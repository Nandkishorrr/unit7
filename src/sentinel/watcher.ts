// The watch, run from Warden's minute sweep: a usage sample every few minutes per server (then the jumps it
// shows), the traffic and log check every 30 or 60 minutes, the findings after it, and a weekly digest. What's
// unusual is kept as an open alert until it clears; a new one is said once (one message per server, at most
// every 15 minutes), and a serious one gets an automatic, read-only look by the AI when one is set up.
import type { App } from '../app.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { cmd } from '../connectors/shell.ts';
import { execute, type Actor } from '../tools/runtime.ts';
import { lastXray } from '../tools/xray.ts';
import { sections, type Inventory } from '../discovery/xray.ts';
import { serverFindings } from '../discovery/findings.ts';
import { sample, readPoints, prune, lastSampleAt, type Row } from './usage.ts';
import { detect, fmtBytes, type Anomaly, type Series } from './anomaly.ts';
import { TRAFFIC_PROBE, readProbe, trafficFindings, accessLogFinding, type Summary, type WatchFinding } from './traffic.ts';
import { settingsOf, saveSettings, due, digestDue, investigateDue, type WatchSettings } from './schedule.ts';
import { redact } from '../redact.ts';
import { withoutArchived } from '../archive.ts';
import { alertKey, snoozeState, stillHidden } from '../snooze.ts';

const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
const HOUR = 3600_000, DAY = 86400_000;
const logged = (what: string) => (e: unknown) => { console.error(`watch ${what}:`, redact(String((e as Error)?.stack ?? e))); };
const asRoot = (s: ServerRow) => (json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '');

// --- alerts: open while the condition holds, said once --------------------------------------------------------
export type Source = 'usage' | 'traffic' | 'finding';
export interface Item { key: string; severity: string; title: string; data?: { quiet?: boolean } & Record<string, unknown> | object }
export interface AlertRow { id: string; server_id: string; source: Source; key: string; severity: string; title: string; data: string; first_at: string; last_at: string; cleared_at: string | null; alerted_at: string | null; incident_id: string | null; conversation_id: string | null }
const SEV = ['critical', 'high', 'warning', 'medium', 'low', 'info'];
export const worse = (a: string, b: string) => (SEV.indexOf(a) <= SEV.indexOf(b) ? a : b);

// open, update and clear one source's alerts for a server; returns what's new and what cleared
export function track(app: App, orgId: string, serverId: string, source: Source, items: Item[], at = now()) {
  const open = all<AlertRow>(app.db, 'SELECT * FROM watch_alerts WHERE server_id = ? AND source = ? AND cleared_at IS NULL', serverId, source);
  const fresh: AlertRow[] = [], cleared: AlertRow[] = [];
  for (const it of items) {
    const row = open.find((r) => r.key === it.key);
    if (row) { run(app.db, 'UPDATE watch_alerts SET last_at = ?, severity = ?, title = ?, data = ? WHERE id = ?', at, it.severity, it.title, JSON.stringify(it.data ?? {}), row.id); continue; }
    const r: AlertRow = { id: id('wal'), server_id: serverId, source, key: it.key, severity: it.severity, title: it.title, data: JSON.stringify(it.data ?? {}), first_at: at, last_at: at, cleared_at: null, alerted_at: null, incident_id: null, conversation_id: null };
    run(app.db, 'INSERT INTO watch_alerts (id, org_id, server_id, source, key, severity, title, data, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', r.id, orgId, serverId, source, r.key, r.severity, r.title, r.data, at, at);
    fresh.push(r);
  }
  for (const r of open) if (!items.some((it) => it.key === r.key)) { run(app.db, 'UPDATE watch_alerts SET cleared_at = ? WHERE id = ?', at, r.id); cleared.push(r); }
  run(app.db, 'DELETE FROM watch_alerts WHERE server_id = ? AND cleared_at IS NOT NULL AND cleared_at < ?', serverId, new Date(Date.parse(at) - 30 * DAY).toISOString());
  return { fresh, cleared };
}

