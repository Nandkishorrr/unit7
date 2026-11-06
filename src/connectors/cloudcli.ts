// The big clouds (Google Cloud, Firebase, AWS, Azure) through what's already on this Mac: their own command-line
// tools, signed in. Unit7 runs on the same Mac, so instead of a pasted key it asks the tool for a short-lived token
// each time it needs one, and nothing long-lived is copied. The vault keeps only which tool and which sign-in.
// Also the JSON-over-HTTPS call they share, whose errors say "refused" (401) the way the account checks expect.
import { execFile } from 'node:child_process';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';

export type Tool = 'gcloud' | 'firebase' | 'aws' | 'az';
const NAME: Record<Tool, string> = { gcloud: 'gcloud', firebase: 'the Firebase CLI', aws: 'the AWS CLI', az: 'the Azure CLI' };
const LOGIN: Record<Tool, string> = { gcloud: 'gcloud auth login', firebase: 'firebase login', aws: 'aws sso login (or aws configure)', az: 'az login' };
// each binary can be pointed elsewhere (tests use a stand-in)
const BIN: Record<Tool, string> = { gcloud: 'UNIT7_GCLOUD_BIN', firebase: 'UNIT7_FIREBASE_BIN', aws: 'UNIT7_AWS_BIN', az: 'UNIT7_AZ_BIN' };

export function cli(tool: Tool, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => execFile(process.env[BIN[tool]] ?? tool, args, {
    timeout, maxBuffer: 32 << 20,
    env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1', AWS_PAGER: '', FIREBASE_CLI_EXPERIMENTS: '', NO_COLOR: '1', AZURE_CORE_ONLY_SHOW_ERRORS: '1' },
  }, (e, out, err) => {
    if (!e) return resolve(out.trim());
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Unit7Error('cli_missing', `${NAME[tool]} isn’t installed on this computer.`, 409));
    const why = String(err || e.message).trim().split('\n').filter(Boolean).pop() ?? '';
    // signed out or expired: a refusal (401), so background work stops until a person signs in again
    if (/re-?auth|log ?in|logged out|credentials|expired|token|sso|authenticat/i.test(why)) return reject(new Unit7Error('cli_signed_out', `${NAME[tool]} on this Mac is signed out (unauthorized). Run: ${LOGIN[tool]}, then reconnect.`, 401));
    reject(new Unit7Error('cli_failed', `${NAME[tool]}: ${why.slice(0, 200)}`, 502));
  }));
}
export const cliJson = async <T = any>(tool: Tool, args: string[], timeout?: number) => JSON.parse(await cli(tool, args, timeout)) as T;

