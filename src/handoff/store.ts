// Findings with a life of their own: once a person gives one to their AI, or a detector raises one, it's a row that moves from
// Open to Fixed. The fix check never believes anyone's word: it waits for a real deploy, then reads the same numbers again.
import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import { all, get, id, json, now, run, type DB } from '../db.ts';
import { lastXray } from '../tools/xray.ts';
import { parseRepo } from '../connectors/github.ts';
import { checkupsSince, itemsOf } from './seen.ts';
import { judgeMetric, safeRoute, winLine, type Check, type FindingRecord, type Status } from './record.ts';
import type { Inventory, Part } from '../discovery/xray.ts';

export interface Row { id: string; key: string; server_id: string | null; part: string | null; status: Status; record: string; sent_at: string | null; sent_to: string | null; deployed_at: string | null; checked_at: string | null; after_value: number | null; win: string | null; created_at: string; updated_at: string }
export const shortId = (key: string) => { const w = /^[a-z]+/i.exec(key)?.[0]?.slice(0, 8) ?? 'find'; return `${w.toLowerCase()}-${createHash('sha1').update(key).digest('hex').slice(0, 4)}`; };

export function appOf(db: DB, orgId: string, serverId?: string, partRef?: string, name?: string): FindingRecord['app'] {
  const server = serverId ? get<{ name: string }>(db, 'SELECT name FROM servers WHERE id = ?', serverId)?.name : undefined;
  const inv: Inventory | undefined = serverId ? lastXray(db, orgId, serverId)?.data : undefined;
  const p: Part | undefined = inv?.parts.find((x) => x.id === partRef || x.name === partRef);
  const siblings = p ? inv!.parts.filter((x) => x.project && x.project === p.project) : [];
  const repo = p?.coolify?.repo ? parseRepo(p.coolify.repo) : undefined;
  const stack = [...new Set([p?.coolify?.buildPack, ...siblings.map((x) => x.product?.name)].filter((x): x is string => !!x))];
  const builder = get<{ repo: string | null }>(db, 'SELECT repo FROM builders WHERE org_id = ? AND app = ?', orgId, p?.name ?? name ?? '');
  const known = builder?.repo ?? (repo ? `${repo.owner}/${repo.name}` : undefined);
  return { name: p?.name ?? name ?? server ?? 'your app', ...(p && { part: p.id }), ...(serverId && { serverId }), ...(server && { server }), ...(known && { repo: known }), ...(stack.length && { stack }) };
}

// One row per finding key: raising it again refreshes the numbers and leaves its status alone, unless it was fixed and is back
export function saveRecord(db: DB, orgId: string, r: Omit<FindingRecord, 'schema' | 'status' | 'id'> & { id?: string }): FindingRecord {
  const was = get<Row>(db, 'SELECT * FROM findings WHERE org_id = ? AND key = ?', orgId, r.key), at = now();
  const status: Status = was?.status ?? 'open';
  const record: FindingRecord = { schema: 'unit7.finding/1', ...r, id: was?.id ?? r.id ?? shortId(r.key), status };
  if (r.route) record.route = { ...r.route, path: safeRoute(r.route.path) };
  if (was) run(db, 'UPDATE findings SET record = ?, updated_at = ? WHERE id = ? AND org_id = ?', JSON.stringify(record), at, was.id, orgId);
  else run(db, 'INSERT INTO findings (id, org_id, key, server_id, part, status, record, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', record.id, orgId, r.key, r.app.serverId ?? null, r.app.part ?? null, status, JSON.stringify(record), at, at);
  return record;
}
export const readRow = (db: DB, orgId: string, ref: string) => get<Row>(db, 'SELECT * FROM findings WHERE org_id = ? AND (id = ? OR key = ?)', orgId, ref, ref);
export const recordOf = (r: Row): FindingRecord => ({ ...json<FindingRecord>(r.record, {} as FindingRecord), status: r.status });

export function setStatus(db: DB, orgId: string, findingId: string, status: Status, extra: Partial<Pick<Row, 'sent_at' | 'sent_to' | 'deployed_at' | 'checked_at' | 'after_value' | 'win'>> = {}) {
  const f = Object.entries(extra);
  run(db, `UPDATE findings SET status = ?, updated_at = ?${f.map(([k]) => `, ${k} = ?`).join('')} WHERE id = ? AND org_id = ?`, status, now(), ...f.map(([, v]) => v as never), findingId, orgId);
}

export const listFindings = (db: DB, orgId: string, o: { status?: string; limit?: number } = {}) => all<Row>(db, `SELECT * FROM findings WHERE org_id = ? AND (? IS NULL OR status = ?) ORDER BY updated_at DESC LIMIT ?`, orgId, o.status ?? null, o.status ?? null, o.limit ?? 50);

