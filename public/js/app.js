import { api } from './api.js';
import { PageEditor } from './editor.js';
import { toJson, toMarkdown, download } from './export.js';

const SAVE_DELAY = 400;
const $ = (sel) => document.querySelector(sel);

const notebookEl = $('#notebook');
const indexEl = $('#index');
const searchEl = $('#search');
const statusEl = $('#status');
const template = $('#page-template');

/** @type {object[]} live (non-deleted) pages, sorted by order */
let pages = [];
/** @type {Map<string, {section: HTMLElement, editor: PageEditor}>} */
const views = new Map();
const dirty = new Set();
let saveTimer = null;
let currentId = null;

// ---------- Helpers ----------

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const prettyDate = (iso) =>
  new Date(`${iso}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function newPage(order) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), date: today(), order, createdAt: now, updatedAt: now, deleted: false, lines: [{ type: 'text', text: '' }] };
}

// ---------- Saving ----------

function markDirty(page) {
  page.updatedAt = new Date().toISOString();
  dirty.add(page.id);
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

async function flush({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  const ids = [...dirty];
  dirty.clear();
  const results = await Promise.allSettled(
    ids.map((id) => {
      const page = pages.find((p) => p.id === id);
      return page ? api.savePage(page, { keepalive }) : null;
    }),
  );
  const failed = ids.filter((_, i) => results[i].status === 'rejected');
  if (failed.length) {
    failed.forEach((id) => dirty.add(id));
    setStatus('Not saved: is the Looseleaf server running? Retrying…', true);
    saveTimer = setTimeout(flush, 3000);
  } else if (ids.length) {
    setStatus(`Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  }
}

// ---------- Rendering ----------

function renderPage(page) {
  const section = template.content.firstElementChild.cloneNode(true);
  section.id = `p-${page.id}`;
  const dateEl = section.querySelector('.page-date');
  dateEl.value = page.date;
  dateEl.addEventListener('change', () => {
    if (!dateEl.value) return void (dateEl.value = page.date);
    page.date = dateEl.value;
    markDirty(page);
    renderIndex();
  });
  section.querySelector('.page-delete').addEventListener('click', () => deletePage(page));

  const editor = new PageEditor(section.querySelector('.editor'), {
    onChange: () => {
      page.lines = editor.getLines();
      markDirty(page);
      scheduleIndex();
      if (searchEl.value) highlight();
    },
    onOverflow: (lines, caret) => handleOverflow(page, lines, caret),
  });
  editor.setLines(page.lines);
  section.addEventListener('focusin', () => setCurrent(page.id));
  views.set(page.id, { section, editor });
  return section;
}

function renderAll() {
  views.clear();
  notebookEl.replaceChildren(...pages.map(renderPage));
  renumber();
  renderIndex();
}

function renumber() {
  pages.forEach((p, i) => {
    views.get(p.id).section.querySelector('.page-num').textContent = `Page ${i + 1}`;
  });
}

function setCurrent(id) {
  if (currentId === id) return;
  currentId = id;
  indexEl.querySelectorAll('a').forEach((a) => a.classList.toggle('current', a.dataset.id === id));
}

// ---------- Index & search ----------

let indexTimer = null;
function scheduleIndex() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(renderIndex, 250);
}

function renderIndex() {
  const q = searchEl.value.trim().toLowerCase();
  const rows = [];
  pages.forEach((p, i) => {
    const allText = p.lines.map((l) => l.text).join('\n');
    if (q && !allText.toLowerCase().includes(q) && !p.date.includes(q)) return;
    const first = p.lines.find((l) => l.text.trim())?.text ?? '';
    const a = document.createElement('a');
    a.href = `#p-${p.id}`;
    a.dataset.id = p.id;
    a.classList.toggle('current', p.id === currentId);
    a.innerHTML = '<span class="num"></span><span class="date"></span><span class="first"></span>';
    a.querySelector('.num').textContent = i + 1;
    a.querySelector('.date').textContent = prettyDate(p.date);
    a.querySelector('.first').textContent = snippet(allText, q) || first || '(blank page)';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      goTo(p.id);
    });
    rows.push(a);
  });
  if (!rows.length) {
    const msg = document.createElement('p');
    msg.className = 'empty-msg';
    msg.textContent = q ? 'No matches.' : 'No pages yet.';
    rows.push(msg);
  }
  indexEl.replaceChildren(...rows);
}

/** For search results, show the text around the match instead of the first line. */
function snippet(text, q) {
  if (!q) return '';
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return '';
  const start = Math.max(0, at - 20);
  return (start ? '…' : '') + text.slice(start, at + q.length + 40).replace(/\n/g, ' ');
}

