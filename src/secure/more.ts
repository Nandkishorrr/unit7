// The rest of "is anything wrong right now": default secrets (the value never leaves the server), the rotate-this list when a provider
// is breached, whether a bill has a real brake, and how long you'd really need to come back from nothing.
import { z } from 'zod';
import { all, get, id, json, now, run } from '../db.ts';
import { defineTool, execute, type Ctx } from '../tools/runtime.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { fid } from '../tools/helpers.ts';
import { notFound, Unit7Error } from '../errors.ts';
import { serverRow } from '../tools/servers.ts';
import { lastXray } from '../tools/xray.ts';
import { removeCopy } from '../tools/partbackup.ts';
import { appsOf } from '../care/partchecks.ts';
import { isPublicKey } from '../tools/env.ts';
import type { Finding } from '../tools/security.ts';

const asRoot = (s: ServerRow) => (json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '');
// S8. Compared on the server, so the value never travels: only the setting's name comes back
export const DEFAULTS = ['POSTGRES_PASSWORD=your-super-secret-and-long-postgres-password', 'JWT_SECRET=your-super-secret-jwt-token-with-at-least-32-characters-long', 'DASHBOARD_PASSWORD=this_password_is_insecure_and_should_be_updated', 'SECRET_KEY_BASE=UpNVntn3cDxHJpq99YMc1T1AQgQpc8kfYTuRgBiYa15BLrx8etQoXz3gZv1/u2oq', 'VAULT_ENC_KEY=your-encryption-key-32-chars-min', 'MINIO_ROOT_PASSWORD=minioadmin', 'GF_SECURITY_ADMIN_PASSWORD=admin'];
export const WEAK_RE = "^[A-Z0-9_]*(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*=(secret|password|passw0rd|changeme|change_me|admin|root|test|test123|123456|12345678|supersecret|supersecretkey|mysecret|mysecretkey|your[-_]?(secret|password|token|api)[-_a-z]*|example|default)$";
export const WEAK = `f=$(mktemp); trap 'rm -f "$f"' EXIT; cat > "$f"
for c in "$@"; do docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null | { grep -xFf "$f"; docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null | grep -iE '${WEAK_RE.replace(/'/g, '')}'; } | cut -d= -f1 | sort -u | sed "s|^|$c |"; done`;
export const weakFindings = (s: Pick<ServerRow, 'id'>, out: string): Finding[] => {
  const by = new Map<string, string[]>();
  for (const l of out.split('\n')) { const [c, k] = l.trim().split(' '); if (c && k && !isPublicKey(k)) by.set(c, [...(by.get(c) ?? []), k]); }
  return [...by].map(([c, keys]) => ({ id: `secret:weak:${s.id}:${c}`, severity: 'high', area: 'app', by: 'unit7', serverId: s.id, title: `${c} still uses an example or easy password`, detail: 'These are in public docs, or in every list an attacker tries first. Unit7 compared them on the server, so the values never left it.', evidence: [...new Set(keys)].join(', '), fix: { label: 'Ask Unit7 to help', ask: `${c} uses default or weak values for ${[...new Set(keys)].join(', ')}. Help me change them safely, one at a time.`, manual: ['Change each one, then restart the app.'] } }));
};
defineTool({
  name: 'security.defaults', title: 'Weak and default secrets', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Compare each running app’s settings, on the server, with published defaults (Supabase’s example passwords, minioadmin) and easy ones (supersecretkey, changeme). Only setting names come back: values never leave the server.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), cs = appsOf(lastXray(ctx.db, ctx.orgId, s.id)?.data).flatMap((p) => p.containers ?? []).slice(0, 60);
    const r = cs.length ? await ssh(ctx.app).exec(s, asRoot(s) + script(WEAK, ...cs), { stdin: `${DEFAULTS.join('\n')}\n`, timeoutMs: 50_000 }) : { stdout: '' };
    return { checked: cs.length, findings: weakFindings(s, r.stdout) };
  },
});

