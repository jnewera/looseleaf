// Single source of truth for keyboard shortcuts. The shortcuts sheet, menu hints
// and button tooltips are all generated from this table so they never drift apart.
//
// Each shortcut has one or more `combos`. A combo is a list of keys pressed
// together ("Ctrl"+"K"); with `typed: true` the keys are typed in sequence.

export const SHORTCUT_GROUPS = [
  {
    title: 'Writing',
    items: [
      { label: 'Checkbox', combos: [['[ ]', 'Space']], typed: true },
      { label: 'Checked checkbox', combos: [['[x]', 'Space']], typed: true },
      { label: 'Bullet', combos: [['-', 'Space'], ['*', 'Space']], typed: true },
      { id: 'toggle-todo', label: 'Check / uncheck line', combos: [['Ctrl', 'Enter']] },
      { label: 'End a list (on an empty item)', combos: [['Enter']] },
      { label: 'Remove bullet or checkbox', combos: [['Backspace']], note: 'at line start' },
      { id: 'undo', label: 'Undo / redo', combos: [['Ctrl', 'Z'], ['Ctrl', 'Y']] },
    ],
  },
  {
    title: 'Pages',
    items: [
      { id: 'next', label: 'Next page', combos: [['PageDown'], ['Alt', '→']] },
      { id: 'prev', label: 'Previous page', combos: [['PageUp'], ['Alt', '←']] },
      { id: 'new-page', label: 'New page', combos: [['Ctrl', 'Shift', 'N']] },
      { label: 'Open the notebook', combos: [['Enter']], note: 'on the cover' },
    ],
  },
  {
    title: 'Notebook',
    items: [
      { id: 'contents', label: 'Contents & search', combos: [['Ctrl', 'K'], ['Ctrl', 'F']] },
      { id: 'dictation', label: 'Dictation on / off', combos: [['Ctrl', 'Shift', 'D']] },
      { id: 'shortcuts', label: 'Keyboard shortcuts', combos: [['Ctrl', '/'], ['?']] },
      { label: 'Close menu or dialog, stop dictation', combos: [['Esc']] },
    ],
  },
];

const byId = new Map(SHORTCUT_GROUPS.flatMap((g) => g.items).filter((i) => i.id).map((i) => [i.id, i]));

/** Primary combo for an action as plain text, e.g. "Ctrl+Shift+D" (for tooltips). */
export function hint(id) {
  const item = byId.get(id);
  return item ? item.combos[0].join(item.typed ? ' ' : '+') : '';
}

/** Primary combo for an action as <kbd> elements (for menu items). */
export function hintKeys(id) {
  const item = byId.get(id);
  return item ? item.combos[0].map(kbd) : [];
}

function kbd(key) {
  const el = document.createElement('kbd');
  el.textContent = key;
  return el;
}

/** Build the contents of the keyboard-shortcuts sheet. */
export function renderShortcutSheet(container) {
  container.replaceChildren(
    ...SHORTCUT_GROUPS.map((group) => {
      const section = document.createElement('section');
      const h = document.createElement('h3');
      h.textContent = group.title;
      const dl = document.createElement('dl');
      for (const item of group.items) {
        const row = document.createElement('div');
        row.className = 'row';
        const dt = document.createElement('dt');
        dt.textContent = item.label;
        const dd = document.createElement('dd');
        item.combos.forEach((combo, i) => {
          if (i) dd.append(' or ');
          const group = document.createElement('span');
          group.className = 'combo';
          combo.forEach((key, k) => {
            if (k) group.append(item.typed ? ' ' : '+');
            group.append(kbd(key));
          });
          dd.append(group);
        });
        if (item.note) dd.append(` (${item.note})`);
        row.append(dt, dd);
        dl.append(row);
      }
      section.append(h, dl);
      return section;
    }),
  );
}
