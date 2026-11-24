// Storage layer: one JSON file, atomic writes, daily rolling backups.
// Kept independent of HTTP so a future sync service can reuse it.
import fs from 'node:fs/promises';
import path from 'node:path';

export const LINE_TYPES = new Set(['text', 'bullet', 'todo']);
const MAX_LINES = 500;
const MAX_TEXT = 10_000;
const BACKUP_RE = /^journal-\d{4}-\d{2}-\d{2}.*\.json$/;

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Validate and normalize a page coming from a client. Throws on bad input. */
export function sanitizePage(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('page must be an object');
  const { id, date, order, createdAt, updatedAt, deleted, lines } = input;
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new ValidationError('invalid id');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('invalid date');
  if (typeof order !== 'number' || !Number.isFinite(order)) throw new ValidationError('invalid order');
  for (const [k, v] of [['createdAt', createdAt], ['updatedAt', updatedAt]]) {
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new ValidationError(`invalid ${k}`);
  }
  if (!Array.isArray(lines) || lines.length > MAX_LINES) throw new ValidationError('invalid lines');
  return {
    id,
    date,
    order,
    createdAt,
    updatedAt,
    deleted: deleted === true,
    lines: lines.map((l) => {
      if (!l || !LINE_TYPES.has(l.type) || typeof l.text !== 'string' || l.text.length > MAX_TEXT) {
        throw new ValidationError('invalid line');
      }
      return l.type === 'todo'
        ? { type: 'todo', text: l.text, done: l.done === true }
        : { type: l.type, text: l.text };
    }),
  };
}

export const DEFAULT_META = Object.freeze({ title: 'Looseleaf', owner: '', updatedAt: new Date(0).toISOString() });

/** Validate notebook-level details shown on the cover. Throws on bad input. */
export function sanitizeMeta(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('meta must be an object');
  const { title, owner, updatedAt } = input;
  if (typeof title !== 'string' || title.length > 80) throw new ValidationError('invalid title');
  if (typeof owner !== 'string' || owner.length > 80) throw new ValidationError('invalid owner');
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) throw new ValidationError('invalid updatedAt');
  return { title: title.trim() || DEFAULT_META.title, owner: owner.trim(), updatedAt };
}

export class ValidationError extends Error {}

export class Store {
  /**
   * @param {string} dir data directory (created if missing)
   * @param {{ backupKeep?: number, now?: () => Date }} [opts]
   */
  constructor(dir, { backupKeep = 30, now = () => new Date() } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'journal.json');
    this.backupDir = path.join(dir, 'backups');
    this.backupKeep = backupKeep;
    this.now = now;
    this.data = { version: 1, meta: { ...DEFAULT_META }, pages: [] };
    this.queue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.backupDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        version: 1,
        meta: parsed.meta ? sanitizeMeta(parsed.meta) : { ...DEFAULT_META },
        pages: (parsed.pages ?? []).map(sanitizePage),
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  /** Notebook details plus all pages (including tombstones), sorted by order. */
  notebook() {
    return { version: 1, meta: { ...this.data.meta }, pages: [...this.data.pages].sort((a, b) => a.order - b.order) };
  }

  /** Last-write-wins update of the notebook's title/owner. Returns the stored meta. */
  async setMeta(input) {
    const meta = sanitizeMeta(input);
    if (Date.parse(meta.updatedAt) < Date.parse(this.data.meta.updatedAt)) return { ...this.data.meta };
    this.data.meta = meta;
    await this.save();
    return { ...meta };
  }

  /** Last-write-wins upsert. Returns the stored page. */
  async upsertPage(input) {
    const page = sanitizePage(input);
    const i = this.data.pages.findIndex((p) => p.id === page.id);
    if (i === -1) this.data.pages.push(page);
    else if (Date.parse(page.updatedAt) >= Date.parse(this.data.pages[i].updatedAt)) this.data.pages[i] = page;
    else return this.data.pages[i];
    await this.save();
    return page;
  }

  /** Soft delete: keep a tombstone so deletions can sync later. */
  async deletePage(id) {
    const page = this.data.pages.find((p) => p.id === id);
    if (!page) return false;
    Object.assign(page, { deleted: true, lines: [], updatedAt: this.now().toISOString() });
    await this.save();
    return true;
  }

  /**
   * Import a notebook. "replace" tombstones every existing page first;
   * "merge" keeps whichever copy of each page is newer.
   */
  async importNotebook(notebook, mode) {
    if (!notebook || !Array.isArray(notebook.pages)) throw new ValidationError('invalid notebook');
    if (mode !== 'replace' && mode !== 'merge') throw new ValidationError('invalid mode');
    const incoming = notebook.pages.map(sanitizePage);
    await this.backup(`-preimport-${this.now().getTime()}`);
    const stamp = this.now().toISOString();
    const byId = new Map(this.data.pages.map((p) => [p.id, p]));
    if (mode === 'replace') {
      for (const p of byId.values()) Object.assign(p, { deleted: true, lines: [], updatedAt: stamp });
      for (const p of incoming) byId.set(p.id, { ...p, deleted: false, updatedAt: stamp });
    } else {
      for (const p of incoming) {
        const cur = byId.get(p.id);
        if (!cur || Date.parse(p.updatedAt) > Date.parse(cur.updatedAt)) byId.set(p.id, p);
      }
    }
    this.data.pages = [...byId.values()];
    if (notebook.meta) {
      const meta = sanitizeMeta(notebook.meta);
      if (mode === 'replace') this.data.meta = { ...meta, updatedAt: stamp };
      else if (Date.parse(meta.updatedAt) > Date.parse(this.data.meta.updatedAt)) this.data.meta = meta;
    }
    await this.save();
    return this.notebook();
  }

  /** Serialize writes so concurrent saves never interleave. */
  save() {
    const run = this.queue.then(() => this.#write());
    this.queue = run.catch(() => {});
    return run;
  }

  async #write() {
    await this.backup('', { onlyIfMissing: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.notebook(), null, 2));
    await renameWithRetry(tmp, this.file);
  }

  /** Copy the current file into backups/ and prune old copies. */
  async backup(suffix = '', { onlyIfMissing = false } = {}) {
    const target = path.join(this.backupDir, `journal-${localDate(this.now())}${suffix}.json`);
    if (onlyIfMissing && (await exists(target))) return;
    try {
      await fs.copyFile(this.file, target);
    } catch (err) {
      if (err.code === 'ENOENT') return; // nothing saved yet
      throw err;
    }
    const files = (await fs.readdir(this.backupDir)).filter((f) => BACKUP_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - this.backupKeep))) {
      await fs.rm(path.join(this.backupDir, f), { force: true });
    }
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// On Windows, antivirus or indexers can briefly lock the target file.
async function renameWithRetry(from, to, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}
