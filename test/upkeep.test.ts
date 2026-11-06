// Upkeep Unit7 does itself with its root access: secret files hidden on every site (Caddy and Coolify's Traefik),
// log upkeep without a Docker restart, swap when memory stays tight, time sync, a certificate renewed on request, the
// cause attached when a server stops answering, and findings that point at the tools that fix them. Every server
// here is a stand-in (ssh exec replaced): the tests read the exact commands, run each twice, and take each back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { script } from '../src/connectors/shell.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { getTool } from '../src/tools/runtime.ts';
import type { App } from '../src/app.ts';
import { renderSite, renderTraefik, guardCaddyFile, guardTraefikFile, SECRET_PATHS } from '../src/deploy/caddy.ts';
import { SWAP, SWAP_PROBE, TIDY, TIME_SYNC, RENEW, renewing, swapSize } from '../src/tools/upkeep.ts';
import { serverFindings, clockOffset, type Finding } from '../src/tools/security.ts';
import { findingsFor } from '../src/discovery/findings.ts';
import { buildInventory } from '../src/discovery/xray.ts';
import { Warden } from '../src/sentinel/warden.ts';
import { COMPOSE_HOST, COOLIFY_HOST } from './xray-fixtures.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';
const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
function fakeServer(app: App, reply: (command: string, o: ExecOptions) => ReturnType<typeof done> | undefined = () => undefined) {
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, o = {}) => { seen.push(command); return reply(command, o) ?? done(); };
  return seen;
}
async function setup(facts: object = {}) {
  const app = testApp();
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify(facts));
  return { app, o, srv, facts: () => json<Record<string, unknown>>(get<{ facts: string }>(app.db, 'SELECT facts FROM servers WHERE id = ?', srv)!.facts, {}) };
}
const events = (app: App, type: string) => all<{ message: string; data: string }>(app.db, 'SELECT message, data FROM events WHERE type = ?', type);
// every tool fix names a real tool with input it accepts
function real(f?: Finding['fix']) {
  assert.ok(f && 'tool' in f, 'a tool fix');
  const t = getTool(f.tool);
  assert.ok(t, `${f.tool} exists`);
  assert.ok(t!.input.safeParse(f.input).success, `${f.tool} accepts ${JSON.stringify(f.input)}`);
  return f;
}

// --- item 9: secret files never served ---------------------------------------------------------------------
test('every Caddy site answers 404 for .env, .git and keys; an older site file gets the rule in place, once', () => {
  const site = renderSite({ hostname: 'app.example.com', upstream: 'unit7-app-1', port: 3000, tls: 'auto' });
  assert.match(site, /\n\t@unit7_secrets path \/\.env\* \/\.git \/\.git\/\* \/\.svn\/\* \/\.hg\/\* \/\.DS_Store \/\.aws \/\.aws\/\* \/\.ssh \/\.ssh\/\* \/\*\.pem \/\*\.key\n\trespond @unit7_secrets 404\n/);
  assert.ok(site.indexOf('respond @unit7_secrets') < site.indexOf('reverse_proxy'), 'answered before the app sees it');
  const old = site.replace(/\t@unit7_secrets[^\n]*\n\trespond @unit7_secrets 404\n/, '');
  assert.equal(guardCaddyFile(old), site, 'the same rule a new site gets, and nothing else changes');
  assert.equal(guardCaddyFile(site), site, 'idempotent');
});

