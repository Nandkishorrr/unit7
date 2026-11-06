// the same reading of a .env file as parseDotenv in src/tools/env.ts, for a file pasted into a page
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[n]!);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if (q === '"' || q === "'" || q === '`') {
      let body = v.slice(1);
      while (!new RegExp(`(^|[^\\\\])${q}\\s*(#.*)?$`).test(body) && n + 1 < lines.length) body += '\n' + lines[++n];
      body = body.replace(new RegExp(`${q}\\s*(#.*)?$`), '');
      v = q === '"' ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"') : body;
    } else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]!] = v;
  }
  return out;
}
