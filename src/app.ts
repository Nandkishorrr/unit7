// The composition root: one App per process, handed to every tool and route.
import { join } from 'node:path';
import { type DB, openDb, UNIT7_HOME, dbPath } from './db.ts';
import { Vault, loadMasterKey } from './vault.ts';
import { EventBus } from './events.ts';

export interface App {
  db: DB;
  vault: Vault;
  events: EventBus;
  home: string;
  // filled by later modules (ssh pool, provider clients) so tools reach them without globals
  services: Record<string, unknown>;
}

export function createApp(o: { dbFile?: string; home?: string; masterKey?: Buffer } = {}): App {
  const home = o.home ?? UNIT7_HOME;
  const db = openDb(o.dbFile ?? dbPath(home));
  return { db, vault: new Vault(db, o.masterKey ?? loadMasterKey(home)), events: new EventBus(db), home, services: {} };
}
