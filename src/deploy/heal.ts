// Self-healing deploys: read why a deploy failed, fix the common causes, try once more.
//
// `diagnoseFailure` is pure (error text in, a plan out) so every pattern is tested against real error
// output. `applyHeal` carries the plan out through Unit7's own tools (so the gate, audit and vault
// apply). Rules: never guess a value only you know (a third-party key), never change what a start
// command means, retry once.
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../tools/runtime.ts';
import { execute } from '../tools/runtime.ts';
import { json, run } from '../db.ts';
import type { Detection } from '../connectors/detect.ts';
import { majorFromSpec } from '../connectors/detect.ts';
import type { ServiceConfig, ServiceRow } from './deployer.ts';
import { NAMES, parsePin, slotOf, type Pins } from './pins.ts';
import { isPublicKey } from '../tools/env.ts';
import { DOCKERFILE_REV } from './dockerfiles.ts';

export type HealFix =
  | { kind: 'generate-secret'; key: string }
  | { kind: 'provision'; engine: 'postgres' | 'redis' | 'mongo' }
  | { kind: 'set-port'; port: number }
  | { kind: 'bind-all' }
  | { kind: 'node-version'; major: number }
  | { kind: 'node-options'; value: string }
  | { kind: 'pm-pin'; spec: string }   // build with this package manager version, remembered for the app ("pnpm@10")
  | { kind: 'swap' }                   // the server ran out of memory building: give it swap
  | { kind: 'wait'; ms: number }       // the registry or network blinked: wait a moment, then build again
  | { kind: 'data-dir'; dir: string }  // the app keeps files in this folder: make it its own, in a volume (src/deploy/volumes.ts)
  | { kind: 'rebuild' };               // built by an older Unit7 Dockerfile: build again with today's

export interface HealPlan { cause: string; fixes: HealFix[]; needsYou: string[] }

interface Facts {
  text: string;                // the error plus the deployment log (build output, container boot logs)
  detection?: Detection;
  cfg: ServiceConfig;
  setKeys: Set<string>;        // env keys already set for the service
  has: { postgres: boolean; redis: boolean; mongo: boolean }; // databases already wired in this environment
  hostMemMb?: number;
}

const KEY = '([A-Z][A-Z0-9_]{2,})';
// "missing env var" phrasings across Node, Python, PHP, zod/t3-env, Django
const MISSING_ENV = [
  new RegExp(`[Mm]issing (?:required )?env(?:ironment)? var(?:iable)?s?:?\\s*["'\`]?${KEY}`, 'g'),
  new RegExp(`${KEY}["'\`]?\\s+(?:env(?:ironment)? var(?:iable)? )?(?:is|must be)\\s+(?:required|not set|not defined|missing|undefined)`, 'g'),
  new RegExp(`KeyError: ['"]${KEY}['"]`, 'g'),
  new RegExp(`${KEY}:\\s*\\[\\s*['"]Required['"]\\s*\\]`, 'g'),
  new RegExp(`"path":\\s*\\[\\s*"${KEY}"\\s*\\][^}]*"message":\\s*"Required"`, 'g'),
  new RegExp(`process\\.env\\.${KEY} is (?:undefined|not set|required)`, 'g'),
  new RegExp(`Set the ${KEY} environment variable`, 'g'),
];
// values Unit7 can safely make up: random secrets the app itself owns
const GENERATABLE = /(SECRET|_KEY_BASE|JWT|SESSION|COOKIE|ENCRYPT|SIGNING|HMAC|^APP_KEY$|SALT|PEPPER|CSRF)/;
// ...but never something a third party issues
const THIRD_PARTY = /(STRIPE|GITHUB|GOOGLE|AWS|OPENAI|ANTHROPIC|SENDGRID|RESEND|TWILIO|MAILGUN|POSTMARK|CLOUDINARY|SUPABASE|CLERK|SENTRY|PUSHER|ALGOLIA|AUTH0|FIREBASE|PAYPAL|SHOPIFY|SLACK|DISCORD|_CLIENT_SECRET$|_API_KEY$|_ACCESS_KEY|_TOKEN$|WEBHOOK)/;
const DB_KEYS: Record<string, 'postgres' | 'redis' | 'mongo'> = { DATABASE_URL: 'postgres', POSTGRES_URL: 'postgres', POSTGRES_PRISMA_URL: 'postgres', PG_URL: 'postgres', REDIS_URL: 'redis', KV_URL: 'redis', MONGODB_URI: 'mongo', MONGO_URL: 'mongo' };
// "I'm listening on…" lines, to catch an app that serves a different port than Unit7 routes to
const LISTENING = [
  /listening on (?:port )?:?(\d{2,5})\b/i,
  /listening at https?:\/\/[^\s:/]+:(\d{2,5})/i,
  /Local:\s+https?:\/\/[^\s:/]+:(\d{2,5})/,
  /(?:running|started) (?:on|at) https?:\/\/[^\s:/]+:(\d{2,5})/i,
  /Uvicorn running on https?:\/\/[^\s:/]+:(\d{2,5})/,
  /url: https?:\/\/[^\s:/]+:(\d{2,5})/,
  /server (?:is )?running (?:on|at) (?:port )?:?(\d{2,5})\b/i,
];
const LOOPBACK_ONLY = /(?:listening on|running on|Local:\s+https?:\/\/)\s*(?:127\.0\.0\.1|localhost)(?::\d+)?/i;

