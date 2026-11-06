// The wider add-on catalogue (src/tools/addons.ts): every tool's first run, the memory check, any other Coolify template,
// the words in a sentence (src/tools/coolify-build.ts), and what happens with no Coolify. The server is a stand-in (ssh exec
// replaced); Coolify is a stand-in reached with real curl; each tool's first setup runs in a real shell against fake docker and curl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { ssh, type ExecOptions, type ExecResult } from '../src/connectors/ssh.ts';
import { id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { CURL, coolifyTiming } from '../src/connectors/coolify.ts';
import { XRAY_PROBE } from '../src/discovery/xray.ts';
import { decideApproval, type ToolResult } from '../src/tools/runtime.ts';
import { ADDONS, addonDns, claimResult, claimScript, type ClaimKind } from '../src/tools/addons.ts';
import { parseWish } from '../src/tools/coolify-build.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';

const TOKEN = '3|unit7testtokenAbC123xyz';
const GRAFANA_PW = 'grafanaAdminPassword0123';
const VW_TOKEN = 'vaultwardenAdminToken0123456789';
const CLAIM_PW = 'U7aclaimedonserver0123456789abcdef012345';
coolifyTiming.pollMs = 5;
const res = (stdout = '', code = 0): ExecResult => ({ code, stdout, stderr: code ? 'it failed' : '', truncated: false });
addonDns.look = () => ({ soa: async () => { throw new Error('none'); }, ns: async () => [], a: async () => [], cname: async () => [] });

// Coolify's published keys that these tests add; anything else is a template it doesn't have
const TEMPLATES = ['ghost', 'grafana', 'portainer', 'nextcloud', 'typesense', 'vaultwarden', 'appwrite', 'garage', 'seaweedfs', 'plane', 'strapi', 'nocodb', 'metabase', 'open-webui', 'flowise', 'pocketbase', 'forgejo', 'directus'];
const PARTS: Record<string, string[]> = { seaweedfs: ['seaweedfs-master', 'seaweedfs-admin'], appwrite: ['appwrite-console', 'appwrite', 'appwrite-realtime'], plane: ['web', 'api'] };
const SERVICE_ENVS: Record<string, { key: string; value: string }[]> = {
  grafana: [{ key: 'SERVICE_PASSWORD_GRAFANA', value: GRAFANA_PW }],
  vaultwarden: [{ key: 'SERVICE_PASSWORD_64_ADMIN', value: VW_TOKEN }],
  seaweedfs: [{ key: 'SERVICE_USER_S3', value: 's3accesskey' }, { key: 'SERVICE_PASSWORD_S3', value: 's3secretkey' }],
};
function fakeCoolify() {
  const seen: { method: string; path: string; body: any }[] = [];
  const projects: { uuid: string; name: string; environments: { name: string; uuid: string }[] }[] = [];
  const things: any[] = [];
  let n = 0;
  const uid = (p: string) => `${p}${String(++n).padStart(4, '0')}`;
  const server = createServer(async (req, rsp) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, 'http://x'), path = url.pathname.replace(/^\/api\/v1/, ''), body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: req.method!, path: path + url.search, body });
    const send = (status: number, b: unknown) => { rsp.writeHead(status, { 'content-type': typeof b === 'string' ? 'text/plain' : 'application/json' }); rsp.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Unauthenticated.' });
    const r = `${req.method} ${path}`, find = (u: string) => things.find((t) => t.uuid === u);
    let m: RegExpExecArray | null;
    if (r === 'GET /version') return send(200, '4.4.0');
    if (r === 'GET /team') return send(200, { id: 0, name: 'Sam’s team' });
    if (r === 'GET /servers') return send(200, [{ uuid: 'srvuuid01', name: 'localhost', ip: 'host.docker.internal' }]);
    if (r === 'GET /servers/srvuuid01/sentinel') return send(200, { sentinel_token: 'sentinel-token-value-1' });
    if (r === 'POST /deploy') return send(400, { message: 'You must provide uuid or tag.' });
    if (r === 'GET /projects') return send(200, projects.map((p) => ({ uuid: p.uuid, name: p.name })));
    if (r === 'POST /projects') {
      if (!body?.name) return send(422, { message: 'Validation failed.', errors: { name: ['The name field is required.'] } }); // how connecting tests the token
      const p = { uuid: uid('proj'), name: body.name, environments: [{ name: 'production', uuid: uid('env') }] }; projects.push(p); return send(201, { uuid: p.uuid });
    }
    if ((m = /^GET \/projects\/(\w+)$/.exec(r))) { const p = projects.find((x) => x.uuid === m![1]); return p ? send(200, p) : send(404, { message: 'Project not found.' }); }
    if ((m = /^GET \/projects\/(\w+)\/([\w-]+)$/.exec(r))) return send(200, { applications: [], services: things.filter((t) => t.project_uuid === m![1]), postgresqls: [] });
    if ((m = /^PATCH \/services\/(\w+)\/envs\/bulk$/.exec(r))) { const t = find(m[1]!); for (const v of body.data) { t.envs = t.envs.filter((e: any) => e.key !== v.key); t.envs.push(v); } return send(201, { message: 'Environment variables updated.' }); }
    if ((m = /^GET \/services\/(\w+)\/envs$/.exec(r))) return send(200, find(m[1]!).envs.map((e: any, i: number) => ({ uuid: `e${i}`, key: e.key, value: e.value, is_preview: false })));
    if (r === 'POST /services') {
      if (!TEMPLATES.includes(body.type)) return send(404, { message: 'Service not found.', valid_service_types: TEMPLATES });
      const t = { ...body, kind: 'service', uuid: uid('svc'), status: 'exited', started: false, envs: (SERVICE_ENVS[body.type] ?? []).map((e) => ({ ...e })) } as any;
      const given = new Map<string, string>((body.urls ?? []).map((u: any) => [u.name, u.url]));
      t.applications = (PARTS[body.type] ?? [body.type]).map((p) => ({ name: p, fqdn: given.get(p) ?? (body.type === 'garage' ? null : `http://${p}-${t.uuid}.203.0.113.9.sslip.io`) }));
      things.push(t);
      return send(201, { uuid: t.uuid, domains: t.applications.map((a: any) => a.fqdn).filter(Boolean) });
    }
    if ((m = /^POST \/services\/(\w+)\/(start|stop)$/.exec(r))) { const t = find(m[1]!); t.started = m[2] === 'start'; if (t.started) t.status = 'running:healthy'; return send(200, { message: `Service ${m[2]} request queued.` }); }
    if ((m = /^GET \/services\/(\w+)$/.exec(r))) { const t = find(m[1]!); return t ? send(200, t) : send(404, { message: 'Not found.' }); }
    if ((m = /^DELETE \/services\/(\w+)$/.exec(r))) { const t = find(m[1]!); if (!t) return send(404, { message: 'Not found.' }); things.splice(things.indexOf(t), 1); return send(200, { message: 'Deletion request queued.' }); }
    send(404, { message: 'Not found.' });
  });
  const state = { seen, things, projects };
  return new Promise<typeof state & { port: number; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r(Object.assign(state, { port: (server.address() as { port: number }).port, close: () => { server.closeAllConnections(); server.close(); } }))));
}

