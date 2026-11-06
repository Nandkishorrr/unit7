// Staging in one click: "make a test copy of shipman". A working copy of an app or project: the same apps and
// settings in a Staging environment, a fresh database with a copy of production's data (names, emails and phones
// replaced if the person wants), a free test address, and a deploy. Values that look live (sk_live_…, rzp_live_…,
// "live" in the name, the live site's address, a live database's address, a connected account's key) are never copied
// without the person saying so: the plan lists them, each with "use a test key" or "copy anyway".
// staging.plan is read only. staging.create runs the plan one gated tool call at a time, each its own step in the
// thread, and stops at the first that doesn't work (the coolify.build pattern); running it again reuses what's there.
// staging.remove takes the copy down; production is only ever read.
import { z } from 'zod';
import { defineTool, execute, peopleRef, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error, forbidden, notFound } from '../errors.ts';
import { fid, isAgent } from './helpers.ts';
import { checkRef, merged } from './env.ts';
import { envContext, isRef, parseRef } from '../vault.ts';
import { serverRow } from './servers.ts';
import { dbService } from './backups.ts';
import { lastXray } from './xray.ts';
import { need } from './coolify.ts';
import { confirmMode } from './coolify-build.ts';
import { ENGINES, engineOf, list, setEnvs, tree, waitImport, type Coolify, type EngineName, type Resource } from '../connectors/coolify.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script, safeName } from '../connectors/shell.ts';
import { ask, stamp, threadFor, type AskSpec } from '../agent/asks.ts';
import type { ServiceConfig } from '../deploy/deployer.ts';

// --- what Unit7 set up, kept so it can be shown and taken down (the made table) -----------------------------
export function madeGet<T>(ctx: Pick<Ctx, 'db' | 'orgId'>, kind: string, key: string): (T & { at: string }) | undefined {
  const r = get<{ data: string; created_at: string }>(ctx.db, 'SELECT data, created_at FROM made WHERE org_id = ? AND kind = ? AND key = ?', ctx.orgId, kind, key);
  return r && { ...json<T>(r.data, {} as T), at: r.created_at };
}
export const madeSet = (ctx: Pick<Ctx, 'db' | 'orgId'>, kind: string, key: string, data: object) => run(ctx.db,
  'INSERT INTO made (id, org_id, kind, key, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id, kind, key) DO UPDATE SET data = excluded.data', id('mad'), ctx.orgId, kind, key, JSON.stringify(data));
export const madeDrop = (ctx: Pick<Ctx, 'db' | 'orgId'>, kind: string, key: string) => run(ctx.db, 'DELETE FROM made WHERE org_id = ? AND kind = ? AND key = ?', ctx.orgId, kind, key);

// --- room on a server: from what Unit7 last read (no SSH), the last usage reading, else a metrics sample, else connect's
export const SPARE_MB = 256; // kept free for the server itself
export function freeMb(ctx: Pick<Ctx, 'db' | 'orgId'>, serverId: string): { mb?: number; at?: string } {
  const u = lastXray<{ free?: { mem?: number } }>(ctx.db, ctx.orgId, serverId, 'usage');
  if (typeof u?.data.free?.mem === 'number') return { mb: Math.round(u.data.free.mem / 1048576), at: u.at };
  const m = get<{ at: string; mem_used: number | null; mem_total: number | null }>(ctx.db, 'SELECT at, mem_used, mem_total FROM metrics WHERE server_id = ? ORDER BY at DESC LIMIT 1', serverId);
  if (m?.mem_total) return { mb: Math.round((m.mem_total - (m.mem_used ?? 0)) / 1048576), at: m.at };
  const f = json<{ mem_available?: number }>(get<{ facts: string }>(ctx.db, 'SELECT facts FROM servers WHERE id = ? AND org_id = ?', serverId, ctx.orgId)?.facts, {});
  return f.mem_available ? { mb: Math.round(f.mem_available / 1048576) } : {};
}
export const roomFor = (ctx: Pick<Ctx, 'db' | 'orgId'>, serverId: string | undefined, needMb: number) => {
  const f = serverId ? freeMb(ctx, serverId) : {};
  return { needMb, ...(f.mb !== undefined && { freeMb: f.mb, fits: f.mb - needMb >= SPARE_MB }), ...(f.at && { at: f.at }) };
};

