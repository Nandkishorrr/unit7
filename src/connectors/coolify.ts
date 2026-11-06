// Coolify's API, always called from inside the server it runs on (http://127.0.0.1:<port>/api/v1 over the SSH
// connection Unit7 already has), so Coolify's API never has to be reachable from the internet. The token goes
// to curl on stdin, as a config file: it is never on a command line, in a file, or in a log.
import type { App } from '../app.ts';
import { ssh, type ServerRow } from './ssh.ts';
import { Unit7Error } from '../errors.ts';
import { json } from '../db.ts';
import type { Inventory, Part } from '../discovery/xray.ts';

export const coolifyTiming = { pollMs: 3000, deployMaxMs: 15 * 60_000, statusMaxMs: 3 * 60_000 }; // tests shorten these

// curl's config syntax: "…" with \\ \" \n \r \t escapes
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
export function curlConfig(o: { url: string; method: string; token: string; body?: unknown; maxTime?: number }): string {
  return [
    `url = ${q(o.url)}`, `request = ${q(o.method)}`, `header = ${q(`Authorization: Bearer ${o.token}`)}`, 'header = "Accept: application/json"',
    ...(o.body === undefined ? [] : ['header = "Content-Type: application/json"', `data-binary = ${q(JSON.stringify(o.body))}`]),
    `max-time = ${o.maxTime ?? 30}`, 'silent', 'show-error', `write-out = ${q('\n%{http_code}')}`, '',
  ].join('\n');
}
export const CURL = `command -v curl >/dev/null 2>&1 || { echo "curl isn't installed on the server" >&2; exit 127; }; exec curl -K -`;
// The same call from inside Coolify's own container (it has curl for its healthcheck), where the API sees 127.0.0.1:
// used when Coolify's "Allowed IPs" refuses the host (Docker forwards a host call from the bridge's gateway address)
// or the host has no curl. Remembered per server for as long as Unit7 runs.
export const CURL_IN_COOLIFY = 'docker exec -i coolify curl -K -';
const inCoolify = new Set<string>();
const sudo = (s: ServerRow) => (json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '');
const refusedByAllowList = (stdout: string) => /\n403$/.test(stdout.trimEnd()) && /not allowed to access the API/i.test(stdout);

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export interface Coolify {
  server: ServerRow; port: number;
  call<T = any>(method: Method, path: string, body?: unknown): Promise<T>;
  raw(method: Method, path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

export function coolifyApi(app: App, s: ServerRow, token: string, port = 8000, signal?: AbortSignal): Coolify {
  if (!/^[\x21-\x7e]{8,512}$/.test(token)) throw new Unit7Error('bad_token', 'That doesn’t look like a Coolify API token (it looks like 1|abc…, copied in full).');
  const once = (inside: boolean, method: Method, path: string, body?: unknown) => ssh(app).exec(s, inside ? sudo(s) + CURL_IN_COOLIFY : CURL,
    { stdin: curlConfig({ url: `http://127.0.0.1:${inside ? 8080 : port}/api/v1${path}`, method, token, body }), timeoutMs: 40_000, signal });
  const raw = async (method: Method, path: string, body?: unknown) => {
    let r = await once(inCoolify.has(s.id), method, path, body);
    // refused by the allow-list (before Coolify did anything) or no curl on the host: once more from inside Coolify
    if (!inCoolify.has(s.id) && (r.code === 127 || (r.code === 0 && refusedByAllowList(r.stdout)))) {
      const inside = await once(true, method, path, body);
      if (inside.code === 0) { inCoolify.add(s.id); r = inside; }
    }
    if (r.code === 127) throw new Unit7Error('no_curl', `curl isn't installed on ${s.name}, so Unit7 can't reach Coolify's API from inside it.`, 502);
    if (r.code === 7) throw new Unit7Error('coolify_down', `Coolify's API isn't answering on port ${port} inside ${s.name}. Is Coolify running?`, 502, { retryable: true });
    if (r.code === 28) throw new Unit7Error('timeout', `Coolify's API on ${s.name} took too long to answer.`, 504, { retryable: true });
    if (r.code !== 0) throw new Unit7Error('coolify_unreachable', `Couldn't reach Coolify's API on ${s.name}: ${(r.stderr || r.stdout).trim().slice(-300) || `curl exit ${r.code}`}`, 502);
    const i = r.stdout.lastIndexOf('\n');
    const status = Number(r.stdout.slice(i + 1).trim());
    const text = r.stdout.slice(0, i);
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* plain text, like GET /version */ }
    return { status, body: parsed as any };
  };
  return {
    server: s, port, raw,
    async call(method, path, body) {
      const r = await raw(method, path, body);
      if (r.status >= 200 && r.status < 300) return r.body;
      throw coolifyError(r.status, r.body, s.name);
    },
  };
}

export function coolifyError(status: number, body: any, server: string): Unit7Error {
  const said = String(typeof body === 'string' ? body : body?.message ?? body?.error ?? '').slice(0, 300);
  if (status === 401) return new Unit7Error('coolify_refused', `Coolify on ${server} refused Unit7's token (401: it expired, was revoked, or belongs to another team). Create a new token and connect again.`, 401);
  if (status === 403 && /not allowed to access the API/i.test(said)) return new Unit7Error('coolify_ip_refused', `Coolify on ${server} only lets the addresses in its “Allowed IPs” use the API. Connect automatically adds 127.0.0.1 (only Coolify itself), so Unit7 can call it from inside the server; or add 127.0.0.1 in Coolify: Settings → Advanced.`, 403);
  if (status === 403 && /not allowed to access the API|API is disabled|api.*(disabled|turned off)/i.test(said)) return new Unit7Error('coolify_api_off', `Coolify's API is turned off on ${server}. Turn it on in Coolify: Settings → Advanced → API Access, then Save.`, 403);
  const need = /Missing required permissions?:\s*([\w:,\s]+)/i.exec(said)?.[1]?.trim();
  if (status === 403) return new Unit7Error('coolify_permission', need ? `The Coolify token can't do this: it needs the "${need}" permission. Create a token that has it and connect again.` : `Coolify said no (403): ${said || 'not allowed'}.`, 403, { need });
  if (status === 404) return new Unit7Error('not_found', `Coolify on ${server} doesn't have that (404). It may have been deleted.`, 404);
  if (status === 429) return new Unit7Error('rate_limited', `Coolify on ${server} asked Unit7 to slow down (429). Try again in a minute.`, 429);
  if (status === 409 && /domain/i.test(said)) return new Unit7Error('domain_taken', `That domain is already used by another app in Coolify on ${server}. Pick another name, or take it off that app first.`, 409);
  if (status === 409) return new Unit7Error('coolify_busy', `Coolify is busy with that already (409): ${said}`, 409);
  // 422: { message: 'Validation failed.', errors: { field: ['why'] } } → "git_branch: The git branch field is required."
  const why = body?.errors && typeof body.errors === 'object' ? Object.entries<any>(body.errors).map(([k, v]) => `${k}: ${[v].flat().join(' ')}`).join('; ').slice(0, 300) : '';
  if (status === 400 || status === 422) return new Unit7Error('coolify_rejected', `Coolify rejected the request: ${why || said || JSON.stringify(body).slice(0, 300)}`, 400);
  return new Unit7Error('coolify_error', `Coolify on ${server} had a problem (${status || 'no answer'}): ${said || 'no details'}`, 502, { retryable: status >= 500 });
}

// What the token may do. Coolify has no "who am I" for abilities, so: /version proves read; the Sentinel
// token appearing proves sensitive reads; POST /deploy with nothing to deploy fails on permissions (403)
// before it fails on input, so any other answer proves deploy. None of these change anything.
export async function abilities(api: Coolify): Promise<{ version: string; team?: string; abilities: string[] }> {
  const v = await api.raw('GET', '/version');
  if (v.status !== 200) throw coolifyError(v.status, v.body, api.server.name);
  const version = String(typeof v.body === 'string' ? v.body : v.body?.version ?? '').trim();
  let team: string | undefined;
  for (const path of ['/team', '/teams/current']) {
    const t = await api.raw('GET', path);
    if (t.status === 200) { team = t.body?.name; break; }
  }
  const out = ['read'];
  const servers = await api.raw('GET', '/servers');
  const first = Array.isArray(servers.body) ? servers.body.find((x: any) => x?.uuid) : undefined;
  if (first) {
    const sen = await api.raw('GET', `/servers/${encodeURIComponent(first.uuid)}/sentinel`);
    const tok = sen.body?.sentinel_token ?? sen.body?.token;
    if (sen.status === 200 && typeof tok === 'string' && tok.length > 8 && !/^\*+$|redacted|hidden/i.test(tok)) out.push('read:sensitive');
  }
  // write: a project with no name is refused on its fields (422) only when the token may write; nothing is made
  const w = await api.raw('POST', '/projects', {});
  if (w.status === 422 || w.status === 400) out.push('write');
  const d = await api.raw('POST', '/deploy', {});
  if (d.status !== 403 && d.status !== 401) out.push('deploy');
  return { version, team, abilities: out };
}

// --- reading Coolify's projects ---------------------------------------------------------------------
export type Kind = 'application' | 'database' | 'service';
export const plural = (k: Kind) => `${k}s`;
export interface Resource {
  uuid: string; name: string; kind: Kind; type?: string; status?: string; fqdn: string[]; repo?: string; branch?: string; buildPack?: string;
  project: string; projectUuid: string; environment: string; isPublic?: boolean; publicPort?: number;
  lastDeploy?: { uuid?: string; status?: string; at?: string; commit?: string };
  health?: CoolifyHealth;  // an application's health check, as Coolify has it (Z8: without one Coolify can't swap versions safely)
}
export interface Tree { projects: { uuid: string; name: string; description?: string; environments: { name: string; uuid?: string; resources: Resource[] }[] }[] }

export const hostsOf = (fqdn: unknown) => String(fqdn ?? '').split(/[,\s]+/).map((u) => u.replace(/^https?:\/\//, '').replace(/[:/].*$/, '').toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
export const list = (b: any, key?: string): any[] => (Array.isArray(b) ? b : key && Array.isArray(b?.[key]) ? b[key] : []);
export const lastDeployOf = (d: any) => d && { uuid: d.deployment_uuid, status: d.status, at: d.finished_at ?? d.updated_at ?? d.created_at, commit: d.commit ? String(d.commit).slice(0, 12) : undefined };

// An application's health check in Coolify's own fields. custom: the repo's Dockerfile has its own HEALTHCHECK, which
// Coolify uses instead. Coolify only swaps versions without a gap when it can tell the new one is healthy.
export interface CoolifyHealth { enabled: boolean; path?: string; port?: string; custom?: boolean }
export const healthOf = (r: any): CoolifyHealth => ({ enabled: r.health_check_enabled === true, ...(r.health_check_path && { path: String(r.health_check_path) }),
  ...(r.health_check_port && { port: String(r.health_check_port) }), ...(r.custom_healthcheck_found === true && { custom: true }) });

export async function tree(api: Coolify, o: { deployments?: boolean } = {}): Promise<Tree> {
  const projects = list(await api.call('GET', '/projects'));
  const out: Tree = { projects: [] };
  await Promise.all(projects.filter((p) => p?.uuid).map(async (p) => {
    const detail = await api.call('GET', `/projects/${encodeURIComponent(p.uuid)}`);
    const envs = list(detail?.environments);
    const environments = await Promise.all(envs.map(async (e: any) => {
      const env = await api.call('GET', `/projects/${encodeURIComponent(p.uuid)}/${encodeURIComponent(e.uuid ?? e.name)}`).catch(() => ({}));
      const resources: Resource[] = [];
      for (const [key, items] of Object.entries<any>(env ?? {})) {
        if (!Array.isArray(items)) continue;
        const kind: Kind = key === 'applications' ? 'application' : key === 'services' ? 'service' : 'database';
        for (const r of items) {
          if (!r?.uuid) continue;
          resources.push({
            uuid: r.uuid, name: r.name ?? r.uuid, kind, type: r.database_type ?? r.service_type ?? (kind === 'database' ? key.replace(/s$/, '') : undefined), status: r.status,
            fqdn: [...hostsOf(r.fqdn), ...list(r.applications).flatMap((a: any) => hostsOf(a.fqdn))], repo: r.git_repository, branch: r.git_branch, buildPack: r.build_pack,
            project: p.name, projectUuid: p.uuid, environment: e.name, isPublic: r.is_public, publicPort: r.public_port,
            ...(kind === 'application' && typeof r.health_check_enabled === 'boolean' && { health: healthOf(r) }),
          });
        }
      }
      return { name: e.name, uuid: e.uuid, resources };
    }));
    out.projects.push({ uuid: p.uuid, name: p.name, description: p.description ?? undefined, environments });
  }));
  if (o.deployments) {
    const apps = out.projects.flatMap((p) => p.environments.flatMap((e) => e.resources)).filter((r) => r.kind === 'application');
    await Promise.all(apps.map(async (a) => {
      const d = await api.call('GET', `/deployments/applications/${encodeURIComponent(a.uuid)}?skip=0&take=1`).catch(() => undefined);
      a.lastDeploy = lastDeployOf(list(d, 'deployments')[0]);
    }));
  }
  out.projects.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Coolify's own words for a project, its apps' names, domains, git source and last deploy, laid over what the
// labels said (labels only carry slugs). Containers stay the source of what's running.
export function enrich(inv: Inventory, t: Tree): Inventory {
  const byUuid = new Map(t.projects.flatMap((p) => p.environments.flatMap((e) => e.resources)).map((r) => [r.uuid, r]));
  for (const part of inv.parts) {
    const r = part.coolify && byUuid.get(part.coolify.uuid);
    if (!r) continue;
    part.name = r.name;
    part.coolify = { ...part.coolify!, ...(r.repo && { repo: r.repo }), ...(r.branch && { branch: r.branch }), ...(r.buildPack && { buildPack: r.buildPack }), ...(r.status && { status: r.status }), ...(r.lastDeploy && { lastDeploy: r.lastDeploy }), ...(r.health && { health: r.health }), environment: r.environment };
    if (/exited|unhealthy|degraded/.test(r.status ?? '') && part.health?.status === 'ok') part.health = { status: 'warn', reason: `Coolify says ${r.status!.replace(':', ', ')}` };
    for (const h of r.fqdn) {
      if (inv.parts.some((p) => p.id === `d:${h}`)) continue;
      const d: Part = { id: `d:${h}`, kind: 'domain', name: h, owner: 'coolify', trust: part.trust, via: 'added in Coolify', target: part.id, ...(part.project && { project: part.project }) };
      inv.parts.push(d);
      part.hosts = [...new Set([...(part.hosts ?? []), h])];
      const pr = inv.projects.find((x) => x.id === part.project);
      if (pr) { pr.parts.push(d.id); pr.domains.push(h); } else inv.loose.push(d.id);
    }
  }
  for (const pr of inv.projects.filter((x) => x.owner === 'coolify' && !x.system)) {
    const r = pr.parts.map((id) => inv.parts.find((p) => p.id === id)?.coolify?.uuid).map((u) => u && byUuid.get(u)).find(Boolean);
    if (r) { pr.name = r.project; pr.coolify = { uuid: r.projectUuid }; }
  }
  return inv;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// one look while waiting: a 429 means wait longer and look again, never drop the work being followed
async function look(api: Coolify, path: string) {
  for (let i = 0; ; i++) {
    try { return await api.call('GET', path); } catch (e) {
      if ((e as Unit7Error).code !== 'rate_limited' || i >= 5) throw e;
      await sleep(coolifyTiming.pollMs * 10);
    }
  }
}

// Wait for a deployment to finish: queued → in_progress → finished | failed | cancelled-by-user
export async function waitDeployment(api: Coolify, uuid: string, say: (m: string) => void, signal?: AbortSignal) {
  const until = Date.now() + coolifyTiming.deployMaxMs;
  let last = '';
  for (;;) {
    const d = await look(api, `/deployments/${encodeURIComponent(uuid)}`);
    const status = String(d?.status ?? 'unknown');
    if (status !== last) { say(`Coolify: ${status.replace(/_/g, ' ')}`); last = status; }
    if (/^(finished|failed|cancelled)/.test(status)) return { status, deployment: d };
    if (Date.now() > until || signal?.aborted) return { status: 'still running', deployment: d };
    await new Promise((r) => setTimeout(r, coolifyTiming.pollMs));
  }
}
// Services and databases return no deployment to follow; their status says when they're there
export async function waitStatus(api: Coolify, kind: Kind, uuid: string, want: RegExp, say: (m: string) => void, signal?: AbortSignal) {
  const until = Date.now() + coolifyTiming.statusMaxMs;
  for (;;) {
    const r = await look(api, `/${plural(kind)}/${encodeURIComponent(uuid)}`);
    const status = String(r?.status ?? 'unknown');
    if (want.test(status)) return status;
    if (Date.now() > until || signal?.aborted) return `${status} (still changing)`;
    say(`Coolify: ${status}`);
    await new Promise((res) => setTimeout(res, coolifyTiming.pollMs));
  }
}

// Queued work that leaves a run in a list (a backup run, a scheduled task run): the newest one that wasn't there
// before, followed until it ends. Coolify returns no id for it, so "new" is "not in the list before".
export async function waitRun(api: Coolify, path: string, before: Set<string>, say: (m: string) => void, signal?: AbortSignal) {
  const until = Date.now() + coolifyTiming.statusMaxMs;
  let last = '';
  for (;;) {
    const b = await look(api, path);
    const run = list(b, 'executions').filter((x) => x?.uuid && !before.has(x.uuid)).sort((x, y) => String(y.created_at ?? '').localeCompare(String(x.created_at ?? '')))[0];
    const status = String(run?.status ?? 'queued');
    if (status !== last) { say(`Coolify: ${status.replace(/_/g, ' ')}`); last = status; }
    if (run && /^(success|failed|error|finished|cancel)/.test(status)) return { status, run };
    if (Date.now() > until || signal?.aborted) return { status: `${status} (still running)`, run };
    await sleep(coolifyTiming.pollMs);
  }
}
// a database import (restore): Coolify gives an activity id to follow
export async function waitImport(api: Coolify, db: string, activity: string, say: (m: string) => void, signal?: AbortSignal) {
  const until = Date.now() + coolifyTiming.deployMaxMs;
  let last = '';
  for (;;) {
    const r = await look(api, `/databases/${encodeURIComponent(db)}/imports/${encodeURIComponent(activity)}`);
    const status = String(r?.status ?? 'queued');
    if (status !== last) { say(`Coolify: ${status.replace(/_/g, ' ')}`); last = status; }
    if (/^(finished|success|failed|error)/.test(status)) return status;
    if (Date.now() > until || signal?.aborted) return `${status} (still running)`;
    await sleep(coolifyTiming.pollMs);
  }
}

// --- creating things --------------------------------------------------------------------------------
const enc = encodeURIComponent;
export const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

// Which of Coolify's servers is this one. Unit7 calls the API from inside this server, so it's the one at this
// IP, else Coolify's own "localhost" entry, else the only one.
export async function coolifyServerUuid(api: Coolify, host: string): Promise<string> {
  const all = list(await api.call('GET', '/servers')).filter((x) => x?.uuid);
  const pick = all.find((x) => x.ip === host) ?? all.find((x) => /^(host\.docker\.internal|localhost|127\.0\.0\.1)$/.test(String(x.ip ?? ''))) ?? (all.length === 1 ? all[0] : undefined);
  if (!pick) throw new Unit7Error('pick_server', `Coolify runs things on ${all.length} servers (${all.map((x) => x.name).join(', ') || 'none'}). Say which one with coolifyServer.`, 400);
  return pick.uuid;
}

// What one environment of a project holds, by kind. The environment call doesn't load keydb, dragonfly or clickhouse.
// ponytail: those three aren't found for reuse by name; read /databases too if that ever matters
export async function envResources(api: Coolify, project: string, env: string) {
  const b = await api.call('GET', `/projects/${enc(project)}/${enc(env)}`).catch((e) => { if ((e as Unit7Error).code === 'not_found') return {}; throw e; });
  const out: Record<Kind, any[]> = { application: [], database: [], service: [] };
  for (const [k, v] of Object.entries<any>(b ?? {})) if (Array.isArray(v)) out[k === 'applications' ? 'application' : k === 'services' ? 'service' : 'database'].push(...v.filter((r) => r?.uuid));
  return out;
}
export const byName = (rows: any[], name: string) => rows.find((r) => String(r?.name ?? '').toLowerCase() === name.toLowerCase());

// Coolify's database engines: the credential fields its API takes for each, and the address an app on the same
// server uses (the database's container is named by its uuid on Coolify's network)
export interface Engine { label: string; logo: string; key: string; creds: (pw: string, root: string) => Record<string, string>; url: (host: string, pw: string) => string }
export const ENGINES = {
  postgresql: { label: 'Postgres', logo: 'postgres', key: 'DATABASE_URL', creds: (p) => ({ postgres_user: 'app', postgres_password: p, postgres_db: 'app' }), url: (h, p) => `postgres://app:${p}@${h}:5432/app` },
  mysql: { label: 'MySQL', logo: 'mysql', key: 'DATABASE_URL', creds: (p, r) => ({ mysql_user: 'app', mysql_password: p, mysql_root_password: r, mysql_database: 'app' }), url: (h, p) => `mysql://app:${p}@${h}:3306/app` },
  mariadb: { label: 'MariaDB', logo: 'mariadb', key: 'DATABASE_URL', creds: (p, r) => ({ mariadb_user: 'app', mariadb_password: p, mariadb_root_password: r, mariadb_database: 'app' }), url: (h, p) => `mysql://app:${p}@${h}:3306/app` },
  mongodb: { label: 'MongoDB', logo: 'mongodb', key: 'MONGODB_URI', creds: (p) => ({ mongo_initdb_root_username: 'app', mongo_initdb_root_password: p, mongo_initdb_database: 'app' }), url: (h, p) => `mongodb://app:${p}@${h}:27017/?directConnection=true` },
  redis: { label: 'Redis', logo: 'redis', key: 'REDIS_URL', creds: (p) => ({ redis_password: p }), url: (h, p) => `redis://default:${p}@${h}:6379/0` },
  keydb: { label: 'KeyDB', logo: 'redis', key: 'REDIS_URL', creds: (p) => ({ keydb_password: p }), url: (h, p) => `redis://:${p}@${h}:6379/0` },
  dragonfly: { label: 'Dragonfly', logo: 'redis', key: 'REDIS_URL', creds: (p) => ({ dragonfly_password: p }), url: (h, p) => `redis://:${p}@${h}:6379/0` },
  clickhouse: { label: 'ClickHouse', logo: 'clickhouse', key: 'CLICKHOUSE_URL', creds: (p) => ({ clickhouse_admin_user: 'app', clickhouse_admin_password: p }), url: (h, p) => `http://app:${p}@${h}:8123` },
} satisfies Record<string, Engine>;
export type EngineName = keyof typeof ENGINES;
export const ENGINE_NAMES = Object.keys(ENGINES) as [EngineName, ...EngineName[]];
export const engineOf = (databaseType: unknown) => String(databaseType ?? '').replace(/^standalone-/, '') as EngineName;

// Settings on an app, database or service, upserted by key in one call with Coolify's exact field names.
// Values may be secrets: the caller has already taught its redactor them.
export async function setEnvs(api: Coolify, kind: Kind, uuid: string, vars: { key: string; value: string; buildtime?: boolean; runtime?: boolean }[]) {
  if (!vars.length) return;
  await api.call('PATCH', `/${plural(kind)}/${enc(uuid)}/envs/bulk`, { data: vars.map((v) => ({
    key: v.key, value: v.value, is_preview: false, is_literal: true,
    ...(v.buildtime !== undefined && { is_buildtime: v.buildtime }), ...(v.runtime !== undefined && { is_runtime: v.runtime }),
  })) });
}

// --- Coolify's own code, run on the server -------------------------------------------------------------
// With root on the server Unit7 does what Coolify's dashboard does, by calling the same PHP: a fixed script, piped
// on stdin to `docker exec -i coolify php` (Coolify's own user, inside its container). Its input is base64 JSON
// written into the script, so nothing is ever on a command line, and there's no tinker (no PsySH, no shell quoting).
// It answers with one marker line, so a PHP notice can't break the reading. A token made here only ever comes back
// on that line's stdout. An AI never writes this PHP: these are the only scripts.
export const COOLIFY_PHP = 'docker exec -i coolify php';
const PHP_HEAD = String.raw`<?php
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$in = json_decode(base64_decode('__IN__'), true);
function unit7_out($v) { echo "\n@@unit7:json ", json_encode($v, JSON_UNESCAPED_SLASHES), "\n"; }
function unit7_server($in) {
  $s = App\Models\Server::where('ip', $in['host'] ?? '')->first() ?? App\Models\Server::find(0);
  if (!$s) throw new Exception('Coolify has no server entry for this machine.');
  return $s;
}
function unit7_owner() {
  $team = App\Models\Team::find(0);
  if (!$team) throw new Exception('Coolify has no root team.');
  $user = $team->members()->wherePivot('role', 'owner')->orderBy('users.id')->first() ?? $team->members()->wherePivot('role', 'admin')->orderBy('users.id')->first();
  if (!$user) throw new Exception('Coolify’s root team has no owner or admin to make the key for.');
  return [$team, $user];
}
try {
`;
const PHP_TAIL = String.raw`
} catch (Throwable $e) { echo "\n@@unit7:error ", json_encode($e->getMessage(), JSON_UNESCAPED_SLASHES), "\n"; exit(1); }
`;
export const PHP_OPS = {
  // what Coolify is, and how its API is set (Settings → Advanced)
  state: String.raw`$s = App\Models\InstanceSettings::get();
unit7_out(['version' => config('constants.coolify.version'), 'api' => (bool) $s->is_api_enabled, 'allowed' => $s->allowed_ips]);`,
  // Unit7's own token, made by Coolify's own User::createToken on the root team, its old one revoked first; the API
  // switched on the way POST /api/v1/enable does; 127.0.0.1 added only to a non-empty list that doesn't let it in.
  // Why 127.0.0.1 doesn't open it wider: Coolify trusts X-Forwarded-For from every caller (TrustProxies, $proxies = '*')
  // and its API allow-list checks $request->ip() (ApiAllowed), so anyone reaching port 8000 directly could already claim
  // any address, a listed one included; the list only ever slowed down someone who couldn't guess one, and a valid API
  // token is still needed either way. What makes the list mean something is port 8000 closed to the internet (the
  // xray:coolify-port finding tip says so); Unit7 itself calls the API from inside the server.
  // One transaction: all of it or none.
  connect: String.raw`[$team, $user] = unit7_owner();
$out = Illuminate\Support\Facades\DB::transaction(function () use ($in, $team, $user) {
  $s = App\Models\InstanceSettings::get();
  $before = ['api' => (bool) $s->is_api_enabled, 'allowed' => $s->allowed_ips];
  $old = $user->tokens()->where('team_id', '0')->where(function ($q) use ($in) {
    $q->where('name', $in['name']);
    if (!empty($in['revoke'])) $q->orWhere(function ($q) use ($in) { $q->whereKey($in['revoke'])->where('name', 'like', 'Unit7 (%'); });
  })->get();
  foreach ($old as $t) $t->delete();
  $change = [];
  if (!$s->is_api_enabled) $change['is_api_enabled'] = true;
  $list = array_values(array_filter(array_map('trim', explode(',', (string) $s->allowed_ips))));
  $passes = !$list || in_array('0.0.0.0', $list, true) || (function_exists('checkIPAgainstAllowlist') ? checkIPAgainstAllowlist('127.0.0.1', $list) : in_array('127.0.0.1', $list, true));
  if (!$passes) $change['allowed_ips'] = implode(',', array_merge($list, ['127.0.0.1']));
  if ($change) $s->update($change);
  session(['currentTeam' => $team]);
  $t = $user->createToken($in['name'], $in['abilities'], now()->addDays((int) $in['days']));
  return ['tokenId' => (string) $t->accessToken->getKey(), 'token' => $t->plainTextToken, 'abilities' => array_values((array) $t->accessToken->abilities),
    'expiresAt' => $t->accessToken->expires_at?->toIso8601String(), 'before' => $before, 'after' => ['api' => (bool) $s->is_api_enabled, 'allowed' => $s->allowed_ips],
    'revoked' => $old->pluck('id')->map(fn ($x) => (string) $x)->all()];
});
unit7_out(['version' => config('constants.coolify.version'), 'team' => $team->name] + $out);`,
  // only Unit7's own tokens: by the id it made, or the name it gave
  revoke: String.raw`$m = Laravel\Sanctum\Sanctum::personalAccessTokenModel();
$q = $m::query()->where('name', 'like', 'Unit7 (%')->where(function ($q) use ($in) { $q->whereKey($in['tokenId'] ?? -1); if (!empty($in['name'])) $q->orWhere('name', $in['name']); });
$ids = $q->pluck('id')->map(fn ($x) => (string) $x)->all();
$q->delete();
unit7_out(['revoked' => $ids]);`,
  // the API switch and allow-list put back, unless someone changed them since
  settings: String.raw`$s = App\Models\InstanceSettings::get();
$now = ['api' => (bool) $s->is_api_enabled, 'allowed' => $s->allowed_ips];
if (isset($in['expect']) && $in['expect'] != $now) throw new Exception('Coolify’s API settings changed since Unit7 changed them, so Unit7 left them as they are. Change them in Coolify: Settings → Advanced.');
$s->update(['is_api_enabled' => (bool) $in['api'], 'allowed_ips' => $in['allowed']]);
unit7_out(['api' => (bool) $s->is_api_enabled, 'allowed' => $s->allowed_ips]);`,
  // the proxy's settings as Coolify keeps them (its database is the source; the file on disk follows it)
  proxy_read: String.raw`$server = unit7_server($in);
$conf = $server->proxy->get('last_saved_proxy_configuration');
unit7_out(['version' => config('constants.coolify.version'), 'server' => $server->uuid, 'type' => $server->proxyType(), 'status' => data_get($server->proxy, 'status'),
  'config' => filled($conf) ? base64_encode($conf) : null, 'path' => $server->proxyPath()]);`,
  // saved the way the dashboard's Save does (database and file, with Coolify's own backup), then restarted with the
  // job its Restart Proxy button queues; refused when the settings changed since Unit7 read them
  proxy_save: String.raw`$server = unit7_server($in);
if ($server->proxyType() !== 'TRAEFIK') throw new Exception('Coolify’s proxy on this server isn’t Traefik, so Unit7 changed nothing.');
$cur = (string) $server->proxy->get('last_saved_proxy_configuration');
if (isset($in['expect']) && md5($cur) !== $in['expect']) throw new Exception('Coolify’s proxy settings changed since Unit7 read them, so Unit7 changed nothing.');
$next = base64_decode($in['config'], true);
$yaml = Symfony\Component\Yaml\Yaml::parse($next);
if (!is_array(data_get($yaml, 'services.traefik.command'))) throw new Exception('The new proxy settings didn’t check out, so Unit7 changed nothing.');
App\Actions\Proxy\SaveProxyConfiguration::run($server, $next);
if (!empty($in['restart'])) App\Jobs\RestartProxyJob::dispatch($server);
unit7_out(['saved' => md5($next), 'restarting' => !empty($in['restart'])]);`,
  // only a restart, with the job Coolify's Restart Proxy button queues: nothing in its settings changes
  proxy_restart: String.raw`$server = unit7_server($in);
if ($server->proxyType() !== 'TRAEFIK') throw new Exception('Coolify’s proxy on this server isn’t Traefik, so Unit7 changed nothing.');
App\Jobs\RestartProxyJob::dispatch($server);
unit7_out(['restarting' => true]);`,
  // the dashboard's own address (Settings → General → Instance's domain). Coolify's API has no route for instance
  // settings (4.3, 4.4), so this is its own Settings save: the fqdn saved, then the same proxy setup its Save runs
  // (Settings/Index.php submit(): $settings->save(); Server::find(0)->setupDynamicProxyConfiguration()).
  instance: String.raw`$s = App\Models\InstanceSettings::get();
unit7_out(['fqdn' => $s->fqdn, 'version' => config('constants.coolify.version')]);`,
  // refused when someone changed it since (expect), so an undo never overwrites a newer choice
  instance_fqdn: String.raw`$s = App\Models\InstanceSettings::get();
$before = $s->fqdn;
if (array_key_exists('expect', $in) && (string) $in['expect'] !== (string) $before) throw new Exception('Coolify’s own address changed since Unit7 changed it, so Unit7 left it as it is. Change it in Coolify: Settings → General.');
$url = $in['fqdn'] ?? null;
if ($url !== null && (!filter_var($url, FILTER_VALIDATE_URL) || !preg_match('#^https?://[a-z0-9.-]+$#i', $url))) throw new Exception('That isn’t an address Coolify accepts.');
$s->fqdn = $url;
$s->save();
$server = App\Models\Server::find(0);
if ($server && method_exists($server, 'setupDynamicProxyConfiguration')) $server->setupDynamicProxyConfiguration();
unit7_out(['before' => $before, 'fqdn' => $s->fqdn]);`,
} as const;
export type PhpOp = keyof typeof PHP_OPS;
export const phpScript = (op: PhpOp, input: Record<string, unknown>) =>
  `${PHP_HEAD.replace('__IN__', b64(JSON.stringify(input)))}// unit7:${op}\n${PHP_OPS[op]}${PHP_TAIL}`;
// a token never reaches an error message, whatever went wrong
export const scrubTokens = (t: string) => t.replace(/\b\d+\|[A-Za-z0-9]{20,}/g, '[a token]');

export async function coolifyPhp<T = any>(app: App, s: ServerRow, op: PhpOp, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const r = await ssh(app).exec(s, sudo(s) + COOLIFY_PHP, { stdin: phpScript(op, input), timeoutMs: 90_000, signal });
  const good = /^@@unit7:json (.*)$/m.exec(r.stdout);
  if (good && r.code === 0) return JSON.parse(good[1]!) as T;
  const bad = /^@@unit7:error (.*)$/m.exec(r.stdout);
  if (bad) throw new Unit7Error('coolify_said_no', scrubTokens(String(JSON.parse(bad[1]!))), 409);
  const err = scrubTokens(r.stderr.trim()).slice(-300);
  if (/No such container|is not running/i.test(err)) throw new Unit7Error('no_coolify', `Coolify’s container isn’t running on ${s.name}, so Unit7 couldn’t reach it.`, 409);
  if (r.code === 127 || /docker: (command )?not found/i.test(err)) throw new Unit7Error('no_docker', `Unit7 couldn’t run Docker on ${s.name}${sudo(s) ? ' (it needs sudo without a password)' : ''}.`, 502);
  throw new Unit7Error('coolify_script', `Coolify on ${s.name} didn’t run Unit7’s request: ${err || `exit ${r.code}`}`, 502);
}

// --- Coolify's Traefik settings, edited line by line --------------------------------------------------------
// The docker-compose YAML Coolify keeps for its proxy, changed the way a person would in its Proxy page: only the
// lines that matter, so their own comments and flags stay as they are. Pure functions (tested on their own).
// The access log is set up like Coolify 4.4's own traffic analytics (same file, same rotation sidecar names, so a
// later upgrade takes it over), plus the sign-in headers kept as REDACTED so Unit7 can tell anonymous calls.
export const PROXY_LOG = '/traefik/access.log';
export const ACCESS_LOG_FLAGS = [
  '--accesslog=true', `--accesslog.filepath=${PROXY_LOG}`, '--accesslog.format=json',
  '--accesslog.fields.headers.names.User-Agent=keep', '--accesslog.fields.headers.names.Referer=keep', '--accesslog.fields.headers.names.X-Forwarded-For=keep',
  '--accesslog.fields.headers.names.Cf-Connecting-Ip=keep', '--accesslog.fields.headers.names.Cf-Ipcountry=keep',
  '--accesslog.fields.headers.names.Cookie=redact', '--accesslog.fields.headers.names.Authorization=redact',
];
// copy-and-truncate at 20 MB, 5 gzip copies kept (BusyBox only); Compose would read $ as its own, so $$
const ROTATE = 'log=/traefik/access.log; keep=5; while true; do size=$$(stat -c %s "$$log" 2>/dev/null || echo 0); if [ "$$size" -gt 20971520 ]; then rm -f "$$log.$$keep.gz"; i=$$((keep - 1)); while [ "$$i" -ge 1 ]; do if [ -f "$$log.$$i.gz" ]; then mv -f "$$log.$$i.gz" "$$log.$$((i + 1)).gz"; fi; i=$$((i - 1)); done; if cp "$$log" "$$log.1"; then : > "$$log"; gzip -f "$$log.1"; fi; fi; sleep 60; done';
export const ROTATE_SERVICE = 'traefik-logrotate', ROTATE_CONTAINER = 'coolify-proxy-logrotate';
const LEGACY_LABELS = ['traefik.enable=true', 'traefik.http.routers.traefik.entrypoints=http', 'traefik.http.routers.traefik.service=api@internal', 'traefik.http.services.traefik.loadbalancer.server.port=8080'];

interface Block { start: number; end: number; indent: number }
const indentOf = (l: string) => l.length - l.trimStart().length;
const skip = (l: string) => !l.trim() || l.trim().startsWith('#');
// "- '--x'", '- "x"', '- x # note' → the value
function itemValue(text: string): string {
  const t = text.trim();
  const sq = /^'((?:[^']|'')*)'/.exec(t);
  if (sq) return sq[1]!.replace(/''/g, "'");
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(t);
  if (dq) return dq[1]!.replace(/\\(.)/g, '$1');
  return t.replace(/\s+#.*$/, '');
}
function endOf(lines: string[], start: number, indent: number) {
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (skip(lines[i]!)) continue;
    const ind = indentOf(lines[i]!);
    if (ind < indent || (ind === indent && !lines[i]!.trimStart().startsWith('- '))) break;
    end = i + 1;
  }
  return end;
}
// a key directly inside a block, as a block of its own (undefined when it's missing or written on one line)
function child(lines: string[], parent: Block, key: string): Block | undefined {
  let at = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (skip(lines[i]!)) continue;
    const ind = indentOf(lines[i]!);
    if (at < 0) at = ind;
    if (ind !== at) continue;
    if (new RegExp(`^\\s*['"]?${key.replace(/[.-]/g, '\\$&')}['"]?:\\s*(#.*)?$`).test(lines[i]!)) return { start: i, end: endOf(lines, i, ind), indent: ind };
  }
  return undefined;
}
const itemsOf = (lines: string[], b: Block) => {
  const out: { i: number; value: string; indent: number }[] = [];
  for (let i = b.start + 1; i < b.end; i++) if (/^\s*-\s/.test(lines[i]!)) out.push({ i, value: itemValue(lines[i]!.trimStart().slice(2)), indent: indentOf(lines[i]!) });
  return out;
};
const yq = (v: string) => `'${v.replace(/'/g, "''")}'`;
const isAccessLogFlag = (v: string) => v === '--accesslog' || v.startsWith('--accesslog=') || v.startsWith('--accesslog.');
const unsupported = (what: string) => new Unit7Error('proxy_layout', `Coolify’s proxy settings write ${what} in a way Unit7 doesn’t edit, so it changed nothing. Change it in Coolify: Servers → Proxy.`, 409);

function parseProxy(text: string) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const root: Block = { start: -1, end: lines.length, indent: -1 };
  const services = child(lines, root, 'services');
  const traefik = services && child(lines, services, 'traefik');
  const get = (k: string) => (traefik ? child(lines, traefik, k) : undefined);
  return { lines, services, traefik, command: get('command'), ports: get('ports'), labels: get('labels'), volumes: get('volumes'), rotate: services && child(lines, services, ROTATE_SERVICE) };
}

