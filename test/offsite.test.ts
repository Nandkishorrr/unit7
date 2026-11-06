// Off-server backups: encrypted before they leave, tamper-evident, and any S3-compatible bucket works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptFile, decryptFile, syncFolders, syncedFolder } from '../src/tools/offsite.ts';
import { testApp, testOrg } from './helpers.ts';
import { signV4, s3 } from '../src/connectors/s3.ts';
import { fakeBucket } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'unit7-offsite-'));

test('copies are encrypted; a changed byte or the wrong key is refused', async () => {
  const key = randomBytes(32), plain = join(dir, 'b.gz'), enc = join(dir, 'b.enc'), out = join(dir, 'b.out');
  const body = Buffer.concat([Buffer.from('CREATE TABLE customers; INSERT secret-row;'), randomBytes(200_000)]);
  writeFileSync(plain, body);
  await encryptFile(key, plain, enc);
  const sealed = readFileSync(enc);
  assert.equal(sealed.subarray(0, 8).toString(), 'FORGEBK1');
  assert.ok(!sealed.includes(Buffer.from('secret-row')), 'no plaintext in the copy');
  await decryptFile(key, enc, out);
  assert.ok(readFileSync(out).equals(body));
  await assert.rejects(decryptFile(randomBytes(32), enc, out), /wrong recovery key/);
  sealed[sealed.length - 100] ^= 1; writeFileSync(enc, sealed);
  await assert.rejects(decryptFile(key, enc, out), /changed or cut short/);
});

test('S3 signatures match AWS’s published example', () => {
  const auth = signV4({ method: 'GET', path: '/test.txt', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' } });
  assert.match(auth, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('put, get and delete on an S3-compatible bucket, streamed from and to disk', async () => {
  const fb = await fakeBucket();
  try {
    const b = { endpoint: fb.endpoint, bucket: 'my-backups', region: 'auto', accessKeyId: 'AKIDTEST1234', secret: 'test-secret-1234' };
    await s3.test(b);
    const f = join(dir, 'up.bin'); writeFileSync(f, randomBytes(300_000));
    await s3.put(b, 'unit7/acme/db/x y.enc', f);
    assert.ok(fb.objects.get('/my-backups/unit7/acme/db/x y.enc')!.equals(readFileSync(f)));
    await s3.get(b, 'unit7/acme/db/x y.enc', join(dir, 'down.bin'));
    assert.ok(readFileSync(join(dir, 'down.bin')).equals(readFileSync(f)));
    await s3.del(b, 'unit7/acme/db/x y.enc');
    assert.equal(fb.objects.size, 0);
    await assert.rejects(s3.test({ ...b, accessKeyId: 'WRONGKEY1' }), /SignatureDoesNotMatch/);
  } finally { fb.close(); }
});

test('finds the folders desktop apps sync (Google Drive, Dropbox, OneDrive, iCloud)', () => {
  const home = mkdtempSync(join(tmpdir(), 'unit7-home-'));
  for (const p of ['Library/CloudStorage/GoogleDrive-ada@example.com/My Drive', 'Library/CloudStorage/GoogleDrive-ada@example.com/Shared drives', 'Library/CloudStorage/Dropbox', 'Library/CloudStorage/OneDrive-Personal', 'Library/Mobile Documents/com~apple~CloudDocs'])
    mkdirSync(join(home, p), { recursive: true });
  const f = syncFolders(home);
  assert.deepEqual(f.map((x) => x.name).sort(), ['Dropbox', 'Google Drive (ada@example.com)', 'OneDrive Personal', 'iCloud Drive']);
  assert.equal(f.find((x) => x.kind === 'google-drive')!.path, join(home, 'Library/CloudStorage/GoogleDrive-ada@example.com/My Drive'), 'My Drive, not shared drives');
  assert.deepEqual(syncFolders(mkdtempSync(join(tmpdir(), 'unit7-empty-'))), []);
  // a Drive the OS won't let Unit7 read (macOS privacy) is listed as blocked, not a crash
  const shut = join(home, 'Library/CloudStorage/GoogleDrive-bo@example.com');
  mkdirSync(shut); chmodSync(shut, 0);
  try { assert.equal(syncFolders(home).find((x) => x.name === 'Google Drive (bo@example.com)')?.blocked, true); } finally { chmodSync(shut, 0o755); }
});

test('the synced folder is used by itself the first time; once a person stops it, it stays off', async () => {
  const app = testApp(); const o = await testOrg(app);
  const said: string[] = [];
  const ctx = { db: app.db, orgId: o.orgId, emit: (_t: string, m: string) => { said.push(m); } } as never;
  const found = () => [{ kind: 'google-drive', name: 'Google Drive (ada@example.com)', path: '/Users/ada/Library/CloudStorage/GoogleDrive-ada@example.com/My Drive' }];
  assert.equal(syncedFolder(ctx, () => [{ ...found()[0]!, blocked: true }]), undefined, 'a blocked folder is never adopted');
  assert.equal(syncedFolder(ctx, found), found()[0]!.path);
  assert.match(said[0]!, /also kept in Google Drive/);
  assert.equal(syncedFolder(ctx, () => []), found()[0]!.path, 'remembered');
  (await import('../src/db.ts')).run(app.db, `UPDATE orgs SET backup_folder = '' WHERE id = ?`, o.orgId); // what Stop does
  assert.equal(syncedFolder(ctx, found), undefined);
  assert.equal(said.length, 1, 'announced once');
});
