---
title: "I Built an MCP Server So Claude Could Manage My Blog — Here's What Actually Happened"
date: "2026-06-21"
articleId: "254e12f5-ed43-4895-a9a2-42b8622376c8"
slug: "i-built-an-mcp-server-so-claude-could-manage-my-blog-heres-what-actually-happened"
---

I run a personal blog backed by Strapi CMS. It works fine. But every time I want to draft a post, I have to open the Strapi admin panel, find the content type, fill in the fields, remember to set the `articleId`, and then either save it as a draft or immediately publish it. It's maybe three minutes of work. I did it enough times that I started thinking: what if I could just ask Claude to do it for me?

That thought turned into a two-week yak shave involving Lambda Web Adapter, DNS rebinding protection, OAuth discovery endpoints, and more Terraform state errors than I'd like to admit. This post is what I wish I'd had before I started.

---

## The Goal

I wanted Claude to be able to:

- List my published posts and drafts
- Read the full content of any post
- Create a new draft
- Edit an existing post
- Publish or unpublish a post
- Delete a post

All of this is exposed through Strapi's REST API. The question was how to make it available to Claude in a way that doesn't require me to paste API responses into the chat manually.

The answer is MCP — the Model Context Protocol. Claude Code supports connecting to remote MCP servers over HTTP, so I could build a small server that wraps Strapi and expose it as a set of tools Claude can call.

---

## The MCP Server

The server itself was the easy part. The Python MCP SDK ships with `FastMCP`, which lets you define tools with decorators. The whole thing is about 150 lines.

```python
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.server import TransportSecuritySettings
import strapi

mcp = FastMCP(
    "blog",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    streamable_http_path="/",
)

@mcp.tool()
async def list_posts() -> list:
    """List all published blog posts (title, date, articleId)."""
    data = await strapi.get(
        "/api/blogs",
        {"sort": "date:desc", "fields": "Title,date,articleId"},
    )
    return [
        {
            "articleId": d["attributes"]["articleId"],
            "title": d["attributes"]["Title"],
            "date": d["attributes"]["date"],
        }
        for d in data["data"]
    ]
```

The Strapi client is a thin wrapper around `httpx` that reads `STRAPI_BASE_URL` and `STRAPI_API_TOKEN` from environment variables:

```python
async def get(path: str, params: dict = {}) -> dict:
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{_base()}{path}", headers=_headers(), params=params)
        r.raise_for_status()
        return r.json()
```

Seven tools total: `list_posts`, `list_drafts`, `get_post`, `create_draft`, `update_post`, `publish_post`, `delete_post`. Each one maps directly to a Strapi REST call. Nothing clever.

The only mildly interesting part is `update_post` — it only sends fields you actually pass, so partial updates work without overwriting things you didn't touch:

```python
updates = {
    k: v
    for k, v in {"Title": title, "Content": content, "date": date}.items()
    if v
}
```

---

## The Deployment

Running this locally is trivial:

```
uvicorn main:_app --host 0.0.0.0 --port 8000
```

But I wanted it deployed somewhere persistent so Claude Code could connect to it without me having a terminal open. And since my Strapi instance is already on AWS (ECS Fargate behind an ALB), I figured I'd keep everything in one place.

I had two options: another ECS service, or Lambda. Lambda is cheaper for a server that gets used a few times a day, so I went with Lambda.

This is where things got interesting.

---

## Why Mangum Didn't Work

