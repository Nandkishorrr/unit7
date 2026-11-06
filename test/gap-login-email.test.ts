// Login on a real domain and a hello@ inbox, against fakes: Supabase's Management API, a stand-in Coolify, Identity Toolkit and
// Cloudflare (DNS and Email Routing). Each provider also says no here: a refused key, a missing role, a feature that's off. A
// secret never comes back in a result or lands anywhere but the vault, and an AI never holds one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account, type Req } from './clouds-fakes.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { all, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { loginHint } from '../src/care/mail.ts';
import { cached } from '../src/connectors/cloudcli.ts';
import { CURL, coolifyTiming } from '../src/connectors/coolify.ts';
import { dnsLook } from '../src/connectors/dnswrite.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { buildInventory } from '../src/discovery/xray.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { dnsDeps } from '../src/tools/clouds-dns.ts';
import { domainDns } from '../src/tools/domains.ts';
import { manageTiming } from '../src/tools/manage.ts';
import { decideApproval, viewInput, type ToolResult } from '../src/tools/runtime.ts';
import { saveXray } from '../src/tools/xray.ts';
import { TOOL_WORDS, noFlag, pressAgain } from '../web/src/lib/words.ts';

process.env.UNIT7_RECHECK = 'off';
coolifyTiming.pollMs = 1;
Object.assign(manageTiming, { settleMs: 0, pollMs: 1, deadlineMs: 30 });

