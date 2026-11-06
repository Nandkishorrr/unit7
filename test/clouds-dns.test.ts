// DNS on the big clouds (Google Cloud DNS, Route 53, Azure DNS, Hetzner) and removing a record anywhere, all offline
// against stateful fakes: a write reads the set first and replaces only that name + type (a TXT is added next to the
// others), a delete writes back what's left, a set changed meanwhile is refused, and domain.remove_record shows what
// breaks, needs a typed name from people and a yes for an AI, refuses NS/SOA at the apex and MX without a person, and
// keeps an undo that Activity's Undo uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account } from './clouds-fakes.ts';
import { defineTool } from '../src/tools/runtime.ts';
import { WRITERS, EDITORS, type Rec } from '../src/connectors/dnswrite.ts';
import { dnsHostFromNs } from '../src/connectors/dnsinfo.ts';
import { dnsDeps } from '../src/tools/clouds-dns.ts';
import { all, get, run } from '../src/db.ts';

const CLI = fileURLToPath(new URL('./fake-cloud-cli.mjs', import.meta.url));
process.env.UNIT7_GCLOUD_BIN = CLI;

type Req = Parameters<Parameters<typeof fakeApi>[0]>[0];

defineTool({ name: 'test.cloudsdns', title: 't', risk: 'read', action: 'read', description: 't',
  input: z.object({ provider: z.string(), acc: z.string(), zone: z.string(), op: z.enum(['upsert', 'del', 'add', 'find']), rec: z.object({ type: z.string(), name: z.string(), content: z.string().optional(), value: z.string().optional() }) }),
  async run(ctx, i) {
    if (i.op === 'upsert') { await WRITERS[i.provider]!.upsert(ctx, i.acc, i.zone, i.rec as Rec); return 'ok'; }
    if (i.op === 'add') { await EDITORS[i.provider]!.add(ctx, i.acc, i.zone, { type: i.rec.type, name: i.rec.name, content: i.rec.content! }); return 'ok'; }
    return EDITORS[i.provider]![i.op](ctx, i.acc, i.zone, { name: i.rec.name, type: i.rec.type, value: i.rec.value });
  } });

test('the four clouds’ DNS hosts are recognised from their nameservers', () => {
  assert.equal(dnsHostFromNs(['ns1-37.azure-dns.com.', 'ns2-37.azure-dns.net.']), 'azure');
  assert.equal(dnsHostFromNs(['hydrogen.ns.hetzner.com.', 'helium.ns.hetzner.de.']), 'hetzner');
  assert.equal(dnsHostFromNs(['ns-cloud-a1.googledomains.com.']), 'google');
  assert.equal(dnsHostFromNs(['ns-1.awsdns-01.org.']), 'route53');
});

