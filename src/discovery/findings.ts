// The findings engine: what the X-ray, the disk sizes, the usage history and the traffic watch say about a
// server, as Risks (could hurt you), Waste (space or money nobody uses) and Tips (small changes that help).
// Deterministic: the AI may phrase these, it never invents them. Each finding has the security check's shape
// (a fix tool with its input, label, safe and undo flags, or the steps a person takes).
import type { DB } from '../db.ts';
import { all, get, json } from '../db.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import type { Finding, Fix } from '../tools/security.ts';
import { engineOf, type Inventory, type Part, type Sizes } from './xray.ts';
import { lastXray } from '../tools/xray.ts';
import { readPoints } from '../sentinel/usage.ts';
import { diskForecast, fmtBytes, type Point } from '../sentinel/anomaly.ts';
import { SEVERITY_RANK, type Bucket, type WatchFinding } from '../sentinel/traffic.ts';
import { routeOf } from './actions.ts';
import { withoutArchived } from '../archive.ts';
import { outsideOf, type Reach } from './outside.ts';

export type { Bucket, WatchFinding };
export interface FindingsInput {
  serverId: string; serverName: string; inv?: Inventory; sizes?: Sizes;
  history?: { memMax: Record<string, number>; restarts: Record<string, number>; oom: Record<string, number>; daily: Point[] };
  traffic?: WatchFinding[]; security?: Finding[]; diskTotal?: number;
  scheduled?: string[]; // parts Unit7 backs up on a schedule itself (part.backup_schedule)
  outside?: Record<string, Reach>; // the last outside check of each port Unit7 closed (discovery/outside.ts)
  coolifySeen?: Record<string, { count: number; lastOk: string | null; offServer: boolean }>; // what Coolify's own backups keep (care/safetynet.ts)
}

// What Unit7 closed, said for a person: the port, what answered there, and that it still runs inside
export const COOLIFY_PORT_WORDS: Record<number, string> = { 6001: 'Coolify’s live updates', 6002: 'Coolify’s terminal' };
export function portWhat(inv: Inventory | undefined, port: number): string {
  if (inv?.coolify && port === inv.coolify.apiPort) return 'Coolify’s dashboard';
  if (inv?.coolify && COOLIFY_PORT_WORDS[port]) return COOLIFY_PORT_WORDS[port]!;
  const p = inv?.parts.find((x) => x.kind !== 'domain' && x.ports?.some((y) => y.port === port)) ?? inv?.parts.find((x) => x.id === inv.ports.find((l) => l.port === port)?.part);
  return p ? `${p.name}${p.engine && DB_WORD[p.engine] ? ` (${DB_WORD[p.engine]})` : ''}` : `port ${port}`;
}
export function closedWords(what: string, coolify: boolean) {
  return coolify ? `Closed to the internet. ${what.startsWith('Coolify') ? 'Coolify' : what} still runs inside the server, which is fine.` : `Closed to the internet. ${what.startsWith('port ') ? 'It' : what} still runs inside the server; your apps still reach it there.`;
}
// Unit7 closed a port at the server's firewall, but the outside check (a plain connection from the person's own
// computer) still got an answer: said plainly, with the likely reason and the next fix (docker: Docker publishes it,
// and the only rule is in INPUT, which Docker's published ports skip)
export function stillOpenFinding(serverId: string, serverName: string, port: number, what: string, r: Reach, o: { docker?: boolean; chains?: string[] } = {}) {
  const why = o.docker && o.chains?.length && !o.chains.includes('DOCKER-USER')
    ? 'Docker publishes this port and skips the rule Unit7 added, because this server’s firewall has no place for Docker’s own rules (DOCKER-USER)'
    : 'the traffic comes in another way than the network connection Unit7 blocked: a second network connection, or a port forward or load balancer at your provider';
  return {
    id: `server:port:${serverId}:${port}`, severity: 'high' as const,
    title: `Port ${port} (${what}) is still reachable from outside`,
    detail: `Still reachable from outside: ${why}. Unit7’s block is on the server, but a connection from this computer still got through.`,
    evidence: `Checked from outside ${r.at.slice(0, 16).replace('T', ' ')} UTC: port ${port} answered${r.ms !== undefined ? ` in ${r.ms} ms` : ''}${o.chains?.length ? `. Unit7’s rule is in ${o.chains.join(' and ')}` : ''}.`,
    fix: { label: 'Ask Unit7 to look', ask: `On my server ${serverName}: port ${port} (${what}) is closed at the server’s firewall, but it still answers from outside. Look first, read-only: the firewall rules, the network connections and what answers on ${port}. Tell me why in plain words and the fix you’d make. Don’t change anything yet.`,
      manual: [`Close port ${port} in your provider’s firewall too (its dashboard calls it Firewall or Security groups), keeping 22, 80 and 443 open.`, 'Then press Check again: Unit7 tests it from outside.'] } as Fix,
  };
}

