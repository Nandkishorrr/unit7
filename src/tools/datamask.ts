// Reading a query before it runs, and what an AI may see of what comes back. Pure code, no I/O.
//
// A list of dangerous words can always be dodged, so nothing here is what keeps a read read-only: an AI's read runs as a login
// that can't write, in a throwaway container, and the database refuses the rest. This only answers "is it one statement", and
// "which columns of this result look personal". For Postgres that second answer comes from the database's own plan, where
// aliases, views and subqueries are already resolved: `SELECT email AS x`, `lower(email)` and a view renaming it all print
// as email. MySQL's plan doesn't list outputs, so there a personal word in the statement leaves only numbers. Either way a
// value shaped like an email or a phone number is hidden wherever it shows up.
import { Unit7Error } from '../errors.ts';

export type Dialect = 'pg' | 'my';
export interface Tok { k: 'word' | 'name' | 'str' | 'op'; v: string; at: number }
const refuse = (why: string) => new Unit7Error('bad_statement', why, 400);

// Strings, comments and dollar quotes the way the database reads them, so a ; or a backslash inside one isn't mistaken for
// anything. A backslash outside one is a client command (psql's \!, mysql's \!), never SQL, and nothing else starts it.
export function tokenize(sql: string, d: Dialect): Tok[] {
  const out: Tok[] = [];
  const quoted = (from: number, q: string, escapes: boolean) => {
    for (let j = from + 1; j < sql.length; j++) {
      if (escapes && sql[j] === '\\') { j++; continue; }
      if (sql[j] === q) { if (sql[j + 1] === q) { j++; continue; } return j + 1; }
    }
    throw refuse('A quote isn’t closed.');
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if ((sql.startsWith('--', i) && (d === 'pg' || /[\s]/.test(sql[i + 2] ?? ' '))) || (d === 'my' && c === '#')) { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e + 1; continue; }
    if (sql.startsWith('/*', i)) {
      // MySQL runs what's in these, so they're code, not comments
      if (d === 'my' && /^\/\*M?!/.test(sql.slice(i, i + 4))) throw refuse('Comments that run code aren’t allowed here.');
      let depth = 1, j = i + 2;
      while (j < sql.length && depth) { if (sql.startsWith('*/', j)) { depth--; j += 2; } else if (d === 'pg' && sql.startsWith('/*', j)) { depth++; j += 2; } else j++; }
      if (depth) throw refuse('A comment isn’t closed.');
      i = j; continue;
    }
    if (c === "'" || (d === 'my' && c === '"')) {
      const last = out.at(-1), e = d === 'pg' && last?.k === 'word' && /^e$/i.test(last.v) && last.at + 1 === i;
      const j = quoted(i, c, d === 'my' || !!e);
      out.push({ k: 'str', v: sql.slice(i + 1, j - 1), at: i }); i = j; continue;
    }
    if (c === '"' || (d === 'my' && c === '`')) { const j = quoted(i, c, false); out.push({ k: 'name', v: sql.slice(i + 1, j - 1).split(c + c).join(c), at: i }); i = j; continue; }
    if (d === 'pg' && c === '$') {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80))?.[0];
      if (tag) { const e = sql.indexOf(tag, i + tag.length); if (e < 0) throw refuse('A quote isn’t closed.'); out.push({ k: 'str', v: sql.slice(i + tag.length, e), at: i }); i = e + tag.length; continue; }
    }
    if (c === '\\') throw refuse('Client commands (a backslash) aren’t allowed in a query.');
    const w = /^[A-Za-z_\u0080-￿][\w$\u0080-￿]*/.exec(sql.slice(i, i + 200))?.[0];
    if (w) { out.push({ k: 'word', v: w, at: i }); i += w.length; continue; }
    out.push({ k: 'op', v: c, at: i }); i++;
  }
  return out;
}

