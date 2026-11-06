// The security check: findings from a made-up server, each with the right fix; a server shared with Coolify
// never gets a firewall; secrets in logs show only by name; the check changes nothing; reports are kept.
// The server is a stand-in (ssh exec replaced) and nothing reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { getTool } from '../src/tools/runtime.ts';
import type { App } from '../src/app.ts';
import { exposedFiles, weeklyDue, type Finding } from '../src/tools/security.ts';

process.env.UNIT7_SKIP_NET_PROBE = '1';
const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
function fakeServer(app: App, reply: (command: string, o: ExecOptions) => ReturnType<typeof done> | undefined = () => undefined) {
  const seen: string[] = [];
  ssh(app).exec = async (_s, command, o = {}) => { seen.push(command); return reply(command, o) ?? done(); };
  return seen;
}
// what the audit script prints, section by section
const audit = (o: Record<string, string[]>) => `${Object.entries({ sshd: [], listen: [], ufw: [], iptables: [], docker: [], inspect: [], disk: ['41%'], reboot: [], updates: [], auto: [], fails: [], ...o })
  .map(([k, v]) => [`@@unit7 ${k}`, ...v].join('\n')).join('\n')}\n@@unit7 end\n`;

async function setup(facts: object) {
  const app = testApp();
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify(facts));
  return { app, o, srv };
}
const byId = (r: { findings: Finding[] }, prefix: string) => r.findings.find((f) => f.id.startsWith(prefix));
const toolOf = (f?: Finding) => (f?.fix && 'tool' in f.fix ? f.fix : undefined);

// every fix names a real tool with input it accepts (and so does its undo)
function fixesAreReal(findings: Finding[]) {
  for (const f of findings) {
    if (!f.fix || !('tool' in f.fix)) continue;
    for (const a of [f.fix, ...(f.fix.undo ? [f.fix.undo] : []), ...(f.fix.alt ?? [])]) {
      const t = getTool(a.tool);
      assert.ok(t, `${f.id}: ${a.tool} exists`);
      assert.ok(t!.input.safeParse(a.input).success, `${f.id}: ${a.tool} accepts ${JSON.stringify(a.input)}`);
    }
    assert.ok(f.fix.change.length > 10, `${f.id}: says what changes`);
  }
}

