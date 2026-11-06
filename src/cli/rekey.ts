// `unit7 vault rekey`: a new master key for everything in the vault. Use it when a copy of the old key may
// exist anywhere (a key file left on disk, a backup of the Mac, a synced folder): afterwards that copy opens
// nothing in this database. Unit7 must be stopped, so nothing writes while every secret is re-wrapped.
import { randomBytes } from 'node:crypto';
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db.ts';
import { Vault, keychain, loadMasterKey } from '../vault.ts';
import { unit7Home, loadConfig } from './client.ts';
import { healthy } from './service.ts';

export async function rekey() {
  if (process.env.UNIT7_MASTER_KEY || process.env.UNIT7_MASTER_PASSPHRASE) {
    throw new Error('Your master key comes from UNIT7_MASTER_KEY / UNIT7_MASTER_PASSPHRASE. Rotate it where you keep it; Unit7 can only rekey a key it stores itself.');
  }
  const home = unit7Home();
  const url = loadConfig()?.url ?? 'http://127.0.0.1:4800';
  if (await healthy(url)) throw new Error('Unit7 is running. Stop it first (unit7 service stop), then run this again.');
  const db = openDb(join(home, 'unit7.db'));
  const next = randomBytes(32);
  // the new key goes to disk first: if anything stops halfway, it's here and nothing is lost
  const pending = join(home, 'master.key.next');
  writeFileSync(pending, next, { mode: 0o600, flag: 'wx' });
  new Vault(db, loadMasterKey(home)).rekey(next);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); // the old wrapped keys leave the write-ahead log too
  db.close();
  if (keychain.usable(home)) { keychain.set(home, next); unlinkSync(pending); } else renameSync(pending, join(home, 'master.key'));
  const old = ['master.key.pre-keychain', 'master.key.bak'].map((f) => join(home, f)).filter(existsSync);
  console.log('✓ Every secret is now sealed under a new master key. Sign in to the web app again.');
  if (old.length) console.log(`Old key copies open nothing any more; you can delete them:\n${old.map((f) => `  ${f}`).join('\n')}`);
}
