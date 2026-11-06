// Closing a port, checked for real: the X-ray reads Unit7's own firewall rules, each closed port is tested from outside
// (a TCP connection from this computer), a finding clears only when the rule is there and nothing answers, and
// Coolify's dashboard port closes only after Coolify answers at its own HTTPS address (or a person insists).
// Fakes only: the server is a stand-in (ssh exec replaced) and the outside checks are swapped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { Redactor } from '../src/redact.ts';
import { buildInventory, parseBlocks } from '../src/discovery/xray.ts';
import { findingsFor, gather } from '../src/discovery/findings.ts';
import { checkOutside, outside, tcpReach, type Tcp } from '../src/discovery/outside.ts';
import { saveXray } from '../src/tools/xray.ts';
import { dashboardFlow, flowTiming } from '../src/tools/coolify-dashboard.ts';
import type { Ctx, ToolResult } from '../src/tools/runtime.ts';
import { COOLIFY_HOST, probe } from './xray-fixtures.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';
const IP = '203.0.113.9';
const RULE = (chain: string, port: number) => chain === 'INPUT'
  ? `-A INPUT -i eth0 -p tcp -m tcp --dport ${port} -m comment --comment unit7-close-${port} -j DROP`
  : `-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport ${port} --ctdir ORIGINAL -m comment --comment unit7-close-${port} -j DROP`;
// the Coolify fixture without its HTTPS address (the dashboard only at http://IP:8000), plus the firewall section
const NO_DOMAIN = COOLIFY_HOST.replace(/\n@@unit7:traefik\n[\s\S]*?(?=\n@@unit7:cron\n)/, '\n@@unit7:traefik\n');
const withRules = (out: string, rules: string[]) => out + probe({ fw: rules.join('\n') });

// swap the outside checks for the length of a test
function swapOutside(o: { tcp?: (host: string, port: number) => Tcp | undefined; https?: (host: string) => { ok: boolean; code?: number; why?: string } | undefined }) {
  const was = { tcp: outside.tcp, https: outside.https };
  if (o.tcp) outside.tcp = async (h, p) => o.tcp!(h, p);
  if (o.https) outside.https = async (h) => o.https!(h);
  return () => { outside.tcp = was.tcp; outside.https = was.https; };
}
const answers = (open: number[]) => (_h: string, p: number): Tcp => (p === 22 || open.includes(p) ? { open: true, ms: 12 } : { open: false, ms: 2500, why: 'no answer' });

