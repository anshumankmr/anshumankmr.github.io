---
title: I Said "Don't Write Auth for Your MCP Server." I Was Wrong.
date: '2026-10-03'
articleId: 51ce3c8d-dd4c-4803-80d2-5b0190eb91c3
slug: i-said-dont-write-auth-for-your-mcp-server-i-was-wrong
description: 'A follow-up to my MCP blog server post: the "FastMCP handles auth" advice
  was wrong, the endpoint was wide open, and here''s the real fix with Auth0.'
---

A few months ago I wrote [I Built an MCP Server So Claude Could Manage My Blog](/blog/i-built-an-mcp-server-so-claude-could-manage-my-blog-heres-what-actually-happened). Someone went through it with a fine-toothed comb and found a problem. Not a typo. A "the headline advice is wrong and the thing you built is unprotected" problem.

They were right, so this is the sequel where I fix it.

---

## What I said

In the original post I wrote this:

> The Lambda Function URL is public (`authorization_type = "NONE"`) and I rely on a token check FastMCP handles internally.

And in the "what I'd do differently" section:

> Don't write auth middleware for MCP servers. FastMCP handles the OAuth discovery protocol for you.

Read those two next to the code I actually shipped:

```python
mcp = FastMCP(
    "blog",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    streamable_http_path="/",
)
```

No auth provider. No token verifier. Nothing. The MCP Python SDK ships with authentication **off by default**. You turn it on by handing FastMCP an `AuthSettings` and a `TokenVerifier`. I did neither. There was no "token check FastMCP handles internally" because there was no token check.

So for a good while, anyone who found the Function URL could call `update_post` and `delete_post` on my blog. The URL is a long random string, which is obscurity, not authentication. I'd like to say I'd have caught it eventually. I did not catch it. A reviewer did.

## How I talked myself into it

The history is almost funny. I'd written a bearer-token middleware, and it broke the OAuth discovery handshake because it also blocked `/.well-known/*`. The MCP client couldn't find out how to authenticate, so it gave up.

The real bug was "my middleware doesn't exempt the discovery routes." The conclusion I drew was "auth middleware is bad, the framework must handle it." I ripped the middleware out, the client connected, everything went green, and I wrote a confident blog post about it.

Lesson: "it connects now" and "it's secure" are different test results. I only ran the first one.

## The actual fix

The MCP server should be an OAuth *resource server*. It doesn't log anyone in or mint tokens. Auth0 does that. The server's only job is to look at a bearer token and decide yes or no.

The FastMCP side is small:

```python
mcp = FastMCP(
    "blog",
    auth=auth_config.settings(),
    token_verifier=OwnerTokenVerifier(auth_config),
    streamable_http_path="/",
    stateless_http=True,
    json_response=True,
)
```

with settings like:

```python
AuthSettings(
    issuer_url=AnyHttpUrl(issuer),
    resource_server_url=AnyHttpUrl(resource),
    required_scopes=["blog:manage"],
    validate_token_resource=True,
)
```

Once those are set, the SDK serves the discovery metadata and returns proper `401` challenges by itself. *That* is the part of "FastMCP handles it" that's true. It only happens if you configure it.

### The verifier is where it matters

`OwnerTokenVerifier` is a few dozen lines. It accepts a token only if all of these hold:

- It's signed RS256, with a key from my Auth0 tenant's JWKS (fetched async, cached, never from a URL the token supplies)
- `iss` is my tenant, `aud` is this server's URL, and it hasn't expired
- It carries the `blog:manage` scope
- **`sub` is exactly my user ID**

That last one is the one I'd have skipped if I'd been rushing. A valid token from my tenant isn't enough, because "valid Auth0 token" only means "someone Auth0 knows." I want "me." So I allowlist my one user ID, turned off sign-ups on the Auth0 connection, and created my user by hand. Not an email, not "whoever logs in first." The `sub`.

If the OAuth env vars are missing, the server doesn't quietly run open. It serves a `503` on every route and exposes no tools. I'd rather be locked out than exposed.

## The Function URL is still `NONE`

Before anyone panics: yes, the Terraform still says this.

```hcl
resource "aws_lambda_function_url" "blog_mcp" {
  function_name      = aws_lambda_function.blog_mcp.function_name
  authorization_type = "NONE" # OAuth tokens and owner identity are verified in-app.
}
```

That's deliberate now. `AWS_IAM` auth on a Function URL wants SigV4-signed requests, and MCP clients don't do that. They speak OAuth. So AWS lets the request through and the app does the real check. The difference from before is that the app now actually *does* the check.

## Proving it, this time

I tested the bad path first. An anonymous request straight at the live Function URL:

```
$ curl -i -X POST <function-url>/ \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

HTTP/1.1 401 Unauthorized
www-authenticate: Bearer error="invalid_token",
  error_description="Authentication required",
  resource_metadata="<function-url>/.well-known/oauth-protected-resource"
```

`/healthz` still returns 200 and the discovery document is still reachable, which is exactly what a client needs to get started. And the Claude connector, using its own OAuth client, completes the login and can list my posts. Same server, same tools, now with a bouncer.

The automated tests use generated RSA keys and a mocked JWKS, and they cover denied requests, the wrong audience, the wrong `sub`, and every tool. They do **not** prove real Auth0 provisioning or real refresh behaviour, which is why I also did the live login by hand.

## Auth0 gotchas that cost me time

- **The API identifier must equal your public URL exactly**, trailing slash included. A mismatch gets you an `audience` error that tells you nothing useful.
- **Turn on Resource Parameter Compatibility Profile** (Settings > Advanced) or MCP clients' `resource` parameter won't line up with your API.
- **Keep the access token short.** I set 900 seconds and enabled offline access, so clients refresh instead of holding long-lived tokens.
- **One Auth0 application per client**, each with its exact callback URL. No wildcards.
- **Check refresh actually works.** A successful first login proves nothing about the second one an hour later.

## While I'm correcting things

Since I'm already eating crow, a few other bits of the original have aged:

- **Strapi is gone.** I removed it three days after that post. Posts are now Markdown files in a GitHub repo, and the MCP server talks to the GitHub Contents API. The "mostly free except the Fargate task" line is simply no longer true.
- **Seven tools became seventeen.** Posts, plus a separate set for short untitled notes.
- **DNS rebinding protection is still off.** It was a one-line fix to get past a `Host` header mismatch behind the Function URL, and I presented it as the answer. The tidier fix is to allow that specific host instead of switching the check off. Now that every request needs a token it matters much less, but it's still a shortcut.

## What I'd actually say now

**Don't hand-roll auth middleware, but do configure the SDK's auth.** The two are different, and my original advice blurred them. A `TokenVerifier` plus `AuthSettings` is the whole thing. If your handshake breaks, the answer is to fix the config, not to delete the protection.

**If your MCP server can write or delete anything, test the unauthenticated request first.** One `curl` with no token. If it doesn't get a 401, you're not done.

**Verify security claims before you write them down.** I wrote "FastMCP handles internally" about code I hadn't read. The docs say authentication is off by default. I just didn't look.

Thanks to whoever pushed on this. It's a better server now, and a more honest blog post.
