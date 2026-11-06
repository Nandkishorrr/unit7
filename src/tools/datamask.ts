// Reading a query before it runs, and what an AI may see of what comes back. Pure code, no I/O.
//
// A list of dangerous words can always be dodged, so nothing here is what keeps a read read-only: an AI's read runs as a login
// that can't write, in a throwaway container, and the database refuses the rest. This only answers "is it one statement", and
// "which outputs of this result are proved safe to show". The answer is an allow-list: an output shows if it's a plain column of a
// real table under a name that isn't personal, a count, or a sum, average, smallest or largest of such a column. Anything else
// comes back hidden, numbers too. For Postgres that comes from the database's own plan, where aliases, views and subqueries are
// already resolved. MySQL's plan doesn't list outputs, so only a plain SELECT can be proved, from its text. Either way a value
// shaped like an email or a phone number is hidden wherever it shows up.
import { Unit7Error } from '../errors.ts';

export type Dialect = 'pg' | 'my';
export interface Tok { k: 'word' | 'name' | 'str' | 'op' | 'cmd' | 'note'; v: string; at: number } // cmd: a backslash outside everything. note: a comment
const refuse = (why: string) => new Unit7Error('bad_statement', why, 400);
const SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
// the whole of a word or a tag, however long: cut one short and what follows it reads as something else
const WORD = /[A-Za-z_\u0080-￿][\w$\u0080-￿]*/y, TAG = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;
const matched = (re: RegExp, sql: string, at: number) => { re.lastIndex = at; return re.exec(sql)?.[0]; };
// psql ends a line at a carriage return too, and the server with it; MySQL only at a newline
const lineEnd = (sql: string, from: number, d: Dialect) => { for (let j = from; j < sql.length; j++) if (sql[j] === '\n' || (d === 'pg' && sql[j] === '\r')) return j; return sql.length; };
// what an E'' string reads differently: a quote after an odd run of backslashes
const ODD_SLASH = /(?:^|[^\\])(?:\\\\)*\\'/;
// where a number stops depends on psql's age: 1e-- starts a comment for one and not for another, and so does 1e$$ a dollar quote
const afterNumber = (sql: string, at: number) => /\d\.?$/.test(sql.slice(Math.max(0, at - 2), at));
const GLUED = 'A number stuck to what follows it can be read two ways. Put a space after it.';