test('on Coolify’s Traefik only Unit7’s own routers leave the secret paths out, so Traefik answers 404; Traefik 2 gets what it understands', () => {
  const y = renderTraefik({ hostname: 'app.example.com', upstream: 'shop-web-3', port: 3000, tls: 'auto' });
  const rules = y.split('\n').filter((l) => l.includes('rule:'));
  assert.equal(rules.length, 2, 'the http and the https router');
  for (const r of rules) {
    assert.ok(r.startsWith('      rule: "Host(`app.example.com`) && !(PathPrefix(`/.env`) || Path(`/.git`) || PathPrefix(`/.git/`)'));
    assert.match(r, /PathRegexp\(`\^\/\[\^\/\]\+\[\.\]\(pem\|key\)\$`\)\)"$/);
  }
  assert.doesNotMatch(renderTraefik({ hostname: 'app.example.com', upstream: 'a', port: 80, tls: 'auto' }, true), /PathRegexp/, 'Traefik 2 has no PathRegexp');
  assert.ok(SECRET_PATHS.every((p) => p.startsWith('/')));
  const old = y.replace(/ && !\([^\n]*\)"/g, '"');
  assert.match(old, /rule: "Host\(`app\.example\.com`\)"\n/);
  assert.equal(guardTraefikFile(old), y);
  assert.equal(guardTraefikFile(y), y, 'idempotent');
});

test('server.protect_sites adds the rule to older Caddy sites, validated before it goes live; a second run changes nothing', async () => {
  const { app, o, srv, facts } = await setup({ web: 'unit7-caddy|caddy:2.11' });
  const fresh = renderSite({ hostname: 'a.example.com', upstream: 'one', port: 3000, tls: 'auto' });
  const files: Record<string, string> = { '/etc/unit7/caddy/sites/a.example.com.caddy': fresh.replace(/\t@unit7_secrets[^\n]*\n\trespond @unit7_secrets 404\n/, ''), '/etc/unit7/caddy/sites/b.example.com.caddy': fresh.replace(/a\.example/g, 'b.example') };
  const seen = fakeServer(app, (c) => {
    if (c.includes('for f in')) return done(Object.keys(files).join('\n'));
    for (const [f, t] of Object.entries(files)) if (c.includes(`cat "$1"' unit7 '${f}'`)) return done(t);
    return undefined;
  });
  const r = ok(await o.h('server.protect_sites', { serverId: srv }));
  assert.deepEqual(r, { sites: 2, updated: 1 });
  const write = seen.find((c) => c.includes('tee "$1"'))!;
  assert.ok(write.includes('cp -p "$1" "$1.prev"') && write.includes("'/etc/unit7/caddy/sites/a.example.com.caddy'") && write.includes('respond @unit7_secrets 404'), 'only the older file is written, with a copy kept aside');
  assert.ok(seen.findIndex((c) => c.includes('caddy validate')) > seen.indexOf(write) && seen.some((c) => c.includes('caddy reload')));
  assert.equal(facts().sitesGuard, 1);
  // once validation fails, the working file comes back
  const bad = fakeServer(app, (c) => c.includes('for f in') ? done(Object.keys(files)[0]) : c.includes('cat "$1"') ? done(files['/etc/unit7/caddy/sites/a.example.com.caddy']) : c.includes('caddy validate') ? done('bad', 1) : undefined);
  assert.equal((await o.h('server.protect_sites', { serverId: srv })).status, 'error');
  assert.ok(bad.some((c) => c.includes('mv -f "$1.prev" "$1"')), 'put back as it was');
  // already there: nothing written, nothing reloaded
  files['/etc/unit7/caddy/sites/a.example.com.caddy'] = fresh;
  const again = fakeServer(app, (c) => c.includes('for f in') ? done(Object.keys(files).join('\n')) : c.includes('cat "$1"') ? done(fresh) : undefined);
  assert.deepEqual(ok(await o.h('server.protect_sites', { serverId: srv })), { sites: 2, updated: 0 });
  assert.ok(!again.some((c) => /tee|caddy reload/.test(c)));
});

test('on a Coolify server only Unit7’s route files change, and Traefik picks them up by itself (no reload, Coolify’s files untouched)', async () => {
  const { app, o, srv } = await setup({ web: 'coolify-proxy|traefik:v3.6' });
  const y = renderTraefik({ hostname: 'app.example.com', upstream: 'shop-web-3', port: 3000, tls: 'auto' }).replace(/ && !\([^\n]*\)"/g, '"');
  const seen = fakeServer(app, (c) => c.includes('for f in') ? done('/data/coolify/proxy/dynamic/unit7-app.example.com.yaml') : c.includes('cat "$1"') ? done(y) : undefined);
  assert.deepEqual(ok(await o.h('server.protect_sites', { serverId: srv })), { sites: 1, updated: 1 });
  assert.ok(seen[0]!.includes('"$1"/unit7-*.yaml') && seen[0]!.includes("'/data/coolify/proxy/dynamic'"), 'only files named unit7-*');
  assert.ok(seen.some((c) => c.includes('tee "$1"') && c.includes('&& !(PathPrefix(`/.env`)')));
  assert.ok(!seen.some((c) => /caddy|\.prev/.test(c)));
});

test('Warden adds the rule to each server’s older sites once, through the gate', async () => {
  const { app, srv, facts } = await setup({ web: 'unit7-caddy|caddy:2.11' });
  const seen = fakeServer(app);
  const w = new Warden(app);
  await w.checkNow(srv);
  assert.equal(facts().sitesGuard, 1);
  assert.ok(get(app.db, `SELECT 1 FROM audit WHERE tool = 'server.protect_sites' AND actor_name = 'Warden' AND result = 'success'`));
  const n = seen.filter((c) => c.includes('for f in')).length;
  await w.checkNow(srv);
  assert.equal(seen.filter((c) => c.includes('for f in')).length, n, 'not again');
});

// --- item 4: log upkeep ---------------------------------------------------------------------------------------
test('server.tidy_logs caps the journal and empties the package cache, never restarting Docker; runs again safely; undo removes the cap', async () => {
  const { app, o, srv } = await setup();
  let capped = false;
  const seen = fakeServer(app, (c) => c.includes('SystemMaxUse') ? done(c.endsWith("unit7 'undo'") ? 'cap=removed' : `${capped ? 'cap=kept' : 'cap=set'}\napt=clean\nfreed=1500000000`) : undefined);
  const r = ok(await o.h('server.tidy_logs', { serverId: srv }));
  assert.equal(seen.at(-1), script(TIDY, ''));
  assert.match(TIDY, /journalctl --vacuum-size=500M/);
  assert.match(TIDY, /printf '# Unit7: keep the system journal under 500 MB\\n\[Journal\]\\nSystemMaxUse=500M\\n' \| \$SU tee "\$C"/);
  assert.match(TIDY, /apt-get clean/);
  assert.doesNotMatch(TIDY, /docker|daemon\.json/, 'Docker is never touched');
  assert.deepEqual(r, { freed: '1.5 GB', journal: 'capped at 500 MB', packageCache: 'emptied', undo: { tool: 'server.tidy_logs', input: { serverId: srv, undo: true }, label: 'Remove the journal cap' } });
  capped = true;
  assert.equal(ok(await o.h('server.tidy_logs', { serverId: srv })).undo, undefined, 'the cap was already there: nothing to undo this time');
  assert.deepEqual(ok(await o.h('server.tidy_logs', { serverId: srv, undo: true })), { journal: 'no cap any more' });
  assert.equal(seen.at(-1), script(TIDY, 'undo'));
  // old log lines are gone for good, and they're the evidence after a break-in: an AI always asks
  assert.equal((await o.a('server.tidy_logs', { serverId: srv })).status, 'approval_required');
  run(app.db, 'UPDATE orgs SET autonomy = 0 WHERE id = ?', o.orgId);
  assert.equal((await o.a('server.tidy_logs', { serverId: srv, undo: true })).status, 'denied', 'Watch only still means watch only');
});

// --- item 14: swap ---------------------------------------------------------------------------------------------
test('server.swap adds min(2 GB, memory) only with 10 GB free and little swap; idempotent; undo takes it all back', async () => {
  const { app, o, srv, facts } = await setup();
  let probe = 'mem=1073741824\nswap=0\nfree=40000000000';
  const seen = fakeServer(app, (c) => c.includes('/proc/meminfo') ? done(probe) : c.includes('mkswap') ? done(c.includes("'off'") ? 'removed' : 'added') : undefined);
  const r = ok(await o.h('server.swap', { serverId: srv }));
  assert.deepEqual(r, { added: '1 GB', file: '/swapfile-unit7', swappiness: 10, undo: { tool: 'server.swap', input: { serverId: srv, off: true }, label: 'Remove the swap' } });
  assert.deepEqual(seen, [script(SWAP_PROBE), script(SWAP, 'on', 1024)]);
  for (const step of ['fallocate -l "$2M" "$F"', 'mkswap "$F"', 'swapon "$F"', '# unit7-swap: added by Unit7', '/swapfile-unit7 none swap sw 0 0', 'vm.swappiness=10', '# was %s']) assert.ok(SWAP.includes(step), step);
  assert.equal(facts().swap_total, 1073741824);
  assert.deepEqual([swapSize(8 * 1024 ** 3), swapSize(512 * 1024 ** 2)], [2048, 512], 'never more than 2 GB, never more than its memory');
  // Unit7's swap is on already: nothing runs again
  probe = 'mem=1073741824\nswap=1073741824\nfree=40000000000\nours=1';
  assert.equal(ok(await o.h('server.swap', { serverId: srv })).already, true);
  assert.equal(seen.filter((c) => c.includes('mkswap')).length, 1);
  // enough swap, or not enough disk: it says so and changes nothing
  probe = 'mem=4294967296\nswap=2147483648\nfree=40000000000';
  assert.match(JSON.stringify(await o.h('server.swap', { serverId: srv })), /already has 2\.1 GB of swap/);
  probe = 'mem=4294967296\nswap=0\nfree=8000000000';
  assert.match(JSON.stringify(await o.h('server.swap', { serverId: srv })), /only 8\.0 GB of disk free/);
  assert.equal(seen.filter((c) => c.includes('mkswap')).length, 1);
  // undo: swapoff, the file and both fstab lines go, swappiness goes back
  ok(await o.h('server.swap', { serverId: srv, off: true }));
  assert.equal(seen.at(-1), script(SWAP, 'off', 0));
  for (const step of ['swapoff "$F"', 'rm -f "$F"', "sed -i -e '/^# unit7-swap/d' -e '/^\\/swapfile-unit7 /d' /etc/fstab", 'vm.swappiness="${was:-60}"']) assert.ok(SWAP.includes(step), step);
});

const METRICS_OUT = (memPct: number, diskFree: number) => ['cpu  100 0 100 1000 0 0 0 0', 'cpu  110 0 110 1010 0 0 0 0', 'mem_total=2000000000', `mem_available=${2000000000 * (1 - memPct / 100)}`,
  'disk_total=100000000000', `disk_used=${100000000000 - diskFree}`, 'load=0.5'].join('\n');
test('Warden: memory tight three checks in a row and little swap: it adds swap through the gate instead of opening an incident; when it can’t, the incident opens as before', async () => {
  const { app, srv } = await setup({ swap_total: 0 });
  const seen = fakeServer(app, (c) => c.includes('/proc/stat') ? done(METRICS_OUT(96, 60e9)) : c.includes('/proc/meminfo') ? done('mem=2000000000\nswap=0\nfree=60000000000') : c.includes('mkswap') ? done('added') : undefined);
  const w = new Warden(app);
  for (let n = 0; n < 3; n++) await w.checkNow(srv);
  assert.ok(seen.includes(script(SWAP, 'on', 1907)), 'min(2 GB, its memory)');
  assert.ok(get(app.db, `SELECT 1 FROM audit WHERE tool = 'server.swap' AND actor_name = 'Warden' AND result = 'success'`));
  assert.equal(all(app.db, 'SELECT 1 FROM incidents').length, 0, 'it acted, so no incident');
  // a small disk: no swap, and the incident opens
  const b = await setup({ swap_total: 0 });
  const seen2 = fakeServer(b.app, (c) => c.includes('/proc/stat') ? done(METRICS_OUT(96, 5e9)) : undefined);
  const w2 = new Warden(b.app);
  for (let n = 0; n < 3; n++) await w2.checkNow(b.srv);
  assert.ok(!seen2.some((c) => c.includes('mkswap')));
  assert.equal(get<{ title: string }>(b.app.db, 'SELECT title FROM incidents')?.title, 'High memory');
});

// --- item 15: certificates and the clock ------------------------------------------------------------------------
test('the clock: not kept in time is a finding with a fix; the offset is read from systemd or chrony', () => {
  const s = { id: 'srv_test0000000a', name: 'box', port: 22, provider_ref: null };
  const out = (lines: string[]) => `@@unit7 sshd\npasswordauthentication no\n@@unit7 ufw\nStatus: active\n@@unit7 clock\n${lines.join('\n')}\n@@unit7 end\n`;
  const f = serverFindings(s, {}, out(['NTPSynchronized=no', 'NTP=no', '       Offset: -7.2s'])).findings.find((x) => x.id === 'server:clock:srv_test0000000a')!;
  assert.deepEqual([f.severity, f.title, f.evidence], ['high', 'box’s clock isn’t kept in time', 'Time sync off; 7.2 seconds behind']);
  assert.deepEqual(real(f.fix).input, { serverId: 'srv_test0000000a' });
  assert.equal((f.fix as { tool: string }).tool, 'server.time_sync');
  assert.equal(serverFindings(s, {}, out(['NTPSynchronized=no', 'NTP=yes'])).findings.find((x) => x.id.startsWith('server:clock'))!.severity, 'medium');
  assert.ok(!serverFindings(s, {}, out(['NTPSynchronized=yes', 'NTP=yes'])).findings.some((x) => x.id.startsWith('server:clock')));
  assert.ok(!serverFindings(s, {}, out([])).findings.some((x) => x.id.startsWith('server:clock')), 'no timedatectl: nothing said');
  assert.deepEqual([clockOffset(['Offset: +1.234ms']), clockOffset(['System time     : 0.500000 seconds slow of NTP time']), clockOffset(['nothing'])], [0.001234, -0.5, undefined]);
});

test('server.time_sync turns time sync on (installing a time service only when needed), runs again safely, and can be turned off again', async () => {
  const { app, o, srv } = await setup();
  let state = 'was=no\nsynced=1';
  const seen = fakeServer(app, (c) => c.includes('timedatectl') ? done(state) : undefined);
  assert.deepEqual(ok(await o.h('server.time_sync', { serverId: srv })), { timeSync: 'on', synced: true, undo: { tool: 'server.time_sync', input: { serverId: srv, on: false }, label: 'Turn it off again' } });
  assert.equal(seen.at(-1), script(TIME_SYNC, 'on'));
  assert.match(TIME_SYNC, /\$SU timedatectl set-ntp true/);
  assert.match(TIME_SYNC, /apt-get install -y -qq systemd-timesyncd .* \|\| .*apt-get install -y -qq chrony/);
  state = 'was=yes\nalready=1';
  assert.equal(ok(await o.h('server.time_sync', { serverId: srv })).already, true);
  ok(await o.h('server.time_sync', { serverId: srv, on: false }));
  assert.equal(seen.at(-1), script(TIME_SYNC, 'off'));
  assert.match(TIME_SYNC, /if \[ "\$1" = off \]; then \$SU timedatectl set-ntp false/);
  // a change with an undo: an AI asks a person first in production
  assert.equal((await o.a('server.time_sync', { serverId: srv })).status, 'approval_required');
});

async function routedDomain(facts: object) {
  const t = await setup(facts);
  const { environments } = ok(await t.o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'production').id;
  const svc = id('svc'), dom = id('dom');
  run(t.app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, ?, 'web', 'web', 'app', '{}' FROM environments WHERE id = ?`, svc, t.srv, env);
  run(t.app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls_mode) VALUES (?, ?, 'shop.example.com', ?, 'active', 'auto')`, dom, t.o.orgId, svc);
  return { ...t, dom };
}
test('a certificate running out on a site Unit7 routes through Caddy: “Renew now” reloads the proxy and checks again from outside', async () => {
  const { app, o, dom } = await routedDomain({ web: 'unit7-caddy|caddy:2.11' });
  const real_ = renewing.certificate;
  renewing.waitMs = 1; renewing.tries = 2;
  let good = true;
  renewing.certificate = async () => ({ validTo: new Date(Date.now() + (good ? 89.5 : 5) * 86400_000).toISOString() });
  try {
    const seen = fakeServer(app, (c) => c.includes('docker logs') ? done('{"level":"error","logger":"tls.obtain","msg":"could not get certificate","error":"Timeout during connect (likely firewall problem)"}') : undefined);
    const r = ok(await o.h('domain.renew_https', { domainId: dom }));
    assert.deepEqual([r.renewed, r.daysLeft], [true, 89]);
    assert.equal(seen[0], script(RENEW));
    assert.match(RENEW, /caddy validate .*\n.*caddy reload --config \/etc\/caddy\/Caddyfile --force/);
    assert.equal(get<{ status: string }>(app.db, `SELECT status FROM watch WHERE host = 'shop.example.com' AND kind = 'tls'`)!.status, 'ok', 'the check from outside is kept');
    good = false;
    const e = await o.h('domain.renew_https', { domainId: dom });
    assert.equal(e.status, 'error');
    assert.match((e as { error: { message: string } }).error.message, /didn’t renew: Timeout during connect \(likely firewall problem\)\. Usually/);
    // the finding's fix is this tool for a Caddy-routed name
    run(app.db, `UPDATE watch SET status = 'expiring', detail = '5 days left', checked_at = ? WHERE host = 'shop.example.com'`, new Date().toISOString());
    fakeServer(app, () => done('@@unit7 sshd\npasswordauthentication no\n@@unit7 end'));
    const rep = ok(await o.h('security.check', {}));
    const f = rep.findings.find((x: Finding) => x.id === 'domain:tls:shop.example.com');
    assert.deepEqual({ ...real(f.fix), change: undefined }, { tool: 'domain.renew_https', input: { domainId: dom }, label: 'Renew now', safe: true, change: undefined });
  } finally { renewing.certificate = real_; renewing.waitMs = 5000; renewing.tries = 8; }
  // on a Coolify server Traefik renews its own: Unit7 says why it didn't, from Traefik's log (test/gap-domains.test.ts has the rest)
  const c = await routedDomain({ web: 'coolify-proxy|traefik:v3.6' });
  renewing.certificate = async () => ({ why: 'unable to verify the first certificate' });
  try {
    const log = 'time=x level=error msg="Unable to obtain ACME certificate for domains" error="acme: error: 400 :: urn:ietf:params:acme:error:connection :: Timeout during connect (likely firewall problem)" domains=["shop.example.com"]';
    fakeServer(c.app, (x) => x.includes('docker logs') ? done(log) : undefined);
    const r = ok(await c.o.h('domain.renew_https', { domainId: c.dom }));
    assert.equal(r.renewed, false);
    assert.match(r.why, /port 80/);
  } finally { renewing.certificate = real_; }
});

// --- item 6a: a server that stops answering ------------------------------------------------------------------
test('on the third failed check Warden runs the read-only diagnosis itself and the alert carries the cause and the fix', async () => {
  const app = testApp(); const o = await testOrg(app);
  app.services.ssh = { check: async () => { throw new Error('connect ETIMEDOUT'); }, exec: async () => ({ code: 1, stdout: '', stderr: '' }) };
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId);
  const w = new Warden(app);
  for (let n = 0; n < 2; n++) await w.checkNow();
  assert.equal(get(app.db, `SELECT 1 FROM audit WHERE tool = 'server.diagnose'`), undefined, 'not before the third');
  await w.checkNow();
  assert.ok(get(app.db, `SELECT 1 FROM audit WHERE tool = 'server.diagnose' AND actor_name = 'Warden' AND result = 'success'`));
  const [e] = events(app, 'server.unreachable');
  assert.equal(e!.message, 'box stopped responding to Unit7. Unit7 doesn’t have the login key for box. Unit7 can fix it: Add the login key, on the server’s page.');
  const d = JSON.parse(e!.data).diagnosis;
  assert.deepEqual([d.cause, d.fixes[0].id], ['no-key', 'install-key']);
  assert.equal(get<{ status: string }>(app.db, 'SELECT status FROM servers WHERE id = ?', srv)!.status, 'unreachable');
});

// --- item 7: findings point at the tools that exist -------------------------------------------------------------
test('findings call the tools that fix them: Coolify backups, memory caps, Tidy up logs, and a direct AI look', () => {
  const day = (d: number) => ({ at: new Date(Date.now() - (10 - d) * 86400_000).toISOString(), cpu: null, mem: null, net: null, restarts: 0, oom: 0, disk: 180e9 + d * 1e9 });
  // Coolify connected, and relay's database with no backup job: Coolify's own daily schedule
  const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9', coolify: { accountId: 'acc_test0000000a' } } as never);
  const noJobs = { ...inv, parts: inv.parts.filter((p) => p.kind !== 'job') };
  const relay = noJobs.parts.find((p) => p.id === 'coolify:relaydb01')!;
  const f = findingsFor({ serverId: 'srv_test0000000a', serverName: 'box', inv: noJobs, sizes: { logs: { 'shopapp01-1': 2.3e9 }, layers: {}, volumes: {}, reclaimable: 0 } as never,
    diskTotal: 200e9, history: { memMax: {}, restarts: {}, oom: {}, daily: Array.from({ length: 10 }, (_, d) => day(d)) } });
  // Unit7 backs it up itself (dump, off the server, daily); Coolify's own daily schedule is the second way
  const backup = real(f.find((x) => x.id === 'xray:no-backup:srv_test0000000a:coolify:relaydb01')!.fix) as { tool: string; input: unknown; safe?: boolean; alt?: { tool: string; input: unknown; safe?: boolean }[]; byHand?: string[] };
  assert.deepEqual([backup.tool, backup.input, backup.safe], ['part.backup_schedule', { serverId: 'srv_test0000000a', part: 'coolify:relaydb01', frequency: 'daily', keep: 7 }, true]);
  assert.deepEqual(backup.alt?.map((a) => [a.tool, a.input, a.safe]), [['coolify.backup', { serverId: 'srv_test0000000a', uuid: relay.coolify!.uuid, op: 'schedule', frequency: 'daily' }, true]]);
  // a Supabase stack isn't a Coolify database (no Coolify schedule for it): Unit7's own backup, Coolify's steps by hand
  const supa = real(f.find((x) => x.id === 'xray:no-backup:srv_test0000000a:coolify:crmsupa01')!.fix) as typeof backup;
  assert.deepEqual([supa.tool, supa.input, supa.alt], ['part.backup_schedule', { serverId: 'srv_test0000000a', part: 'coolify:crmsupa01', frequency: 'daily', keep: 7 }, undefined]);
  assert.deepEqual(supa.byHand, ['In Coolify, open crm-supabase → Backups.', 'Add a daily schedule and, if you can, an S3 bucket so copies live off the server.']);
  const logs = real(f.find((x) => x.id === 'xray:logs:srv_test0000000a')!.fix) as { tool: string; safe?: boolean; byHand?: string[] };
  assert.deepEqual([logs.tool, logs.safe], ['server.tidy_logs', true]);
  assert.match(logs.byHand![0]!, /^Optional, for apps Unit7 didn’t start: set log rotation in \/etc\/docker\/daemon\.json/, 'the daemon.json note stays, only as an optional step');
  const fc = real(f.find((x) => x.id === 'xray:disk-forecast:srv_test0000000a')!.fix) as { tool: string };
  assert.equal(fc.tool, 'server.tidy_logs', 'nothing to prune: tidy up logs');
  // a compose app alone in its project that ran out of memory: a cap from its own history
  const c = buildInventory(COMPOSE_HOST);
  const solo = { ...c, parts: c.parts.filter((p) => p.id !== 'c:shop-db-1' && p.id !== 'c:shop-redis-1').map((p) => (p.id === 'c:shop-web-1' ? { ...p, health: { status: 'bad' as const, reason: 'it ran out of memory' } } : p)) };
  const g = findingsFor({ serverId: 'srv_c0000000000a', serverName: 'c', inv: solo, history: { memMax: { 'compose:shop': 700e6 }, restarts: {}, oom: {}, daily: [] } });
  const cap = real(g.find((x) => x.id === 'xray:oom:srv_c0000000000a:c:shop-web-1')!.fix) as { tool: string; input: unknown; label: string };
  assert.deepEqual([cap.tool, cap.input, cap.label], ['part.limits', { serverId: 'srv_c0000000000a', part: 'c:shop-web-1', memoryMb: 1280 }, 'Cap it at 1.3 GB']);
  const tip = real(g.find((x) => x.id === 'xray:no-cap:srv_c0000000000a:c:shop-web-1')!.fix) as { tool: string };
  assert.equal(tip.tool, 'part.limits');
  assert.ok(!g.some((x) => x.id === 'xray:no-caps:srv_c0000000000a'), 'the app with its own button isn’t listed again');
  // a restart loop: a read-only look by the AI, straight from the button
  const loop = { ...c, parts: c.parts.map((p) => (p.id === 'c:shop-web-1' ? { ...p, state: 'restarting' } : p)) };
  const ask = findingsFor({ serverId: 'srv_c0000000000a', serverName: 'c', inv: loop }).find((x) => x.id.startsWith('xray:restart-loop:'))!.fix as { ask?: string; label?: string };
  assert.equal(ask.label, 'Ask Unit7 to look');
  assert.match(ask.ask!, /^On my server c: why does web keep restarting\? Look first, read-only: .*Don’t change anything yet/);
});

test('in the security check: database passwords get a one-click schedule (still a person’s choice), and the clock joins the server’s findings', async () => {
  const { app, o, srv } = await setup();
  fakeServer(app, () => done('@@unit7 sshd\npasswordauthentication no\n@@unit7 ufw\nStatus: active\n@@unit7 clock\nNTPSynchronized=no\nNTP=no\n@@unit7 end'));
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'production').id;
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, ?, 'shop-db', 'shop-db', 'postgres', '{}' FROM environments WHERE id = ?`, id('svc'), srv, env);
  const r = ok(await o.h('security.check', {}));
  const pw = real(r.findings.find((x: Finding) => x.id === 'unit7:db-passwords').fix);
  assert.deepEqual([pw.tool, pw.input], ['secrets.rotation', { databases: 90 }]);
  assert.equal((await o.a('secrets.rotation', { databases: 90 })).status, 'denied', 'an AI still can’t set it');
  ok(await o.h('secrets.rotation', { databases: 90 }));
  assert.ok(r.findings.some((x: Finding) => x.id === `server:clock:${srv}`));
});