type Seen = { command: string; stdin: string };
function fakeHost(app: App, o: { coolifyPort?: number; answer?: (command: string, stdin: string) => ExecResult | undefined } = {}) {
  const seen: Seen[] = [];
  ssh(app).exec = async (_s, command, e: ExecOptions = {}) => {
    const stdin = String(e.stdin ?? '');
    if (stdin === XRAY_PROBE) return res(COOLIFY_HOST);
    if (command === CURL && o.coolifyPort) return new Promise((resolve) => {
      const p = spawn('curl', ['-K', '-']);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
      p.stdin.end(stdin.replace('http://127.0.0.1:8000/', `http://127.0.0.1:${o.coolifyPort}/`));
    });
    seen.push({ command, stdin });
    const a = o.answer?.(command, stdin);
    if (a) return a;
    if (command.includes('@@unit7:secret')) return res(`\n@@unit7:secret\n${CLAIM_PW}\n\n@@unit7:reply\nunit7-http=201\n`);
    return res();
  };
  return seen;
}

async function coolifyBox(mem = 8192, answer?: (command: string, stdin: string) => ExecResult | undefined) {
  const app = testApp();
  const c = await fakeCoolify();
  const o = await testOrg(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`,
    srv, o.orgId, JSON.stringify({ sudo: 'root', publicIp: '203.0.113.9', mem_available: mem * 1024 * 1024, web: 'coolify-proxy|traefik:v3.1' }));
  const seen = fakeHost(app, { coolifyPort: c.port, answer });
  ok(await o.h('coolify.connect', { serverId: srv, token: TOKEN }));
  c.seen.length = 0;
  return { app, c, o, srv, seen };
}
const approve = async (app: App, o: { orgId: string; human: any }, r: unknown) => decideApproval(app, o.orgId, o.human, (r as { approvalId: string }).approvalId, true) as Promise<ToolResult>;
const order = (c: { seen: { method: string; path: string }[] }) => c.seen.map((x) => `${x.method} ${x.path}`);
const env = (t: any, k: string) => t.envs.find((e: any) => e.key === k)?.value;

// --- the list ---------------------------------------------------------------------------------------------------------
test('the catalogue: every installable tool says what it’s for, what it needs and how its first run is safe', () => {
  const ids = ADDONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const want of ['ghost', 'grafana', 'metabase', 'directus', 'strapi', 'nocodb', 'forgejo', 'vaultwarden', 'nextcloud', 'portainer', 'typesense', 'open-webui', 'flowise', 'pocketbase', 'appwrite', 'garage']) assert.ok(ids.includes(want), want);
  for (const a of ADDONS) {
    assert.ok(a.line.length > 10 && !a.line.includes('—'), `${a.id}: a plain line`);
    assert.ok(a.memoryMb > 0, `${a.id}: its memory`);
    if (a.off) { if (a.instead) assert.ok(ids.includes(a.instead), `${a.id}: ${a.instead}`); continue; }
    assert.ok(a.template || a.unit7, `${a.id}: how it’s added`);
    assert.ok(a.template ? a.part : true, `${a.id}: which part gets the address`);
    // a login Unit7 made or claimed, one Coolify generated, an extra password in front, or nothing that signs in
    assert.ok(a.claim || a.creds?.length, `${a.id}: nobody can claim it`);
    if (a.claim?.gate) assert.ok(/extra password/.test(a.firstVisit ?? '') || a.claim.api, `${a.id}: says what the extra password is`);
  }
  // what Coolify has switched off is listed, off, with what does the same job
  for (const [off, instead] of [['dify', 'flowise'], ['minio', 'seaweedfs'], ['plausible', 'umami']] as const) {
    const a = ADDONS.find((x) => x.id === off)!;
    assert.ok(a.off); assert.equal(a.instead, instead); assert.equal(a.template, undefined);
  }
});

// --- must be claimed ------------------------------------------------------------------------------------------------------
test('a tool whose first visitor becomes admin: Ghost is made, started, claimed from inside the server, and only then gets its domain', async () => {
  const { app, c, o, srv, seen } = await coolifyBox();
  const real = addonDns.write;
  const wrote: { name: string; claimed: boolean }[] = [];
  addonDns.write = async (_ctx, hostname, records) => { wrote.push({ name: hostname, claimed: seen.some((x) => x.command.includes('@@unit7:secret')) }); return { written: true, provider: 'cloudflare', zone: 'example.com', records }; };
  try {
    const r = ok(await o.h('addon.install', { serverId: srv, addon: 'ghost', domain: 'blog.example.com' }));
    assert.deepEqual(c.seen.find((x) => x.method === 'POST' && x.path === '/services')!.body.urls, [{ name: 'ghost', url: 'https://blog.example.com' }]);
    assert.equal(c.seen.find((x) => x.method === 'POST' && x.path === '/services')!.body.instant_deploy, false, 'made but not started');
    const svc = c.things.find((x) => x.name === 'ghost');
    const claim = seen.find((x) => x.command.includes('@@unit7:secret'))!;
    assert.ok(claim.command.includes(`'ghost-${svc.uuid}'`) && claim.command.includes(`'2368'`));
    assert.ok(!claim.command.includes(CLAIM_PW), 'the password never on a command line');
    assert.deepEqual(wrote, [{ name: 'blog.example.com', claimed: true }], 'its DNS only after the claim');
    assert.deepEqual(r.credentials, [{ label: `Admin password (${(await emailOf(app, o.userId))})`, saved: true }]);
    assert.match(r.firstVisit, /set its admin login before it went live/);
    assert.match(r.wire.note, /\/ghost/);
    assert.ok(!JSON.stringify(r).includes(CLAIM_PW), 'the password isn’t in the result');
    assert.equal(ok(await o.h('addon.credentials', { serverId: srv, addon: 'ghost' })).items[0].value, CLAIM_PW);
  } finally { addonDns.write = real; c.close(); }
});
async function emailOf(app: App, userId: string) { return (app.db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string }).email; }

test('someone reaches the first sign-in before Unit7: it’s stopped, never handed over, and its domain isn’t written', async () => {
  let reply = 'unit7-taken';
  const { c, o, srv } = await coolifyBox(8192, (command) => (command.includes('@@unit7:secret') ? res(`\n@@unit7:secret\n${CLAIM_PW}\n\n@@unit7:reply\n${reply}\n`) : undefined));
  const real = addonDns.write;
  let wrote = 0;
  addonDns.write = async (_ctx, _h, records) => { wrote++; return { written: true, provider: 'cloudflare', zone: 'example.com', records }; };
  try {
    const r = await o.h('addon.install', { serverId: srv, addon: 'metabase', domain: 'reports.example.com' }) as any;
    assert.equal(r.error.code, 'claimed_by_someone');
    const svc = c.things.find((x) => x.name === 'metabase');
    assert.equal(svc.started, false, 'stopped');
    assert.equal(wrote, 0);
    // the tool said no for some other reason: stopped too, rather than left open
    reply = 'unit7-http=500';
    assert.equal((await o.h('addon.install', { serverId: srv, addon: 'strapi' }) as any).error.code, 'claim_failed');
    assert.equal(c.things.find((x) => x.name === 'strapi').started, false);
  } finally { addonDns.write = real; c.close(); }
});

test('Portainer holds the Docker socket: the extra password stands in front until the claim worked, and the risk is said first', async () => {
  const { c, o, srv, seen } = await coolifyBox();
  const held = await o.a('addon.install', { serverId: srv, addon: 'portainer' });
  assert.equal(held.status, 'approval_required');
  assert.match((held as any).why, /every container on this server/);
  try {
    const r = ok(await o.h('addon.install', { serverId: srv, addon: 'portainer' }));
    const svc = c.things.find((x) => x.name === 'portainer');
    const gate = seen.findIndex((x) => x.stdin.includes('basicAuth') && x.stdin.includes(`portainer-${svc.uuid}:9000`));
    const claim = seen.findIndex((x) => x.command.includes('@@unit7:secret'));
    const gone = seen.findIndex((x) => x.command.includes('rm -f'));
    assert.ok(gate >= 0 && gate < claim && claim < gone, `gate, claim, gate gone: ${gate} ${claim} ${gone}`);
    assert.equal(r.gated, undefined);
    assert.deepEqual(r.credentials, [{ label: 'Admin password (admin)', saved: true }], 'the extra password left the vault');
    assert.match(r.warning, /Coolify included/);
  } finally { c.close(); }
});

test('no supported claim: Nextcloud and Forgejo stay behind the extra password, flagged, until the person says they’re done', async () => {
  const { c, o, srv, seen } = await coolifyBox();
  try {
    for (const [addon, port, says] of [['nextcloud', 80, /create the admin account/], ['forgejo', 3000, /administrator account/]] as const) {
      const r = ok(await o.h('addon.install', { serverId: srv, addon }));
      const svc = c.things.find((x) => x.name === addon);
      assert.equal(r.gated, true, addon);
      assert.match(r.firstVisit, says);
      assert.match(r.firstVisit, /extra password/);
      const at = order(c);
      assert.ok(seen.some((x) => x.stdin.includes(`${addon}-${svc.uuid}:${port}`)), `${addon}: the route goes to its port`);
      assert.ok(at.indexOf(`POST /services/${svc.uuid}/start`) > 0);
      assert.equal(ok(await o.a('addon.catalog', { serverId: srv })).items.find((x: any) => x.id === addon).installed.gated, true);
      assert.equal((await o.a('addon.unlock', { serverId: srv, addon })).status, 'denied', 'only a person says it’s done');
      ok(await o.h('addon.unlock', { serverId: srv, addon }));
    }
    assert.equal(env(c.things.find((x) => x.name === 'forgejo'), 'FORGEJO__service__DISABLE_REGISTRATION'), 'true');
  } finally { c.close(); }
});

test('settings before the first start: Typesense’s key, Vaultwarden’s closed sign-ups, and each one’s rule about addresses', async () => {
  const { app, c, o, srv } = await coolifyBox();
  const real = addonDns.write;
  addonDns.write = async (_ctx, _h, records) => ({ written: true, provider: 'cloudflare', zone: 'example.com', records });
  try {
    const t = ok(await o.h('addon.install', { serverId: srv, addon: 'typesense' }));
    const ts = c.things.find((x) => x.name === 'typesense');
    const at = order(c);
    assert.ok(at.indexOf(`PATCH /services/${ts.uuid}/envs/bulk`) < at.indexOf(`POST /services/${ts.uuid}/start`), 'the key it can’t start without goes in first');
    const key = env(ts, 'TYPESENSE_API_KEY');
    assert.match(key, /^U7a[0-9a-f]{36}$/);
    assert.deepEqual(t.credentials, [{ label: 'API key', saved: true }]);
    const ref = t.wire.env.find((e: any) => e.key === 'TYPESENSE_API_KEY').value;
    assert.match(ref, /^credential:\/\/addon\//, 'wired by reference');
    assert.equal(app.vault.resolve(o.orgId, ref), key);
    assert.equal(t.wire.env.find((e: any) => e.key === 'TYPESENSE_HOST').value, t.url);
    assert.ok(!JSON.stringify(t).includes(key));

    assert.match((await o.h('addon.install', { serverId: srv, addon: 'vaultwarden' }) as any).error.message, /only works over HTTPS/);
    assert.ok(!c.things.some((x) => x.name === 'vaultwarden'), 'nothing made on a test address');
    const v = ok(await o.h('addon.install', { serverId: srv, addon: 'vaultwarden', domain: 'vault.example.com' }));
    const vw = c.things.find((x) => x.name === 'vaultwarden');
    assert.equal(env(vw, 'SIGNUP_ALLOWED'), 'false');
    const after = order(c);
    assert.ok(after.indexOf(`PATCH /services/${vw.uuid}/envs/bulk`) < after.indexOf(`POST /services/${vw.uuid}/start`), 'sign-ups closed before it ever answers');
    assert.deepEqual(v.credentials, [{ label: 'Admin token', saved: true }]);
    assert.match(v.firstVisit, /invite your own email/);
    assert.equal(ok(await o.h('addon.credentials', { serverId: srv, addon: 'vaultwarden' })).items[0].value, VW_TOKEN);

    // what Coolify generated: into the vault, shown to a person only, never to an AI
    const g = ok(await o.h('addon.install', { serverId: srv, addon: 'grafana' }));
    assert.deepEqual(g.credentials, [{ label: 'Admin password (user admin)', saved: true }]);
    assert.equal((await o.a('addon.credentials', { serverId: srv, addon: 'grafana' })).status, 'denied');

    // the S3 stores: where the app actually sends its uploads, and a port the template doesn't give
    const w = ok(await o.h('addon.install', { serverId: srv, addon: 'seaweedfs' }));
    const sw = c.things.find((x) => x.name === 'seaweedfs');
    assert.equal(w.wire.env.find((e: any) => e.key === 'S3_ENDPOINT').value, `http://seaweedfs-master-${sw.uuid}.203.0.113.9.sslip.io`);
    assert.match(w.url, /seaweedfs-admin/);
    assert.match((await o.h('addon.install', { serverId: srv, addon: 'garage' }) as any).error.message, /no test address/);
    const ga = ok(await o.h('addon.install', { serverId: srv, addon: 'garage', domain: 's3.example.com' }));
    assert.deepEqual(c.seen.filter((x) => x.method === 'POST' && x.path === '/services').at(-1)!.body.urls, [{ name: 'garage', url: 'https://s3.example.com:3900' }]);
    assert.equal(ga.url, 'https://s3.example.com');
  } finally { addonDns.write = real; c.close(); }
});