export function diagnoseFailure(f: Facts): HealPlan {
  const t = f.text;
  const fixes: HealFix[] = [];
  const needsYou: string[] = [];
  const causes: string[] = [];
  const add = (x: HealFix) => { if (!fixes.some((y) => JSON.stringify(y) === JSON.stringify(x))) fixes.push(x); };

  // 1. settings the code needs that nobody set
  const named = new Set<string>();
  for (const re of MISSING_ENV) for (const m of t.matchAll(re)) if (!f.setKeys.has(m[1]!)) named.add(m[1]!);
  const vague = /environment variable|env var/i.test(t) && !named.size;
  const keys = named.size ? [...named] : vague ? (f.detection?.envKeys ?? []).filter((k) => !f.setKeys.has(k)) : [];
  for (const k of keys) {
    const db = DB_KEYS[k];
    if (db) { if (!f.has[db]) add({ kind: 'provision', engine: db }); }
    else if (GENERATABLE.test(k) && !THIRD_PARTY.test(k)) add({ kind: 'generate-secret', key: k });
    else needsYou.push(k);
  }
  if (keys.length) causes.push(`missing settings: ${keys.join(', ')}`);

  // 2. the app reaches for a database that isn't there
  if (!f.setKeys.has('DATABASE_URL') && !f.has.postgres && /ECONNREFUSED[^\n]*:5432|P1001|Can't reach database server|could not connect to server|connection to server at [^\n]* failed|getaddrinfo ENOTFOUND (?:postgres|db)\b/i.test(t)) {
    add({ kind: 'provision', engine: 'postgres' }); causes.push('no database to connect to');
  }
  if (!f.setKeys.has('REDIS_URL') && !f.has.redis && /ECONNREFUSED[^\n]*:6379|Redis connection to [^\n]* failed|getaddrinfo ENOTFOUND redis\b/i.test(t)) {
    add({ kind: 'provision', engine: 'redis' }); causes.push('no Redis to connect to');
  }

  // 3. the app listens somewhere Unit7 isn't looking
  const routed = f.cfg.port ?? f.detection?.port;
  if (LOOPBACK_ONLY.test(t) && !f.setKeys.has('HOST')) { add({ kind: 'bind-all' }); causes.push('the app only listens on localhost inside its container'); }
  for (const re of LISTENING) {
    const p = Number(re.exec(t)?.[1]);
    if (p && routed && p !== routed && p !== 80 && f.detection?.builder !== 'static') { add({ kind: 'set-port', port: p }); causes.push(`the app listens on ${p}, not ${routed}`); break; }
  }

  // 4. wrong Node version
  const engine = /The engine "node" is incompatible with this module\. Expected version "([^"]+)"/.exec(t) ?? /Unsupported engine[^\n]*required:\s*\{\s*node:\s*'([^']+)'/.exec(t) ?? /requires? (?:a )?Node(?:\.js)?(?: version)? ([>=^~\d. x|]+)/i.exec(t);
  if (engine) { const major = majorFromSpec(engine[1]!); if (major && major !== (f.cfg.nodeVersion ?? f.detection?.nodeVersion ?? 22)) { add({ kind: 'node-version', major }); causes.push(`needs Node ${major}`); } }

  // 5. build ran out of memory, or old webpack on new Node
  const opts = new Set((f.cfg.nodeOptions ?? '').split(/\s+/).filter(Boolean));
  if (/JavaScript heap out of memory|Reached heap limit|Allocation failed - JavaScript heap/i.test(t)) {
    const mb = Math.min(4096, Math.max(1024, Math.round((f.hostMemMb ?? 2048) * 0.6)));
    for (const o of [...opts]) if (o.startsWith('--max-old-space-size')) opts.delete(o);
    opts.add(`--max-old-space-size=${mb}`); causes.push('the build ran out of memory');
  }
  if (/0308010C|digital envelope routines::unsupported/.test(t)) { opts.add('--openssl-legacy-provider'); causes.push('an older build tool needs legacy OpenSSL'); }
  const value = [...opts].join(' ');
  if (value && value !== (f.cfg.nodeOptions ?? '')) add({ kind: 'node-options', value });

  return { cause: causes.length ? causes.join('; ') : 'unrecognised failure', fixes, needsYou };
}