// One statement, or a refusal. text is what the database gets: no trailing ; and nothing after it.
export function statement(sql: string, d: Dialect) {
  const toks = tokenize(sql, d), semi = toks.findIndex((t) => t.k === 'op' && t.v === ';');
  if (semi >= 0 && semi < toks.length - 1) throw refuse('Only one statement at a time. Run them one by one.');
  const body = semi >= 0 ? toks.slice(0, semi) : toks;
  if (body[0]?.k !== 'word') throw refuse('That doesn’t look like a statement.');
  let depth = 0;
  for (const t of body) if (t.k === 'op') { if (t.v === '(') depth++; if (t.v === ')' && --depth < 0) break; }
  if (depth !== 0) throw refuse('The brackets don’t match.');
  return { first: body[0].v.toLowerCase(), text: sql.slice(0, semi >= 0 ? toks[semi]!.at : sql.length).trim(), toks: body };
}
const has = (toks: Tok[], ...words: string[]) => toks.some((t) => t.k === 'word' && words.includes(t.v.toLowerCase()));
const READS: Record<Dialect, string[]> = { pg: ['select', 'with', 'values', 'table', 'show', 'explain'], my: ['select', 'with', 'values', 'table', 'show', 'explain', 'desc', 'describe'] };
export const isRead = (first: string, d: Dialect) => READS[d].includes(first);
// a cursor (or LIMIT) can hold these; SHOW and EXPLAIN return what they return
export const isRows = (first: string) => ['select', 'with', 'values', 'table'].includes(first);
export function readStatement(sql: string, d: Dialect) {
  const st = statement(sql, d);
  if (!isRead(st.first, d)) throw new Unit7Error('needs_write', 'That changes data. To run it, say write: true: it then waits for approval and takes a fresh copy first.', 400);
  if (d === 'my' && has(st.toks, 'outfile', 'dumpfile')) throw refuse('A read can’t write a file on the server.');
  return st;
}
export function writeStatement(sql: string, d: Dialect) {
  const st = statement(sql, d);
  if (d === 'my' && ['system', 'source', 'delimiter'].includes(st.first)) throw refuse('Client commands aren’t allowed in a query.');
  // a command on the server, whatever else the statement does
  if (st.first === 'copy' && has(st.toks, 'program')) throw refuse('COPY … PROGRAM runs a command on the server, so it isn’t allowed here.');
  return st;
}
// what can't be undone from a copy of one database, for the gate: never a plain data change
export function dropsDatabase(sql: string, d: Dialect) {
  try { const { first, toks } = statement(sql, d); return first === 'drop' && has(toks.slice(1, 2), 'database', 'schema'); } catch { return false; }
}

// --- what looks personal ---------------------------------------------------------------------------------------------------
const PERSONAL = /(^|_)(e?mails?|phones?|mobile|telephone|tel|fax|passwords?|passwd|pwd|pass|tokens?|secrets?|api_?keys?|private_?keys?|credentials?|otp|jwt|cookies?|salt|ssn|passport|tax_?id|national_?id|iban|cvv|card(_?number)?|birth(_?(day|date))?|dob|first_?names?|last_?names?|full_?names?|sur_?names?|given_?names?|family_?names?|middle_?names?|maiden_?name|display_?names?|nick_?names?|nicename|user_?names?|login|addr|address|address_?\d|street|post_?codes?|zip(_?codes?)?|ip|ip_?addr(ess)?|lat(itude)?|lng|longitude)($|_)/;
const WHO = 'users?|customers?|clients?|profiles?|people|persons?|members?|contacts?|employees?|staff|authors?|patients?|students?|subscribers?|leads?|guests?|owners?|admins?|buyers?|sellers?|billing|shipping|recipients?|senders?';
const PEOPLE = new RegExp(`(^|_)(${WHO})($|_)`);
const WHO_NAME = new RegExp(`(^|_)(${WHO})_name$`);
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export const peopleIn = (names: string[]) => names.some((n) => PEOPLE.test(snake(n)));
// a bare `name` is a person's only in a table about people: products have names too
export const personal = (name: string, people: boolean) => { const n = snake(name); return PERSONAL.test(n) || WHO_NAME.test(n) || (people && n === 'name'); };