// What's signed in here, for the Connections page: tool → who (an email, a profile, a subscription). Asked at most
// once a minute; every check is local (no network) and a missing tool is just "not signed in".
const quiet = <T>(p: Promise<T>) => p.catch(() => undefined);
async function detect(): Promise<Partial<Record<Tool, string>>> {
  const [gcloud, firebase, aws, az] = await Promise.all([
    quiet(cli('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], 8000)).then((s) => s?.split('\n')[0]?.trim() || undefined),
    quiet(cliJson<{ result?: { user?: { email?: string }; email?: string }[] }>('firebase', ['login:list', '--json'])).then((r) => r?.result?.map((x) => x.user?.email ?? x.email).find(Boolean)),
    quiet(cliJson<{ AccessKeyId?: string }>('aws', ['configure', 'export-credentials', '--format', 'process'])).then((r) => (r?.AccessKeyId ? process.env.AWS_PROFILE || 'default' : undefined)),
    quiet(cliJson<{ name?: string; user?: { name?: string } }>('az', ['account', 'show', '--output', 'json'])).then((r) => r?.user?.name ?? r?.name),
  ]);
  return Object.fromEntries(Object.entries({ gcloud, firebase, aws, az }).filter(([, v]) => v)) as Partial<Record<Tool, string>>;
}
let seen: { at: number; p: Promise<Partial<Record<Tool, string>>> } | undefined;
export const signedIn = () => {
  if (!seen || Date.now() - seen.at > 60_000) seen = { at: Date.now(), p: detect() };
  return seen.p;
};
export const forgetSignedIn = () => { seen = undefined; };

// which tool connects which tile (Firebase rides on gcloud when it's there: it sees custom domains too)
export const TOOLS_FOR: Record<string, Tool[]> = { gcp: ['gcloud'], firebase: ['gcloud', 'firebase'], aws: ['aws'], azure: ['az'] };
export const TOOL_LABEL: Record<Tool, string> = { gcloud: 'gcloud', firebase: 'Firebase CLI', aws: 'AWS CLI', az: 'Azure CLI' };
export async function cliFor(providerId: string): Promise<{ tool: Tool; who: string } | undefined> {
  const s = await signedIn();
  const tool = TOOLS_FOR[providerId]?.find((t) => s[t]);
  return tool && { tool, who: s[tool]! };
}

// --- every sign-in each tool has here, so a person picks which one to connect -------------------------------------
// gcloud: each account it holds; the Firebase CLI: each of its logins; AWS: each profile; Azure: each signed-in user
// (with one of its subscriptions, to name it). Each Unit7 account then names its own sign-in on every call (--account,
// --profile, --subscription), so whichever one the tool has active never matters. Nothing here signs out or switches it.
export interface SignIn { tool: Tool; who: string; active: boolean; subscription?: string }
async function listSignIns(tool: Tool): Promise<SignIn[]> {
  if (tool === 'gcloud') return (await cliJson<{ account: string; status?: string }[]>('gcloud', ['auth', 'list', '--format=json'], 8000)).map((x) => ({ tool, who: x.account, active: x.status === 'ACTIVE' }));
  if (tool === 'firebase') return ((await cliJson<{ result?: { user?: { email?: string }; email?: string }[] }>('firebase', ['login:list', '--json'], 8000)).result ?? [])
    .map((x, i) => ({ tool, who: x.user?.email ?? x.email ?? '', active: i === 0 })).filter((s) => s.who);
  if (tool === 'aws') return (await cli('aws', ['configure', 'list-profiles'], 8000)).split('\n').map((p) => p.trim()).filter(Boolean)
    .map((who) => ({ tool, who, active: who === (process.env.AWS_PROFILE || 'default') }));
  // ponytail: one per user; a user in several directories shows once (its default one first), add per-directory if asked
  const users = new Map<string, SignIn>();
  for (const s of await cliJson<{ id: string; isDefault?: boolean; user?: { name?: string } }[]>('az', ['account', 'list', '--output', 'json'], 8000)) {
    const who = s.user?.name;
    if (who && (!users.has(who) || s.isDefault)) users.set(who, { tool, who, active: !!s.isDefault, subscription: s.id });
  }
  return [...users.values()];
}
// every sign-in for a tile, gcloud's before the Firebase CLI's (an email both have shows once), and which tools answered
export async function signInsFor(providerId: string): Promise<{ signIns: SignIn[]; tools: Tool[] }> {
  const found = await Promise.all((TOOLS_FOR[providerId] ?? []).map((t) => listSignIns(t).then((l) => ({ t, l }), () => undefined)));
  const signIns: SignIn[] = [];
  for (const f of found) for (const s of f?.l ?? []) if (!signIns.some((x) => x.who.toLowerCase() === s.who.toLowerCase())) signIns.push(s);
  return { signIns, tools: found.flatMap((f) => (f ? [f.t] : [])) };
}

// "Sign in with another Google account": gcloud's own browser sign-in on this Mac, added next to the ones it has.
// --no-activate keeps the account gcloud uses the one it was. Waits up to five minutes for the person to finish in the
// browser, one at a time, and says which account is new (undefined: they signed in with one gcloud already had).
let addingGoogle: Promise<string | undefined> | undefined;
export function addGoogleSignIn(): Promise<string | undefined> {
  return addingGoogle ??= (async () => {
    const before = new Set((await listSignIns('gcloud').catch(() => [])).map((s) => s.who));
    try { await cli('gcloud', ['auth', 'login', '--brief', '--no-activate'], 5 * 60_000); }
    catch (e) { throw (e as Unit7Error).code === 'cli_missing' ? e : new Unit7Error('signin_unfinished', 'The Google sign-in didn’t finish. Try again.', 409); }
    forgetSignedIn();
    return (await listSignIns('gcloud')).find((s) => !before.has(s.who))?.who;
  })().finally(() => { addingGoogle = undefined; });
}

// A short-lived token (or a costly answer), cached per account until shortly before it runs out
const cache = new Map<string, { value: string; until: number }>();
export async function cached(key: string, mint: () => Promise<{ value: string; until?: number }>, maxMs = 50 * 60_000) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const t = await mint();
  cache.set(key, { value: t.value, until: Math.min(t.until ?? Infinity, Date.now() + maxMs) - 60_000 });
  return t.value;
}
export const dropCached = (key: string) => cache.delete(key);

// JSON over HTTPS. 401 stays 401 (a refused credential), 404 means "not there" (an app not created yet), 429 slow down.
export async function call<T = any>(who: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string> } = {}): Promise<T> {
  await assertReachable(new URL(url).hostname);
  const res = await fetch(url, {
    method: init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET'),
    headers: { accept: 'application/json', ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : init.body !== undefined && { 'content-type': 'application/json' }), ...init.headers },
    body: init.form ? new URLSearchParams(init.form).toString() : init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : {}; } catch { /* XML or plain text: the caller reads it */ }
  if (!res.ok) {
    const e = typeof data === 'object' ? data : {};
    const msg = e.error?.message ?? e.message ?? e.Message ?? e.error_description ?? (typeof e.error === 'string' ? e.error : undefined) ?? /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? res.statusText ?? String(res.status);
    // a sign-in endpoint saying the key or secret is no good (OAuth's invalid_client / invalid_grant) is a refusal too
    const status = res.status === 400 && /^(invalid_client|invalid_grant|unauthorized_client)$/.test(String(e.error)) ? 401 : [401, 403, 404, 429].includes(res.status) ? res.status : 502;
    throw new Unit7Error(status === 401 ? 'provider_refused' : status === 404 ? 'provider_missing' : 'provider_error', `${who}: ${status === 401 ? 'unauthorized, ' : ''}${msg}`.slice(0, 300), status);
  }
  return data as T;
}
export const isMissing = (e: unknown) => (e as Unit7Error)?.status === 404;