test('Appwrite: three parts share its address by path, its address is the console, and its first sign-up goes to its API part', async () => {
  const { c, o, srv, seen } = await coolifyBox();
  const real = addonDns.write;
  addonDns.write = async (_ctx, _h, records) => ({ written: true, provider: 'cloudflare', zone: 'example.com', records });
  try {
    const r = ok(await o.h('addon.install', { serverId: srv, addon: 'appwrite', domain: 'appwrite.example.com' }));
    assert.deepEqual(c.seen.find((x) => x.method === 'POST' && x.path === '/services')!.body.urls, [
      { name: 'appwrite-console', url: 'https://appwrite.example.com:3000' }, { name: 'appwrite', url: 'https://appwrite.example.com/v1' }, { name: 'appwrite-realtime', url: 'https://appwrite.example.com/v1/realtime' },
    ]);
    const svc = c.things.find((x) => x.name === 'appwrite');
    const claim = seen.find((x) => x.command.includes('@@unit7:secret'))!;
    assert.ok(claim.command.includes(`'appwrite-${svc.uuid}'`) && claim.command.includes(`'80'`));
    assert.equal(r.url, 'https://appwrite.example.com');
    assert.equal(r.wire.env.find((e: any) => e.key === 'APPWRITE_ENDPOINT').value, 'https://appwrite.example.com/v1');
  } finally { addonDns.write = real; c.close(); }
});

