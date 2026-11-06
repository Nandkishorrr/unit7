// Z4 · Database changes that break the version still serving. A deploy runs the new version's migrations first, then
// starts it beside the old one and moves traffic: for about a minute the OLD code answers visitors against the NEW
// schema. A renamed column, a dropped one the old code still reads, a new required column the old code never fills, or
// a changed type breaks it in that window. This reads each pending migration (Prisma's migration.sql, Drizzle, Knex,
// Rails-style and plain .sql files, plus the common ORM DSLs where it's cheap), names each such change in plain words
// with the two-step way to do it, and grades it:
//   destructive: it loses data (the guard in detect.ts sees it): waits for a person, exactly as before;
//   risky: it breaks the old version while both run: waits for a person's choice (an AI asks on the Approvals page);
//   warning: worth knowing (a unique rule on existing data): shown, never blocks.
// Postgres migrations also run with a lock wait limit, so a busy table can't freeze the site behind them.
import type { Ctx } from '../tools/runtime.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import { ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { run } from '../db.ts';
import { destructiveLine } from '../connectors/detect.ts';

export type DbChangeKind = 'rename_column' | 'drop_column' | 'drop_table' | 'required_column' | 'change_type' | 'rename_table' | 'add_unique' | 'removes_data';
export type DbLevel = 'warning' | 'risky' | 'destructive';
// One change, for the Release timeline's Database step: title + why in plain words, the two-step fix, the SQL under Advanced.
export interface DbChange {
  kind: DbChangeKind; level: DbLevel; file: string; sql: string;
  table?: string; column?: string; to?: string;
  title: string; why: string; steps: string[];
}
// What the Database step shows. Kept on the deployment as plan.dbCheck.
export interface DbCheck {
  status: 'safe' | DbLevel;  // the worst change that matters (risky only counts while an old version serves)
  summary: string;           // one line for the step
  files: string[];           // the pending migration files checked
  changes: DbChange[];
  oldVersion: boolean;       // a version is serving now (a first deploy has nothing to break)
  lockLimit?: string;        // Postgres: how long a migration waits for a lock ("5s")
  held?: boolean;            // the deploy stopped here for a person
  goAhead?: string;          // who chose "Go ahead anyway"
}

// --- reading migrations ----------------------------------------------------------------------------------------------
type Raw = { kind: DbChangeKind; file: string; sql: string; table?: string; column?: string; to?: string; level?: DbLevel; set?: boolean };

