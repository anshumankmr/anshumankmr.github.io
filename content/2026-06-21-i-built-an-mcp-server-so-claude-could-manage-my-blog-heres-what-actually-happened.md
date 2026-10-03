---
title: I Built an MCP Server So Claude Could Manage My Blog
date: '2026-06-21'
articleId: 254e12f5-ed43-4895-a9a2-42b8622376c8
slug: i-built-an-mcp-server-so-claude-could-manage-my-blog-heres-what-actually-happened
---

> **Update (2026-10-03):** this post describes the setup as of 21 June. Since then Strapi has been removed ([the story](/article/2026-06-27/i-ran-a-personal-blog-on-aws-i-deserve-what-happened/)), the server has grown from 8 tools to 17, and it now requires OAuth. The auth advice below was wrong. Corrections are marked "Edit" inline and summarised under EDITS at the end. The current setup is in [Part 2](/article/2026-10-03/my-blogs-mcp-server-finally-got-a-lock-part-2/).

I run a personal blog backed by Strapi CMS. It works fine. But every time I want to draft a post, I have to open the Strapi admin panel, find the content type, fill in the fields, remember to set the `articleId`, and then either save it as a draft or immediately publish it. It's maybe three minutes of work. I did it enough times that I started thinking: what if I could just ask Claude to do it for me?

That thought turned into a two-week yak shave involving Lambda Web Adapter, DNS rebinding protection, OAuth discovery endpoints, and more Terraform state errors than I'd like to admit. This post is what I wish I'd had before I started.

---

## What I Wanted Claude to Do

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
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False
    ),
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

**Edit (2026-10-03):** look closely at that `FastMCP(...)` call. There's no `auth=` and no `token_verifier=`, which means this server had **no authentication at all**. See EDITS at the end of this post, and [Part 2](/article/2026-10-03/my-blogs-mcp-server-finally-got-a-lock-part-2/) for the fix.

The Strapi client is a thin wrapper around `httpx` that reads `STRAPI_BASE_URL` and `STRAPI_API_TOKEN` from environment variables:

```python
async def get(path: str, params: dict | None = None) -> dict:
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{_base()}{path}",
            headers=_headers(),
            params=params or {},
        )
        r.raise_for_status()
        return r.json()
```

**Edit (2026-10-03):** the original signature was `params: dict = {}`, a mutable default argument. It's shared between calls, which is a classic Python trap. It's now `dict | None = None`.

~~Seven tools total: `list_posts`, `list_drafts`, `get_post`, `create_draft`, `update_post`, `publish_post`, `delete_post`.~~ **Edit (2026-10-03): eight tools total:** `list_posts`, `list_drafts`, `get_post`, `create_draft`, `update_post`, `publish_post`, `unpublish_post`, `delete_post`. The original list left out `unpublish_post`, even though the server had it and the post says unpublishing works. Each one maps directly to a Strapi REST call. Nothing clever.

The only mildly interesting part is `update_post` — it only sends fields you actually pass, so partial updates work without overwriting things you didn't touch:

```python
updates = {
    k: v
    for k, v in {"Title": title, "Content": content, "date": date}.items()
    if v is not None
}
```

**Edit (2026-10-03):** this originally filtered with `if v`, which silently drops every falsy value, so you couldn't set a field to an empty string. Defaulting the arguments to `None` and filtering with `is not None` fixes that.

---

## The Deployment

Running this locally is trivial:

```
uvicorn main:_app --host 0.0.0.0 --port 8000
```

But I wanted it deployed somewhere persistent so Claude Code could connect to it without me having a terminal open. And since my Strapi instance is already on AWS (ECS Fargate behind an ALB), I figured I'd keep everything in one place.

**Edit (2026-10-03):** that Strapi setup is gone. See the update note at the top.

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

COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 \
    /lambda-adapter /opt/extensions/lambda-adapter

ENV PORT=8080

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py strapi.py ./

