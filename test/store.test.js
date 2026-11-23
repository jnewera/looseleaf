import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, sanitizePage, ValidationError } from '../server/store.js';

let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-test-'));
});

const page = (over = {}) => ({
  id: 'p1',
  date: '2026-11-23',
  order: 1,
  createdAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T10:00:00.000Z',
  lines: [{ type: 'todo', text: 'buy milk', done: true }],
  ...over,
});

test('persists pages and reloads them', async () => {
  const s = await new Store(dir).load();
  await s.upsertPage(page());
  const reloaded = await new Store(dir).load();
  assert.deepEqual(reloaded.notebook().pages, [{ ...page(), deleted: false }]);
});

test('writes atomically (no temp file left behind)', async () => {
  const s = await new Store(dir).load();
  await Promise.all([1, 2, 3].map((n) => s.upsertPage(page({ id: `p${n}`, order: n }))));
  const files = await fs.readdir(dir);
  assert.ok(files.includes('journal.json'));
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
  const json = JSON.parse(await fs.readFile(path.join(dir, 'journal.json'), 'utf8'));
  assert.equal(json.pages.length, 3);
});

test('last write wins: stale updates are ignored', async () => {
  const s = await new Store(dir).load();
  await s.upsertPage(page({ updatedAt: '2026-11-23T12:00:00.000Z', lines: [] }));
  const kept = await s.upsertPage(page({ updatedAt: '2026-11-23T11:00:00.000Z' }));
  assert.deepEqual(kept.lines, []);
});

test('delete leaves a tombstone for future sync', async () => {
  const s = await new Store(dir).load();
  await s.upsertPage(page());
  assert.equal(await s.deletePage('p1'), true);
  const [p] = s.notebook().pages;
  assert.equal(p.deleted, true);
  assert.deepEqual(p.lines, []);
  assert.equal(await s.deletePage('missing'), false);
});

test('rejects malformed pages', () => {
  assert.throws(() => sanitizePage(page({ id: '../etc' })), ValidationError);
  assert.throws(() => sanitizePage(page({ date: 'yesterday' })), ValidationError);
  assert.throws(() => sanitizePage(page({ lines: [{ type: 'h1', text: 'x' }] })), ValidationError);
  // Unknown fields are dropped; `done` only kept for todos.
  const clean = sanitizePage(page({ evil: 1, lines: [{ type: 'text', text: 'a', done: true }] }));
  assert.equal('evil' in clean, false);
  assert.deepEqual(clean.lines, [{ type: 'text', text: 'a' }]);
});

test('daily backups rotate, keeping only the newest N', async () => {
  let day = new Date(2026, 0, 1, 12);
  const s = await new Store(dir, { backupKeep: 3, now: () => day }).load();
  for (let i = 0; i < 6; i++) {
    day = new Date(2026, 0, 1 + i, 12);
    await s.upsertPage(page({ updatedAt: day.toISOString() }));
  }
  const backups = (await fs.readdir(path.join(dir, 'backups'))).sort();
  assert.deepEqual(backups, ['journal-2026-01-04.json', 'journal-2026-01-05.json', 'journal-2026-01-06.json']);
});

test('import: merge keeps newer pages, replace tombstones old ones', async () => {
  const s = await new Store(dir).load();
  await s.upsertPage(page({ id: 'a', updatedAt: '2026-11-23T12:00:00.000Z', lines: [] }));

  await s.importNotebook({ pages: [page({ id: 'a' }), page({ id: 'b', order: 2 })] }, 'merge');
  let pages = s.notebook().pages;
  assert.deepEqual(pages.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(pages[0].lines, [], 'older imported copy of "a" should not win');

  await s.importNotebook({ pages: [page({ id: 'c' })] }, 'replace');
  pages = s.notebook().pages;
  assert.deepEqual(pages.filter((p) => !p.deleted).map((p) => p.id), ['c']);
  assert.equal(pages.filter((p) => p.deleted).length, 2);

  const backups = await fs.readdir(path.join(dir, 'backups'));
  assert.ok(backups.some((f) => f.includes('preimport')), 'safety backup before import');
});
