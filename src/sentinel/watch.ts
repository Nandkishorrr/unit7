// Watching everything on the map from the outside, not just apps on your own servers: every app's address
// and every domain pointing at an app answers (every 5 minutes); certificates aren't about to run out,
// domain registrations aren't about to lapse, and domains can't be used to send email in your name (daily).
// Problems go to your phone; a site that comes back says so.
import { connect as tlsConnect } from 'node:tls';
import type { App } from '../app.ts';
import { all, get, json, now, run } from '../db.ts';
import { Resolver, lookup } from 'node:dns/promises';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { assertReachable } from '../netguard.ts';
import { pool } from '../discovery/scanners.ts';
import { archivedAssets } from '../archive.ts';

export type WatchKind = 'site' | 'tls' | 'registration' | 'email';
export interface WatchRow { host: string; kind: WatchKind; status: string; detail: string | null; streak: number; ms: number | null; last_ok: string | null; checked_at: string | null; value: string | null; asset: string | null }

const DOWN_AFTER = 2;        // failed checks in a row before it's "down" (about 10 minutes)
const SLOW_MS = 3000;        // slower than this, twice in a row, is "slow"
const days = (iso: string) => Math.floor((Date.parse(iso) - Date.now()) / 86400_000);
// asked of public resolvers, so a cached local answer never hides a missing record
const resolver = () => { const r = new Resolver({ timeout: 4000, tries: 2 }); r.setServers(['1.1.1.1', '8.8.8.8']); return r; };
const txt = (n: string) => resolver().resolveTxt(n).then((v) => v.map((p) => p.join('')), () => [] as string[]);
const mx = (n: string) => resolver().resolveMx(n).then((v) => v.length > 0, () => false);

// what each check calls a problem; one that goes back to fine says "Cleared" in Activity (a site that was down says
// it's answering again, site.recovered)
const BAD: Record<WatchKind, RegExp> = { site: /^slow$/, tls: /^(expiring|broken)$/, registration: /^(expiring|expired)$/, email: /^(unprotected|spoofable)$/ };
const OK: Record<WatchKind, string> = { site: 'is fast again', tls: '’s HTTPS certificate is fine again', registration: '’s registration is renewed', email: '’s email is protected' };
function save(app: App, orgId: string, host: string, kind: WatchKind, f: Partial<WatchRow>) {
  const was = get<{ status: string }>(app.db, 'SELECT status FROM watch WHERE org_id = ? AND host = ? AND kind = ?', orgId, host, kind)?.status;
  if (was && BAD[kind].test(was) && (f.status === 'ok' || f.status === 'up')) app.events.emit(orgId, 'alert.cleared', `Cleared: ${host}${OK[kind].startsWith('’') ? '' : ' '}${OK[kind]}`, { severity: 'success', resource: host, data: { key: `${kind}:${host}`, source: 'watch' } });
  run(app.db, `INSERT INTO watch (org_id, host, kind, status, detail, streak, ms, last_ok, checked_at, value, asset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, host, kind) DO UPDATE SET status = excluded.status, detail = excluded.detail, streak = excluded.streak, ms = excluded.ms,
    last_ok = coalesce(excluded.last_ok, watch.last_ok), checked_at = excluded.checked_at, value = coalesce(excluded.value, watch.value), asset = coalesce(excluded.asset, watch.asset)`,
    orgId, host, kind, f.status ?? 'unknown', f.detail ?? null, f.streak ?? 0, f.ms ?? null, f.last_ok ?? null, now(), f.value ?? null, f.asset ?? null);
}
const prev = (app: App, orgId: string, host: string, kind: WatchKind) => get<WatchRow & { alerted: string | null }>(app.db, 'SELECT * FROM watch WHERE org_id = ? AND host = ? AND kind = ?', orgId, host, kind);

