// Warden: the always-on automation agent. It watches every ready server, runs deterministic
// reflexes (zero AI), keeps the logs, runs scheduled backups, and
// opens an incident for the AI brain only when a reflex can't handle it. Everything it does goes
// through the one tool gate as the actor "Warden", so the autonomy level and hard lines apply.
import { noteAlive } from './gaps.ts';
import type { App } from '../app.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { execute, noteAccountTrouble, providerTrouble, type Actor, type ToolResult } from '../tools/runtime.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import { collectMetrics } from '../tools/servers.ts';
import { nextRun } from '../tools/jobs.ts';
import { autoSync, syncDue, syncRunning } from '../tools/map.ts';
import { redact } from '../redact.ts';
import { archivedServices, touchesArchived } from '../archive.ts';

const JOB_WAITS = [60_000, 5 * 60_000, 15 * 60_000, 3600_000, 6 * 3600_000];
const WARDEN: Actor = { kind: 'agent', id: 'warden', userId: null, name: 'Warden', role: 'agent', agent: 'Warden' };
const METRICS_EVERY = Number(process.env.UNIT7_METRICS_INTERVAL_MS ?? 30_000);
const SWEEP_EVERY = 60_000;

interface Flag { count: number; since: number; lastActed: number }
// background work never takes Unit7 down: a failure is logged (secrets scrubbed) and the next round tries again
const logged = (what: string) => (e: unknown) => { console.error(`warden ${what}:`, redact(String((e as Error)?.stack ?? e))); };
// the servers Warden watches: ready ones, and ones it marked unreachable itself (still looked at, so it sees them come back)
const WATCHED = `SELECT * FROM servers WHERE status = 'ready' OR (status = 'unreachable' AND ssh_block IS NULL AND json_extract(facts, '$.wardenDown') IS NOT NULL)`;

// One pass over Caddy's JSON access log lines: hits per IP (abuse) and traffic per site (load, errors,
// static files served without a long cache).
const SCANNER = /\/(\.env|\.git\/|wp-login|phpmyadmin|vendor\/phpunit|cgi-bin|actuator|\.\.)/i;
const STATIC = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf)(\?|$)/i;
export function summarizeAccessLog(out: string) {
  const perIp = new Map<string, { hits: number; scans: number }>();
  const hosts = new Map<string, { requests: number; errors: number; ms: number[]; staticHits: number; staticUncached: number }>();
  for (const line of out.split('\n')) {
    if (!line.includes('handled request')) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const ip = e?.request?.client_ip || e?.request?.remote_ip;
    const uri = String(e?.request?.uri ?? '');
    if (ip) { const c = perIp.get(ip) ?? { hits: 0, scans: 0 }; c.hits++; if (SCANNER.test(uri)) c.scans++; perIp.set(ip, c); }
    const host = String(e?.request?.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!host) continue;
    const h = hosts.get(host) ?? { requests: 0, errors: 0, ms: [], staticHits: 0, staticUncached: 0 };
    h.requests++;
    if (e.status >= 500) h.errors++;
    if (typeof e.duration === 'number') h.ms.push(e.duration * 1000);
    if (e.status === 200 && STATIC.test(uri.split('?')[0] ?? '')) {
      h.staticHits++;
      const cc = String(e?.resp_headers?.['Cache-Control']?.[0] ?? '');
      if (!/immutable|max-age=(\d{5,})/.test(cc)) h.staticUncached++;
    }
    hosts.set(host, h);
  }
  const perHost = new Map([...hosts].map(([k, h]) => {
    const sorted = h.ms.sort((a, b) => a - b);
    return [k, { requests: h.requests, errors: h.errors, p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? sorted.at(-1) ?? 0), staticHits: h.staticHits, staticUncached: h.staticUncached }];
  }));
  return { perIp, perHost };
}

export class Warden {
  private app: App;
  private timer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private flags = new Map<string, Flag>(); // "serverId:condition" -> streak
  private busy = new Set<string>();         // serverIds currently being collected
  private started = false;

  constructor(app: App) { this.app = app; }

  start() {
    if (this.started || process.env.UNIT7_WARDEN === 'off') return;
    this.started = true;
    this.timer = setInterval(() => this.tick().catch((e) => console.error('warden tick', e)), METRICS_EVERY);
    this.sweepTimer = setInterval(() => this.sweep().catch((e) => console.error('warden sweep', e)), SWEEP_EVERY);
    this.timer.unref(); this.sweepTimer.unref();
    setTimeout(() => this.tick().catch(() => undefined), 3000);
    void import('../outpost/index.ts').then((m) => m.applyAwake(this.app.db)).catch(logged('stay awake'));
    // earned autonomy: a rejection, or a failed AI deploy, counts at once
    this.app.events.on((e) => {
      if (e.type !== 'approval.rejected' && e.type !== 'deployment.failed') return;
      void import('../tools/autopilot.ts').then(({ earnedCheck }) => { for (const env of all<{ id: string }>(this.app.db, 'SELECT id FROM environments WHERE earn = 1 AND org_id = ?', e.org_id)) earnedCheck(this.app, env.id); }).catch(logged('earned autonomy'));
    });
    // something serious happened, or a new server: a check-up shortly after, so the picture is fresh (and never empty) when a person looks
    this.app.events.on((e) => { if ((e.severity === 'critical' && /^(watch|site|server|incident)\./.test(e.type)) || e.type === 'server.ready') this.checkupsSoon.set(e.org_id, Date.now() + 2 * 60_000); });
    // trouble wakes Seven, and a person's yes or no reaches it (a no holds for 30 days)
    void import('../seven/shift.ts').then(({ answered, wakeOn }) => this.app.events.on((e) => {
      wakeOn(e);
      if ((e.type === 'approval.approved' || e.type === 'approval.rejected') && e.resource) answered(this.app.db, e.resource, e.type === 'approval.approved');
    }));
    // "when this happens" routines
    this.app.events.on((e) => { void import('../tools/routines.ts').then((m) => m.routinesOnEvent(this.app, e)).catch(logged('when this happens')); });
    // events out, for whoever asked for them
    this.app.events.on((e) => { void import('../ops/index.ts').then((m) => m.postEvent(this.app, e)).catch(logged('webhook')); });
    // break-in signs: copies and evidence leave the server at once, however busy it is (a miner is busy), and nothing else is touched.
    // The Safety Net switch still counts: off is off.
    this.app.events.on((e) => { if (e.type === 'breakin.found' && e.resource && get<{ safety_net: number }>(this.app.db, 'SELECT safety_net FROM orgs WHERE id = ?', e.org_id)?.safety_net) void this.launch(e.org_id, e.resource, 'signs of a break-in'); });
    // a secret found in an app's code is changed at once
    this.app.events.on((e) => {
      if (e.type !== 'secret.leaked') return;
      const d = e.data as { keys?: string[]; serviceId?: string } | undefined;
      if (!d?.keys?.length || !d.serviceId) return;
      void import('../tools/autopilot.ts').then(async ({ leakPlan }) => {
        const { plan, manual } = leakPlan(this.app.db, e.org_id, d.serviceId!, d.keys!);
        for (const p of plan) await this.act(e.org_id, p.tool, p.input, `${p.key} was found in code`);
        if (manual.length) this.app.events.emit(e.org_id, 'secret.manual', `${manual.join(', ')} ${manual.length > 1 ? 'were' : 'was'} found in code and Unit7 can't change ${manual.length > 1 ? 'them' : 'it'}: revoke ${manual.length > 1 ? 'them' : 'it'} where ${manual.length > 1 ? 'they come' : 'it comes'} from (the provider's dashboard), then paste the new value into Unit7.`, { severity: 'critical', resource: d.serviceId });
      }).catch(logged('leaked secret'));
    });
    // after each map sync: at Full autopilot, what's clearly one product (its wiring and DNS agree) is grouped, with an undo
    this.app.events.on((e) => {
      if (e.type !== 'sync.done') return;
      void import('../organize/groups.ts').then((g) => g.autoGroup(this.app, e.org_id)).catch(logged('grouping'));
    });
    // a newly connected account shows up on the map within a minute
    const soon = new Map<string, NodeJS.Timeout>();
    this.app.events.on((e) => {
      if (e.type !== 'account.connected') return;
      clearTimeout(soon.get(e.org_id));
      soon.set(e.org_id, setTimeout(() => this.syncOrg(e.org_id), 20_000).unref());
    });
    // something deleted (asset.delete): the map is synced again soon, so it shows what the provider has now
    this.app.events.on((e) => {
      if (e.type !== 'asset.deleted') return;
      clearTimeout(soon.get(e.org_id));
      soon.set(e.org_id, setTimeout(() => this.syncOrg(e.org_id), 20_000).unref());
    });
  }
  stop() { clearInterval(this.timer); clearInterval(this.sweepTimer); this.started = false; }

