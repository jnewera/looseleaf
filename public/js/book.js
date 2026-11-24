// Book: which pages are showing (a "view"), page-turn and cover animations,
// and scaling the book to fit the window.
//
// Double mode (wide windows): view 0 = [inside cover, page 1], view v = [page 2v, page 2v+1]
// (1-based). Single mode (narrow windows): view v = page v+1. The view after the last page
// shows a blank sheet you can click to start a new page.

const TURN_MS = 600;
const COVER_MS = 850;
const MAX_SCALE = 1.15;
const MIN_DOUBLE_SCALE = 0.72;

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion() ? 0 : ms));

export class Book {
  /**
   * @param {HTMLElement} root  the .book element
   * @param {{
   *   pageCount: () => number,
   *   pageIdAt: (index: number) => string,
   *   renderSlot: (slot: {kind: string, index?: number}, opts: {live: boolean, side: string}) => HTMLElement|null,
   *   onChange: () => void,
   * }} deps
   */
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;
    this.wrap = root.parentElement;
    this.stage = this.wrap.parentElement;
    this.slotEls = [...root.querySelectorAll('.slot')];
    this.leaf = root.querySelector('.leaf');
    this.leafFront = root.querySelector('.leaf-front');
    this.leafBack = root.querySelector('.leaf-back');
    this.mode = 'double';
    this.view = 0;
    this.turning = null;
    this.rendered = [null, null];
    root.style.setProperty('--turn-ms', `${TURN_MS}ms`);
    new ResizeObserver(() => this.fit()).observe(this.stage);
  }

  get state() {
    return this.root.dataset.state;
  }
  get isOpen() {
    return this.state === 'open';
  }

  // ---------- Views ----------

  viewCount() {
    const n = this.deps.pageCount();
    return this.mode === 'single' ? n + 1 : Math.floor(n / 2) + 1;
  }
  get lastView() {
    return this.viewCount() - 1;
  }

  viewOfPage(index) {
    return this.mode === 'single' ? index : Math.floor((index + 1) / 2);
  }

  /** Slots for a view, left to right. */
  slotsFor(view) {
    const n = this.deps.pageCount();
    const at = (i) => (i < n ? { kind: 'page', index: i } : { kind: 'blank', index: n });
    if (this.mode === 'single') return [at(view)];
    return [view === 0 ? { kind: 'inside' } : at(2 * view - 1), at(2 * view)];
  }

  sideOf(pos) {
    return this.mode === 'single' ? 'single' : pos === 0 ? 'left' : 'right';
  }

  #key(slot) {
    return slot.kind === 'page' ? `p:${this.deps.pageIdAt(slot.index)}` : slot.kind;
  }

  /** Re-render slots whose content changed (or all of them with force). */
  render(force = false) {
    this.view = Math.max(0, Math.min(this.view, this.lastView));
    const slots = this.slotsFor(this.view);
    this.slotEls.forEach((el, pos) => {
      const slot = slots[pos];
      if (!slot) {
        el.replaceChildren();
        this.rendered[pos] = null;
        return;
      }
      const key = `${this.mode}:${this.#key(slot)}`;
      if (!force && this.rendered[pos] === key) return;
      const content = this.deps.renderSlot(slot, { live: true, side: this.sideOf(pos) });
      el.replaceChildren(...(content ? [content] : []));
      this.rendered[pos] = key;
    });
    this.deps.onChange();
  }

  // ---------- Turning ----------

  next() {
    return this.turnTo(this.view + 1);
  }
  prev() {
    return this.turnTo(this.view - 1);
  }

  /** Turn to a view. Requests made mid-turn wait for the current turn to land. */
  async turnTo(target, opts = {}) {
    while (this.turning) await this.turning;
    this.turning = this.#turn(target, opts);
    try {
      await this.turning;
    } finally {
      this.turning = null;
    }
  }

  async #turn(target, { animate = true } = {}) {
    target = Math.max(0, Math.min(target, this.lastView));
    if (target === this.view) return;
    if (!animate || reducedMotion() || !this.isOpen) {
      this.view = target;
      this.render();
      return;
    }
    const forward = target > this.view;
    const from = this.slotsFor(this.view);
    const to = this.slotsFor(target);
    const staticSlot = (slot, side) => this.deps.renderSlot(slot, { live: false, side }) ?? '';
    let keyframes;

    if (this.mode === 'double') {
      // The turning leaf is the right page going forward, the left page going back.
      this.leafFront.replaceChildren(staticSlot(forward ? from[1] : from[0], forward ? 'right' : 'left'));
      this.leafBack.replaceChildren(staticSlot(forward ? to[0] : to[1], forward ? 'left' : 'right'));
      Object.assign(this.leaf.style, {
        left: forward ? 'var(--page-w)' : '0px',
        transformOrigin: forward ? 'left center' : 'right center',
      });
      keyframes = forward
        ? [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-180deg)' }]
        : [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }];
      // Reveal what's under the leaf right away; the other side updates when it lands.
      this.view = target;
      this.#renderPos(forward ? 1 : 0);
    } else {
      const blankBack = document.createElement('section');
      blankBack.className = 'page single static';
      Object.assign(this.leaf.style, { left: '0px', transformOrigin: 'left center' });
      if (forward) {
        this.leafFront.replaceChildren(staticSlot(from[0], 'single'));
        this.leafBack.replaceChildren(blankBack);
        keyframes = [{ transform: 'rotateY(0deg)', opacity: 1 }, { transform: 'rotateY(-180deg)', opacity: 0 }];
        this.view = target;
        this.#renderPos(0);
      } else {
        this.leafFront.replaceChildren(staticSlot(to[0], 'single'));
        this.leafBack.replaceChildren(blankBack);
        keyframes = [{ transform: 'rotateY(-180deg)', opacity: 0 }, { transform: 'rotateY(0deg)', opacity: 1 }];
        this.view = target;
      }
    }

    this.leaf.classList.add('turning');
    this.deps.onChange(); // update the page label as the turn starts
    try {
      const anim = this.leaf.animate(keyframes, { duration: TURN_MS, easing: 'cubic-bezier(.45,.05,.3,1)' });
      // Never let a stalled animation (hidden window, no frames) block the next turn.
      await Promise.race([anim.finished.catch(() => {}), new Promise((r) => setTimeout(r, TURN_MS + 400))]);
      anim.cancel();
    } finally {
      this.render();
      this.leaf.classList.remove('turning');
      this.leafFront.replaceChildren();
      this.leafBack.replaceChildren();
    }
  }

  #renderPos(pos) {
    const slot = this.slotsFor(this.view)[pos];
    if (!slot) return;
    const content = this.deps.renderSlot(slot, { live: true, side: this.sideOf(pos) });
    this.slotEls[pos].replaceChildren(...(content ? [content] : []));
    this.rendered[pos] = `${this.mode}:${this.#key(slot)}`;
  }

  // ---------- Cover ----------

  async open() {
    if (this.state !== 'closed') return;
    this.render(true);
    this.root.dataset.state = 'opening';
    this.deps.onChange();
    await wait(COVER_MS);
    this.root.dataset.state = 'open';
    this.deps.onChange();
  }

  async close() {
    if (this.state !== 'open') return;
    this.root.dataset.state = 'closing';
    this.deps.onChange();
    await wait(COVER_MS);
    this.root.dataset.state = 'closed';
    this.deps.onChange();
  }

  // ---------- Fit to window ----------

  fit() {
    const availW = this.stage.clientWidth - 48;
    const availH = this.stage.clientHeight - 60 - 32; // minus the bar under the book
    if (availW <= 0 || availH <= 0) return;

    const prevMode = this.mode;
    const firstPage = this.#firstPageIndex();
    this.root.dataset.mode = 'double';
    const doubleScale = Math.min(availW / this.root.offsetWidth, availH / this.root.offsetHeight);
    const portrait = availH > availW * 1.1;
    this.mode = doubleScale < MIN_DOUBLE_SCALE || portrait ? 'single' : 'double';
    this.root.dataset.mode = this.mode;

    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    // Snap so each 27px rule lands on whole device pixels (crisp lines at any size).
    const rule = parseFloat(getComputedStyle(this.root).getPropertyValue('--rule')) || 27;
    const scale = Math.floor(Math.min(availW / w, availH / h, MAX_SCALE) * rule) / rule;
    this.root.style.transform = `scale(${scale})`;
    Object.assign(this.wrap.style, { width: `${w * scale}px`, height: `${h * scale}px` });
    const bar = this.stage.querySelector('.book-bar');
    if (bar) bar.style.width = `${w * scale}px`;

    if (this.mode !== prevMode) {
      this.view = this.viewOfPage(firstPage);
      this.render(true);
    }
  }

  #firstPageIndex() {
    if (this.mode === 'single') return this.view;
    return this.view === 0 ? 0 : 2 * this.view - 1;
  }
}
