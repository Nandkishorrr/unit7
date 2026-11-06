// Just enough YAML for unit7.yaml: maps, lists, strings, numbers and booleans, indented with two spaces. No new dependency for a file
// Unit7 writes itself. Comments are allowed. Anything fancier is refused rather than guessed at.
const plain = (s: string) => /^[A-Za-z0-9_./@:+-][A-Za-z0-9_./@:+ -]*$/.test(s) && !/^(true|false|null|~|\d+(\.\d+)?)$/i.test(s) && !/[ :]$/.test(s) && !s.includes(': ');
const scalar = (v: unknown) => (typeof v === 'string' ? (plain(v) ? v : JSON.stringify(v)) : v === null || v === undefined ? 'null' : String(v));
export function toYaml(v: unknown, pad = ''): string {
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[]\n`;
    return v.map((x) => {
      if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length) { const [first, ...rest] = toYaml(x, `${pad}  `).split('\n'); return `${pad}- ${first!.trimStart()}\n${rest.join('\n')}`; }
      return `${pad}- ${scalar(x)}\n`;
    }).join('');
  }
  if (v && typeof v === 'object') {
    return Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => {
      if (Array.isArray(x) && !x.length) return `${pad}${k}: []\n`;
      if (x && typeof x === 'object' && !Object.keys(x).length) return `${pad}${k}: {}\n`;
      return x && typeof x === 'object' ? `${pad}${k}:\n${toYaml(x, `${pad}  `)}` : `${pad}${k}: ${scalar(x)}\n`;
    }).join('');
  }
  return `${pad}${scalar(v)}\n`;
}
const value = (t: string): unknown => {
  const s = t.trim();
  if (s === '[]') return []; if (s === '{}') return {}; if (s === 'null' || s === '~' || s === '') return null; if (s === 'true') return true; if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) return JSON.parse(s) as string;
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') || s.startsWith('{') || /^[|>]/.test(s)) throw new Error(`unit7.yaml keeps to plain lists and maps: ${s.slice(0, 40)}`);
  return s;
};
const stripComment = (l: string) => { let q = ''; for (let i = 0; i < l.length; i++) { const c = l[i]!; if (q) { if (c === q && l[i - 1] !== '\\') q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '#' && (i === 0 || l[i - 1] === ' ')) return l.slice(0, i); } return l; };
export function fromYaml(text: string): unknown {
  const lines = text.split('\n').map((l) => stripComment(l).replace(/\s+$/, '')).filter((l) => l.trim()).map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  const key = /^("(?:[^"\\]|\\.)*"|[^\s:][^:]*?):(?:\s+(.*))?$/;
  const block = (indent: number): unknown => {
    if (lines[i]?.text.startsWith('- ') || lines[i]?.text === '-') {
      const out: unknown[] = [];
      while (i < lines.length && lines[i]!.indent === indent && /^-( |$)/.test(lines[i]!.text)) {
        const rest = lines[i]!.text.slice(1).trimStart();
        if (key.test(rest) && !rest.startsWith('"')) { lines[i] = { indent: indent + 2, text: rest }; out.push(block(indent + 2)); } else { out.push(value(rest)); i++; }
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    while (i < lines.length && lines[i]!.indent === indent) {
      const m = key.exec(lines[i]!.text);
      if (!m) throw new Error(`I can’t read this line of unit7.yaml: ${lines[i]!.text.slice(0, 60)}`);
      const k = m[1]!.startsWith('"') ? JSON.parse(m[1]!) as string : m[1]!; i++;
      if (m[2] !== undefined) out[k] = value(m[2]);
      else if (i < lines.length && lines[i]!.indent > indent) out[k] = block(lines[i]!.indent);
      else if (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')) out[k] = block(indent);
      else out[k] = null;
    }
    return out;
  };
  return lines.length ? block(lines[0]!.indent) : {};
}
