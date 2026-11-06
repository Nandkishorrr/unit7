// An app's own folders and saved files: the generated Dockerfiles give the app's folder to its own user, never run a
// package manager at start, keep data folders in volumes that survive deploys (and are backed up), carry pnpm 11's moved
// settings, and a permission error on start is classified, fixed once and never looped. A stand-in server: no Docker needed
// (the grep check runs the real grep).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { all, get, id, json, run } from '../src/db.ts';
import { ssh, type ExecOptions, type ExecResult } from '../src/connectors/ssh.ts';
import { detect, type RepoFacts } from '../src/connectors/detect.ts';
import { withPins, movePnpmSettings, pnpmShim } from '../src/deploy/pins.ts';
import { dockerfileFor, startFor } from '../src/deploy/dockerfiles.ts';
import { classifyBuild, choicesFor, fixesFor } from '../src/deploy/heal.ts';
import { dockerAvailable } from './fixture.ts';
import { DATA_TRAITS, PREPARE, appVolumes, dataDirsOf, dirsFromDiff, filesWords, volumeArgs } from '../src/deploy/volumes.ts';
import { filesBackupScript, filesRestoreScript } from '../src/tools/backups.ts';
import { settingsChanges, settingsPrBody } from '../src/tools/pins.ts';

const pkg = (o: object) => JSON.stringify(o);
const facts = (manifests: Record<string, string>, pinFiles: Record<string, string> = {}, extra: Partial<RepoFacts> = {}): RepoFacts => ({ files: Object.keys({ ...manifests, ...pinFiles }), manifests, pinFiles, ...extra });
const build = (f: RepoFacts) => dockerfileFor(withPins(detect(f), f, {}), [])!;
const START = 'NODE_ENV=production tsx server/index.ts';

// --- the Dockerfile ---------------------------------------------------------------------------------------------------------
test('Dockerfile: the app’s folder and packages belong to the app’s user, per package manager, and it stays off root', () => {
  const app = { name: 'harbor', scripts: { start: START }, dependencies: { hono: '4' } };
  const pnpm = build(facts({ 'package.json': pkg(app) }, { 'pnpm-lock.yaml': `lockfileVersion: '9.0'\n` }));
  const npm = build(facts({ 'package.json': pkg(app) }, { 'package-lock.json': '{"lockfileVersion": 3}' }));
  const yarn = build(facts({ 'package.json': pkg(app) }, { 'yarn.lock': '# yarn lockfile v1\n' }));
  // the install's own layer hands node_modules to the app's user (no second copy in another layer)
  assert.match(pnpm, /\nRUN corepack enable && corepack prepare pnpm@10 --activate && pnpm install --frozen-lockfile && chown -R node:node \/app \/usr\/local\/share\/corepack\n/);
  assert.match(yarn, /\nRUN corepack enable && corepack prepare yarn@1 --activate && yarn install --frozen-lockfile && chown -R node:node \/app \/usr\/local\/share\/corepack\n/);
  assert.match(npm, /\nRUN \(\[ -f package-lock\.json \] && npm ci\) \|\| npm install && chown -R node:node \/app\n/);
  for (const df of [pnpm, npm, yarn]) {
    assert.match(df, /COPY --chown=node:node \. \./);
    assert.match(df, /\nRUN chown node:node \/app && /, 'the app’s folder itself: the app can create its own folders in it');
    assert.ok(df.indexOf('USER node') > df.lastIndexOf('chown'), 'runs as the unprivileged user, after every chown');
    assert.doesNotMatch(df.split('USER node')[1]!, /^USER root/m);
  }
  // corepack's downloads where the app's user finds the same pnpm that installed (npm needs none)
  assert.match(pnpm, /\nENV COREPACK_HOME=\/usr\/local\/share\/corepack\n/);
  assert.doesNotMatch(npm, /COREPACK_HOME/);
  // a data folder the code writes to is made and owned before USER
  const withData = dockerfileFor({ ...withPins(detect(facts({ 'package.json': pkg(app) }, { 'pnpm-lock.yaml': `lockfileVersion: '9.0'\n` })), facts({ 'package.json': pkg(app) }), {}), dataDirs: ['data', 'uploads'] }, [])!;
  assert.match(withData, /\nRUN mkdir -p \/app\/data \/app\/uploads && chown node:node \/app\/data \/app\/uploads && chown node:node \/app/);
  const py = dockerfileFor({ stack: 'python-flask', builder: 'railpack', runtime: 'python', port: 8000, needs: [], envKeys: [], healthPath: '/', notes: [], dataDirs: ['data'] }, [])!;
  assert.match(py, /RUN useradd -m app && mkdir -p \/app\/data && chown -R app \/app\nUSER app/);
});