// a risk or traffic alert that's gone: Activity says so (usage ones say "back to normal", watch.cleared)
function saidCleared(app: App, s: Pick<ServerRow, 'id' | 'name' | 'org_id'>, rows: AlertRow[]) {
  for (const r of rows) app.events.emit(s.org_id, 'alert.cleared', `Cleared on ${s.name}: ${r.title.replace(/\.$/, '')}`, { severity: 'success', resource: s.id, data: { key: r.key, source: r.source, serverId: s.id } });
}
const TYPE: Record<Source, string> = { usage: 'watch.anomaly', traffic: 'watch.traffic', finding: 'watch.finding' };
// everything not yet said for this server and source, in one message, at most every 15 minutes
export function announce(app: App, orgId: string, s: Pick<ServerRow, 'id' | 'name'>, source: Source, at = Date.now()) {
  // what a person said is fine (or hid for now) never buzzes the phone while it's hidden and no worse than when they hid
  // it; it stays unsaid (not marked), so it's said normally once the time is up
  const hidden = snoozeState(app.db, orgId, at).hidden;
  const all_ = all<AlertRow>(app.db, 'SELECT * FROM watch_alerts WHERE server_id = ? AND source = ? AND cleared_at IS NULL AND alerted_at IS NULL ORDER BY first_at', s.id, source);
  const pending = all_.filter((p) => !stillHidden(hidden.get(alertKey(p)), p.severity) && !json<{ quiet?: boolean }>(p.data, {}).quiet);
  if (!pending.length) return undefined;
  const last = get<{ at: string | null }>(app.db, 'SELECT max(alerted_at) at FROM watch_alerts WHERE server_id = ? AND source = ?', s.id, source)?.at;
  if (last && at - Date.parse(last) < 15 * 60_000) return undefined;
  const sev = pending.map((p) => p.severity).reduce(worse);
  const titles = pending.map((p) => p.title);
  const message = `${s.name}: ${titles.slice(0, 3).join(' ')}${titles.length > 3 ? ` And ${titles.length - 3} more.` : ''}`;
  run(app.db, `UPDATE watch_alerts SET alerted_at = ? WHERE id IN (${pending.map(() => '?').join(',')})`, new Date(at).toISOString(), ...pending.map((p) => p.id));
  app.events.emit(orgId, TYPE[source], message, { severity: sev === 'critical' ? 'critical' : 'warning', resource: s.id, data: { serverId: s.id, alerts: pending.map((p) => ({ id: p.id, key: p.key, severity: p.severity, title: p.title })) } });
  return message;
}

// --- automatic investigation: read-only, through the same path Warden's incidents take --------------------------
export async function investigate(app: App, orgId: string, s: Pick<ServerRow, 'id' | 'name'>, rows: AlertRow[], settings: WatchSettings) {
  const hidden = snoozeState(app.db, orgId).hidden; // nobody looks into what a person said is fine (unless it got worse)
  const serious = rows.filter((r) => (r.severity === 'critical' || (r.source !== 'usage' && r.severity === 'high')) && !stillHidden(hidden.get(alertKey(r)), r.severity));
  if (!serious.length || !settings.investigate) return;
  const last = get<{ at: string | null }>(app.db, 'SELECT max(first_at) at FROM watch_alerts WHERE server_id = ? AND incident_id IS NOT NULL', s.id)?.at ?? undefined;
  if (!investigateDue(last)) return;
  // a brain must be there to take it (Unit7's own model, or your AI through the inbox); never a person's subscription
  const { agentStatus } = await import('../agent/brain.ts');
  const { anyWatcher } = await import('../agent/bridge.ts');
  if (!(await agentStatus(app, orgId)).ready && !anyWatcher(app, orgId)) return;
  const { escalate, untrusted } = await import('../agent/escalate.ts');
  const incidentId = id('inc');
  const title = serious[0]!.title.replace(/\.$/, '');
  run(app.db, `INSERT INTO incidents (id, org_id, project_id, environment_id, title, status, severity, trigger_event) VALUES (?, ?, NULL, NULL, ?, 'open', 'warning', ?)`, incidentId, orgId, `${title} on ${s.name}`.slice(0, 200), TYPE[serious[0]!.source]);
  const evidence = serious.map((r) => { const d = json<{ evidence?: string; reason?: string; forecast?: string }>(r.data, {}); return `- ${r.title}${d.forecast ? ` ${d.forecast}` : ''}${d.evidence ? `\n  ${d.evidence}` : ''}`; }).join('\n');
  const r = await escalate(app, orgId, `Look into ${s.name}: ${title}`.slice(0, 80),
    `Unit7's watch noticed something unusual on the server ${s.name} (${s.id}) at ${serious[0]!.first_at}. Investigate it read-only: what changed recently (deploys, restarts, the X-ray), memory and out-of-memory kills, the disk, and the logs around that time. Don't change anything. Reply with a short diagnosis in plain words: what happened, the likely cause, and the fix you'd suggest; the person decides.\n\n${untrusted('the server watch', evidence)}`);
  run(app.db, `UPDATE watch_alerts SET incident_id = ?, conversation_id = ? WHERE id IN (${serious.map(() => '?').join(',')})`, incidentId, r.conversationId, ...serious.map((x) => x.id));
  run(app.db, `UPDATE incidents SET report = ? WHERE id = ?`, r.via === 'unit7' ? `See conversation ${r.conversationId}` : `Handed to your AI (conversation ${r.conversationId})`, incidentId);
  app.events.emit(orgId, 'incident.opened', `Unit7 is looking into ${s.name}: ${title}`, { severity: 'warning', resource: incidentId, data: { incidentId, conversationId: r.conversationId, serverId: s.id } });
}