test('a made-up server: every problem gets the right fix', async () => {
  const { app, o, srv } = await setup({ web: 'unit7-caddy|caddy:2.11', ufw: 'inactive' });
  fakeServer(app, (c) => c.includes('@@unit7 sshd') ? done(audit({
    sshd: ['passwordauthentication yes', 'permitrootlogin yes', 'maxauthtries 6'],
    listen: ['0.0.0.0:22 users:(("sshd",pid=1,fd=3))', '127.0.0.1:2019 users:(("caddy",pid=2,fd=3))', '0.0.0.0:3000 users:(("node",pid=3,fd=3))', '127.0.0.53%lo:53 users:(("systemd-resolve",pid=4,fd=3))'],
    ufw: ['Status: inactive'],
    docker: ['unit7-caddy|caddy:2.11|0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp', 'shop-db|postgres:17|0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp', 'cache|redis:7|127.0.0.1:6379->6379/tcp'],
    inspect: ['/unit7-caddy|false|unit7-caddy-data;', '/watch|false|/var/run/docker.sock;'],
    disk: ['93%'], reboot: ['yes'], updates: ['4'], fails: ['   250 198.51.100.7', '    60 198.51.100.8'],
  })) : undefined);
  const r = ok(await o.h('security.check', { serverId: srv }));
  const ssh_ = byId(r, 'server:ssh-password');
  assert.equal(ssh_?.severity, 'critical', 'root password guessing is the worst');
  assert.equal(toolOf(ssh_)?.tool, 'server.harden');
  const pg = byId(r, `server:port:${srv}:5432`)!;
  assert.equal(pg.severity, 'high');
  assert.deepEqual(toolOf(pg)?.input, { serverId: srv, port: 5432 });
  assert.equal(toolOf(pg)?.safe, true);
  assert.equal(toolOf(byId(r, `server:port:${srv}:3000`))?.tool, 'server.close_port', 'an app answering directly can be closed');
  assert.ok(!byId(r, `server:port:${srv}:6379`), 'a port on 127.0.0.1 is not open to the internet');
  assert.ok(!byId(r, `server:port:${srv}:2019`) && !byId(r, `server:port:${srv}:53`), 'local-only listeners are fine');
  assert.equal(toolOf(byId(r, 'server:firewall'))?.tool, 'server.bootstrap', 'a server of its own gets the firewall turned on');
  assert.equal(toolOf(byId(r, 'server:disk'))?.tool, 'docker.prune');
  assert.equal(toolOf(byId(r, 'server:updates'))?.tool, 'server.harden');
  assert.equal(byId(r, 'server:ssh-guessing')?.severity, 'high');
  // a restart to finish updates: now (with a backup first), or a night window a person sets; the steps stay as the by-hand way
  const reboot = toolOf(byId(r, 'server:reboot'))!;
  assert.deepEqual([reboot.tool, reboot.input], ['server.reboot', { serverId: srv }]);
  assert.deepEqual(reboot.alt?.map((a) => [a.tool, a.input]), [['reboot.window', { serverId: srv, days: [0, 1, 2, 3, 4, 5, 6], start: '04:00', minutes: 60 }]]);
  assert.ok(reboot.byHand?.length, 'the steps stay, by hand');
  assert.equal(byId(r, 'server:container')?.title, 'watch can control all of box');
  assert.ok(r.findings.every((f: Finding) => f.by === 'unit7'));
  fixesAreReal(r.findings);
  // saved
  const row = get<{ score: number; findings: string }>(app.db, 'SELECT score, findings FROM security_reports WHERE id = ?', r.id)!;
  assert.equal(row.score, r.score);
  assert.equal(json<Finding[]>(row.findings, []).length, r.findings.length);
  assert.ok(r.score < 50);
});