const closePort = (serverId: string, port: number): Fix => ({
  tool: 'server.close_port', input: { serverId, port }, label: 'Close this port', safe: true,
  change: `Blocks port ${port} from the internet at the server’s own firewall. Your apps still reach it inside the server; you can open it again.`,
  undo: { tool: 'server.close_port', input: { serverId, port, open: true }, label: 'Open it again' },
});
// Coolify's proxy dashboard: closed in Coolify's own proxy settings (so its Restart Proxy keeps it closed), not just at the firewall
const closeDashboard = (serverId: string): Fix => ({
  tool: 'coolify.proxy', input: { serverId, op: 'close_dashboard' }, label: 'Close it in Coolify', safe: false,
  change: 'Turns the passwordless dashboard off and stops publishing port 8080, in Coolify’s own proxy settings, then restarts the proxy the way Coolify does: sites pause for a few seconds. Unit7 checks every site still answers, and puts it back by itself if one doesn’t. Activity can undo it.',
});
// a database Unit7 can dump where it runs (manage.ts freshBackup): its engine's container is there, or Postgres on the server itself
export const canDump = (p: Part) => ['database', 'app', 'service'].includes(p.kind) && ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].includes(p.engine ?? '') && p.owner !== 'unit7'
  && (!!p.internals?.some((x) => engineOf(x.image)) || !!p.containers?.length || (p.owner === 'systemd' && p.engine === 'postgres'));
const dailyBackup = (serverId: string, p: Part, alt?: Fix[], byHand?: string[]): Fix => ({
  tool: 'part.backup_schedule', input: { serverId, part: p.id, frequency: 'daily', keep: 7 }, label: 'Back up daily with Unit7', safe: true,
  change: `Copies ${p.name} every day (the first copy right now), keeps the last 7, and stores them encrypted off the server. Nothing in the database changes; Undo stops it.`,
  ...(alt?.length && { alt: alt as never }), ...(byHand && { byHand }) });
const prune = (serverId: string): Fix => ({ tool: 'docker.prune', input: { serverId }, label: 'Clean up safely', safe: true, change: 'Removes images no container uses and build leftovers older than a day. Never touches data (volumes) or running apps.' });
// a question for Unit7's AI, sent from the finding's own button (the person's chosen brain answers on Home); look: a
// read-only investigation first, nothing changed until the person says so
const ask = (server: string, q: string, look = false): Fix => ({ manual: [`Ask Unit7: “${q}”.`], label: look ? 'Ask Unit7 to look' : 'Ask Unit7',
  ask: `On my server ${server}: ${q}${look ? ' Look first, read-only: its logs, recent changes and the X-ray. Don’t change anything yet; tell me the cause in plain words and the fix you’d make.' : ''}` });
const tidy = (serverId: string, byHand: string[]): Fix => ({ tool: 'server.tidy_logs', input: { serverId }, label: 'Tidy up logs', safe: true, byHand,
  change: 'Caps the system journal at 500 MB and empties the package cache. Docker isn’t restarted; apps keep running.' });
const capIt = (serverId: string, p: Part, cap: number): Fix => ({ tool: 'part.limits', input: { serverId, part: p.id, memoryMb: cap }, label: `Cap it at ${mb(cap)}`,
  change: `Gives ${p.name} a ${mb(cap)} memory cap (1.5× its busiest this week) without restarting it. Unit7 checks it keeps running and puts the old cap back if not.` });
// Unit7 can cap it over SSH (Docker, Compose or systemd; Coolify's are capped in Coolify, PM2's in its own file)
export const cappable = (p: Part) => { const r = routeOf(p, 'limits'); return r.via === 'ssh' && r.how !== 'pm2' && r.how !== 'process'; };
const ADMIN = /portainer\/portainer|(^|\/)adminer(:|$)|phpmyadmin|dpage\/pgadmin|mongo-express|redis-commander|amir20\/dozzle|netdata\/netdata|(^|\/)traefik(:|$)/;
const DB_WORD: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis', clickhouse: 'ClickHouse' };
// rounded up to the next 256 MB, at least 256 MB
export const capFor = (max?: number) => (max ? Math.max(256, Math.ceil((max * 1.5) / 1e6 / 256) * 256) : undefined);
export const mb = (m: number) => (m >= 1024 ? `${(m / 1024).toFixed(1).replace(/\.0$/, '')} GB` : `${m} MB`);

