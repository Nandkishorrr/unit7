// Coolify's dashboard behind its own HTTPS address, and its port closed without locking anyone out. Closing port 8000
// while the dashboard opens only at http://<server>:8000 locks the person out, so the order is fixed: a name (like
// coolify.<one of their domains>), its DNS pointed at the server, that name set as Coolify's own address (its own
// Settings save, with an undo), a wait until https://<name> answers from outside, and only then the ports closed and
// tested from outside. Each step is its own gated tool call; the first that doesn't work stops it with the next step in
// plain words, and running it again picks up there. Coolify's firewall docs: once the dashboard works through a domain
// on Coolify's proxy, 8000, 6001 (live updates) and 6002 (terminal) can close; those then go through 80 and 443.
import { z } from 'zod';
import { defineTool, execute, type Ctx, type ToolResult } from './runtime.ts';
import { all, get, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid } from './helpers.ts';
import { serverRow } from './servers.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { coolifyPhp, phpScript } from '../connectors/coolify.ts';
import { manageDirs } from './manage.ts';
import { saveUndo, recordChange, changeMade, stamp } from './coolify.ts';
import { lastXray } from './xray.ts';
import type { Inventory } from '../discovery/xray.ts';
import { outside, targetOf, outsideOf, checkOutside, closedPortsOf, type Reach } from '../discovery/outside.ts';
import { portWhat, closedWords, stillOpenFinding } from '../discovery/findings.ts';

export const COOLIFY_FIREWALL_DOCS = 'https://coolify.io/docs/knowledge-base/server/firewall';
const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; } };
const and = (xs: (string | number)[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r, j) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); j(signal.reason); }, { once: true }); });
export const flowTiming = { pollMs: 5000, httpsMaxMs: 4 * 60_000 }; // tests shorten these

// how to reach the dashboard with its port closed: a tunnel over SSH, then http://localhost:<port>
export const tunnelOf = (s: Pick<ServerRow, 'host' | 'port' | 'username'>, port: number) =>
  `ssh -N -L ${port}:localhost:${port} ${s.username}@${s.host}${s.port && s.port !== 22 ? ` -p ${s.port}` : ''}`;
// Coolify's live-update and terminal ports that answer the internet now
export const realtimeOpen = (inv?: Inventory) => [...new Set([...(inv?.parts ?? []).filter((p) => p.containers?.some((c) => /^coolify(-realtime)?$/.test(c))).flatMap((p) => p.ports ?? []), ...(inv?.ports ?? [])]
  .filter((x) => x.public && (x.port === 6001 || x.port === 6002)).map((x) => x.port))].sort((a, b) => a - b);

// --- where the dashboard opens, and whether that answers over HTTPS from outside -------------------------------
export interface Dashboard { url: string; host?: string; https: boolean; answers?: boolean; why?: string; code?: number; from: 'coolify' | 'xray'; apiPort: number; at: string }
export async function dashboardOf(ctx: Ctx, s: ServerRow, o: { php?: boolean } = {}): Promise<Dashboard | undefined> {
  const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
  if (!inv?.coolify) return undefined;
  const apiPort = inv.coolify.apiPort ?? 8000;
  let url = inv.coolify.dashboard, from: Dashboard['from'] = 'xray';
  // Coolify's own setting first (needs root over SSH); else what the X-ray read from its proxy files
  if (o.php !== false) {
    try { url = (await coolifyPhp<{ fqdn?: string | null }>(ctx.app, s, 'instance', {}, ctx.signal)).fqdn || undefined; from = 'coolify'; } catch { /* no root here */ }
  }
  const host = url && /^https:\/\//i.test(url) ? hostOf(url) : undefined;
  const r = host ? await outside.https(host) : undefined;
  const d: Dashboard = { url: host ? `https://${host}` : `http://${targetOf(s)}:${apiPort}`, ...(host && { host }), https: !!host, from, apiPort, at: new Date().toISOString(),
    ...(r && { answers: r.ok && (r.code ?? 500) < 400, code: r.code, ...(r.why && { why: r.why }) }) };
  run(ctx.db, `UPDATE servers SET facts = json_set(COALESCE(NULLIF(facts, ''), '{}'), '$.coolifyDashboard', json(?)) WHERE id = ?`, JSON.stringify(d), s.id);
  return d;
}

