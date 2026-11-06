import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';

const BASE = 'http://localhost:4800';

function client() {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  let cookie = '', bind = ''; // a browser session is the cookie plus the page's header
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await http.fetch(new Request(BASE + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie && { cookie, 'x-unit7-bind': bind }), ...headers },
    }));
    const set = res.headers.get('set-cookie'); bind = res.headers.get('x-unit7-bind') ?? bind;
    if (set) cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
    return { status: res.status, body: await res.json().catch(() => null) as any, headers: res.headers };
  };
  return { app, call, clearCookie: () => (cookie = '') };
}

test('http: first-run signup, session, then invite-only', async () => {
  const { call, clearCookie } = client();
  assert.equal((await call('GET', '/api/setup')).body.needsSetup, true);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/auth/signup', { email: 'ada@example.com', name: 'Ada', password: 'short' })).status, 400);
  const s = await call('POST', '/api/auth/signup', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  assert.equal(s.status, 200);
  const me = await call('GET', '/api/me');
  assert.equal(me.body.role, 'owner');
  assert.equal(me.body.user.email, 'ada@example.com');
  clearCookie();
  const second = await call('POST', '/api/auth/signup', { email: 'eve@example.com', name: 'Eve', password: 'correct horse battery' });
  assert.equal(second.status, 403);
  assert.equal((await call('POST', '/api/auth/login', { email: 'ada@example.com', password: 'wrong password!' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'ada@example.com', password: 'correct horse battery' })).status, 200);
  assert.equal((await call('GET', '/api/me')).status, 200);
});

test('http: security headers and CSRF', async () => {
  const { call } = client();
  await call('POST', '/api/auth/signup', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  const r = await call('GET', '/api/me');
  assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const evil = await call('POST', '/api/tools/project.create', { input: { name: 'x' } }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error.code, 'bad_origin');
  const good = await call('POST', '/api/tools/project.create', { input: { name: 'Shop' } });
  assert.equal(good.status, 200);
  assert.equal(good.body.status, 'ok');
});

test('http: API tokens act as their role, never above their creator', async () => {
  const { call, clearCookie } = client();
  await call('POST', '/api/auth/signup', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  const { token } = (await call('POST', '/api/tokens', { name: 'reader', role: 'readonly' })).body;
  const agentTok = (await call('POST', '/api/tokens', { name: 'claude', role: 'agent' })).body.token;
  clearCookie();
  const auth = (t: string) => ({ authorization: `Bearer ${t}`, origin: '' });
  assert.equal((await call('GET', '/api/graph', undefined, auth(token))).status, 200);
  const denied = await call('POST', '/api/tools/project.create', { input: { name: 'x' } }, auth(token));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.status, 'denied');
  assert.equal((await call('POST', '/api/tools/project.create', { input: { name: 'Agent proj' } }, auth(agentTok))).body.status, 'ok');
  assert.equal((await call('GET', '/api/me', undefined, auth('unit7_pat_nope'))).status, 401);
  // tokens can't mint tokens
  assert.equal((await call('POST', '/api/tokens', { name: 'x', role: 'owner' }, auth(agentTok))).status, 403);
  // the audit trail names the agent
  const audit = (await call('GET', '/api/audit', undefined, auth(token))).body;
  assert.ok(audit.some((a: any) => a.actor_kind === 'agent' && a.tool === 'project.create'));
});

test('http: login is rate limited', async () => {
  const { call } = client();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'x' }, { 'x-forwarded-for': '10.9.9.9' })).status;
  assert.equal(last, 429);
});

test('http: tool catalog exposes typed schemas', async () => {
  const { call } = client();
  await call('POST', '/api/auth/signup', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  const tools = (await call('GET', '/api/tools')).body;
  const create = tools.find((t: any) => t.name === 'project.create');
  assert.equal(create.risk, 'write');
  assert.equal(create.input.properties.name.type, 'string');
});
