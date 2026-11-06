// Unit7's state: one SQLite file (node:sqlite, WAL). Every tenant-owned row carries org_id, and
// every query that touches one filters on it — tenant isolation is a WHERE clause, tested in
// test/security.test.ts.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// before the rename the default home was ~/.forge and the database forge.db: an install that only has
// the old names keeps using them
const legacy = (now: string, old: string) => (!existsSync(now) && existsSync(old) ? old : now);
export const UNIT7_HOME = process.env.UNIT7_HOME || legacy(join(homedir(), '.unit7'), join(homedir(), '.forge'));
export const dbPath = (home: string) => legacy(join(home, 'unit7.db'), join(home, 'forge.db'));

export type DB = DatabaseSync & { cache?: Map<string, StatementSync> };
type P = SQLInputValue;

export const id = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const now = () => new Date().toISOString();

export function openDb(file = dbPath(UNIT7_HOME)): DB {
  if (file !== ':memory:') {
    // a relative path (like "undefined/unit7.db" from an unset home) would quietly start a second,
    // empty Unit7 in whatever folder the process runs from
    if (!isAbsolute(file)) throw new Error(`Unit7's database path must be absolute, got "${file}". Check UNIT7_HOME.`);
    // Everything Unit7 keeps (database, logs, uploads, backup copies) is its owner's alone: other accounts on this
    // computer get nothing, whatever mode an older version or a copy left behind.
    process.umask(0o077);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const mine = (f: string) => statSync(f).uid === process.getuid?.();
    if (mine(dirname(file))) chmodSync(dirname(file), 0o700);
    else console.warn(`Note: ${dirname(file)} belongs to another user, so Unit7 can't make it private. Use a folder of your own for UNIT7_HOME.`);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f) && mine(f)) chmodSync(f, 0o600);
  }
  const db: DB = new DatabaseSync(file);
  // secure_delete: a deleted credential is overwritten, not left readable in free pages of the file
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;');
  migrate(db);
  return db;
}

const stmt = (db: DB, sql: string) => {
  db.cache ??= new Map();
  let s = db.cache.get(sql);
  if (!s) db.cache.set(sql, (s = db.prepare(sql)));
  return s;
};
export const get = <T>(db: DB, sql: string, ...p: P[]) => stmt(db, sql).get(...p) as T | undefined;
export const all = <T>(db: DB, sql: string, ...p: P[]) => stmt(db, sql).all(...p) as T[];
export const run = (db: DB, sql: string, ...p: P[]) => stmt(db, sql).run(...p);