test('no package manager at start: pnpm and Yarn scripts run through Node itself (npm on Node 20), never an install', () => {
  const app = (o: object = {}) => ({ name: 'harbor', scripts: { start: START }, dependencies: { hono: '4' }, ...o });
  const pnpm = build(facts({ 'package.json': pkg(app()) }, { 'pnpm-lock.yaml': `lockfileVersion: '9.0'\n` }));
  assert.match(pnpm, /\nCMD \["sh", "-c", "node --run start"\]\n/);
  const yarn = build(facts({ 'package.json': pkg(app()) }, { 'yarn.lock': '# yarn lockfile v1\n' }));
  assert.match(yarn, /\nCMD \["sh", "-c", "node --run start"\]\n/);
  const old = build(facts({ 'package.json': pkg(app({ engines: { node: '20' } })) }, { 'pnpm-lock.yaml': `lockfileVersion: '9.0'\n` }));
  assert.match(old, /\nCMD \["sh", "-c", "npm run start"\]\n/, 'Node 20 has no --run; npm comes with the image and never reinstalls');
  for (const df of [pnpm, yarn, old]) {
    const cmd = /\nCMD (.+)\n/.exec(df)![1]!;
    assert.doesNotMatch(cmd, /\b(pnpm|yarn|install|corepack)\b/, cmd);
  }
  // the person's own start command is kept as it is unless it's only "pnpm run <script>"
  assert.equal(startFor({ startCommand: 'pnpm dlx serve', nodeVersion: 22 } as never), 'pnpm dlx serve');
  assert.equal(startFor({ startCommand: 'node dist/index.js' } as never), 'node dist/index.js');
  assert.equal(startFor({ startCommand: 'yarn serve:prod', nodeVersion: 24 } as never), 'node --run serve:prod');
});