// --- memory ---------------------------------------------------------------------------------------------------------------
test('too little memory: asked of the server right now, refused with the numbers, nothing made', async () => {
  // Unit7's last reading says 8 GB, the server says 700 MB now
  let free = String(700 * 1024);
  const { c, o, srv, seen } = await coolifyBox(8192, (command) => (command.includes('MemAvailable') ? res(`${free}\n`) : undefined));
  try {
    const r = await o.h('addon.install', { serverId: srv, addon: 'ghost' }) as any;
    assert.equal(r.error.code, 'no_room');
    assert.match(r.error.message, /box has 700 MB of memory free\. Ghost needs about 1024 MB, and Unit7 keeps 256 MB free for the server itself, so it didn’t add Ghost\./);
    assert.match(r.error.message, /bigger server/);
    assert.equal(c.seen.filter((x) => x.method === 'POST').length, 0, 'nothing made, in Coolify or anywhere');
    assert.ok(seen.some((x) => x.command.includes('MemAvailable')), 'it asked the server');
    // just fits: what it needs plus what's kept for the server
    free = String((1024 + 256) * 1024);
    ok(await o.h('addon.install', { serverId: srv, addon: 'ghost' }));
    // a template Unit7 knows nothing about still can't take the last of the memory
    free = String(100 * 1024);
    const u = await o.h('addon.install', { serverId: srv, addon: 'plane' }) as any;
    assert.equal(u.error.code, 'no_room');
    assert.match(u.error.message, /box has 100 MB of memory free\. Unit7 keeps 256 MB free/);
  } finally { c.close(); }
});

