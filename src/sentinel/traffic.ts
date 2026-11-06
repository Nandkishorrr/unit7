// The traffic and log watch (every 30 or 60 minutes): one read-only SSH trip reads the access logs of whatever
// serves the web on a server (Unit7's Caddy, Coolify's Traefik, nginx) and counts errors in the apps' own logs.
// The pure code here turns those lines into a summary (requests, visitors, 4xx/5xx, top paths and user agents,
// bots and scanners, login hammering, calls without signing in) and compares it with the usual for this time
// of the week, raising findings with evidence (query strings and secrets removed) and a fix.
import { createHmac, randomBytes } from 'node:crypto';
import { Redactor } from '../redact.ts';
import { classify } from '../netguard.ts';
import { bandOf, median } from './baseline.ts';
import { fmtTimes } from './anomaly.ts';
import type { Finding, Severity, Fix } from '../tools/security.ts';

export type Bucket = 'risk' | 'waste' | 'tip';
export type WatchFinding = Finding & { bucket: Bucket };

const PRELUDE = `export LC_ALL=C PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin"
if command -v timeout >/dev/null 2>&1; then t() { n=$1; shift; timeout "$n" "$@" 2>/dev/null; }; else t() { shift; "$@" 2>/dev/null; }; fi
s() { printf '\\n@@unit7:%s\\n' "$1"; }
`;
// An app's log, down to its real error lines: never an access line that answered (a URL can hold the word "exceptions"
// or "last_error" and still be a normal 200), never a line that says it's only info. Shared so a test can run it.
export const ERROR_LINES = `grep -iE 'error|exception|fatal|panic|traceback|unhandled|segfault' | grep -vE '"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) [^"]*" [1-4][0-9][0-9] ' | grep -viE '(level|lvl|severity)"?[=:] ?"?(info|debug|trace|notice)\\b|"level":(10|20|30)\\b'`;

// $1 = the window in minutes. Each log is capped at its newest 100,000 lines. Coolify's proxy is only read
// (docker logs, or a tail inside it when its access log goes to a file). Unit7 changes Coolify's own settings only
// through these typed tools (coolify.proxy turns this log on), never with raw edits through server.exec.
export const TRAFFIC_PROBE = PRELUDE + `M="\${1:-30}"
names=$(t 5 docker ps --format '{{.Names}}')
s proxies
printf '%s\\n' "$names" | grep -xE 'unit7-caddy|coolify-proxy'
[ -r /var/log/nginx/access.log ] && echo nginx
if printf '%s\\n' "$names" | grep -qx unit7-caddy; then s caddy_log; t 30 docker logs --since "\${M}m" unit7-caddy 2>&1 | grep '"handled request"' | tail -n 100000; fi
if printf '%s\\n' "$names" | grep -qx coolify-proxy; then
  a=$(t 5 docker inspect -f '{{json .Args}}' coolify-proxy); s traefik_args; echo "$a"
  if printf '%s' "$a" | grep -q -- '"--accesslog' && ! printf '%s' "$a" | grep -q -- '"--accesslog=false"'; then
    f=$(printf '%s' "$a" | tr ',' '\\n' | grep -- '--accesslog.filepath=' | head -1 | sed 's/.*--accesslog.filepath=//; s/["\\]]*$//')
    s traefik_log
    if [ -n "$f" ]; then t 30 docker exec coolify-proxy tail -n 100000 "$f"; else t 30 docker logs --since "\${M}m" coolify-proxy 2>&1 | tail -n 100000; fi
  fi
fi
if [ -r /var/log/nginx/access.log ]; then s nginx_log; tail -n 100000 /var/log/nginx/access.log; fi
s app_errors
for c in $(printf '%s\\n' "$names" | grep -vxE 'coolify|coolify-(db|redis|realtime|proxy|sentinel)|unit7-caddy' | head -40); do
  l=$(t 10 docker logs --since "\${M}m" --tail 20000 "$c" 2>&1 | ${ERROR_LINES})
  [ -n "$l" ] && { echo "##$c $(printf '%s\\n' "$l" | wc -l)"; printf '%s\\n' "$l" | tail -n 3 | cut -c1-300; }
done
`;

