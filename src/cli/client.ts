// The CLI talks to a Unit7 control plane over HTTP with a token — the same tools as the UI. Config
// lives in ~/.unit7/cli.json (written by `unit7 login`) or in UNIT7_URL / UNIT7_TOKEN.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

// ~/.unit7/cli.json, or the pre-rename ~/.forge/cli.json while that's the only one
const legacy = (now: string, old: string) => (!existsSync(now) && existsSync(old) ? old : now);
const CONFIG = process.env.UNIT7_CONFIG_DIR ? join(process.env.UNIT7_CONFIG_DIR, 'cli.json') : legacy(join(homedir(), '.unit7', 'cli.json'), join(homedir(), '.forge', 'cli.json'));

export interface CliConfig { url: string; token: string; home?: string }

export function loadConfig(): CliConfig | undefined {
  if (process.env.UNIT7_URL && process.env.UNIT7_TOKEN) return { url: process.env.UNIT7_URL, token: process.env.UNIT7_TOKEN };
  if (existsSync(CONFIG)) { try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return undefined; } }
  return undefined;
}

// Where Unit7 keeps its data: UNIT7_HOME, else what `unit7 connect` saved, else ~/.unit7.
export function unit7Home(): string {
  let home = process.env.UNIT7_HOME;
  if (!home && existsSync(CONFIG)) { try { home = JSON.parse(readFileSync(CONFIG, 'utf8')).home; } catch { /* fall through */ } }
  home ||= legacy(join(homedir(), '.unit7'), join(homedir(), '.forge'));
  // the background service and `unit7 connect` write here; a relative home lands in the current folder
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error(`Unit7's data folder must be an absolute path, got "${home}". Check UNIT7_HOME or "home" in ${CONFIG}.`);
  return home;
}

export function saveConfig(c: CliConfig) {
  mkdirSync(join(CONFIG, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function requireConfig(): CliConfig {
  const c = loadConfig();
  if (!c) { console.error('Not logged in. Run `unit7 login --url <https://your-unit7>` and paste a token from Settings → API tokens, or set UNIT7_URL and UNIT7_TOKEN.'); process.exit(1); }
  return c;
}

async function req(path: string, init: { method?: string; body?: unknown; token: string; url: string }) {
  const res = await fetch(`${init.url}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${init.token}`, ...(init.body !== undefined && { 'content-type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => null) as any;
  if (!res.ok && !(path.startsWith('/api/tools/') && data?.status)) {
    throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data;
}

export const apiGet = (path: string, c = requireConfig()) => req(path, { ...c });

// Run a Unit7 tool and print a friendly result. Returns the ok output or exits non-zero.
export async function tool(name: string, input: unknown = {}, o: { config?: CliConfig; dryRun?: boolean; quiet?: boolean } = {}) {
  const c = o.config ?? requireConfig();
  const r = await req(`/api/tools/${name}`, { body: { input, dryRun: o.dryRun }, ...c });
  if (r.status === 'ok') { if (!o.quiet) console.log(typeof r.output === 'string' ? r.output : JSON.stringify(r.output, null, 2)); return r.output; }
  if (r.status === 'dry_run') { console.log('Dry run:', JSON.stringify(r.plan, null, 2)); return r.plan; }
  if (r.status === 'approval_required') { console.error(`⏳ Needs approval: ${r.why}${/run this again/i.test(r.why) ? '' : '\n   Approve it in Unit7: approving runs it, no need to run this again.'}`); process.exit(2); }
  if (r.status === 'denied') { console.error(`✗ Not allowed: ${r.why}`); process.exit(3); }
  console.error(`✗ ${r.error?.message ?? 'failed'}`); process.exit(1);
}
