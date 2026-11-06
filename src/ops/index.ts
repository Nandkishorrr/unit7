// For people who run things with scripts: a config file with no secrets in it, metrics and events going out, an audit log you can take
// away and check, delayed deletes, and a tool finder for small MCP profiles.
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { App } from '../app.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { defineTool, execute, openInput, setHoldHook, tools as allTools, type Actor } from '../tools/runtime.ts';
import { requireHuman } from '../tools/helpers.ts';
import { Unit7Error, notFound } from '../errors.ts';
import { assertReachable } from '../netguard.ts';
import { lastCheckup } from '../care/checkup.ts';
import { protectionOf, settingsOf } from '../care/safetynet.ts';
import { blindMs, gapsIn } from '../sentinel/gaps.ts';
import { fromYaml, toYaml } from './yaml.ts';
import { makeRef } from '../vault.ts';
import { scopes } from '../auth.ts';
import { ROUTINE_AGENT } from '../tools/routines.ts';

// --- X7: unit7.yaml. What's yours to keep in a repo. It never holds a secret: settings appear by name. ----------------------------
export interface Config { version: 1; rules: { text: string; tz?: string }[]; important: { key: string; important: boolean }[]; safety: { busy?: { from: string; to: string; tz?: string } | null; checkup?: string }; projects: { name: string; environments: { name: string; kind: string; autonomy: number }[]; services: { name: string; kind: string; domains: string[]; settings: string[] }[] }[] }
export function exportConfig(db: DB, orgId: string): Config {
  const s = settingsOf(db, orgId), projects = all<{ id: string; name: string }>(db, 'SELECT id, name FROM projects WHERE org_id = ? ORDER BY name', orgId).map((p) => ({ name: p.name,
    environments: all<{ name: string; kind: string; autonomy: number }>(db, 'SELECT name, kind, autonomy FROM environments WHERE project_id = ? ORDER BY name', p.id),
    services: all<{ id: string; name: string; kind: string }>(db, 'SELECT id, name, kind FROM services WHERE project_id = ? ORDER BY name', p.id).map((v) => ({ name: v.name, kind: v.kind, domains: all<{ hostname: string }>(db, 'SELECT hostname FROM domains WHERE service_id = ? ORDER BY hostname', v.id).map((d) => d.hostname), settings: all<{ key: string }>(db, 'SELECT DISTINCT key FROM env_vars WHERE scope_id = ? AND deleted_at IS NULL ORDER BY key', v.id).map((k) => k.key) })) }));
  return { version: 1, rules: all<{ text: string; tz: string | null }>(db, 'SELECT text, tz FROM plain_rules WHERE org_id = ? ORDER BY at', orgId).map((r) => ({ text: r.text, ...(r.tz && { tz: r.tz }) })), important: all<{ key: string; important: number }>(db, 'SELECT key, important FROM safety_marks WHERE org_id = ? ORDER BY key', orgId).map((m) => ({ key: m.key, important: !!m.important })), safety: { ...(s.busy !== undefined && { busy: s.busy }), ...(s.checkup && { checkup: s.checkup }) }, projects };
}
export interface Drift { kind: 'add' | 'remove' | 'change' | 'note'; what: string; apply?: { tool: string; input: Record<string, unknown> } }
// (pure) what the file wants against what is. Only what Unit7 owns is applied. Projects are compared and reported: they stay deliberate.
export function planConfig(want: Partial<Config>, is: Config): Drift[] {
  const out: Drift[] = [], rules = new Set(is.rules.map((r) => r.text)), wanted = new Set((want.rules ?? []).map((r) => r.text));
  for (const r of want.rules ?? []) if (!rules.has(r.text)) out.push({ kind: 'add', what: `Rule: ${r.text}`, apply: { tool: 'rule.add', input: { text: r.text, ...(r.tz && { tz: r.tz }) } } });
  for (const r of is.rules) if (want.rules && !wanted.has(r.text)) out.push({ kind: 'remove', what: `Rule: ${r.text}` });
  for (const m of want.important ?? []) { const c = is.important.find((x) => x.key === m.key); if (c?.important !== m.important) out.push({ kind: 'change', what: `${m.key} counts as ${m.important ? 'important' : 'not important'}`, apply: { tool: 'safety.mark', input: m } }); }
  if (want.safety?.checkup && want.safety.checkup !== is.safety.checkup) out.push({ kind: 'change', what: `Check-ups by themselves: ${want.safety.checkup}`, apply: { tool: 'safety.settings', input: { checkup: want.safety.checkup } } });
  if (want.safety?.busy !== undefined && JSON.stringify(want.safety.busy) !== JSON.stringify(is.safety.busy ?? null)) out.push({ kind: 'change', what: `Busy hours: ${want.safety.busy ? `${want.safety.busy.from} to ${want.safety.busy.to}` : 'none'}`, apply: { tool: 'safety.settings', input: { busy: want.safety.busy } } });
  const have = new Map(is.projects.map((p) => [p.name, p]));
  for (const p of want.projects ?? []) { const c = have.get(p.name); if (!c) { out.push({ kind: 'note', what: `Project ${p.name} is in the file but not in Unit7` }); continue; } for (const v of p.services) { const x = c.services.find((y) => y.name === v.name); if (!x) out.push({ kind: 'note', what: `${p.name}/${v.name} is in the file but not in Unit7` }); else for (const k of v.settings) if (!x.settings.includes(k)) out.push({ kind: 'note', what: `${p.name}/${v.name} is missing the setting ${k}` }); } }
  for (const p of is.projects) if (want.projects && !want.projects.some((q) => q.name === p.name)) out.push({ kind: 'note', what: `Project ${p.name} isn’t in the file` });
  return out;
}
const SECRETISH = /(?:password|secret|token|private[_-]?key)\s*:\s*\S/i;
const parseConfig = (text: string) => { if (SECRETISH.test(text.replace(/^\s*settings:[\s\S]*?(?=^\S|\Z)/gm, ''))) throw new Unit7Error('secret_in_config', 'That file looks like it holds a secret. unit7.yaml never does: settings go in by name only.', 400); return fromYaml(text) as Partial<Config>; };
defineTool({ name: 'config.export', title: 'Export unit7.yaml', risk: 'read', action: 'read', description: 'What Unit7 holds that’s yours to keep in a repo, as YAML: rules, what counts as important, Safety Net settings, and projects with their settings by name. It never holds a secret.', input: z.object({}), run: (ctx) => ({ yaml: toYaml(exportConfig(ctx.db, ctx.orgId)) }) });
defineTool({ name: 'config.plan', title: 'What would unit7.yaml change?', risk: 'read', action: 'read', description: 'Compare a unit7.yaml with what Unit7 holds: what apply would change, and any drift.', input: z.object({ yaml: z.string().max(500_000) }), run: (ctx, i) => ({ changes: planConfig(parseConfig(i.yaml), exportConfig(ctx.db, ctx.orgId)) }) });
defineTool({
  name: 'config.apply', title: 'Apply unit7.yaml', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'People only. Apply what config.plan listed. Only what Unit7 owns: rules, marks and Safety Net settings. Projects and apps are compared, never created from the file, and nothing is removed.',
  input: z.object({ yaml: z.string().max(500_000) }),
  async run(ctx, i) {
    requireHuman(ctx, 'apply unit7.yaml');
    const done: string[] = [];
    for (const c of planConfig(parseConfig(i.yaml), exportConfig(ctx.db, ctx.orgId))) { if (!c.apply) continue; const r = await execute(ctx.app, ctx.orgId, ctx.actor, c.apply.tool, c.apply.input, { reason: 'unit7.yaml' }); if (r.status !== 'ok') throw new Unit7Error('apply_failed', `Stopped at “${c.what}”.`, 409); done.push(c.what); }
    return { done };
  },
});