// a stand-in Coolify server: Coolify's own PHP (its address), the firewall script, the undo copies
async function setup(o: { xray?: string; fqdn?: string | null } = {}) {
  const app = testApp();
  const org = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', ?, 'root', 'credential://ssh/box/private-key', 'ready', '{}')`, srv, org.orgId, IP);
  saveXray(app.db, org.orgId, srv, 'fast', buildInventory(o.xray ?? NO_DOMAIN, { serverHost: IP }));
  app.services.recheck = 'off';
  const st = { fqdn: o.fqdn ?? null as string | null, closed: new Set<number>(), php: [] as { op: string; input: any }[], cmds: [] as string[], files: new Map<string, string>() };
  const done = (stdout = '', code = 0, stderr = '') => ({ code, stdout, stderr, truncated: false });
  ssh(app).exec = async (_s, command: string, x: ExecOptions = {}) => {
    const stdin = String(x.stdin ?? '');
    st.cmds.push(command);
    if (command.includes('cat > "$1"')) { const path = /'(\/var\/lib\/unit7\/undo\/[^']+)'/.exec(command)![1]!; st.files.set(path, stdin); return done('feedface\n'); }
    if (command.includes('sha256sum')) { // the undo copy, run in Coolify
      const path = /'(\/var\/lib\/unit7\/undo\/[^']+)'/.exec(command)![1]!, php = st.files.get(path)!;
      const input = JSON.parse(Buffer.from(/base64_decode\('([A-Za-z0-9+/=]*)'\)/.exec(php)![1]!, 'base64').toString());
      st.php.push({ op: 'undo', input });
      if (String(input.expect ?? '') !== String(st.fqdn ?? '')) return done('', 4, 'changed since');
      st.fqdn = input.fqdn; return done();
    }
    if (command.includes('docker exec -i coolify php')) {
      const op = /\/\/ unit7:(\w+)/.exec(stdin)![1]!, input = JSON.parse(Buffer.from(/base64_decode\('([A-Za-z0-9+/=]*)'\)/.exec(stdin)![1]!, 'base64').toString());
      st.php.push({ op, input });
      if (op === 'instance') return done(`\n@@unit7:json ${JSON.stringify({ fqdn: st.fqdn, version: '4.4.2' })}\n`);
      if (op === 'instance_fqdn') {
        if ('expect' in input && String(input.expect ?? '') !== String(st.fqdn ?? '')) return done(`\n@@unit7:error ${JSON.stringify('changed since')}\n`, 1);
        const before = st.fqdn; st.fqdn = input.fqdn; return done(`\n@@unit7:json ${JSON.stringify({ before, fqdn: st.fqdn })}\n`);
      }
    }
    if (command.includes('unit7-close-$1( |$)')) { const port = Number(/ '(\d+)'$/.exec(command)![1]); return st.closed.has(port) ? done('', 5, `Port ${port} is closed to the internet, so taking Coolify’s own address away now would lock you out of its dashboard.`) : done(); }
    if (command.includes('unit7-close-')) { const [, port, act] = / '(\d+)' '(close|open)'$/.exec(command)!; if (act === 'close') st.closed.add(Number(port)); else st.closed.delete(Number(port)); return done('done'); }
    return done();
  };
  const ctx = (actor = org.human): Ctx => ({ app, db: app.db, orgId: org.orgId, actor, env: undefined, projectId: undefined, signal: new AbortController().signal, redactor: new Redactor(), resources: [],
    secret: () => { throw new Error('no secrets here'); }, credentialFor: () => { throw new Error('no credentials here'); }, progress: () => {}, emit: (t, m, e) => app.events.emit(org.orgId, t, m, e) });
  return { app, o: org, srv, st, ctx };
}

// --- 1. the X-ray reads Unit7's own rules -----------------------------------------------------------------------
test('the X-ray reads the tagged firewall rules: those ports are closed to the internet, by Unit7', () => {
  const blocks = parseBlocks([RULE('DOCKER-USER', 5432), RULE('INPUT', 5432), RULE('INPUT', 3000), '-A DOCKER-USER -j RETURN',
    '-A INPUT -p tcp --dport 9000 -m comment --comment someone-else -j DROP', '-A INPUT -p tcp --dport 7000 -m comment --comment unit7-close-7000 -j ACCEPT'].join('\n'));
  assert.deepEqual([...blocks].map(([p, c]) => [p, [...c].sort()]), [[5432, ['DOCKER-USER', 'INPUT']], [3000, ['INPUT']]], 'only Unit7’s DROP rules count');

  const open = buildInventory(COOLIFY_HOST, { serverHost: IP });
  assert.equal(open.blocked, undefined, 'an X-ray without the firewall section says nothing about rules');
  assert.ok(open.parts.find((p) => p.id === 'coolify:relaydb01')!.exposed);

  const inv = buildInventory(withRules(COOLIFY_HOST, [RULE('DOCKER-USER', 5432), RULE('INPUT', 5432), RULE('INPUT', 8000)]), { serverHost: IP });
  assert.deepEqual(inv.blocked, [{ port: 5432, chains: ['DOCKER-USER', 'INPUT'] }, { port: 8000, chains: ['INPUT'] }]);
  const db = inv.parts.find((p) => p.id === 'coolify:relaydb01')!;
  assert.deepEqual(db.ports!.find((x) => x.port === 5432), { port: 5432, proto: 'tcp', ip: '0.0.0.0', public: false, blockedBy: 'unit7' });
  assert.equal(db.exposed, false, 'its only published port is blocked: not on the internet any more');
  assert.equal(inv.ports.find((l) => l.port === 5432)!.public, false);
  // a Docker-published port with only an INPUT rule: Docker skips INPUT, so it still faces the internet
  assert.equal(inv.parts.find((p) => p.containers?.includes('coolify'))!.ports!.find((x) => x.port === 8000)!.public, true);
  const none = buildInventory(withRules(COOLIFY_HOST, []), { serverHost: IP });
  assert.deepEqual(none.blocked, [], 'the rules were read, and there are none');
});

