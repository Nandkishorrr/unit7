// Home's five suggested tasks: what's most worth doing next, from what Unit7 already knows. Open problems (the
// server watch, risks, sites down, errors), Warden's suggestions, what waits for your OK, things going stale (no
// backup, a certificate or domain about to run out, subdomains nobody uses), what you asked before and didn't
// finish (or keep asking), and setup gaps (Coolify not connected, no phone alerts, no budget). Deterministic: stored
// state only, no AI call and no trip to a server. Each task is a sentence the AI can do, with why, where it came
// from, how urgent it is, and a one-click fix when one exists. Archived things stay out; a task you dismiss stays
// away for 7 days.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, json, type DB } from '../db.ts';
import { suggestions, type Suggestion } from '../suggestions.ts';
import { watchIssues } from '../sentinel/watch.ts';
import { serverFindings } from '../discovery/findings.ts';
import { coolifyAccount, lastXray } from './xray.ts';
import { archivedAssets, archivedServices, assetIdOf } from '../archive.ts';
import { isRunning } from '../agent/brain.ts';
import { untrusted } from '../agent/escalate.ts';
import { alertKey, hiddenNow, snooze, snoozeKeyOf, unsnooze } from '../snooze.ts';
import { alertsVerified } from '../sentinel/phone.ts';
import { explainAlert, explainFinding, explainSuggestion, type Explain } from '../explain.ts';

// What a task asks the person's AI is the person's own message, so text from outside (a provider's error message, a log
// line, a hostname, a container's name) never goes in as their words: the sentence is Unit7's own with a short clean
// label, and the outside text follows fenced off as data (the same fence as the story and the phone fix use).
export const cleanLabel = (s: string, n = 60) => s.replace(/[\u0000-\u001f\u007f"'`\\<>{}[\]|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const hostLabel = (h: string) => h.toLowerCase().replace(/[^a-z0-9.:-]/g, '').slice(0, 80);
export const askWith = (sentence: string, source: string, raw: string) => `${sentence}\n\n${untrusted(source, raw.slice(0, 800))}`;
const OUTSIDE_ASK: Record<string, string> = { error: 'the app’s error log', vuln: 'the security scan', devserver: 'the app’s settings', 'scale-blocked': 'what Unit7 found in the code' };

export type Source = 'problem' | 'approval' | 'stale' | 'history' | 'suggestion' | 'setup';
export type Severity = 'alert' | 'warn' | 'info';
export interface About { kind: 'server' | 'project' | 'app' | 'domain' | 'database' | 'account'; id: string; name: string }
export interface Task {
  id: string;            // stable: dismissing hides this id
  text: string;          // a sentence the AI can do: "Back up shop-db every day, it has no backup yet"
  why: string;           // the reason, for the hover
  source: Source; label: string; // where it came from, in plain words ("Server watch", "Your chats")
  icon: string;          // a brand logo id (coolify, vercel…) or a plain icon name (alert, backup, globe…)
  severity: Severity;
  related?: number;      // how many more tasks are the same problem (one certificate: "down", "broken" and "renew it")
  fix?: { tool: string; input: Record<string, unknown>; label: string; success?: string }; // the direct one-click fix
  href?: string; cta?: string;   // a page to open instead (approvals, alerts, budget)
  ask?: string;                  // what goes in the ask box (the text when unset)
  conversationId?: string;       // finish an earlier chat: open it and carry on
  about?: About;                 // the thing it's about, as a context chip for the ask
  at?: string;
  explain?: Explain;             // what happened, what it can cause, what Unit7 does: the hover's plain words
  snoozeKey?: string;            // what "This is fine" hides: the finding or alert itself, so every list agrees (else id)
}
export type Candidate = Task & { keys?: string[] }; // keys: what it's about, to leave out what's archived

const DAY = 86400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DB_KINDS = new Set(['postgres', 'mysql', 'mariadb', 'mongo', 'redis']);
const lc = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const firstSentence = (t: string) => (/^(.+?[.!?])(\s|$)/.exec(t)?.[1] ?? t).replace(/[.!]$/, '');
export const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// --- the ranking (pure) -------------------------------------------------------------------------------------------
const SEV: Record<Severity, number> = { alert: 300, warn: 200, info: 100 };
const SRC: Record<Source, number> = { problem: 50, approval: 45, stale: 30, history: 20, suggestion: 10, setup: 0 };
// newer counts a little (at most 20 points, so it never lifts a task over a more urgent one)
const freshness = (at: string | undefined, now: number) => (at ? Math.max(0, 20 - Math.floor((now - Date.parse(at)) / 3600_000)) : 0);
export const scoreOf = (c: Candidate, now = Date.now()) => SEV[c.severity] + SRC[c.source] + freshness(c.at, now);

// One broken thing, one row: a site's "down", "certificate broken" and "renew it" are the same problem said three ways
export const rootOf = (id: string) => /^(?:risk:)?(?:domain:\w+|site:\w+):(.+)$/.exec(id)?.[1];

// The top few: dismissed and archived out, the same task (or sentence) once, at most two from one source while
// others wait (so five errors don't hide the backup nobody has), most urgent first; ties by id, so it's stable.
export function rankTasks(list: Candidate[], o: { dismissed?: Set<string>; archived?: Set<string>; limit?: number; now?: number } = {}): Task[] {
  const now = o.now ?? Date.now(), limit = o.limit ?? 5;
  const ranked = list.filter((c) => !o.dismissed?.has(c.id) && !c.keys?.some((k) => o.archived?.has(k)))
    .map((c) => ({ c, s: scoreOf(c, now) })).sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id));
  const seen = new Set<string>(), uniq: typeof ranked = [], roots = new Map<string, typeof ranked[number]>();
  for (const x of ranked) {
    const k = norm(x.c.text), root = rootOf(x.c.id);
    if (seen.has(x.c.id) || seen.has(k)) continue;
    const first = root ? roots.get(root) : undefined;
    if (first) { first.c = { ...first.c, related: (first.c.related ?? 0) + 1 }; seen.add(x.c.id); continue; }
    if (root) roots.set(root, x);
    seen.add(x.c.id); seen.add(k); uniq.push(x);
  }
  const per: Partial<Record<Source, number>> = {}, picked: typeof ranked = [], rest: typeof ranked = [];
  for (const x of uniq) { if ((per[x.c.source] ?? 0) < 2) { per[x.c.source] = (per[x.c.source] ?? 0) + 1; picked.push(x); } else rest.push(x); }
  return [...picked.slice(0, limit), ...rest].slice(0, limit).sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id))
    .map(({ c: { keys: _k, ...t } }) => t);
}