test('a server shared with Coolify never gets a firewall; single ports close instead, and Coolify’s own are left alone', async () => {
  const { app, o, srv } = await setup({ web: 'coolify-proxy|traefik:v3.6', ufw: 'inactive' });
  const seen = fakeServer(app, (c) => c.includes('@@unit7 sshd') ? done(audit({
    sshd: ['passwordauthentication no', 'permitrootlogin prohibit-password'],
    ufw: ['Status: inactive'],
    docker: ['coolify-proxy|traefik:v3.6|0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp, 0.0.0.0:8080->8080/tcp', 'coolify|ghcr.io/coollabsio/coolify:4|0.0.0.0:8000->8080/tcp',
      'coolify-realtime|ghcr.io/coollabsio/coolify-realtime:1|0.0.0.0:6001-6002->6001-6002/tcp', 'app-db|postgres:16|0.0.0.0:5432->5432/tcp'],
    inspect: ['/coolify|false|/var/run/docker.sock;/data/coolify;', '/coolify-proxy|false|/var/run/docker.sock;'],
    fails: ['   900 198.51.100.7'],
  })) : undefined);
  const r = ok(await o.h('security.check', { serverId: srv }));
  const tools = r.findings.map((f: Finding) => toolOf(f)?.tool).filter(Boolean);
  assert.ok(!tools.includes('server.bootstrap') && !tools.includes('server.harden'), 'no firewall, and nothing else that turns one on');
  const fw = byId(r, 'server:firewall')!;
  assert.equal(fw.severity, 'info');
  assert.equal(fw.fix, undefined);
  assert.equal(toolOf(byId(r, `server:port:${srv}:8080`))?.tool, 'server.close_port', 'Traefik’s dashboard: close the port');
  assert.match(byId(r, `server:port:${srv}:8080`)!.title, /Coolify’s proxy dashboard/);
  assert.equal(toolOf(byId(r, `server:port:${srv}:5432`))?.tool, 'server.close_port');
  for (const p of [8000, 6001, 6002]) assert.ok(!byId(r, `server:port:${srv}:${p}:`) && !r.findings.some((f: Finding) => f.id === `server:port:${srv}:${p}`), `Coolify needs ${p}`);
  assert.equal(byId(r, 'server:coolify-ports')?.severity, 'info');
  assert.equal(byId(r, 'server:coolify-docker')?.severity, 'info', 'Coolify controlling Docker is expected');
  assert.ok(!byId(r, 'server:container'));
  assert.equal(byId(r, 'server:ssh-guessing')?.severity, 'low', 'keys only: guessing can’t get in');
  assert.equal(toolOf(byId(r, 'server:ssh-guessing'))?.tool, 'shield.block');
  fixesAreReal(r.findings);

  // closing 8080 is one tagged DROP rule for that port (Docker's published ports too), never a firewall switched on
  seen.length = 0;
  const plan = await o.h('server.close_port', { serverId: srv, port: 8080 }, { dryRun: true });
  assert.equal(plan.status, 'dry_run');
  assert.match((plan as any).plan.change, /port 8080/);
  const closed = ok(await o.h('server.close_port', { serverId: srv, port: 8080 }));
  assert.equal(closed.closed, 8080);
  assert.equal(closed.undo.input.open, true);
  const cmd = seen.join('\n');
  assert.match(cmd, /DOCKER-USER/);
  assert.match(cmd, /--ctdir ORIGINAL/);
  assert.match(cmd, /unit7-close-/);
  assert.doesNotMatch(cmd, /ufw (--force )?enable|iptables -F|iptables-restore/);
  assert.deepEqual(json<{ closedPorts: number[] }>(get<{ facts: string }>(app.db, 'SELECT facts FROM servers WHERE id = ?', srv)!.facts, { closedPorts: [] }).closedPorts, [8080]);
  ok(await o.h('server.close_port', { serverId: srv, port: 8080, open: true }));
  assert.deepEqual(json<{ closedPorts: number[] }>(get<{ facts: string }>(app.db, 'SELECT facts FROM servers WHERE id = ?', srv)!.facts, { closedPorts: [1] }).closedPorts, []);
  for (const port of [22, 80, 443]) assert.equal((await o.h('server.close_port', { serverId: srv, port })).status, 'error', `${port} stays open`);

  // once closed (the rule is there), the port is no longer a finding
  fakeServer(app, (c) => c.includes('@@unit7 sshd') ? done(audit({
    sshd: ['passwordauthentication no'], docker: ['coolify-proxy|traefik:v3.6|0.0.0.0:8080->8080/tcp'], iptables: ['-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL -m comment --comment unit7-close-8080 -j DROP'],
  })) : undefined);
  assert.ok(!byId(ok(await o.h('security.check', { serverId: srv })), `server:port:${srv}:8080`));
});

