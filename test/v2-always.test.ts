// V2, always on. The Outpost has to be small, safe and really work on a plain Linux server; what it saw has to close the gaps it
// covered and no more; and the lifeboat only ever creates and copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { testApp, testOrg, ok } from './helpers.ts';
import { get, id, run } from '../src/db.ts';
import { dockerAvailable } from './fixture.ts';
import { ssh } from '../src/connectors/ssh.ts';
import { BACKUPS, CRON, CRON_LINE, DIR, OUTPOST, configOf, jobsOf, parseReadings, uncovered } from '../src/outpost/script.ts';
import { CATCHUP, EVIDENCE, catchupWords, readCatchup, syncOutpost } from '../src/outpost/index.ts';
import { blindMs, gapsIn, noteAlive } from '../src/sentinel/gaps.ts';
import { getTool } from '../src/tools/runtime.ts';
import { script } from '../src/connectors/shell.ts';

const SRV = 'srv_always000001', H = 3600_000;
const world = async () => { const app = testApp(); const o = await testOrg(app); run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'vps', '203.0.113.9', 'credential://x', 'ready', '{}')`, SRV, o.orgId); return { app, o }; };

test('the Outpost stays small and readable, opens nothing, and holds only the alert channel', () => {
  assert.ok(OUTPOST.split('\n').length < 90, `${OUTPOST.split('\n').length} lines`);
  assert.match(OUTPOST, /^#!\/bin\/sh\n# Unit7 Outpost/);
  assert.match(OUTPOST, new RegExp(`To remove it: rm -rf ${DIR} ${CRON}`));
  for (const bad of [/\bnc\b.*-l/, /listen/i, /python|node\s/, /docker (stop|rm|restart|kill|exec [^"]* (rm|drop))/, /rm -rf (?!\$d)/]) assert.ok(!bad.test(OUTPOST.replace(/# To remove it.*\n/, '')), String(bad));
  const c = configOf({ alertUrl: 'https://ntfy.sh/abc', heartbeatUrl: '', sites: ['a.example.com', 'bad site;rm'], copyHour: 3, jobs: [] });
  assert.match(c, /ALERT_URL='https:\/\/ntfy\.sh\/abc'/); assert.match(c, /SITES='a\.example\.com'\n/, 'a name that could be a command never gets in'); assert.match(c, /COPY_HOUR=03/);
  assert.equal(jobsOf({ sites: [], copyHour: 3, jobs: [{ id: 'db', kind: 'postgres', container: 'pg-1' }, { id: 'x;y', kind: 'mysql', container: 'c' }] }), 'db|postgres|pg-1\n');
  assert.match(CRON_LINE, /^# Unit7 Outpost.*\n\* \* \* \* \* root /);
  assert.equal(parseReadings('{"at":"2026-11-06T10:00:00Z","cpu":1,"memUsed":2,"memTotal":3,"diskUsed":4,"diskTotal":5,"running":6,"down":[]}\nnot json\n').length, 1);
});

test('hours the Outpost covered stop being blind; a hole in its readings stays blind', () => {
  const t = Date.UTC(2026, 10, 6), m = 60_000, gap = { from: t, to: t + 8 * H };
  const steady = Array.from({ length: 480 }, (_, i) => t + i * m);
  assert.deepEqual(uncovered(gap, steady), []);
  assert.deepEqual(uncovered(gap, []), [gap], 'no readings: all of it stays');
  const holed = steady.filter((x) => x < t + H || x > t + 2 * H);
  const left = uncovered(gap, holed);
  assert.equal(left.length, 1); assert.ok(Math.abs(left[0]!.to - left[0]!.from - H) < 3 * m);
});

test('catching up: what the server’s own logs say about the hours Unit7 slept', () => {
  const from = Date.UTC(2026, 10, 5, 21), to = Date.UTC(2026, 10, 6, 7);
  const c = readCatchup('@@boot\n2026-11-06 02:00:00\n@@events\n   3 die crm-web\n   1 oom crm-web\n@@oom\n2\n', from, to);
  assert.equal(c.rebooted, true); assert.equal(c.died, 3); assert.equal(c.oom, 2); assert.deepEqual(c.names, ['crm-web']);
  assert.equal(catchupWords('vps', c), 'vps restarted, 2 memory kills, 3 container stops (crm-web)');
  assert.equal(catchupWords('vps', readCatchup('@@boot\n2026-01-01 02:00:00\n@@events\n@@oom\n0\n', from, to)), 'vps: nothing happened');
  assert.ok(!/docker (stop|rm|restart|kill)|rm -/.test(CATCHUP), 'it only reads');
});

test('a gap is noticed when Unit7 comes back, and what it missed counts as blind', async () => {
  const { app } = await world(), t = Date.UTC(2026, 10, 6);
  assert.equal(noteAlive(app.db, t), undefined);
  assert.equal(noteAlive(app.db, t + 5 * 60_000), undefined, 'a normal sweep');
  const g = noteAlive(app.db, t + 8 * H)!;
  assert.equal(g.from, t + 5 * 60_000); assert.equal(g.to, t + 8 * H);
  assert.equal(blindMs(gapsIn(app.db, t, t + 9 * H)), 8 * H - 5 * 60_000);
});

test('green: the lifeboat and the Outpost’s reads only create or copy, and the gate treats them so', () => {
  assert.equal(getTool('safety.lifeboat')!.green, true); assert.equal(getTool('outpost.install')!.green, undefined, 'installing changes the server, so it follows your autonomy');
  for (const bad of [/\brm -rf (?!"\$d")/, /docker (stop|rm|restart|kill)/, /systemctl (stop|restart)/, /kill /]) assert.ok(!bad.test(EVIDENCE), String(bad));
});

test('real Docker: the Outpost runs on a plain Linux box, takes a reading, sends alerts only when Unit7 is away, and takes a real copy', { skip: !dockerAvailable() && 'Docker isn’t available here', timeout: 180_000 }, async () => {
  const tag = id('x').slice(2, 8).toLowerCase().replace(/[^a-z0-9]/g, 'a'), box = `unit7-outpost-${tag}`, db = `unit7-outdb-${tag}`, sink = `unit7-sink-${tag}`;
  spawnSync('docker', ['run', '-d', '--name', db, '-e', 'POSTGRES_PASSWORD=x', 'postgres:16-alpine'], { stdio: 'ignore' });
  // docker.sock from the Mac: a Linux box with curl and docker that can see the database, as Coolify's server would
  spawnSync('docker', ['run', '-d', '--name', box, '-v', '/var/run/docker.sock:/var/run/docker.sock', 'docker:27-cli', 'sh', '-c', 'apk add --no-cache curl coreutils >/dev/null 2>&1; sleep 300'], { stdio: 'ignore' });
  const sh = (cmd: string) => execFileSync('docker', ['exec', '-i', box, 'sh', '-c', cmd], { encoding: 'utf8' });
  try {
    for (let i = 0; i < 80 && spawnSync('docker', ['exec', db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 60 && spawnSync('docker', ['exec', box, 'sh', '-c', 'command -v curl']).status !== 0; i++) await new Promise((r) => setTimeout(r, 500));
    execFileSync('docker', ['exec', '-i', box, 'sh', '-c', `mkdir -p ${DIR} && cat > ${DIR}/outpost.sh && chmod 700 ${DIR}/outpost.sh`], { input: OUTPOST });
    execFileSync('docker', ['exec', '-i', box, 'sh', '-c', `cat > ${DIR}/config`], { input: configOf({ sites: [], copyHour: new Date().getUTCHours(), jobs: [] }) });
    execFileSync('docker', ['exec', '-i', box, 'sh', '-c', `cat > ${DIR}/jobs`], { input: `db|postgres|${db}\n` });
    const run1 = spawnSync('docker', ['exec', box, 'sh', '-c', `${DIR}/outpost.sh`], { encoding: 'utf8' });
    assert.equal(run1.status, 0, run1.stderr);
    const r = parseReadings(sh(`cat ${DIR}/readings.jsonl`))[0]!;
    assert.ok(r, 'it took a reading'); assert.ok(r.memTotal > 1e8); assert.ok(r.diskTotal > 1e9); assert.ok(r.running >= 2, String(r.running)); assert.ok(r.cpu >= 0);
    // the nightly copy only runs at :00 of its hour, so run that part of the script as it is written
    const copy = OUTPOST.slice(OUTPOST.indexOf('  mkdir -p ' + BACKUPS), OUTPOST.lastIndexOf('fi\n')).replace(/\\\$/g, '$');
    const c = spawnSync('docker', ['exec', '-i', box, 'sh', '-c', `D=${DIR}; alert() { echo ALERT "$@"; }; ${copy}`], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const files = sh(`ls ${BACKUPS}/db/`).trim().split('\n');
    assert.equal(files.length, 1); assert.match(sh(`gzip -dc ${BACKUPS}/db/${files[0]} | head -c 4000`), /PostgreSQL database cluster dump/);
    // quiet while Unit7 is awake, speaks when it's away
    spawnSync('docker', ['run', '-d', '--name', sink, '--network', 'container:' + box, 'nginx:alpine'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    const alertCheck = (alive: boolean) => { sh(`rm -f ${DIR}/unit7-alive; ${alive ? `touch ${DIR}/unit7-alive` : ''}`); return spawnSync('docker', ['exec', '-i', box, 'sh', '-c', `D=${DIR}; ALERT_URL=http://127.0.0.1/alert; ${OUTPOST.slice(OUTPOST.indexOf('alert() {'), OUTPOST.indexOf('once() {'))}\nalert "t" "m" 3; echo done`], { encoding: 'utf8' }); };
    alertCheck(true);
    const before = execFileSync('docker', ['logs', sink], { encoding: 'utf8' }).split('\n').filter((l) => /\/alert/.test(l)).length + spawnSync('docker', ['logs', sink], { encoding: 'utf8' }).stderr.split('\n').filter((l) => /\/alert/.test(l)).length;
    assert.equal(before, 0, 'Unit7 is awake, so the Outpost keeps quiet');
    alertCheck(false);
    await new Promise((r) => setTimeout(r, 300));
    const logs = spawnSync('docker', ['logs', sink], { encoding: 'utf8' });
    assert.match(logs.stdout + logs.stderr, /POST \/alert/, 'Unit7 is away, so the Outpost speaks');
  } finally { spawnSync('docker', ['rm', '-f', box, db, sink], { stdio: 'ignore' }); }
});

