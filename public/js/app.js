import { api } from './api.js';
import { PageEditor, fillStatic } from './editor.js';
import { Book } from './book.js';
import { toJson, toMarkdown, download } from './export.js';
import { createDictation, parseTranscript } from './dictation.js';
import { hint } from './shortcuts.js';
import {
  icon, prettyDate, createMenu, createContents, confirmDelete, editDetails,
  askImportMode, openShortcuts, anyDialogOpen,
} from './menu.js';

const SAVE_DELAY = 400;
const TIP_KEY = 'looseleaf.tipDismissed';
const $ = (sel) => document.querySelector(sel);

/** @type {{title:string, owner:string, updatedAt:string}} */
let meta = { title: 'Looseleaf', owner: '', updatedAt: new Date(0).toISOString() };
/** @type {object[]} live (non-deleted) pages, sorted by order */
let pages = [];
/** Pages with an editor on screen: id -> { section, editor } */
const live = new Map();
const dirty = new Set();
let saveTimer = null;
let currentPageId = null;

// ---------- Small helpers ----------

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let statusTimer = null;
function setStatus(text, { error = false, sticky = false } = {}) {
  const el = $('#status');
  clearTimeout(statusTimer);
  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.remove('faded');
  if (!error && !sticky && text) statusTimer = setTimeout(() => el.classList.add('faded'), 2000);
}

function newPage(order) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), date: today(), order, createdAt: now, updatedAt: now, deleted: false, lines: [{ type: 'text', text: '' }] };
}

const tryStorage = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

// ---------- Saving ----------

function markDirty(page) {
  page.updatedAt = new Date().toISOString();
  dirty.add(page.id);
  setStatus('Saving…', { sticky: true });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

async function flush({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  const ids = [...dirty];
  dirty.clear();
  if (!ids.length) return;
  const results = await Promise.allSettled(
    ids.map((id) => {
      const page = pages.find((p) => p.id === id);
      return page ? api.savePage(page, { keepalive }) : null;
    }),
  );
  const failed = ids.filter((_, i) => results[i].status === 'rejected');
  if (failed.length) {
    failed.forEach((id) => dirty.add(id));
    setStatus('Not saved. Is the Looseleaf server running? Retrying…', { error: true });
    saveTimer = setTimeout(flush, 3000);
  } else {
    setStatus('Saved');
  }
}

// ---------- Page rendering ----------

function editorCallbacks(page, getEditor) {
  return {
    onChange: () => {
      page.lines = getEditor().getLines();
      markDirty(page);
      if (contents.isOpen) contents.render(pages, currentPageId);
      if (contents.query) highlight();
    },
    onOverflow: (lines, caret) => handleOverflow(page, lines, caret),
  };
}

function buildPage(page, { live: isLive, side }) {
  const index = pages.indexOf(page);
  const section = $('#page-template').content.firstElementChild.cloneNode(true);
  section.classList.add(side);
  section.dataset.id = page.id;
  const dateBtn = section.querySelector('.page-date');
  const dateInput = section.querySelector('.page-date-input');
  dateBtn.textContent = prettyDate(page.date);
  dateInput.value = page.date;
  section.querySelector('.page-num').textContent = index + 1;
  const corner = section.querySelector('.corner');
  corner.title = side === 'left' ? `Previous page (${hint('prev')})` : `Next page (${hint('next')})`;
  corner.setAttribute('aria-label', side === 'left' ? 'Previous page' : 'Next page');
  const editorEl = section.querySelector('.editor');

  if (!isLive) {
    section.classList.add('static');
    fillStatic(editorEl, page.lines);
    return { section, editor: null };
  }

  corner.addEventListener('click', () => (side === 'left' ? book.prev() : book.next()));
  dateBtn.addEventListener('click', () => {
    try {
      dateInput.showPicker();
    } catch {
      dateInput.click();
    }
  });
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return void (dateInput.value = page.date);
    page.date = dateInput.value;
    dateBtn.textContent = prettyDate(page.date);
    markDirty(page);
  });
  section.addEventListener('focusin', () => {
    currentPageId = page.id;
  });
  const editor = new PageEditor(editorEl, editorCallbacks(page, () => editor));
  editor.setLines(page.lines);
  return { section, editor };
}