const saved = { look: { ...dnsLook }, deps: { ...dnsDeps }, dom: { ...domainDns } };
after(() => { Object.assign(dnsLook, saved.look); Object.assign(dnsDeps, saved.deps); Object.assign(domainDns, saved.dom); });
const failed = (r: ToolResult) => (r.status === 'error' ? r.error : assert.fail(JSON.stringify(r)));
const setEnv = (k: string, v: string) => { process.env[k] = v; return () => { delete process.env[k]; }; };
const sent = (api: { calls: Req[] }, method: string, path: RegExp) => api.calls.filter((c) => c.method === method && path.test(c.path));
// everything stored, as text: a secret may only live in the vault's ciphertext
const everywhere = (app: App) => all<{ name: string }>(app.db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((t) => JSON.stringify(all(app.db, `SELECT * FROM "${t.name}"`), (_k, v) => (v instanceof Uint8Array ? '[bytes]' : v))).join('\n');

function world(host: string | undefined, records: Record<string, string[]> = {}, zone = 'example.com') {
  const info = async () => ({ zone, host, nameservers: [] });
  dnsLook.host = info; dnsDeps.host = info; domainDns.host = info;
  dnsDeps.answers = async (n, t) => records[`${t} ${n}`] ?? [];
  return records;
}

// --- hosted Supabase ------------------------------------------------------------------------------------------------------
const REF = 'abcdefghijklmnop12', TOKEN = `sbp_${'a1'.repeat(20)}`, CLIENT_SECRET = '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n', STORED_HASH = 'stored-hash-of-the-old-secret';
async function hostedSupabase(auth: Record<string, unknown>, o: { custom?: unknown; refuse?: boolean } = {}) {
  const st = { auth };
  const api = await fakeApi(({ method, path, body }) => {
    if (o.refuse) return [401, { message: 'Invalid token' }];
    if (path === `/v1/projects/${REF}/config/auth` && method === 'GET') return st.auth;
    if (path === `/v1/projects/${REF}/config/auth` && method === 'PATCH') { Object.assign(st.auth, JSON.parse(body)); return st.auth; }
    if (path === `/v1/projects/${REF}/custom-hostname`) return o.custom ?? [404, { message: 'none' }];
  });
  const off = setEnv('UNIT7_SUPABASE_API', `${api.base}/v1`), app = testApp(), org = await testOrg(app);
  const acc = account(app, org.orgId, 'supabase', TOKEN, 'Supabase');
  return { st, api, app, o: org, acc, close: () => { api.close(); off(); } };
}

test('supabase.auth raises the email limit on a project with its own sender, as numbers, an AI asks first, and Undo puts it back', async () => {
  const s = await hostedSupabase({ smtp_host: 'smtp.mailhost.example', rate_limit_email_sent: 30, smtp_max_frequency: 60 });
  try {
    const seen = ok(await s.o.a('supabase.auth', { ref: REF }));
    assert.deepEqual(seen.emails, { perHour: 30, gapSeconds: 60 });
    assert.equal((await s.o.a('supabase.auth', { ref: REF, op: 'set', emailsPerHour: 120 })).status, 'approval_required');
    assert.equal(sent(s.api, 'PATCH', /config\/auth/).length, 0);

    const done = ok(await s.o.h('supabase.auth', { ref: REF, op: 'set', emailsPerHour: 120, emailGapSeconds: 30 }));
    assert.deepEqual(JSON.parse(sent(s.api, 'PATCH', /config\/auth/)[0]!.body), { rate_limit_email_sent: 120, smtp_max_frequency: 30 }, 'the API takes numbers, not strings');
    assert.deepEqual(done.emails, { perHour: 120, gapSeconds: 30 });
    ok(await s.o.h('change.undo', { changeId: done.changeId }));
    assert.deepEqual([s.st.auth.rate_limit_email_sent, s.st.auth.smtp_max_frequency], [30, 60]);

    assert.equal((await s.o.h('supabase.auth', { ref: REF, op: 'set', emailsPerHour: 0 })).status, 'error', 'the API starts at 1');
    ok(await s.o.h('supabase.auth', { ref: REF, op: 'set', emailGapSeconds: 0 }));
    assert.equal(s.st.auth.smtp_max_frequency, 0, 'no gap at all is a real choice');
  } finally { s.close(); }
});

test('the built-in sender stays at 2 an hour: Unit7 says so and what to do, and asks Supabase nothing', async () => {
  const s = await hostedSupabase({ smtp_host: '', rate_limit_email_sent: 2 });
  try {
    const e = failed(await s.o.h('supabase.auth', { ref: REF, op: 'set', emailsPerHour: 100 }));
    assert.equal(e.code, 'no_sender');
    assert.match(e.message, /2 emails an hour.*email\.setup.*email\.connect_app/);
    assert.equal(sent(s.api, 'PATCH', /config\/auth/).length, 0);
    const both = ok(await s.o.h('supabase.auth', { ref: REF, op: 'set', smtpHost: 'smtp.mailhost.example', emailsPerHour: 100 }));
    assert.equal(both.emails.perHour, 100, 'a sender given in the same breath counts');
  } finally { s.close(); }
});

test('a refused Supabase key says what to do, and flags the account', async () => {
  const s = await hostedSupabase({}, { refuse: true });
  try {
    const e = failed(await s.o.h('supabase.auth', { ref: REF, op: 'set', emailsPerHour: 100 }));
    assert.equal(e.code, 'supabase_auth');
    assert.match(e.message, /Check the access token in Connections/);
    assert.equal(all<{ status: string }>(s.app.db, `SELECT status FROM accounts WHERE provider = 'supabase'`)[0]!.status, 'failing');
    assert.ok(!JSON.stringify(e).includes(TOKEN));
    assert.equal(failed(await s.o.h('auth.sign_in', { ref: REF, provider: 'google' })).code, 'supabase_auth', 'the steps need the project, so that says the same');
  } finally { s.close(); }
});

test('auth.sign_in without a client only reads: the address to paste, where, and the settings that hold the client', async () => {
  const s = await hostedSupabase({ site_url: 'https://app.example.com/', uri_allow_list: '', external_google_enabled: false, external_github_enabled: true });
  try {
    const r = ok(await s.o.a('auth.sign_in', { ref: REF, provider: 'google' }));
    assert.equal(r.byApi, false);
    assert.match(r.why, /no API that makes a sign-in client/);
    assert.equal(r.on, false);
    assert.equal(r.open, 'https://console.cloud.google.com/apis/credentials');
    assert.deepEqual(r.paste, { origin: 'https://app.example.com', redirect: `https://${REF}.supabase.co/auth/v1/callback` });
    assert.deepEqual(r.settings, { clientId: 'external_google_client_id', clientSecret: 'external_google_secret', on: 'external_google_enabled' });
    assert.match(r.then, /ui\.form.*Vault.*Never in chat/);
    assert.ok(r.steps.some((x: string) => /Authorized redirect URIs/.test(x)));
    assert.equal(sent(s.api, 'PATCH', /config\/auth/).length, 0);
    assert.equal(all(s.app.db, 'SELECT 1 FROM approvals').length, 0, 'a read needs no yes');

    const gh = ok(await s.o.a('auth.sign_in', { ref: REF, provider: 'github', url: 'https://new.example.com/welcome' }));
    assert.equal(gh.on, true);
    assert.deepEqual(gh.paste, { homepage: 'https://new.example.com', callback: `https://${REF}.supabase.co/auth/v1/callback` });
    assert.match(gh.open, /github\.com\/settings\/developers/);
    assert.equal(failed(await s.o.h('auth.sign_in', { ref: REF, provider: 'google', client: 'only-half' })).code, 'invalid_input');
  } finally { s.close(); }

  const custom = await hostedSupabase({ site_url: '' }, { custom: { status: '5_services_reconfigured', custom_hostname: 'api.example.com' } });
  try {
    const r = ok(await custom.o.h('auth.sign_in', { ref: REF, provider: 'google' }));
    assert.equal(r.paste.redirect, 'https://api.example.com/auth/v1/callback', 'the callback people really reach');
    assert.match(r.note, /no site address yet/);
  } finally { custom.close(); }
});

test('auth.sign_in with a client: an AI never holds the secret, a reference goes through a person, and no result or record has it', async () => {
  const s = await hostedSupabase({ site_url: 'https://app.example.com', external_google_enabled: false, external_google_client_id: 'old-id', external_google_secret: STORED_HASH });
  try {
    const raw = await s.o.a('auth.sign_in', { ref: REF, provider: 'google', client: 'id-1.apps.googleusercontent.com', clientSecret: CLIENT_SECRET });
    assert.equal(raw.status, 'denied');
    assert.match((raw as any).why, /An AI never handles a client secret.*ui\.form/);
    assert.ok(!everywhere(s.app).includes(CLIENT_SECRET), 'asking leaves nothing behind');

    s.app.vault.put(s.o.orgId, 'credential://chat/abc/secret', CLIENT_SECRET, { kind: 'secret', by: 'Ada', meta: { from: 'chat' } });
    const ref = 'credential://chat/abc/secret', asked = await s.o.a('auth.sign_in', { ref: REF, provider: 'google', client: 'id-1.apps.googleusercontent.com', clientSecret: ref });
    assert.equal(asked.status, 'approval_required');
    assert.equal(sent(s.api, 'PATCH', /config\/auth/).length, 0);
    const card = all<{ id: string; input: string }>(s.app.db, `SELECT id, input FROM approvals WHERE tool = 'auth.sign_in'`)[0]!;
    assert.equal(viewInput(card.input).clientSecret, ref, 'the approver sees the reference');

    const done = await decideApproval(s.app, s.o.orgId, s.o.human, card.id, true);
    assert.equal(done.status, 'ok', JSON.stringify(done));
    const out = (done as { output: any }).output;
    assert.equal(out.on, true);
    assert.match(out.note, /can’t put back an old client secret/, 'Undo’s limit is said when it counts');
    assert.deepEqual(JSON.parse(sent(s.api, 'PATCH', /config\/auth/)[0]!.body), { external_google_enabled: true, external_google_client_id: 'id-1.apps.googleusercontent.com', external_google_secret: CLIENT_SECRET });
    assert.ok(!JSON.stringify(done).includes(CLIENT_SECRET));
    assert.ok(!everywhere(s.app).includes(CLIENT_SECRET), 'not in audit, events, the approval or the undo');
    assert.ok(!JSON.stringify(ok(await s.o.a('supabase.auth', { ref: REF }))).includes(STORED_HASH), 'what Supabase stores for it never comes back either');
    assert.deepEqual(ok(await s.o.a('supabase.auth', { ref: REF })).signIn, ['google']);

    ok(await s.o.h('change.undo', { changeId: out.changeId }));
    assert.deepEqual([s.st.auth.external_google_enabled, s.st.auth.external_google_client_id], [false, 'old-id']);
    assert.equal(s.st.auth.external_google_secret, CLIENT_SECRET, 'Undo can’t put back a secret it never read, and says so');

    const typed = ok(await s.o.h('auth.sign_in', { ref: REF, provider: 'github', client: 'Iv1.abc', clientSecret: 'a person may type it here' }));
    assert.equal(typed.on, true);
    assert.equal(s.st.auth.external_github_secret, 'a person may type it here');
    assert.ok(!everywhere(s.app).includes('a person may type it here'));

    assert.equal(failed(await s.o.h('auth.sign_in', { ref: REF, provider: 'github', client: ref, clientSecret: ref })).code, 'invalid_input', 'a client ID is shown when read, so it can’t hold a reference');
    s.app.vault.put(s.o.orgId, 'credential://ntfy/phone/topic', 'approve-codes-go-here', { by: 'Ada' });
    const own = await s.o.a('auth.sign_in', { ref: REF, provider: 'github', client: 'x', clientSecret: 'credential://ntfy/phone/topic' });
    assert.match(failed(await decideApproval(s.app, s.o.orgId, s.o.human, (own as any).approvalId, true) as ToolResult).message, /one of Unit7's own keys/, 'a yes doesn’t make Unit7’s own key a client secret');
    assert.notEqual(s.st.auth.external_github_secret, 'approve-codes-go-here');
  } finally { s.close(); }
});

// --- self-hosted, on a stand-in Coolify ----------------------------------------------------------------------------------
// its Compose file hands only what's named here to the auth container, as the real template does
const PLAIN: Record<string, string> = { GOTRUE_SITE_URL: 'GOTRUE_SITE_URL', SMTP_HOST: 'GOTRUE_SMTP_HOST' };
function standIn(app: App, passes: string[] = []) {
  const envs = new Map<string, { value: string; literal?: boolean }>([['SMTP_HOST', { value: 'smtp.mailhost.example' }]]);
  const live: Record<string, string> = { GOTRUE_SITE_URL: 'https://shop.example.com', API_EXTERNAL_URL: 'https://api.shop.example.com', GOTRUE_SMTP_HOST: 'smtp.mailhost.example', GOTRUE_EXTERNAL_GOOGLE_ENABLED: 'false' };
  const seen = { commands: [] as string[], deploys: 0 };
  ssh(app).exec = async (_s, command, opt: ExecOptions = {}) => {
    seen.commands.push(command);
    if (command === CURL) {
      const stdin = String(opt.stdin), url = new URL(/^url = "(.*)"$/m.exec(stdin)![1]!), method = /^request = "(.*)"$/m.exec(stdin)![1]!;
      const raw = /^data-binary = "(.*)"$/m.exec(stdin)?.[1], body = raw ? JSON.parse(raw.replace(/\\(.)/g, '$1')) : undefined;
      const path = url.pathname.replace('/api/v1', ''), r = `${method} ${path}`;
      const send = (status: number, b: unknown) => ({ code: 0, stdout: `${JSON.stringify(b)}\n${status}`, stderr: '', truncated: false });
      if (r === 'GET /services/shopsupa01/envs') return send(200, [...envs].map(([key], n) => ({ uuid: `env${n}`, key, is_preview: false })));
      if (r === 'POST /services/shopsupa01/envs' || r === 'PATCH /services/shopsupa01/envs') { envs.set(body.key, { value: body.value, literal: body.is_literal }); return send(201, { uuid: 'e' }); }
      const del = /^DELETE \/services\/shopsupa01\/envs\/env(\d+)$/.exec(r);
      if (del) { envs.delete([...envs.keys()][Number(del[1])]!); return send(200, {}); }
      if (r === 'POST /deploy') {
        seen.deploys++;
        for (const k of [...Object.keys(PLAIN), ...passes]) { const to = PLAIN[k] ?? k; if (envs.has(k)) live[to] = envs.get(k)!.value; else if (passes.includes(k)) delete live[to]; }
        return send(200, { deployments: [{ message: 'Service started', resource_uuid: 'shopsupa01' }] });
      }
      if (r === 'GET /services/shopsupa01') return send(200, { status: 'running:healthy' });
      return send(404, { message: 'Not found.' });
    }
    if (command.includes('@@unit7:keys')) {
      const lines = Object.entries(live).filter(([k]) => command.includes(`"${k}"`)).map(([k, v]) => `/supabase-auth-shopsupa01|${JSON.stringify(`${k}=${v}`)}`);
      return { code: 0, stdout: `\n@@unit7:keys\n${lines.join('\n')}\n`, stderr: '', truncated: false };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return { envs, live, seen };
}
async function onServer() {
  const app = testApp(), o = await testOrg(app), srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ sudo: 'root' }));
  saveXray(app.db, o.orgId, srv, 'fast', buildInventory(COOLIFY_HOST));
  const coolify = account(app, o.orgId, 'coolify', '3|unit7testtokenAbC123xyz', 'Coolify on box');
  run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.serverId', ?, '$.facts', json(?)) WHERE id = ?`, srv, JSON.stringify({ abilities: ['read', 'write', 'deploy'] }), coolify);
  return { app, o, srv };
}
const PART = { part: 'shop-supabase' };

test('self-hosted limits: GoTrue’s own settings, the gap with the unit Go needs, read back from the running container', async () => {
  const { app, o, srv } = await onServer(), c = standIn(app, ['GOTRUE_RATE_LIMIT_EMAIL_SENT', 'GOTRUE_SMTP_MAX_FREQUENCY']);
  assert.equal((await o.a('supabase.auth', { serverId: srv, ...PART, op: 'set', emailsPerHour: 120 })).status, 'approval_required');
  const r = ok(await o.h('supabase.auth', { serverId: srv, ...PART, op: 'set', emailsPerHour: 120, emailGapSeconds: 30 }));
  assert.equal(r.changed, true);
  assert.equal(c.envs.get('GOTRUE_RATE_LIMIT_EMAIL_SENT')!.value, '120', 'a plain number is per hour');
  assert.equal(c.envs.get('GOTRUE_SMTP_MAX_FREQUENCY')!.value, '30s', 'a bare 30 would stop GoTrue starting');
  assert.deepEqual(r.emails, { perHour: 120, gapSeconds: 30 });
  assert.deepEqual(ok(await o.a('supabase.auth', { serverId: srv, ...PART })).emails, { perHour: 120, gapSeconds: 30 });
  c.live.GOTRUE_SMTP_MAX_FREQUENCY = '2m';
  assert.equal(ok(await o.a('supabase.auth', { serverId: srv, ...PART })).emails.gapSeconds, 120, 'a stack may write it another way');
  ok(await o.h('change.undo', { changeId: r.changeId }));
  assert.ok(!c.envs.has('GOTRUE_RATE_LIMIT_EMAIL_SENT'), 'a setting that wasn’t there goes again');
});

test('self-hosted limits on a stack whose Compose file doesn’t pass them on: put back, said plainly, with what to add', async () => {
  const { app, o, srv } = await onServer(), c = standIn(app);
  const r = ok(await o.h('supabase.auth', { serverId: srv, ...PART, op: 'set', emailsPerHour: 120, emailGapSeconds: 30 }));
  assert.equal(r.changed, false);
  assert.equal(r.rolledBack, true);
  assert.match(r.why, /doesn’t pass it on.*Edit Compose File/);
  assert.deepEqual(r.inCompose, { GOTRUE_RATE_LIMIT_EMAIL_SENT: '120', GOTRUE_SMTP_MAX_FREQUENCY: '30s' });
  assert.ok(!c.envs.has('GOTRUE_RATE_LIMIT_EMAIL_SENT'), 'nothing half done');
  assert.equal(c.seen.deploys, 2);
});

test('auth.sign_in on a stack: its own setting names, a redeploy, checked in the container, the secret out of every result', async () => {
  const names = ['ENABLED', 'CLIENT_ID', 'SECRET', 'REDIRECT_URI'].map((n) => `GOTRUE_EXTERNAL_GOOGLE_${n}`);
  const { app, o, srv } = await onServer(), c = standIn(app, names);
  const steps = ok(await o.a('auth.sign_in', { serverId: srv, ...PART, provider: 'google' }));
  assert.deepEqual(steps.settings, { clientId: 'GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID', clientSecret: 'GOTRUE_EXTERNAL_GOOGLE_SECRET', on: 'GOTRUE_EXTERNAL_GOOGLE_ENABLED', callback: 'GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI' });
  assert.equal(steps.paste.redirect, 'https://api.shop.example.com/auth/v1/callback');
  assert.equal(c.seen.deploys, 0);

  const r = ok(await o.h('auth.sign_in', { serverId: srv, ...PART, provider: 'google', client: 'id-1', clientSecret: CLIENT_SECRET }));
  assert.equal(r.on, true);
  assert.equal(c.envs.get('GOTRUE_EXTERNAL_GOOGLE_SECRET')!.value, CLIENT_SECRET);
  assert.equal(c.envs.get('GOTRUE_EXTERNAL_GOOGLE_SECRET')!.literal, true, 'a $ in a secret stays a $');
  assert.equal(c.envs.get('GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI')!.value, 'https://api.shop.example.com/auth/v1/callback');
  assert.equal(c.live.GOTRUE_EXTERNAL_GOOGLE_ENABLED, 'true');
  assert.equal(c.seen.deploys, 1);
  assert.ok(!JSON.stringify(r).includes(CLIENT_SECRET) && !everywhere(app).includes(CLIENT_SECRET));
  assert.ok(!c.seen.commands.some((x) => /"GOTRUE_EXTERNAL_GOOGLE_SECRET"/.test(x)), 'it’s never read back from the running stack');
  assert.deepEqual(ok(await o.a('supabase.auth', { serverId: srv, ...PART })).signIn, ['google']);

  ok(await o.h('change.undo', { changeId: r.changeId }));
  assert.ok(!c.envs.has('GOTRUE_EXTERNAL_GOOGLE_SECRET'), 'one that’s new goes again');
  assert.deepEqual(ok(await o.a('supabase.auth', { serverId: srv, ...PART })).signIn, [], 'and the button goes with it');
});

test('auth.sign_in on a stack that doesn’t pass the settings on: nothing left behind, and the exact names to add', async () => {
  const { app, o, srv } = await onServer(), c = standIn(app);
  const r = ok(await o.h('auth.sign_in', { serverId: srv, ...PART, provider: 'github', client: 'Iv1.abc', clientSecret: CLIENT_SECRET }));
  assert.equal(r.on, false);
  assert.match(r.why, /Compose file/);
  assert.match(r.compose, /GOTRUE_EXTERNAL_GITHUB_CLIENT_ID, GOTRUE_EXTERNAL_GITHUB_SECRET, GOTRUE_EXTERNAL_GITHUB_ENABLED, GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI, each as NAME=\$\{NAME\}/);
  assert.ok(![...c.envs.keys()].some((k) => k.includes('GITHUB')), 'the secret doesn’t stay in Coolify');
  assert.ok(!JSON.stringify(r).includes(CLIENT_SECRET) && !everywhere(app).includes(CLIENT_SECRET));
});

test('a stack with no public address has nowhere to send people back to, and says so instead of giving a callback that can’t work', async () => {
  const { app, o, srv } = await onServer();
  const inv = buildInventory(COOLIFY_HOST);
  inv.parts.find((p) => p.name === 'shop-supabase')!.hosts = [];
  saveXray(app.db, o.orgId, srv, 'fast', inv);
  const c = standIn(app);
  c.live.API_EXTERNAL_URL = 'http://supabase-kong:8000';
  const e = failed(await o.h('auth.sign_in', { serverId: srv, ...PART, provider: 'google', client: 'id-1', clientSecret: CLIENT_SECRET }));
  assert.equal(e.code, 'no_address');
  assert.equal(c.seen.deploys, 0);
  assert.equal(ok(await o.h('auth.sign_in', { serverId: srv, ...PART, provider: 'google', apiUrl: 'https://auth.example.com' })).paste.redirect, 'https://auth.example.com/auth/v1/callback');
});

// --- Firebase Auth --------------------------------------------------------------------------------------------------------
const PROJECT = 'shop-demo', KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ type: 'service_account', project_id: PROJECT, client_email: 'unit7@shop-demo.iam.gserviceaccount.com', private_key: KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const CONFIG = `/identitytoolkit/admin/v2/projects/${PROJECT}/config`;
async function firebase(o: { answer?: () => unknown; projects?: string[] } = {}) {
  const st = { domains: ['localhost', `${PROJECT}.firebaseapp.com`, `${PROJECT}.web.app`], answer: o.answer };
  const api = await fakeApi(({ method, path, body }) => {
    if (path === '/oauth2/token') return { access_token: 'ya29.from-key', expires_in: 3600 };
    if (st.answer) return st.answer();
    if (path.startsWith('/cloudresourcemanager/v1/projects')) return { projects: (o.projects ?? [PROJECT]).map((projectId) => ({ projectId })) };
    if (path === CONFIG && method === 'GET') return { name: `projects/${PROJECT}/config`, authorizedDomains: st.domains, client: { apiKey: 'AIza-a-browser-key' }, notification: { sendEmail: { smtp: { password: 'smtp-secret-in-the-config' } } } };
    if (path === `${CONFIG}?updateMask=authorizedDomains` && method === 'PATCH') { st.domains = JSON.parse(body).authorizedDomains; return { name: `projects/${PROJECT}/config`, authorizedDomains: st.domains }; }
  });
  const off = setEnv('UNIT7_GOOGLE_API', api.base), app = testApp(), org = await testOrg(app);
  return { st, api, app, o: org, close: () => { api.close(); off(); } };
}

test('firebase.auth_domains: lists, adds to the list and keeps every name, never reads the rest, and Undo keeps what came since', async () => {
  const f = await firebase();
  try {
    const acc = account(f.app, f.o.orgId, 'firebase', SA, 'Firebase');
    const seen = ok(await f.o.a('firebase.auth_domains', {}));
    assert.deepEqual(seen, { project: PROJECT, domains: f.st.domains, untrusted: seen.untrusted }, 'that one list, nothing else from the config');
    assert.ok(!/AIza|smtp-secret/.test(JSON.stringify(seen)));

    const dry = await f.o.h('firebase.auth_domains', { op: 'add', domains: ['https://app.example.com/login', 'localhost.example.com'] }, { dryRun: true });
    assert.deepEqual((dry as any).plan.willAdd, ['app.example.com', 'localhost.example.com'], 'an address is cut down to its name');
    assert.equal(sent(f.api, 'PATCH', /./).length, 0);

    const asked = await f.o.a('firebase.auth_domains', { op: 'add', domains: ['app.example.com'] });
    assert.equal(asked.status, 'approval_required');
    assert.match((asked as any).why, /People can sign in from app\.example\.com/);

    const was = [...f.st.domains], done = ok(await f.o.h('firebase.auth_domains', { op: 'add', domains: ['APP.example.com', 'app.example.com'], accountId: acc, project: PROJECT }));
    assert.deepEqual(done.added, ['app.example.com'], 'each name once');
    assert.deepEqual(f.st.domains, [...was, 'app.example.com'], 'everything already allowed stays');
    assert.deepEqual(Object.keys(JSON.parse(sent(f.api, 'PATCH', /./)[0]!.body)), ['authorizedDomains'], 'the update mask has one field, and so does the body');

    const again = ok(await f.o.h('firebase.auth_domains', { op: 'add', domains: ['app.example.com'] }));
    assert.equal(again.changed, false);
    assert.equal(sent(f.api, 'PATCH', /./).length, 1, 'nothing to write');

    f.st.domains = [...f.st.domains, 'added-by-hand.example.com'];
    ok(await f.o.h('change.undo', { changeId: done.changeId }));
    assert.deepEqual(f.st.domains, [...was, 'added-by-hand.example.com'], 'Undo takes back its own and nothing else');

    assert.equal((await f.o.h('firebase.auth_domains', { op: 'add' })).status, 'error');
    assert.equal((await f.o.h('firebase.auth_domains', { op: 'add', domains: ['not a domain'] })).status, 'error');
    assert.equal((await f.o.h('firebase.auth_domains', { project: '../other' })).status, 'error', 'a project id goes into a path');
  } finally { f.close(); }
});

test('firebase.auth_domains says what’s wrong when Google says no: a dead key, no role, the API off, Auth never turned on', async () => {
  const google = (status: number, message: string) => () => [status, { error: { code: status, message, status: 'X' } }];
  const f = await firebase();
  try {
    account(f.app, f.o.orgId, 'firebase', SA, 'Firebase');
    f.st.answer = google(403, 'The caller does not have permission');
    const role = failed(await f.o.h('firebase.auth_domains', { op: 'add', domains: ['app.example.com'] }));
    assert.equal(role.code, 'firebase_key');
    assert.match(role.message, /Firebase Authentication Admin role/);
    f.st.answer = google(403, 'Identity Toolkit API has not been used in project 123 before or it is disabled.');
    assert.equal(failed(await f.o.h('firebase.auth_domains', {})).code, 'firebase_api_off');
    f.st.answer = google(404, 'CONFIGURATION_NOT_FOUND');
    const off = failed(await f.o.h('firebase.auth_domains', {}));
    assert.equal(off.code, 'no_firebase_auth');
    assert.match(off.message, /console\.firebase\.google\.com\/project\/shop-demo\/authentication/);
    assert.equal(sent(f.api, 'PATCH', /./).length, 0, 'a list that can’t be read is never written');
    f.st.answer = google(401, 'Request had invalid authentication credentials.');
    const dead = failed(await f.o.h('firebase.auth_domains', {}));
    assert.equal(dead.code, 'provider_refused');
    assert.equal(all<{ status: string }>(f.app.db, `SELECT status FROM accounts WHERE provider = 'firebase'`)[0]!.status, 'failing', 'a dead key is flagged');
    assert.ok(!JSON.stringify(dead).includes('ya29'));
  } finally { f.close(); }

  const bad = await firebase();
  try {
    assert.equal(failed(await bad.o.h('firebase.auth_domains', {})).code, 'no_account');
    account(bad.app, bad.o.orgId, 'firebase', JSON.stringify({ cli: 'firebase', account: 'ada@example.com' }), 'Firebase CLI');
    const cli = failed(await bad.o.h('firebase.auth_domains', {}));
    assert.equal(cli.code, 'firebase_key');
    assert.match(cli.message, /Firebase CLI, which Unit7 only reads with/);
    assert.equal(bad.api.calls.length, 0, 'it never tried');
  } finally { bad.close(); }
});

test('firebase.auth_domains picks the right project, and a gcloud sign-in names its quota project', async () => {
  const f = await firebase({ projects: [PROJECT, 'other-project'] });
  try {
    const acc = account(f.app, f.o.orgId, 'gcp', JSON.stringify({ cli: 'gcloud', account: 'ada@example.com' }), 'Google Cloud');
    await cached(`google:${acc}`, async () => ({ value: 'ya29.gcloud' }));
    assert.equal(failed(await f.o.h('firebase.auth_domains', {})).code, 'choose_one');
    assert.deepEqual(ok(await f.o.h('firebase.auth_domains', { project: PROJECT })).domains, f.st.domains);
    assert.equal(sent(f.api, 'GET', /\/config$/).at(-1)!.headers['x-goog-user-project'], PROJECT);
    assert.equal(failed(await f.o.h('firebase.auth_domains', { op: 'add', project: 'nobody-here', domains: ['app.example.com'], accountId: acc })).code, 'no_firebase_auth', 'one sign-in is taken at its word, and Google answers');
  } finally { f.close(); }
});

test('a domain just pointed gets told about each sign-in it might use, and nothing is done', async () => {
  const app = testApp(), o = await testOrg(app);
  assert.equal(loginHint(app.db, o.orgId, 'app.example.com'), undefined);
  account(app, o.orgId, 'firebase', SA, 'Firebase');
  assert.match(loginHint(app.db, o.orgId, 'app.example.com')!, /^If it signs people in with Firebase Auth, add app\.example\.com with firebase\.auth_domains/);
  account(app, o.orgId, 'supabase', TOKEN, 'Supabase');
  assert.match(loginHint(app.db, o.orgId, 'app.example.com')!, /auth\.urls.*firebase\.auth_domains/);
});

// --- Cloudflare: DNS records and Email Routing, a subdomain as its docs describe it -----------------------------------------
const CF_MX = (name: string) => [{ type: 'MX', name, content: 'route1.mx.cloudflare.net', priority: 13, ttl: 1 }, { type: 'MX', name, content: 'route2.mx.cloudflare.net', priority: 86, ttl: 1 }];
const CF_SPF = (name: string) => ({ type: 'TXT', name, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 });
async function cloudflareFake(recs: any[] = []) {
  const st = { recs, n: 1, enabled: false, subs: [] as string[], order: [] as string[], addresses: [] as any[], rules: [] as any[], refused: undefined as RegExp | undefined };
  const good = (result: unknown) => ({ success: true, errors: [], messages: [], result });
  const api = await fakeApi(({ method, path, body }) => {
    const u = new URL(path, 'http://x'), p = u.pathname;
    if (st.refused?.test(`${method} ${p}`)) return [403, { success: false, errors: [{ message: 'Authentication error' }] }];
    if (p === '/zones') return good([{ id: 'z1', name: 'example.com' }]);
    if (p === '/zones/z1') return good({ id: 'z1', name: 'example.com', account: { id: 'cfacc' } });
    if (p === '/zones/z1/dns_records' && method === 'GET') { const t = u.searchParams.get('type'), nm = u.searchParams.get('name'); return good(st.recs.filter((r) => (!t || r.type === t) && (!nm || r.name === nm))); }
    if (p === '/zones/z1/dns_records' && method === 'POST') { const r = { id: `r${st.n++}`, ...JSON.parse(body) }; st.recs.push(r); return good(r); }
    const rec = /^\/zones\/z1\/dns_records\/(.+)$/.exec(p);
    if (rec && method === 'PUT') { st.recs[st.recs.findIndex((r) => r.id === rec[1])] = { id: rec[1], ...JSON.parse(body) }; return good({ id: rec[1] }); }
    if (rec && method === 'DELETE') { st.recs.splice(st.recs.findIndex((r) => r.id === rec[1]), 1); return good({ id: rec[1] }); }
    if (p === '/zones/z1/email/routing') return good({ id: 'z1', enabled: st.enabled, name: 'example.com' });
    if (p === '/zones/z1/email/routing/dns' && method === 'GET') { if (u.searchParams.has('subdomain')) return [400, { success: false, errors: [{ message: 'do not rely on this parameter' }] }]; return good([...CF_MX('example.com'), CF_SPF('example.com')]); }
    if (p === '/zones/z1/email/routing/dns' && method === 'POST') {
      const name = body ? JSON.parse(body).name : undefined;
      st.order.push(`on ${name ?? 'example.com'}`);
      if (name) { st.subs.push(name); for (const r of CF_MX(name)) st.recs.push({ id: `r${st.n++}`, ...r }); if (!st.recs.some((r) => r.name === name && /^v=spf1/.test(r.content))) st.recs.push({ id: `r${st.n++}`, ...CF_SPF(name) }); }
      else st.enabled = true;
      return good({ id: 'z1', enabled: true });
    }
    if (p === '/zones/z1/email/routing/dns' && method === 'DELETE') { st.enabled = false; return good({ id: 'z1', enabled: false }); }
    if (p === '/accounts/cfacc/email/routing/addresses' && method === 'GET') return good(st.addresses);
    if (p === '/accounts/cfacc/email/routing/addresses' && method === 'POST') { const a = { id: `a${st.n++}`, email: JSON.parse(body).email, verified: null }; st.addresses.push(a); return good(a); }
    if (p === '/zones/z1/email/routing/rules' && method === 'GET') return good(st.rules);
    if (p === '/zones/z1/email/routing/rules' && method === 'POST') {
      const r = { id: `rule${st.n++}`, ...JSON.parse(body) }, on = r.matchers[0].value.split('@')[1];
      // a subdomain takes rules once it's set up
      if (on !== 'example.com' && !st.subs.includes(on)) return [400, { success: false, errors: [{ message: 'That domain is not enabled for Email Routing.' }] }];
      st.order.push(`rule ${r.matchers[0].value}`); st.rules.push(r); return good(r);
    }
    const rule = /^\/zones\/z1\/email\/routing\/rules\/(.+)$/.exec(p);
    if (rule && method === 'PUT') { const i = st.rules.findIndex((r) => r.id === rule[1]); st.rules[i] = { id: rule[1], ...JSON.parse(body) }; return good(st.rules[i]); }
    if (rule && method === 'DELETE') { st.rules.splice(st.rules.findIndex((r) => r.id === rule[1]), 1); return good({ id: rule[1] }); }
    return [404, { success: false, errors: [{ message: 'Not found' }] }];
  });
  const off = setEnv('UNIT7_CLOUDFLARE_API', api.base), app = testApp(), o = await testOrg(app);
  account(app, o.orgId, 'cloudflare', 'cf-demo-token');
  const clicked = () => { for (const a of st.addresses) a.verified = '2026-11-06T10:00:00Z'; };
  return { st, api, app, o, clicked, close: () => { api.close(); off(); } };
}
const SUB = { from: 'hello@mail.example.com', to: 'ada@inbox.example' }, BARE = { from: 'hello@example.com', to: 'ada@inbox.example' };
const at = (recs: any[], name: string, type: string) => recs.filter((r) => r.name === name && r.type === type);

test('email.forward on a subdomain: the inbox first, Cloudflare turns the subdomain on and writes its records, then the rule, and the bare domain is left alone', async () => {
  const mail = [{ id: 'mx', type: 'MX', name: 'example.com', content: 'mx1.mailhost.example', priority: 10, ttl: 1 }];
  const f = await cloudflareFake(mail);
  try {
    world('cloudflare', { 'TXT example.com': ['v=spf1 include:_spf.mailhost.example ~all'] });
    const dry = (await f.o.h('email.forward', SUB, { dryRun: true }) as any).plan;
    assert.equal(dry.emailRouting, 'turned on');
    assert.match(dry.cloudflareAdds, /MX and SPF records at mail\.example\.com/);
    assert.equal(dry.stopsThere, false, 'the bare domain’s mail isn’t in the way');
    assert.equal(dry.note, undefined);

    const first = ok(await f.o.h('email.forward', SUB));
    assert.equal(first.waiting, 'inbox');
    assert.match(first.note, /Nothing about mail\.example\.com’s mail has changed/);
    assert.equal(f.st.subs.length, 0);

    f.clicked();
    const done = ok(await f.o.h('email.forward', SUB));
    assert.equal(done.forwarded, true);
    assert.deepEqual(f.st.order, ['on mail.example.com', 'rule hello@mail.example.com'], 'Cloudflare takes rules once the subdomain is set up');
    assert.equal(at(f.st.recs, 'mail.example.com', 'MX').length, 2, 'its records are Cloudflare’s to write');
    assert.deepEqual(at(f.st.recs, 'example.com', 'MX').map((r) => r.content), ['mx1.mailhost.example'], 'the bare domain’s mail never moved');
    assert.equal(f.st.enabled, false, 'the bare domain’s own routing stays off');
    assert.ok(!sent(f.api, 'GET', /email\/routing\/dns/).some((c) => c.path.includes('subdomain')), 'the parameter Cloudflare says not to rely on');
    assert.match(done.undo, /Cloudflare keeps mail\.example\.com set up/);

    const again = ok(await f.o.h('email.forward', SUB));
    assert.equal(again.forwarded, true);
    assert.equal(f.st.subs.length, 1, 'once on, it isn’t turned on again');
    assert.equal(f.st.rules.length, 1);

    const back = ok(await f.o.h('change.undo', { changeId: done.changeId }));
    assert.equal(f.st.rules.length, 0);
    assert.equal(sent(f.api, 'DELETE', /email\/routing\/dns/).length, 0, 'that call would turn off the whole zone');
    assert.match(JSON.stringify(back), /Cloudflare keeps mail\.example\.com set up/);
  } finally { f.close(); }
});

test('a subdomain: an SPF line already there is joined, the bare domain’s missing SPF is said, and mail going elsewhere is left alone', async () => {
  const f = await cloudflareFake([{ id: 's', type: 'TXT', name: 'mail.example.com', content: 'v=spf1 include:amazonses.com ~all', ttl: 1 }]);
  try {
    world('cloudflare', { 'TXT mail.example.com': ['v=spf1 include:amazonses.com ~all'] });
    ok(await f.o.h('email.forward', SUB));
    f.clicked();
    const done = ok(await f.o.h('email.forward', SUB));
    assert.equal(done.forwarded, true);
    assert.deepEqual(at(f.st.recs, 'mail.example.com', 'TXT').map((r) => r.content), ['v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net ~all'], 'one line, both senders');
    assert.match(done.note, /example\.com has no SPF line, and Cloudflare may add its own there.*email\.check/);
  } finally { f.close(); }

  const held = await cloudflareFake([{ id: 'mx', type: 'MX', name: 'mail.example.com', content: 'mx1.mailhost.example', priority: 10, ttl: 1 }]);
  try {
    world('cloudflare');
    for (const r of [await held.o.h('email.forward', { ...SUB, replaceMail: true }), await held.o.h('email.forward', SUB, { dryRun: true })]) assert.match(failed(r).message, /Mail for mail\.example\.com goes to mx1\.mailhost\.example now.*at that mail host/);
    assert.equal(held.st.subs.length, 0);
    assert.equal(held.st.addresses.length, 0, 'nothing started');
  } finally { held.close(); }
});

test('a refused Cloudflare key stops a forward on a subdomain with what to do, before anything changes', async () => {
  const f = await cloudflareFake();
  try {
    world('cloudflare');
    f.st.addresses.push({ id: 'a1', email: 'ada@inbox.example', verified: '2026-11-06T10:00:00Z' });
    f.st.refused = /^POST \/zones\/z1\/email\/routing\/dns$/;
    const e = failed(await f.o.h('email.forward', SUB));
    assert.equal(e.code, 'cloudflare_key');
    assert.match(e.message, /Zone Settings: Edit/);
    assert.equal(f.st.rules.length, 0);
    assert.equal(all<{ status: string }>(f.app.db, `SELECT status FROM accounts WHERE provider = 'cloudflare'`)[0]!.status, 'verified', 'the key still does everything else');
    assert.ok(!JSON.stringify(e).includes('cf-demo-token'));
    f.st.refused = undefined;
    assert.equal(ok(await f.o.h('email.forward', SUB)).forwarded, true, 'with a better key it picks up');
  } finally { f.close(); }
});

test('a domain not on Cloudflare: what’s stopping it, the one step, and that step always waits for a person', async () => {
  const app = testApp(), o = await testOrg(app);
  world('hostinger', { 'MX mail.example.com': ['5 mx1.hostinger.com'] });
  for (const input of [SUB, BARE]) {
    const r = ok(await o.h('email.forward', input));
    assert.equal(r.forwarded, false);
    assert.match(r.why, /example\.com’s DNS is at Hostinger.*needs the domain’s DNS on Cloudflare/);
    assert.deepEqual([r.fix.tool, r.fix.input, r.fix.label], ['domain.move_dns', { domain: 'example.com' }, 'Move DNS to Cloudflare']);
    assert.match(r.fix.note, /a person approves it/);
  }
  assert.match(ok(await o.h('email.forward', SUB)).steps[0], /Mail for mail\.example\.com goes to Hostinger Email/);
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const asked = await o.a('domain.move_dns', { domain: 'example.com' });
  assert.equal(asked.status, 'approval_required', 'even on full autopilot');
  assert.match((asked as any).why, /a person says yes first/);
});

test('email.check says what forwards where: on, waiting and why, off, elsewhere with its fix, no account, and a refused key leaves the rest standing', async () => {
  const f = await cloudflareFake();
  try {
    const dns = world('cloudflare', { 'MX example.com': ['13 route1.mx.cloudflare.net.', '86 route2.mx.cloudflare.net.'] });
    assert.deepEqual(ok(await f.o.a('email.check', { domain: 'example.com' })).forwarding, { state: 'off', at: 'Cloudflare Email Routing', forwards: [] });

    const rule = (from: string, to: string, enabled = true) => f.st.rules.push({ id: `r-${from}`, enabled, matchers: [{ type: 'literal', field: 'to', value: from }], actions: [{ type: 'forward', value: [to] }] });
    rule('hello@example.com', 'ada@inbox.example');
    rule('news@mail.example.com', 'ada@inbox.example');
    f.st.rules.push({ id: 'drop', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'spam@example.com' }], actions: [{ type: 'drop' }] });
    f.st.addresses.push({ id: 'a', email: 'ada@inbox.example', verified: null });
    const wait = ok(await f.o.a('email.check', { domain: 'example.com' })).forwarding;
    assert.equal(wait.state, 'waiting');
    assert.deepEqual(wait.forwards.map((x: any) => [x.from, x.to, x.working]), [['hello@example.com', 'ada@inbox.example', false]], 'this domain’s forwards, not a subdomain’s, and not a rule that drops mail');
    assert.match(wait.forwards[0].why, /hasn’t clicked Cloudflare’s link/);

    f.clicked();
    assert.equal(ok(await f.o.a('email.check', { domain: 'example.com' })).forwarding.state, 'on');
    delete dns['MX example.com'];
    const lost = ok(await f.o.a('email.check', { domain: 'example.com' })).forwarding;
    assert.equal(lost.state, 'waiting');
    assert.match(lost.forwards[0].why, /doesn’t reach Cloudflare yet/);
    dns['MX example.com'] = ['13 route1.mx.cloudflare.net'];
    f.st.rules[0].enabled = false;
    assert.match(ok(await f.o.a('email.check', { domain: 'example.com' })).forwarding.forwards[0].why, /turned off at Cloudflare/);
    dns['MX mail.example.com'] = ['13 route1.mx.cloudflare.net'];
    assert.deepEqual(ok(await f.o.a('email.check', { domain: 'mail.example.com' })).forwarding.forwards.map((x: any) => x.from), ['news@mail.example.com'], 'a subdomain’s own');

    f.st.refused = /email\/routing/;
    const refused = ok(await f.o.a('email.check', { domain: 'example.com' }));
    assert.equal(refused.forwarding.state, 'cant_read');
    assert.match(refused.forwarding.why, /Email Routing Addresses: Edit/);
    assert.match(refused.verdict, /needs work/, 'the rest of the check still stands');
    assert.equal(all(f.app.db, 'SELECT 1 FROM changes').length, 0, 'a check changes nothing');
  } finally { f.close(); }

  const app = testApp(), o = await testOrg(app);
  world('cloudflare');
  const none = ok(await o.h('email.check', { domain: 'example.com' })).forwarding;
  assert.equal(none.state, 'no_account');
  assert.match(none.why, /Connect that account first/);
  world('godaddy');
  const away = ok(await o.h('email.check', { domain: 'example.com' })).forwarding;
  assert.equal(away.state, 'elsewhere');
  assert.equal(away.fix.tool, 'domain.move_dns');
  world(undefined, {}, '');
  dnsDeps.host = async () => ({ zone: undefined, host: undefined, nameservers: [] }) as never;
  assert.equal(ok(await o.h('email.check', { domain: 'example.com' })).forwarding.state, 'cant_read');
});