// --- what each source says -----------------------------------------------------------------------------------------
// Warden's suggestions, said as something to do. The id names what it's about (backup:svc_…, harden:srv_…).
const SAY: Record<string, (n: string) => string> = {
  backup: (n) => `Back up ${n} every day, it has no backup yet`,
  badbackup: (n) => `Take a fresh backup of ${n}, the last one doesn’t restore`,
  offsite: (n) => `Copy ${n}’s latest backup off its server`,
  migration: (n) => `Back up ${n}’s database, then finish its deploy`,
  deployfail: (n) => `Find out why ${n}’s last deploy failed`,
  error: (n) => `Fix the errors in ${n}`,
  '5xx': (n) => `Fix the server errors on ${n}`,
  vuln: (n) => `Upgrade ${n}’s packages that have known security holes`,
  devserver: (n) => `Run ${n} as a production build`,
  leak: (n) => `Rename the secret in ${n} that would ship to browsers`,
  envmissing: (n) => `Add the missing settings to ${n}`,
  health: (n) => `Add a health check to ${n}`,
  domain: (n) => `Give ${n} its own domain`,
  cache: (n) => `Let browsers cache ${n}’s build files`,
  scale: (n) => `Run a second copy of ${n} to share the load`,
  'scale-blocked': (n) => `Make ${n} safe to run as two copies`,
  'server-max': (n) => `Give ${n} more room, its server is maxed out`,
  mem: (n) => `Find out why ${n} uses so much memory`,
  job: (n) => `Fix ${n}’s failing scheduled job`,
  worker: (n) => `Start ${n}’s background worker`,
  idle: (n) => `Stop ${n}, nobody visited it in two days`,
  down: (n) => `Find out why ${n} stopped answering, and fix it`,
  prepare: (n) => `Prepare ${n} so it can run apps`,
  harden: (n) => `Lock down ${n}: sign-in and open ports`,
  disk: (n) => `Free up space on ${n}, its disk is nearly full`,
  rightsize: (n) => `Move ${n} to a smaller plan and pay less`,
};
// a product suggestion (src/organize/groups.ts), said as something to do
export const groupWords = (t: string) => {
  const one = /^These (\d+) look like one product: (.+)\. Group them\?$/.exec(t);
  if (one) return `Group ${one[1]} things into one product: ${one[2]}`;
  const into = /^(.+) looks? like part of (.+)\. Add (?:them|it)\?$/.exec(t);
  return into ? `Add ${into[1]} to ${into[2]}` : firstSentence(t);
};
const PROBLEM = new Set(['incident', 'down', 'deployfail', 'error', '5xx', 'badbackup', 'migration', 'leak', 'devserver', 'vuln', 'mem', 'server-max']);
const STALE = new Set(['backup', 'offsite']);
// on the general view these are the setup steps on Home already, or not tasks
const SKIP = new Set(['all-clear', 'approvals', 'no-server', 'first-deploy', 'no-agent', 'blocked', 'staging']);
// the same suggestion for several things says it once: "Add the missing settings to api and web"
const SAY_MANY: Record<string, (names: string) => string> = {
  envmissing: (n) => `Add the missing settings to ${n}`,
  backup: (n) => `Back up ${n} every day, they have no backup yet`,
  harden: (n) => `Lock down ${n}: sign-in and open ports`,
  health: (n) => `Add health checks to ${n}`,
  domain: (n) => `Give ${n} their own domains`,
  vuln: (n) => `Upgrade the packages with known security holes in ${n}`,
  cache: (n) => `Let browsers cache the build files of ${n}`,
  devserver: (n) => `Run ${n} as production builds`,
};
export const names = (list: string[]) => (list.length <= 3 ? list.slice(0, -1).join(', ') + (list.length > 1 ? ` and ${list.at(-1)}` : list[0] ?? '') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`);
const SEV_ORDER: Severity[] = ['alert', 'warn', 'info'];
export function mergeSame(list: (Candidate & { kind?: string; name?: string })[]): Candidate[] {
  const groups = new Map<string, typeof list>();
  for (const c of list) { const k = c.kind && c.name && SAY_MANY[c.kind] ? c.kind : c.id; groups.set(k, [...(groups.get(k) ?? []), c]); }
  return [...groups.entries()].map(([k, g]) => {
    const strip = ({ kind: _k, name: _n, ...c }: (typeof list)[number]): Candidate => c;
    if (g.length === 1) return strip(g[0]!);
    const all = g.map((c) => c.name!).sort((a, b) => a.localeCompare(b));
    const { fix: _f, about: _a, ask: _q, ...first } = strip(g[0]!);
    return { ...first, id: `${k}:${all.join(',')}`.slice(0, 280), text: SAY_MANY[k]!(names(all)), why: g.slice(0, 2).map((c) => c.why).join(' ') + (g.length > 2 ? ` And ${g.length - 2} more like it.` : ''),
      severity: SEV_ORDER.find((s) => g.some((c) => c.severity === s))!, keys: [...new Set(g.flatMap((c) => c.keys ?? []))] };
  });
}

const ICON: Record<string, string> = { backup: 'backup', badbackup: 'backup', offsite: 'backup', migration: 'database', harden: 'lock', leak: 'lock', vuln: 'shield', disk: 'disk', down: 'server', prepare: 'server', rightsize: 'wallet', domain: 'globe', incident: 'alert' };

// what an id like "backup:svc_…" or "error:err_…" is about: its name, the context chip, the ids archive checks use
function subject(db: DB, orgId: string, id: string): { name?: string; about?: About; keys: string[]; extra?: string } {
  for (const p of id.split(':').slice(1)) {
    const svc = (sid: string, extra?: string) => {
      const s = get<{ name: string; kind: string; project_id: string }>(db, 'SELECT name, kind, project_id FROM services WHERE id = ? AND org_id = ?', sid, orgId);
      return s ? { name: s.name, about: { kind: DB_KINDS.has(s.kind) ? 'database' as const : 'app' as const, id: sid, name: s.name }, keys: [sid, s.project_id], extra } : undefined;
    };
    if (p.startsWith('svc_')) { const r = svc(p); if (r) return r; }
    if (p.startsWith('srv_')) {
      const s = get<{ name: string }>(db, 'SELECT name FROM servers WHERE id = ? AND org_id = ?', p, orgId);
      if (s) return { name: s.name, about: { kind: 'server', id: p, name: s.name }, keys: [p, assetIdOf(orgId, `unit7:${p}`)] };
    }
    if (p.startsWith('err_')) { const g = get<{ service_id: string; kind: string }>(db, 'SELECT service_id, kind FROM error_groups WHERE id = ?', p); const r = g && svc(g.service_id, g.kind); if (r) return r; }
    if (p.startsWith('bak_')) { const b = get<{ service_id: string }>(db, 'SELECT service_id FROM backups WHERE id = ?', p); const r = b && svc(b.service_id); if (r) return r; }
    if (p.startsWith('job_')) { const j = get<{ service_id: string }>(db, 'SELECT service_id FROM jobs WHERE id = ?', p); const r = j && svc(j.service_id); if (r) return r; }
    if (p.startsWith('prj_')) { const x = get<{ name: string }>(db, 'SELECT name FROM projects WHERE id = ? AND org_id = ?', p, orgId); if (x) return { name: x.name, about: { kind: 'project', id: p, name: x.name }, keys: [p] }; }
  }
  return { keys: [] };
}

function fromSuggestion(db: DB, orgId: string, s: Suggestion): (Candidate & { kind: string; name?: string }) | undefined {
  const kind = s.id.split(':')[0]!;
  if (SKIP.has(kind)) return undefined;
  const sub = subject(db, orgId, s.id);
  const say = SAY[kind] as ((n: string) => string) | undefined;
  const tool = s.actions.find((a) => a.kind === 'tool' && !a.preview);
  const text = kind === 'serverapp' && tool?.kind === 'tool' && sub.name ? `${tool.label} on ${sub.name}` // "Connect Supabase on box"
    : kind === 'error' && sub.extra && sub.name ? `Fix the ${cleanLabel(sub.extra, 40)} in ${sub.name}`
    : kind === 'incident' ? `Look into it: ${cleanLabel(firstSentence(s.text.replace(/^Incident on the perimeter:\s*/, '')), 100)}`
    : kind === 'group' ? groupWords(s.text)
    : say && sub.name ? say(sub.name) : firstSentence(s.text);
  const prompt = s.actions.find((a) => a.kind === 'ask');
  return {
    id: s.id, text, why: s.text, severity: s.severity, source: PROBLEM.has(kind) ? 'problem' : STALE.has(kind) ? 'stale' : 'suggestion',
    label: kind === 'error' ? 'Errors' : kind === 'vuln' || kind === 'leak' ? 'Security check' : kind === 'group' ? 'Products' : 'Warden', icon: ICON[kind] ?? (sub.about?.kind === 'database' ? 'database' : sub.about?.kind === 'server' ? 'server' : kind === 'error' || kind === '5xx' ? 'bug' : 'app'),
    ...(tool?.kind === 'tool' && { fix: { tool: tool.tool, input: tool.input, label: tool.label, ...(tool.success && { success: tool.success }) } }),
    ...(prompt?.kind === 'ask' && { ask: OUTSIDE_ASK[kind] ? askWith(`${text}. Find the cause and fix it, if it’s safe.`, OUTSIDE_ASK[kind]!, prompt.prompt.replace(/^\/unit7\s+/, '')) : prompt.prompt.replace(/^\/unit7\s+/, '') }),
    ...(kind === 'incident' && !prompt && { ask: askWith('Look into this incident: find out what happened, and fix it if it’s safe.', 'the incident', s.text) }),
    ...(sub.about && { about: sub.about }), keys: [...(sub.keys ?? []), s.id], kind, name: sub.name, explain: explainSuggestion(s.id, s.text),
  };
}

const RISK_SEV: Record<string, Severity | undefined> = { critical: 'alert', high: 'alert', medium: 'warn' };
// a server risk, said as something to do on that server
function riskText(f: { id: string; title: string }, server: string) {
  const name = (re: RegExp) => re.exec(f.title)?.[1];
  if (f.id.startsWith('xray:no-backup:')) return `Back up ${name(/^(.+?) has no backups/) ?? 'this database'}, it has no backup yet`;
  if (f.id.startsWith('server:port:')) { const port = f.id.split(':').at(-1); const who = name(/^(.+?) (?:\(.+?\) )?answers the internet/); return who ? `Close ${who} to the internet on ${server}` : `Close port ${port} on ${server} to the internet`; }
  if (f.id.startsWith('xray:restart-loop:')) return `Find out why ${name(/^(.+) keeps restarting/) ?? 'an app'} keeps restarting on ${server}`;
  if (f.id.startsWith('xray:oom:')) return `Stop ${name(/^(.+) keeps running out of memory/) ?? 'an app'} running out of memory on ${server}`;
  if (f.id.startsWith('xray:disk-forecast:')) return `Free up disk space on ${server} before it fills up`;
  return `Fix on ${server}: ${lc(f.title)}`;
}

// --- gathering (reads only what's stored) -----------------------------------------------------------------------
export function candidates(ctx: Pick<Ctx, 'app' | 'db' | 'orgId' | 'actor'>): Candidate[] {
  const { db, orgId } = ctx;
  const out: Candidate[] = [];
  const add = (c: Candidate | undefined) => { if (c) out.push(c); };
  const userId = ctx.actor.userId;
  const servers = all<{ id: string; name: string; status: string }>(db, 'SELECT id, name, status FROM servers WHERE org_id = ? ORDER BY name', orgId);
  const serverAbout = (s: { id: string; name: string }): Pick<Candidate, 'about' | 'keys'> => ({ about: { kind: 'server', id: s.id, name: s.name }, keys: [s.id, assetIdOf(orgId, `unit7:${s.id}`)] });
  const assetName = (id?: string | null) => (id ? get<{ name: string; kind: string; provider: string }>(db, 'SELECT name, kind, provider FROM assets WHERE id = ? AND org_id = ?', id, orgId) : undefined);
  const domainAsset = (name: string) => get<{ id: string }>(db, `SELECT id FROM assets WHERE org_id = ? AND kind = 'domain' AND name = ?`, orgId, name)?.id;

  // waiting for your OK: one task that opens Approvals (the list itself lives there and in the side panel)
  const pending = all<{ why: string; created_at: string }>(db, `SELECT why, created_at FROM approvals WHERE org_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC`, orgId, new Date().toISOString());
  if (pending.length) add({ id: 'approvals', source: 'approval', label: 'Approvals', icon: 'approval', severity: 'warn', at: pending[0]!.created_at, href: '/approvals', cta: 'Review',
    text: pending.length === 1 ? 'Review the action waiting for your OK' : `Review the ${pending.length} actions waiting for your OK`, why: `Nothing happens until you say yes. ${pending[0]!.why}` });

  // Warden's suggestions (incidents, failed deploys, errors, backups, servers to prepare or lock down…)
  out.push(...mergeSame(suggestions(ctx.app, orgId).map((s) => fromSuggestion(db, orgId, s)).filter((c) => !!c)));

  // the server watch: unusual jumps in usage and traffic, open right now
  for (const a of all<{ server_id: string; server_name: string; source: string; key: string; severity: string; title: string; data: string; first_at: string }>(db, `SELECT a.server_id, s.name server_name, a.source, a.key, a.severity, a.title, a.data, a.first_at
      FROM watch_alerts a JOIN servers s ON s.id = a.server_id WHERE a.org_id = ? AND a.cleared_at IS NULL ORDER BY a.first_at DESC LIMIT 10`, orgId)) {
    const fix = json<{ fix?: { tool?: string; input?: Record<string, unknown>; label?: string } }>(a.data, {}).fix;
    add({ id: a.source === 'findings' ? `risk:${a.key}` : `watch:${a.server_id}:${a.key}`, source: 'problem', label: 'Server watch', icon: 'alert', at: a.first_at,
      severity: a.severity === 'critical' ? 'alert' : a.severity === 'low' ? 'info' : 'warn',
      text: `Check ${a.server_name}: ${lc(cleanLabel(a.title, 100))}`, why: `${a.title} on ${a.server_name}, since ${a.first_at.slice(0, 16).replace('T', ' ')} UTC.`,
      ask: askWith(`Something unusual is happening on the server ${cleanLabel(a.server_name)}. Find out why, and fix it if it’s safe.`, 'the server watch', `${a.title} on ${a.server_name}`),
      ...(fix?.tool && { fix: { tool: fix.tool, input: fix.input ?? {}, label: fix.label ?? 'Fix it' } }), ...serverAbout({ id: a.server_id, name: a.server_name }),
      keys: [...serverAbout({ id: a.server_id, name: a.server_name }).keys!, alertKey({ source: a.source, key: a.key, server_id: a.server_id })], snoozeKey: alertKey({ source: a.source, key: a.key, server_id: a.server_id }), explain: explainAlert({ source: a.source, key: a.key, title: a.title, data: json(a.data, {}) }) });
  }

  // each server's risks and waste from its last X-ray (and the security check's sign-in findings)
  for (const s of servers) {
    let risks: ReturnType<typeof serverFindings> = [];
    try { risks = serverFindings(db, orgId, s); } catch { continue; } // an X-ray from an older version: skip it, never fail Home
    for (const f of risks.filter((x) => x.bucket !== 'tip' && RISK_SEV[x.severity] && (x.bucket === 'risk' || x.severity !== 'medium'))) {
      const tool = f.fix && 'tool' in f.fix ? f.fix : undefined;
      add({ id: `risk:${f.id}`, source: f.id.startsWith('xray:no-backup:') ? 'stale' : 'problem', label: f.bucket === 'waste' ? 'Clean-up' : 'Risks', severity: RISK_SEV[f.severity]!,
        ask: askWith(`Fix this risk on the server ${cleanLabel(s.name)}, if it’s safe.`, 'the server’s X-ray', `${f.title}. ${f.detail}`),
        icon: f.id.includes('no-backup') ? 'backup' : f.id.startsWith('server:port:') ? 'lock' : f.id.includes('disk') ? 'disk' : 'shield',
        text: riskText(f, s.name), why: `${f.title}. ${f.detail}`, ...(tool && { fix: { tool: tool.tool, input: tool.input, label: tool.label } }), ...serverAbout(s), keys: [...serverAbout(s).keys!, f.id], snoozeKey: f.id, explain: explainFinding(f) });
    }
  }

  // the latest security check: the serious things it found beyond the servers' own risks
  const report = get<{ findings: string }>(db, `SELECT findings FROM security_reports WHERE org_id = ? AND server_id IS NULL ORDER BY created_at DESC LIMIT 1`, orgId);
  for (const f of json<{ id: string; severity: string; title: string; detail: string; area: string; serverId?: string; fix?: { tool?: string; input?: Record<string, unknown>; label?: string } }[]>(report?.findings, [])
    .filter((x) => x.severity === 'critical' || x.severity === 'high').slice(0, 6)) {
    const s = f.serverId ? servers.find((x) => x.id === f.serverId) : undefined;
    add({ id: `risk:${f.id}`, source: 'problem', label: 'Security check', icon: 'shield', severity: 'alert', text: `Fix: ${cleanLabel(f.title, 100)}`, why: f.detail,
      ask: askWith('Fix this security check finding, if it’s safe.', 'the security check', `${f.title}. ${f.detail}`),
      ...(f.fix?.tool && { fix: { tool: f.fix.tool, input: f.fix.input ?? {}, label: f.fix.label ?? 'Fix it' } }), ...(s && serverAbout(s)), keys: [...(s ? serverAbout(s).keys! : []), f.id], snoozeKey: f.id, explain: explainFinding(f as never) });
  }

  // the outside checks: sites down or slow, certificates and registrations running out, email others can fake
  for (const w of watchIssues(ctx.app, orgId)) {
    const [kind, ...rest] = w.key.split(':'), host = rest.join(':');
    const sev: Severity = w.severity === 'critical' ? 'alert' : w.severity === 'warning' ? 'warn' : 'info';
    const app = assetName(w.about);
    const dom = domainAsset(host);
    const about: About | undefined = w.about && app ? { kind: 'app', id: w.about, name: app.name } : dom ? { kind: 'domain', id: dom, name: host } : undefined;
    // hidden by the outside check's own key ("down:shop.example.com"), the same key the Map's issue has
    const keys = [w.about, dom, w.key].filter((k): k is string => !!k);
    const base = { why: w.text, severity: sev, keys, snoozeKey: w.key, ...(about && { about }) };
    const h = hostLabel(host), seen = (sentence: string) => askWith(sentence, 'the site check', w.text);
    if (kind === 'down') add({ ...base, id: `site:${w.key}`, source: 'problem', label: 'Site checks', icon: 'globe', text: `Get ${h} answering again`, ask: seen(`${h} isn’t answering. Find out why and fix it.`) });
    else if (kind === 'slow') add({ ...base, id: `site:${w.key}`, source: 'problem', label: 'Site checks', icon: 'globe', text: `Find out why ${h} is slow`, ask: seen(`${h} is slow. Find out why and fix it.`) });
    else if (kind === 'tls') add({ ...base, id: `site:${w.key}`, source: 'stale', label: 'Site checks', icon: 'lock', text: `Renew ${h}’s HTTPS certificate`, ask: seen(`${h}’s HTTPS certificate is running out. Find out why it isn’t renewing and fix it.`) });
    else if (kind === 'reg') add({ ...base, id: `site:${w.key}`, source: 'stale', label: 'Domains', icon: 'globe', text: `Renew ${h} before it expires`, ask: seen(`${h} is about to expire. Help me renew it in time.`) });
    else if (kind === 'email') add({ ...base, id: `site:${w.key}`, source: 'suggestion', label: 'Domains', icon: 'mail', severity: sev === 'alert' ? 'warn' : sev, text: `Stop others sending email as ${host}`,
      fix: { tool: 'domain.protect_email', input: { domain: host }, label: 'Protect it', success: `${host} is protected` } });
  }

  // errors on hosted platforms (Vercel, Netlify…), from their logs: the busiest few in the last day
  for (const e of all<{ asset: string; kinds: number; hits: number; last: string }>(db, `SELECT asset, count(*) kinds, sum(count) hits, max(last_seen) last FROM remote_errors
      WHERE org_id = ? AND last_seen > ? GROUP BY asset ORDER BY hits DESC LIMIT 3`, orgId, ago(DAY))) {
    const a = assetName(e.asset);
    const top = get<{ kind: string; message: string; count: number }>(db, 'SELECT kind, message, count FROM remote_errors WHERE org_id = ? AND asset = ? AND last_seen > ? ORDER BY count DESC LIMIT 1', orgId, e.asset, ago(DAY));
    if (!a || !top) continue;
    const said = `${top.kind}: ${top.message.slice(0, 160)}`;
    add({ id: `remote:${e.asset}`, source: 'problem', label: 'Errors', icon: a.provider, severity: e.hits >= 50 ? 'alert' : 'warn', at: e.last, keys: [e.asset],
      text: /^\d{3}$/.test(top.kind) ? `Fix the ${top.kind} errors on ${cleanLabel(a.name)}` : `Fix the ${cleanLabel(top.kind, 40)} on ${cleanLabel(a.name)}`,
      why: `${said} (${top.count} time${top.count === 1 ? '' : 's'} in the last day${e.kinds > 1 ? `, and ${e.kinds - 1} other kind${e.kinds === 2 ? '' : 's'} of error` : ''}).`,
      ask: askWith(`Fix the errors on ${cleanLabel(a.name)}: it happened ${top.count} time${top.count === 1 ? '' : 's'} in the last day. Find the cause and fix it.`, 'the app’s error log', said),
      about: { kind: a.kind === 'database' ? 'database' : 'app', id: e.asset, name: a.name } });
  }

  // subdomains that reach no app: a root with three or more of them is worth tidying
  const loose = all<{ id: string; name: string; zone: string | null }>(db, `SELECT d.id, d.name, json_extract(d.meta, '$.zone') zone FROM assets d WHERE d.org_id = ? AND d.kind = 'domain'
    AND json_extract(d.meta, '$.zone') IS NOT NULL AND d.name != json_extract(d.meta, '$.zone')
    AND NOT EXISTS (SELECT 1 FROM edges e JOIN assets t ON t.id = e.target WHERE e.source = d.id AND t.kind IN ('app', 'server'))`, orgId);
  const byZone = new Map<string, string[]>();
  for (const d of loose) byZone.set(d.zone!, [...(byZone.get(d.zone!) ?? []), d.name]);
  for (const [zone, subs] of byZone) {
    if (subs.length < 3) continue;
    const dom = domainAsset(zone);
    const list = subs.slice(0, 6).join(', ') + (subs.length > 6 ? '…' : '');
    add({ id: `subdomains:${zone}:${subs.length}`, source: 'stale', label: 'Domains', icon: 'globe', severity: 'info', keys: dom ? [dom] : [],
      text: `Tidy up ${subs.length} subdomains of ${zone} that reach nothing`, why: `They don’t point at any app or server: ${list}.`,
      ask: askWith(`${subs.length} subdomains of ${hostLabel(zone)} don’t reach any app. Show them, and help me connect or remove the ones I don’t need.`, 'the map’s domain list', list), ...(dom && { about: { kind: 'domain', id: dom, name: zone } }) });
  }

  // your chats: one that stopped before it finished, and what you keep asking
  if (userId) {
    const chats = all<{ id: string; title: string; updated_at: string; role: string; content: string }>(db, `SELECT c.id, c.title, c.updated_at, m.role, m.content FROM conversations c
      JOIN messages m ON m.id = (SELECT id FROM messages x WHERE x.conversation_id = c.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)
      WHERE c.org_id = ? AND c.user_id = ? AND c.updated_at > ? ORDER BY c.updated_at DESC LIMIT 20`, orgId, userId, ago(7 * DAY));
    const unfinished = new Set<string>();
    for (const c of chats) {
      if (isRunning(c.id)) continue;
      const why = unfinishedWhy(c.role, json<Record<string, any>>(c.content, {}), c.updated_at);
      if (!why) continue;
      unfinished.add(norm(c.title));
      add({ id: `finish:${c.id}`, source: 'history', label: 'Your chats', icon: 'history', severity: 'info', at: c.updated_at, conversationId: c.id,
        text: `Finish: ${c.title}`, why, ask: 'Please pick up where you left off and finish this.' });
    }
    const asked = new Map<string, { text: string; convs: Set<string>; at: string }>();
    for (const m of all<{ content: string; conversation_id: string; created_at: string }>(db, `SELECT m.content, m.conversation_id, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.org_id = ? AND c.user_id = ? AND m.role = 'user' AND m.created_at > ? ORDER BY m.created_at`, orgId, userId, ago(30 * DAY))) {
      const text = String(json<{ text?: string }>(m.content, {}).text ?? '').trim();
      if (text.length < 12 || text.length > 200) continue; // "hy" isn't a task
      const k = norm(text);
      const hit = asked.get(k) ?? { text, convs: new Set<string>(), at: m.created_at };
      hit.text = text; hit.at = m.created_at; hit.convs.add(m.conversation_id);
      asked.set(k, hit);
    }
    for (const [k, a] of asked) {
      if (a.convs.size < 3 || unfinished.has(k)) continue;
      add({ id: `repeat:${k.slice(0, 120)}`, source: 'history', label: 'You ask this often', icon: 'repeat', severity: 'info', at: a.at, text: a.text.replace(/[.!?]+$/, ''), why: `You asked this ${a.convs.size} times this month.` });
    }
  }

  // setup gaps: Coolify running where Unit7 can't manage it, nobody hears about problems at night, no budget
  for (const s of servers) {
    const inv = lastXray(db, orgId, s.id)?.data;
    if (!inv?.coolify || inv.coolify.connected || coolifyAccount(ctx, s.id)) continue;
    const n = (inv.projects ?? []).filter((p) => p.owner === 'coolify' && !p.system).length;
    add({ id: `coolify:${s.id}`, source: 'setup', label: 'Setup', icon: 'coolify', severity: n ? 'warn' : 'info', ...serverAbout(s),
      text: `Connect Coolify on ${s.name} so I can manage its ${n ? `${n} project${n === 1 ? '' : 's'}` : 'apps'}`,
      why: 'Coolify runs there, but Unit7 only sees it from the outside. Connected, it shows real names, domains and deploys, and can change them through Coolify.' });
  }
  const watching = servers.length > 0 || !!get(db, 'SELECT 1 FROM assets WHERE org_id = ? LIMIT 1', orgId);
  if (watching && !alertsVerified(db, orgId)) {
    add({ id: 'alerts', source: 'setup', label: 'Setup', icon: 'bell', severity: 'info', href: '/connections#alerts', cta: 'Set up',
      text: 'Set up phone alerts, so you hear about problems at night', why: 'Free with the ntfy app: scan a code, then tap once to prove your phone gets them. Unit7 tells you the moment something needs you.' });
  }
  if (watching && get<{ b: number | null }>(db, 'SELECT budget_monthly b FROM orgs WHERE id = ?', orgId)?.b == null) {
    add({ id: 'budget', source: 'setup', label: 'Setup', icon: 'wallet', severity: 'info', href: '/autopilot', cta: 'Set it',
      text: 'Set a monthly budget, so I warn you before costs climb', why: 'Unit7 adds up what your servers and accounts cost and tells you before you go over.' });
  }
  return out;
}

// Did a chat stop before it finished? The reason, from its last message, or nothing when it ended with an answer.
export function unfinishedWhy(role: string, c: Record<string, any>, at: string, now = Date.now()): string | undefined {
  if (role === 'status' && (c.tone === 'bad' || c.tone === 'warn') && c.text !== 'Stopped.') return String(c.text ?? 'It stopped before it finished.').replace(/`/g, '');
  if (role === 'tool' && ['error', 'denied', 'running', 'approval_required'].includes(c.status)) return c.status === 'approval_required' ? 'It was waiting for your OK.' : 'A step didn’t finish.';
  if (role === 'ask' && c.state !== 'answered') return 'It was waiting for your answer.';
  if (role === 'user' && now - Date.parse(at) > 5 * 60_000) return 'It never got an answer.';
  return undefined;
}

