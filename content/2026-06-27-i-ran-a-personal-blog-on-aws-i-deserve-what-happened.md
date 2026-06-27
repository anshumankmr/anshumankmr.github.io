---
title: I Ran a Personal Blog on AWS. I Deserve What Happened.
date: '2026-06-27'
articleId: c5818523-6d19-4674-8dd0-78fe719a6d3b
slug: i-ran-a-personal-blog-on-aws-i-deserve-what-happened
---

For years I ran this blog on GCP. Cloud Build for the pipeline, GCS for the bucket, Strapi as the CMS. Strapi is a headless CMS — a full application with a database, an admin panel, and an API — which is a lot of machinery for a blog that a few dozen people read. I ran it anyway. It felt professional.

Then Google charged me ₹7,000 for a Google Translate API key I had never used. Not a billing error. Not a test. A key I enabled, never called, and forgot existed. I asked for a refund. They said no. I migrated to AWS that week.

This was not a considered architectural decision. It was spite.

I set up an S3 bucket, wrote Terraform to manage IAM roles, wired up OIDC authentication between GitHub Actions and AWS, and told myself this was an improvement. It was not an improvement. It was the same overengineered blog on different infrastructure, now with the added complexity of Terraform state and IAM policies to maintain.

At some point — honestly, about a year ago — I knew the setup was overkill. The content pipeline, the CMS, the deploy tooling — none of it was making the writing better. It was just cost and complexity I'd been carrying long enough that dismantling it felt like more effort than keeping it. The GCP bill was the thing that finally made the effort feel worth it.

So I cut it. Strapi is gone — the posts live as markdown files fetched from a JSON file on GitHub. GitHub Actions builds it. Cloudflare Pages serves it for free. No database, no CMS, no IAM roles. The pipeline is one YAML file and a single deploy command.

The blog is the same. The infrastructure bill is zero.

Google still hasn't refunded the ₹7,000. At this point I consider it the most expensive lesson in not normalizing complexity.
