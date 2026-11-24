// Export helpers: full JSON backup and a readable Markdown copy.

export function toJson(pages) {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), pages }, null, 2);
}

export function toMarkdown(pages) {
  const out = ['# Looseleaf', ''];
  pages.forEach((page, i) => {
    out.push(`## Page ${i + 1} · ${page.date}`, '');
    for (const line of page.lines) {
      if (line.type === 'todo') out.push(`- [${line.done ? 'x' : ' '}] ${line.text}`);
      else if (line.type === 'bullet') out.push(`- ${line.text}`);
      else out.push(line.text);
    }
    out.push('');
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
