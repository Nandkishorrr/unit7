// Try it on a copy first: a risky migration runs on a throwaway made from a fresh copy, and the result comes back before anything
// touches live. What changed, what broke, how long it took. Then the person decides. Green: it only ever creates a copy, and removes
// only that copy.
import { z } from 'zod';
import { defineTool, execute } from '../tools/runtime.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { fid } from '../tools/helpers.ts';
import { Unit7Error } from '../errors.ts';
import { json } from '../db.ts';
import { serverRow } from '../tools/servers.ts';
import { lastXray } from '../tools/xray.ts';
import { findPart } from '../tools/manage.ts';
import { removeCopy } from '../tools/partbackup.ts';

const asRoot = (s: ServerRow) => (json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '');
const COUNTS = `ANALYZE; select schemaname || '.' || relname, n_live_tup from pg_stat_user_tables order by 1`;
export const parseCounts = (out: string) => new Map(out.split('\n').flatMap((l) => { const [t, n] = l.split('|'); return t && n && /^\d+$/.test(n.trim()) ? [[t.trim(), Number(n)] as const] : []; }));
// (pure) what the rehearsal did to each table, in order of how much moved
export function compareCounts(before: Map<string, number>, after: Map<string, number>) {
  const out: { table: string; before?: number; after?: number; change: 'gone' | 'new' | 'changed' }[] = [];
  for (const [t, n] of before) { const a = after.get(t); if (a === undefined) out.push({ table: t, before: n, change: 'gone' }); else if (a !== n) out.push({ table: t, before: n, after: a, change: 'changed' }); }
  for (const [t, n] of after) if (!before.has(t)) out.push({ table: t, after: n, change: 'new' });
  return out.sort((a, b) => Math.abs((b.after ?? 0) - (b.before ?? 0)) - Math.abs((a.after ?? 0) - (a.before ?? 0)));
}
export const worries = (c: ReturnType<typeof compareCounts>) => c.filter((x) => x.change === 'gone' || (x.after !== undefined && x.before !== undefined && x.after < x.before * 0.5)).map((x) => (x.change === 'gone' ? `${x.table} would be removed, with ${x.before} rows` : `${x.table} would fall from ${x.before} to ${x.after} rows`));

const PSQL = `docker exec -i "$1" psql -U postgres -v ON_ERROR_STOP=1 -AtqX -F '|'`;
defineTool({
  name: 'safety.rehearse', title: 'Try it on a copy first', risk: 'write', action: 'backup', green: true, timeoutMs: 2 * 3600_000,
  description: 'Rehearse a risky SQL migration on a throwaway copy of a Postgres database found on a server, made from a fresh backup, with no public port. Returns whether it worked, how long it took, and which tables changed. The live database isn’t touched, and the copy is removed afterwards. For an AI about to change a schema: call this first and show the result.',
  input: z.object({ serverId: fid('srv'), part: z.string().min(1).max(300), sql: z.string().min(3).max(100_000) }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId), inv = lastXray(ctx.db, ctx.orgId, s.id)?.data, p = inv && findPart(inv, i.part);
    if (!p || p.engine !== 'postgres') throw new Unit7Error('postgres_only', 'Rehearsals work on Postgres so far.', 409);
    const step = async (tool: string, input: unknown) => { const r = await execute(ctx.app, ctx.orgId, ctx.actor, tool, input, { reason: 'a rehearsal', signal: ctx.signal }); if (r.status !== 'ok') throw new Unit7Error('rehearsal', r.status === 'error' ? r.error.message : `${tool}: ${r.status}`, 409); return r.output as Record<string, unknown>; };
    ctx.progress('Taking a fresh copy…');
    await step('part.backup', { serverId: s.id, part: p.id, reason: 'before a rehearsal' });
    ctx.progress('Opening a throwaway copy…');
    const copy = String((await step('part.restore', { serverId: s.id, part: p.id, into: 'copy' })).copy);
    try {
      const read = async () => parseCounts((await ssh(ctx.app).exec(s, asRoot(s) + script(`${PSQL} <<'U7SQL'\n${COUNTS}\nU7SQL`, copy), { timeoutMs: 120_000 })).stdout);
      const before = await read(), t0 = Date.now();
      ctx.progress('Running it on the copy…');
      const r = await ssh(ctx.app).exec(s, asRoot(s) + script(`docker exec -i "$1" psql -U postgres -v ON_ERROR_STOP=1 -q -1`, copy), { stdin: i.sql, timeoutMs: 3600_000, signal: ctx.signal });
      const ms = Date.now() - t0, after = await read(), changed = compareCounts(before, after), ok = r.code === 0;
      return { ok, ms, ...(ok ? {} : { error: ctx.redactor.redact(r.stderr).slice(-600) }), changed: changed.slice(0, 30), worries: worries(changed), live: 'Untouched.', next: ok ? 'It worked on the copy. Running it on live is your call.' : 'It failed on the copy, so live was spared.' };
    } finally { await removeCopy(ctx, s, copy).catch(() => undefined); }
  },
});