test('too little memory: the server not answering falls back on the last reading, and no reading at all doesn’t block', async () => {
  const { app, c, o, srv } = await coolifyBox(1024, (command) => (command.includes('MemAvailable') ? res('', 255) : undefined));
  try {
    assert.equal((await o.h('addon.install', { serverId: srv, addon: 'appwrite' }) as any).error.code, 'no_room');
    const cat = ok(await o.a('addon.catalog', { serverId: srv }));
    assert.equal(cat.items.find((x: any) => x.id === 'appwrite').fits, false);
    run(app.db, `UPDATE servers SET facts = ? WHERE id = ?`, JSON.stringify({ sudo: 'root', publicIp: '203.0.113.9', web: 'coolify-proxy|traefik:v3.1' }), srv);
    ok(await o.h('addon.install', { serverId: srv, addon: 'typesense' }));
  } finally { c.close(); }
});

// --- any other template ------------------------------------------------------------------------------------------------
test('a Coolify template outside the catalogue: added with a plain warning, an AI asks first, and it can be seen and taken off', async () => {
  const { c, o, srv } = await coolifyBox();
  try {
    const held = await o.a('addon.install', { serverId: srv, addon: 'plane' });
    assert.equal(held.status, 'approval_required', 'an AI asks a person, at any autonomy');
    assert.match((held as any).why, /doesn’t know how plane handles its first run/);
    const r = ok(await o.h('addon.install', { serverId: srv, addon: 'plane' }));
    assert.equal(c.things.find((x) => x.type === 'plane').started, true);
    assert.match(r.warning, /whoever opens it first may become its admin/);
    assert.match(r.url, /^http:\/\/web-svc\d+\.203\.0\.113\.9\.sslip\.io$/, 'its free test address');
    assert.deepEqual(r.credentials, []);
    assert.match(r.credentialsNote, /in Coolify/);

    const it = ok(await o.a('addon.catalog', { serverId: srv })).items.find((x: any) => x.id === 'plane');
    assert.deepEqual([it.unknown, it.how, it.installed.url], [true, 'coolify', r.url]);
    assert.match(it.warn, /first run/);
    assert.equal(ok(await o.h('addon.install', { serverId: srv, addon: 'plane' })).already, true);

    // Unit7 doesn't know which part takes an address
    assert.match((await o.h('addon.install', { serverId: srv, addon: 'strapi-x', domain: 'x.example.com' }) as any).error.message, /which part/);

    ok(await o.h('addon.remove', { serverId: srv, addon: 'plane' }));
    assert.ok(!c.things.some((x) => x.type === 'plane'));
    assert.equal(ok(await o.a('addon.catalog', { serverId: srv })).items.find((x: any) => x.id === 'plane'), undefined);
  } finally { c.close(); }
});

