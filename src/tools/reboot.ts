// Reboot windows. Security updates sometimes need a restart to take effect. A person sets a window per server ("Sundays
// 03:00–04:00, server time"); that counts as their OK for restarts inside it. When the server says it needs one, Warden
// warns 10 minutes before (Activity and the phone), takes a fresh backup of Unit7's databases on it, restarts it through
// the gate as Warden (the server_restart action), waits for SSH and every site that answered before, and says how it
// went. Something that doesn't come back opens an incident with the Doctor's look attached. Never outside the window,
// never two servers of one organisation at once, never during a deploy, never while Autopilot is paused. Without a
// window a restart is a change to something live: an AI asks a person first, as before.
import { z } from 'zod';
import type { App } from '../app.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { defineTool, execute, type Ctx, type ToolResult } from './runtime.ts';
import { fid, requireHuman } from './helpers.ts';
import { serverRow, type Facts } from './servers.ts';
import { listening, ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { probe } from '../sentinel/watch.ts';
import { lastXray } from './xray.ts';
import { proxyOf } from '../deploy/caddy.ts';

// --- the window ---------------------------------------------------------------------------------------------------------
// days: 0 = Sunday … 6 = Saturday, on the server's clock; offset: the server's UTC offset in minutes, as it last said
export interface Window { days: number[]; start: string; minutes: number; offset: number | null }
interface Row { server_id: string; org_id: string; days: string; start: string; minutes: number; utc_offset: number | null; set_by: string | null; warned_for: number | null; warned_at: string | null; tried_for: number | null; last_reboot_at: string | null; last_result: string | null }
const windowRow = (db: DB, serverId: string) => get<Row>(db, 'SELECT * FROM reboot_windows WHERE server_id = ?', serverId);
const asWindow = (r: Row): Window => ({ days: json<number[]>(r.days, []), start: r.start, minutes: r.minutes, offset: r.utc_offset });

// The window that's on now, or the next one: its start and end in UTC milliseconds
export function windowAt(w: Window, nowMs: number): { inside: boolean; start: number; end: number } {
  const off = (w.offset ?? 0) * 60_000, local = new Date(nowMs + off); // read with getUTC*: the server's wall clock
  const [h, m] = w.start.split(':').map(Number) as [number, number];
  for (let d = -1; d <= 7; d++) { // yesterday's may still be on (a window past midnight)
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, h, m));
    if (!w.days.includes(day.getUTCDay())) continue;
    const start = day.getTime() - off, end = start + w.minutes * 60_000;
    if (end > nowMs) return { inside: nowMs >= start, start, end };
  }
  return { inside: false, start: Infinity, end: Infinity };
}

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export function windowWords(w: Window) {
  const [h, m] = w.start.split(':').map(Number) as [number, number];
  const days = w.days.length === 7 ? 'Every day' : w.days.length === 5 && [1, 2, 3, 4, 5].every((d) => w.days.includes(d)) ? 'Weekdays'
    : w.days.length === 2 && w.days.includes(0) && w.days.includes(6) ? 'Weekends' : w.days.map((d) => DAY_NAMES[d]).join(', ').replace(/, ([^,]+)$/, ' and $1');
  return `${days} ${w.start}–${hhmm(h * 60 + m + w.minutes)}, server time`;
}