test('Google Cloud DNS: one set at a time, the old set named exactly, TXT added next to the others, ALIAS only at the apex', async () => {
  const sets = new Map<string, { name: string; type: string; ttl: number; rrdatas: string[] }>([
    ['example.com.|TXT', { name: 'example.com.', type: 'TXT', ttl: 300, rrdatas: ['"google-site-verification=abc"'] }],
    ['example.com.|A', { name: 'example.com.', type: 'A', ttl: 300, rrdatas: ['199.36.158.100'] }],
  ]);
  const changes: any[] = [];
  const api = await fakeApi(({ method, path, auth, body }) => {
    if (auth !== 'Bearer ya29.from-gcloud') return [401, { error: { message: 'bad' } }];
    const u = new URL(path, 'http://x');
    if (u.pathname === '/cloudresourcemanager/v1/projects') return { projects: [{ projectId: 'shop-prod' }] };
    if (u.pathname === '/dns/dns/v1/projects/shop-prod/managedZones') return { managedZones: [{ name: 'example-com', dnsName: 'example.com.', visibility: 'public' }] };
    if (u.pathname.endsWith('/rrsets')) { const s = sets.get(`${u.searchParams.get('name')}|${u.searchParams.get('type')}`); return { rrsets: s ? [s] : [] }; }
    if (u.pathname.endsWith('/changes') && method === 'POST') {
      const c = JSON.parse(body); changes.push(c);
      for (const d of c.deletions ?? []) { const s = sets.get(`${d.name}|${d.type}`); if (!s || JSON.stringify(s) !== JSON.stringify(d)) return [412, { error: { message: 'deletion does not match' } }]; }
      for (const d of c.deletions ?? []) sets.delete(`${d.name}|${d.type}`);
      for (const a of c.additions ?? []) sets.set(`${a.name}|${a.type}`, a);
      return { id: '1', status: 'pending' };
    }
  });
  process.env.UNIT7_GOOGLE_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = account(app, o.orgId, 'gcp', JSON.stringify({ cli: 'gcloud', account: 'sam@example.com' }));
    const t = (op: string, rec: object) => o.h('test.cloudsdns', { provider: 'gcp', acc, zone: 'example.com', op, rec });
    ok(await t('upsert', { type: 'A', name: 'app.example.com', content: '203.0.113.9' }));
    assert.deepEqual(changes.at(-1), { additions: [{ name: 'app.example.com.', type: 'A', ttl: 300, rrdatas: ['203.0.113.9'] }] }, 'a new name: only an addition');
    ok(await t('upsert', { type: 'A', name: 'app.example.com', content: '203.0.113.10' }));
    assert.deepEqual(changes.at(-1).deletions, [{ name: 'app.example.com.', type: 'A', ttl: 300, rrdatas: ['203.0.113.9'] }], 'the old set, exactly');
    ok(await t('upsert', { type: 'TXT', name: 'example.com', content: 'v=spf1 -all' }));
    assert.deepEqual(sets.get('example.com.|TXT')!.rrdatas, ['"google-site-verification=abc"', '"v=spf1 -all"'], 'the verification stays next to the new SPF');
    ok(await t('upsert', { type: 'CNAME', name: 'www.example.com', content: 'shop-web.web.app' }));
    assert.deepEqual(sets.get('www.example.com.|CNAME')!.rrdatas, ['shop-web.web.app.'], 'hostnames end in a dot');
    ok(await t('upsert', { type: 'ALIAS', name: 'example.com', content: 'shop.example.net' }));
    assert.deepEqual(sets.get('example.com.|ALIAS')!.rrdatas, ['shop.example.net.']);
    assert.equal((await t('upsert', { type: 'ALIAS', name: 'www.example.com', content: 'shop.example.net' })).status, 'error', 'ALIAS only at the apex');
    assert.deepEqual(ok(await t('del', { type: 'TXT', name: 'example.com', value: 'v=spf1 -all' })), [{ type: 'TXT', name: 'example.com', content: 'v=spf1 -all', ttl: 300 }]);
    assert.deepEqual(sets.get('example.com.|TXT')!.rrdatas, ['"google-site-verification=abc"'], 'only that one went');
  } finally { api.close(); delete process.env.UNIT7_GOOGLE_API; }
});