function buildBlank({ live: isLive, side }) {
  const section = document.createElement('section');
  section.className = `page blank ${side}${isLive ? '' : ' static'}`;
  const hintEl = document.createElement('div');
  hintEl.className = 'blank-hint';
  const text = document.createElement('span');
  text.textContent = 'Click to start a new page';
  hintEl.append(icon('plus'), text);
  section.append(hintEl);
  if (isLive) {
    section.title = `New page (${hint('new-page')})`;
    section.addEventListener('click', () => addPage());
  }
  return section;
}

/** Book callback: build the DOM for one slot. */
function renderSlot(slot, opts) {
  if (slot.kind === 'inside') return null; // the cover's lining shows through
  if (slot.kind === 'blank') return buildBlank(opts);
  const page = pages[slot.index];
  const { section, editor } = buildPage(page, opts);
  if (editor) live.set(page.id, { section, editor });
  return section;
}

/** Editor for a page: the on-screen one, or a temporary off-screen one for measuring. */
function editorFor(page) {
  const entry = live.get(page.id);
  if (entry?.section.isConnected) return entry.editor;
  const { section, editor } = buildPage(page, { live: true, side: 'right' });
  $('#measure').append(section);
  return editor;
}

const visibleEntries = () => [...live.entries()].filter(([, e]) => e.section.isConnected);

/** Book callback: after any render, turn, open or close. */
function onBookChange() {
  for (const [id, e] of live) if (!e.section.isConnected) live.delete(id);
  for (const [id, e] of live) {
    e.section.querySelector('.page-num').textContent = pages.findIndex((p) => p.id === id) + 1;
    e.editor.reflow(); // older/larger pages get split onto the next page
  }
  if (!visibleEntries().some(([id]) => id === currentPageId)) {
    currentPageId = visibleEntries().at(-1)?.[0] ?? currentPageId;
  }
  updateBar();
  highlight();
}

function updateBar() {
  const n = pages.length;
  const label = $('#page-label');
  const nextBtn = $('#next-btn');
  if (book.state !== 'open' && book.state !== 'opening') {
    label.textContent = 'Click the cover to open';
    return;
  }
  const nums = book.slotsFor(book.view).filter((s) => s.kind === 'page').map((s) => s.index + 1);
  label.textContent = !nums.length ? 'New page' : nums.length === 1 ? `Page ${nums[0]} of ${n}` : `Pages ${nums[0]}–${nums[1]} of ${n}`;
  $('#prev-btn').disabled = book.view === 0;
  $('#prev-btn').title = `Previous page (${hint('prev')})`;
  const atEnd = book.view >= book.lastView;
  nextBtn.querySelector('use').setAttribute('href', `img/icons.svg#${atEnd ? 'plus' : 'chevron-right'}`);
  nextBtn.title = atEnd ? `New page (${hint('new-page')})` : `Next page (${hint('next')})`;
  nextBtn.setAttribute('aria-label', atEnd ? 'New page' : 'Next page');
}

// ---------- Page operations ----------

/** Add a page after `after` (default: at the end). Returns it immediately. */
function addPage({ after = null, focus = true } = {}) {
  const i = after ? pages.indexOf(after) : pages.length - 1;
  const prev = pages[i];
  const next = pages[i + 1];
  const order = prev ? (next ? (prev.order + next.order) / 2 : prev.order + 1) : 1;
  const page = newPage(order);
  pages.splice(i + 1, 0, page);
  markDirty(page);
  book.render();
  if (focus) goToPage(page, { focus: 'start' });
  return page;
}

