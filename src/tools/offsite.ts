// Off-server backups. A backup that lives only on its database's server dies with that server, so each
// one is also copied to this computer and, when you set them up, into a folder a desktop app syncs
// (Google Drive, iCloud Drive, Dropbox, OneDrive: no sign-in for Unit7, the app uploads it) and to an
// S3-compatible bucket (R2, B2, S3, Spaces, Wasabi, MinIO). Copies are encrypted here first (AES-256-GCM, a key per organisation
// kept in the vault), so the bucket only ever holds ciphertext. The recovery key decrypts a copy even
// if this computer is gone: `unit7 backup decrypt`.
import { z } from 'zod';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync, readdirSync, copyFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { makeRef } from '../vault.ts';
import { ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { s3, type Bucket } from '../connectors/s3.ts';
import { backupHost } from './backups.ts';
import { serverRow } from './servers.ts';
import { lastXray } from './xray.ts';
import { fid, requireHuman, requireRole } from './helpers.ts';

// --- encryption: "FORGEBK1" + 12-byte IV + ciphertext + 16-byte tag ------------------------------------
const MAGIC = Buffer.from('FORGEBK1');
export async function encryptFile(key: Buffer, input: string, output: string) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  await pipeline(createReadStream(input), c, async function* (src) { yield Buffer.concat([MAGIC, iv]); for await (const chunk of src) yield chunk; yield c.getAuthTag(); }, createWriteStream(output, { mode: 0o600 }));
}
export async function decryptFile(key: Buffer, input: string, output: string) {
  const size = statSync(input).size;
  if (size < 36) throw new Unit7Error('bad_backup', 'That file is too short to be a Unit7 backup.');
  const fd = openSync(input, 'r'), head = Buffer.alloc(20), tag = Buffer.alloc(16);
  readSync(fd, head, 0, 20, 0); readSync(fd, tag, 0, 16, size - 16); closeSync(fd);
  if (!head.subarray(0, 8).equals(MAGIC)) throw new Unit7Error('bad_backup', 'That isn’t a Unit7 backup file.');
  const d = createDecipheriv('aes-256-gcm', key, head.subarray(8, 20));
  d.setAuthTag(tag);
  try { await pipeline(createReadStream(input, { start: 20, end: size - 17 }), d, createWriteStream(output, { mode: 0o600 })); }
  catch { rmSync(output, { force: true }); throw new Unit7Error('bad_backup', 'The backup didn’t decrypt: wrong recovery key, or the file was changed or cut short.'); }
}
const sha256File = async (path: string) => { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); };

// one random key per organisation, kept in the vault (survives a master-key change; shown only as the recovery key)
const KEY_REF = makeRef('forge', 'backups', 'key');
function backupKey(ctx: Ctx): Buffer {
  // only a key that was never made is made: one that fails to decrypt (tampered vault) must stop the copy,
  // not be silently replaced, or every earlier copy becomes unreadable
  if (ctx.app.vault.has(ctx.orgId, KEY_REF)) return Buffer.from(ctx.secret(KEY_REF), 'base64');
  const k = randomBytes(32);
  ctx.app.vault.put(ctx.orgId, KEY_REF, k.toString('base64'), { kind: 'backup_key', by: 'backups' });
  return k;
}

// --- where copies go ------------------------------------------------------------------------------------
interface Offsite { local?: string; folder?: string; folderError?: string; bucket?: { account: string; key: string }; size?: number; at?: string; error?: string }