The standard way to run an ASGI app on Lambda is [Mangum](https://mangum.fastapiexpert.com/). It wraps your app, receives the Lambda event, translates it to an ASGI scope, and returns a Lambda response. I've used it before for FastAPI and it works great.

I started there:

```python
from mangum import Mangum
handler = Mangum(mcp.streamable_http_app())
```

It didn't work. The MCP client would connect, do the OAuth discovery handshake, and then hang when it tried to send the first actual message.

The problem is that MCP's streamable HTTP transport uses server-sent events (SSE) — it holds a response stream open and pushes messages over time. Mangum buffers the entire response before returning it to Lambda. There's no buffering here to do: the response never ends until the client disconnects.

Mangum is built for the request-response model. Streaming doesn't fit.

---

## Lambda Web Adapter

AWS has a solution for this: [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) (LWA). Instead of translating Lambda events into ASGI calls, LWA runs your web server as a normal process and proxies HTTP requests to it via localhost. Your app doesn't know it's in Lambda at all — it's just a web server listening on a port.

This means you can use any web server, including uvicorn, and streaming works exactly the same as it would on a regular instance.

The Dockerfile is almost embarrassingly simple:

```dockerfile
FROM public.ecr.aws/docker/library/python:3.12-slim

COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 \
    /lambda-adapter /opt/extensions/lambda-adapter

ENV PORT=8080

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py strapi.py ./

CMD ["uvicorn", "main:_app", "--host", "0.0.0.0", "--port", "8080"]
```

The `COPY --from` line pulls the LWA binary out of the official ECR image and puts it at `/opt/extensions/lambda-adapter`. Lambda automatically runs anything in `/opt/extensions/` as an extension before invoking your handler. LWA starts your CMD, waits for the port to be ready, and then starts proxying.

One thing that bit me: I initially tried using `public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4` because that's what a lot of blog posts reference. The correct image for the binary-copy pattern is the `1.x` release line. The older tags don't have the binary at the expected path.

Another thing: I tried an Amazon Linux 2 base image first because it's the "native" Lambda environment. LWA doesn't care what base image you use — it's a static binary — but `python:3.12-slim` (Debian) is smaller and gives you a normal pip install experience without fighting Amazon's package repos.

---

## The OAuth Gotchas

MCP clients do a discovery handshake before connecting. They GET `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` to figure out what auth the server expects. If those return 404 or get blocked, the client gives up.

I had added bearer token middleware early on to protect the endpoint:

```python
# early attempt — don't do this
class BearerAuthMiddleware:
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            auth = headers.get(b"authorization", b"").decode()
            if not auth.startswith("Bearer "):
                # return 401
                ...
        await self.app(scope, receive, send)
```

The problem: this blocked the `/.well-known/` paths too. The MCP client never got the discovery response, never knew what token to send, and gave up before even trying to authenticate.

FastMCP actually handles OAuth resource metadata automatically — it serves `/.well-known/oauth-protected-resource` itself. I didn't need my own middleware at all. I removed it and let FastMCP handle auth concerns. The Lambda Function URL is public (`authorization_type = "NONE"`) and I rely on a token check FastMCP handles internally.

---

## The DNS Rebinding Problem

Once the OAuth discovery was working, the MCP client successfully sent its first POST request to `/mcp`. And got a 400.

FastMCP has DNS rebinding protection enabled by default. It checks the `Host` header on incoming requests and rejects anything that doesn't look like a known host. When a request comes in through Lambda Function URL, the `Host` header is the Lambda URL hostname. FastMCP didn't recognize it as a trusted host and rejected every POST.

The fix is one line:

```python
mcp = FastMCP(
    "blog",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    streamable_http_path="/",
)
```

The `enable_dns_rebinding_protection=False` is the obvious part. The `streamable_http_path="/"` is less obvious: by default FastMCP mounts the MCP handler at `/mcp`. Lambda Web Adapter sometimes has issues with path routing when the app is mounted at a subpath. Serving at `/` removes that variable entirely.

---

## The Infrastructure

The Terraform for the Lambda deployment is straightforward once you know LWA handles the transport:

```hcl
resource "aws_lambda_function" "blog_mcp" {
  function_name = "blog-mcp"
  role          = aws_iam_role.blog_mcp.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.blog_mcp.repository_url}:latest"
  timeout       = 30
  memory_size   = 256

  environment {
    variables = {
      STRAPI_BASE_URL  = var.strapi_base_url
      STRAPI_API_TOKEN = var.strapi_api_token
    }
  }
}

resource "aws_lambda_function_url" "blog_mcp" {
  function_name      = aws_lambda_function.blog_mcp.function_name
  authorization_type = "NONE"
}
```

Lambda Function URL gives you a stable HTTPS endpoint without needing an API Gateway or ALB. For a low-traffic internal tool this is exactly the right call — it's free within the Lambda free tier and requires zero additional configuration.

One Terraform issue I hit: I had manually created the ECR repository and CloudWatch log group early in the project before I had Terraform set up. Running `terraform apply` tried to create them again and failed with `ResourceAlreadyExists`. The fix is to import the existing resources into state before applying:

```bash
terraform import aws_ecr_repository.blog_mcp blog-mcp
terraform import aws_cloudwatch_log_group.blog_mcp /aws/lambda/blog-mcp
```

I automated this in the deploy workflow so it's idempotent regardless of whether the resources exist.

---

## Connecting Claude to It

With the server deployed, connecting Claude Code is one config addition:

```json
{
  "mcpServers": {
    "blog": {
      "type": "http",
      "url": "https://<your-lambda-function-url>.lambda-url.us-east-1.on.aws/"
    }
  }
}
```

After that, Claude can see all seven tools and use them in conversation:

> "Draft a post about the Lambda Web Adapter, title it 'Why Mangum Didn't Work', leave the date as today, and save it as a draft."

It works. It actually works. The draft shows up in my Strapi admin panel with the content Claude wrote, correctly formatted, with the right date. Publishing and unpublishing also work. I've been using it for a few weeks now without issues.

---

## What I'd Do Differently

**Start with Lambda Web Adapter, not Mangum.** If you're running any kind of streaming server on Lambda — MCP, SSE, WebSocket over HTTP — LWA is the right tool. Mangum is for request-response ASGI apps. The distinction matters and it's easy to miss.

**Don't write auth middleware for MCP servers.** FastMCP handles the OAuth discovery protocol for you. If you put your own middleware in front of it, you'll block the handshake. Let the framework do its job.

**Use `streamable_http_path="/"`** when deploying behind a reverse proxy or LWA. Subpath mounting adds a routing variable you don't need.

**Import existing resources before first Terraform apply.** If you created anything in the AWS console before writing the Terraform, import it first. Running bootstrap in your CI with explicit imports before `terraform apply` prevents the `AlreadyExists` errors that would otherwise require manual intervention.

---

## The Full Picture

The Strapi CMS runs on ECS Fargate behind an ALB. The MCP server runs on Lambda, packaged as a container image, using Lambda Web Adapter to bridge the uvicorn HTTP server to the Lambda execution model. Terraform manages both, with state in S3. GitHub Actions deploys both on push to master.

Total cost for the MCP server is roughly zero — it runs a few times a day and fits comfortably within Lambda's free tier. The main ongoing cost is the Fargate task running Strapi.

Is it overkill for a personal blog? Yes, obviously. But "can Claude draft and publish my posts" is now a real capability I have, and the path from question to working system is fully documented for the next person who wants to build something like it.