// --- 2. the outside check ---------------------------------------------------------------------------------------------
test('the outside check: a real listener answers, a closed port doesn’t; unreachable servers and private addresses say “not tested”', async () => {
  const listener = createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  const port = (listener.address() as { port: number }).port;
  const yes = await tcpReach('127.0.0.1', port, 1000);
  assert.equal(yes.open, true);
  listener.close();
  await new Promise((r) => listener.once('close', r));
  const no = await tcpReach('127.0.0.1', port, 1000);
  assert.deepEqual([no.open, no.why], [false, 'refused']);

  const { app, srv } = await setup();
  const row = () => get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', srv);
  const back = swapOutside({ tcp: answers([5432]) });
  try {
    const r = await checkOutside(app.db, row(), [5432, 8000]);
    assert.deepEqual([r['5432']!.state, r['8000']!.state], ['open', 'closed']);
    assert.equal(json<any>(row().facts, {}).outside['8000'].state, 'closed', 'kept on the server row');
    // nothing answers, not even SSH: this computer can't reach it, so nothing is claimed about the port
    outside.tcp = async () => ({ open: false, ms: 2500, why: 'no answer' });
    assert.equal((await checkOutside(app.db, row(), [8000]))['8000']!.state, 'unknown');
    run(app.db, `UPDATE servers SET host = '10.0.0.5' WHERE id = ?`, srv);
    assert.match((await checkOutside(app.db, row(), [8000]))['8000']!.why!, /private network/);
  } finally { back(); }
  // offline (tests, demo copies): nothing is tried, what was kept stays
  run(app.db, `UPDATE servers SET host = ? WHERE id = ?`, IP, srv);
  const kept = await checkOutside(app.db, row(), [6001]);
  assert.equal(kept['6001'], undefined);
});

// --- 3. when a port finding clears ---------------------------------------------------------------------------------
test('a port finding clears only with the rule there and no answer from outside; a rule with an answer is said plainly', () => {
  const at = new Date().toISOString();
  const base = { serverId: 'srv_test0000000a', serverName: 'box' };
  const ids = (f: ReturnType<typeof findingsFor>) => f.map((x) => x.id);
  // no rule: as before, the database and Coolify's port answer the internet
  const noRule = findingsFor({ ...base, inv: buildInventory(withRules(NO_DOMAIN, []), { serverHost: IP }) });
  assert.ok(ids(noRule).includes('server:port:srv_test0000000a:5432'));
  const tip = noRule.find((x) => x.id === 'xray:coolify-port:srv_test0000000a')!;
  assert.equal(tip.title, 'Coolify answers the internet on port 8000');
  assert.deepEqual((tip.fix as any).flow, { kind: 'coolify-domain', serverId: 'srv_test0000000a' }, 'no HTTPS address yet: the safe order, never a bare close');
  assert.equal((tip.fix as any).label, 'Give Coolify a domain, then close 8000');

  const blocked = buildInventory(withRules(NO_DOMAIN, [RULE('DOCKER-USER', 5432), RULE('INPUT', 5432), RULE('DOCKER-USER', 8000), RULE('INPUT', 8000)]), { serverHost: IP });
  // rule + no answer: both gone
  const shut = findingsFor({ ...base, inv: blocked, outside: { 5432: { state: 'closed', at }, 8000: { state: 'closed', at } } });
  assert.ok(!ids(shut).includes('server:port:srv_test0000000a:5432'));
  assert.ok(!ids(shut).some((x) => x.startsWith('xray:coolify-port:') || x === 'server:port:srv_test0000000a:8000'));
  // rule, not tested yet: the rule is trusted
  assert.ok(!ids(findingsFor({ ...base, inv: blocked })).includes('server:port:srv_test0000000a:5432'));
  // rule + an answer from outside: still reachable, with the likely reason and the next fix
  const leak = findingsFor({ ...base, inv: blocked, outside: { 5432: { state: 'open', at, ms: 30 }, 8000: { state: 'closed', at } } });
  const f = leak.find((x) => x.id === 'server:port:srv_test0000000a:5432')!;
  assert.deepEqual([f.bucket, f.severity, f.title], ['risk', 'high', 'Port 5432 (relay-db (PostgreSQL)) is still reachable from outside']);
  assert.match(f.detail, /^Still reachable from outside: the traffic comes in another way/);
  assert.match((f.fix as any).manual[0], /provider’s firewall/);
  assert.ok((f.fix as any).ask, 'and Unit7 can look');
  // Coolify's port the same way
  const coolLeak = findingsFor({ ...base, inv: blocked, outside: { 8000: { state: 'open', at } } }).find((x) => x.id === 'server:port:srv_test0000000a:8000')!;
  assert.match(coolLeak.title, /Port 8000 \(Coolify’s dashboard\) is still reachable from outside/);
  // the same rules for the security check's own port reading
  const sec = findingsFor({ ...base, inv: blocked, outside: { 5432: { state: 'open', at } } });
  assert.equal(sec.filter((x) => x.id === 'server:port:srv_test0000000a:5432').length, 1, 'said once');
});