// Folders that desktop apps keep in sync with the cloud, found on this computer
export function syncFolders(home = process.env.UNIT7_SYNC_HOME ?? homedir()): { kind: string; name: string; path: string; blocked?: boolean }[] { // UNIT7_SYNC_HOME: tests never touch your real Drive
  const out: { kind: string; name: string; path: string; blocked?: boolean }[] = [];
  const dir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const cs = join(home, 'Library', 'CloudStorage');
  if (dir(cs)) for (const d of readdirSync(cs)) {
    const root = join(cs, d);
    if (d.startsWith('GoogleDrive-')) {
      // "My Drive" (or its translation): the one folder that isn't shared drives or other computers
      // macOS refuses a background Unit7 until it's allowed in Privacy & Security: shown, never adopted
      let names: string[];
      try { names = readdirSync(root); } catch { out.push({ kind: 'google-drive', name: `Google Drive (${d.slice(12)})`, path: join(root, 'My Drive'), blocked: true }); continue; }
      const sub = names.filter((x) => !x.startsWith('.') && dir(join(root, x)) && !/^(Shared drives|Other computers|\.shortcut)/i.test(x));
      out.push({ kind: 'google-drive', name: `Google Drive (${d.slice(12)})`, path: join(root, sub.includes('My Drive') ? 'My Drive' : sub[0] ?? '') });
    } else if (d.startsWith('Dropbox')) out.push({ kind: 'dropbox', name: d.replace(/^Dropbox-?/, 'Dropbox ').trim(), path: root });
    else if (d.startsWith('OneDrive')) out.push({ kind: 'onedrive', name: d.replace(/^OneDrive-?/, 'OneDrive ').trim(), path: root });
    else if (d.startsWith('Box')) out.push({ kind: 'box', name: 'Box', path: root });
  }
  const icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (dir(icloud)) out.push({ kind: 'icloud', name: 'iCloud Drive', path: icloud });
  // older apps and other systems
  for (const [kind, name, p] of [['google-drive', 'Google Drive', join(home, 'Google Drive', 'My Drive')], ['google-drive', 'Google Drive', '/Volumes/GoogleDrive/My Drive'], ['dropbox', 'Dropbox', join(home, 'Dropbox')], ['onedrive', 'OneDrive', join(home, 'OneDrive')]] as const)
    if (dir(p) && !out.some((o) => o.path === p)) out.push({ kind, name, path: p });
  return out.filter((o) => o.blocked || dir(o.path));
}
const localDir = (ctx: Ctx, slug: string) => join(ctx.app.home, 'backups', ctx.orgId, slug);
function storage(ctx: Ctx): (Bucket & { accountId: string; name: string; prefix: string }) | undefined {
  const a = get<{ id: string; name: string; meta: string }>(ctx.db, `SELECT id, name, meta FROM accounts WHERE org_id = ? AND provider = 'storage' ORDER BY created_at LIMIT 1`, ctx.orgId);
  if (!a) return undefined;
  const m = json<{ endpoint: string; bucket: string; region: string; accessKeyId: string; prefix?: string }>(a.meta, {} as never);
  const prefix = m.prefix ?? 'forge/';
  return { ...m, prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix, secret: ctx.credentialFor('storage', a.id).value, accountId: a.id, name: a.name };
}
// The synced folder to use. Never chosen (NULL): the first one on this computer, adopted once and
// announced. Stopped by a person (''): none, for good.
export function syncedFolder(ctx: Pick<Ctx, 'db' | 'orgId' | 'emit'>, found = syncFolders): string | undefined {
  const chosen = get<{ backup_folder: string | null }>(ctx.db, 'SELECT backup_folder FROM orgs WHERE id = ?', ctx.orgId)?.backup_folder;
  if (chosen !== null && chosen !== undefined) return chosen || undefined;
  const f = found().find((x) => !x.blocked);
  if (!f) return undefined;
  run(ctx.db, 'UPDATE orgs SET backup_folder = ? WHERE id = ?', f.path, ctx.orgId);
  ctx.emit('backup.folder_auto', `Backups are also kept in ${f.name} (encrypted, in "Unit7 Backups"); its app uploads them. Settings → Backups to stop.`, { severity: 'info' });
  return f.path;
}
const offsiteOn = (ctx: Ctx) => get<{ offsite: string }>(ctx.db, 'SELECT offsite FROM orgs WHERE id = ?', ctx.orgId)?.offsite !== 'off';