// --- does it need a restart? ------------------------------------------------------------------------------------------
// Debian and Ubuntu leave /var/run/reboot-required; Fedora, Rocky and Alma answer needs-restarting -r. The clock's
// offset comes back too (the window is in server time), and the boot id, which changes with every restart.
export const PROBE = `[ -f /var/run/reboot-required ] && echo reboot=yes
command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo reboot=yes; }
echo "offset=$(date +%z)"; echo "boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"`;
export function parseProbe(out: string): { reboot: boolean; offset?: number; boot?: string } {
  const kv = Object.fromEntries(out.split('\n').map((l) => l.trim().split('=') as [string, string]).filter((p) => p.length === 2));
  const z = /^([+-])(\d{2})(\d{2})$/.exec(kv.offset ?? '');
  const offset = z ? (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) : undefined;
  // what a server prints is untrusted: an offset outside the real range is ignored, a boot id must look like one
  return { reboot: kv.reboot === 'yes', ...(offset !== undefined && Math.abs(offset) <= 14 * 60 && { offset }), ...(/^[0-9a-f-]{36}$/.test(kv.boot ?? '') && { boot: kv.boot }) };
}
const seen = new Map<string, { at: number; reboot: boolean }>(); // the last look per server (looked at most every 5 minutes)
export async function needsReboot(app: App, s: ServerRow, nowMs = Date.now()): Promise<boolean> {
  const last = seen.get(s.id);
  if (last && nowMs - last.at < 5 * 60_000) return last.reboot;
  let reboot: boolean;
  try {
    const p = parseProbe(await ssh(app).check(s, script(PROBE), { what: 'Checking for updates that need a restart', timeoutMs: 20_000 }));
    if (p.offset !== undefined) run(app.db, 'UPDATE reboot_windows SET utc_offset = ? WHERE server_id = ?', p.offset, s.id);
    reboot = p.reboot;
  } catch {
    // couldn't ask: the latest security check (of the last week) may have said so
    const f = get<{ findings: string }>(app.db, 'SELECT findings FROM security_reports WHERE org_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1', s.org_id, new Date(nowMs - 7 * 86400_000).toISOString());
    reboot = json<{ id: string }[]>(f?.findings, []).some((x) => x.id === `server:reboot:${s.id}`);
  }
  seen.set(s.id, { at: nowMs, reboot });
  return reboot;
}

// --- guards -------------------------------------------------------------------------------------------------------------
export const deployRunning = (db: DB, serverId: string) => !!get(db, `SELECT 1 FROM deployments d JOIN services s ON s.id = d.service_id
  WHERE s.server_id = ? AND d.status IN ('queued', 'building', 'deploying') AND d.started_at > ? LIMIT 1`, serverId, new Date(Date.now() - 3 * 3600_000).toISOString());
export const restarting = new Set<string>(); // organisations with a server restarting right now (one at a time)
const coolifyOn = (db: DB, s: ServerRow) => !!lastXray(db, s.org_id, s.id)?.data?.coolify || proxyOf(json<Facts>(s.facts, {})).kind === 'coolify';

// the sites to wait for: Unit7's own domains on this server, and the ones the X-ray found routed here
export function sitesOn(db: DB, orgId: string, serverId: string): string[] {
  const own = all<{ hostname: string }>(db, `SELECT d.hostname FROM domains d JOIN services s ON s.id = d.service_id WHERE s.server_id = ? AND d.org_id = ?`, serverId, orgId).map((d) => d.hostname);
  const found = (lastXray(db, orgId, serverId)?.data?.parts ?? []).flatMap((p) => (p.kind === 'domain' ? [p.name] : p.hosts ?? []));
  return [...new Set([...own, ...found].map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)))].slice(0, 30);
}

// waits made for tests to shorten (the real ones are minutes)
export const rebootDeps = {
  probe: (host: string) => probe(host), listening, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  pollMs: 5000, downMs: 3 * 60_000, upMs: 10 * 60_000, sitesMs: 5 * 60_000,
};
async function until(ok: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    if (await ok().catch(() => false)) return true;
    if (Date.now() >= end) return false;
    await rebootDeps.sleep(rebootDeps.pollMs);
  }
}
const REBOOT = `SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"
$SU systemd-run --on-active=3 --quiet systemctl reboot 2>/dev/null || { ( sleep 3; $SU reboot ) >/dev/null 2>&1 & }
echo ok`;
const dur = (s: number) => (s < 90 ? `${s} seconds` : `${Math.round(s / 60)} minutes`);

