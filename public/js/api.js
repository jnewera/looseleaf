// The only module that talks to storage. A future phone/sync version can swap
// this for an offline-first implementation (IndexedDB + sync queue) with the same API.

async function request(method, url, body, { keepalive = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    keepalive,
  });
  if (!res.ok) {
    const msg = await res.json().then((j) => j.error, () => res.statusText);
    throw new Error(`${res.status} ${msg}`);
  }
  return res.json();
}

export const api = {
  /** @returns {Promise<{version:number, meta:object, pages:object[]}>} all pages, including tombstones */
  getNotebook: () => request('GET', '/api/notebook'),
  savePage: (page, opts) => request('PUT', `/api/pages/${encodeURIComponent(page.id)}`, page, opts),
  deletePage: (id) => request('DELETE', `/api/pages/${encodeURIComponent(id)}`),
  saveMeta: (meta) => request('PUT', '/api/meta', meta),
  importNotebook: (notebook, mode) => request('POST', '/api/import', { notebook, mode }),
};