// What to watch: every app's own address, and every domain the map says reaches an app
export function targets(app: App, orgId: string): { host: string; asset: string; name: string }[] {
  const out = new Map<string, { host: string; asset: string; name: string }>();
  const off = archivedAssets(app.db, orgId); // archived: not watched
  for (const a of all<{ id: string; name: string; url: string | null }>(app.db, `SELECT id, name, url FROM assets WHERE org_id = ? AND kind = 'app' AND url LIKE 'http%'`, orgId)) {
    if (off.has(a.id)) continue;
    try { const h = new URL(a.url!).hostname.toLowerCase(); if (!out.has(h)) out.set(h, { host: h, asset: a.id, name: a.name }); } catch { /* not a URL */ }
  }
  for (const d of all<{ host: string; asset: string; name: string }>(app.db, `SELECT d.name host, a.id asset, a.name name FROM edges e JOIN assets d ON d.id = e.source JOIN assets a ON a.id = e.target
      WHERE e.org_id = ? AND d.kind = 'domain' AND a.kind = 'app' AND e.kind IN ('domain', 'dns') AND e.status != 'misconfigured'`, orgId)) if (!out.has(d.host) && !off.has(d.asset) && !d.host.startsWith('*.')) out.set(d.host, d);
  return [...out.values()].slice(0, 500); // ponytail: 500 addresses per organisation per round
}

export async function probe(host: string): Promise<{ ok: boolean; code?: number; ms: number; why?: string }> {
  const t0 = Date.now();
  try {
    await assertReachable(host);
    // manual: a redirect is an answer (the site works) and is never followed to an address Unit7 didn't check
    const res = await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Unit7 uptime check' } });
    void res.body?.cancel();
    // a 4xx at the root is still a working site (an API without a home page, a login wall); 5xx is not
    return { ok: res.status < 500, code: res.status, ms: Date.now() - t0, why: res.status >= 500 ? `HTTP ${res.status}` : undefined };
  } catch (e) {
    const c = (e as { cause?: { code?: string } }).cause?.code;
    return { ok: false, ms: Date.now() - t0, why: (e as Error).name === 'TimeoutError' ? 'no answer in 10 seconds' : c === 'ENOTFOUND' ? 'the name doesn’t resolve' : /CERT|SSL|TLS/i.test(c ?? '') ? 'its HTTPS certificate is broken' : c ?? (e as Error).message.slice(0, 80) };
  }
}

export async function certificate(host: string): Promise<{ validTo?: string; why?: string }> {
  try { await assertReachable(host); } catch (e) { return { why: (e as Error).message }; }
  return new Promise((resolve) => {
    const s = tlsConnect({ host, port: 443, servername: host, timeout: 8000, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate(), problem = s.authorizationError;
      s.end();
      resolve({ validTo: c?.valid_to ? new Date(c.valid_to).toISOString() : undefined, why: problem ? String(problem) : undefined });
    });
    s.on('timeout', () => { s.destroy(); resolve({ why: 'no answer on port 443' }); });
    s.on('error', (e) => resolve({ why: e.message.slice(0, 80) }));
  });
}