test('Route 53: UPSERT for one name + type, DELETE names the set exactly, aliases are left to AWS', async () => {
  const sets = new Map<string, { ttl: number; values: string[]; alias?: string }>([
    ['example.com|TXT', { ttl: 300, values: ['"google-site-verification=abc"'] }],
    ['api.example.com|A', { ttl: 60, values: ['198.51.100.4', '198.51.100.5'] }],
    ['example.com|A', { ttl: 0, values: [], alias: 'd2xyz.cloudfront.net.' }],
  ]);
  const posts: string[] = [];
  const tagv = (x: string, t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(x)?.[1];
  const api = await fakeApi(({ method, path, body, auth }) => {
    if (!auth.startsWith('AWS4-HMAC-SHA256')) return [403, '<Error><Code>IncompleteSignature</Code></Error>'];
    const u = new URL(path, 'http://x');
    if (u.pathname === '/route53.amazonaws.com/2013-04-01/hostedzone') return '<ListHostedZonesResponse><HostedZones><HostedZone><Id>/hostedzone/Z1</Id><Name>example.com.</Name><Config><PrivateZone>false</PrivateZone></Config></HostedZone></HostedZones></ListHostedZonesResponse>';
    if (u.pathname === '/route53.amazonaws.com/2013-04-01/hostedzone/Z1/rrset' && method === 'GET') {
      const name = u.searchParams.get('name')!.replace(/\.$/, ''), type = u.searchParams.get('type')!;
      // like Route 53: the list starts at name + type, so the next set comes back when there's none
      const hit = sets.get(`${name}|${type}`), key = hit ? `${name}|${type}` : [...sets.keys()].sort().find((k) => k > `${name}|${type}`);
      const s = key && sets.get(key);
      if (!s) return '<ListResourceRecordSetsResponse><ResourceRecordSets></ResourceRecordSets></ListResourceRecordSetsResponse>';
      const [n, t] = key!.split('|');
      return `<ListResourceRecordSetsResponse><ResourceRecordSets><ResourceRecordSet><Name>${n}.</Name><Type>${t}</Type>${s.alias ? `<AliasTarget><DNSName>${s.alias}</DNSName></AliasTarget>` : `<TTL>${s.ttl}</TTL><ResourceRecords>${s.values.map((v) => `<ResourceRecord><Value>${v.replace(/"/g, '&quot;')}</Value></ResourceRecord>`).join('')}</ResourceRecords>`}</ResourceRecordSet></ResourceRecordSets></ListResourceRecordSetsResponse>`;
    }
    if (u.pathname === '/route53.amazonaws.com/2013-04-01/hostedzone/Z1/rrset/' && method === 'POST') {
      posts.push(body);
      const action = tagv(body, 'Action'), name = tagv(body, 'Name')!.replace(/\.$/, ''), type = tagv(body, 'Type')!, ttl = Number(tagv(body, 'TTL'));
      const values = [...body.matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => m[1]!.replace(/&quot;/g, '"'));
      if (action === 'DELETE') { const s = sets.get(`${name}|${type}`); if (!s || s.ttl !== ttl || JSON.stringify(s.values) !== JSON.stringify(values)) return [400, '<ErrorResponse><Error><Code>InvalidChangeBatch</Code><Message>not found</Message></Error></ErrorResponse>']; sets.delete(`${name}|${type}`); }
      else sets.set(`${name}|${type}`, { ttl, values });
      return '<ChangeResourceRecordSetsResponse><ChangeInfo><Id>/change/C1</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>';
    }
  });
  process.env.UNIT7_AWS_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = account(app, o.orgId, 'aws', 'AKIAEXAMPLEGOOD1234:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    const t = (op: string, rec: object) => o.h('test.cloudsdns', { provider: 'aws', acc, zone: 'example.com', op, rec });
    ok(await t('upsert', { type: 'CNAME', name: 'www.example.com', content: 'shop-site.amplifyapp.com' }));
    assert.match(posts.at(-1)!, /^<\?xml version="1.0" encoding="UTF-8"\?><ChangeResourceRecordSetsRequest xmlns="https:\/\/route53.amazonaws.com\/doc\/2013-04-01\/"><ChangeBatch><Comment>Unit7<\/Comment><Changes><Change><Action>UPSERT<\/Action><ResourceRecordSet><Name>www.example.com.<\/Name><Type>CNAME<\/Type><TTL>300<\/TTL>/);
    ok(await t('upsert', { type: 'TXT', name: 'example.com', content: 'v=spf1 -all' }));
    assert.deepEqual(sets.get('example.com|TXT')!.values, ['"google-site-verification=abc"', '"v=spf1 -all"']);
    assert.deepEqual(ok(await t('del', { type: 'A', name: 'api.example.com', value: '198.51.100.5' })).map((r: any) => r.content), ['198.51.100.5']);
    assert.deepEqual(sets.get('api.example.com|A'), { ttl: 60, values: ['198.51.100.4'] }, 'the other value stays, same TTL');
    ok(await t('del', { type: 'A', name: 'api.example.com' }));
    assert.match(posts.at(-1)!, /<Action>DELETE<\/Action>.*<TTL>60<\/TTL>/, 'DELETE names the set exactly');
    assert.ok(!sets.has('api.example.com|A'));
    const alias = await t('del', { type: 'A', name: 'example.com' });
    assert.equal(alias.status, 'error');
    assert.match((alias as any).error.message, /AWS alias/);
  } finally { api.close(); delete process.env.UNIT7_AWS_API; }
});

test('Azure DNS: typed record sets, If-None-Match to create and If-Match (the etag read) to change or delete', async () => {
  const SUB = '00000000-0000-0000-0000-000000000001';
  const zone = `/subscriptions/${SUB}/resourceGroups/web/providers/Microsoft.Network/dnszones/example.org`;
  const sets = new Map<string, { etag: string; properties: any }>([[`${zone}/TXT/@`, { etag: 'e1', properties: { TTL: 3600, TXTRecords: [{ value: ['google-site-verification=abc'] }] } }]]);
  const seen: { method: string; path: string; ifMatch?: string; ifNone?: string; body?: any }[] = [];
  let n = 1;
  const api = await fakeApi(({ method, path, auth, body, headers }) => {
    if (path.startsWith('/login/')) return { access_token: 'eyJ.from-sp', expires_in: 3600 };
    if (auth !== 'Bearer eyJ.from-sp') return [401, { error: { message: 'bad' } }];
    const p = path.replace(/^\/arm/, '').replace(/\?.*$/, '');
    if (p === '/subscriptions') return { value: [{ subscriptionId: SUB, state: 'Enabled' }] };
    if (p === `/subscriptions/${SUB}/providers/Microsoft.Network/dnszones`) return { value: [{ id: zone, name: 'example.org' }] };
    const key = decodeURIComponent(p);
    seen.push({ method, path: key, ifMatch: headers['if-match'] as string, ifNone: headers['if-none-match'] as string, body: body ? JSON.parse(body) : undefined });
    const s = sets.get(key);
    if (method === 'GET') return s;
    if (method === 'PUT') {
      if (headers['if-none-match'] === '*' && s) return [412, { error: { message: 'exists' } }];
      if (headers['if-match'] && headers['if-match'] !== s?.etag) return [412, { error: { message: 'changed' } }];
      sets.set(key, { etag: `e${++n}`, properties: JSON.parse(body).properties });
      return sets.get(key);
    }
    if (method === 'DELETE') { if (headers['if-match'] !== s?.etag) return [412, { error: { message: 'changed' } }]; sets.delete(key); return {}; }
  });
  process.env.UNIT7_AZURE_API = `${api.base}/arm`; process.env.UNIT7_AZURE_LOGIN = `${api.base}/login`;
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = account(app, o.orgId, 'azure', `tenant-1:${SUB}:good-secret`);
    const t = (op: string, rec: object) => o.h('test.cloudsdns', { provider: 'azure', acc, zone: 'example.org', op, rec });
    ok(await t('upsert', { type: 'A', name: 'app.example.org', content: '203.0.113.9' }));
    assert.deepEqual(seen.at(-1), { method: 'PUT', path: `${zone}/A/app`, ifMatch: undefined, ifNone: '*', body: { properties: { TTL: 300, ARecords: [{ ipv4Address: '203.0.113.9' }] } } });
    ok(await t('upsert', { type: 'TXT', name: 'example.org', content: 'v=spf1 -all' }));
    assert.equal(seen.at(-1)!.ifMatch, 'e1', 'changes only the set it read');
    assert.deepEqual(sets.get(`${zone}/TXT/@`)!.properties.TXTRecords, [{ value: ['google-site-verification=abc'] }, { value: ['v=spf1 -all'] }]);
    ok(await t('upsert', { type: 'CNAME', name: 'www.example.org', content: 'happy-sea-123.azurestaticapps.net' }));
    assert.deepEqual(sets.get(`${zone}/CNAME/www`)!.properties.CNAMERecord, { cname: 'happy-sea-123.azurestaticapps.net' });
    assert.equal((await t('upsert', { type: 'ALIAS', name: 'example.org', content: 'x.example.net' })).status, 'error', 'Azure aliases only point at Azure resources');
    ok(await t('del', { type: 'A', name: 'app.example.org' }));
    assert.equal(seen.at(-1)!.method, 'DELETE');
    assert.ok(!sets.has(`${zone}/A/app`));
  } finally { api.close(); delete process.env.UNIT7_AZURE_API; delete process.env.UNIT7_AZURE_LOGIN; }
});

