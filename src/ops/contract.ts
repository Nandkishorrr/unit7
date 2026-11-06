// Coolify changes under us, so the fields Unit7 depends on are written down here, and checked against the real API. A change shows up
// here first, instead of as a strange bug.
import { z } from 'zod';
import { all } from '../db.ts';
import { defineTool, type Ctx } from '../tools/runtime.ts';
import { coolifyFor } from '../tools/xray.ts';
import type { ServerRow } from '../connectors/ssh.ts';

export const CONTRACT: { path: string; list: boolean; fields: string[]; since?: string }[] = [
  { path: '/projects', list: true, fields: ['uuid', 'name'] }, { path: '/applications', list: true, fields: ['uuid', 'name', 'status'] }, { path: '/services', list: true, fields: ['uuid', 'name'] },
  { path: '/databases', list: true, fields: ['uuid', 'name'] }, { path: '/servers', list: true, fields: ['uuid', 'name', 'ip'] },
];
// (pure) what's missing from an answer, or undefined when it still matches
export function contractGap(c: (typeof CONTRACT)[number], body: unknown): string | undefined {
  const rows = Array.isArray(body) ? body : undefined;
  if (c.list && !rows) return `${c.path} no longer answers with a list`;
  const row = rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return undefined; // nothing to compare
  const gone = c.fields.filter((f) => !(f in row));
  return gone.length ? `${c.path} no longer has ${gone.join(', ')}` : undefined;
}
export async function checkContract(ctx: Ctx, s: ServerRow) {
  const c = coolifyFor(ctx, s);
  if (!c) return undefined;
  const version = await c.api.call('GET', '/version').catch(() => undefined), gaps: string[] = [], failed: string[] = [];
  for (const x of CONTRACT) { const body = await c.api.call('GET', x.path).catch(() => { failed.push(x.path); return undefined; }); if (body !== undefined) { const g = contractGap(x, body); if (g) gaps.push(g); } }
  return { server: s.name, version: typeof version === 'string' ? version : c.version, gaps, failed };
}
defineTool({
  name: 'coolify.contract', title: 'Has Coolify changed under Unit7?', risk: 'read', action: 'read', timeoutMs: 60_000, idle: (o: { gaps: number }) => !o.gaps,
  description: 'Check the Coolify API on each connected server still has the fields Unit7 depends on. Warden does this daily, so a Coolify update that changes something is noticed here first.',
  input: z.object({}),
  async run(ctx) {
    const out = []; for (const s of all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ? AND status = 'ready'`, ctx.orgId)) { const r = await checkContract(ctx, s).catch(() => undefined); if (r) out.push(r); }
    const gaps = out.flatMap((r) => r.gaps);
    if (gaps.length && ctx.actor.kind !== 'user') ctx.emit('coolify.changed', `Coolify changed in a way Unit7 depends on: ${gaps[0]}. Some features may not work until Unit7 updates.`, { severity: 'warning' });
    return { servers: out, gaps: gaps.length };
  },
});
