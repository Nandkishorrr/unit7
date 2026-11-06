// Showing one setting's value when Coolify won't send it. Option A: a person lets Unit7's own Coolify key read values
// (a new key with read:sensitive, the old one deleted), then the value shows. Option B: a person reads that ONE key
// from the running container over root: only that key, on stdout, kept out of audit, events and results. Public
// values (NEXT_PUBLIC_…) are named as public. And the plain-words next steps for errors that used to be dead ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, id, run } from '../src/db.ts';
import { buildInventory } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { RUNNING_ENV, isPublicKey, runningEnvTemplate } from '../src/tools/coolify.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { fakeHost, shell } from './coolify-root-fixtures.ts';
import { isPublicKey as isPublicWeb, revealProblem, nextStep } from '../web/src/lib/nextstep.ts';

const SECRET = 'sk_live_9f8e7d6c5b4a=tail';
const everything = (app: ReturnType<typeof testApp>) => JSON.stringify([all(app.db, 'SELECT * FROM audit'), all(app.db, 'SELECT * FROM events')]);
const addServer = (app: ReturnType<typeof testApp>, orgId: string) => {
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, orgId, JSON.stringify({ sudo: 'root' }));
  return srv;
};

// --- Option A ---------------------------------------------------------------------------------------------
test('option A: “allow Unit7 to see values” makes a new key with read:sensitive (people only), then the value shows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-reveal-a-'));
  Object.assign(manageDirs, { undo: join(dir, 'undo') });
  const host = await fakeHost();
  host.st.api = true;
  try {
    const app = testApp();
    const o = await testOrg(app);
    const srv = addServer(app, o.orgId);
    saveXray(app.db, o.orgId, srv, 'fast', buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' }));
    const sh = shell(dir, host.port);
    ssh(app).exec = async (_s, command, x: ExecOptions = {}) => sh(command, String(x.stdin ?? ''));
    const first = ok(await o.h('coolify.connect', { serverId: srv, auto: true }));
    assert.deepEqual(first.abilities, ['read', 'write', 'deploy', 'delete']);
    const want = { serverId: srv, uuid: 'shopapp01', op: 'reveal', key: 'NEXT_PUBLIC_SUPABASE_URL' };
    const no = await o.h('coolify.envs', want);
    assert.equal(no.status, 'error');
    assert.equal(no.status === 'error' && no.error.code, 'coolify_permission');
    assert.equal(revealProblem(no), 'no_value', 'the web app knows to offer the two ways');

    // an AI and a developer can't give Unit7's key more power
    assert.equal((await o.a('coolify.connect', { serverId: srv, auto: true, readSecrets: true })).status, 'denied');
    const dev = await o.as(o.role('developer'))('coolify.connect', { serverId: srv, auto: true, readSecrets: true });
    assert.notEqual(dev.status, 'ok', 'owners and admins only');

    const oldId = host.st.tokens.find((t) => t.name.startsWith('Unit7 ('))!.id;
    const again = ok(await o.h('coolify.connect', { serverId: srv, auto: true, readSecrets: true }));
    assert.ok(again.abilities.includes('read:sensitive'));
    assert.equal(host.st.php.at(-1)!.input.revoke, oldId, 'the old key is deleted in Coolify');
    assert.equal(host.st.tokens.filter((t) => t.name.startsWith('Unit7 (')).length, 1);
    const shown = ok(await o.h('coolify.envs', want));
    assert.equal(shown.value, 'https://db.example.com');
    assert.equal(shown.public, true);
    assert.ok(!everything(app).includes('https://db.example.com'), 'the value stays out of audit and events');
  } finally { host.close(); }
});

