// Uptime Kuma: adding HTTP monitors for the sites Unit7 knows. Uptime Kuma has no REST API for monitors (1.x and 2.x):
// its own web app talks to the server over socket.io, and its wiki calls that API internal ("not officially supported
// for third-party integrations", github.com/louislam/uptime-kuma/wiki/Internal-API). It's still the only supported way
// short of editing its database while it runs, so Unit7 uses it the way the web app does, from inside the container:
// `docker exec -i <container> node -` with this program on stdin, the login and the sites inside it (never on a
// command line), talking to 127.0.0.1 (no Origin header, which Uptime Kuma 2 allows). socket.io-client is in Uptime
// Kuma's own production dependencies (package.json at 1.23.16 and 2.0.x), so nothing is installed.
// Events and shapes are from server/server.js at 1.23.16 and 2.0.2: setup(username, password, cb), login({ username,
// password, token }, cb) → { ok, token } | { tokenRequired }, the "monitorList" push after login (keyed by id, each with
// its tags), getTags(cb), addTag({ name, color }, cb) → { ok, tag }, add(monitor, cb) → { ok, monitorID },
// addMonitorTag(tagID, monitorID, value, cb). A new monitor carries exactly what the web app's form would send
// (EditMonitor.vue's monitorDefaults for that major version), so it looks like one the person made.
// Pure: the program text and reading its answer. Nothing it prints is a secret; what it prints is the server's data.
import { sections } from '../discovery/xray.ts';

export const TAG = 'unit7';
export const INTERVAL = 60;
export interface Site { url: string; name: string }
export interface KumaInput { username: string; password: string; sites: Site[]; setup?: boolean; interval?: number }
export interface KumaResult {
  ok: boolean; why?: 'unreachable' | 'setup' | 'taken' | 'login' | '2fa' | 'no_list' | 'tag' | 'timeout' | 'error' | 'no_client'; msg?: string; version?: string;
  added: { url: string; id: number; tagged: boolean }[]; already: { url: string; id: number; mine: boolean }[];
  failed: { url: string; msg?: string }[]; stale: { url: string; name: string; id: number }[]; total?: number;
}

