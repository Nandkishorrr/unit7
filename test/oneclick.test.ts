// One click per connection: GitHub (app from a manifest, then install), OpenRouter (sign-in → key),
// and pasted keys, all named automatically. The providers' servers are faked at fetch().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, createVerify } from 'node:crypto';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { get, json } from '../src/db.ts';
import { githubAppToken } from '../src/connectors/oneclick.ts';

const app = testApp();
app.services.listen = { host: '127.0.0.1', port: 4800 };
const http = createHttp(app);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

// the outside world: GitHub and OpenRouter
const realFetch = globalThis.fetch;
let challenge = '';
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'https://api.github.com/app-manifests/CODE1/conversions') return reply({ id: 7, slug: 'unit7-abc123', pem, client_id: 'Iv1.x', client_secret: 's', owner: { login: 'ada' } }, 201);
  if (url === 'https://api.github.com/app/installations/42/access_tokens') {
    const [h, p, sig] = String(init.headers.authorization).slice(7).split('.');
    const valid = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url'));
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    return valid && claims.iss === '7' ? reply({ token: 'ghs_installtoken123', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201) : reply({ message: 'bad jwt' }, 401);
  }
  if (url === 'https://openrouter.ai/api/v1/auth/keys') {
    const b = JSON.parse(init.body);
    return createHash('sha256').update(b.code_verifier).digest('base64url') === challenge && b.code === 'ORCODE' ? reply({ key: 'sk-or-v1-testkey' }) : reply({ error: { message: 'bad verifier' } }, 403);
  }
  return realFetch(input, init);
}) as typeof fetch;

let cookie = '', bind = ''; // a browser session is the cookie plus the page's header
const call = async (method: string, path: string, body?: unknown) => {
  const r = await http.fetch(new Request(`http://localhost:4800${path}`, { method, redirect: 'manual', body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: 'http://localhost:4800', ...(cookie && { cookie, 'x-unit7-bind': bind }) } }));
  const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
  const text = await r.text();
  return { status: r.status, location: r.headers.get('location') ?? '', csp: r.headers.get('content-security-policy') ?? '', text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

test('one-click connections', async (t) => {
  resetRateLimits();
  await call('POST', '/api/auth/signup', { email: 'ada@x.com', name: 'Ada', password: 'correct horse battery' });
  const orgId = get<{ id: string }>(app.db, 'SELECT id FROM orgs LIMIT 1')!.id;

  await t.test('the catalog lists one method per provider', async () => {
    const list = (await call('GET', '/api/connections')).body;
    assert.equal(list.find((p: any) => p.id === 'hostinger').method, 'mcp');
    assert.equal(list.find((p: any) => p.id === 'github').method, 'github-app');
    assert.ok(list.find((p: any) => p.id === 'cloudflare').keyUrl.includes('permissionGroupKeys'));
  });

  await t.test('GitHub: manifest page → app created → installed → install tokens', async () => {
    const start = (await call('GET', '/api/connect/github/start')).body.url as string;
    const state = start.split('/').pop()!;
    const page = await call('GET', new URL(start).pathname);
    assert.match(page.text, /action="https:\/\/github\.com\/settings\/apps\/new\?state=/);
    assert.match(page.csp, /form-action https:\/\/github\.com/);
    assert.match(page.csp, /script-src 'sha256-/);

    const created = await call('GET', `/api/connect/github/created?code=CODE1&state=${state}`);
    assert.equal(created.status, 302);
    assert.equal(created.location, `https://github.com/apps/unit7-abc123/installations/new?state=${encodeURIComponent(state)}`);
    const acc = get<{ id: string; name: string; meta: string }>(app.db, `SELECT id, name, meta FROM accounts WHERE provider = 'github'`)!;
    assert.equal(acc.name, 'GitHub (ada)');
    assert.equal(json<any>(acc.meta, {}).pending, 'install');

    const installed = await call('GET', `/api/connect/github/installed?installation_id=42&setup_action=install&state=${state}`);
    assert.equal(installed.location, '/connections?connected=GitHub+%28ada%29');
    const meta = json<any>(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', acc.id)!.meta, {});
    assert.equal(meta.installationId, 42);
    assert.equal(meta.pending, undefined);
    const secret = app.vault.resolve(orgId, meta.ref);
    assert.equal(await githubAppToken(app, orgId, { id: acc.id, meta: JSON.stringify(meta) }, secret), 'ghs_installtoken123');
  });

  await t.test('OpenRouter: sign-in code becomes a stored key', async () => {
    const url = new URL((await call('GET', '/api/connect/openrouter/start')).body.url);
    assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth');
    challenge = url.searchParams.get('code_challenge')!;
    const back = new URL(url.searchParams.get('callback_url')!);
    const r = await call('GET', `${back.pathname}?code=ORCODE`);
    assert.equal(r.location, '/connections?connected=OpenRouter');
    const acc = get<{ meta: string }>(app.db, `SELECT meta FROM accounts WHERE provider = 'openrouter'`)!;
    assert.equal(app.vault.resolve(orgId, json<any>(acc.meta, {}).ref), 'sk-or-v1-testkey');
    // the same link can't be used twice
    assert.match((await call('GET', `${back.pathname}?code=ORCODE`)).location, /oauth_error=/);
  });

  await t.test('a pasted key is named automatically', async () => {
    assert.equal((await call('POST', '/api/connect/google/key', { token: 'AIzaSyTestKey000000000000' })).status, 200);
    assert.equal((await call('POST', '/api/connect/google/key', { token: 'AIzaSyTestKey111111111111' })).status, 200);
    const names = (await call('GET', '/api/connections')).body.find((p: any) => p.id === 'google').accounts.map((a: any) => a.name);
    assert.deepEqual(names, ['Google Gemini', 'Google Gemini 2']);
  });
});
