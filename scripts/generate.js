#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const root = process.env.BLOG_CONTENT_ROOT || path.join(__dirname, '..');
const generated = path.join(root, 'generated');

function readEntries(directory) {
  const location = path.join(root, directory);
  if (!fs.existsSync(location)) return [];
  return fs.readdirSync(location).filter(file => file.endsWith('.md') && file !== 'README.md').map(filename => {
    const { data, content } = matter(fs.readFileSync(path.join(location, filename), 'utf8'));
    return { data, content: content.trim(), sourcePath: `${directory}/${filename}` };
  });
}
function writeCollection(name, objects, slugs) {
  const directory = path.join(generated, name);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of fs.readdirSync(directory)) if (file.endsWith('.json')) fs.unlinkSync(path.join(directory, file));
  objects.forEach((object, i) => fs.writeFileSync(path.join(directory, `${slugs[i]}.json`), JSON.stringify({ data: [object] }, null, 2) + '\n'));
}

const posts = readEntries('content').sort((a, b) => new Date(b.data.date) - new Date(a.data.date));
const blogs = posts.map(({ data, content, sourcePath }, i) => ({
  id: i + 1,
  attributes: {
    Title: data.title, date: data.date, articleId: data.articleId, Content: content,
    slug: data.slug, sourcePath,
    ...(data.description ? { description: data.description } : {}),
  },
}));
const notes = readEntries('notes').sort((a, b) => new Date(b.data.publishedAt) - new Date(a.data.publishedAt));
const noteObjects = notes.map(({ data, content, sourcePath }) => ({
  noteId: data.noteId, slug: data.slug, publishedAt: data.publishedAt, content, sourcePath,
}));
fs.mkdirSync(generated, { recursive: true });
fs.writeFileSync(path.join(generated, 'content.json'), JSON.stringify({ data: blogs }, null, 2) + '\n');
fs.writeFileSync(path.join(generated, 'notes.json'), JSON.stringify({ data: noteObjects }, null, 2) + '\n');
writeCollection('posts', blogs, posts.map(post => post.data.slug));
writeCollection('notes', noteObjects, notes.map(note => note.data.slug));
console.log(`Generated ${blogs.length} posts and ${noteObjects.length} notes. Drafts are excluded.`);