const PROGRAM = String.raw`
const path = require('path');
const out = (o) => { process.stdout.write('\n@@unit7:reply\n' + JSON.stringify(o) + '\n'); process.exit(0); };
let lib;
try { lib = require(require.resolve('socket.io-client', { paths: [process.cwd(), '/app'] })); } catch (e) { out({ ok: false, why: 'no_client' }); }
const version = (() => { for (const d of [process.cwd(), '/app']) { try { return String(require(path.join(d, 'package.json')).version); } catch {} } return ''; })();
const major = Number(version.split('.')[0]) || 1;
// what the web app's "Add New Monitor" form sends, by major version (EditMonitor.vue monitorDefaults)
const V1 = { type: 'http', name: '', parent: null, url: 'https://', method: 'GET', interval: 60, retryInterval: 60, resendInterval: 0, maxretries: 0, timeout: 48, notificationIDList: {}, ignoreTls: false, upsideDown: false, packetSize: 56, expiryNotification: false, maxredirects: 10, accepted_statuscodes: ['200-299'], dns_resolve_type: 'A', dns_resolve_server: '1.1.1.1', docker_container: '', docker_host: null, proxyId: null, mqttUsername: '', mqttPassword: '', mqttTopic: '', mqttSuccessMessage: '', authMethod: null, oauth_auth_method: 'client_secret_basic', httpBodyEncoding: 'json', kafkaProducerBrokers: [], kafkaProducerSaslOptions: { mechanism: 'None' }, kafkaProducerSsl: false, kafkaProducerAllowAutoTopicCreation: false, gamedigGivenPortOnly: true };
const V2 = { type: 'http', name: '', parent: null, url: 'https://', method: 'GET', ipFamily: null, interval: 60, retryInterval: 60, resendInterval: 0, maxretries: 0, notificationIDList: {}, ignoreTls: false, upsideDown: false, expiryNotification: false, maxredirects: 10, accepted_statuscodes: ['200-299'], dns_resolve_type: 'A', dns_resolve_server: '1.1.1.1', docker_container: '', docker_host: null, proxyId: null, mqttUsername: '', mqttPassword: '', mqttTopic: '', mqttWebsocketPath: '', mqttSuccessMessage: '', mqttCheckType: 'keyword', authMethod: null, oauth_auth_method: 'client_secret_basic', httpBodyEncoding: 'json', kafkaProducerBrokers: [], kafkaProducerSaslOptions: { mechanism: 'None' }, cacheBust: false, kafkaProducerSsl: false, kafkaProducerAllowAutoTopicCreation: false, gamedigGivenPortOnly: true, remote_browser: null, rabbitmqNodes: [], rabbitmqUsername: '', rabbitmqPassword: '', conditions: [], ping_count: 3, ping_numeric: true, packetSize: 56, ping_per_request_timeout: 2 };
const base = major >= 2 ? V2 : V1;
const port = Number(process.env.UPTIME_KUMA_PORT || process.env.PORT || 3001);
const tls = !!(process.env.UPTIME_KUMA_SSL_KEY && process.env.UPTIME_KUMA_SSL_CERT);
const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const mine = (m) => (m.tags || []).some((t) => String(t.name).toLowerCase() === TAG);
setTimeout(() => out({ ok: false, why: 'timeout' }), 150000);
const socket = lib.io((tls ? 'https' : 'http') + '://127.0.0.1:' + port, { transports: ['websocket'], reconnectionDelay: 2000, reconnectionAttempts: 45, rejectUnauthorized: false });
const call = (ev, ...args) => new Promise((res) => socket.emit(ev, ...args, res));
const wait = (ok, ms) => new Promise((res) => { const t0 = Date.now(); const tick = () => (ok() ? res(true) : Date.now() - t0 > ms ? res(false) : setTimeout(tick, 100)); tick(); });
let monitors = null, started = false;
socket.on('monitorList', (list) => { monitors = list || {}; });
socket.io.on('reconnect_failed', () => out({ ok: false, why: 'unreachable', version }));
socket.on('connect', () => { if (started) return; started = true; main().catch((e) => out({ ok: false, why: 'error', msg: String((e && e.message) || e).slice(0, 200), version })); });
async function main() {
  if (INPUT.setup) {
    const s = await call('setup', INPUT.username, INPUT.password);
    if (!s || !s.ok) return out({ ok: false, why: /initiali[sz]ed|already/i.test(String(s && s.msg)) ? 'taken' : 'setup', msg: String((s && s.msg) || '').slice(0, 200), version });
  }
  const l = await call('login', { username: INPUT.username, password: INPUT.password, token: '' });
  if (l && l.tokenRequired) return out({ ok: false, why: '2fa', version });
  if (!l || !l.ok) return out({ ok: false, why: 'login', msg: String((l && l.msg) || '').slice(0, 200), version });
  if (!(await wait(() => monitors !== null, 20000))) return out({ ok: false, why: 'no_list', version });
  const list = Object.values(monitors);
  const watched = new Map();
  for (const m of list) { const h = host(m.url); if (h && !watched.has(h)) watched.set(h, m); }
  const added = [], already = [], failed = [];
  let tag;
  for (const s of INPUT.sites) {
    const h = host(s.url), have = watched.get(h);
    if (have) { already.push({ url: s.url, id: have.id, mine: mine(have) }); continue; }
    if (!tag) {
      const g = await call('getTags');
      tag = ((g && g.tags) || []).find((t) => String(t.name).toLowerCase() === TAG);
      if (!tag) { const r = await call('addTag', { name: TAG, color: '#2563EB' }); if (!r || !r.ok || !r.tag) return out({ ok: false, why: 'tag', msg: String((r && r.msg) || '').slice(0, 200), version, added, already, failed }); tag = r.tag; }
    }
    const mon = (b) => Object.assign({}, b, { name: s.name, url: s.url, interval: INPUT.interval, retryInterval: INPUT.interval, maxretries: 1, description: 'Added by Unit7' });
    let r = await call('add', mon(base));
    // an early 2.x build without some of the newer form's fields: the 1.x form's set, which every 2.x has
    if (r && !r.ok && base !== V1 && /column/i.test(String(r.msg))) r = await call('add', mon(V1));
    if (!r || !r.ok) { failed.push({ url: s.url, msg: String((r && r.msg) || '').slice(0, 200) }); continue; }
    const t = await call('addMonitorTag', tag.id, r.monitorID, '');
    added.push({ url: s.url, id: r.monitorID, tagged: !!(t && t.ok) });
    watched.set(h, { id: r.monitorID, tags: [{ name: TAG }] });
  }
  const known = new Set(INPUT.sites.map((s) => host(s.url)));
  const stale = list.filter((m) => mine(m) && !known.has(host(m.url))).map((m) => ({ url: m.url, name: m.name, id: m.id }));
  out({ ok: true, version, added, already, failed, stale, total: list.length + added.length });
}
`;

