// DNS names go into providers' URL paths, so they're hostnames and nothing else: the zone, domain and record name are
// checked before any provider call (dry runs included), and every writer encodes each path segment (and refuses "." and
// ".."). Cloudflare's list is filtered on our side too, and a removed record comes back exactly: orange cloud and TTL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { testApp, testOrg, ok } from './helpers.ts';
import { account } from './clouds-fakes.ts';
import { defineTool } from '../src/tools/runtime.ts';
import { WRITERS, EDITORS, LISTERS, NAMESERVERS } from '../src/connectors/dnswrite.ts';
import { dnsDeps } from '../src/tools/clouds-dns.ts';

const EVIL = 'x/../../delete/example.com/123456';
const TOKENS: Record<string, string> = { porkbun: 'pk1_key:sk1_secret', godaddy: 'gd-pat-token-123456', digitalocean: 'dop_v1_token_123', namecom: 'ada:nc-token-1234', vercel: 'vc-token-123456', cloudflare: 'cf-token-123456' };

function recordFetch(reply: (u: URL, method: string) => unknown = () => ({})) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(reply(new URL(url), method) ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('the reviewer’s zone (and the same trick in the domain or the name) is refused before any provider call, dry run included', async () => {
  const f = recordFetch();
  const realDeps = { ...dnsDeps };
  let lookups = 0;
  dnsDeps.host = async () => { lookups++; return {} as never; };
  try {
    const app = testApp(), o = await testOrg(app);
    for (const [provider, token] of Object.entries(TOKENS)) {
      const accountId = account(app, o.orgId, provider, token);
      for (const input of [{ zone: EVIL, name: 'www' }, { domain: EVIL, name: 'www' }, { name: `www/../../delete/example.com/1` }, { zone: '..', name: 'www' }, { zone: 'example.com', name: 'a..b' }, { zone: 'exa%2fmple.com', name: 'www' }]) {
        for (const r of [await o.a('domain.remove_record', { ...input, type: 'A', accountId }, { dryRun: true }), await o.h('domain.remove_record', { ...input, type: 'A', accountId, confirmName: 'www.example.com' })]) {
          assert.equal(r.status === 'error' && r.error.code, 'invalid_input', `${provider} ${JSON.stringify(input)}`);
        }
      }
    }
    assert.equal(f.calls.length, 0, 'no provider was called');
    assert.equal(lookups, 0, 'not even a DNS lookup');
    // real names still pass the check (the call then goes on to look the zone up)
    const shapes = ['www', '@', '*.example.com', '_dmarc.example.com', 'sel._domainkey.example.com', 'WWW.Example.COM.'];
    for (const name of shapes) {
      const r = await o.h('domain.remove_record', { zone: 'example.com', name, type: 'TXT' }, { dryRun: true });
      assert.ok(!(r.status === 'error' && r.error.code === 'invalid_input'), `${name}: ${JSON.stringify(r)}`);
    }
  } finally { f.restore(); Object.assign(dnsDeps, realDeps); }
});

defineTool({ name: 'test.dnsguard', title: 't', risk: 'read', action: 'read', description: 't',
  input: z.object({ provider: z.string(), acc: z.string(), zone: z.string(), op: z.enum(['owns', 'upsert', 'find', 'del', 'add', 'list', 'ns']) }),
  async run(ctx, i) {
    const rec = { type: 'A' as const, name: `app.${i.zone}`, content: '203.0.113.1' };
    if (i.op === 'owns') return WRITERS[i.provider]!.owns(ctx, i.acc, i.zone);
    if (i.op === 'upsert') return WRITERS[i.provider]!.upsert(ctx, i.acc, i.zone, rec);
    if (i.op === 'add') return EDITORS[i.provider]!.add(ctx, i.acc, i.zone, rec);
    if (i.op === 'list') return LISTERS[i.provider]!(ctx, i.acc, i.zone);
    if (i.op === 'ns') return NAMESERVERS[i.provider]!(ctx, i.acc, i.zone, ['ns1.example.net', 'ns2.example.net']);
    return EDITORS[i.provider]![i.op](ctx, i.acc, i.zone, { name: rec.name, type: 'A' });
  } });

test('every writer keeps a zone inside its own path segment, and refuses "." and ".."', async (t) => {
  if (!(await lookup('api.godaddy.com').then(() => true, () => false))) return t.skip('offline');
  // records come back with ids, so deletes and edits run too
  const f = recordFetch((u, method) => (u.hostname === 'api.digitalocean.com' && method === 'GET' ? { domain_records: [{ id: 41, type: 'A', name: 'app', data: '203.0.113.1', ttl: 300 }] }
    : u.pathname.includes('/dns/retrieve/') ? { status: 'SUCCESS', records: [{ id: '77', name: `app.${EVIL}`, type: 'A', content: '203.0.113.1', ttl: '600' }] }
    : u.hostname === 'api.name.com' && method === 'GET' ? { records: [{ id: 5, fqdn: `app.${EVIL}.`, type: 'A', answer: '203.0.113.1', ttl: 300 }] }
    : u.hostname === 'api.godaddy.com' && method === 'GET' ? [{ type: 'A', name: 'app', data: '203.0.113.1', ttl: 600 }]
    : u.hostname === 'api.vercel.com' && u.pathname === '/v2/teams' ? { teams: [] }
    : u.hostname === 'api.vercel.com' ? { records: [{ id: 'rec_1', name: 'app', type: 'A', value: '203.0.113.1', ttl: 60 }] }
    : {}));
  try {
    const app = testApp(), o = await testOrg(app);
    const ops: Record<string, string[]> = { godaddy: ['owns', 'upsert', 'find', 'del', 'add', 'list'], digitalocean: ['owns', 'upsert', 'find', 'del', 'add', 'list'], porkbun: ['owns', 'upsert', 'find', 'del', 'add', 'list'],
      namecom: ['owns', 'upsert', 'find', 'del', 'add', 'list', 'ns'], vercel: ['owns', 'upsert', 'find', 'del', 'add'] };
    for (const [provider, list] of Object.entries(ops)) {
      const acc = account(app, o.orgId, provider, TOKENS[provider]!);
      for (const op of list) {
        f.calls.length = 0;
        await o.h('test.dnsguard', { provider, acc, zone: EVIL, op });
        assert.ok(f.calls.length, `${provider} ${op} called out`);
        for (const c of f.calls) {
          const path = new URL(c.url).pathname;
          assert.ok(!path.includes('/delete/example.com/') && !path.includes('/../'), `${provider} ${op}: ${c.method} ${path}`);
        }
        assert.ok(f.calls.some((c) => new URL(c.url).pathname.includes(encodeURIComponent(EVIL))), `${provider} ${op}: the zone went as one encoded segment`);
        for (const zone of ['..', '.']) {
          f.calls.length = 0;
          const r = await o.h('test.dnsguard', { provider, acc, zone, op });
          assert.equal(r.status, 'error', `${provider} ${op} ${zone}`);
          assert.equal(f.calls.length, 0, `${provider} ${op} ${zone}: nothing sent (a URL parser would walk up the path)`);
        }
      }
    }
  } finally { f.restore(); }
});

test('Cloudflare: only that name and type is ever deleted, and Undo brings the record back proxied, with its TTL', async (t) => {
  if (!(await lookup('api.cloudflare.com').then(() => true, () => false))) return t.skip('offline');
  // a list that ignores the filter: other names and types come back too
  const f = recordFetch((u, method) => (u.pathname === '/client/v4/zones' ? { success: true, result: [{ id: 'z1', name: 'example.com' }] }
    : method === 'GET' ? { success: true, result: [
      { id: 'r1', type: 'A', name: 'www.example.com', content: '203.0.113.1', ttl: 1, proxied: true },
      { id: 'r2', type: 'A', name: 'www.example.com', content: '203.0.113.2', ttl: 300, proxied: false },
      { id: 'r3', type: 'A', name: 'shop.example.com', content: '203.0.113.3', ttl: 1, proxied: true },
      { id: 'r4', type: 'TXT', name: 'www.example.com', content: 'keep me', ttl: 1 }] }
    : { success: true, result: { id: 'new' } }));
  const realDeps = { ...dnsDeps };
  dnsDeps.host = async () => ({ zone: 'example.com', host: 'cloudflare' }) as never;
  dnsDeps.answers = async () => [];
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = account(app, o.orgId, 'cloudflare', TOKENS.cloudflare!);
    const r = ok(await o.h('domain.remove_record', { zone: 'example.com', name: 'www', type: 'A', accountId: acc, confirmName: 'www.example.com' }));
    const deleted = f.calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname.split('/').pop());
    assert.deepEqual(deleted, ['r1', 'r2'], 'not shop.example.com, not the TXT');
    f.calls.length = 0;
    ok(await o.h('change.undo', { changeId: r.changeId }));
    const added = f.calls.filter((c) => c.method === 'POST').map((c) => c.body);
    assert.deepEqual(added.map((b) => [b.content, b.proxied, b.ttl]), [['203.0.113.1', true, 1], ['203.0.113.2', false, 300]], 'exactly as they were');
  } finally { f.restore(); Object.assign(dnsDeps, realDeps); }
});