// Strings, comments and dollar quotes the way psql and the database read them, so a ; or a backslash inside one isn't mistaken for
// anything. A backslash outside one is a client command (psql's \!, mysql's \!), never SQL, and nothing else starts it. One token at
// a time: a dump can be big, and whoever reads it moves pos.i past its rows.
export function* lex(sql: string, d: Dialect, pos = { i: 0 }): Generator<Tok> {
  const quoted = (from: number, q: string, escapes: boolean) => {
    for (let j = from + 1; j < sql.length; j++) {
      if (escapes && sql[j] === '\\') { j++; continue; }
      if (sql[j] === q) { if (sql[j + 1] === q) { j++; continue; } return j + 1; }
    }
    throw refuse('A quote isn’t closed.');
  };
  let word: Tok | undefined;
  while (pos.i < sql.length) {
    const i = pos.i, c = sql[i]!;
    if (SPACE.has(c)) { pos.i++; continue; }
    if (d === 'pg' && sql.startsWith('--', i) && word?.at === i - 1 && /^e$/i.test(word.v) && afterNumber(sql, word.at)) throw refuse(GLUED);
    if ((sql.startsWith('--', i) && (d === 'pg' || SPACE.has(sql[i + 2] ?? ' '))) || (d === 'my' && c === '#')) { pos.i = lineEnd(sql, i, d); yield { k: 'note', v: sql.slice(i, pos.i), at: i }; continue; }
    if (sql.startsWith('/*', i)) {
      // MySQL runs what's in these, so they're code, not comments
      if (d === 'my' && /^\/\*M?!/.test(sql.slice(i, i + 4))) throw refuse('Comments that run code aren’t allowed here.');
      let depth = 1, j = i + 2;
      while (j < sql.length && depth) { if (sql.startsWith('*/', j)) { depth--; j += 2; } else if (d === 'pg' && sql.startsWith('/*', j)) { depth++; j += 2; } else j++; }
      if (depth) throw refuse('A comment isn’t closed.');
      pos.i = j; yield { k: 'note', v: sql.slice(i, j), at: i }; continue;
    }
    if (c === "'" || (d === 'my' && c === '"')) {
      // 1e'…' is an escape string to an old psql and not to a new one, and a string on the next line is whatever the last one was
      const e = d === 'pg' && word?.at === i - 1 && /^e$/i.test(word.v) && !/[\w$.\u0080-￿]/.test(sql[i - 2] ?? ' ');
      const j = quoted(i, c, d === 'my' || e);
      if (d === 'pg' && !e && ODD_SLASH.test(sql.slice(i + 1, j))) throw refuse('A backslash right before a quote can be read two ways. Double it, or write the string as E\'…\'.');
      pos.i = j; yield { k: 'str', v: sql.slice(i + 1, j - 1), at: i }; continue;
    }
    if (c === '"' || (d === 'my' && c === '`')) { const j = quoted(i, c, false); pos.i = j; yield { k: 'name', v: sql.slice(i + 1, j - 1).split(c + c).join(c), at: i }; continue; }
    if (d === 'pg' && c === '$') {
      const tag = matched(TAG, sql, i);
      if (tag) { const e = sql.indexOf(tag, i + tag.length); if (e < 0) throw refuse('A quote isn’t closed.'); pos.i = e + tag.length; yield { k: 'str', v: sql.slice(i + tag.length, e), at: i }; continue; }
    }
    pos.i = i + 1;
    if (c === '\\') { yield { k: 'cmd', v: c, at: i }; continue; }
    const w = matched(WORD, sql, i);
    if (w && d === 'pg' && w.includes('$') && afterNumber(sql, i)) throw refuse(GLUED);
    if (w) { pos.i = i + w.length; yield word = { k: 'word', v: w, at: i }; continue; }
    yield { k: 'op', v: c, at: i };
  }
}
export function tokenize(sql: string, d: Dialect) {
  const out: Tok[] = [];
  for (const t of lex(sql, d)) {
    if (t.k === 'cmd' || (t.k === 'note' && t.v.includes('\\'))) throw refuse('Client commands (a backslash) aren’t allowed in a query.');
    if (t.k !== 'note') out.push(t);
  }
  return out;
}

// One statement, or a refusal. text is what the database gets: no trailing ; and nothing after it.
export function statement(sql: string, d: Dialect) {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(sql)) throw refuse('A query can’t hold control characters, such as a carriage return. Take them out and try again.');
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
// what can't be undone from a copy of one database, for the gate: never a plain data change. The gate doesn't know which database
// it is, so it's read both ways, and never differently from what runs: what statement refuses never runs
export const dropsDatabase = (sql: string) => (['pg', 'my'] as const).some((d) => {
  try { const { first, toks } = statement(sql, d); return first === 'drop' && has(toks.slice(1, 2), 'database', 'schema'); } catch { return false; }
});

// --- what looks personal ---------------------------------------------------------------------------------------------------
const PERSONAL = /(^|_)(e?mails?|phones?|mobile|telephone|tel|fax|passwords?|passwd|pwd|pass|hash(ed)?|digest|pin|auth|keys?|sessions?|tokens?|secrets?|api_?keys?|private_?keys?|credentials?|otp|jwt|cookies?|salt|ssn|passport|tax_?id|national_?id|iban|cvv|card(_?number)?|birth(_?(day|date))?|dob|first_?names?|last_?names?|full_?names?|sur_?names?|given_?names?|family_?names?|middle_?names?|maiden_?name|display_?names?|nick_?names?|nicename|user_?names?|login|addr|address|address_?\d|street|post_?codes?|zip(_?codes?)?|ip|ip_?addr(ess)?|lat(itude)?|lng|longitude)($|_)/;
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
export interface Mask { hide: Set<number>; all: boolean } // hide: nothing shows in these columns. all: nothing shows in any
const NONE = (): Mask => ({ hide: new Set(), all: false });

