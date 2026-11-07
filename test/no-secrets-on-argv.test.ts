// No password or token on a command line. Unit7 runs `sh -c '<script>' unit7 arg1 arg2…` over SSH, and every argument of
// every process (docker's, and the database client's inside a container) shows in the server's process list. Secrets go
// on the SSH channel's stdin instead, and reach a program by name only (`docker exec -e PGPASSWORD`).
// 1. a scan of src/ for command strings that put a secret right after a secret's name or flag;
// 2. the database flows, against a stand-in server that records every command and what went on its stdin;
// 3. a few of those commands run in a real shell with a fake docker, to prove the value arrives in docker's environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { buildInventory } from '../src/discovery/xray.ts';
import { saveXray } from '../src/tools/xray.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

// --- 1. the scan ----------------------------------------------------------------------------------------------------
const SECRET_NAME = String.raw`\b(?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY))`;
// a value from an argument ($1), all of them ($@), or a JS value spliced into the string (${pw}, not a shell ${NAME:-x})
const FROM_ARG_OR_JS = String.raw`["']?(?:\$\d|\$\{\d|\$[@*]|\$\{(?![A-Z_][A-Z0-9_]*[:}-]))`;
const CMD = /\b(?:docker|mongosh|mongo|psql|mysql|mariadb|redis-cli|curl|wget|git)\s+\S|\b(?:script|cmd)\(/;
const RULES: [string, RegExp][] = [
  ['a secret variable set from an argument or a spliced value', new RegExp(SECRET_NAME + '=' + FROM_ARG_OR_JS)],
  ['a value after -e NAME= is in docker\'s arguments', new RegExp(String.raw`(?:-e|--env)\s+` + SECRET_NAME + String.raw`=["']?\$`)],
  ['a secret flag followed by a value', /(?:^|[\s'"])--(?:requirepass|password|pass|token|access-token|api-key|auth|secret|client-secret)(?:=|\s+)["']?\$/],
  ['a secret flag followed by a value (argument list)', /['"`]--(?:requirepass|password|pass|token|access-token|api-key|auth|secret)['"`]\s*,\s*(?!['"`])\S/],
  ['-p with the password glued on', /(?:^|[\s'"])-p["']?\$/],
  ['redis-cli -a', /redis-cli\b[^|;&\n]*\s-a\s+["']?\$/],
  ['an auth header on a command line', /(?:-H|--header)[\s'"`,]*(?:Authorization|X-[\w-]*(?:Key|Token)):\s*(?:\w+\s+)?\$/i],
  ['a password quoted into a command', /\bshq\(\s*(?:[\w.]+\.)?(?:pw|password|passwd|secret|token|\w*(?:Password|Secret|Token))\s*\)|\bpwQuote\(/],
  ['a secret in a sed program', /\bsed\s+["']s[/|#]\$\{?[A-Z_]*(?:TOKEN|PASSWORD|SECRET|KEY)/],
];
const OPTS = /\{\s*(?:stdin|what|timeoutMs|signal|maxBytes)\b/;
const SECRET_ARG = /[(,]\s*(?:[\w.]+\.)?(?:pw|password|passwd|secret|token)\s*[,)]/;
// (a URL that is a variable's value, NAME="http://$u:$p@…" cmd, is that program's environment, not its arguments)
const URL_CREDS = /(?<!=["']?[a-z]*)[a-z]+:\/\/[^\s'"@/]*:\$\{?[\w(]+\}?[^\s'"]*@/;

// What is wrong on each line of a file: the rules, a secret-named value passed to script()/cmd(), and credentials in a URL
// on a command line (git's, mongosh's: those end up in that program's arguments).
function scan(text: string): { line: number; why: string; text: string }[] {
  const out: { line: number; why: string; text: string }[] = [];
  const lines = text.split('\n');
  let open = false; // a script()/cmd() call that continues on the next line
  lines.forEach((l, k) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const [why, re] of RULES) if (re.test(l)) out.push({ line: k + 1, why, text: t });
    const at = l.search(/\b(?:script|cmd)\(/);
    const args = at >= 0 ? l.slice(at) : open ? l : '';
    if (args) {
      const cut = args.search(OPTS);
      if (SECRET_ARG.test(cut >= 0 ? args.slice(0, cut) : args)) out.push({ line: k + 1, why: 'a secret passed as a command-line argument', text: t });
      open = cut < 0 && !/\);?\s*$/.test(args);
    }
    if (URL_CREDS.test(l) && CMD.test(l)) out.push({ line: k + 1, why: 'credentials in a URL on a command line', text: t });
  });
  return out;
}

// Real exceptions, each with why. Matched by file and a piece of the line (line numbers move).
const ALLOWED: { file: string; has: string; why: string }[] = [
  // `claude mcp add` (the person's own Claude Code CLI, on this computer, not a server) only takes a header as an
  // argument; it runs for a moment while connecting, as the person, and the token is one Unit7 made for that CLI
  { file: 'src/agents/clients.ts', has: "'--header', `Authorization: Bearer ${t.token}`", why: 'local CLI with no other way in' },
];

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

test('the scan catches each way a secret gets onto a command line, and leaves the stdin ways alone', () => {
  const bad = [
    `docker exec -e PGPASSWORD="$3" "$1" psql`, 'docker exec -i -e MYSQL_PWD=${shq(pw)} c mysql', '-e POSTGRES_PASSWORD="$4" "$2"',
    `docker run -e MYSQL_ROOT_PASSWORD=\${password} x`, 'docker exec -e PGPASSWORD="$P" c psql', `redis-cli -a "$1" ping`, `mysql -uroot -p"$2"`,
    `curl -H "Authorization: Bearer $T" https://x`, `['run', image, 'redis-server', '--requirepass', password]`, `exec redis-server --requirepass "$REDIS_PASSWORD"`,
    'await ssh(app).check(s, script(\'cat > "$1"\', file, pw), { what: \'x\' })', 'git clone "https://x-access-token:$GIT_TOKEN@github.com/$REPO.git" /w',
    'docker exec c mongosh ${shq(`mongodb://root:${pw}@localhost:27017/x`)}', 'git push 2>&1 | sed "s/$GIT_TOKEN/***/g"',
  ];
  for (const b of bad) assert.ok(scan(b).length, `not caught: ${b}`);
  const good = [
    `IFS= read -r __pw || true; export PGPASSWORD="$__pw"; unset __pw; docker exec -e PGPASSWORD "$1" psql`, `IFS= read -r P; MYSQL_PWD="$P" exec docker exec -i -e MYSQL_PWD "$1" mysql`,
    `docker exec "$2" sh -c 'export MYSQL_PWD="\\\${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; mysqldump'`, `export PGPASSWORD="\${POSTGRES_PASSWORD:-}"; exec psql`,
    `printf 'header = "Authorization: Bearer %s"\\n' "$t" | curl -K -`, 'ps -eo pid,comm --sort=-p"$1"', `mysqladmin ping -uroot -pverify --silent`,
    'await ssh(app).check(s, script(\'cat > "$1"\', file), { what: \'x\', stdin: `${pw}\\n` })', `ctx.app.vault.put(o, ref, \`postgresql://postgres:\${pw}@\${pool}:6432/app\`)`,
    `docker exec "$c" sh -c 'MC_HOST_unit7="http://$u:$p@127.0.0.1:9000" mc admin info unit7'`,
  ];
  for (const g of good) assert.deepEqual(scan(g), [], `wrongly caught: ${g}`);
});

test('no command string in src/ puts a password or token on a command line', () => {
  const root = join(import.meta.dirname, '..');
  const found: string[] = [];
  const allowedHits = new Set<string>();
  for (const f of walk(join(root, 'src'))) {
    const file = relative(root, f);
    for (const h of scan(readFileSync(f, 'utf8'))) {
      const allow = ALLOWED.find((a) => a.file === file && h.text.includes(a.has));
      if (allow) { allowedHits.add(`${allow.file} ${allow.has}`); continue; }
      found.push(`${file}:${h.line}  ${h.why}\n    ${h.text.slice(0, 220)}`);
    }
  }
  assert.deepEqual(found, [], `\n${found.join('\n')}\n\nSend the secret on stdin (secretIn in src/connectors/shell.ts) and pass it by name.`);
  for (const a of ALLOWED) assert.ok(allowedHits.has(`${a.file} ${a.has}`), `the allow-list entry for ${a.file} matches nothing any more: remove it`);
});

// --- 2. the flows, on a stand-in server --------------------------------------------------------------------------------
const done = (stdout = '', code = 0) => ({ code, stdout, stderr: code ? 'failed' : '', truncated: false });
type Seen = { command: string; stdin: string }[];
function fakeServer(app: App, reply: (command: string) => ReturnType<typeof done> | undefined = () => undefined): Seen {
  const seen: Seen = [];
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => { seen.push({ command, stdin: String(o.stdin ?? '') }); return reply(command) ?? done(); };
  return seen;
}
// none of these is on any command line; each that was used arrived as the first line of some command's stdin
function onlyOnStdin(seen: Seen, secrets: Record<string, string>) {
  assert.ok(seen.length, 'something ran');
  for (const [what, value] of Object.entries(secrets)) {
    for (const x of seen) assert.ok(!x.command.includes(value), `${what} is on a command line: ${x.command.slice(0, 300)}`);
    assert.ok(seen.some((x) => x.stdin.startsWith(`${value}\n`)), `${what} never arrived on stdin`);
  }
}

async function setup() {
  const app = testApp();
  const o = await testOrg(app, 'Sam');
  const { environments } = ok(await o.h('project.create', { name: 'Shop' }));
  const env = environments.find((e: any) => e.kind === 'development').id;
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready')`, srv, o.orgId);
  run(app.db, `UPDATE orgs SET offsite = 'off' WHERE id = ?`, o.orgId);
  const db = (kind: string, slug: string, pw: string, config: object = {}) => {
    const svc = id('svc'), ref = `credential://${kind}/${slug}/password`;
    run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, server_id, name, slug, kind, config) SELECT ?, org_id, project_id, id, ?, ?, ?, ?, ? FROM environments WHERE id = ?`,
      svc, srv, slug, slug, kind, JSON.stringify({ engine: kind, container: `${slug}-c`, database: 'app', passwordRef: ref, ...config }), env);
    app.vault.put(o.orgId, ref, pw, { kind: 'db_password' });
    return svc;
  };
  return { app, o, env, srv, db };
}
const backupRow = (app: App, orgId: string, svc: string, kind: string) => {
  const b = id('bak');
  run(app.db, `INSERT INTO backups (id, org_id, service_id, kind, reason, location, status, checksum) VALUES (?, ?, ?, ?, 'manual', '/var/lib/unit7/backups/x.gz', 'done', 'abc')`, b, orgId, svc, kind);
  return b;
};
const answers = (c: string) => (c.includes('gunzip -t') ? done('abc\n') : c.includes('/^COPY /') ? done('postgres\tpublic.items\t3\n') : c.includes('-AtqX') ? done('public.items|3\n') : c.includes('wc -c') ? done('10\nabc\n') : c.includes('{{.Config.Image}}') ? done('postgres:17-alpine\n') : c.includes('-tAc') || c.includes(' -N -e') ? done('3\n') : undefined);

test('a backup, its check and a restore: the database password only ever travels on stdin', async () => {
  for (const kind of ['postgres', 'mysql']) {
    const { app, o, db } = await setup();
    const pw = `${kind}-Pw-${id('x').slice(2)}`;
    const svc = db(kind, 'store', pw);
    const seen = fakeServer(app, answers);
    ok(await o.h('backup.create', { serviceId: svc }));
    const bak = backupRow(app, o.orgId, svc, kind);
    assert.equal(ok(await o.h('backup.verify', { backupId: bak })).ok, true);
    ok(await o.h('backup.restore', { backupId: bak, confirm: true }));
    onlyOnStdin(seen, { [`the ${kind} password`]: pw });
    assert.ok(seen.some((x) => /mysqldump|pg_dump/.test(x.command) && x.stdin === `${pw}\n`), 'the dump signs in from stdin');
    assert.ok(seen.some((x) => /ON_ERROR_STOP|mysql -u root/.test(x.command) && x.command.includes('gunzip') && x.stdin === `${pw}\n`), 'and so does the restore');
  }
});

test('database.query (a read, a write) and database.inspect, for each engine: no password on a command line', async () => {
  for (const kind of ['postgres', 'mysql', 'mariadb', 'mongo', 'redis']) {
    const { app, o, db } = await setup();
    const pw = `${kind}-Admin-${id('x').slice(2)}`;
    const svc = db(kind, 'store', pw);
    const seen = fakeServer(app);
    const sql = kind === 'redis' ? 'GET greeting' : kind === 'mongo' ? 'db.items.countDocuments()' : 'SELECT count(*) FROM items';
    ok(await o.h('database.query', { serviceId: svc, sql }));
    ok(await o.h('database.query', { serviceId: svc, sql: kind === 'redis' ? 'SET greeting hello' : kind === 'mongo' ? 'db.items.insertOne({a:1})' : "INSERT INTO items (name) VALUES ('a')", write: true }));
    ok(await o.h('database.inspect', { serviceId: svc }));
    const ro = app.vault.resolve(o.orgId, `credential://${kind}/store/readonly-password`)!;
    onlyOnStdin(seen, { [`${kind}'s admin password`]: pw, [`${kind}'s read-only password`]: ro });
    if (kind === 'mongo') assert.ok(seen.every((x) => !/mongodb:\/\/[^"'\s]*:[^"'\s]*@/.test(x.command)), 'no password in a connection string either');
  }
});

test('a password change (with a pooler): neither the old nor the new password is on a command line', async () => {
  const { app, o, db } = await setup();
  const old = 'old-Pw-1234567890';
  const pg = db('postgres', 'pg', old, { pool: { container: 'pg-pool' } });
  const seen = fakeServer(app);
  ok(await o.h('database.rotate_password', { serviceId: pg }));
  const next = app.vault.resolve(o.orgId, 'credential://postgres/pg/password')!;
  assert.notEqual(next, old);
  for (const x of seen) for (const v of [old, next]) assert.ok(!x.command.includes(v), x.command.slice(0, 300));
  const alter = seen.find((x) => x.stdin.includes('ALTER USER'))!;
  assert.ok(alter.stdin.startsWith(`${old}\n`), 'signs in with the current password, from stdin');
  assert.match(alter.command, /-e PGPASSWORD "\$1"/);
  assert.ok(seen.some((x) => x.command.includes('6432') && x.stdin === `${next}\n`), 'the pooler check signs in from stdin too');
});

test('creating a database and putting a pooler in front: the password reaches docker by name only', async () => {
  for (const engine of ['postgres', 'mysql', 'mongo', 'redis']) {
    const { app, o, env } = await setup();
    const seen = fakeServer(app);
    const r = ok(await o.h('database.create', { environmentId: env, engine }));
    const pw = app.vault.resolve(o.orgId, r.passwordRef)!;
    onlyOnStdin(seen, { [`the new ${engine} password`]: pw });
    const start = seen.find((x) => x.command.includes("'run'"))!;
    assert.match(start.command, engine === 'redis' ? /'-e' 'REDIS_PASSWORD'/ : /'-e' '(POSTGRES|MYSQL_ROOT|MONGO_INITDB_ROOT)_PASSWORD'/);
    if (engine === 'postgres') {
      seen.length = 0;
      ok(await o.h('database.pool', { serviceId: r.serviceId }));
      for (const x of seen) assert.ok(!x.command.includes(pw), x.command.slice(0, 300));
      assert.ok(seen.some((x) => x.command.includes('6432') && x.stdin === `${pw}\n`));
    }
  }
});

test('a test copy from a part backup: its new password goes on stdin, not on docker run', async () => {
  const SRV = 'srv_argv00000001';
  for (const engine of ['mysql', 'postgres']) {
    const app = testApp();
    const o = await testOrg(app, 'Sam');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'web-1', '203.0.113.9', 'root', 'credential://ssh/box/k', 'ready', '{}')`, SRV, o.orgId);
    const inv = buildInventory(COOLIFY_HOST, { serverHost: '203.0.113.9' });
    inv.parts.push({ id: `c:${engine}-db`, kind: 'database', name: `${engine}-db`, owner: 'compose', trust: 'understood', engine, image: `${engine}:8`, containers: [`${engine}-db-1`], project: 'c:shop' } as any);
    saveXray(app.db, o.orgId, SRV, 'fast', inv);
    run(app.db, `INSERT INTO backups (id, org_id, server_id, part, kind, reason, location, size, checksum, status, finished_at) VALUES (?, ?, ?, ?, ?, 'manual', '/var/lib/unit7/backups/p.gz', 10, 'abc', 'done', ?)`,
      id('bak'), o.orgId, SRV, `c:${engine}-db`, engine, new Date().toISOString());
    const seen = fakeServer(app, (c) => (c.includes('gunzip -t') ? done('abc\n') : undefined));
    const copy = ok(await o.h('part.restore', { serverId: SRV, part: `c:${engine}-db` }));
    const pw = app.vault.resolve(o.orgId, copy.passwordRef)!;
    onlyOnStdin(seen, { [`the ${engine} copy's password`]: pw });
    const made = seen.find((x) => x.command.includes('docker run -d'))!;
    assert.match(made.command, engine === 'mysql' ? /-e MYSQL_ROOT_PASSWORD -e MARIADB_ROOT_PASSWORD "\$2"/ : /-e POSTGRES_PASSWORD "\$2"/);
  }
});

// --- 3. in a real shell, with a fake docker ------------------------------------------------------------------------------
// docker records its arguments, the secret names in its environment, and its stdin; the commands Unit7 sent run as-is
function fakeBins() {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-argv-')), log = join(dir, 'log');
  const bin = (name: string) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env node
const fs = require('fs'); let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const names = ['PGPASSWORD', 'MYSQL_PWD', 'REDISCLI_AUTH', 'UNIT7_PW', 'POSTGRES_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD', 'MONGO_INITDB_ROOT_PASSWORD', 'REDIS_PASSWORD'];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2), env: Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]])), stdin }) + '\\n');
`);
    chmodSync(join(dir, name), 0o755);
  };
  bin('docker'); bin('docker-entrypoint.sh');
  const sh = (command: string, stdin: string, env: Record<string, string> = {}) => {
    const r = spawnSync('sh', ['-c', command], { input: stdin, env: { PATH: `${dir}:${process.env.PATH}`, ...env }, encoding: 'utf8', timeout: 20_000 });
    return r.status;
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { bin: string; argv: string[]; env: Record<string, string>; stdin: string });
  return { sh, calls, reset: () => writeFileSync(log, '') };
}

test('in a real shell: each command hands the password to docker through its environment, never its arguments', async () => {
  const f = fakeBins();
  // a look inside each engine as its admin, and the rotation's sign-in
  for (const [kind, name] of [['postgres', 'PGPASSWORD'], ['mysql', 'MYSQL_PWD'], ['mongo', 'UNIT7_PW'], ['redis', 'REDISCLI_AUTH']] as const) {
    const { app, o, db } = await setup();
    const pw = `It's-${kind}-"pw"$x`; // quotes and a dollar sign, so a quoting slip shows
    const svc = db(kind, 'store', pw);
    const seen = fakeServer(app);
    ok(await o.h('database.inspect', { serviceId: svc }));
    if (kind === 'postgres') ok(await o.h('database.rotate_password', { serviceId: svc }));
    assert.equal(seen.filter((x) => x.command.includes('docker exec -i -e')).length, kind === 'postgres' ? 2 : 1);
    for (const x of seen.filter((x) => x.command.includes('docker exec -i -e'))) {
      f.reset();
      assert.equal(f.sh(x.command, x.stdin), 0, x.command);
      const c = f.calls().find((y) => y.bin === 'docker')!;
      assert.ok(!c.argv.join(' ').includes(pw), `on docker's arguments: ${c.argv.join(' ')}`);
      assert.equal(c.env[name], pw, `${name} reached docker for ${kind}`);
      assert.ok(c.argv.includes('-e') && c.argv.includes(name), 'and docker passes it on by name');
      if (kind === 'mongo') assert.match(c.argv.at(-1)!, /^db\.getSiblingDB\('admin'\)\.auth\('root', process\.env\.UNIT7_PW\); db\.getCollectionNames\(\)\.map\(/);
    }
  }
  // a new Redis: docker gets the password by name, and redis-server reads it from a config on its stdin
  const { app, o, env } = await setup();
  const seen = fakeServer(app);
  const r = ok(await o.h('database.create', { environmentId: env, engine: 'redis' }));
  const pw = app.vault.resolve(o.orgId, r.passwordRef)!;
  const start = seen.find((x) => x.command.includes("'run'"))!;
  f.reset();
  assert.equal(f.sh(start.command, start.stdin), 0);
  const run1 = f.calls()[0]!;
  assert.equal(run1.env.REDIS_PASSWORD, pw);
  assert.ok(!run1.argv.join(' ').includes(pw));
  const [shell, dashC, inside] = run1.argv.slice(-3);
  assert.deepEqual([shell, dashC], ['sh', '-c']);
  f.reset();
  assert.equal(f.sh(inside!, '', { REDIS_PASSWORD: pw }), 0, 'the container’s own command');
  const redis = f.calls()[0]!;
  assert.deepEqual(redis.argv, ['redis-server', '-']);
  assert.equal(redis.stdin, `requirepass ${pw}\nmaxmemory-policy allkeys-lru\n`);
});
