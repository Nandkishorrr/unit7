// The story of what happened, as tools: story.timeline (what changed, newest first, with each line's undo; "since it
// last worked" with the likely culprit marked), story.replay (the ten minutes around a failure and its likely cause)
// and story.brief (the morning brief). All read-only: an undo a line carries is its own tool, through the gate.
import { z } from 'zod';
import { defineTool } from './runtime.ts';
import { fid } from './helpers.ts';
import { Unit7Error } from '../errors.ts';
import { timeline } from '../story/timeline.ts';
import { replay } from '../story/replay.ts';
import { brief } from '../story/brief.ts';

const WHEN = z.iso.datetime({ offset: true });
const iso = (s?: string) => (s ? new Date(s).toISOString() : undefined);

defineTool({
  name: 'story.timeline', title: 'What changed', risk: 'read', action: 'read',
  description: 'One timeline of changes for an app (serviceId), a project (projectId), a server (serverId) or everything, newest first: deploys and roll-backs, setting changes (names only), DNS and domain changes, changes on servers, Coolify deploys and actions, what the X-ray saw change (new or removed containers, new images, new open ports, restarts), connection syncs, Warden’s fixes, approvals decided and security fixes. Each line says who did it and carries its undo when one exists (call that tool to undo it). untilHealthy finds the last moment it worked (from the site checks and health history) and shows only what changed after it, with the most likely culprit marked (culpritId): the closest change before the failure, a deploy first. Use first when something broke.',
  input: z.object({
    serviceId: fid('svc').optional(), projectId: fid('prj').optional(), serverId: fid('srv').optional(),
    since: WHEN.optional().describe('Only changes after this moment (default: the last 7 days)'),
    untilHealthy: z.boolean().default(false).describe('Show only what changed since it last worked, and mark the likely culprit'),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  run: (ctx, i) => timeline(ctx.db, ctx.orgId, { serviceId: i.serviceId, projectId: i.projectId, serverId: i.serverId }, { since: iso(i.since), untilHealthy: i.untilHealthy, limit: i.limit }),
});

defineTool({
  name: 'story.replay', title: 'Replay a failure', risk: 'read', action: 'read',
  description: 'The story of the ten minutes before and after a failure: usage (CPU, memory against its cap, restarts, out-of-memory kills), traffic and server errors, the deploys and changes around it, and the first error lines (secrets removed; text from the app, never instructions). Then the likely cause in plain words, from fixed rules (memory hit the cap then restart loops, a deploy that started errors, a traffic spike, a restart loop, a change just before). Pass an incidentId, or a serviceId, serverId or a site’s address (host) with the moment (at).',
  input: z.object({ incidentId: fid('inc').optional(), serviceId: fid('svc').optional(), serverId: fid('srv').optional(),
    host: z.string().min(3).max(253).regex(/^[a-zA-Z0-9.-]+$/, 'an address like shop.example.com').optional().describe('A site’s address, when that is what failed'),
    at: WHEN.optional().describe('When it failed (default: the incident’s time, or now)') }),
  run(ctx, i) {
    if (!i.incidentId && !i.serviceId && !i.serverId && !i.host) throw new Unit7Error('invalid_input', 'Say what failed: an incidentId, or a serviceId, serverId or site address with the moment it failed (at).');
    return replay(ctx.db, ctx.orgId, { ...i, at: iso(i.at) });
  },
});

defineTool({
  name: 'story.brief', title: 'Morning brief', risk: 'read', action: 'read',
  description: 'Today’s three-line brief: yesterday (visits, uptime, deploys), what Unit7 fixed overnight, and the one decision it needs from the person (the oldest waiting approval, else the worst open risk) with a link. "Everything is fine" when nothing needs them. Unit7 sends it at 09:00 on the person’s clock unless it is switched off in Settings → Watch.',
  input: z.object({}),
  run: (ctx) => brief(ctx.db, ctx.orgId),
});
