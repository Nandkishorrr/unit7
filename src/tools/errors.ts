// Errors in plain words. Warden reads each running app's logs every minute (stderr included), pulls out
// real errors — Node and Python stack traces, JSON logs at level error — and groups them the way Sentry
// does: by type + the message with changing parts removed + the first stack frame in *your* code
// (library frames skipped). Each group becomes one sentence with a "fix it with my AI" button.
// Logs pass through the redactor before anything is stored, so a secret in a log line never lands here.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { serverRow } from './servers.ts';
import { replicaNames, type ServiceConfig } from '../deploy/deployer.ts';
import { fid } from './helpers.ts';

export interface ErrorEvent { kind: string; message: string; frame?: string; sample: string; total?: number } // total: how often in all, when a service counts for itself

const LIBRARY = /node_modules|node:internal|internal\/|site-packages|dist-packages|\/usr\/lib\/|<anonymous>|\(native\)/;
const JS_ERROR = /^(?:Uncaught |Unhandled ?(?:promise )?rejection:? |\[[^\]]*\]\s*)?((?:[A-Z][\w$]*)?(?:Error|Exception))(?: \[[\w:]+\])?: (.+)$/;
const JS_FRAME = /^\s+at (?:.+? \()?(.+?):(\d+)(?::\d+)?\)?$/;
const PY_FRAME = /^\s+File "(.+?)", line (\d+)/;
const PY_END = /^([A-Z][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)|[A-Z]\w*Error)(?::\s*(.*))?$/;

// one log blob → the distinct error events in it
export function extractErrors(text: string): ErrorEvent[] {
  const lines = text.split('\n');
  const out: ErrorEvent[] = [];
  const short = (f: string, n: string) => `${f.replace(/^.*?\/(?=[^/]+\/[^/]+$)/, '').replace(/^file:\/\//, '')}:${n}`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/^\S+ (?:stdout|stderr) [FP] /, ''); // docker log prefixes, if any
    // Python: Traceback … File "…", line N … ExcType: message
    if (/^Traceback \(most recent call last\):/.test(line)) {
      const block = [line]; let frame: string | undefined; let j = i + 1;
      for (; j < lines.length && j < i + 80; j++) {
        const l = lines[j]!; block.push(l);
        const f = PY_FRAME.exec(l); if (f && !LIBRARY.test(f[1]!)) frame = short(f[1]!, f[2]!);
        const end = PY_END.exec(l.trim()); if (end && !/^\s/.test(l)) { out.push({ kind: end[1]!, message: (end[2] ?? '').trim(), frame, sample: block.join('\n') }); break; }
      }
      i = j; continue;
    }
    // Node: "TypeError: message" followed by "    at …" frames
    const js = JS_ERROR.exec(line.trim());
    if (js) {
      const block = [line]; let frame: string | undefined; let j = i + 1;
      for (; j < lines.length && JS_FRAME.test(lines[j]!) && j < i + 60; j++) {
        block.push(lines[j]!);
        const f = JS_FRAME.exec(lines[j]!)!; if (!frame && !LIBRARY.test(f[1]!)) frame = short(f[1]!, f[2]!);
      }
      if (block.length > 1 || /error|exception/i.test(js[1]!)) out.push({ kind: js[1]!, message: js[2]!.trim(), frame, sample: block.join('\n') });
      i = j - 1; continue;
    }
    // JSON logs (pino, winston, structlog…): level error/fatal
    if (line.startsWith('{') && /"(?:level|severity|lvl)"\s*:\s*(?:"(?:error|fatal|critical)"|5\d|6\d)/i.test(line)) {
      try {
        const o = JSON.parse(line);
        const err = o.err ?? o.error ?? {};
        out.push({ kind: err.type ?? err.name ?? 'Error', message: String(err.message ?? o.msg ?? o.message ?? 'error').slice(0, 300), frame: undefined, sample: (err.stack ?? line).toString().slice(0, 1500) });
      } catch { /* not JSON after all */ }
    }
  }
  return out;
}

// what stays the same across occurrences of "the same" error
export const normalise = (m: string) => m
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
  .replace(/\b0x[0-9a-f]+\b/gi, '<hex>').replace(/\b[0-9a-f]{24,}\b/gi, '<id>')
  .replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 300);
export const fingerprint = (e: ErrorEvent) =>
  createHash('sha1').update(`${e.kind}|${normalise(e.message)}|${(e.frame ?? '').replace(/:\d+$/, '')}`).digest('hex').slice(0, 16);