// a value that looks personal, wherever it turned up: a JSON column, a concat, a function Unit7 can't see into
const EMAIL = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w.-])(?:\+\d[\d\s().-]{6,}\d|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?![\w-])/g;
export const hideShapes = (v: string) => v.replace(EMAIL, '[hidden email]').replace(PHONE, '[hidden phone]');
// these can't carry a person: "may always count and aggregate" stays true whatever the column is called
const PLAIN = /^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|t|f|true|false|\d{4}-\d{2}(?:-\d{2})?(?:[ T][\d:.]+(?:[+-]\d{2}(?::?\d{2})?|Z)?)?)$/i;

export interface Mask { hide: Set<number>; text: Set<number>; all: boolean } // hide: nothing shows. text: only numbers show. all: text, for every column
const NONE = (): Mask => ({ hide: new Set(), text: new Set(), all: false });

const noLiterals = (e: string) => e.replace(/'(?:[^']|'')*'/g, "''");
// count(...), sum(...), avg(...) out of an expression, with any FILTER (...): a number, whatever went in
const closing = (e: string, from: number) => { let i = from, depth = 1; for (; i < e.length && depth; i++) { if (e[i] === '(') depth++; if (e[i] === ')') depth--; } return i; };
function noCounts(e: string) {
  for (;;) {
    const m = /\b(?:count|sum|avg|stddev\w*|variance|var_\w+)\s*\(/i.exec(e);
    if (!m) return e;
    let i = closing(e, m.index + m[0].length);
    const f = /^\s*FILTER\s*\(/i.exec(e.slice(i));
    if (f) i = closing(e, i + f[0].length);
    e = `${e.slice(0, m.index)}0${e.slice(i)}`;
  }
}
const named = (e: string) => e.match(/[A-Za-z_][\w$]*/g) ?? [];

// Functions that run text as a query or read outside the tables: a personal column can hide in the string they're given,
// and a plan only shows the string
const DYNAMIC = /\b(?:(?:query|table|schema|database|cursor)_to_xml\w*|ts_stat|ts_rewrite|dblink\w*|crosstab\w*|connectby|xpath_table|pg_read_\w+|pg_ls_\w+|lo_get|lo_export|loread)\b/;
export const usesDynamic = (text: string) => DYNAMIC.test(text);

// (Postgres) the mask from EXPLAIN (VERBOSE, FORMAT JSON). Only the top node's outputs are the result: scans below often list
// every column of a table even for count(*), so what they say proves nothing, except under a UNION, where each arm is a result too.
interface PlanNode { 'Node Type'?: string; 'Relation Name'?: string; Alias?: string; Output?: string[]; Plans?: PlanNode[]; [k: string]: unknown }
export function planMask(root: PlanNode, columns: string[], sqlWords: string[]): Mask {
  const nodes: PlanNode[] = [];
  const walk = (x: PlanNode) => { nodes.push(x); x.Plans?.forEach(walk); };
  walk(root);
  const bases = new Set(nodes.flatMap((x) => (x['Relation Name'] ? [x['Relation Name'], x.Alias ?? ''] : [])));
  const people = peopleIn([...nodes.flatMap((x) => (x['Relation Name'] ? [x['Relation Name']] : [])), ...sqlWords]);
  const m = NONE(), top = root.Output ?? root.Plans?.[0]?.Output; // an Append lists no outputs of its own: its first arm's are the result's
  if (!top) return { ...m, all: true };
  const mention = (e: string) => named(noLiterals(e)).some((w) => personal(w, people)) || /\.\*/.test(e);
  // a union's other arms: their columns come out under the first arm's names
  if (nodes.some((x) => /^(Append|Merge Append|Recursive Union|SetOp)$/.test(x['Node Type'] ?? '')) && nodes.slice(1).some((x) => x.Output?.some((e) => mention(noCounts(e))))) return { ...m, all: true };
  columns.forEach((name, i) => {
    const raw = top[i];
    if (raw === undefined) { m.text.add(i); return; }
    const e = noCounts(noLiterals(raw));
    const counted = e !== noLiterals(raw) && !named(e).some((w) => !/^\d/.test(w));
    if (counted) return; // only counts and sums: a number, whatever it's called
    if (mention(e) || personal(name, people)) { m.hide.add(i); return; }
    // a value from somewhere Unit7 can't see the column of: a subquery, a CTE, a function's result
    const aliases = [...e.matchAll(/\b([A-Za-z_][\w$]*)\.[A-Za-z_"]/g)].map((x) => x[1]!);
    if (/\$\d|SubPlan|InitPlan/.test(e) || aliases.some((a) => !bases.has(a))) m.text.add(i);
  });
  return m;
}

// (MySQL) no outputs in its plan: names only, and a personal word anywhere outside a count leaves only numbers
export function textMask(toks: Tok[], columns: string[]): Mask {
  const words = toks.filter((t) => t.k === 'word' || t.k === 'name').map((t) => t.v), people = peopleIn(words), m = NONE();
  const line = toks.filter((t) => t.k !== 'str').map((t) => (t.k === 'op' ? t.v : `${t.v} `)).join('');
  columns.forEach((c, i) => { if (personal(c, people)) m.hide.add(i); });
  return { ...m, all: named(noCounts(line)).some((w) => personal(w, people)) };
}

export function maskRows(columns: string[], rows: string[][], m: Mask) {
  const masked = new Set<string>();
  const out = rows.map((r) => r.map((v, i) => {
    if (v === '' || (PLAIN.test(v) && !m.hide.has(i))) return v;
    if (m.hide.has(i) && !/^(t|f|true|false)$/i.test(v)) { masked.add(columns[i] ?? String(i)); return '[hidden]'; }
    if (m.all || m.text.has(i)) { masked.add(columns[i] ?? String(i)); return '[hidden]'; }
    const clean = hideShapes(v);
    if (clean !== v) masked.add(columns[i] ?? String(i));
    return clean;
  }));
  return { rows: out, masked: [...masked] };
}

// MongoDB: the same, by field name, all the way down
export function maskDoc(v: unknown, seen: Set<string>, onlyNumbers: boolean, people: boolean, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => maskDoc(x, seen, onlyNumbers, people, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, personal(k, people) ? (seen.add(k), '[hidden]') : maskDoc(x, seen, onlyNumbers, people, k)]));
  if (typeof v !== 'string') return v;
  if (onlyNumbers) { seen.add(key); return '[hidden]'; }
  const clean = hideShapes(v);
  if (clean !== v) seen.add(key);
  return clean;
}

// --- reading results -------------------------------------------------------------------------------------------------------
// psql --csv: RFC 4180, with newlines inside quotes
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; continue; }
    if (c === '"') { quoted = true; any = true; }
    else if (c === ',') { row.push(cell); cell = ''; any = true; }
    else if (c === '\n') { if (any || cell) { row.push(cell); rows.push(row); } row = []; cell = ''; any = false; }
    else if (c !== '\r') { cell += c; any = true; }
  }
  if (any || cell) { row.push(cell); rows.push(row); }
  return rows;
}
// mysql -B: tabs between cells, backslash escapes inside them
const UNTAB: Record<string, string> = { n: '\n', t: '\t', 0: '\0', '\\': '\\' };
export const parseTsv = (text: string) => text.split('\n').filter((l) => l !== '').map((l) => l.split('\t').map((c) => (c === 'NULL' ? '' : c.replace(/\\(.)/g, (m, x: string) => UNTAB[x] ?? m))));
export const toCsv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