// --- the data folders ---------------------------------------------------------------------------------------------------------
test('data folders: found in the code (the real grep), from what the old version wrote, never a folder the repo ships', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-data-'));
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server', 'db.ts'), `import Database from 'better-sqlite3';\nimport { mkdirSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), 'data'), { recursive: true });\nexport const db = new Database('data/harbor.db');\n`);
  writeFileSync(join(dir, 'server', 'up.ts'), `const dest = './uploads';\nrouter.get('/api/uploads/:id');\nstream.on('data', f);\n`);
  const traits = execFileSync('grep', ['-rhoE', '-e', `(${DATA_TRAITS})`, '--include=*.ts', '-r', '.'], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(dataDirsOf(traits, ['server/db.ts', 'package.json']).dirs, ['data', 'uploads']);
  // the repo ships files in data/: a volume would hide its updates
  const shipped = dataDirsOf(traits, ['data/countries.json']);
  assert.deepEqual(shipped.dirs, ['uploads']);
  assert.match(shipped.notes[0]!, /ships files in data\//);
  assert.deepEqual(dataDirsOf(traits, ['data/.gitkeep']).dirs, ['data', 'uploads'], 'a placeholder is fine');
  assert.match(dataDirsOf(`'app.db'`, []).notes[0]!, /SQLite file app\.db sits at the top/);
  assert.deepEqual(dataDirsOf(`'db/app.sqlite'`, []).dirs, ['db']);
  // what the previous version wrote inside its container (docker diff), caches and packages left out
  assert.deepEqual(dirsFromDiff('C /app\nA /app/data\nA /app/data/harbor.db\nA /app/node_modules/.cache/x\nC /tmp\nA /app/sessions/a\nA /app/notes.txt'), ['data', 'sessions']);
  // detect() carries them for Unit7-built apps only
  const f = facts({ 'package.json': pkg({ scripts: { start: START }, dependencies: { hono: '4' } }) }, {}, { traits });
  assert.deepEqual(detect(f).dataDirs, ['data', 'uploads']);
  assert.equal(detect({ ...f, files: [...f.files, 'Dockerfile'], manifests: { ...f.manifests, Dockerfile: 'FROM node:22' } }).dataDirs, undefined, 'the repo’s own Dockerfile decides its folders');
});

test('volumes: one per folder, per app and environment, mounted by name; the words on the app page', () => {
  const vols = appVolumes('unit7-harbor-1a2b3c', ['uploads', 'data', 'data', 'node_modules']);
  assert.deepEqual(vols, [{ name: 'unit7-harbor-1a2b3c-data', path: '/app/data' }, { name: 'unit7-harbor-1a2b3c-uploads', path: '/app/uploads' }]);
  assert.equal(volumeArgs(vols), `-v 'unit7-harbor-1a2b3c-data:/app/data' -v 'unit7-harbor-1a2b3c-uploads:/app/uploads'`);
  assert.equal(appVolumes(`unit7-${'x'.repeat(60)}-1a2b3c`, ['data'])[0]!.name.length <= 63, true);
  assert.equal(filesWords(vols.slice(0, 1), 'daily'), 'Saves files in /app/data · kept between deploys · backed up daily');
  assert.throws(() => volumeArgs([{ name: 'x; rm -rf /', path: '/app/data' }]));
});

test('backups: the saved files go into one archive per backup, read-only; a restore stops the app’s copies first', () => {
  const vols = [{ name: 'unit7-harbor-1a2b3c-data', path: '/app/data' }];
  assert.equal(filesBackupScript(vols), `docker run --rm -v 'unit7-harbor-1a2b3c-data:/b/data:ro' alpine:3 tar czf - -C /b . > "$1" && gzip -t "$1" && test -s "$1"`);
  const r = filesRestoreScript(vols);
  assert.ok(r.indexOf('docker stop') < r.indexOf('tar xzf') && r.indexOf('tar xzf') < r.indexOf('docker start'));
  assert.match(r, /-v 'unit7-harbor-1a2b3c-data:\/b\/data' /, 'writable for the restore');
});

// --- pnpm 11's settings ---------------------------------------------------------------------------------------------------------
test('pnpm 11: package.json’s pnpm settings go into pnpm-workspace.yaml for the build, and the pull request moves them', () => {
  const app = { name: 'harbor', packageManager: 'pnpm@11.1.0', scripts: { start: START }, dependencies: { hono: '4' }, pnpm: { onlyBuiltDependencies: ['better-sqlite3', 'esbuild'], overrides: { 'hono@<4': '4' } } };
  const f = facts({ 'package.json': pkg(app) }, { 'pnpm-lock.yaml': `lockfileVersion: '9.0'\n` });
  const d = withPins(detect(f), f, {});
  const shim = pnpmShim(f, d.pins)!;
  assert.deepEqual(shim.keys, ['onlyBuiltDependencies', 'overrides']);
  // allowBuilds is pnpm 11's name for them (pnpm.io/blog/releases/11.0); JSON values are valid YAML
  assert.equal(shim.yaml, 'allowBuilds: {"better-sqlite3":true,"esbuild":true}\noverrides: {"hono@<4":"4"}\n');
  // the repo's own workspace file is kept, and a setting it already has wins
  assert.equal(pnpmShim({ ...f, manifests: { ...f.manifests, 'pnpm-workspace.yaml': 'packages:\n  - "."\noverrides:\n  hono: "4"\n' } }, d.pins)!.yaml, 'packages:\n  - "."\noverrides:\n  hono: "4"\nallowBuilds: {"better-sqlite3":true,"esbuild":true}\n');
  // pnpm 10 still reads package.json: nothing to do
  const f10 = facts({ 'package.json': pkg({ ...app, packageManager: 'pnpm@10.18.3' }) }, { 'pnpm-lock.yaml': `lockfileVersion: '9.0'\n` });
  assert.equal(pnpmShim(f10, withPins(detect(f10), f10, {}).pins), undefined);
  assert.equal(movePnpmSettings(pkg({ name: 'x' }), undefined, 11), undefined);
  // the pull request: the field leaves package.json (formatting kept), the settings land in pnpm-workspace.yaml
  const text = JSON.stringify(app, null, 4) + '\n';
  const ch = settingsChanges({ 'package.json': text }, 11);
  assert.deepEqual(ch.map((c) => c.path), ['package.json', 'pnpm-workspace.yaml']);
  assert.equal(JSON.parse(ch[0]!.content).pnpm, undefined);
  assert.match(ch[0]!.content, /^\{\n {4}"name": "harbor",/);
  assert.equal(ch[1]!.content, shim.yaml);
  const body = settingsPrBody('harbor', ch, false);
  assert.match(body, /pnpm 11 no longer reads the "pnpm" field in package\.json/);
  assert.match(body, /- package\.json: removed onlyBuiltDependencies, overrides from package\.json’s "pnpm" field/);
  assert.match(body, /- pnpm-workspace\.yaml: allowBuilds \(pnpm 11’s name for onlyBuiltDependencies\) and overrides/);
});

// --- the classifier ---------------------------------------------------------------------------------------------------------
const OWNER_LOG = `The new version didn't pass its health check, so Unit7 kept the previous one live.
The app keeps crashing on start (restarted 3 times, exit code 0).
 WARN  The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.onlyBuiltDependencies"
 ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR  Failed to remove /app/node_modules/hono from the modules directory: Permission denied (os error 13)
node:fs:1364
  const result = binding.mkdir(
Error: EACCES: permission denied, mkdir '/app/data'
    at Object.mkdirSync (node:fs:1364:26)
    at file:///app/server/db.ts:8:1`;

test('classifier: the owner’s exact lines are a permission problem, fixed by Unit7 once, in plain words', () => {
  const f = classifyBuild({ text: OWNER_LOG, code: 'unhealthy', setKeys: new Set(), builder: 'railpack', packageManager: 'pnpm' })!;
  assert.equal(f.kind, 'permissions');
  assert.equal(f.words, 'The app tried to create /app/data but wasn’t allowed to.');
  assert.deepEqual(fixesFor(f), [{ kind: 'data-dir', dir: 'data' }]);
  // the modules-dir error alone is not about pnpm's version (it used to read as one)
  const modules = classifyBuild({ text: ' ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR  Failed to remove /app/node_modules/hono from the modules directory: Permission denied (os error 13)', code: 'build_failed', setKeys: new Set(), builder: 'railpack', packageManager: 'pnpm', rev: 1 })!;
  assert.equal(modules.kind, 'permissions');
  assert.equal(modules.words, 'The app tried to change its installed packages when it started but wasn’t allowed to.');
  assert.deepEqual(fixesFor(modules), [{ kind: 'rebuild' }], 'built by an older Unit7 Dockerfile: today’s fixes it');
  // no loop: the folder is already kept and today's Dockerfile built it, so nothing more by itself
  const again = classifyBuild({ text: OWNER_LOG, code: 'unhealthy', setKeys: new Set(), builder: 'railpack', dataDirs: ['data'], rev: 2 })!;
  assert.deepEqual(fixesFor(again), []);
  assert.equal(classifyBuild({ text: OWNER_LOG, code: 'unhealthy', setKeys: new Set(), skip: ['permissions'] })?.kind, undefined, 'skipped after one try');
  // the choices: shape from web/src/lib/choices.ts, exactly one recommended
  const o = { app: 'harbor', serviceId: 'svc_1', deploymentId: 'dep_1', state: 'failed' as const };
  const ours = choicesFor(again, o), theirs = choicesFor({ ...again, ours: false }, o);
  for (const cs of [ours, theirs]) {
    assert.equal(cs.filter((c) => c.recommended).length, 1);
    for (const c of cs) { assert.ok(c.label && c.why); assert.doesNotMatch(`${c.label} ${c.why}`, /svc_|dep_|credential:\/\//); }
  }
  assert.deepEqual([ours[0]!.label, ours[0]!.tool], ['Build again', 'deployment.create']);
  assert.match(theirs[0]!.ask!, /pull request.*Never push to the main branch\./);
  // Python's phrasing too
  assert.equal(classifyBuild({ text: `PermissionError: [Errno 13] Permission denied: '/app/uploads/a.png'`, code: 'unhealthy', setKeys: new Set(), builder: 'railpack' })!.dataDir, 'uploads');
});

// --- the deploy, end to end, with a stand-in server ---------------------------------------------------------------------------
const res = (stdout = '', code = 0): ExecResult => ({ code, stdout, stderr: '', truncated: false });
const SHA = 'c'.repeat(40);
function host(app: ReturnType<typeof testApp>, o: { pkg: object; healthy: (dockerfile: string) => boolean }) {
  const dockerfiles: string[] = [], commands: string[] = [], written: Record<string, string> = {};
  let current = '';
  ssh(app).exec = async (_s, command, x: ExecOptions = {}) => {
    commands.push(command);
    const stdin = typeof x.stdin === 'string' ? x.stdin : '';
    if (command.includes('git clone')) return res(`UNIT7_SHA=${SHA}\n`);
    if (command.includes('gitleaks')) return res('[]');
    if (command.includes('-maxdepth 3')) return res('package.json\npnpm-lock.yaml\nserver/index.ts\nserver/db.ts\n');
    if (command.includes('head -c 32768')) return res(JSON.stringify(o.pkg));
    if (command.includes('@@unit7-file')) return res(`@@unit7-file pnpm-lock.yaml\nlockfileVersion: '9.0'\n`);
    if (command.includes('cat >') && command.includes('pnpm-workspace.yaml')) { written['pnpm-workspace.yaml'] = stdin; return res(); }
    if (command.includes('Dockerfile.unit7') && command.includes('cat >')) { dockerfiles.push(stdin); current = stdin; return res(); }
    if (command.includes('docker build')) return res('done');
    if (command.includes(`'inspect'`) && command.includes('OOMKilled')) return res(o.healthy(current) ? 'running 0 false 0' : 'restarting 0 false 3');
    if (command.includes('docker logs')) return res(OWNER_LOG.split('\n').slice(2).join('\n'));
    if (command.includes('curlimages/curl')) return res('200');
    return res();
  };
  return { dockerfiles, commands, written };
}
async function setup() {
  const app = testApp();
  const o = await testOrg(app);
  const { environments } = ok(await o.h('project.create', { name: 'Harbor' }));
  const env = environments.find((e: { kind: string }) => e.kind === 'development').id;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ publicIp: '203.0.113.9', mem_total: 4 * 1024 ** 3 }));
  run(app.db, `UPDATE orgs SET offsite = 'off' WHERE id = ?`, o.orgId);
  const svc = ok(await o.h('service.create', { environmentId: env, name: 'harbor', serverId: srv, source: { type: 'git', repo: 'sam/harbor' } })).serviceId;
  const cfg = () => json<Record<string, any>>(get<{ config: string }>(app.db, 'SELECT config FROM services WHERE id = ?', svc)!.config, {});
  return { app, o, svc, cfg };
}
const HARBOR = { name: 'harbor', packageManager: 'pnpm@11.1.0', scripts: { start: START }, dependencies: { hono: '4', 'better-sqlite3': '12' }, pnpm: { onlyBuiltDependencies: ['better-sqlite3'] } };

test('the owner’s deploy: crashes on start, Unit7 gives it /app/data in a volume, builds once more by itself, and it’s live', async () => {
  const t = await setup();
  const h = host(t.app, { pkg: HARBOR, healthy: (df) => df.includes('mkdir -p /app/data') });
  const r = ok(await t.o.h('deployment.create', { serviceId: t.svc }));
  assert.equal(h.dockerfiles.length, 2, 'one build, then exactly one more');
  assert.equal(r.status, 'live');
  assert.equal(r.told, 'The app tried to create /app/data but wasn’t allowed to. Unit7 fixed the folder permissions and gave it a place to keep files that survives deploys (/app/data), and it’s live.');
  assert.match(h.dockerfiles[0]!, /CMD \["sh", "-c", "node --run start"\]/);
  // the volume: made and owned before the start, mounted into the app and its migrations
  const name = t.cfg().volumes[0].name;
  assert.match(name, /^unit7-harbor-[a-z0-9-]{6}-data$/);
  assert.deepEqual(t.cfg().volumes, [{ name, path: '/app/data' }]);
  assert.ok(h.commands.some((c) => c.includes('docker volume create') && c.includes(name)), 'prepared on the server');
  assert.ok(h.commands.some((c) => c.includes('docker run -d') && c.includes(`-v '\\''${name}:/app/data'\\''`)), 'mounted into the new version');
  // pnpm 11's moved settings were in the build
  assert.equal(h.written['pnpm-workspace.yaml'], 'allowBuilds: {"better-sqlite3":true}\n');
  // backed up daily from now on, and said plainly on the app page
  assert.deepEqual(all(t.app.db, 'SELECT frequency, keep FROM backup_schedules WHERE service_id = ?', t.svc).map((x) => ({ ...(x as object) })), [{ frequency: 'daily', keep: 7 }]);
  const got = ok(await t.o.h('service.get', { serviceId: t.svc }));
  assert.equal(got.savedFiles.words, 'Saves files in /app/data · kept between deploys · backed up daily');
  // the next deploy keeps the volume (the data stays), with no rebuild
  const again = ok(await t.o.h('deployment.create', { serviceId: t.svc }));
  assert.equal(again.status, 'live');
  assert.equal(h.dockerfiles.length, 3);
  assert.deepEqual(t.cfg().volumes, [{ name, path: '/app/data' }]);
  // a backup of the app is its saved files
  const b = ok(await t.o.h('backup.create', { serviceId: t.svc, reason: 'manual' }));
  assert.match(b.location, /\/var\/lib\/unit7\/backups\/harbor-files-.*\.tgz$/);
  assert.ok(h.commands.some((c) => c.includes('tar czf') && c.includes(`${name}:/b/data:ro`)));
  assert.equal(get<{ kind: string }>(t.app.db, 'SELECT kind FROM backups WHERE id = ?', b.backupId)!.kind, 'files');
});

test('no loop: when the folder fix doesn’t help, one more build and then choices, never a third build', async () => {
  const t = await setup();
  const h = host(t.app, { pkg: HARBOR, healthy: () => false });
  const r = await t.o.a('deployment.create', { serviceId: t.svc });
  assert.equal(r.status, 'error');
  assert.equal(h.dockerfiles.length, 2, 'the first build and one more');
  // the next person's deploy: the folder is already kept and today's Dockerfile built it, so no build by itself
  const next = await t.o.h('deployment.create', { serviceId: t.svc });
  assert.equal(next.status, 'error');
  assert.equal(h.dockerfiles.length, 3, 'only the deploy that was asked for');
  assert.match((next as { error: { message: string } }).error.message, /^The app tried to create \/app\/data but wasn’t allowed to\.\nThe version that was live keeps serving\.\nWhat you can do:\n• Build again \(recommended\)/);
});

// --- a real build and run (skipped without Docker) ---------------------------------------------------------------------------
const noDocker = !dockerAvailable() && 'Docker is not available';
test('real Docker: the app creates /app/data as its own user, keeps its file in the volume, and the next version sees it', { skip: noDocker, timeout: 240_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-own-'));
  writeFileSync(join(dir, 'package.json'), pkg({ name: 'harbor', version: '1.0.0', scripts: { start: 'node server.js' } }));
  writeFileSync(join(dir, 'server.js'), `const fs = require('node:fs');\nfs.mkdirSync('data', { recursive: true });\nconst f = 'data/visits.txt';\nconst n = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0) + 1;\nfs.writeFileSync(f, String(n));\nconsole.log('visits=' + n + ' uid=' + process.getuid());\n`);
  const d = { stack: 'node', builder: 'railpack', runtime: 'node', packageManager: 'npm', startCommand: 'npm run start', port: 3000, needs: [], envKeys: [], healthPath: '/', notes: [], nodeVersion: 22, dataDirs: ['data'] } as const;
  writeFileSync(join(dir, 'Dockerfile.unit7'), dockerfileFor({ ...d, needs: [], envKeys: [], notes: [], dataDirs: ['data'] }, [])!);
  const tag = `unit7-test-own:${Date.now()}`, vol = `unit7-test-own-${Date.now()}-data`;
  const sh = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    sh('build', '-q', '-f', join(dir, 'Dockerfile.unit7'), '-t', tag, dir);
    execFileSync('sh', ['-c', PREPARE, 'unit7', tag, '', 'svc_test', vol, '/app/data'], { encoding: 'utf8' });
    assert.match(sh('run', '--rm', '-v', `${vol}:/app/data`, tag), /visits=1 uid=1000/, 'not root, and allowed to write');
    assert.match(sh('run', '--rm', '-v', `${vol}:/app/data`, tag), /visits=2/, 'the next version sees the same files');
    assert.match(sh('run', '--rm', tag), /visits=1/, 'without the volume nothing is kept (what used to happen)');
  } finally {
    try { sh('volume', 'rm', '-f', vol); } catch { /* gone */ }
    try { sh('rmi', '-f', tag); } catch { /* gone */ }
  }
});
