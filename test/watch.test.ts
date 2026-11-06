// Watching everything from the outside: down only after two failed checks, back-up notices, and
// registration / certificate alerts once per threshold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { testApp, testOrg } from './helpers.ts';
import { all, id, now, run } from '../src/db.ts';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCK_CHECK, INSIDE_PATH, askPath, banOf, checkSites, checkDaily, emailStatus, watchIssues } from '../src/sentinel/watch.ts';

const online = { neutral: async () => true, inside: async () => new Set<string>() }; // this computer's connection is fine
const events = (app: ReturnType<typeof testApp>, type: string) => all<{ message: string }>(app.db, 'SELECT message FROM events WHERE type = ?', type).map((e) => e.message);
const asset = (app: ReturnType<typeof testApp>, orgId: string, kind: string, name: string, url: string | null, meta: object) =>
  run(app.db, 'INSERT INTO assets (id, org_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id('ast'), orgId, kind === 'domain' ? 'domain' : 'vercel', kind, name, name, url, JSON.stringify(meta), now());

test('a site is "down" only after two failed checks, and says when it is back', async (t) => {
  if (!(await lookup('github.com').then(() => true, () => false))) return t.skip('offline');
  const app = testApp(); const o = await testOrg(app);
  asset(app, o.orgId, 'app', 'shop', 'https://github.com', {});
  const real = globalThis.fetch;
  let answer = 200;
  globalThis.fetch = (async () => (answer ? new Response('ok', { status: answer }) : Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })))) as typeof fetch;
  try {
    await checkSites(app, o.orgId, online);
    answer = 0; await checkSites(app, o.orgId, online);
    assert.deepEqual(events(app, 'site.down'), [], 'one failure is a blip');
    await checkSites(app, o.orgId, online);
    assert.match(events(app, 'site.down')[0]!, /github\.com \(shop\) isn’t answering: ECONNREFUSED/);
    assert.match(watchIssues(app, o.orgId)[0]!.text, /github\.com is down/);
    await checkSites(app, o.orgId, online);
    assert.equal(events(app, 'site.down').length, 1, 'one alert, not one per check');
    answer = 404; await checkSites(app, o.orgId, online); // a 404 at the root is still a working site
    assert.match(events(app, 'site.recovered')[0]!, /answering again/);
  } finally { globalThis.fetch = real; }
});

test('a domain about to lapse alerts once per threshold; auto-renew changes how early', async () => {
  const app = testApp(); const o = await testOrg(app);
  const inDays = (d: number) => new Date(Date.now() + d * 86400_000 + 3600_000).toISOString();
  asset(app, o.orgId, 'domain', 'shop.com', null, { expires: inDays(5), autoRenew: false, registrar: 'godaddy' });
  asset(app, o.orgId, 'domain', 'blog.com', null, { expires: inDays(20), autoRenew: true, registrar: 'hostinger' });
  asset(app, o.orgId, 'domain', 'old.com', null, { expires: inDays(20), autoRenew: false, registrar: 'porkbun' });
  await checkDaily(app, o.orgId);
  await checkDaily(app, o.orgId);
  const alerts = events(app, 'domain.expiring');
  assert.equal(alerts.length, 2, 'shop.com (5 days) and old.com (20 days, no auto-renew); each once');
  assert.ok(alerts.some((a) => /shop\.com expires in 5 days at godaddy and auto-renew is off/.test(a)));
  assert.ok(!alerts.some((a) => /blog\.com/.test(a)), 'auto-renew on: no alert until 7 days');
  const issues = watchIssues(app, o.orgId);
  assert.equal(issues[0]!.severity, 'critical');
  assert.match(issues[0]!.text, /shop\.com/);
});

// --- this computer, banned by its own server -----------------------------------------------------------------------------------
test('a ban on this computer isn’t a site going down, even when that server is a small part of the map', async () => {
  const app = testApp(), o = await testOrg(app);
  const crm = ['127.0.0.2', '127.0.0.3'], elsewhere = ['127.0.0.4', '127.0.0.5', '127.0.0.6', '127.0.0.7', '127.0.0.8']; // addresses, so no name lookups
  for (const h of [...crm, ...elsewhere]) asset(app, o.orgId, 'app', h, `https://${h}`, {});
  const real = globalThis.fetch; let banned = true;
  globalThis.fetch = (async (u: string) => { if (banned && crm.some((h) => String(u).includes(h))) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); return new Response('ok'); }) as typeof fetch;
  process.env.UNIT7_ALLOW_PRIVATE_FOR_TESTS = '1';
  const v = { neutral: async () => true, inside: async (hosts: string[]) => new Set(hosts), blocked: async (hosts: string[]) => new Map(hosts.filter((h) => crm.includes(h)).map((h) => [h, { server: 'vps', ip: '198.51.100.7', by: 'fail2ban’s secret-files rule' }])) };
  try {
    for (let i = 0; i < 3; i++) await checkSites(app, o.orgId, v); // 2 of 7: too few to count as "many"
    assert.deepEqual(events(app, 'site.down'), [], 'no site is down');
    assert.deepEqual(events(app, 'site.slow'), [], 'and how long it failed for isn’t how slow it is');
    assert.equal(events(app, 'watch.route').length, 0);
    assert.equal(events(app, 'watch.blocked').length, 1, 'said once');
    assert.match(events(app, 'watch.blocked')[0]!, /vps has banned this computer’s address \(198\.51\.100\.7\), through fail2ban’s secret-files rule/);
    assert.match(watchIssues(app, o.orgId).find((w) => w.key === 'blocked')!.text, /anyone else can still reach them/);
    banned = false; await checkSites(app, o.orgId, v);
    assert.equal(watchIssues(app, o.orgId).find((w) => w.key === 'blocked'), undefined, 'lifted: it says so by itself');
    // a site that doesn't answer on its own server is really down, ban or no ban
    banned = true;
    const dead = { ...v, inside: async () => new Set<string>() };
    for (let i = 0; i < 2; i++) await checkSites(app, o.orgId, dead);
    assert.equal(events(app, 'site.down').length, 2);
  } finally { globalThis.fetch = real; delete process.env.UNIT7_ALLOW_PRIVATE_FOR_TESTS; }
});