// "Is it me or them?" A failed check says something about this computer's connection before it says anything about a
// site. Every site failing at once was, on a real install, a sleeping Mac or a dropped connection 128 times out of 131.
// neutral: can this computer reach the internet at all? inside: which of these sites answer from inside their own server?
// blocked: has their server banned this computer? Then every site on it looks down from here, and only from here.
export interface Blocked { server: string; ip: string; by: string }
export interface Vantage { neutral(): Promise<boolean>; inside(hosts: string[]): Promise<Set<string>>; blocked?(hosts: string[]): Promise<Map<string, Blocked>> }
const NEUTRAL = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://dns.google/resolve?name=example.com'];
export const INSIDE_CHECK = 'for h in "$@"; do c=$(curl -sk -o /dev/null -m 6 -w "%{http_code}" --resolve "$h:443:127.0.0.1" "https://$h/" 2>/dev/null); echo "$h $c"; done';
// The address the server sees this computer on, then the rule that bans it, if one does. fail2ban and firewall rules show in iptables, CrowdSec in ipset.
// ponytail: a ban held only in nftables isn't seen, so those sites read as down, as they did before
export const BLOCK_CHECK = 'ip=${SSH_CLIENT%% *}; [ -n "$ip" ] || exit 0; s=; [ "$(id -u)" = 0 ] || s="sudo -n"; echo "$ip"; $s iptables-save 2>/dev/null | grep -F -- "-s $ip/32" | grep -E -- "-j (DROP|REJECT)" | head -n 1; $s ipset list 2>/dev/null | grep -qE "^$ip( |$)" && echo "-A ipset"; true';
// (pure) what BLOCK_CHECK printed
export function banOf(stdout: string, server: string): Blocked | undefined {
  const [ip, rule] = stdout.trim().split('\n'), chain = /^-A ([\w-]+)/.exec(rule ?? '')?.[1];
  return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && chain ? { server, ip, by: chain.startsWith('f2b-') ? `fail2ban’s ${chain.slice(4)} rule` : chain === 'ipset' ? 'a block list' : 'a firewall rule' } : undefined;
}
// the connected server each of these names really points at
async function serversOf(app: App, orgId: string, hosts: string[]) {
  const ready = all<ServerRow>(app.db, `SELECT * FROM servers WHERE org_id = ? AND status = 'ready'`, orgId), out = new Map<ServerRow, string[]>();
  if (ready.length) await pool(hosts, 6, async (h) => { const ip = await lookup(h, { family: 4 }).then((a) => a.address, () => undefined), s = ready.find((x) => x.host === ip); if (s) out.set(s, [...(out.get(s) ?? []), h]); });
  return out;
}
export const serverOf = async (app: App, orgId: string, host: string) => [...(await serversOf(app, orgId, [host])).keys()][0];

// Asking for /.env is what attackers do, so a server's own defence (fail2ban, CrowdSec) bans whoever asks. From this computer that's
// you: every site on that server stops answering you for days. So a path like that goes to a connected server from inside it, where
// the proxy sees its own address. ponytail: a site behind a CDN doesn't point at the server, so it's still asked from here.
export const INSIDE_PATH = 'curl -sk -m 6 -D - -A "Unit7 security check" --resolve "$1:443:127.0.0.1" "https://$1$2" 2>/dev/null | head -c 8192';
export async function askPath(app: App, s: ServerRow | undefined, host: string, path: string, max = 4096): Promise<{ status: number; text: string } | undefined> {
  if (s) {
    const out = (await ssh(app).exec(s, script(INSIDE_PATH, host, path), { timeoutMs: 15_000 }).catch(() => undefined))?.stdout ?? '';
    const status = Number(/^HTTP\/\S+ (\d{3})/.exec(out)?.[1]), body = out.indexOf('\r\n\r\n');
    return status ? { status, text: body < 0 ? '' : out.slice(body + 4, body + 4 + max) } : undefined;
  }
  const r = await fetch(`https://${host}${path}`, { redirect: 'manual', headers: { 'user-agent': 'Unit7 security check' }, signal: AbortSignal.timeout(6000) }).catch(() => undefined);
  if (!r) return undefined;
  if (!r.body) return { status: r.status, text: '' };
  const reader = r.body.getReader(), dec = new TextDecoder();
  let text = '';
  while (text.length < max) { const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined })); if (done || !value) break; text += dec.decode(value, { stream: true }); }
  void reader.cancel().catch(() => undefined);
  return { status: r.status, text };
}