test('with Coolify on its HTTPS address, its live-update ports get their own tip, closed through the same safe flow', () => {
  const inv = buildInventory(withRules(COOLIFY_HOST, [RULE('DOCKER-USER', 8000)]), { serverHost: IP });
  const f = findingsFor({ serverId: 'srv_test0000000a', serverName: 'box', inv });
  assert.ok(!f.some((x) => x.id.startsWith('xray:coolify-port:')), '8000 is closed');
  const rt = f.find((x) => x.id === 'xray:coolify-realtime:srv_test0000000a')!;
  assert.equal(rt.title, 'Coolify’s live-update ports 6001 and 6002 answer the internet');
  assert.match(rt.detail, /80 and 443/);
  assert.deepEqual((rt.fix as any).input, { serverId: 'srv_test0000000a', ports: [6001, 6002] });
  assert.equal((rt.fix as any).tool, 'coolify.dashboard_domain');
});

// --- 4. the safe order ---------------------------------------------------------------------------------------------
function fakeCalls(answer: Partial<Record<string, (input: any) => ToolResult>> = {}) {
  const calls: { tool: string; input: any }[] = [];
  const okr = (output: unknown): ToolResult => ({ status: 'ok', output, auditId: 'aud_x', durationMs: 1 });
  const base: Record<string, (input: any) => ToolResult> = {
    'domain.point': (i) => okr({ hostname: i.hostname, dns: `cloudflare: A ${i.hostname} → ${IP}` }),
    'coolify.instance_domain': (i) => okr({ changed: true, url: i.url, changeId: 'chg_x' }),
    'server.close_port': (i) => okr({ closed: i.port }),
  };
  return { calls, tools: () => calls.map((c) => c.tool), call: async (tool: string, input: Record<string, unknown>) => { calls.push({ tool, input }); return (answer[tool] ?? base[tool]!)(input); } };
}

