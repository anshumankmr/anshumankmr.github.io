#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..', 'generated');
const load = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).data;
const posts = load('content.json');
const notes = load('notes.json');
assert(Array.isArray(posts) && Array.isArray(notes), 'Both feeds require data arrays');
const ids = new Set();
const slugs = new Set();
for (const item of posts) {
  assert(item.id && item.attributes, 'Post id and attributes required');
  const attrs = item.attributes;
  for (const field of ['Title', 'date', 'articleId', 'Content', 'slug', 'sourcePath']) assert(attrs[field], `${field} required for post ${item.id}`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(attrs.date) && !Number.isNaN(Date.parse(attrs.date)), 'Post date must be YYYY-MM-DD');
  assert(!ids.has(attrs.articleId), 'Duplicate post ID');
  ids.add(attrs.articleId);
  assert(!slugs.has(attrs.slug), 'Duplicate post slug');
  slugs.add(attrs.slug);
}
slugs.clear();
for (const note of notes) {
  for (const field of ['noteId', 'slug', 'publishedAt', 'content', 'sourcePath']) assert(typeof note[field] === 'string' && note[field].trim(), `${field} required for note`);
  assert(/^[a-zA-Z0-9-]+$/.test(note.slug), 'Note slug must be safe for URLs');
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(note.publishedAt) && !Number.isNaN(Date.parse(note.publishedAt)), 'Note timestamp requires an ISO date, time, and timezone');
  assert(!ids.has(note.noteId), 'Duplicate note ID');
  ids.add(note.noteId);
  assert(!slugs.has(note.slug), 'Duplicate note slug');
  slugs.add(note.slug);
}
console.log(`✓ ${posts.length} posts and ${notes.length} notes validated.`);