// server.close_port asks this before closing a port: Coolify's dashboard port, while its HTTPS address doesn't work,
// would lock the person out (only they may choose that, with anyway)
export async function coolifyLockout(ctx: Ctx, s: ServerRow, port: number) {
  const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
  if (!inv?.coolify || port !== (inv.coolify.apiPort ?? 8000)) return undefined;
  const d = await dashboardOf(ctx, s);
  if (d?.https && d.answers) return undefined;
  const ip = `http://${targetOf(s)}:${port}`;
  const why = !d?.https ? `Coolify’s dashboard opens only at ${ip}` : `Coolify’s address ${d.url} doesn’t answer over HTTPS from here${d.why ? ` (${d.why})` : ''}`;
  return {
    error: new Unit7Error('coolify_lockout', `Closing port ${port} now would lock you out: ${why}. Give Coolify its own HTTPS address first: coolify.dashboard_domain does it step by step and closes the port only once that address works. A person can still close it anyway; the dashboard then opens only through an SSH tunnel.`, 409),
    warning: `You won’t be able to open Coolify at ${ip}; you’d need an SSH tunnel.`, tunnel: tunnelOf(s, port),
  };
}

// the person's own domains (the zones), for "coolify.<domain>": the ones with apps on this server first
export function zonesOf(db: Ctx['db'], orgId: string) {
  const z = new Set<string>();
  for (const r of all<{ name: string; zone: string | null }>(db, `SELECT name, json_extract(meta, '$.zone') zone FROM assets WHERE org_id = ? AND kind = 'domain'`, orgId)) z.add(String(r.zone || r.name).toLowerCase());
  for (const r of all<{ zone: string }>(db, 'SELECT zone FROM domains WHERE org_id = ? AND zone IS NOT NULL', orgId)) z.add(r.zone.toLowerCase());
  // an instant address (sslip.io, nip.io) is a machine's name, not one of theirs
  return [...z].filter((x) => HOST.test(x) && !/\.(sslip|nip)\.io$/.test(x) && ![...z].some((y) => y !== x && x.endsWith(`.${y}`)));
}
export function suggestions(db: Ctx['db'], orgId: string, inv?: Inventory) {
  const zones = zonesOf(db, orgId);
  const here = new Set((inv?.parts ?? []).flatMap((p) => p.hosts ?? []).map((h) => zones.find((zn) => h === zn || h.endsWith(`.${zn}`))).filter(Boolean) as string[]);
  return zones.sort((a, b) => +here.has(b) - +here.has(a) || a.localeCompare(b)).slice(0, 6).map((zn) => `coolify.${zn}`);
}

// a name the dashboard may take: a subdomain, used by nothing on the server or in Unit7, pointing nowhere else
async function nameProblem(ctx: Ctx, s: ServerRow, inv: Inventory, name: string): Promise<string | undefined> {
  if (!HOST.test(name)) return `${name} isn’t a name Unit7 can use. Try one like coolify.example.com.`;
  const zones = zonesOf(ctx.db, ctx.orgId);
  if (zones.includes(name) || name.split('.').length < 3) return `Use a subdomain like coolify.${name}, so ${name} keeps pointing where it does.`;
  const usedBy = inv.parts.find((p) => p.kind !== 'domain' && p.hosts?.includes(name));
  if (usedBy) return `${name} already opens ${usedBy.name}. Pick another name.`;
  const d = get<{ org_id: string; service_id: string | null; target: string | null }>(ctx.db, 'SELECT org_id, service_id, target FROM domains WHERE hostname = ?', name);
  const t = json<{ kind?: string; serverId?: string }>(d?.target, {});
  if (d && (d.org_id !== ctx.orgId || d.service_id || t.kind !== 'server' || t.serverId !== s.id)) return `${name} already goes somewhere else in Unit7. Pick another name.`;
  // what public DNS says now: never take over a name that points somewhere else
  const dns = outside.dns();
  if (!dns) return undefined;
  const [a, cname] = await Promise.all([dns.a(name).catch(() => [] as string[]), dns.cname(name).catch(() => [] as string[])]);
  if (cname.length) return `${name} is an alias of ${cname[0]!.replace(/\.$/, '')} right now, so something may use it. Pick another name.`;
  const other = a.filter((x) => x !== targetOf(s));
  return other.length ? `${name} points at ${other.join(', ')} right now, so something may use it. Pick another name.` : undefined;
}