// --- values that look live ----------------------------------------------------------------------------------
const LIVE_WORD = /(^|[^a-z])live([^a-z]|$)/i;
const LIVE_KEY = /\b(sk|pk|rk|rzp|whsec)_live_[A-Za-z0-9]/;
const DB_URL = /^(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?):\/\//i;
const PROD_HOST = /(^|[.-])prod(uction)?([.-]|$)/i;
// Why a setting shouldn't go into a test copy as it is, in words; undefined when it can. Values are only looked at here.
export function liveReason(key: string, value: string, o: { prodHosts?: string[]; account?: string } = {}): string | undefined {
  if (LIVE_KEY.test(value)) return 'a live payment key';
  if (o.account) return `your connected ${o.account} account’s key`;
  if (LIVE_WORD.test(key) || (isRef(value) && LIVE_WORD.test(value))) return '“live” in its name';
  if (/(^|_)prod(uction)?(_|$)/i.test(key)) return '“production” in its name';
  if (DB_URL.test(value)) return 'a database address (likely your live data)';
  const host = /^https?:\/\/(?:[^@/\s]*@)?([^/:?#\s]+)/i.exec(value)?.[1]?.toLowerCase();
  if (host && ((o.prodHosts ?? []).some((h) => host === h || host.endsWith(`.${h}`)) || PROD_HOST.test(host))) return `your live site’s address (${host})`;
  return undefined;
}

// --- names, emails and phones in a database copy --------------------------------------------------------------
export type Pii = 'email' | 'name' | 'phone';
export interface Column { table: string; column: string; as: Pii }
const PEOPLE = /^(users?|customers?|members?|accounts?|profiles?|people|persons?|contacts?|subscribers?|employees?|staff|students?|clients?|leads?|patients?|guests?|authors?|buyers?|sellers?|drivers?)$/i;
export function piiOf(table: string, column: string): Pii | undefined {
  const c = column.toLowerCase();
  if (/(^|_)e?_?mail(_?address)?$/.test(c)) return 'email';
  if (/(^|_)(phone|mobile|cell|tel|telephone|whatsapp)(_?(no|num|number))?$/.test(c)) return 'phone';
  if (/^((first|last|middle|full|given|family|display|real|legal|contact|customer|billing|shipping)_?name|surname|username|user_name|nickname)$/.test(c)) return 'name';
  if (c === 'name' && PEOPLE.test(table)) return 'name';
  return undefined;
}
// text columns, one "table.column" per line (the same query on production for the preview and on the copy for real)
export const COLUMNS_SQL: Record<'postgres' | 'mysql', string> = {
  postgres: `SELECT table_name || '.' || column_name FROM information_schema.columns WHERE table_schema = 'public' AND (data_type IN ('text', 'character varying', 'character') OR udt_name = 'citext') ORDER BY 1;`,
  mysql: `SELECT CONCAT(table_name, '.', column_name) FROM information_schema.columns WHERE table_schema = DATABASE() AND data_type IN ('varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext') ORDER BY 1;`,
};
const IDENT = /^[A-Za-z_][\w$]{0,62}$/;
export function piiColumns(lines: string): Column[] {
  return lines.split('\n').map((l) => /^\s*([\w$]+)\.([\w$]+)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m && IDENT.test(m[1]!) && IDENT.test(m[2]!))
    .flatMap((m) => { const as = piiOf(m[1]!, m[2]!); return as ? [{ table: m[1]!, column: m[2]!, as }] : []; });
}
// Each value becomes a stand-in made from its own hash, so the same email is the same stand-in everywhere (joins and
// unique columns keep working) and NULL stays NULL. Names are checked against IDENT before they get here.
export function anonymizeSql(engine: 'postgres' | 'mysql' | 'mariadb', cols: Column[]): string {
  const pg = engine === 'postgres';
  const q = (s: string) => { if (!IDENT.test(s)) throw new Unit7Error('invalid_input', `“${s}” isn’t a plain column name.`); return pg ? `"${s}"` : `\`${s}\``; };
  const expr = (c: string, as: Pii) => (pg
    ? { email: `'u' || left(md5(${c}), 10) || '@example.com'`, name: `'Person ' || left(md5(${c}), 6)`, phone: `'+1555' || left(regexp_replace(md5(${c}), '[^0-9]', '', 'g') || '0000000', 7)` }
    : { email: `CONCAT('u', LEFT(MD5(${c}), 10), '@example.com')`, name: `CONCAT('Person ', LEFT(MD5(${c}), 6))`, phone: `CONCAT('+1555', LEFT(CONCAT(REGEXP_REPLACE(MD5(${c}), '[^0-9]', ''), '0000000'), 7))` })[as];
  const tables = Map.groupBy(cols, (c) => c.table);
  const updates = [...tables].map(([t, cs]) => `UPDATE ${q(t)} SET ${cs.map((c) => `${q(c.column)} = ${expr(q(c.column), c.as)}`).join(', ')};`);
  return [pg ? 'BEGIN;' : 'START TRANSACTION;', ...updates, 'COMMIT;'].join('\n');
}

// SQL on a database container, the password on the first stdin line (never on a command line), the SQL after it
interface SqlTarget { engine: 'postgres' | 'mysql' | 'mariadb'; container: string; user: string; database: string; password: string }
async function sqlOn(ctx: Ctx, s: ServerRow, t: SqlTarget, sql: string) {
  const c = safeName(t.container, 'container');
  const body = t.engine === 'postgres'
    ? 'IFS= read -r P; PGPASSWORD="$P" exec docker exec -i -e PGPASSWORD "$1" psql -X -q -tA -U "$2" -d "$3" -v ON_ERROR_STOP=1'
    : `IFS= read -r P; MYSQL_PWD="$P" exec docker exec -i -e MYSQL_PWD "$1" ${t.engine === 'mariadb' ? 'mariadb' : 'mysql'} -N -B -u "$2" "$3"`;
  return ssh(ctx.app).check(s, script(body, c, t.user, t.database), { what: 'Reading the database', stdin: `${t.password}\n${sql}\n`, timeoutMs: 10 * 60_000, signal: ctx.signal });
}
const sqlEngine = (e: string) => (e === 'postgres' || e === 'postgresql' ? 'postgres' : e === 'mysql' ? 'mysql' : e === 'mariadb' ? 'mariadb' : undefined);
const columnsSql = (e: 'postgres' | 'mysql' | 'mariadb') => COLUMNS_SQL[e === 'postgres' ? 'postgres' : 'mysql'];
// a Unit7 database as a SQL target (its own admin user and password)
function unit7Sql(ctx: Ctx, serviceId: string): { s: ServerRow; t?: SqlTarget; name: string } {
  const { svc, s, db } = dbService(ctx, serviceId);
  const engine = sqlEngine(db.engine);
  return { s, name: svc.name, ...(engine && { t: { engine, container: db.container, user: engine === 'postgres' ? (db.userRef ? 'unit7' : 'postgres') : 'root', database: db.database ?? 'app', password: db.passwordRef ? ctx.secret(db.passwordRef) : '' } }) };
}
// a Coolify database as a SQL target: its container is named by its uuid; Postgres there trusts its own socket
async function coolifySql(api: Coolify, uuid: string): Promise<SqlTarget | undefined> {
  const d = await api.call('GET', `/databases/${encodeURIComponent(uuid)}`);
  const engine = sqlEngine(engineOf(d?.database_type));
  if (!engine) return undefined;
  const p = engine === 'postgres' ? 'postgres' : engine;
  const password = engine === 'postgres' ? '' : d?.[`${p}_root_password`];
  if (engine !== 'postgres' && typeof password !== 'string') throw new Unit7Error('coolify_permission', 'Coolify didn’t share the database’s password, which replacing names needs (a token with read:sensitive).', 403);
  return { engine, container: uuid, user: engine === 'postgres' ? String(d?.postgres_user ?? 'postgres') : 'root', database: String(d?.[`${p}_db`] ?? d?.[`${p}_database`] ?? 'app'), password: password as string };
}
async function previewColumns(ctx: Ctx, s: ServerRow, t: SqlTarget | undefined): Promise<{ columns?: Column[]; note?: string }> {
  if (!t) return { note: 'Only Postgres and MySQL copies get names replaced.' };
  try { return { columns: piiColumns(await sqlOn(ctx, s, t, columnsSql(t.engine))) }; } catch { return { note: 'The server didn’t answer, so Unit7 finds the columns once the data is copied.' }; }
}

// --- steps, run one gated tool call at a time ---------------------------------------------------------------------
interface Step { tool: string; title: string; input: Record<string, unknown>; keep?: Record<string, string>; name?: string }
// a step's input with what earlier steps made ('$env', '$app:svc_…') filled in
const fill = (input: Record<string, unknown>, made: Record<string, string>) =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('$') ? made[v.slice(1)] : v]));
type Ran = { ok: true; done: { step: string; reused?: boolean }[]; outputs: Record<string, any>[] } | { ok: false; done: { step: string }[]; failed: { step: string; why: string; approvalId?: string }; next: string };
async function runSteps(ctx: Ctx, steps: Step[], made: Record<string, string>, o: { reason: string; gone?: boolean; after?: (st: Step, out: Record<string, any>) => void }): Promise<Ran> {
  const show = threadFor(ctx);
  const done: { step: string }[] = [], outputs: Record<string, any>[] = [];
  for (const [n, st] of steps.entries()) {
    const input = fill(st.input, made);
    const msg = { id: id('step'), role: 'tool' as const, content: { tool: st.tool, title: st.title, input, status: 'running' }, created_at: stamp() };
    show?.(msg);
    ctx.progress(`Step ${n + 1} of ${steps.length}: ${st.title}`);
    const r = await execute(ctx.app, ctx.orgId, ctx.actor, st.tool, input, { reason: o.reason, signal: ctx.signal, conversationId: ctx.conversationId, onProgress: (m) => ctx.progress(m), underApproval: ctx.approvalId });
    const out = r.status === 'ok' ? (r.output ?? {}) as Record<string, any> : undefined;
    const gone = o.gone && r.status === 'error' && r.error.code === 'not_found'; // taking down something already gone is fine
    const why = gone ? undefined : r.status === 'error' ? r.error.message : r.status === 'denied' || r.status === 'approval_required' ? r.why
      : out && st.tool === 'coolify.control' && !/^finished/.test(String(out.status)) ? `The deploy ended as ${out.status}.` : undefined;
    show?.({ ...msg, content: { ...msg.content, ...(r.status === 'ok' ? { status: why ? 'error' : 'ok', output: r.output, durationMs: r.durationMs, ...(why && { error: why }) }
      : r.status === 'approval_required' ? { status: 'approval_required', why: r.why, approvalId: r.approvalId, approvalState: 'pending' }
      : gone ? { status: 'ok', output: { gone: true } } : { status: r.status === 'denied' ? 'denied' : 'error', error: why }) } });
    if (why) {
      return { ok: false, done, failed: { step: st.title, why, ...(r.status === 'approval_required' && { approvalId: r.approvalId }) },
        next: r.status === 'approval_required' ? 'It waits for a person’s approval (the card above, or Approvals). Once it’s approved, run it again: what’s done is reused.'
          : r.status === 'denied' ? 'Unit7’s settings don’t allow this step here. A person can do it, or change how much Unit7 does alone.'
          : 'Fix that, then run it again: what’s done is reused, nothing is made twice.' };
    }
    for (const [as, field] of Object.entries(st.keep ?? {})) if (typeof out?.[field] === 'string') made[as] = out[field];
    if (out) o.after?.(st, out);
    outputs.push(out ?? {});
    done.push({ step: st.title, ...(out?.reused && { reused: true }) });
  }
  return { ok: true, done, outputs };
}
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const card = (title: string, steps: Step[], changes: { label: string; before?: string; after: string }[], confirmLabel: string): Extract<AskSpec, { kind: 'confirm' }> => ({
  kind: 'confirm', title: cut(title, 140), note: `${steps.length} steps. Production only gets a fresh backup, nothing in it changes; live keys stay out unless you chose them.`,
  changes: changes.slice(0, 12).map((c) => ({ label: cut(c.label, 80), ...(c.before && { before: cut(c.before, 200) }), after: cut(c.after, 200) })),
  undo: 'Take the copy down any time (Remove the test copy): its apps, databases and data copy go, production is never touched.', confirmLabel,
});

