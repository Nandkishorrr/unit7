// What can a stranger do? Unit7 looks at your own sites the way nobody-in-particular would: what's in the JavaScript you ship, what
// that public key can read, and which files answer. It only ever asks how many rows there are, never for one. It only looks at
// addresses it can tie to you, and it asks gently: a few requests, one at a time. Files that shouldn't download are asked for from
// inside a connected server, because asking from here gets you banned (see askPath).
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { defineTool, type Ctx } from '../tools/runtime.ts';
import { assertReachable } from '../netguard.ts';
import { pool } from '../discovery/scanners.ts';
import { askPath, serverOf, targets } from '../sentinel/watch.ts';
import { lastXray } from '../tools/xray.ts';
import { all } from '../db.ts';
import { isTestHost } from '../care/readiness.ts';
import { exposedFiles, type Finding } from '../tools/security.ts';

const MAX_JS = 2_000_000, MAX_FILES = 12, UA = 'Unit7 security check';
// (pure) what a JWT says about itself. Nothing here is verified or used.
export function jwtRole(token: string) { try { const p = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { role?: string; iss?: string; ref?: string }; return { role: p.role, ...(p.iss && { iss: p.iss }) }; } catch { return undefined; } }
// keys, by what they can do. A public key in a page is normal, and is never an alarm by itself.
const KEYS: { re: RegExp; name: string; label: 'can spend your money' | 'meant to be public' }[] = [
  { re: /\bsk_live_[0-9a-zA-Z]{16,}/g, name: 'Stripe secret key', label: 'can spend your money' }, { re: /\brk_live_[0-9a-zA-Z]{16,}/g, name: 'Stripe restricted key', label: 'can spend your money' },
  { re: /\bsk-ant-[\w-]{20,}/g, name: 'Anthropic key', label: 'can spend your money' }, { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, name: 'OpenAI key', label: 'can spend your money' }, { re: /\bAKIA[0-9A-Z]{16}\b/g, name: 'AWS access key', label: 'can spend your money' },
  { re: /\bgh[pousr]_[0-9A-Za-z]{30,}/g, name: 'GitHub token', label: 'can spend your money' }, { re: /\bxox[bap]-[0-9A-Za-z-]{20,}/g, name: 'Slack token', label: 'can spend your money' },
  { re: /\bpk_live_[0-9a-zA-Z]{16,}/g, name: 'Stripe public key', label: 'meant to be public' },
];
export interface KeyHit { name: string; label: string; tail: string }
export function keysIn(js: string): KeyHit[] {
  const out = new Map<string, KeyHit>();
  for (const k of KEYS) for (const m of js.matchAll(k.re)) out.set(m[0], { name: k.name, label: k.label, tail: m[0].slice(-4) });
  return [...out.values()];
}
const JWT = /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g, SUPABASE = /https:\/\/[a-z0-9-]+\.supabase\.co\b/g;
export function supabaseIn(js: string, host: string) {
  const urls = [...new Set([...js.matchAll(SUPABASE)].map((m) => m[0]))], tokens = [...new Set([...js.matchAll(JWT)].map((m) => m[0]))];
  const typed = tokens.map((t) => ({ token: t, ...jwtRole(t) })).filter((t) => t.role);
  // a self-hosted stack sits at its own address: any site-relative or same-domain url beside the key
  const own = new RegExp(`https://[a-z0-9.-]*${host.split('.').slice(-2).join('\\.')}\\b`, 'g'), selfHosted = [...new Set([...js.matchAll(own)].map((m) => m[0]))].filter((u) => /supabase|api|db|kong/.test(u));
  return { urls: urls.length ? urls : selfHosted, anon: typed.find((t) => t.role === 'anon')?.token, service: typed.find((t) => t.role === 'service_role')?.token };
}
// the defaults people ship with: a key signed with one of these means anyone can sign their own
const DEFAULT_SECRETS = ['your-super-secret-jwt-token-with-at-least-32-characters-long', 'super-secret-jwt-token-with-at-least-32-characters-long', 'supersecretkey', 'secret', 'changeme', 'your-secret-key'];
export function signedWithDefault(jwt: string) {
  const [h, p, s] = jwt.split('.');
  return !!(h && p && s) && DEFAULT_SECRETS.some((d) => createHmac('sha256', d).update(`${h}.${p}`).digest('base64url') === s);
}
export const badRandom = (js: string) => /(token|secret|session|apikey|api_key)[^;\n]{0,60}Math\.random\(\)|Math\.random\(\)[^;\n]{0,60}(token|secret|session)/i.test(js);