// --- Hetzner, and domain.remove_record end to end ------------------------------------------------------------------
function hetznerFake(sets: Map<string, { name: string; type: string; ttl: number | null; records: { value: string }[] }>) {
  return ({ method, path, auth, body }: Req) => {
    if (auth !== 'Bearer hz-good-token-123') return [401, { error: { code: 'unauthorized', message: 'unable to authenticate' } }];
    const p = decodeURIComponent(path.replace(/^\/hz/, '').replace(/\?.*$/, ''));
    if (p === '/zones/example.net') return { zone: { id: 9, name: 'example.net' } };
    const m = /^\/zones\/example\.net\/rrsets(?:\/([^/]+)\/([A-Z]+)(\/actions\/(\w+))?)?$/.exec(p);
    if (!m) return undefined;
    const key = `${m[1]}|${m[2]}`;
    if (!m[1] && method === 'POST') { const b = JSON.parse(body); sets.set(`${b.name}|${b.type}`, b); return [201, { rrset: b, action: { id: 1 } }]; }
    if (method === 'GET') return sets.has(key) ? { rrset: sets.get(key) } : undefined;
    if (method === 'DELETE') { sets.delete(key); return [201, { action: { id: 2 } }]; }
    if (m[4] === 'set_records') { sets.set(key, { ...sets.get(key)!, records: JSON.parse(body).records }); return [201, { action: { id: 3 } }]; }
  };
}