// --- the choices a person makes on the plan card -------------------------------------------------------------------
const KEY = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/);
const UUID = z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/, 'a Coolify uuid');
// skip (the default) · copy (anyway, not recommended) · a test value: a credential:// reference from the vault, or a plain address
const CHOICE = z.string().max(300).refine((v) => v === 'skip' || v === 'copy' || isRef(v) || /^https?:\/\/[^\s@'"<>]+$/.test(v), 'skip, copy, a credential:// reference (a test key in the vault) or a plain https:// address');
const CHOICES = {
  liveKeys: z.record(KEY, CHOICE).default({}).describe('For each live-looking setting the plan lists: "skip" (default), "copy" (not recommended), or a test value (a credential:// reference, or an https:// address).'),
  copyData: z.boolean().default(true).describe('Copy production’s data into the new staging database (from a fresh backup; never over production).'),
  anonymize: z.boolean().default(true).describe('Replace names, emails and phones in the copy (Postgres and MySQL).'),
};
type Choices = { liveKeys: Record<string, string>; copyData: boolean; anonymize: boolean };
interface Live { key: string; app: string; why: string; choice: string }
// what a live-looking key becomes: copied, set to the test value, or left out
function choose(live: Live[], keys: string[], tests: { key: string; value: string }[], l: Omit<Live, 'choice'>, c: Choices) {
  const choice = c.liveKeys[l.key] ?? 'skip';
  if (!live.some((x) => x.key === l.key)) live.push({ ...l, choice });
  if (choice === 'copy') keys.push(l.key);
  else if (choice !== 'skip' && !tests.some((t) => t.key === l.key)) tests.push({ key: l.key, value: choice });
}

// --- a Unit7 project: a Staging environment with the same apps, fresh databases, settings, data and a deploy ---------
const DB_KINDS = new Set(['postgres', 'mysql', 'mariadb', 'mongo', 'redis']);
const DATA_KINDS = new Set(['postgres', 'mysql', 'mariadb', 'mongo']); // Redis is a cache: a fresh one is right
const NEED_MB: Record<string, number> = { app: 384, worker: 256, postgres: 256, mysql: 384, mariadb: 320, mongo: 384, redis: 64 }; // ponytail: a rule of thumb per kind, not measured
const LABEL: Record<string, string> = { postgres: 'Postgres', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis' };
interface Svc { id: string; name: string; slug: string; kind: string; config: string; server_id: string | null; environment_id: string; current_deployment_id: string | null }
interface Unit7Made { kind: 'unit7'; projectId: string; envId?: string; envMade?: boolean; services: string[]; copied: string[]; urls?: Record<string, string> }
const urlRefOf = (svc: Svc) => json<{ passwordRef?: string }>(svc.config, {}).passwordRef?.replace(/[^/]+$/, 'url');

async function unit7Plan(ctx: Ctx, projectId: string, c: Choices) {
  const project = get<{ name: string }>(ctx.db, 'SELECT name FROM projects WHERE id = ? AND org_id = ?', projectId, ctx.orgId);
  if (!project) throw notFound('That project');
  const envs = all<{ id: string; name: string; kind: string }>(ctx.db, 'SELECT id, name, kind FROM environments WHERE project_id = ? ORDER BY created_at', projectId);
  const prod = envs.find((e) => e.kind === 'production');
  if (!prod) throw new Unit7Error('no_production', `${project.name} has no Production environment to copy.`, 409);
  const target = envs.find((e) => e.kind === 'staging' && /^staging$/i.test(e.name)) ?? envs.find((e) => e.kind === 'staging');
  const svcs = all<Svc>(ctx.db, 'SELECT * FROM services WHERE environment_id = ? AND org_id = ? ORDER BY created_at', prod.id, ctx.orgId)
    .filter((s) => !json<{ previewOf?: string }>(s.config, {}).previewOf);
  if (!svcs.length) throw new Unit7Error('nothing_to_copy', `${project.name}’s Production has nothing in it yet.`, 409);
  const have = target ? all<Svc>(ctx.db, 'SELECT * FROM services WHERE environment_id = ? AND org_id = ?', target.id, ctx.orgId) : [];
  const there = (name: string) => have.find((h) => h.name.toLowerCase() === name.toLowerCase());
  const prev = madeGet<Unit7Made>(ctx, 'staging', projectId);
  const made: Record<string, string> = {}, steps: Step[] = [], skipped: string[] = [];
  const changes: { label: string; before?: string; after: string }[] = [{ label: 'Environment', after: target ? `${target.name}, already there` : 'Staging, new' }];
  if (target) made.env = target.id;
  else steps.push({ tool: 'environment.create', title: 'Make the Staging environment', input: { projectId, name: 'Staging', kind: 'staging' }, keep: { env: 'id' } });

  const apps = svcs.filter((s) => s.kind === 'app' || s.kind === 'worker'), dbs = svcs.filter((s) => DB_KINDS.has(s.kind));
  const deployable: Svc[] = [];
  for (const a of apps) {
    const cfg = json<ServiceConfig>(a.config, {});
    const t = there(a.name);
    if (t) { made[`app:${a.id}`] = t.id; if (!t.current_deployment_id) deployable.push(a); continue; }
    if (!cfg.source || cfg.source.type === 'upload') { skipped.push(`${a.name} deploys from a folder on this computer: add it to Staging and deploy it there yourself.`); continue; }
    steps.push({ tool: 'service.create', title: `Add ${a.name} to Staging`, keep: { [`app:${a.id}`]: 'serviceId' }, input: {
      environmentId: '$env', name: a.name, kind: a.kind, source: cfg.source, ...(cfg.port && { port: cfg.port }), ...(cfg.buildCommand && { buildCommand: cfg.buildCommand }), ...(cfg.startCommand && { startCommand: cfg.startCommand }),
    } });
    deployable.push(a);
  }
  const copied = new Set(prev?.copied ?? []);
  const oneServer = (get<{ n: number }>(ctx.db, `SELECT count(*) n FROM servers WHERE org_id = ? AND status = 'ready'`, ctx.orgId)?.n ?? 0) <= 1;
  const databases: { name: string; engine: string; copy: boolean; anonymize?: Column[]; note?: string }[] = [];
  for (const d of dbs) {
    const t = there(d.name);
    if (t && t.kind === d.kind) { made[`db:${d.id}`] = t.id; const u = urlRefOf(t); if (u) made[`dburl:${d.id}`] = u; }
    else steps.push({ tool: 'database.create', title: `Add a fresh ${LABEL[d.kind]} database ${d.name}`, keep: { [`db:${d.id}`]: 'serviceId', [`dburl:${d.id}`]: 'connectionUrl' }, input: {
      environmentId: '$env', engine: d.kind, name: d.name, ...(json<{ database?: string }>(d.config, {}).database && { database: json<{ database?: string }>(d.config, {}).database }), ...(!oneServer && d.server_id && { serverId: d.server_id }),
    } });
    changes.push({ label: `${LABEL[d.kind]} database`, after: `${d.name}, a new one${t ? ', already there' : ''} (production’s stays as it is)` });
  }

  // settings: a key wired to a production database is pointed at the staging one; live-looking ones wait for a choice
  const dbByAccount = new Map(dbs.flatMap((d) => { const ref = json<{ passwordRef?: string }>(d.config, {}).passwordRef; return ref && isRef(ref) ? [[parseRef(ref).account, d] as const] : []; }));
  const prodHosts = all<{ hostname: string }>(ctx.db, `SELECT d.hostname FROM domains d JOIN services s ON s.id = d.service_id WHERE s.environment_id = ? AND d.hostname NOT LIKE '%.sslip.io' AND d.hostname NOT LIKE '%.nip.io'`, prod.id).map((r) => r.hostname.toLowerCase());
  // Staging already sees the project's and the organisation's settings (and its own, if it's there)
  const ownKeys = new Set(target ? merged(ctx.db, ctx.orgId, { type: 'environment', id: target.id, label: '' }).filter((v) => v.from === 'environment').map((v) => v.key) : []);
  const live: Live[] = [], tests: { key: string; value: string }[] = [], blank: string[] = [], taken = new Set<string>();
  let copiedKeys = 0;
  for (const a of apps) {
    if (!made[`app:${a.id}`] && !steps.some((s) => s.keep?.[`app:${a.id}`])) continue;
    const keys: string[] = [];
    for (const v of merged(ctx.db, ctx.orgId, { type: 'service', id: a.id, label: a.name })) {
      const d = v.ref ? dbByAccount.get(parseRef(v.ref).account) : undefined;
      if (d) {
        const mine = there(a.name) && merged(ctx.db, ctx.orgId, { type: 'service', id: there(a.name)!.id, label: '' }).some((x) => x.key === v.key && x.from === 'service');
        if (!mine) steps.push({ tool: 'env.set', title: `Point ${a.name}’s ${v.key} at the Staging database`, input: { serviceId: `$app:${a.id}`, key: v.key, value: `$dburl:${d.id}` } });
        continue;
      }
      if (ownKeys.has(v.key) || taken.has(v.key)) continue;
      taken.add(v.key);
      const shared = v.from === 'project' || v.from === 'org'; // Staging inherits it unless it gets its own
      const value = v.ref ?? ctx.app.vault.openValue(ctx.orgId, envContext(v), v.ciphertext!, v.wrapped_key!);
      const acc = v.ref ? get<{ provider: string }>(ctx.db, 'SELECT provider FROM accounts WHERE org_id = ? AND provider = ? AND slug = ?', ctx.orgId, parseRef(v.ref).provider, parseRef(v.ref).account) : undefined;
      const why = liveReason(v.key, value, { prodHosts, ...(acc && { account: acc.provider }) });
      if (!why) { if (!shared) keys.push(v.key); continue; }
      const before = tests.length;
      choose(live, shared ? [] : keys, tests, { key: v.key, app: a.name, why: shared ? `${why}, set for the whole project` : why }, c);
      // a live key Staging would inherit, left out: Staging gets its own empty one instead
      if (shared && tests.length === before && (c.liveKeys[v.key] ?? 'skip') === 'skip') blank.push(v.key);
    }
    if (keys.length) { steps.push({ tool: 'env.copy', title: `Copy ${keys.length} setting${keys.length === 1 ? '' : 's'} from ${a.name}`, input: { fromServiceId: a.id, environmentId: '$env', keys } }); copiedKeys += keys.length; }
  }
  for (const t of tests) steps.push({ tool: 'env.set', title: `Use a test value for ${t.key}`, input: { environmentId: '$env', key: t.key, value: t.value } });
  for (const k of blank) steps.push({ tool: 'env.set', title: `Keep the live ${k} out of Staging`, input: { environmentId: '$env', key: k, value: '' } });
  changes.push({ label: 'Settings', after: `${copiedKeys} copied${live.length ? `; ${live.filter((l) => l.choice === 'skip').length} live-looking left out, ${tests.length} given test values` : ''}. Values never show here.` });

  // data: a fresh backup of each production database, restored into its new staging one
  for (const d of dbs.filter((x) => DATA_KINDS.has(x.kind))) {
    const sql = sqlEngine(d.kind);
    let preview: { columns?: Column[]; note?: string } = {};
    if (c.copyData && c.anonymize && sql) {
      try { const u = unit7Sql(ctx, d.id); preview = await previewColumns(ctx, u.s, u.t); } catch { preview = { note: 'Unit7 finds the columns once the data is copied.' }; }
    }
    databases.push({ name: d.name, engine: LABEL[d.kind]!, copy: c.copyData, ...(c.copyData && c.anonymize && { anonymize: preview.columns ?? [] }), ...((preview.note || (c.copyData && c.anonymize && !sql)) && { note: preview.note ?? 'MongoDB copies aren’t scrubbed yet: names stay as they are.' }) });
    if (!c.copyData || copied.has(d.id)) continue;
    steps.push({ tool: 'backup.create', title: `Take a fresh backup of ${d.name}`, input: { serviceId: d.id, reason: 'for the Staging copy' }, keep: { [`bak:${d.id}`]: 'backupId' } });
    steps.push({ tool: 'staging.copy_data', title: `Copy ${d.name}’s data into Staging${c.anonymize && sql ? ' with names, emails and phones replaced' : ''}`, input: { backupId: `$bak:${d.id}`, serviceId: `$db:${d.id}`, anonymize: c.anonymize && !!sql } });
  }
  if (dbs.some((d) => DATA_KINDS.has(d.kind))) changes.push({ label: 'Data', after: c.copyData ? `copied from a fresh backup${c.anonymize ? ', names, emails and phones replaced' : ''}` : 'none (empty databases)' });
  for (const a of deployable) steps.push({ tool: 'deployment.create', title: `Deploy ${a.name} in Staging`, input: { serviceId: `$app:${a.id}` }, name: a.name });
  if (deployable.length) changes.push({ label: 'Address', after: 'a free test address for each app (add a domain any time)' });

  const server = svcs.map((s) => s.server_id).filter((x): x is string => !!x).sort((a, b) => svcs.filter((s) => s.server_id === b).length - svcs.filter((s) => s.server_id === a).length)[0];
  const need = svcs.reduce((n, s) => n + (json<{ memoryMb?: number }>(s.config, {}).memoryMb ?? NEED_MB[s.kind] ?? 256), 0);
  const room = roomFor(ctx, server, need);
  if (room.fits === false) changes.push({ label: 'Room', after: `needs about ${need} MB, ${room.freeMb} MB free: it may not fit` });
  return {
    kind: 'unit7' as const, name: project.name, from: prod.name, to: target?.name ?? 'Staging', steps, made, live, databases, skipped, room,
    card: card(`Make a test copy of ${project.name}`, steps, changes, 'Make the copy'),
    existing: prev ? { at: prev.at, environmentId: prev.envId, urls: prev.urls ?? {} } : null,
  };
}

// --- a Coolify app: a staging environment in the same Coolify project, made with Coolify's own tools -----------------
const TEST_ENV = /^(dev|development|staging|stage|test|testing|preview|qa|sandbox)$/i;
interface CoolifyMade { kind: 'coolify'; serverId: string; app: string; project?: string; copy?: string; databases: { uuid: string; name: string }[]; copied: string[]; url?: string }
async function homeOf(api: Coolify, uuid: string): Promise<Resource> {
  const r = (await tree(api)).projects.flatMap((p) => p.environments.flatMap((e) => e.resources)).find((x) => x.uuid === uuid);
  if (!r) throw notFound('That Coolify app or database');
  return r;
}
async function coolifyPlan(ctx: Ctx, serverId: string, app: string, c: Choices) {
  const s = serverRow(ctx, serverId);
  const { api } = need(ctx, s);
  const t = await tree(api);
  const all_ = t.projects.flatMap((p) => p.environments.flatMap((e) => e.resources));
  const home = all_.find((r) => r.uuid === app && r.kind === 'application');
  if (!home) throw notFound('That Coolify app');
  if (TEST_ENV.test(home.environment)) throw new Unit7Error('already_test', `${home.name} is already in ${home.environment}, a test environment.`, 409);
  const a = await api.call('GET', `/applications/${encodeURIComponent(app)}`);
  const port = Number(String(a?.ports_exposes ?? '').split(',')[0]) || 3000;
  const src = a?.docker_registry_image_name ? { image: `${a.docker_registry_image_name}:${a.docker_registry_image_tag || 'latest'}` }
    : a?.build_pack === 'dockerfile' && typeof a?.dockerfile === 'string' && a.dockerfile.length >= 10 ? { dockerfile: a.dockerfile }
    : a?.git_repository ? { repo: String(a.git_repository), ...(a.git_branch && { branch: String(a.git_branch) }), ...(a.build_pack && ['nixpacks', 'railpack', 'static', 'dockerfile', 'dockercompose'].includes(a.build_pack) && { buildPack: a.build_pack }) } : undefined;
  if (!src) throw new Unit7Error('unsupported', `Unit7 can’t tell where ${home.name}’s code comes from, so it can’t copy it.`, 400);
  const envName = 'staging';
  const there = all_.filter((r) => r.projectUuid === home.projectUuid && r.environment === envName);
  const dbs = all_.filter((r) => r.projectUuid === home.projectUuid && r.environment === home.environment && r.kind === 'database' && engineOf(r.type) in ENGINES);
  const prev = madeGet<CoolifyMade>(ctx, 'staging', `coolify:${s.id}:${app}`);
  const made: Record<string, string> = {}, steps: Step[] = [];
  const where = { serverId: s.id, project: '$project', environment: envName };
  steps.push({ tool: 'coolify.create_project', title: `Add a staging environment to ${home.project}`, input: { serverId: s.id, name: home.project, environment: envName }, keep: { project: 'project' } });
  steps.push({ tool: 'coolify.create_app', title: `Add ${home.name} to staging`, keep: { app: 'uuid' }, input: { ...where, name: home.name, ...src, port } });
  const changes: { label: string; before?: string; after: string }[] = [
    { label: 'Environment', after: `staging in ${home.project}${there.length ? ', already there' : ', new'}` },
    { label: 'App', after: `${home.name}, the same code (${'image' in src ? src.image : 'repo' in src ? src.repo : 'its Dockerfile'})${there.some((r) => r.name === home.name) ? ', already there' : ''}` },
  ];
  const envs = list(await api.call('GET', `/applications/${encodeURIComponent(app)}/envs`)).filter((e) => !e?.is_preview && typeof e?.key === 'string');
  const wired = new Set<string>();
  for (const d of dbs) {
    const e = ENGINES[engineOf(d.type)];
    const wire = envs.some((x) => x.key === e.key) && !wired.has(e.key);
    if (wire) wired.add(e.key);
    steps.push({ tool: 'coolify.create_database', title: `Add a fresh ${e.label} database ${d.name}`, keep: { [`db:${d.uuid}`]: 'uuid' }, input: { ...where, engine: engineOf(d.type), name: d.name, ...(wire && { injectInto: '$app' }) } });
    changes.push({ label: `${e.label} database`, after: `${d.name}, a new one${wire ? `, wired as ${e.key}` : ''}` });
  }
  // settings: values are looked at here only to spot live ones; they go from app to copy inside Unit7, never into a result
  const prodHosts = home.fqdn.filter((h) => !/\.(sslip|nip)\.io$/.test(h));
  const live: Live[] = [], keys: string[] = [], tests: { key: string; value: string }[] = [];
  const sensitive = envs.some((e) => typeof (e.real_value ?? e.value) === 'string');
  for (const e of envs) {
    if (wired.has(e.key) || /^SERVICE_(FQDN|URL)_/.test(e.key)) continue;
    const value = typeof (e.real_value ?? e.value) === 'string' ? String(e.real_value ?? e.value) : '';
    const dbUuid = dbs.find((d) => value.includes(d.uuid));
    const why = dbUuid ? `an address of ${dbUuid.name}, production’s database` : liveReason(e.key, value, { prodHosts });
    if (why) choose(live, keys, tests, { key: e.key, app: home.name, why }, c);
    else keys.push(e.key);
  }
  if (keys.length || tests.length) steps.push({ tool: 'staging.copy_settings', title: `Copy ${keys.length} setting${keys.length === 1 ? '' : 's'} from ${home.name}`, input: { serverId: s.id, from: app, to: '$app', keys, set: Object.fromEntries(tests.map((x) => [x.key, x.value])) } });
  changes.push({ label: 'Settings', after: `${keys.length} copied${live.length ? `; ${live.filter((l) => l.choice === 'skip').length} live-looking left out` : ''}${sensitive ? '' : ' (Coolify didn’t share values, so live keys were spotted by name only)'}. Values never show here.` });
  const databases: { name: string; engine: string; copy: boolean; anonymize?: Column[]; note?: string }[] = [];
  const copied = new Set(prev?.copied ?? []);
  for (const d of dbs) {
    const engine = engineOf(d.type), sql = sqlEngine(engine), e = ENGINES[engine];
    if (!sql && engine !== 'mongodb') continue;
    const target = c.copyData && c.anonymize && sql ? await coolifySql(api, d.uuid).catch(() => undefined) : undefined;
    const preview = c.copyData && c.anonymize && sql ? await previewColumns(ctx, s, target) : {};
    databases.push({ name: d.name, engine: e.label, copy: c.copyData, ...(c.copyData && c.anonymize && sql && { anonymize: preview.columns ?? [] }), ...(preview.note && { note: preview.note }) });
    if (!c.copyData || copied.has(d.uuid)) continue;
    steps.push({ tool: 'coolify.backup', title: `Take a fresh backup of ${d.name}`, input: { serverId: s.id, uuid: d.uuid, op: 'run' }, keep: { [`file:${d.uuid}`]: 'file' } });
    steps.push({ tool: 'staging.copy_data', title: `Copy ${d.name}’s data into staging${c.anonymize && sql ? ' with names, emails and phones replaced' : ''}`, input: { serverId: s.id, fromDb: d.uuid, toDb: `$db:${d.uuid}`, file: `$file:${d.uuid}`, anonymize: c.anonymize && !!sql } });
  }
  if (databases.length) changes.push({ label: 'Data', after: c.copyData ? `copied from a fresh backup${c.anonymize ? ', names, emails and phones replaced' : ''}` : 'none (empty databases)' });
  steps.push({ tool: 'coolify.control', title: `Deploy ${home.name} in staging`, input: { serverId: s.id, uuid: '$app', kind: 'application', action: 'deploy' } });
  changes.push({ label: 'Address', after: 'a free test address from Coolify' });
  const need_ = 384 + dbs.reduce((n, d) => n + (NEED_MB[engineOf(d.type) === 'postgresql' ? 'postgres' : engineOf(d.type) === 'mongodb' ? 'mongo' : engineOf(d.type)] ?? 256), 0);
  const room = roomFor(ctx, s.id, need_);
  if (room.fits === false) changes.push({ label: 'Room', after: `needs about ${need_} MB, ${room.freeMb} MB free: it may not fit` });
  return {
    kind: 'coolify' as const, name: home.name, server: s.name, from: home.environment, to: envName, steps, made, live, databases, skipped: [] as string[], room,
    card: card(`Make a test copy of ${home.name}`, steps, changes, 'Make the copy'),
    existing: prev ? { at: prev.at, url: prev.url } : null,
  };
}

// --- other hosts: what's possible, in words (their own preview and branch deploys) --------------------------------------
const HOSTS: Record<string, { name: string; possible: string[]; unit7?: string }> = {
  vercel: { name: 'Vercel', possible: ['Vercel makes a preview for every branch and pull request: push a staging branch and it gets its own address.', 'Give the preview its own keys in Vercel: Settings → Environment Variables → Preview, with test keys.'] },
  netlify: { name: 'Netlify', possible: ['Turn on branch deploys for a staging branch (Site configuration → Build & deploy → Branches); it gets its own address.', 'Set test keys for that branch’s deploy context in Netlify’s environment variables.'] },
  render: { name: 'Render', possible: ['Render’s preview environments make a copy for each pull request (from a render.yaml Blueprint).', 'Or add a second service that deploys a staging branch, with its own test keys.'] },
  railway: { name: 'Railway', possible: ['Railway has environments: add a staging environment from the project’s environment menu; it copies the services.', 'Give it its own variables and a fresh database there.'] },
  fly: { name: 'Fly.io', unit7: 'A person can have Unit7 make this copy, because Fly.io charges for it.', possible: ['Start a second app from what this one runs: live.put with to: "fly", copyOf: "<app>" and name: "<app>-staging". It takes the image and shape, never the settings or volumes.', 'Give it its own test keys with live.env.'] },
  heroku: { name: 'Heroku', unit7: 'A person can have Unit7 make this copy, because Heroku charges for it.', possible: ['Start a second app from what this one runs: live.put with to: "heroku", copyOf: "<app>" and name: "<app>-staging". It takes the built version, never the settings or add-ons.', 'Give it its own test keys with live.env, and its own add-ons on Heroku.'] },
};

// --- tools --------------------------------------------------------------------------------------------------------
const TARGET = {
  projectId: fid('prj').optional().describe('A Unit7 project: a Staging environment with the same apps.'),
  serverId: fid('srv').optional(), app: UUID.optional().describe('A Coolify app (its uuid, with serverId): a staging environment in its Coolify project.'),
  host: z.enum(Object.keys(HOSTS) as [string, ...string[]]).optional().describe('An app on Vercel, Netlify, Render, Railway, Fly.io or Heroku: says what that host offers.'),
};
const oneTarget = (i: { projectId?: string; serverId?: string; app?: string; host?: string }) => [i.projectId, i.app, i.host].filter(Boolean).length === 1 && (!i.app || !!i.serverId);
const planFor = (ctx: Ctx, i: { projectId?: string; serverId?: string; app?: string } & Choices) => (i.projectId ? unit7Plan(ctx, i.projectId, i) : coolifyPlan(ctx, i.serverId!, i.app!, i));
const keyOf = (i: { projectId?: string; serverId?: string; app?: string }) => i.projectId ?? `coolify:${i.serverId}:${i.app}`;
const showPlan = (p: Awaited<ReturnType<typeof planFor>>) => ({
  kind: p.kind, name: p.name, from: p.from, to: p.to, steps: p.steps.map((x, n) => `${n + 1}. ${x.title}`),
  liveKeys: p.live.map(({ key, app, why, choice }) => ({ key, app, why, choice })), databases: p.databases, skipped: p.skipped, room: p.room, card: p.card, existing: p.existing,
  undo: 'staging.remove takes the copy down (its apps, databases and data copy); production is never touched.',
});

defineTool({
  name: 'staging.plan', title: 'Plan a test copy', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'What “make a test copy of my app” would do, changing nothing: for a Unit7 project (projectId) a Staging environment with the same apps, fresh databases, settings, a copy of production’s data (from a fresh backup, never over production; names, emails and phones replaced in Postgres and MySQL, with the columns listed) and a deploy on a free test address; for a Coolify app (serverId + app) the same through a staging environment in its Coolify project; for Vercel, Netlify, Render, Railway, Fly.io or Heroku (host) what they offer. Lists live-looking settings (sk_live_, rzp_live_, “live” in the name, the live site, a live database) that are left out unless the person chooses, the room needed on the server and how to undo it. Then staging.create with the same target and the person’s choices.',
  input: z.object({ ...TARGET, ...CHOICES }).refine(oneTarget, 'Give one target: projectId, serverId with app, or host.'),
  async run(ctx, i) {
    if (i.host) return { kind: 'host', host: i.host, name: HOSTS[i.host]!.name, possible: HOSTS[i.host]!.possible, steps: [], note: HOSTS[i.host]!.unit7 ?? `Unit7 doesn’t make ${HOSTS[i.host]!.name} copies itself yet; this is what ${HOSTS[i.host]!.name} offers.` };
    const p = await planFor(ctx, i);
    return { ...showPlan(p), confirm: confirmMode(ctx, p.to) };
  },
});

defineTool({
  name: 'staging.create', title: 'Make a test copy', risk: 'read', action: 'read', timeoutMs: 90 * 60_000,
  description: 'Make the test copy staging.plan describes (same target and choices). In Unit7’s ask box it first shows the whole plan as one card and waits for “Make the copy”, unless autonomy is Full autopilot on a test environment; elsewhere show the person staging.plan’s card and pass confirmed once they say yes. Then each step runs as its own Unit7 action (the same approvals and autonomy as calling it alone; this tool changes nothing by itself), shown in the thread, and it stops at the first that doesn’t work, saying what was done and what next. Running it again reuses what’s there.',
  input: z.object({ ...TARGET, ...CHOICES, confirmed: z.boolean().default(false).describe('Only outside the ask box: the person saw the plan and said yes.') }).refine((i) => oneTarget(i) && !i.host, 'Give projectId, or serverId with app.'),
  // "copy a live key anyway", "the person said yes" and "don't replace names" are a person's choices: an AI that sets
  // them asks a person first (the approval card shows exactly which)
  assess: (_c, i) => {
    const copies = Object.entries(i.liveKeys).filter(([, v]) => v === 'copy').map(([k]) => k);
    return copies.length || i.confirmed || !i.anonymize
      ? { tier: 2, discovered: true, impact: [copies.length && `Copies live-looking settings as they are: ${copies.join(', ')}.`, !i.anonymize && 'Copies production data without replacing names, emails and phones.', i.confirmed && 'Says the person already agreed to the plan.'].filter(Boolean).join(' ') }
      : { tier: 0 };
  },
  async run(ctx, i) {
    const p = await planFor(ctx, i);
    const steps = p.steps.map((x, n) => `${n + 1}. ${x.title}`);
    const c = confirmMode(ctx, p.to);
    if (c.mode === 'needs' && !i.confirmed) return { created: false, needsConfirm: true, card: p.card, steps, note: 'Show the person this plan in your own words (and the live keys it leaves out), and call again with confirmed: true once they say yes.' };
    if (c.mode === 'ask') {
      const a = await ask(ctx, p.card);
      if (a.ok !== true) return { created: false, steps, ...(a.ok === false ? { declined: true, note: 'They said not now. Nothing was changed.' } : a) };
    }
    const key = keyOf(i);
    // what each step made is written down as it goes, so a copy that stopped halfway can still be taken down
    const rec: any = madeGet(ctx, 'staging', key) ?? (p.kind === 'unit7' ? { kind: 'unit7', projectId: i.projectId, services: [], copied: [] } : { kind: 'coolify', serverId: i.serverId, app: i.app, databases: [], copied: [] });
    delete rec.at;
    if (p.kind === 'unit7' && p.made.env) rec.envId ??= p.made.env;
    const urls: Record<string, string> = {};
    const r = await runSteps(ctx, p.steps, { ...p.made }, { reason: `test copy of ${p.name}`, after: (st, out) => {
      if (st.tool === 'environment.create' && out.id) Object.assign(rec, { envId: out.id, envMade: true });
      if ((st.tool === 'service.create' || st.tool === 'database.create') && out.serviceId) rec.services = [...new Set([...rec.services, out.serviceId])];
      if (st.tool === 'staging.copy_data' && out.source) rec.copied = [...new Set([...rec.copied, out.source])];
      if (st.tool === 'deployment.create' && out.url) urls[st.name ?? 'app'] = out.url;
      if (st.tool === 'coolify.create_project' && out.project) rec.project = out.project;
      if (st.tool === 'coolify.create_app' && out.uuid) { rec.copy = out.uuid; if (out.domains?.[0]) rec.url = `https://${out.domains[0]}`; }
      if (st.tool === 'coolify.create_database' && out.uuid && !rec.databases.some((d: { uuid: string }) => d.uuid === out.uuid)) rec.databases.push({ uuid: out.uuid, name: out.name });
      madeSet(ctx, 'staging', key, rec);
    } });
    if (Object.keys(urls).length) { rec.urls = { ...rec.urls, ...urls }; madeSet(ctx, 'staging', key, rec); }
    const left = p.live.filter((l) => l.choice === 'skip').map((l) => l.key);
    if (!r.ok) return { created: false, done: r.done, failed: r.failed, next: r.next, ...(left.length && { leftOut: left }) };
    const url = p.kind === 'coolify' ? rec.url : Object.values(rec.urls ?? {})[0];
    ctx.emit('staging.created', `Made a test copy of ${p.name}${url ? ` at ${String(url).replace(/^https?:\/\//, '')}` : ''}`, { severity: 'success' });
    return {
      created: true, name: p.name, done: r.done, ...(url && { url }), ...(p.kind === 'unit7' && { urls: rec.urls ?? {} }), ...(left.length && { leftOut: left, note: 'These live-looking settings weren’t copied: give the copy test keys for them.' }),
      ...(p.skipped.length && { skipped: p.skipped }), undo: 'staging.remove takes it down; production is never touched.',
    };
  },
});

defineTool({
  name: 'staging.remove', title: 'Take a test copy down', risk: 'destructive', action: 'service_delete', peopleOnly: true, timeoutMs: 30 * 60_000,
  description: 'Take down a test copy staging.create made (projectId, or serverId with app): its apps, its databases with their copied data, and the environment if Unit7 made it. Only what the copy made; production is never touched. People only.',
  input: z.object(TARGET).refine((i) => oneTarget(i) && !i.host, 'Give projectId, or serverId with app.'),
  async run(ctx, i) {
    const key = keyOf(i);
    const rec = madeGet<Unit7Made | CoolifyMade>(ctx, 'staging', key);
    if (!rec) throw new Unit7Error('no_copy', 'Unit7 didn’t make a test copy of that, so there’s nothing to take down.', 404);
    const steps: Step[] = [];
    if (rec.kind === 'unit7') {
      const rows = rec.services.map((x) => get<Svc>(ctx.db, 'SELECT * FROM services WHERE id = ? AND org_id = ?', x, ctx.orgId)).filter((x): x is Svc => !!x);
      // never production's, whatever the record says
      const prodEnvs = new Set(all<{ id: string }>(ctx.db, `SELECT id FROM environments WHERE org_id = ? AND kind = 'production'`, ctx.orgId).map((e) => e.id));
      for (const s of [...rows.filter((x) => !DB_KINDS.has(x.kind)), ...rows.filter((x) => DB_KINDS.has(x.kind))]) {
        if (prodEnvs.has(s.environment_id)) throw forbidden(`${s.name} is in production. Unit7 won’t take it down as part of a test copy.`);
        steps.push({ tool: 'service.remove', title: `Remove ${s.name} from Staging${DB_KINDS.has(s.kind) ? ' with its copied data' : ''}`, input: { serviceId: s.id, deleteData: DB_KINDS.has(s.kind) } });
      }
      if (rec.envMade && rec.envId && get(ctx.db, 'SELECT 1 FROM environments WHERE id = ? AND org_id = ?', rec.envId, ctx.orgId)) steps.push({ tool: 'environment.delete', title: 'Remove the Staging environment', input: { environmentId: rec.envId } });
    } else {
      const s = serverRow(ctx, rec.serverId);
      // only what's still there (a removal a person approved since has already happened), and only in a test environment
      const alive = new Map((await tree(need(ctx, s).api)).projects.flatMap((p) => p.environments.flatMap((e) => e.resources)).map((r) => [r.uuid, r]));
      for (const r of [rec.copy, ...rec.databases.map((d) => d.uuid)].map((u) => u && alive.get(u))) {
        if (r && !TEST_ENV.test(r.environment)) throw forbidden(`${r.name} isn’t in a test environment. Unit7 won’t take it down as part of a test copy.`);
      }
      if (rec.copy && alive.has(rec.copy)) steps.push({ tool: 'coolify.remove', title: 'Remove the app’s test copy', input: { serverId: s.id, uuid: rec.copy, kind: 'application' } });
      for (const d of rec.databases.filter((x) => alive.has(x.uuid))) steps.push({ tool: 'coolify.remove', title: `Remove ${d.name} from staging with its copied data`, input: { serverId: s.id, uuid: d.uuid, kind: 'database', deleteVolumes: true, confirmName: d.name } });
    }
    const r = await runSteps(ctx, steps, {}, { reason: 'take the test copy down', gone: true });
    if (!r.ok) return { removed: false, done: r.done, failed: r.failed, next: r.next };
    madeDrop(ctx, 'staging', key);
    ctx.emit('staging.removed', `${ctx.actor.name} took a test copy down`, { severity: 'warning' });
    return { removed: true, done: r.done };
  },
});

// --- the two steps only a test copy needs ------------------------------------------------------------------------------
// Copy a backup into the NEW staging database: never into production, never into the database it came from, never into
// the environment it came from. Then, if asked, replace names, emails and phones in the copy.
export const RESTORE: Record<string, string> = { // also the DR standby's data refresh (src/fleet/dr.ts)
  postgres: 'IFS= read -r P; gunzip -c "$1" | PGPASSWORD="$P" docker exec -i -e PGPASSWORD "$2" psql -X -q -v ON_ERROR_STOP=1 -U "$3" -d "$4" >/dev/null',
  mysql: 'IFS= read -r P; gunzip -c "$1" | MYSQL_PWD="$P" docker exec -i -e MYSQL_PWD "$2" mysql -u "$3" >/dev/null',
  mariadb: 'IFS= read -r P; gunzip -c "$1" | MYSQL_PWD="$P" docker exec -i -e MYSQL_PWD "$2" mariadb -u "$3" >/dev/null',
  mongo: 'IFS= read -r P; gunzip -c "$1" | docker exec -i "$2" mongorestore --archive --gzip --drop >/dev/null',
};
const envKind = (ctx: Ctx, envId: string) => get<{ kind: string; name: string }>(ctx.db, 'SELECT kind, name FROM environments WHERE id = ?', envId);
// a database a test copy made itself (the made table): the only place a copy's data may go
export const madeByCopy = (ctx: Pick<Ctx, 'db' | 'orgId'>, idOrUuid: string) => all<{ data: string }>(ctx.db, `SELECT data FROM made WHERE org_id = ? AND kind = 'staging'`, ctx.orgId)
  .some((r) => { const m = json<{ services?: string[]; databases?: { uuid: string }[] }>(r.data, {}); return (m.services ?? []).includes(idOrUuid) || (m.databases ?? []).some((d) => d.uuid === idOrUuid); });
// the copied data, gone again (a scrub that didn't finish must not leave real names behind): every schema of the copy's
// own database (Postgres), or the database emptied and made again (MySQL). Names are checked before they get here.
export function dropCopySql(t: Pick<SqlTarget, 'engine' | 'database'>) {
  if (t.engine === 'postgres') return `DO $$ DECLARE r record; BEGIN FOR r IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP EXECUTE format('DROP SCHEMA %I CASCADE', r.nspname); END LOOP; END $$;\nCREATE SCHEMA IF NOT EXISTS public;`;
  if (!IDENT.test(t.database)) throw new Unit7Error('invalid_input', `“${t.database}” isn’t a plain database name.`);
  return `DROP DATABASE \`${t.database}\`;\nCREATE DATABASE \`${t.database}\`;`;
}
defineTool({
  name: 'staging.copy_data', title: 'Copy data into a test copy', risk: 'write', action: 'data_copy', timeoutMs: 45 * 60_000,
  description: 'Restore a fresh backup of a production database into the NEW database of its test copy, then (anonymize) replace names, emails and phones there (Postgres and MySQL). Never into production, the database it came from, or its own environment. Unit7: backupId + serviceId (the staging database). Coolify: serverId + fromDb + toDb + file (from coolify.backup op run). staging.create runs this; call it alone only to copy again.',
  input: z.object({ backupId: fid('bak').optional(), serviceId: fid('svc').optional(), serverId: fid('srv').optional(), fromDb: UUID.optional(), toDb: UUID.optional(), file: z.string().regex(/^\/[\w./-]{1,400}$/).optional(), anonymize: z.boolean().default(true) })
    .refine((i) => (!!i.backupId && !!i.serviceId) !== (!!i.serverId && !!i.fromDb && !!i.toDb && !!i.file), 'Give backupId and serviceId (Unit7), or serverId, fromDb, toDb and file (Coolify).'),
  // not replacing names, emails and phones is a person's choice: an AI's request without it always waits for one
  assess: (ctx, i) => ({ tier: 2, ...(!i.anonymize && { discovered: true }), impact: `Copies production data into a new test database${i.anonymize ? ', with names, emails and phones replaced' : ' as it is (names and emails included)'}.` }),
  async run(ctx, i) {
    // names, emails and phones stay replaced unless a person chose otherwise (here, or on the plan they approved)
    if (!i.anonymize && isAgent(ctx) && !ctx.approvalId) throw forbidden('An AI can’t copy production data without replacing names, emails and phones. A person can choose that on the plan.');
    const notMade = () => forbidden('A test copy’s data only goes into a database the test copy made itself (staging.create). This one wasn’t, so nothing was copied.');
    let anonymized: Column[] = [], from: string, into: string, source: string;
    if (i.backupId) {
      const b = get<{ service_id: string | null; location: string; kind: string; status: string; checksum: string | null }>(ctx.db, 'SELECT service_id, location, kind, status, checksum FROM backups WHERE id = ? AND org_id = ?', i.backupId, ctx.orgId);
      if (!b || b.status !== 'done') throw new Unit7Error('bad_backup', 'That backup didn’t finish, so there’s nothing to copy.', 409);
      const t = dbService(ctx, i.serviceId!);
      const there = envKind(ctx, t.svc.environment_id);
      if (!there || there.kind === 'production') throw forbidden(`${t.svc.name} is in production. A test copy’s data only ever goes into a new staging database.`);
      if (b.service_id === t.svc.id) throw forbidden('That backup came from this database. Restoring over a database is backup.restore, not a test copy.');
      const src = b.service_id ? get<{ name: string; environment_id: string }>(ctx.db, 'SELECT name, environment_id FROM services WHERE id = ?', b.service_id) : undefined;
      if (src?.environment_id === t.svc.environment_id) throw forbidden('The copy goes into another environment than the one the data came from.');
      if (!madeByCopy(ctx, t.svc.id)) throw notMade();
      if (t.db.engine !== b.kind || !RESTORE[b.kind]) throw new Unit7Error('wrong_engine', `That is a ${b.kind} backup; ${t.svc.name} is ${t.db.engine}.`, 400);
      // the file is on the copy's server, or its off-server copy is brought there; a damaged file is caught before anything loads
      if ((await ssh(ctx.app).exec(t.s, script('test -s "$1"', b.location))).code !== 0) { const { fetchToServer } = await import('./offsite.ts'); await fetchToServer(ctx, i.backupId, undefined, t.svc.id); }
      const sum = (await ssh(ctx.app).exec(t.s, script('gunzip -t "$1" && sha256sum "$1" | cut -d" " -f1', b.location))).stdout.trim();
      if (!sum || (b.checksum && sum !== b.checksum)) throw new Unit7Error('bad_backup', 'That backup file is damaged or isn’t the one Unit7 made. Nothing was copied.', 409);
      const target = unit7Sql(ctx, t.svc.id);
      ctx.progress(`Copying ${src?.name ?? 'the backup'} into ${t.svc.name}…`);
      await ssh(ctx.app).check(t.s, script(RESTORE[b.kind]!, b.location, safeName(t.db.container, 'container'), target.t?.user ?? 'root', target.t?.database ?? 'app'),
        { what: 'Copying the data', stdin: `${target.t?.password ?? ''}\n`, timeoutMs: 40 * 60_000, signal: ctx.signal });
      if (i.anonymize && target.t) anonymized = await scrub(ctx, t.s, target.t, t.svc.name);
      [from, into, source] = [src?.name ?? 'a backup', t.svc.name, b.service_id ?? i.backupId];
    } else {
      const s = serverRow(ctx, i.serverId!);
      const { api } = need(ctx, s);
      const [a, b] = [await homeOf(api, i.fromDb!), await homeOf(api, i.toDb!)];
      if (a.uuid === b.uuid || b.kind !== 'database') throw forbidden('A test copy’s data goes into its own new database, never back into the one it came from.');
      if (!TEST_ENV.test(b.environment) || b.environment === a.environment) throw forbidden(`${b.name} is in ${b.environment}. A test copy’s data only ever goes into a staging database.`);
      if (!madeByCopy(ctx, b.uuid)) throw notMade();
      ctx.progress(`Copying ${a.name} into ${b.name}…`);
      const r = await api.call('POST', `/databases/${encodeURIComponent(b.uuid)}/imports`, { server_path: i.file, replace_existing: true });
      const activity = r?.activity_id ?? r?.id;
      if (!activity) throw new Unit7Error('coolify_error', 'Coolify started the copy but didn’t say how to follow it.', 502);
      const status = await waitImport(api, b.uuid, String(activity), (m) => ctx.progress(m), ctx.signal);
      if (!/^(finished|success)/.test(status)) throw new Unit7Error('copy_failed', `Coolify’s copy ended as ${status}.`, 502);
      const t = i.anonymize ? await coolifySql(api, b.uuid) : undefined;
      if (t) anonymized = await scrub(ctx, s, t, b.name);
      [from, into, source] = [a.name, b.name, a.uuid];
    }
    ctx.emit('staging.data_copied', `Copied ${from}’s data into ${into}${anonymized.length ? `, ${anonymized.length} columns of names, emails and phones replaced` : ''}`, { severity: 'success' });
    return { copied: into, from, source, anonymized: anonymized.map((c) => `${c.table}.${c.column}`), ...(i.anonymize && !anonymized.length && { note: 'No name, email or phone columns were found to replace.' }) };
  },
});
async function scrub(ctx: Ctx, s: ServerRow, t: SqlTarget, name: string) {
  try {
    const cols = piiColumns(await sqlOn(ctx, s, t, columnsSql(t.engine)));
    if (cols.length) { ctx.progress(`Replacing names, emails and phones in ${cols.length} columns…`); await sqlOn(ctx, s, t, anonymizeSql(t.engine, cols)); }
    return cols;
  } catch (e) {
    // the real names, emails and phones must not stay in the copy: its data goes again
    const dropped = await sqlOn(ctx, s, t, dropCopySql(t)).then(() => true, () => false);
    ctx.emit('staging.scrub_failed', `Replacing names, emails and phones in ${name} didn’t finish, so ${dropped ? 'Unit7 removed the copied data again' : 'Unit7 tried to remove the copied data and couldn’t: take the copy down'}.`, { severity: 'warning' });
    throw new Unit7Error('scrub_failed', `Replacing names, emails and phones in ${name} didn’t finish (${ctx.redactor.redact((e as Error).message).slice(0, 200)}), so ${dropped ? 'Unit7 removed the copied data again. Nothing real is left in the copy.' : 'Unit7 tried to remove the copied data and couldn’t. Take the copy down (Remove the test copy) now.'}`, 502);
  }
}

// A Coolify app's settings into its test copy, values staying inside Unit7 (never in a result): the keys given, plus test
// values for the live-looking ones the person chose to replace.
defineTool({
  name: 'staging.copy_settings', title: 'Copy settings into a test copy', risk: 'write', action: 'env_write', timeoutMs: 120_000,
  description: 'Copy a Coolify app’s settings (keys) into its test copy (to, an app in a staging environment), values never shown; set gives keys a test value instead (a credential:// reference or an https:// address). Needs a token with read:sensitive. staging.create runs this.',
  input: z.object({ serverId: fid('srv'), from: UUID, to: UUID, keys: z.array(KEY).max(300).default([]), set: z.record(KEY, CHOICE).default({}) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const { api } = need(ctx, s);
    const to = await homeOf(api, i.to);
    if (!TEST_ENV.test(to.environment) || i.from === i.to) throw forbidden(`${to.name} is in ${to.environment}. Settings are copied into a test copy only.`);
    const src = list(await api.call('GET', `/applications/${encodeURIComponent(i.from)}/envs`)).filter((e) => !e?.is_preview);
    // the same live-key check as the plan, here too: an AI copies a live-looking setting only once a person said so
    const resources = (await tree(api)).projects.flatMap((p) => p.environments.flatMap((e) => e.resources));
    const home = resources.find((r) => r.uuid === i.from);
    const prodHosts = (home?.fqdn ?? []).filter((h) => !/\.(sslip|nip)\.io$/.test(h));
    const dbs = resources.filter((r) => r.kind === 'database' && (!home || (r.projectUuid === home.projectUuid && r.environment === home.environment)));
    const vars: { key: string; value: string; buildtime?: boolean; runtime?: boolean }[] = [], live: string[] = [];
    for (const key of i.keys) {
      const e = src.find((x) => x.key === key);
      const v = e?.real_value ?? e?.value;
      if (typeof v !== 'string') throw new Unit7Error('coolify_permission', `Coolify didn’t share ${key}’s value (that needs a token with read:sensitive). Copy it in Coolify, or connect a token that can read settings.`, 403);
      ctx.redactor.add(v, `setting ${key}`);
      const why = dbs.some((d) => v.includes(d.uuid)) ? 'an address of production’s database' : liveReason(key, v, { prodHosts });
      if (why) live.push(`${key} (${why})`);
      vars.push({ key, value: v, ...(typeof (e.is_buildtime ?? e.is_build_time) === 'boolean' && { buildtime: e.is_buildtime ?? e.is_build_time }), ...(typeof e.is_runtime === 'boolean' && { runtime: e.is_runtime }) });
    }
    if (live.length && isAgent(ctx) && !ctx.approvalId) throw forbidden(`These look live, so an AI doesn’t copy them into a test copy: ${live.join(', ')}. The person chooses on the plan (staging.create), and nothing was copied.`);
    for (const [key, v] of Object.entries(i.set)) {
      if (v === 'skip' || v === 'copy') continue;
      // a login or full-access key is never opened for a test copy, whoever asks
      if (isRef(v) && peopleRef(ctx.app, ctx.orgId, v)) throw forbidden(`${key}: ${v} is a login or full-access key meant for people, so it isn’t used in a test copy.`);
      if (isRef(v)) checkRef(ctx, { type: 'org', id: ctx.orgId, label: 'organization' }, v);
      vars.push({ key, value: isRef(v) ? ctx.secret(v) : v, runtime: true });
    }
    await setEnvs(api, 'application', i.to, vars);
    ctx.emit('coolify.setting', `Copied ${vars.length} settings into ${to.name}’s test copy on ${s.name}`, { resource: s.id });
    return { copied: i.keys, set: Object.keys(i.set).filter((k) => i.set[k] !== 'skip' && i.set[k] !== 'copy'), next: 'The copy gets them on its next deploy.' };
  },
});