// what the saved settings say, for the status and the checks
export function proxyFacts(text: string) {
  const p = parseProxy(text);
  const cmd = p.command ? itemsOf(p.lines, p.command).map((x) => x.value) : [];
  const ports = p.ports ? itemsOf(p.lines, p.ports).map((x) => x.value) : [];
  const labels = p.labels ? itemsOf(p.lines, p.labels).map((x) => x.value) : [];
  const flag = (k: string) => cmd.find((c) => c.startsWith(`${k}=`))?.slice(k.length + 1);
  const log = cmd.some(isAccessLogFlag) && flag('--accesslog') !== 'false';
  return {
    traefik: !!p.traefik, command: cmd,
    accessLog: { on: log, file: log ? flag('--accesslog.filepath') : undefined, json: /json/i.test(flag('--accesslog.format') ?? ''), rotated: !!p.rotate },
    dashboard: { insecure: flag('--api.insecure') === 'true', port8080: ports.some((x) => /^(\d+\.\d+\.\d+\.\d+:)?8080:8080(\/tcp)?$/.test(x)), legacyLabels: labels.includes('traefik.http.routers.traefik.service=api@internal') && labels.filter((l) => l.startsWith('traefik.')).every((l) => LEGACY_LABELS.includes(l)) },
    mount: p.volumes ? itemsOf(p.lines, p.volumes).map((x) => x.value).find((v) => /:\/traefik\/?(:rw)?$/.test(v))?.replace(/:\/traefik\/?(:rw)?$/, '') : undefined,
  };
}