// --- one access log line, whichever proxy wrote it ------------------------------------------------------
export interface Hit { at: number; ip: string; method: string; host?: string; path: string; status: number; ua?: string; ms?: number; anon?: boolean; router?: string; upstream?: string; country?: string; bytes?: number; ref?: string; qs?: string; qh?: string; fine?: boolean } // upstream: which copy answered (a canary's log_append); country: Cloudflare's Cf-Ipcountry
const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const clfTime = (t: string) => { // 07/Oct/2026:10:00:00 +0000
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(t);
  return m ? Date.parse(`${m[3]}-${MONTHS[m[2]!] ?? '01'}-${m[1]}T${m[4]}${m[5]}${m[6]}:${m[7]}`) : NaN;
};
// nginx "combined" and Traefik's "common" format (which adds a count, the router, the upstream and the time taken)
const CLF = /^(\S+) \S+ (\S+) \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) (\S+)(?: "([^"]*)" "([^"]*)")?(?: \d+ "([^"]*)" "[^"]*" (\d+)ms)?/;
// a visit's address without its query or fragment, from the moment it's read: those can carry tokens (?apikey=, reset
// and magic-link codes), so Unit7 never keeps or shows them, even where the server's own log does
export const pathOnly = (p: string) => p.split(/[?#]/)[0] || '/';
// The query's shape and a keyed hash, worked out here and then dropped: id=eq.5&select=* becomes id=eq&select, and the hash can only
// be compared inside this one read, because the key is thrown away with it. So a loop over ?id=eq.1, ?id=eq.2 shows, and no value stays.
export function queryOf(uri: string, salt: Buffer) {
  const raw = uri.split('#')[0]!.split('?')[1];
  if (!raw) return {};
  const shape = raw.split('&').filter(Boolean).map((kv) => { const [k = '', v = ''] = kv.split('='); const op = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is|cs|cd|fts)\./.exec(v)?.[0]?.slice(0, -1); return `${decodeSafe(k).replace(/[^\w.-]/g, '').slice(0, 40)}${op ? `=${op}` : ''}`; }).sort().join('&').slice(0, 120);
  return { qs: shape, qh: createHmac('sha256', salt).update(raw).digest('hex').slice(0, 12) };
}
const decodeSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
// the page a call came from, same site only: a path to group by, never a query
const refOf = (ref: string | undefined, host?: string) => { if (!ref || ref === '-') return undefined; try { const u = new URL(ref); return !host || u.hostname === host.replace(/:\d+$/, '') ? normPath(u.pathname) : undefined; } catch { return undefined; } };
const hdr = (h: Record<string, unknown> | undefined, name: string) => { const v = h?.[name] ?? h?.[name.toLowerCase()]; return Array.isArray(v) ? String(v[0] ?? '') : v === undefined ? undefined : String(v); };
export function parseHit(line: string, salt: Buffer = randomBytes(16)): Hit | undefined {
  const l = line.trim();
  if (!l) return undefined;
  if (l.startsWith('{')) {
    let e: any; try { e = JSON.parse(l); } catch { return undefined; }
    if (e?.request && typeof e.status === 'number') { // Caddy
      const h = e.request.headers as Record<string, unknown> | undefined;
      const host = String(e.request.host ?? '').toLowerCase().replace(/:\d+$/, ''), rf = refOf(hdr(h, 'Referer'), host);
      return { ...queryOf(String(e.request.uri ?? '/'), salt), fine: true, ...(typeof e.size === 'number' && { bytes: e.size }), ...(rf && { ref: rf }), at: typeof e.ts === 'number' ? e.ts * 1000 : Date.parse(e.ts), ip: String(e.request.client_ip || e.request.remote_ip || ''), method: String(e.request.method ?? ''), host: String(e.request.host ?? '').toLowerCase().replace(/:\d+$/, '') || undefined,
        path: pathOnly(String(e.request.uri ?? '/')), status: e.status, ua: hdr(h, 'User-Agent'), ms: typeof e.duration === 'number' ? e.duration * 1000 : undefined, ...(h && { anon: !hdr(h, 'Cookie') && !hdr(h, 'Authorization') }),
        ...(typeof e.upstream === 'string' && e.upstream && { upstream: e.upstream }), ...(/^[A-Z]{2}$/.test(hdr(h, 'Cf-Ipcountry') ?? '') && { country: hdr(h, 'Cf-Ipcountry') }) };
    }
    if (e?.ClientHost !== undefined || e?.RequestPath !== undefined) { // Traefik JSON
      const hasAuth = 'request_Cookie' in e || 'request_Authorization' in e, rf = refOf(e.request_Referer, e.RequestHost ? String(e.RequestHost).toLowerCase() : undefined);
      return { ...queryOf(String(e.RequestPath ?? '/'), salt), fine: true, ...(typeof e.DownstreamContentSize === 'number' && { bytes: e.DownstreamContentSize }), ...(rf && { ref: rf }), at: Date.parse(e.StartUTC ?? e.time), ip: String(e.ClientHost ?? '').replace(/^\[|\]$/g, ''), method: String(e.RequestMethod ?? ''), host: e.RequestHost ? String(e.RequestHost).toLowerCase().replace(/:\d+$/, '') : undefined,
        path: pathOnly(String(e.RequestPath ?? '/')), status: Number(e.DownstreamStatus ?? e.OriginStatus) || 0, ua: e['request_User-Agent'], ms: typeof e.Duration === 'number' ? e.Duration / 1e6 : undefined, router: e.RouterName, ...(hasAuth && { anon: false }) };
    }
    return undefined;
  }
  const m = CLF.exec(l);
  if (!m) return undefined;
  const rf = refOf(m[8]);
  return { ...queryOf(m[5]!, salt), ...(/^\d+$/.test(m[7]!) && { bytes: Number(m[7]) }), ...(rf && { ref: rf }), at: clfTime(m[3]!), ip: m[1]!, method: m[4]!, path: pathOnly(m[5]!), status: Number(m[6]), ua: m[9] && m[9] !== '-' ? m[9] : undefined, ...(m[10] && { router: m[10] }), ...(m[11] && { ms: Number(m[11]) }), ...(m[2] !== '-' && { anon: false }) };
}
// Traefik's JSON only says a call carried a sign-in when it's set to keep those headers: then "missing" means anonymous
export function parseLog(text = ''): { hits: Hit[]; anonKnown: boolean } {
  const hits: Hit[] = [];
  let traefikAuth = false, caddy = false;
  const salt = randomBytes(16);
  for (const line of text.split('\n')) {
    const h = parseHit(line, salt);
    if (!h) continue;
    if (line.includes('"request_Cookie"') || line.includes('"request_Authorization"')) traefikAuth = true;
    if (line.includes('"handled request"')) caddy = true;
    hits.push(h);
  }
  if (traefikAuth) for (const h of hits) if (h.router !== undefined && h.anon === undefined) h.anon = true;
  return { hits, anonKnown: caddy || traefikAuth };
}

// Coolify's proxy: is its access log on, where does it go, and in what shape
export function traefikAccess(argsJson?: string): { on: boolean; file?: string; format: 'json' | 'common'; headers: boolean } {
  let args: string[] = [];
  try { args = JSON.parse(argsJson?.trim() || '[]'); } catch { /* not readable */ }
  const val = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
  const on = args.some((a) => a === '--accesslog' || a.startsWith('--accesslog.')) || /^true$/i.test(val('--accesslog') ?? '');
  return { on: on && !/^false$/i.test(val('--accesslog') ?? ''), file: val('--accesslog.filepath'), format: /json/i.test(val('--accesslog.format') ?? '') ? 'json' : 'common', headers: args.some((a) => /^--accesslog\.fields\.headers\.names\.(Cookie|Authorization)=/i.test(a)) };
}

// --- what a window of traffic says -----------------------------------------------------------------------
export const SCANNER = /\/(\.env|\.git\/|\.aws|\.ssh|wp-login\.php|wp-admin|wp-content|xmlrpc\.php|phpmyadmin|pma\/|myadmin|vendor\/phpunit|cgi-bin|actuator|\.\.\/|config\.php|server-status|boaform|HNAP1|owa\/|solr\/|\.DS_Store|backup\.(zip|sql|tar)|eval-stdin|shell\.php|setup\.php)/i;
export const LOGIN = /\/(login|signin|sign-in|log-in|auth|session|sessions|token|oauth\/token|users\/sign_in|account\/login|wp-login\.php|xmlrpc\.php)(\/|$|\?|\.)/i;
const BOT = /^node$|^wordpress\/|guzzlehttp|bot|crawl|spider|slurp|curl|wget|python|go-http|okhttp|axios|node-fetch|undici|headless|zgrab|masscan|nuclei|sqlmap|nikto|scan|httpclient|java\/|libwww|ruby|php\/|uptime|monitor|pingdom|statuscake|unit7/i;
const AGENTS: [RegExp, string][] = [[/unit7/i, 'Unit7’s own checks'], [/googlebot/i, 'Googlebot'], [/bingbot/i, 'Bingbot'], [/gptbot|chatgpt/i, 'OpenAI bot'], [/claudebot|anthropic/i, 'Claude bot'], [/ahrefs/i, 'Ahrefs bot'], [/semrush/i, 'Semrush bot'],
  [/facebookexternalhit|meta-externalagent/i, 'Facebook preview'], [/curl\//i, 'curl'], [/python-requests|python-urllib|aiohttp|httpx/i, 'Python script'], [/go-http-client/i, 'Go program'], [/wget/i, 'wget'],
  [/okhttp/i, 'Android app (okhttp)'], [/axios|node-fetch|undici/i, 'Node.js script'], [/zgrab|masscan|nuclei|sqlmap|nikto|censys|shodan/i, 'Scanner'], [/headless/i, 'Headless browser'],
  [/edg\//i, 'Edge'], [/firefox\//i, 'Firefox'], [/chrome\//i, 'Chrome'], [/safari\//i, 'Safari'], [/bot|crawl|spider/i, 'Other bot']];
export const agentOf = (ua?: string) => (ua ? AGENTS.find(([re]) => re.test(ua))?.[1] ?? 'Other' : 'No user agent');
export const isBot = (ua?: string) => !ua || BOT.test(ua);
// /users/123/orders/9f8e… → /users/:id/orders/:id, and never a query string (it can carry tokens)
export const normPath = (p: string) => (p.split(/[?#]/)[0] || '/').replace(/\/(\d+|[0-9a-f]{8,}(-[0-9a-f]{4,}){0,4}|[A-Za-z0-9_-]{22,})(?=\/|$)/g, '/:id').slice(0, 120);

export interface AppErrors { container: string; n: number; sample: string[] }
export interface Summary {
  at: string; minutes: number; requests: number; ips: number; status: { s2xx: number; s3xx: number; s4xx: number; s5xx: number }; p95?: number;
  topPaths: { path: string; n: number; s4xx: number; s5xx: number }[]; topAgents: { agent: string; n: number; bot: boolean }[];
  topIps: { ip: string; n: number; anon: number; logins: number; scans: number; s4xx: number }[]; hosts: { host: string; n: number; s5xx: number }[];
  bots: number; scanners: { n: number; ips: number }; logins: { n: number; failed: number; ips: number }; anon: { n: number; ips: number; how: 'headers' | 'refused' };
  errors: AppErrors[]; sources: { id: string; name: string; lines: number; note?: string }[];
  // per site, the answered requests (not scanners) by who made them, each counted once: people opening pages in a browser,
  // programs (other servers, scripts, apps, no user agent) and a browser calling API-style paths. Says whether an API
  // nobody visits is in use (asset.cleanup).
  callers?: { host: string; people: number; programs: number; api: number }[];
  // every request counted once by who made it: real browsers (and how many different ones), your own apps calling from
  // inside the server, other programs, bots and scanners, and Unit7's own checks. "Visits" means visitors, never requests.
  who?: { people: number; visitors: number; own: number; programs: number; bots: number; unit7: number };
  // per site, calls to each part of a Supabase-style stack, so a part nobody uses can be spotted (a top-ten list would miss it)
  stack?: Record<string, Record<string, number>>;
}
const PROGRAM = /^node$|^wordpress\/|curl|python|go-http|okhttp|axios|node-fetch|undici|java\/|httpclient|ruby|php\/|libwww|wget|postman|insomnia|dart|reqwest|guzzle/i;
const API_PATH = /^\/(api|v\d+|graphql|rpc|trpc|webhooks?|hooks?|rest|functions)(\/|$)|\.json$/i;
const STACK_PATH = /^\/(realtime|storage|functions|graphql|auth|rest)\/v\d/;
const topN = <T>(m: Map<string, T>, n: number, by: (x: T) => number) => [...m].sort((a, b) => by(b[1]) - by(a[1])).slice(0, n);

// inside the server: a private address, or the server's own (self)
const fromInside = (ip: string, self: string[] = []) => self.includes(ip) || ['private', 'loopback'].includes(classify(ip));
export function analyze(hits: Hit[], o: { now?: number; minutes: number; anonKnown: boolean; errors?: AppErrors[]; sources?: Summary['sources']; self?: string[] }): Summary {
  const now = o.now ?? Date.now(), from = now - o.minutes * 60_000;
  const win = hits.filter((h) => !(h.at < from) && !(h.at > now + 60_000)); // a line without a readable time counts (docker logs --since already cut it)
  const status = { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 };
  const paths = new Map<string, { n: number; s4xx: number; s5xx: number }>(), agents = new Map<string, { n: number; bot: boolean }>(), hosts = new Map<string, { n: number; s5xx: number }>();
  const ips = new Map<string, { n: number; anon: number; logins: number; scans: number; s4xx: number }>();
  const callers = new Map<string, { people: number; programs: number; api: number }>();
  let bots = 0, scans = 0, logins = 0, failed = 0, anon = 0;
  const who = { people: 0, visitors: 0, own: 0, programs: 0, bots: 0, unit7: 0 };
  const stack: Record<string, Record<string, number>> = {};
  const visitors = new Set<string>();
  const ms: number[] = [];
  for (const h of win) {
    const c = h.status >= 500 ? 's5xx' : h.status >= 400 ? 's4xx' : h.status >= 300 ? 's3xx' : 's2xx';
    status[c]++;
    const path = normPath(h.path);
    const p = paths.get(path) ?? { n: 0, s4xx: 0, s5xx: 0 }; p.n++; if (c === 's4xx') p.s4xx++; if (c === 's5xx') p.s5xx++; paths.set(path, p);
    const ag = agentOf(h.ua), bot = isBot(h.ua);
    const a = agents.get(ag) ?? { n: 0, bot }; a.n++; agents.set(ag, a);
    if (bot) bots++;
    if (h.ua && /unit7/i.test(h.ua)) who.unit7++;
    else if (fromInside(h.ip, o.self)) who.own++;
    else if (!bot) { who.people++; visitors.add(`${h.ip}|${h.ua}`); }
    else if (!h.ua || PROGRAM.test(h.ua)) who.programs++;
    else who.bots++;
    const host = h.host ?? h.router;
    const part = STACK_PATH.exec(h.path)?.[1];
    if (host && part) { const t = (stack[host] ??= {}); t[part] = (t[part] ?? 0) + 1; }
    if (host) { const x = hosts.get(host) ?? { n: 0, s5xx: 0 }; x.n++; if (c === 's5xx') x.s5xx++; hosts.set(host, x); }
    if (host && h.status < 400 && !SCANNER.test(h.path)) {
      const k = callers.get(host) ?? { people: 0, programs: 0, api: 0 };
      if (bot) { if (!h.ua || PROGRAM.test(h.ua)) k.programs++; } else if (API_PATH.test(pathOnly(h.path))) k.api++; else k.people++;
      callers.set(host, k);
    }
    const ip = ips.get(h.ip) ?? { n: 0, anon: 0, logins: 0, scans: 0, s4xx: 0 };
    ip.n++; if (c === 's4xx') ip.s4xx++;
    const isAnon = o.anonKnown ? h.anon !== false : h.status === 401 || h.status === 403;
    if (isAnon) { ip.anon++; anon++; }
    if (SCANNER.test(h.path) && !(/unit7/i.test(h.ua ?? '') && fromInside(h.ip, o.self))) { ip.scans++; scans++; } // Unit7's own file checks, from inside, aren't bots looking for a way in
    if (LOGIN.test(h.path) && (h.method === 'POST' || /wp-login|xmlrpc/i.test(h.path))) { ip.logins++; logins++; if (h.status >= 400) failed++; }
    ips.set(h.ip, ip);
    if (typeof h.ms === 'number') ms.push(h.ms);
  }
  ms.sort((a, b) => a - b);
  return {
    at: new Date(now).toISOString(), minutes: o.minutes, requests: win.length, ips: ips.size, status, ...(ms.length && { p95: Math.round(ms[Math.floor(ms.length * 0.95)] ?? ms.at(-1)!) }),
    topPaths: topN(paths, 10, (x) => x.n).map(([path, x]) => ({ path, ...x })), topAgents: topN(agents, 8, (x) => x.n).map(([agent, x]) => ({ agent, ...x })),
    topIps: topN(ips, 10, (x) => x.n).map(([ip, x]) => ({ ip, ...x })), hosts: topN(hosts, 10, (x) => x.n).map(([host, x]) => ({ host, ...x })),
    bots, scanners: { n: scans, ips: [...ips.values()].filter((x) => x.scans).length }, logins: { n: logins, failed, ips: [...ips.values()].filter((x) => x.logins).length },
    anon: { n: anon, ips: [...ips.values()].filter((x) => x.anon).length, how: o.anonKnown ? 'headers' : 'refused' },
    errors: o.errors ?? [], sources: o.sources ?? [],
    callers: topN(callers, 20, (x) => x.people + x.programs + x.api).map(([host, x]) => ({ host, ...x })),
    who: { ...who, visitors: visitors.size }, ...(Object.keys(stack).length && { stack }),
  };
}

export function parseErrors(text = ''): AppErrors[] {
  const out: AppErrors[] = [];
  for (const chunk of text.split(/^##/m).slice(1)) {
    const [head = '', ...rest] = chunk.split('\n');
    const m = /^(\S+)\s+(\d+)/.exec(head.trim());
    if (m) out.push({ container: m[1]!, n: Number(m[2]), sample: rest.map((l) => l.trim()).filter(Boolean).slice(-3) });
  }
  return out;
}

// --- the whole probe → a summary, plus how each source was read ---------------------------------------------
export function readProbe(sec: Record<string, string>, o: { now?: number; minutes: number; self?: string[] }) {
  const proxies = (sec.proxies ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const sources: Summary['sources'] = [];
  const hits: Hit[] = [];
  let anonKnown = true, any = false;
  const take = (id: string, name: string, text: string | undefined, note?: string) => {
    if (text === undefined) return;
    const p = parseLog(text);
    hits.push(...p.hits); any ||= p.hits.length > 0;
    if (p.hits.length) anonKnown &&= p.anonKnown;
    sources.push({ id, name, lines: p.hits.length, ...(note && { note }) });
  };
  take('unit7-caddy', 'Unit7’s web server', sec.caddy_log);
  const traefik = proxies.includes('coolify-proxy') ? traefikAccess(sec.traefik_args) : undefined;
  if (traefik && !traefik.on) sources.push({ id: 'coolify-traefik', name: 'Coolify’s proxy', lines: 0, note: 'its access log is off' });
  else take('coolify-traefik', 'Coolify’s proxy', sec.traefik_log, traefik && !traefik.headers ? 'it doesn’t record sign-in headers, so calls refused for not being signed in stand in for anonymous ones' : undefined);
  take('nginx', 'nginx', sec.nginx_log);
  const s = analyze(hits, { ...o, anonKnown: any && anonKnown, errors: parseErrors(sec.app_errors), sources });
  return { summary: s, traefik, hits };
}

// --- findings: this window against the usual for this time of the week ------------------------------------
interface Ctx { serverId: string; serverName: string }
const per = (w: Summary, v: number) => v / Math.max(1, w.minutes);
const n = (x: number) => (x >= 10_000 ? `${(x / 1000).toFixed(0)}k` : x >= 1000 ? `${(x / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(x));
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
export const blockFix = (serverId: string, ip: string, reason: string): Fix => ({
  tool: 'shield.block', input: { serverId, ip, reason }, label: `Block ${ip}`, safe: true,
  change: `Blocks ${ip} for 15 minutes, longer if it comes back. It lifts by itself.`, undo: { tool: 'shield.unblock', input: { serverId, ip }, label: 'Unblock it' },
});
const blockable = (ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && classify(ip) === 'public';
const lookFix = (what: string): Fix => ({ manual: [`Ask Unit7: “${what}”. It reads the logs and recent changes and tells you what it finds.`], label: 'Ask Unit7 to look',
  ask: `${what.charAt(0).toUpperCase()}${what.slice(1)} Look first, read-only: the logs, the traffic and recent changes. Don’t change anything yet; tell me what you find in plain words and the fix you’d make.` });

// usual per minute for this time of the week, from earlier windows (median and band)
export function usualOf(past: Summary[], at: string, f: (w: Summary) => number) {
  return bandOf(past.map((w) => ({ at: w.at, v: per(w, f(w)) })), at, (m) => Math.max(0.5, 0.5 * m));
}

export function trafficFindings(w: Summary, seen: Summary[], c: Ctx): WatchFinding[] {
  const out: WatchFinding[] = [];
  const past = seen.filter((x) => x.requests > 0 || x.sources?.some((s) => s.lines > 0)); // a check that read no log says nothing about what's usual
  const red = new Redactor();
  const add = (f: Omit<WatchFinding, 'area' | 'by' | 'about' | 'serverId' | 'bucket'> & { bucket?: Bucket }) =>
    out.push({ bucket: 'risk', ...f, evidence: f.evidence && red.redact(f.evidence), area: 'server', by: 'unit7', serverId: c.serverId, about: { kind: 'server', id: c.serverId, name: c.serverName } });
  const mins = `${w.minutes} minutes`;
  const top = w.topIps[0];
  const topPath = w.topPaths[0];
  const usual = (f: (x: Summary) => number) => usualOf(past, w.at, f);
  const vs = (now: number, f: (x: Summary) => number) => { const u = usual(f); return u ? { u, ratio: per(w, now) / Math.max(u.mid, 0.01), over: per(w, now) > u.hi } : undefined; };

  // 1. a surge in requests
  const r = vs(w.requests, (x) => x.requests);
  // traffic grows: the last days are the better guide when they're busier than the same hour weeks ago
  const lately = past.slice(-48).map((x) => per(x, x.requests));
  if (r && lately.length >= 12) { const m = median(lately); if (m > r.u.mid) { r.u = { ...r.u, mid: m, hi: Math.max(r.u.hi, m * 2) }; r.ratio = per(w, w.requests) / Math.max(m, 0.01); r.over = per(w, w.requests) > r.u.hi; } }
  if (w.requests >= 300 && r && r.over && r.ratio >= 3) {
    const one = top && top.n >= 0.4 * w.requests ? top : undefined;
    add({ id: `traffic:surge:${c.serverId}`, severity: r.ratio >= 10 ? 'high' : 'medium', title: `${n(w.requests)} requests in the last ${mins}, ${fmtTimes(r.ratio)} the usual`,
      detail: one ? `Most of them (${pct(one.n, w.requests)}%) came from one address, ${one.ip}.` : `They came from ${n(w.ips)} addresses${topPath ? `; the busiest page was ${topPath.path}` : ''}. If it’s real visitors, great; if it’s a bot, it costs you CPU.`,
      evidence: `Usually about ${n(Math.round(r.u.mid * w.minutes))} in ${mins} at this time. Top: ${w.topPaths.slice(0, 3).map((p) => `${p.path} (${n(p.n)})`).join(', ')}`,
      fix: one && blockable(one.ip) ? blockFix(c.serverId, one.ip, 'request flood') : lookFix(`why is traffic on ${c.serverName} so high?`) });
  }

  // 2. server errors
  const e5 = vs(w.status.s5xx, (x) => x.status.s5xx);
  const rate5 = w.requests ? w.status.s5xx / w.requests : 0;
  if (w.status.s5xx >= 20 && rate5 >= 0.05 && (!e5 || e5.ratio >= 3)) {
    const worst = [...w.topPaths].sort((a, b) => b.s5xx - a.s5xx)[0];
    const host = [...w.hosts].sort((a, b) => b.s5xx - a.s5xx)[0];
    add({ id: `traffic:5xx:${c.serverId}`, severity: rate5 >= 0.2 ? 'critical' : 'high', title: `${n(w.status.s5xx)} requests failed with a server error (${pct(w.status.s5xx, w.requests)}%)`,
      detail: `Visitors got an error page instead of your site${host?.s5xx ? `, mostly on ${host.host}` : ''}. ${e5 ? `Usually it’s about ${Math.round(e5.u.mid * w.minutes)} in ${mins}.` : ''}`.trim(),
      evidence: worst?.s5xx ? `Most on ${worst.path} (${worst.s5xx})` : undefined, fix: lookFix(`why are requests failing on ${c.serverName}?`) });
  }

  // 3. calls without signing in: one address, or a crowd
  const anonWord = w.anon.how === 'headers' ? 'calls without signing in' : 'calls refused for not being signed in';
  const anonTop = [...w.topIps].sort((a, b) => b.anon - a.anon)[0];
  if (anonTop && anonTop.anon >= 300 && anonTop.anon >= 0.25 * w.requests) {
    add({ id: `traffic:anon-one:${c.serverId}:${anonTop.ip}`, severity: 'high', title: `One address made ${n(anonTop.anon)} ${anonWord}`,
      detail: `${anonTop.ip} sent ${pct(anonTop.n, w.requests)}% of all traffic in the last ${mins}. Someone (or something) is hammering your site.`,
      evidence: `${anonTop.ip}: ${n(anonTop.n)} requests, ${n(anonTop.anon)} ${anonWord}, ${n(anonTop.s4xx)} refused`,
      fix: blockable(anonTop.ip) ? blockFix(c.serverId, anonTop.ip, 'many calls without signing in') : lookFix(`who is ${anonTop.ip} calling ${c.serverName}?`) });
  } else {
    const a = vs(w.anon.n, (x) => x.anon.n);
    if (w.anon.n >= 500 && w.anon.ips >= 30 && ((a && a.over && a.ratio >= 3) || (!a && w.anon.n >= 2000))) {
      add({ id: `traffic:anon-many:${c.serverId}`, severity: 'medium', title: `${n(w.anon.n)} ${anonWord} from ${n(w.anon.ips)} addresses${a ? `, ${fmtTimes(a.ratio)} the usual` : ''}`,
        detail: `A crowd of addresses is calling without signing in. Blocking one at a time won’t help; a limit per address on the busiest paths will.${topPath ? ` The busiest path is ${topPath.path}.` : ''}`,
        evidence: w.topPaths.slice(0, 3).map((p) => `${p.path} (${n(p.n)})`).join(', '),
        fix: { manual: [`Add a rate limit to ${topPath?.path ?? 'the busiest paths'} in your app (for example 60 requests a minute per address).`, 'If the calls are a bot you don’t want, ask Unit7 to block the busiest addresses.'], label: 'Ask Unit7 to slow them down',
          ask: `A crowd of addresses is calling ${c.serverName} without signing in (${n(w.anon.n)} calls from ${n(w.anon.ips)} addresses${topPath ? `, mostly ${topPath.path}` : ''}). Block the busiest ones with Shield and tell me how to add a limit per address. Show me the plan first.` } });
    }
  }

  // 4. someone guessing passwords on a login page
  const hammer = [...w.topIps].sort((a, b) => b.logins - a.logins)[0];
  if (hammer && hammer.logins >= 30) {
    add({ id: `traffic:login-one:${c.serverId}:${hammer.ip}`, severity: 'high', title: `${hammer.ip} tried to sign in ${n(hammer.logins)} times in ${mins}`,
      detail: 'That’s password guessing, not a person who forgot theirs.', evidence: `${n(w.logins.failed)} failed sign-ins in total from ${w.logins.ips} address${w.logins.ips === 1 ? '' : 'es'}`,
      fix: blockable(hammer.ip) ? blockFix(c.serverId, hammer.ip, 'password guessing') : lookFix(`who is guessing passwords on ${c.serverName}?`) });
  } else if (w.logins.failed >= 100 && w.logins.ips >= 10) {
    add({ id: `traffic:login-many:${c.serverId}`, severity: 'medium', title: `${n(w.logins.failed)} failed sign-ins from ${w.logins.ips} addresses in ${mins}`,
      detail: 'Many addresses are guessing passwords on your sign-in page at once.',
      fix: { manual: ['Limit sign-in tries per address in your app (for example 5 a minute), or add a captcha after a few failures.', 'Turn on two-step sign-in for admin accounts.'], label: 'Ask Unit7 to slow them down',
        ask: `Many addresses are guessing passwords on ${c.serverName}’s sign-in page (${n(w.logins.failed)} failed sign-ins from ${w.logins.ips} addresses). Block the worst ones with Shield and tell me how to limit sign-in tries. Show me the plan first.` } });
  }

  // 5. scanners looking for open doors (common on the internet; worth a look when one is persistent)
  if (w.scanners.n >= 20) {
    const scanner = [...w.topIps].sort((a, b) => b.scans - a.scans)[0]!;
    add({ id: `traffic:scan:${c.serverId}`, bucket: 'tip', severity: 'low', title: `Bots probed ${c.serverName} for weak spots ${n(w.scanners.n)} times`,
      detail: 'They try well-known paths like /.env and /wp-login.php. Normal on the internet; it only matters if one of them answers.',
      evidence: `${w.scanners.ips} address${w.scanners.ips === 1 ? '' : 'es'}, most from ${scanner.ip} (${scanner.scans})`,
      fix: blockable(scanner.ip) ? blockFix(c.serverId, scanner.ip, 'vulnerability scanner') : undefined });
  }

  // 6. an app writing far more errors than usual
  for (const er of w.errors) {
    const was = past.map((x) => x.errors.find((y) => y.container === er.container)?.n ?? 0);
    const mid = was.length ? median(was.map((v, i) => per(past[i]!, v))) : 0;
    const ratio = per(w, er.n) / Math.max(mid, 0.05);
    if (er.n < 20 || (was.length >= 3 && ratio < 3)) continue;
    add({ id: `logs:errors:${c.serverId}:${er.container}`, severity: 'medium', title: `${er.container} wrote ${n(er.n)} error lines in the last ${mins}`,
      detail: was.length >= 3 ? `About ${fmtTimes(ratio)} the usual (around ${Math.round(mid * w.minutes)}).` : 'Unit7 is still learning what’s usual for it.',
      evidence: er.sample.map((l) => l.replace(/([?&][\w.-]+=)[^&\s"]+/g, '$1…')).join('\n'), fix: lookFix(`why is ${er.container} on ${c.serverName} logging errors?`) });
  }
  // one Block button per address: the most specific finding keeps it, a surge then says "look" instead
  const blocks = (f: WatchFinding) => (f.fix && 'tool' in f.fix && f.fix.tool === 'shield.block' ? String(f.fix.input.ip) : undefined);
  for (const f of out) if (f.id.startsWith('traffic:surge') && blocks(f) && out.some((g) => g !== f && blocks(g) === blocks(f))) f.fix = lookFix(`why is traffic on ${c.serverName} so high?`);
  return out;
}

// when nothing could be read: say why, and turn it on in one click (coolify.proxy, through Coolify's own settings)
export function accessLogFinding(c: Ctx, traefik?: { on: boolean }): WatchFinding | undefined {
  if (!traefik || traefik.on) return undefined;
  return { id: `traffic:no-log:coolify:${c.serverId}`, bucket: 'tip', severity: 'info', area: 'server', by: 'unit7', serverId: c.serverId, about: { kind: 'server', id: c.serverId, name: c.serverName },
    title: 'Coolify’s proxy keeps no access log', detail: 'So Unit7 can’t count visits on this server or spot floods and calls without signing in. Unit7 can turn it on in Coolify’s own proxy settings (only through its built-in steps, never by editing files by hand): a JSON log in the proxy’s folder, kept under 20 MB, with sign-in headers hidden. The log on the server keeps each visit’s full address, including anything after “?” (some apps put keys or reset links there); it stays in Coolify’s own folder on the server (which only its administrator can open), and Unit7 never keeps or shows that part.',
    fix: { tool: 'coolify.proxy', input: { serverId: c.serverId, op: 'access_log_on' }, label: 'Turn it on', safe: false,
      change: 'Adds the access log to Coolify’s own proxy settings (so its Restart Proxy keeps it) and restarts the proxy the way Coolify does: sites pause for a few seconds. Unit7 checks every site still answers, and puts it back by itself if one doesn’t. Activity can undo it.' } };
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

// --- the traffic over a range, for the server page's graph ----------------------------------------------------------
// Each stored check (a window of 30 or 60 minutes) lands in the hour (24h, 7d) or UTC day (30d) it ended in, so the
// newest check always shows in the current hour.
// A bucket no check covered stays empty (a gap is a gap, not a zero). The usual band for an hour is the per-minute
// usual for that hour of the week, from checks before it, times the minutes the checks covered; days get no band.
export type SeriesRange = '24h' | '7d' | '30d';
export interface TrafficPoint { at: string; minutes: number; visits: number | null; errors: number; refused: number; anon: number; band: { lo: number; mid: number; hi: number } | null }
export interface TrafficSeries {
  range: SeriesRange; step: '1h' | '1d'; points: TrafficPoint[];
  totals: { visits: number; errors: number; refused: number; anon: number; checks: number; minutes: number };
  usual?: number; // the usual visits for the hours that have checks, when every one of them has a band
  topPaths: { path: string; n: number; errors: number }[];
  callers: { people: number; bots: number; scanners: number };
  agents: { agent: string; n: number; bot: boolean }[];
}
const SERIES: Record<SeriesRange, { step: number; n: number }> = { '24h': { step: 3600_000, n: 24 }, '7d': { step: 3600_000, n: 168 }, '30d': { step: 86400_000, n: 30 } };
export const seriesSince = (range: SeriesRange, now = Date.now()) => Math.floor(now / SERIES[range].step) * SERIES[range].step - (SERIES[range].n - 1) * SERIES[range].step;

export function trafficSeries(windows: Summary[], range: SeriesRange, now = Date.now()): TrafficSeries {
  const { step, n } = SERIES[range];
  const first = seriesSince(range, now);
  const mid = (w: Summary) => Date.parse(w.at) - 1; // a check ending on the hour belongs to the hour before
  const sorted = windows.filter((w) => Number.isFinite(Date.parse(w.at)) && w.minutes > 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const inRange = sorted.filter((w) => mid(w) >= first && mid(w) < first + n * step);
  const points: TrafficPoint[] = Array.from({ length: n }, (_, i) => ({ at: new Date(first + i * step).toISOString(), minutes: 0, visits: null, errors: 0, refused: 0, anon: 0, band: null }));
  for (const w of inRange) {
    const p = points[Math.floor((mid(w) - first) / step)]!;
    p.minutes += w.minutes; p.visits = (p.visits ?? 0) + w.requests; p.errors += w.status?.s5xx ?? 0; p.refused += w.status?.s4xx ?? 0; p.anon += w.anon?.n ?? 0;
  }
  if (step === 3600_000) for (const p of points) {
    if (!p.minutes) continue;
    const t = Date.parse(p.at);
    const past = sorted.filter((w) => Date.parse(w.at) <= t && Date.parse(w.at) > t - 28 * 86400_000);
    const u = usualOf(past, new Date(t + step / 2).toISOString(), (x) => x.requests);
    if (u) p.band = { lo: Math.round(u.lo * p.minutes), mid: Math.round(u.mid * p.minutes), hi: Math.round(u.hi * p.minutes) };
  }
  const sum = (f: (w: Summary) => number) => inRange.reduce((a, w) => a + (f(w) || 0), 0);
  const visits = sum((w) => w.requests), bots = sum((w) => w.bots), scanners = sum((w) => w.scanners?.n ?? 0);
  const merge = <T extends { n: number }>(lists: T[][], key: (x: T) => string) => {
    const m = new Map<string, T & { n: number }>();
    for (const l of lists) for (const x of l ?? []) { const k = key(x), had = m.get(k); m.set(k, had ? { ...had, ...x, n: had.n + x.n } : { ...x }); }
    return [...m.values()].sort((a, b) => b.n - a.n);
  };
  const paths = new Map<string, { path: string; n: number; errors: number }>();
  for (const w of inRange) for (const p of w.topPaths ?? []) { const x = paths.get(p.path) ?? { path: p.path, n: 0, errors: 0 }; x.n += p.n; x.errors += p.s5xx; paths.set(p.path, x); }
  const withData = points.filter((p) => p.minutes);
  const usual = step === 3600_000 && withData.length && withData.every((p) => p.band) ? withData.reduce((a, p) => a + p.band!.mid, 0) : undefined;
  return {
    range, step: step === 3600_000 ? '1h' : '1d', points,
    totals: { visits, errors: sum((w) => w.status?.s5xx ?? 0), refused: sum((w) => w.status?.s4xx ?? 0), anon: sum((w) => w.anon?.n ?? 0), checks: inRange.length, minutes: sum((w) => w.minutes) },
    ...(usual !== undefined && { usual }),
    topPaths: [...paths.values()].sort((a, b) => b.n - a.n).slice(0, 6),
    // scanners are counted by the paths they probe, bots by their user agent: a scanner is never also counted as a bot
    callers: { scanners, bots: Math.max(0, bots - scanners), people: Math.max(0, visits - Math.max(bots, scanners)) },
    agents: merge(inRange.map((w) => w.topAgents), (a) => a.agent).slice(0, 6).map(({ agent, n, bot }) => ({ agent, n, bot })),
  };
}