export function vantageOf(app: App, orgId: string): Vantage {
  return {
    async neutral() {
      if (process.env.UNIT7_SKIP_NET_PROBE) return true;
      const tries = await Promise.all(NEUTRAL.map((u) => fetch(u, { signal: AbortSignal.timeout(6000) }).then((r) => { void r.body?.cancel(); return r.ok; }, () => false)));
      return tries.some(Boolean);
    },
    async inside(hosts) {
      const up = new Set<string>();
      if (process.env.UNIT7_SKIP_NET_PROBE) return up;
      for (const [s, names] of await serversOf(app, orgId, hosts)) {
        const r = await ssh(app).exec(s, script(INSIDE_CHECK, ...names.slice(0, 40)), { timeoutMs: 90_000 }).catch(() => undefined);
        for (const line of (r?.stdout ?? '').split('\n')) { const [h, code] = line.trim().split(' '); if (h && Number(code) >= 200 && Number(code) < 500) up.add(h); }
      }
      return up;
    },
    async blocked(hosts) {
      const out = new Map<string, Blocked>();
      if (process.env.UNIT7_SKIP_NET_PROBE) return out;
      for (const [s, names] of await serversOf(app, orgId, hosts)) {
        const ban = banOf((await ssh(app).exec(s, script(BLOCK_CHECK), { timeoutMs: 20_000 }).catch(() => undefined))?.stdout ?? '', s.name);
        if (ban) for (const h of names) out.set(h, ban);
      }
      return out;
    },
  };
}

// what a whole round means, from what failed in it (pure)
export function roundVerdict(total: number, failed: number, neutralOk: boolean | undefined): 'fine' | 'offline' | 'many' | 'some' {
  if (!failed) return 'fine';
  if (neutralOk === false) return 'offline';
  return failed >= Math.max(3, Math.ceil(total / 2)) ? 'many' : 'some';
}

const onceEvery = (app: App, orgId: string, type: string, ms: number) => !get(app.db, 'SELECT 1 FROM events WHERE org_id = ? AND type = ? AND created_at > ?', orgId, type, new Date(Date.now() - ms).toISOString());

// what the last round found about this computer being banned. In memory, because the next round asks again.
const blockedNow = new Map<string, string>();

// every 5 minutes: is each site answering?
export async function checkSites(app: App, orgId: string, v: Vantage = vantageOf(app, orgId)) {
  const list = targets(app, orgId);
  const seen = await pool(list, 10, async (t) => ({ t, r: await probe(t.host) }));
  const failed = seen.filter((x) => !x.r.ok), names = failed.map((x) => x.t.host);
  const verdict = roundVerdict(list.length, failed.length, failed.length ? await v.neutral() : undefined);
  // one server's sites can be a small part of the map, so this is asked whenever anything failed. Only a ban found here clears a site
  // in a small round: answering inside doesn't prove strangers can reach it, and a certificate can be broken only from outside.
  const block = (failed.length && verdict !== 'offline' ? await v.blocked?.(names).catch(() => undefined) : undefined) ?? new Map<string, Blocked>();
  const ask = verdict === 'many' ? names : [...block.keys()];
  const answers = ask.length ? await v.inside(ask).catch(() => new Set<string>()) : new Set<string>();
  for (const { t, r } of seen) {
    if (r.ok) { checkSite(app, orgId, t, r); continue; }
    if (verdict === 'offline') { save(app, orgId, t.host, 'site', { ...prev(app, orgId, t.host, 'site'), detail: 'Not checked: this computer lost its connection' }); continue; }
    checkSite(app, orgId, t, answers.has(t.host) ? { ok: true, ms: 0, why: undefined, code: 200 } : r); // ms: how long it failed for isn't how fast it is
  }
  if (verdict === 'offline' && onceEvery(app, orgId, 'watch.offline', 3600_000)) app.events.emit(orgId, 'watch.offline', 'Unit7 lost its own connection, so it couldn’t check your sites. This says nothing about your sites.', { severity: 'info' });
  const ban = [...block.values()][0];
  if (ban) {
    const text = `${ban.server} has banned this computer’s address (${ban.ip}), through ${ban.by}. Its sites can’t be reached from here, but anyone else can still reach them.`;
    blockedNow.set(orgId, text);
    if (onceEvery(app, orgId, 'watch.blocked', 6 * 3600_000)) app.events.emit(orgId, 'watch.blocked', `${text} Ask Unit7 to lift it.`, { severity: 'warning', resource: ban.server });
  } else {
    if (verdict !== 'offline') blockedNow.delete(orgId);
    if (answers.size && onceEvery(app, orgId, 'watch.route', 6 * 3600_000)) app.events.emit(orgId, 'watch.route', `${answers.size} site${answers.size === 1 ? '' : 's'} didn’t answer this computer, but answer on the server itself. It’s most likely this computer’s network. If visitors complain, check the server’s firewall.`, { severity: 'warning' });
  }
  pruneWatch(app, orgId, list);
  return list.length;
}

