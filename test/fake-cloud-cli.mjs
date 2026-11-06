#!/usr/bin/env node
// A stand-in for gcloud, firebase, aws and az signed in on this Mac (tests point UNIT7_GCLOUD_BIN, UNIT7_FIREBASE_BIN,
// UNIT7_AWS_BIN and UNIT7_AZ_BIN here). Which tool it plays is clear from its arguments. FAKE_CLOUD_SIGNED_OUT lists
// the tools that act signed out (comma-separated); FAKE_CLOUD_LOG, if set, gets one line per call.
// Several sign-ins (comma-separated, the first is the active one): FAKE_GCLOUD_ACCOUNTS, FAKE_FIREBASE_ACCOUNTS,
// FAKE_AWS_PROFILES, FAKE_AZ_USERS (each defaults to one: sam@example.com, or the "default" profile). A browser
// sign-in (`gcloud auth login`) adds FAKE_GCLOUD_LOGIN, kept in the FAKE_CLOUD_STATE file between calls; without
// --no-activate it refuses, since that would switch which account gcloud uses.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const a = process.argv.slice(2);
const cmd = a.join(' ');
const tool = a[0] === 'auth' || a[0] === 'run' ? 'gcloud' : /^[a-z]+:[a-z:]+$/.test(a[0] ?? '') ? 'firebase' : a[0] === 'configure' ? 'aws' : a[0] === 'account' ? 'az' : 'unknown';
if (process.env.FAKE_CLOUD_LOG) appendFileSync(process.env.FAKE_CLOUD_LOG, `${tool} ${cmd}\n`);
// one answer per call; written with a callback so a pipe never loses the end of it
let answered = false;
const out = (o) => { if (answered) return; answered = true; process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o), () => process.exit(0)); };
const fail = (msg, code = 1) => { if (answered) return; answered = true; process.exitCode = code; process.stderr.write(`${msg}\n`); };
if ((process.env.FAKE_CLOUD_SIGNED_OUT ?? '').split(',').includes(tool)) {
  answered = true;
  process.exitCode = 1;
  process.stderr.write(tool === 'gcloud' ? 'ERROR: (gcloud.auth) You do not currently have an active account selected. Please run gcloud auth login\n' : 'Error: Failed to authenticate, have you run login?\n');
}
const listOf = (v, d) => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const state = process.env.FAKE_CLOUD_STATE;
const added = state && existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).gcloud ?? [] : [];
const gAccounts = [...listOf(process.env.FAKE_GCLOUD_ACCOUNTS, 'sam@example.com'), ...added];
const flag = (name) => { const i = a.findIndex((x) => x === name || x.startsWith(`${name}=`)); return i < 0 ? undefined : a[i].includes('=') ? a[i].split('=').slice(1).join('=') : a[i + 1]; };
const gToken = (who) => (who === 'sam@example.com' ? 'ya29.from-gcloud' : `ya29.for-${who}`);

// `gcloud run deploy`: says in the log what it would send, and FAKE_RUN_FAIL is the line it dies with
if (tool === 'gcloud' && a[1] === 'deploy') {
  const env = flag('--env-vars-file');
  if (process.env.FAKE_CLOUD_LOG) appendFileSync(process.env.FAKE_CLOUD_LOG, `sent ${readdirSync(flag('--source'), { recursive: true }).sort().join(',')}\nenv ${env ? readFileSync(env, 'utf8') : ''}\n`);
  if (process.env.FAKE_RUN_FAIL) fail(process.env.FAKE_RUN_FAIL); else out({ metadata: { name: a[2] } });
}
if (tool === 'gcloud' && a[1] === 'list') out(cmd.includes('--format=json') ? gAccounts.map((account, i) => ({ account, status: i === 0 ? 'ACTIVE' : '' })) : `${gAccounts[0] ?? ''}\n`);
if (tool === 'gcloud' && a[1] === 'print-access-token') {
  const who = flag('--account') ?? (a[2] && !a[2].startsWith('-') ? a[2] : gAccounts[0]);
  if (gAccounts.includes(who)) out(`${gToken(who)}\n`); else fail(`ERROR: (gcloud.auth.print-access-token) There are no credentials for account [${who}].`);
}
if (tool === 'gcloud' && a[1] === 'login') {
  if (!a.includes('--no-activate')) fail('fake-cloud-cli: this sign-in would switch the active account', 3);
  else if (!process.env.FAKE_GCLOUD_LOGIN) fail('ERROR: (gcloud.auth.login) There was a problem with web authentication.');
  else { writeFileSync(state, JSON.stringify({ gcloud: [...new Set([...added, process.env.FAKE_GCLOUD_LOGIN])] })); process.stderr.write(`You are now logged in as [${process.env.FAKE_GCLOUD_LOGIN}].\n`); out(''); }
}
if (tool === 'firebase' && a[0] === 'login:list') out({ status: 'success', result: listOf(process.env.FAKE_FIREBASE_ACCOUNTS, 'sam@example.com').map((email) => ({ user: { email } })) });
if (tool === 'firebase' && a[0] === 'projects:list') out({ status: 'success', result: [{ projectId: 'shop-prod', displayName: 'Shop' }] });
if (tool === 'firebase' && a[0] === 'hosting:sites:list') out({ status: 'success', result: { sites: [{ name: 'projects/shop-prod/sites/shop-web', defaultUrl: 'https://shop-web.web.app' }] } });
if (tool === 'firebase' && a[0] === 'firestore:databases:list') out({ status: 'success', result: [{ name: 'projects/shop-prod/databases/(default)', locationId: 'nam5' }] });
const profiles = listOf(process.env.FAKE_AWS_PROFILES, 'default');
if (tool === 'aws' && a[1] === 'list-profiles') out(profiles.join('\n') + '\n');
if (tool === 'aws' && a[1] === 'export-credentials') {
  const p = flag('--profile') ?? 'default';
  if (profiles.includes(p)) out({ Version: 1, AccessKeyId: 'ASIAFAKEEXAMPLE12345', SecretAccessKey: 'fake/secret/from/cli', SessionToken: 'fake-session-token', Expiration: new Date(Date.now() + 3600_000).toISOString() });
  else fail(`The config profile (${p}) could not be found`, 255);
}
const subs = listOf(process.env.FAKE_AZ_USERS, 'sam@example.com').map((name, i) => ({ id: `00000000-0000-0000-0000-00000000000${i + 1}`, name: 'Pay-As-You-Go', tenantId: `tenant-${i + 1}`, isDefault: i === 0, user: { name, type: 'user' } }));
if (tool === 'az' && a[1] === 'list') out(subs);
if (tool === 'az' && a[1] === 'show') out(subs[0]);
if (tool === 'az' && a[1] === 'get-access-token') {
  const s = flag('--subscription');
  const i = s ? subs.findIndex((x) => x.id === s) : 0;
  if (i < 0) fail(`ERROR: Subscription '${s}' not found. Check the spelling and casing and try again.`);
  else out({ accessToken: i === 0 ? 'eyJ.from-az' : `eyJ.from-az-${i + 1}`, expiresOn: '2099-01-01 00:00:00.000000', expires_on: 4070908800 });
}
if (!answered) { process.stderr.write(`fake-cloud-cli: no answer for "${cmd}"\n`); process.exitCode = 2; }