// --- Coolify's own address, with an undo ---------------------------------------------------------------------
// The undo refuses while Unit7 keeps Coolify's port closed: taking the address away then would lock the person out.
const UNDO_GUARD = `SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"
if $SU iptables -S 2>/dev/null | grep -Eq -- "unit7-close-$1( |$)"; then echo "Port $1 is closed to the internet, so taking Coolify’s own address away now would lock you out of its dashboard. Open port $1 again first, then undo this." >&2; exit 5; fi`;

defineTool({
  name: 'coolify.instance_domain', title: 'Set Coolify’s own address', risk: 'write', action: 'coolify_admin', timeoutMs: 120_000,
  assess: (_c, i) => ({ tier: 2, discovered: true, impact: i.url ? `Sets ${i.url} as the address of Coolify’s dashboard (Settings → General), the way Coolify’s own Save does: its proxy then routes the name and gets the HTTPS certificate. The old address keeps working until its port closes. Activity can undo it.` : 'Takes away the address of Coolify’s dashboard (Settings → General). Activity can undo it.' }),
  description: 'Set the address Coolify’s dashboard answers at (Settings → General → Instance’s domain), with Coolify’s own save code on the server (its API has no route for instance settings), then the proxy setup its Save runs. Needs SSH as root or sudo. Point the name at the server first (domain.point with server). Keeps an undo (change.undo), which refuses while Coolify’s port is closed by Unit7, so it can’t lock anyone out. coolify.dashboard_domain runs it as one of its steps.',
  input: z.object({ serverId: fid('srv'), url: z.string().max(260).regex(/^https:\/\/[A-Za-z0-9.-]+$/, 'https://<name>').nullable() }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
    if (!inv?.coolify) throw new Unit7Error('no_coolify', `Unit7 didn’t find Coolify on ${s.name}. Scan the server again if it was just installed.`, 404);
    const url = i.url?.toLowerCase() ?? null;
    const name = url ? hostOf(url)! : undefined;
    const usedBy = name ? inv.parts.find((p) => p.kind !== 'domain' && p.hosts?.includes(name)) : undefined;
    if (usedBy) throw new Unit7Error('domain_taken', `${name} already opens ${usedBy.name} on ${s.name}. Pick another name.`, 409);
    ctx.progress('Reading Coolify’s own address…');
    const before = (await coolifyPhp<{ fqdn?: string | null }>(ctx.app, s, 'instance', {}, ctx.signal)).fqdn ?? null;
    if ((before ?? '').toLowerCase() === (url ?? '')) return { changed: false, already: true, url };
    // the undo first: Coolify's own save of the old address, refused if someone changed it after Unit7
    const step = await saveUndo(ctx, s, `${manageDirs.undo}/${stamp()}/coolify-instance.php`, phpScript('instance_fqdn', { fqdn: before, expect: url }));
    ctx.progress(url ? `Setting ${url} as Coolify’s address…` : 'Taking Coolify’s address away…');
    await coolifyPhp(ctx.app, s, 'instance_fqdn', { fqdn: url, expect: before }, ctx.signal);
    const summary = url ? `Set ${url} as the address of Coolify’s dashboard` : 'Took away the address of Coolify’s dashboard';
    const apiPort = inv.coolify.apiPort ?? 8000;
    const changeId = recordChange(ctx, s, 'coolify', 'coolify_instance', summary, [script(UNDO_GUARD, apiPort), step]);
    changeMade(ctx, s, changeId, 'coolify', summary);
    return { changed: true, before, url, changeId, undo: `change.undo with changeId ${changeId} puts back ${before ?? 'no address'} (it refuses while port ${apiPort} is closed, so open that first).` };
  },
});

// --- the safe order, as one flow ---------------------------------------------------------------------------------
export type StepKey = 'name' | 'point' | 'set' | 'https' | 'close' | 'check';
export interface FlowStep { key: StepKey; label: string; state: 'todo' | 'running' | 'ok' | 'waiting' | 'failed' | 'skipped'; note?: string }
type Call = (tool: string, input: Record<string, unknown>) => Promise<ToolResult>;
function said(r: ToolResult): { ok: true; output: any } | { ok: false; state: 'waiting' | 'failed'; note: string } {
  if (r.status === 'ok' || r.status === 'dry_run') return { ok: true, output: r.status === 'ok' ? r.output : r.plan };
  if (r.status === 'approval_required') return { ok: false, state: 'waiting', note: 'Waiting for your OK on Approvals. Once it’s approved, run this again: it picks up here.' };
  if (r.status === 'denied') return { ok: false, state: 'failed', note: r.why };
  return { ok: false, state: 'failed', note: r.error.message };
}