// --- usage: sample, then look for jumps -------------------------------------------------------------------------
async function inventory(app: App, s: ServerRow): Promise<Inventory | undefined> {
  const last = lastXray(app.db, s.org_id, s.id);
  if (last && Date.now() - Date.parse(last.at) < HOUR) return last.data;
  const r = await execute(app, s.org_id, WARDEN, 'server.xray', { serverId: s.id }, { reason: 'Warden: keeping the usage history per project' }).catch(() => undefined);
  // auto-connect is a change (it connects test copies by itself, at Full autopilot only): below that it would only ask
  const level = get<{ autonomy: number }>(app.db, 'SELECT autonomy FROM orgs WHERE id = ?', s.org_id)?.autonomy ?? 3;
  if (r?.status === 'ok' && level >= 4) await execute(app, s.org_id, WARDEN, 'serverapp.autoconnect', { serverId: s.id }, { reason: 'Warden: connect apps found on the server' }).catch(() => undefined);
  return r?.status === 'ok' ? r.output as Inventory : last?.data;
}

export function seriesFor(app: App, serverId: string, scopes: { scope: string; name: string }[], nowMs = Date.now()): Series[] {
  const recent = readPoints(app.db, serverId, '5m', nowMs - 12 * HOUR);
  // normal comes from before the last two hours, so what's happening now can't make itself look normal
  const hourly = readPoints(app.db, serverId, '1h', nowMs - 30 * DAY);
  const daily = readPoints(app.db, serverId, '1d', nowMs - 60 * DAY, 'server');
  return scopes.map(({ scope, name }) => ({ scope, name, recent: recent.get(scope)?.points ?? [], hourly: (hourly.get(scope)?.points ?? []).filter((p) => Date.parse(p.at) < nowMs - 2 * HOUR), ...(scope === 'server' && { daily: daily.get('server')?.points ?? [] }) }));
}

// one story per thing: a leak says more than "memory is high" for the same project, and a project's restart
// loop more than "apps on this server restarted"
export function anomaliesOf(series: Series[], host: { memTotal?: number; diskTotal?: number; memUsed?: number }, nowMs = Date.now()): Anomaly[] {
  const all_ = series.flatMap((s) => detect(s, host, nowMs));
  return all_.filter((a) => !(a.kind === 'high' && a.metric === 'mem' && all_.some((b) => b.kind === 'leak' && b.scope === a.scope))
    && !(a.kind === 'restarts' && a.scope === 'server' && all_.some((b) => b.kind === 'restarts' && b.scope !== 'server')));
}
// "crm’s memory", "the server’s CPU", "ledger’s restarts", "the disk"
const WORD: Record<string, string> = { cpu: 'CPU', mem: 'memory', net: 'network traffic', restarts: 'restarts', disk: 'disk' };
export const subjectOf = (a: Partial<Anomaly>) => (a.metric === 'disk' ? 'The disk' : `${!a.scope || a.scope === 'server' ? 'The server' : a.name}’s ${WORD[a.metric ?? ''] ?? 'usage'}`);
const asItem = (a: Anomaly): Item => ({ key: a.key, severity: a.severity, title: a.forecast ? `${a.reason} ${a.forecast}` : a.reason, data: a });