test('no domain yet: the name, its DNS, Coolify’s address and HTTPS come first, and 8000 closes only once HTTPS answers', async () => {
  const t = await setup();
  flowTiming.pollMs = 5; flowTiming.httpsMaxMs = 60;
  let https = false;
  const queue: boolean[] = []; // answers to give first, in order
  const back = swapOutside({ https: () => ((queue.length ? queue.shift() : https) ? { ok: true, code: 302 } : { ok: false, why: 'its HTTPS certificate is broken' }), tcp: answers([]) });
  try {
    // without a name it asks for one, with names to pick
    await assert.rejects(dashboardFlow(t.ctx(), { serverId: t.srv }, fakeCalls().call), /Pick a name for Coolify’s dashboard first/);
    // HTTPS never comes: it waits, and 8000 is never closed
    const slow = fakeCalls();
    const seen: string[][] = [];
    const off = t.app.events.on((e) => { if (e.type === 'coolify.dashboard') seen.push((e.data.steps as { key: string; state: string }[]).map((s) => `${s.key}:${s.state}`)); });
    const r1 = await dashboardFlow(t.ctx(), { serverId: t.srv, domain: 'coolify.example.com' }, slow.call);
    assert.deepEqual(slow.tools(), ['domain.point', 'coolify.instance_domain'], 'never server.close_port');
    assert.equal(r1.done, false);
    assert.equal(r1.steps.find((s) => s.key === 'https')!.state, 'waiting');
    assert.match(r1.next!, /Port 8000 stays open until it works/);
    assert.ok(seen.some((s) => s.includes('name:running')), 'live, step by step');
    // HTTPS answers: then, and only then, the ports close, and they're tested from outside
    https = true;
    const f = fakeCalls();
    const r2 = await dashboardFlow(t.ctx(), { serverId: t.srv, domain: 'coolify.example.com' }, f.call);
    off();
    assert.deepEqual(f.tools(), ['domain.point', 'coolify.instance_domain', 'server.close_port', 'server.close_port', 'server.close_port']);
    assert.deepEqual(f.calls[0]!.input, { hostname: 'coolify.example.com', server: { serverId: t.srv } });
    assert.deepEqual(f.calls[1]!.input, { serverId: t.srv, url: 'https://coolify.example.com' });
    assert.deepEqual(f.calls.slice(2).map((c) => c.input.port), [8000, 6001, 6002], '6001 and 6002 too: through the domain they go over 80 and 443');
    assert.equal(r2.done, true);
    assert.equal(r2.said, 'Closed to the internet. Coolify still runs inside the server, which is fine.');
    assert.equal(r2.steps.find((s) => s.key === 'check')!.state, 'ok');
    // a step that fails stops it, with a plain next step, and 8000 stays open
    const bad = fakeCalls({ 'coolify.instance_domain': () => ({ status: 'error', error: { code: 'no_docker', message: 'Unit7 couldn’t run Docker on box.' } }) });
    const r3 = await dashboardFlow(t.ctx(), { serverId: t.srv, domain: 'coolify.example.com' }, bad.call);
    assert.ok(!bad.tools().includes('server.close_port'));
    assert.match(r3.next!, /Settings → General → Instance’s domain: https:\/\/coolify\.example\.com/);
    assert.match(r3.next!, /Port 8000 stays open/);
    // a name an app already uses is refused before anything changes
    const used = fakeCalls();
    const r4 = await dashboardFlow(t.ctx(), { serverId: t.srv, domain: 'relay.example.com' }, used.call);
    assert.deepEqual([used.tools(), r4.steps[0]!.state], [[], 'failed']);
    // run again after a person approved steps by hand: what's done isn't asked for again (no approval loop)
    run(t.app.db, `INSERT INTO domains (id, org_id, hostname, status, tls, target) VALUES (?, ?, 'coolify.example.com', 'pending', 'issuing', ?)`, id('dom'), t.o.orgId, JSON.stringify({ kind: 'server', serverId: t.srv }));
    t.st.fqdn = 'https://coolify.example.com';
    run(t.app.db, `UPDATE servers SET facts = json_set(facts, '$.closedPorts', json('[8000]')) WHERE id = ?`, t.srv);
    queue.push(false); // Coolify's address set, but not answering yet when the flow starts
    const again = fakeCalls();
    const r5 = await dashboardFlow(t.ctx(), { serverId: t.srv, domain: 'coolify.example.com' }, again.call);
    assert.deepEqual(again.calls.map((c) => `${c.tool}${c.input.port ? `:${c.input.port}` : ''}`), ['server.close_port:6001', 'server.close_port:6002']);
    assert.deepEqual(r5.steps.slice(1, 3).map((x) => x.note), ['It already points at this server.', 'It already was.']);
    assert.equal(r5.done, true);
  } finally { back(); }
});