// Deployed since it was sent? A Coolify deploy of that app, or (no app known) any on its server, or a Unit7 deploy.
export function deployedSince(db: DB, orgId: string, r: Pick<Row, 'server_id' | 'part' | 'record'>, since: string): string | undefined {
  const name = recordOf({ ...r, status: 'open' } as Row).app.name;
  const seen = get<{ at: string }>(db, `SELECT at FROM deploys_seen WHERE org_id = ? AND at > ? AND status NOT IN ('failed', 'cancelled', 'cancelled-by-user', 'error') AND (? IS NULL OR server_id = ?) AND (name = ? OR ? IS NULL) ORDER BY at LIMIT 1`, orgId, since, r.server_id, r.server_id, name, r.part);
  if (seen) return seen.at;
  return get<{ at: string }>(db, `SELECT d.started_at at FROM deployments d JOIN services s ON s.id = d.service_id WHERE d.org_id = ? AND d.status = 'live' AND d.started_at > ? AND (? IS NULL OR s.server_id = ?) ORDER BY d.started_at LIMIT 1`, orgId, since, r.server_id, r.server_id)?.at;
}

const HOUR = 3600_000, BACK_DAYS = 7;
export type Metrics = Record<string, (app: App, orgId: string, r: FindingRecord, from: string, to: string) => { value: number; requests: number; hourly?: number } | undefined>;
export const METRICS: Metrics = {};

// One pass. Each state only moves on what's measured: a deploy happened, enough time passed, the numbers say so.
export function fixCheck(app: App, orgId: string, nowMs = Date.now()) {
  const { db } = app, moved: { id: string; status: Status; win?: string }[] = [];
  const emit = (r: FindingRecord, status: Status, message: string, severity: 'success' | 'warning' | 'info' = 'info') => { moved.push({ id: r.id, status, ...(status === 'fixed' && { win: message }) }); app.events.emit(orgId, `finding.${status}`, message, { severity, data: { id: r.id } }); };
  for (const row of all<Row>(db, `SELECT * FROM findings WHERE org_id = ? AND status = 'sent'`, orgId)) {
    const at = deployedSince(db, orgId, row, row.sent_at ?? row.created_at);
    if (!at) continue;
    setStatus(db, orgId, row.id, 'watching', { deployed_at: at });
    emit(recordOf(row), 'watching', `${recordOf(row).app.name} deployed. Unit7 is watching whether it fixed “${recordOf(row).title}”.`);
  }
  for (const row of all<Row>(db, `SELECT * FROM findings WHERE org_id = ? AND status IN ('watching', 'thin')`, orgId)) {
    const r = recordOf(row), c: Check = r.check, from = row.deployed_at ?? row.updated_at, fromMs = Date.parse(from);
    if (nowMs - fromMs < c.holdHours * HOUR) continue;
    if (c.kind === 'metric') {
      const m = METRICS[r.detector]?.(app, orgId, r, from, new Date(nowMs).toISOString());
      if (!m) continue;
      const verdict = judgeMetric(c, m.value, m.requests);
      if (verdict === 'thin') { if (row.status !== 'thin') { setStatus(db, orgId, row.id, 'thin', { checked_at: now(), after_value: m.value }); emit(r, 'thin', `Not enough traffic yet to say whether “${r.title}” is fixed.`); } continue; }
      if (verdict === 'fixed') { const win = winLine(r, m.value, m.hourly); setStatus(db, orgId, row.id, 'fixed', { checked_at: now(), after_value: m.value, win }); emit(r, 'fixed', win, 'success'); }
      else { setStatus(db, orgId, row.id, 'still', { checked_at: now(), after_value: m.value }); emit(r, 'still', `“${r.title}” is still happening after the deploy: ${Math.round(m.value)} now, ${Math.round(c.before ?? 0)} before.`, 'warning'); }
      continue;
    }
    // "is it gone?" needs a check-up that ran after the deploy
    const after = checkupsSince(db, orgId, from);
    if (!after.length) continue;
    const still = after.some((c2) => itemsOf(c2).has(row.key));
    if (still) { setStatus(db, orgId, row.id, 'still', { checked_at: now() }); emit(r, 'still', `“${r.title}” is still there after the deploy.`, 'warning'); }
    else { const win = winLine(r); setStatus(db, orgId, row.id, 'fixed', { checked_at: now(), win }); emit(r, 'fixed', win, 'success'); }
  }
  // a fix has to last: for a week after it, seeing it again reopens it with a link back
  for (const row of all<Row>(db, `SELECT * FROM findings WHERE org_id = ? AND status = 'fixed' AND checked_at > ?`, orgId, new Date(nowMs - BACK_DAYS * 86400_000).toISOString())) {
    if (checkupsSince(db, orgId, row.checked_at!).some((c) => itemsOf(c).has(row.key))) { const r = recordOf(row); setStatus(db, orgId, row.id, 'back', { checked_at: now() }); emit(r, 'back', `“${r.title}” came back after it was fixed.`, 'warning'); }
  }
  return moved;
}