export type ProxyOp = 'access_log_on' | 'access_log_off' | 'close_dashboard';
// the settings after one op, and what changed in words (nothing when it's already so)
export function proxyEdit(text: string, op: ProxyOp): { text: string; changed: string[] } {
  const p = parseProxy(text);
  if (!p.traefik || !p.services) throw unsupported('the Traefik service');
  const { lines } = p;
  const changed: string[] = [];
  const drop = new Set<number>(), after = new Map<number, string[]>(), swap = new Map<number, string>();
  if (op === 'access_log_on' || op === 'access_log_off') {
    if (!p.command) throw unsupported('the proxy’s command list');
    const items = itemsOf(lines, p.command);
    const have = items.filter((x) => isAccessLogFlag(x.value));
    const want = op === 'access_log_on' ? ACCESS_LOG_FLAGS : [];
    if (have.length !== want.length || have.some((x, k) => x.value !== want[k])) {
      for (const x of have) drop.add(x.i);
      if (want.length) {
        const last = items.at(-1), ind = ' '.repeat(last?.indent ?? p.command.indent + 2);
        after.set(last?.i ?? p.command.start, want.map((f) => `${ind}- ${yq(f)}`));
      }
      changed.push(op === 'access_log_on' ? 'Traefik writes its access log as JSON to the proxy’s folder, with sign-in headers hidden' : 'Traefik stops writing its access log');
    }
    if (op === 'access_log_on' && !p.rotate) {
      const mount = proxyFacts(text).mount;
      if (!mount) throw unsupported('the proxy’s folder (it isn’t mounted at /traefik)');
      const step = indentOf(lines[p.command.start]!) - p.traefik.indent || 2;
      const a = ' '.repeat(p.traefik.indent), b = ' '.repeat(p.traefik.indent + step), c = ' '.repeat(p.traefik.indent + 2 * step);
      const restart = child(lines, p.traefik, 'restart');
      const sidecar = [`${a}${ROTATE_SERVICE}:`, `${b}container_name: ${ROTATE_CONTAINER}`, `${b}image: 'alpine:3'`, `${b}restart: ${restart ? lines[restart.start]!.split(':').slice(1).join(':').trim() : 'unless-stopped'}`, `${b}network_mode: none`,
        `${b}volumes:`, `${c}- ${yq(`${mount}:/traefik`)}`, `${b}labels:`, `${c}- coolify.managed=true`, `${b}entrypoint:`, `${c}- /bin/sh`, `${c}- '-c'`, `${c}- ${yq(ROTATE)}`];
      after.set(p.services.end - 1, [...(after.get(p.services.end - 1) ?? []), ...sidecar]);
      changed.push('A small helper keeps the log under 20 MB (5 older copies, compressed)');
    }
    if (op === 'access_log_off' && p.rotate && lines.slice(p.rotate.start, p.rotate.end).some((l) => l.includes(ROTATE_CONTAINER))) {
      for (let i = p.rotate.start; i < p.rotate.end; i++) drop.add(i);
      changed.push('The log’s helper is gone (the old log file stays in the proxy’s folder)');
    }
  } else {
    const ins = p.command && itemsOf(lines, p.command).find((x) => x.value === '--api.insecure=true');
    if (ins) { swap.set(ins.i, lines[ins.i]!.replace('--api.insecure=true', '--api.insecure=false')); changed.push('Traefik’s dashboard isn’t served without a password any more'); }
    const port = p.ports && itemsOf(lines, p.ports).filter((x) => /^(\d+\.\d+\.\d+\.\d+:)?8080:8080(\/tcp)?$/.test(x.value));
    if (port?.length) { for (const x of port) drop.add(x.i); changed.push('Port 8080 isn’t open to the internet any more'); }
    if (p.labels && proxyFacts(text).dashboard.legacyLabels) {
      for (const x of itemsOf(lines, p.labels)) {
        if (x.value === 'traefik.enable=true') swap.set(x.i, lines[x.i]!.replace('traefik.enable=true', 'traefik.enable=false'));
        else if (LEGACY_LABELS.includes(x.value)) drop.add(x.i);
      }
      changed.push('The dashboard’s route on port 80 is gone (Coolify 4.4 removes it the same way)');
    }
  }
  if (!changed.length) return { text, changed };
  const out: string[] = [];
  lines.forEach((l, i) => { if (!drop.has(i)) out.push(swap.get(i) ?? l); out.push(...(after.get(i) ?? [])); });
  return { text: out.join('\n'), changed };
}