test('a template Coolify doesn’t have, a name Unit7 won’t pass on, and what’s switched off: plain answers, nothing made', async () => {
  const { c, o, srv } = await coolifyBox();
  try {
    const r = await o.h('addon.install', { serverId: srv, addon: 'no-such-template' }) as any;
    assert.equal(r.error.code, 'no_template');
    assert.match(r.error.message, /no template called no-such-template, so nothing was added/);
    assert.equal(c.things.length, 0);
    assert.equal(ok(await o.a('addon.catalog', { serverId: srv })).items.find((x: any) => x.id === 'no-such-template'), undefined);
    assert.equal((await o.h('addon.install', { serverId: srv, addon: 'a;rm -rf' })).status, 'error');
    assert.match((await o.h('addon.install', { serverId: srv, addon: 'dify' }) as any).error.message, /switched off.*Flowise does the same job/);
    assert.match((await o.h('addon.install', { serverId: srv, addon: 'minio' }) as any).error.message, /SeaweedFS does the same job/);
    assert.equal(c.seen.filter((x) => x.method === 'POST' && x.path === '/services').length, 1, 'only the one Coolify turned down');
  } finally { c.close(); }
});

test('no Coolify on the server: only Umami and Unleash go on, and the others say what to do', async () => {
  const app = testApp();
  const o = await testOrg(app);
  fakeHost(app);
  const srv = id('srv');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ publicIp: '203.0.113.9', mem_available: 8 * 1024 ** 3 }));
  const cat = ok(await o.a('addon.catalog', { serverId: srv }));
  const can = cat.items.filter((x: any) => x.how === 'unit7').map((x: any) => x.id).sort();
  assert.deepEqual(can, ['umami', 'unleash']);
  for (const addon of ['ghost', 'plane']) {
    const m = (await o.h('addon.install', { serverId: srv, addon }) as any).error.message;
    assert.match(m, /through Coolify/);
    assert.match(m, /Connect Coolify on box/);
    assert.match(m, /install Coolify there first/);
    assert.match(m, /only add Umami and Unleash/);
  }
});

