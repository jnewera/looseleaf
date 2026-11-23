// Runs before CSS paints: apply a saved light/dark override if there is one.
try {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