/** Open the book if needed, turn to the page, and optionally place the caret. */
async function goToPage(page, { focus = null, caret = null } = {}) {
  if (!book.isOpen) await openBook();
  await book.turnTo(book.viewOfPage(pages.indexOf(page)));
  const entry = live.get(page.id);
  currentPageId = page.id;
  if (!entry) return;
  if (caret) entry.editor.focusAt(caret.i, caret.o);
  else if (focus === 'start') entry.editor.focusAt(0, 0);
  else if (focus === 'end') entry.editor.focusEnd();
}

/** Text that didn't fit on `page` goes to the top of the next page (created if needed). */
function handleOverflow(page, lines, caret) {
  const i = pages.indexOf(page);
  const next = pages[i + 1] ?? addPage({ after: page, focus: false });
  const editor = editorFor(next);
  editor.prependLines(lines);
  if (caret && live.get(next.id)?.section.isConnected) editor.focusAt(caret.i, caret.o);
  editor.commitExternalChange(); // may cascade onto the page after
  if (!$('#measure').contains(document.activeElement)) $('#measure').replaceChildren();
  if (caret && !live.get(next.id)?.section.isConnected) goToPage(next, { caret });
  else if (caret) currentPageId = next.id;
}

function currentPage() {
  return pages.find((p) => p.id === currentPageId) ?? pages[book.slotsFor(book.view).find((s) => s.kind === 'page')?.index];
}

async function deletePage(page) {
  if (!page) return;
  const number = pages.indexOf(page) + 1;
  if (!(await confirmDelete({ number, date: page.date, lines: page.lines }))) return;
  try {
    dirty.delete(page.id);
    await api.deletePage(page.id).catch((err) => {
      if (!String(err.message).startsWith('404')) throw err; // never saved yet: fine
    });
  } catch {
    setStatus('Could not delete. Is the Looseleaf server running?', { error: true });
    return;
  }
  pages = pages.filter((p) => p !== page);
  live.delete(page.id);
  if (currentPageId === page.id) currentPageId = null;
  if (!pages.length) addPage({ focus: false });
  book.render();
  if (contents.isOpen) contents.render(pages, currentPageId);
  setStatus(`Page ${number} deleted`);
}

// ---------- Search highlight ----------

/** Highlight matches using the CSS Custom Highlight API (doesn't touch the editable DOM). */
function highlight() {
  if (!globalThis.CSS?.highlights) return;
  CSS.highlights.delete('search');
  const q = contents.query;
  if (!q) return;
  const ranges = [];
  for (const [, { editor }] of visibleEntries()) {
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

// ---------- Cover & notebook details ----------

function applyMeta() {
  $('.cover-title').textContent = meta.title;
  $('.cover-owner').textContent = meta.owner;
  $('.endpaper-owner').textContent = meta.owner;
  $('.endpaper-title').textContent = meta.title;
  $('.menu-title').textContent = meta.title;
  document.title = meta.title;
}

async function editNotebookDetails() {
  const result = await editDetails(meta);
  if (!result) return;
  meta = { ...result, updatedAt: new Date().toISOString() };
  applyMeta();
  try {
    meta = await api.saveMeta(meta);
    setStatus('Saved');
  } catch {
    setStatus('Could not save notebook details.', { error: true });
  }
}

async function openBook() {
  await book.open();
  if (!tryStorage(() => localStorage.getItem(TIP_KEY))) $('#tip').hidden = false;
  const entry = live.get(currentPage()?.id);
  if (entry && !document.activeElement?.closest('.editor')) entry.editor.focusEnd();
}

async function closeBook() {
  dictation?.stop();
  await flush();
  await book.close();
  $('.cover-front').focus();
}

function dismissTip() {
  $('#tip').hidden = true;
  tryStorage(() => localStorage.setItem(TIP_KEY, '1'));
}

// ---------- Import / export ----------

const exportName = (ext) => `looseleaf-${today()}.${ext}`;

async function importFile(file) {
  let notebook;
  try {
    notebook = JSON.parse(await file.text());
    if (!Array.isArray(notebook.pages)) throw new Error('missing pages');
  } catch {
    setStatus('That file is not a Looseleaf backup.', { error: true });
    return;
  }
  const kept = notebook.pages.filter((p) => !p.deleted);
  const mode = await askImportMode(`${file.name}: ${kept.length} page${kept.length === 1 ? '' : 's'}.`);
  if (mode !== 'merge' && mode !== 'replace') return;
  try {
    await flush();
    const result = await api.importNotebook({ ...notebook, pages: kept }, mode);
    pages = result.pages.filter((p) => !p.deleted);
    meta = result.meta;
    applyMeta();
    if (!pages.length) addPage({ focus: false });
    live.clear();
    book.view = Math.min(book.view, book.lastView);
    book.render(true);
    setStatus(`Imported ${kept.length} pages (${mode})`);
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, { error: true });
  }
}

// ---------- Theme ----------

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  tryStorage(() => localStorage.setItem('theme', next));
}

