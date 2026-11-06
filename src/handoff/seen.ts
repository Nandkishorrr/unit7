// What later check-ups saw, for the "is it gone?" fix check.
import { all, json, type DB } from '../db.ts';

export const checkupsSince = (db: DB, orgId: string, at: string) => all<{ data: string }>(db, 'SELECT data FROM checkups WHERE org_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 5', orgId, at).map((r) => json<{ items?: { id: string }[] }>(r.data, {}));
export const itemsOf = (c: { items?: { id: string }[] }) => new Set((c.items ?? []).map((i) => i.id));
