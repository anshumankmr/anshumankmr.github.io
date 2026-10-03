---
title: My Blog's MCP Server Finally Got a Lock (Part 2)
date: '2026-10-03'
articleId: 160fb3f1-be69-4183-9a43-8e3e0c39dd18
slug: my-blogs-mcp-server-finally-got-a-lock-part-2
description: 'Part 2 of the blog-MCP saga: someone pointed out my server had no auth,
  so in one day I added Auth0 OAuth, tests, a deploy fix, and notes, then checked
  that the lock actually works.'
---

This is the sequel to [I Built an MCP Server So Claude Could Manage My Blog](/article/2026-06-21/i-built-an-mcp-server-so-claude-could-manage-my-blog-heres-what-actually-happened/).

---

## The problem, in one paragraph

The original server had no auth provider and no token verifier. The Lambda Function URL is `authorization_type = "NONE"`, and the server exposes `update_post` and `delete_post`. As written, anyone with the URL could edit or delete my posts. The URL is a long random string, but that's obscurity, not a lock. (The correction, with a diff of what I changed, is at the bottom of the original post under **EDITS**.)

## The plan: be a resource server, not a login system

I don't want to run a login system. Auth0 can own login and token issuance, and my server just has to answer one question per request: *is this token legit, and is it me?*

That's the whole design. FastMCP gets an `AuthSettings` and a `TokenVerifier`:

```python
mcp = FastMCP(
    "blog",
    auth=_auth_config.settings() if _auth_config else None,
    token_verifier=OwnerTokenVerifier(_auth_config) if _auth_config else None,
    streamable_http_path=MCP_PATH,
    stateless_http=True,
    json_response=True,
)
```

Once you hand it those, the SDK serves the OAuth discovery metadata and returns proper `401` challenges on its own. That is the part of "FastMCP handles it" that was true. I just hadn't turned it on.

## Setting up Auth0 without leaving the terminal

Auth0 ships an MCP server of its own, so I let Claude set up the Auth0 side through it. It created three separate applications, one per client I want to use:

| Client | Type |
| --- | --- |
| Local Codex | Native/public, PKCE, no secret |
| ChatGPT | Regular web app, PKCE + refresh tokens |
| Claude | Regular web app, PKCE + refresh tokens |

Separate apps mean I can revoke one client without logging the others out. Each gets exact callback URLs, never wildcards.

Not everything could be done that way. The Auth0 MCP's default permissions covered clients but not APIs, and it has no tools for users, connections or tenant settings at all. So a few things were dashboard work for me, and the handoff note in the repo lists them as "not done" rather than pretending:

- Create the API, with the identifier **exactly equal** to the server's public URL (trailing slash included), a `blog:manage` permission, a 900-second access token, and offline access on.
- Create my user by hand and **disable sign-ups** on the database connection.
- Turn on the **Resource Parameter Compatibility Profile**, or MCP clients' `resource` parameter won't match your API.

That handoff note was one of the more useful things from today. It has a table of what's been validated and what hasn't, and it keeps "76 tests passed" separate from "I actually logged in." Those are not the same claim, and mixing them up is how the original post happened.

## The verifier is the interesting bit

`OwnerTokenVerifier` accepts a token only if it passes every one of these:

- Signed RS256, with a key from my tenant's JWKS (fetched async, cached, with at most one refresh per 30s for an unknown key ID, and never from a URL the token supplies)
- Correct `iss`, `aud` and `exp`, with the required claims present
- Has the `blog:manage` scope
- **`sub` equals my user ID, exactly**

The last one is the one I care about. A valid token from my tenant only proves Auth0 knows the person. I want it to be me. I allowlist the one immutable user ID, not an email address and not "whoever logs in first".

And it fails closed. If the three OAuth env vars (`AUTH0_ISSUER_URL`, `MCP_PUBLIC_URL`, `MCP_ALLOWED_SUB`) are missing or malformed, the server doesn't quietly start open. It serves a `503` on every route and exposes no tools.

## Tests: the denial table

I wrote the tests around ways to get in that should fail. They use generated RSA keys, a mocked JWKS and a mocked GitHub, so there are no real tokens and no live writes. They cover:

- missing, malformed and forged tokens
- expired, wrong-issuer and wrong-audience tokens
- a valid token for a *different user*
- insufficient scope, missing claims, and the wrong signing algorithm
- an unknown signing key and a JWKS outage
- missing configuration

Every one of those must be rejected **before** anything reaches GitHub. The suite is at 125 passing now, and I'm honest about its limits: mocked tests don't prove real Auth0 provisioning, real login, token refresh or a web client's quirks.

## A deploy gotcha: workflow-only changes don't deploy

My deploy workflow triggers on pushes that touch `mcp/**`. I tweaked the workflow file itself (to accept the Auth0 settings from repository variables *or* secrets) and nothing happened, because `.github/workflows/` isn't under `mcp/`. The fix was one line, `workflow_dispatch`, so I can run it from the Actions tab. It's the kind of thing you only learn by staring at a pipeline that stubbornly does nothing.

The workflow also refuses to touch AWS if the three OAuth values aren't set. Better a red build than an open server.

## Checking it for real

The test I should have run the first time: an anonymous request straight at the live Function URL.

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

`/healthz` is still a public 200, and the discovery document is public too, which is what a client needs to start the OAuth dance. The Claude connector goes through the full sign-in and can list my posts.

The Function URL is still `NONE` in Terraform, on purpose. `AWS_IAM` needs SigV4-signed requests and MCP clients don't send those. The difference now is that the app does the checking.

## While I was in there: notes

With auth in place I added the thing I'd been wanting: **notes**, short untitled posts that don't need a title or a draft-polish cycle. Seven new tools take the server from 10 to 17:

`list_notes`, `get_note`, `create_note`, `update_note`, `publish_note`, `unpublish_note`, `delete_note`

Notes are Markdown files with a `noteId`, a timezone-aware timestamp and a slug like `2026-10-03-1630-<first-8-uuid-chars>`. The UUID suffix stops two notes in the same minute from colliding, and editing a note keeps its original slug even if you change the time. `create_note` saves a draft by default, and `draft=false` publishes straight away. They go through the same owner-only auth, so none of the security settings changed.

## Pinning the endpoint to `/`

One more tidy-up. The MCP endpoint lives at the Function URL root, and now there's a test that says so: `/mcp`, `/sse`, `/notes` and friends return a plain `404`, with no redirect. Posts and notes share one endpoint and one catalog. `MCP_PUBLIC_URL` is accepted with or without the trailing slash, and both forms identify the same endpoint.

It sounds trivial, but when the audience in your tokens has to match your URL exactly, "which URL is the canonical one" is a security question and not just a style choice.

## What I'd tell past me

**Test the bad request first.** One `curl` with no token takes ten seconds. If it doesn't come back `401`, stop.

**"It connects" is not "it's secure".** I had the first and wrote up the second.

**Write down what you haven't verified.** A mocked test suite and a real login prove different things. Keep them in different columns.

**Check who, not just whether.** A valid token means someone Auth0 knows. Compare the `sub`.

Things are in better shape than they were this morning. Next up is making sure the ChatGPT and Codex logins work as well as the Claude one does.
