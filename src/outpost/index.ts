// Installing, reading and removing the Outpost, the Mac's stay-awake switch, the outside heartbeat, catching up after a sleep, and the
// lifeboat. On a Mac that sleeps, these are the difference between "when asked" and "by itself".
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { App } from '../app.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { defineTool, type Ctx } from '../tools/runtime.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { fid, requireHuman } from '../tools/helpers.ts';
import { Unit7Error } from '../errors.ts';
import { makeRef } from '../vault.ts';
import { serverRow } from '../tools/servers.ts';
import { lastXray } from '../tools/xray.ts';
import { copyOffsite } from '../tools/offsite.ts';
import { manageDirs, ROOM_PROBE, roomVerdict } from '../tools/manage.ts';
import { storeRows } from '../sentinel/usage.ts';
import { blindMs, gapsIn } from '../sentinel/gaps.ts';
import { inBusyHours, protectionOf, quietHourOf, settingsOf } from '../care/safetynet.ts';
import { assertReachable } from '../netguard.ts';
import { engineOf } from '../discovery/xray.ts';
import { BACKUPS, CRON, CRON_LINE, DIR, OUTPOST, configOf, jobsOf, parseReadings, uncovered, type Config } from './script.ts';

const HEART = makeRef('heartbeat', 'unit7', 'url');
const asRoot = (s: ServerRow) => (json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '');
const outposts = (db: DB, orgId?: string) => all<{ server_id: string; org_id: string; version: string; installed_at: string; synced_at: string | null }>(db, 'SELECT * FROM outposts WHERE (? IS NULL OR org_id = ?)', orgId ?? null, orgId ?? null);