export function describe(x: HealFix): string {
  switch (x.kind) {
    case 'generate-secret': return `generated ${x.key}`;
    case 'provision': return `added a ${x.engine} database and wired it in`;
    case 'set-port': return `pointed traffic at port ${x.port}, where the app listens`;
    case 'bind-all': return 'made the app listen on all interfaces (HOST=0.0.0.0)';
    case 'node-version': return `switched to Node ${x.major}`;
    case 'node-options': return `set NODE_OPTIONS=${x.value} for the build`;
    case 'pm-pin': { const p = parsePin(x.spec); return p ? `built with ${NAMES[p.tool]} ${p.version}` : `built with ${x.spec}`; }
    case 'swap': return 'gave the server swap so the build has room';
    case 'wait': return 'waited a moment and built again';
    case 'data-dir': return `fixed the folder permissions and gave it a place to keep files that survives deploys (/app/${x.dir})`;
    case 'rebuild': return 'fixed the folder permissions and built it again';
  }
}

const secretFor = (key: string) => key === 'APP_KEY' ? `base64:${randomBytes(32).toString('base64')}` // Laravel's format
  : /KEY_BASE/.test(key) ? randomBytes(64).toString('hex')                                           // Rails
  : randomBytes(32).toString('base64url');

// Carry out a plan through Unit7's tools. Returns what was done (for the deploy log and the user).
export async function applyHeal(ctx: Ctx, svc: ServiceRow, plan: HealPlan): Promise<string[]> {
  const done: string[] = [];
  const cfg = json<ServiceConfig>(svc.config, {});
  const via = { reason: 'self-heal after a failed deploy' };
  for (const x of plan.fixes) {
    if (x.kind === 'generate-secret') {
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'env.set', { serviceId: svc.id, key: x.key, value: secretFor(x.key), secret: true }, via);
      if (r.status === 'ok') done.push(describe(x));
    } else if (x.kind === 'provision') {
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'database.create', { environmentId: svc.environment_id, engine: x.engine, injectInto: svc.id }, via);
      if (r.status === 'ok') done.push(describe(x));
    } else if (x.kind === 'pm-pin') {
      const p = parsePin(x.spec);
      if (p) { cfg.pinned = [...(cfg.pinned ?? []).filter((s) => { const q = parsePin(s); return !q || slotOf(q.tool) !== slotOf(p.tool); }), x.spec]; done.push(describe(x)); }
    } else if (x.kind === 'swap') {
      if (!svc.server_id) continue;
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.swap', { serverId: svc.server_id }, via);
      if (r.status === 'ok' && !(r.output as { already?: boolean }).already) done.push(describe(x));
    } else if (x.kind === 'wait') {
      await new Promise((r) => setTimeout(r, x.ms));
      done.push(describe(x));
    } else if (x.kind === 'data-dir') {
      cfg.dataDirs = [...new Set([...(cfg.dataDirs ?? []), x.dir])];
      done.push(describe(x));
    } else if (x.kind === 'rebuild') {
      done.push(describe(x));
    } else if (x.kind === 'bind-all') {
      for (const key of ['HOST', 'HOSTNAME']) await execute(ctx.app, ctx.orgId, ctx.actor, 'env.set', { serviceId: svc.id, key, value: '0.0.0.0' }, via);
      done.push(describe(x));
    } else {
      if (x.kind === 'set-port') cfg.port = x.port;
      if (x.kind === 'node-version') cfg.nodeVersion = x.major;
      if (x.kind === 'node-options') cfg.nodeOptions = x.value;
      done.push(describe(x));
    }
  }
  run(ctx.db, 'UPDATE services SET config = ? WHERE id = ?', JSON.stringify(cfg), svc.id);
  return done;
}

