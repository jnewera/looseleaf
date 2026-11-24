// Zero-dependency HTTP server: static files + a small JSON API.
// Binds to 127.0.0.1 only; the journal never leaves this machine.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, ValidationError } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 5 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {Store} store */
export function createServer(store, { publicDir = PUBLIC_DIR } = {}) {
  return http.createServer(async (req, res) => {
    try {
      // Block DNS-rebinding: only accept requests addressed to localhost.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') throw new HttpError(403, 'forbidden host');

      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(store, req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return await serveStatic(publicDir, url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof ValidationError ? 400 : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'internal error' : err.message });
    }
  });
}

async function handleApi(store, req, res, url) {
  const { method } = req;
  const pageMatch = url.pathname.match(/^\/api\/pages\/([\w-]{1,64})$/);

  if (method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (method === 'GET' && url.pathname === '/api/notebook') return sendJson(res, 200, store.notebook());

  if (method === 'PUT' && pageMatch) {
    const body = await readJson(req);
    if (body.id !== pageMatch[1]) throw new HttpError(400, 'id mismatch');
    return sendJson(res, 200, await store.upsertPage(body));
  }
  if (method === 'DELETE' && pageMatch) {
    if (!(await store.deletePage(pageMatch[1]))) throw new HttpError(404, 'not found');
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && url.pathname === '/api/import') {
    const body = await readJson(req);
    return sendJson(res, 200, await store.importNotebook(body.notebook, body.mode));
  }
  throw new HttpError(404, 'not found');
}

async function readJson(req) {
  // Requiring JSON forces a CORS preflight, so other websites can't post here.
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'expected application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

async function serveStatic(publicDir, pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) throw new HttpError(404, 'not found');
  let body;
  try {
    body = await fs.readFile(file);
  } catch {
    throw new HttpError(404, 'not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'",
  });
  res.end(body);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Run directly: `node server/server.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4317);
  const dataDir = path.resolve(process.env.JOURNAL_DATA ?? path.join(ROOT, 'data'));
  const store = await new Store(dataDir).load();
  createServer(store)
    .on('error', (err) => {
      console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use (is Looseleaf already running?)` : err);
      process.exit(1);
    })
    .listen(port, '127.0.0.1', () => console.log(`Looseleaf running at http://127.0.0.1:${port}  (data: ${dataDir})`));
}