export function heartbeatUrl(app: App, orgId: string) { try { return app.vault.resolve(orgId, HEART); } catch { return undefined; } }
function alertUrl(app: App, orgId: string) {
  const a = get<{ slug: string; meta: string }>(app.db, `SELECT slug, meta FROM accounts WHERE org_id = ? AND provider = 'ntfy' LIMIT 1`, orgId), m = json<{ ref?: string }>(a?.meta, {});
  if (!a) return undefined; try { return app.vault.resolve(orgId, m.ref ?? `credential://ntfy/${a.slug}/token`); } catch { return undefined; }
}
// the copy goes out in the server's quietest hour, never inside the hours a person called busy (UTC, like the script's clock)
function copyHourOf(db: DB, orgId: string, serverId: string) {
  const set = settingsOf(db, orgId), { hour } = quietHourOf(db, serverId), d = new Date();
  return Array.from({ length: 24 }, (_, k) => (hour + k) % 24).find((h) => !inBusyHours(set, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 30))) ?? hour;
}
function configFor(ctx: Ctx, s: ServerRow): Config {
  const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data, sites = [...new Set((inv?.projects ?? []).flatMap((p) => p.domains))].slice(0, 12);
  const jobs = protectionOf(ctx.db, ctx.orgId).filter((g) => g.important && g.serverId === s.id).flatMap((g) => {
    const p = inv?.parts.find((x) => x.id === g.part), c = p && (p.internals?.find((x) => engineOf(x.image))?.name ?? (p.engine ? p.containers?.[0] : undefined));
    if (!p || !c || !['postgres', 'mysql', 'mariadb'].includes(p.engine ?? '')) return [];
    const supabase = p.engine === 'postgres' && /(^|\/)supabase\/postgres(:|$)/.test(p.internals?.find((x) => engineOf(x.image))?.image ?? p.image ?? '');
    return [{ id: p.id.replace(/[^\w.-]+/g, '-').slice(0, 60), kind: (supabase ? 'supabase' : p.engine === 'postgres' ? 'postgres' : 'mysql') as Config['jobs'][number]['kind'], container: c }];
  });
  return { ...(alertUrl(ctx.app, ctx.orgId) && { alertUrl: alertUrl(ctx.app, ctx.orgId)! }), ...(heartbeatUrl(ctx.app, ctx.orgId) && { heartbeatUrl: heartbeatUrl(ctx.app, ctx.orgId)! }), sites, copyHour: copyHourOf(ctx.db, ctx.orgId, s.id), jobs };
}
defineTool({
  name: 'outpost.install', title: 'Put an Outpost on a server', risk: 'write', action: 'server_write', timeoutMs: 60_000,
  description: 'Install the Outpost: one small script, run each minute from cron, that keeps measuring, checks sites from inside, takes the nightly copies and sends phone alerts while Unit7 sleeps. It opens no port and holds only the alert channel. Nothing that runs changes. Remove it in one step with outpost.remove. Run it again to update its list of sites and copies.',
  input: z.object({ serverId: fid('srv') }),
  assess: () => ({ tier: 1, impact: `Adds a script in ${DIR} and a cron file. Nothing that runs changes, and removing it takes one step.`, shows: `${DIR}/outpost.sh, ${CRON}` }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), c = configFor(ctx, s), x = ssh(ctx.app);
    const send = (file: string, body: string, mode: string) => x.check(s, asRoot(s) + script(`set -e; mkdir -p ${DIR}; chmod 700 ${DIR}; umask 077; cat > "$1"; chmod "$2" "$1"`, file, mode), { what: 'Installing the Outpost', stdin: body, timeoutMs: 20_000 });
    await send(`${DIR}/outpost.sh`, OUTPOST, '700'); await send(`${DIR}/config`, configOf(c), '600'); await send(`${DIR}/jobs`, jobsOf(c), '600');
    await x.check(s, asRoot(s) + script(`set -e; [ -d /etc/cron.d ] || { echo "this server has no /etc/cron.d" >&2; exit 3; }; command -v curl >/dev/null || { echo "this server has no curl" >&2; exit 3; }; cat > "$1"; chmod 644 "$1"; touch ${DIR}/unit7-alive`, CRON), { what: 'Starting the Outpost', stdin: CRON_LINE, timeoutMs: 20_000 });
    run(ctx.db, `INSERT INTO outposts (server_id, org_id, version, installed_at) VALUES (?, ?, '1', ?) ON CONFLICT (server_id) DO UPDATE SET version = excluded.version`, s.id, ctx.orgId, now());
    ctx.emit('outpost.installed', `The Outpost is on ${s.name}: it keeps watch while this computer sleeps.`, { severity: 'success', resource: s.id });
    return { server: s.name, sites: c.sites.length, copies: c.jobs.length, alerts: !!c.alertUrl, heartbeat: !!c.heartbeatUrl, read: `Everything it does is in ${DIR}/outpost.sh on the server.` };
  },
});

defineTool({
  name: 'outpost.remove', title: 'Remove the Outpost', risk: 'write', action: 'server_write', timeoutMs: 30_000,
  description: 'Take the Outpost off a server: its script, its readings and its cron file. Copies it took stay where they are.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    await ssh(ctx.app).check(s, asRoot(s) + `rm -f ${CRON} && rm -rf ${DIR}`, { what: 'Removing the Outpost' });
    run(ctx.db, 'DELETE FROM outposts WHERE server_id = ?', s.id);
    return { removed: s.name, kept: `Copies it took stay in ${BACKUPS}.` };
  },
});