// --- the page -------------------------------------------------------------------------------------------------------------
test('the email page’s calls work through the real server as a person’s, and a read-only teammate can look but not add', async () => {
  const f = await cloudflareFake();
  resetRateLimits();
  const { createInvite, acceptInvite } = await import('../src/auth.ts');
  const http = createHttp(f.app);
  const server = await new Promise<ReturnType<typeof serve>>((r) => { const s = serve({ fetch: http.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { f.app.services.listen = { host: '127.0.0.1', port: info.port }; r(s); }); });
  const base = `http://localhost:${(f.app.services.listen as any).port}`;
  const browser = () => {
    let cookie = '', bind = '';
    return async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${base}${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: base, ...(cookie && { cookie, 'x-unit7-bind': bind }) } });
      const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
  };
  try {
    world('cloudflare', { 'MX example.com': ['13 route1.mx.cloudflare.net'] });
    const sam = browser();
    await sam('POST', '/api/auth/login', { email: all<{ email: string }>(f.app.db, 'SELECT email FROM users')[0]!.email, password: 'correct horse battery' });
    const me = (await sam('GET', '/api/me')).body;
    const page =(await sam('POST', '/api/tools/email.check', { input: { domain: 'example.com' } })).body;
    assert.equal(page.status, 'ok');
    for (const k of ['verdict', 'spf', 'dkim', 'dmarc', 'sender', 'forwarding']) assert.ok(k in page.output, k);
    assert.equal(page.output.forwarding.state, 'off');

    assert.equal((await sam('POST', '/api/tools/email.forward', { input: BARE })).body.output.waiting, 'inbox');
    f.clicked();
    assert.equal((await sam('POST', '/api/tools/email.forward', { input: BARE })).body.output.forwarded, true);
    assert.equal((await sam('POST', '/api/tools/email.check', { input: { domain: 'example.com' } })).body.output.forwarding.state, 'on');

    const web = browser(), owner = { user: me.user, org: me.org, role: 'owner', via: 'session' } as any;
    await acceptInvite(f.app.db, createInvite(f.app.db, owner, 'kim@example.com', 'readonly' as any), { name: 'Kim', password: 'correct horse battery' });
    await web('POST', '/api/auth/login', { email: 'kim@example.com', password: 'correct horse battery' });
    assert.equal((await web('POST', '/api/tools/email.check', { input: { domain: 'example.com' } })).body.status, 'ok');
    assert.equal((await web('POST', '/api/tools/email.forward', { input: { ...BARE, from: 'sales@example.com' } })).body.status, 'denied');
  } finally { server.close(); f.close(); }
});