// an incident, with the Doctor's look at the server attached
async function incident(ctx: Ctx, s: ServerRow, title: string) {
  const d = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.diagnose', { serverId: s.id }, { reason: 'after a restart' }).catch(() => undefined);
  const diagnosis = d?.status === 'ok' ? d.output as { cause: string; title: string; explain: string; fixes: { id: string; label: string }[] } : undefined;
  const incidentId = id('inc');
  run(ctx.db, `INSERT INTO incidents (id, org_id, project_id, environment_id, title, status, severity, trigger_event, report) VALUES (?, ?, NULL, NULL, ?, 'open', 'critical', 'reboot.failed', ?)`,
    incidentId, ctx.orgId, title, diagnosis ? `${diagnosis.title}. ${diagnosis.explain}` : null);
  ctx.emit('incident.opened', `Incident: ${title}${diagnosis ? `. ${diagnosis.title.replace(/\.$/, '')}.${diagnosis.fixes[0] ? ` Unit7 can fix it: ${diagnosis.fixes[0].label}, on the server’s page.` : ''}` : ''}`,
    { severity: 'critical', resource: s.id, data: { incidentId, type: 'reboot.failed', serverId: s.id, ...(diagnosis && { diagnosis }) } });
  return incidentId;
}

async function restart(ctx: Ctx, s: ServerRow) {
  const pool = ssh(ctx.app), deps = rebootDeps;
  // 1. a fresh backup of every database Unit7 runs here; no restart without one
  for (const d of all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM services WHERE server_id = ? AND org_id = ? AND kind IN ('postgres','mysql','mariadb','mongo','redis')`, s.id, ctx.orgId)) {
    ctx.progress(`Backing up ${d.name} first…`);
    const b = await execute(ctx.app, ctx.orgId, ctx.actor, 'backup.create', { serviceId: d.id, reason: 'before restarting the server' }, { reason: 'a fresh backup before a restart' });
    if (b.status !== 'ok') throw new Unit7Error('backup_failed', `Didn’t restart ${s.name}: the backup of ${d.name} didn’t work first (${b.status === 'error' ? b.error.message : 'why' in b ? b.why : b.status}). Nothing was restarted.`, 409);
  }
  // 2. which sites answer now (those are the ones to wait for afterwards)
  const before = sitesOn(ctx.db, ctx.orgId, s.id);
  const answered = (await Promise.all(before.map(async (h) => ((await deps.probe(h).catch(() => ({ ok: false }))).ok ? h : '')))).filter(Boolean);
  const boot = parseProbe(await pool.check(s, script(PROBE), { what: 'Reading the server', timeoutMs: 20_000 })).boot;
  // apps that also run on other servers (src/fleet) stop sending visitors here first, and get them back afterwards
  const { leaveRotation, rejoinRotation } = await import('../fleet/traffic.ts');
  const rotated = await leaveRotation(ctx, s.id);
  // 3. restart (the connection may drop on the way down)
  ctx.progress(`Restarting ${s.name}…`);
  const was = s.status;
  run(ctx.db, `UPDATE servers SET status = 'rebooting' WHERE id = ?`, s.id);
  const t0 = Date.now();
  await pool.exec(s, script(REBOOT), { timeoutMs: 20_000 }).catch(() => undefined);
  pool.close(s.id);
  // 4. down, then SSH back, then signed in again on a new boot
  ctx.progress(`Waiting for ${s.name} to come back…`);
  await until(async () => !(await deps.listening(s.host, s.port, 3000)), deps.downMs); // a quick one may be back before Unit7 looks: the boot id tells
  let fresh: string | undefined;
  const back = await until(async () => {
    if (!(await deps.listening(s.host, s.port, 3000))) return false;
    pool.answered(s.id); // it answers: no waiting out the backoff from the restart
    fresh = parseProbe(await pool.check(s, script(PROBE), { what: 'Signing in after the restart', timeoutMs: 20_000 })).boot;
    return true;
  }, deps.upMs);
  const seconds = Math.round((Date.now() - t0) / 1000);
  if (!back) {
    // Warden keeps looking (and says when it's back)
    run(ctx.db, `UPDATE servers SET status = 'unreachable', facts = json_set(facts, '$.wardenDown', ?) WHERE id = ?`, now(), s.id);
    run(ctx.db, 'UPDATE reboot_windows SET last_reboot_at = ?, last_result = ? WHERE server_id = ?', now(), 'not back', s.id);
    await incident(ctx, s, `${s.name} didn’t come back after restarting`);
    throw new Unit7Error('not_back', `${s.name} didn’t come back within ${dur(Math.round(deps.upMs / 1000))} of restarting. Unit7 opened an incident with its health check attached.`, 502);
  }
  run(ctx.db, `UPDATE servers SET status = ? WHERE id = ? AND status = 'rebooting'`, was === 'rebooting' ? 'ready' : was, s.id);
  if (boot && fresh === boot) {
    run(ctx.db, 'UPDATE reboot_windows SET last_result = ? WHERE server_id = ?', 'didn’t restart', s.id);
    await rejoinRotation(ctx, s.id, rotated);
    throw new Unit7Error('not_restarted', `${s.name} was asked to restart but didn’t (it’s been up the whole time). Nothing else changed.`, 502);
  }
  // 5. every site that answered before
  ctx.progress(answered.length ? `Checking ${answered.length} site${answered.length === 1 ? '' : 's'} came back…` : 'Done.');
  const down: string[] = [];
  await Promise.all(answered.map(async (h) => { if (!(await until(async () => (await deps.probe(h)).ok, deps.sitesMs))) down.push(h); }));
  run(ctx.db, 'UPDATE reboot_windows SET last_reboot_at = ?, last_result = ? WHERE server_id = ?', now(), down.length ? `${down.length} site${down.length === 1 ? '' : 's'} down` : 'ok', s.id);
  seen.delete(s.id);
  if (down.length) {
    await incident(ctx, s, `${down.slice(0, 3).join(', ')} didn’t come back after ${s.name} restarted`);
    ctx.emit('reboot.done', `Restarted ${s.name}: it was back in ${dur(seconds)}, but ${down.join(', ')} ${down.length === 1 ? 'doesn’t' : 'don’t'} answer yet. Unit7 opened an incident.`, { severity: 'warning', resource: s.id, data: { seconds, down } });
    return { restarted: true, seconds, sites: answered.filter((h) => !down.includes(h)), down };
  }
  await rejoinRotation(ctx, s.id, rotated);
  ctx.emit('reboot.done', `Restarted ${s.name} to finish its updates: back in ${dur(seconds)}${answered.length ? `, and ${answered.length === 1 ? 'its site answers' : `all ${answered.length} sites answer`}` : ''}.`, { severity: 'success', resource: s.id, data: { seconds } });
  return { restarted: true, seconds, sites: answered, down };
}

// --- tools --------------------------------------------------------------------------------------------------------------
const wardenActor = (a: Ctx['actor']) => a.kind === 'agent' && a.id === 'warden' && a.userId === null;

defineTool({
  // the window is a person's OK for restarts inside it, so only a person sets it
  name: 'reboot.window', title: 'Set a server’s restart window', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'People only. When updates need a restart, Unit7 restarts this server inside this window (server time), after a 10-minute warning and a fresh backup, and checks everything comes back. off: true removes it; then a restart waits for a person, as before.',
  input: z.object({
    serverId: fid('srv'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 03:00').optional(),
    minutes: z.number().int().min(15).max(360).default(60), off: z.boolean().default(false),
  }),
  async run(ctx, i) {
    requireHuman(ctx, 'set when a server may restart');
    const s = serverRow(ctx, i.serverId);
    if (i.off) {
      run(ctx.db, 'DELETE FROM reboot_windows WHERE server_id = ?', s.id);
      ctx.emit('reboot.window', `${ctx.actor.name} removed ${s.name}’s restart window. A restart waits for a person now.`, { resource: s.id });
      return rebootView(ctx.db, s);
    }
    if (!i.days || !i.start) throw new Unit7Error('invalid_input', 'Pick the days and the start time.', 400);
    // the server's own clock, when it answers (Warden keeps it current)
    const offset = await ssh(ctx.app).check(s, script(PROBE), { timeoutMs: 15_000 }).then((o) => parseProbe(o).offset ?? null, () => windowRow(ctx.db, s.id)?.utc_offset ?? null);
    run(ctx.db, `INSERT INTO reboot_windows (server_id, org_id, days, start, minutes, utc_offset, set_by) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (server_id) DO UPDATE SET days = excluded.days, start = excluded.start, minutes = excluded.minutes, utc_offset = coalesce(excluded.utc_offset, reboot_windows.utc_offset), set_by = excluded.set_by, warned_for = NULL, tried_for = NULL`,
      s.id, ctx.orgId, JSON.stringify([...new Set(i.days)].sort()), i.start, i.minutes, offset, ctx.actor.name);
    const v = rebootView(ctx.db, s);
    ctx.emit('reboot.window', `${ctx.actor.name} set ${s.name}’s restart window: ${v.words}. Unit7 restarts it there when updates need it.`, { resource: s.id });
    return v;
  },
});

export function rebootView(db: DB, s: ServerRow, nowMs = Date.now()) {
  const r = windowRow(db, s.id), w = r && asWindow(r), at = w && windowAt(w, nowMs);
  return {
    server: s.name, window: w ? { days: w.days, start: w.start, minutes: w.minutes } : null, words: w ? windowWords(w) : null,
    clockKnown: w ? w.offset !== null : undefined, inside: at?.inside ?? false, next: at && Number.isFinite(at.start) ? new Date(at.start).toISOString() : null,
    needsRestart: seen.get(s.id)?.reboot ?? null, coolify: coolifyOn(db, s), setBy: r?.set_by ?? null, lastRestart: r?.last_reboot_at ?? null, lastResult: r?.last_result ?? null,
  };
}

defineTool({
  name: 'reboot.status', title: 'A server’s restart window', risk: 'read', action: 'read',
  description: 'The restart window a person set for a server (server time), when the next one is, and whether updates are waiting for a restart (looked at by Warden near the window).',
  input: z.object({ serverId: fid('srv') }),
  run: (ctx, i) => rebootView(ctx.db, serverRow(ctx, i.serverId)),
});

defineTool({
  name: 'server.reboot', title: 'Restart a server', risk: 'write', action: 'server_restart', timeoutMs: 25 * 60_000,
  // inside the window a person set, Warden's own scheduled restart is theirs already (easy to undo: it comes back by
  // itself); any other AI, and any restart outside it, is a change to something live, so it asks a person first
  assess: (c, i) => {
    const r = windowRow(c.db, i.serverId), inside = !!r && windowAt(asWindow(r), Date.now()).inside;
    return { tier: inside && wardenActor(c.actor) ? 1 : 2, impact: `${inside ? `Inside the restart window a person set (${windowWords(asWindow(r!))}). ` : ''}The server is offline for a minute or two; Unit7 backs up its databases first and checks every site comes back.` };
  },
  description: 'Restart a server (for updates that need it): a fresh backup of Unit7’s databases on it first, then the restart, then a wait for SSH and every site that answered before. Something that doesn’t come back opens an incident with the health check attached. Refuses during a deploy, or while another server of yours restarts. Inside the restart window a person set it runs by itself; otherwise an AI asks first.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const r = windowRow(ctx.db, s.id);
    // Warden restarts only inside the window a person set
    if (ctx.actor.id === 'warden' && (!r || !windowAt(asWindow(r), Date.now()).inside)) throw new Unit7Error('outside_window', `Warden only restarts ${s.name} inside the restart window a person set.`, 409);
    if (deployRunning(ctx.db, s.id)) throw new Unit7Error('busy', `A deploy is running on ${s.name}. Restart it once that’s done.`, 409);
    if (restarting.has(ctx.orgId)) throw new Unit7Error('busy', 'Another of your servers is restarting right now. One at a time.', 409);
    // an app on several servers whose others are out or sick: this one is the last serving it, so Warden's restart waits
    if (wardenActor(ctx.actor)) {
      const last = (await import('../fleet/care.ts')).restartWouldDown(ctx.db, s.id);
      if (last.length) throw new Unit7Error('last_server', `Warden waits to restart ${s.name}: it’s the only server serving ${last.join(', ')} right now.`, 409);
    }
    // Warden's restart in the window (the only one that runs without asking): only when the server says it needs one,
    // 10 minutes after the warning for this window, and once per window (the restart uses the warning up)
    if (wardenActor(ctx.actor)) {
      const at = windowAt(asWindow(r!), Date.now());
      if (r!.warned_for !== at.start || Date.now() - Date.parse(r!.warned_at ?? '') < 9.5 * 60_000) throw new Unit7Error('not_warned', `Warden restarts ${s.name} only 10 minutes after saying so.`, 409);
      if (!(await needsReboot(ctx.app, s))) throw new Unit7Error('not_needed', `${s.name} doesn’t need a restart, so Warden leaves it running.`, 409);
      if (!run(ctx.db, 'UPDATE reboot_windows SET warned_for = NULL WHERE server_id = ? AND warned_for = ?', s.id, at.start).changes) throw new Unit7Error('not_warned', `Warden already restarted ${s.name} in this window.`, 409);
    }
    restarting.add(ctx.orgId);
    try { return await restart(ctx, s); } finally { restarting.delete(ctx.orgId); }
  },
});

// --- Warden's minute: warn 10 minutes before, then restart inside the window -----------------------------------------
export async function rebootTick(app: App, act: (orgId: string, tool: string, input: unknown, reason: string) => Promise<ToolResult>, nowMs = Date.now()) {
  const started = new Set<string>(), pending: Promise<ToolResult>[] = [];
  // a restart cut short (Unit7 itself stopped mid-way) leaves "rebooting": Warden watches it again, and says if it's down
  for (const o of all<{ id: string; org_id: string }>(app.db, `SELECT id, org_id FROM servers WHERE status = 'rebooting'`)) if (!restarting.has(o.org_id)) run(app.db, `UPDATE servers SET status = 'ready' WHERE id = ?`, o.id);
  for (const r of all<Row & { status: string; name: string }>(app.db, `SELECT w.*, s.status, s.name FROM reboot_windows w JOIN servers s ON s.id = w.server_id`)) {
    if (r.status !== 'ready' || started.has(r.org_id) || restarting.has(r.org_id)) continue;
    if (get(app.db, 'SELECT 1 FROM orgs WHERE id = ? AND paused_at IS NOT NULL', r.org_id)) continue;
    const w = asWindow(r), at = windowAt(w, nowMs);
    if (r.tried_for === at.start || (!at.inside && at.start - nowMs > 15 * 60_000)) continue; // one try per window; nothing to do until it's near
    const s = get<ServerRow>(app.db, 'SELECT * FROM servers WHERE id = ?', r.server_id)!;
    if (!(await needsReboot(app, s, nowMs))) continue;
    if (r.warned_for !== at.start) {
      if (at.inside || at.start - nowMs <= 10 * 60_000) {
        run(app.db, 'UPDATE reboot_windows SET warned_for = ?, warned_at = ? WHERE server_id = ?', at.start, new Date(nowMs).toISOString(), s.id);
        app.events.emit(s.org_id, 'reboot.soon', `${s.name} restarts in 10 minutes to finish its updates (its window: ${windowWords(w)}). Unit7 backs up its databases first and checks every site comes back.${coolifyOn(app.db, s) ? ' Coolify’s apps restart too; they come back by themselves.' : ''}`,
          { severity: 'warning', resource: s.id, data: { at: new Date(Math.max(nowMs + 10 * 60_000, at.start)).toISOString() } });
      }
      continue;
    }
    // ten minutes after the warning, inside the window, with time left, nothing deploying, nothing else restarting
    if (!at.inside || nowMs - Date.parse(r.warned_at ?? '') < 9.5 * 60_000 || at.end - nowMs < 5 * 60_000 || deployRunning(app.db, s.id)) continue;
    if (get(app.db, `SELECT 1 FROM servers WHERE org_id = ? AND status = 'rebooting'`, s.org_id)) continue;
    run(app.db, 'UPDATE reboot_windows SET tried_for = ? WHERE server_id = ?', at.start, s.id);
    started.add(s.org_id);
    pending.push(act(s.org_id, 'server.reboot', { serverId: s.id }, 'updates need a restart, inside the window a person set'));
  }
  return pending;
}