// Copy one backup off its server: down to here (checked against the server's checksum), encrypted, and up to the bucket
// whose backup it is: one of Unit7's databases, or one Unit7 found on a server (part.backup), named after it
function backupOwner(ctx: Ctx, b: { service_id: string | null; server_id?: string | null; part?: string | null }) {
  if (b.service_id || !b.server_id || !b.part) return backupHost(ctx, b.service_id!);
  const s = serverRow(ctx, b.server_id);
  const name = get<{ name: string }>(ctx.db, 'SELECT name FROM part_backup_schedules WHERE server_id = ? AND part = ?', s.id, b.part)?.name
    ?? lastXray(ctx.db, ctx.orgId, s.id)?.data.parts.find((p) => p.id === b.part)?.name ?? b.part;
  return { svc: { id: s.id, name, slug: `${s.name}-${name}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 80) }, s };
}

export async function copyOffsite(ctx: Ctx, backupId: string) {
  const b = get<{ service_id: string; server_id: string | null; part: string | null; location: string; checksum: string | null; status: string; offsite: string | null }>(ctx.db, 'SELECT service_id, server_id, part, location, checksum, status, offsite FROM backups WHERE id = ? AND org_id = ?', backupId, ctx.orgId);
  if (!b || b.status !== 'done') throw new Unit7Error('bad_backup', 'Only a finished backup can be copied.', 409);
  const { svc, s } = backupOwner(ctx, b);
  const dir = localDir(ctx, svc.slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const local = join(dir, `${basename(b.location)}.enc`), part = join(dir, `.${backupId}.part`);
  const done: Offsite = {};
  try {
    ctx.progress(`Copying ${svc.name}'s backup off ${s.name}…`);
    await ssh(ctx.app).getFile(s, b.location, part);
    if (b.checksum && (await sha256File(part)) !== b.checksum) throw new Unit7Error('bad_copy', 'The copy doesn’t match the backup on the server (checksum differs).', 502);
    await encryptFile(backupKey(ctx), part, local);
    done.local = local; done.size = statSync(local).size;
    // the synced folder is best effort: a stopped Drive app must not keep the copy out of the bucket
    const folder = syncedFolder(ctx);
    if (folder) {
      try {
        if (!existsSync(folder)) throw new Unit7Error('folder_missing', `The synced folder isn\u2019t there (${folder}). Is the Google Drive / Dropbox app running?`, 409);
        const dest = join(folder, 'Unit7 Backups', get<{ slug: string }>(ctx.db, 'SELECT slug FROM orgs WHERE id = ?', ctx.orgId)!.slug, svc.slug);
        mkdirSync(dest, { recursive: true });
        copyFileSync(local, join(dest, basename(local)));
        done.folder = join(dest, basename(local)); // the desktop app uploads it from here
      } catch (e) {
        done.folderError = (e as Error).message.slice(0, 300);
        ctx.emit('backup.folder_failed', `${svc.name}'s backup didn't go into the synced folder: ${done.folderError.slice(0, 160)}`, { severity: 'warning', resource: svc.id });
      }
    }
    const st = storage(ctx);
    if (st) {
      ctx.progress(`Uploading to ${st.bucket}…`);
      const key = `${st.prefix}${get<{ slug: string }>(ctx.db, 'SELECT slug FROM orgs WHERE id = ?', ctx.orgId)!.slug}/${svc.slug}/${basename(local)}`;
      await s3.put(st, key, local);
      done.bucket = { account: st.accountId, key };
    }
    done.at = now();
    run(ctx.db, 'UPDATE backups SET offsite = ? WHERE id = ?', JSON.stringify(done), backupId);
    ctx.emit('backup.offsite', `${svc.name}'s backup is safe off the server (this computer${done.folder ? ' + synced folder' : ''}${done.bucket ? ` + ${st!.bucket}` : ''})`, { severity: 'success', resource: svc.id });
    return { backupId, thisComputer: true, syncedFolder: done.folder, syncedFolderProblem: done.folderError, bucket: done.bucket ? st!.bucket : undefined, size: done.size };
  } catch (e) {
    run(ctx.db, 'UPDATE backups SET offsite = ? WHERE id = ?', JSON.stringify({ ...done, error: (e as Error).message.slice(0, 300), at: now() }), backupId);
    ctx.emit('backup.offsite_failed', `${svc.name}'s backup couldn't be copied off the server: ${(e as Error).message.slice(0, 160)}`, { severity: 'warning', resource: svc.id });
    throw e;
  } finally { rmSync(part, { force: true }); }
}

// Bring an off-server copy back onto the database's server (its own file is gone, or to prove the copy restores)
export async function fetchToServer(ctx: Ctx, backupId: string, remote?: string, serviceId?: string) {
  const b = get<{ service_id: string; location: string; checksum: string | null; offsite: string | null }>(ctx.db, 'SELECT service_id, location, checksum, offsite FROM backups WHERE id = ? AND org_id = ?', backupId, ctx.orgId);
  const off = json<Offsite>(b?.offsite ?? '{}', {});
  if (!b || (!off.local && !off.folder && !off.bucket)) throw new Unit7Error('no_copy', 'That backup has no off-server copy.', 404);
  const { svc, s } = backupHost(ctx, serviceId ?? b.service_id); // another database's server, when restoring into it
  const dir = localDir(ctx, svc.slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpEnc = join(dir, `.${backupId}.get`), plain = join(dir, `.${backupId}.gz`);
  try {
    // nearest first: this computer, then the synced folder (the app may download it on demand), then the bucket
    let enc = [off.local, off.folder].find((p) => p && existsSync(p));
    if (!enc) {
      const st = storage(ctx);
      if (!st || !off.bucket) throw new Unit7Error('no_copy', 'The copy on this computer is gone and there’s no bucket copy.', 404);
      ctx.progress(`Downloading ${svc.name}'s backup from ${st.bucket}…`);
      await s3.get(st, off.bucket.key, tmpEnc);
      enc = tmpEnc;
    }
    await decryptFile(backupKey(ctx), enc, plain);
    if (b.checksum && (await sha256File(plain)) !== b.checksum) throw new Unit7Error('bad_copy', 'The off-server copy doesn’t match the original backup.', 502);
    const target = remote ?? b.location;
    ctx.progress(`Putting the backup back on ${s.name}…`);
    await ssh(ctx.app).check(s, script('mkdir -p "$(dirname "$1")"', target), { what: 'Preparing' });
    await ssh(ctx.app).putFile(s, plain, target);
    return target;
  } finally { rmSync(tmpEnc, { force: true }); rmSync(plain, { force: true }); }
}

export async function removeOffsite(ctx: Ctx, offsite: string | null) {
  const off = json<Offsite>(offsite ?? '{}', {});
  for (const p of [off.local, off.folder]) if (p) rmSync(p, { force: true });
  const st = off.bucket && storage(ctx);
  if (st && off.bucket) await s3.del(st, off.bucket.key).catch(() => undefined);
}

// --- tools ---------------------------------------------------------------------------------------------

defineTool({
  name: 'backup.offsite_copy', title: 'Copy a backup off its server', risk: 'write', action: 'backup', green: true, timeoutMs: 60 * 60_000,
  description: 'Copy a backup off its database’s server: to this computer and (if connected) your bucket, encrypted. Unit7 does this after every backup by itself; use this to retry one.',
  input: z.object({ backupId: fid('bak') }),
  run: (ctx, i) => copyOffsite(ctx, i.backupId),
});

defineTool({
  name: 'backup.storage_connect', title: 'Connect backup storage', risk: 'write', action: 'vault_write', sensitive: ['secretKey'], peopleOnly: true, timeoutMs: 60_000,
  description: 'Connect an S3-compatible bucket for off-server backup copies (Cloudflare R2, Backblaze B2, AWS S3, DigitalOcean Spaces, Wasabi, MinIO). People only: the secret is typed into Unit7, never into a chat. Unit7 proves it works with a test write.',
  input: z.object({ endpoint: z.string().url().max(300), bucket: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]+$/), region: z.string().max(40).default('auto'),
    accessKey: z.string().min(8).max(200), secretKey: z.string().min(8).max(500), prefix: z.string().max(100).regex(/^[\w./-]*$/).default('unit7/') }),
  async run(ctx, i) {
    requireHuman(ctx, 'connect backup storage');
    const b: Bucket = { endpoint: i.endpoint.replace(/\/+$/, ''), bucket: i.bucket, region: i.region, accessKeyId: i.accessKey, secret: i.secretKey };
    ctx.redactor.add(i.secretKey, 'storage secret');
    await s3.test(b);
    const name = `${new URL(b.endpoint).hostname.split('.').slice(-2, -1)[0] ?? 'Storage'} · ${i.bucket}`;
    const ref = makeRef('storage', i.bucket, 'secret');
    const accountId = id('acc');
    run(ctx.db, `DELETE FROM accounts WHERE org_id = ? AND provider = 'storage'`, ctx.orgId); // one bucket at a time
    run(ctx.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status, verified_at) VALUES (?, ?, 'storage', ?, ?, ?, 'verified', ?)`,
      accountId, ctx.orgId, name, i.bucket, JSON.stringify({ ref, endpoint: b.endpoint, bucket: i.bucket, region: i.region, accessKeyId: i.accessKey, prefix: i.prefix }), now());
    ctx.app.vault.put(ctx.orgId, ref, i.secretKey, { kind: 'api_token', accountId, by: ctx.actor.name });
    ctx.emit('account.connected', `Backup storage connected: ${i.bucket}`, { severity: 'success', resource: accountId });
    return { connected: name, note: 'New backups now also go to this bucket, encrypted. Older ones: run backup.offsite_copy, or wait for the next backup.' };
  },
});

defineTool({
  name: 'backup.storage', title: 'Where backups are kept', risk: 'read', action: 'read',
  description: 'Where off-server backup copies go (this computer, your bucket), how many there are and how big, and whether it’s on.',
  input: z.object({}),
  run(ctx) {
    const dir = join(ctx.app.home, 'backups', ctx.orgId);
    let files = 0, bytes = 0;
    const walk = (d: string) => { if (!existsSync(d)) return; for (const f of readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(join(d, f.name)); else if (f.name.endsWith('.enc')) { files++; bytes += statSync(join(d, f.name)).size; } } };
    walk(dir);
    const st = get<{ name: string; meta: string }>(ctx.db, `SELECT name, meta FROM accounts WHERE org_id = ? AND provider = 'storage' LIMIT 1`, ctx.orgId);
    const failing = all<{ id: string }>(ctx.db, `SELECT id FROM backups WHERE org_id = ? AND status = 'done' AND json_extract(offsite, '$.error') IS NOT NULL AND created_at > ?`, ctx.orgId, new Date(Date.now() - 7 * 86400_000).toISOString()).length;
    const folder = get<{ backup_folder: string | null }>(ctx.db, 'SELECT backup_folder FROM orgs WHERE id = ?', ctx.orgId)?.backup_folder || undefined;
    return { on: offsiteOn(ctx), thisComputer: { folder: dir, copies: files, megabytes: Math.round(bytes / 1048576) },
      syncedFolder: folder ? { path: folder, name: syncFolders().find((f) => folder.startsWith(f.path))?.name ?? basename(folder), there: existsSync(folder) } : null, foundFolders: syncFolders(), bucket: st ? { name: st.name, endpoint: json<{ endpoint: string }>(st.meta, { endpoint: '' }).endpoint } : null, failedThisWeek: failing };
  },
});

defineTool({
  name: 'backup.folder_set', title: 'Copy backups into a synced folder', risk: 'write', action: 'backup', peopleOnly: true,
  description: 'Choose the folder a desktop app syncs to the cloud (Google Drive, iCloud Drive, Dropbox, OneDrive) where every encrypted backup copy also goes: no sign-in for Unit7, the app uploads it. Unit7 uses the first one it finds by itself; this picks another, or stops (no path). People only.',
  input: z.object({ path: z.string().max(1000).optional() }),
  run(ctx, i) {
    requireHuman(ctx, 'choose where backups go');
    if (!i.path) { run(ctx.db, `UPDATE orgs SET backup_folder = '' WHERE id = ?`, ctx.orgId); return { syncedFolder: null }; } // '' = stopped, never re-adopted
    const p = resolve(i.path);
    if (!isAbsolute(i.path) || !existsSync(p) || !statSync(p).isDirectory()) throw new Unit7Error('bad_folder', `${i.path} isn\u2019t a folder on this computer.`, 400);
    if (p === '/' || /^\/(etc|usr|bin|sbin|System|Library|private\/etc)(\/|$)/.test(p) || p.startsWith(ctx.app.home)) throw new Unit7Error('bad_folder', 'Pick a folder of your own (a synced one like Google Drive), not a system or Unit7 folder.', 400);
    try { const t = join(p, `.unit7-write-test-${process.pid}`); writeFileSync(t, 'ok'); unlinkSync(t); } catch { throw new Unit7Error('bad_folder', `Unit7 can\u2019t write to ${i.path}.`, 400); }
    run(ctx.db, 'UPDATE orgs SET backup_folder = ? WHERE id = ?', p, ctx.orgId);
    return { syncedFolder: p, note: 'New backups also go here (in "Unit7 Backups"), encrypted; the desktop app uploads them. Older ones: backup.offsite_copy.' };
  },
});

defineTool({
  name: 'backup.offsite_set', title: 'Off-server copies on or off', risk: 'write', action: 'backup', peopleOnly: true,
  description: 'Turn off-server backup copies on (the default) or off for this organisation.',
  input: z.object({ on: z.boolean() }),
  run(ctx, i) { run(ctx.db, 'UPDATE orgs SET offsite = ? WHERE id = ?', i.on ? 'on' : 'off', ctx.orgId); return { on: i.on }; },
});

defineTool({
  name: 'backup.recovery_key', title: 'Backup recovery key', risk: 'read', action: 'secret_reveal',
  description: 'The key that decrypts off-server backup copies, for your password manager: with it, `unit7 backup decrypt` restores a copy even if this computer is lost. People only (owners and admins).',
  input: z.object({}),
  run(ctx) {
    requireHuman(ctx, 'see the backup recovery key');
    requireRole(ctx, ['owner', 'admin'], 'see the backup recovery key');
    ctx.emit('secret.revealed', `${ctx.actor.name} viewed the backup recovery key`, { severity: 'warning' });
    // shown only to the person who asked, never kept in the audit log (the runtime's reveal rule)
    return { recoveryKey: { __reveal: backupKey(ctx).toString('base64') }, keepItIn: 'your password manager (not a chat, not a file next to the backups)', use: 'unit7 backup decrypt <file.enc> <out.gz>  (it asks for this key)' };
  },
});

