// Building through Coolify (src/tools/coolify.ts creates, src/tools/coolify-build.ts plan + build). A stand-in Coolify
// keeps projects, apps, databases and services in memory and answers like v4.4; the "server" runs real curl with the
// config Unit7 sends on stdin. Covers each create call's exact body, base64 compose, delete_volumes=false, polling,
// plans for three sentences, the one plan card in the ask box, stop-on-failure, secrets never leaving Coolify, autonomy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { all, id, now, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { CURL, coolifyError, coolifyTiming } from '../src/connectors/coolify.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import { decideApproval, execute, type ToolResult } from '../src/tools/runtime.ts';
import { answerAsk, bindRun } from '../src/agent/asks.ts';
import { parseWish } from '../src/tools/coolify-build.ts';
import type { AgentMessage } from '../src/agent/brain.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

const TOKEN = '3|unit7testtokenAbC123xyz';
const SUPA_URL = 'http://supabasekong-k9.203.0.113.9.sslip.io';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.anonKeyValue7Qx.Sig5ature';
const SERVICE_ROLE = 'eyJhbGciOiJIUzI1NiJ9.serviceRole9Zp.Sig6ature';
coolifyTiming.pollMs = 5;

function fakeCoolify(o: { sensitive?: boolean } = {}) {
  const seen: { method: string; path: string; body: any }[] = [];
  const projects: { uuid: string; name: string; environments: { name: string; uuid: string }[] }[] = [];
  const things: any[] = [], schedules: any[] = [], tasks: any[] = [];
  const deps = new Map<string, string>(), ticks = new Map<string, number>();
  let n = 0;
  const uid = (p: string) => `${p}${String(++n).padStart(4, '0')}`;
  const at = () => new Date(Date.UTC(2026, 9, 7, 10, 0, ++n)).toISOString();
  const tick = (k: string) => { const v = (ticks.get(k) ?? 0) + 1; ticks.set(k, v); return v; };
  const state = { throttle: 0, seen, things, schedules };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://x'), path = url.pathname.replace(/^\/api\/v1/, ''), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: req.method!, path: path + url.search, body });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': typeof b === 'string' ? 'text/plain' : 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Unauthenticated.' });
    const r = `${req.method} ${path}`, find = (u: string) => things.find((t) => t.uuid === u);
    let m: RegExpExecArray | null;
    if (r === 'GET /version') return send(200, '4.4.0');
    if (r === 'GET /team') return send(200, { id: 0, name: 'Sam’s team' });
    if (r === 'GET /servers') return send(200, [{ uuid: 'srvuuid01', name: 'localhost', ip: 'host.docker.internal' }]);
    if (r === 'GET /servers/srvuuid01/sentinel') return send(200, { sentinel_token: 'sentinel-token-value-1' });
    if (r === 'POST /deploy') {
      const u = url.searchParams.get('uuid');
      if (!u) return send(400, { message: 'You must provide uuid or tag.' });
      const dep = uid('dep'); deps.set(dep, find(u)?.name === 'broken' ? 'failed' : 'finished');
      return send(200, { deployments: [{ message: 'Deployment queued.', resource_uuid: u, deployment_uuid: dep }] });
    }
    if ((m = /^GET \/deployments\/(\w+)$/.exec(r))) {
      if (state.throttle > 0) { state.throttle--; return send(429, { message: 'Too Many Attempts.' }); }
      return send(200, { deployment_uuid: m[1], status: tick(m[1]!) < 3 ? 'in_progress' : deps.get(m[1]!), logs: JSON.stringify([{ output: 'npm ERR! missing script: build' }]) });
    }
    if (r === 'GET /projects') return send(200, projects.map((p) => ({ uuid: p.uuid, name: p.name })));
    if (r === 'POST /projects') {
      const p = { uuid: uid('proj'), name: body.name, environments: [{ name: 'production', uuid: uid('env') }] }; // Coolify adds production itself
      projects.push(p); return send(201, { uuid: p.uuid });
    }
    if ((m = /^(GET|DELETE) \/projects\/(\w+)$/.exec(r))) {
      const p = projects.find((x) => x.uuid === m![2]);
      if (!p) return send(404, { message: 'Project not found.' });
      if (m[1] === 'GET') return send(200, p);
      projects.splice(projects.indexOf(p), 1); return send(200, { message: 'Project deleted.' });
    }
    if ((m = /^POST \/projects\/(\w+)\/environments$/.exec(r))) {
      const p = projects.find((x) => x.uuid === m![1])!;
      if (p.environments.some((e) => e.name === body.name)) return send(409, { message: 'Environment with this name already exists.' });
      const e = { name: body.name, uuid: uid('env') }; p.environments.push(e); return send(201, { uuid: e.uuid });
    }
    if ((m = /^GET \/projects\/(\w+)\/([\w-]+)$/.exec(r))) {
      const env = projects.find((x) => x.uuid === m![1])?.environments.find((e) => e.uuid === m![2] || e.name === m![2]); // a name or a uuid
      const here = things.filter((t) => t.project_uuid === m![1] && t.environment_name === env?.name);
      return send(200, { applications: here.filter((t) => t.kind === 'application'), services: here.filter((t) => t.kind === 'service'),
        ...Object.groupBy(here.filter((t) => t.kind === 'database'), (t) => (t.engine === 'redis' ? 'redis' : `${t.engine}s`)) });
    }
    if ((m = /^POST \/applications\/(public|private-github-app|dockerimage|dockerfile)$/.exec(r))) {
      const need = ['project_uuid', 'server_uuid', 'environment_name', ...({ dockerfile: ['dockerfile'], dockerimage: ['docker_registry_image_name', 'ports_exposes'] } as Record<string, string[]>)[m[1]!] ?? ['git_repository', 'git_branch', 'build_pack', 'ports_exposes'], ...(m[1] === 'private-github-app' ? ['github_app_uuid'] : [])];
      const miss = need.filter((k) => body?.[k] === undefined);
      if (miss.length) return send(422, { message: 'Validation failed.', errors: Object.fromEntries(miss.map((k) => [k, [`The ${k.replace(/_/g, ' ')} field is required.`]])) });
      if (String(body.domains ?? '').includes('taken.example.com')) return send(409, { message: 'Domain conflicts detected. Use force_domain_override=true to proceed.' });
      const t = { ...body, kind: 'application', uuid: uid('app'), status: 'exited', envs: [] as any[] };
      t.fqdn = body.domains ?? `http://${t.uuid}.203.0.113.9.sslip.io`;
      things.push(t); return send(201, { uuid: t.uuid, domains: String(t.fqdn).split(',') });
    }
    if ((m = /^PATCH \/applications\/(\w+)$/.exec(r))) {
      if (String(body.domains ?? '').includes('taken.example.com')) return send(409, { message: 'Domain conflicts detected. Use force_domain_override=true to proceed.' });
      Object.assign(find(m[1]!), body.domains ? { fqdn: body.domains } : body); return send(200, { uuid: m[1] });
    }
    if ((m = /^PATCH \/(applications|databases|services)\/(\w+)\/envs\/bulk$/.exec(r))) {
      const t = find(m[2]!); if (!t) return send(404, { message: 'Not found.' });
      for (const v of body.data) { t.envs = t.envs.filter((e: any) => e.key !== v.key); t.envs.push(v); }
      return send(201, { message: 'Environment variables updated.' });
    }
    if ((m = /^POST \/databases\/(\w+)$/.exec(r))) {
      if (!body.server_uuid || !body.project_uuid || !body.environment_name) return send(422, { message: 'Validation failed.', errors: { server_uuid: ['The server uuid field is required.'] } });
      const t = { ...body, kind: 'database', engine: m[1], uuid: uid('db'), status: 'exited', database_type: `standalone-${m[1]}`, envs: [] };
      things.push(t); return send(201, { uuid: t.uuid });
    }
    if (r === 'POST /services') {
      if (!body.type === !body.docker_compose_raw) return send(422, { message: 'Validation failed.', errors: { type: ['Give type or docker_compose_raw.'] } });
      const t = { ...body, kind: 'service', uuid: uid('svc'), status: 'exited', envs: body.type === 'supabase'
        ? [{ key: 'SERVICE_URL_SUPABASEKONG', value: SUPA_URL }, { key: 'SERVICE_SUPABASEANON_KEY', value: ANON }, { key: 'SERVICE_SUPABASESERVICE_KEY', value: SERVICE_ROLE }] : [] };
      things.push(t); return send(201, { uuid: t.uuid, domains: body.type === 'supabase' ? [SUPA_URL] : [] });
    }
    if ((m = /^GET \/services\/(\w+)\/envs$/.exec(r))) return send(200, find(m[1]!).envs.map((e: any, i: number) => ({ uuid: `e${i}`, key: e.key, is_preview: false, ...(o.sensitive !== false && { value: e.value }) })));
    if ((m = /^GET \/(applications|databases|services)\/(\w+)$/.exec(r))) {
      const t = find(m[2]!); if (!t) return send(404, { message: 'Not found.' });
      if (t.kind !== 'application') t.status = tick(t.uuid) < 2 ? 'starting' : 'running:healthy';
      return send(200, t);
    }
    if ((m = /^DELETE \/(applications|databases|services)\/(\w+)$/.exec(r))) { things.splice(things.indexOf(find(m[2]!)), 1); return send(200, { message: 'Deletion request queued.' }); }
    if (r === 'GET /github-apps') return send(200, [{ id: 0, uuid: 'ghpublic', name: 'Public GitHub', is_public: true }, { id: 1, uuid: 'ghapp01', name: 'Sam’s GitHub App', is_public: false }]);
    if (r === 'GET /github-apps/1/repositories') return send(200, { repositories: [{ full_name: 'example/shop', private: true, default_branch: 'main' }] });
    // backups: a run starts as running and is a success the next time it's looked at
    const backup = (b: any) => b.executions.push({ uuid: uid('exe'), status: 'running', created_at: at(), filename: `/data/coolify/backups/databases/${b.db}/pg-dump-${n}.dmp`, size: 2048 });
    if ((m = /^(GET|POST) \/databases\/(\w+)\/backups$/.exec(r))) {
      if (m[1] === 'GET') return send(200, schedules.filter((b) => b.db === m![2]).map(({ executions: _e, ...b }) => b));
      const b = { uuid: uid('bak'), db: m[2], ...body, executions: [] as any[] }; schedules.push(b);
      if (body.backup_now) backup(b);
      return send(201, { uuid: b.uuid, message: 'Backup configuration created.' });
    }
    if ((m = /^(PATCH|DELETE) \/databases\/(\w+)\/backups\/(\w+)$/.exec(r))) {
      const b = schedules.find((x) => x.uuid === m![3])!;
      if (m[1] === 'DELETE') { schedules.splice(schedules.indexOf(b), 1); return send(200, { message: 'Deleted.' }); }
      if (body.backup_now) backup(b);
      return send(200, { message: 'Backup configuration updated.' });
    }
    if ((m = /^GET \/databases\/(\w+)\/backups\/(\w+)\/executions$/.exec(r))) {
      const b = schedules.find((x) => x.uuid === m![2])!;
      const out = { executions: b.executions.map((e: any) => ({ ...e })) };
      for (const e of b.executions) if (e.status === 'running') e.status = 'success';
      return send(200, out);
    }
    if ((m = /^POST \/databases\/(\w+)\/imports$/.exec(r))) return send(201, { message: 'Import queued.', activity_id: uid('act') });
    if ((m = /^GET \/databases\/(\w+)\/imports\/(\w+)$/.exec(r))) return send(200, { status: tick(m[2]!) < 2 ? 'in_progress' : 'finished' });
    // scheduled tasks
    if ((m = /^(GET|POST) \/applications\/(\w+)\/scheduled-tasks$/.exec(r))) {
      if (m[1] === 'GET') return send(200, tasks.filter((t) => t.app === m![2]).map(({ runs: _r, ...t }) => t));
      const t = { uuid: uid('task'), app: m[2], ...body, runs: [] as any[] }; tasks.push(t); return send(201, { uuid: t.uuid });
    }
    if ((m = /^POST \/applications\/(\w+)\/scheduled-tasks\/(\w+)\/execute$/.exec(r))) {
      tasks.find((t) => t.uuid === m![2])!.runs.push({ uuid: uid('run'), status: 'running', created_at: at(), message: 'Migrated 3 tables\nDone' });
      return send(200, { message: 'Task queued for execution.' });
    }
    if ((m = /^GET \/applications\/(\w+)\/scheduled-tasks\/(\w+)\/executions$/.exec(r))) {
      const t = tasks.find((x) => x.uuid === m![2])!;
      const out = t.runs.map((e: any) => ({ ...e }));
      for (const e of t.runs) e.status = 'success';
      return send(200, out);
    }
    send(404, { message: 'Not found.' });
  });
  return new Promise<typeof state & { port: number; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r(Object.assign(state, { port: (server.address() as { port: number }).port, close: () => server.close() }))));
}