export function findingsFor(i: FindingsInput): WatchFinding[] {
  const out: WatchFinding[] = [];
  const about = { kind: 'server' as const, id: i.serverId, name: i.serverName };
  const add = (bucket: Bucket, f: Omit<Finding, 'area' | 'by' | 'serverId' | 'about'>) => { if (!out.some((x) => x.id === f.id)) out.push({ ...f, bucket, area: 'server', by: 'unit7', serverId: i.serverId, about }); };
  const inv = i.inv;
  const parts = inv?.parts ?? [];
  const project = (p: Part) => inv?.projects.find((x) => x.id === p.project);
  const own = (p: Part) => !project(p)?.system;

  // --- risks: what answers the internet that shouldn't ---
  for (const p of parts.filter((x) => x.kind === 'database' && x.exposed && own(x))) {
    const open = (p.ports ?? []).filter((x) => x.public);
    const noPass = p.engine === 'redis' && !(p.envKeys ?? []).some((k) => /PASS|AUTH/i.test(k));
    for (const port of open.length ? open : [{ port: 0 }]) {
      add('risk', { id: port.port ? `server:port:${i.serverId}:${port.port}` : `xray:exposed:${i.serverId}:${p.id}`, severity: noPass ? 'critical' : 'high',
        title: noPass ? `${p.name} (Redis) answers the internet, and Unit7 sees no password on it` : `${p.name} (${DB_WORD[p.engine ?? ''] ?? 'a database'}) answers the internet${port.port ? ` on port ${port.port}` : ''}`,
        detail: `Docker’s published ports skip the firewall, so bots can reach it and try passwords all day. Your apps reach it inside the server; nothing outside needs this port.${p.owner === 'coolify' ? ' In Coolify you can also turn off “Make it publicly available” for it.' : ''}`,
        evidence: `${p.name}: ${open.map((x) => `${x.ip || '0.0.0.0'}:${x.port}`).join(', ') || 'published to all addresses'}`, ...(port.port && { fix: closePort(i.serverId, port.port) }) });
    }
  }
  for (const p of parts) {
    const proxy = p.name === 'coolify-proxy' || p.containers?.includes('coolify-proxy');
    const panel = ADMIN.test(p.image ?? '') && !proxy;
    if (!proxy && !panel) continue;
    for (const x of (p.ports ?? []).filter((y) => y.public && (proxy ? y.port === 8080 : y.port !== 443 && y.port !== 80))) {
      add('risk', { id: `server:port:${i.serverId}:${x.port}`, severity: 'high',
        title: proxy ? 'Coolify’s proxy dashboard is open to the internet on port 8080' : `${p.product?.name ?? p.name}’s admin page is open to the internet on port ${x.port}`,
        detail: proxy ? 'It shows every site and route on this server to anyone, without a password. Coolify doesn’t need it open.' : 'Admin pages belong behind a sign-in and HTTPS, or closed to the internet. Bots look for these.',
        evidence: `Port ${x.port}: ${p.containers?.[0] ?? p.name} (${p.image ?? 'unknown image'})`, fix: proxy ? closeDashboard(i.serverId) : closePort(i.serverId, x.port) });
    }
  }
  if (inv?.coolify?.dashboard?.startsWith('http://')) add('risk', { id: `xray:coolify-http:${i.serverId}`, severity: 'medium', title: 'Coolify’s dashboard has no HTTPS',
    detail: 'Your Coolify password crosses the internet unencrypted every time you sign in.', evidence: `Dashboard at ${inv.coolify.dashboard}`,
    // the same safe flow as its open port: a name, its DNS, Coolify's own address, HTTPS, then the port closed
    fix: { label: 'Give it its own address', flow: { kind: 'coolify-domain', serverId: i.serverId }, ask: `On my server ${i.serverName}: give Coolify’s dashboard its own address with HTTPS (a subdomain of one of my domains pointed at this server, set as Coolify’s instance domain). Show me the plan and ask before changing anything.`,
      manual: ['Point a subdomain (for example coolify.example.com) at this server.', 'In Coolify, open Settings and set it as the instance’s domain; Coolify gets an HTTPS certificate for it.', 'Sign in through the new address from then on.'] } });
  // Coolify itself answering the internet on its API port: its allowed-IPs list trusts whatever address a caller claims
  // (connectors/coolify.ts, PHP_OPS.connect), so only the token stands in the way. Unit7 calls the API from inside.
  const coolifyPort = inv?.coolify?.apiPort ?? 8000;
  const coolifyItself = parts.find((p) => p.containers?.includes('coolify'));
  if (coolifyItself?.ports?.some((x) => x.public && x.port === coolifyPort)) add('tip', { id: `xray:coolify-port:${i.serverId}`, severity: 'low', title: `Coolify answers the internet on port ${coolifyPort}`,
    detail: `Its “Allowed IPs” can be fooled by a caller who says it comes from an allowed address, so a stolen token would work from anywhere. Once Coolify has its own domain with HTTPS, keep port ${coolifyPort} closed to the internet: Unit7 talks to Coolify from inside the server, so nothing of yours stops working.`,
    evidence: `Port ${coolifyPort}: ${coolifyItself.containers?.[0] ?? 'coolify'}`,
    fix: inv?.coolify?.dashboard?.startsWith('https://') ? { ...closePort(i.serverId, coolifyPort), label: `Close port ${coolifyPort}`, safe: false,
        change: `Blocks port ${coolifyPort} from the internet. You keep signing in through ${inv.coolify.dashboard}; Unit7 talks to Coolify from inside the server. You can open it again.`,
        byHand: [`Or close port ${coolifyPort} in your provider’s firewall, so only the HTTPS address reaches Coolify.`] }
      // no HTTPS address yet: closing the port now would lock the person out, so the fix is the safe order (a name first)
      : { label: `Give Coolify a domain, then close ${coolifyPort}`, flow: { kind: 'coolify-domain', serverId: i.serverId },
          manual: ['Give Coolify its own domain with HTTPS first (Settings → instance domain), and sign in through it.', `Then close port ${coolifyPort} in the server’s firewall (or your provider’s), so only the HTTPS address reaches Coolify.`] } });
  // with the HTTPS address working, Coolify's live updates (6001) and terminal (6002) go through ports 80 and 443 too
  // (coolify.io/docs/knowledge-base/server/firewall), so those ports can close as well
  const realtime = [...new Set([...parts.filter((p) => p.containers?.some((c) => /^coolify(-realtime)?$/.test(c))).flatMap((p) => p.ports ?? []), ...(inv?.ports ?? [])]
    .filter((x) => x.public && (x.port === 6001 || x.port === 6002) && i.outside?.[String(x.port)]?.state !== 'closed').map((x) => x.port))].sort((a, b) => a - b); // tested closed from outside: nothing to say
  if (inv?.coolify?.dashboard?.startsWith('https://') && realtime.length) add('tip', { id: `xray:coolify-realtime:${i.serverId}`, severity: 'low',
    title: `Coolify’s live-update port${realtime.length === 1 ? '' : 's'} ${realtime.join(' and ')} answer${realtime.length === 1 ? 's' : ''} the internet`,
    detail: `Coolify needs ${realtime.length === 1 ? 'it' : 'them'} only when its dashboard is opened at the server’s address. Through ${inv.coolify.dashboard}, live updates and the terminal go through ports 80 and 443 (Coolify’s firewall docs say so), so ${realtime.length === 1 ? 'it' : 'they'} can close.`,
    evidence: `Port${realtime.length === 1 ? '' : 's'} ${realtime.join(', ')}: Coolify`,
    fix: { tool: 'coolify.dashboard_domain', input: { serverId: i.serverId, ports: realtime }, label: `Close ${realtime.join(' and ')}`, safe: false,
      change: `Checks ${inv.coolify.dashboard} answers over HTTPS first, then blocks port${realtime.length === 1 ? '' : 's'} ${realtime.join(' and ')} from the internet and tests from outside. Coolify keeps running; each port can open again from Activity.` } });
  // what Unit7 closed that still answers from outside (the X-ray no longer sees it as open, so this is the only word on it)
  for (const b of inv?.blocked ?? []) {
    const r = i.outside?.[String(b.port)];
    if (r?.state !== 'open') continue;
    const docker = parts.some((p) => !!p.containers?.length && p.ports?.some((x) => x.port === b.port));
    add('risk', stillOpenFinding(i.serverId, i.serverName, b.port, portWhat(inv, b.port), r, { docker, chains: b.chains }));
  }
  // Z8 · a Coolify app with no health check: Coolify can't tell the new version works, so it can't swap without a gap
  // (a Dockerfile's own HEALTHCHECK counts; compose apps keep theirs in the compose file; previews don't matter)
  for (const p of parts.filter((x) => x.coolify?.type === 'application' && x.coolify.health && !x.coolify.health.enabled && !x.coolify.health.custom && x.coolify.buildPack !== 'dockercompose' && !x.coolify.preview && own(x))) {
    add('risk', { id: `xray:coolify-health:${i.serverId}:${p.coolify!.uuid}`, severity: 'medium', title: `Coolify can’t swap versions safely for ${p.name}`,
      detail: 'Coolify can’t swap versions safely for this app: it has no health check, so visitors can see errors during a deploy.', evidence: `${p.name}: health check off in Coolify`,
      fix: inv?.coolify?.connected
        ? { tool: 'coolify.health_check', input: { serverId: i.serverId, uuid: p.coolify!.uuid }, label: 'Add a health check', safe: false,
            change: 'Finds a page the app answers on from inside the server (/health, /api/health, /healthz, then /), turns on Coolify’s health check with it, then offers a deploy to test it. Undo puts the old settings back.' }
        : { label: 'Show me how', manual: [`In Coolify, open ${p.name} → Health check.`, 'Turn it on with a page the app always answers (for example /health), and save.', 'Deploy again, so Coolify uses it.'] } });
  }
  for (const f of i.security ?? []) if (/^server:(ssh-(password|tries)|clock):/.test(f.id)) add('risk', { id: f.id, severity: f.severity, title: f.title, detail: f.detail, evidence: f.evidence, fix: f.fix });

  // --- risks: apps in trouble ---
  // the usage history is per project: an out-of-memory count there names the project's part only when the X-ray
  // can't tell which one it was; a memory cap is suggested only for a project of one part (its peak is that part's)
  const workers = parts.filter((x) => own(x) && (x.kind === 'app' || x.kind === 'database' || x.kind === 'service'));
  // a project's peak is its one part's only when it has one part
  const capOf = (p: Part) => (workers.filter((x) => x.project === p.project).length === 1 ? capFor(i.history?.memMax[p.project ?? '']) : undefined);
  const oomFinding = (p: Part, why?: string) => {
    const scope = p.project ?? '';
    const cap = capOf(p);
    add('risk', { id: `xray:oom:${i.serverId}:${p.id}`, severity: 'medium', title: `${p.name} keeps running out of memory`,
      detail: `Each time, it’s killed and restarted, and visitors see errors.${cap ? ` Give it a ${mb(cap)} memory cap and a restart rule, so it stops at its own limit instead of starving the server.` : ' Give it a memory cap a little above what it normally uses, and a restart rule.'}`,
      evidence: [why, i.history?.oom[scope] ? `${i.history.oom[scope]} out-of-memory restart${i.history.oom[scope] === 1 ? '' : 's'} this week${project(p) ? ` in ${project(p)!.name}` : ''}` : ''].filter(Boolean).join('; ') || undefined,
      fix: cap && cappable(p) ? capIt(i.serverId, p, cap) : { label: 'Ask Unit7 to look', ask: `On my server ${i.serverName}: ${p.name} keeps running out of memory. Look first, read-only: its logs, its memory over the week and recent deploys. Tell me why in plain words, and the memory limit you’d set.`, manual: p.owner === 'coolify'
        ? [`In Coolify, open ${p.name} → Resource limits.`, `Set Maximum memory to ${cap ? mb(cap) : 'a little above what it normally uses'}, and save.`, 'Redeploy it so the limit applies.']
        : [`Set a memory limit for ${p.name}${cap ? ` of ${mb(cap)}` : ''} (in Docker Compose: mem_limit), with restart: unless-stopped.`, 'Recreate it so the limit applies.'] } });
  };
  for (const p of workers) {
    if (p.state === 'restarting' || /keeps restarting/.test(p.health?.reason ?? '')) add('risk', { id: `xray:restart-loop:${i.serverId}:${p.id}`, severity: 'high', title: `${p.name} keeps restarting`, detail: 'It crashes, starts again and crashes again, so it’s down most of the time.',
      evidence: `${p.restarts ?? 0} restarts${p.health?.reason ? `: ${p.health.reason}` : ''}`, fix: ask(i.serverName, `why does ${p.name} keep restarting?`, true) });
    else if (/ran out of memory/.test(p.health?.reason ?? '')) oomFinding(p, p.health!.reason);
  }
  for (const [scope, n] of Object.entries(i.history?.oom ?? {})) {
    if (!n || scope === 'server' || out.some((f) => f.id.startsWith(`xray:oom:${i.serverId}:`) && workers.find((w) => f.id.endsWith(`:${w.id}`))?.project === scope)) continue;
    const p = workers.find((w) => w.project === scope && w.kind === 'app') ?? workers.find((w) => w.project === scope);
    if (p) oomFinding(p);
  }

  // --- risks: no way back ---
  const jobs = parts.filter((x) => x.kind === 'job');
  // Redis is usually a cache (nothing to lose), so only the databases that keep data count
  for (const p of parts.filter((x) => x.kind === 'database' && own(x) && x.owner !== 'unit7' && x.engine !== 'redis')) {
    const names = [p.name, ...(p.containers ?? [])];
    const pr = project(p);
    const who = pr && !p.name.toLowerCase().includes(pr.name.toLowerCase()) ? `${p.name} in ${pr.name}` : p.name;
    const backed = jobs.some((j) => /dump|backup|bgsave|\bsave\b|restic|borg|rclone/i.test(j.command ?? '') && (j.project === p.project || names.some((n) => j.command?.includes(n))));
    if (backed || i.scheduled?.includes(p.id)) continue;
    // Coolify keeps copies by itself: that's a backup, but on this server only, it goes down with it
    const seen = i.coolifySeen?.[p.id];
    if (seen?.lastOk && Date.now() - Date.parse(seen.lastOk) < 8 * 86400_000) {
      if (!seen.offServer) add('risk', { id: `xray:weak-backup:${i.serverId}:${p.id}`, severity: 'medium', title: `${who} is backed up by Coolify, but only on this server`,
        detail: 'If the server dies, those copies go with it. A copy off the server fixes that.', ...(canDump(p) && { fix: dailyBackup(i.serverId, p) }) });
      continue;
    }
    const coolifyOwn: Fix | undefined = p.coolify?.type === 'database' && inv?.coolify?.connected ? { tool: 'coolify.backup', input: { serverId: i.serverId, uuid: p.coolify.uuid, op: 'schedule', frequency: 'daily' }, label: 'Use Coolify’s backups', safe: true,
      change: 'Coolify backs it up every day from now on, on the server. Add an S3 bucket in Coolify too, so copies live off the server.' } : undefined;
    const steps = p.owner === 'coolify' ? [`In Coolify, open ${p.name} → Backups.`, 'Add a daily schedule and, if you can, an S3 bucket so copies live off the server.'] : undefined;
    add('risk', { id: `xray:no-backup:${i.serverId}:${p.id}`, severity: p.owner === 'coolify' ? 'medium' : 'high', title: `${who} has no backups Unit7 can see`,
      detail: `If the server dies or a bad change deletes data, there’s no way back.${p.owner === 'coolify' ? ' Coolify may back it up itself; check its Backups tab.' : ''}`,
      fix: canDump(p) ? dailyBackup(i.serverId, p, coolifyOwn && [coolifyOwn], steps)
        : p.owner !== 'coolify' ? ask(i.serverName, `back up ${p.name} every day.`)
        // a Coolify database: Coolify's own schedule, through its API (a stack such as Supabase isn't one, so its steps stay)
        : p.coolify?.type === 'database' && inv?.coolify?.connected ? { tool: 'coolify.backup', input: { serverId: i.serverId, uuid: p.coolify.uuid, op: 'schedule', frequency: 'daily' }, label: 'Back up daily', safe: true,
          change: 'Coolify backs it up every day from now on. Add an S3 bucket in Coolify too, so copies live off the server.' }
        : { label: 'Show me how', manual: [`In Coolify, open ${p.name} → Backups.`, 'Add a daily schedule and, if you can, an S3 bucket so copies live off the server.'] } });
  }
  const fc = i.history?.daily.length ? diskForecast(i.history.daily, i.diskTotal ?? inv?.server.diskTotal) : undefined;
  if (fc?.days !== undefined && fc.days <= 90) {
    const reclaim = i.sizes?.reclaimable ?? inv?.disk?.reclaimable ?? 0;
    add(fc.days <= 30 ? 'risk' : 'tip', { id: `xray:disk-forecast:${i.serverId}`, severity: fc.days <= 7 ? 'high' : fc.days <= 30 ? 'medium' : 'low',
      title: `The disk is full in about ${Math.max(1, Math.round(fc.days))} day${Math.round(fc.days) === 1 ? '' : 's'} at this rate`, detail: `It grows about ${fmtBytes(fc.perDay)} a day. A full disk stops databases and sign-ins.`,
      fix: reclaim >= 1e9 ? prune(i.serverId) : tidy(i.serverId, ['See what grows (the disk view on this server).', 'Remove old backups you don’t need, or give the server a bigger disk at your provider.']) });
  }

  // --- waste ---
  const logs = Object.entries(i.sizes?.logs ?? {}).filter(([, b]) => b >= 500e6).sort((a, b) => b[1] - a[1]);
  if (logs.length) add('waste', { id: `xray:logs:${i.serverId}`, severity: logs[0]![1] >= 2e9 ? 'medium' : 'low', title: `Logs take ${fmtBytes(logs.reduce((a, [, b]) => a + b, 0))} and keep growing`,
    detail: 'Docker keeps every log line forever unless it’s told to rotate them, a common cause of a full disk. Apps Unit7 starts rotate their own.', evidence: logs.slice(0, 3).map(([c, b]) => `${c} ${fmtBytes(b)}`).join(', '),
    fix: tidy(i.serverId, ['Optional, for apps Unit7 didn’t start: set log rotation in /etc/docker/daemon.json: {"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}.', 'Then restart Docker at a quiet moment; those apps pick it up when they’re next recreated (on Coolify: their next deploy).']) });
  const reclaim = i.sizes?.reclaimable ?? inv?.disk?.reclaimable ?? 0;
  if (reclaim >= 1e9) add('waste', { id: `xray:reclaim:${i.serverId}`, severity: reclaim >= 10e9 ? 'medium' : 'low', title: `${fmtBytes(reclaim)} of old images and build cache nobody uses`,
    detail: 'Left behind by earlier deploys. Removing them frees the space and changes nothing that runs.', fix: prune(i.serverId) });
  // one finding per leftover volume, biggest first, each with its own way to the 7-day trash
  const unused = parts.filter((p) => p.kind === 'volume' && !p.project && p.health?.reason === 'nothing uses it').map((p) => ({ p, bytes: i.sizes?.volumes[p.name] ?? 0 })).filter((v) => v.bytes >= 100e6 || !i.sizes);
  for (const { p, bytes } of unused.sort((a, b) => b.bytes - a.bytes).slice(0, 10)) add('waste', { id: `xray:volume:${i.serverId}:${p.id}`, severity: 'low', title: `${p.name}${bytes ? ` (${fmtBytes(bytes)})` : ''} is data nothing uses`,
    detail: 'It may hold old data, so Unit7 never removes it by itself. Look first, then remove it if you don’t need it: it goes to a 7-day trash, so it can come back.',
    fix: routeOf(p, 'remove').via === 'ssh' ? { tool: 'part.remove', input: { serverId: i.serverId, part: p.id }, label: 'Move to the trash', typeName: p.name, change: 'Copies it into a 7-day trash, then removes it. Undo brings it back; after 7 days it’s gone for good.' }
      : { label: 'Show me how', manual: ['Check what’s inside first (or back it up).', `Then remove it where it was made (${p.owner === 'coolify' ? 'in Coolify' : 'the tool that manages it'}).`] } });
  for (const [c, b] of Object.entries(i.sizes?.layers ?? {}).filter(([, b]) => b >= 1e9)) add('risk', { id: `xray:layer:${i.serverId}:${c}`, severity: 'medium', title: `${c} keeps ${fmtBytes(b)} inside its container`,
    detail: 'Files written inside a container (not in a volume) are thrown away on its next deploy or recreate.', fix: ask(i.serverName, `move ${c}’s data into a volume.`) });

  // --- tips ---
  for (const r of inv?.repos ?? []) if (r.dirty > 0) add('tip', { id: `xray:git-dirty:${i.serverId}:${r.dir}`, severity: 'medium', title: `${r.dirty} file${r.dirty === 1 ? ' was' : 's were'} changed directly on the server in ${r.dir}`,
    detail: 'They aren’t saved in git, so the next deploy or a new server loses them, and nobody else can see them.', evidence: r.remote ? `Checkout of ${r.remote}` : undefined,
    fix: { label: 'Ask Unit7 to look', ask: `On my server ${i.serverName}: ${r.dir} has ${r.dirty} file${r.dirty === 1 ? '' : 's'} changed outside git. Look first, read-only: show me what changed, in plain words, and whether it should be saved to git or thrown away. Don’t change anything yet.`,
      manual: [`On the server, in ${r.dir}: git status shows the changed files.`, 'Commit and push them (or undo them with git checkout), so git has the truth again.'] } });
  const ownProjects = (inv?.projects ?? []).filter((p) => !p.system);
  const uncapped = parts.filter((p) => own(p) && p.kind === 'app' && p.containers?.length && !p.memLimit && p.owner !== 'unit7' && p.state === 'running');
  // an app Unit7 can cap with a number from its history gets its own button; the rest are listed together
  const own1 = ownProjects.length >= 2 ? uncapped.filter((p) => capOf(p) && cappable(p)) : [];
  for (const p of own1) add('tip', { id: `xray:no-cap:${i.serverId}:${p.id}`, severity: 'low', title: `${p.name} has no memory cap`,
    detail: 'If it leaks memory, it can take every other project on this server down with it. A cap keeps the trouble to this one app.', evidence: `Busiest this week: ${fmtBytes(i.history!.memMax[p.project ?? '']!)}`, fix: capIt(i.serverId, p, capOf(p)!) });
  const rest = uncapped.filter((p) => !own1.includes(p));
  if (ownProjects.length >= 2 && rest.length) add('tip', { id: `xray:no-caps:${i.serverId}`, severity: 'low', title: `${rest.length} app${rest.length === 1 ? ' has' : 's have'} no memory cap`,
    detail: 'If one leaks memory, it can take every other project on this server down with it. A cap keeps the trouble to that one app.',
    evidence: rest.slice(0, 4).map((p) => { const c = capFor(i.history?.memMax[p.project ?? '']); return `${p.name}${c ? ` (try ${mb(c)})` : ''}`; }).join(', '),
    fix: { label: 'Ask Unit7 to cap them', ask: `On my server ${i.serverName}: give each app without a memory cap a safe one (about 1.5× its busiest this week): ${rest.slice(0, 6).map((p) => p.name).join(', ')}. Show me the caps first and ask before changing anything.`,
      manual: [rest.some((p) => p.owner === 'coolify') ? 'In Coolify, open each app → Resource limits → Maximum memory.' : 'Set mem_limit for each app in its Docker Compose file.', 'Pick about 1.5× what it uses at its busiest; Unit7’s usage history shows that.'] } });

  for (const f of i.traffic ?? []) add(f.bucket, f);
  const order: Record<Bucket, number> = { risk: 0, waste: 1, tip: 2 };
  return out.sort((a, b) => order[a.bucket] - order[b.bucket] || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// --- what's stored, gathered (no trip to the server) -------------------------------------------------------
export function gather(db: DB, orgId: string, s: Pick<ServerRow, 'id' | 'name'>): FindingsInput & { at: { xray?: string; sizes?: string; traffic?: string } } {
  const x = lastXray(db, orgId, s.id), d = lastXray<Sizes>(db, orgId, s.id, 'deep');
  const week = readPoints(db, s.id, '1h', Date.now() - 7 * 86400_000);
  const memMax: Record<string, number> = {}, restarts: Record<string, number> = {}, oom: Record<string, number> = {};
  for (const [scope, { points }] of week) {
    memMax[scope] = Math.max(0, ...points.map((p) => p.memMax ?? p.mem ?? 0));
    restarts[scope] = points.reduce((a, p) => a + p.restarts, 0);
    oom[scope] = points.reduce((a, p) => a + p.oom, 0);
  }
  const daily = readPoints(db, s.id, '1d', Date.now() - 60 * 86400_000, 'server').get('server')?.points ?? [];
  const tw = get<{ at: string; findings: string }>(db, 'SELECT at, findings FROM traffic_windows WHERE server_id = ? ORDER BY at DESC LIMIT 1', s.id);
  const report = get<{ findings: string }>(db, `SELECT findings FROM security_reports WHERE org_id = ? AND (server_id = ? OR server_id IS NULL) ORDER BY created_at DESC LIMIT 1`, orgId, s.id);
  const diskTotal = all<{ disk_total: number }>(db, 'SELECT disk_total FROM metrics WHERE server_id = ? ORDER BY at DESC LIMIT 1', s.id)[0]?.disk_total;
  return {
    // what's archived (asset.archive) gets no findings: inv leaves it out
    serverId: s.id, serverName: s.name, inv: withoutArchived(db, orgId, s.id, x?.data), sizes: d?.data, history: { memMax, restarts, oom, daily },
    traffic: json<WatchFinding[]>(tw?.findings, []), security: json<Finding[]>(report?.findings, []).filter((f) => f.serverId === s.id), diskTotal: diskTotal || undefined,
    scheduled: all<{ part: string }>(db, 'SELECT part FROM part_backup_schedules WHERE org_id = ? AND server_id = ?', orgId, s.id).map((r) => r.part),
    outside: outsideOf(get<{ facts: string }>(db, 'SELECT facts FROM servers WHERE id = ?', s.id)?.facts),
    coolifySeen: Object.fromEntries(all<{ part: string; count: number; last_ok: string | null; off_server: number }>(db, 'SELECT part, count, last_ok, off_server FROM coolify_backups_seen WHERE server_id = ?', s.id).map((r) => [r.part, { count: r.count, lastOk: r.last_ok, offServer: !!r.off_server }])),
    at: { xray: x?.at, sizes: d?.at, traffic: tw?.at },
  };
}

export const serverFindings = (db: DB, orgId: string, s: Pick<ServerRow, 'id' | 'name'>) => findingsFor(gather(db, orgId, s));