// the whole of stdin for `node -`: the input first (as a constant), then the program
export function kumaProgram(i: KumaInput): string {
  const input = { username: i.username, password: i.password, sites: i.sites.map((s) => ({ url: s.url, name: s.name })), ...(i.setup && { setup: true }), interval: i.interval ?? INTERVAL };
  return `'use strict';\nconst INPUT = ${JSON.stringify(input)};\nconst TAG = ${JSON.stringify(TAG)};\n${PROGRAM}`;
}

// what came back, checked field by field: it's the server's data, so only the shapes Unit7 expects get through
const str = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const arr = (v: unknown) => (Array.isArray(v) ? v.slice(0, 500) : []);
const WHY = new Set(['unreachable', 'setup', 'taken', 'login', '2fa', 'no_list', 'tag', 'timeout', 'error', 'no_client']);
export function parseKuma(stdout: string): KumaResult {
  let j: any;
  try { j = JSON.parse((sections(stdout).reply ?? '').trim()); } catch { j = undefined; }
  if (!j || typeof j !== 'object') return { ok: false, why: 'error', msg: 'it didn’t answer', added: [], already: [], failed: [], stale: [] };
  return {
    ok: j.ok === true, ...(WHY.has(j.why) && { why: j.why }), ...(j.msg && { msg: str(j.msg, 200) }), ...(j.version && { version: str(j.version, 40) }),
    added: arr(j.added).map((a: any) => ({ url: str(a?.url), id: num(a?.id), tagged: a?.tagged === true })),
    already: arr(j.already).map((a: any) => ({ url: str(a?.url), id: num(a?.id), mine: a?.mine === true })),
    failed: arr(j.failed).map((a: any) => ({ url: str(a?.url), ...(a?.msg && { msg: str(a.msg, 200) }) })),
    stale: arr(j.stale).map((a: any) => ({ url: str(a?.url), name: str(a?.name, 120), id: num(a?.id) })),
    ...(j.total !== undefined && { total: num(j.total) }),
  };
}

// why it stopped, in words
export const kumaWhy = (r: KumaResult, name = 'Uptime Kuma') => ({
  unreachable: `${name} isn’t answering inside its container.`,
  no_client: `This ${name} doesn’t have the piece Unit7 talks to it with (an unusual build).`,
  setup: `${name} didn’t take the admin login Unit7 made${r.msg ? ` (${r.msg})` : ''}.`,
  taken: `${name} already has an admin, so Unit7 didn’t make one.`,
  login: `${name} refused the login Unit7 has for it. If you changed its password, give Unit7 the new one.`,
  '2fa': `${name} asks for a two-factor code, which Unit7 can’t type.`,
  no_list: `${name} didn’t send its monitors.`,
  tag: `${name} didn’t take the “unit7” tag${r.msg ? ` (${r.msg})` : ''}.`,
  timeout: `${name} took too long to answer.`,
  error: `${name} stopped with an error${r.msg ? ` (${r.msg})` : ''}.`,
} as Record<string, string>)[r.why ?? 'error'] ?? `${name} didn’t answer as expected.`;
