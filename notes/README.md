# Notes

Published notes are short Markdown files with no title. The blog displays the
body and a timestamp linking to the note. Two latest notes also appear at home;
posts and notes share `/rss.xml`.

```markdown
---
noteId: <uuid>
slug: 2026-10-03-1630-<first-eight-uuid-characters>
publishedAt: '2026-10-03T16:30:00+05:30'
---

Your short note. Markdown links and paragraphs work.
```

The `slug` is a permanent address. Keep it unchanged when editing a note.
Timestamps must include a timezone; the blog displays them in Asia/Kolkata.
Use the blog MCP server's `create_note` to generate the ID, slug, and timestamp.
It saves a draft by default. `publish_note` moves it here; `update_note` edits
it without changing its address. Rebuild content and then the blog after
publishing. `draft_notes/` is excluded from generated JSON and the public blog.

No sample notes are published. Write your first note when you're ready.