export async function dashboardFlow(ctx: Ctx, i: { serverId: string; domain?: string; ports?: number[] },
  call: Call = (tool, input) => execute(ctx.app, ctx.orgId, ctx.actor, tool, input, { reason: 'Coolify’s own address first, then its port closed', signal: ctx.signal, conversationId: ctx.conversationId, ...(ctx.approvalId && { underApproval: ctx.approvalId }) })) {
  const s = serverRow(ctx, i.serverId);
  const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
  if (!inv?.coolify) throw new Unit7Error('no_coolify', `Unit7 didn’t find Coolify on ${s.name}. Scan the server again if it was just installed.`, 404);
  const apiPort = inv.coolify.apiPort ?? 8000;
  // the dashboard's own port first
  const ports = i.ports?.length ? [...new Set(i.ports)].sort((a, b) => (a === apiPort ? -1 : b === apiPort ? 1 : a - b)) : [apiPort, ...realtimeOpen(inv)];
  if (ports.some((p) => p !== apiPort && p !== 6001 && p !== 6002)) throw new Unit7Error('invalid_input', `Only Coolify’s own ports (${apiPort}, 6001, 6002) close here. server.close_port closes others.`, 400);
  const steps: FlowStep[] = [
    { key: 'name', label: 'Pick its name', state: 'todo' },
    { key: 'point', label: 'Point it at this server', state: 'todo' },
    { key: 'set', label: 'Make it Coolify’s own address', state: 'todo' },
    { key: 'https', label: 'Wait until it answers over HTTPS', state: 'todo' },
    { key: 'close', label: `Close port${ports.length === 1 ? '' : 's'} ${and(ports)}`, state: 'todo' },
    { key: 'check', label: 'Check from outside', state: 'todo' },
  ];
  let url: string | undefined;
  const show = () => ctx.app.events.emit(ctx.orgId, 'coolify.dashboard', '', { live: true, data: { serverId: s.id, steps } });
  const set = (k: StepKey, state: FlowStep['state'], note?: string) => { const x = steps.find((y) => y.key === k)!; x.state = state; x.note = note; show(); ctx.progress(`${x.label}${note ? `: ${note}` : ''}`); };
  const end = (done: boolean, next?: string, extra: { said?: string; undo?: { tool: string; input: Record<string, unknown>; label: string }[] } = {}) => ({ serverId: s.id, server: s.name, url, done, ports, steps, ...(next && { next }), ...extra });
  const stop = (k: StepKey, st: { state: 'waiting' | 'failed'; note: string }) => {
    set(k, st.state, st.note);
    ctx.emit('coolify.dashboard_stopped', `Coolify’s own address on ${s.name} stopped at “${steps.find((x) => x.key === k)!.label}”: ${st.note}`, { severity: 'warning', resource: s.id });
    return end(false, st.state === 'failed' ? `${st.note} Port ${apiPort} stays open, so you can still sign in at http://${targetOf(s)}:${apiPort}.` : st.note);
  };

  // already has a working HTTPS address: straight to closing
  const d = await dashboardOf(ctx, s);
  if (d?.https && d.answers) {
    url = d.url;
    for (const k of ['name', 'point', 'set', 'https'] as const) set(k, 'skipped', k === 'name' ? `Coolify already opens at ${d.url}.` : undefined);
  } else {
    const name = i.domain?.trim().toLowerCase();
    if (!name) throw new Unit7Error('needs_name', `Pick a name for Coolify’s dashboard first${suggestions(ctx.db, ctx.orgId, inv)[0] ? `, like ${suggestions(ctx.db, ctx.orgId, inv)[0]}` : ' (coolify. and one of your domains)'}. coolify.dashboard lists names to use.`, 400);
    // a. the name
    set('name', 'running');
    const bad = await nameProblem(ctx, s, inv, name);
    if (bad) return stop('name', { state: 'failed', note: bad });
    url = `https://${name}`;
    set('name', 'ok', name);
    // b. its DNS at the server (run again, a name Unit7 already pointed here isn't asked for again)
    set('point', 'running');
    const had = get<{ status: string; target: string | null }>(ctx.db, 'SELECT status, target FROM domains WHERE hostname = ? AND org_id = ?', name, ctx.orgId);
    const pointed = had && json<{ kind?: string; serverId?: string }>(had.target, {}).serverId === s.id;
    if (pointed) set('point', 'ok', had.status === 'waiting_dns' ? `Waiting for the DNS record you add; ${url} works once it’s there.` : 'It already points at this server.');
    else {
      const p = said(await call('domain.point', { hostname: name, server: { serverId: s.id } }));
      if (!p.ok) return stop('point', p);
      if (p.output?.dns === 'needs you') {
        const recs = (p.output.addThese ?? []).map((r: { type: string; name: string; value: string }) => `${r.type} ${r.name} → ${r.value}`).join(', ');
        return stop('point', { state: 'waiting', note: `Add ${recs} at ${p.output.at ?? 'your DNS provider'}, then run this again: it picks up here. Port ${apiPort} stays open until Coolify answers at ${url}.` });
      }
      set('point', 'ok', typeof p.output?.dns === 'string' ? p.output.dns : undefined);
    }
    // c. Coolify's own address (with an undo); already set (Coolify said so a moment ago): nothing to ask
    set('set', 'running');
    if (d?.host === name) set('set', 'ok', 'It already was.');
    else {
      const c = said(await call('coolify.instance_domain', { serverId: s.id, url }));
      if (!c.ok) return stop('set', { state: c.state, note: `${c.note}${c.state === 'failed' ? ` Or set it by hand: in Coolify, Settings → General → Instance’s domain: ${url}, then Save, and run this again.` : ''}` });
      set('set', 'ok', c.output?.already ? 'It already was.' : 'Saved in Coolify. Activity can undo it.');
    }
    // d. it answers over HTTPS, from outside (DNS and the certificate can take a few minutes)
    set('https', 'running', 'Coolify is getting its HTTPS certificate…');
    let why = 'this computer can’t test it right now';
    for (const until = Date.now() + flowTiming.httpsMaxMs; ;) {
      const r = await outside.https(name);
      if (r?.ok && (r.code ?? 500) < 400) { why = ''; break; }
      if (r) why = r.why ?? `HTTP ${r.code}`;
      if (!r || Date.now() >= until) break;
      await sleep(flowTiming.pollMs, ctx.signal);
    }
    if (why) return stop('https', { state: 'waiting', note: `${url} doesn’t answer over HTTPS yet (${why}). DNS and the certificate can take a few minutes: run this again then, it picks up here. Port ${apiPort} stays open until it works.` });
    set('https', 'ok', `${url} answers.`);
  }
  // e. only now: the ports
  set('close', 'running');
  const shut = new Set(json<{ closedPorts?: number[] }>(serverRow(ctx, s.id).facts, {}).closedPorts ?? []); // closed on an earlier run (the check below still tests them)
  for (const port of ports.filter((p) => !shut.has(p))) {
    const r = said(await call('server.close_port', { serverId: s.id, port }));
    if (!r.ok) return stop('close', r);
  }
  set('close', 'ok', `Closed at the server’s firewall. Each can open again from Activity.`);
  // f. the real test, from this computer
  set('check', 'running');
  const o = await checkOutside(ctx.db, s, ports, { skipNewerThanMs: 60_000 });
  const open = ports.filter((p) => o[String(p)]?.state === 'open');
  if (open.length) return stop('check', { state: 'failed', note: stillOpenFinding(s.id, s.name, open[0]!, portWhat(inv, open[0]!), o[String(open[0]!)]!).detail });
  const untested = ports.filter((p) => o[String(p)]?.state !== 'closed');
  const words = closedWords('Coolify', true);
  set('check', untested.length ? 'waiting' : 'ok', untested.length ? 'Unit7 couldn’t test it from this computer just now; the next check does.' : words);
  ctx.emit('coolify.dashboard_done', `Coolify opens at ${url} and port${ports.length === 1 ? '' : 's'} ${and(ports)} on ${s.name} ${ports.length === 1 ? 'is' : 'are'} closed to the internet`, { severity: 'success', resource: s.id });
  return end(true, undefined, { said: words, undo: ports.map((p) => ({ tool: 'server.close_port', input: { serverId: s.id, port: p, open: true }, label: `Open ${p} again` })) });
}