test('Hetzner DNS: a new set is created, an existing one has its records set, TXT values stay quoted', async () => {
  const sets = new Map([['@|TXT', { name: '@', type: 'TXT', ttl: 3600, records: [{ value: '"google-site-verification=abc"' }] }]]) as Map<string, any>;
  const api = await fakeApi(hetznerFake(sets));
  process.env.UNIT7_HETZNER_API = `${api.base}/hz`;
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = account(app, o.orgId, 'hetzner', 'hz-good-token-123');
    const t = (op: string, rec: object) => o.h('test.cloudsdns', { provider: 'hetzner', acc, zone: 'example.net', op, rec });
    ok(await t('upsert', { type: 'A', name: 'app.example.net', content: '203.0.113.80' }));
    assert.deepEqual(sets.get('app|A'), { name: 'app', type: 'A', ttl: 300, records: [{ value: '203.0.113.80' }] });
    ok(await t('upsert', { type: 'TXT', name: '_dmarc.example.net', content: 'v=DMARC1; p=reject' }));
    assert.deepEqual(sets.get('_dmarc|TXT').records, [{ value: '"v=DMARC1; p=reject"' }]);
    ok(await t('upsert', { type: 'TXT', name: 'example.net', content: 'v=spf1 -all' }));
    assert.deepEqual(sets.get('@|TXT').records, [{ value: '"google-site-verification=abc"' }, { value: '"v=spf1 -all"' }]);
    assert.equal((await t('upsert', { type: 'ALIAS', name: 'example.net', content: 'x.example.com' })).status, 'error', 'Hetzner has no ALIAS');
  } finally { api.close(); delete process.env.UNIT7_HETZNER_API; }
});

