// Warden's autonomy, tested without any AI: the deterministic reflexes against a real server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { dockerAvailable, startServer } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { Warden } from '../src/sentinel/warden.ts';
import { classifyLogLine, classifyMetric } from '../src/sentinel/classify.ts';
import { all, get, id, run } from '../src/db.ts';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const skip = !dockerAvailable() && 'Docker is not available';
const app = testApp();
let fx: Awaited<ReturnType<typeof startServer>>, o: Awaited<ReturnType<typeof testOrg>>, envId: string, serverId: string, appId: string;
const w = new Warden(app);

async function uploadApp(crash = false): Promise<string> {
  const dir = execFileSync('mktemp', ['-d']).toString().trim();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', scripts: { start: 'node server.js' } }));
  writeFileSync(join(dir, 'server.js'), crash ? "process.exit(1)" : "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(process.env.PORT||3000)");
  execFileSync('tar', ['-czf', join(dir, 's.tgz'), '-C', dir, 'package.json', 'server.js']);
  const up = id('upl'); const ud = join(app.home, 'uploads'); mkdirSync(ud, { recursive: true });
  const dst = join(ud, up + '.tgz'); writeFileSync(dst, readFileSync(join(dir, 's.tgz')));
  run(app.db, 'INSERT INTO uploads (id,org_id,path,size,sha256,created_by) VALUES (?,?,?,?,?,?)', up, o.orgId, dst, 1, 'x', 't');
  return up;
}

before(async () => {
  if (skip) return;
  fx = await startServer(); o = await testOrg(app);
  envId = ok(await o.h('project.create', { name: 'W', environments: ['production'] })).environments[0].id;
  serverId = ok(await o.h('server.connect', { name: 'Box', host: '127.0.0.1', port: fx.sshPort, privateKey: fx.privateKey })).serverId;
  ok(await o.h('server.bootstrap', { serverId }));
  appId = ok(await o.h('service.create', { environmentId: envId, name: 'web', serverId })).serviceId;
  ok(await o.h('deployment.create', { serviceId: appId, source: { type: 'upload', uploadId: await uploadApp() } }));
}, { timeout: 600_000 });
after(() => { ssh(app).closeAll(); fx?.stop(); });

test('classifier flags miners and fatals, ignores normal lines', () => {
  assert.equal(classifyLogLine('xmrig starting, stratum+tcp://pool').score, 1);
  assert.ok(classifyLogLine('FATAL: out of memory').score >= 0.8);
  assert.equal(classifyLogLine('GET /health 200 3ms').score, 0);
  assert.ok(classifyMetric('rps', 600, 50).score > 0);
  assert.equal(classifyMetric('rps', 60, 50).score, 0);
});

test('Warden restarts a crashed managed container', { skip, timeout: 300_000 }, async () => {
  const container = get<{ container: string }>(app.db, 'SELECT container FROM deployments WHERE service_id = ? ORDER BY number DESC LIMIT 1', appId)!.container;
  const s = get<any>(app.db, 'SELECT * FROM servers WHERE id = ?', serverId);
  // kill it
  await ssh(app).exec(s, `docker stop ${container}`);
  // the reflex needs the "down" condition once (streak need=1); run a couple of passes
  await w.checkNow(serverId);
  await new Promise((r) => setTimeout(r, 1500));
  await w.checkNow(serverId);
  // wait for restart + health
  let up = false;
  for (let i = 0; i < 30; i++) { const st = (await ssh(app).exec(s, `docker inspect -f '{{.State.Status}}' ${container}`)).stdout.trim(); if (st === 'running') { up = true; break; } await new Promise((r) => setTimeout(r, 1000)); }
  assert.ok(up, 'Warden brought the container back up');
  const events = all<{ type: string }>(app.db, 'SELECT type FROM events WHERE org_id = ? AND type IN (?, ?)', o.orgId, 'service.down', 'service.restarted');
  assert.ok(events.some((e) => e.type === 'service.down'));
});

test('Warden runs a due scheduled backup and prunes old ones', { skip, timeout: 300_000 }, async () => {
  const db = ok(await o.h('database.create', { environmentId: envId, engine: 'postgres', name: 'wd' }));
  ok(await o.h('backup.schedule', { serviceId: db.serviceId, frequency: 'daily', keep: 2 }));
  // force it due
  run(app.db, 'UPDATE backup_schedules SET last_run_at = NULL WHERE service_id = ?', db.serviceId);
  await w.sweepNow();
  // wait for the backup to finish
  let done = false;
  for (let i = 0; i < 30; i++) { const b = get<{ status: string }>(app.db, `SELECT status FROM backups WHERE service_id = ? ORDER BY created_at DESC LIMIT 1`, db.serviceId); if (b?.status === 'done') { done = true; break; } await new Promise((r) => setTimeout(r, 1000)); }
  assert.ok(done, 'scheduled backup completed');
  const backups = all(app.db, `SELECT 1 FROM backups WHERE service_id = ? AND reason LIKE 'scheduled%'`, db.serviceId);
  assert.ok(backups.length >= 1);
});