// --- Option B ---------------------------------------------------------------------------------------------
// a docker stand-in with two containers of the app (the live one and a preview) and one of another app
function fakeDocker(dir: string) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const ctrs = [
    { name: 'shop-live', labels: { 'coolify.applicationUuid': 'shopapp01', 'coolify.pullRequestId': '0' }, env: ['PATH=/usr/bin', 'NEXT_PUBLIC_SUPABASE_URL=https://db.example.com', `STRIPE_SECRET=${SECRET}`, 'EMPTY='] },
    { name: 'shop-pr-3', labels: { 'coolify.applicationUuid': 'shopapp01', 'coolify.pullRequestId': '3' }, env: ['STRIPE_SECRET=preview-value-123'] },
    { name: 'other', labels: { 'coolify.applicationUuid': 'otherapp1' }, env: ['STRIPE_SECRET=other-value-123'] },
  ];
  writeFileSync(join(dir, 'ctrs.json'), JSON.stringify(ctrs));
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'docker.log'))}, JSON.stringify(a) + '\\n');
const ctrs = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'ctrs.json'))}, 'utf8'));
if (a[0] === 'ps') {
  const [k, v] = a[a.indexOf('--filter') + 1].slice(6).split('=');
  for (const c of ctrs) if (c.labels[k] === v) process.stdout.write(c.name + '|' + (c.labels['coolify.pullRequestId'] ?? '') + '\\n');
} else if (a[0] === 'inspect' && a[1] === '-f') {
  const m = /^\\{\\{range \\.Config\\.Env\\}\\}\\{\\{if eq \\(index \\(split \\. "="\\) 0\\) "(\\w+)"\\}\\}\\{\\{json \\.\\}\\}\\{\\{end\\}\\}\\{\\{end\\}\\}$/.exec(a[2]);
  if (!m) { process.stderr.write('unexpected template'); process.exit(1); }
  const e = ctrs.find((c) => c.name === a[3]).env.find((x) => x.split('=')[0] === m[1]);
  if (e !== undefined) process.stdout.write(JSON.stringify(e));
  process.stdout.write('\\n');
} else { process.stderr.write('unexpected docker ' + a.join(' ')); process.exit(1); }
`);
  chmodSync(join(bin, 'docker'), 0o755);
  return bin;
}

test('option B: reads ONE key from the running app over root, never the rest; people only; kept out of audit and events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-reveal-b-'));
  const bin = fakeDocker(dir);
  const app = testApp();
  const o = await testOrg(app);
  const srv = addServer(app, o.orgId);
  const commands: string[] = [];
  ssh(app).exec = async (_s, command, _x: ExecOptions = {}) => {
    commands.push(command);
    return new Promise((resolve) => {
      const p = spawn('sh', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
    });
  };
  const input = { serverId: srv, uuid: 'shopapp01', kind: 'application', key: 'STRIPE_SECRET' };

  // the exact command: a constant script, the template for that one key, Coolify's two label generations
  const r = ok(await o.h('coolify.running_value', input));
  assert.equal(r.value, SECRET, 'the live container’s value (with = inside), not the preview’s');
  assert.equal(r.from, 'running');
  assert.equal(r.public, false);
  assert.equal(commands.length, 1);
  assert.ok(commands[0]!.includes(`'{{range .Config.Env}}{{if eq (index (split . "=") 0) "STRIPE_SECRET"}}{{json .}}{{end}}{{end}}'`));
  assert.ok(commands[0]!.includes(`'coolify.applicationUuid=shopapp01' 'com.docker.compose.project=shopapp01'`));
  assert.ok(commands[0]!.startsWith(`sh -c '`));
  const calls = readFileSync(join(dir, 'docker.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  assert.deepEqual(calls.filter((c) => c[0] === 'inspect').map((c) => c[3]), ['shop-live'], 'only the live container is read');
  assert.ok(calls.every((c) => c[0] === 'ps' || (c[0] === 'inspect' && c[2] === runningEnvTemplate('STRIPE_SECRET'))), 'never a command that prints the whole environment');
  assert.ok(!/exec|environ|printenv|\benv\b/.test(commands[0]!.replace('.Config.Env', '')), 'no shell inside the app, no env dump');

  // what's kept: the key's name, never its value or another key's
  const kept = everything(app);
  assert.ok(!kept.includes(SECRET) && !kept.includes('https://db.example.com') && !kept.includes('preview-value-123'));
  assert.match(kept, /revealed STRIPE_SECRET from the running app on box/);
  assert.match(kept, /shown only to the person who asked/);

  // a public one, an empty one, one that isn't there
  const pub = ok(await o.h('coolify.running_value', { ...input, key: 'NEXT_PUBLIC_SUPABASE_URL' }));
  assert.equal(pub.value, 'https://db.example.com');
  assert.equal(pub.public, true);
  assert.equal(ok(await o.h('coolify.running_value', { ...input, key: 'EMPTY' })).value, '');
  const missing = await o.h('coolify.running_value', { ...input, key: 'NOPE' });
  assert.equal(missing.status === 'error' && missing.error.code, 'not_set');
  const gone = await o.h('coolify.running_value', { ...input, uuid: 'nothere01' });
  assert.equal(gone.status === 'error' && gone.error.code, 'not_running');

  // refused before anything runs: a bad name, an AI, a token, a developer
  const before = commands.length;
  for (const key of ['A B', 'X;rm -rf /', '1ABC', 'A.B', '$(id)', 'K"}}{{.}}{{"', '']) {
    const bad = await o.h('coolify.running_value', { ...input, key });
    assert.equal(bad.status, 'error', key);
    assert.throws(() => runningEnvTemplate(key));
  }
  assert.equal((await o.a('coolify.running_value', input)).status, 'denied');
  assert.equal((await o.as({ ...o.human, kind: 'token' })('coolify.running_value', input)).status, 'denied');
  assert.notEqual((await o.as(o.role('developer'))('coolify.running_value', input)).status, 'ok');
  assert.equal(commands.length, before, 'nothing ran on the server for any of them');
  assert.ok(RUNNING_ENV.includes('docker inspect -f "$t"') && !RUNNING_ENV.includes('/proc'), 'the script itself never dumps the environment');
});