// --- build failures, classified -------------------------------------------------------------------------------------------
// What a failed build says, in one plain line, and what to do about it. `ours`: the failing choice was Unit7's own (the
// repo didn't say), so Unit7 builds once more with the corrected one by itself and says so after. When the repo should
// carry the fix, or Unit7 can't settle it, the person gets choices (choicesFor): exactly one recommended. A real code
// mistake is never changed silently: the line, in plain words, and an offer to have it fixed in a pull request.
export type FailureKind = 'pm-version' | 'node-version' | 'oom' | 'flake' | 'build-env' | 'code' | 'permissions';
export interface Failure {
  kind: FailureKind; words: string;
  pin?: string;      // pm-version / node-version: the version to build with ("pnpm@10", "node@20")
  ours?: boolean;    // the version that failed was Unit7's pick, not the repo's (Unit7 rebuilds by itself)
  explicit?: boolean;// the repo itself names the version that failed (the fix belongs in the repo)
  killed?: boolean;  // oom: the server ran out (swap helps), not Node's own heap limit
  keys?: string[];   // build-env: the public settings the build needs
  where?: string;    // code: file:line
  line?: string;     // code: the compiler's own line
  dataDir?: string;  // permissions: the folder the app keeps files in, to make its own (a volume)
  rebuild?: boolean; // permissions: an older Unit7 Dockerfile built it; today's fixes it
}
// the shared choice row's shape (web/src/lib/choices.ts): a tool run as the person, a sentence for Unit7's AI, steps to do
// by hand (copy: the one command among them), or nothing at all ("Not now")
export interface Choice { label: string; why: string; recommended: boolean; tool?: string; input?: Record<string, unknown>; ask?: string; copy?: string; steps?: string[]; look?: boolean; risk?: 'change'; change?: string }
const REDEPLOY = 'Builds and deploys it again; the old version keeps serving until the new one is healthy';
export const FLAKE_WAIT = { ms: 20_000 }; // how long Unit7 waits before building again after a registry blip (tests shorten it)

// a lockfile that's simply out of date (OUTDATED below) is the repo's to fix, never a reason to switch versions
const PM_HARD = /ERR_PNPM_(?:LOCKFILE_BREAKING_CHANGE|LOCKFILE_CONFIG_MISMATCH|NO_LOCKFILE|BROKEN_LOCKFILE|UNSUPPORTED_LOCKFILE\w*|BAD_PM_VERSION|IGNORED_BUILDS|PACKAGE_MANAGER\w*|UNSUPPORTED_PNPM\w*)|This project is configured to use \w+|Ignoring not compatible lockfile|not compatible with (?:the )?current pnpm|compatible with lockfileVersion@\d|current global version of Yarn is|This project's package\.json defines "packageManager"/;
const PM_SOFT = /Ignored build scripts?:/i;
const OUTDATED = /ERR_PNPM_OUTDATED_LOCKFILE|lockfile needs to be updated|The lockfile would have been modified by this install|package\.json and package-lock\.json (?:or npm-shrinkwrap\.json )?are (?:not )?in sync/;
const NODE_NEEDS: [RegExp, boolean][] = [ // the spec, and whether it's "at least"
  [/The engine "node" is incompatible with this module\. Expected version "([^"]+)"/, false],
  [/Unsupported engine[^\n]*required:\s*\{\s*node:\s*'([^']+)'/, false],
  [/wanted:\s*\{\s*"node":\s*"([^"]+)"/, false],
  [/Expected version:\s*([^\n]+)\n\s*Got:\s*v?\d/, false],
  [/requires at least Node(?:\.js)? v?(\d+(?:\.\d+)*)/i, true],
  [/requires? (?:a )?Node(?:\.js)?(?: version)? ([>=^~\d. x|]+)/i, false],
];
const HEAP = /JavaScript heap out of memory|Reached heap limit|Allocation failed - JavaScript heap/;
const KILLED = /exit code:? 137\b|returned a non-zero code: 137|signal: killed|ResourceExhausted|cannot allocate memory|^\s*Killed\s*$/m;
const FLAKE = /\b429\b|Too Many Requests|toomanyrequests|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT|socket hang up|ERR_PNPM_META_FETCH_FAIL|TLS handshake timeout|i\/o timeout|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|npm (?:ERR!|error) network|Could not resolve host/i;
const FILE = String.raw`[\w@.\[\]()/-]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|go|rs|py)`;
const CODE: [RegExp, (m: RegExpExecArray) => { file?: string; at?: string; msg: string }][] = [
  [new RegExp(String.raw`(?:^|\n)\.?\/?(${FILE}):(\d+):\d+\s*\n\s*Type error: ([^\n]+)`), (m) => ({ file: m[1], at: m[2], msg: m[3]! })],                 // Next.js
  [new RegExp(String.raw`(${FILE})(?:\((\d+),\d+\)|:(\d+):\d+)(?::| -) error TS\d+: ([^\n]+)`), (m) => ({ file: m[1], at: m[2] ?? m[3], msg: m[4]! })],  // tsc
  [new RegExp(String.raw`(?:^|\n)\.?\/?(${FILE})(?::(\d+):\d+)?\s*\n\s*Module not found: (?:Error: )?([^\n]+)`), (m) => ({ file: m[1], at: m[2], msg: m[3]! })],
  [/Module not found: (?:Error: )?([^\n]+)/, (m) => ({ msg: m[1]! })],
  [/failed to resolve import "([^"]+)" from "([^"]+)"/, (m) => ({ file: m[2], msg: `Cannot find module '${m[1]}'` })],              // Vite / Rollup
  [new RegExp(String.raw`Could not resolve "([^"]+)"\s*\n\s*\n?\s*(${FILE}):(\d+)`), (m) => ({ file: m[2], at: m[3], msg: `Cannot find module '${m[1]}'` })], // esbuild
  [/ModuleNotFoundError: (No module named '[^']+')/, (m) => ({ msg: m[1]! })],                                                       // Python
  [new RegExp(String.raw`(?:^|\n)\s*\.?\/?(${FILE}):(\d+):\d+: ([^\n]+)`), (m) => ({ file: m[1], at: m[2], msg: m[3]! })],                // Go
  [new RegExp(String.raw`error(?:\[E\d+\])?: ([^\n]+)\n\s*--> (${FILE}):(\d+)`), (m) => ({ file: m[2], at: m[3], msg: m[1]! })],          // Rust
  [/SyntaxError: ([^\n]+)/, (m) => ({ msg: m[1]! })],
];
// a compiler's sentence in plainer words
function plainly(msg: string): string {
  const q = (s: string) => `“${s.slice(0, 60)}”`;
  let m: RegExpExecArray | null;
  if ((m = /Cannot find module '([^']+)'|Can't resolve '([^']+)'/.exec(msg))) return `it imports ${q(m[1] ?? m[2]!)}, which isn’t there`;
  if ((m = /Property '([^']+)' does not exist on type '([^']+)'/.exec(msg))) return `it uses ${q(m[1]!)} on ${q(m[2]!)}, which doesn’t have it`;
  if ((m = /Cannot find name '([^']+)'|^undefined: (\w+)|cannot find value `(\w+)`/.exec(msg))) return `it uses ${q(m[1] ?? m[2] ?? m[3]!)}, which isn’t defined anywhere`;
  if ((m = /No module named '([^']+)'/.exec(msg))) return `it needs the Python package ${q(m[1]!)}, which isn’t in its requirements`;
  if ((m = /Type '(.+?)' is not assignable to type '(.+?)'/.exec(msg))) return `a value has the wrong type (${q(m[1]!)} where ${q(m[2]!)} is expected)`;
  return msg.trim().replace(/\.$/, '').slice(0, 160);
}
const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const majorOf = (v?: string) => (v ? /^(\d+)/.exec(v)?.[1] : undefined);