export async function sampleServer(app: App, s: ServerRow) {
  const inv = await inventory(app, s);
  const { rows, host } = await sample(app, s, inv);
  const settings = settingsOf(app.db, s.org_id);
  // archived projects (asset.archive) get no usage alerts
  const kept = inv && withoutArchived(app.db, s.org_id, s.id, inv), off = new Set(inv && kept ? inv.projects.filter((p) => !kept.projects.some((k) => k.id === p.id)).map((p) => p.id) : []);
  const series = seriesFor(app, s.id, rows.filter((r: Row) => (!r.system || r.scope === 'server') && !off.has(r.scope)));
  const found = anomaliesOf(series, { memTotal: host.memTotal, diskTotal: host.diskTotal, memUsed: host.memUsed });
  const { fresh, cleared } = track(app, s.org_id, s.id, 'usage', found.map(asItem));
  for (const c of cleared) app.events.emit(s.org_id, 'watch.cleared', `${s.name}: ${subjectOf(json<Anomaly>(c.data, {} as Anomaly))} ${c.key.includes(':restarts:') ? 'have settled down' : 'is back to normal'}.`, { severity: 'success', resource: s.id });
  announce(app, s.org_id, s, 'usage');
  if (fresh.some((r) => !json<{ quiet?: boolean }>(r.data, {}).quiet)) {
    // something jumped: read the logs now rather than at the next half hour (unless they were just read)
    const lastCheck = get<{ at: string | null }>(app.db, 'SELECT max(at) at FROM traffic_windows WHERE server_id = ?', s.id)?.at ?? undefined;
    if ((settings.traffic || settings.logs) && due(lastCheck, 10)) await trafficServer(app, s, settings).catch(logged('traffic'));
    await investigate(app, s.org_id, s, fresh, settings).catch(logged('investigate'));
  }
  return { rows, anomalies: found };
}

// --- traffic and logs, then the findings --------------------------------------------------------------------------
// one check per server at a time: a second caller (the schedule, a jump, a person asking) shares the running one
const inFlight = new Map<string, ReturnType<typeof checkTraffic>>();
export function trafficServer(app: App, s: ServerRow, settings = settingsOf(app.db, s.org_id)) {
  const running = inFlight.get(s.id);
  if (running) return running;
  const p = checkTraffic(app, s, settings).finally(() => inFlight.delete(s.id));
  inFlight.set(s.id, p);
  return p;
}
async function checkTraffic(app: App, s: ServerRow, settings: WatchSettings) {
  const minutes = settings.every;
  const r = await ssh(app).exec(s, `${asRoot(s)}${cmd('sh', '-s', '--', String(minutes))}`, { stdin: TRAFFIC_PROBE, timeoutMs: 120_000, maxBytes: 48 * 1024 * 1024 });
  if (!r.stdout.includes('@@unit7:proxies')) throw new Error(`No traffic check from ${s.name}: ${r.stderr.trim().slice(-200) || `exit ${r.code}`}`);
  const { summary, traefik, hits } = readProbe(sections(r.stdout), { minutes, self: [s.host] });
  // Traefik names a router, not a host: the X-ray knows which Coolify app (and domain) each router is
  const inv = lastXray(app.db, s.org_id, s.id)?.data;
  summary.hosts = summary.hosts.map((h) => { const uuid = /^https?-\d+-([\w-]+)@/.exec(h.host)?.[1]; const p = uuid && inv?.parts.find((x) => x.coolify?.uuid === uuid); return p ? { ...h, host: p.hosts?.[0] ?? p.name } : h; });
  const past = all<{ summary: string }>(app.db, 'SELECT summary FROM traffic_windows WHERE server_id = ? AND at > ? ORDER BY at', s.id, new Date(Date.now() - 30 * DAY).toISOString()).map((w) => json<Summary>(w.summary, {} as Summary)).filter((w) => w.at);
  const ctx = { serverId: s.id, serverName: s.name };
  let found = trafficFindings(summary, past, ctx).filter((f) => (f.id.startsWith('logs:') ? settings.logs : settings.traffic));
  const note = accessLogFinding(ctx, traefik);
  if (note) found = [...found, note];
  run(app.db, 'INSERT INTO traffic_windows (id, org_id, server_id, at, minutes, summary, findings) VALUES (?, ?, ?, ?, ?, ?, ?)', id('twn'), s.org_id, s.id, summary.at, minutes, JSON.stringify(summary), JSON.stringify(found));
  run(app.db, 'DELETE FROM traffic_windows WHERE server_id = ? AND at < ?', s.id, new Date(Date.now() - 35 * DAY).toISOString());
  await import('../inspect/index.ts').then((m) => m.inspectWindow(app, s, hits, minutes)).catch(logged('call inspector'));
  const { fresh, cleared } = track(app, s.org_id, s.id, 'traffic', found.filter((f) => ['critical', 'high', 'medium'].includes(f.severity)).map((f) => ({ key: f.id, severity: f.severity, title: f.title.endsWith('.') ? f.title : `${f.title}.`, data: f })));
  saidCleared(app, s, cleared);
  announce(app, s.org_id, s, 'traffic');
  const risks = settings.findings ? findingsServer(app, s) : [];
  await investigate(app, s.org_id, s, [...fresh, ...risks], settings).catch(logged('investigate'));
  return { summary, findings: found };
}