function fakeServer(app: App, port: number) {
  ssh(app).exec = async (_s, command, o: ExecOptions = {}) => {
    const stdin = String(o.stdin ?? '');
    if (stdin === XRAY_PROBE) return { code: 0, stdout: COOLIFY_HOST, stderr: '', truncated: false };
    if (command !== CURL) throw new Error(`unexpected command: ${command}`);
    return new Promise((resolve) => {
      const p = spawn('curl', ['-K', '-']);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
      p.stdin.end(stdin.replace('http://127.0.0.1:8000/', `http://127.0.0.1:${port}/`));
    });
  };
}
async function setup(o: { sensitive?: boolean } = {}) {
  const app = testApp();
  const c = await fakeCoolify(o);
  const org = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, org.orgId, JSON.stringify({ sudo: 'root' }));
  fakeServer(app, c.port);
  ok(await org.h('coolify.connect', { serverId: srv, token: TOKEN }));
  c.seen.length = 0;
  return { app, c, o: org, srv };
}
// a person approves what's waiting; the action then runs
const approve = async (app: App, o: { orgId: string; human: any }, r: unknown, name?: string) => decideApproval(app, o.orgId, o.human, (r as { approvalId: string }).approvalId, true, name) as Promise<ToolResult>;
const calls = (c: { seen: { method: string; path: string; body: any }[] }, method: string, path: RegExp) => c.seen.filter((x) => x.method === method && path.test(x.path));
const autonomy = (app: App, orgId: string, level: number) => run(app.db, 'UPDATE orgs SET autonomy = ? WHERE id = ?', level, orgId);

