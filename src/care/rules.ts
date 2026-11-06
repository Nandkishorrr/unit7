// Plain-words rules: "Never touch the shop during work hours" becomes a real rule at the gate, not a note an AI might ignore. It binds AIs
// and Warden. A person can still act: it's their server. Green steps pass, because a copy changes nothing.
import { z } from 'zod';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { defineTool, gateRules } from '../tools/runtime.ts';
import { requireHuman } from '../tools/helpers.ts';
import { Unit7Error } from '../errors.ts';
import { lastXray } from '../tools/xray.ts';

export type When = { kind: 'always' } | { kind: 'work' } | { kind: 'weekends' } | { kind: 'night' } | { kind: 'hours'; from: string; to: string };
export interface ParsedRule { name: string; when: When }

const pad = (h: string) => { const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(h.trim()); if (!m) return undefined; let n = Number(m[1]); if (m[3]?.toLowerCase() === 'pm' && n < 12) n += 12; if (m[3]?.toLowerCase() === 'am' && n === 12) n = 0; return n <= 23 ? `${String(n).padStart(2, '0')}:${m[2] ?? '00'}` : undefined; };
// (pure) a sentence into a rule, or undefined when it can't be sure what was meant
export function parseRule(text: string): ParsedRule | undefined {
  const t = text.trim().replace(/[.!]+$/, '').replace(/[’]/g, "'");
  const m = /^(?:never|do not|don't)\s+(?:touch|change|restart|deploy(?:\s+to)?|update|modify)\s+(.+?)$/i.exec(t) ?? /^leave\s+(.+?)\s+alone(.*)$/i.exec(t);
  if (!m) return undefined;
  let rest = `${m[1]!}${m[2] ?? ''}`.trim(), when: When = { kind: 'always' };
  const at = (re: RegExp, w: (x: RegExpExecArray) => When | undefined) => { const x = re.exec(rest); if (!x) return; const v = w(x); if (v) { when = v; rest = rest.slice(0, x.index).trim(); } };
  at(/\b(?:during|in)\s+(?:work|working|business|office)\s+hours$/i, () => ({ kind: 'work' }));
  at(/\b(?:on|at|during)\s+(?:the\s+)?weekends?$/i, () => ({ kind: 'weekends' }));
  at(/\b(?:at|during the)\s+night$/i, () => ({ kind: 'night' }));
  at(/\bbetween\s+(\S+(?:\s*[ap]m)?)\s+and\s+(\S+(?:\s*[ap]m)?)$/i, (x) => { const from = pad(x[1]!), to = pad(x[2]!); return from && to ? { kind: 'hours', from, to } : undefined; });
  const name = rest.replace(/^(the|my)\s+/i, '').trim();
  return name.length >= 2 && !/\s(?:during|between|on|at)\s/i.test(` ${name} `) ? { name, when } : undefined;
}
const local = (nowMs: number, tz?: string) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(nowMs); const v = (t: string) => p.find((x) => x.type === t)?.value ?? ''; return { day: v('weekday'), at: `${v('hour')}:${v('minute')}` }; };
export function inForce(w: When, nowMs: number, tz?: string) {
  const { day, at } = local(nowMs, tz), weekend = day === 'Sat' || day === 'Sun';
  if (w.kind === 'always') return true;
  if (w.kind === 'weekends') return weekend;
  if (w.kind === 'work') return !weekend && at >= '09:00' && at < '18:00';
  if (w.kind === 'night') return at >= '22:00' || at < '06:00';
  return w.from <= w.to ? at >= w.from && at < w.to : at >= w.from || at < w.to;
}
const whenWords = (w: When) => ({ always: '', work: ' during work hours', weekends: ' on weekends', night: ' at night', hours: w.kind === 'hours' ? ` between ${w.from} and ${w.to}` : '' })[w.kind];