test('the page can be found, and the words a person reads are there', () => {
  const src = (p: string) => readFileSync(new URL(`../web/src/${p}`, import.meta.url), 'utf8');
  assert.match(src('App.tsx'), /path === '\/email'\) page = <EmailPage/);
  assert.match(src('App.tsx'), /match\('\/email\/:domain', path\)/);
  assert.match(src('App.tsx'), /go\('\/email'\)/, 'from ⌘K');
  assert.match(src('pages/Connections.tsx'), /<A href="\/email"/, 'from the Domains & DNS group');
  assert.match(src('pages/map/parts.tsx'), /navigate\(`\/email\/\$\{root\}`\)/, 'from a domain’s screen');
  assert.match(src('pages/map/Inside.tsx'), /navigate\(`\/email\/\$\{a\.name\}`\)/, 'and a subdomain’s');
  assert.ok(TOOL_WORDS['auth.sign_in'] && TOOL_WORDS['firebase.auth_domains']);
});

test('on the page a tool’s words for an AI become a person’s: no flag names, and the button to press', async () => {
  // what the tools really say, a dot in an address and all
  const f = await cloudflareFake([{ id: 'mx', type: 'MX', name: 'example.com', content: 'mx1.mailhost.example', priority: 10, ttl: 1 }]);
  try {
    world('cloudflare');
    const moved = failed(await f.o.h('email.forward', BARE));
    assert.equal(noFlag(moved.message), 'Mail for example.com goes to mx1.mailhost.example now. Forwarding sends all of it to Cloudflare instead, every address, so anything you read there stops arriving.');
    f.st.recs.length = 0;
    f.st.rules.push({ id: 'r', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'hello@example.com' }], actions: [{ type: 'forward', value: ['old@inbox.example'] }] });
    f.st.addresses.push({ id: 'a', email: 'ada@inbox.example', verified: '2026-11-06T10:00:00Z' });
    assert.equal(noFlag(failed(await f.o.h('email.forward', BARE)).message), 'hello@example.com goes to old@inbox.example now.', 'it stops at the sentence, not at the first dot');
  } finally { f.close(); }
  assert.equal(noFlag('Nothing to confirm here.'), 'Nothing to confirm here.');
  assert.equal(pressAgain('Click it (check spam too), then run this again. Nothing has changed.', 'Add the forward'), 'Click it (check spam too), then press Add the forward again. Nothing has changed.');
  assert.equal(pressAgain('DNS can take longer. Run this again to finish.', 'Set up sending'), 'DNS can take longer. Press Set up sending again to finish.');
  assert.equal(pressAgain('Then run email.setup again.', 'Set up sending'), 'Then press Set up sending again.');
  assert.equal(pressAgain(undefined, 'Check it'), undefined);
});
