import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { createServer } from '../server/server.js';

let server;
let port;

before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-srv-'));
  const store = await new Store(dir).load();
  server = createServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

/** Raw request so we can control the Host header. */
function req(method, p, { body, host = `127.0.0.1:${port}`, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { host, ...(data ? { 'content-type': type } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    r.on('error', reject);
    r.end(data);
  });
}

const page = {
  id: 'abc-123',
  date: '2026-11-23',
  order: 1,
  createdAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T10:00:00.000Z',
  lines: [{ type: 'bullet', text: 'hello' }],
};

test('serves the app shell', async () => {
  const res = await req('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<title>Looseleaf<\/title>/);
});

test('rejects non-localhost Host headers (DNS rebinding)', async () => {
  const res = await req('GET', '/api/notebook', { host: 'evil.example:4317' });
  assert.equal(res.status, 403);
});

test('blocks path traversal', async () => {
  const res = await req('GET', '/..%2fserver%2fstore.js');
  assert.equal(res.status, 404);
});

test('requires JSON content type for writes (CSRF guard)', async () => {
  const res = await req('PUT', `/api/pages/${page.id}`, { body: page, type: 'text/plain' });
  assert.equal(res.status, 415);
});

test('page CRUD round trip', async () => {
  assert.equal((await req('PUT', `/api/pages/${page.id}`, { body: page })).status, 200);
  let nb = JSON.parse((await req('GET', '/api/notebook')).text);
  assert.equal(nb.pages[0].lines[0].text, 'hello');

  assert.equal((await req('PUT', '/api/pages/other-id', { body: page })).status, 400, 'id mismatch');
  assert.equal((await req('PUT', `/api/pages/${page.id}`, { body: { ...page, lines: 'x' } })).status, 400);

  assert.equal((await req('DELETE', `/api/pages/${page.id}`)).status, 200);
  nb = JSON.parse((await req('GET', '/api/notebook')).text);
  assert.equal(nb.pages[0].deleted, true);
  assert.equal((await req('DELETE', '/api/pages/nope')).status, 404);
});

test('rejects invalid JSON', async () => {
  const res = await req('PUT', `/api/pages/${page.id}`, { body: '{not json' });
  assert.equal(res.status, 400);
});

test('meta round trip', async () => {
  const meta = { title: 'My Notes', owner: 'Jay', updatedAt: '2026-11-24T10:00:00.000Z' };
  assert.equal((await req('PUT', '/api/meta', { body: meta })).status, 200);
  const nb = JSON.parse((await req('GET', '/api/notebook')).text);
  assert.deepEqual(nb.meta, meta);
  assert.equal((await req('PUT', '/api/meta', { body: { ...meta, title: 42 } })).status, 400);
});