test('Coolify already answers at its HTTPS address: straight to closing, the name steps skipped', async () => {
  const t = await setup({ xray: COOLIFY_HOST, fqdn: 'https://coolify.example.com' });
  const back = swapOutside({ https: (h) => (h === 'coolify.example.com' ? { ok: true, code: 200 } : undefined), tcp: answers([]) });
  try {
    const f = fakeCalls();
    const r = await dashboardFlow(t.ctx(), { serverId: t.srv, ports: [8000] }, f.call);
    assert.deepEqual(f.tools(), ['server.close_port']);
    assert.deepEqual(r.steps.slice(0, 4).map((s) => s.state), ['skipped', 'skipped', 'skipped', 'skipped']);
    assert.equal(r.url, 'https://coolify.example.com');
    assert.equal(r.done, true);
  } finally { back(); }
});

// --- 5. close anyway: people only ------------------------------------------------------------------------------
test('server.close_port refuses Coolify’s port without a working HTTPS address; only a person can close it anyway', async () => {
  const t = await setup();
  const back = swapOutside({ https: () => ({ ok: false, why: 'no answer' }), tcp: answers([]) });
  try {
    const refused = await t.o.h('server.close_port', { serverId: t.srv, port: 8000 });
    assert.equal(refused.status, 'error');
    assert.equal((refused as any).error.code, 'coolify_lockout');
    assert.match((refused as any).error.message, /would lock you out: Coolify’s dashboard opens only at http:\/\/203\.0\.113\.9:8000/);
    assert.ok(!t.st.closed.has(8000));
    const ai = await t.o.a('server.close_port', { serverId: t.srv, port: 8000, anyway: true });
    assert.equal(ai.status, 'denied', 'an AI can’t, even with approval');
    assert.ok(!t.st.closed.has(8000));
    const plan = await t.o.h('server.close_port', { serverId: t.srv, port: 8000, anyway: true }, { dryRun: true });
    assert.equal(plan.status, 'dry_run');
    assert.equal((plan as any).plan.tunnel, `ssh -N -L 8000:localhost:8000 root@${IP}`);
    const done = ok(await t.o.h('server.close_port', { serverId: t.srv, port: 8000, anyway: true }));
    assert.equal(done.closed, 8000);
    assert.match(done.warning, /You won’t be able to open Coolify at http:\/\/203\.0\.113\.9:8000; you’d need an SSH tunnel/);
    assert.equal(done.outside, 'closed');
    assert.equal(done.said, 'Closed to the internet. Coolify still runs inside the server, which is fine.');
    // other ports close as before; the database's words say it still runs inside
    const pg = ok(await t.o.h('server.close_port', { serverId: t.srv, port: 5432 }));
    assert.match(pg.said, /^Closed to the internet\. relay-db \(PostgreSQL\) still runs inside the server/);
  } finally { back(); }
  // with HTTPS working, no "anyway" is needed
  const t2 = await setup({ xray: COOLIFY_HOST, fqdn: 'https://coolify.example.com' });
  const back2 = swapOutside({ https: () => ({ ok: true, code: 302 }), tcp: answers([]) });
  try { assert.equal(ok(await t2.o.h('server.close_port', { serverId: t2.srv, port: 8000 })).closed, 8000); } finally { back2(); }
});