// Rows for names nothing on the map reaches any more (a removed domain, a deleted app) are never checked again, so
// they'd say "down" forever: they go, and a problem among them says it's cleared.
export function pruneWatch(app: App, orgId: string, list = targets(app, orgId)) {
  const live = new Set(list.map((t) => t.host));
  const domains = new Set(all<{ name: string }>(app.db, `SELECT name FROM assets WHERE org_id = ? AND kind = 'domain'`, orgId).map((d) => d.name));
  // only after the map has something: an empty map (never synced) proves nothing
  if (!live.size && !domains.size) return 0;
  let n = 0;
  for (const w of watchRows(app, orgId)) {
    const gone = w.kind === 'site' || w.kind === 'tls' ? !live.has(w.host) : !domains.has(w.host);
    if (!gone) continue;
    run(app.db, 'DELETE FROM watch WHERE org_id = ? AND host = ? AND kind = ?', orgId, w.host, w.kind);
    n++;
    if (w.status === 'down' || BAD[w.kind].test(w.status)) app.events.emit(orgId, 'alert.cleared', `Cleared: ${w.host} isn’t watched any more (nothing on the map uses it)`, { severity: 'success', resource: w.host, data: { key: `${w.kind}:${w.host}`, source: 'watch' } });
  }
  return n;
}

export function checkSite(app: App, orgId: string, t: { host: string; asset: string; name: string }, r: Awaited<ReturnType<typeof probe>>) {
  const p = prev(app, orgId, t.host, 'site');
  const streak = r.ok ? 0 : (p?.streak ?? 0) + 1;
  const slow = r.ok && r.ms > SLOW_MS && !!p?.detail?.startsWith('slow'); // this check and the one before
  const status = !r.ok ? (streak >= DOWN_AFTER || p?.status === 'down' ? 'down' : 'flaky') : slow ? 'slow' : 'up';
  save(app, orgId, t.host, 'site', { status, streak, ms: r.ms, detail: r.ok ? (r.ms > SLOW_MS ? `slow: ${r.ms} ms` : `HTTP ${r.code}`) : r.why, last_ok: r.ok ? now() : undefined, asset: t.asset });
  if (status === 'down' && p?.status !== 'down') app.events.emit(orgId, 'site.down', `${t.host} (${t.name}) isn’t answering: ${r.why}`, { severity: 'critical', resource: t.host });
  if (status === 'up' && p?.status === 'down') app.events.emit(orgId, 'site.recovered', `${t.host} (${t.name}) is answering again${r.ms ? ` (${r.ms} ms)` : ''}`, { severity: 'success', resource: t.host });
  if (status === 'slow' && p?.status !== 'slow') app.events.emit(orgId, 'site.slow', `${t.host} (${t.name}) is slow: ${r.ms} ms to answer`, { severity: 'warning', resource: t.host });
  return status;
}

// at most one alert per threshold crossed (30, 14, 7, 3, 1 days, then expired)
function thresholdAlert(app: App, orgId: string, host: string, kind: WatchKind, daysLeft: number, type: string, text: string) {
  const step = [30, 14, 7, 3, 1, 0].find((d) => daysLeft <= d);
  if (step === undefined) return;
  const p = prev(app, orgId, host, kind);
  if (p?.alerted === String(step)) return;
  run(app.db, 'UPDATE watch SET alerted = ? WHERE org_id = ? AND host = ? AND kind = ?', String(step), orgId, host, kind);
  app.events.emit(orgId, type, text, { severity: daysLeft <= 3 ? 'critical' : 'warning', resource: host });
}