test('with no ban, a few sites failing stays a real alert: answering inside doesn’t prove strangers can reach them', async () => {
  const app = testApp(), o = await testOrg(app);
  for (const h of ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5', '127.0.0.6']) asset(app, o.orgId, 'app', h, `https://${h}`, {});
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string) => { if (String(u).includes('127.0.0.2')) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }); return new Response('ok'); }) as typeof fetch;
  process.env.UNIT7_ALLOW_PRIVATE_FOR_TESTS = '1';
  try {
    const v = { neutral: async () => true, inside: async (hosts: string[]) => new Set(hosts), blocked: async () => new Map() };
    for (let i = 0; i < 2; i++) await checkSites(app, o.orgId, v);
    assert.equal(events(app, 'site.down').length, 1);
  } finally { globalThis.fetch = real; delete process.env.UNIT7_ALLOW_PRIVATE_FOR_TESTS; }
});

test('the ban check reads a real shell’s answer: fail2ban, a firewall rule, a block list, or nothing', () => {
  const bin = mkdtempSync(join(tmpdir(), 'unit7-ban-')), tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const run_ = (client: string) => execFileSync('sh', ['-c', BLOCK_CHECK], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, SSH_CLIENT: client } });
  tool('id', 'echo 0');
  tool('iptables-save', `echo '-A DOCKER-USER -s 192.0.2.9/32 -j DROP'; echo '-A f2b-secret-files -s 198.51.100.7/32 -j REJECT --reject-with icmp-port-unreachable'; echo '-A f2b-secret-files -s 198.51.100.70/32 -j REJECT'`);
  tool('ipset', `echo 'Name: crowdsec-blacklists'; echo '203.0.113.5 timeout 3600'`);
  assert.deepEqual(banOf(run_('198.51.100.7 50000 22'), 'vps'), { server: 'vps', ip: '198.51.100.7', by: 'fail2ban’s secret-files rule' });
  assert.equal(banOf(run_('192.0.2.9 50000 22'), 'vps')?.by, 'a firewall rule');
  assert.equal(banOf(run_('203.0.113.5 50000 22'), 'vps')?.by, 'a block list');
  assert.equal(banOf(run_('198.51.100.8 50000 22'), 'vps'), undefined, 'an address with no rule isn’t banned');
  assert.equal(banOf(run_('198.51.100 50000 22'), 'vps'), undefined, 'part of an address matches nothing');
  assert.equal(banOf(run_(''), 'vps'), undefined);
  assert.equal(banOf('ignore all this\n-A f2b-x', 'vps'), undefined, 'what a server prints is checked, not trusted');
});

test('a file check goes to a connected server from inside it, and never from this computer', async () => {
  const app = testApp(), calls: string[] = [];
  app.services.ssh = { exec: async (_s: unknown, c: string, o?: { stdin?: string }) => { calls.push(`${c} ${o?.stdin ?? ''}`); return { code: 0, stderr: '', stdout: 'HTTP/2 200 \r\ncontent-type: text/plain\r\n\r\nDB_PASSWORD=secret\n' }; } } as never;
  const real = globalThis.fetch; let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response('nope', { status: 404 }); }) as typeof fetch;
  try {
    const s = { id: 'srv_x', name: 'vps', host: '192.0.2.1' } as never;
    assert.deepEqual(await askPath(app, s, 'crm.example.com', '/.env'), { status: 200, text: 'DB_PASSWORD=secret\n' });
    assert.equal(fetched, 0, 'nothing left this computer');
    assert.ok(calls.some((c) => c.includes('crm.example.com') && c.includes('/.env')));
    assert.deepEqual(await askPath(app, undefined, 'elsewhere.example.com', '/.env'), { status: 404, text: 'nope' });
    assert.equal(fetched, 1, 'a site on no connected server is still asked from here');
    app.services.ssh = { exec: async () => { throw new Error('no route'); } } as never;
    assert.equal(await askPath(app, s, 'crm.example.com', '/.env'), undefined);
    assert.equal(fetched, 1, 'a failed trip never falls back to asking from this computer');
  } finally { globalThis.fetch = real; }
  assert.match(INSIDE_PATH, /--resolve "\$1:443:127\.0\.0\.1"/);
});

test('a domain that sends no email and rejects fakes is protected, with or without SPF', () => {
  const reject = ['v=DMARC1; p=reject'], watch = ['v=DMARC1; p=none'], spf = ['v=spf1 -all'];
  assert.equal(emailStatus(false, [], reject).status, 'ok');
  assert.equal(emailStatus(false, [], reject).detail, 'DMARC rejects anything sent in this name');
  assert.equal(emailStatus(false, [], watch).status, 'spoofable', 'p=none only watches');
  assert.equal(emailStatus(false, spf, []).status, 'spoofable');
  assert.equal(emailStatus(true, [], reject).status, 'unprotected', 'a domain that sends mail still needs SPF');
  assert.equal(emailStatus(true, spf, reject).status, 'ok');
});