// The part of a migration that runs on deploy: `migrate deploy/latest/up` never runs a down() section, and a down file
// never runs at all. Cut only where an up marker clearly comes first, so nothing that runs is ever hidden.
const UP = /\b(?:exports\.up|async\s+up\s*\(|function\s+up\s*\(|up\s*[:(=]|def\s+upgrade\b|def\s+up\b)/;
const DOWN = /\b(?:exports\.down|async\s+down\s*\(|function\s+down\s*\(|down\s*[:(=]|def\s+downgrade\b|def\s+down\b)/;
const SQL_DOWN = /^\s*--\s*(?:migrate:down|\+goose\s+down)\b/im;
export function upPart(body: string, file = ''): string {
  if (/\.down\.sql$/i.test(file)) return '';
  const sqlDown = SQL_DOWN.exec(body);
  if (sqlDown) return body.slice(0, sqlDown.index);
  if (/\.sql$/i.test(file)) return body;
  const u = UP.exec(body), d = DOWN.exec(body);
  return u && d && d.index > u.index ? body.slice(0, d.index) : body;
}

const ID = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+))*`;
const name = (s?: string) => s?.split('.').pop()!.trim().replace(/^["`[]|["`\]]$/g, '');
const one = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);
// split "a, b(c, d), e" on the commas outside parentheses and quotes
function topLevel(s: string): string[] {
  const out: string[] = []; let depth = 0, q = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)--[^\n]*/g, '$1').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''");

const created = (code: string) => [...code.matchAll(new RegExp(String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${ID})`, 'gi'))].map((m) => name(m[1])!.toLowerCase());

function sqlChanges(code: string, file: string, isNew: (t?: string) => boolean): Raw[] {
  const out: Raw[] = [];
  const add = (r: Omit<Raw, 'file'>) => { if (!isNew(r.table)) out.push({ ...r, file }); };
  // a .sql file is statements split by ";"; in code, SQL sits in strings, a statement per line
  for (const stmt of noComments(code).split(/\.sql$/i.test(file) ? /;/ : /;|\n/)) {
    const sql = one(stmt);
    if (!sql) continue;
    for (const m of sql.matchAll(new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${ID}(?:\s*,\s*${ID})*)`, 'gi'))) for (const t of topLevel(m[1]!)) add({ kind: 'drop_table', sql, table: name(t) });
    for (const m of sql.matchAll(new RegExp(String.raw`\b(?:TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM)\s+(?:ONLY\s+)?(${ID})`, 'gi'))) add({ kind: 'removes_data', sql, table: name(m[1]) });
    for (const m of sql.matchAll(new RegExp(String.raw`\bRENAME\s+TABLE\s+(${ID})\s+TO\s+(${ID})`, 'gi'))) add({ kind: 'rename_table', sql, table: name(m[1]), to: name(m[2]) });
    const u = new RegExp(String.raw`\bCREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${ID}\s+)?ON\s+(?:ONLY\s+)?(${ID})\s*(?:USING\s+\w+\s*)?\(([^)]*)\)`, 'i').exec(sql);
    if (u) add({ kind: 'add_unique', sql, table: name(u[1]), column: topLevel(u[2]!).map(name).join(', ') });
    const alter = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${ID})\s+([\s\S]+)`, 'i').exec(sql);
    if (!alter) continue;
    const table = name(alter[1]);
    for (const a of topLevel(alter[2]!)) {
      const sql = one(`ALTER TABLE ${alter[1]} ${a}`); // each action on its own: an ADD next to a DROP isn't a drop
      let m: RegExpExecArray | null;
      if ((m = new RegExp(String.raw`^RENAME\s+TO\s+(${ID})`, 'i').exec(a))) add({ kind: 'rename_table', sql, table, to: name(m[1]) });
      else if (/^RENAME\s+(?:CONSTRAINT|INDEX|KEY)\b/i.test(a)) continue;
      else if ((m = new RegExp(String.raw`^RENAME\s+(?:COLUMN\s+)?(${ID})\s+TO\s+(${ID})`, 'i').exec(a))) add({ kind: 'rename_column', sql, table, column: name(m[1]), to: name(m[2]) });
      else if (/^DROP\s+(?:CONSTRAINT|INDEX|KEY|PRIMARY|FOREIGN|CHECK|PARTITION|DEFAULT|NOT\s+NULL)\b/i.test(a)) continue;
      else if ((m = new RegExp(String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${ID})`, 'i').exec(a))) add({ kind: 'drop_column', sql, table, column: name(m[1]) });
      else if ((m = /^ADD\s+(?:CONSTRAINT\s+\S+\s+)?UNIQUE\b[^(]*\(([^)]*)\)/i.exec(a))) add({ kind: 'add_unique', sql, table, column: topLevel(m[1]!).map(name).join(', ') });
      else if (/^ADD\s+(?:CONSTRAINT|PRIMARY|FOREIGN|INDEX|KEY|CHECK|FULLTEXT|SPATIAL|UNIQUE)\b/i.test(a)) continue;
      else if ((m = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${ID})\s+([\s\S]*)`, 'i').exec(a))) {
        const def = m[2]!;
        if (/\bNOT\s+NULL\b/i.test(def) && !/\b(?:DEFAULT|GENERATED|IDENTITY|AUTO_INCREMENT|(?:BIG|SMALL)?SERIAL\d?)\b/i.test(def)) add({ kind: 'required_column', sql, table, column: name(m[1]) });
      } else if ((m = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${ID})\s+(?:SET\s+DATA\s+)?TYPE\b`, 'i').exec(a))) add({ kind: 'change_type', sql, table, column: name(m[1]) });
      else if ((m = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${ID})\s+SET\s+NOT\s+NULL\b`, 'i').exec(a))) add({ kind: 'required_column', sql, table, column: name(m[1]), set: true });
      else if ((m = new RegExp(String.raw`^MODIFY\s+(?:COLUMN\s+)?(${ID})`, 'i').exec(a))) add({ kind: 'change_type', sql, table, column: name(m[1]) });
      else if ((m = new RegExp(String.raw`^CHANGE\s+(?:COLUMN\s+)?(${ID})\s+(${ID})`, 'i').exec(a))) {
        const [from, to] = [name(m[1]), name(m[2])];
        add(from?.toLowerCase() === to?.toLowerCase() ? { kind: 'change_type', sql, table, column: from } : { kind: 'rename_column', sql, table, column: from, to });
      }
    }
  }
  return out;
}

// ORM DSLs: Rails, Django, Alembic, Knex, Sequelize, Laravel. The call's arguments are its quoted names (or Ruby symbols).
// ponytail: regex reading, not a parser; a migration written in an unusual style is simply not explained (the SQL guard and
// the data-loss guard still apply).
function dslChanges(code: string, file: string, isNew: (t?: string) => boolean): Raw[] {
  const out: Raw[] = [];
  const re = /(?:\b|->|::)(rename_column|renameColumn|remove_column|removeColumn|drop_column|dropColumns?|drop_table|dropTable(?:IfExists)?|Schema::drop(?:IfExists)?|DeleteModel|rename_table|renameTable|Schema::rename|RenameModel|change_column_null|change_column|changeColumn|RenameField|RemoveField|AlterField|AddField|alter_column|add_column|addColumn|add_index|addIndex|create_index|create_unique_constraint|addConstraint|AddConstraint|AlterUniqueTogether)\b/g;
  for (const m of code.matchAll(re)) {
    const at = m.index! + m[0].length;
    // the call: up to its closing parenthesis, or the rest of the line for Ruby without parentheses
    let body: string;
    if (code[at] === '(' || /^\s*\(/.test(code.slice(at, at + 3))) {
      const open = code.indexOf('(', at); let depth = 0, i = open;
      for (; i < code.length; i++) { if (code[i] === '(') depth++; else if (code[i] === ')' && --depth === 0) break; }
      body = code.slice(open + 1, i);
    } else body = code.slice(at, (code.indexOf('\n', at) + 1 || code.length + 1) - 1);
    const a = [...body.matchAll(/(?:^|[\s,([]):(\w+)|['"]([\w.]+)['"]/g)].map((x) => x[1] ?? x[2]!);
    const ctx = [...code.slice(0, m.index).matchAll(/(?:alterTable|\.table|Schema::table)\(\s*['"]([\w.]+)['"]/g)].pop()?.[1];
    const sql = one(m[0] + (body.length < 240 ? `(${body})` : '(…)'));
    const fn = m[1]!.replace(/^(Schema::)/, 'Schema_');
    const push = (r: Omit<Raw, 'file' | 'sql'>) => { if (!isNew(r.table)) out.push({ ...r, file, sql }); };
    switch (fn) {
      case 'rename_column': case 'renameColumn': case 'RenameField':
        if (a.length >= 3) push({ kind: 'rename_column', table: a[0], column: a[1], to: a[2] });
        else if (a.length === 2) push({ kind: 'rename_column', table: ctx, column: a[0], to: a[1] });
        break;
      case 'remove_column': case 'removeColumn': case 'drop_column': case 'RemoveField': if (a[1]) push({ kind: 'drop_column', table: a[0], column: a[1] }); break;
      case 'dropColumn': case 'dropColumns':
        if (!ctx && a.length >= 2) push({ kind: 'drop_column', table: a[0], column: a[1] }); // TypeORM: (table, column)
        else for (const c of a) push({ kind: 'drop_column', table: ctx, column: c });
        break;
      case 'drop_table': case 'dropTable': case 'dropTableIfExists': case 'Schema_drop': case 'Schema_dropIfExists': case 'DeleteModel': if (a[0]) push({ kind: 'drop_table', table: a[0] }); break;
      case 'rename_table': case 'renameTable': case 'Schema_rename': case 'RenameModel': if (a[1]) push({ kind: 'rename_table', table: a[0], to: a[1] }); break;
      case 'change_column': case 'changeColumn': if (a[1]) push({ kind: 'change_type', table: a[0], column: a[1] }); break;
      case 'AlterField': if (a[1]) push({ kind: 'change_type', table: a[0], column: a[1], level: 'warning' }); break;
      case 'change_column_null': if (a[1] && /\bfalse\b/.test(body)) push({ kind: 'required_column', table: a[0], column: a[1], set: true }); break;
      case 'alter_column':
        if (/new_column_name\s*=/.test(body)) push({ kind: 'rename_column', table: a[0], column: a[1], to: /new_column_name\s*=\s*['"](\w+)/.exec(body)?.[1] });
        else if (/\btype_\s*=/.test(body)) push({ kind: 'change_type', table: a[0], column: a[1] });
        else if (/nullable\s*=\s*False/.test(body)) push({ kind: 'required_column', table: a[0], column: a[1], set: true });
        break;
      case 'AddField': case 'add_column': case 'addColumn':
        if (/ManyToManyField/.test(body)) break;
        if ((fn === 'AddField' ? !/null\s*=\s*True/.test(body) : /null:\s*false|allowNull:\s*false|nullable\s*=\s*False/.test(body)) && !/default:|defaultValue|server_default|default\s*=/.test(body)) push({ kind: 'required_column', table: a[0], column: a[1] });
        break;
      case 'add_index': case 'addIndex': if (/unique:\s*true/.test(body)) push({ kind: 'add_unique', table: a[0] }); break;
      case 'create_index': if (/unique\s*=\s*True/.test(body)) push({ kind: 'add_unique', table: a[1] }); break;
      case 'create_unique_constraint': push({ kind: 'add_unique', table: a[1] }); break;
      case 'addConstraint': if (/type:\s*['"]unique/i.test(body)) push({ kind: 'add_unique', table: a[0] }); break;
      case 'AddConstraint': if (/UniqueConstraint/.test(body)) push({ kind: 'add_unique', table: a[0] }); break;
      case 'AlterUniqueTogether': push({ kind: 'add_unique', table: a[0] }); break;
    }
  }
  // Knex .alter() and Laravel ->change(): the column on that line changes its definition
  for (const m of code.matchAll(/^.*(?:\.alter\(\)|->change\(\)).*$/gm)) {
    const col = /['"]([\w.]+)['"]/.exec(m[0])?.[1];
    const table = [...code.slice(0, m.index).matchAll(/(?:alterTable|\.table|Schema::table)\(\s*['"]([\w.]+)['"]/g)].pop()?.[1];
    if (col && !isNew(table)) out.push({ kind: 'change_type', file, sql: one(m[0]), table, column: col });
  }
  return out;
}

// --- in plain words ----------------------------------------------------------------------------------------------------
const LEVEL: Record<DbChangeKind, DbLevel> = { rename_column: 'risky', drop_column: 'risky', drop_table: 'risky', required_column: 'risky', change_type: 'risky', rename_table: 'risky', add_unique: 'warning', removes_data: 'destructive' };
const RANK: Record<'safe' | DbLevel, number> = { safe: 0, warning: 1, risky: 2, destructive: 3 };
const WHILE = 'so visitors would see errors for about a minute while both run';
const of = (t?: string, c?: string) => [t, c].filter(Boolean).join('.') || 'it';

function words(r: Raw, used: boolean | undefined): Pick<DbChange, 'title' | 'why' | 'steps'> {
  const t = r.table, c = r.column, both = of(t, c);
  switch (r.kind) {
    case 'rename_column': return used === false
      ? { title: 'Renames a column', why: `This renames ${both} to ${r.to}. The running version doesn’t mention ${c}, so it won’t notice.`, steps: [] }
      : { title: 'Renames a column', why: `This renames a column (${both} → ${r.to}). The old version still uses the old name, ${WHILE}.`,
          steps: [`Add the new column (${r.to}) and keep ${c}.`, 'Deploy code that writes to both.', `Copy the data across${t ? ` (UPDATE ${t} SET ${r.to} = ${c})` : ''}.`, `Switch reads to ${r.to}.`, `Remove ${c} in the next release.`] };
    case 'drop_column': return used === false
      ? { title: 'Removes a column', why: `This removes ${both}. The running version doesn’t use it, so visitors won’t notice. Its data is gone, so Unit7 backs up first.`, steps: [] }
      : { title: 'Removes a column', why: `This removes a column (${both}) the old version still uses, ${WHILE}, and its data is gone.`,
          steps: [`Deploy code that no longer reads or writes ${c}.`, 'Remove the column in the next release, once nothing running uses it (Unit7 backs up first).'] };
    case 'drop_table': return used === false
      ? { title: 'Removes a table', why: `This removes the table ${t}. The running version doesn’t use it, so visitors won’t notice. Its data is gone, so Unit7 backs up first.`, steps: [] }
      : { title: 'Removes a table', why: `This removes a table (${t}) the old version still uses, ${WHILE}, and its data is gone.`,
          steps: [`Deploy code that no longer uses ${t}.`, 'Remove the table in the next release, once nothing running uses it (Unit7 backs up first).'] };
    case 'rename_table': return used === false
      ? { title: 'Renames a table', why: `This renames ${t} to ${r.to}. The running version doesn’t mention ${t}, so it won’t notice.`, steps: [] }
      : { title: 'Renames a table', why: `This renames a table (${t} → ${r.to}). The old version still uses the old name, ${WHILE}.`,
          steps: [`Create the new table (${r.to}) next to ${t}.`, 'Deploy code that writes to both.', 'Copy the data across.', `Switch reads to ${r.to}.`, `Remove ${t} in the next release.`] };
    case 'required_column': return r.set
      ? { title: 'Makes a column required', why: `This makes ${both} required. The old version may still save rows without it, so those saves would fail for about a minute while both run.`,
          steps: [`Deploy code that always fills in ${c}.`, 'Fill it in for the rows that already exist.', 'Make it required in the next release.'] }
      : { title: 'Adds a required column', why: `This adds a required column (${both}) with no default. The old version doesn’t know about it, so every row it saves would fail for about a minute while both run.`,
          steps: ['Add the column as optional, or give it a default.', 'Deploy code that always fills it in.', 'Fill it in for the rows that already exist.', 'Make it required in the next release.'] };
    case 'change_type': return r.level === 'warning'
      ? { title: 'Changes a column', why: `This changes how ${both} is defined. If its type or rules get stricter, the old version may send values it refuses.`, steps: ['If the type changes, add a new column instead, deploy code that writes to both, then switch over in the next release.'] }
      : { title: 'Changes a column’s type', why: `This changes the type of ${both}. The old version may send values the new type refuses, and a big table can be locked while it’s rewritten.`,
          steps: [`Add a new column with the new type next to ${c}.`, 'Deploy code that writes to both.', 'Copy the data across.', 'Switch reads to the new column.', `Remove ${c} in the next release.`] };
    case 'removes_data': return { title: 'Deletes rows', why: `This deletes rows from ${t ?? 'a table'}. They don’t come back by themselves, so Unit7 backs up first and a person decides.`, steps: [] };
    case 'add_unique': return { title: 'Adds a unique rule', why: `This makes ${both} unique. If two rows already share a value, the change fails and the deploy stops (nothing is lost; the old version keeps serving).`,
      steps: ['Look for duplicates first and clean them up.', 'Then add the rule. On a big Postgres table, CREATE UNIQUE INDEX CONCURRENTLY avoids locking it.'] };
  }
}

// The whole check, pure. bodies: pending file → its text. oldVersion: something is serving now. used: whether the running
// version's own files mention a name (undefined = couldn't tell, so assume it does).
export function checkMigrations(bodies: Record<string, string>, o: { oldVersion: boolean; used?: (name: string) => boolean | undefined } = { oldVersion: true }): DbCheck {
  const files = Object.keys(bodies);
  const ups = Object.fromEntries(files.map((f) => [f, upPart(bodies[f]!, f)]));
  const fresh = new Set(files.flatMap((f) => created(noComments(ups[f]!))));
  const isNew = (t?: string) => !!t && fresh.has(t.toLowerCase());
  const raw = files.flatMap((f) => [...sqlChanges(ups[f]!, f, isNew), ...(/\.sql$/i.test(f) ? [] : dslChanges(ups[f]!, f, isNew))]);
  const seen = new Set<string>();
  const changes: DbChange[] = [];
  for (const r of raw) {
    const key = `${r.kind}:${r.table ?? ''}:${r.column ?? ''}:${r.to ?? ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const target = r.kind === 'drop_table' || r.kind === 'rename_table' ? r.table : r.kind === 'rename_column' || r.kind === 'drop_column' ? r.column : undefined;
    const used = target ? o.used?.(target) : undefined;
    let level: DbLevel = r.level ?? LEVEL[r.kind];
    if (used === false && level === 'risky') level = 'warning'; // nothing running uses it: only the data-loss guard still applies
    if (destructiveLine(r.sql)) level = 'destructive';           // what the data-loss guard stops on, named the same way
    changes.push({ kind: r.kind, level, file: r.file, sql: r.sql, ...(r.table && { table: r.table }), ...(r.column && { column: r.column }), ...(r.to && { to: r.to }), ...words(r, used) });
  }
  changes.sort((a, b) => RANK[b.level] - RANK[a.level]);
  let status = changes.reduce<'safe' | DbLevel>((s, c) => (RANK[c.level] > RANK[s] ? c.level : s), 'safe');
  if (status === 'risky' && !o.oldVersion) status = 'warning'; // a first deploy: no old version to break
  const first = changes[0]?.title.toLowerCase();
  const summary = !files.length ? 'No new database changes in this release.'
    : status === 'safe' ? `Checked ${files.length} database change${files.length === 1 ? '' : 's'}: safe for the version still serving.`
    : status === 'destructive' ? `This database change removes data (${first}).`
    : status === 'risky' ? `This database change can break the version still serving (${first}).`
    : !o.oldVersion && changes.some((c) => c.level === 'risky') ? 'Nothing is serving yet, so these changes can’t break an older version.'
    : `One thing to know about this database change (${first}).`;
  return { status, summary, files, changes, oldVersion: o.oldVersion };
}

