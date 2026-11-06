// Several sign-ins in one cloud CLI (two Google accounts in gcloud, AWS profiles, Azure users): the person picks one,
// each Unit7 account always asks for its own (never whichever the CLI has active), the same one is never added twice,
// and "Sign in with another Google account" adds one through gcloud without switching the active account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testApp, testOrg, ok } from './helpers.ts';
import { addCliSignIn, cliSignIns, connectCloudCli } from '../src/connectors/oneclick.ts';
import { forgetSignedIn } from '../src/connectors/cloudcli.ts';
import { get, run } from '../src/db.ts';
import type { App } from '../src/app.ts';

const CLI = fileURLToPath(new URL('./fake-cloud-cli.mjs', import.meta.url));
for (const v of ['UNIT7_GCLOUD_BIN', 'UNIT7_FIREBASE_BIN', 'UNIT7_AWS_BIN', 'UNIT7_AZ_BIN']) process.env[v] = CLI;
const dir = mkdtempSync(join(tmpdir(), 'unit7-signins-'));
const LOG = join(dir, 'cli.log');
process.env.FAKE_CLOUD_LOG = LOG;
process.env.FAKE_CLOUD_STATE = join(dir, 'state.json');
const calls = () => readFileSync(LOG, 'utf8').trim().split('\n');
const fresh = (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  writeFileSync(LOG, ''); writeFileSync(process.env.FAKE_CLOUD_STATE!, '{}'); forgetSignedIn();
};
const secretOf = (app: App, orgId: string, accountId: string) =>
  JSON.parse(app.vault.resolve(orgId, JSON.parse(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', accountId)!.meta).ref));

// a fake API that answers everything with one body and keeps the Authorization headers it saw
async function fake(body: string, type = 'application/json') {
  const auth: string[] = [];
  const server = createServer((req, res) => { auth.push(String(req.headers.authorization ?? '')); res.writeHead(200, { 'content-type': type }).end(body); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth, close: () => server.close() };
}

test('two Google accounts in gcloud: pick either, each uses its own, the same one is refused', async () => {
  fresh({ FAKE_GCLOUD_ACCOUNTS: 'sam@example.com,kim@example.com', FAKE_CLOUD_SIGNED_OUT: '' });
  const api = await fake(JSON.stringify({ projects: [{ projectId: 'shop-prod' }] }));
  process.env.UNIT7_GOOGLE_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const before = await cliSignIns(app, o.orgId, 'gcp');
    assert.deepEqual(before.signIns.map((s) => [s.who, s.active, s.connected]), [['sam@example.com', true, false], ['kim@example.com', false, false]]);
    assert.equal(before.login, 'browser');

    const sam = await connectCloudCli(app, o.orgId, 'gcp'); // no pick: the active one
    assert.equal(sam.name, 'Google Cloud · sam@example.com');
    const kim = await connectCloudCli(app, o.orgId, 'gcp'); // no pick again: the next one not connected yet
    assert.equal(kim.name, 'Google Cloud · kim@example.com');
    assert.deepEqual(secretOf(app, o.orgId, kim.accountId), { cli: 'gcloud', account: 'kim@example.com' });
    await assert.rejects(connectCloudCli(app, o.orgId, 'gcp', 'SAM@example.com'), /This Google account is already connected/);
    await assert.rejects(connectCloudCli(app, o.orgId, 'gcp'), /already connected/, 'nothing left to add');
    await assert.rejects(connectCloudCli(app, o.orgId, 'gcp', 'lee@example.com'), /isn’t signed in on this Mac/);
    assert.deepEqual((await cliSignIns(app, o.orgId, 'gcp')).signIns.map((s) => s.connected), [true, true]);
    // Firebase is its own tile: the same Google account may sit there too
    assert.equal((await connectCloudCli(app, o.orgId, 'firebase', 'kim@example.com')).name, 'Firebase · kim@example.com');

    writeFileSync(LOG, '');
    assert.equal(ok(await o.h('account.verify', { accountId: kim.accountId })).status, 'verified');
    assert.equal(api.auth.at(-1), 'Bearer ya29.for-kim@example.com', 'kim’s token, though sam is the active account');
    const tokenCalls = calls().filter((l) => l.includes('print-access-token'));
    assert.ok(tokenCalls.length && tokenCalls.every((l) => l.includes('--account=kim@example.com')), tokenCalls.join('\n'));

    // an expired one comes back on the same account when it's picked again
    run(app.db, `UPDATE accounts SET status = 'failing' WHERE id = ?`, sam.accountId);
    assert.equal((await connectCloudCli(app, o.orgId, 'gcp', 'sam@example.com')).accountId, sam.accountId);
    assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM accounts WHERE id = ?', sam.accountId)!.status, 'verified');
  } finally { api.close(); delete process.env.UNIT7_GOOGLE_API; fresh({ FAKE_GCLOUD_ACCOUNTS: undefined }); }
});

test('“Sign in with another Google account” adds it through gcloud and never switches the active one', async () => {
  fresh({ FAKE_GCLOUD_ACCOUNTS: 'sam@example.com', FAKE_GCLOUD_LOGIN: 'lee@example.com' });
  try {
    const app = testApp(), o = await testOrg(app);
    await connectCloudCli(app, o.orgId, 'gcp');
    const r = await addCliSignIn(app, o.orgId, 'gcp');
    assert.equal(r.added?.name, 'Google Cloud · lee@example.com');
    assert.deepEqual(r.signIns.map((s) => [s.who, s.connected]), [['sam@example.com', true], ['lee@example.com', true]]);
    assert.ok(calls().some((l) => l === 'gcloud auth login --brief --no-activate'));
    assert.ok(!calls().some((l) => /config set|revoke|auth login(?!.*--no-activate)/.test(l)), 'nothing signs out or switches the account');
    // signing in with one gcloud already has adds nothing new: the person picks it from the list instead
    const again = await addCliSignIn(app, o.orgId, 'firebase');
    assert.equal(again.added, null);
    assert.ok(again.signIns.some((s) => s.who === 'lee@example.com' && !s.connected));
    delete process.env.FAKE_GCLOUD_LOGIN;
    await assert.rejects(addCliSignIn(app, o.orgId, 'gcp'), /didn’t finish/);
    await assert.rejects(addCliSignIn(app, o.orgId, 'aws'), /Terminal/);
  } finally { fresh({ FAKE_GCLOUD_ACCOUNTS: undefined, FAKE_GCLOUD_LOGIN: undefined }); }
});

test('AWS profiles and Azure users: each account keeps its own profile or subscription', async () => {
  fresh({ FAKE_AWS_PROFILES: 'default,work', FAKE_AZ_USERS: 'sam@example.com,kim@example.com' });
  const sts = await fake('<?xml version="1.0"?><GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/unit7</Arn><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>', 'text/xml');
  const arm = await fake(JSON.stringify({ value: [{ subscriptionId: 'sub-2', displayName: 'Side projects' }] }));
  process.env.UNIT7_AWS_API = sts.base; process.env.UNIT7_AZURE_API = arm.base;
  try {
    const app = testApp(), o = await testOrg(app);
    assert.deepEqual((await cliSignIns(app, o.orgId, 'aws')).signIns.map((s) => s.who), ['default', 'work']);
    const work = await connectCloudCli(app, o.orgId, 'aws', 'work');
    assert.deepEqual(secretOf(app, o.orgId, work.accountId), { cli: 'aws', profile: 'work' });
    await assert.rejects(connectCloudCli(app, o.orgId, 'aws', 'work'), /This AWS profile is already connected/);
    writeFileSync(LOG, '');
    assert.equal(ok(await o.h('account.verify', { accountId: work.accountId })).status, 'verified');
    assert.ok(calls().some((l) => l.includes('export-credentials --profile work')));

    const kim = await connectCloudCli(app, o.orgId, 'azure', 'kim@example.com');
    assert.deepEqual(secretOf(app, o.orgId, kim.accountId), { cli: 'az', user: 'kim@example.com', subscription: '00000000-0000-0000-0000-000000000002' });
    assert.equal(ok(await o.h('account.verify', { accountId: kim.accountId })).status, 'verified');
    assert.equal(arm.auth.at(-1), 'Bearer eyJ.from-az-2', 'kim’s own subscription, not the default one');
  } finally { sts.close(); arm.close(); delete process.env.UNIT7_AWS_API; delete process.env.UNIT7_AZURE_API; fresh({ FAKE_AWS_PROFILES: undefined, FAKE_AZ_USERS: undefined }); }
});
