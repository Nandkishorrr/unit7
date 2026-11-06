// Zero-downtime releases: the parts of a deploy that come after "the new version is healthy".
//  - readiness: find the app's own health page, warm its busiest pages, learn how long it takes to start
//  - drain: after traffic moves, let the old version finish its open requests before it stops
//  - proof: count the requests that failed while traffic moved, from the proxy's own log
//  - watch: for a few minutes after the switch, compare errors and speed with the old version's usual,
//    and roll back by itself (as Warden, through the gate) when it's clearly worse
//  - steps: the release as one timeline (Build → … → Done), kept in the deployment's plan for the UI
// The decisions are pure functions (tested with fake numbers); the rest is a few SSH commands.
import type { App } from '../app.ts';
import { execute, type Actor } from '../tools/runtime.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { get, json, run } from '../db.ts';
import { parseHit, pathOnly, SCANNER, type Hit } from '../sentinel/traffic.ts';
import { proxyFor } from './caddy.ts';

// --- settings (service config `release`), all optional: the defaults are the safe ones --------------------------
export interface ReleaseSettings { drainSeconds?: number; watchMinutes?: number; autoRollback?: boolean; mustContain?: string; workerGraceSeconds?: number; websockets?: boolean }
export const DEFAULTS = { drainSeconds: 30, wsDrainSeconds: 120, watchMinutes: 5, autoRollback: true, workerGraceSeconds: 60, stopGraceSeconds: 30 } as const;
export const drainLimit = (r: ReleaseSettings | undefined, websockets: boolean) => r?.drainSeconds ?? (websockets || r?.websockets ? DEFAULTS.wsDrainSeconds : DEFAULTS.drainSeconds);
export const watchMinutes = (r: ReleaseSettings | undefined) => r?.watchMinutes ?? DEFAULTS.watchMinutes;

// Unit7's own requests through the proxy during a switch, so the proof has something to count even when nobody visits
export const PROBE_UA = 'unit7-switch-check';

// --- the release timeline ----------------------------------------------------------------------------------------
export const STEP_KEYS = ['build', 'test', 'database', 'start', 'check', 'switch', 'drain', 'watch', 'done'] as const;
export type StepKey = typeof STEP_KEYS[number];
export interface Step { key: StepKey; state: 'active' | 'done' | 'failed' | 'skipped'; at: string; ms?: number; note?: string; line: number }

// Records the steps as the deploy moves through them. `save` writes them into the deployment's plan (and tells the UI).
export function stepper(save: (steps: Step[]) => void, line: () => number, now = () => Date.now()) {
  const steps: Step[] = [];
  const close = (state: Step['state'] = 'done', note?: string) => {
    const cur = steps.at(-1);
    if (cur?.state !== 'active') return;
    cur.state = state; cur.ms = now() - Date.parse(cur.at);
    if (note) cur.note = note;
  };
  const at = () => new Date(now()).toISOString();
  return {
    steps,
    current: () => steps.at(-1)?.state === 'active' ? steps.at(-1)!.key : undefined,
    go(key: StepKey, note?: string) { close(); steps.push({ key, state: 'active', at: at(), line: line(), ...(note && { note }) }); save(steps); },
    note(text: string) { const cur = steps.at(-1); if (cur?.state === 'active') { cur.note = text; save(steps); } },
    skip(key: StepKey, note: string) { close(); steps.push({ key, state: 'skipped', at: at(), ms: 0, line: line(), note }); save(steps); },
    done(note?: string, state: 'done' | 'skipped' = 'done') { close(state, note); save(steps); },
    fail(note: string) { close('failed', note); save(steps); },
  };
}

// --- drain ---------------------------------------------------------------------------------------------------------
// /proc/net/tcp(6) of the old container: connections to the app's port that are still open (state 01, ESTABLISHED).
// null when nothing could be read (then nobody knows, and Unit7 says so).
export function openConnections(text: string, port: number): number | null {
  if (/UNREADABLE/.test(text)) return null;
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  let n = 0;
  for (const l of text.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length < 4 || !/^\d+:$/.test(f[0]!)) continue;
    if (f[1]!.split(':').pop()!.toUpperCase() === hex && f[3] === '01') n++;
  }
  return n;
}