// --- words in a sentence --------------------------------------------------------------------------------------------------
test('words in a sentence: PocketBase and Appwrite go through the add-on flow, Plausible and MinIO get a plain answer', async () => {
  const { c, o, srv } = await coolifyBox();
  try {
    const plan = ok(await o.a('coolify.plan', { serverId: srv, goal: 'a Next.js app from repo acme/shop with PocketBase' }));
    assert.ok(plan.steps.includes('3. Add PocketBase'), plan.steps.join(' | '));
    assert.ok(!JSON.stringify(plan.card).includes('a one-click stack'));
    assert.deepEqual(parseWish({ goal: 'an app from repo acme/shop with appwrite' }).services, ['appwrite']);

    const m = parseWish({ goal: 'a Next.js app from repo acme/shop with MinIO storage' });
    assert.deepEqual(m.services, []);
    assert.equal(m.missing[0]!.field, 'service');
    assert.match(m.missing[0]!.ask, /switched off.*SeaweedFS does the same job/);
    // the answer comes back as a service, with the same sentence
    const again = parseWish({ goal: 'a Next.js app from repo acme/shop with MinIO storage', service: 'seaweedfs' });
    assert.deepEqual([again.services, again.missing], [['seaweedfs'], []]);
    assert.match(parseWish({ goal: 'a site from repo acme/shop with plausible analytics' }).missing[0]!.ask, /Umami does the same job/);
    assert.match(parseWish({ goal: 'x y z', service: 'dify' }).missing[0]!.ask, /Flowise does the same job/);
    // the ordinary word isn't the product
    assert.deepEqual(parseWish({ goal: 'a plausible landing page from repo acme/shop' }).missing, []);

    // a build runs the step through the add-on flow: claimed, its keys kept, its address in the result
    const built = ok(await o.h('coolify.build', { serverId: srv, goal: 'just PocketBase' }));
    assert.equal(built.built, true);
    assert.match(built.url, /pocketbase-svc\d+/);
    assert.deepEqual(c.projects.map((p) => p.name), ['Tools'], 'no empty project of its own');
    assert.ok(c.seen.some((x) => x.path === '/services' && x.method === 'POST' && x.body.type === 'pocketbase' && x.body.instant_deploy === false), 'through the add-on flow, not started before it’s set up');
    assert.equal(ok(await o.h('addon.credentials', { serverId: srv, addon: 'pocketbase' })).items[0].value, CLAIM_PW);
  } finally { c.close(); }
});

// --- each tool's own first setup: the script in a real shell (dash where there is one, as on the server) with real curl, against a stand-in for the tool
const EMAIL = 'sam@example.com';
async function firstSetup(kind: ClaimKind, answers: Record<string, [number, string?]>, logs = '') {
  const asked: { method: string; path: string; headers: Record<string, unknown>; body: string }[] = [];
  const tool = createServer(async (req, rsp) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    asked.push({ method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
    const [status, answer] = answers[`${req.method} ${req.url}`] ?? [404];
    rsp.writeHead(status); rsp.end(answer ?? '');
  });
  await new Promise<void>((r) => tool.listen(0, '127.0.0.1', r));
  const port = (tool.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'unit7-claim-'));
  const log = join(dir, 'argv.log');
  writeFileSync(log, ''); writeFileSync(join(dir, 'logs'), logs);
  const fake = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  fake('docker', `case "$1" in inspect) echo 127.0.0.1;; logs) cat "${join(dir, 'logs')}";; esac`);
  fake('sleep', ':');
  fake('curl', `exec /usr/bin/curl "$@"`);
  if (existsSync('/bin/dash')) symlinkSync('/bin/dash', join(dir, 'sh'));
  const out = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
    const p = spawn('sh', ['-c', claimScript(kind, 'c-svc1', port, EMAIL)], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ stdout, stderr, status }));
  });
  tool.closeAllConnections(); tool.close();
  return { out, got: claimResult(out.stdout), asked, sent: (path: string) => asked.find((x) => x.method === 'POST' && x.path === path), argv: readFileSync(log, 'utf8') };
}
const SETUPS: { kind: ClaimKind; answers: Record<string, [number, string?]>; logs?: string; path: string; pw?: RegExp; body: (pw: string) => unknown; headers?: Record<string, string>; taken?: Record<string, [number, string?]> }[] = [
  { kind: 'ghost', path: '/ghost/api/admin/authentication/setup', answers: { 'GET /ghost/api/admin/authentication/setup': [200, '{"setup":[{"status":false}]}'], 'POST /ghost/api/admin/authentication/setup': [201, '{}'] },
    body: (password) => ({ setup: [{ name: 'Owner', email: EMAIL, password, blogTitle: 'My site' }] }), headers: { 'x-forwarded-proto': 'https' },
    taken: { 'GET /ghost/api/admin/authentication/setup': [200, '{"setup":[{"status":true}]}'] } },
  { kind: 'metabase', path: '/api/setup', answers: { 'GET /api/health': [200], 'GET /api/session/properties': [200, '{"has-user-setup":false,"setup-token":"abc-123"}'], 'POST /api/setup': [200, '{}'] },
    body: (password) => ({ token: 'abc-123', user: { email: EMAIL, password, first_name: 'Unit7', last_name: 'Owner' }, prefs: { site_name: 'My company' } }),
    taken: { 'GET /api/health': [200], 'GET /api/session/properties': [200, '{"has-user-setup":true,"setup-token":null}'] } },
  { kind: 'strapi', path: '/admin/register-admin', answers: { 'GET /admin/init': [200, '{"data":{"uuid":false,"hasAdmin":false}}'], 'POST /admin/register-admin': [200, '{}'] },
    body: (password) => ({ email: EMAIL, password, firstname: 'Unit7', lastname: 'Owner' }), taken: { 'GET /admin/init': [200, '{"data":{"hasAdmin":true}}'] } },
  { kind: 'nocodb', path: '/api/v1/app-settings', answers: { 'GET /api/v1/health': [200], 'GET /api/v1/meta/nocodb/info': [200, '{"firstUser":true}'], 'POST /api/v1/auth/user/signup': [200, '{"token":"tok.abc-1"}'], 'POST /api/v1/app-settings': [200, '{}'] },
    body: () => ({ invite_only_signup: true }), headers: { 'xc-auth': 'tok.abc-1' }, taken: { 'GET /api/v1/health': [200], 'GET /api/v1/meta/nocodb/info': [200, '{"firstUser":false}'] } },
  { kind: 'portainer', path: '/api/users/admin/init', logs: 'level=info setup_token=00ff12ab\n', answers: { 'GET /api/users/admin/check': [404], 'POST /api/users/admin/init': [200, '{}'] },
    body: (Password) => ({ Username: 'admin', Password }), headers: { 'x-setup-token': '00ff12ab' }, taken: { 'GET /api/users/admin/check': [204] } },
  { kind: 'openwebui', path: '/api/v1/auths/signup', answers: { 'GET /health': [200], 'POST /api/v1/auths/signup': [200, '{}'] },
    body: (password) => ({ name: 'Owner', email: EMAIL, password }), taken: { 'GET /health': [200], 'POST /api/v1/auths/signup': [403] } },
  { kind: 'flowise', path: '/api/v1/account/register', pw: /^U7a[0-9a-f]{36}-$/, answers: { 'GET /api/v1/ping': [200], 'POST /api/v1/account/register': [201, '{}'] },
    body: (credential) => ({ user: { name: 'Owner', email: EMAIL, credential } }) },
  { kind: 'pocketbase', path: '/api/collections/_superusers/records', logs: '(!) Launch the URL below\nhttp://0.0.0.0:8080/_/#/pbinstall/eyJh.bc-d_e\n', answers: { 'GET /api/health': [200], 'POST /api/collections/_superusers/records': [200, '{}'] },
    body: (password) => ({ email: EMAIL, password, passwordConfirm: password }), headers: { authorization: 'eyJh.bc-d_e' } },
  { kind: 'appwrite', path: '/v1/account', answers: { 'GET /v1/health/version': [200], 'POST /v1/account': [201, '{}'] },
    body: (password) => ({ userId: 'unique()', email: EMAIL, password, name: 'Owner' }), headers: { 'x-appwrite-project': 'console' }, taken: { 'GET /v1/health/version': [200], 'POST /v1/account': [501] } },
];
for (const s of SETUPS) {
  test(`${s.kind}’s first setup in a real shell: valid JSON through curl’s config, the password only on stdout and stdin, someone else there first is noticed`, async () => {
    const r = await firstSetup(s.kind, s.answers, s.logs);
    assert.equal(r.out.status, 0, r.out.stderr);
    const pw = r.got.pw ?? '';
    assert.match(pw, s.pw ?? /^U7a[0-9a-f]{36}$/, r.out.stdout);
    const sent = r.sent(s.path)!;
    assert.ok(sent, `${s.path} was called: ${JSON.stringify(r.asked.map((x) => x.path))}`);
    assert.deepEqual(JSON.parse(sent.body), s.body(pw));
    assert.equal(sent.headers['content-type'], 'application/json');
    for (const [k, v] of Object.entries(s.headers ?? {})) assert.equal(sent.headers[k], v, k);
    assert.ok(!r.argv.includes(pw), 'never on a command line');
    assert.ok(r.asked.some((x) => x.body.includes(pw)), 'handed over on stdin');
    if (s.taken) assert.deepEqual((await firstSetup(s.kind, s.taken, s.logs)).got, { taken: true });
  });
}

