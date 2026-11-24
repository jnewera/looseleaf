// Menu panel, contents/search sheet and dialogs. No app state lives here:
// callers pass data in and get user choices back.
import { hint, hintKeys, renderShortcutSheet } from './shortcuts.js';

const $ = (sel) => document.querySelector(sel);

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `img/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

export const prettyDate = (iso) =>
  new Date(`${iso}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// Close dialogs from their [data-close] buttons or by clicking the backdrop.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close('cancel');
    if (e.target.closest('[data-close]')) dialog.close('cancel');
  });
}

function choose(dialog) {
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
}

export const anyDialogOpen = () => !!document.querySelector('dialog[open]') || !$('#menu').hidden;

// ---------- Menu ----------

/**
 * @param {Array<'sep' | {id:string, icon:string, label:string|(() => string), shortcut?:string,
 *   action:() => void, danger?:boolean, hidden?:() => boolean, disabled?:() => boolean,
 *   pressed?:() => boolean, iconFor?:() => string}>} items
 */
export function createMenu(items) {
  const menu = $('#menu');
  const scrim = $('#menu-scrim');
  const btn = $('#menu-btn');
  const list = menu.querySelector('.menu-items');
  btn.title = 'Menu';

  function render() {
    const els = [];
    for (const item of items) {
      if (item === 'sep') {
        if (els.length && els.at(-1).tagName !== 'HR') els.push(document.createElement('hr'));
        continue;
      }
      if (item.hidden?.()) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `menu-item${item.danger ? ' danger' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.dataset.id = item.id;
      b.disabled = !!item.disabled?.();
      if (item.pressed) b.setAttribute('aria-pressed', String(item.pressed()));
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = typeof item.label === 'function' ? item.label() : item.label;
      const keys = document.createElement('span');
      keys.className = 'hint';
      if (item.shortcut) keys.append(...hintKeys(item.shortcut));
      b.append(icon(item.iconFor?.() ?? item.icon), label, keys);
      b.addEventListener('click', () => {
        close();
        item.action();
      });
      els.push(b);
    }
    if (els.at(-1)?.tagName === 'HR') els.pop();
    list.replaceChildren(...els);
  }

  function open() {
    render();
    menu.hidden = false;
    scrim.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    list.querySelector('.menu-item:not(:disabled)')?.focus();
  }

  function close({ restoreFocus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    scrim.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) btn.focus();
  }

  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  scrim.addEventListener('click', () => close());
  menu.querySelector('[data-action="close-menu"]').addEventListener('click', () => close({ restoreFocus: true }));
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close({ restoreFocus: true });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...list.querySelectorAll('.menu-item:not(:disabled)')];
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    }
  });

  return { open, close, get isOpen() { return !menu.hidden; } };
}

// ---------- Contents & search ----------

/**
 * @param {{ onQuery:(q:string)=>void, onPick:(index:number)=>void, onDelete:(index:number)=>void }} handlers
 */
export function createContents({ onQuery, onPick, onDelete }) {
  const dialog = $('#contents-dialog');
  const input = $('#search');
  const list = $('#contents-list');
  input.addEventListener('input', () => onQuery(input.value));

  function snippet(text, q) {
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) return '';
    const start = Math.max(0, at - 20);
    return (start ? '…' : '') + text.slice(start, at + q.length + 50).replace(/\n/g, ' ');
  }

  /** @param {object[]} pages  @param {string|null} currentId */
  function render(pages, currentId) {
    const q = input.value.trim().toLowerCase();
    const rows = [];
    pages.forEach((p, i) => {
      const all = p.lines.map((l) => l.text).join('\n');
      if (q && !all.toLowerCase().includes(q) && !p.date.includes(q)) return;
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `contents-row${p.id === currentId ? ' current' : ''}`;
      const date = Object.assign(document.createElement('span'), { className: 'c-date', textContent: prettyDate(p.date) });
      const first = p.lines.find((l) => l.text.trim())?.text ?? '';
      const text = Object.assign(document.createElement('span'), {
        className: 'c-text',
        textContent: (q && snippet(all, q)) || first || '(blank page)',
      });
      const dots = Object.assign(document.createElement('span'), { className: 'c-dots' });
      const num = Object.assign(document.createElement('span'), { className: 'c-num', textContent: i + 1 });
      row.append(date, text, dots, num);
      row.addEventListener('click', () => {
        dialog.close();
        onPick(i);
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.title = `Delete page ${i + 1}`;
      del.setAttribute('aria-label', `Delete page ${i + 1}`);
      del.append(icon('trash'));
      del.addEventListener('click', () => onDelete(i));
      li.append(row, del);
      rows.push(li);
    });
    if (!rows.length) {
      const li = Object.assign(document.createElement('li'), { className: 'contents-empty', textContent: q ? 'No pages match.' : 'No pages yet.' });
      rows.push(li);
    }
    list.replaceChildren(...rows);
  }

  return {
    render,
    get query() {
      return input.value.trim().toLowerCase();
    },
    get isOpen() {
      return dialog.open;
    },
    open(pages, currentId, { focusSearch = true } = {}) {
      render(pages, currentId);
      if (!dialog.open) dialog.showModal();
      if (focusSearch) {
        input.focus();
        input.select();
      }
    },
  };
}

// ---------- Dialogs ----------

/** Always-on confirmation before deleting a page. Resolves true to delete. */
export async function confirmDelete({ number, date, lines }) {
  const dialog = $('#delete-dialog');
  dialog.querySelector('#delete-title').textContent = `Delete page ${number}?`;
  dialog.querySelector('.confirm-date').textContent = prettyDate(date);
  const preview = lines.filter((l) => l.text.trim()).slice(0, 3);
  dialog.querySelector('.confirm-preview').textContent = preview
    .map((l) => (l.type === 'todo' ? `${l.done ? '☑' : '☐'} ${l.text}` : l.type === 'bullet' ? `• ${l.text}` : l.text))
    .join('\n');
  const result = choose(dialog);
  dialog.querySelector('button[value="cancel"]').focus();
  return (await result) === 'delete';
}

/** Edit the notebook's title and owner. Resolves to {title, owner} or null. */
export async function editDetails(meta) {
  const dialog = $('#details-dialog');
  const title = $('#details-title-input');
  const owner = $('#details-owner-input');
  title.value = meta.title;
  owner.value = meta.owner;
  const result = choose(dialog);
  title.focus();
  title.select();
  return (await result) === 'save' ? { title: title.value.trim() || 'Looseleaf', owner: owner.value.trim() } : null;
}

/** Ask merge vs replace for an import. Resolves 'merge' | 'replace' | ''. */
export function askImportMode(summary) {
  const dialog = $('#import-dialog');
  $('#import-summary').textContent = summary;
  return choose(dialog);
}

export function openShortcuts() {
  const dialog = $('#shortcuts-dialog');
  renderShortcutSheet($('#shortcuts-body'));
  if (!dialog.open) dialog.showModal();
}

export { hint };