// What's hidden from Home: "This is fine" or "Hide for now" (snooze.set, or home.dismiss for 7 days), one store for
// every list. Kept as a function of its own for what imports it.
export const dismissedBy = (db: DB, orgId: string, _userId?: string | null): Set<string> => new Set(hiddenNow(db, orgId).keys()); // not once it got worse

export function homeTasks(ctx: Pick<Ctx, 'app' | 'db' | 'orgId' | 'actor'>, limit = 5): Task[] {
  const archived = new Set([...archivedAssets(ctx.db, ctx.orgId), ...archivedServices(ctx.db, ctx.orgId)]);
  const hidden = dismissedBy(ctx.db, ctx.orgId);
  // hidden by its id or its snoozeKey, each as the snooze store keeps it (a count in the id doesn't matter)
  const list = candidates(ctx).map((c) => ({ ...c, keys: [...(c.keys ?? []), snoozeKeyOf(c.id), ...(c.snoozeKey ? [snoozeKeyOf(c.snoozeKey)] : [])] }));
  return rankTasks(list, { dismissed: hidden, archived: new Set([...archived, ...hidden]), limit });
}

defineTool({
  name: 'home.suggest', title: 'Suggested next tasks', risk: 'read', action: 'read',
  description: 'The few things most worth doing next (five by default), each a sentence to act on with why, where it came from and how urgent it is: open problems (unusual server activity, risks, sites down, errors), Warden’s suggestions, what waits for approval (one link to Approvals), things going stale (no backup, a certificate or domain registration running out, subdomains that reach nothing), what the person asked before and didn’t finish or keeps asking, and setup gaps (Coolify not connected, no phone alerts, no budget). A task has a one-click fix tool when one exists, else a page to open or a request to ask. Leaves out what’s archived and what the person dismissed in the last 7 days. Read-only: stored state only, no AI.',
  input: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
  run: (ctx, i) => ({ tasks: homeTasks(ctx, i.limit), at: new Date().toISOString() }),
});

defineTool({
  name: 'home.dismiss', title: 'Hide a suggested task', risk: 'write', action: 'preference', peopleOnly: true, // org-wide, so a write
  description: 'Hide one of Home’s suggested tasks (its id from home.suggest) for 7 days, or bring it back (hide: false). Only a person can: an AI asks with ui.hide.',
  input: z.object({ id: z.string().min(1).max(300), hide: z.boolean().default(true) }),
  // the same store as "This is fine" everywhere else (snooze.set), for 7 days
  run: (ctx, i) => (i.hide ? { id: i.id, hidden: true, until: snooze(ctx.db, ctx.orgId, { key: i.id, for: '7d', kind: 'task', by: ctx.actor.name }).until } : (unsnooze(ctx.db, ctx.orgId, i.id), { id: i.id, hidden: false })),
});