// The plain-words reason a risky deploy stopped (the deployment's error; its last line is what the app page shows).
export function riskyMessage(c: DbCheck): string {
  const top = c.changes.find((x) => x.level === 'risky') ?? c.changes[0]!;
  return `The new version changes the database in a way that can break the version still serving, so Unit7 paused before running it. The old version is still serving.\n${top.file}: ${top.sql}\nDo it in two steps:\n${top.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nOr a person can choose “Go ahead anyway”.\n${top.why}`;
}

// --- Postgres lock limits ----------------------------------------------------------------------------------------------
// Unit7 runs the app's own migrate command, so it can't SET these in the session itself: libpq-based clients (psql,
// node-postgres, psycopg, Rails, Django) read PGOPTIONS. A migration waiting on a busy table gives up after 5 s instead
// of queueing every visitor's query behind it; a statement never outlives the migration's own 15-minute limit.
// ponytail: Prisma's and Go's own drivers ignore PGOPTIONS; per-URL options are the upgrade if those need it too.
export const LOCK_LIMIT = '5s';
export function withLockLimits(env: Record<string, string>, log?: (m: string) => void): Record<string, string> {
  if (!/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL ?? '')) return env;
  const own = env.PGOPTIONS ?? '';
  const add = [!/lock_timeout/.test(own) && `-c lock_timeout=${LOCK_LIMIT}`, !/statement_timeout/.test(own) && '-c statement_timeout=15min'].filter(Boolean);
  if (!add.length) return env;
  log?.(`Postgres changes wait at most ${LOCK_LIMIT} for a lock, so a busy table can’t freeze the site.`);
  return { ...env, PGOPTIONS: [own, ...add].filter(Boolean).join(' ') };
}
// a migration that gave up on its lock, said plainly (added to the failure)
export const lockHint = (out: string) => (/lock timeout|lock_timeout|canceling statement due to lock/i.test(out)
  ? `\nThe database was busy, so the change gave up after waiting ${LOCK_LIMIT} for its table instead of freezing the site. Deploy again at a quieter moment.` : '');