const noLiterals = (e: string) => e.replace(/'(?:[^']|'')*'/g, "''");
// count(...) out of an expression, with any FILTER (...): a number, whatever went in. A sum isn't: it hands back what it's given
const closing = (e: string, from: number) => { let i = from, depth = 1; for (; i < e.length && depth; i++) { if (e[i] === '(') depth++; if (e[i] === ')') depth--; } return i; };
function noCounts(e: string) {
  for (;;) {
    const m = /\bcount\s*\(/i.exec(e);
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

// A list of new column names on a table (FROM users u(a, b)): the plan then prints the new names, so nothing it says can be trusted.
// A word that can't name a table starts a call, and so does whatever comes right after one of these.
const RESERVED = new Set('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with'.split(' '));
const CALLS_FOLLOW = new Set([...RESERVED, 'by', 'between', 'partition', 'set', 'at', 'zone']);
export function renamesColumns(toks: Tok[]) {
  return toks.some((t, k) => {
    const next = toks[k + 1], prev = toks[k - 1], w = t.v.toLowerCase();
    if (next?.k !== 'op' || next.v !== '(' || !prev) return false;
    if (t.k === 'word' && w === 'only') return true;
    if (t.k === 'op' || t.k === 'str' || (t.k === 'word' && RESERVED.has(w))) return false;
    return prev.k === 'name' || (prev.k === 'op' && prev.v === '*') || (prev.k === 'word' && (prev.v.toLowerCase() === 'as' || !CALLS_FOLLOW.has(prev.v.toLowerCase())));
  });
}

// (Postgres) the mask from EXPLAIN (VERBOSE, FORMAT JSON). Only the top node's outputs are the result: scans below often list every
// column of a table even for count(*), so what they say proves nothing, except under a UNION, where each arm is a result too.
interface PlanNode { 'Node Type'?: string; 'Relation Name'?: string; Schema?: string; Alias?: string; Output?: string[]; Plans?: PlanNode[]; [k: string]: unknown }
const IDENT = '"(?:[^"]|"")+"|[A-Za-z_][\\w$]*', COLUMN = new RegExp(`^(?:(${IDENT})\\.)?(${IDENT})$`);
const unquoted = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);
const AGGREGATE = /^(?:sum|avg|min|max)\((.+)\)$/i;
export function planMask(root: PlanNode, columns: string[], sqlWords: string[]): Mask {
  const nodes: PlanNode[] = [];
  const walk = (x: PlanNode) => { nodes.push(x); x.Plans?.forEach(walk); };
  walk(root);
  // the tables that were really read. A subquery, a CTE, VALUES or a function can carry any value under any name
  const scans = nodes.filter((x) => x['Relation Name'] && !['pg_catalog', 'information_schema'].includes(x.Schema ?? '')), tables = new Set(scans.map((x) => x.Alias ?? x['Relation Name']!));
  for (const x of nodes) if (!x['Relation Name'] && x.Alias) tables.delete(x.Alias);
  const people = peopleIn([...nodes.flatMap((x) => (x['Relation Name'] ? [x['Relation Name']] : [])), ...sqlWords]);
  const m = NONE(), top = root.Output ?? root.Plans?.[0]?.Output; // an Append lists no outputs of its own: its first arm's are the result's
  if (!top) return { ...m, all: true };
  const plain = (e: string) => {
    const [, table, column] = COLUMN.exec(e) ?? [];
    return !!column && (table ? tables.has(unquoted(table)) : tables.size === 1) && !personal(unquoted(column), people);
  };
  const proved = (raw: string) => { const e = raw.replace(/^\((.*)\)$/, '$1'); return plain(e) || plain(AGGREGATE.exec(e)?.[1] ?? ''); }; // a Sort above prints it in brackets
  const counted = (raw: string) => { const e = noCounts(noLiterals(raw)); return !/\$\d/.test(e) && !named(e).length; };
  // a union's other arms: their columns come out under the first arm's names
  const arms = nodes.filter((x) => /^(Append|Merge Append|Recursive Union|SetOp)$/.test(x['Node Type'] ?? '')).every((x) => x.Plans?.every((a) => a.Output?.every(proved) ?? true));
  columns.forEach((name, i) => {
    const raw = top[i];
    if (raw !== undefined && counted(raw)) return;
    if (raw === undefined || !arms || !proved(raw) || personal(name, people)) m.hide.add(i);
  });
  return m;
}

// What an AI may see of a Postgres read. EXPLAIN talks about a query, never its rows, and a built-in setting holds no secret: one with
// a dot in its name is an app's own, and Supabase keeps its JWT secret in one.
export function readMask(st: { first: string; toks: Tok[] }, plan: unknown, columns: string[]): Mask {
  if (st.first === 'explain' || (st.first === 'show' && st.toks.length === 2 && st.toks[1]!.k === 'word')) return NONE();
  if (!plan || renamesColumns(st.toks)) return { ...NONE(), all: true };
  return planMask(plan as PlanNode, columns, st.toks.filter((t) => t.k === 'word' || t.k === 'name').map((t) => t.v));
}

// (MySQL) no outputs in its plan, so the statement has to prove it: one plain SELECT, item by item, each lined up with its column.
// A subquery or a union can put anything under any name, and only the database knows what a view renamed.
const word = (t: Tok | undefined, ...w: string[]) => t?.k === 'word' && w.includes(t.v.toLowerCase());
export function textMask(toks: Tok[], columns: string[]): Mask {
  const words = toks.filter((t) => t.k === 'word' || t.k === 'name').map((t) => t.v), people = peopleIn(words), m = NONE();
  columns.forEach((c, i) => { if (personal(c, people)) m.hide.add(i); });
  if (word(toks[0], 'desc', 'describe', 'explain')) return m; // names and numbers about a table, never its rows
  if (!word(toks[0], 'select') || toks.slice(1).some((t) => word(t, 'select', 'union', 'except', 'intersect'))) return { ...m, all: true };
  const items: Tok[][] = [[]];
  let depth = 0;
  for (const t of word(toks[1], 'distinct') ? toks.slice(2) : toks.slice(1)) {
    if (t.k === 'op' && t.v === '(') depth++;
    if (t.k === 'op' && t.v === ')') depth--;
    if (!depth && word(t, 'from')) break;
    if (!depth && t.k === 'op' && t.v === ',') items.push([]); else items.at(-1)!.push(t);
  }
  if (items.length === 1 && items[0]!.at(-1)?.v === '*' && items[0]!.at(-1)?.k === 'op' && items[0]!.length <= 3) return m; // SELECT *: the columns are what they're called
  if (items.length !== columns.length) return { ...m, all: true };
  const shape = (x: Tok[]) => x.map((t) => (t.k === 'op' ? t.v : t.k === 'str' ? 's' : 'w')).join('');
  // [t.]column [AS name], where a bare second word could be an operator: BINARY password
  const plainColumn = (x: Tok[]) => {
    const at = x[1]?.v === '.' ? 2 : 0;
    return /^(?:w\.)?w(?:ww)?$/.test(shape(x)) && (x.length === at + 1 || word(x[at + 1], 'as')) && !personal(x[at]!.v, people);
  };
  const proved = (x: Tok[]) => {
    if (word(x[0], 'count') && x[1]?.v === '(') { let d = 0, k = 1; for (; k < x.length; k++) { if (x[k]!.k === 'op' && x[k]!.v === '(') d++; if (x[k]!.k === 'op' && x[k]!.v === ')' && !--d) break; } return /^w{0,2}$/.test(shape(x.slice(k + 1))); }
    if (word(x[0], 'sum', 'avg', 'min', 'max') && x[1]?.v === '(') { const close = x.findIndex((t) => t.k === 'op' && t.v === ')'); return close > 0 && plainColumn(x.slice(2, close)) && /^w{0,2}$/.test(shape(x.slice(close + 1))); }
    return plainColumn(x);
  };
  items.forEach((x, i) => { if (!proved(x)) m.hide.add(i); });
  return m;
}

// What a database says about a query can hold its rows: a failed cast prints the value. So an AI gets fixed words, never the database's.
const AI_HEARS: [RegExp, string][] = [
  [/syntax error|error in your SQL syntax/i, 'The database couldn’t read that query. Check its syntax.'],
  [/does not exist|doesn't exist|Unknown (column|table)/i, 'That query names a table, a column or a function that isn’t there. part.tables lists the tables.'],
  [/read-only transaction|READ ONLY transaction/i, 'That would change data, and this login can only read. To change data, say write: true.'],
  [/statement timeout|lock timeout|max_execution_time|max_statement_time/i, 'That took too long, so it was stopped.'],
];
export const aiHears = (said: string) => AI_HEARS.find(([re]) => re.test(said))?.[1] ?? 'The database refused that query. Its own words can hold row values, so they don’t go to an AI. A person can run it to see why.';

export function maskRows(columns: string[], rows: string[][], m: Mask) {
  const masked = new Set<string>();
  const out = rows.map((r) => r.map((v, i) => {
    if (v === '') return v;
    if (m.all || m.hide.has(i)) { if (/^(t|f|true|false)$/i.test(v)) return v; masked.add(columns[i] ?? String(i)); return '[hidden]'; }
    const clean = hideShapes(v);
    if (clean !== v) masked.add(columns[i] ?? String(i));
    return clean;
  }));
  return { rows: out, masked: [...masked] };
}

// MongoDB: the same, by field name, all the way down. all: the query named something personal, so it could be here under any name
export function maskDoc(v: unknown, seen: Set<string>, all: boolean, people: boolean, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => maskDoc(x, seen, all, people, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, personal(k, people) ? (seen.add(k), '[hidden]') : maskDoc(x, seen, all, people, k)]));
  if (all && v !== null && typeof v !== 'boolean') { seen.add(key); return '[hidden]'; }
  if (typeof v !== 'string') return v;
  const clean = hideShapes(v);
  if (clean !== v) seen.add(key);
  return clean;
}

// What an AI asks of MongoDB is read as data here and written out again, so none of its text ever runs: mongosh would run it as
// JavaScript, with the login's password in reach. Stages and operators are the ones whose output keeps its field names: a computed
// value ($concat, $getField, $objectToArray, $function, $where) could carry any field under any name.
const MONGO_READS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct']);
const MONGO_CHANGES = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany']);
const MONGO_AFTER = new Set(['sort', 'limit', 'skip']);
const MONGO_OPS = new Set('$eq $ne $gt $gte $lt $lte $in $nin $exists $type $and $or $nor $not $size $all $elemMatch $regex $options $match $group $sort $limit $skip $count $project $unwind $sum $avg $min $max $oid $date'.split(' '));
const MONGO_WRITE_OPS = new Set('$set $unset $inc $mul $rename $setOnInsert $push $pull $addToSet $pop $currentDate'.split(' '));
export interface MongoQuery { collection: string; method: string; args: unknown[]; after: { name: string; args: unknown[] }[]; words: string[]; counts: boolean }
export function mongoQuery(text: string, write = false): MongoQuery {
  const js = () => refuse('An AI asks MongoDB in plain data, like db.users.find({ plan: "pro" }), with no JavaScript.');
  let i = 0;
  const skip = () => { while (i < text.length && SPACE.has(text[i]!)) i++; };
  const at = (c: string) => { skip(); if (text[i] !== c) return false; i++; return true; };
  const must = (c: string) => { if (!at(c)) throw js(); };
  const name = () => { skip(); const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 300)); if (!m) throw js(); i += m[0].length; return m[0]; };
  const string = () => {
    const q = text[i]!, from = ++i;
    let out = '';
    for (; i < text.length && text[i] !== q; i++) {
      if (text[i] !== '\\') { out += text[i]; continue; }
      const e = text[++i]!;
      out += { n: '\n', t: '\t', r: '\r' }[e] ?? e;
    }
    if (i >= text.length || i - from > 65_536) throw js();
    i++;
    return out;
  };
  const value = (): unknown => {
    skip();
    const c = text[i];
    if (c === '"' || c === "'") return string();
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = {};
      if (at('}')) return o;
      do {
        if (at('}')) return o; // a trailing comma
        skip();
        const k = text[i] === '"' || text[i] === "'" ? string() : name();
        if (k === '__proto__') throw js();
        must(':');
        o[k] = value();
      } while (at(','));
      must('}');
      return o;
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      if (at(']')) return a;
      do { if (at(']')) return a; a.push(value()); } while (at(','));
      must(']');
      return a;
    }
    const n = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (n) { i += n[0].length; return Number(n[0]); }
    const w = name();
    if (w === 'true' || w === 'false') return w === 'true';
    if (w === 'null') return null;
    // the two a query can't do without, as what they are: data
    if (w === 'ObjectId' || w === 'ISODate') { must('('); skip(); const v = text[i] === '"' || text[i] === "'" ? string() : undefined; must(')'); if (v === undefined) throw js(); return w === 'ObjectId' ? { $oid: v } : { $date: v }; }
    throw js();
  };
  const call = () => { must('('); const args: unknown[] = []; if (at(')')) return args; do args.push(value()); while (at(',')); must(')'); return args; };
  const words: string[] = [];
  const check = (v: unknown) => {
    if (typeof v === 'string') { if (v.startsWith('$$')) throw js(); words.push(...named(v)); return; }
    if (Array.isArray(v)) { v.forEach(check); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('$') && !MONGO_OPS.has(k) && !(write && MONGO_WRITE_OPS.has(k))) throw refuse(`An AI can’t use ${k.slice(0, 40)} here: it can compute a value under any name. Plain filters, $group, $project and $sort work.`);
      if (!k.startsWith('$')) words.push(...named(k));
      check(x);
    }
  };
  if (name() !== 'db') throw js();
  must('.');
  let collection = name();
  if (collection === 'getCollection') { must('('); skip(); collection = String(value()); must(')'); }
  must('.');
  const method = name();
  if (!MONGO_READS.has(method) && !(write && MONGO_CHANGES.has(method))) throw MONGO_CHANGES.has(method) ? new Unit7Error('needs_write', 'That changes data. To change data, say write: true.', 400) : js();
  const args = call(), after: MongoQuery['after'] = [];
  while (at('.')) {
    const tail = name(), more = call();
    if (tail === 'toArray') continue;
    if (!MONGO_AFTER.has(tail)) throw js();
    after.push({ name: tail, args: more });
  }
  at(';');
  skip();
  if (i < text.length) throw js();
  [args, ...after.map((a) => a.args)].forEach(check);
  words.push(...named(collection));
  const last = method === 'aggregate' ? (args[0] as Record<string, unknown>[] | undefined)?.at?.(-1) : undefined;
  return { collection, method, args, after, words, counts: method === 'countDocuments' || method === 'estimatedDocumentCount' || (!!last && typeof last === 'object' && '$count' in last) };
}
export const mongoCall = (q: MongoQuery) => {
  const data = (a: unknown[]) => `...EJSON.parse(${JSON.stringify(JSON.stringify(a))})`;
  return `db.getCollection(${JSON.stringify(q.collection)}).${q.method}(${data(q.args)})${q.after.map((a) => `.${a.name}(${data(a.args)})`).join('')}`;
};

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