// The app (or its start step) wasn't allowed to write in its own folder: a folder it creates for its files, its packages
// (pnpm wanting to reinstall node_modules at start), a SQLite file. Node, Python, pnpm and busybox phrasings.
const DENIED: RegExp[] = [
  /(?:EACCES|EPERM): (?:permission denied|operation not permitted), (?:mkdir|open|scandir|unlink|rename|copyfile|symlink|rmdir|access|chmod|utime|lstat|stat) '([^']+)'/,
  /PermissionError: \[Errno 13\] Permission denied: '([^']+)'/,
  /Failed to remove (\S+?)(?: from the modules directory)?: Permission denied/,
  /mkdir: (?:can't create directory|cannot create directory) '([^']+)': Permission denied/,
  /ERR_PNPM_\w+[^\n]*Permission denied \(os error 13\)/,
  /SQLITE_CANTOPEN|unable to open database file/,
];
// which folder under the app's own (/app) a denied path is in: a data folder to keep, or Unit7's own (node_modules)
const appDir = (p?: string) => (p ? /^\/app\/([^/]+)/.exec(p)?.[1] : undefined);
const MODULES = new Set(['node_modules', '.next', 'dist', 'build', '.cache']);

// skip: kinds already tried (a second failure after Unit7 switched versions isn't about the version)
// builder / rev / dataDirs: whose Dockerfile built it (Unit7's 'railpack' or the repo's), which revision of Unit7's, and the
// folders the app already keeps in volumes (so a permission fix is made once, never in a loop)
export function classifyBuild(f: { text: string; code?: string; pins?: Pins; nodeVersion?: number; packageManager?: string; setKeys: Set<string>; skip?: FailureKind[]; builder?: string; rev?: number; dataDirs?: string[] }): Failure | undefined {
  const t = f.text;
  // before anything else: "ERR_PNPM_PACKAGE_MANAGER_…: Permission denied" isn't about pnpm's version
  const denied = f.skip?.includes('permissions') ? undefined : DENIED.map((re) => re.exec(t)).find(Boolean);
  if (denied && (f.code === 'build_failed' || f.code === 'unhealthy' || f.code === 'deploy_failed' || !f.code)) {
    const path = denied[1], dir = appDir(path), ours = f.builder !== 'dockerfile' && f.builder !== 'compose';
    const keep = dir && !MODULES.has(dir) && !/\.(?:db|sqlite3?|json|log)$/.test(dir) ? dir : undefined;
    const what = keep ? `create /app/${keep}` : dir && MODULES.has(dir) ? 'change its installed packages when it started' : path ? `write ${path}` : 'write its files';
    const words = `The app tried to ${what} but wasn’t allowed to.`;
    // Unit7's own Dockerfile: a folder it doesn't keep yet, or one built by an older Dockerfile, is fixed by building again
    const dataDir = ours && keep && !f.dataDirs?.includes(keep) ? keep : undefined;
    const rebuild = ours && !dataDir && (f.rev ?? 1) < DOCKERFILE_REV;
    return { kind: 'permissions', words, ours, ...(dataDir && { dataDir }), ...(rebuild && { rebuild }), ...(path && { where: path }), line: denied[0].slice(0, 200) };
  }
  if (f.code === 'tests_failed') {
    const last = t.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /^The tests? .*failed|tests? failed/i.test(l));
    return { kind: 'code', words: `Your app’s own tests failed, so Unit7 didn’t put this version live.${last ? ` ${last}` : ''}` };
  }
  if (f.code && f.code !== 'build_failed') return undefined; // a runtime failure: the self-heal above reads those
  // out of memory: Node's own heap limit (more heap) or the whole server (swap)
  if (HEAP.test(t)) return { kind: 'oom', words: 'The build ran out of memory.' };
  if (KILLED.test(t)) return { kind: 'oom', killed: true, words: 'The server ran out of memory while building, so the build was stopped.' };

  // the package manager: a version that can't work with this project
  const pin = f.pins?.pm, tool = (pin?.tool ?? f.packageManager ?? (/ERR_PNPM_|pnpm/i.test(t) ? 'pnpm' : /yarn|YN\d{4}/i.test(t) ? 'yarn' : 'npm')) as 'pnpm' | 'yarn' | 'npm';
  const hard = PM_HARD.test(t), soft = PM_SOFT.test(t);
  const codeHit = CODE.findIndex(([re]) => re.test(t));
  if (!f.skip?.includes('pm-version') && (hard || (soft && codeHit === -1))) { // "ignored build scripts" is only a warning: a code mistake beside it is the cause
    // what ran: this build's pin, or (an older deploy) what the log shows corepack fetching
    const logged = new RegExp(String.raw`(?:${tool}|cli-dist)-(\d+)\.\d+\.\d+\.tgz|Your current ${tool} is v?(\d+)|${tool} v(\d+)\.\d+`).exec(t);
    const used = majorOf(pin?.version) ?? logged?.[1] ?? logged?.[2] ?? logged?.[3];
    const known = pin?.lock ?? (pin && pin.source !== 'repo' ? [majorOf(pin.version)!, ...(pin.alts ?? [])] : tool === 'pnpm' ? ['10', '9'] : undefined);
    const next = known?.find((m) => m !== used);
    if (next) {
      const name = NAMES[tool], ours = !pin || pin.source === 'lockfile' || pin.source === 'default', explicit = pin?.source === 'repo';
      const ran = used ? `${name} ${used}` : `a newer ${name}`;
      const what = soft && !hard ? `The build used ${ran}, which skipped the install steps some of your packages need.` : `The build used ${ran}, which can’t work with the lockfile in your repo.`;
      const lockSays = pin?.lock?.length ? `your lockfile was made by ${name} ${pin.lock.join(' or ')}` : `your lockfile works with ${name} ${next}`;
      const why = explicit ? `Your repo asks for ${name} ${used}, but ${lockSays}.` : ours ? `Your repo doesn’t say which ${name} to use, and ${lockSays}.` : `${name} ${used} was picked for this app before, but ${lockSays}.`;
      return { kind: 'pm-version', words: `${what} ${why}`, pin: `${tool}@${next}`, ours, explicit };
    }
  }
  // Node: part of the app asks for another version
  const usedNode = Number(f.pins?.node?.version ?? f.nodeVersion ?? 22);
  for (const [re, atLeast] of f.skip?.includes('node-version') ? [] : NODE_NEEDS) {
    const m = re.exec(t);
    const major = m ? majorFromSpec(atLeast ? `>=${m[1]}` : m[1]!) : undefined;
    if (!major || major === usedNode) continue;
    const ours = !f.pins?.node || f.pins.node.source === 'default', explicit = f.pins?.node?.source === 'repo';
    const needs = atLeast ? `Node ${/^(\d+)/.exec(m![1]!)?.[1]} or newer` : `Node ${major}`;
    return { kind: 'node-version', words: `Part of your app needs ${needs}, but the build used Node ${usedNode}.${explicit ? ` Your repo asks for Node ${usedNode}.` : ours ? ' Your repo doesn’t say which Node to use.' : ''}`, pin: `node@${major}`, ours, explicit };
  }
  // public settings baked into the pages at build time (NEXT_PUBLIC_*, VITE_*…)
  const keys = new Set<string>();
  for (const re of MISSING_ENV) for (const m of t.matchAll(re)) if (isPublicKey(m[1]!) && !f.setKeys.has(m[1]!)) keys.add(m[1]!);
  if (keys.size) {
    const k = [...keys], many = k.length > 1;
    return { kind: 'build-env', keys: k, words: `The build needs ${list(k)}, which ${many ? 'aren’t' : 'isn’t'} set for this app. ${many ? 'They’re' : 'It’s'} built into the pages, so ${many ? 'they have' : 'it has'} to be there before the build.` };
  }
  // a mistake in the code: the line, in plain words
  if (codeHit >= 0) {
    const [re, read] = CODE[codeHit]!;
    const m = re.exec(t)!, r = read(m);
    const where = r.file ? `${r.file.replace(/^\.\//, '')}${r.at ? `:${r.at}` : ''}` : undefined;
    const place = r.file ? `In ${r.file.replace(/^\.\//, '')}${r.at ? `, line ${r.at}` : ''}, ` : 'The code: ';
    return { kind: 'code', words: `The code has a mistake, so it didn’t build. ${place}${plainly(r.msg)}.`, ...(where && { where }), line: m[0].trim().split('\n').slice(-1)[0]!.slice(0, 200) };
  }
  const out = OUTDATED.exec(t);
  if (out) return { kind: 'code', words: 'The lockfile in your repo doesn’t match package.json, so the install stopped. It needs updating in the repo.', line: out[0] };
  // the registry or the network blinked (read near the end: an early retry that worked isn't the failure)
  const tail = t.slice(-4000);
  if (FLAKE.test(tail)) return { kind: 'flake', words: /429|Too Many Requests|toomanyrequests/i.test(tail) ? 'A package registry asked the build to slow down (too many downloads at once).' : 'A package registry didn’t answer for a moment.' };
  return undefined;
}

// what Unit7 does by itself for a failure: only its own choices, and only what can't change what the app does
export function fixesFor(f: Failure | undefined): HealFix[] {
  if (!f) return [];
  if (f.kind === 'pm-version' && f.ours && f.pin) return [{ kind: 'pm-pin', spec: f.pin }];
  if (f.kind === 'oom' && f.killed) return [{ kind: 'swap' }];
  if (f.kind === 'flake') return [{ kind: 'wait', ms: FLAKE_WAIT.ms }];
  if (f.kind === 'permissions' && f.ours) return f.dataDir ? [{ kind: 'data-dir', dir: f.dataDir }] : f.rebuild ? [{ kind: 'rebuild' }] : [];
  return [];
}

// 3–4 choices, exactly one recommended. 'failed': the old version is still serving and the person decides. 'healed': Unit7
// already built it with the right version; what's left is writing it into the repo.
export function choicesFor(f: Failure, o: { app: string; serviceId: string; deploymentId?: string; state: 'failed' | 'healed'; fromProduction?: { serviceId: string; environmentId: string } }): Choice[] {
  const again: Choice = { label: 'Try the build again', why: 'The live version keeps serving meanwhile.', recommended: false, tool: 'deployment.create', input: { serviceId: o.serviceId }, risk: 'change', change: REDEPLOY };
  const log: Choice = { label: 'Show me the build log', why: 'Everything the build printed, with secrets hidden.', recommended: false, tool: 'deployment.logs', input: o.deploymentId ? { deploymentId: o.deploymentId } : { serviceId: o.serviceId }, look: true };
  const askUnit7: Choice = { label: 'Ask Unit7', why: 'Unit7’s AI reads the build log and talks it through with you.', recommended: false, ask: `The deploy of ${o.app} failed: ${f.words} What should I do?` };
  if ((f.kind === 'pm-version' || f.kind === 'node-version') && f.pin) {
    const p = parsePin(f.pin)!, name = `${NAMES[p.tool]} ${p.version}`;
    const copy = p.tool === 'node' ? `npm pkg set engines.node=${p.version}.x` : `corepack use ${f.pin}`;
    const command: Choice = { label: 'Show me the command', why: 'Run it in your repo, then commit and push.', recommended: false, copy, steps: [`In your repo, run: ${copy}`, 'Commit and push; Unit7 deploys it like any push.'] };
    const where = p.tool === 'node' ? 'package.json (engines)' : 'package.json';
    if (o.state === 'healed') return [
      { label: `Pin ${name} in the repo for me`, why: `Opens a pull request that writes it into ${where}, so every build and every computer uses it. Nothing changes until it’s merged.`, recommended: true, tool: 'deployment.pin_pr', input: { serviceId: o.serviceId, pins: [f.pin] } },
      command,
      { label: 'Not now', why: `Unit7 keeps building ${o.app} with ${name} either way.`, recommended: false },
    ];
    return [
      { label: `Build with ${name} and pin it for me`, why: `Unit7 builds with ${name} now, then opens a pull request that writes it into ${where}. The live version keeps serving until the new one is healthy.`, recommended: true, tool: 'deployment.create', input: { serviceId: o.serviceId, pin: f.pin, pinPr: true }, risk: 'change', change: `${REDEPLOY}, then opens a pull request` },
      { label: `Build with ${name} this time only`, why: 'Your repo stays as it is.', recommended: false, tool: 'deployment.create', input: { serviceId: o.serviceId, pin: f.pin }, risk: 'change', change: REDEPLOY },
      command,
      askUnit7,
    ];
  }
  if (f.kind === 'build-env') {
    const keys = f.keys ?? [];
    const out: Choice[] = [];
    if (o.fromProduction) out.push({ label: 'Copy them from Production', why: `Copies ${list(keys)} from the live app. Then build again: they’re baked in at build time.`, recommended: true, tool: 'env.copy', input: { fromServiceId: o.fromProduction.serviceId, environmentId: o.fromProduction.environmentId, keys } });
    out.push({ label: 'Type them in', why: 'A short form; Unit7 keeps them with this app’s settings.', recommended: !o.fromProduction, ask: `Ask me for ${list(keys)} with a form, save ${keys.length > 1 ? 'them' : 'it'} for ${o.app}, then deploy ${o.app} again.` });
    out.push({ ...again, label: 'Build again', why: 'Once they’re set.' });
    if (out.length < 4) out.push(askUnit7);
    return out;
  }
  if (f.kind === 'code') return [
    { label: 'Ask Unit7 to fix it', why: 'Unit7’s AI finds the fix and opens a pull request with it. Nothing goes live until you merge it; the live version keeps serving.', recommended: true,
      ask: `Fix the mistake that stops ${o.app} from building${f.where ? ` (${f.where})` : ''}: read the last build log, find the fix, and open a pull request with it on a new branch. Never push to the main branch.` },
    { ...again, why: 'Once a fix is merged. The live version keeps serving meanwhile.' },
    log,
  ];
  if (f.kind === 'permissions') return f.ours ? [
    { ...again, label: 'Build again', why: 'Unit7 makes the app’s folder its own and keeps its files in a place that survives deploys. The live version keeps serving meanwhile.', recommended: true },
    log, askUnit7,
  ] : [
    { label: 'Ask Unit7 to fix the Dockerfile', why: 'Your repo’s Dockerfile runs the app as a user that can’t write there. Unit7’s AI opens a pull request that fixes it; nothing goes live until you merge it.', recommended: true,
      ask: `${o.app} can’t write ${f.where ?? 'its files'} when it starts (permission denied). Read the last deploy log and the repo’s Dockerfile, then open a pull request on a new branch that makes that folder belong to the user the app runs as (COPY --chown, or mkdir and chown before USER), keeping the app off root. Never push to the main branch.` },
    { ...again, why: 'Once a fix is merged. The live version keeps serving meanwhile.' },
    log,
  ];
  if (f.kind === 'oom') return [
    { label: 'Ask Unit7', why: 'Unit7’s AI finds a way to build it with less memory, or a bigger server for it.', recommended: true, ask: `${o.app}'s build keeps running out of memory on its server. Find a way to build it with less memory, or tell me what size of server it needs.` },
    again, log,
  ];
  return [{ ...again, recommended: true }, log, askUnit7]; // flake
}