// Back from sleep, or every so often: bring in what it saw, cut those hours out of "wasn't watching", and pick up the copies it took
export async function syncOutpost(ctx: Ctx, s: ServerRow) {
  const o = get<{ synced_at: string | null; installed_at: string }>(ctx.db, 'SELECT synced_at, installed_at FROM outposts WHERE server_id = ?', s.id);
  if (!o) return { readings: 0, copies: 0 };
  const since = o.synced_at ?? o.installed_at;
  // each sync also carries the brakes: the Outpost can't ask, so it's told what a person set
  const org = get<{ safety_net: number; autonomy: number; paused_at: string | null }>(ctx.db, 'SELECT safety_net, autonomy, paused_at FROM orgs WHERE id = ?', ctx.orgId);
  const allowed = org?.safety_net && org.autonomy >= 1 && !org.paused_at ? 'on' : 'off', hour = String(copyHourOf(ctx.db, ctx.orgId, s.id)).padStart(2, '0');
  const r = await ssh(ctx.app).exec(s, asRoot(s) + script(`printf 'COPIES=%s\\nCOPY_HOUR=%s\\n' "$2" "$3" > ${DIR}/brakes 2>/dev/null; touch ${DIR}/unit7-alive 2>/dev/null; awk -v s="$1" -F'"' '$4 > s' ${DIR}/readings.jsonl 2>/dev/null | tail -n 20160; echo @@copies; for f in ${BACKUPS}/*/*.sql.gz; do [ -f "$f" ] && echo "$f $(wc -c < "$f") $(sha256sum "$f" | cut -d" " -f1)"; done`, since, allowed, hour), { timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024, signal: ctx.signal });
  const [text = '', copiesText = ''] = r.stdout.split('@@copies\n');
  const readings = parseReadings(text);
  for (const x of readings) {
    run(ctx.db, 'INSERT INTO metrics (server_id, at, cpu, mem_used, mem_total, disk_used, disk_total) VALUES (?, ?, ?, ?, ?, ?, ?)', s.id, x.at, x.cpu, x.memUsed, x.memTotal, x.diskUsed, x.diskTotal);
    storeRows(ctx.db, ctx.orgId, s.id, x.at, [{ scope: 'server', name: 'The whole server', cpu: x.cpu, mem: x.memUsed, net: null, restarts: 0, oom: 0, disk: x.diskUsed }]);
  }
  // the hours it covered aren't blind any more
  if (readings.length) {
    const times = readings.map((x) => Date.parse(x.at));
    for (const g of all<{ rowid: number; from_at: string; to_at: string }>(ctx.db, 'SELECT rowid, from_at, to_at FROM watch_gaps WHERE to_at > ?', since)) {
      const left = uncovered({ from: Date.parse(g.from_at), to: Date.parse(g.to_at) }, times);
      run(ctx.db, 'DELETE FROM watch_gaps WHERE rowid = ?', g.rowid);
      for (const l of left) run(ctx.db, 'INSERT INTO watch_gaps (from_at, to_at) VALUES (?, ?)', new Date(l.from).toISOString(), new Date(l.to).toISOString());
    }
  }
  let copies = 0;
  const parts = lastXray(ctx.db, ctx.orgId, s.id)?.data.parts ?? [];
  for (const line of copiesText.split('\n').filter(Boolean)) {
    const [file = '', size = '0', sum = ''] = line.split(' '), slug = file.split('/').at(-2) ?? '', part = parts.find((p) => p.id.replace(/[^\w.-]+/g, '-').slice(0, 60) === slug);
    if (!part || get(ctx.db, 'SELECT 1 FROM backups WHERE org_id = ? AND location = ?', ctx.orgId, file)) continue;
    const backupId = id('bak');
    run(ctx.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES (?, ?, NULL, ?, ?, ?, 'scheduled (outpost)', ?, ?, ?, 'done', ?)`, backupId, ctx.orgId, s.id, part.id, part.engine ?? 'database', file, Number(size), sum, now());
    copies++;
  }
  if (readings.length) run(ctx.db, 'UPDATE outposts SET synced_at = ? WHERE server_id = ?', readings.at(-1)!.at, s.id);
  return { readings: readings.length, copies };
}
defineTool({
  name: 'outpost.sync', title: 'Bring in what the Outpost saw', risk: 'read', action: 'read', timeoutMs: 120_000, idle: (o: { readings: number; copies: number }) => !o.copies,
  description: 'Read the Outpost’s readings and copies from each server that has one. Hours it covered stop counting as blind. Warden does this every few minutes.',
  input: z.object({}),
  async run(ctx) {
    let readings = 0, copies = 0;
    for (const o of outposts(ctx.db, ctx.orgId)) { const r = await syncOutpost(ctx, serverRow(ctx, o.server_id)).catch(() => ({ readings: 0, copies: 0 })); readings += r.readings; copies += r.copies; }
    return { readings, copies };
  },
});

// Reading is always allowed, sending isn't: under Pause or Observe the copies wait on the server, and go when a person lets them
defineTool({
  name: 'outpost.send_copies', title: 'Send the Outpost’s copies off the server', risk: 'write', action: 'backup', green: true, timeoutMs: 2 * 3600_000, idle: (o: { sent: number }) => !o.sent,
  description: 'Copy the newest copies the Outpost took off the server, encrypted, the same way as every backup. Only copies. Warden does this after each sync.',
  input: z.object({}),
  async run(ctx) {
    if (get<{ offsite: string }>(ctx.db, 'SELECT offsite FROM orgs WHERE id = ?', ctx.orgId)?.offsite === 'off') return { sent: 0 };
    const rows = all<{ id: string }>(ctx.db, `SELECT id FROM backups WHERE org_id = ? AND reason = 'scheduled (outpost)' AND status = 'done' AND offsite IS NULL ORDER BY created_at DESC LIMIT 3`, ctx.orgId);
    let sent = 0, failed: unknown;
    for (const b of rows) { try { await copyOffsite(ctx, b.id); sent++; } catch (e) { failed = e; } }
    if (failed && !sent) throw failed; // Warden then waits longer each time
    return { sent };
  },
});

// --- catching up: what the server's own logs say happened while Unit7 slept ------------------------------------------------------
export const CATCHUP = `S="$1"; U="$2"
printf '@@boot\\n'; uptime -s 2>/dev/null
printf '@@events\\n'; timeout 20 docker events --since "$S" --until "$U" --filter type=container --filter event=die --filter event=oom --filter event=restart --format '{{.Status}} {{.Actor.Attributes.name}}' 2>/dev/null | sort | uniq -c | sort -rn | head -30
printf '@@oom\\n'; (journalctl -k --since "$S" --until "$U" --no-pager 2>/dev/null || dmesg 2>/dev/null) | grep -ci 'out of memory'
`;
export function readCatchup(out: string, from: number, to: number) {
  const part = (k: string) => new RegExp(`@@${k}\\n([\\s\\S]*?)(?=@@|$)`).exec(out)?.[1]?.trim() ?? '';
  const boot = Date.parse(part('boot').replace(' ', 'T') + 'Z'), rebooted = Number.isFinite(boot) && boot > from && boot < to;
  const events = part('events').split('\n').flatMap((l) => { const m = /^\s*(\d+)\s+(\S+)\s+(\S+)/.exec(l); return m ? [{ n: Number(m[1]), what: m[2]!, name: m[3]! }] : []; });
  const died = events.filter((e) => e.what === 'die').reduce((a, e) => a + e.n, 0), oom = Number(part('oom')) || 0;
  return { rebooted, died, oom, names: [...new Set(events.map((e) => e.name))].slice(0, 6) };
}
export const catchupWords = (name: string, c: ReturnType<typeof readCatchup>) => [c.rebooted && `${name} restarted`, c.oom && `${c.oom} memory kill${c.oom === 1 ? '' : 's'}`, c.died && `${c.died} container stop${c.died === 1 ? '' : 's'}${c.names.length ? ` (${c.names.slice(0, 3).join(', ')})` : ''}`].filter(Boolean).join(', ') || `${name}: nothing happened`;
defineTool({
  name: 'catchup.read', title: 'What happened while Unit7 slept', risk: 'read', action: 'read', timeoutMs: 90_000,
  description: 'Read each server’s own logs for a stretch Unit7 wasn’t watching: reboots, containers that stopped, memory kills.',
  input: z.object({ from: z.string().max(40), to: z.string().max(40) }),
  async run(ctx, i) {
    const fromMs = Date.parse(i.from), toMs = Date.parse(i.to), lines: string[] = [];
    for (const s of all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ? AND status = 'ready'`, ctx.orgId)) {
      const r = await ssh(ctx.app).exec(s, asRoot(s) + script(CATCHUP, i.from, i.to), { timeoutMs: 40_000 }).catch(() => undefined);
      if (r) lines.push(catchupWords(s.name, readCatchup(r.stdout, fromMs, toMs)));
    }
    const hours = Math.round((toMs - fromMs) / 3600_000), line = `While I was away (${hours} hour${hours === 1 ? '' : 's'}): ${lines.join('; ') || 'no server answered'}.`;
    ctx.emit('catchup.done', line, { data: { from: i.from, to: i.to } });
    return { line };
  },
});