export interface Drained { ms: number; open: number | null; why: 'empty' | 'limit' | 'unknown' }
// Wait until the old version has no open connections, or the limit passes. When they can't be counted, wait a
// short while (settle) instead of the whole limit, and say so.
export async function drainWait(count: () => Promise<number | null>, o: { limitMs: number; everyMs?: number; settleMs?: number; onCount?: (n: number, ms: number) => void; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<Drained> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  for (;;) {
    const open = await count().catch(() => null);
    const ms = now() - t0;
    if (open === 0) return { ms, open, why: 'empty' };
    if (open === null) { await sleep(Math.max(0, Math.min(o.settleMs ?? 10_000, o.limitMs - ms))); return { ms: now() - t0, open, why: 'unknown' }; }
    o.onCount?.(open, ms);
    if (ms >= o.limitMs) return { ms, open, why: 'limit' };
    await sleep(Math.min(o.everyMs ?? 1000, o.limitMs - ms));
  }
}

// how many connections each old copy still has open, read from the host (works for images without a shell),
// else from inside the container
const COUNT = `P=$1; shift; for c in "$@"; do
  pid=$(docker inspect -f '{{.State.Pid}}' "$c" 2>/dev/null) || continue
  [ "\${pid:-0}" -gt 0 ] 2>/dev/null || continue
  if cat "/proc/$pid/net/tcp" 2>/dev/null; then cat "/proc/$pid/net/tcp6" 2>/dev/null
  else docker exec "$c" cat /proc/net/tcp 2>/dev/null || echo UNREADABLE; fi
done; true`;
export async function countOpen(app: App, s: ServerRow, containers: string[], port: number): Promise<number | null> {
  const r = await ssh(app).exec(s, script(COUNT, port, ...containers), { timeoutMs: 20_000 });
  return r.code === 0 ? openConnections(r.stdout, port) : null;
}

// --- readiness -----------------------------------------------------------------------------------------------------
export const HEALTH_PATHS = ['/health', '/healthz', '/api/health', '/up'];
// how long to wait for a new version to answer: three times its slowest start so far, never under 90 s or over 5 min
export const healthWaitMs = (pastStartMs: number[]) => (pastStartMs.length ? Math.min(300_000, Math.max(90_000, Math.round(Math.max(...pastStartMs) * 3))) : 90_000);
export const okCode = (path: string, code: number) => (path === '/' ? code > 0 && code < 500 : code >= 200 && code < 400);

// the pages worth opening before visitors arrive: the busiest pages people asked for (GET, answered fine, not files,
// not scanners), then what the server's traffic checks saw, then "/"
const FILES = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|txt|xml|json)$/i;
export function warmPaths(hits: Hit[], fallback: string[] = [], n = 5): string[] {
  const count = new Map<string, number>();
  for (const h of hits) {
    if (h.method !== 'GET' || h.status >= 400 || h.ua === PROBE_UA || SCANNER.test(h.path)) continue;
    const p = pathOnly(h.path);
    if (FILES.test(p)) continue;
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  const top = [...count].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const out = [...new Set([...top, ...fallback.filter((p) => !p.includes(':id') && !FILES.test(p))])]
    .filter((p) => p.startsWith('/') && p.length <= 200 && !/[\s"'\\`$]/.test(p)).slice(0, n);
  return out.length ? out : ['/'];
}

// GET each path on a container from inside the private network: [{ path, code, ms }]
export async function requestPaths(app: App, s: ServerRow, base: string, paths: string[]): Promise<{ path: string; code: number; ms: number }[]> {
  const r = await ssh(app).exec(s, script(`docker run --rm --network unit7 --entrypoint sh curlimages/curl:latest -c 'b=$1; shift; for p in "$@"; do r=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 15 "$b$p" 2>/dev/null) || r="000 0"; echo "$r $p"; done' x "$@"`, base, ...paths), { timeoutMs: 20_000 + paths.length * 16_000 });
  return r.stdout.split('\n').map((l) => /^(\d{3}) ([\d.]+) (\S+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ path: m[3]!, code: Number(m[1]), ms: Math.round(Number(m[2]) * 1000) }));
}

// --- what the proxy saw -------------------------------------------------------------------------------------------
export interface Rates { requests: number; errors: number; failed: number; p95?: number; downtimeSeconds: number; websockets: boolean }
// errors: any 5xx. failed: the proxy couldn't get an answer (502/503/504): what visitors see as "down".
// Downtime is the number of seconds in which at least one request failed.
export function rates(hits: Hit[], o: { from?: number; to?: number; probes?: boolean } = {}): Rates {
  let requests = 0, errors = 0, failed = 0, websockets = false;
  const ms: number[] = [], down = new Set<number>();
  for (const h of hits) {
    if (o.from !== undefined && h.at < o.from) continue;
    if (o.to !== undefined && h.at > o.to) continue;
    if (h.status === 101) websockets = true;
    if (!o.probes && h.ua === PROBE_UA) continue;
    requests++;
    if (h.status >= 500) errors++;
    if (h.status >= 502 && h.status <= 504) { failed++; down.add(Math.floor(h.at / 1000)); }
    if (typeof h.ms === 'number' && h.status !== 101) ms.push(h.ms);
  }
  ms.sort((a, b) => a - b);
  return { requests, errors, failed, downtimeSeconds: down.size, websockets, ...(ms.length && { p95: Math.round(ms[Math.floor(ms.length * 0.95)] ?? ms.at(-1)!) }) };
}

// Unit7's own Caddy log lines for these hostnames since a moment (docker's --since: "30m" or a unix time), and the
// server's clock. null when the log can't be read (another proxy, Caddy missing, SSH trouble): then it's "not measured".
const READ_LOG = `S=$1; shift
docker inspect unit7-caddy >/dev/null 2>&1 || { echo @@nolog; exit 0; }
P=$(mktemp) || { echo @@nolog; exit 0; }
for h in "$@"; do printf '"host":"%s"\\n' "$h"; done > "$P"
echo "@@now $(date +%s.%N)"
docker logs --since "$S" unit7-caddy 2>&1 | grep -F '"handled request"' | grep -F -f "$P" | tail -n 20000
rm -f "$P"; true`;
export async function readSiteLog(app: App, s: ServerRow, hosts: string[], since: string): Promise<{ hits: Hit[]; now: number } | null> {
  if (proxyFor(s).kind !== 'caddy' || !hosts.length) return null;
  const r = await ssh(app).exec(s, script(READ_LOG, since, ...hosts), { timeoutMs: 45_000 }).catch(() => null);
  if (!r || r.code !== 0 || r.stdout.includes('@@nolog')) return null;
  const wanted = new Set(hosts.map((h) => h.toLowerCase()));
  const hits: Hit[] = [];
  let now = NaN;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@@now ')) { now = parseFloat(line.slice(6)) * 1000; continue; }
    const h = parseHit(line);
    if (h && (!h.host || wanted.has(h.host))) hits.push(h);
  }
  return { hits, now: Number.isFinite(now) ? now : Date.now() };
}

// a light, steady request through the proxy while traffic moves (4 a second, Unit7's own), so the proof counts real
// answers even when nobody visits. Returns the server's clock at the start.
export async function startSwitchCheck(app: App, s: ServerRow, name: string, host: string, tls: string, path: string): Promise<number | undefined> {
  const port = tls === 'off' ? 80 : 443;
  const url = `${tls === 'off' ? 'http' : 'https'}://${host}${path}`;
  const r = await ssh(app).exec(s, script(`docker rm -f "$1" >/dev/null 2>&1; docker run -d --rm --name "$1" --network unit7 --entrypoint sh curlimages/curl:latest -c 'while :; do curl -sk -o /dev/null --max-time 5 -A ${PROBE_UA} --connect-to "$1:$2:unit7-caddy:$2" "$3" >/dev/null 2>&1; sleep 0.25; done' x "$2" "$3" "$4" >/dev/null 2>&1; echo "@@now $(date +%s.%N)"`, name, host, port, url), { timeoutMs: 60_000 }).catch(() => null);
  const t = r && parseFloat(/@@now (\S+)/.exec(r.stdout)?.[1] ?? '');
  return t ? t * 1000 : undefined;
}
export const stopSwitchCheck = (app: App, s: ServerRow, name: string) => ssh(app).exec(s, script('docker rm -f "$1" >/dev/null 2>&1; true', name)).catch(() => undefined);

export interface Proof { measured: boolean; why?: string; requests?: number; failed?: number; downtimeSeconds?: number }
export function proofOf(hits: Hit[] | null, from: number, to: number, why = 'The proxy’s log couldn’t be read, so this switch wasn’t measured.'): Proof {
  if (!hits) return { measured: false, why };
  const r = rates(hits, { from: from - 1000, to: to + 1000, probes: true });
  return { measured: true, requests: r.requests, failed: r.failed, downtimeSeconds: r.downtimeSeconds };
}

// --- the watch window ------------------------------------------------------------------------------------------------
export interface Verdict { act: 'rollback' | 'ok' | 'wait'; reason?: string }
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`; // 6%, 7.5%, 0.3%
const msWords = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
// Clearly worse means: the health check fails 3 times in a row, or, over at least `minRequests` requests, the error
// rate is above max(2%, 3 × usual) or the slowest pages (p95) are 3 × slower than usual and a second more.
export function watchVerdict(base: Pick<Rates, 'requests' | 'errors' | 'p95'> | undefined, cur: Pick<Rates, 'requests' | 'errors' | 'p95'>, o: { healthFails: number; done: boolean; minRequests?: number }): Verdict {
  if (o.healthFails >= 3) return { act: 'rollback', reason: 'it stopped answering its health check' };
  const min = o.minRequests ?? 30;
  if (cur.requests >= min) {
    const rate = cur.errors / cur.requests;
    const known = !!base && base.requests >= min;
    const usual = known ? base!.errors / base!.requests : 0;
    if (rate > Math.max(0.02, 3 * usual)) return { act: 'rollback', reason: `errors jumped to ${pct(rate)}${known ? ` (usually ${pct(usual)})` : ''}` };
    if (known && base!.p95 && cur.p95 && cur.p95 > Math.max(3 * base!.p95, base!.p95 + 1000)) return { act: 'rollback', reason: `pages got slow: ${msWords(cur.p95)} instead of the usual ${msWords(base!.p95)}` };
  }
  return { act: o.done ? 'ok' : 'wait' };
}

const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
export interface Watch {
  orgId: string; projectId?: string; serviceId: string; name: string; deploymentId: string; number: number; previousId: string; serverId: string;
  hosts: string[]; container: string; port: number; healthPath: string; base?: Rates; since: number; until: number;
  autoRollback: boolean; migrated: boolean; healthFails: number; timer?: NodeJS.Timeout;
}
const watches = new Map<string, Watch>(); // by service: one watch per app, the newest deploy's
export const TICK_MS = 20_000;
export const watching = (serviceId: string) => watches.get(serviceId);

const savePlan = (app: App, deploymentId: string, patch: object) => run(app.db, 'UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?', JSON.stringify(patch), deploymentId);
// the timeline's last steps, once the watch ends (it runs after the deploy has returned)
function endSteps(app: App, w: Watch, state: 'done' | 'failed', note: string) {
  const steps = json<{ steps?: Step[] }>(get<{ plan: string }>(app.db, 'SELECT plan FROM deployments WHERE id = ?', w.deploymentId)?.plan, {}).steps ?? [];
  const cur = steps.find((x) => x.key === 'watch');
  if (cur) { cur.state = state; cur.ms = Date.now() - Date.parse(cur.at); cur.note = note; }
  if (state === 'done' && !steps.some((x) => x.key === 'done')) steps.push({ key: 'done', state: 'done', at: new Date().toISOString(), ms: 0, line: cur?.line ?? 0 });
  run(app.db, `UPDATE deployments SET plan = json_set(plan, '$.steps', json(?)) WHERE id = ?`, JSON.stringify(steps), w.deploymentId);
  app.events.emit(w.orgId, 'deployment.step', note, { live: true, projectId: w.projectId, resource: w.serviceId, data: { deploymentId: w.deploymentId, serviceId: w.serviceId, steps } });
}

export function startWatch(app: App, w: Omit<Watch, 'healthFails' | 'timer'>, tickMs = TICK_MS) {
  stopWatch(app, w.serviceId, 'a newer deploy started');
  const full: Watch = { ...w, healthFails: 0 };
  watches.set(w.serviceId, full);
  const minutes = Math.round((w.until - Date.now()) / 60_000);
  savePlan(app, w.deploymentId, { watch: { status: 'watching', until: new Date(w.until).toISOString(), minutes, autoRollback: w.autoRollback && !w.migrated, ...(w.base && { base: pick(w.base) }) } });
  app.events.emit(w.orgId, 'deployment.watch_started', `Watching ${w.name} for ${minutes} min after deploy #${w.number}`, { projectId: w.projectId, resource: w.serviceId, data: { deploymentId: w.deploymentId, serviceId: w.serviceId, minutes } });
  const loop = () => {
    full.timer = setTimeout(() => {
      if (watches.get(w.serviceId) !== full) return;
      void watchTick(app, full).then((v) => { if (v.act === 'wait' && watches.get(w.serviceId) === full) loop(); }).catch(() => { if (watches.get(w.serviceId) === full) loop(); });
    }, tickMs);
    full.timer.unref?.();
  };
  loop();
  return full;
}