// --- on the server -----------------------------------------------------------------------------------------------------
// Which of these names the running version's own files still mention: one grep inside its container. undefined when it
// can't tell (no grep in the image, a timeout), and then every name counts as used.
export async function runningMentions(ctx: Ctx, s: ServerRow, container: string, names: string[]): Promise<Set<string> | undefined> {
  const words = [...new Set(names.filter((n) => /^[A-Za-z_][\w$]{0,62}$/.test(n)))];
  if (!words.length) return new Set();
  const r = await ssh(ctx.app).exec(s, script('out=$(timeout 15 docker exec "$1" grep -rIhowE --exclude-dir=node_modules --exclude-dir=.git -e "$2" . 2>/dev/null); rc=$?; printf "%s\\n" "$out" | sort -u | head -200; echo "@@rc=$rc"', container, words.join('|')), { timeoutMs: 25_000 }).catch(() => undefined);
  const rc = /@@rc=(\d+)/.exec(r?.stdout ?? '')?.[1];
  if (rc !== '0' && rc !== '1') return undefined; // 1 = grep ran and found none of them
  return new Set(r!.stdout.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('@@rc=')));
}

// The Database step of a deploy: read the pending migrations once, check them against the version still serving, keep the
// result on the deployment (plan.dbCheck), and say what has to stop. The caller throws (its fail() records the stop).
export async function checkRelease(ctx: Ctx, s: ServerRow, a: {
  dir: string; pending: string[]; previousLive?: string; deploymentId: string; log: (m: string) => void;
  allowRisky?: boolean; allowDestructive?: boolean;
}): Promise<{ check: DbCheck; destructive?: { file: string; line: string }; paused?: string }> {
  const bodies: Record<string, string> = {};
  for (const f of a.pending.slice(0, 40)) bodies[f] = (await ssh(ctx.app).exec(s, script('head -c 200000 "$1/$2"', a.dir, f))).stdout;
  let check = checkMigrations(bodies, { oldVersion: !!a.previousLive });
  // drops and renames: does the running version even use those names? (an unused one is the safe last step)
  const names = check.changes.filter((c) => ['drop_table', 'rename_table', 'drop_column', 'rename_column'].includes(c.kind)).map((c) => (c.kind.endsWith('table') ? c.table : c.column)!).filter(Boolean);
  if (a.previousLive && names.length) {
    const seen = await runningMentions(ctx, s, a.previousLive, names);
    if (seen) check = checkMigrations(bodies, { oldVersion: true, used: (n) => seen.has(n.toLowerCase()) });
  }
  let destructive: { file: string; line: string } | undefined;
  for (const [file, body] of Object.entries(bodies)) {
    const line = destructiveLine(upPart(body, file));
    if (line) { destructive = { file, line }; break; }
  }
  // the data-loss guard saw something this check has no words for (DROP SCHEMA…): it still shows on the step
  if (destructive && !check.changes.some((c) => c.level === 'destructive')) {
    check = { ...check, status: 'destructive', summary: 'This database change removes data.', changes: [{ kind: 'removes_data', level: 'destructive', file: destructive.file, sql: destructive.line, title: 'Removes data',
      why: 'This change deletes data. It doesn’t come back by itself, so Unit7 backs up first and a person decides.', steps: [] }, ...check.changes] };
  }
  const stopsForData = !!destructive && !a.allowDestructive;
  const stopsForRisk = !stopsForData && check.status === 'risky' && !a.allowRisky && !a.allowDestructive;
  const going = !stopsForData && !stopsForRisk && RANK[check.status] >= RANK.risky;
  check = { ...check, ...((stopsForData || stopsForRisk) && { held: true }), ...(going && { goAhead: ctx.actor.name }) };
  run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ dbCheck: check }), a.deploymentId);
  a.log(check.summary);
  for (const c of check.changes.slice(0, 3)) a.log(`${c.file}: ${c.why}`);
  if (going) a.log(`${ctx.actor.name} chose to go ahead anyway.`);
  return { check, ...(stopsForData && { destructive }), ...(stopsForRisk && { paused: riskyMessage(check) }) };
}