test('syncing brings readings in, cuts them out of the blind hours, and registers the copies it took', async () => {
  const { app, o } = await world(), t = Date.now() - 10 * H;
  run(app.db, `INSERT INTO outposts (server_id, org_id, version, installed_at) VALUES (?, ?, '1', ?)`, SRV, o.orgId, new Date(t - H).toISOString());
  run(app.db, 'INSERT INTO watch_gaps (from_at, to_at) VALUES (?, ?)', new Date(t).toISOString(), new Date(t + H).toISOString());
  const readings = Array.from({ length: 70 }, (_, i) => JSON.stringify({ at: new Date(t - 5 * 60_000 + i * 60_000).toISOString(), cpu: 5, memUsed: 1e9, memTotal: 4e9, diskUsed: 2e9, diskTotal: 9e9, running: 3, down: [] })).join('\n');
  ssh(app).exec = (async () => ({ code: 0, stdout: `${readings}\n@@copies\n`, stderr: '', truncated: false })) as never;
  const r = await syncOutpost({ app, db: app.db, orgId: o.orgId, signal: undefined } as never, { id: SRV, facts: '{}' } as never);
  assert.equal(r.readings, 70);
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM watch_gaps')!.n, 0, 'nothing blind is left');
  assert.equal(get<{ n: number }>(app.db, 'SELECT count(*) n FROM metrics WHERE server_id = ?', SRV)!.n, 70);
  ok; script;
});
