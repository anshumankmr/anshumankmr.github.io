#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const CONTENT_DIR = path.join(__dirname, '..', 'content');
const GENERATED_DIR = path.join(__dirname, '..', 'generated');
const POSTS_DIR = path.join(GENERATED_DIR, 'posts');

fs.mkdirSync(POSTS_DIR, { recursive: true });

const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md'));

const posts = files
  .map(filename => {
    const raw = fs.readFileSync(path.join(CONTENT_DIR, filename), 'utf8');
    const { data, content } = matter(raw);
    return { filename, data, content: content.trim() };
  })
  .sort((a, b) => new Date(b.data.date) - new Date(a.data.date));

const blogObjects = posts.map(({ data, content }, i) => ({
  id: i + 1,
  attributes: {
    Title: data.title,
    date: data.date,
    articleId: data.articleId,
    Content: content,
  },
}));

fs.writeFileSync(
  path.join(GENERATED_DIR, 'content.json'),
  JSON.stringify({ data: blogObjects }, null, 2)
);

for (const obj of blogObjects) {
  const slug = posts[obj.id - 1].data.slug;
  fs.writeFileSync(
    path.join(POSTS_DIR, `${slug}.json`),
    JSON.stringify({ data: [obj] }, null, 2)
  );
}

console.log(`Generated ${blogObjects.length} posts.`);