// node:sqlite has no transaction helper. Savepoints nest, so tx() inside tx() is fine.
// fn must be synchronous: never hold a transaction across an await.
let depth = 0;
export function tx<T>(db: DB, fn: () => T): T {
  const sp = `sp${depth++}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const r = fn();
    db.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  } finally {
    depth--;
  }
}

export const json = <T>(s: unknown, fallback: T): T => (typeof s === 'string' && s ? (JSON.parse(s) as T) : fallback);

const TS = `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// Append-only. user_version tracks how many have run.
const MIGRATIONS = [
  `
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
    password_hash TEXT, created_at ${TS});
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at ${TS});
  CREATE TABLE memberships (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    role TEXT NOT NULL, created_at ${TS}, PRIMARY KEY (org_id, user_id));
  CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
    expires_at TEXT NOT NULL, ip TEXT, user_agent TEXT, created_at ${TS});
  CREATE TABLE api_tokens (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
    name TEXT NOT NULL, prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, created_at ${TS});
  CREATE TABLE passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE, public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0, transports TEXT, name TEXT, created_at ${TS}, last_used_at TEXT);
  CREATE TABLE invites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT, created_at ${TS});

  CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, name TEXT NOT NULL, slug TEXT NOT NULL,
    description TEXT, repo TEXT, created_at ${TS}, UNIQUE (org_id, slug));
  CREATE TABLE environments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects ON DELETE CASCADE,
    name TEXT NOT NULL, slug TEXT NOT NULL, kind TEXT NOT NULL, autonomy INTEGER NOT NULL, rules TEXT NOT NULL DEFAULT '{}',
    created_at ${TS}, UNIQUE (project_id, slug));
  -- an identity at a provider: "Cloudflare / Client A"
  CREATE TABLE accounts (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, provider TEXT NOT NULL, name TEXT NOT NULL,
    slug TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'unverified', verified_at TEXT, created_at ${TS},
    UNIQUE (org_id, provider, slug));
  -- which identity an environment uses at each provider; never guessed
  CREATE TABLE environment_accounts (environment_id TEXT NOT NULL REFERENCES environments ON DELETE CASCADE, provider TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts ON DELETE CASCADE, PRIMARY KEY (environment_id, provider));
  -- the Context Vault: envelope-encrypted, versioned; the newest unretired version is current
  CREATE TABLE secrets (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, ref TEXT NOT NULL, version INTEGER NOT NULL,
    kind TEXT NOT NULL, account_id TEXT REFERENCES accounts ON DELETE SET NULL, ciphertext BLOB NOT NULL, wrapped_key BLOB NOT NULL,
    hint TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at ${TS}, retired_at TEXT, last_used_at TEXT,
    UNIQUE (org_id, ref, version));

  CREATE TABLE servers (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, name TEXT NOT NULL, host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL DEFAULT 'root', key_ref TEXT NOT NULL, host_key TEXT,
    account_id TEXT REFERENCES accounts ON DELETE SET NULL, provider_ref TEXT, status TEXT NOT NULL DEFAULT 'new',
    facts TEXT NOT NULL DEFAULT '{}', last_seen_at TEXT, created_at ${TS}, UNIQUE (org_id, name));
  -- apps, workers and databases are all services; kind says which
  CREATE TABLE services (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects ON DELETE CASCADE,
    environment_id TEXT NOT NULL REFERENCES environments ON DELETE CASCADE, server_id TEXT REFERENCES servers ON DELETE SET NULL,
    name TEXT NOT NULL, slug TEXT NOT NULL, kind TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'new',
    current_deployment_id TEXT, created_at ${TS}, UNIQUE (environment_id, slug));
  CREATE TABLE deployments (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, service_id TEXT NOT NULL REFERENCES services ON DELETE CASCADE,
    number INTEGER NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL DEFAULT '{}', plan TEXT NOT NULL DEFAULT '{}', image TEXT, container TEXT,
    log TEXT NOT NULL DEFAULT '', error TEXT, triggered_by TEXT, rollback_of TEXT, started_at ${TS}, finished_at TEXT,
    UNIQUE (service_id, number));
  CREATE TABLE domains (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, hostname TEXT NOT NULL UNIQUE COLLATE NOCASE,
    service_id TEXT REFERENCES services ON DELETE SET NULL, account_id TEXT REFERENCES accounts ON DELETE SET NULL, zone TEXT,
    status TEXT NOT NULL DEFAULT 'pending', tls TEXT NOT NULL DEFAULT 'pending', checked_at TEXT, detail TEXT, created_at ${TS});
  -- scope_type: org | project | environment | service. A value is either envelope-encrypted here or
  -- a credential:// reference resolved at deploy time. Versions are kept; deleted_at hides a key.
  CREATE TABLE env_vars (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
    key TEXT NOT NULL, version INTEGER NOT NULL, secret INTEGER NOT NULL, ciphertext BLOB, wrapped_key BLOB, ref TEXT, hint TEXT NOT NULL,
    created_by TEXT, created_at ${TS}, deleted_at TEXT, UNIQUE (scope_type, scope_id, key, version));

  CREATE TABLE backups (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, service_id TEXT REFERENCES services ON DELETE SET NULL, kind TEXT NOT NULL,
    reason TEXT NOT NULL, location TEXT, size INTEGER, checksum TEXT, status TEXT NOT NULL, error TEXT, verified_at TEXT,
    created_at ${TS}, finished_at TEXT);
  CREATE TABLE backup_schedules (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, service_id TEXT NOT NULL REFERENCES services ON DELETE CASCADE,
    frequency TEXT NOT NULL, keep INTEGER NOT NULL DEFAULT 7, last_run_at TEXT, created_at ${TS}, UNIQUE (service_id, frequency));
  CREATE TABLE metrics (server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, at TEXT NOT NULL, cpu REAL, mem_used INTEGER, mem_total INTEGER,
    disk_used INTEGER, disk_total INTEGER, load1 REAL, containers TEXT);
  CREATE INDEX metrics_server_at ON metrics (server_id, at);

  CREATE TABLE events (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL,
    project_id TEXT, environment_id TEXT, resource TEXT, data TEXT NOT NULL DEFAULT '{}', handled_at TEXT, created_at ${TS});
  CREATE INDEX events_org ON events (org_id, created_at);
  CREATE TABLE audit (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL, agent TEXT,
    user_id TEXT, project_id TEXT, environment_id TEXT, tool TEXT NOT NULL, action TEXT NOT NULL, risk TEXT NOT NULL, reason TEXT,
    input TEXT NOT NULL DEFAULT '{}', output TEXT, result TEXT NOT NULL, error TEXT, duration_ms INTEGER, resources TEXT NOT NULL DEFAULT '[]',
    approval_id TEXT, created_at ${TS});
  CREATE INDEX audit_org ON audit (org_id, created_at);
  CREATE TABLE approvals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, reason TEXT, why TEXT NOT NULL,
    actor TEXT NOT NULL, environment_id TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT, result TEXT,
    expires_at TEXT NOT NULL, created_at ${TS});

  CREATE TABLE conversations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL, project_id TEXT,
    agent_session TEXT, created_at ${TS}, updated_at ${TS});
  CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations ON DELETE CASCADE, role TEXT NOT NULL,
    content TEXT NOT NULL, created_at ${TS});
  -- project memory: facts the agent learned ("Client A's API runs on srv-2"). Infra state lives in the real tables.
  CREATE TABLE memories (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT, content TEXT NOT NULL, source TEXT, created_at ${TS});
  CREATE TABLE incidents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT, environment_id TEXT, title TEXT NOT NULL,
    status TEXT NOT NULL, severity TEXT NOT NULL, trigger_event TEXT, timeline TEXT NOT NULL DEFAULT '[]', root_cause TEXT, remediation TEXT,
    report TEXT, created_at ${TS}, resolved_at TEXT);
  `,
  // org-wide resources (servers, accounts) follow the org's own autonomy and rules
  `
  ALTER TABLE orgs ADD COLUMN autonomy INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE orgs ADD COLUMN rules TEXT NOT NULL DEFAULT '{}';
  `,
  // source tarballs uploaded by `unit7 deploy` (a folder, no git needed)
  `
  CREATE TABLE uploads (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, path TEXT NOT NULL, size INTEGER NOT NULL,
    sha256 TEXT NOT NULL, created_by TEXT, created_at ${TS});
  ALTER TABLE domains ADD COLUMN tls_mode TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE domains ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  `,
  // which Claude model Unit7's own agent uses (owners pick it in Settings)
  `ALTER TABLE orgs ADD COLUMN agent_model TEXT;`,
  // which brain Unit7's AI used to use (no longer read; kept so old databases still migrate)
  `ALTER TABLE orgs ADD COLUMN agent_backend TEXT;`,
  // per-site traffic, summarised from Caddy's access log every 30s (Warden's load and error rules)
  `CREATE TABLE traffic (server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, hostname TEXT NOT NULL, at TEXT NOT NULL,
     requests INTEGER NOT NULL, errors INTEGER NOT NULL, p95_ms INTEGER NOT NULL, static_hits INTEGER NOT NULL, static_uncached INTEGER NOT NULL);
   CREATE INDEX traffic_host_at ON traffic(hostname, at);`,
  // the inbox: a request typed in the web UI that your own AI (Claude Code, over MCP) picks up and does
  // user_id: who asked. A watcher only answers its own person's requests (and Warden's incidents), so
  // one person's Claude subscription never serves someone else.
  `CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     conversation_id TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
     user_id TEXT NOT NULL, claimed_by TEXT, created_at ${TS}, claimed_at TEXT, done_at TEXT);
   CREATE INDEX agent_tasks_pending ON agent_tasks(org_id, status, created_at);`,
  // a backup proven by restoring it into a throwaway database (weekly, and on demand)
  `ALTER TABLE backups ADD COLUMN verify_ok INTEGER;
   ALTER TABLE backups ADD COLUMN verify_note TEXT;`, // verified_at was already in the schema, unused until now
  // errors from app logs, grouped by fingerprint (type + normalised message + first frame in your code)
  `CREATE TABLE error_groups (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     service_id TEXT NOT NULL REFERENCES services ON DELETE CASCADE, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
     message TEXT NOT NULL, frame TEXT, sample TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
     first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, first_deploy INTEGER, resolved_at TEXT,
     UNIQUE (service_id, fingerprint));
   CREATE TABLE error_hits (group_id TEXT NOT NULL REFERENCES error_groups ON DELETE CASCADE, at TEXT NOT NULL, n INTEGER NOT NULL);
   CREATE INDEX error_hits_group_at ON error_hits(group_id, at);`,
  // the Autopilot kill switch: while set, AI actors (Warden, Unit7's AI, agent tokens) can't change anything
  `ALTER TABLE orgs ADD COLUMN paused_at TEXT;`,
  // scheduled jobs: a command run once on a schedule, in a one-off container from the app's image
  `CREATE TABLE jobs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     service_id TEXT NOT NULL REFERENCES services ON DELETE CASCADE, name TEXT NOT NULL, schedule TEXT NOT NULL,
     command TEXT NOT NULL, last_run_at TEXT, last_status TEXT, last_output TEXT, last_ms INTEGER, created_at ${TS},
     UNIQUE (service_id, name));`,
  // a domain points at a target anywhere (an app here, a Vercel project…); records = what DNS must say
  `ALTER TABLE domains ADD COLUMN target TEXT;
   ALTER TABLE domains ADD COLUMN records TEXT;`,
  // links: one thing wired to another (a database to an app, an API to a website), across providers.
  // vars = the settings Unit7 put on the consumer: key, where its value lives, and a fingerprint of it
  `CREATE TABLE links (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     source TEXT NOT NULL, target TEXT NOT NULL, vars TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'ok',
     detail TEXT, checked_at TEXT, created_at ${TS});`,
  // the map: everything a sync found across every connected account (apps, sites, databases, servers,
  // domains) and how they point at each other. scan_cache keeps each account's last good scan, so one
  // expired token doesn't erase its part of the map.
  `CREATE TABLE scan_cache (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, scope TEXT NOT NULL,
     found TEXT NOT NULL, refs TEXT NOT NULL, ok INTEGER NOT NULL, note TEXT, at TEXT NOT NULL, PRIMARY KEY (org_id, scope));
   CREATE TABLE assets (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, account_id TEXT,
     provider TEXT NOT NULL, kind TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT, meta TEXT NOT NULL DEFAULT '{}',
     seen_at TEXT NOT NULL, UNIQUE (org_id, provider, ext_id));
   CREATE TABLE edges (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, source TEXT NOT NULL,
     target TEXT NOT NULL, kind TEXT NOT NULL, via TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ok', detail TEXT,
     UNIQUE (org_id, source, target, kind, via));
   CREATE TABLE sync_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, started_at TEXT NOT NULL,
     finished_at TEXT, status TEXT NOT NULL DEFAULT 'running', summary TEXT NOT NULL DEFAULT '{}');`,
  // off-server backup copies: where each one went (this computer, a bucket), and the org's switch
  `ALTER TABLE backups ADD COLUMN offsite TEXT;
   ALTER TABLE orgs ADD COLUMN offsite TEXT NOT NULL DEFAULT 'on';`,
  // a folder a desktop app syncs (Google Drive, iCloud Drive, Dropbox, OneDrive): copies go there too
  `ALTER TABLE orgs ADD COLUMN backup_folder TEXT;`,
  // outside checks on everything on the map: sites answering, certificates, registrations, email protection
  `CREATE TABLE watch (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, host TEXT NOT NULL, kind TEXT NOT NULL,
     status TEXT NOT NULL, detail TEXT, streak INTEGER NOT NULL DEFAULT 0, ms INTEGER, last_ok TEXT, checked_at TEXT,
     value TEXT, asset TEXT, alerted TEXT, PRIMARY KEY (org_id, host, kind));`,
  // earned autonomy: an environment's level moves with the record of what AI did there (a person's switch, with a ceiling)
  `ALTER TABLE environments ADD COLUMN earn INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE environments ADD COLUMN earn_cap INTEGER;
   ALTER TABLE environments ADD COLUMN earn_changed_at TEXT;
   ALTER TABLE environments ADD COLUMN earn_note TEXT;`,
  // secret rotation: when each connection's key last changed (and until when the old one is still accepted),
  // and how often the organisation wants keys and database passwords changed (days; 0 = never)
  `ALTER TABLE links ADD COLUMN rotated_at TEXT;
   ALTER TABLE links ADD COLUMN previous_until TEXT;
   ALTER TABLE orgs ADD COLUMN rotate_links_days INTEGER NOT NULL DEFAULT 90;
   ALTER TABLE orgs ADD COLUMN rotate_db_days INTEGER NOT NULL DEFAULT 0;`,
  // errors from apps on other hosts, grouped like local ones; and how far each app's logs have been read
  `CREATE TABLE remote_errors (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, asset TEXT NOT NULL, fingerprint TEXT NOT NULL,
     kind TEXT NOT NULL, message TEXT NOT NULL, frame TEXT, sample TEXT, count INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL,
     last_seen TEXT NOT NULL, alerted_at TEXT, PRIMARY KEY (org_id, asset, fingerprint));
   CREATE TABLE log_cursors (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, asset TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (org_id, asset));`,
  // a monthly budget across providers, and the costs last read (converted into the budget's currency)
  `ALTER TABLE orgs ADD COLUMN budget_monthly REAL;
   ALTER TABLE orgs ADD COLUMN budget_currency TEXT NOT NULL DEFAULT 'USD';
   ALTER TABLE orgs ADD COLUMN budget_actions TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE orgs ADD COLUMN budget_manual TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE orgs ADD COLUMN budget_alerted TEXT;
   CREATE TABLE costs (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, provider TEXT NOT NULL, account TEXT NOT NULL, label TEXT NOT NULL,
     amount REAL NOT NULL, currency TEXT NOT NULL, kind TEXT NOT NULL, original TEXT, at TEXT NOT NULL);`,
  // why Unit7 has stopped signing in to a server until a person changes something ('key' | 'host_key')
  `ALTER TABLE servers ADD COLUMN ssh_block TEXT;`,
  // a provider said "slow down": background work for the account waits until then
  `ALTER TABLE accounts ADD COLUMN pause_until TEXT;`,
  // built-in things were tagged 'forge' before the rename
  `UPDATE assets SET provider = 'unit7' WHERE provider = 'forge';
   UPDATE assets SET meta = replace(replace(meta, '"kind":"forge"', '"kind":"unit7"'), '"platform":"forge"', '"platform":"unit7"');
   UPDATE scan_cache SET scope = 'unit7' WHERE scope = 'forge';
   UPDATE scan_cache SET found = replace(replace(replace(found, '"provider":"forge"', '"provider":"unit7"'), '"platform":"forge"', '"platform":"unit7"'), '"kind":"forge"', '"kind":"unit7"');
   UPDATE links SET source = replace(source, '"kind":"forge"', '"kind":"unit7"'), target = replace(target, '"kind":"forge"', '"kind":"unit7"');
   UPDATE domains SET target = replace(target, '"kind":"forge"', '"kind":"unit7"');
   UPDATE api_tokens SET name = replace(name, 'Forge connect · ', 'Unit7 connect · ');`,
  // how often Warden syncs the map by itself: '15m' | '1h' | '6h' | '1d' | 'off'
  `ALTER TABLE orgs ADD COLUMN sync_every TEXT NOT NULL DEFAULT '6h';`,
  // the member whose own Claude subscription / Google account ('claude' | 'gemini') answers their ask box:
  // a subscription is one person's, so at most one member per account on this Unit7
  `ALTER TABLE memberships ADD COLUMN brain TEXT;
   CREATE UNIQUE INDEX memberships_brain ON memberships (brain) WHERE brain IS NOT NULL;`,
  // security check reports (findings with their fixes, newest kept), and the weekly check's switch
  `CREATE TABLE security_reports (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT,
     by TEXT NOT NULL, score INTEGER NOT NULL, counts TEXT NOT NULL, findings TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '[]',
     fresh TEXT NOT NULL DEFAULT '[]', ms INTEGER, created_at ${TS});
   CREATE INDEX security_reports_org ON security_reports (org_id, created_at);
   ALTER TABLE orgs ADD COLUMN security_weekly INTEGER NOT NULL DEFAULT 1;`,
  // server X-rays: everything found on a server, grouped into projects (kind 'fast'), and the slower disk sizes
  // ('deep'). Every run is kept (ok = 0 with a note when it failed), so the last good one is always there.
  // A server's monthly price (from you, or its provider) splits into a cost per project.
  `CREATE TABLE xrays (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'fast', ok INTEGER NOT NULL,
     note TEXT, ms INTEGER, data TEXT NOT NULL DEFAULT '{}', created_at ${TS});
   CREATE INDEX xrays_server ON xrays (server_id, kind, created_at);
   ALTER TABLE servers ADD COLUMN monthly_price REAL;
   ALTER TABLE servers ADD COLUMN price_currency TEXT;
   ALTER TABLE servers ADD COLUMN price_source TEXT;`,
  // the watch: usage history per server and project (5-minute, hourly and daily rollups), each traffic and log
  // check's summary with what it found, what's open or was cleared (unusual jumps, traffic, risks) with when
  // it was alerted and investigated, and each organisation's watch settings
  `CREATE TABLE usage_points (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE,
     scope TEXT NOT NULL, name TEXT NOT NULL, res TEXT NOT NULL, at TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1,
     cpu REAL, cpu_max REAL, mem REAL, mem_max REAL, net REAL, net_max REAL, restarts INTEGER NOT NULL DEFAULT 0, oom INTEGER NOT NULL DEFAULT 0, disk REAL,
     PRIMARY KEY (server_id, scope, res, at));
   CREATE INDEX usage_points_res ON usage_points (res, at);
   CREATE TABLE traffic_windows (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, at TEXT NOT NULL, minutes INTEGER NOT NULL,
     summary TEXT NOT NULL DEFAULT '{}', findings TEXT NOT NULL DEFAULT '[]');
   CREATE INDEX traffic_windows_server ON traffic_windows (server_id, at);
   CREATE TABLE watch_alerts (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, source TEXT NOT NULL, key TEXT NOT NULL, severity TEXT NOT NULL,
     title TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', first_at TEXT NOT NULL, last_at TEXT NOT NULL, cleared_at TEXT,
     alerted_at TEXT, incident_id TEXT, conversation_id TEXT);
   CREATE INDEX watch_alerts_server ON watch_alerts (server_id, source, cleared_at);
   ALTER TABLE orgs ADD COLUMN watch TEXT NOT NULL DEFAULT '{}';`,
  // changes Unit7 made to things on a server, each with how to take it back (status: done = can be undone, undone,
  // rolled_back = its health check failed and Unit7 put it back, kept = nothing to undo, e.g. a fresh backup);
  // and the things on a server a person adopted (trust moves up from what the X-ray could tell)
  `CREATE TABLE changes (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, part TEXT NOT NULL, verb TEXT NOT NULL, summary TEXT NOT NULL,
     undo TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'done', actor TEXT, note TEXT, undone_at TEXT, created_at ${TS});
   CREATE INDEX changes_server ON changes (server_id, created_at);
   CREATE TABLE part_trust (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE,
     part TEXT NOT NULL, trust TEXT NOT NULL, by TEXT NOT NULL, created_at ${TS}, PRIMARY KEY (server_id, part));`,
  // archived: things a person keeps but Unit7 stops looking at (no watch, alerts, suggestions or changes). key is a map
  // asset id (ast_…, stable across syncs) or a Unit7 project id (prj_…); name/kind/provider say what it was if it leaves the map
  `CREATE TABLE archived (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
     provider TEXT, by TEXT, created_at ${TS}, PRIMARY KEY (org_id, key));`,
  // "Let Unit7 fix it" from a phone alert: each button offered (single use, expiring), the investigation it started as the
  // person who tapped it, the one fix it proposed and how that went (status: offered, looking, proposed, fixing, fixed,
  // failed, declined, no_fix); and each month's cost total, so the cost radar can say how this month compares
  `CREATE TABLE care_fixes (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, account_id TEXT NOT NULL,
     user_id TEXT NOT NULL, problem TEXT NOT NULL, type TEXT NOT NULL, resource TEXT, title TEXT NOT NULL, message TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'offered', conversation_id TEXT, via TEXT, approval_id TEXT, outcome TEXT,
     expires_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, created_at ${TS});
   CREATE INDEX care_fixes_problem ON care_fixes (org_id, problem, started_at);
   CREATE TABLE cost_months (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, month TEXT NOT NULL, total REAL NOT NULL,
     currency TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL, PRIMARY KEY (org_id, month));`,
  // products: things across providers that are one product (a site, its database, its domain, a Coolify app), one name and
  // one health everywhere. A member is a map asset id (ast_…, stable across syncs, so a re-scan keeps it) or a Unit7 project
  // id (prj_…), in at most one product. group_skips: what a person said doesn't belong (a member they took out: ref = the
  // product, key = the thing; a suggestion they turned down or a product they ungrouped: ref = its sug_ id), never suggested again.
  // clients: who the person builds for. A client owns products, projects and things (each at most one client; none = the
  // person's own), and may have a status page on one of the person's servers (status: on, server, domain, what it shows,
  // when it was last pushed; the link's token lives in the vault).
  `CREATE TABLE product_groups (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, name TEXT NOT NULL,
     auto INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at ${TS});
   CREATE TABLE group_members (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL,
     group_id TEXT NOT NULL REFERENCES product_groups ON DELETE CASCADE, reason TEXT, created_at ${TS}, PRIMARY KEY (org_id, key));
   CREATE INDEX group_members_group ON group_members (group_id);
   CREATE TABLE group_skips (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, ref TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
     created_at ${TS}, PRIMARY KEY (org_id, ref, key));
   CREATE TABLE clients (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, name TEXT NOT NULL COLLATE NOCASE,
     color TEXT, logo TEXT, contact TEXT, status TEXT NOT NULL DEFAULT '{}', created_at ${TS}, UNIQUE (org_id, name));
   CREATE TABLE client_members (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL,
     client_id TEXT NOT NULL REFERENCES clients ON DELETE CASCADE, created_at ${TS}, PRIMARY KEY (org_id, key));`,
  // saved routines: a list of tool steps or an ask, on a schedule in plain words, run as their owner; each run kept
  // with its steps' results (waiting = the approval it waits on, at_step = the step that waits)
  `CREATE TABLE routines (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, owner_id TEXT NOT NULL,
     name TEXT NOT NULL, kind TEXT NOT NULL, ask TEXT, steps TEXT NOT NULL DEFAULT '[]', schedule TEXT NOT NULL, tz TEXT,
     scope TEXT NOT NULL DEFAULT '[]', report TEXT NOT NULL DEFAULT '["activity"]', paused_at TEXT, paused_why TEXT,
     fails INTEGER NOT NULL DEFAULT 0, next_at TEXT, last_at TEXT, last_status TEXT, last_summary TEXT, created_at ${TS}, updated_at ${TS});
   CREATE INDEX routines_due ON routines (next_at);
   CREATE TABLE routine_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     routine_id TEXT NOT NULL REFERENCES routines ON DELETE CASCADE, why TEXT NOT NULL, status TEXT NOT NULL, summary TEXT,
     steps TEXT NOT NULL DEFAULT '[]', waiting TEXT, at_step INTEGER, conversation_id TEXT, started_at ${TS}, finished_at TEXT);
   CREATE INDEX routine_runs_routine ON routine_runs (routine_id, started_at);`,
  // made: test copies (kind staging, key = the project id or coolify:<server>:<app>) and add-ons (kind addon, key =
  // <server>:<add-on>) Unit7 set up, with what each step made, so they can be shown and taken down again
  `CREATE TABLE made (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, kind TEXT NOT NULL, key TEXT NOT NULL,
     data TEXT NOT NULL DEFAULT '{}', created_at ${TS}, UNIQUE (org_id, kind, key));`,
  // a phone fix's "propose only" window, kept with the fix (survives a restart; as long as its inbox request lives);
  // which AI session (token) claimed an inbox request, so its calls belong to that conversation; who wrote a routine's ask
  `ALTER TABLE care_fixes ADD COLUMN look_until TEXT;
   ALTER TABLE agent_tasks ADD COLUMN claimed_token TEXT;
   ALTER TABLE routines ADD COLUMN ask_by TEXT;`,
  // changes that aren't on a server (a DNS record removed, a cloud machine stopped) keep their undo in changes too, so
  // Activity's Undo works for them: server_id may be empty. The table is copied as it is (SQLite can't drop NOT NULL).
  `CREATE TABLE changes_new (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     server_id TEXT REFERENCES servers ON DELETE CASCADE, part TEXT NOT NULL, verb TEXT NOT NULL, summary TEXT NOT NULL,
     undo TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'done', actor TEXT, note TEXT, undone_at TEXT, created_at ${TS});
   INSERT INTO changes_new (id, org_id, server_id, part, verb, summary, undo, status, actor, note, undone_at, created_at)
     SELECT id, org_id, server_id, part, verb, summary, undo, status, actor, note, undone_at, created_at FROM changes;
   DROP TABLE changes;
   ALTER TABLE changes_new RENAME TO changes;
   CREATE INDEX changes_server ON changes (server_id, created_at);
   CREATE INDEX changes_org ON changes (org_id, created_at);`,
  // Warden's own fixes (tools/autofix.ts): each safe fix it ran by itself, with its undo (status: applied, asked = a rule
  // made it wait for a person, failed), and the switch per organisation; restart windows per server (tools/reboot.ts): days
  // (0 = Sunday) and start on the server's clock, its UTC offset as it last said, who set it (their OK for restarts inside
  // it), and which window was warned about and tried (window start, ms)
  `CREATE TABLE autofixes (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT,
     finding TEXT NOT NULL, title TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, undo TEXT NOT NULL DEFAULT '{}',
     status TEXT NOT NULL, audit_id TEXT, created_at ${TS});
   CREATE INDEX autofixes_org ON autofixes (org_id, created_at);
   ALTER TABLE orgs ADD COLUMN autofix INTEGER NOT NULL DEFAULT 1;
   CREATE TABLE reboot_windows (server_id TEXT PRIMARY KEY REFERENCES servers ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     days TEXT NOT NULL, start TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 60, utc_offset INTEGER, set_by TEXT,
     warned_for INTEGER, warned_at TEXT, tried_for INTEGER, last_reboot_at TEXT, last_result TEXT, created_at ${TS});`,
  // kept: what a person said is in use (asset.keep), keyed like archived (a map asset id or a Unit7 project id): never
  // suggested for archiving or deleting again; important = also handled with extra care (an AI asks before changing it)
  `CREATE TABLE kept (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
     provider TEXT, important INTEGER NOT NULL DEFAULT 0, note TEXT, by TEXT, created_at ${TS}, PRIMARY KEY (org_id, key));`,
  // snoozes: "This is fine" on a finding, alert or suggestion, keyed by its stable id. until NULL = for good (a person
  // said it's fine; reason is theirs). Past until, it shows again, marked "back"; cleared_at = brought back by hand.
  // backups of databases Unit7 found on a server but doesn't run itself (a Coolify Supabase, a Compose Postgres): the
  // backups table gains where they came from (server_id, part), and their own daily schedules
  `CREATE TABLE snoozes (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL, until TEXT, reason TEXT,
     title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', days INTEGER, by TEXT, created_at ${TS}, cleared_at TEXT, PRIMARY KEY (org_id, key));
   ALTER TABLE backups ADD COLUMN server_id TEXT;
   ALTER TABLE backups ADD COLUMN part TEXT;
   CREATE TABLE part_backup_schedules (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, part TEXT NOT NULL, name TEXT NOT NULL, engine TEXT NOT NULL,
     frequency TEXT NOT NULL DEFAULT 'daily', keep INTEGER NOT NULL DEFAULT 7, last_run_at TEXT, created_by TEXT, created_at ${TS}, UNIQUE (server_id, part));`,
  // how serious a hidden thing was when a person hid it: one that comes back worse shows again
  `ALTER TABLE snoozes ADD COLUMN severity TEXT;`,
  // many servers (src/fleet): an app's placement. services.server_id stays its main server (it builds, runs migrations and,
  // with a front proxy, takes every visitor); service_targets lists every server it runs on, the main one included (role
  // primary), with its place in rotation (in; out = a person took it out; sick = taken out by its health) and the
  // deployment it runs there. fleets: how visitors are spread (front proxy or DNS) and the private port of the app on the
  // other servers. fleet_runs: a rolling release, lane by lane, so it can be paused, continued or cancelled. fleet_net:
  // each server's address on the private network (WireGuard, or the provider's own) and its WireGuard public key (the
  // private key never leaves the server).
  `CREATE TABLE service_targets (service_id TEXT NOT NULL REFERENCES services ON DELETE CASCADE, server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE,
     org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'replica', weight INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'in',
     deployment_id TEXT, health TEXT, checked_at TEXT, added_at ${TS}, PRIMARY KEY (service_id, server_id));
   CREATE INDEX service_targets_server ON service_targets (server_id);
   CREATE TABLE fleets (service_id TEXT PRIMARY KEY REFERENCES services ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     mode TEXT NOT NULL DEFAULT 'front', why TEXT, edge_port INTEGER, created_at ${TS});
   CREATE TABLE fleet_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, service_id TEXT NOT NULL REFERENCES services ON DELETE CASCADE,
     status TEXT NOT NULL, batch INTEGER NOT NULL DEFAULT 1, lanes TEXT NOT NULL DEFAULT '[]', error TEXT, by TEXT, created_at ${TS}, finished_at TEXT);
   CREATE INDEX fleet_runs_service ON fleet_runs (service_id, created_at);
   CREATE TABLE fleet_net (server_id TEXT PRIMARY KEY REFERENCES servers ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     kind TEXT NOT NULL, address TEXT NOT NULL, public_key TEXT, endpoint TEXT, created_at ${TS});`,
  // zero-downtime proof (src/deploy/release.ts): what the proxy saw while traffic moved to this deployment. NULL = not
  // measured (first deploy, or the proxy's log couldn't be read), never a made-up 0.
  `ALTER TABLE deployments ADD COLUMN downtime_seconds REAL;
   ALTER TABLE deployments ADD COLUMN failed_requests INTEGER;`,
  // keep it fresh (src/fresh): automatic updates with proof. orgs.fresh: the defaults (how far updates go, the weekly
  // report). fresh_scans: each app's last look at its libraries, advisories and base image. fresh_batches: one batch of
  // updates (weekly, an emergency security fix, a major version, a rebuild, a server's patches, a Coolify image) with its
  // steps (Find → Apply → Test → Staging → Check → Accept → Release → Watch) and what happened. fresh_holds: a library or
  // an app held back, or a freeze window (starts set) when nothing updates.
  `ALTER TABLE orgs ADD COLUMN fresh TEXT NOT NULL DEFAULT '{}';
   CREATE TABLE fresh_scans (service_id TEXT PRIMARY KEY REFERENCES services ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
   CREATE TABLE fresh_batches (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, service_id TEXT REFERENCES services ON DELETE CASCADE,
     server_id TEXT REFERENCES servers ON DELETE CASCADE, kind TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
     items TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL DEFAULT '{}', why TEXT, by TEXT, created_at ${TS}, finished_at TEXT);
   CREATE INDEX fresh_batches_service ON fresh_batches (service_id, created_at);
   CREATE INDEX fresh_batches_org ON fresh_batches (org_id, created_at);
   CREATE TABLE fresh_holds (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, service_id TEXT REFERENCES services ON DELETE CASCADE,
     package TEXT, starts TEXT, until TEXT, reason TEXT, by TEXT, created_at ${TS});`,
  // many servers, part two (src/fleet): canaries: a new version tried on a share of visitors by weight (share, the steps,
  // the hold per step, the old and new copies, a point per look for the two lines). dr_standbys: a warm copy of an app on
  // a second server (role standby in service_targets), its databases' copies there, how often their data is refreshed,
  // the last refresh and the last drill.
  `CREATE TABLE canaries (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, service_id TEXT NOT NULL REFERENCES services ON DELETE CASCADE,
     status TEXT NOT NULL, share INTEGER NOT NULL, steps TEXT NOT NULL DEFAULT '[]', step INTEGER NOT NULL DEFAULT 0, hold_minutes INTEGER NOT NULL DEFAULT 5,
     from_deployment_id TEXT, deployment_id TEXT, old_containers TEXT NOT NULL DEFAULT '[]', new_containers TEXT NOT NULL DEFAULT '[]', step_at TEXT,
     points TEXT NOT NULL DEFAULT '[]', health_fails INTEGER NOT NULL DEFAULT 0, reason TEXT, by TEXT, created_at ${TS}, finished_at TEXT);
   CREATE INDEX canaries_service ON canaries (service_id, created_at);
   CREATE TABLE dr_standbys (service_id TEXT PRIMARY KEY REFERENCES services ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE,
     server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, status TEXT NOT NULL, hours INTEGER NOT NULL DEFAULT 6, dbs TEXT NOT NULL DEFAULT '[]',
     refreshed_at TEXT, data_at TEXT, refresh_error TEXT, drill TEXT, failover_at TEXT, dns TEXT, by TEXT, created_at ${TS});`,
  // V2. watch_gaps: when Unit7 wasn't watching (src/sentinel/gaps.ts). instance: a few values for this install. Warden's
  // own repeated reads no longer keep their full output (one call was 83% of a real database), so the old ones go too.
  `CREATE TABLE watch_gaps (from_at TEXT NOT NULL, to_at TEXT NOT NULL);
   CREATE INDEX watch_gaps_to ON watch_gaps (to_at);
   CREATE TABLE instance (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   ALTER TABLE security_reports ADD COLUMN coverage TEXT;
   UPDATE audit SET output = NULL WHERE actor_id = 'warden' AND risk = 'read';`,
  // V2, the Safety Net (src/care/safetynet.ts): on by default, a person's say on what's important, what Coolify keeps by
  // itself, and each ladder it ran. checkups: every Check-up as a record with a link (src/care/checkup.ts).
  `ALTER TABLE orgs ADD COLUMN safety_net INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE orgs ADD COLUMN safety TEXT NOT NULL DEFAULT '{}';
   CREATE TABLE safety_marks (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL, important INTEGER NOT NULL, by TEXT, at TEXT NOT NULL, PRIMARY KEY (org_id, key));
   CREATE TABLE coolify_backups_seen (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, part TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0, last_ok TEXT, off_server INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, PRIMARY KEY (server_id, part));
   CREATE TABLE safety_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT, part TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
     steps TEXT NOT NULL DEFAULT '[]', why TEXT, created_at ${TS}, finished_at TEXT);
   CREATE INDEX safety_runs_part ON safety_runs (org_id, part, created_at);
   CREATE TABLE checkups (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, by TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'all', level TEXT NOT NULL, line TEXT NOT NULL,
     data TEXT NOT NULL DEFAULT '{}', ms INTEGER, created_at ${TS});
   CREATE INDEX checkups_org ON checkups (org_id, created_at);
   CREATE TABLE deploys_seen (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, uuid TEXT NOT NULL, name TEXT NOT NULL, deployment TEXT NOT NULL,
     status TEXT NOT NULL, commit_sha TEXT, project TEXT, at TEXT NOT NULL, PRIMARY KEY (server_id, uuid, deployment));
   CREATE INDEX deploys_seen_org ON deploys_seen (org_id, at);
   ALTER TABLE api_tokens ADD COLUMN scope TEXT;
   CREATE TABLE findings (id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL, server_id TEXT, part TEXT, status TEXT NOT NULL DEFAULT 'open', record TEXT NOT NULL,
     sent_at TEXT, sent_to TEXT, deployed_at TEXT, checked_at TEXT, after_value REAL, win TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, id), UNIQUE (org_id, key));
   CREATE INDEX findings_status ON findings (org_id, status, updated_at);
   CREATE TABLE builders (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, app TEXT NOT NULL, repo TEXT, target TEXT, lovable TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, app));
   CREATE TABLE inspect_signals (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT NOT NULL, key TEXT NOT NULL, detector TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, windows INTEGER NOT NULL DEFAULT 1, hours TEXT NOT NULL DEFAULT '[]', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (org_id, key));
   CREATE TABLE finding_points (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, finding_id TEXT NOT NULL, at TEXT NOT NULL, calls INTEGER NOT NULL, requests INTEGER NOT NULL, minutes INTEGER NOT NULL);
   CREATE INDEX finding_points_at ON finding_points (org_id, finding_id, at);
   CREATE TABLE pg_snapshots (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT NOT NULL, part TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (server_id, part));
   CREATE TABLE image_scans (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT NOT NULL REFERENCES servers ON DELETE CASCADE, image TEXT NOT NULL, report TEXT NOT NULL, scanned_at TEXT NOT NULL, PRIMARY KEY (server_id, image));`,
  // V2, always on: which servers have an Outpost, and how far Unit7 has read it (src/outpost)
  `CREATE TABLE outposts (server_id TEXT PRIMARY KEY REFERENCES servers ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, version TEXT NOT NULL, installed_at TEXT NOT NULL, synced_at TEXT);`,
  // V2: rules in plain words, Right or Wrong, fixes learned, written investigations, and notes on incidents and projects
  `CREATE TABLE plain_rules (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, text TEXT NOT NULL, name TEXT NOT NULL, when_json TEXT NOT NULL, tz TEXT, by TEXT NOT NULL, at TEXT NOT NULL);
   CREATE TABLE judgements (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL, kind TEXT NOT NULL, was_right INTEGER NOT NULL, why TEXT, by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (org_id, key));
   CREATE TABLE playbooks (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, kind TEXT NOT NULL, tool TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (org_id, kind, tool));
   CREATE TABLE investigations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, title TEXT NOT NULL, about TEXT, status TEXT NOT NULL, ideas TEXT NOT NULL DEFAULT '[]', conclusion TEXT, sure INTEGER, opinion TEXT, by TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT);
   ALTER TABLE incidents ADD COLUMN notes TEXT;
   ALTER TABLE routines ADD COLUMN on_event TEXT;
   ALTER TABLE routines ADD COLUMN stop_at TEXT;
   ALTER TABLE memories ADD COLUMN about TEXT;
   ALTER TABLE memories ADD COLUMN expires_at TEXT;`,
  // V2, deep security: what each server looked like the first time, rotate-this lists, fire drills
  `CREATE TABLE server_baseline (server_id TEXT PRIMARY KEY REFERENCES servers ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, data TEXT NOT NULL, at TEXT NOT NULL);
   CREATE TABLE breach_lists (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, provider TEXT NOT NULL, items TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE fire_drills (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, server_id TEXT NOT NULL, part TEXT NOT NULL, name TEXT NOT NULL, minutes INTEGER NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);`,
  // V2, ready for everyone: an audit chain and the commands each action ran, deletes that wait, and a badge
  `ALTER TABLE audit ADD COLUMN chain TEXT;
   ALTER TABLE audit ADD COLUMN prev_chain TEXT;
   ALTER TABLE audit ADD COLUMN commands TEXT;
   ALTER TABLE orgs ADD COLUMN badge_token TEXT;
   CREATE TABLE held_deletes (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, approval_id TEXT NOT NULL, tool TEXT NOT NULL, actor TEXT NOT NULL, by TEXT NOT NULL, run_at TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);`,
  // V2.1, Seven (src/seven): its settings, each shift, each thing it did or asked, and what the person told it.
  // An install that upgrades already runs real things, so Seven starts off there: a person reads what it would do, then turns it on.
  `ALTER TABLE orgs ADD COLUMN seven TEXT NOT NULL DEFAULT '{}';
   UPDATE orgs SET seven = '{"on":false}';
   CREATE TABLE seven_shifts (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, trigger TEXT NOT NULL, why TEXT, status TEXT NOT NULL DEFAULT 'running', brain TEXT NOT NULL DEFAULT 'rules', line TEXT, level TEXT,
     notes TEXT NOT NULL DEFAULT '[]', thoughts TEXT NOT NULL DEFAULT '[]', fingerprint TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, started_at ${TS}, finished_at TEXT);
   CREATE INDEX seven_shifts_org ON seven_shifts (org_id, started_at);
   CREATE TABLE seven_actions (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, shift_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL, because TEXT, why TEXT NOT NULL, expect TEXT, status TEXT NOT NULL,
     result TEXT, approval_id TEXT, by_who TEXT NOT NULL, created_at ${TS}, updated_at ${TS});
   CREATE INDEX seven_actions_org ON seven_actions (org_id, status, updated_at);
   CREATE INDEX seven_actions_approval ON seven_actions (approval_id);
   CREATE TABLE seven_memory (org_id TEXT NOT NULL REFERENCES orgs ON DELETE CASCADE, key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (org_id, key));`,
];

export function migrate(db: DB) {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