  // Run one collection pass for a server (or all ready servers) synchronously. Used by tests and by
  // a manual "run checks now". Reflexes may need the same condition across calls to fire.
  async checkNow(serverId?: string) {
    const servers = serverId
      ? all<ServerRow>(this.app.db, 'SELECT * FROM servers WHERE id = ?', serverId)
      : all<ServerRow>(this.app.db, WATCHED);
    for (const s of servers) await this.collect(s).catch(() => undefined);
  }
  sweepNow() { return this.sweep(); }

  private orgOf(serverId: string) { return get<{ org_id: string }>(this.app.db, 'SELECT org_id FROM servers WHERE id = ?', serverId)?.org_id; }
  // Every job Warden runs goes through here. One that fails (or waits on an approval) isn't simply run
  // again on its schedule: it waits 1, 5, 15 minutes, then 1 and 6 hours, so a broken thing is never
  // hammered (or a person asked to approve the same thing every few minutes). Success resets it.
  private failing = new Map<string, { until: number; fails: number; last: ToolResult }>();
  private async act(orgId: string, tool: string, input: unknown, reason: string, extra: { onlyIfAllowed?: boolean } = {}): Promise<ToolResult> {
    const key = `${orgId}:${tool}:${JSON.stringify(input)}`;
    // archived (asset.archive): no reflexes, deploys, syncs of its connections or other background changes; backups keep going
    if (!tool.startsWith('backup.') && touchesArchived(this.app.db, orgId, input)) return { status: 'denied', why: 'It’s archived, so Warden leaves it alone.', auditId: '' };
    const f = this.failing.get(key);
    if (f && f.until > Date.now()) return f.last;
    // never rejects, so no background caller can leave a promise failing unhandled
    const r: ToolResult = await execute(this.app, orgId, WARDEN, tool, input, { reason: `Warden: ${reason}`, ...extra })
      .catch((e) => ({ status: 'error', error: { code: 'internal', message: redact((e as Error)?.message ?? String(e)) } }));
    if (r.status === 'ok' || r.status === 'dry_run') this.failing.delete(key);
    else {
      const fails = (f?.fails ?? 0) + 1;
      this.failing.set(key, { until: Date.now() + JOB_WAITS[Math.min(fails, JOB_WAITS.length) - 1]!, fails, last: r });
    }
    return r;
  }

  // streak tracking: a reflex fires only after a condition holds for N consecutive observations,
  // and then not again for `cooldown` ms, so Warden never thrashes.
  private streak(key: string, active: boolean, need: number, cooldown: number): 'fire' | 'hold' | 'clear' {
    let f = this.flags.get(key);
    if (!active) { if (f) this.flags.delete(key); return 'clear'; }
    const now = Date.now();
    if (!f) this.flags.set(key, (f = { count: 0, since: now, lastActed: 0 })); // the first sighting counts: need 1 fires at once
    f.count++;
    if (f.count >= need && now - f.lastActed > cooldown) { f.lastActed = now; return 'fire'; }
    return 'hold';
  }

  // --- the 30s metrics + reflex tick ---
  private async tick() {
    const servers = all<ServerRow>(this.app.db, WATCHED);
    for (const s of servers) {
      if (this.busy.has(s.id)) continue;
      this.busy.add(s.id);
      this.collect(s).catch(() => undefined).finally(() => this.busy.delete(s.id));
    }
  }

  private async collect(s: ServerRow) {
    let m;
    try { m = await collectMetrics(this.app, s); }
    catch { await this.onUnreachable(s); return; }
    this.flags.delete(`${s.id}:unreachable`);
    if (s.status === 'unreachable') {
      run(this.app.db, `UPDATE servers SET status = 'ready', facts = json_remove(facts, '$.wardenDown') WHERE id = ? AND status = 'unreachable'`, s.id);
      this.app.events.emit(s.org_id, 'server.recovered', `${s.name} is answering Unit7 again`, { severity: 'success', resource: s.id });
    }
    await this.scanAbuse(s).catch(() => undefined);
    const { reconcile } = await import('./shield.ts');
    await reconcile(this.app, s).catch(() => undefined);
    // sites written before Unit7 hid secret files (.env, .git) get the rule in place, once (looked at again after 6 hours)
    const { sitesGuarded } = await import('../tools/upkeep.ts');
    if (!sitesGuarded(s.facts) && this.streak(`${s.id}:sites-guard`, true, 1, 6 * 3600_000) === 'fire') await this.act(s.org_id, 'server.protect_sites', { serverId: s.id }, 'hiding secret files on every site');
    const diskPct = m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : 0;
    const memPct = m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;

    // #18 disk filling: old images could go, but that can't be taken back (a rollback uses them), so a person gets asked now, phone included
    if (this.streak(`${s.id}:disk`, diskPct > 90, 2, 10 * 60_000) === 'fire') {
      const r = await this.act(s.org_id, 'docker.prune', { serverId: s.id }, `disk ${diskPct.toFixed(0)}%`);
      this.app.events.emit(s.org_id, 'server.disk_high', `${s.name}’s disk is ${diskPct.toFixed(0)}% full.${r.status === 'approval_required' ? ' Unit7 can free space and is waiting for your OK.' : ''}`, { severity: 'warning', resource: s.id });
    }
    // #10 memory pressure → surface (restart-leakiest is an incident decision, not a blind reflex)
    if (this.streak(`${s.id}:mem`, memPct > 92, 3, 15 * 60_000) === 'fire' && !(await this.addSwap(s, m, memPct))) {
      this.openIncident(s.org_id, s, 'High memory', `${s.name} memory at ${memPct.toFixed(0)}%. Investigate which container is leaking and restart or raise its limit within headroom.`, 'server.mem_high');
    }
    // #1/#9 sustained high CPU → incident (could be load needing cache/scale, or a runaway/miner)
    if (this.streak(`${s.id}:cpu`, m.cpu > 95, 4, 15 * 60_000) === 'fire') {
      this.openIncident(s.org_id, s, 'Sustained high CPU', `${s.name} CPU has been above 95% for two minutes. Check top processes (server.processes) and container stats: is this real load (add caching/workers or scale) or a runaway/miner (pause and page)?`, 'server.cpu_high');
    }
    // #11/#13 crashed or unhealthy containers that Unit7 manages → restart, then let an incident decide
    for (const c of m.containers) {
      const svc = get<{ id: string; name: string; status: string; current_deployment_id: string | null }>(this.app.db, 'SELECT id, name, status, current_deployment_id FROM services WHERE server_id = ? AND config LIKE ?', s.id, `%${c.name}%`);
      void svc;
    }
    await this.checkContainers(s);
  }