// a Home chat thread: the run is bound like the brain binds it, and every message is stored like conversations.ts does
function thread(app: App, orgId: string, userId: string) {
  const conversationId = id('cnv');
  run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conversationId, orgId, userId, 'build');
  const msgs = new Map<string, AgentMessage>();
  const emit = (m: AgentMessage) => {
    msgs.set(m.id, m);
    run(app.db, `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content`, m.id, conversationId, m.role, JSON.stringify(m.content), m.created_at ?? now());
  };
  const ac = new AbortController();
  const unbind = bindRun(conversationId, { orgId, userId, emit, signal: ac.signal });
  const principal = { org: { id: orgId }, user: { id: userId } } as any;
  const askOpen = async () => {
    for (let i = 0; i < 400; i++) { const a = [...msgs.values()].find((m) => m.role === 'ask' && m.content.state === 'waiting'); if (a) return a; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('no ask came');
  };
  return { conversationId, msgs, unbind, askOpen, answer: (askId: string, body: unknown) => answerAsk(app, principal, askId, body) };
}

test('every create sends Coolify’s exact fields, reuses by name, and wires secrets inside Coolify only', async () => {
  const { app, c, o, srv } = await setup();
  try {
    const p = ok(await o.h('coolify.create_project', { serverId: srv, name: 'shop', environment: 'staging' }));
    assert.deepEqual(calls(c, 'POST', /^\/projects$/)[0]!.body, { name: 'shop' });
    assert.deepEqual(calls(c, 'POST', /\/environments$/)[0]!.body, { name: 'staging' });
    assert.equal(p.reused, false);
    assert.match(p.undo, /coolify\.remove kind project/);
    assert.equal(ok(await o.h('coolify.create_project', { serverId: srv, name: 'Shop' })).reused, true, 'same name, any case: reused');
    assert.equal(calls(c, 'POST', /^\/projects$/).length, 1);
    const where = { serverId: srv, project: p.project, environment: 'production' };
    const loc = { project_uuid: p.project, environment_name: 'production', server_uuid: 'srvuuid01' };

    // a private repo goes through the Coolify GitHub App that reaches it, branch from the repo
    const web = ok(await o.h('coolify.create_app', { ...where, name: 'shop', repo: 'https://github.com/example/shop' }));
    assert.deepEqual(calls(c, 'POST', /^\/applications\//)[0], { method: 'POST', path: '/applications/private-github-app', body: { ...loc, name: 'shop', ports_exposes: '3000', instant_deploy: false, git_branch: 'main', build_pack: 'nixpacks', github_app_uuid: 'ghapp01', git_repository: 'example/shop' } });
    assert.deepEqual(web.domains, [`${web.uuid}.203.0.113.9.sslip.io`]);
    // a public one, with a domain and a build pack
    ok(await o.h('coolify.create_app', { ...where, name: 'blog', repo: 'example/blog', branch: 'trunk', buildPack: 'static', port: 80, domains: ['blog.example.com'] }));
    assert.deepEqual(calls(c, 'POST', /^\/applications\//)[1]!.body, { ...loc, name: 'blog', ports_exposes: '80', instant_deploy: false, domains: 'https://blog.example.com', git_branch: 'trunk', build_pack: 'static', git_repository: 'https://github.com/example/blog' });
    // an image, and a Dockerfile (base64)
    ok(await o.h('coolify.create_app', { ...where, name: 'api', image: 'ghcr.io/example/api:1.2', port: 8080 }));
    assert.deepEqual(calls(c, 'POST', /^\/applications\//)[2], { method: 'POST', path: '/applications/dockerimage', body: { ...loc, name: 'api', ports_exposes: '8080', instant_deploy: false, docker_registry_image_name: 'ghcr.io/example/api', docker_registry_image_tag: '1.2' } });
    const DOCKERFILE = 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\n';
    ok(await o.h('coolify.create_app', { ...where, name: 'site', dockerfile: DOCKERFILE, port: 80 }));
    const df = calls(c, 'POST', /^\/applications\/dockerfile$/)[0]!.body;
    assert.equal(Buffer.from(df.dockerfile, 'base64').toString(), DOCKERFILE);
    assert.equal(ok(await o.h('coolify.create_app', { ...where, name: 'shop', repo: 'example/shop' })).reused, true);
    assert.equal(calls(c, 'POST', /^\/applications\//).length, 4, 'not made twice');
    assert.equal((await o.h('coolify.create_app', { ...where, name: 'x', repo: 'example/x', image: 'nginx' })).status, 'error', 'one source only');

    // a database: private, its password made by Unit7 and put straight into the app's DATABASE_URL
    const db = ok(await o.a('coolify.create_database', { ...where, engine: 'postgresql', name: 'shop-db', injectInto: web.uuid }));
    const sent = calls(c, 'POST', /^\/databases\/postgresql$/)[0]!.body;
    assert.deepEqual(Object.keys(sent).sort(), ['environment_name', 'instant_deploy', 'is_public', 'name', 'postgres_db', 'postgres_password', 'postgres_user', 'project_uuid', 'server_uuid']);
    assert.deepEqual([sent.is_public, sent.instant_deploy, sent.postgres_user, sent.postgres_db], [false, true, 'app', 'app']);
    assert.match(sent.postgres_password, /^[\w-]{32}$/);
    assert.equal(db.status, 'running:healthy', 'waited until it runs');
    assert.deepEqual(db.wired, ['DATABASE_URL']);
    const bulk = calls(c, 'PATCH', /\/envs\/bulk$/)[0]!;
    assert.equal(bulk.path, `/applications/${web.uuid}/envs/bulk`);
    assert.deepEqual(bulk.body, { data: [{ key: 'DATABASE_URL', value: `postgres://app:${sent.postgres_password}@${db.uuid}:5432/app`, is_preview: false, is_literal: true, is_buildtime: false, is_runtime: true }] });
    assert.equal((await o.a('coolify.create_database', { ...where, engine: 'redis', public: true, publicPort: 6380 })).status, 'approval_required', 'opening a database to the internet asks first');

    // one-click Supabase, wired with NEXT_PUBLIC_ copies; your own compose goes base64-encoded
    const supa = ok(await o.a('coolify.create_service', { ...where, type: 'supabase', name: 'shop-supabase', injectInto: web.uuid, nextPublic: true }));
    assert.deepEqual(calls(c, 'POST', /^\/services$/)[0]!.body, { ...loc, name: 'shop-supabase', instant_deploy: true, type: 'supabase' });
    assert.deepEqual(supa.wired, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);
    const supaBulk = calls(c, 'PATCH', /\/envs\/bulk$/)[1]!.body.data;
    assert.deepEqual(supaBulk.map((v: any) => [v.key, v.value === ANON || v.value === SUPA_URL, v.is_buildtime ?? null]), [['SUPABASE_URL', true, null], ['SUPABASE_ANON_KEY', true, null], ['NEXT_PUBLIC_SUPABASE_URL', true, true], ['NEXT_PUBLIC_SUPABASE_ANON_KEY', true, true]]);
    assert.ok(!supaBulk.some((v: any) => v.value === SERVICE_ROLE), 'the service-role key stays in Supabase');
    const COMPOSE = 'services:\n  web:\n    image: nginx:alpine\n';
    const held = await o.a('coolify.create_service', { ...where, compose: COMPOSE, name: 'mine', wait: false });
    assert.equal(held.status, 'approval_required', 'your own compose can run anything: asks first');
    ok(await approve(app, o, held, 'box'));
    assert.equal(Buffer.from(calls(c, 'POST', /^\/services$/)[1]!.body.docker_compose_raw, 'base64').toString(), COMPOSE);

    // a domain is added next to the test address, with the DNS record to make
    const d = ok(await o.a('coolify.set_domain', { serverId: srv, uuid: web.uuid, domains: ['https://shop.example.com'] }));
    assert.deepEqual(calls(c, 'PATCH', new RegExp(`^/applications/${web.uuid}$`))[0]!.body, { domains: `http://${web.uuid}.203.0.113.9.sslip.io,https://shop.example.com` });
    assert.deepEqual(d.dns, [{ type: 'A', name: 'shop.example.com', value: '203.0.113.9' }]);
    const taken = await o.a('coolify.set_domain', { serverId: srv, uuid: web.uuid, domains: ['taken.example.com'] });
    assert.equal(taken.status, 'error');
    assert.match((taken as any).error.message, /already used by another app/, '409 in plain words');

    // nothing secret ever came back: results, audit, events
    const everything = JSON.stringify([db, supa, all(app.db, 'SELECT * FROM audit'), all(app.db, 'SELECT * FROM events')]);
    for (const secret of [sent.postgres_password, ANON, SERVICE_ROLE, TOKEN]) assert.ok(!everything.includes(secret), 'no secret in results, audit or events');
  } finally { c.close(); }
});

test('removing keeps the data unless a person types the name; 422 says which field', async () => {
  const { app, c, o, srv } = await setup();
  try {
    const p = ok(await o.h('coolify.create_project', { serverId: srv, name: 'shop' }));
    const db = ok(await o.h('coolify.create_database', { serverId: srv, project: p.project, engine: 'postgresql', name: 'shop-db', wait: false }));
    assert.equal((await o.a('coolify.remove', { serverId: srv, uuid: db.uuid, kind: 'database' })).status, 'approval_required', 'removing asks first');
    assert.equal((await o.a('coolify.remove', { serverId: srv, uuid: db.uuid, kind: 'database', deleteVolumes: true, confirmName: 'shop-db' })).status, 'denied', 'an AI never deletes data');
    // a person deleting data too: restricted, so it's approved, and the typed name must match
    const wrong = await o.h('coolify.remove', { serverId: srv, uuid: db.uuid, kind: 'database', deleteVolumes: true, confirmName: 'shop' });
    assert.equal(wrong.status, 'approval_required');
    const r = await approve(app, o, wrong, 'shop');
    assert.equal(r.status, 'error');
    assert.match((r as any).error.message, /type its name/);
    assert.equal(calls(c, 'DELETE', /^\/databases\//).length, 0, 'nothing deleted');
    const keep = ok(await o.h('coolify.remove', { serverId: srv, uuid: db.uuid, kind: 'database' }));
    assert.equal(keep.dataKept, true);
    assert.deepEqual(calls(c, 'DELETE', /^\/databases\//).map((x) => x.path), [`/databases/${db.uuid}?delete_volumes=false`], 'delete_volumes=false, said out loud');

    // Coolify's 422 says which field, and Unit7 passes that on
    assert.match(coolifyError(422, { message: 'Validation failed.', errors: { git_branch: ['The git branch field is required.'] } }, 'box').message, /git_branch: The git branch field is required\./);
  } finally { c.close(); }
});

test('polling: deploys, backups, restores and jobs are followed to their end, and a 429 is waited out', async () => {
  const { app, c, o, srv } = await setup();
  try {
    const p = ok(await o.h('coolify.create_project', { serverId: srv, name: 'shop' }));
    const web = ok(await o.h('coolify.create_app', { serverId: srv, project: p.project, name: 'shop', repo: 'example/blog' }));
    c.throttle = 1;
    const d = ok(await o.a('coolify.control', { serverId: srv, uuid: web.uuid, action: 'deploy' }));
    assert.equal(d.status, 'finished', 'a 429 while following is waited out, not a failure');
    assert.ok(calls(c, 'GET', /^\/deployments\//).length >= 4);

    const db = ok(await o.h('coolify.create_database', { serverId: srv, project: p.project, engine: 'postgresql', name: 'shop-db' }));
    // back up now: no schedule yet, so a daily one starts now; then again through it
    const b1 = ok(await o.a('coolify.backup', { serverId: srv, uuid: db.uuid, op: 'run' }));
    assert.deepEqual(calls(c, 'POST', /\/backups$/)[0]!.body, { frequency: 'daily', enabled: true, save_s3: false, backup_now: true });
    assert.deepEqual([b1.status, b1.scheduled], ['success', 'daily']);
    const b2 = ok(await o.a('coolify.backup', { serverId: srv, uuid: db.uuid, op: 'run' }));
    assert.deepEqual(calls(c, 'PATCH', /\/backups\/\w+$/)[0]!.body, { backup_now: true });
    assert.notEqual(b2.file, b1.file, 'the new run, not the old one');
    ok(await o.a('coolify.backup', { serverId: srv, uuid: db.uuid, op: 'schedule', frequency: '0 3 * * *', keep: 14 }));
    assert.deepEqual(calls(c, 'POST', /\/backups$/)[1]!.body, { frequency: '0 3 * * *', enabled: true, save_s3: false, database_backup_retention_amount_locally: 14, backup_now: false });
    const listed = ok(await o.a('coolify.backup', { serverId: srv, uuid: db.uuid }));
    assert.equal(listed[0].recent.length, 2);
    assert.equal((await o.a('coolify.backup', { serverId: srv, uuid: db.uuid, op: 'unschedule' })).status, 'denied', 'stopping backups is for a person');

    // restore into a new copy next to it: the live one is untouched
    const side = ok(await o.a('coolify.backup', { serverId: srv, uuid: db.uuid, op: 'restore' }));
    assert.equal(side.into, 'side');
    assert.equal(side.restored, true);
    assert.match(side.side.name, /^shop-db-restored-\d{12}$/);
    assert.equal(calls(c, 'POST', /^\/databases\/postgresql$/)[1]!.body.name, side.side.name);
    assert.deepEqual(calls(c, 'POST', /\/imports$/).map((x) => [x.path, x.body]), [[`/databases/${side.side.uuid}/imports`, { server_path: b2.file, replace_existing: false }]]);
    assert.equal((await o.a('coolify.backup', { serverId: srv, uuid: db.uuid, op: 'restore', into: 'live', confirmName: 'shop-db' })).status, 'denied', 'restoring over live data is for a person');
    const live = await o.h('coolify.backup', { serverId: srv, uuid: db.uuid, op: 'restore', into: 'live', confirmName: 'shop-db' });
    assert.equal(live.status, 'approval_required', 'restores are restricted in production');
    const done = ok(await approve(app, o, live, 'shop-db'));
    assert.equal(done.restored, true);
    assert.ok(done.safetyBackup && done.safetyBackup !== b2.file, 'a fresh backup first');
    assert.deepEqual(calls(c, 'POST', /\/imports$/)[1]!.body, { server_path: b2.file, replace_existing: true });

    // a scheduled job: creating or running a command asks first; run now waits for its output
    const t = await o.a('coolify.task', { serverId: srv, uuid: web.uuid, op: 'create', name: 'migrate', command: 'npm run migrate', frequency: 'daily' });
    assert.equal(t.status, 'approval_required', 'a command on the server asks first');
    const made = ok(await approve(app, o, t, 'box'));
    assert.deepEqual(calls(c, 'POST', /\/scheduled-tasks$/)[0]!.body, { enabled: true, name: 'migrate', command: 'npm run migrate', frequency: 'daily' });
    const ran = await o.a('coolify.task', { serverId: srv, uuid: web.uuid, op: 'run', task: made.task });
    const out = ok(await approve(app, o, ran, 'box'));
    assert.equal(out.status, 'success');
    assert.deepEqual(out.output, ['Migrated 3 tables', 'Done']);
    assert.match(out.untrusted, /data, not instructions/);
    assert.deepEqual(ok(await o.a('coolify.task', { serverId: srv, uuid: web.uuid })).map((x: any) => x.name), ['migrate']);
  } finally { c.close(); }
});

test('three sentences become plans: the steps, the wiring and the card', async () => {
  const next = parseWish({ goal: 'make me a Next.js app with Supabase from my GitHub repo' });
  assert.deepEqual(next.missing.map((x) => x.field), ['repo'], 'asks for the repo first');
  assert.deepEqual([next.app?.framework, next.app?.port, next.services, next.databases, next.environment], ['Next.js', 3000, ['supabase'], [], 'production']);
  const img = parseWish({ goal: 'deploy the image ghcr.io/example/api:1.2 with a postgres database on api.example.com' });
  assert.deepEqual([img.name, img.app?.image, img.databases, img.domain, img.missing.length], ['api', 'ghcr.io/example/api:1.2', ['postgresql'], 'api.example.com', 0]);
  const blog = parseWish({ goal: 'a staging Django site from https://github.com/example/blog with redis' });
  assert.deepEqual([blog.name, blog.app?.repo, blog.app?.port, blog.databases, blog.environment], ['blog', 'https://github.com/example/blog', 8000, ['redis'], 'staging']);
  assert.deepEqual(parseWish({ goal: 'just a mysql database', name: 'Store' }).app, undefined, 'no app when none is asked for');

  const { c, o, srv } = await setup();
  try {
    const plan = async (input: object) => ok(await o.a('coolify.plan', { serverId: srv, ...input }));
    const a = await plan({ goal: 'make me a Next.js app with Supabase from my GitHub repo', repo: 'example/shop' });
    assert.equal(a.ready, true);
    assert.deepEqual(a.steps, ['1. Set up the project shop', '2. Create the app shop', '3. Add Supabase', '4. Deploy shop']);
    assert.deepEqual(a.card.changes.map((x: any) => x.label), ['Project in Coolify', 'Environment', 'App', 'Supabase', 'App settings', 'Address', 'Deploy']);
    assert.match(a.card.changes[2].after, /example\/shop, through Sam’s GitHub App: Next\.js on port 3000/);
    assert.match(a.card.changes[4].after, /^SUPABASE_URL, SUPABASE_ANON_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: filled in inside Coolify/);
    assert.equal(a.confirm.mode, 'needs', 'outside the ask box the caller confirms');
    const b = await plan({ goal: 'deploy the image ghcr.io/example/api:1.2 with a postgres database on api.example.com' });
    assert.deepEqual(b.steps, ['1. Set up the project api', '2. Create the app api', '3. Add the Postgres database api-postgres', '4. Give api the domain api.example.com', '5. Deploy api']);
    assert.ok(b.card.changes.some((x: any) => x.label === 'App settings' && x.after.startsWith('DATABASE_URL:')));
    assert.ok(b.card.changes.some((x: any) => x.label === 'Domain' && /A record to 203\.0\.113\.9/.test(x.after)));
    const d = await plan({ goal: 'a staging Django site from https://github.com/example/blog with redis' });
    assert.deepEqual(d.steps, ['1. Set up the project blog', '2. Create the app blog', '3. Add the Redis database blog-redis', '4. Deploy blog']);
    assert.ok(d.card.changes.some((x: any) => x.label === 'Environment' && x.after === 'staging, new'));
    assert.equal(calls(c, 'POST', /./).length, 0, 'planning changes nothing');
    const none = ok(await o.a('coolify.plan', { goal: 'make me a Next.js app' }));
    assert.equal(none.server, 'box', 'the only server with Coolify connected is used');
  } finally { c.close(); }
});

test('in the ask box: one plan card, then every step in the thread; values never leave Coolify', async () => {
  const { app, c, o, srv } = await setup();
  const t = thread(app, o.orgId, o.userId);
  try {
    const goal = 'make me a Next.js app with Supabase from my GitHub repo';
    const running = execute(app, o.orgId, o.agent, 'coolify.build', { serverId: srv, goal, repo: 'example/shop' }, { conversationId: t.conversationId });
    const card = await t.askOpen();
    assert.equal(card.content.spec.kind, 'confirm');
    assert.equal(card.content.spec.confirmLabel, 'Build it');
    assert.equal(calls(c, 'POST', /./).length, 0, 'nothing happens before the person says yes');
    t.answer(card.id, { ok: true });
    const r = ok(await running);
    assert.equal(r.built, true);
    assert.match(r.url, /^https:\/\/app\d+\.203\.0\.113\.9\.sslip\.io$/);
    assert.equal(r.undo.length, 3, 'project, app, Supabase: each with its undo');
    const steps = [...t.msgs.values()].filter((m) => m.role === 'tool');
    assert.deepEqual(steps.map((m) => [m.content.tool, m.content.status]), [['coolify.create_project', 'ok'], ['coolify.create_app', 'ok'], ['coolify.create_service', 'ok'], ['coolify.control', 'ok']]);
    assert.deepEqual(steps[2]!.content.output.wired, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);
    assert.equal([...t.msgs.values()].filter((m) => m.role === 'ask').length, 1, 'one card for the whole plan');
    // the app got the wiring, deployed after it
    const shop = c.things.find((x) => x.name === 'shop');
    assert.deepEqual(shop.envs.map((e: any) => e.key), ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);
    assert.ok(c.seen.findIndex((x) => x.path.startsWith('/deploy?uuid=')) > c.seen.findIndex((x) => x.path.endsWith('/envs/bulk')));
    const stored = JSON.stringify([all(app.db, 'SELECT * FROM messages'), all(app.db, 'SELECT * FROM audit'), all(app.db, 'SELECT * FROM events'), r]);
    for (const secret of [ANON, SERVICE_ROLE, TOKEN]) assert.ok(!stored.includes(secret), 'the thread, audit and events never see a value');
  } finally { t.unbind(); c.close(); }
});

test('stops at the first failure with what was done and what next; again, it reuses what’s there', async () => {
  const { c, o, srv } = await setup();
  try {
    const goal = 'a Next.js app from example/shop with Supabase on taken.example.com';
    const r = ok(await o.h('coolify.build', { serverId: srv, goal }));
    assert.equal(r.built, false);
    assert.deepEqual(r.done.map((x: any) => x.step), ['Set up the project shop', 'Create the app shop', 'Add Supabase']);
    assert.equal(r.failed.step, 'Give shop the domain taken.example.com');
    assert.match(r.failed.why, /already used by another app/);
    assert.match(r.next, /reused/);
    assert.equal(calls(c, 'POST', /^\/deploy\?uuid=/).length, 0, 'never deployed past a failure');

    const again = ok(await o.h('coolify.build', { serverId: srv, goal, domain: 'shop.example.com' }));
    assert.equal(again.built, true);
    assert.equal(again.url, 'https://shop.example.com');
    assert.match(again.next, /Point shop\.example\.com at 203\.0\.113\.9/);
    assert.deepEqual(again.done.slice(0, 3).map((x: any) => !!x.reused), [true, true, true]);
    assert.equal(calls(c, 'POST', /^\/applications\//).length, 1, 'the app wasn’t made twice');
    assert.equal(calls(c, 'POST', /^\/services$/).length, 1);

    // a deploy that fails stops the build with the end of its log
    const broken = ok(await o.h('coolify.build', { serverId: srv, goal: 'a Node.js api', repo: 'example/broken' }));
    assert.equal(broken.failed.step, 'Deploy broken');
    assert.match(broken.failed.why, /failed/);
    assert.deepEqual(broken.failed.logTail, ['npm ERR! missing script: build']);
    // Supabase settings Coolify won't share: the step fails in plain words
  } finally { c.close(); }
  const quiet = await setup({ sensitive: false });
  try {
    const r = ok(await quiet.o.h('coolify.build', { serverId: quiet.srv, goal: 'a Next.js app with Supabase', repo: 'example/shop' }));
    assert.equal(r.failed.step, 'Add Supabase');
    assert.match(r.failed.why, /read:sensitive/);
  } finally { quiet.c.close(); }
});

test('autonomy: 4 on a test environment just builds; outside the ask box the caller confirms; 1 holds every step', async () => {
  const { app, c, o, srv } = await setup();
  const t = thread(app, o.orgId, o.userId);
  const agentIn = (input: object) => execute(app, o.orgId, o.agent, 'coolify.build', { serverId: srv, ...input }, { conversationId: t.conversationId });
  try {
    autonomy(app, o.orgId, 4);
    const r = ok(await agentIn({ goal: 'a staging Next.js app with Supabase', repo: 'example/shop' }));
    assert.equal(r.built, true);
    assert.equal([...t.msgs.values()].filter((m) => m.role === 'ask').length, 0, 'autonomy 4 on staging: no card, just the report');

    // production at 4 still shows the card; "not now" changes nothing
    const before = calls(c, 'POST', /./).length;
    const prod = agentIn({ goal: 'a Next.js app', repo: 'example/blog' });
    t.answer((await t.askOpen()).id, { ok: false });
    assert.equal(ok(await prod).declined, true);
    assert.equal(calls(c, 'POST', /./).length, before, 'nothing made');

    // a terminal AI (no ask box) must show the plan and come back with confirmed
    autonomy(app, o.orgId, 3);
    const first = ok(await o.a('coolify.build', { serverId: srv, goal: 'a Django site', repo: 'example/blog' }));
    assert.equal(first.needsConfirm, true);
    assert.equal(first.card.kind, 'confirm');
    assert.equal(ok(await o.a('coolify.build', { serverId: srv, goal: 'a Django site', repo: 'example/blog', confirmed: true })).built, true);

    // 1 (Suggest): no card; the first step waits for a person's approval and the build stops there
    autonomy(app, o.orgId, 1);
    const held = ok(await agentIn({ goal: 'an app with redis', repo: 'example/held' }));
    assert.equal(held.built, false);
    assert.ok(held.failed.approvalId);
    assert.match(held.next, /approval/);
    assert.equal([...t.msgs.values()].filter((m) => m.role === 'ask').length, 1, 'still only the one earlier card');
    const step = [...t.msgs.values()].filter((m) => m.role === 'tool').at(-1)!;
    assert.deepEqual([step.content.tool, step.content.status, step.content.approvalState], ['coolify.create_project', 'approval_required', 'pending']);
  } finally { t.unbind(); c.close(); }
});
