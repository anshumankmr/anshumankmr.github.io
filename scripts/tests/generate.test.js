const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, '..', 'generate.js');

test('generation includes published notes, excludes drafts, and removes stale JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anshuman-content-test-'));
  const env = { ...process.env, BLOG_CONTENT_ROOT: root };
  try {
    for (const directory of ['content', 'notes', 'draft_notes']) fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, 'content', 'post.md'), '---\ntitle: A post\ndate: "2026-10-03"\narticleId: post-id\nslug: a-post\ndescription: Custom summary.\n---\nOriginal body.\n');
    fs.writeFileSync(path.join(root, 'notes', '2026-10-03-1630-note.md'), '---\nnoteId: note-id\nslug: 2026-10-03-1630-note\npublishedAt: "2026-10-03T16:30:00+05:30"\n---\nPublished thought.\n');
    fs.writeFileSync(path.join(root, 'notes', 'README.md'), '# Notes format');
    fs.writeFileSync(path.join(root, 'draft_notes', 'private.md'), '---\nnoteId: draft-id\n---\nPrivate draft.');
    let run = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const load = name => JSON.parse(fs.readFileSync(path.join(root, 'generated', name)));
    const notes = load('notes.json').data;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].content, 'Published thought.');
    assert.equal(notes[0].sourcePath, 'notes/2026-10-03-1630-note.md');
    assert.equal(load('content.json').data[0].attributes.description, 'Custom summary.');
    assert.equal(load('content.json').data[0].attributes.Content, 'Original body.');
    assert(!JSON.stringify(notes).includes('Private draft'));
    fs.unlinkSync(path.join(root, 'notes', '2026-10-03-1630-note.md'));
    run = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(load('notes.json').data, []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'generated', 'notes')), []);
  } finally { fs.rmSync(root, { recursive: true }); }
});