// every name a tool's input could mean: the thing, its project, its environment, its server
export function namesOf(db: DB, orgId: string, input: Record<string, unknown>) {
  const names: string[] = [];
  const add = (v: unknown) => { if (typeof v === 'string' && v) names.push(v.toLowerCase()); };
  const by = <T>(sql: string, v: unknown) => (typeof v === 'string' ? get<T>(db, sql, v) : undefined);
  // an undo points at a change, a rollback at a deployment, a domain at its app: each leads back to the thing itself
  const change = by<{ server_id: string | null; part: string | null }>('SELECT server_id, part FROM changes WHERE id = ?', input.changeId);
  const serviceId = input.serviceId ?? by<{ service_id: string }>('SELECT service_id FROM deployments WHERE id = ?', input.deploymentId)?.service_id ?? by<{ service_id: string }>('SELECT service_id FROM domains WHERE id = ?', input.domainId)?.service_id;
  const svc = by<{ name: string; project: string; env: string | null; kind: string | null }>('SELECT s.name, p.name project, e.name env, e.kind FROM services s JOIN projects p ON p.id = s.project_id LEFT JOIN environments e ON e.id = s.environment_id WHERE s.id = ?', serviceId);
  add(svc?.name); add(svc?.project); add(svc?.env); add(svc?.kind);
  add(by<{ name: string }>('SELECT name FROM projects WHERE id = ?', input.projectId)?.name);
  const env = by<{ name: string; kind: string }>('SELECT name, kind FROM environments WHERE id = ?', input.environmentId); add(env?.name); add(env?.kind);
  const serverId = input.serverId ?? change?.server_id;
  if (typeof serverId === 'string') {
    add(get<{ name: string }>(db, 'SELECT name FROM servers WHERE id = ? AND org_id = ?', serverId, orgId)?.name);
    const inv = lastXray(db, orgId, serverId)?.data, ref = input.part ?? input.uuid ?? input.container ?? change?.part;
    const p = typeof ref === 'string' ? inv?.parts.find((x) => x.id === ref || x.name === ref || x.coolify?.uuid === ref || x.containers?.includes(ref) || x.internals?.some((c) => c.name === ref)) : undefined;
    add(p?.name); add(p?.coolify?.environment); add(inv?.projects.find((x) => x.id === p?.project)?.name);
  }
  add(input.part); add(input.container); add(input.name); add(input.hostname);
  return names;
}
const hits = (rule: string, names: string[]) => { const r = rule.toLowerCase(); return names.some((n) => n === r || n.includes(r) || r.includes(n) && n.length >= 3); };
// everything a rule could name here. One that matches nothing would look like protection and stop nothing.
export function knownNames(db: DB, orgId: string) {
  const names = ['servers', 'projects', 'services', 'environments'].flatMap((t) => all<{ name: string }>(db, `SELECT name FROM ${t} WHERE org_id = ?`, orgId).map((r) => r.name));
  names.push(...all<{ kind: string }>(db, 'SELECT DISTINCT kind FROM environments WHERE org_id = ?', orgId).map((r) => r.kind));
  for (const s of all<{ id: string }>(db, 'SELECT id FROM servers WHERE org_id = ?', orgId)) {
    const inv = lastXray(db, orgId, s.id)?.data;
    names.push(...(inv?.projects ?? []).flatMap((p) => [p.name, ...p.domains]), ...(inv?.parts ?? []).flatMap((p) => [p.name, ...(p.containers ?? []), ...(p.coolify?.environment ? [p.coolify.environment] : [])]));
  }
  return names.map((n) => n.toLowerCase());
}
// What the gate asks: does a rule stop this right now? It reads the person's own time zone, kept with the rule.
export function ruleStops(db: DB, orgId: string, input: Record<string, unknown>, nowMs = Date.now()): string | undefined {
  const rules = all<{ text: string; name: string; when_json: string; tz: string | null }>(db, 'SELECT text, name, when_json, tz FROM plain_rules WHERE org_id = ?', orgId);
  if (!rules.length) return undefined;
  const names = namesOf(db, orgId, input);
  for (const r of rules) if (hits(r.name, names) && inForce(json<When>(r.when_json, { kind: 'always' }), nowMs, r.tz ?? undefined)) return `Your rule says so: “${r.text}”.`;
  return undefined;
}

gateRules.push(ruleStops);

defineTool({
  name: 'rule.add', title: 'Add a rule in plain words', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'People only. A rule in plain words that binds every AI and Warden at the gate, like “Never touch the shop during work hours”, “Leave billing alone on weekends” or “Don’t restart Tracker between 22:00 and 06:00”. Copies still run, because they change nothing.',
  input: z.object({ text: z.string().min(5).max(200), tz: z.string().max(64).optional() }),
  run(ctx, i) {
    requireHuman(ctx, 'add a rule');
    const p = parseRule(i.text);
    if (!p) throw new Unit7Error('unclear_rule', 'I couldn’t turn that into a rule. Try “Never touch the shop during work hours”.', 400);
    if (!hits(p.name, knownNames(ctx.db, ctx.orgId))) throw new Unit7Error('unknown_name', `Unit7 doesn’t know anything called “${p.name}”, so this rule wouldn’t stop anything. Use the name of a project, app, server or environment.`, 400);
    const ruleId = id('rul');
    run(ctx.db, 'INSERT INTO plain_rules (id, org_id, text, name, when_json, tz, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ruleId, ctx.orgId, i.text.trim(), p.name, JSON.stringify(p.when), i.tz ?? null, ctx.actor.name, now());
    return { id: ruleId, means: `No AI and no automatic step changes ${p.name}${whenWords(p.when)}. You still can.` };
  },
});
defineTool({ name: 'rule.list', title: 'Your rules', risk: 'read', action: 'read', description: 'The plain-words rules every AI and Warden must follow.', input: z.object({}), run: (ctx) => ({ rules: all(ctx.db, 'SELECT id, text, by, at FROM plain_rules WHERE org_id = ? ORDER BY at DESC', ctx.orgId) }) });
defineTool({ name: 'rule.remove', title: 'Remove a rule', risk: 'write', action: 'policy_change', peopleOnly: true, description: 'People only. Remove a plain-words rule.', input: z.object({ id: z.string().max(40) }), run(ctx, i) { requireHuman(ctx, 'remove a rule'); return { removed: run(ctx.db, 'DELETE FROM plain_rules WHERE id = ? AND org_id = ?', i.id, ctx.orgId).changes > 0 }; } });