// Read the app's recent logs and fold its errors into groups. Returns the groups that got new hits.
const lastScan = new Map<string, number>(); // serviceId -> time of last scan (in-process)
export async function scanErrors(ctx: Ctx, serviceId: string): Promise<{ group: string; kind: string; message: string; frame?: string; added: number; fresh: boolean }[]> {
  const svc = get<{ id: string; server_id: string | null; current_deployment_id: string | null; config: string }>(ctx.db, 'SELECT id, server_id, current_deployment_id, config FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  const dep = svc && get<{ container: string | null; number: number }>(ctx.db, 'SELECT container, number FROM deployments WHERE id = ?', svc.current_deployment_id ?? '');
  if (!svc?.server_id || !dep?.container) return [];
  const since = Math.min(600, Math.ceil((Date.now() - (lastScan.get(serviceId) ?? Date.now() - 70_000)) / 1000) + 5);
  lastScan.set(serviceId, Date.now());
  const containers = [dep.container, ...replicaNames(dep.container, json<ServiceConfig>(svc.config, {}).replicas)];
  const s = serverRow(ctx, svc.server_id);
  let text = '';
  for (const c of containers) text += (await ssh(ctx.app).exec(s, script('docker logs --since "$1s" "$2" 2>&1 | tail -c 300000', since, c), { timeoutMs: 30_000 })).stdout + '\n';
  const events = extractErrors(ctx.redactor.redact(text));
  const byGroup = new Map<string, { e: ErrorEvent; n: number }>();
  for (const e of events) { const f = fingerprint(e); const g = byGroup.get(f); if (g) g.n++; else byGroup.set(f, { e, n: 1 }); }
  const out = [];
  for (const [fp, { e, n }] of byGroup) {
    const existing = get<{ id: string; resolved_at: string | null }>(ctx.db, 'SELECT id, resolved_at FROM error_groups WHERE service_id = ? AND fingerprint = ?', serviceId, fp);
    const groupId = existing?.id ?? id('err');
    if (existing) run(ctx.db, 'UPDATE error_groups SET count = count + ?, last_seen = ?, sample = ?, resolved_at = NULL WHERE id = ?', n, now(), e.sample.slice(0, 3000), groupId);
    else run(ctx.db, 'INSERT INTO error_groups (id, org_id, service_id, fingerprint, kind, message, frame, sample, count, first_seen, last_seen, first_deploy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      groupId, ctx.orgId, serviceId, fp, e.kind, e.message.slice(0, 500), e.frame ?? null, e.sample.slice(0, 3000), n, now(), now(), dep.number);
    run(ctx.db, 'INSERT INTO error_hits (group_id, at, n) VALUES (?, ?, ?)', groupId, now(), n);
    out.push({ group: groupId, kind: e.kind, message: e.message, frame: e.frame, added: n, fresh: !existing || !!existing.resolved_at });
  }
  run(ctx.db, 'DELETE FROM error_hits WHERE at < ?', new Date(Date.now() - 2 * 86400_000).toISOString());
  return out;
}

// --- tools ---------------------------------------------------------------------------------------

defineTool({
  name: 'errors.scan', title: 'Read an app’s errors from its logs', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'Read an app’s recent logs and group its errors (stack traces, error-level JSON logs). Warden runs this every minute.',
  input: z.object({ serviceId: fid('svc') }),
  run: async (ctx, i) => ({ updated: await scanErrors(ctx, i.serviceId) }),
});

defineTool({
  name: 'errors.list', title: 'Errors, in plain words', risk: 'read', action: 'read',
  description: 'Grouped errors for an app (or a whole project): what it is, where in the code, how often in the last hour, and since which deploy. Includes a sample stack trace for fixing.',
  input: z.object({ serviceId: fid('svc').optional(), projectId: fid('prj').optional(), includeResolved: z.boolean().default(false) }),
  run(ctx, i) {
    if (!i.serviceId && !i.projectId) throw new Unit7Error('bad_input', 'Give a serviceId or a projectId.');
    const hour = new Date(Date.now() - 3600_000).toISOString();
    return all<Record<string, unknown>>(ctx.db, `SELECT g.id, g.service_id serviceId, s.name service, g.kind, g.message, g.frame, g.count total, g.first_seen firstSeen, g.last_seen lastSeen, g.first_deploy firstDeploy, g.resolved_at resolvedAt, g.sample,
        (SELECT coalesce(sum(n),0) FROM error_hits h WHERE h.group_id = g.id AND h.at > ?) lastHour
      FROM error_groups g JOIN services s ON s.id = g.service_id
      WHERE g.org_id = ? AND (? IS NULL OR g.service_id = ?) AND (? IS NULL OR s.project_id = ?) AND (? OR g.resolved_at IS NULL)
      ORDER BY g.last_seen DESC LIMIT 50`, hour, ctx.orgId, i.serviceId ?? null, i.serviceId ?? null, i.projectId ?? null, i.projectId ?? null, i.includeResolved ? 1 : 0);
  },
});

defineTool({
  name: 'errors.resolve', title: 'Mark an error fixed', risk: 'write', action: 'read',
  description: 'Mark an error group fixed. If it happens again it comes back on its own.',
  input: z.object({ groupId: fid('err') }),
  run(ctx, i) { run(ctx.db, 'UPDATE error_groups SET resolved_at = ? WHERE id = ? AND org_id = ?', now(), i.groupId, ctx.orgId); return { resolved: true }; },
});

// One sentence per error group, for suggestions and the UI.
export function sentence(g: { service: string; kind: string; message: string; frame?: string | null; lastHour: number; firstDeploy?: number | null }) {
  return `${g.service}: ${g.kind}${g.frame ? ` in ${g.frame}` : ''} — "${g.message.slice(0, 120)}" (${g.lastHour}× in the last hour${g.firstDeploy ? `, since deploy #${g.firstDeploy}` : ''})`;
}
