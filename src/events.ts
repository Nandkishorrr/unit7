// Everything that happens becomes an event: persisted (so the incident agent and the activity feed
// can read history) and pushed live to subscribers (SSE in the UI, the event reactor). `live`
// events — progress lines, log chunks, agent tokens — are pushed but not stored.
import { type DB, id, run } from './db.ts';

export type Severity = 'info' | 'success' | 'warning' | 'critical';
export interface Unit7Event {
  id: string; org_id: string; type: string; severity: Severity; message: string;
  project_id?: string | null; environment_id?: string | null; resource?: string | null;
  data: Record<string, unknown>; created_at: string; live?: boolean;
}
type Listener = (e: Unit7Event) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  emit(orgId: string, type: string, message: string, o: {
    severity?: Severity; projectId?: string | null; environmentId?: string | null; resource?: string | null;
    data?: Record<string, unknown>; live?: boolean;
  } = {}): Unit7Event {
    const e: Unit7Event = {
      id: id('evt'), org_id: orgId, type, severity: o.severity ?? 'info', message,
      project_id: o.projectId ?? null, environment_id: o.environmentId ?? null, resource: o.resource ?? null,
      data: o.data ?? {}, created_at: new Date().toISOString(), live: o.live,
    };
    if (!o.live) {
      run(this.db, `INSERT INTO events (id, org_id, type, severity, message, project_id, environment_id, resource, data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, e.id, orgId, type, e.severity, message, e.project_id ?? null, e.environment_id ?? null,
        e.resource ?? null, JSON.stringify(e.data), e.created_at);
    }
    for (const l of this.listeners) {
      try { l(e); } catch (err) { console.error('event listener failed', err); }
    }
    return e;
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