test('the first setups fail closed: no token, no sign-up, a refused setting, an odd token, a bad name', async () => {
  assert.equal((await firstSetup('pocketbase', { 'GET /api/health': [200] })).got.pw, undefined, 'its setup link never came');
  const noSignup = await firstSetup('nocodb', { 'GET /api/v1/health': [200], 'GET /api/v1/meta/nocodb/info': [200, '{"firstUser":true}'], 'POST /api/v1/auth/user/signup': [400, '{"msg":"no"}'] });
  assert.equal(noSignup.got.pw, undefined);
  assert.equal(noSignup.sent('/api/v1/app-settings'), undefined);
  // signed up, but invite-only wasn't accepted: someone else may be its super admin, so it isn't a claim
  assert.equal((await firstSetup('nocodb', { 'GET /api/v1/health': [200], 'GET /api/v1/meta/nocodb/info': [200, '{"firstUser":true}'], 'POST /api/v1/auth/user/signup': [200, '{"token":"t"}'], 'POST /api/v1/app-settings': [403] })).got.why, 'it answered 403');
  assert.deepEqual((await firstSetup('metabase', { 'GET /api/health': [200], 'GET /api/session/properties': [200, '{"setup-token":"a b;c"}'] })).got, { taken: true });
  assert.equal((await firstSetup('flowise', { 'GET /api/v1/ping': [200], 'POST /api/v1/account/register': [400] })).got.why, 'it answered 400');
  assert.throws(() => claimScript('ghost', 'c; rm -rf /', 2368, EMAIL));
  assert.throws(() => claimScript('flowise', 'c', 3001, 'sam"@example.com'));
});
