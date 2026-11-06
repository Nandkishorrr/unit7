// A stand-in server for Coolify-with-root tests (and a demo): Coolify 4.3.23's database, its API, its Traefik and the
// sites behind it, answering Unit7's real shell scripts through `docker` and `curl` stand-ins on the shell's PATH.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { proxyFacts } from '../src/connectors/coolify.ts';

// Coolify 4.3.23's own proxy settings, as an older install keeps them: the dashboard open, plus a person's comment and flag
export const PROXY = `name: coolify-proxy
networks:
  coolify:
    external: true
services:
  traefik:
    container_name: coolify-proxy
    image: 'traefik:v3.6'
    restart: unless-stopped
    networks:
      - coolify
    ports:
      - '80:80'
      - '443:443'
      - '443:443/udp'
      - '8080:8080'
    volumes:
      - '/var/run/docker.sock:/var/run/docker.sock:ro'
      - '/data/coolify/proxy/:/traefik'
    command:
      - '--ping=true'
      - '--api.dashboard=true'
      - '--entrypoints.http.address=:80'
      - '--entrypoints.https.address=:443'
      - '--api.insecure=true'
      - '--providers.docker=true'
      # Cloudflare in front: keep its addresses
      - '--entrypoints.https.forwardedHeaders.trustedIPs=173.245.48.0/20'
    labels:
      - traefik.enable=true
      - traefik.http.routers.traefik.entrypoints=http
      - traefik.http.routers.traefik.service=api@internal
      - traefik.http.services.traefik.loadbalancer.server.port=8080
      - coolify.managed=true
      - coolify.proxy=true
`;
export const SITES = ['relay.example.com', 'shop.example.com', 'api.shop.example.com', 'crm.example.com', 'ledger.example.com'];
export const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const inList = (ip: string, list: string[]) => list.some((e) => {
  if (!e.includes('/')) return e === ip;
  const [net, bits] = e.split('/'), n = (x: string) => x.split('.').reduce((a, o) => a * 256 + Number(o), 0), m = Number(bits);
  return m === 0 || Math.floor(n(ip) / 2 ** (32 - m)) === Math.floor(n(net!) / 2 ** (32 - m));
});