// renewed: the next cycle's warnings start from the first threshold again
const rearm = (app: App, orgId: string, host: string, kind: WatchKind) => run(app.db, 'UPDATE watch SET alerted = NULL WHERE org_id = ? AND host = ? AND kind = ? AND alerted IS NOT NULL', orgId, host, kind);

// one certificate's answer, kept (and alerted on); also how a renewal is checked straight after
export function saveCert(app: App, orgId: string, t: { host: string; asset?: string }, c: { validTo?: string; why?: string }) {
  if (!c.validTo) { save(app, orgId, t.host, 'tls', { status: 'unknown', detail: c.why, asset: t.asset }); return; }
  const left = days(c.validTo);
  save(app, orgId, t.host, 'tls', { status: c.why ? 'broken' : left <= 14 ? 'expiring' : 'ok', detail: c.why ?? `${left} days left`, value: c.validTo, asset: t.asset });
  if (left <= 14) thresholdAlert(app, orgId, t.host, 'tls', left, 'tls.expiring', `${t.host}'s HTTPS certificate ${left < 0 ? 'has expired' : `runs out in ${left} day${left === 1 ? '' : 's'}`}. It should renew by itself; this means renewal is failing.`);
  else rearm(app, orgId, t.host, 'tls');
}

// daily: certificates, registrations, email protection
export async function checkDaily(app: App, orgId: string) {
  await pool(targets(app, orgId), 8, async (t) => saveCert(app, orgId, t, await certificate(t.host)));
  for (const d of all<{ name: string; meta: string }>(app.db, `SELECT name, meta FROM assets WHERE org_id = ? AND kind = 'domain' AND json_extract(meta, '$.expires') IS NOT NULL`, orgId)) checkRegistration(app, orgId, d);
  const apexes = all<{ name: string }>(app.db, `SELECT name FROM assets WHERE org_id = ? AND kind = 'domain' AND json_extract(meta, '$.zone') = name`, orgId).map((x) => x.name);
  await pool(apexes, 6, (apex) => checkEmail(app, orgId, apex));
  pruneWatch(app, orgId);
}

// a domain's registration, from what the registrar said on the last scan
export function checkRegistration(app: App, orgId: string, d: { name: string; meta: string }) {
  const m = json<{ expires: string; autoRenew?: boolean; registrar?: string }>(d.meta, { expires: '' });
  const left = days(m.expires);
  save(app, orgId, d.name, 'registration', { status: left < 0 ? 'expired' : left <= (m.autoRenew ? 7 : 30) ? 'expiring' : 'ok', detail: `${left} days left${m.autoRenew === true ? ', renews by itself' : m.autoRenew === false ? ', auto-renew is OFF' : ''} (${m.registrar})`, value: m.expires });
  // renewing costs money, so Unit7 tells you; it never renews by itself
  if (left <= (m.autoRenew ? 7 : 30)) thresholdAlert(app, orgId, d.name, 'registration', left, 'domain.expiring', `${d.name} ${left < 0 ? 'has expired' : `expires in ${left} day${left === 1 ? '' : 's'}`} at ${m.registrar}${m.autoRenew === false ? ' and auto-renew is off' : ''}. Renew it there, or everything on it goes offline.`);
  else rearm(app, orgId, d.name, 'registration');
}

