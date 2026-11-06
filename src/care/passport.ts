// A project's passport: a living page that says what runs where, so a new developer or an AI starts with the facts. Written from
// what the X-ray and the Safety Net see, and never holds a secret: settings appear by name only.
import { z } from 'zod';
import { all, type DB } from '../db.ts';
import { defineTool } from '../tools/runtime.ts';
import { lastXray } from '../tools/xray.ts';
import { fid } from '../tools/helpers.ts';
import { notFound } from '../errors.ts';
import { LEVEL_WORDS, protectionOf } from './safetynet.ts';
import type { Inventory, Part } from '../discovery/xray.ts';

export interface Passport { name: string; server: string; how: string; domains: string[]; apps: { name: string; image?: string; repo?: string; branch?: string; settings: string[] }[]; databases: { name: string; engine?: string; level?: string; lastCopy?: string }[]; jobs: { name: string; when?: string; command?: string }[]; lastDeploys: { name: string; status: string; at: string }[]; notes: string[]; at: string }

export function passportOf(db: DB, orgId: string, serverId: string, serverName: string, inv: Inventory, ref: string, nowIso = new Date().toISOString()): Passport | undefined {
  const project = inv.projects.find((p) => p.id === ref || p.name === ref);
  if (!project) return undefined;
  const parts: Part[] = inv.parts.filter((p) => project.parts.includes(p.id)), guarded = protectionOf(db, orgId).filter((g) => g.serverId === serverId);
  const apps = parts.filter((p) => p.kind === 'app' || p.kind === 'service'), dbs = parts.filter((p) => p.engine && p.kind !== 'app' || p.kind === 'database');
  const jobs = inv.parts.filter((p) => p.schedule && (project.parts.includes(p.id) || p.project === project.id));
  const how = parts.some((p) => p.owner === 'coolify') ? `Coolify${inv.coolify?.version ? ` ${inv.coolify.version}` : ''}${apps.find((a) => a.coolify?.repo) ? ', from Git' : ''}` : project.how;
  return { name: project.name, server: serverName, how, domains: project.domains, at: nowIso,
    apps: apps.map((p) => ({ name: p.name, ...(p.image && { image: p.image }), ...(p.coolify?.repo && { repo: p.coolify.repo }), ...(p.coolify?.branch && { branch: p.coolify.branch }), settings: [...(p.envKeys ?? [])].sort() })),
    databases: dbs.map((p) => { const g = guarded.find((x) => x.part === p.id); return { name: p.name, ...(p.engine && { engine: p.engine }), ...(g && { level: LEVEL_WORDS[g.level] }), ...(g?.lastCopy && { lastCopy: g.lastCopy }) }; }),
    jobs: jobs.map((p) => ({ name: p.name, ...(p.schedule && { when: p.schedule }), ...(p.command && { command: p.command.slice(0, 120) }) })),
    lastDeploys: all<{ name: string; status: string; at: string }>(db, 'SELECT name, status, at FROM deploys_seen WHERE org_id = ? AND server_id = ? AND project IS ? ORDER BY at DESC LIMIT 5', orgId, serverId, project.id),
    notes: all<{ content: string; source: string | null }>(db, 'SELECT content, source FROM memories WHERE org_id = ? AND about = ? COLLATE NOCASE AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 10', orgId, project.name, nowIso).map((m) => `${m.content}${m.source ? ` (${m.source})` : ''}`) };
}

// (pure) the page as Markdown, to hand to a new developer or an AI. It sits nowhere in a repo unless someone puts it there.
export function passportMarkdown(p: Passport) {
  const l: string[] = [`# ${p.name}`, '', `Runs on ${p.server}, through ${p.how}. Written by Unit7, ${p.at.slice(0, 10)}. It holds no secrets: settings are by name only.`, ''];
  if (p.domains.length) l.push('## Addresses', ...p.domains.map((d) => `- https://${d}`), '');
  if (p.apps.length) { l.push('## What runs'); for (const a of p.apps) { l.push(`- **${a.name}**${a.image ? ` (\`${a.image}\`)` : ''}${a.repo ? `, from ${a.repo}${a.branch ? ` on ${a.branch}` : ''}` : ''}`); if (a.settings.length) l.push(`  - Settings: ${a.settings.slice(0, 40).map((s) => `\`${s}\``).join(', ')}`); } l.push(''); }
  if (p.databases.length) l.push('## Data', ...p.databases.map((d) => `- **${d.name}**${d.engine ? ` (${d.engine})` : ''}${d.level ? `: ${d.level}` : ''}${d.lastCopy ? `, last copy ${d.lastCopy.slice(0, 10)}` : ''}`), '');
  if (p.jobs.length) l.push('## Scheduled jobs', ...p.jobs.map((j) => `- ${j.when ?? ''} ${j.name}${j.command ? `: \`${j.command}\`` : ''}`.trim()), '');
  if (p.notes.length) l.push('## Notes', ...p.notes.map((n) => `- ${n}`), '');
  if (p.lastDeploys.length) l.push('## Recent deploys', ...p.lastDeploys.map((d) => `- ${d.at.slice(0, 16).replace('T', ' ')} ${d.name}: ${d.status}`), '');
  return l.join('\n');
}

defineTool({
  name: 'project.passport', title: 'A project’s passport', risk: 'read', action: 'read',
  description: 'One page on a project found on a server: what runs where, its addresses, its databases and how safe they are, scheduled jobs, how it deploys, and settings by name (never values). Includes it as Markdown to hand to a new developer or an AI. project is its name or id from server.xray.',
  input: z.object({ serverId: fid('srv'), project: z.string().min(1).max(200) }),
  run(ctx, i) {
    const inv = lastXray(ctx.db, ctx.orgId, i.serverId)?.data, s = ctx.db.prepare('SELECT name FROM servers WHERE id = ?').get(i.serverId) as { name: string } | undefined;
    const p = inv && s && passportOf(ctx.db, ctx.orgId, i.serverId, s.name, inv, i.project);
    if (!p) throw notFound('That project');
    return { ...p, markdown: passportMarkdown(p) };
  },
});
