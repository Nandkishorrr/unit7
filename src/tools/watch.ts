// The server watch, as tools: server.trends (usage history per project with its usual band and what happened
// when), server.findings (risks, waste and tips with their fixes), server.traffic (the last traffic and log
// check), watch.anomalies (what's unusual right now, everywhere) and watch.settings.
import { gapsIn } from '../sentinel/gaps.ts';
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { all, json } from '../db.ts';
import { fid } from './helpers.ts';
import { serverRow } from './servers.ts';
import { lastXray, runXray } from './xray.ts';
import type { Inventory } from '../discovery/xray.ts';
import { gather, findingsFor } from '../discovery/findings.ts';
import { readPoints, type Res } from '../sentinel/usage.ts';
import { bandFor, type Point, type Series } from '../sentinel/anomaly.ts';
import { hourOfWeek, median } from '../sentinel/baseline.ts';
import { seriesFor, trafficServer, type AlertRow } from '../sentinel/watcher.ts';
import { settingsOf, saveSettings, DEFAULTS } from '../sentinel/schedule.ts';
import type { Summary, WatchFinding } from '../sentinel/traffic.ts';
import { trafficSeries, seriesSince } from '../sentinel/traffic.ts';
import { explainAlert, withExplain } from '../explain.ts';
import { alertKey, visible } from '../snooze.ts';