test('public values: the prefixes web frameworks send to every browser', () => {
  for (const f of [isPublicKey, isPublicWeb]) {
    for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'VITE_API', 'PUBLIC_URL', 'NUXT_PUBLIC_X', 'EXPO_PUBLIC_KEY', 'REACT_APP_ID']) assert.equal(f(k), true, k);
    for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLICX', 'MY_VITE_KEY', 'public_url', 'DATABASE_URL', 'NEXTPUBLIC_A']) assert.equal(f(k), false, k);
  }
});

test('dead ends: an error names its next step', () => {
  const err = (code: string, message = '') => ({ status: 'error' as const, error: { code, message } });
  assert.equal(revealProblem(err('coolify_permission')), 'no_value');
  assert.equal(revealProblem(err('not_running')), undefined);
  assert.equal(revealProblem({ status: 'ok' }), undefined);
  assert.deepEqual(nextStep(err('coolify_not_connected')), { kind: 'connect_coolify', label: 'Connect Coolify' });
  assert.deepEqual(nextStep(err('coolify_permission', 'Coolify returned no logs.')), { kind: 'coolify_permission', label: 'Give permission' });
  assert.deepEqual(nextStep(err('network', 'Failed to fetch')), { kind: 'retry', label: 'Try again' });
  assert.deepEqual(nextStep(err('timeout', 'took longer')), { kind: 'retry', label: 'Try again' });
  assert.deepEqual(nextStep(err('provider_auth', 'The token was refused')), { kind: 'reconnect', label: 'Reconnect', href: '/connections' });
  assert.deepEqual(nextStep(err('not_connected')), { kind: 'connections', label: 'Connect', href: '/connections' });
  assert.deepEqual(nextStep(err('not_connected'), { serverId: 'srv_abc' }), { kind: 'connections', label: 'Connect', href: '/servers/srv_abc/apps' }, 'an app on a server connects on its page');
  assert.deepEqual(nextStep(err('coolify_permission'), { serverId: 'srv_abc' }), { kind: 'coolify_permission', label: 'Give permission', href: '/servers/srv_abc#coolify-connect' });
  assert.deepEqual(nextStep(err('account_paused', 'Vercel refused Unit7’s credential, so…')), { kind: 'reconnect', label: 'Reconnect', href: '/connections' });
  assert.deepEqual(nextStep(err('owned_by_paas', 'run by Coolify')), { kind: 'ask', label: 'Ask Unit7 why' });
  assert.equal(nextStep(err('host_key_changed', 'x')), undefined, 'no server to open: nothing made up');
  assert.deepEqual(nextStep({ status: 'approval_required', why: 'x' }), { kind: 'approvals', label: 'Open approvals', href: '/approvals' });
  assert.equal(nextStep(err('invalid_input', 'Name the setting')), undefined, 'no made-up step');
  assert.equal(nextStep({ status: 'ok' }), undefined);
});