// --- 6. the undo of Coolify's address -----------------------------------------------------------------------------
test('Coolify’s own address: set with Coolify’s save, undone from Activity, and the undo refuses while 8000 is closed', async () => {
  const t = await setup({ fqdn: null });
  const r = ok(await t.o.h('coolify.instance_domain', { serverId: t.srv, url: 'https://coolify.example.com' }));
  assert.equal(t.st.fqdn, 'https://coolify.example.com');
  assert.deepEqual(t.st.php.find((p) => p.op === 'instance_fqdn')!.input, { fqdn: 'https://coolify.example.com', expect: null });
  const ch = get<{ verb: string; summary: string; undo: string }>(t.app.db, 'SELECT verb, summary, undo FROM changes WHERE id = ?', r.changeId)!;
  assert.equal(ch.summary, 'Set https://coolify.example.com as the address of Coolify’s dashboard');
  assert.equal(json<{ steps: string[] }>(ch.undo, { steps: [] }).steps.length, 2, 'the lock-out guard, then Coolify’s own save of the old address');
  // the same again changes nothing
  assert.equal(ok(await t.o.h('coolify.instance_domain', { serverId: t.srv, url: 'https://coolify.example.com' })).already, true);
  // 8000 closed: taking the address away would lock the person out, so the undo refuses
  t.st.closed.add(8000);
  const no = await t.o.h('change.undo', { changeId: r.changeId });
  assert.equal(no.status, 'error');
  assert.match((no as any).error.message, /lock you out/);
  assert.equal(t.st.fqdn, 'https://coolify.example.com');
  // 8000 open again: the undo puts the old address back (none)
  t.st.closed.delete(8000);
  ok(await t.o.h('change.undo', { changeId: r.changeId }));
  assert.equal(t.st.fqdn, null);
  assert.equal(get<{ status: string }>(t.app.db, 'SELECT status FROM changes WHERE id = ?', r.changeId)!.status, 'undone');
  // an AI asks a person first (it changes Coolify's own settings)
  assert.equal((await t.o.a('coolify.instance_domain', { serverId: t.srv, url: 'https://coolify.example.com' })).status, 'approval_required');
});

test('the server page’s reads: where Coolify opens, the names to give it, and every closed port checked from outside', async () => {
  const t = await setup();
  run(t.app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, 'cloudflare', 'domain', 'example.com', 'example.com', '{"zone":"example.com"}', '2026-10-08T00:00:00Z')`, id('ast'), t.o.orgId);
  const back = swapOutside({ tcp: answers([]) });
  try {
    const d = ok(await t.o.h('coolify.dashboard', { serverId: t.srv }));
    assert.deepEqual([d.url, d.ipOnly, d.portOpen, d.suggestions], [`http://${IP}:8000`, true, true, ['coolify.example.com']]);
    assert.deepEqual(d.realtimeOpen, [6001, 6002]);
    assert.equal(d.tunnel, `ssh -N -L 8000:localhost:8000 root@${IP}`);
    ok(await t.o.h('server.close_port', { serverId: t.srv, port: 5432 }));
    saveXray(t.app.db, t.o.orgId, t.srv, 'fast', buildInventory(withRules(NO_DOMAIN, [RULE('DOCKER-USER', 5432)]), { serverHost: IP }));
    const c = ok(await t.o.h('server.closed_ports', { serverId: t.srv }));
    assert.equal(c.ports.length, 1);
    assert.deepEqual([c.ports[0].port, c.ports[0].rule, c.ports[0].outside.state], [5432, true, 'closed']);
    assert.match(c.ports[0].said, /^Closed to the internet/);
    // the findings read the outside check from the server row
    assert.equal(gather(t.app.db, t.o.orgId, { id: t.srv, name: 'box' }).outside!['5432']!.state, 'closed');
    // the rule gone (a restart): said, with the way to close it again
    saveXray(t.app.db, t.o.orgId, t.srv, 'fast', buildInventory(withRules(NO_DOMAIN, []), { serverHost: IP }));
    const gone = ok(await t.o.h('server.closed_ports', { serverId: t.srv }));
    assert.match(gone.ports[0].said, /rule for it is gone/);
    assert.equal(gone.ports[0].again.tool, 'server.close_port');
  } finally { back(); }
  assert.equal(all(t.app.db, `SELECT 1 FROM audit WHERE tool IN ('coolify.dashboard', 'server.closed_ports') AND result = 'error'`).length, 0);
});