// risks worth a message: new critical or high ones
export function findingsServer(app: App, s: Pick<ServerRow, 'id' | 'name' | 'org_id'>): AlertRow[] {
  const all_: WatchFinding[] = serverFindings(app.db, s.org_id, s);
  const { fresh, cleared } = track(app, s.org_id, s.id, 'finding', all_.filter((f) => f.bucket === 'risk' && (f.severity === 'critical' || f.severity === 'high') && !f.id.startsWith('traffic:') && !f.id.startsWith('logs:'))
    .map((f) => ({ key: f.id, severity: f.severity, title: f.title.endsWith('.') ? f.title : `${f.title}.`, data: f })));
  saidCleared(app, s, cleared);
  announce(app, s.org_id, s, 'finding');
  return fresh;
}

// --- the weekly digest --------------------------------------------------------------------------------------------
export interface DigestServer { name: string; requests: number; topHost?: { host: string; n: number }; problems: number; open: number; oom: { name: string; n: number }[]; restarts: number; disk?: number; updates?: number }
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
export function digestText(servers: DigestServer[]): string {
  if (!servers.length) return 'A quiet week: no servers to report on.';
  return servers.map((s) => {
    const bits = [
      s.requests ? `${k(s.requests)} requests${s.topHost ? ` (${s.topHost.host} ${k(s.topHost.n)})` : ''}` : '',
      s.problems ? `${s.problems} unusual thing${s.problems === 1 ? '' : 's'} spotted${s.open ? `, ${s.open} still open` : ', all cleared'}` : 'nothing unusual',
      ...s.oom.slice(0, 2).map((o) => `${o.name} ran out of memory ${o.n === 1 ? 'once' : o.n === 2 ? 'twice' : `${o.n} times`}`),
      s.disk !== undefined && Math.abs(s.disk) >= 50e6 ? `disk ${s.disk > 0 ? '+' : '−'}${fmtBytes(Math.abs(s.disk))}` : '',
      s.updates ? `${s.updates} security update${s.updates === 1 ? '' : 's'} waiting` : '',
    ].filter(Boolean);
    return `${s.name}: ${bits.join(', ')}.`;
  }).join(' ');
}
export function digestStats(app: App, orgId: string, nowMs = Date.now()): DigestServer[] {
  const since = new Date(nowMs - 7 * DAY).toISOString();
  return all<ServerRow>(app.db, `SELECT * FROM servers WHERE org_id = ? AND status NOT IN ('new', 'bootstrapping') ORDER BY name`, orgId).map((s) => {
    const windows = all<{ summary: string }>(app.db, 'SELECT summary FROM traffic_windows WHERE server_id = ? AND at >= ?', s.id, since).map((w) => json<Summary>(w.summary, {} as Summary));
    const hosts = new Map<string, number>();
    for (const w of windows) for (const h of w.hosts ?? []) hosts.set(h.host, (hosts.get(h.host) ?? 0) + h.n);
    const topHost = [...hosts].sort((a, b) => b[1] - a[1])[0];
    const alerts = all<{ cleared_at: string | null }>(app.db, `SELECT cleared_at FROM watch_alerts WHERE server_id = ? AND source != 'finding' AND first_at >= ?`, s.id, since);
    const hourly = readPoints(app.db, s.id, '1h', nowMs - 7 * DAY);
    const oom = [...hourly].filter(([scope]) => scope !== 'server').map(([, v]) => ({ name: v.name, n: v.points.reduce((a, p) => a + p.oom, 0) })).filter((o) => o.n > 0).sort((a, b) => b.n - a.n);
    const disk = (readPoints(app.db, s.id, '1d', nowMs - 8 * DAY, 'server').get('server')?.points ?? []).filter((p) => p.disk != null);
    const report = get<{ findings: string }>(app.db, 'SELECT findings FROM security_reports WHERE org_id = ? ORDER BY created_at DESC LIMIT 1', orgId);
    const upd = json<{ id: string; title: string }[]>(report?.findings, []).find((f) => f.id === `server:updates:${s.id}`);
    return { name: s.name, requests: windows.reduce((a, w) => a + (w.requests ?? 0), 0), ...(topHost && { topHost: { host: topHost[0], n: topHost[1] } }),
      problems: alerts.length, open: alerts.filter((a) => !a.cleared_at).length, oom, restarts: (hourly.get('server')?.points ?? []).reduce((a, p) => a + p.restarts, 0),
      ...(disk.length >= 2 && { disk: disk.at(-1)!.disk! - disk[0]!.disk! }), ...(upd && { updates: Number(/^(\d+)/.exec(upd.title)?.[1]) || 1 }) };
  });
}
export function weeklyDigest(app: App, orgId: string, nowMs = Date.now()) {
  const servers = digestStats(app, orgId, nowMs);
  const text = digestText(servers);
  saveSettings(app.db, orgId, { lastDigest: new Date(nowMs).toISOString() });
  app.events.emit(orgId, 'watch.digest', `This week: ${text}`, { severity: 'info', data: { servers } });
  return text;
}