// --- X8: metrics and events going out ------------------------------------------------------------------------------------------
export function metricsText(db: DB, orgId: string, nowMs = Date.now()) {
  const l: string[] = [], m = (name: string, help: string, type: string, rows: [string, number][]) => { if (!rows.length) return; l.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); for (const [lab, v] of rows) l.push(`${name}${lab} ${v}`); };
  const lab = (o: Record<string, string>) => `{${Object.entries(o).map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '')}"`).join(',')}}`;
  const servers = all<{ id: string; name: string }>(db, 'SELECT id, name FROM servers WHERE org_id = ?', orgId), last = servers.flatMap((s) => { const r = get<{ cpu: number | null; mem_used: number | null; mem_total: number | null; disk_used: number | null; disk_total: number | null }>(db, 'SELECT cpu, mem_used, mem_total, disk_used, disk_total FROM metrics WHERE server_id = ? ORDER BY at DESC LIMIT 1', s.id); return r ? [{ s, r }] : []; });
  m('unit7_server_cpu_percent', 'CPU in use', 'gauge', last.map(({ s, r }) => [lab({ server: s.name }), r.cpu ?? 0]));
  m('unit7_server_memory_used_bytes', 'Memory in use', 'gauge', last.map(({ s, r }) => [lab({ server: s.name }), r.mem_used ?? 0]));
  m('unit7_server_memory_total_bytes', 'Memory on the server', 'gauge', last.map(({ s, r }) => [lab({ server: s.name }), r.mem_total ?? 0]));
  m('unit7_server_disk_used_bytes', 'Disk in use', 'gauge', last.map(({ s, r }) => [lab({ server: s.name }), r.disk_used ?? 0]));
  m('unit7_server_disk_total_bytes', 'Disk on the server', 'gauge', last.map(({ s, r }) => [lab({ server: s.name }), r.disk_total ?? 0]));
  m('unit7_site_up', '1 if the site answers', 'gauge', all<{ host: string; status: string }>(db, `SELECT host, status FROM watch WHERE org_id = ? AND kind = 'site'`, orgId).map((w) => [lab({ host: w.host }), ['ok', 'up'].includes(w.status) ? 1 : 0]));
  const prot = protectionOf(db, orgId, nowMs).filter((g) => g.important);
  m('unit7_protection_databases', 'Important databases by level', 'gauge', ['unprotected', 'weak', 'protected', 'proven'].map((level) => [lab({ level }), prot.filter((g) => g.level === level).length] as [string, number]));
  const c = lastCheckup(db, orgId);
  if (c?.items) m('unit7_checkup_open_items', 'Items on the last Check-up', 'gauge', ['critical', 'high', 'medium', 'low'].map((severity) => [lab({ severity }), c.items.filter((i) => i.severity === severity).length] as [string, number]));
  m('unit7_blind_seconds_7d', 'Seconds Unit7 wasn’t watching in the last week', 'gauge', [['', Math.round(blindMs(gapsIn(db, nowMs - 7 * 86400_000, nowMs)) / 1000)]]);
  return `${l.join('\n')}\n`;
}
const HOOK = makeRef('webhook', 'events', 'url'), HOOK_KEY = makeRef('webhook', 'events', 'signing');
const hookOf = (app: App, orgId: string) => { try { return { url: app.vault.resolve(orgId, HOOK), key: app.vault.resolve(orgId, HOOK_KEY) }; } catch { return undefined; } };
export const signBody = (key: string, body: string) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
defineTool({
  name: 'events.webhook', title: 'Send events to a webhook', risk: 'write', action: 'settings_write', peopleOnly: true, timeoutMs: 15_000,
  description: 'People only. Post Unit7’s events (warnings and above) as JSON to your own address, signed with X-Unit7-Signature. Empty removes it.',
  input: z.object({ url: z.string().url().max(300).or(z.literal('')) }),
  async run(ctx, i) {
    requireHuman(ctx, 'set a webhook');
    if (!i.url) { ctx.app.vault.retire(ctx.orgId, HOOK); return { on: false }; }
    const u = new URL(i.url); if (u.protocol !== 'https:') throw new Unit7Error('bad_url', 'Use an https:// address.', 400);
    await assertReachable(u.hostname);
    const key = randomBytes(24).toString('base64url');
    ctx.app.vault.put(ctx.orgId, HOOK, i.url, { kind: 'webhook', by: ctx.actor.name }); ctx.app.vault.put(ctx.orgId, HOOK_KEY, key, { kind: 'webhook', by: ctx.actor.name });
    return { on: true, signingKey: key, note: 'Keep this key. It’s shown once. Check X-Unit7-Signature with it.' };
  },
});
export async function postEvent(app: App, e: { org_id: string; type: string; severity: string; message: string; created_at: string; resource?: string | null }, send: typeof fetch = fetch) {
  if (!['warning', 'critical'].includes(e.severity)) return false;
  const h = hookOf(app, e.org_id);
  if (!h) return false;
  const body = JSON.stringify({ type: e.type, severity: e.severity, message: e.message, at: e.created_at, resource: e.resource ?? null });
  await send(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-unit7-signature': signBody(h.key, body) }, body, signal: AbortSignal.timeout(8000) }).catch(() => undefined);
  return true;
}

// --- X9: an audit log you can take away ------------------------------------------------------------------------------------------
export { chainOf, verifyLines } from './chain.ts';
import { verifyLines } from './chain.ts';
export function exportAudit(db: DB, orgId: string, since?: string) {
  const rows = all<{ id: string; actor_name: string; tool: string; input: string | null; result: string; chain: string; prev_chain: string; created_at: string; risk: string; reason: string | null }>(db, `SELECT id, actor_name, tool, input, result, chain, prev_chain, created_at, risk, reason FROM audit WHERE org_id = ? AND chain IS NOT NULL AND (? IS NULL OR created_at >= ?) ORDER BY rowid`, orgId, since ?? null, since ?? null);
  return rows.map((r) => JSON.stringify({ id: r.id, at: r.created_at, actor: r.actor_name, tool: r.tool, risk: r.risk, input: r.input, result: r.result, reason: r.reason, prev: r.prev_chain, chain: r.chain }));
}
defineTool({ name: 'audit.export', title: 'Take the audit log away', risk: 'read', action: 'read', description: 'Every change, command runs included, as JSON lines, each linked to the one before it by a hash, so a line changed later shows up. Reads aren’t in the chain.', input: z.object({ since: z.string().max(40).optional() }), run(ctx, i) { const lines = exportAudit(ctx.db, ctx.orgId, i.since); return { jsonl: lines.join('\n'), lines: lines.length, ...verifyLines(lines) }; } });
defineTool({ name: 'audit.commands', title: 'Show exact commands', risk: 'read', action: 'read', description: 'The commands one action ran on a server, secrets hidden.', input: z.object({ auditId: z.string().max(40) }), run(ctx, i) { const r = get<{ commands: string | null; tool: string }>(ctx.db, 'SELECT commands, tool FROM audit WHERE id = ? AND org_id = ?', i.auditId, ctx.orgId); if (!r) throw notFound('That action'); return { tool: r.tool, commands: json<string[]>(r.commands, []) }; } });

// --- X5: delete is its own permission. An AI's delete waits 48 hours, even after a yes -----------------------------------------------
export const HELD_HOURS = 48, HELD_TOOLS = new Set(['coolify.remove', 'service.remove', 'project.delete', 'environment.delete', 'asset.delete', 'addon.remove', 'staging.remove', 'server.remove']);
export function holdDelete(app: App, orgId: string, a: { id: string; tool: string; actor: Actor; by: string }, nowMs = Date.now()) {
  const until = new Date(nowMs + HELD_HOURS * 3600_000).toISOString();
  run(app.db, `INSERT INTO held_deletes (id, org_id, approval_id, tool, actor, by, run_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)`, id('hld'), orgId, a.id, a.tool, JSON.stringify(a.actor), a.by, until, now());
  app.events.emit(orgId, 'delete.held', `An AI’s delete (${a.tool}) waits 48 hours. You can cancel it until then.`, { severity: 'warning', resource: a.id });
  return until;
}
// a routine is a person's own saved step, not an AI deciding, so it runs when they say yes
// tools that do many things hold only their delete
export const HELD_OPS: Record<string, string> = { 'supabase.functions': 'delete', 'supabase.storage': 'delete', 'neon.branch': 'delete' };
const held = (app: App, orgId: string, a: { id: string; tool: string }) => HELD_TOOLS.has(a.tool) || (!!HELD_OPS[a.tool] && openInput(app, orgId, a.id, get<{ input: string }>(app.db, 'SELECT input FROM approvals WHERE id = ?', a.id)?.input ?? '{}').op === HELD_OPS[a.tool]);
setHoldHook((app, orgId, a) => (held(app, orgId, a) && a.actor.agent !== ROUTINE_AGENT ? holdDelete(app, orgId, a) : undefined));
export async function runHeld(app: App, nowMs = Date.now()) {
  const done: string[] = [];
  for (const h of all<{ id: string; org_id: string; approval_id: string; tool: string; actor: string; by: string }>(app.db, `SELECT id, org_id, approval_id, tool, actor, by FROM held_deletes WHERE status = 'held' AND run_at <= ?`, new Date(nowMs).toISOString())) {
    const a = get<{ input: string }>(app.db, 'SELECT input FROM approvals WHERE id = ?', h.approval_id), who = JSON.parse(h.actor) as Actor;
    run(app.db, `UPDATE held_deletes SET status = 'done' WHERE id = ?`, h.id);
    if (a) { await execute(app, h.org_id, { ...who, name: `${who.name} (approved by ${h.by}, after 48 hours)` }, h.tool, openInput(app, h.org_id, h.approval_id, a.input), { approvalId: h.approval_id }).catch(() => undefined); done.push(h.id); }
  }
  return done;
}
defineTool({ name: 'delete.held', title: 'Deletes waiting', risk: 'read', action: 'read', description: 'Deletes an AI asked for and a person approved. Each waits 48 hours, and a person can cancel it until then.', input: z.object({}), run: (ctx) => ({ held: all(ctx.db, `SELECT id, tool, by, run_at runAt, created_at at FROM held_deletes WHERE org_id = ? AND status = 'held' ORDER BY run_at`, ctx.orgId) }) });
defineTool({ name: 'delete.cancel', title: 'Cancel a waiting delete', risk: 'write', action: 'policy_change', peopleOnly: true, description: 'People only. Stop a held delete. Nothing is removed.', input: z.object({ id: z.string().max(40) }), run(ctx, i) { requireHuman(ctx, 'cancel a delete'); return { cancelled: run(ctx.db, `UPDATE held_deletes SET status = 'cancelled' WHERE id = ? AND org_id = ? AND status = 'held'`, i.id, ctx.orgId).changes > 0 }; } });

// --- X6: small profiles for MCP clients, and a way to find the rest ------------------------------------------------------------------
const READ = ['graph.get', 'server.list', 'server.metrics', 'server.usage', 'server.xray', 'server.findings', 'server.traffic', 'checkup.run', 'checkup.get', 'findings.list', 'finding.get', 'finding.check', 'finding.prompt', 'inspect.list', 'logs.digest', 'cron.map', 'safety.status', 'expiry.list', 'always.status', 'story.timeline', 'story.replay', 'security.reports', 'project.passport', 'project.readiness', 'events.recent', 'audit.search', 'dns.list', 'tools.find'];
export const PROFILES: Record<string, string[]> = {
  read: READ,
  deploy: [...READ.slice(0, 10), 'project.list', 'service.get', 'live.options', 'live.put', 'live.logs', 'live.env', 'github.create_repo', 'github.push', 'deployment.create', 'deployment.logs', 'deployment.rollback', 'env.list', 'env.set', 'domain.point', 'domain.check', 'coolify.control', 'coolify.deployments', 'coolify.logs', 'coolify.envs', 'safety.copy', 'safety.rehearse', 'service.restart', 'staging.plan', 'staging.create', 'tools.find'],
  ops: [...READ.slice(0, 13), 'docker.prune', 'server.tidy_logs', 'part.restart', 'part.logs', 'part.limits', 'part.impact', 'part.tables', 'part.query', 'file.list', 'file.read', 'server.close_port', 'change.list', 'change.undo', 'alert.recheck', 'backup.create', 'safety.protect', 'safety.copy', 'coolify.memory_cap', 'tools.find'],
};
Object.assign(scopes, PROFILES);
export function findTools(query: string, limit = 8) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return allTools().map((t) => ({ t, score: words.reduce((n, w) => n + (t.name.includes(w) ? 3 : 0) + (t.title.toLowerCase().includes(w) ? 2 : 0) + (t.description.toLowerCase().includes(w) ? 1 : 0), 0) })).filter((x) => x.score).sort((a, b) => b.score - a.score).slice(0, limit).map(({ t }) => ({ name: t.name, title: t.title, what: t.description.slice(0, 160) }));
}
defineTool({ name: 'tools.find', title: 'Find a tool', risk: 'read', action: 'read', description: 'Search all of Unit7’s tools by what you want to do. A small profile only lists some: this shows the rest, and which a fuller key would need.', input: z.object({ query: z.string().min(2).max(200) }), run: (_ctx, i) => { const t = findTools(i.query); return { tools: t, ...(!t.length && { none: 'No tool does this. Say so plainly, say why, and offer the closest way that works.' }) }; } });