// --- the stand-in server: Coolify's database, its API, its Traefik, the sites behind it ---------------------
export function fakeHost() {
  const st = {
    api: false, allowed: null as string | null, nextId: 41,
    tokens: [{ id: '40', name: 'My laptop', abilities: ['root'], plain: `40|${'p'.repeat(40)}aaaaaaaa` }] as { id: string; name: string; abilities: string[]; plain: string }[],
    config: PROXY as string, running: PROXY, started: 1, pending: false,
    down: undefined as undefined | ((running: string) => string[]), // sites that stop answering under a config
    php: [] as { op: string; input: any }[], calls: [] as { via: 'host' | 'inside'; method: string; path: string }[],
  };
  const reply = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
  const out = (v: unknown) => reply(`some notice\n@@unit7:json ${JSON.stringify(v)}\n`);
  const fail = (m: string) => reply(`\n@@unit7:error ${JSON.stringify(m)}\n`, 1);
  const restart = () => { if (st.pending) { st.pending = false; st.running = st.config; st.started++; } };
  const php = (script: string) => {
    const op = /\/\/ unit7:(\w+)/.exec(script)![1]!, input = JSON.parse(Buffer.from(/base64_decode\('([A-Za-z0-9+/=]*)'\)/.exec(script)![1]!, 'base64').toString());
    st.php.push({ op, input });
    const settings = () => ({ api: st.api, allowed: st.allowed });
    if (op === 'state') return out({ version: '4.3.23', ...settings() });
    if (op === 'connect') {
      const before = settings();
      const old = st.tokens.filter((t) => t.name === input.name || (t.id === input.revoke && t.name.startsWith('Unit7 (')));
      st.tokens = st.tokens.filter((t) => !old.includes(t));
      st.api = true;
      const list = String(st.allowed ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (list.length && !list.includes('0.0.0.0') && !inList('127.0.0.1', list)) st.allowed = [...list, '127.0.0.1'].join(',');
      const t = { id: String(st.nextId++), name: input.name, abilities: input.abilities, plain: '' };
      t.plain = `${t.id}|${randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(40, 'x').slice(0, 40)}${'0c0ffee1'}`;
      st.tokens.push(t);
      return out({ version: '4.3.23', team: 'Root Team', tokenId: t.id, token: t.plain, abilities: t.abilities, expiresAt: '2027-10-07T00:00:00+00:00', before, after: settings(), revoked: old.map((x) => x.id) });
    }
    if (op === 'revoke') {
      const gone = st.tokens.filter((t) => t.name.startsWith('Unit7 (') && (t.id === input.tokenId || t.name === input.name));
      st.tokens = st.tokens.filter((t) => !gone.includes(t));
      return out({ revoked: gone.map((t) => t.id) });
    }
    if (op === 'settings') {
      if (input.expect && (input.expect.api !== st.api || (input.expect.allowed ?? '') !== (st.allowed ?? ''))) return fail('Coolify’s API settings changed since Unit7 changed them, so Unit7 left them as they are.');
      st.api = input.api; st.allowed = input.allowed;
      return out(settings());
    }
    if (op === 'proxy_read') return out({ version: '4.3.23', server: 'srvuuid01', type: 'TRAEFIK', status: 'running', config: Buffer.from(st.config).toString('base64'), path: '/data/coolify/proxy/' });
    if (op === 'proxy_save') {
      if (input.expect && md5(st.config) !== input.expect) return fail('Coolify’s proxy settings changed since Unit7 read them, so Unit7 changed nothing.');
      st.config = Buffer.from(input.config, 'base64').toString();
      if (input.restart) st.pending = true;
      return out({ saved: md5(st.config), restarting: !!input.restart });
    }
    return fail(`unknown op ${op}`);
  };
  // Coolify's API: its token check, its "API is disabled" and "Allowed IPs" gate, then a few routes
  const api = (via: 'host' | 'inside', config: string) => {
    const val = (k: string) => new RegExp(`^${k} = "((?:[^"\\\\]|\\\\.)*)"$`, 'm').exec(config)?.[1]?.replace(/\\(.)/g, '$1');
    const path = val('url')!.replace(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1/, ''), method = val('request')!;
    st.calls.push({ via, method, path });
    const send = (status: number, b: unknown) => reply(`${typeof b === 'string' ? b : JSON.stringify(b)}\n${status}`);
    const t = st.tokens.find((x) => `Bearer ${x.plain}` === /^header = "(Authorization: [^"]+)"$/m.exec(config)?.[1]?.replace('Authorization: ', ''));
    if (!t) return send(401, { message: 'Unauthenticated.' });
    if (!st.api) return send(403, { success: true, message: 'API is disabled.' });
    const list = String(st.allowed ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (list.length && !list.includes('0.0.0.0') && !inList(via === 'inside' ? '127.0.0.1' : '10.0.1.1', list)) return send(403, { success: true, message: 'You are not allowed to access the API.' });
    const can = (a: string) => t.abilities.includes('root') || t.abilities.includes(a);
    const r = `${method} ${path}`;
    if (r === 'GET /version') return send(200, '4.3.23');
    if (r === 'GET /team') return send(200, { id: 0, name: 'Root Team' });
    if (r === 'GET /servers') return send(200, [{ uuid: 'srvuuid01', name: 'localhost', ip: 'host.docker.internal' }]);
    if (r === 'GET /servers/srvuuid01/sentinel') return send(200, can('read:sensitive') ? { sentinel_token: 'sentinel-token-value-1' } : { is_metrics_enabled: true });
    if (r === 'POST /projects') return can('write') ? send(400, { message: 'Invalid request.', error: 'Empty JSON.' }) : send(403, { message: 'Missing required permissions: write' });
    // like Coolify: a key without read:sensitive gets the setting's name, never its value
    if (r === 'GET /applications/shopapp01/envs') return send(200, [{ uuid: 'env1', key: 'NEXT_PUBLIC_SUPABASE_URL', is_preview: false, ...(can('read:sensitive') && { value: 'https://db.example.com', real_value: 'https://db.example.com' }) }, { uuid: 'env2', key: 'SUPABASE_SERVICE_KEY', is_preview: false, ...(can('read:sensitive') && { value: 'service-key-value-0123', real_value: 'service-key-value-0123' }) }]);
    if (r === 'POST /deploy') return can('deploy') ? send(400, { message: 'You must provide uuid or tag.' }) : send(403, { message: 'Missing required permissions: deploy' });
    return send(404, { message: 'Not found.' });
  };
  const ports = (cfg: string) => ({ '80/tcp': [{ HostIp: '', HostPort: '80' }], ...(proxyFacts(cfg).dashboard.port8080 && { '8080/tcp': [{ HostIp: '', HostPort: '8080' }] }) });
  const docker = (argv: string[], stdin: string) => {
    if (argv.join(' ') === 'exec -i coolify php') return php(stdin);
    if (argv.join(' ') === 'exec -i coolify curl -K -') return api('inside', stdin);
    if (argv[0] === 'inspect') {
      restart(); // Coolify's queue picks the restart up
      const f = argv[2]!;
      if (f === '{{json .Args}}') return reply(JSON.stringify(proxyFacts(st.running).command));
      if (f === '{{json .HostConfig.PortBindings}}') return reply(JSON.stringify(ports(st.running)));
      return reply(`2026-10-07T08:00:0${st.started}Z|running|healthy\n`);
    }
    if (argv[0] === 'compose' && argv.at(-2) === 'config') return readFileSync(argv[2]!, 'utf8').includes('services:') ? reply() : reply('', 15, 'invalid compose');
    if (argv[0] === 'pull') return reply();
    if (argv[0] === 'ps') return reply('coolify\ncoolify-proxy\n');
    if (argv[0] === 'logs') return reply();
    return reply('', 1, `unexpected docker ${argv.join(' ')}`);
  };
  const curl = (argv: string[], stdin: string) => {
    if (argv.join(' ') === '-K -') return api('host', stdin);
    const url = argv.at(-1)!;
    if (url === 'http://127.0.0.1:8080/dashboard/') return reply(proxyFacts(st.running).dashboard.insecure && proxyFacts(st.running).dashboard.port8080 ? '200' : '000');
    const host = /^https?:\/\/([^/]+)\//.exec(url)?.[1];
    if (host && SITES.includes(host)) return reply(st.down?.(st.running).includes(host) ? '502' : url.startsWith('https') ? '200' : '308');
    return reply('000', 6);
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const argv = JSON.parse(Buffer.from(String(req.headers['x-argv']), 'base64').toString()) as string[], stdin = Buffer.concat(chunks).toString();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/docker' ? docker(argv, stdin) : curl(argv, stdin)));
  });
  return new Promise<{ st: typeof st; port: number; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r({ st, port: (server.address() as { port: number }).port, close: () => server.close() })));
}