/** Highlight matches using the CSS Custom Highlight API (doesn't touch the editable DOM). */
function highlight() {
  if (!globalThis.CSS?.highlights) return;
  CSS.highlights.delete('search');
  const q = searchEl.value.trim().toLowerCase();
  if (!q) return;
  const ranges = [];
  for (const { editor } of views.values()) {
    const walker = document.createTreeWalker(editor.el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const lower = node.textContent.toLowerCase();
      for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
        const r = new Range();
        r.setStart(node, i);
        r.setEnd(node, i + q.length);
        ranges.push(r);
      }
    }
  }
  CSS.highlights.set('search', new Highlight(...ranges));
}

function goTo(id, { focus = false } = {}) {
  const view = views.get(id);
  if (!view) return;
  view.section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setCurrent(id);
  if (focus) view.editor.focusAt(0, 0);
}

// ---------- Page operations ----------

function addPage({ afterId = null, focus = true } = {}) {
  const i = afterId ? pages.findIndex((p) => p.id === afterId) : pages.length - 1;
  const prev = pages[i];
  const next = pages[i + 1];
  const order = prev ? (next ? (prev.order + next.order) / 2 : prev.order + 1) : 1;
  const page = newPage(order);
  pages.splice(i + 1, 0, page);
  const section = renderPage(page);
  if (prev) views.get(prev.id).section.after(section);
  else notebookEl.prepend(section);
  renumber();
  renderIndex();
  markDirty(page);
  if (focus) goTo(page.id, { focus: true });
  return page;
}

/** Text that didn't fit on `page` goes to the top of the next page (created if needed). */
function handleOverflow(page, lines, caret) {
  const i = pages.findIndex((p) => p.id === page.id);
  const next = pages[i + 1] ?? addPage({ afterId: page.id, focus: false });
  const { editor } = views.get(next.id);
  editor.prependLines(lines);
  if (caret) {
    editor.focusAt(caret.i, caret.o);
    setCurrent(next.id);
  }
  editor.commitExternalChange(); // may cascade to the page after
}

async function deletePage(page) {
  const hasText = page.lines.some((l) => l.text.trim());
  if (hasText && !confirm(`Delete page ${pages.indexOf(page) + 1} (${prettyDate(page.date)})? This can't be undone.`)) return;
  try {
    dirty.delete(page.id);
    await api.deletePage(page.id).catch((err) => {
      if (!String(err.message).startsWith('404')) throw err; // never saved yet: fine
    });
  } catch {
    setStatus('Could not delete: is the Looseleaf server running?', true);
    return;
  }
  pages = pages.filter((p) => p !== page);
  views.get(page.id).section.remove();
  views.delete(page.id);
  if (!pages.length) addPage();
  renumber();
  renderIndex();
  setStatus('Page deleted');
}

// ---------- Import / export ----------

function exportName(ext) {
  return `looseleaf-${today()}.${ext}`;
}

async function importFile(file) {
  let notebook;
  try {
    notebook = JSON.parse(await file.text());
    if (!Array.isArray(notebook.pages)) throw new Error('missing pages');
  } catch {
    setStatus('That file is not a journal backup.', true);
    return;
  }
  const live = notebook.pages.filter((p) => !p.deleted);
  $('#import-summary').textContent = `${file.name}: ${live.length} page${live.length === 1 ? '' : 's'}.`;
  const dialog = $('#import-dialog');
  dialog.showModal();
  const mode = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (mode !== 'merge' && mode !== 'replace') return;
  try {
    await flush();
    const result = await api.importNotebook({ ...notebook, pages: live }, mode);
    pages = result.pages.filter((p) => !p.deleted);
    renderAll();
    setStatus(`Imported ${live.length} pages (${mode})`);
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, true);
  }
}

// ---------- Theme ----------

function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = isDark ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', root.dataset.theme);
  } catch {}
}

// ---------- Wiring ----------

function wire() {
  $('#new-page').addEventListener('click', () => addPage());
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#export-json').addEventListener('click', () => download(exportName('json'), toJson(pages), 'application/json'));
  $('#export-md').addEventListener('click', () => download(exportName('md'), toMarkdown(pages), 'text/markdown'));
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });

  searchEl.addEventListener('input', () => {
    renderIndex();
    highlight();
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchEl.value = '';
      renderIndex();
      highlight();
    } else if (e.key === 'Enter') {
      const first = indexEl.querySelector('a');
      if (first) goTo(first.dataset.id);
    }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      addPage();
    }
  });

  // Never lose the last keystrokes.
  addEventListener('blur', () => flush());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush({ keepalive: true }));
  addEventListener('pagehide', () => flush({ keepalive: true }));
}

async function init() {
  wire();
  try {
    const nb = await api.getNotebook();
    pages = nb.pages.filter((p) => !p.deleted).sort((a, b) => a.order - b.order);
  } catch {
    setStatus('Could not reach the Looseleaf server. Start it with "npm start".', true);
    return;
  }
  renderAll();
  if (!pages.length) addPage();
  else {
    setStatus(`${pages.length} page${pages.length === 1 ? '' : 's'}`);
    // Start where you left off: the last page.
    const last = pages[pages.length - 1];
    views.get(last.id).section.scrollIntoView({ block: 'start' });
    setCurrent(last.id);
  }
}

init();