// (pure) can others send email as this domain? A domain that sends no email only needs DMARC to say reject: fakes fail it with or without SPF.
export function emailStatus(hasMx: boolean, root: string[], dmarc: string[]) {
  const spf = root.some((t) => /^v=spf1/i.test(t)), dm = dmarc.some((t) => /^v=DMARC1/i.test(t)), rejects = dmarc.some((t) => /^v=DMARC1/i.test(t) && /;\s*p=(reject|quarantine)\b/i.test(t));
  const missing = [!spf && (hasMx || !rejects) && 'SPF', !dm && 'DMARC'].filter(Boolean) as string[];
  return { status: missing.length ? (hasMx ? 'unprotected' : 'spoofable') : 'ok',
    detail: missing.length ? `${missing.join(' and ')} missing${hasMx ? ': your email may land in spam, and others can send as you' : ': this domain sends no email, but anyone can pretend it does'}` : spf ? 'SPF and DMARC set' : 'DMARC rejects anything sent in this name' };
}
// DNS can't list a domain's DKIM keys, so the names senders usually use are asked
export const DKIM_SELECTORS = ['resend', 'google', 'default', 'selector1', 'selector2', 'k1', 's1', 's2', 'dkim', 'mail', 'smtp', 'zoho', 'hostingermail-a', 'fm1', 'protonmail', 'pm', 'cf2024-1'];
export const isDkimKey = (t: string) => /(^|;)\s*p=[A-Za-z0-9+/]/.test(t);
// (pure) signed, unsigned, or silent: a domain with no mail has nothing to sign
export const dkimWord = (signed: boolean, hasMx: boolean, root: string[]) => (signed ? 'signed' : hasMx || root.some((t) => /^v=spf1\s+\S/i.test(t) && !/^v=spf1\s+-all\s*$/i.test(t)) ? 'unsigned' : 'silent');
// (SPF, DMARC and DKIM, asked of public resolvers)
export async function checkEmail(app: App, orgId: string, apex: string) {
  const [hasMx, root, dmarc, keys] = await Promise.all([mx(apex), txt(apex), txt(`_dmarc.${apex}`), Promise.all(DKIM_SELECTORS.map((s) => txt(`${s}._domainkey.${apex}`)))]);
  save(app, orgId, apex, 'email', { ...emailStatus(hasMx, root, dmarc), value: dkimWord(keys.flat().some(isDkimKey), hasMx, root) });
}

export const watchRows = (app: Pick<App, 'db'>, orgId: string) => all<WatchRow>(app.db, 'SELECT host, kind, status, detail, streak, ms, last_ok, checked_at, value, asset FROM watch WHERE org_id = ? ORDER BY kind, host', orgId);

// what needs a look, worst first, for the map
export function watchIssues(app: Pick<App, 'db'>, orgId: string) {
  const out: { severity: 'critical' | 'warning' | 'info'; key: string; text: string; about?: string }[] = [];
  const ban = blockedNow.get(orgId);
  if (ban) out.push({ severity: 'warning', key: 'blocked', text: ban });
  const off = archivedAssets(app.db, orgId);
  for (const w of watchRows(app, orgId)) {
    if (w.asset && off.has(w.asset)) continue; // archived: no alerts
    if (w.kind === 'site' && w.status === 'down') out.push({ severity: 'critical', key: `down:${w.host}`, about: w.asset ?? undefined, text: `${w.host} is down: ${w.detail}.` });
    if (w.kind === 'site' && w.status === 'slow') out.push({ severity: 'warning', key: `slow:${w.host}`, about: w.asset ?? undefined, text: `${w.host} is slow (${w.ms} ms).` });
    if (w.kind === 'tls' && (w.status === 'expiring' || w.status === 'broken')) out.push({ severity: w.status === 'broken' ? 'critical' : 'warning', key: `tls:${w.host}`, text: `${w.host}'s HTTPS certificate: ${w.detail}.` });
    if (w.kind === 'registration' && w.status !== 'ok') out.push({ severity: w.status === 'expired' || days(w.value!) <= 7 ? 'critical' : 'warning', key: `reg:${w.host}`, text: `${w.host}'s registration: ${w.detail}.` });
    if (w.kind === 'email' && w.status !== 'ok') out.push({ severity: w.status === 'unprotected' ? 'warning' : 'info', key: `email:${w.host}`, text: `${w.host}: ${w.detail}.` });
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