const RANGES = { '6h': { res: '5m', ms: 6 * 3600_000 }, '24h': { res: '5m', ms: 86400_000 }, '7d': { res: '1h', ms: 7 * 86400_000 }, '30d': { res: '1h', ms: 30 * 86400_000 }, '1y': { res: '1d', ms: 365 * 86400_000 } } as const;
const r1 = (n: number | null | undefined, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

export interface Mark { at: string; kind: 'deploy' | 'restart' | 'oom' | 'change' | 'alert'; label: string; scope?: string }
// what happened on the server in a range: deploys and restarts (Unit7's and Coolify's), out-of-memory kills, alerts
function marks(ctx: Ctx, serverId: string, sinceMs: number, inv: Inventory | undefined, points: Map<string, { name: string; points: Point[] }>): Mark[] {
  const since = new Date(sinceMs).toISOString();
  const svcs = all<{ id: string }>(ctx.db, 'SELECT id FROM services WHERE server_id = ? AND org_id = ?', serverId, ctx.orgId).map((s) => s.id);
  const out: Mark[] = [];
  for (const e of all<{ type: string; message: string; created_at: string; resource: string | null }>(ctx.db, `SELECT type, message, created_at, resource FROM events WHERE org_id = ? AND created_at >= ?
      AND resource IN (${[serverId, ...svcs].map(() => '?').join(',')}) AND (type LIKE 'deployment.%' OR type IN ('service.restarted', 'service.rollback', 'coolify.action', 'coolify.setting', 'server.disk_freed', 'watch.anomaly', 'shield.blocked'))
      ORDER BY created_at LIMIT 300`, ctx.orgId, since, serverId, ...svcs)) {
    const kind: Mark['kind'] = /^deployment\.|coolify\.action/.test(e.type) ? 'deploy' : e.type === 'service.restarted' ? 'restart' : e.type === 'watch.anomaly' ? 'alert' : 'change';
    out.push({ at: e.created_at, kind, label: e.message.slice(0, 140) });
  }
  for (const p of inv?.parts ?? []) {
    const at = p.coolify?.lastDeploy?.at;
    if (at && Date.parse(at) >= sinceMs) out.push({ at, kind: 'deploy', label: `${p.name} deployed by Coolify${p.coolify?.lastDeploy?.status ? ` (${p.coolify.lastDeploy.status})` : ''}`, scope: p.project });
  }
  for (const [scope, s] of points) for (const p of s.points) {
    if (p.oom) out.push({ at: p.at, kind: 'oom', label: `${scope === 'server' ? 'An app' : s.name} ran out of memory${p.oom > 1 ? ` ${p.oom} times` : ''}`, scope });
    else if (p.restarts) out.push({ at: p.at, kind: 'restart', label: `${scope === 'server' ? 'Apps' : s.name} restarted${p.restarts > 1 ? ` ${p.restarts} times` : ''}`, scope });
  }
  return out.filter((m) => m.scope !== 'server').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const alertOut = (r: AlertRow & { server_name?: string }) => {
  const d = json<Record<string, any>>(r.data, {});
  return { id: r.id, serverId: r.server_id, ...(r.server_name && { serverName: r.server_name }), source: r.source, key: r.key, severity: r.severity, title: r.title, since: r.first_at, lastSeen: r.last_at, cleared: r.cleared_at,
    scope: d.scope, name: d.name, kind: d.kind, metric: d.metric, ...(d.since && { started: d.since }), ...(d.fix && { fix: d.fix }), ...(r.incident_id && { incidentId: r.incident_id, conversationId: r.conversation_id }),
    snoozeKey: alertKey(r), explain: explainAlert({ source: r.source, key: r.key, title: r.title, data: d }) };
};

defineTool({
  name: 'server.trends', title: 'Usage over time on a server', risk: 'read', action: 'read',
  description: 'CPU, memory, network, restarts and out-of-memory kills over time, for the whole server and each project on it, with the band that is normal for each hour of the week and markers for deploys, restarts and alerts. Also the unusual jumps open right now (CPU or memory far above usual, memory climbing like a leak, restart loops, the disk filling faster than usual, network spikes), each with its reason in plain words. Ranges: 6h, 24h (5-minute points), 7d, 30d (hourly), 1y (daily). Unit7 samples every 5 minutes while it runs. Read-only; reads only what Unit7 stored.',
  input: z.object({ serverId: fid('srv'), range: z.enum(['6h', '24h', '7d', '30d', '1y']).default('24h'), scope: z.string().max(300).optional().describe('One project id from server.xray, or "server"') }),
  run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const { res, ms } = RANGES[i.range];
    const nowMs = Date.now(), since = nowMs - ms;
    const pts = readPoints(ctx.db, s.id, res as Res, since, i.scope);
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
    const system = new Set((inv?.projects ?? []).filter((p) => p.system).map((p) => p.id));
    const base = new Map(seriesFor(ctx.app, s.id, [...pts].map(([scope, v]) => ({ scope, name: v.name }))).map((x) => [x.scope, x]));
    const series = [...pts].map(([scope, v]) => {
      const sr: Series | undefined = base.get(scope);
      const memo = new Map<string, ReturnType<typeof bandFor>>();
      const band = (k: 'cpu' | 'mem' | 'net', at: string) => {
        if (res === '1d' || !sr) return null;
        const key = `${k}:${hourOfWeek(at)}`;
        if (!memo.has(key)) memo.set(key, bandFor(sr, k, at));
        const b = memo.get(key);
        return b ? { lo: r1(b.lo, k === 'cpu' ? 1 : 0), hi: r1(b.hi, k === 'cpu' ? 1 : 0), mid: r1(b.mid, k === 'cpu' ? 1 : 0) } : null;
      };
      return {
        scope, name: v.name, ...(system.has(scope) && { system: true }),
        points: v.points.map((p) => ({ at: p.at, cpu: r1(p.cpu), cpuMax: r1(p.cpuMax), mem: r1(p.mem, 0), memMax: r1(p.memMax, 0), net: r1(p.net, 0), restarts: p.restarts, oom: p.oom, ...(scope === 'server' && { disk: r1(p.disk, 0) }) })),
        band: { cpu: v.points.map((p) => band('cpu', p.at)), mem: v.points.map((p) => band('mem', p.at)), net: v.points.map((p) => band('net', p.at)) },
      };
    }).sort((a, b) => +(a.scope !== 'server') - +(b.scope !== 'server') || +!!a.system - +!!b.system || a.name.localeCompare(b.name));
    const learning = !series.some((x) => x.band.cpu.some(Boolean));
    const open = all<AlertRow>(ctx.db, `SELECT * FROM watch_alerts WHERE server_id = ? AND source = 'usage' AND (cleared_at IS NULL OR cleared_at > ?) ORDER BY cleared_at IS NOT NULL, first_at DESC LIMIT 30`, s.id, new Date(nowMs - 86400_000).toISOString()).map(alertOut);
    return {
      blind: gapsIn(ctx.db, since, nowMs).map((g) => ({ from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString() })),
      serverId: s.id, serverName: s.name, range: i.range, res, at: new Date(nowMs).toISOString(), cpus: inv?.server.cpus, memTotal: inv?.server.memTotal, diskTotal: inv?.server.diskTotal,
      series, events: marks(ctx, s.id, since, inv, pts), anomalies: open, learning,
      ...(!series.length && { next: 'No usage history yet: Unit7 samples this server every 5 minutes while it runs, so the first points appear within minutes.' }),
      ...(series.length && learning && { note: 'Still learning what’s normal here: the usual band appears after about a day of history.' }),
    };
  },
});

defineTool({
  name: 'server.findings', title: 'Risks, waste and tips for a server', risk: 'read', action: 'read', timeoutMs: 150_000,
  description: 'What could hurt this server and what it wastes, each with its fix: databases and admin pages open to the internet (Docker skips the firewall), Coolify’s proxy dashboard on port 8080, Redis without a password, password sign-in for SSH (from the last security check), apps that keep restarting or running out of memory, databases without backups, a disk-full forecast, logs that never rotate, old images and build cache, unused volumes, data written inside containers, files changed on the server outside git, apps without a memory cap, and what the last traffic check found. Each fix is a tool to run (with safe and undo) or steps. Read-only; uses the stored X-ray unless fresh is true (or there is none).',
  input: z.object({ serverId: fid('srv'), fresh: z.boolean().default(false).describe('X-ray the server again first (one read-only SSH trip)') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const notes: string[] = [];
    if (i.fresh || !lastXray(ctx.db, ctx.orgId, s.id)) {
      ctx.progress(`X-raying ${s.name}…`);
      await runXray(ctx, s).catch((e) => notes.push(`Couldn’t X-ray ${s.name} just now, so this uses what Unit7 last saw: ${(e as Error).message.slice(0, 200)}`));
    }
    const input = gather(ctx.db, ctx.orgId, s);
    const all_ = visible(ctx.db, ctx.orgId, findingsFor(input), (f) => f.id).map(withExplain);
    if (!input.sizes) notes.push('Disk details (logs, volumes, data inside containers) need one disk measurement (server.sizes); it runs in the background every few hours.');
    if (!input.at.traffic) notes.push('Traffic findings appear after the first traffic and log check (every 30 minutes while Unit7 runs).');
    const of = (b: WatchFinding['bucket']) => all_.filter((f) => f.bucket === b);
    return { serverId: s.id, serverName: s.name, at: input.at, counts: { risks: of('risk').length, waste: of('waste').length, tips: of('tip').length }, risks: of('risk'), waste: of('waste'), tips: of('tip'), notes };
  },
});

defineTool({
  name: 'server.traffic', title: 'Traffic and logs on a server', risk: 'read', action: 'read', timeoutMs: 150_000,
  description: 'The last traffic and log check of a server (Unit7 runs it every 30 or 60 minutes): requests, unique visitors, 4xx and 5xx, busiest paths, user agents and addresses, bots and scanners, sign-in hammering, calls without signing in, and error lines per app, compared with what is usual for this time of the week, with findings and their fixes (block an address with Shield, rate-limit advice). Reads Unit7’s web server, Coolify’s proxy (when its access log is on; if not it says how to turn it on) and nginx. fresh: true checks now (one read-only SSH trip). Read-only.',
  input: z.object({ serverId: fid('srv'), fresh: z.boolean().default(false) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const settings = settingsOf(ctx.db, ctx.orgId);
    const rows = () => all<{ at: string; minutes: number; summary: string; findings: string }>(ctx.db, 'SELECT at, minutes, summary, findings FROM traffic_windows WHERE server_id = ? ORDER BY at DESC LIMIT 96', s.id);
    let w = rows();
    let stale: { since: string; why: string } | undefined;
    if (i.fresh || !w.length || Date.now() - Date.parse(w[0]!.at) > (settings.every + 10) * 60_000) {
      ctx.progress(`Reading ${s.name}’s access and error logs…`);
      try { await trafficServer(ctx.app, s, settings); w = rows(); } catch (e) { if (!w.length) throw e; stale = { since: w[0]!.at, why: (e as Error).message.slice(0, 300) }; }
    }
    const last = w[0]!;
    const summary = json<Summary>(last.summary, {} as Summary);
    const past = w.slice(1).map((x) => json<Summary>(x.summary, {} as Summary));
    const usual = (f: (x: Summary) => number) => (past.length >= 3 ? Math.round(median(past.map((x) => (f(x) / Math.max(1, x.minutes)) * summary.minutes))) : undefined);
    return {
      serverId: s.id, serverName: s.name, at: last.at, minutes: last.minutes, every: settings.every, summary, findings: json<WatchFinding[]>(last.findings, []),
      usual: { requests: usual((x) => x.requests), s4xx: usual((x) => x.status.s4xx), s5xx: usual((x) => x.status.s5xx), anon: usual((x) => x.anon.n), ips: usual((x) => x.ips) },
      history: w.slice().reverse().map((x) => { const m = json<Summary>(x.summary, {} as Summary); return { at: x.at, minutes: x.minutes, requests: m.requests, s5xx: m.status?.s5xx ?? 0, s4xx: m.status?.s4xx ?? 0, anon: m.anon?.n ?? 0 }; }),
      ...(stale && { stale }),
    };
  },
});

defineTool({
  name: 'server.traffic_series', title: 'Traffic over time on a server', risk: 'read', action: 'read',
  description: 'Visits per hour (24h, 7d) or per day (30d) from the stored traffic checks, each with its server errors, refused calls and calls without signing in, the band that is usual for that hour of the week, and the totals over the range: the busiest pages, who is calling (people, bots, scanners) and the deploys in it. Read-only; reads only what Unit7 stored and never checks the server (server.traffic does).',
  input: z.object({ serverId: fid('srv'), range: z.enum(['24h', '7d', '30d']).default('24h') }),
  run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const nowMs = Date.now(), from = seriesSince(i.range, nowMs);
    // hours need the four weeks before them for their usual band; days don't
    const since = new Date(from - (i.range === '30d' ? 3600_000 : 28 * 86400_000)).toISOString();
    const windows = all<{ summary: string }>(ctx.db, 'SELECT summary FROM traffic_windows WHERE server_id = ? AND at >= ? ORDER BY at', s.id, since).map((w) => json<Summary>(w.summary, {} as Summary)).filter((w) => w.at);
    const last = windows.at(-1);
    return {
      serverId: s.id, serverName: s.name, at: new Date(nowMs).toISOString(), ...(last && { lastCheck: last.at }), ...trafficSeries(windows, i.range, nowMs),
      // a deploy's started, building and done events are one mark: the last word within 15 minutes
      deploys: marks(ctx, s.id, from, lastXray(ctx.db, ctx.orgId, s.id)?.data, new Map()).filter((m) => m.kind === 'deploy')
        .reduce<Mark[]>((out, m) => { const prev = out.at(-1); if (prev && Date.parse(m.at) - Date.parse(prev.at) < 15 * 60_000) out[out.length - 1] = m; else out.push(m); return out; }, []),
    };
  },
});

defineTool({
  name: 'watch.anomalies', title: 'What’s unusual right now', risk: 'read', action: 'read',
  description: 'Everything the server watch has open right now across every server (unusual jumps in usage, traffic and log problems, new serious risks), newest first, plus what cleared in the last day. Each says why in plain words, when it started, and whether the AI is already looking into it.',
  input: z.object({ serverId: fid('srv').optional() }),
  run(ctx, i) {
    const rows = all<AlertRow & { server_name: string }>(ctx.db, `SELECT a.*, s.name server_name FROM watch_alerts a JOIN servers s ON s.id = a.server_id
      WHERE a.org_id = ? AND (? IS NULL OR a.server_id = ?) AND (a.cleared_at IS NULL OR a.cleared_at > ?) ORDER BY a.cleared_at IS NOT NULL, a.first_at DESC LIMIT 100`,
    ctx.orgId, i.serverId ?? null, i.serverId ?? null, new Date(Date.now() - 86400_000).toISOString()).map(alertOut);
    const shown = visible(ctx.db, ctx.orgId, rows, (r) => r.snoozeKey);
    return { open: shown.filter((r) => !r.cleared), cleared: shown.filter((r) => r.cleared) };
  },
});

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 22:00');
defineTool({
  name: 'watch.settings', title: 'Server watch settings', risk: (i) => (Object.keys(i).length ? 'write' : 'read'), action: (i) => (Object.keys(i).length ? 'settings_write' : 'read'),
  description: 'How Unit7 watches servers: how often it checks traffic and logs (every 30 or 60 minutes), what it watches (usage jumps, traffic and anonymous calls, app error logs, risks and waste, a weekly digest, an automatic read-only AI look at serious problems), and quiet hours when only critical alerts reach your phone. With no fields it reads them.',
  input: z.object({
    every: z.union([z.literal(30), z.literal(60)]).optional(), usage: z.boolean().optional(), traffic: z.boolean().optional(), logs: z.boolean().optional(), findings: z.boolean().optional(),
    digest: z.boolean().optional(), investigate: z.boolean().optional(), brief: z.boolean().optional().describe('The morning brief at 09:00'), quiet: z.object({ from: HHMM, to: HHMM, tz: z.string().max(64).optional() }).nullable().optional(),
    tz: z.string().max(64).optional().describe('The person’s time zone, like Europe/Berlin'),
  }),
  async run(ctx, i) {
    const zone = (tz?: string) => { try { return tz && new Intl.DateTimeFormat('en', { timeZone: tz }) ? tz : undefined; } catch { return undefined; } };
    if (i.quiet?.tz && !zone(i.quiet.tz)) delete i.quiet.tz;
    if (i.tz !== undefined && !zone(i.tz)) delete i.tz;
    const s = Object.keys(i).length ? saveSettings(ctx.db, ctx.orgId, i) : settingsOf(ctx.db, ctx.orgId);
    const { lastDigest, sampleEvery, ...shown } = { ...DEFAULTS, ...s };
    // the switch says on, but with nobody to do the looking nothing happens: say so
    const { agentStatus } = await import('../agent/brain.ts');
    const { anyWatcher } = await import('../agent/bridge.ts');
    const investigateReady = (await agentStatus(ctx.app, ctx.orgId)).ready || anyWatcher(ctx.app, ctx.orgId);
    return { ...shown, investigateReady, sampleEvery, lastDigest: lastDigest ?? null, channels: all<{ provider: string }>(ctx.db, `SELECT provider FROM accounts WHERE org_id = ? AND provider IN ('ntfy', 'webhook')`, ctx.orgId).map((c) => c.provider) };
  },
});
