// The DNS writers send exactly the safe request: one name + type replaced, never a whole zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { testApp, testOrg, ok } from './helpers.ts';
import { defineTool } from '../src/tools/runtime.ts';
import { WRITERS } from '../src/connectors/dnswrite.ts';

defineTool({ name: 'test.dnswrite', title: 't', risk: 'read', action: 'read', description: 't', input: z.object({ provider: z.string(), acc: z.string(), name: z.string(), type: z.string(), content: z.string() }),
  run: (ctx, i) => WRITERS[i.provider]!.upsert(ctx, i.acc, 'example.com', { type: i.type as 'A', name: i.name, content: i.content }).then(() => 'ok') });

test('GoDaddy, Porkbun, DigitalOcean and Name.com get the right calls', async (t) => {
  if (!(await lookup('api.godaddy.com').then(() => true, () => false))) return t.skip('offline');
  const calls: { method: string; url: string; auth?: string; body?: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, auth: (init.headers as Record<string, string>).authorization, body: init.body ? JSON.parse(init.body as string) : undefined });
    const body = url.includes('/dns/retrieve/') ? { status: 'SUCCESS', records: [{ id: '77', name: 'www.example.com', type: 'CNAME' }] }
      : url.includes('digitalocean') && init.method === 'GET' ? { domain_records: [] }
      : url.includes('name.com') && init.method === 'GET' ? { records: [{ id: 5, fqdn: 'example.com.', type: 'A' }] } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const app = testApp();
    const o = await testOrg(app);
    const acc = async (provider: string, token: string) => ok(await o.h('account.connect', { provider, token })).accountId;
    const write = async (provider: string, a: string, name: string, type: string, content: string) => ok(await o.h('test.dnswrite', { provider, acc: a, name, type, content }));

    await write('godaddy', await acc('godaddy', 'gd-pat-token-123456'), 'app.example.com', 'A', '203.0.113.9');
    assert.deepEqual(calls.at(-1), { method: 'PUT', url: 'https://api.godaddy.com/v1/domains/example.com/records/A/app', auth: 'Bearer gd-pat-token-123456', body: [{ data: '203.0.113.9', ttl: 600 }] });
    await write('godaddy', await acc('godaddy', 'legacykey:legacysecret'), 'example.com', 'A', '203.0.113.9');
    assert.equal(calls.at(-1)!.url, 'https://api.godaddy.com/v1/domains/example.com/records/A/%40');
    assert.equal(calls.at(-1)!.auth, 'sso-key legacykey:legacysecret');
    assert.ok(!calls.some((c) => c.method === 'PUT' && c.url.endsWith('/records')), 'never replaces the whole zone');
    assert.equal((await o.h('test.dnswrite', { provider: 'godaddy', acc: await acc('godaddy', 'gd-pat-token-999999'), name: 'example.com', type: 'ALIAS', content: 'x.vercel-dns.com' })).status, 'error', 'GoDaddy has no ALIAS');

    calls.length = 0;
    await write('porkbun', await acc('porkbun', 'pk1_abc:sk1_def'), 'www.example.com', 'CNAME', 'abc.vercel-dns-017.com');
    assert.equal(calls.at(-1)!.url, 'https://api.porkbun.com/api/json/v3/dns/edit/example.com/77', 'edits the record that is there');
    assert.deepEqual(calls.at(-1)!.body, { apikey: 'pk1_abc', secretapikey: 'sk1_def', name: 'www', type: 'CNAME', content: 'abc.vercel-dns-017.com', ttl: '600' });

    calls.length = 0;
    await write('digitalocean', await acc('digitalocean', 'dop_v1_token_123'), 'www.example.com', 'CNAME', 'abc.vercel-dns-017.com');
    assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST']);
    assert.deepEqual(calls[1]!.body, { type: 'CNAME', name: 'www', data: 'abc.vercel-dns-017.com.', ttl: 300 });

    calls.length = 0;
    await write('namecom', await acc('namecom', 'ada:nc-token-1234'), 'example.com', 'A', '203.0.113.9');
    assert.equal(calls.at(-1)!.method, 'PUT');
    assert.equal(calls.at(-1)!.url, 'https://api.name.com/core/v1/domains/example.com/records/5');
    assert.equal(calls.at(-1)!.auth, `Basic ${Buffer.from('ada:nc-token-1234').toString('base64')}`);
    assert.deepEqual(calls.at(-1)!.body, { host: '', type: 'A', answer: '203.0.113.9', ttl: 300 });
  } finally { globalThis.fetch = real; }
});