// ---------- Dictation ----------

const caption = $('#dictation-caption');
const micBtn = $('#mic-btn');

function positionCaption() {
  const sel = getSelection();
  let rect = null;
  if (sel.rangeCount && document.activeElement?.closest?.('.editor')) {
    const r = sel.getRangeAt(0).cloneRange();
    rect = r.getClientRects()[0] ?? r.startContainer.parentElement?.getBoundingClientRect?.();
  }
  if (!rect) rect = micBtn.getBoundingClientRect();
  caption.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 440))}px`;
  caption.style.top = `${Math.min(rect.bottom + 8, innerHeight - 44)}px`;
}

/** Editor that should receive dictated text: the focused one, else the current page. */
function dictationTarget() {
  const focused = visibleEntries().find(([, e]) => e.editor.el === document.activeElement);
  if (focused) return focused[1].editor;
  const entry = live.get(currentPage()?.id);
  if (!entry?.section.isConnected) return null;
  entry.editor.focusEnd();
  return entry.editor;
}

function insertDictation(transcript) {
  for (const part of parseTranscript(transcript)) {
    const editor = dictationTarget();
    if (!editor) return;
    if (part.command === 'newline') {
      editor.newLine();
      continue;
    }
    const before = editor.textBeforeCaret() ?? '';
    let text = part.text;
    if (!before.trim() || /[.!?]\s*$/.test(before)) text = text[0].toUpperCase() + text.slice(1);
    if (before && !/\s$/.test(before)) text = ` ${text}`;
    document.execCommand('insertText', false, text);
  }
  positionCaption();
}

const dictation = createDictation({
  onState(listening) {
    micBtn.setAttribute('aria-pressed', String(listening));
    micBtn.querySelector('use').setAttribute('href', `img/icons.svg#${listening ? 'mic-off' : 'mic'}`);
    micBtn.title = `${listening ? 'Stop dictation' : 'Start dictation'} (${hint('dictation')})`;
    caption.hidden = !listening;
    if (listening) {
      caption.querySelector('.text').textContent = 'Listening…';
      positionCaption();
    }
  },
  onInterim(text) {
    caption.querySelector('.text').textContent = text || 'Listening…';
    positionCaption();
  },
  onFinal: insertDictation,
  onError: (message) => setStatus(message, { error: true }),
});

async function toggleDictation() {
  if (!dictation) return;
  if (!dictation.listening && !book.isOpen) await openBook();
  if (!dictation.listening) dictationTarget();
  dictation.toggle();
}

// ---------- Menu, contents, wiring ----------

const book = new Book($('.book'), {
  pageCount: () => pages.length,
  pageIdAt: (i) => pages[i].id,
  renderSlot,
  onChange: onBookChange,
});

const contents = createContents({
  onQuery: () => {
    contents.render(pages, currentPageId);
    highlight();
  },
  onPick: (i) => goToPage(pages[i], { focus: 'end' }),
  onDelete: (i) => deletePage(pages[i]),
});

