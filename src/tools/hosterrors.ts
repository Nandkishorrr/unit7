// Errors from apps on other hosts (Vercel, Railway, Render, Fly.io, Heroku, DigitalOcean) and from Sentry, grouped the same
// way as apps on your servers: every 10 minutes Warden reads each app's new error lines since the last read,
// folds them into groups (same error = same group), and tells you when a new kind of error keeps happening or
// an old one spikes. Netlify has no logs API; Supabase's logs come later.
import { z } from 'zod';
import { defineTool, noteAccountTrouble, type Ctx } from './runtime.ts';
import { all, get, json, now, run } from '../db.ts';
import { extractErrors, fingerprint, type ErrorEvent } from './errors.ts';
import { vercel } from '../connectors/clouds.ts';
import { railway, render, fly, heroku, digitalocean } from '../connectors/hosts.ts';
import { sentry } from '../connectors/services.ts';
import { pool } from '../discovery/scanners.ts';
import type { End } from './links.ts';
import { archivedAssets } from '../archive.ts';

type Line = { at: string; text: string; level?: string };
const SUPPORTED = ['vercel', 'railway', 'render', 'fly', 'heroku', 'digitalocean', 'sentry'];
const ERRORISH = /\b(error|exception|fatal|panic|traceback|unhandled|at=error)\b/i;

async function lines(ctx: Ctx, provider: string, accountId: string, extId: string, end: End | undefined, since: Date, api?: string): Promise<{ all: Line[]; errors: Line[]; events?: ErrorEvent[] }> {
  const e = end as Record<string, string> | undefined;
  switch (provider) {
    // Sentry groups errors itself: each issue seen since the last read is one group here, and its own count says how many
    case 'sentry': {
      const [org, project] = extId.split('/') as [string, string], clean = (s: string) => ctx.redactor.redact(s);
      const seen = (await sentry.issues(ctx, accountId, org, project, api)).filter((i) => !(Date.parse(i.lastSeen ?? '') < since.getTime()));
      return { all: [], errors: [], events: seen.map((i) => ({ kind: i.type ?? 'Error', message: clean((i.value ?? i.title).slice(0, 300)), frame: i.culprit, sample: clean([i.title, i.culprit, i.url].filter(Boolean).join('\n').slice(0, 1500)), total: i.count })) };
    }
    // these hosts filter by level themselves
    case 'vercel': { const l = await vercel.errorLines(ctx, accountId, e!.project!, e!.team, since); return { all: l, errors: l }; }
    case 'railway': { const l = await railway.errorLines(ctx, accountId, { environment: e!.environment!, service: e!.service! }, since); return { all: l, errors: l }; }
    case 'render': { const l = await render.errorLines(ctx, accountId, e!.service!, since); return { all: l, errors: l }; }
    // these return everything: keep the stack traces around error lines, judge by level or wording
    case 'fly': { const l = await fly.recentLines(ctx, accountId, e!.app!, since); return { all: l, errors: l.filter((x) => /error|fatal|crit/i.test(x.level ?? '') || ERRORISH.test(x.text)) }; }
    case 'heroku': { const l = await heroku.recentLines(ctx, accountId, e!.app!, since); return { all: l, errors: l.filter((x) => ERRORISH.test(x.text)) }; }
    case 'digitalocean': { const l = await digitalocean.recentLines(ctx, accountId, extId.replace(/^app-/, ''), since); return { all: l, errors: l.filter((x) => ERRORISH.test(x.text)) }; }
  }
  return { all: [], errors: [] };
}

// the error events in some lines: stack traces and structured errors first, else each error line on its own
export function eventsFrom(all: Line[], errors: Line[], redact: (s: string) => string): ErrorEvent[] {
  const found = extractErrors(redact(all.map((l) => l.text).join('\n')));
  return found.length ? found : errors.map((l) => { const t = redact(l.text).trim(); return { kind: 'Logged error', message: t.slice(0, 300), sample: t.slice(0, 1500) }; });
}