// Unit7's commands run in a real shell; `docker` and `curl` on its PATH ask the stand-in
export function shell(dir: string, port: number) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = `#!${process.execPath}
const name = require('path').basename(process.argv[1]); const argv = process.argv.slice(2); const chunks = [];
const go = async () => {
  const r = await fetch('http://127.0.0.1:${port}/' + name, { method: 'POST', headers: { 'x-argv': Buffer.from(JSON.stringify(argv)).toString('base64') }, body: Buffer.concat(chunks) });
  const j = await r.json(); process.stdout.write(j.stdout || ''); process.stderr.write(j.stderr || ''); process.exitCode = j.code || 0;
};
// like the real ones, only \`docker exec -i\` and \`curl -K -\` read stdin (a script piped to sh -s stays the shell's)
if ((argv[0] === 'exec' && argv[1] === '-i') || (argv[0] === '-K' && argv[1] === '-')) { process.stdin.on('data', (c) => chunks.push(c)); process.stdin.on('end', go); } else void go();`;
  for (const n of ['docker', 'curl']) { writeFileSync(join(bin, n), shim); chmodSync(join(bin, n), 0o755); }
  if (spawnSync('sh', ['-c', 'command -v sha256sum']).status !== 0) { writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n'); chmodSync(join(bin, 'sha256sum'), 0o755); }
  return (command: string, stdin: string) => new Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>((resolve) => {
    const p = spawn('sh', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, truncated: false }));
    p.stdin.end(stdin);
  });
}