// --- this computer -------------------------------------------------------------------------------------------------------------
let awake: ChildProcess | undefined;
export const stayAwakeWanted = (db: DB) => get<{ value: string }>(db, `SELECT value FROM instance WHERE key = 'stay_awake'`)?.value === '1';
export function applyAwake(db: DB) {
  const want = stayAwakeWanted(db) && process.platform === 'darwin';
  if (want && !awake) { awake = spawn('/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' }); awake.on('exit', () => { awake = undefined; }); awake.unref(); }
  if (!want && awake) { awake.kill(); awake = undefined; }
}

defineTool({
  name: 'always.status', title: 'How well Unit7 keeps watch', risk: 'read', action: 'read',
  description: 'Was Unit7 watching: the hours it missed this week, whether this computer stays awake, which servers have an Outpost, and whether an outside heartbeat is set.',
  input: z.object({}),
  run(ctx) {
    const week = Date.now() - 7 * 86400_000, gaps = gapsIn(ctx.db, week, Date.now());
    return { watched: Math.round(1000 - (blindMs(gaps) / (7 * 86400_000)) * 1000) / 10, gaps: gaps.slice(-10).map((g) => ({ from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString() })), stayAwake: stayAwakeWanted(ctx.db), mac: process.platform === 'darwin', heartbeat: !!heartbeatUrl(ctx.app, ctx.orgId), phone: !!alertUrl(ctx.app, ctx.orgId),
      servers: all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM servers WHERE org_id = ? AND status = 'ready' ORDER BY name`, ctx.orgId).map((s) => { const o = outposts(ctx.db, ctx.orgId).find((x) => x.server_id === s.id); return { ...s, outpost: !!o, ...(o?.synced_at && { lastReading: o.synced_at }) }; }) };
  },
});

defineTool({
  name: 'always.stay_awake', title: 'Keep this computer awake', risk: 'write', action: 'settings_write', peopleOnly: true,
  description: 'People only. Keep this computer awake while it’s plugged in, so Unit7 keeps watching. On battery it sleeps as usual.',
  input: z.object({ on: z.boolean() }),
  run(ctx, i) {
    requireHuman(ctx, 'keep this computer awake');
    if (process.platform !== 'darwin') throw new Unit7Error('not_a_mac', 'This switch is for a Mac. A server doesn’t sleep.', 409);
    run(ctx.db, `INSERT INTO instance (key, value) VALUES ('stay_awake', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, i.on ? '1' : '0');
    applyAwake(ctx.db);
    return { on: i.on };
  },
});

defineTool({
  name: 'always.heartbeat', title: 'Set an outside heartbeat', risk: 'write', action: 'settings_write', peopleOnly: true,
  description: 'People only. A check URL from an outside service such as healthchecks.io. Unit7 and the Outpost both ping it, so if the server and this computer both go quiet, that service tells you. Only something outside can report a dead server. Empty removes it.',
  input: z.object({ url: z.string().url().max(300).or(z.literal('')) }),
  async run(ctx, i) {
    requireHuman(ctx, 'set the heartbeat');
    if (!i.url) { ctx.app.vault.retire(ctx.orgId, HEART); return { on: false }; }
    const u = new URL(i.url);
    if (u.protocol !== 'https:') throw new Unit7Error('bad_url', 'Use the service’s https:// address.', 400);
    await assertReachable(u.hostname);
    ctx.app.vault.put(ctx.orgId, HEART, i.url, { kind: 'heartbeat', by: ctx.actor.name, meta: { label: 'Outside heartbeat' } });
    await fetch(i.url, { signal: AbortSignal.timeout(8000) }).catch(() => undefined);
    return { on: true, next: 'Install or re-install the Outpost so the server pings it too.' };
  },
});
export async function heartbeatTick(app: App) {
  for (const o of all<{ id: string }>(app.db, 'SELECT id FROM orgs')) { const u = heartbeatUrl(app, o.id); if (u) await fetch(u, { signal: AbortSignal.timeout(8000) }).catch(() => undefined); }
}

// --- the lifeboat: danger on the way, so a fresh copy and the evidence leave the server now ---------------------------------------
export const EVIDENCE = `set -e; d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
{ date -u; uptime; who; last -n 50 2>/dev/null; } > "$d/who.txt"
ps auxww --sort=-%cpu 2>/dev/null | head -60 > "$d/processes.txt"
ss -tunap 2>/dev/null | head -200 > "$d/connections.txt"
{ crontab -l 2>/dev/null; ls -la /etc/cron.d 2>/dev/null; } > "$d/cron.txt"
for u in /root /home/*; do [ -f "$u/.ssh/authorized_keys" ] && { echo "== $u"; ssh-keygen -lf "$u/.ssh/authorized_keys" 2>/dev/null; }; done > "$d/ssh-keys.txt"
{ tail -n 3000 /var/log/auth.log 2>/dev/null || journalctl -u ssh -n 3000 --no-pager 2>/dev/null; } > "$d/sign-ins.txt"
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null > "$d/containers.txt"
mkdir -p "$(dirname "$1")"; tar czf "$1" -C "$d" .`;
defineTool({
  name: 'safety.lifeboat', title: 'Send an emergency copy off the server', risk: 'write', action: 'backup', green: true, timeoutMs: 2 * 3600_000,
  description: 'When danger appears: a fresh copy of everything important goes off the server, with logs kept as evidence (who signed in, processes, connections, SSH keys by fingerprint). Only creates and copies. Touches nothing that runs.',
  input: z.object({ serverId: fid('srv'), why: z.string().min(3).max(160) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), file = `${manageDirs.backups}/evidence/${now().replace(/[:.]/g, '-')}.tgz`;
    const tight = roomVerdict((await ssh(ctx.app).exec(s, script(ROOM_PROBE, manageDirs.backups), { timeoutMs: 20_000 })).stdout, ctx.actor.kind === 'user', 2e8);
    if (tight) throw new Unit7Error('no_room', `The lifeboat didn’t launch: ${tight}.`, 507);
    await ssh(ctx.app).check(s, asRoot(s) + script(EVIDENCE, file), { what: 'Keeping the evidence', timeoutMs: 120_000 });
    const meta = (await ssh(ctx.app).exec(s, asRoot(s) + script('wc -c < "$1"; sha256sum "$1" | cut -d" " -f1', file))).stdout.trim().split('\n'), backupId = id('bak');
    run(ctx.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES (?, ?, NULL, ?, ?, 'evidence', ?, ?, ?, ?, 'done', ?)`, backupId, ctx.orgId, s.id, `evidence:${s.id}`, i.why.slice(0, 120), file, Number(meta[0] ?? 0), meta[1] ?? null, now());
    const off = await copyOffsite(ctx, backupId).catch(() => undefined);
    const { execute } = await import('../tools/runtime.ts');
    const copy = await execute(ctx.app, ctx.orgId, ctx.actor, 'safety.copy', { serverId: s.id, reason: i.why }, { reason: i.why });
    ctx.emit('safety.lifeboat', `Lifeboat launched on ${s.name}: ${i.why}. A fresh copy and the evidence went off the server. Nothing else changed.`, { severity: 'warning', resource: s.id });
    return { why: i.why, evidence: { file, offServer: !!off }, copies: copy.status === 'ok' ? copy.output : undefined };
  },
});