// "Looks good, stop watching", or a newer deploy/rollback: the watch ends where it is
export function stopWatch(app: App, serviceId: string, why: string): boolean {
  const w = watches.get(serviceId);
  if (!w) return false;
  clearTimeout(w.timer);
  watches.delete(serviceId);
  savePlan(app, w.deploymentId, { watch: { status: 'stopped', reason: why } });
  endSteps(app, w, 'done', `Stopped watching: ${why}`);
  return true;
}

const pick = (r: Rates) => ({ requests: r.requests, errors: r.errors, ...(r.p95 !== undefined && { p95: r.p95 }) });

// One look at the new version: its traffic since the switch (from the proxy log) and its health check.
export async function watchTick(app: App, w: Watch, now = Date.now()): Promise<Verdict> {
  const s = get<ServerRow>(app.db, 'SELECT * FROM servers WHERE id = ?', w.serverId);
  if (!s) { watches.delete(w.serviceId); return { act: 'ok' }; }
  const log = await readSiteLog(app, s, w.hosts, String(Math.floor(w.since / 1000)));
  const cur = log ? rates(log.hits, { from: w.since }) : { requests: 0, errors: 0, failed: 0, downtimeSeconds: 0, websockets: false };
  const probe = await requestPaths(app, s, `http://${w.container}:${w.port}`, [w.healthPath]).catch(() => []);
  w.healthFails = probe[0] && okCode(w.healthPath, probe[0].code) ? 0 : w.healthFails + 1;
  const v = watchVerdict(w.base, cur, { healthFails: w.healthFails, done: now >= w.until });
  if (watches.get(w.serviceId) !== w) return { act: 'ok' }; // stopped while it looked
  savePlan(app, w.deploymentId, { watch: { now: pick(cur), healthFails: w.healthFails } });
  if (v.act === 'wait') return v;
  watches.delete(w.serviceId);
  if (v.act === 'ok') {
    savePlan(app, w.deploymentId, { watch: { status: 'ok' } });
    endSteps(app, w, 'done', cur.requests ? `No change in errors or speed over ${cur.requests} requests` : 'It kept answering its health check');
    app.events.emit(w.orgId, 'deployment.watch_ok', `${w.name} deploy #${w.number} looks good after the watch`, { severity: 'success', projectId: w.projectId, resource: w.serviceId, data: { deploymentId: w.deploymentId, serviceId: w.serviceId } });
    return v;
  }
  // clearly worse: roll back through the gate as Warden, unless a person turned that off or the deploy changed the
  // database (older code against a newer schema can corrupt data: the same rule Warden keeps)
  const reason = `${v.reason} after the deploy`;
  if (!w.autoRollback || w.migrated) {
    savePlan(app, w.deploymentId, { watch: { status: 'bad', reason } });
    endSteps(app, w, 'failed', `${cap(reason)}. ${w.migrated ? 'Not rolled back by itself: this deploy changed the database.' : 'Rolling back by itself is off.'}`);
    app.events.emit(w.orgId, 'deployment.watch_bad', `${w.name}: ${reason}. ${w.migrated ? 'Unit7 didn’t roll back by itself because this deploy changed the database; roll back from the app page if the old version still works with it.' : 'Rolling back by itself is off for this app.'}`, { severity: 'warning', projectId: w.projectId, resource: w.serviceId, data: { deploymentId: w.deploymentId, serviceId: w.serviceId } });
    return v;
  }
  const r = await execute(app, w.orgId, WARDEN, 'deployment.rollback', { serviceId: w.serviceId, deploymentId: w.previousId }, { reason: `Warden: ${reason} (deploy #${w.number})` })
    .catch((e) => ({ status: 'error' as const, error: { code: 'internal', message: String((e as Error)?.message ?? e) } }));
  if (r.status === 'ok') {
    savePlan(app, w.deploymentId, { watch: { status: 'rolled_back', reason } });
    endSteps(app, w, 'failed', `Rolled back by itself: ${reason}`);
    app.events.emit(w.orgId, 'deployment.rolled_back', `Rolled back ${w.name}: ${reason}`, { severity: 'warning', projectId: w.projectId, resource: w.serviceId, data: { deploymentId: w.deploymentId, serviceId: w.serviceId, reason } });
  } else {
    const why = r.status === 'approval_required' ? 'the roll back is waiting for your OK' : r.status === 'error' ? `the roll back didn’t work: ${r.error.message}` : 'the roll back wasn’t allowed';
    savePlan(app, w.deploymentId, { watch: { status: 'bad', reason: `${reason}; ${why}` } });
    endSteps(app, w, 'failed', `${cap(reason)}; ${why}`);
    app.events.emit(w.orgId, 'deployment.watch_bad', `${w.name}: ${reason}, and ${why}.`, { severity: 'warning', projectId: w.projectId, resource: w.serviceId, data: { deploymentId: w.deploymentId, serviceId: w.serviceId } });
  }
  return v;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
