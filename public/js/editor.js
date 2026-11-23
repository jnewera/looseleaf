// PageEditor: a contenteditable notebook page made of line blocks.
// Each block is <div class="ln" data-type="text|bullet|todo" data-done="true|false">.
// The DOM is kept flat (plain text inside each block) so it maps 1:1 to the data model.

const SHORTCUT = /^(\[[  ]?\]|\[[xX]\]|[-*])[  ]/;
const HISTORY_LIMIT = 200;

/** Parse one Markdown-ish line ("- [x] milk", "- eggs", "[] call") into a line object. */
export function parseLine(raw) {
  const todo = raw.match(/^\s*(?:[-*]\s+)?\[([ xX]?)\]\s?(.*)$/);
  if (todo) return { type: 'todo', text: todo[2], done: todo[1].toLowerCase() === 'x' };
  const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
  if (bullet) return { type: 'bullet', text: bullet[1] };
  return { type: 'text', text: raw };
}

function makeBlock({ type = 'text', text = '', done = false } = {}) {
  const b = document.createElement('div');
  b.className = 'ln';
  setType(b, type, done);
  setText(b, text);
  return b;
}

function setType(b, type, done = false) {
  b.dataset.type = type;
  if (type === 'todo') b.dataset.done = String(done);
  else delete b.dataset.done;
}

function setText(b, text) {
  b.textContent = text;
  if (!text) b.append(document.createElement('br')); // keeps empty rows editable
}

const textOf = (b) => b.textContent.replace(/​/g, '');

function toLine(b) {
  const type = b.dataset.type ?? 'text';
  const line = { type, text: textOf(b) };
  if (type === 'todo') line.done = b.dataset.done === 'true';
  return line;
}