const get = async (url: string, o: { head?: boolean; headers?: Record<string, string>; max?: number } = {}) => {
  const r = await fetch(url, { method: o.head ? 'HEAD' : 'GET', redirect: 'manual', headers: { 'user-agent': UA, ...o.headers }, signal: AbortSignal.timeout(8000) }).catch(() => undefined);
  if (!r) return undefined;
  if (o.head || !r.body) { void r.body?.cancel(); return { status: r.status, headers: r.headers, text: '' }; }
  const reader = r.body.getReader(), dec = new TextDecoder(), max = o.max ?? MAX_JS;
  let text = '';
  while (text.length < max) { const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined })); if (done || !value) break; text += dec.decode(value, { stream: true }); }
  void reader.cancel().catch(() => undefined);
  return { status: r.status, headers: r.headers, text };
};
export const scriptsIn = (html: string, base: string) => [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].flatMap((m) => { try { const u = new URL(m[1]!, base); return u.origin === new URL(base).origin ? [u.href] : []; } catch { return []; } }).slice(0, MAX_FILES);

// (pure) what the row counts mean
export function tableFinding(host: string, list: { table: string; rows: number }[]): Finding | undefined {
  const open = list.filter((t) => t.rows > 0).sort((a, b) => b.rows - a.rows);
  if (!open.length) return undefined;
  const rows = open.reduce((n, t) => n + t.rows, 0);
  return { id: `stranger:tables:${host}`, severity: 'critical', area: 'app', by: 'unit7', title: `Anyone can read ${rows.toLocaleString('en-US')} rows on ${host}`, detail: 'The key in your site is meant to be public. Your database door rule (RLS) is what should stop it, and on these tables it doesn’t. Unit7 only counted rows and read none.', evidence: open.slice(0, 8).map((t) => `${t.table}: ${t.rows.toLocaleString('en-US')} rows`).join(', '),
    fix: { label: 'Ask Unit7 to help', ask: `On ${host}, the public key can read these tables: ${open.slice(0, 8).map((t) => t.table).join(', ')}. Help me turn on row level security and write the right policies. Show me each policy first, and don’t change anything until I agree.`, manual: ['Turn on row level security for each table.', 'Add a policy for who may read what.', 'Run this check again.'] } };
}
async function countTables(url: string, key: string) {
  const headers = { apikey: key, authorization: `Bearer ${key}` }, spec = await get(`${url}/rest/v1/`, { headers, max: 800_000 });
  if (spec?.status !== 200) return [];
  let names: string[] = [];
  try { names = Object.keys((JSON.parse(spec.text) as { paths?: Record<string, unknown> }).paths ?? {}).map((p) => p.replace(/^\//, '')).filter((p) => p && !p.startsWith('rpc/')); } catch { return []; }
  const out: { table: string; rows: number }[] = [];
  for (const t of names.slice(0, 40)) {
    const r = await get(`${url}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`, { head: true, headers: { ...headers, Prefer: 'count=exact' } }); // HEAD: the count, no rows
    const n = Number(r?.headers.get('content-range')?.split('/')[1]);
    if (r && r.status < 300 && Number.isFinite(n)) out.push({ table: t, rows: n });
  }
  return out;
}
const blocked = (h: string) => assertReachable(h).then(() => false, (e: { code?: string }) => e.code === 'blocked_host');
// (pure) a redirect on "/" Unit7 may follow: https, and still this site (www and the bare name). Anywhere else isn't Unit7's to look at.
export function sameSite(location: string | null, base: string, host: string) {
  try { const u = new URL(location ?? '', base), site = host.replace(/^www\./, ''); return u.protocol === 'https:' && (u.hostname === site || u.hostname.endsWith(`.${site}`)) ? u : undefined; } catch { return undefined; }
}
const OPEN_PATHS = ['/.env.local', '/.env.production', '/backup.sql', '/dump.sql', '/db.sql', '/database.sql', '/backup.zip'];

export async function strangerLook(ctx: Ctx, host: string) {
  const findings: Finding[] = [];
  let base = `https://${host}`, page = await get(`${base}/`, { max: 600_000 });
  if (page && page.status >= 300 && page.status < 400) {
    const next = sameSite(page.headers.get('location'), base, host);
    if (!next || await blocked(next.hostname)) return { host, findings, looked: 0 };
    base = next.origin; page = await get(next.href, { max: 600_000 });
  }
  // an empty redirect or an error page has nothing to read, and that mustn't come back as "clean"
  if (!page || page.status >= 300) return { host, findings, looked: 0 };
  const scripts = scriptsIn(page.text, base);
  let js = page.text, looked = 1;
  for (const src of scripts) {
    const r = await get(src); looked++;
    if (!r || r.status !== 200) continue;
    js += `\n${r.text}`;
    const map = /\/\/[#@] sourceMappingURL=([^\s'"]+)/.exec(r.text)?.[1];
    const mapUrl = map && !map.startsWith('data:') ? new URL(map, src) : undefined;
    if (mapUrl && mapUrl.origin === new URL(src).origin && !findings.some((f) => f.id === `stranger:sourcemap:${host}`)) { // a page can't send Unit7 anywhere else
      const m = await get(mapUrl.href, { head: true });
      if (m?.status === 200) findings.push({ id: `stranger:sourcemap:${host}`, severity: 'medium', area: 'app', by: 'unit7', title: `${host} hands out its source code`, detail: 'Source maps are public, so anyone can read your original code, comments included.', fix: { label: 'Ask Unit7 to help', ask: `${host} serves its source maps publicly. Tell me how to stop that for my framework.`, manual: ['Turn off production source maps, or upload them privately.'] } });
    }
  }
  for (const k of keysIn(js).filter((x) => x.label === 'can spend your money')) findings.push({ id: `stranger:key:${host}:${k.tail}`, severity: 'critical', area: 'app', by: 'unit7', title: `A ${k.name} is in what ${host} sends to every visitor`, detail: 'This one can spend your money. Assume it’s known, change it first, then move it to the server.', evidence: `…${k.tail} (the rest hidden)`, fix: { label: 'Ask Unit7 to help', ask: `A ${k.name} ending in ${k.tail} ships in ${host}’s JavaScript. Help me change it and move it to the server.`, manual: ['Change the key at the provider.', 'Read it only on the server.'] } });
  const sb = supabaseIn(js, host);
  if (sb.service) findings.push({ id: `stranger:service-key:${host}`, severity: 'critical', area: 'app', by: 'unit7', title: `Your master database key is in what ${host} sends to every visitor`, detail: 'A service_role key skips every door rule. Anyone can read or delete everything. Change it now.', fix: { label: 'Ask Unit7 to help', ask: `The Supabase service_role key ships in ${host}’s JavaScript. Help me change it and move it to the server.`, manual: ['Change the key.', 'Use it only on the server.'] } });
  if (sb.anon && signedWithDefault(sb.anon)) findings.push({ id: `stranger:default-jwt:${host}`, severity: 'critical', area: 'app', by: 'unit7', title: `${host} still uses the example signing secret`, detail: 'The secret behind your keys is the one from the docs, so anyone can sign a key that does anything.', fix: { label: 'Ask Unit7 to help', ask: `The JWT secret behind ${host} is a published default. Help me change it, and every key made from it.`, manual: ['Change the JWT secret.', 'Make new keys from it.'] } });
  // these addresses come from the page, so each is checked like any other before Unit7 sends it a key
  if (sb.anon) for (const url of sb.urls.slice(0, 2)) { if (await blocked(new URL(url).hostname)) continue; const f = tableFinding(host, await countTables(url, sb.anon)); if (f) findings.push(f); }
  if (badRandom(js)) findings.push({ id: `stranger:random:${host}`, severity: 'low', area: 'app', by: 'unit7', title: `${host} makes something secret with Math.random()`, detail: 'Math.random() can be predicted. Likely, not proven: Unit7 read this in the shipped code.', fix: { ask: `${host} seems to make a token with Math.random(). Find it and use a secure random source.`, manual: ['Use crypto.randomUUID() or crypto.getRandomValues().'] } });
  const name = new URL(base).hostname, server = await serverOf(ctx.app, ctx.orgId, name);
  for (const path of OPEN_PATHS) {
    const r = await askPath(ctx.app, server, name, path); looked++;
    if (r?.status !== 200 || /<(html|!doctype|head|body)\b/i.test(r.text)) continue;
    const env = path.includes('.env'), hit = env ? exposedFiles('/.env', r.text) : /^(--|\/\*|CREATE |INSERT |PK)/m.test(r.text);
    if (hit) findings.push({ id: `stranger:file:${host}:${path}`, severity: 'critical', area: 'app', by: 'unit7', title: `${host} gives ${path} to anyone`, detail: env ? 'Passwords and keys download from the web. Assume everything in it is known.' : 'A copy of your data downloads from the web.', evidence: `https://${host}${path} answered`, fix: { label: 'Ask Unit7 to help', ask: `https://${host}${path} downloads from the web. Help me remove it and change what it exposed.`, manual: ['Remove the file from what’s served.', 'Change anything it held.'] } });
  }
  return { host, findings, looked };
}

// Only addresses Unit7 can tie to you: your own domains on your servers and connected accounts. Test addresses too: they're yours.
export function ownHosts(ctx: Ctx) {
  const hosts = new Set(targets(ctx.app, ctx.orgId).map((t) => t.host));
  for (const s of all<{ id: string }>(ctx.db, `SELECT id FROM servers WHERE org_id = ?`, ctx.orgId)) for (const p of lastXray(ctx.db, ctx.orgId, s.id)?.data.projects ?? []) for (const d of p.domains) hosts.add(d);
  return [...hosts].filter((h) => !/^\d+\.\d+\.\d+\.\d+$/.test(h)).sort((a, b) => Number(isTestHost(a)) - Number(isTestHost(b)));
}
defineTool({
  name: 'security.stranger', title: 'What can a stranger do?', risk: 'read', action: 'read', timeoutMs: 8 * 60_000,
  description: 'Look at your own sites from outside, as nobody: keys in the JavaScript you ship (labelled meant to be public or can spend your money), a service_role key, a signing secret still at its published default, which tables the public key can read (a count only, never a row), source maps, and files that shouldn’t download (asked for from inside a connected server, so its defences don’t ban this computer). Only addresses tied to you.',
  input: z.object({ host: z.string().max(253).optional() }),
  async run(ctx, i) {
    const mine = ownHosts(ctx);
    if (process.env.UNIT7_SKIP_NET_PROBE) return { sites: 0, findings: [], skipped: 'offline' };
    if (i.host && !mine.includes(i.host)) return { sites: 0, findings: [], refused: `${i.host} isn’t tied to you, so Unit7 won’t look at it.` };
    const list = (i.host ? [i.host] : mine).slice(0, 12), out: Awaited<ReturnType<typeof strangerLook>>[] = [];
    await pool(list, 2, async (h) => { try { await assertReachable(h); ctx.progress(`Looking at ${h} from outside…`); out.push(await strangerLook(ctx, h)); } catch { /* not reachable from here, or a private address */ } });
    const read = out.filter((x) => x.looked);
    return { sites: read.length, findings: read.flatMap((x) => x.findings), checked: read.map((x) => x.host), notRead: out.filter((x) => !x.looked).map((x) => x.host) };
  },
});