// S10. A provider was breached. What do I change, in what order?
const PROVIDERS: Record<string, RegExp> = { vercel: /VERCEL/, supabase: /SUPABASE|PGRST|POSTGRES|DATABASE_URL/, stripe: /STRIPE/, openai: /OPENAI/, anthropic: /ANTHROPIC|CLAUDE/, github: /GITHUB|^GH_/, aws: /^AWS_|S3_/, cloudflare: /CLOUDFLARE|^CF_/, resend: /RESEND/, sendgrid: /SENDGRID/, twilio: /TWILIO/, firebase: /FIREBASE/, google: /GOOGLE|GEMINI/, clerk: /CLERK/, auth0: /AUTH0/, sentry: /SENTRY/, hostinger: /HOSTINGER/, coolify: /COOLIFY/ };
const DANGER = /SECRET|SERVICE|PRIVATE|PASSWORD|TOKEN|KEY/;
export interface Tick { app: string; key: string; done: boolean }
export function rotateList(provider: string, apps: { name: string; keys: string[] }[]): Tick[] {
  const re = PROVIDERS[provider.toLowerCase()] ?? new RegExp(provider.toUpperCase().replace(/\W/g, '_'));
  const list = apps.flatMap((a) => a.keys.filter((k) => re.test(k.toUpperCase())).map((key) => ({ app: a.name, key, done: false })));
  const rank = (k: string) => (isPublicKey(k) ? 2 : DANGER.test(k) ? 0 : 1);
  return list.sort((a, b) => rank(a.key) - rank(b.key));
}
defineTool({
  name: 'security.breach', title: 'A company got hacked. What do I change?', risk: 'write', action: 'backup', green: true, timeoutMs: 2 * 3600_000,
  description: 'When a provider is breached: takes a fresh copy of what’s important, then lists every setting of yours from that provider, most dangerous first, to tick off as you change them. Unit7 lists them: changing them is yours.',
  input: z.object({ provider: z.string().min(2).max(40) }),
  async run(ctx, i) {
    const apps = all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ?`, ctx.orgId).flatMap((s) => appsOf(lastXray(ctx.db, ctx.orgId, s.id)?.data).map((p) => ({ name: p.name, keys: p.envKeys ?? [] })));
    const unit7 = all<{ key: string }>(ctx.db, 'SELECT DISTINCT key FROM env_vars WHERE org_id = ? AND deleted_at IS NULL', ctx.orgId).map((k) => k.key), items = rotateList(i.provider, [...apps, ...(unit7.length ? [{ name: 'Your Unit7 apps', keys: unit7 }] : [])]), listId = id('bre');
    run(ctx.db, 'INSERT INTO breach_lists (id, org_id, provider, items, created_at) VALUES (?, ?, ?, ?, ?)', listId, ctx.orgId, i.provider, JSON.stringify(items), now());
    const copy = await execute(ctx.app, ctx.orgId, ctx.actor, 'safety.copy', { reason: `${i.provider} was breached` }, { reason: `${i.provider} breach`, signal: ctx.signal });
    return { id: listId, provider: i.provider, items, copied: copy.status === 'ok' ? (copy.output as { copied: string[] }).copied : [], note: items.length ? 'Change them in this order. Tick each off as you go.' : `None of your settings look like they’re from ${i.provider}. Check any you keep elsewhere.` };
  },
});
defineTool({
  name: 'security.breach_tick', title: 'Tick off a changed setting', risk: 'write', action: 'memory', description: 'Mark one setting on a breach list as changed.',
  input: z.object({ id: z.string().max(40), app: z.string().max(200), key: z.string().max(200), done: z.boolean().default(true) }),
  run(ctx, i) {
    const r = get<{ items: string }>(ctx.db, 'SELECT items FROM breach_lists WHERE id = ? AND org_id = ?', i.id, ctx.orgId);
    if (!r) throw notFound('That list');
    const items = json<Tick[]>(r.items, []).map((t) => (t.app === i.app && t.key === i.key ? { ...t, done: i.done } : t));
    run(ctx.db, 'UPDATE breach_lists SET items = ? WHERE id = ?', JSON.stringify(items), i.id);
    return { left: items.filter((t) => !t.done).length };
  },
});

// S11. Is there a real brake? What each provider's limit really does, from their docs, as of November 2026.
export const BRAKES: Record<string, { brake: 'fixed' | 'prepaid' | 'needs-setup' | 'none' | 'unknown'; words: string }> = {
  hostinger: { brake: 'fixed', words: 'A fixed plan: it can’t run away.' }, digitalocean: { brake: 'fixed', words: 'Mostly fixed plans. Bandwidth overage can still add up.' },
  vercel: { brake: 'needs-setup', words: 'An amount alone stops nothing. “Pause production deployments” must be on, and it doesn’t stop AI Gateway.' },
  gcp: { brake: 'none', words: 'Budgets only send alerts, and cost data lags. Nothing stops by itself.' }, firebase: { brake: 'none', words: 'Budgets only send alerts, and cost data lags. Nothing stops by itself.' },
  aws: { brake: 'none', words: 'Budgets alert. Nothing stops unless you build it.' }, azure: { brake: 'none', words: 'Budgets alert. Nothing stops unless you build it.' }, cloudflare: { brake: 'none', words: 'Usage-based products have no spending limit.' },
  openai: { brake: 'prepaid', words: 'Prepaid credit limits what you can lose, if auto-recharge is off.' }, anthropic: { brake: 'prepaid', words: 'Prepaid credit limits what you can lose, if auto-reload is off.' },
  supabase: { brake: 'unknown', words: 'Sources disagree on whether a spend cap is on by default, and compute is always charged. Check your plan.' }, railway: { brake: 'unknown', words: 'Check whether a usage limit is set.' }, render: { brake: 'unknown', words: 'Check whether a usage limit is set.' }, fly: { brake: 'unknown', words: 'Check whether a usage limit is set.' }, heroku: { brake: 'fixed', words: 'Mostly fixed dyno prices.' },
};
export function brakeView(providers: string[]) {
  const list = [...new Set(providers)].filter((p) => BRAKES[p]).map((p) => ({ provider: p, ...BRAKES[p]! })), open = list.filter((b) => b.brake === 'none' || b.brake === 'needs-setup');
  return { list, line: !list.length ? 'Nothing connected can run up a bill.' : open.length ? `${open.length} of ${list.length} can run away with no brake: ${open.map((b) => b.provider).join(', ')}.` : 'Nothing connected can run away unchecked.', worst: open.length ? 'With no brake, one bad night costs whatever the traffic costs. Real cases ran 13 to 48 hours before anyone noticed.' : undefined };
}
defineTool({ name: 'spend.brake', title: 'Could one night cost me a fortune?', risk: 'read', action: 'read', description: 'For each connected provider: is there a real hard stop, or only an alert? What a bad night could cost when there’s no brake.', input: z.object({}), run: (ctx) => brakeView(all<{ provider: string }>(ctx.db, 'SELECT DISTINCT provider FROM accounts WHERE org_id = ?', ctx.orgId).map((a) => a.provider)) });

// N12. If this server died today: a real restore, timed, and an honest sum for the rest.
export function comeback(o: { restoreMs: number; apps: number; files: boolean; offServer: boolean; settings: boolean }) {
  const steps = [{ step: 'Get a new server ready', minutes: 15, measured: false }, { step: 'Restore the database', minutes: Math.max(1, Math.ceil((o.restoreMs * 1.5) / 60_000)), measured: true }, { step: `Deploy ${o.apps} app${o.apps === 1 ? '' : 's'}`, minutes: 5 * Math.max(1, o.apps), measured: false }, { step: 'Point the domains at it', minutes: 10, measured: false }];
  const gaps = [...(!o.offServer ? ['The only copies are on this server, so if it died you’d have nothing to restore.'] : []), ...(!o.files ? ['Uploaded files aren’t copied yet.'] : []), ...(!o.settings ? ['Settings aren’t copied yet, so you’d rebuild them by hand.'] : [])];
  return { minutes: steps.reduce((n, s) => n + s.minutes, 0), steps, gaps };
}
defineTool({
  name: 'safety.fire_drill', title: 'If this server died today', risk: 'write', action: 'backup', green: true, timeoutMs: 2 * 3600_000,
  description: 'Restore the newest copy of a database into a throwaway, time it, remove it, and work out how long coming back from nothing would take: "You could be back in about N minutes", with what’s measured, what’s estimated, and what’s missing. The live database isn’t touched.',
  input: z.object({ serverId: fid('srv'), part: z.string().min(1).max(300) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), inv = lastXray(ctx.db, ctx.orgId, s.id)?.data, p = inv?.parts.find((x) => x.id === i.part || x.name === i.part);
    if (!p) throw new Unit7Error('not_found', `Unit7 didn’t find ${i.part} on ${s.name}.`, 404);
    const t0 = Date.now(), r = await execute(ctx.app, ctx.orgId, ctx.actor, 'part.restore', { serverId: s.id, part: p.id, into: 'copy' }, { reason: 'a fire drill', signal: ctx.signal });
    if (r.status !== 'ok') throw new Unit7Error('drill_failed', r.status === 'error' ? `The restore failed, which is what a drill is for: ${r.error.message}` : `The restore didn’t run: ${r.status}`, 409);
    const restoreMs = Date.now() - t0, copy = String((r.output as { copy: string }).copy);
    await removeCopy(ctx, s, copy).catch(() => undefined);
    const has = (sql: string, ...a: string[]) => !!get(ctx.db, sql, ctx.orgId, s.id, ...a), offServer = has(`SELECT 1 FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND offsite IS NOT NULL AND status = 'done'`, p.id);
    const extras = `extras:${p.id}`, c = comeback({ restoreMs, apps: (inv?.parts ?? []).filter((x) => x.kind === 'app' && x.project === p.project).length, offServer, files: has(`SELECT 1 FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND kind = 'files'`, extras), settings: has(`SELECT 1 FROM backups WHERE org_id = ? AND server_id = ? AND part = ? AND kind = 'settings'`, extras) });
    run(ctx.db, `INSERT INTO fire_drills (id, org_id, server_id, part, name, minutes, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id('frd'), ctx.orgId, s.id, p.id, p.name, c.minutes, JSON.stringify(c), now());
    return { line: `You could be back in about ${c.minutes} minutes.`, ...c, measured: `The database restore took ${Math.round(restoreMs / 1000)} seconds on this server. The rest are estimates.` };
  },
});