defineTool({
  name: 'coolify.dashboard_domain', title: 'Give Coolify a domain, then close its port', risk: 'write', action: 'server_write', timeoutMs: 10 * 60_000,
  description: 'Close Coolify’s dashboard port (8000) to the internet without locking anyone out, in a safe order, each step its own checked action: (a) the name you pick (domain, like coolify.example.com; coolify.dashboard suggests some), (b) its DNS pointed at the server (domain.point), (c) set as Coolify’s own address (coolify.instance_domain, with an undo), (d) a wait until https://<name> answers from outside, (e) only then the ports closed (server.close_port: 8000, and 6001/6002 when they’re open: Coolify’s docs say live updates and the terminal go through 80 and 443 once the domain works), (f) tested from outside. When Coolify already answers at an HTTPS address, it closes the ports directly. Stops at the first step that doesn’t work with what to do; run it again and it picks up there. ports limits which of Coolify’s ports close.',
  input: z.object({ serverId: fid('srv'), domain: z.string().trim().max(253).optional(), ports: z.array(z.number().int().min(1).max(65535)).max(3).optional() }),
  run: (ctx, i) => dashboardFlow(ctx, i),
});

// --- what the server page shows ---------------------------------------------------------------------------------
defineTool({
  name: 'coolify.dashboard', title: 'Coolify’s dashboard address', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Where Coolify’s dashboard opens on a server, and whether that address answers over HTTPS from outside (tested from this computer); names to give it (coolify.<one of your domains>); whether its port and its live-update ports (6001, 6002) still answer the internet; and the SSH tunnel that reaches it once its port is closed. check: true asks Coolify itself and tests again now. Read-only. Next: coolify.dashboard_domain.',
  input: z.object({ serverId: fid('srv'), check: z.boolean().default(false) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
    if (!inv?.coolify) return { serverId: s.id, coolify: false };
    const kept = json<{ coolifyDashboard?: Dashboard }>(s.facts, {}).coolifyDashboard;
    const xr = inv.coolify.dashboard;
    const fresh = kept && Date.now() - Date.parse(kept.at) < 10 * 60_000 && (!xr?.startsWith('https://') || kept.url === `https://${hostOf(xr)}`);
    const d = !i.check && fresh ? kept! : (await dashboardOf(ctx, s, { php: i.check }))!;
    const apiPort = inv.coolify.apiPort ?? 8000;
    const api = inv.parts.filter((p) => p.containers?.includes('coolify')).flatMap((p) => p.ports ?? []).find((x) => x.port === apiPort);
    return {
      serverId: s.id, server: s.name, coolify: true, ...d, ipOnly: !d.https, apiPort,
      portOpen: !!api?.public, portClosed: !!inv.blocked?.some((b) => b.port === apiPort), realtimeOpen: realtimeOpen(inv),
      suggestions: d.https ? [] : suggestions(ctx.db, ctx.orgId, inv), tunnel: tunnelOf(s, apiPort), docs: COOLIFY_FIREWALL_DOCS,
    };
  },
});

defineTool({
  name: 'server.closed_ports', title: 'Ports Unit7 closed, checked from outside', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Every port Unit7 closed to the internet on a server (server.close_port), each tested from outside with a connection from this computer: closed, still reachable (with the likely reason), or not tested yet, and when; and whether Unit7’s firewall rule is still there (a restart can clear it). check: true tests them again now. Read-only.',
  input: z.object({ serverId: fid('srv'), check: z.boolean().default(false) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data;
    const ports = closedPortsOf(s, inv?.blocked);
    let o: Record<string, Reach> = outsideOf(s.facts);
    // tested again when asked, or when the last test is missing or older than half an hour
    const old = (p: number) => !o[String(p)] || Date.now() - Date.parse(o[String(p)]!.at) > 30 * 60_000;
    if (ports.length && (i.check || ports.some(old))) o = await checkOutside(ctx.db, s, ports, { skipNewerThanMs: i.check ? 0 : 30 * 60_000 });
    return {
      serverId: s.id, server: s.name,
      ports: ports.map((p) => {
        const what = portWhat(inv, p), coolify = /^Coolify/.test(what), r = o[String(p)];
        const rule = inv?.blocked ? inv.blocked.some((b) => b.port === p) : undefined; // undefined: an X-ray from before Unit7 read its rules
        const said = r?.state === 'open' ? stillOpenFinding(s.id, s.name, p, what, r).detail
          : rule === false ? 'Unit7’s firewall rule for it is gone (a restart clears rules that weren’t saved), so it may answer again.'
          : r?.state === 'closed' ? closedWords(what, coolify) : r ? `Not tested from outside: ${r.why ?? 'no answer from the server at all'}.` : 'Not tested from outside yet.';
        return { port: p, what, coolify, rule, outside: r ?? null, said, ...(rule === false && { again: { tool: 'server.close_port', input: { serverId: s.id, port: p }, label: 'Close it again' } }) };
      }),
    };
  },
});