// --- the minute tick (Warden's sweep calls this) --------------------------------------------------------------------
const lastRun = new Map<string, number>(); // `${kind}:${serverId}` -> when it last ran here
let ticks = 0;
export function tick(app: App, busy: Set<string>) {
  ticks++;
  const servers = all<ServerRow>(app.db, `SELECT * FROM servers WHERE status = 'ready' AND ssh_block IS NULL`);
  const settings = new Map<string, WatchSettings>();
  const of = (orgId: string) => settings.get(orgId) ?? settings.set(orgId, settingsOf(app.db, orgId)).get(orgId)!;
  for (const s of servers) {
    const w = of(s.org_id);
    const go = (kind: string, every: number, last: () => string | undefined, fn: () => Promise<unknown>) => {
      const key = `${kind}:${s.id}`;
      if (busy.has(key) || !due(lastRun.get(key) ?? last(), every)) return;
      busy.add(key); lastRun.set(key, Date.now());
      void fn().catch(logged(kind)).finally(() => busy.delete(key));
    };
    if (w.usage) go('usage', w.sampleEvery, () => lastSampleAt(app.db, s.id), () => sampleServer(app, s));
    if (w.traffic || w.logs || w.findings) go('traffic', w.every, () => get<{ at: string }>(app.db, 'SELECT max(at) at FROM traffic_windows WHERE server_id = ?', s.id)?.at ?? undefined, () => trafficServer(app, s, w));
  }
  if (ticks % 60 === 11) prune(app.db);
  for (const [orgId, w] of settings) if (digestDue(w) && !busy.has(`digest:${orgId}`)) { busy.add(`digest:${orgId}`); try { weeklyDigest(app, orgId); } catch (e) { logged('digest')(e); } finally { busy.delete(`digest:${orgId}`); } }
  void import('../story/brief.ts').then((b) => b.briefTick(app, busy)).catch(logged('brief')); // the morning brief, 09:00 on each person's clock
}
