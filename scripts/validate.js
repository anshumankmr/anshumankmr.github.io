#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'generated', 'content.json'), 'utf8')
);

assert(Array.isArray(data.data), 'data.data must be an array');

for (const item of data.data) {
  assert(item.id, `id required (got ${item.id})`);
  assert(item.attributes, 'attributes required');
  assert(item.attributes.Title, `Title required for id ${item.id}`);
  assert(item.attributes.date, `date required for id ${item.id}`);
  assert(item.attributes.articleId, `articleId required for id ${item.id}`);
  assert(item.attributes.Content, `Content required for id ${item.id}`);
}

console.log(`✓ ${data.data.length} posts validated.`);