export async function scanHostErrors(ctx: Ctx) {
  const off = archivedAssets(ctx.db, ctx.orgId); // archived: its errors aren't read
  const apps = all<{ id: string; account_id: string | null; provider: string; ext_id: string; name: string; meta: string }>(ctx.db,
    `SELECT id, account_id, provider, ext_id, name, meta FROM assets WHERE org_id = ? AND kind IN ('app', 'service') AND account_id IS NOT NULL AND provider IN (${SUPPORTED.map(() => '?').join(',')})`, ctx.orgId, ...SUPPORTED)
    .filter((a) => !off.has(a.id)).slice(0, 80);
  const report: { app: string; group: string; kind: string; message: string; added: number; fresh: boolean }[] = [], skipped: string[] = [];
  await pool(apps, 4, async (a) => {
    const cursor = get<{ at: string }>(ctx.db, 'SELECT at FROM log_cursors WHERE org_id = ? AND asset = ?', ctx.orgId, a.id)?.at;
    const since = new Date(Math.max(Date.parse(cursor ?? '') || 0, Date.now() - 60 * 60_000)); // never more than the last hour
    const startedAt = now();
    let got: Awaited<ReturnType<typeof lines>>;
    const meta = json<{ end?: End; api?: string }>(a.meta, {});
    try { got = await lines(ctx, a.provider, a.account_id!, a.ext_id, meta.end, cursor ? since : new Date(Date.now() - 15 * 60_000), meta.api); }
    catch (e) { noteAccountTrouble(ctx.app, a.account_id!, e); skipped.push(`${a.name}: ${(e as Error).message.slice(0, 120)}`); return; }
    run(ctx.db, `INSERT INTO log_cursors (org_id, asset, at) VALUES (?, ?, ?) ON CONFLICT(org_id, asset) DO UPDATE SET at = excluded.at`, ctx.orgId, a.id, startedAt);
    const groups = new Map<string, { e: ErrorEvent; n: number }>();
    for (const e of got.events ?? eventsFrom(got.all, got.errors, (s) => ctx.redactor.redact(s))) { const f = fingerprint(e); const g = groups.get(f); if (g) g.n++; else groups.set(f, { e, n: 1 }); }
    for (const [fp, { e, n: hits }] of groups) {
      const prev = get<{ count: number; last_seen: string; alerted_at: string | null }>(ctx.db, 'SELECT count, last_seen, alerted_at FROM remote_errors WHERE org_id = ? AND asset = ? AND fingerprint = ?', ctx.orgId, a.id, fp);
      const n = e.total === undefined ? hits : prev ? Math.max(1, e.total - prev.count) : e.total; // a service's own total, added once
      run(ctx.db, `INSERT INTO remote_errors (org_id, asset, fingerprint, kind, message, frame, sample, count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(org_id, asset, fingerprint) DO UPDATE SET count = remote_errors.count + excluded.count, last_seen = excluded.last_seen, sample = excluded.sample`,
        ctx.orgId, a.id, fp, e.kind, e.message.slice(0, 500), e.frame ?? null, e.sample.slice(0, 3000), n, now(), now());
      const fresh = !prev || Date.parse(prev.last_seen) < Date.now() - 7 * 86400_000; // new, or back after a quiet week
      report.push({ app: a.name, group: fp, kind: e.kind, message: e.message, added: n, fresh });
      // a new kind of error that keeps happening, or an old one spiking; at most once every 6 hours per error
      if (((fresh && n >= 3) || n >= 25) && (!prev?.alerted_at || Date.parse(prev.alerted_at) < Date.now() - 6 * 3600_000)) {
        run(ctx.db, 'UPDATE remote_errors SET alerted_at = ? WHERE org_id = ? AND asset = ? AND fingerprint = ?', now(), ctx.orgId, a.id, fp);
        ctx.emit('app.errors', `${a.name}: ${e.kind}: ${e.message.slice(0, 140)} (${n} times in the last few minutes)`, { severity: 'warning', resource: a.id });
      }
    }
  });
  run(ctx.db, 'DELETE FROM remote_errors WHERE org_id = ? AND last_seen < ?', ctx.orgId, new Date(Date.now() - 30 * 86400_000).toISOString());
  return { apps: apps.length, newErrors: report.filter((r) => r.fresh).length, report: report.slice(0, 50), skipped };
}

defineTool({
  name: 'errors.scan_hosts', title: 'Read errors from other hosts', risk: 'read', action: 'read', timeoutMs: 10 * 60_000,
  description: 'Read new error lines from every app on Vercel, Railway, Render, Fly.io, Heroku and DigitalOcean, and new issues from every Sentry project (from the map), group them, and flag new or spiking errors. Warden does this every 10 minutes.',
  input: z.object({}),
  run: (ctx) => scanHostErrors(ctx),
});

defineTool({
  name: 'errors.hosts', title: 'Errors in apps on other hosts', risk: 'read', action: 'read',
  description: 'Error groups from apps on other hosts and from Sentry, most recent first: what, how often, a sample (secrets scrubbed). Optionally for one app (its map id).',
  input: z.object({ assetId: z.string().max(40).optional() }),
  run: (ctx, i) => all(ctx.db, `SELECT e.asset, a.name app, a.provider, e.kind, e.message, e.frame, e.count, e.first_seen, e.last_seen, e.sample FROM remote_errors e LEFT JOIN assets a ON a.id = e.asset
    WHERE e.org_id = ? AND (? IS NULL OR e.asset = ?) ORDER BY e.last_seen DESC LIMIT 100`, ctx.orgId, i.assetId ?? null, i.assetId ?? null),
});
