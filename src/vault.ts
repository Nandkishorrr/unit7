// The Context Vault. Secrets are envelope-encrypted: each version gets its own random data key
// (AES-256-GCM), and that data key is wrapped with the key-encryption key derived from the master
// key. Both ciphertexts are bound (GCM additional data) to org + reference + version, so a row
// copied into another tenant or onto another reference fails to decrypt instead of leaking.
//
// The model never sees a value. Tools take `credential://provider/account/name` references and
// the broker (Ctx.secret in tools/runtime.ts) resolves them inside the execution that needs them.
import { randomBytes, createCipheriv, createDecipheriv, createHmac, hkdfSync, argon2Sync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { type DB, UNIT7_HOME, all, get, id, now, run, tx } from './db.ts';
import { Unit7Error, notFound } from './errors.ts';

const REF = /^credential:\/\/([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9._-]{0,127})$/;

export interface Ref { provider: string; account: string; name: string }
export function parseRef(ref: string): Ref {
  const m = REF.exec(ref);
  if (!m) throw new Unit7Error('bad_reference', `"${ref}" is not a credential reference. They look like credential://provider/account/name.`);
  return { provider: m[1]!, account: m[2]!, name: m[3]! };
}
export const isRef = (s: string) => REF.test(s);
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'default';
// The context a variable's value is sealed under (its row identity), so a value can't be moved to another row
export const envContext = (r: { scope_type: string; scope_id: string; key: string; version: number }) =>
  `env:${r.scope_type}:${r.scope_id}:${r.key}:${r.version}`;

export const makeRef = (provider: string, account: string, name: string) => {
  const ref = `credential://${slugify(provider)}/${slugify(account)}/${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 128)}`;
  parseRef(ref);
  return ref;
};

// Where the master key comes from, in order: UNIT7_MASTER_KEY (base64, 32 bytes, for hosts with a
// real secret store), UNIT7_MASTER_PASSPHRASE (argon2id, salt kept next to the DB), the macOS
// Keychain on a Mac (one item per Unit7 home, like Safari's or Chrome's own keys), or a random key
// file created once with 0600 permissions. A Mac with an old key file moves it into the Keychain.
const loaded = new Map<string, Buffer>(); // the env key is read once (then removed), so later loads reuse it
export function loadMasterKey(home = UNIT7_HOME): Buffer {
  const had = loaded.get(home);
  if (had) return had;
  const k = readMasterKey(home);
  loaded.set(home, k);
  return k;
}
function readMasterKey(home: string): Buffer {
  const env = process.env.UNIT7_MASTER_KEY;
  delete process.env.UNIT7_MASTER_KEY; // read once; children (git, gh, ssh…) never inherit it
  if (env) {
    const k = Buffer.from(env, 'base64');
    if (k.length !== 32) throw new Unit7Error('bad_master_key', 'UNIT7_MASTER_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');
    return k;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const pass = process.env.UNIT7_MASTER_PASSPHRASE;
  delete process.env.UNIT7_MASTER_PASSPHRASE;
  if (pass) {
    const saltFile = join(home, 'master.salt');
    if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16), { mode: 0o600 });
    return argon2Sync('argon2id', { message: pass, nonce: readFileSync(saltFile), parallelism: 4, tagLength: 32, memory: 65536, passes: 3 });
  }
  const file = join(home, 'master.key');
  if (keychain.usable(home)) return fromKeychain(home, file);
  return readKeyFile(file, true);
}