CMD ["uvicorn", "main:_app", "--host", "0.0.0.0", "--port", "8080"]
```

**Edit (2026-10-03):** I originally pinned `:1.0.1`. The adapter's README now shows the same pattern with `:1.1.0`, so that's what's above. My own deployment still builds with `1.0.1`.

The `COPY --from` line pulls the LWA binary out of the official ECR image and puts it at `/opt/extensions/lambda-adapter`. Lambda automatically runs anything in `/opt/extensions/` as an extension before invoking your handler. LWA starts your CMD, waits for the port to be ready, and then starts proxying.

~~One thing that bit me: I initially tried using `public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4` because that's what a lot of blog posts reference. The correct image for the binary-copy pattern is the `1.x` release line. The older tags don't have the binary at the expected path.~~

**Edit (2026-10-03), replacement:** the struck-through claim was wrong. I checked the published `0.8.4` image, and its single layer contains `/lambda-adapter`, the same layout as `1.0.1` and `1.1.0`. What really bit me was one step earlier. I tried downloading the `v0.8.4` release artifacts from GitHub inside the Dockerfile, picked the wrong file, fixed the extraction, and only then switched to the `COPY --from` pattern with the ECR image. The pattern is what fixed it, not the version number.

Another thing: I tried Amazon's own Lambda Python base image (`public.ecr.aws/lambda/python:3.12`) first because it's the "native" Lambda environment. LWA doesn't care what base image you use — it's a static binary — but `python:3.12-slim` (Debian) is smaller and gives you a normal pip install experience without fighting Amazon's package repos.

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

~~FastMCP actually handles OAuth resource metadata automatically — it serves `/.well-known/oauth-protected-resource` itself. I didn't need my own middleware at all. I removed it and let FastMCP handle auth concerns. The Lambda Function URL is public (`authorization_type = "NONE"`) and I rely on a token check FastMCP handles internally.~~

**Edit (2026-10-03): the struck-through paragraph above was wrong, and it matters.** FastMCP serves OAuth metadata and rejects unauthenticated requests *only if you configure auth*, by passing `auth=AuthSettings(...)` and a `token_verifier=`. The MCP Python SDK has authentication **off by default**. My code configured neither, so there was no "token check FastMCP handles internally". Once the broken middleware was gone and the client connected, I assumed the framework was doing the protecting. It wasn't. With the Function URL set to `authorization_type = "NONE"`, the endpoint (including `update_post` and `delete_post`) was open to anyone who had the URL.

What the middleware actually got wrong was not exempting the `/.well-known/` discovery paths. The right fix was to configure the SDK's auth, not to remove auth.

---

## The DNS Rebinding Problem

Once the OAuth discovery was working, the MCP client successfully sent its first POST request to `/mcp`. And got a 400.

FastMCP has DNS rebinding protection enabled by default. It checks the `Host` header on incoming requests and rejects anything that doesn't look like a known host. When a request comes in through Lambda Function URL, the `Host` header is the Lambda URL hostname. FastMCP didn't recognize it as a trusted host and rejected every POST.

The fix is one line:

```python
mcp = FastMCP(
    "blog",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False
    ),
    streamable_http_path="/",
)
```

The `enable_dns_rebinding_protection=False` is the obvious part. The `streamable_http_path="/"` is less obvious: by default FastMCP mounts the MCP handler at `/mcp`. Lambda Web Adapter sometimes has issues with path routing when the app is mounted at a subpath. Serving at `/` removes that variable entirely.

**Edit (2026-10-03):** that "one line" works by switching a protection off, so it's a workaround, not a fix. A tidier option is to allow the Function URL host instead of disabling the check. It's far less risky now that every request needs a valid token, but the check is still off.

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

**Edit (2026-10-03):** `authorization_type = "NONE"` is only acceptable if the application verifies tokens itself, and at the time of writing mine didn't. It's still `NONE` today, deliberately: `AWS_IAM` expects SigV4-signed requests, which MCP clients don't send. The difference is that the app now validates an Auth0 access token on every request. The environment variables above are also the old Strapi ones.

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

After that, Claude can see all ~~seven~~ eight tools and use them in conversation:

> "Draft a post about the Lambda Web Adapter, title it 'Why Mangum Didn't Work', leave the date as today, and save it as a draft."

It works. It actually works. The draft shows up in my Strapi admin panel with the content Claude wrote, correctly formatted, with the right date. Publishing and unpublishing also work. I've been using it for a few weeks now without issues.

**Edit (2026-10-03):** "it works, without issues" meant "it connects", not "it's secure". Those are different claims. A config that's just a URL is also no longer enough: the server now answers `401` until the client completes an OAuth sign-in.

---

## How It All Fit Together (June 2026)

The Strapi CMS runs on ECS Fargate behind an ALB. The MCP server runs on Lambda, packaged as a container image, using Lambda Web Adapter to bridge the uvicorn HTTP server to the Lambda execution model. Terraform manages both, with state in S3. GitHub Actions deploys both on push to master.

Total cost for the MCP server is roughly zero — it runs a few times a day and fits comfortably within Lambda's free tier. The main ongoing cost is the Fargate task running Strapi.

**Edit (2026-10-03):** this section is a snapshot, and it's out of date. Strapi and its Fargate task were removed on 24 June. Posts are now Markdown files in a GitHub repo served as static JSON from Cloudflare Pages, and the MCP server talks to the GitHub Contents API, with no database behind it. See [the 27 June post](/article/2026-06-27/i-ran-a-personal-blog-on-aws-i-deserve-what-happened/) for why.

---

## Four Lessons From the Yak Shave

**Start with Lambda Web Adapter, not Mangum.** If you're running any kind of streaming server on Lambda — MCP, SSE, WebSocket over HTTP — LWA is the right tool. Mangum is for request-response ASGI apps. The distinction matters and it's easy to miss.

~~**Don't write auth middleware for MCP servers.** FastMCP handles the OAuth discovery protocol for you. If you put your own middleware in front of it, you'll block the handshake. Let the framework do its job.~~

**Edit (2026-10-03), replacement:** **Don't hand-roll auth middleware, but do configure the SDK's auth.** Pass FastMCP an `AuthSettings` and a `TokenVerifier`. The SDK then serves the discovery metadata and returns proper `401` challenges for you. Auth is off by default, so if your server can write or delete anything, make one request with no token before you call it done. If you don't get a `401`, you aren't done.

**Use `streamable_http_path="/"`** when deploying behind a reverse proxy or LWA. Subpath mounting adds a routing variable you don't need.

**Import existing resources before first Terraform apply.** If you created anything in the AWS console before writing the Terraform, import it first. Running bootstrap in your CI with explicit imports before `terraform apply` prevents the `AlreadyExists` errors that would otherwise require manual intervention.

---

## EDITS

**BLUF:** The auth advice in this post was wrong, and the server it describes was unauthenticated. "FastMCP handles auth" is false: the MCP Python SDK has auth off by default, and my code configured none. The endpoint, including `update_post` and `delete_post`, was open to anyone with the Function URL. I fixed it on 2026-10-03 with Auth0 OAuth and an owner-only token check, and confirmed that an anonymous request now gets a `401`. The story of the fix is in [Part 2](/article/2026-10-03/my-blogs-mcp-server-finally-got-a-lock-part-2/). The same pass also corrected a wrong tool list, an unfounded Lambda Web Adapter claim, two code samples, and the stale Strapi architecture. Details below.

**Wrong, and corrected in place** (each marked "Edit (2026-10-03)" in the text above):

1. **Auth (the big one).** I struck through the paragraph claiming FastMCP handles auth internally and added a correction. The fix is `AuthSettings` plus a `TokenVerifier`. The real bug in my middleware was that it blocked the `/.well-known/` discovery paths, so it needed a route exemption, not removal.
2. **Lessons.** I struck through "Don't write auth middleware" and replaced it with: don't hand-roll auth middleware, but do configure the SDK's auth, and test the unauthenticated request first.
3. **Tool list.** It said seven tools and omitted `unpublish_post`, even though the post says unpublishing works. The server had eight tools, including `unpublish_post`. I've corrected the list and the count.
4. **Lambda Web Adapter claim.** I struck through "the older tags don't have the binary at the expected path". I checked the published `0.8.4` image, and it has `/lambda-adapter` at the same path as `1.0.1` and `1.1.0`. What actually bit me was downloading the `v0.8.4` GitHub release artifacts, not the ECR image tag. I also bumped the pinned version in the sample Dockerfile from `1.0.1` to `1.1.0`, matching the adapter's README. My own deployment still builds with `1.0.1`.
5. **Base image.** I said I'd tried "an Amazon Linux 2 base image". It was Amazon's Lambda Python base image, `public.ecr.aws/lambda/python:3.12`.
6. **Code samples.** `params: dict = {}` (a mutable default argument) is now `params: dict | None = None`, and the `update_post` filter `if v` is now `if v is not None`, because `if v` silently dropped falsy values and so couldn't set a field to an empty string. I also wrapped the longest code lines so they don't clip in the reading column.

**Flagged as out of date, with a note in place:**

7. **`FastMCP(...)` sample.** I added a note that it has no `auth=` or `token_verifier=`.
8. **DNS rebinding.** I added a note that `enable_dns_rebinding_protection=False` is a workaround, and that allowing the specific host would be the tidier fix.
9. **Terraform.** I added a note that `authorization_type = "NONE"` is only safe when the app verifies tokens, which mine didn't at the time, and that the Strapi environment variables shown are the old ones.
10. **"Works without issues".** I added a note that this meant "connects", not "secure".
11. **Strapi architecture.** Strapi on ECS Fargate behind an ALB was removed on 24 June (see [the 27 June post](/article/2026-06-27/i-ran-a-personal-blog-on-aws-i-deserve-what-happened/)). I added an update banner at the top and notes in the Deployment and "How It All Fit Together" sections. The server has also grown from eight tools to seventeen (the new ones are `rebuild_content`, `rebuild_blog` and a set of seven note tools; `unpublish_post` was already there), and it now has a test suite.

**Trimmed:**

12. **Title and ending.** I cut the "— Here's What Actually Happened" subtitle from the title, renamed three generic section headings (the goals section, "How It All Fit Together" and the lessons), and moved the architecture summary ahead of the lessons. I removed the closing paragraph that oversold the post, so it now ends on the last concrete lesson. The URL didn't change.
