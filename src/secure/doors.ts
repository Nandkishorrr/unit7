// Your database door rules, checked from inside: Supabase's own advisors cover hosted and local projects, so a self-hosted stack gets
// nothing. These read the catalogs in a read-only session and never touch a row.
import { z } from 'zod';
import { defineTool, type Ctx } from '../tools/runtime.ts';
import { fid } from '../tools/helpers.ts';
import { lastXray } from '../tools/xray.ts';
import { serverRow } from '../tools/servers.ts';
import { pgRead } from '../care/partchecks.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import type { Part } from '../discovery/xray.ts';
import type { Finding } from '../tools/security.ts';

export const LINTS = {
  noRls: `select c.relname, has_table_privilege('anon', c.oid, 'select') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
  noPolicy: `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid)`,
  openPolicy: `select tablename, policyname, cmd from pg_policies where schemaname = 'public' and (qual = 'true' or with_check = 'true') and (roles::text like '%anon%' or roles::text like '%public%')`,
  riskyFn: `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')`,
  publicBucket: `select name from storage.buckets where public`,
  slowPolicy: `select tablename, policyname from pg_policies where schemaname = 'public' and qual ~ 'auth\\.(uid|jwt|role)\\(\\)' and qual !~ '\\(\\s*select\\s+auth\\.'`,
};
type Lint = keyof typeof LINTS;
// (pure) what the rows mean, in your words first
export function doorFindings(s: Pick<ServerRow, 'id' | 'name'>, p: Pick<Part, 'id' | 'name'>, r: Partial<Record<Lint, string[][]>>): Finding[] {
  const out: Finding[] = [], about = { kind: 'app' as const, id: p.id, name: p.name }, base = { area: 'app' as const, by: 'unit7' as const, serverId: s.id, about };
  const ask = (q: string) => ({ label: 'Ask Unit7 to help', ask: `${q} Show me each change first, and don’t change anything until I agree.`, manual: ['Open the SQL editor and fix it, or give this to your AI.'] });
  const off = r.noRls ?? [], reachable = off.filter((x) => x[1] === 't');
  if (reachable.length) out.push({ ...base, id: `doors:no-rls:${s.id}:${p.id}`, severity: 'critical', title: `${reachable.length} table${reachable.length === 1 ? ' has' : 's have'} no door rule, and the public key can reach ${reachable.length === 1 ? 'it' : 'them'}`, detail: 'Your database door rule (RLS) is off, so anyone with the key in your site can read and change these.', evidence: reachable.slice(0, 8).map((x) => x[0]).join(', '), fix: ask(`On ${p.name}, RLS is off on ${reachable.slice(0, 8).map((x) => x[0]).join(', ')}, and anon can reach them. Help me turn it on with the right policies.`) });
  else if (off.length) out.push({ ...base, id: `doors:no-rls-closed:${s.id}:${p.id}`, severity: 'low', title: `${off.length} table${off.length === 1 ? ' has' : 's have'} no door rule, but the public key can’t reach ${off.length === 1 ? 'it' : 'them'} today`, detail: 'A later change to its permissions would open it.', evidence: off.slice(0, 8).map((x) => x[0]).join(', '), fix: ask(`On ${p.name}, turn on RLS for ${off.slice(0, 8).map((x) => x[0]).join(', ')}.`) });
  if (r.noPolicy?.length) out.push({ ...base, id: `doors:no-policy:${s.id}:${p.id}`, severity: 'low', title: `${r.noPolicy.length} table${r.noPolicy.length === 1 ? ' has' : 's have'} a door rule that lets nobody in`, detail: 'RLS is on with no policy, so your own app can’t use it either. That’s safe, but it may not be what you meant.', evidence: r.noPolicy.slice(0, 8).map((x) => x[0]).join(', '), fix: ask(`On ${p.name}, these tables have RLS and no policy: ${r.noPolicy.slice(0, 8).map((x) => x[0]).join(', ')}. Tell me what each should allow.`) });
  if (r.openPolicy?.length) out.push({ ...base, id: `doors:open-policy:${s.id}:${p.id}`, severity: 'high', title: `${r.openPolicy.length} door rule${r.openPolicy.length === 1 ? ' lets' : 's let'} anyone in`, detail: 'The rule is written as “true”, so having a rule doesn’t protect anything.', evidence: r.openPolicy.slice(0, 6).map((x) => `${x[0]}: ${x[2]}`).join(', '), fix: ask(`On ${p.name}, these policies allow everyone: ${r.openPolicy.slice(0, 6).map((x) => `${x[1]} on ${x[0]}`).join(', ')}. Help me narrow them.`) });
  if (r.riskyFn?.length) out.push({ ...base, id: `doors:risky-fn:${s.id}:${p.id}`, severity: 'high', title: `${r.riskyFn.length} database function${r.riskyFn.length === 1 ? ' runs' : 's run'} with full rights and anyone can call ${r.riskyFn.length === 1 ? 'it' : 'them'}`, detail: 'A function marked security definer skips the door rules for whoever calls it.', evidence: r.riskyFn.slice(0, 8).map((x) => x[0]).join(', '), fix: ask(`On ${p.name}, review these security definer functions: ${r.riskyFn.slice(0, 8).map((x) => x[0]).join(', ')}. Revoke anon where it isn’t needed.`) });
  if (r.publicBucket?.length) out.push({ ...base, id: `doors:public-bucket:${s.id}:${p.id}`, severity: 'medium', title: `${r.publicBucket.length} storage bucket${r.publicBucket.length === 1 ? ' is' : 's are'} public`, detail: 'Anyone with a link can download what’s in them. Fine for logos, not for invoices.', evidence: r.publicBucket.slice(0, 8).map((x) => x[0]).join(', '), fix: ask(`On ${p.name}, should these buckets be public: ${r.publicBucket.slice(0, 8).map((x) => x[0]).join(', ')}?`) });
  if (r.slowPolicy?.length) out.push({ ...base, id: `doors:slow-policy:${s.id}:${p.id}`, severity: 'low', title: `${r.slowPolicy.length} door rule${r.slowPolicy.length === 1 ? ' runs' : 's run'} once for every row`, detail: 'On big tables this slows every page. Wrapping it as (select auth.uid()) makes it run once per query.', evidence: r.slowPolicy.slice(0, 6).map((x) => x[0]).join(', '), fix: ask(`On ${p.name}, wrap auth calls in these policies as (select auth.uid()): ${r.slowPolicy.slice(0, 6).map((x) => x[1]).join(', ')}.`) });
  return out;
}
export const isSupabase = (p: Part) => /(^|\/)supabase\/postgres(:|$)/.test(p.internals?.map((x) => x.image).join(' ') ?? p.image ?? '') || /(^|\s)supabase\/postgres/.test(p.image ?? '');
export async function doorCheck(ctx: Ctx, s: ServerRow, p: Part) {
  const out: Partial<Record<Lint, string[][]>> = {};
  for (const k of Object.keys(LINTS) as Lint[]) { const r = await pgRead(ctx, s, p, LINTS[k]); if (r) out[k] = r; }
  return out;
}
defineTool({
  name: 'security.doors', title: 'Check my database door rules', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'Read the security rules of each self-hosted Supabase on a server, in a read-only session: tables with row level security (RLS) off that the public key can reach, policies that let anyone in, security definer functions anyone can call, public storage buckets, and rules that run once per row. Reads catalogs only, never rows.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), parts = (lastXray(ctx.db, ctx.orgId, s.id)?.data.parts ?? []).filter((p) => p.engine === 'postgres' && isSupabase(p) && p.state === 'running'), findings: Finding[] = [];
    for (const p of parts.slice(0, 6)) { ctx.progress(`Reading ${p.name}’s door rules…`); findings.push(...doorFindings(s, p, await doorCheck(ctx, s, p))); }
    return { databases: parts.length, findings };
  },
});