export class PageEditor {
  /**
   * @param {HTMLElement} el the .editor element
   * @param {{ onChange: () => void, onOverflow: (lines: object[], caret: {i:number,o:number}|null) => void }} hooks
   */
  constructor(el, { onChange, onOverflow }) {
    this.el = el;
    this.onChange = onChange;
    this.onOverflow = onOverflow;
    this.history = [];
    this.hIndex = -1;
    this.hTimer = null;

    el.addEventListener('keydown', (e) => this.#onKeyDown(e));
    el.addEventListener('beforeinput', (e) => this.#onBeforeInput(e));
    el.addEventListener('input', () => this.#onInput());
    el.addEventListener('paste', (e) => this.#onPaste(e));
    el.addEventListener('mousedown', (e) => this.#onMouseDown(e));
    el.addEventListener('dragstart', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => e.preventDefault());
  }

  // ---------- Public API ----------

  setLines(lines) {
    this.el.replaceChildren(...(lines.length ? lines : [{}]).map(makeBlock));
    this.resetHistory();
  }

  getLines() {
    return [...this.el.children].map(toLine);
  }

  /** Insert lines at the top of the page (used when the previous page overflows). */
  prependLines(lines) {
    // A lone empty line on a fresh page is just a placeholder; replace it.
    const only = this.el.children.length === 1 && this.el.firstElementChild;
    if (only && !textOf(only) && only.dataset.type === 'text') only.remove();
    this.el.prepend(...lines.map(makeBlock));
  }

  /** Call after prependLines: re-check overflow, notify, and reset undo. */
  commitExternalChange() {
    this.#checkOverflow();
    this.onChange();
    this.resetHistory();
  }

  resetHistory() {
    clearTimeout(this.hTimer);
    this.history = [this.#snapshot()];
    this.hIndex = 0;
  }

  focusAt(i = 0, o = 0) {
    const b = this.el.children[Math.min(i, this.el.children.length - 1)];
    if (b) this.#setCaret(b, o);
  }

  // ---------- Caret helpers ----------

  #currentBlock() {
    const sel = getSelection();
    if (!sel.rangeCount || !this.el.contains(sel.anchorNode)) return null;
    let n = sel.anchorNode;
    while (n && n.parentNode !== this.el) n = n.parentNode;
    return n?.nodeType === 1 ? n : null;
  }

  #caretOffset(b) {
    const r = getSelection().getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(b);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().replace(/​/g, '').length;
  }

  /** Caret as {i: block index, o: char offset}, or null if it's not in this page. */
  getCaret() {
    const b = this.#currentBlock();
    if (!b) return null;
    return { i: [...this.el.children].indexOf(b), o: this.#caretOffset(b) };
  }

  #setCaret(b, offset) {
    this.el.focus({ preventScroll: true });
    const range = document.createRange();
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let left = offset;
    let node;
    let placed = false;
    while ((node = walker.nextNode())) {
      if (left <= node.length) {
        range.setStart(node, left);
        placed = true;
        break;
      }
      left -= node.length;
    }
    if (!placed) {
      const last = [...b.childNodes].filter((n) => n.nodeType === 3).pop();
      if (last) range.setStart(last, last.length);
      else range.setStart(b, 0);
    }
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    b.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Events ----------

  #onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && !e.shiftKey && key === 'z') return this.#prevent(e, () => this.undo());
    if (mod && (key === 'y' || (e.shiftKey && key === 'z'))) return this.#prevent(e, () => this.redo());
    if (mod && ['b', 'i', 'u'].includes(key)) return e.preventDefault(); // no rich text

    if (mod && e.key === 'Enter') {
      return this.#prevent(e, () => {
        const b = this.#currentBlock();
        if (!b) return;
        if (b.dataset.type === 'todo') this.#toggle(b);
        else {
          setType(b, 'todo');
          this.#changed(true);
        }
      });
    }

    if (e.key === 'Enter') return this.#prevent(e, () => this.#splitBlock());

    const sel = getSelection();
    if (!sel.isCollapsed) return; // let the browser delete selections, then normalize
    const b = this.#currentBlock();
    if (!b) return;

    if (e.key === 'Backspace' && this.#caretOffset(b) === 0) {
      return this.#prevent(e, () => {
        if (b.dataset.type !== 'text') {
          setType(b, 'text'); // first backspace removes the bullet/checkbox
        } else if (b.previousElementSibling) {
          const prev = b.previousElementSibling;
          const at = textOf(prev).length;
          setText(prev, textOf(prev) + textOf(b));
          b.remove();
          this.#setCaret(prev, at);
        } else return;
        this.#changed(true);
      });
    }

    if (e.key === 'Delete' && this.#caretOffset(b) === textOf(b).length && b.nextElementSibling) {
      return this.#prevent(e, () => {
        const at = textOf(b).length;
        setText(b, textOf(b) + textOf(b.nextElementSibling));
        b.nextElementSibling.remove();
        this.#setCaret(b, at);
        this.#changed(true);
      });
    }
  }

  #onBeforeInput(e) {
    // Route Edit-menu undo/redo through our own history.
    if (e.inputType === 'historyUndo') this.#prevent(e, () => this.undo());
    else if (e.inputType === 'historyRedo') this.#prevent(e, () => this.redo());
    else if (e.inputType.startsWith('format')) e.preventDefault();
  }

  #onInput() {
    this.#normalize();
    const b = this.#currentBlock();
    if (b && b.dataset.type === 'text') {
      const m = textOf(b).match(SHORTCUT);
      if (m) {
        const off = this.#caretOffset(b);
        const marker = m[1];
        if (marker === '-' || marker === '*') setType(b, 'bullet');
        else setType(b, 'todo', /x/i.test(marker));
        setText(b, textOf(b).slice(m[0].length));
        this.#setCaret(b, Math.max(0, off - m[0].length));
        return this.#changed(true);
      }
    }
    this.#changed(false);
  }

  #onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    if (!text) return;
    const lines = text.split('\n');
    if (lines.length === 1) {
      document.execCommand('insertText', false, text); // keeps it simple and plain
      return;
    }
    if (!getSelection().isCollapsed) document.execCommand('delete');
    this.#normalize();
    const b = this.#currentBlock() ?? this.el.lastElementChild;
    const off = this.#currentBlock() ? this.#caretOffset(b) : textOf(b).length;
    const before = textOf(b).slice(0, off);
    const after = textOf(b).slice(off);
    setText(b, before + lines[0]);
    let anchor = b;
    let caretLen = 0;
    lines.slice(1).forEach((raw, idx, arr) => {
      const line = parseLine(raw);
      caretLen = line.text.length;
      if (idx === arr.length - 1) line.text += after;
      const nb = makeBlock(line);
      anchor.after(nb);
      anchor = nb;
    });
    this.#setCaret(anchor, caretLen);
    this.#changed(true);
  }

  #onMouseDown(e) {
    const b = e.target.closest?.('.ln');
    if (!b || b.parentNode !== this.el || b.dataset.type !== 'todo') return;
    const r = b.getBoundingClientRect();
    const rule = parseFloat(getComputedStyle(this.el).lineHeight);
    // The checkbox is drawn in the block's left padding on its first row.
    if (e.clientX - r.left < 24 && e.clientY - r.top < rule) {
      e.preventDefault(); // don't move the caret
      this.#toggle(b);
    }
  }

  #prevent(e, fn) {
    e.preventDefault();
    fn();
  }

  // ---------- Edits ----------

  #toggle(b) {
    b.dataset.done = String(b.dataset.done !== 'true');
    this.#changed(true);
  }

  #splitBlock() {
    if (!getSelection().isCollapsed) document.execCommand('delete');
    this.#normalize();
    const b = this.#currentBlock();
    if (!b) return;
    const text = textOf(b);
    if (b.dataset.type !== 'text' && text === '') {
      setType(b, 'text'); // Enter on an empty bullet/checkbox ends the list
      return this.#changed(true);
    }
    const off = this.#caretOffset(b);
    setText(b, text.slice(0, off));
    const nb = makeBlock({ type: b.dataset.type, text: text.slice(off) });
    b.after(nb);
    this.#setCaret(nb, 0);
    this.#changed(true);
  }

  /** Keep the DOM flat: every child is a .ln block holding only text (and maybe a <br>). */
  #normalize() {
    const caret = this.getCaret();
    let dirty = false;
    for (const node of [...this.el.childNodes]) {
      const isBlock = node.nodeType === 1 && node.classList.contains('ln');
      if (!isBlock) {
        if (node.nodeType === 3 && !node.textContent) {
          node.remove();
          continue;
        }
        // Stray text or browser-inserted elements: wrap as a plain line.
        node.replaceWith(makeBlock({ type: node.dataset?.type ?? 'text', text: node.textContent }));
        dirty = true;
      } else if ([...node.childNodes].some((c) => c.nodeType === 1 && c.nodeName !== 'BR')) {
        setText(node, textOf(node)); // flatten spans/fonts the browser may inject
        node.removeAttribute('style');
        dirty = true;
      } else if (!node.textContent && !node.querySelector('br')) {
        node.append(document.createElement('br'));
      }
    }
    if (!this.el.children.length) {
      this.el.append(makeBlock());
      dirty = true;
    }
    if (dirty && caret) this.focusAt(caret.i, caret.o);
  }

  /** After any edit: move overflow to the next page, notify, and record undo. */
  #changed(structural) {
    const overflowed = this.#checkOverflow();
    this.onChange();
    clearTimeout(this.hTimer);
    if (overflowed) this.resetHistory(); // undo across pages would duplicate text
    else if (structural) this.#record();
    else this.hTimer = setTimeout(() => this.#record(), 500);
  }

  /**
   * If content is taller than the page, move trailing blocks (splitting a long
   * paragraph at a word boundary if needed) to the next page. Returns true if moved.
   */
  #checkOverflow() {
    const el = this.el;
    if (el.scrollHeight <= el.clientHeight) return false;
    const caret = this.getCaret();
    const caretBlock = caret ? el.children[caret.i] : null;
    const moved = [];
    let caretTarget = null;

    const row = parseFloat(getComputedStyle(el).lineHeight);

    while (el.scrollHeight > el.clientHeight) {
      const last = el.lastElementChild;
      const text = textOf(last);
      const firstRowFits = last.offsetTop + row <= el.clientHeight;
      const splitAt = firstRowFits && text ? this.#fitLength(last, text) : 0;

      if (splitAt > 0 && splitAt < text.length) {
        // Split: the head stays here, the rest continues as plain text on the next page.
        const restRaw = text.slice(splitAt);
        const rest = restRaw.replace(/^[  ]+/, '');
        setText(last, text.slice(0, splitAt));
        const line = { type: 'text', text: rest };
        if (last === caretBlock && caret.o > splitAt) {
          caretTarget = { line, o: Math.max(0, caret.o - splitAt - (restRaw.length - rest.length)) };
        }
        moved.unshift(line);
      } else {
        if (el.children.length === 1) break; // nothing sensible left to move
        const line = toLine(last);
        if (last === caretBlock) caretTarget = { line, o: caret.o };
        moved.unshift(line);
        last.remove();
      }
    }
    if (!moved.length) return false;
    const c = caretTarget ? { i: moved.indexOf(caretTarget.line), o: caretTarget.o } : null;
    this.onOverflow(moved, c);
    return true;
  }

  /** Longest prefix (ending at a word boundary when possible) of `text` that fits on the page. */
  #fitLength(block, text) {
    const el = this.el;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      setText(block, text.slice(0, mid));
      if (el.scrollHeight <= el.clientHeight) lo = mid;
      else hi = mid - 1;
    }
    setText(block, text);
    if (lo >= text.length) return text.length;
    const space = text.lastIndexOf(' ', lo);
    return space > 0 ? space : lo;
  }

  // ---------- Undo / redo (snapshot based) ----------

  #snapshot() {
    return { lines: this.getLines(), caret: this.getCaret() };
  }

  #record() {
    clearTimeout(this.hTimer);
    const snap = this.#snapshot();
    const cur = this.history[this.hIndex];
    if (cur && JSON.stringify(cur.lines) === JSON.stringify(snap.lines)) {
      cur.caret = snap.caret;
      return;
    }
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(snap);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.hIndex = this.history.length - 1;
  }

  undo() {
    this.#record(); // commit any pending typing first
    if (this.hIndex <= 0) return;
    // Put the caret where the undone edit happened.
    const undoneCaret = this.history[this.hIndex].caret;
    this.#restore(this.history[--this.hIndex], undoneCaret);
  }

  redo() {
    if (this.hIndex >= this.history.length - 1) return;
    const snap = this.history[++this.hIndex];
    this.#restore(snap, snap.caret);
  }

  #restore(snap, caret) {
    this.el.replaceChildren(...(snap.lines.length ? snap.lines : [{}]).map(makeBlock));
    if (caret) this.focusAt(caret.i, caret.o);
    this.onChange();
  }
}