test('secrets printed in logs show up by name only, never by value', async () => {
  const { app, o, srv } = await setup({ web: 'unit7-caddy|caddy:2.11' });
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'production').id;
  const svc = id('svc'), dep = id('dep');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, ?, 'web', 'web', 'app', '{}' FROM environments WHERE id = ?`, svc, srv, env);
  run(app.db, `INSERT INTO deployments (id, org_id, service_id, number, status, container) VALUES (?, ?, ?, 1, 'live', 'web-c')`, dep, o.orgId, svc);
  run(app.db, 'UPDATE services SET current_deployment_id = ? WHERE id = ?', dep, svc);
  const value = 'Zq8xT4mN2pR7vK1wB9cY5hL3';
  ok(await o.h('env.set', { serviceId: svc, key: 'PAYMENT_TOKEN', value }));
  fakeServer(app, (c) => c.includes('@@unit7 sshd') ? done(audit({ sshd: ['passwordauthentication no'], ufw: ['Status: active'] })
    + `@@unit7 log web-c\nstarting with token ${value}\nready\n@@unit7 log other\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU\n`) : undefined);
  const r = await o.h('security.check', { serverId: srv });
  const out = ok(r);
  const leak = byId(out, `app:log-secret:${srv}:${svc}`)!;
  assert.equal(leak.severity, 'high');
  assert.match(leak.evidence!, /PAYMENT_TOKEN/);
  assert.equal(leak.about?.name, 'web');
  assert.equal(byId(out, `app:log-secret:${srv}:other`)?.severity, 'medium', 'a key shape in some other container’s log');
  assert.ok(!JSON.stringify(r).includes(value), 'not in what the tool returns');
  assert.ok(!all<{ findings: string }>(app.db, 'SELECT findings FROM security_reports').some((x) => x.findings.includes(value)), 'not in the saved report');
  assert.ok(!all<{ output: string | null }>(app.db, 'SELECT output FROM audit').some((x) => x.output?.includes(value)), 'not in the audit record');
  fixesAreReal(out.findings);
});

test('the check only reads: its one command changes nothing, and it is a read tool', async () => {
  const { app, o, srv } = await setup({});
  const seen = fakeServer(app, () => done(audit({})));
  ok(await o.h('security.check', { serverId: srv }));
  assert.equal(getTool('security.check')!.risk, 'read');
  assert.equal(seen.length, 1, 'one round trip');
  assert.doesNotMatch(seen[0]!, /iptables -[IADF]|ufw (--force |)(enable|allow|deny|reset)|\btee\b|\brm\b|docker (rm|run|stop|restart|exec|kill)|systemctl (restart|reload|stop|start)|apt-get (install|upgrade)|sed -i|>\s*\/(?!dev\/null)/);
  // an AI on "watch only" can still run it
  run(app.db, 'UPDATE orgs SET autonomy = 0 WHERE id = ?', o.orgId);
  assert.equal((await o.a('security.check', { serverId: srv })).status, 'ok');
});

test('a server that doesn’t answer says so, with the way to find out why', async () => {
  const { app, o, srv } = await setup({});
  ssh(app).exec = async () => { throw new Error('box (203.0.113.9) didn’t answer on port 22. Unit7 tries again in 1 minute.'); };
  const r = ok(await o.h('security.check', { serverId: srv }));
  const f = byId(r, 'server:unreachable')!;
  assert.equal(f.severity, 'low');
  assert.match(f.detail, /didn’t answer/);
  assert.doesNotMatch(f.detail, /tries again/);
  assert.ok(r.notes.some((n: string) => /Couldn’t reach box/.test(n)));
});

test('domains, backups and Unit7’s own settings: findings with their fixes', async () => {
  const { app, o, srv } = await setup({});
  fakeServer(app, () => done(audit({ sshd: ['passwordauthentication no'], ufw: ['Status: active'] })));
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'production').id;
  const pg = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, ?, 'shop-db', 'shop-db', 'postgres', '{}' FROM environments WHERE id = ?`, pg, srv, env);
  const at = new Date().toISOString();
  run(app.db, `INSERT INTO watch (org_id, host, kind, status, detail, checked_at) VALUES (?, 'example.com', 'email', 'unprotected', 'SPF and DMARC missing', ?), (?, 'shop.example.com', 'tls', 'expiring', '5 days left', ?), (?, 'example.org', 'registration', 'expiring', '9 days left', ?)`, o.orgId, at, o.orgId, at, o.orgId, at);
  run(app.db, `INSERT INTO sync_runs (id, org_id, started_at, finished_at, status, summary) VALUES (?, ?, ?, ?, 'done', ?)`, id('syn'), o.orgId, at, at,
    JSON.stringify({ issues: [{ severity: 'critical', key: 'takeover:old.example.com', text: 'old.example.com points at gone.herokuapp.com, which no longer exists.' }] }));
  const r = ok(await o.h('security.check', {}));
  const email = byId(r, 'domain:email:example.com')!;
  assert.deepEqual(toolOf(email) && { tool: toolOf(email)!.tool, input: toolOf(email)!.input, safe: toolOf(email)!.safe }, { tool: 'domain.protect_email', input: { domain: 'example.com' }, safe: true });
  assert.equal(toolOf(byId(r, 'domain:tls:shop.example.com'))?.tool, 'watch.check');
  assert.ok('manual' in byId(r, 'domain:registration:example.org')!.fix!, 'renewing costs money: a person does it');
  const take = byId(r, 'domain:takeover:old.example.com')!;
  assert.equal(take.severity, 'critical');
  assert.ok('manual' in take.fix!);
  assert.deepEqual(toolOf(byId(r, `unit7:no-backup:${pg}`))?.input, { serviceId: pg, frequency: 'daily', keep: 7 });
  assert.ok(byId(r, 'unit7:alerts'), 'no phone alerts set up');
  fixesAreReal(r.findings);
  // .env and .git served on the web: only a real file counts, never a page
  assert.deepEqual(exposedFiles('/.env', 'DATABASE_URL=postgres://u:p@h/db\nSECRET=x\n'), { first: 'DATABASE_URL' });
  assert.equal(exposedFiles('/.env', '<!doctype html><html><body>App</body></html>'), undefined);
  assert.deepEqual(exposedFiles('/.git/config', '[core]\n\trepositoryformatversion = 0\n'), {});
  assert.equal(exposedFiles('/.git/config', 'Not found'), undefined);
});

