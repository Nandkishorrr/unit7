// Care: is a project ready for real users (project.readiness), and what does everything cost (cost.radar). Both only
// read. Their fixes and savings are other tools a person (or an AI, through the gate) runs; nothing here spends money.
import { z } from 'zod';
import { defineTool, execute } from './runtime.ts';
import { fid } from './helpers.ts';
import { notFound } from '../errors.ts';
import { readiness, allReadiness } from '../care/readiness.ts';
import { costRadar } from '../care/radar.ts';
import { foundReadiness } from '../care/partchecks.ts';

defineTool({
  name: 'project.readiness', title: 'Is a project ready for real users', risk: 'read', action: 'read',
  description: 'A checklist for a project’s live copy, every tick from what Unit7 has seen: its own domain (not only a test address), HTTPS working, email protection (SPF and DMARC), daily backups with a tested restore, a backup copy off the server, phone alerts, an uptime check, errors tracked, a budget, no secrets in the code (the last deploy’s scan), and autonomy chosen by a person. Checks that don’t apply drop out (no database, no backup checks). Each unticked item names its fix: a tool to run, a page, or a request. Without projectId: every project’s score.',
  input: z.object({ projectId: fid('prj').optional(), serverId: fid('srv').optional().describe('With found: a project the X-ray found on this server (a Coolify project)'), found: z.string().max(200).optional() }),
  run(ctx, i) {
    if (i.serverId && i.found) { const r = foundReadiness(ctx.db, ctx.orgId, i.serverId, i.found); if (!r) throw notFound('That project'); return r; }
    if (!i.projectId) return { projects: allReadiness(ctx.db, ctx.orgId) };
    const r = readiness(ctx.db, ctx.orgId, i.projectId);
    if (!r) throw notFound('That project');
    return r;
  },
});

defineTool({
  name: 'cost.radar', title: 'What everything costs a month', risk: 'read', action: 'read', timeoutMs: 5 * 60_000,
  description: 'One monthly number across everything: provider bills Unit7 last read (Vercel, Railway, DigitalOcean, Heroku, Cloudflare, Hostinger, AWS and Azure spend, your own entries), each server’s monthly price, split by project (from each server’s last usage reading), by provider and by client, against last month and your budget. Plus “save” ideas from real signals: projects with no deploy in 90 days and no visits, servers mostly idle for 30 days (a smaller plan: people decide, Unit7 never changes plans), duplicate databases, and old images or unused volumes. Figures marked estimate are projections or shares. refresh: read the providers’ bills first (budget.check).',
  input: z.object({ refresh: z.boolean().default(false) }),
  async run(ctx, i) {
    if (i.refresh) await execute(ctx.app, ctx.orgId, ctx.actor, 'budget.check', {}, { reason: 'cost radar', signal: ctx.signal });
    return costRadar(ctx);
  },
});
