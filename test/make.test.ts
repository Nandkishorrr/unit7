// Staging in one click (src/tools/staging.ts) and Add a tool to my server (src/tools/addons.ts). The server is a
// stand-in (ssh exec replaced) that answers like a healthy Docker host; Coolify is a stand-in too, answering like v4.4,
// reached with real curl and the config Unit7 sends on stdin (the test/coolify-build.test.ts style). Covers: live-key
// detection, the data copy into a NEW database (never over production), the anonymize SQL, stop on failure and reuse,
// taking a copy down, the Coolify path, the add-on room check, the install calls, the domain step and the keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions, type ExecResult } from '../src/connectors/ssh.ts';
import { all, get, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { CURL, coolifyTiming } from '../src/connectors/coolify.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import { decideApproval, execute, type ToolResult } from '../src/tools/runtime.ts';
import { anonymizeSql, liveReason, piiColumns, piiOf } from '../src/tools/staging.ts';
import { ADDONS, addonDns, claimResult, claimScript, gateRoute } from '../src/tools/addons.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { fakeKuma, isKumaTrip, runInKuma } from './kuma-fixture.ts';

const TOKEN = '3|unit7testtokenAbC123xyz';
const LIVE = 'sk_live_51HxQwErTyUiOp0987654321abcd';
const MASTER = 'meiliMasterKey7Qx2Lp9Zr4Vt6Ny8Wb';
coolifyTiming.pollMs = 5;
const res = (stdout = '', code = 0): ExecResult => ({ code, stdout, stderr: code ? 'it failed' : '', truncated: false });
const COLUMNS = 'users.email\nusers.name\nusers.phone\nusers.bio\nproducts.name\norders.billing_email\n';
// what a tool's own first setup answers from inside the server (the password made there, then the tool's reply)
const CLAIM_PW = 'U7aclaimedonserver0123456789abcdef012345';
let claimReply = 'unit7-users=1\nunit7-http=200';
// public DNS as the add-ons see it: nothing points anywhere unless a test says so
const dnsSays: Record<string, { a?: string[]; cname?: string[] }> = {};
addonDns.look = () => ({ soa: async () => { throw new Error('none'); }, ns: async () => [], a: async (h: string) => dnsSays[h]?.a ?? [], cname: async (h: string) => dnsSays[h]?.cname ?? [] });

// --- pure parts ---------------------------------------------------------------------------------------------
test('live-looking values are named, never shown; names, emails and phones are found by column', () => {
  assert.equal(liveReason('STRIPE_SECRET_KEY', LIVE), 'a live payment key');
  assert.equal(liveReason('RAZORPAY_KEY', 'rzp_live_AbCdEf123456'), 'a live payment key');
  assert.equal(liveReason('STRIPE_KEY', 'sk_test_abc'), undefined, 'a test key is fine');
  assert.equal(liveReason('PAYPAL_LIVE_ID', 'merchant-1'), '“live” in its name');
  assert.equal(liveReason('DELIVERY_ZONE', 'north'), undefined, '“delivery” isn’t “live”');
  assert.equal(liveReason('PROD_TOKEN', 'x'), '“production” in its name');
  assert.equal(liveReason('SITE_URL', 'https://shop.example.com/', { prodHosts: ['shop.example.com'] }), 'your live site’s address (shop.example.com)');
  assert.equal(liveReason('API', 'https://api.prod.example.org'), 'your live site’s address (api.prod.example.org)');
  assert.equal(liveReason('API', 'https://api.example.org'), undefined);
  assert.match(liveReason('OTHER_DB', 'postgres://app:pw@db.example.com/app')!, /database address/);
  assert.match(liveReason('MAIL', 'credential://resend/acme/token', { account: 'resend' })!, /connected resend account/);

  assert.deepEqual(['email', 'billing_email', 'e_mail', 'phone_number', 'mobile', 'first_name', 'username'].map((c) => piiOf('things', c)), ['email', 'email', 'email', 'phone', 'phone', 'name', 'name']);
  assert.equal(piiOf('products', 'name'), undefined, 'a product’s name isn’t a person’s');
  assert.equal(piiOf('customers', 'name'), 'name');
  assert.equal(piiOf('users', 'email_verified'), undefined);
  assert.deepEqual(piiColumns(`${COLUMNS}bad;drop.x\n(3 rows)\n`), [
    { table: 'users', column: 'email', as: 'email' }, { table: 'users', column: 'name', as: 'name' }, { table: 'users', column: 'phone', as: 'phone' }, { table: 'orders', column: 'billing_email', as: 'email' },
  ]);
  const cols = piiColumns(COLUMNS);
  assert.equal(anonymizeSql('postgres', cols), [
    'BEGIN;',
    `UPDATE "users" SET "email" = 'u' || left(md5("email"), 10) || '@example.com', "name" = 'Person ' || left(md5("name"), 6), "phone" = '+1555' || left(regexp_replace(md5("phone"), '[^0-9]', '', 'g') || '0000000', 7);`,
    `UPDATE "orders" SET "billing_email" = 'u' || left(md5("billing_email"), 10) || '@example.com';`,
    'COMMIT;',
  ].join('\n'));
  assert.match(anonymizeSql('mysql', cols), /^START TRANSACTION;\nUPDATE `users` SET `email` = CONCAT\('u', LEFT\(MD5\(`email`\), 10\), '@example\.com'\)/);
  assert.throws(() => anonymizeSql('postgres', [{ table: 'users"; DROP TABLE x; --', column: 'email', as: 'email' }]), /plain column name/);
});

// --- a stand-in server ------------------------------------------------------------------------------------------
type Seen = { command: string; stdin: string };
function fakeHost(app: App, o: { coolifyPort?: number; answer?: (command: string, stdin: string) => ExecResult | undefined } = {}) {
  const seen: Seen[] = [];
  ssh(app).exec = async (_s, command, e: ExecOptions = {}) => {
    const stdin = String(e.stdin ?? '');
    if (stdin === XRAY_PROBE) return res(COOLIFY_HOST);
    if (command === CURL && o.coolifyPort) return new Promise((resolve) => {
      const p = spawn('curl', ['-K', '-']);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
      p.stdin.end(stdin.replace('http://127.0.0.1:8000/', `http://127.0.0.1:${o.coolifyPort}/`));
    });
    seen.push({ command, stdin });
    const a = o.answer?.(command, stdin);
    if (a) return a;
    if (command.includes('@@unit7:secret')) return res(`\n@@unit7:secret\n${CLAIM_PW}\n\n@@unit7:reply\n${claimReply}\n`);
    if (stdin.includes('information_schema.columns')) return res(COLUMNS);
    if (command.includes('wc -c <')) return res('2048\nchecksum0001\n');
    if (command.includes('gunzip -t')) return res('checksum0001\n');
    if (command.includes(`'inspect'`) && command.includes('State.Status')) return res('running 0 false 0');
    if (command.includes('curlimages/curl')) return res('200');
    return res();
  };
  return seen;
}
const approve = async (app: App, o: { orgId: string; human: any }, r: unknown, name?: string) => decideApproval(app, o.orgId, o.human, (r as { approvalId: string }).approvalId, true, name) as Promise<ToolResult>;
const secretsIn = (app: App) => JSON.stringify([all(app.db, 'SELECT * FROM audit'), all(app.db, 'SELECT * FROM events'), all(app.db, 'SELECT * FROM messages'), all(app.db, 'SELECT * FROM approvals')]);

// --- a Unit7 project ------------------------------------------------------------------------------------------
async function shop() {
  const app = testApp();
  const o = await testOrg(app);
  run(app.db, `UPDATE orgs SET offsite = 'off' WHERE id = ?`, o.orgId); // no background off-server copies
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`,
    srv, o.orgId, JSON.stringify({ publicIp: '203.0.113.9', mem_available: 3 * 1024 ** 3 }));
  const seen = fakeHost(app);
  const { projectId, environments } = ok(await o.h('project.create', { name: 'Shop', environments: ['production'] }));
  const prod = environments[0].id;
  const web = ok(await o.h('service.create', { environmentId: prod, name: 'web', serverId: srv, source: { type: 'image', image: 'nginx:alpine' }, port: 80 })).serviceId;
  const db = ok(await o.h('database.create', { environmentId: prod, engine: 'postgres', name: 'shop-db', serverId: srv, injectInto: web })).serviceId;
  for (const [key, value] of [['STRIPE_SECRET_KEY', LIVE], ['PUBLIC_URL', 'https://shop.example.com'], ['API_BASE', 'https://api.example.org'], ['APP_NAME', 'Shop']]) ok(await o.h('env.set', { serviceId: web, key, value }));
  ok(await o.h('env.set', { projectId, key: 'PAYPAL_LIVE_ID', value: 'merchant-123' }));
  ok(await o.h('env.set', { projectId, key: 'SUPPORT_EMAIL', value: 'help@example.com' }));
  run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status) VALUES (?, ?, 'shop.example.com', ?, 'active')`, id('dom'), o.orgId, web);
  ok(await o.h('vault.set', { ref: 'credential://stripe-test/sam/secret', value: 'sk_test_abcdef123456' }));
  seen.length = 0;
  const container = (svc: string) => JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', svc)!.config).container as string;
  const pw = (svc: string) => app.vault.resolve(o.orgId, JSON.parse(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', svc)!.config).passwordRef);
  return { app, o, srv, projectId, prod, web, db, seen, container, pw };
}
const vars = async (o: any, serviceId: string) => Object.fromEntries(ok(await o.h('env.list', { serviceId })).variables.map((v: any) => [v.key, v]));

test('a Unit7 project: the plan lists live keys and the columns, and changes nothing', async () => {
  const t = await shop();
  const plan = ok(await t.o.a('staging.plan', { projectId: t.projectId }));
  assert.deepEqual(plan.steps, [
    '1. Make the Staging environment', '2. Add web to Staging', '3. Add a fresh Postgres database shop-db', '4. Point web’s DATABASE_URL at the Staging database',
    '5. Copy 2 settings from web', '6. Keep the live PAYPAL_LIVE_ID out of Staging', '7. Take a fresh backup of shop-db',
    '8. Copy shop-db’s data into Staging with names, emails and phones replaced', '9. Deploy web in Staging',
  ]);
  assert.deepEqual(plan.liveKeys.map((l: any) => [l.key, l.why, l.choice]), [
    ['PAYPAL_LIVE_ID', '“live” in its name, set for the whole project', 'skip'], ['PUBLIC_URL', 'your live site’s address (shop.example.com)', 'skip'], ['STRIPE_SECRET_KEY', 'a live payment key', 'skip'],
  ]);
  assert.deepEqual(plan.databases[0].anonymize.map((c: any) => `${c.table}.${c.column}`), ['users.email', 'users.name', 'users.phone', 'orders.billing_email']);
  assert.deepEqual(plan.room, { needMb: 640, freeMb: 3072, fits: true });
  assert.equal(plan.card.kind, 'confirm');
  assert.equal(plan.confirm.mode, 'needs', 'outside the ask box the caller confirms');
  assert.equal(all(t.app.db, `SELECT 1 FROM environments WHERE kind = 'staging'`).length, 0, 'planning changes nothing');
  assert.ok(t.seen.every((x) => !/gunzip|UPDATE/.test(x.command + x.stdin)), 'nothing restored or rewritten while planning');
  const out = JSON.stringify(plan);
  for (const s of [LIVE, 'merchant-123', t.pw(t.db)]) assert.ok(!out.includes(s), 'no value in the plan');
  // an AI outside the ask box gets the card back to show, and nothing is made
  const held = ok(await t.o.a('staging.create', { projectId: t.projectId }));
  assert.equal(held.needsConfirm, true);
  assert.equal(all(t.app.db, `SELECT 1 FROM environments WHERE kind = 'staging'`).length, 0);
});

test('a Unit7 project: stops at the first failure, then makes the copy into new databases and reuses what’s there', async () => {
  const t = await shop();
  const choices = { liveKeys: { STRIPE_SECRET_KEY: 'credential://stripe-test/sam/secret' } };
  // the backup fails: everything before it is made, nothing after it runs
  const failing = fakeHost(t.app, { answer: (c) => (c.includes('2>"$2.err"') ? res('', 1) : undefined) });
  const first = ok(await t.o.h('staging.create', { projectId: t.projectId, ...choices }));
  assert.equal(first.created, false);
  assert.equal(first.failed.step, 'Take a fresh backup of shop-db');
  assert.deepEqual(first.done.map((d: any) => d.step).slice(0, 3), ['Make the Staging environment', 'Add web to Staging', 'Add a fresh Postgres database shop-db']);
  assert.match(first.next, /reused/);
  assert.ok(!failing.some((x) => x.command.includes('gunzip -c')), 'no copy without a fresh backup');
  const staging = get<{ id: string }>(t.app.db, `SELECT id FROM environments WHERE project_id = ? AND kind = 'staging'`, t.projectId)!.id;
  const inStaging = () => all<{ id: string; name: string; kind: string }>(t.app.db, 'SELECT id, name, kind FROM services WHERE environment_id = ? ORDER BY name', staging);
  assert.deepEqual(inStaging().map((s) => s.name), ['shop-db', 'web']);
  assert.equal(get<{ n: number }>(t.app.db, `SELECT count(*) n FROM deployments d JOIN services s ON s.id = d.service_id WHERE s.environment_id = ?`, staging)!.n, 0, 'never deployed past a failure');

  // again, with the server working: what's there is reused, and it finishes
  const seen = fakeHost(t.app);
  const r = ok(await t.o.h('staging.create', { projectId: t.projectId, ...choices }));
  assert.equal(r.created, true);
  assert.match(r.url, /^https:\/\/web-[\w-]+\.203-0-113-9\.sslip\.io$/, 'a free test address');
  assert.deepEqual(r.leftOut, ['PUBLIC_URL'], 'the project-wide live key was already blanked by the first run');
  assert.deepEqual(inStaging().map((s) => s.name), ['shop-db', 'web'], 'nothing made twice');
  const [sdb, sweb] = inStaging().map((s) => s.id);

  // settings: the staging database, a test key, live ones out, the rest copied
  const v = await vars(t.o, sweb!);
  const prodUrl = (await vars(t.o, t.web)).DATABASE_URL.value;
  assert.match(v.DATABASE_URL.value, /^credential:\/\/postgres\/svc-/);
  assert.notEqual(v.DATABASE_URL.value, prodUrl, 'the copy talks to its own database');
  assert.equal(v.STRIPE_SECRET_KEY.value, 'credential://stripe-test/sam/secret');
  assert.equal(v.PUBLIC_URL, undefined, 'the live site’s address stays out');
  assert.deepEqual([v.PAYPAL_LIVE_ID.from, v.PAYPAL_LIVE_ID.value], ['environment', ''], 'a project-wide live key is blanked for Staging');
  assert.deepEqual([v.APP_NAME.value, v.API_BASE.value, v.SUPPORT_EMAIL.from], ['Shop', 'https://api.example.org', 'project']);

  // data: a fresh backup of production, restored into the NEW database, then names, emails and phones replaced there
  const bak = get<{ reason: string; service_id: string }>(t.app.db, `SELECT reason, service_id FROM backups WHERE status = 'done'`)!;
  assert.deepEqual([bak.reason, bak.service_id], ['for the Staging copy', t.db]);
  const restore = seen.find((x) => x.command.includes('gunzip -c'))!;
  assert.ok(restore.command.includes(`'${t.container(sdb!)}'`) && !restore.command.includes(`'${t.container(t.db)}'`), 'restored into the staging database only');
  assert.equal(restore.stdin, `${t.pw(sdb!)}\n`, 'its password on stdin, never on the command line');
  const scrub = seen.find((x) => x.stdin.includes('UPDATE "users"'))!;
  assert.ok(scrub.command.includes(`'${t.container(sdb!)}'`), 'scrubbed in the copy');
  assert.ok(!seen.some((x) => x.command.includes(`'${t.container(t.db)}'`) && /UPDATE|gunzip -c/.test(x.stdin + x.command)), 'production is never written');
  const live = get<{ status: string }>(t.app.db, `SELECT status FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1`, sweb)!;
  assert.equal(live.status, 'live');

  // the copy step itself refuses production, its own source, and its own environment
  const b = get<{ id: string }>(t.app.db, `SELECT id FROM backups WHERE service_id = ? AND status = 'done'`, t.db)!.id;
  const into = async (serviceId: string) => { const x = await t.o.h('staging.copy_data', { backupId: b, serviceId }); return x.status === 'error' ? x.error.message : x.status; };
  assert.match(await into(t.db), /in production/);
  const devDb = ok(await t.o.h('database.create', { environmentId: t.prod, engine: 'postgres', name: 'other-db', serverId: t.srv })).serviceId;
  assert.match(await into(devDb), /in production/);

  // once more: only what's new in production (the database just added) is made and copied; shop-db isn't copied twice
  const again = ok(await t.o.h('staging.create', { projectId: t.projectId, ...choices }));
  assert.deepEqual(again.done.map((d: any) => d.step), ['Add a fresh Postgres database other-db', 'Take a fresh backup of other-db', 'Copy other-db’s data into Staging with names, emails and phones replaced']);
  assert.equal(all(t.app.db, `SELECT 1 FROM backups WHERE service_id = ? AND status = 'done'`, t.db).length, 1, 'the data isn’t copied twice');

  for (const s of [LIVE, 'merchant-123', t.pw(t.db), t.pw(sdb!), 'sk_test_abcdef123456']) assert.ok(!secretsIn(t.app).includes(s) && !JSON.stringify([first, r, again]).includes(s), 'no value in results, audit, events or approvals');
});

test('a person’s choices stay a person’s: an AI’s “copy anyway”, “confirmed” or “don’t scrub” waits for them; the copy steps check for themselves', async () => {
  const t = await shop();
  // the plan’s choices, set by an AI, become an approval request (the card says which)
  const copyLive = await t.o.a('staging.create', { projectId: t.projectId, liveKeys: { STRIPE_SECRET_KEY: 'copy' } }) as any;
  assert.equal(copyLive.status, 'approval_required');
  assert.match(copyLive.why, /Copies live-looking settings as they are: STRIPE_SECRET_KEY/);
  assert.equal((await t.o.a('staging.create', { projectId: t.projectId, confirmed: true })).status, 'approval_required');
  assert.equal((await t.o.a('staging.create', { projectId: t.projectId, anonymize: false })).status, 'approval_required');
  assert.equal(all(t.app.db, `SELECT 1 FROM environments WHERE kind = 'staging'`).length, 0, 'nothing made while it waits');

  // env.copy by an AI: plain settings yes, a live key no
  const stg = ok(await t.o.h('environment.create', { projectId: t.projectId, name: 'Staging', kind: 'staging' })).id;
  ok(await t.o.a('env.copy', { fromServiceId: t.web, environmentId: stg, keys: ['APP_NAME'] }));
  const live = await t.o.a('env.copy', { fromServiceId: t.web, environmentId: stg, keys: ['STRIPE_SECRET_KEY'] }) as any;
  assert.equal(live.status, 'error');
  assert.match(live.error.message, /look live, so an AI doesn’t copy them: STRIPE_SECRET_KEY/);

  // copy_data: never into a database the copy didn’t make; an AI never turns the scrub off
  ok(await t.o.h('backup.create', { serviceId: t.db, reason: 'test' }));
  const b = get<{ id: string }>(t.app.db, `SELECT id FROM backups WHERE service_id = ? AND status = 'done'`, t.db)!.id;
  const mine = ok(await t.o.h('database.create', { environmentId: stg, engine: 'postgres', name: 'hand-made', serverId: t.srv })).serviceId;
  const foreign = await t.o.h('staging.copy_data', { backupId: b, serviceId: mine }) as any;
  assert.match(foreign.error.message, /database the test copy made itself/);
  run(t.app.db, `INSERT INTO made (id, org_id, kind, key, data) VALUES (?, ?, 'staging', ?, ?)`, id('mad'), t.o.orgId, t.projectId, JSON.stringify({ kind: 'unit7', projectId: t.projectId, services: [mine], copied: [] }));
  // (even in a test environment at Full autopilot: an AI asking to skip the scrub waits for a person, who sees what it means)
  run(t.app.db, 'UPDATE environments SET autonomy = 4 WHERE id = ?', stg);
  const raw = await t.o.a('staging.copy_data', { backupId: b, serviceId: mine, anonymize: false }) as any;
  assert.equal(raw.status, 'approval_required');
  assert.match(raw.why, /as it is \(names and emails included\)/);

  // a scrub that fails takes the copied data out again, and says so
  const seen = fakeHost(t.app, { answer: (_c, stdin) => (stdin.includes('UPDATE "users"') ? res('', 1) : undefined) });
  const failed = await t.o.h('staging.copy_data', { backupId: b, serviceId: mine }) as any;
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'scrub_failed');
  assert.match(failed.error.message, /removed the copied data again/);
  const drop = seen.find((x) => x.stdin.includes('DROP SCHEMA'))!;
  assert.ok(drop && drop.command.includes(`'${t.container(mine)}'`) && !drop.command.includes(`'${t.container(t.db)}'`), 'dropped in the copy only');
  assert.ok(seen.findIndex((x) => x.stdin.includes('DROP SCHEMA')) > seen.findIndex((x) => x.command.includes('gunzip -c')), 'after the restore');
  assert.ok(get(t.app.db, `SELECT 1 FROM events WHERE type = 'staging.scrub_failed'`));
});

test('a Unit7 project: taking the copy down is a person’s, and leaves production alone', async () => {
  const t = await shop();
  ok(await t.o.h('staging.create', { projectId: t.projectId }));
  assert.equal((await t.o.a('staging.remove', { projectId: t.projectId })).status, 'denied', 'an AI never deletes');
  const seen = fakeHost(t.app);
  const r = ok(await t.o.h('staging.remove', { projectId: t.projectId }));
  assert.equal(r.removed, true);
  assert.deepEqual(r.done.map((d: any) => d.step), ['Remove web from Staging', 'Remove shop-db from Staging with its copied data', 'Remove the Staging environment']);
  assert.equal(all(t.app.db, `SELECT 1 FROM environments WHERE project_id = ? AND kind = 'staging'`, t.projectId).length, 0);
  assert.deepEqual(all<{ name: string }>(t.app.db, 'SELECT name FROM services WHERE environment_id = ? ORDER BY name', t.prod).map((s) => s.name), ['shop-db', 'web'], 'production untouched');
  assert.ok(seen.some((x) => x.command.includes(`'volume' 'rm'`)), 'the copied data goes too');
  assert.ok(!seen.some((x) => x.command.includes(t.container(t.db))), 'nothing touched production’s database');
  assert.equal((await t.o.h('staging.remove', { projectId: t.projectId })).status, 'error', 'nothing left to take down');
});

// --- a stand-in Coolify -------------------------------------------------------------------------------------------
function fakeCoolify() {
  const seen: { method: string; path: string; body: any }[] = [];
  const projects: { uuid: string; name: string; environments: { name: string; uuid: string }[] }[] = [];
  const things: any[] = [], schedules: any[] = [];
  const ticks = new Map<string, number>();
  let n = 0;
  const uid = (p: string) => `${p}${String(++n).padStart(4, '0')}`;
  const tick = (k: string) => { const v = (ticks.get(k) ?? 0) + 1; ticks.set(k, v); return v; };
  const SERVICE_ENVS: Record<string, { key: string; value: string }[]> = { meilisearch: [{ key: 'SERVICE_PASSWORD_MEILISEARCH', value: MASTER }, { key: 'MEILI_ENV', value: 'production' }] };
  const server = createServer(async (req, rsp) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://x'), path = url.pathname.replace(/^\/api\/v1/, ''), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: req.method!, path: path + url.search, body });
    const send = (status: number, b: unknown) => { rsp.writeHead(status, { 'content-type': typeof b === 'string' ? 'text/plain' : 'application/json' }); rsp.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Unauthenticated.' });
    const r = `${req.method} ${path}`, find = (u: string) => things.find((t) => t.uuid === u);
    let m: RegExpExecArray | null;
    if (r === 'GET /version') return send(200, '4.4.0');
    if (r === 'GET /team') return send(200, { id: 0, name: 'Sam’s team' });
    if (r === 'GET /servers') return send(200, [{ uuid: 'srvuuid01', name: 'localhost', ip: 'host.docker.internal' }]);
    if (r === 'GET /servers/srvuuid01/sentinel') return send(200, { sentinel_token: 'sentinel-token-value-1' });
    if (r === 'POST /deploy') return url.searchParams.get('uuid') ? send(200, { deployments: [{ message: 'Deployment queued.', deployment_uuid: uid('dep') }] }) : send(400, { message: 'You must provide uuid or tag.' });
    if ((m = /^GET \/deployments\/(\w+)$/.exec(r))) return send(200, { deployment_uuid: m[1], status: tick(m[1]!) < 2 ? 'in_progress' : 'finished' });
    if (r === 'GET /projects') return send(200, projects.map((p) => ({ uuid: p.uuid, name: p.name })));
    if (r === 'POST /projects') { if (!body?.name) return send(422, { message: 'Validation failed.', errors: { name: ['The name field is required.'] } }); const p = { uuid: uid('proj'), name: body.name, environments: [{ name: 'production', uuid: uid('env') }] }; projects.push(p); return send(201, { uuid: p.uuid }); }
    if ((m = /^GET \/projects\/(\w+)$/.exec(r))) { const p = projects.find((x) => x.uuid === m![1]); return p ? send(200, p) : send(404, { message: 'Project not found.' }); }
    if ((m = /^POST \/projects\/(\w+)\/environments$/.exec(r))) {
      const p = projects.find((x) => x.uuid === m![1])!;
      if (p.environments.some((e) => e.name === body.name)) return send(409, { message: 'Environment with this name already exists.' });
      const e = { name: body.name, uuid: uid('env') }; p.environments.push(e); return send(201, { uuid: e.uuid });
    }
    if ((m = /^GET \/projects\/(\w+)\/([\w-]+)$/.exec(r))) {
      const env = projects.find((x) => x.uuid === m![1])?.environments.find((e) => e.uuid === m![2] || e.name === m![2]);
      const here = things.filter((t) => t.project_uuid === m![1] && t.environment_name === env?.name);
      return send(200, { applications: here.filter((t) => t.kind === 'application'), services: here.filter((t) => t.kind === 'service'), postgresqls: here.filter((t) => t.kind === 'database') });
    }
    if ((m = /^POST \/applications\/(dockerimage|public)$/.exec(r))) {
      const t = { ...body, kind: 'application', uuid: uid('app'), status: 'exited', envs: [] as any[] };
      t.fqdn = body.domains ?? `http://${t.uuid}.203.0.113.9.sslip.io`;
      things.push(t); return send(201, { uuid: t.uuid, domains: String(t.fqdn).split(',') });
    }
    if ((m = /^PATCH \/(applications|databases|services)\/(\w+)\/envs\/bulk$/.exec(r))) {
      const t = find(m[2]!); for (const v of body.data) { t.envs = t.envs.filter((e: any) => e.key !== v.key); t.envs.push(v); }
      return send(201, { message: 'Environment variables updated.' });
    }
    if ((m = /^GET \/(applications|services)\/(\w+)\/envs$/.exec(r))) return send(200, find(m[2]!).envs.map((e: any, i: number) => ({ uuid: `e${i}`, key: e.key, value: e.value, is_preview: false })));
    if ((m = /^POST \/databases\/(\w+)$/.exec(r))) {
      const t = { ...body, kind: 'database', engine: m[1], uuid: uid('db'), status: 'exited', database_type: `standalone-${m[1]}`, envs: [] };
      things.push(t); return send(201, { uuid: t.uuid });
    }
    if (r === 'POST /services') {
      if (body.type === 'plausible') return send(404, { message: 'Service not found.' });
      const part = body.urls?.[0]?.name ?? body.type ?? 'unleash';
      const t = { ...body, kind: 'service', uuid: uid('svc'), status: 'exited', started: !!body.instant_deploy, envs: (SERVICE_ENVS[body.type] ?? []).map((e) => ({ ...e })) } as any;
      t.applications = [{ name: part, fqdn: body.urls?.[0]?.url ?? `http://${part}-${t.uuid}.203.0.113.9.sslip.io` }];
      things.push(t); return send(201, { uuid: t.uuid, domains: t.applications.map((a: any) => a.fqdn) });
    }
    if ((m = /^POST \/services\/(\w+)\/(start|stop)$/.exec(r))) { const t = find(m[1]!); if (!t) return send(404, { message: 'Not found.' }); t.started = m[2] === 'start'; return send(200, { message: `Service ${m[2]} request queued.` }); }
    if ((m = /^GET \/(applications|databases|services)\/(\w+)$/.exec(r))) {
      const t = find(m[2]!); if (!t) return send(404, { message: 'Not found.' });
      if (t.kind !== 'application') t.status = t.kind === 'service' && !t.started ? 'exited' : tick(t.uuid) < 2 ? 'starting' : 'running:healthy';
      return send(200, t);
    }
    if ((m = /^DELETE \/(applications|databases|services)\/(\w+)$/.exec(r))) { const t = find(m[2]!); if (!t) return send(404, { message: 'Not found.' }); things.splice(things.indexOf(t), 1); return send(200, { message: 'Deletion request queued.' }); }
    if (r === 'GET /github-apps') return send(200, []);
    if ((m = /^(GET|POST) \/databases\/(\w+)\/backups$/.exec(r))) {
      if (m[1] === 'GET') return send(200, schedules.filter((b) => b.db === m![2]).map(({ executions: _e, ...b }) => b));
      const b = { uuid: uid('bak'), db: m[2], ...body, executions: [] as any[] }; schedules.push(b);
      if (body.backup_now) b.executions.push({ uuid: uid('exe'), status: 'running', created_at: new Date().toISOString(), filename: `/data/coolify/backups/databases/${m[2]}/pg-dump-${n}.dmp`, size: 2048 });
      return send(201, { uuid: b.uuid });
    }
    if ((m = /^GET \/databases\/(\w+)\/backups\/(\w+)\/executions$/.exec(r))) {
      const b = schedules.find((x) => x.uuid === m![2])!;
      const out = { executions: b.executions.map((e: any) => ({ ...e })) };
      for (const e of b.executions) e.status = 'success';
      return send(200, out);
    }
    if ((m = /^POST \/databases\/(\w+)\/imports$/.exec(r))) return send(201, { message: 'Import queued.', activity_id: uid('act') });
    if ((m = /^GET \/databases\/(\w+)\/imports\/(\w+)$/.exec(r))) return send(200, { status: tick(m[2]!) < 2 ? 'in_progress' : 'finished' });
    send(404, { message: 'Not found.' });
  });
  const state = { seen, things, projects };
  return new Promise<typeof state & { port: number; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r(Object.assign(state, { port: (server.address() as { port: number }).port, close: () => server.close() }))));
}
async function coolifyBox(mem = 1024) {
  const app = testApp();
  const c = await fakeCoolify();
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`,
    srv, o.orgId, JSON.stringify({ sudo: 'root', publicIp: '203.0.113.9', mem_available: mem * 1024 * 1024, web: 'coolify-proxy|traefik:v3.1' }));
  const seen = fakeHost(app, { coolifyPort: c.port });
  ok(await o.h('coolify.connect', { serverId: srv, token: TOKEN }));
  c.seen.length = 0;
  return { app, c, o, srv, seen };
}
const calls = (c: { seen: { method: string; path: string; body: any }[] }, method: string, path: RegExp) => c.seen.filter((x) => x.method === method && path.test(x.path));

test('a Coolify app: a staging environment in its project, fresh database, settings without live keys, data copied and scrubbed', async () => {
  const { app, c, o, srv, seen } = await coolifyBox();
  try {
    // production: an app on shop.example.com with a Postgres database
    const p = ok(await o.h('coolify.create_project', { serverId: srv, name: 'shop' }));
    const web = ok(await o.h('coolify.create_app', { serverId: srv, project: p.project, name: 'web', image: 'ghcr.io/example/web:1.0', port: 3000, domains: ['shop.example.com'] }));
    const pdb = ok(await o.h('coolify.create_database', { serverId: srv, project: p.project, engine: 'postgresql', name: 'shop-db', injectInto: web.uuid }));
    c.things.find((x) => x.uuid === web.uuid).envs.push({ key: 'STRIPE_SECRET_KEY', value: LIVE }, { key: 'NEXT_PUBLIC_SITE', value: 'https://shop.example.com' }, { key: 'FEATURE_X', value: 'on' });
    c.seen.length = 0;

    const plan = ok(await o.a('staging.plan', { serverId: srv, app: web.uuid }));
    assert.deepEqual(plan.steps, ['1. Add a staging environment to shop', '2. Add web to staging', '3. Add a fresh Postgres database shop-db', '4. Copy 1 setting from web',
      '5. Take a fresh backup of shop-db', '6. Copy shop-db’s data into staging with names, emails and phones replaced', '7. Deploy web in staging']);
    assert.deepEqual(plan.liveKeys.map((l: any) => [l.key, l.why]), [['STRIPE_SECRET_KEY', 'a live payment key'], ['NEXT_PUBLIC_SITE', 'your live site’s address (shop.example.com)']]);
    assert.deepEqual(plan.databases[0].anonymize.map((x: any) => `${x.table}.${x.column}`), ['users.email', 'users.name', 'users.phone', 'orders.billing_email']);
    assert.equal(calls(c, 'POST', /./).length, 0, 'planning changes nothing');
    assert.ok(!JSON.stringify(plan).includes(LIVE));

    const r = ok(await o.h('staging.create', { serverId: srv, app: web.uuid }));
    assert.equal(r.created, true);
    assert.match(r.url, /^https:\/\/app\d+\.203\.0\.113\.9\.sslip\.io$/);
    const copy = c.things.find((x) => x.kind === 'application' && x.environment_name === 'staging');
    const sdb = c.things.find((x) => x.kind === 'database' && x.environment_name === 'staging');
    assert.deepEqual([copy.name, copy.docker_registry_image_name, copy.docker_registry_image_tag, copy.project_uuid], ['web', 'ghcr.io/example/web', '1.0', p.project], 'the same code, same project');
    assert.equal(sdb.name, 'shop-db');
    assert.deepEqual(copy.envs.map((e: any) => e.key).sort(), ['DATABASE_URL', 'FEATURE_X'], 'its own database, no live keys');
    assert.ok(copy.envs.find((e: any) => e.key === 'DATABASE_URL').value.includes(`@${sdb.uuid}:`), 'wired to the new database');
    // the copy is restored into the new database from production's fresh backup; never into production's
    const imports = calls(c, 'POST', /\/imports$/);
    assert.deepEqual(imports.map((x) => x.path), [`/databases/${sdb.uuid}/imports`]);
    assert.match(imports[0]!.body.server_path, new RegExp(`^/data/coolify/backups/databases/${pdb.uuid}/`));
    const scrub = seen.find((x) => x.stdin.includes('UPDATE "users"'))!;
    assert.ok(scrub.command.includes(`'${sdb.uuid}'`) && !scrub.command.includes(`'${pdb.uuid}'`), 'scrubbed inside the copy’s container');
    assert.ok(calls(c, 'POST', /^\/deploy\?uuid=/).every((x) => x.path.includes(copy.uuid)), 'only the copy is deployed');

    // copy_data refuses to go back into production
    const back = await o.h('staging.copy_data', { serverId: srv, fromDb: sdb.uuid, toDb: pdb.uuid, file: '/data/x.dmp' });
    assert.equal(back.status, 'error');
    assert.match((back as any).error.message, /staging database/);
    // copy_settings checks for live keys itself: an AI asking for one straight away gets nothing copied
    const sneak = await o.a('staging.copy_settings', { serverId: srv, from: web.uuid, to: copy.uuid, keys: ['STRIPE_SECRET_KEY', 'FEATURE_X'] }) as any;
    assert.equal(sneak.status, 'error');
    assert.match(sneak.error.message, /STRIPE_SECRET_KEY \(a live payment key\)/);
    assert.ok(!copy.envs.some((e: any) => e.key === 'STRIPE_SECRET_KEY'), 'nothing copied');
    // and a login meant for people is never opened for a test copy, whoever asks
    app.vault.put(o.orgId, 'credential://serverapp/box-supa/supabase.dashboard-password', 'dashPassw0rd123', { kind: 'serverapp', meta: { people: true, label: 'Dashboard login' } });
    const login = await o.h('staging.copy_settings', { serverId: srv, from: web.uuid, to: copy.uuid, set: { ADMIN_PASSWORD: 'credential://serverapp/box-supa/supabase.dashboard-password' } }) as any;
    assert.match(login.error.message, /meant for people/);
    assert.ok(!copy.envs.some((e: any) => e.key === 'ADMIN_PASSWORD'));

    // taking it down: the copy and its database (deleting data waits for a yes), never production
    const down = ok(await o.h('staging.remove', { serverId: srv, app: web.uuid }));
    assert.equal(down.removed, false);
    assert.ok(down.failed.approvalId, 'deleting the copy’s data waits for a person’s approval');
    ok(await approve(app, o, { approvalId: down.failed.approvalId }, 'shop-db'));
    assert.equal(ok(await o.h('staging.remove', { serverId: srv, app: web.uuid })).removed, true);
    assert.deepEqual(calls(c, 'DELETE', /./).map((x) => x.path), [`/applications/${copy.uuid}?delete_volumes=false`, `/databases/${sdb.uuid}?delete_volumes=true`]);
    assert.ok(c.things.some((x) => x.uuid === web.uuid) && c.things.some((x) => x.uuid === pdb.uuid), 'production untouched');
    assert.ok(!secretsIn(app).includes(LIVE) && !JSON.stringify([plan, r]).includes(LIVE), 'no live value anywhere');
  } finally { c.close(); }
});

test('other hosts: what they offer, in words', async () => {
  const app = testApp(), o = await testOrg(app);
  const v = ok(await o.a('staging.plan', { host: 'vercel' }));
  assert.equal(v.name, 'Vercel');
  assert.match(v.possible[0], /preview for every branch/);
  assert.equal((await o.a('staging.create', { host: 'vercel' })).status, 'error');
});

// --- add a tool to my server ----------------------------------------------------------------------------------------
test('the catalog: room for each tool, how it’s added, Plausible off, a subdomain suggested', async () => {
  const { app, c, o, srv } = await coolifyBox(1024);
  try {
    run(app.db, `INSERT INTO domains (id, org_id, hostname, status) VALUES (?, ?, 'shop.example.com', 'active'), (?, ?, 'api.example.com', 'active'), (?, ?, 'x.203.0.113.9.sslip.io', 'active')`, id('dom'), o.orgId, id('dom'), o.orgId, id('dom'), o.orgId);
    const cat = ok(await o.a('addon.catalog', {}));
    assert.equal(cat.server.id, srv, 'the server with Coolify connected');
    assert.deepEqual([cat.freeMb, cat.root], [1024, 'example.com']);
    assert.equal(cat.items.length, ADDONS.length);
    const by = Object.fromEntries(cat.items.map((x: any) => [x.id, x]));
    assert.deepEqual([by.umami.how, by.umami.fits, by.umami.suggest], ['coolify', true, 'analytics.example.com']);
    assert.equal(by.glitchtip.fits, false, '1 GB needed, 1 GB free: no room to spare');
    assert.deepEqual([by.plausible.how, by.plausible.instead], ['off', 'umami']);
    assert.equal(calls(c, 'POST', /./).length, 0);
    const p = await o.h('addon.install', { serverId: srv, addon: 'plausible' });
    assert.match((p as any).error.message, /Umami does the same job/);
  } finally { c.close(); }
});

test('installing: Coolify’s one-click service with its domain, the DNS record, healthy, Uptime Kuma’s sites', async () => {
  const { app, c, o, srv } = await coolifyBox(4096);
  // the extra password goes on before it ever starts
  const gates: { file: string; route: string; started: boolean }[] = [];
  const seen = fakeHost(app, { coolifyPort: c.port, answer: (command, stdin) => {
    if (command.includes('unit7-gate-') && stdin.includes('basicAuth')) gates.push({ file: /'(\/data\/coolify\/proxy\/dynamic\/unit7-gate-\w+\.yaml)'/.exec(command)?.[1] ?? '', route: stdin, started: !!c.things.find((x) => x.name === 'uptime-kuma')?.started });
    return undefined;
  } });
  const wrote: { hostname: string; records: any[] }[] = [];
  const real = addonDns.write;
  addonDns.write = async (_ctx, hostname, records) => { wrote.push({ hostname, records }); return { written: true, provider: 'cloudflare', zone: 'example.com', records }; };
  try {
    run(app.db, `INSERT INTO domains (id, org_id, hostname, status) VALUES (?, ?, 'shop.example.com', 'active')`, id('dom'), o.orgId);
    // an AI's install waits for a person, with the whole install on the card
    const held = await o.a('addon.install', { serverId: srv, addon: 'uptime-kuma', domain: 'uptime.example.com' });
    assert.equal(held.status, 'approval_required');
    assert.match((held as any).why, /Adds Uptime Kuma to box \(about 256 MB\) at uptime\.example\.com, writing its DNS record/);
    const r = ok(await approve(app, o, held));
    assert.deepEqual(calls(c, 'POST', /^\/services$/)[0]!.body, { project_uuid: c.projects[0]!.uuid, environment_name: 'production', server_uuid: 'srvuuid01', name: 'uptime-kuma', instant_deploy: false, type: 'uptime-kuma', urls: [{ name: 'uptime-kuma', url: 'https://uptime.example.com' }] });
    // made, its settings in, its extra password in front, and only then started
    const svc = c.things.find((x) => x.name === 'uptime-kuma');
    const order = c.seen.map((x) => `${x.method} ${x.path}`);
    assert.ok(order.indexOf(`PATCH /services/${svc.uuid}/envs/bulk`) < order.indexOf(`POST /services/${svc.uuid}/start`), 'its settings before it starts');
    assert.deepEqual(svc.envs.find((e: any) => e.key === 'UPTIME_KUMA_DB_TYPE')?.value, 'sqlite', 'no open database wizard either');
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.started, false, 'the password was there before it ever answered');
    assert.match(gates[0]!.file, new RegExp(`unit7-gate-${svc.uuid}\\.yaml$`));
    assert.match(gates[0]!.route, /rule: "Host\(`uptime\.example\.com`\)"\n\s+entryPoints: \[https\]/);
    assert.match(gates[0]!.route, /- "unit7:\{SHA\}[A-Za-z0-9+\/=]{28}"/);
    assert.match(gates[0]!.route, new RegExp(`url: "http://uptime-kuma-${svc.uuid}:3001"`));
    assert.match(gates[0]!.route, /redirectScheme/, 'plain http only redirects, so the password travels encrypted');
    assert.equal(r.gated, true);
    const extra = r.credentials.find((x: any) => /^Extra password/.test(x.label));
    assert.equal(extra?.saved, true);
    const extraPw = ok(await o.h('addon.credentials', { serverId: srv, addon: 'uptime-kuma' })).items.find((x: any) => /^Extra password/.test(x.label)).value;
    assert.match(extraPw, /^U7a[0-9a-f]{36}$/);
    assert.ok(!gates[0]!.route.includes(extraPw) && !seen.some((x) => x.command.includes(extraPw)), 'only its hash goes to the server, never on a command line');
    assert.ok(!secretsIn(app).includes(extraPw));
    assert.equal(c.projects[0]!.name, 'Tools');
    assert.deepEqual([r.url, r.healthy, r.via], ['https://uptime.example.com', true, 'coolify']);
    assert.deepEqual(wrote, [{ hostname: 'uptime.example.com', records: [{ type: 'A', name: 'uptime.example.com', content: '203.0.113.9' }] }]);
    assert.deepEqual(r.dns, { written: true, at: 'cloudflare' });
    // its own setup didn't answer here (this stand-in server runs nothing), so the extra password stays and the sites are listed
    assert.equal(r.monitors.sites[0], 'https://shop.example.com', 'the sites Unit7 knows, to watch: its domains, then what the X-ray found');
    assert.ok(!r.monitors.sites.includes('https://uptime.example.com'), 'not itself');
    assert.match(r.monitors.note, /Add each as an HTTP\(s\) monitor in Uptime Kuma\.$/);
    assert.ok(!r.credentials.some((x: any) => /^Admin password/.test(x.label)), 'a login it couldn’t set isn’t kept');
    assert.match(r.firstVisit, /extra password until you’ve set it up/);
    assert.equal(get<{ status: string }>(app.db, `SELECT status FROM domains WHERE hostname = 'uptime.example.com'`)!.status, 'pending', 'Unit7 watches the new name');
    assert.equal(ok(await o.h('addon.install', { serverId: srv, addon: 'uptime-kuma' })).already, true, 'once is enough');
    assert.equal(ok(await o.a('addon.catalog', { serverId: srv })).items.find((x: any) => x.id === 'uptime-kuma').installed.url, 'https://uptime.example.com');

    // “I’ve finished setup”: a person’s, and the route goes
    assert.equal((await o.a('addon.unlock', { serverId: srv, addon: 'uptime-kuma' })).status, 'denied');
    ok(await o.h('addon.unlock', { serverId: srv, addon: 'uptime-kuma' }));
    assert.ok(seen.some((x) => x.command.includes('rm -f') && x.command.includes(gates[0]!.file)), 'its route file is gone');
    assert.equal(ok(await o.a('addon.catalog', { serverId: srv })).items.find((x: any) => x.id === 'uptime-kuma').installed.gated, undefined);
    assert.ok(!ok(await o.h('addon.credentials', { serverId: srv, addon: 'uptime-kuma' })).items.some((x: any) => /^Extra password/.test(x.label)));

    // a name that's taken or bare is refused before anything is made
    const before = calls(c, 'POST', /^\/services$/).length;
    assert.match((await o.h('addon.install', { serverId: srv, addon: 'n8n', domain: 'shop.example.com' }) as any).error.message, /already goes somewhere/);
    assert.match((await o.h('addon.install', { serverId: srv, addon: 'n8n', domain: 'example.com' }) as any).error.message, /Use a subdomain/);
    // a name Unit7 doesn't know that already points somewhere else (public DNS says so) is never taken over unasked
    dnsSays['api.example.com'] = { a: ['198.51.100.7'] };
    dnsSays['www.example.com'] = { cname: ['shop.example.net.'] };
    const live = await o.h('addon.install', { serverId: srv, addon: 'n8n', domain: 'api.example.com' }) as any;
    assert.equal(live.error.code, 'domain_in_use');
    assert.match(live.error.message, /api\.example\.com points at 198\.51\.100\.7 right now, so Unit7 didn’t touch it/);
    assert.match((await o.h('addon.install', { serverId: srv, addon: 'n8n', domain: 'www.example.com' }) as any).error.message, /alias of shop\.example\.net/);
    assert.equal((await o.a('addon.install', { serverId: srv, addon: 'n8n', domain: 'api.example.com', takeover: 'api.example.com' })).status, 'denied', 'only a person moves it');
    assert.equal(calls(c, 'POST', /^\/services$/).length, before);
    assert.equal(wrote.length, 1, 'no record written for them');
    // already pointing at this server is fine; a person typing the name moves one
    dnsSays['ok.example.com'] = { a: ['203.0.113.9'] };
    ok(await o.h('addon.install', { serverId: srv, addon: 'n8n', domain: 'ok.example.com' }));
    assert.equal(wrote.at(-1)!.hostname, 'ok.example.com');

    // taking it off is a person's; the data stays unless they type its name
    assert.equal((await o.a('addon.remove', { serverId: srv, addon: 'uptime-kuma' })).status, 'denied');
    ok(await o.h('addon.remove', { serverId: srv, addon: 'uptime-kuma' }));
    assert.match(calls(c, 'DELETE', /^\/services\//)[0]!.path, /\?delete_volumes=false$/);
    assert.equal(get(app.db, `SELECT 1 FROM domains WHERE hostname = 'uptime.example.com'`), undefined);
  } finally { addonDns.write = real; c.close(); for (const k of Object.keys(dnsSays)) delete dnsSays[k]; }
});

test('Uptime Kuma: Unit7 makes its admin behind the extra password, then the password goes and it watches every site', async () => {
  const { app, c, o, srv } = await coolifyBox(4096);
  const kuma = fakeKuma({});
  const wrote: string[] = [];
  let setupBeforeDns: boolean | undefined;
  const seen = fakeHost(app, { coolifyPort: c.port, answer: (command, stdin) => {
    if (!isKumaTrip(command)) return undefined;
    if (stdin.includes('"setup":true')) setupBeforeDns = wrote.length === 0;
    return runInKuma(kuma.dir, stdin);
  } });
  const real = addonDns.write;
  addonDns.write = async (_ctx, hostname, records) => { wrote.push(hostname); return { written: true, provider: 'cloudflare', zone: 'example.com', records }; };
  try {
    run(app.db, `INSERT INTO domains (id, org_id, hostname, status) VALUES (?, ?, 'shop.example.com', 'active')`, id('dom'), o.orgId);
    const r = ok(await approve(app, o, await o.a('addon.install', { serverId: srv, addon: 'uptime-kuma', domain: 'uptime.example.com' })));
    const svc = c.things.find((x) => x.name === 'uptime-kuma');
    // its first-run setup, from inside its container while the extra password still stood in front, before its DNS
    const k = kuma.state();
    assert.equal(k.users.length, 1);
    assert.equal(k.users[0]!.username, 'admin');
    assert.equal(setupBeforeDns, true);
    const trips = seen.filter((x) => isKumaTrip(x.command));
    assert.equal(trips[0]!.command, `sh -c 'exec docker exec -i "$1" node -' unit7 'uptime-kuma-${svc.uuid}'`);
    const gate = seen.find((x) => x.command.includes('unit7-gate-') && x.stdin.includes('basicAuth'));
    assert.ok(gate && seen.indexOf(gate) < seen.indexOf(trips[0]!), 'the extra password was up first');
    assert.ok(seen.some((x) => x.command.includes('rm -f') && x.command.includes(`unit7-gate-${svc.uuid}.yaml`)), 'then it goes: its own login protects it');
    assert.equal(r.gated, undefined);
    assert.match(r.firstVisit, /Unit7 set its admin login before it went live/);
    assert.deepEqual(r.credentials, [{ label: 'Admin password (user admin)', saved: true }]);
    const pw = ok(await o.h('addon.credentials', { serverId: srv, addon: 'uptime-kuma' })).items[0].value;
    assert.equal(k.users[0]!.password, pw);
    assert.ok(!seen.some((x) => x.command.includes(pw)) && !secretsIn(app).includes(pw), 'the login only ever on stdin');
    // then it watches every site Unit7 knows, tagged, and says so
    assert.equal(r.monitors.synced, true);
    assert.equal(r.monitors.watching, kuma.state().monitors.length);
    assert.ok(r.monitors.watching >= 2);
    assert.equal(r.monitors.note, `Uptime Kuma now watches ${r.monitors.watching} sites (${r.monitors.watching} new).`);
    assert.ok(kuma.state().monitors.every((m: any) => m.tags.some((t: any) => t.name === 'unit7') && m.interval === 60));
    assert.ok(!kuma.state().monitors.some((m: any) => m.url === 'https://uptime.example.com'), 'not itself');
    assert.equal(r.wire, undefined, 'nothing left for the person to add by hand');
  } finally { addonDns.write = real; c.close(); }
});

test('no add-on can be claimed by a stranger: its login is set before it starts, by its own setup right after, or it waits behind an extra password', () => {
  // what a tool's first setup said
  assert.deepEqual(claimResult(`\n@@unit7:secret\n${CLAIM_PW}\n\n@@unit7:reply\nunit7-http=200\n`), { pw: CLAIM_PW });
  assert.deepEqual(claimResult(`\n@@unit7:secret\n${CLAIM_PW}\n\n@@unit7:reply\nunit7-taken\n`), { taken: true }, 'the default login no longer works: someone got there first');
  assert.deepEqual(claimResult(`\n@@unit7:secret\n${CLAIM_PW}\n\n@@unit7:reply\nunit7-users=2\nunit7-http=200\n`), { taken: true }, 'someone else signed up before the admin was made');
  assert.equal(claimResult(`\n@@unit7:secret\n${CLAIM_PW}\n\n@@unit7:reply\nunit7-http=400\n`).why, 'it answered 400');
  assert.equal(claimResult('').pw, undefined);
  // the extra password's route: a plain-http test address gets the password there; nothing else goes in
  const route = gateRoute('svc0001', [{ host: 'status-svc0001.203.0.113.9.sslip.io', https: false }], 'statusnook-svc0001', 8000, '{SHA}qUqP5cyxm6YcTAhz05Hph5gvu9M=');
  assert.match(route, /unit7-gate-svc0001-http:\n\s+rule: "Host\(`status-svc0001\.203\.0\.113\.9\.sslip\.io`\)"\n\s+entryPoints: \[http\]\n\s+priority: 100000\n\s+middlewares: \[unit7-gate-svc0001-auth\]/);
  assert.ok(!/certResolver/.test(route));
  for (const bad of [() => gateRoute('svc0001', [{ host: 'a.example.com`) || Host(`x', https: true }], 'c', 1, '{SHA}qUqP5cyxm6YcTAhz05Hph5gvu9M='), () => gateRoute('svc0001', [{ host: 'a.example.com', https: true }], 'c"; rm', 1, '{SHA}qUqP5cyxm6YcTAhz05Hph5gvu9M='), () => gateRoute('svc0001', [], 'c', 1, 'plain')]) assert.throws(bad);
});

test('the first-setup scripts run in a real shell: the new password only on stdout and stdin, never a command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-claim-'));
  const log = join(dir, 'argv.log'), fed = join(dir, 'stdin.log');
  const fake = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  fake('docker', `if [ "$1" = inspect ]; then echo 172.18.0.9; exit 0; fi
if [ "$1" = exec ]; then shift; [ "$1" = -i ] && shift; shift; exec "$@"; fi`);
  fake('curl', `case "$*" in *-K*) { printf '%s\\n' "--- curl config"; cat; } >> "${fed}"; echo unit7-http=200;; *auth/login*) printf '%s\\n200' '{"token":"tok.abc-123","user":{"id":"41e2b680-648e-4b09-bcd7-3e2b10c06264","username":"admin"}}';; *healthz*) printf 200;; esac`);
  fake('manage.py', `case "$1" in createsuperuser) printf '%s\\n' "--- superuser $* pw=$DJANGO_SUPERUSER_PASSWORD" >> "${fed}";; shell) echo unit7-users=1;; esac`);
  const sh = (cmd: string) => spawnSync('sh', ['-c', cmd], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  const made: string[] = [];
  for (const [kind, c, port] of [['umami', 'umami-svc1', 3000], ['n8n', 'n8n-svc2', 5678], ['glitchtip', 'web-svc3', 8000]] as const) {
    const out = sh(claimScript(kind, c, port, 'sam@example.com'));
    assert.equal(out.status, 0, `${kind}: ${out.stderr}`);
    const got = claimResult(out.stdout);
    assert.match(got.pw ?? '', /^U7a[0-9a-f]{36}$/, kind);
    made.push(got.pw!);
  }
  const argv = readFileSync(log, 'utf8'), stdin = readFileSync(fed, 'utf8');
  for (const pw of made) { assert.ok(!argv.includes(pw), 'never on a command line'); assert.ok(stdin.includes(pw), 'handed over on stdin'); }
  assert.match(stdin, new RegExp(`header = "Authorization: Bearer tok\\.abc-123"\ndata = "\\{\\\\"password\\\\":\\\\"${made[0]}\\\\"\\}"`), 'Umami: the new password set on its seeded admin');
  assert.match(argv, /curl .*\/api\/users\/41e2b680-648e-4b09-bcd7-3e2b10c06264/s);
  assert.match(stdin, /"email\\":\\"sam@example\.com\\"/);
  assert.match(argv, /curl .*\/rest\/owner\/setup/s);
  assert.match(stdin, new RegExp(`--- superuser createsuperuser --noinput --email sam@example\\.com pw=${made[2]}`));
  assert.throws(() => claimScript('n8n', 'n8n; rm -rf /', 5678, 'sam@example.com'));
  assert.throws(() => claimScript('n8n', 'n8n-svc2', 5678, 'sam"@example.com'));
});

test('add-ons: settings before the first start, the tool’s own setup right after, someone first means it’s stopped, Databasus waits, Unleash without demo tokens', async () => {
  const { app, c, o, srv, seen } = await coolifyBox(8192);
  try {
    // Listmonk and CloudBeaver read their admin from settings at their first start: set before it starts, kept for people only
    const lm = ok(await o.h('addon.install', { serverId: srv, addon: 'listmonk' }));
    const svc = c.things.find((x) => x.name === 'listmonk');
    const order = c.seen.map((x) => `${x.method} ${x.path}`);
    assert.ok(order.indexOf(`PATCH /services/${svc.uuid}/envs/bulk`) < order.indexOf(`POST /services/${svc.uuid}/start`));
    assert.equal(svc.envs.find((e: any) => e.key === 'LISTMONK_ADMIN_USER').value, 'admin');
    const pw = svc.envs.find((e: any) => e.key === 'LISTMONK_ADMIN_PASSWORD').value;
    assert.match(pw, /^U7a[0-9a-f]{36}$/);
    assert.deepEqual(lm.credentials, [{ label: 'Admin password (user admin)', saved: true }]);
    assert.ok(!secretsIn(app).includes(pw) && !seen.some((x) => x.command.includes(pw)), 'never on a command line, in a result, audit row or event');
    const ref = app.vault.list(o.orgId, 'credential://addon/').find((e) => e.ref.endsWith('/unit7_admin_password'))!.ref;
    const env = ok(await o.h('project.create', { name: 'Shop', environments: ['development'] })).environments[0].id;
    assert.equal((await o.a('env.set', { environmentId: env, key: 'LM', value: ref })).status, 'denied', 'an admin login is never put into an app by an AI');
    ok(await o.h('addon.install', { serverId: srv, addon: 'cloudbeaver' }));
    const cb = c.things.find((x) => x.name === 'cloudbeaver');
    assert.deepEqual(['CB_SERVER_NAME', 'CB_ADMIN_NAME', 'CLOUDBEAVER_APP_ANONYMOUS_ACCESS_ENABLED'].map((k) => cb.envs.find((e: any) => e.key === k)?.value), ['CloudBeaver', 'cbadmin', 'false']);

    // GlitchTip: sign-ups off before it starts, its superuser made by its own command, inside the server
    ok(await o.h('addon.install', { serverId: srv, addon: 'glitchtip' }));
    const gt = c.things.find((x) => x.name === 'glitchtip');
    assert.equal(gt.envs.find((e: any) => e.key === 'ENABLE_USER_REGISTRATION').value, 'False');
    const made = seen.find((x) => x.command.includes('createsuperuser'))!;
    assert.ok(made.command.includes(`'web-${gt.uuid}'`) && !made.command.includes(CLAIM_PW));

    // n8n: someone reached its first setup first: stopped, never handed over
    claimReply = 'unit7-http=400';
    const lost = await o.h('addon.install', { serverId: srv, addon: 'n8n' }) as any;
    assert.equal(lost.error.code, 'claim_failed');
    const n8n = c.things.find((x) => x.name === 'n8n');
    assert.ok(c.seen.some((x) => x.method === 'POST' && x.path === `/services/${n8n.uuid}/stop`), 'stopped rather than left open');
    assert.equal(n8n.started, false);
    claimReply = 'unit7-taken';
    assert.equal((await o.h('addon.install', { serverId: srv, addon: 'umami' }) as any).error.code, 'claimed_by_someone');
    claimReply = 'unit7-users=1\nunit7-http=200';

    // Databasus: coming soon, nothing made
    const db = await o.h('addon.install', { serverId: srv, addon: 'databasus' }) as any;
    assert.match(db.error.message, /Coming soon/);
    assert.ok(!c.things.some((x) => x.name === 'databasus'));

    // Unleash: its own compose: the user name set, no public demo tokens
    ok(await o.h('addon.install', { serverId: srv, addon: 'unleash' }));
    const ul = calls(c, 'POST', /^\/services$/).find((x) => x.body.name === 'unleash')!.body;
    const compose = Buffer.from(ul.docker_compose_raw, 'base64').toString();
    assert.equal(ul.type, undefined);
    assert.match(compose, /UNLEASH_DEFAULT_ADMIN_USERNAME=admin/);
    assert.ok(!/insecure|INIT_.*_API_TOKENS/.test(compose));
  } finally { c.close(); claimReply = 'unit7-users=1\nunit7-http=200'; }
});

test('keys: what the tool generated goes to the vault, wiring uses references, only a person sees the value', async () => {
  const { app, c, o, srv } = await coolifyBox(4096);
  try {
    const r = ok(await o.h('addon.install', { serverId: srv, addon: 'meilisearch' }));
    assert.match(r.url, /^http:\/\/meilisearch-svc\d+\.203\.0\.113\.9\.sslip\.io$/, 'its free test address');
    assert.deepEqual(r.credentials, [{ label: 'Master key', saved: true }]);
    const ref = r.wire.env.find((e: any) => e.key === 'MEILISEARCH_API_KEY').value;
    assert.match(ref, /^credential:\/\/addon\/srv-[\w-]+-meilisearch\/service_password_meilisearch$/);
    assert.equal(r.wire.env.find((e: any) => e.key === 'MEILISEARCH_HOST').value, r.url);
    assert.equal(app.vault.resolve(o.orgId, ref), MASTER);
    assert.ok(!JSON.stringify(r).includes(MASTER) && !secretsIn(app).includes(MASTER), 'the value is in no result, audit row or event');
    assert.equal((await o.a('addon.credentials', { serverId: srv, addon: 'meilisearch' })).status, 'denied', 'an AI never sees it');
    const shown = ok(await o.h('addon.credentials', { serverId: srv, addon: 'meilisearch' }));
    assert.deepEqual(shown.items, [{ label: 'Master key', value: MASTER }]);
    assert.ok(!secretsIn(app).includes(MASTER), 'not even after it was shown');
    // off again: its keys leave the vault (restorable)
    ok(await o.h('addon.remove', { serverId: srv, addon: 'meilisearch' }));
    assert.equal(app.vault.has(o.orgId, ref), false);
  } finally { c.close(); }
});

test('without Coolify: Unit7 deploys the one-container tools itself, and says which need Coolify', async () => {
  const app = testApp(), o = await testOrg(app);
  run(app.db, `UPDATE orgs SET offsite = 'off' WHERE id = ?`, o.orgId);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'plain', '203.0.113.7', 'root', 'credential://ssh/plain/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ publicIp: '203.0.113.7', mem_available: 2048 * 1024 * 1024 }));
  fakeHost(app);
  const cat = ok(await o.a('addon.catalog', { serverId: srv }));
  const by = Object.fromEntries(cat.items.map((x: any) => [x.id, x]));
  assert.deepEqual([by.umami.how, by.unleash.how, by.listmonk.how], ['unit7', 'unit7', 'needs_coolify']);
  assert.match((await o.h('addon.install', { serverId: srv, addon: 'listmonk' }) as any).error.message, /through Coolify/);
  const r = ok(await o.h('addon.install', { serverId: srv, addon: 'umami' }));
  assert.equal(r.via, 'unit7');
  assert.equal(r.healthy, true);
  assert.match(r.url, /^https:\/\/umami-[\w-]+\.203-0-113-7\.sslip\.io$/);
  assert.ok(r.credentials.some((x: any) => x.label === 'Admin password (admin)' && x.saved), 'its seeded admin / umami changed right after it went live');
  const tools = get<{ id: string }>(app.db, `SELECT id FROM projects WHERE slug = 'tools'`)!.id;
  const svcs = all<{ name: string; kind: string; id: string }>(app.db, 'SELECT id, name, kind FROM services WHERE project_id = ? ORDER BY name', tools);
  assert.deepEqual(svcs.map((s) => [s.name, s.kind]), [['umami', 'app'], ['umami-db', 'postgres']]);
  const v = await vars(o, svcs[0]!.id);
  assert.match(v.DATABASE_URL.value, /^credential:\/\/postgres\//);
  assert.match(v.APP_SECRET.value, /^credential:\/\/addon\//, 'its secret made into the vault, set as a reference');
  assert.equal(v.DATABASE_TYPE.value, 'postgres');
  ok(await o.h('addon.remove', { serverId: srv, addon: 'umami' }));
  assert.equal(all(app.db, 'SELECT 1 FROM services WHERE project_id = ?', tools).length, 0);
});

// a whole install from the ask box: one action, so one step and one card
test('from the chat: an install is one step with its result', async () => {
  const { app, c, o, srv, seen } = await coolifyBox(4096);
  try {
    const r = await execute(app, o.orgId, o.human, 'addon.install', { serverId: srv, addon: 'umami' });
    assert.equal(r.status, 'ok');
    const out = (r as any).output;
    assert.match(out.wire.snippet, /^<script defer src="http:\/\/umami-svc\d+\.203\.0\.113\.9\.sslip\.io\/script\.js" data-website-id="your-website-id"><\/script>$/);
    assert.match(out.firstVisit, /Unit7 set its admin login before it went live/);
    // Umami's seeded admin / umami is changed from inside the server before it's handed over, the new one made there
    const claim = seen.find((x) => x.command.includes('/api/auth/login'))!;
    const svc = c.things.find((x) => x.name === 'umami');
    assert.ok(claim.command.includes(`'umami-${svc.uuid}'`) && claim.command.includes(`'3000'`));
    assert.ok(svc.started, 'it was started first');
    assert.ok(!claim.command.includes(CLAIM_PW), 'the new password never on a command line');
    assert.deepEqual(out.credentials, [{ label: 'Admin password (admin)', saved: true }]);
    assert.equal(ok(await o.h('addon.credentials', { serverId: srv, addon: 'umami' })).items[0].value, CLAIM_PW);
    assert.ok(!secretsIn(app).includes(CLAIM_PW));
    assert.equal(all(app.db, `SELECT 1 FROM audit WHERE tool = 'addon.install'`).length, 1, 'one audit row for the whole install');
  } finally { c.close(); }
});

// in the ask box: one card for the whole copy; Full autopilot on a test environment just makes it and reports
test('autonomy: one plan card in the ask box; at Full autopilot the copy is made without one', async () => {
  const t = await shop();
  const { bindRun, answerAsk } = await import('../src/agent/asks.ts');
  const conversationId = id('cnv');
  run(t.app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conversationId, t.o.orgId, t.o.userId, 'copy');
  const msgs = new Map<string, any>();
  const ac = new AbortController();
  const unbind = bindRun(conversationId, { orgId: t.o.orgId, userId: t.o.userId, emit: (m) => { msgs.set(m.id, m); run(t.app.db, `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content`, m.id, conversationId, m.role, JSON.stringify(m.content), m.created_at ?? new Date().toISOString()); }, signal: ac.signal });
  try {
    const running = execute(t.app, t.o.orgId, t.o.agent, 'staging.create', { projectId: t.projectId }, { conversationId });
    let card: any;
    for (let i = 0; i < 400 && !card; i++) { card = [...msgs.values()].find((m) => m.role === 'ask' && m.content.state === 'waiting'); if (!card) await new Promise((r) => setTimeout(r, 10)); }
    assert.equal(card.content.spec.confirmLabel, 'Make the copy');
    assert.equal(all(t.app.db, `SELECT 1 FROM environments WHERE kind = 'staging'`).length, 0, 'nothing before the person says yes');
    answerAsk(t.app, { org: { id: t.o.orgId }, user: { id: t.o.userId } } as any, card.id, { ok: false });
    assert.equal(ok(await running).declined, true);
    run(t.app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', t.o.orgId);
    const r = ok(await execute(t.app, t.o.orgId, t.o.agent, 'staging.create', { projectId: t.projectId }, { conversationId }));
    assert.equal([...msgs.values()].filter((m) => m.role === 'ask').length, 1, 'no second card at Full autopilot');
    // each step is its own action in the thread, with the gate's own answer: an environment an AI makes starts at
    // "Ask first", so putting code in it waits for a person (the copy carries on when they approve and ask again)
    const steps = [...msgs.values()].filter((m) => m.role === 'tool');
    assert.deepEqual(steps.map((m) => [m.content.tool, m.content.status]), [['environment.create', 'ok'], ['service.create', 'approval_required']]);
    assert.equal(r.created, false);
    assert.equal(r.failed.step, 'Add web to Staging');
    assert.ok(r.failed.approvalId);
  } finally { unbind(); }
});