  // docker events would be ideal; the 30s poll of `docker ps` catches crashes between ticks well enough for v1
  private async checkContainers(s: ServerRow) {
    const r = await this.act(s.org_id, 'docker.list', { serverId: s.id }, 'health scan');
    if (r.status !== 'ok') return;
    for (const c of r.output as any[]) {
      const name = c.Names ?? c.Name;
      const svc = get<{ id: string; name: string; current_deployment_id: string | null }>(this.app.db,
        `SELECT s.id, s.name, s.current_deployment_id FROM services s JOIN deployments d ON d.id = s.current_deployment_id WHERE d.container = ? AND s.server_id = ?`, name, s.id);
      if (!svc) continue;
      if (archivedServices(this.app.db, s.org_id).has(svc.id)) continue; // archived: not restarted, not alerted on
      const down = /Exited|Dead|Created/.test(c.Status ?? c.State ?? '');
      const unhealthy = /unhealthy/.test(c.Status ?? '');
      if (this.streak(`${svc.id}:down`, down, 1, 2 * 60_000) === 'fire') {
        this.app.events.emit(s.org_id, 'service.down', `${svc.name} is down — Warden is restarting it`, { severity: 'critical', resource: svc.id });
        // first bring it back; a restart is always safe and is the common fix
        let r2 = await this.act(s.org_id, 'service.restart', { serviceId: svc.id }, 'container down');
        if (r2.status !== 'ok') {
          // restart failed. If a deploy landed recently and there's an earlier healthy version, roll back.
          const last = get<{ finished_at: string | null }>(this.app.db, 'SELECT finished_at FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', svc.id);
          const recent = last?.finished_at && Date.now() - new Date(last.finished_at).getTime() < 15 * 60_000;
          const hasTarget = !!get(this.app.db, `SELECT 1 FROM deployments WHERE service_id = ? AND id != ? AND status = 'stopped' AND container IS NOT NULL`, svc.id, svc.current_deployment_id ?? '');
          // never roll back on its own across a migration: older code against a newer schema can corrupt data
          const migrated = (json<{ migrated?: string[] }>(get<{ plan: string }>(this.app.db, 'SELECT plan FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.plan ?? '{}', {}).migrated ?? []).length > 0;
          if (recent && hasTarget && !migrated) { this.app.events.emit(s.org_id, 'service.rollback', `Restart didn't help; Warden is rolling ${svc.name} back`, { severity: 'warning', resource: svc.id }); r2 = await this.act(s.org_id, 'deployment.rollback', { serviceId: svc.id }, 'down after a deploy, restart failed'); }
          if (r2.status !== 'ok') this.openIncident(s.org_id, s, `${svc.name} is down`, `${svc.name}'s container isn't running and Warden couldn't bring it back. Investigate the logs (deployment.logs) and recent deploys.`, 'service.down', svc.id);
        }
      } else if (this.streak(`${svc.id}:unhealthy`, unhealthy, 3, 5 * 60_000) === 'fire') {
        this.app.events.emit(s.org_id, 'service.unhealthy', `${svc.name} is unhealthy — Warden is restarting it`, { severity: 'warning', resource: svc.id });
        await this.act(s.org_id, 'service.restart', { serviceId: svc.id }, 'unhealthy');
      }
    }
  }

  // #1/#2/#3: read recent Caddy access logs, block IPs that flood or scan, and keep per-site traffic
  // numbers for the load and error suggestions. Zero AI.
  private async scanAbuse(s: ServerRow) {
    const { ssh } = await import('../connectors/ssh.ts');
    const { cmd } = await import('../connectors/shell.ts');
    const r = await ssh(this.app).exec(s, `${cmd('docker', 'logs', '--since', '35s', 'unit7-caddy')} 2>&1`, { timeoutMs: 15_000 }).catch(() => null);
    if (!r || r.code !== 0) return;
    const { perIp, perHost } = summarizeAccessLog(r.stdout);
    const at = now();
    for (const [host, t] of perHost) {
      run(this.app.db, 'INSERT INTO traffic (server_id, hostname, at, requests, errors, p95_ms, static_hits, static_uncached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', s.id, host, at, t.requests, t.errors, t.p95, t.staticHits, t.staticUncached);
    }
    const { blockIp } = await import('./shield.ts');
    const { classify } = await import('../netguard.ts');
    for (const [ip, c] of perIp) {
      if (classify(ip) !== 'public') continue;
      // ~35s window: >700 requests ≈ >1200/min, or any real scanner path
      const reason = c.scans >= 1 ? 'vulnerability scanner' : c.hits > 700 ? 'request flood' : '';
      if (!reason) continue;
      if (this.streak(`${s.id}:abuse:${ip}`, true, 1, 10 * 60_000) !== 'fire') continue;
      await blockIp(this.app, s, ip, reason).catch(() => undefined);
    }
  }

  // #14 memory stays tight and the server has little or no swap: a swap file (min(2 GB, its memory), only with 10 GB
  // of disk free), through the gate like any reflex. False when it couldn't, so the incident opens as before.
  private async addSwap(s: ServerRow, m: { memTotal: number; diskTotal: number; diskUsed: number }, memPct: number) {
    const want = Math.min(2 * 1024 ** 3, m.memTotal);
    if ((json<{ swap_total?: number }>(s.facts, {}).swap_total ?? 0) >= want / 2 || m.diskTotal - m.diskUsed < 10 * 1024 ** 3) return false;
    const r = await this.act(s.org_id, 'server.swap', { serverId: s.id }, `memory at ${memPct.toFixed(0)}% with little swap`);
    return r.status === 'ok' && !!(r.output as { added?: string }).added;
  }

  private async onUnreachable(s: ServerRow) {
    if (s.status === 'unreachable') return; // already said; Warden keeps looking quietly until it answers
    if (this.streak(`${s.id}:unreachable`, true, 3, 10 * 60_000) !== 'fire') return;
    // the third miss in a row: find out why first (read-only), so the alert says the cause and the fix Unit7 offers
    const r = await this.act(s.org_id, 'server.diagnose', { serverId: s.id }, 'stopped responding three times in a row');
    const d = r.status === 'ok' ? (r.output as { cause: string; title: string; explain: string; fixes: { id: string; label: string }[] }) : undefined;
    if (d?.cause === 'ok') return; // it answered after all
    // marked as Warden's own call, so Warden (and nothing else) keeps checking it
    run(this.app.db, `UPDATE servers SET status = 'unreachable', facts = json_set(facts, '$.wardenDown', ?) WHERE id = ? AND status = 'ready'`, now(), s.id);
    const why = d ? ` ${d.title.replace(/\.$/, '')}.${d.fixes[0] ? ` Unit7 can fix it: ${d.fixes[0].label}, on the server’s page.` : ' The server’s page shows what to do.'}` : '';
    this.app.events.emit(s.org_id, 'server.unreachable', `${s.name} stopped responding to Unit7.${why}`, { severity: 'critical', resource: s.id,
      ...(d && { data: { diagnosis: { cause: d.cause, title: d.title, explain: d.explain, fixes: d.fixes } } }) });
  }

  // --- the 60s sweep: certs, backups, scheduled jobs ---
  private sweeps = 0;
  private async sweep() {
    this.sweeps++;
    const gap = noteAlive(this.app.db);
    if (gap && gap.to - gap.from >= 15 * 60_000) this.catchUp(gap); // back from sleep: what did the servers do meanwhile?
    await this.refreshSignIns().catch(() => undefined);
    this.pollGit();
    this.scanAppErrors();
    this.runDueJobs();
    this.watchDomains();
    this.watchLinks();
    this.watchOutside();
    // the server watch: usage samples (every 5 minutes), traffic and logs (every 30 or 60), findings, the weekly digest
    void import('./watcher.ts').then((w) => w.tick(this.app, this.busy)).catch(logged('server watch'));
    // incidents whose cause is gone (its alerts cleared, or no new high-load incident for an hour) close by themselves
    if (this.sweeps % 5 === 3) void import('../tools/recheck.ts').then((r) => { for (const o of all<{ id: string }>(this.app.db, `SELECT DISTINCT org_id id FROM incidents WHERE status IN ('open', 'investigated')`)) r.resolveIncidents(this.app, o.id); }).catch(logged('incidents'));
    // clients' status pages: fresh files every 5 minutes
    if (this.sweeps % 5 === 2) void import('../organize/status.ts').then((m) => m.refreshStatusPages(this.app)).catch(logged('status pages'));
    // saved routines: start what's due (as their owners, through the gate) and carry on runs whose approval came
    void import('../tools/routines.ts').then((r) => r.tick(this.app)).catch(logged('routines'));
    void import('../tools/runtime.ts').then((r) => r.closeInterrupted(this.app)).catch(logged('closing interrupted work'));
    if (this.sweeps % 2 === 0) this.autoscale();
    if (this.sweeps % 60 === 13) this.rotateSecrets();
    if (this.sweeps % 10 === 4) this.fixVulnerabilities();
    // a pull request pinning an app's build tools (src/tools/pins.ts): merged once green where the autonomy allowed it when it opened
    if (this.sweeps % 10 === 4) for (const a of all<{ id: string; org_id: string }>(this.app.db, `SELECT id, org_id FROM services WHERE json_extract(config, '$.pinPr.auto') = 1`)) void this.act(a.org_id, 'deployment.merge_pin', { serviceId: a.id }, 'the pin pull request’s checks are green');
    if (this.sweeps % 1440 === 20) for (const o of all<{ id: string }>(this.app.db, 'SELECT id FROM orgs WHERE budget_monthly IS NOT NULL')) void this.act(o.id, 'budget.check', {}, 'daily budget check'); // #36
    // the big clouds' spend, twice a day (AWS charges a cent per cost read): a spike or a budget past 100% alerts with a stop plan
    if (this.sweeps % 720 === 41) for (const o of all<{ org_id: string }>(this.app.db, `SELECT DISTINCT org_id FROM accounts WHERE provider IN ('gcp', 'firebase', 'aws', 'azure') AND status != 'failing'`)) void this.act(o.org_id, 'cloud.spend_watch', {}, 'twice-daily cloud cost check');
    if (this.sweeps % 10 === 6) { // #35 errors from apps on other hosts, every 10 minutes, one pass per organisation
      for (const o of all<{ org_id: string }>(this.app.db, `SELECT DISTINCT org_id FROM assets WHERE kind = 'app' AND provider IN ('vercel','railway','render','fly','heroku','digitalocean')`)) {
        const key = `hosterrors:${o.org_id}`;
        if (this.busy.has(key)) continue;
        this.busy.add(key);
        void this.act(o.org_id, 'errors.scan_hosts', {}, 'reading errors from other hosts').finally(() => this.busy.delete(key));
      }
    }
    if (this.sweeps % 60 === 7) void import('../tools/autopilot.ts').then(({ earnedCheck }) => { for (const e of all<{ id: string }>(this.app.db, 'SELECT id FROM environments WHERE earn = 1')) earnedCheck(this.app, e.id); }).catch(logged('earned autonomy')); // #31 earned autonomy, hourly
    if (this.sweeps % 60 === 2) this.rescanImages(); // hourly check; each image at most weekly
    if (this.sweeps % 60 === 3) void import('../tools/activity.ts').then((m) => m.weeklyBlocked(this.app)).catch(logged('weekly summary')); // hourly check, one alert a week
    if (this.sweeps % 60 === 9) this.trimHistory();
    if (this.sweeps % 60 === 17) this.weeklySecurity(); // hourly look; each organisation at most weekly
    if (this.sweeps % 15 === 8) void this.autofixNow(); // safe fixes with an undo, by itself (tools/autofix.ts decides which)
    if (this.sweeps % 15 === 11) this.safetyNow(); // what's important and has no safe copy gets one (care/safetynet.ts)
    if (this.sweeps % 5 === 2) void this.seeDeploys(); // Coolify tells nobody when it deploys (care/deploywatch.ts)
    if (this.sweeps % 5 === 4) void this.sevenNow(); // Seven's shifts (src/seven): every 6 hours, a daily review, soon after trouble
    if (this.sweeps % 10 === 7) void import('../handoff/store.ts').then(({ fixCheck }) => { for (const o of all<{ id: string }>(this.app.db, `SELECT DISTINCT org_id id FROM findings WHERE status IN ('sent', 'watching', 'thin', 'fixed')`)) fixCheck(this.app, o.id); }).catch(logged('fix check')); // did what the AI shipped work?
    if (this.sweeps % 10 === 5) void this.checkupNow(); // short daily, full weekly, and soon after a deploy or a serious alert
    if (this.sweeps % 60 === 33) for (const s of all<{ id: string; org_id: string }>(this.app.db, `SELECT id, org_id FROM servers WHERE status = 'ready'`)) void this.act(s.org_id, 'inspect.database', { serverId: s.id }, 'what the database hears');
    if (this.sweeps % 360 === 37) for (const s of all<{ id: string; org_id: string }>(this.app.db, `SELECT id, org_id FROM servers WHERE status = 'ready'`)) void this.act(s.org_id, 'inspect.outside', { serverId: s.id }, 'are outside services failing');
    if (this.sweeps % 5 === 3) { // the Outpost: bring in what it saw, and tell it Unit7 is awake so it stays quiet. The heartbeat for whoever watches from outside.
      for (const o of all<{ org_id: string }>(this.app.db, 'SELECT DISTINCT org_id FROM outposts')) void this.act(o.org_id, 'outpost.sync', {}, 'what the Outpost saw').then(() => this.act(o.org_id, 'outpost.send_copies', {}, 'the Outpost’s copies go off the server'));
      void import('../outpost/index.ts').then((m) => m.heartbeatTick(this.app)).catch(logged('heartbeat'));
    }
    if (this.sweeps % 60 === 41) void this.lifeboatNow().catch(logged('lifeboat'));
    if (this.sweeps % 10 === 8) void import('../ops/index.ts').then((m) => m.runHeld(this.app)).catch(logged('held deletes'));
    if (this.sweeps % 1440 === 50) for (const o of all<{ org_id: string }>(this.app.db, `SELECT DISTINCT org_id FROM accounts WHERE provider = 'coolify'`)) void this.act(o.org_id, 'coolify.contract', {}, 'has Coolify changed');
    if (this.sweeps % 5 === 4) void import('../care/helpnow.ts').then((m) => { for (const o of all<{ org_id: string }>(this.app.db, `SELECT DISTINCT org_id FROM incidents WHERE status = 'resolved' AND notes IS NULL`)) m.writeNotes(this.app.db, o.org_id); }).catch(logged('incident notes'));
    void import('./telegram.ts').then((m) => m.telegramReplies(this.app)).catch(logged('telegram'));
    if (this.sweeps % 60 === 27) for (const o of all<{ id: string }>(this.app.db, `SELECT DISTINCT org_id id FROM servers WHERE status = 'ready'`)) void this.act(o.id, 'part.copies_remind', {}, 'an old past copy holds real data');
    void this.rebootNow(); // restart windows: a warning 10 minutes before, then the restart inside the window (tools/reboot.ts)
    // keep it fresh (src/fresh): weekly updates in each app's quietest hour, security fixes that can't wait, servers' patches
    if (this.sweeps % 5 === 1) void this.freshNow();
    // apps on several servers (src/fleet): each server's health every minute; with DNS, a sick one leaves rotation and comes back
    if (!this.busy.has('fleets')) { this.busy.add('fleets'); void import('../fleet/traffic.ts').then((m) => m.fleetTick(this.app, (org, tool, input, reason) => this.act(org, tool, input, reason))).catch(logged('fleets')).finally(() => this.busy.delete('fleets')); }
    // canaries (src/fleet/canary.ts): a look at each new version on its share of visitors, then step up, promote or roll back
    if (!this.busy.has('canaries')) { this.busy.add('canaries'); void import('../fleet/canary.ts').then((m) => m.canaryTick(this.app, (org, tool, input, reason) => this.act(org, tool, input, reason))).catch(logged('canaries')).finally(() => this.busy.delete('canaries')); }
    // warm standbys (src/fleet/dr.ts): data every few hours, the monthly drill in a quiet hour, and the switch when a main server is down
    if (!this.busy.has('standbys')) { this.busy.add('standbys'); void import('../fleet/dr.ts').then((m) => m.drTick(this.app, (org, tool, input, reason) => this.act(org, tool, input, reason))).catch(logged('standbys')).finally(() => this.busy.delete('standbys')); }
    // keep a week of server metrics and two days of per-site traffic
    run(this.app.db, 'DELETE FROM metrics WHERE at < ?', new Date(Date.now() - 7 * 86400_000).toISOString());
    run(this.app.db, 'DELETE FROM traffic WHERE at < ?', new Date(Date.now() - 2 * 86400_000).toISOString());
    // #21 scheduled + stale backups
    for (const sch of all<{ id: string; org_id: string; service_id: string; frequency: string; keep: number; last_run_at: string | null }>(this.app.db, 'SELECT * FROM backup_schedules')) {
      const due = { hourly: 3600_000, daily: 86400_000, weekly: 604800_000 }[sch.frequency] ?? 86400_000;
      // the schedule moves on only when a backup was made; a failed one is retried in 15 minutes and said once
      const bkey = `backup:${sch.id}`;
      if ((!sch.last_run_at || Date.now() - new Date(sch.last_run_at).getTime() > due) && (this.backupRetry.get(sch.id) ?? 0) <= Date.now() && !this.busy.has(bkey)) {
        this.busy.add(bkey);
        try {
          const r = await this.act(sch.org_id, 'backup.create', { serviceId: sch.service_id, reason: `scheduled (${sch.frequency})` }, 'scheduled backup');
          if (r.status === 'ok') {
            run(this.app.db, 'UPDATE backup_schedules SET last_run_at = ? WHERE id = ?', now(), sch.id);
            this.backupRetry.delete(sch.id);
            await this.act(sch.org_id, 'backup.prune', { serviceId: sch.service_id, keep: sch.keep }, 'keeping the newest backups');
          } else {
            const why = r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? 'it is waiting for approval' : r.status;
            const name = get<{ name: string }>(this.app.db, 'SELECT name FROM services WHERE id = ?', sch.service_id)?.name ?? sch.service_id;
            if (!this.backupRetry.has(sch.id)) this.app.events.emit(sch.org_id, 'backup.failed', `The ${sch.frequency} backup of ${name} failed: ${why}. Warden tries again every 15 minutes.`, { severity: 'critical', resource: sch.service_id });
            this.backupRetry.set(sch.id, Date.now() + 15 * 60_000);
          }
        } finally { this.busy.delete(bkey); }
      }
      // #22 a backup you never restored isn't a backup: prove the latest one weekly, in the background
      const last = get<{ id: string; verified_at: string | null }>(this.app.db, `SELECT id, verified_at FROM backups WHERE service_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`, sch.service_id);
      const key = `verify:${sch.service_id}`;
      if (last && !this.busy.has(key) && (!last.verified_at || Date.now() - Date.parse(last.verified_at) > 7 * 86400_000)) {
        this.busy.add(key);
        // the off-server copy when there is one: that proves the whole chain (copy, encrypt, decrypt, restore)
        const offsite = !!get<{ ok: number }>(this.app.db, `SELECT 1 ok FROM backups WHERE id = ? AND (json_extract(offsite, '$.local') IS NOT NULL OR json_extract(offsite, '$.bucket') IS NOT NULL)`, last.id);
        void this.act(sch.org_id, 'backup.verify', { backupId: last.id, offsite }, 'weekly restore test').finally(() => this.busy.delete(key));
      }
    }
    // databases Unit7 found on a server and backs up itself ("Back up daily with Unit7"): in the background, one at a
    // time each; a failure is said once and tried again in 15 minutes
    void import('../tools/partbackup.ts').then(({ dueSchedules }) => {
      for (const p of dueSchedules(this.app.db)) {
        const key = `partbackup:${p.id}`;
        if (this.busy.has(key) || (this.backupRetry.get(p.id) ?? 0) > Date.now()) continue;
        this.busy.add(key);
        void this.act(p.org_id, 'part.backup', { serverId: p.server_id, part: p.part, reason: `scheduled (${p.frequency})` }, 'scheduled backup').then((r) => {
          if (r.status === 'ok') { this.backupRetry.delete(p.id); return; }
          const why = r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? 'it is waiting for approval' : r.status;
          if (!this.backupRetry.has(p.id)) this.app.events.emit(p.org_id, 'backup.failed', `The ${p.frequency} backup of ${p.name} failed: ${why}. Warden tries again every 15 minutes.`, { severity: 'critical', resource: p.server_id });
          this.backupRetry.set(p.id, Date.now() + 15 * 60_000);
        }).finally(() => this.busy.delete(key));
      }
    }).catch(logged('database backups'));
  }

  // Keep the history useful, not endless: machines' reads go after 30 days and events after 90 (changes,
  // approvals, refusals and everything people did stay); Warden's push-to-deploy checks that found nothing
  // new go after an hour, with their "done" events. Stale flags go too.
  private backupRetry = new Map<string, number>(); // schedule id -> no retry before
  private trimHistory() {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString(), day = 86400_000;
    run(this.app.db, `DELETE FROM audit WHERE actor_kind IN ('agent', 'system') AND risk = 'read' AND result NOT IN ('denied', 'approval_required') AND approval_id IS NULL AND created_at < ?`, ago(30 * day));
    run(this.app.db, 'DELETE FROM events WHERE created_at < ?', ago(90 * day));
    // space from what was trimmed goes back to the disk, at most once a day (it blocks for a moment on a big file)
    if (this.sweeps % 1440 === 9) {
      const pages = (p: string) => Number((this.app.db.prepare(`PRAGMA ${p}`).get() as Record<string, number>)[p]) || 0;
      if (pages('freelist_count') * pages('page_size') > 64 * 1024 * 1024) { try { this.app.db.exec('VACUUM'); } catch (e) { console.error('vacuum', e); } }
    }
    // rows from before the audit chain: a chained row is never deleted, or the chain would look tampered with (service.sync_git's idle keeps new ones out)
    run(this.app.db, `DELETE FROM audit WHERE tool = 'service.sync_git' AND actor_id = 'warden' AND result = 'success' AND json_extract(output, '$.deployed') = 0 AND chain IS NULL AND created_at < ?`, ago(3600_000));
    run(this.app.db, `DELETE FROM events WHERE type = 'action.completed' AND json_extract(data, '$.tool') = 'service.sync_git' AND created_at < ? AND json_extract(data, '$.auditId') NOT IN (SELECT id FROM audit)`, ago(3600_000));
    for (const [k, f] of this.flags) if (Date.now() - Math.max(f.since, f.lastActed) > day) this.flags.delete(k);
  }

  // #23 push to deploy (every minute) and a preview URL per pull request (every five). Only apps that
  // were deployed once by hand, from GitHub, with the switch on (default). In the background, one at a time
  // per app, so a long deploy is never started twice.
  private pollGit() {
    const apps = all<{ id: string; org_id: string; config: string; kind: string }>(this.app.db, `SELECT id, org_id, config, kind FROM services
      WHERE current_deployment_id IS NOT NULL AND json_extract(config, '$.source.type') = 'git' AND json_extract(config, '$.previewOf') IS NULL`);
    for (const a of apps) {
      const cfg = json<{ autoDeploy?: boolean; previews?: boolean }>(a.config, {});
      const jobs: [string, string][] = [];
      if (cfg.autoDeploy !== false) jobs.push(['service.sync_git', 'new commits']);
      if (a.kind === 'app' && cfg.previews !== false && this.sweeps % 5 === 1) jobs.push(['service.sync_previews', 'pull request previews']);
      for (const [tool, why] of jobs) {
        const key = `${tool}:${a.id}`;
        if (this.busy.has(key)) continue;
        this.busy.add(key);
        void this.act(a.org_id, tool, { serviceId: a.id }, why).finally(() => this.busy.delete(key));
      }
    }
  }

  // #25 errors from app logs, grouped (errors.scan). A NEW error spiking in production goes to a brain
  // on its own — only when one is listening (Unit7's model or a /unit7 watch), once per error per day.
  private scanAppErrors() {
    for (const a of all<{ id: string; org_id: string; name: string; env_kind: string; autonomy: number }>(this.app.db, `SELECT s.id, s.org_id, s.name, e.kind env_kind, e.autonomy FROM services s
        JOIN environments e ON e.id = s.environment_id JOIN deployments d ON d.id = s.current_deployment_id
        WHERE d.status = 'live' AND s.kind NOT IN ('postgres','mysql','mariadb','mongo','redis')`)) {
      const key = `errors:${a.id}`;
      if (this.busy.has(key)) continue;
      this.busy.add(key);
      void this.act(a.org_id, 'errors.scan', { serviceId: a.id }, 'error scan').then(async (r) => {
        if (r.status !== 'ok' || a.env_kind !== 'production' || a.autonomy < 2) return;
        for (const g of (r.output as { updated: { group: string; kind: string; message: string; frame?: string; added: number; fresh: boolean }[] }).updated) {
          const flag = `errhand:${g.group}`;
          if (!g.fresh || g.added < 3 || (this.flags.get(flag) && Date.now() - this.flags.get(flag)!.since < 86400_000)) continue;
          // out of database connections: a pooler fixes it, no AI needed
          if (/too many (clients|connections)|remaining connection slots|connection limit exceeded/i.test(g.message)) {
            const { merged } = await import('../tools/env.ts');
            const ref = merged(this.app.db, a.org_id, { type: 'service', id: a.id, label: '' }).map((v) => v.ref).find((r) => r && /^credential:\/\/postgres\/[^/]+\/url$/.test(r));
            const pg = ref && get<{ id: string }>(this.app.db, `SELECT id FROM services WHERE org_id = ? AND kind = 'postgres' AND json_extract(config, '$.passwordRef') = ?`, a.org_id, ref.replace(/url$/, 'password'));
            if (pg) {
              this.flags.set(flag, { count: 1, since: Date.now(), lastActed: Date.now() });
              void this.act(a.org_id, 'database.pool', { serviceId: pg.id }, `${a.name} ran out of database connections`);
              continue;
            }
          }
          const { agentStatus } = await import('../agent/brain.ts');
          const { anyWatcher } = await import('../agent/bridge.ts');
          if (!(await agentStatus(this.app, a.org_id)).ready && !anyWatcher(this.app, a.org_id)) continue;
          this.flags.set(flag, { count: 1, since: Date.now(), lastActed: Date.now() });
          const sample = get<{ sample: string }>(this.app.db, 'SELECT sample FROM error_groups WHERE id = ?', g.group)?.sample ?? '';
          const { escalate, untrusted } = await import('../agent/escalate.ts');
          await escalate(this.app, a.org_id, `New error in ${a.name}`, `A new error is happening in production in ${a.name} (service ${a.id}), ${g.added} times in the last minute. Find the cause (errors_list, deployment_logs, recent deploys). If the latest deploy caused it and users are affected, roll back; otherwise explain the code fix needed. Summarise.\n\n${untrusted('the app\u2019s error log', `${g.kind}${g.frame ? ` in ${g.frame}` : ''}: ${g.message}\n\nStack trace:\n${sample.slice(0, 2500)}`)}`);
        }
      }).catch(logged('error scan')).finally(() => this.busy.delete(key));
    }
  }

  // #27 domains: ones waiting on DNS are checked every 2 minutes (and finish by themselves once DNS is
  // live); live ones once a day, so a DNS change made somewhere else is caught
  private watchDomains() {
    const day = this.sweeps % 1440 === 3;
    for (const d of all<{ id: string; org_id: string; status: string }>(this.app.db, `SELECT id, org_id, status FROM domains WHERE auto = 0 AND status IN ('pending','waiting_dns','active','broken')`)) {
      const waiting = d.status === 'pending' || d.status === 'waiting_dns' || d.status === 'broken';
      if (!(waiting ? this.sweeps % 2 === 0 : day)) continue;
      const key = `domain:${d.id}`;
      if (this.busy.has(key)) continue;
      this.busy.add(key);
      void this.act(d.org_id, 'domain.check', { domainId: d.id }, waiting ? 'waiting for DNS' : 'daily domain check').finally(() => this.busy.delete(key));
    }
  }

  // #28 connections: re-read each source (a rotated key, a new domain) and push changes to the other
  // side — every 6 hours, and every 15 minutes for one that's broken
  private watchLinks() {
    for (const l of all<{ id: string; org_id: string; status: string }>(this.app.db, 'SELECT id, org_id, status FROM links')) {
      if (this.sweeps % (l.status === 'broken' ? 15 : 360) !== 4) continue;
      const key = `link:${l.id}`;
      if (this.busy.has(key)) continue;
      this.busy.add(key);
      void this.act(l.org_id, 'link.sync', { linkId: l.id }, 'keeping a connection in sync').finally(() => this.busy.delete(key));
    }
    // #29 the map: each organisation syncs on its own schedule (sync.schedule: every 6 hours unless changed, or
    // off), then wires up what clearly belongs together. Looked at every minute, so one that's overdue when
    // Unit7 starts syncs within a minute.
    for (const o of all<{ org_id: string }>(this.app.db, `SELECT DISTINCT org_id FROM accounts UNION SELECT org_id FROM services GROUP BY org_id HAVING count(*) > 1`)) {
      if (syncDue(autoSync(this.app.db, o.org_id))) this.syncOrg(o.org_id);
    }
  }

  // #34 vulnerable packages: a fix PR for apps whose latest scan found fixable ones (once a day at most),
  // merged once its preview is green where "merge when healthy" is on
  private fixVulnerabilities() {
    const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    for (const a of all<{ id: string; org_id: string; config: string; plan: string }>(this.app.db, `SELECT s.id, s.org_id, s.config, d.plan FROM services s JOIN deployments d ON d.id = s.current_deployment_id
        WHERE json_extract(s.config, '$.source.type') = 'git' AND json_extract(s.config, '$.previewOf') IS NULL`)) {
      const c = json<{ fixPr?: object; fixTriedAt?: string; autoFixPrs?: boolean; autoMergeFixes?: boolean }>(a.config, {});
      const sec = json<{ security?: { critical: number; high: number } }>(a.plan, {}).security;
      const key = `fix:${a.id}`;
      if (this.busy.has(key)) continue;
      if (c.fixPr && c.autoMergeFixes) { this.busy.add(key); void this.act(a.org_id, 'security.merge_fix', { serviceId: a.id }, 'the fix PR\u2019s preview is green').finally(() => this.busy.delete(key)); continue; }
      if (this.sweeps % 60 === 4 && !c.fixPr && c.autoFixPrs !== false && sec && sec.critical + sec.high > 0 && (!c.fixTriedAt || c.fixTriedAt < dayAgo)) {
        this.busy.add(key);
        void this.act(a.org_id, 'security.fix_pr', { serviceId: a.id }, `${sec.critical + sec.high} fixable vulnerabilities`).finally(() => this.busy.delete(key));
      }
    }
  }

  // #33 secret rotation (hourly look): connection keys when due, their old keys after the grace day, and
  // database passwords when due, only in the quiet hour (03:00 UTC)
  private rotateSecrets() {
    const day = 86400_000;
    for (const l of all<{ id: string; org_id: string; previous_until: string | null }>(this.app.db, `SELECT id, org_id, previous_until FROM links WHERE previous_until IS NOT NULL AND previous_until < ?`, now())) {
      void this.act(l.org_id, 'link.retire_previous', { linkId: l.id }, 'the old key\u2019s grace day is over');
    }
    for (const l of all<{ id: string; org_id: string }>(this.app.db, `SELECT l.id, l.org_id FROM links l JOIN orgs o ON o.id = l.org_id
        WHERE o.rotate_links_days > 0 AND l.status = 'ok' AND l.vars LIKE '%_API_KEY%' AND l.previous_until IS NULL AND coalesce(l.rotated_at, l.created_at) < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || o.rotate_links_days || ' days')`)) {
      void this.act(l.org_id, 'link.rotate', { linkId: l.id }, 'scheduled key change');
    }
    if (new Date().getUTCHours() !== 3) return;
    for (const d of all<{ id: string; org_id: string; days: number; ref: string }>(this.app.db, `SELECT s.id, s.org_id, o.rotate_db_days days, json_extract(s.config, '$.passwordRef') ref FROM services s JOIN orgs o ON o.id = s.org_id
        WHERE o.rotate_db_days > 0 AND s.kind IN ('postgres', 'mysql', 'mariadb')`)) {
      const at = this.app.vault.meta(d.org_id, d.ref)?.created_at;
      if (at && Date.parse(at) < Date.now() - d.days * day) void this.act(d.org_id, 'database.rotate_password', { serviceId: d.id, reason: 'scheduled' }, 'scheduled password change');
    }
  }

  // #32 autoscaling: the apps that asked for it get a copy more when slow or busy, one fewer after 30 calm minutes
  private autoscale() {
    void import('./autoscale.ts').then(async ({ plans }) => {
      for (const p of plans(this.app)) {
        const key = `scale:${p.serviceId}`;
        if (this.busy.has(key)) continue;
        this.busy.add(key);
        const r = await this.act(p.orgId, 'service.scale', { serviceId: p.serviceId, replicas: p.replicas }, `autoscale: ${p.why}`).finally(() => this.busy.delete(key));
        if (r.status === 'ok') {
          run(this.app.db, `UPDATE services SET config = json_set(config, '$.autoscale.lastChange', ?, '$.autoscale.lastWhy', ?) WHERE id = ?`, now(), `${p.from} → ${p.replicas}: ${p.why}`, p.serviceId);
          this.app.events.emit(p.orgId, 'service.autoscaled', `${p.name}: ${p.from} → ${p.replicas} copies (${p.why})`, { severity: 'info', resource: p.serviceId });
        }
      }
    }).catch((e) => console.error('autoscale', e));
  }

  // #30 everything on the map, from the outside: sites every 5 minutes; certificates, registrations and email daily
  private watchOutside() {
    const daily = this.sweeps % 1440 === 10;
    if (this.sweeps % 5 !== 1 && !daily) return;
    for (const o of all<{ org_id: string }>(this.app.db, `SELECT DISTINCT org_id FROM assets`)) {
      const key = `watch:${o.org_id}`;
      if (this.busy.has(key)) continue;
      this.busy.add(key);
      void import('./watch.ts').then(async (w) => { await w.checkSites(this.app, o.org_id); if (daily) await w.checkDaily(this.app, o.org_id); })
        .catch((e) => console.error('watch', e)).finally(() => this.busy.delete(key));
    }
  }

  syncOrg(orgId: string) {
    const key = `sync:${orgId}`;
    if (this.busy.has(key) || syncRunning(this.app.db, orgId)) return; // never two syncs at once (one started by hand counts)
    this.busy.add(key);
    void this.act(orgId, 'sync.run', {}, 'keeping the map current')
      .then(() => this.act(orgId, 'link.autoconnect', {}, 'connecting what belongs together'))
      .finally(() => this.busy.delete(key));
  }

  // #26 scheduled jobs: run each one that's due, never two runs of the same job at once
  private runDueJobs() {
    for (const j of all<{ id: string; org_id: string; schedule: string; last_run_at: string | null }>(this.app.db, 'SELECT id, org_id, schedule, last_run_at FROM jobs')) {
      let due = false;
      try { due = nextRun(j.schedule, j.last_run_at ? new Date(j.last_run_at) : null) <= new Date(); } catch { continue; }
      const key = `job:${j.id}`;
      if (!due || this.busy.has(key)) continue;
      this.busy.add(key);
      void this.act(j.org_id, 'job.run', { jobId: j.id }, 'scheduled job').finally(() => this.busy.delete(key));
    }
  }

  // #37 the weekly security check: read-only, across everything; the check itself alerts on new critical or high findings
  private weeklySecurity() {
    void import('../tools/security.ts').then(({ weeklyDue }) => {
      for (const orgId of weeklyDue(this.app.db)) {
        const key = `security:${orgId}`;
        if (this.busy.has(key)) continue;
        this.busy.add(key);
        void this.act(orgId, 'security.check', {}, 'weekly security check').finally(() => this.busy.delete(key));
      }
    }).catch(logged('weekly security check'));
  }

  private async sevenNow() {
    if (this.busy.has('seven')) return;
    this.busy.add('seven');
    try { await (await import('../seven/index.ts')).sevenTick(this.app); } catch (e) { logged('seven')(e); } finally { this.busy.delete('seven'); }
  }
  private catchUp(gap: { from: number; to: number }) {
    for (const o of all<{ id: string }>(this.app.db, `SELECT DISTINCT org_id id FROM servers WHERE status = 'ready'`)) void this.act(o.id, 'catchup.read', { from: new Date(gap.from).toISOString(), to: new Date(gap.to).toISOString() }, 'back from sleep');
  }
  // at most once a day per server: an emergency copy of everything is heavy
  private async launch(orgId: string, serverId: string, why: string) {
    if (get(this.app.db, `SELECT 1 FROM audit WHERE org_id = ? AND tool = 'safety.lifeboat' AND created_at > ? AND json_extract(input, '$.serverId') = ?`, orgId, new Date(Date.now() - 86400_000).toISOString(), serverId)) return;
    await this.act(orgId, 'safety.lifeboat', { serverId, why }, why);
  }
  // danger on the way: a plan or domain about to end with no auto-renew. A full disk isn't a reason: a copy could fill it, so that one asks a person.
  private async lifeboatNow() {
    const { expiries } = await import('../care/expiry.ts'), { mayCopy } = await import('../care/safetynet.ts');
    for (const s of all<{ id: string; org_id: string }>(this.app.db, `SELECT id, org_id FROM servers WHERE status = 'ready'`)) {
      const ending = expiries(this.app.db, s.org_id).find((e) => e.days >= 0 && e.days <= 3 && !e.renews && e.kind !== 'key');
      if (ending && mayCopy(this.app.db, s.org_id, s.id)) await this.launch(s.org_id, s.id, `${ending.name} runs out in ${ending.days} day${ending.days === 1 ? '' : 's'}`);
    }
  }
  // Asked for by a deploy or a serious alert: it runs a little later, so what's asked about has settled, and never twice in 30 minutes
  private checkupsSoon = new Map<string, number>();
  private async seeDeploys() {
    for (const o of all<{ id: string }>(this.app.db, `SELECT DISTINCT a.org_id id FROM accounts a WHERE a.provider = 'coolify'`)) {
      const r = await this.act(o.id, 'deploys.sync', {}, 'what Coolify deployed');
      if (r.status !== 'ok') continue;
      const { copyWorthTaking } = await import('../care/deploywatch.ts'), { mayCopy } = await import('../care/safetynet.ts');
      for (const d of (r.output as { seen: import('../care/deploywatch.ts').Deploy[] }).seen) {
        this.checkupsSoon.set(o.id, Date.now() + 30 * 60_000);
        if (/fail|error/i.test(d.status)) void this.act(o.id, 'deploys.explain', { serverId: d.serverId, uuid: d.uuid, deployment: d.deployment }, 'a deploy failed');
        if (!d.fresh || !copyWorthTaking(this.app.db, o.id, d) || !mayCopy(this.app.db, o.id, d.serverId)) continue;
        this.app.events.emit(o.id, 'safety.deploy_copy', `Taking a fresh copy because ${d.name} is deploying`, { resource: d.project ?? d.uuid });
        void this.act(o.id, 'safety.copy', { serverId: d.serverId, ...(d.project && { project: d.project }), reason: `before ${d.name}’s deploy` }, 'a deploy started').catch(() => undefined);
      }
    }
  }
  private async checkupNow() {
    if (this.busy.has('checkup')) return;
    this.busy.add('checkup');
    try {
      const { checkupDue } = await import('../care/checkup.ts'), { quietHourOf } = await import('../care/safetynet.ts');
      for (const o of all<{ id: string }>(this.app.db, 'SELECT id FROM orgs WHERE paused_at IS NULL')) {
        const server = get<{ id: string }>(this.app.db, `SELECT id FROM servers WHERE org_id = ? AND status = 'ready' ORDER BY created_at LIMIT 1`, o.id);
        const soon = this.checkupsSoon.get(o.id), recent = get(this.app.db, `SELECT 1 FROM checkups WHERE org_id = ? AND created_at > ?`, o.id, new Date(Date.now() - 30 * 60_000).toISOString());
        const due = checkupDue(this.app.db, o.id, Date.now(), server ? quietHourOf(this.app.db, server.id).calmNow : true) ?? (soon && soon <= Date.now() && !recent ? { quick: true } : undefined);
        if (!due) continue;
        this.checkupsSoon.delete(o.id);
        await this.act(o.id, 'checkup.run', due, due.quick ? 'the daily check-up' : 'the weekly check-up');
      }
    } catch (e) { logged('check-up')(e); } finally { this.busy.delete('checkup'); }
  }

  private safetyNow() {
    if (this.busy.has('safety')) return;
    this.busy.add('safety');
    void import('../care/safetynet.ts').then(({ safetyTick }) => safetyTick(this.app, (org, tool, input, reason) => this.act(org, tool, input, reason)))
      .catch(logged('safety net')).finally(() => this.busy.delete('safety'));
  }

  // Safe fixes (marked safe, with an undo) Warden runs by itself at "Fix itself" or higher, as itself through the gate,
  // within its limits. One pass per organisation at a time.
  async autofixNow() {
    const { autofixPass } = await import('../tools/autofix.ts');
    for (const o of all<{ id: string }>(this.app.db, 'SELECT id FROM orgs WHERE autofix = 1 AND paused_at IS NULL')) {
      const key = `autofix:${o.id}`;
      if (this.busy.has(key)) continue;
      this.busy.add(key);
      await autofixPass(this.app, o.id, (org, tool, input, reason, extra) => this.act(org, tool, input, reason, extra)).catch(logged('autofix')).finally(() => this.busy.delete(key));
    }
  }
  // Restart windows a person set: looked at every minute (a trip to a server only near its window)
  // Keep it fresh: what's due (src/fresh/tick.ts decides; each run goes through the gate as Warden). Coolify images hourly.
  async freshNow() {
    if (this.busy.has('fresh')) return [];
    this.busy.add('fresh');
    try {
      const { freshTick, coolifyImages } = await import('../fresh/tick.ts');
      const act = (org: string, tool: string, input: unknown, reason: string) => this.act(org, tool, input, reason);
      if (this.sweeps % 60 === 31) void coolifyImages(this.app, act).catch(logged('keep it fresh: Coolify images'));
      return await freshTick(this.app, act);
    } catch (e) { logged('keep it fresh')(e); return []; } finally { this.busy.delete('fresh'); }
  }
  async rebootNow() {
    if (this.busy.has('reboots')) return [];
    this.busy.add('reboots');
    try {
      const { rebootTick } = await import('../tools/reboot.ts');
      return await rebootTick(this.app, (org, tool, input, reason) => this.act(org, tool, input, reason));
    } catch (e) { logged('restart windows')(e); return []; } finally { this.busy.delete('reboots'); }
  }

  // #24 vulnerabilities appear in old images without any deploy: re-scan each running app weekly
  private rescanImages() {
    for (const a of all<{ id: string; org_id: string; plan: string }>(this.app.db, `SELECT s.id, s.org_id, d.plan FROM services s JOIN deployments d ON d.id = s.current_deployment_id
        WHERE d.status = 'live' AND d.image IS NOT NULL AND s.kind NOT IN ('postgres','mysql','mariadb','mongo','redis')`)) {
      const at = json<{ security?: { scannedAt?: string } }>(a.plan, {}).security?.scannedAt;
      const key = `scan:${a.id}`;
      if (this.busy.has(key) || (at && Date.now() - Date.parse(at) < 7 * 86400_000)) continue;
      this.busy.add(key);
      void this.act(a.org_id, 'security.scan', { serviceId: a.id }, 'weekly vulnerability scan').finally(() => this.busy.delete(key));
    }
  }

  // keep one-click provider sign-ins alive: refresh tokens a few minutes before they expire. A refresh the
  // provider refuses is final (the person reconnects); one that fails otherwise waits longer each time.
  private refreshWait = new Map<string, { until: number; fails: number }>();
  private async refreshSignIns() {
    const { accessToken } = await import('../connectors/mcp-oauth.ts');
    for (const a of all<{ id: string; org_id: string; meta: string }>(this.app.db, `SELECT id, org_id, meta FROM accounts WHERE json_extract(meta, '$.auth') = 'oauth' AND status != 'failing'`)) {
      const ref = json<{ ref?: string }>(a.meta, {}).ref;
      const w = this.refreshWait.get(a.id);
      if (!ref || (w && w.until > Date.now())) continue;
      try {
        if (JSON.parse(this.app.vault.resolve(a.org_id, ref)).expires_at - Date.now() > 5 * 60_000) continue;
        // 5 minutes early for real (a tool call refreshing at the same moment shares this one refresh)
        await accessToken(`${a.org_id}:${ref}`, () => this.app.vault.resolve(a.org_id, ref), (s) => this.app.vault.put(a.org_id, ref, JSON.stringify(s), { kind: 'oauth', accountId: a.id, by: 'token refresh' }), 5 * 60_000);
        this.refreshWait.delete(a.id);
      } catch (e) {
        if (providerTrouble(e) === 'auth') { this.refreshWait.delete(a.id); noteAccountTrouble(this.app, a.id, e); continue; }
        const fails = (w?.fails ?? 0) + 1;
        this.refreshWait.set(a.id, { until: Date.now() + JOB_WAITS[Math.min(fails, JOB_WAITS.length) - 1]!, fails });
      }
    }
  }

  // Open an incident and, if autonomy allows, let the agent brain investigate and fix it.
  private openIncident(orgId: string, s: ServerRow, title: string, brief: string, type: string, serviceId?: string) {
    const key = `incident:${s.id}:${type}`;
    if (this.flags.get(key) && Date.now() - this.flags.get(key)!.since < 30 * 60_000) return; // one open incident per condition per 30m
    this.flags.set(key, { count: 1, since: Date.now(), lastActed: Date.now() });
    const incidentId = id('inc');
    run(this.app.db, `INSERT INTO incidents (id, org_id, project_id, environment_id, title, status, severity, trigger_event) VALUES (?, ?, NULL, NULL, ?, 'open', 'warning', ?)`, incidentId, orgId, title, type);
    this.app.events.emit(orgId, 'incident.opened', `Incident: ${title} on ${s.name}`, { severity: 'critical', resource: incidentId, data: { incidentId, type } });
    this.investigate(orgId, incidentId, `Incident on ${s.name}: ${title}`, `An incident was detected. ${brief} Investigate using the read tools, fix it if you safely can within policy, then summarise what happened. Server: ${s.name} (${s.id}).${serviceId ? ` Service: ${serviceId}.` : ''}`).catch(logged('incident'));
  }

  // Judgment calls go to a brain: Unit7's own model if one is connected, otherwise your own AI through
  // the inbox (the Claude Code running /unit7 watch picks it up). Its actions still pass the gate.
  private async investigate(orgId: string, incidentId: string, title: string, brief: string) {
    const { escalate } = await import('../agent/escalate.ts');
    const r = await escalate(this.app, orgId, title, brief);
    run(this.app.db, `UPDATE incidents SET status = CASE WHEN ? = 'unit7' THEN 'investigated' ELSE status END, report = ? WHERE id = ?`, r.via, r.via === 'unit7' ? `See conversation ${r.conversationId}` : `Handed to your AI (conversation ${r.conversationId})`, incidentId);
  }
}

export function warden(app: App): Warden {
  return ((app.services.warden as Warden | undefined) ??= new Warden(app));
}