const menu = createMenu([
  { id: 'contents', icon: 'contents', label: 'Contents & search', shortcut: 'contents', action: () => contents.open(pages, currentPageId) },
  { id: 'new-page', icon: 'plus', label: 'New page', shortcut: 'new-page', action: () => addPage() },
  {
    id: 'dictation', icon: 'mic', label: () => (dictation?.listening ? 'Stop dictation' : 'Dictation'),
    shortcut: 'dictation', hidden: () => !dictation, action: toggleDictation,
  },
  { id: 'delete', icon: 'trash', label: 'Delete this page…', danger: true, disabled: () => !book.isOpen, action: () => deletePage(currentPage()) },
  'sep',
  { id: 'details', icon: 'edit', label: 'Notebook details…', action: editNotebookDetails },
  {
    id: 'theme', icon: 'moon', iconFor: () => (isDark() ? 'sun' : 'moon'),
    label: () => (isDark() ? 'Day mode' : 'Night mode'), action: toggleTheme,
  },
  { id: 'shortcuts', icon: 'keyboard', label: 'Keyboard shortcuts', shortcut: 'shortcuts', action: showShortcuts },
  'sep',
  { id: 'export-json', icon: 'download', label: 'Export backup (JSON)', action: () => download(exportName('json'), toJson(pages, meta), 'application/json') },
  { id: 'export-md', icon: 'file-text', label: 'Export as Markdown', action: () => download(exportName('md'), toMarkdown(pages, meta), 'text/markdown') },
  { id: 'import', icon: 'upload', label: 'Import backup…', action: () => $('#import-file').click() },
  'sep',
  { id: 'close', icon: 'book-closed', label: 'Close notebook', disabled: () => !book.isOpen, action: closeBook },
]);

function showShortcuts() {
  dismissTip();
  openShortcuts();
}

const isTyping = () => !!document.activeElement?.closest?.('input, textarea, [contenteditable="true"]');

function wire() {
  const cover = $('.cover-front');
  cover.addEventListener('click', openBook);
  cover.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openBook();
    }
  });
  $('.endpaper-owner').addEventListener('click', editNotebookDetails);
  $('#prev-btn').addEventListener('click', () => book.prev());
  $('#next-btn').addEventListener('click', () => (book.view >= book.lastView ? addPage() : book.next()));
  $('#tip-close').addEventListener('click', dismissTip);
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });
  if (dictation) {
    micBtn.hidden = false;
    micBtn.title = `Start dictation (${hint('dictation')})`;
    micBtn.addEventListener('click', toggleDictation);
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape' && dictation?.listening && !anyDialogOpen()) return void dictation.stop();
    if (mod && !e.shiftKey && (key === 'k' || key === 'f')) {
      e.preventDefault();
      menu.close();
      return void contents.open(pages, currentPageId);
    }
    if (mod && e.shiftKey && key === 'n') {
      e.preventDefault();
      return void addPage();
    }
    if (mod && e.shiftKey && key === 'd') {
      e.preventDefault();
      return void toggleDictation();
    }
    if ((mod && key === '/') || (e.key === '?' && !isTyping())) {
      e.preventDefault();
      menu.close();
      return void showShortcuts();
    }
    if (anyDialogOpen() || !book.isOpen) return;
    if (e.key === 'PageDown' || (e.altKey && e.key === 'ArrowRight')) {
      e.preventDefault();
      book.next();
    } else if (e.key === 'PageUp' || (e.altKey && e.key === 'ArrowLeft')) {
      e.preventDefault();
      book.prev();
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
    meta = nb.meta ?? meta;
    pages = nb.pages.filter((p) => !p.deleted).sort((a, b) => a.order - b.order);
  } catch {
    setStatus('Could not reach the Looseleaf server. Start it with "npm start".', { error: true });
    return;
  }
  applyMeta();
  if (!pages.length) addPage({ focus: false });
  book.fit();
  book.view = book.viewOfPage(pages.length - 1); // open where you left off
  book.render(true);
  $('.cover-front').focus();
}

init();