test('domain.remove_record: what breaks first, a typed name, never NS/SOA at the apex, MX only by a person, and Undo puts it back', async () => {
  const sets = new Map<string, any>([
    ['www|CNAME', { name: 'www', type: 'CNAME', ttl: 300, records: [{ value: 'old-shop.herokudns.com.' }] }],
    ['@|TXT', { name: '@', type: 'TXT', ttl: 300, records: [{ value: '"v=spf1 include:_spf.example.com ~all"' }, { value: '"google-site-verification=abc"' }] }],
    ['@|NS', { name: '@', type: 'NS', ttl: 3600, records: [{ value: 'hydrogen.ns.hetzner.com.' }] }],
    ['@|MX', { name: '@', type: 'MX', ttl: 300, records: [{ value: '10 mx.example.com.' }] }],
  ]);
  const api = await fakeApi(hetznerFake(sets));
  process.env.UNIT7_HETZNER_API = `${api.base}/hz`;
  const real = { ...dnsDeps };
  dnsDeps.host = async () => ({ zone: 'example.net', host: 'hetzner', nameservers: ['hydrogen.ns.hetzner.com'] });
  dnsDeps.answers = async (name, type) => (type === 'CNAME' ? ['old-shop.herokudns.com'] : []);
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'hetzner', 'hz-good-token-123', 'Hetzner');
    run(app.db, `INSERT INTO sync_runs (id, org_id, started_at, finished_at, status, summary) VALUES ('syn_1', ?, '2026-10-07T00:00:00Z', '2026-10-07T00:01:00Z', 'done', ?)`, o.orgId,
      JSON.stringify({ issues: [{ severity: 'critical', key: 'takeover:www.example.net', text: 'www.example.net points at old-shop.herokudns.com, which no longer exists.' }] }));
    run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES ('ast_shopapp00001', ?, 'heroku', 'app', 'h1', 'old-shop', ?, '2026-10-07')`, o.orgId, JSON.stringify({ hosts: ['www.example.net'] }));

    const dry = await o.h('domain.remove_record', { domain: 'example.net', name: 'www', type: 'cname' }, { dryRun: true });
    assert.equal(dry.status, 'dry_run');
    const plan = (dry as any).plan;
    assert.deepEqual(plan.willDelete, ['CNAME www.example.net → old-shop.herokudns.com']);
    assert.deepEqual(plan.answersNow, ['old-shop.herokudns.com']);
    assert.equal(plan.takeoverCleared, true, 'deleting it clears the takeover risk');
    assert.deepEqual(plan.stops, ['old-shop stops answering at www.example.net']);
    assert.equal(plan.at, 'Hetzner DNS');
    assert.equal(plan.confirm, 'www.example.net');

    const noName = await o.h('domain.remove_record', { domain: 'example.net', name: 'www', type: 'CNAME' });
    assert.equal(noName.status, 'error');
    assert.equal((noName as any).error.code, 'confirm_needed', 'a person types the name');
    assert.ok(sets.has('www|CNAME'));

    // an AI asks first, even at Full autopilot, and the person approving types the name again
    run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
    assert.equal((await o.a('domain.remove_record', { domain: 'example.net', name: 'www', type: 'CNAME' })).status, 'error', 'an AI must say the name');
    const asked = await o.a('domain.remove_record', { domain: 'example.net', name: 'www', type: 'CNAME', confirmName: 'www.example.net' });
    assert.equal(asked.status, 'approval_required');
    assert.match((asked as any).why, /a person says yes first.*Hard to undo/);

    const done = ok(await o.h('domain.remove_record', { domain: 'example.net', name: 'www', type: 'CNAME', confirmName: 'www.example.net' }));
    assert.deepEqual(done.removed, ['CNAME www.example.net → old-shop.herokudns.com']);
    assert.ok(!sets.has('www|CNAME'));
    const ch = get<{ server_id: string | null; verb: string; status: string }>(app.db, 'SELECT server_id, verb, status FROM changes WHERE id = ?', done.changeId)!;
    assert.deepEqual({ ...ch }, { server_id: null, verb: 'dns.remove', status: 'done' }, 'an undo that isn’t on a server');
    assert.ok(all<{ data: string }>(app.db, `SELECT data FROM events WHERE type = 'change.made' AND org_id = ?`, o.orgId).some((e) => JSON.parse(e.data).changeId === done.changeId), 'Activity offers Undo');
    assert.ok(ok(await o.h('change.list')).some((c: any) => c.changeId === done.changeId && c.canUndo));
    ok(await o.h('change.undo', { changeId: done.changeId }));
    assert.deepEqual(sets.get('www|CNAME')?.records, [{ value: 'old-shop.herokudns.com.' }], 'Undo put it back exactly');

    // one value of several: the rest stays; email consequences are said
    const spf = await o.h('domain.remove_record', { zone: 'example.net', name: '@', type: 'TXT', value: 'v=spf1 include:_spf.example.com ~all' }, { dryRun: true });
    assert.match((spf as any).plan.stops.join(' '), /spam/);
    assert.equal((spf as any).plan.email, true);
    ok(await o.h('domain.remove_record', { zone: 'example.net', name: '@', type: 'TXT', value: 'v=spf1 include:_spf.example.com ~all', confirmName: 'example.net' }));
    assert.deepEqual(sets.get('@|TXT').records, [{ value: '"google-site-verification=abc"' }]);

    const ns = await o.h('domain.remove_record', { zone: 'example.net', name: '@', type: 'NS', confirmName: 'example.net' });
    assert.equal((ns as any).error.code, 'refused');
    assert.equal((await o.h('domain.remove_record', { zone: 'example.net', name: '@', type: 'SOA', confirmName: 'example.net' }) as any).error.code, 'refused');
    assert.equal((await o.h('domain.remove_record', { zone: 'example.net', name: '@', type: 'MX', confirmName: 'example.net' }) as any).error.code, 'confirm_email', 'MX needs a person to say email may stop');
    assert.equal((await o.a('domain.remove_record', { zone: 'example.net', name: '@', type: 'MX', confirmName: 'example.net', breakEmail: true })).status, 'denied', 'never an AI');
    ok(await o.h('domain.remove_record', { zone: 'example.net', name: '@', type: 'MX', confirmName: 'example.net', breakEmail: true }));
    assert.ok(!sets.has('@|MX') && sets.has('@|NS'));
  } finally { api.close(); delete process.env.UNIT7_HETZNER_API; Object.assign(dnsDeps, real); }
});

test('deleting at the other DNS hosts: by id, or the name + type with the rest written back, never the zone', async (t) => {
  const { lookup } = await import('node:dns/promises');
  if (!(await lookup('api.godaddy.com').then(() => true, () => false))) return t.skip('offline');
  const calls: { method: string; url: string; body?: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(init.body as string) : undefined });
    const u = new URL(url);
    const body =
      u.hostname === 'api.godaddy.com' && method === 'GET' ? [{ data: '203.0.113.1', ttl: 600 }, { data: '203.0.113.2', ttl: 600 }]
      : u.hostname === 'api.digitalocean.com' && method === 'GET' ? { domain_records: [{ id: 41, type: 'A', name: 'app', data: '203.0.113.1', ttl: 300 }] }
      : u.pathname.includes('/dns/retrieve/') ? { status: 'SUCCESS', records: [{ id: '77', name: 'app.example.com', type: 'A', content: '203.0.113.1', ttl: '600' }] }
      : u.hostname === 'api.name.com' && method === 'GET' ? { records: [{ id: 5, fqdn: 'app.example.com.', type: 'A', answer: '203.0.113.1', ttl: 300 }] }
      : u.hostname === 'api.cloudflare.com' && u.pathname === '/client/v4/zones' ? { success: true, result: [{ id: 'z1', name: 'example.com' }] }
      : u.hostname === 'api.cloudflare.com' && method === 'GET' ? { success: true, result: [{ id: 'r1', type: 'A', name: 'app.example.com', content: '203.0.113.1', ttl: 1 }] }
      : u.hostname === 'api.cloudflare.com' ? { success: true, result: { id: 'r1' } }
      : u.hostname === 'api.vercel.com' && u.pathname === '/v2/teams' ? { teams: [] }
      : u.hostname === 'api.vercel.com' && u.pathname === '/v5/domains/example.com/records' ? { records: [{ id: 'rec_1', name: 'app', type: 'A', value: '203.0.113.1', ttl: 60 }] }
      : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const app = testApp(), o = await testOrg(app);
    const del = async (provider: string, token: string, value?: string) => ok(await o.h('test.cloudsdns', { provider, acc: account(app, o.orgId, provider, token), zone: 'example.com', op: 'del', rec: { type: 'A', name: 'app.example.com', value } }));
    assert.deepEqual(await del('godaddy', 'gd-pat-token-123456', '203.0.113.2'), [{ type: 'A', name: 'app.example.com', content: '203.0.113.2', ttl: 600, priority: undefined }]);
    assert.deepEqual(calls.at(-1), { method: 'PUT', url: 'https://api.godaddy.com/v1/domains/example.com/records/A/app', body: [{ data: '203.0.113.1', ttl: 600 }] }, 'the other value is written back for that name + type only');
    await del('godaddy', 'gd-pat-token-654321');
    assert.deepEqual(calls.at(-1), { method: 'DELETE', url: 'https://api.godaddy.com/v1/domains/example.com/records/A/app', body: undefined });
    await del('digitalocean', 'dop_v1_token_123');
    assert.deepEqual(calls.at(-1), { method: 'DELETE', url: 'https://api.digitalocean.com/v2/domains/example.com/records/41', body: undefined });
    await del('porkbun', 'pk1_abc:sk1_def');
    assert.equal(calls.at(-1)!.url, 'https://api.porkbun.com/api/json/v3/dns/delete/example.com/77');
    await del('namecom', 'ada:nc-token-1234');
    assert.deepEqual(calls.at(-1), { method: 'DELETE', url: 'https://api.name.com/core/v1/domains/example.com/records/5', body: undefined });
    await del('cloudflare', 'cf-token-123456');
    assert.deepEqual(calls.at(-1), { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1', body: undefined });
    await del('vercel', 'vc-token-123456');
    assert.deepEqual(calls.at(-1), { method: 'DELETE', url: 'https://api.vercel.com/v2/domains/example.com/records/rec_1', body: undefined });
    assert.ok(!calls.some((c) => c.method !== 'GET' && /\/records\/?$/.test(new URL(c.url).pathname) && c.method === 'PUT'), 'never a whole-zone replace');
  } finally { globalThis.fetch = real; }
});