test('reports are kept; only what’s new is fresh; Warden checks weekly and alerts on new serious problems', async () => {
  const { app, o, srv } = await setup({ web: 'unit7-caddy|caddy:2.11' });
  let passwords = 'no';
  fakeServer(app, () => done(audit({ sshd: [`passwordauthentication ${passwords}`], ufw: ['Status: active'] })));
  assert.deepEqual(weeklyDue(app.db), [o.orgId], 'a server and no report yet: due');
  const first = ok(await o.h('security.check', {}));
  assert.deepEqual(weeklyDue(app.db), [], 'checked this week');
  const second = ok(await o.h('security.check', {}));
  assert.deepEqual(second.fresh, [], 'nothing new');
  passwords = 'yes';
  const third = ok(await o.a('security.check', {}));
  assert.deepEqual(third.fresh, [`server:ssh-password:${srv}`]);
  assert.ok(get(app.db, `SELECT 1 FROM events WHERE org_id = ? AND type = 'security.found'`, o.orgId), 'an AI/Warden run alerts on it');
  const hist = ok(await o.h('security.reports', {}));
  assert.equal(hist.history.length, 3);
  assert.equal(hist.latest.id, third.id);
  assert.equal(hist.weekly, true);
  assert.ok(first.id !== third.id);
  // the server's own view of the full report is just its part
  const mine = ok(await o.h('security.reports', { serverId: srv }));
  assert.ok(mine.latest.findings.every((f: Finding) => f.serverId === srv));
  // the switch: off means Warden doesn't run it; an AI can't turn it off
  assert.equal((await o.a('security.weekly', { on: false })).status, 'denied');
  ok(await o.h('security.weekly', { on: false }));
  run(app.db, `UPDATE security_reports SET created_at = '2020-01-01T00:00:00.000Z'`);
  assert.deepEqual(weeklyDue(app.db), []);
});

test('an AI’s own findings join the report, marked as found by AI, secrets scrubbed', async () => {
  const { app, o, srv } = await setup({});
  fakeServer(app, () => done(audit({ sshd: ['passwordauthentication no'], ufw: ['Status: active'] })));
  ok(await o.h('security.check', {}));
  const r = ok(await o.a('security.note', { title: 'A cron job downloads a script from the internet', severity: 'high', detail: 'It runs whatever that site sends, as root.', evidence: 'curl -H "Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789" | sh', steps: ['Remove the cron line.'], serverId: srv }));
  assert.ok(r.score < 100);
  const last = ok(await o.h('security.reports', {})).latest;
  const f = last.findings.find((x: Finding) => x.by === 'ai');
  assert.equal(f.title, 'A cron job downloads a script from the internet');
  assert.equal(f.about.name, 'box');
  assert.doesNotMatch(f.evidence, /ghp_abcdefghijklmnop/);
  assert.deepEqual(f.fix, { manual: ['Remove the cron line.'] });
  assert.equal(last.counts.high, 1);
  // Unit7's next check can't see it, so it stays (for a week) instead of vanishing
  const again = ok(await o.h('security.check', {}));
  assert.ok(again.findings.some((x: Finding) => x.by === 'ai' && x.title === f.title));
  assert.ok(!again.fresh.includes(f.id), 'not new the second time');
});