function readKeyFile(file: string, create: boolean): Buffer {
  if (create && !existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  if ((statSync(file).mode & 0o077) !== 0) throw new Unit7Error('master_key_exposed', `${file} is readable by other users. Run: chmod 600 "${file}"`);
  const k = readFileSync(file);
  if (k.length !== 32) throw new Unit7Error('bad_master_key', `${file} is not a 32-byte key.`);
  return k;
}

function fromKeychain(home: string, file: string): Buffer {
  const stored = keychain.get(home);
  const onDisk = existsSync(file) ? readKeyFile(file, false) : undefined;
  if (stored) {
    if (onDisk && !onDisk.equals(stored)) throw new Unit7Error('master_key_conflict', `The Keychain and ${file} hold different Unit7 keys. Move one away and restart.`);
    if (onDisk) unlinkSync(file); // a migration that stopped before cleaning up
    return stored;
  }
  const key = onDisk ?? randomBytes(32);
  keychain.set(home, key);
  if (!keychain.get(home)?.equals(key)) throw new Unit7Error('keychain_failed', 'Unit7 could not save its key in the macOS Keychain. Set UNIT7_KEYCHAIN=off to keep it in a file.');
  if (onDisk) unlinkSync(file); // only after the Keychain copy reads back identical
  return key;
}

// macOS Keychain through Apple's own `security` tool. The value goes in over stdin (`security -i`),
// never on a command line where `ps` could see it.
const LEGACY_SERVICE = 'dev.forge.vault';
function readItem(service: string, home: string): Buffer | undefined {
  try {
    const k = Buffer.from(execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', home, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'base64');
    return k.length === 32 ? k : undefined;
  } catch { return undefined; }
}
export const keychain = {
  service: 'dev.unit7.vault',
  usable: (home: string) => process.platform === 'darwin' && process.env.UNIT7_KEYCHAIN !== 'off' && !/["\\\n]/.test(home),
  get(home: string): Buffer | undefined {
    const k = readItem(keychain.service, home);
    if (k) return k;
    // a key saved before the rename: under the old item name, for this folder or for it under its old name
    for (const account of [home, home.replace(/\.unit7$/, '.forge')]) {
      const old = readItem(LEGACY_SERVICE, account);
      if (old) { keychain.set(home, old); return old; } // copied, never moved: the old item stays as a backup
    }
    return undefined;
  },
  set(home: string, key: Buffer) {
    execFileSync('/usr/bin/security', ['-i'], { input: `add-generic-password -U -s ${keychain.service} -a "${home}" -l "Unit7 vault key" -j "Encrypts the secrets in ${home}" -w ${key.toString('base64')}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
  },
};

const V1 = 1;
function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from([V1]), iv, c.getAuthTag(), ct]);
}
function unseal(key: Buffer, blob: Uint8Array, aad: string): Buffer {
  const b = Buffer.from(blob);
  if (b[0] !== V1) throw new Unit7Error('vault_format', 'This secret was written by a newer Unit7.', 500);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(1, 13)).setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(13, 29));
  try {
    return Buffer.concat([d.update(b.subarray(29)), d.final()]);
  } catch {
    throw new Unit7Error('vault_tampered', 'A secret failed its integrity check — it was altered or moved. It cannot be used.', 500);
  }
}

// what anyone may see about a secret
const hintOf = (v: string) => (v.length >= 16 ? `…${v.slice(-4)}` : '••••••');

export interface SecretMeta {
  ref: string; version: number; kind: string; account_id: string | null; hint: string;
  meta: string; created_by: string | null; created_at: string; last_used_at: string | null;
}

export class Vault {
  private kek: Buffer;
  private db: DB;
  private bindKey: Buffer;
  constructor(db: DB, master: Buffer) {
    this.db = db;
    this.kek = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'forge/vault/kek/v1', 32));
    this.bindKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'forge/session/bind/v1', 32));
  }

  // The second half of a browser session: the web app keeps it in its own (port-scoped) storage and sends it
  // as a header. Cookies on localhost go to every port, so a cookie alone is not enough to be signed in.
  bindTag(sessionToken: string) { return createHmac('sha256', this.bindKey).update(sessionToken).digest('base64url'); }

  put(orgId: string, ref: string, value: string, o: { kind?: string; accountId?: string | null; meta?: object; by?: string } = {}) {
    parseRef(ref);
    if (!value) throw new Unit7Error('empty_secret', 'A secret needs a value.');
    return tx(this.db, () => {
      const prev = get<{ v: number | null }>(this.db, 'SELECT max(version) v FROM secrets WHERE org_id = ? AND ref = ?', orgId, ref);
      const version = (prev?.v ?? 0) + 1;
      const aad = `${orgId}\n${ref}\n${version}`;
      const dek = randomBytes(32);
      run(this.db, `UPDATE secrets SET retired_at = ? WHERE org_id = ? AND ref = ? AND retired_at IS NULL`, now(), orgId, ref);
      run(this.db,
        `INSERT INTO secrets (id, org_id, ref, version, kind, account_id, ciphertext, wrapped_key, hint, meta, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id('sec'), orgId, ref, version, o.kind ?? 'secret', o.accountId ?? null,
        seal(dek, Buffer.from(value, 'utf8'), aad), seal(this.kek, dek, aad), hintOf(value), JSON.stringify(o.meta ?? {}), o.by ?? null);
      // OAuth tokens refresh every few minutes; keep only the last two retired versions
      if (o.kind === 'oauth') run(this.db, `DELETE FROM secrets WHERE org_id = ? AND ref = ? AND retired_at IS NOT NULL AND version < ?`, orgId, ref, version - 2);
      return { ref, version };
    });
  }

  // A rotated-away credential is kept a while so a bad rotation can be undone, then deleted for good (with
  // secure_delete, overwritten): after `days`, only the newest `keep` old versions of each credential remain.
  purgeRetired(days = 30, keep = 2) {
    return Number(run(this.db, `DELETE FROM secrets WHERE retired_at IS NOT NULL AND retired_at < ? AND version <= (
      SELECT max(version) FROM secrets s WHERE s.org_id = secrets.org_id AND s.ref = secrets.ref) - 1 - ?`,
      new Date(Date.now() - days * 86400_000).toISOString(), keep).changes);
  }

  // Only the broker calls this. Everything else gets metadata.
  resolve(orgId: string, ref: string): string {
    const row = get<{ id: string; version: number; ciphertext: Uint8Array; wrapped_key: Uint8Array }>(this.db,
      'SELECT id, version, ciphertext, wrapped_key FROM secrets WHERE org_id = ? AND ref = ? AND retired_at IS NULL', orgId, ref);
    if (!row) throw notFound(`The credential ${ref}`);
    const aad = `${orgId}\n${ref}\n${row.version}`;
    const value = unseal(unseal(this.kek, row.wrapped_key, aad), row.ciphertext, aad).toString('utf8');
    run(this.db, 'UPDATE secrets SET last_used_at = ? WHERE id = ?', now(), row.id);
    return value;
  }

  has(orgId: string, ref: string) {
    return !!get(this.db, 'SELECT 1 FROM secrets WHERE org_id = ? AND ref = ? AND retired_at IS NULL', orgId, ref);
  }

  meta(orgId: string, ref: string) {
    return get<SecretMeta>(this.db,
      `SELECT ref, version, kind, account_id, hint, meta, created_by, created_at, last_used_at FROM secrets
       WHERE org_id = ? AND ref = ? AND retired_at IS NULL`, orgId, ref);
  }

  list(orgId: string, prefix = 'credential://') {
    return all<SecretMeta>(this.db,
      `SELECT ref, version, kind, account_id, hint, meta, created_by, created_at, last_used_at FROM secrets
       WHERE org_id = ? AND retired_at IS NULL AND substr(ref, 1, length(?)) = ? ORDER BY ref`, orgId, prefix, prefix);
  }

  history(orgId: string, ref: string) {
    return all<{ version: number; hint: string; created_by: string | null; created_at: string; retired_at: string | null }>(this.db,
      'SELECT version, hint, created_by, created_at, retired_at FROM secrets WHERE org_id = ? AND ref = ? ORDER BY version DESC', orgId, ref);
  }

  // Retire, don't erase: old versions stay restorable until purged.
  retire(orgId: string, ref: string) {
    const r = run(this.db, 'UPDATE secrets SET retired_at = ? WHERE org_id = ? AND ref = ? AND retired_at IS NULL', now(), orgId, ref);
    if (!r.changes) throw notFound(`The credential ${ref}`);
  }

  // Bring back an older version as the newest one (a rotation that went wrong).
  restore(orgId: string, ref: string, version: number, by?: string) {
    const row = get<{ version: number; ciphertext: Uint8Array; wrapped_key: Uint8Array; kind: string; account_id: string | null; meta: string }>(this.db,
      'SELECT version, ciphertext, wrapped_key, kind, account_id, meta FROM secrets WHERE org_id = ? AND ref = ? AND version = ?', orgId, ref, version);
    if (!row) throw notFound(`Version ${version} of ${ref}`);
    const aad = `${orgId}\n${ref}\n${row.version}`;
    const value = unseal(unseal(this.kek, row.wrapped_key, aad), row.ciphertext, aad).toString('utf8');
    return this.put(orgId, ref, value, { kind: row.kind, accountId: row.account_id, meta: JSON.parse(row.meta), by });
  }

  // Envelope encryption for values that live in other tables (env vars). `context` names the slot
  // (it becomes the additional data), so a value can't be moved to another key or tenant.
  sealValue(orgId: string, context: string, value: string) {
    const aad = `${orgId}\n${context}`;
    const dek = randomBytes(32);
    return { ciphertext: seal(dek, Buffer.from(value, 'utf8'), aad), wrapped: seal(this.kek, dek, aad), hint: hintOf(value) };
  }
  openValue(orgId: string, context: string, ciphertext: Uint8Array, wrapped: Uint8Array) {
    const aad = `${orgId}\n${context}`;
    return unseal(unseal(this.kek, wrapped, aad), ciphertext, aad).toString('utf8');
  }

  // Re-wrap every data key under a new master key: vault secrets, sealed variable values, and the sealed
  // inputs of waiting approvals. Ciphertexts don't change. One transaction: all of it moves, or none.
  rekey(newMaster: Buffer) {
    const next = Buffer.from(hkdfSync('sha256', newMaster, Buffer.alloc(0), 'forge/vault/kek/v1', 32));
    const rewrap = (wrapped: Uint8Array, aad: string) => seal(next, unseal(this.kek, wrapped, aad), aad);
    tx(this.db, () => {
      for (const r of all<{ id: string; org_id: string; ref: string; version: number; wrapped_key: Uint8Array }>(this.db,
        'SELECT id, org_id, ref, version, wrapped_key FROM secrets')) {
        run(this.db, 'UPDATE secrets SET wrapped_key = ? WHERE id = ?', rewrap(r.wrapped_key, `${r.org_id}\n${r.ref}\n${r.version}`), r.id);
      }
      for (const r of all<{ id: string; org_id: string; scope_type: string; scope_id: string; key: string; version: number; wrapped_key: Uint8Array }>(this.db,
        'SELECT id, org_id, scope_type, scope_id, key, version, wrapped_key FROM env_vars WHERE wrapped_key IS NOT NULL')) {
        run(this.db, 'UPDATE env_vars SET wrapped_key = ? WHERE id = ?', rewrap(r.wrapped_key, `${r.org_id}\n${envContext(r)}`), r.id);
      }
      for (const a of all<{ id: string; org_id: string; input: string }>(this.db, `SELECT id, org_id, input FROM approvals WHERE input LIKE '%"__sealed"%'`)) {
        const input = JSON.parse(a.input) as Record<string, unknown>;
        for (const [k, v] of Object.entries(input)) {
          const sealed = (v as { __sealed?: unknown } | null)?.__sealed;
          if (typeof sealed !== 'string') continue;
          const [c, w] = sealed.split('.');
          input[k] = { ...(v as object), __sealed: `${c}.${Buffer.from(rewrap(Buffer.from(w!, 'base64'), `${a.org_id}\napproval:${a.id}:${k}`)).toString('base64')}` };
        }
        run(this.db, 'UPDATE approvals SET input = ? WHERE id = ?', JSON.stringify(input), a.id);
      }
    });
    this.kek = next;
    this.bindKey = Buffer.from(hkdfSync('sha256', newMaster, Buffer.alloc(0), 'forge/session/bind/v1', 32)); // everyone signs in again
  }
}
