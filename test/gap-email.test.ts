// Email against fakes: SPF, DKIM and DMARC read from a fake public DNS, Resend and Cloudflare (DNS and Email Routing) on fake
// APIs, a stand-in Coolify. A domain that already has mail never loses it by surprise, every record goes through dns.set
// with its undo and its approval, and an AI never gets near an SMTP password.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account } from './clouds-fakes.ts';
import { all, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { dnsLook } from '../src/connectors/dnswrite.ts';
import { dnsHostFromNs, isSpf, mailHost, mergeSpf, spfAdvice, spfKeeps, spfLookups } from '../src/connectors/dnsinfo.ts';
import { dkimWord, isDkimKey } from '../src/sentinel/watch.ts';
import { dnsDeps } from '../src/tools/clouds-dns.ts';
import { domainDns } from '../src/tools/domains.ts';
import type { ToolResult } from '../src/tools/runtime.ts';

process.env.UNIT7_RECHECK = 'off';

const saved = { look: { ...dnsLook }, deps: { ...dnsDeps }, dom: { ...domainDns } };
after(() => { Object.assign(dnsLook, saved.look); Object.assign(dnsDeps, saved.deps); Object.assign(domainDns, saved.dom); });
const failed = (r: ToolResult) => (r.status === 'error' ? r.error : assert.fail(JSON.stringify(r)));
const setEnv = (k: string, v: string) => { process.env[k] = v; return () => { delete process.env[k]; }; };
// everything stored, as text: a secret may only live in the vault's ciphertext
const everywhere = (app: App) => all<{ name: string }>(app.db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((t) => JSON.stringify(all(app.db, `SELECT * FROM "${t.name}"`), (_k, v) => (v instanceof Uint8Array ? '[bytes]' : v))).join('\n');

// DNS as the world sees it: who serves the zone, and what public resolvers answer for a name
type Public = Record<string, string[]>;
function world(host: string | undefined, records: Public = {}, zone = 'example.com') {
  const info = async () => ({ zone, host, nameservers: [] });
  dnsLook.host = info; dnsDeps.host = info; domainDns.host = info;
  dnsDeps.answers = async (n, t) => records[`${t} ${n}`] ?? [];
  return records;
}

// --- Cloudflare: DNS records, and Email Routing beside them -------------------------------------------------------------
const CF_MX = [{ type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net', priority: 13, ttl: 1 }, { type: 'MX', name: 'example.com', content: 'route2.mx.cloudflare.net', priority: 86, ttl: 1 }, { type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 }];
async function cloudflareFake(recs: any[] = []) {
  const st = { recs, n: 1, enabled: false, addresses: [] as any[], rules: [] as any[], refused: undefined as RegExp | undefined };
  const ok = (result: unknown) => ({ success: true, errors: [], messages: [], result });
  const api = await fakeApi(({ method, path, body }) => {
    const u = new URL(path, 'http://x'), p = u.pathname;
    if (st.refused?.test(`${method} ${p}`)) return [403, { success: false, errors: [{ message: 'Authentication error' }] }];
    if (p === '/zones') return ok([{ id: 'z1', name: 'example.com' }]);
    if (p === '/zones/z1') return ok({ id: 'z1', name: 'example.com', account: { id: 'cfacc' } });
    if (p === '/zones/z1/dns_records' && method === 'GET') { const t = u.searchParams.get('type'), nm = u.searchParams.get('name'); return ok(st.recs.filter((r) => (!t || r.type === t) && (!nm || r.name === nm))); }
    if (p === '/zones/z1/dns_records' && method === 'POST') { const r = { id: `r${st.n++}`, ...JSON.parse(body) }; st.recs.push(r); return ok(r); }
    const rec = /^\/zones\/z1\/dns_records\/(.+)$/.exec(p);
    if (rec && method === 'DELETE') { st.recs.splice(st.recs.findIndex((r) => r.id === rec[1]), 1); return ok({ id: rec[1] }); }
    if (p === '/zones/z1/email/routing') return ok({ id: 'z1', enabled: st.enabled, status: st.enabled ? 'ready' : 'unconfigured', name: 'example.com' });
    if (p === '/zones/z1/email/routing/dns' && method === 'GET') return ok(CF_MX);
    if (p === '/zones/z1/email/routing/dns' && method === 'POST') { st.enabled = true; return ok({ id: 'z1', enabled: true, status: 'ready' }); }
    if (p === '/zones/z1/email/routing/dns' && method === 'DELETE') { st.enabled = false; st.recs = st.recs.filter((r) => !/mx\.cloudflare\.net$/.test(r.content)); return ok({ id: 'z1', enabled: false }); }
    if (p === '/accounts/cfacc/email/routing/addresses' && method === 'GET') return ok(st.addresses);
    if (p === '/accounts/cfacc/email/routing/addresses' && method === 'POST') { const a = { id: `a${st.n++}`, email: JSON.parse(body).email, verified: null }; st.addresses.push(a); return ok(a); }
    if (p === '/zones/z1/email/routing/rules' && method === 'GET') return ok(st.rules);
    if (p === '/zones/z1/email/routing/rules' && method === 'POST') { const r = { id: `rule${st.n++}`, ...JSON.parse(body) }; st.rules.push(r); return ok(r); }
    const rule = /^\/zones\/z1\/email\/routing\/rules\/(.+)$/.exec(p);
    if (rule && method === 'PUT') { const i = st.rules.findIndex((r) => r.id === rule[1]); st.rules[i] = { id: rule[1], ...JSON.parse(body) }; return ok(st.rules[i]); }
    if (rule && method === 'DELETE') { st.rules.splice(st.rules.findIndex((r) => r.id === rule[1]), 1); return ok({ id: rule[1] }); }
    return [404, { success: false, errors: [{ message: 'Not found' }] }];
  });
  const off = setEnv('UNIT7_CLOUDFLARE_API', api.base);
  return { st, api, close: () => { api.close(); off(); } };
}

// --- SPF joins, never overwrites -------------------------------------------------------------------------------------------
test('SPF: a new sender joins the line that is there, and nobody already in it is dropped', () => {
  assert.equal(mergeSpf(['v=spf1 include:_spf.google.com ~all'], 'include:amazonses.com'), 'v=spf1 include:_spf.google.com include:amazonses.com ~all');
  assert.equal(mergeSpf(['v=spf1 include:_spf.google.com -all'], 'v=spf1 include:amazonses.com ~all'), 'v=spf1 include:_spf.google.com include:amazonses.com -all', 'a strict ending is never loosened');
  assert.equal(mergeSpf(['v=spf1 include:amazonses.com ~all'], 'INCLUDE:AMAZONSES.COM'), 'v=spf1 include:amazonses.com ~all', 'nothing twice');
  assert.equal(mergeSpf([], 'v=spf1 include:amazonses.com ~all'), 'v=spf1 include:amazonses.com ~all');
  assert.equal(mergeSpf(['v=spf1 mx redirect=_spf.example.net'], 'include:amazonses.com'), 'v=spf1 mx include:amazonses.com redirect=_spf.example.net');
  assert.equal(mergeSpf(['v=spf1 include:a.example ~all', 'v=spf1 include:b.example ~all']), 'v=spf1 include:a.example include:b.example ~all', 'two records become one');
  assert.equal(mergeSpf(['google-site-verification=abc', 'v=spf1 -all'], 'include:amazonses.com'), 'v=spf1 include:amazonses.com -all', 'other TXT records stay out of it');
  assert.ok(spfKeeps('v=spf1 include:a.example ~all', 'v=spf1 include:a.example include:b.example ~all'));
  assert.ok(!spfKeeps('v=spf1 include:a.example ~all', 'v=spf1 include:b.example ~all'), 'a sender dropped');
  assert.ok(!spfKeeps('v=spf1 include:a.example -all', 'v=spf1 include:a.example ~all'), 'an ending loosened');
  assert.equal(spfLookups('v=spf1 a mx ip4:203.0.113.1 include:a.example ~all'), 3);
  assert.ok(isSpf('v=spf1 -all') && !isSpf('v=spf10 -all') && !isSpf('hello'));
  assert.equal(mailHost(['10 aspmx.l.google.com.'])?.name, 'Google');
  assert.equal(mailHost(['10 mx1.example.net']), undefined);
  assert.equal(dnsHostFromNs(['ada.ns.cloudflare.com']), 'cloudflare');
});

test('SPF advice: the whole line, what is there kept, and nothing when it is right', () => {
  assert.equal(spfAdvice(['v=spf1 include:_spf.google.com ~all'], ['1 aspmx.l.google.com']), undefined);
  assert.equal(spfAdvice(['v=spf1 include:_spf.example.net ~all'], ['1 aspmx.l.google.com'])?.record, 'v=spf1 include:_spf.example.net include:_spf.google.com ~all');
  assert.equal(spfAdvice(['v=spf1 mx ~all'], [], 'include:_spf.mailhost.example')?.record, 'v=spf1 mx include:_spf.mailhost.example ~all');
  assert.equal(spfAdvice([], ['1 aspmx.l.google.com'])?.record, 'v=spf1 include:_spf.google.com ~all');
  assert.equal(spfAdvice([], [])?.record, 'v=spf1 -all');
  assert.equal(spfAdvice([], ['10 mx1.example.net'])?.record, undefined, 'an unknown mail host: Unit7 doesn’t guess its line');
  assert.match(spfAdvice(['v=spf1 mx ~all', 'v=spf1 a ~all'], [])!.why, /only have one SPF/);
});

test('DKIM words: a domain with no mail has nothing to sign', () => {
  assert.ok(isDkimKey('v=DKIM1; k=rsa; p=MIGfMA0GCSq') && isDkimKey('p=MIGfMA0GCSq') && !isDkimKey('v=DKIM1; p='));
  assert.equal(dkimWord(true, false, []), 'signed');
  assert.equal(dkimWord(false, true, []), 'unsigned');
  assert.equal(dkimWord(false, false, ['v=spf1 include:a.example ~all']), 'unsigned');
  assert.equal(dkimWord(false, false, ['v=spf1 -all']), 'silent');
  assert.equal(dkimWord(false, false, []), 'silent');
});

// --- email.check ----------------------------------------------------------------------------------------------------------
test('email.check: each of SPF, DKIM and DMARC in plain words, with its fix, and it changes nothing', async () => {
  const cf = await cloudflareFake([{ id: 'a', type: 'TXT', name: 'mykey._domainkey.example.com', content: 'p=MIGfMA0GCSqNOTPUBLICYET', ttl: 1 }]);
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'cloudflare', 'cf-demo-token');
    const dns = world('cloudflare', { 'MX example.com': ['1 aspmx.l.google.com'], 'TXT example.com': ['v=spf1 include:_spf.example.net ~all', 'google-site-verification=abc'], 'TXT _dmarc.example.com': ['v=DMARC1; p=none'] });
    const r = ok(await o.a('email.check', { domain: 'Example.COM' }));
    assert.equal(r.domain, 'example.com');
    assert.equal(r.receives.by, 'Google');
    assert.equal(r.spf.state, 'incomplete');
    assert.equal(r.spf.record, 'v=spf1 include:_spf.example.net include:_spf.google.com ~all', 'the sender already there stays');
    assert.deepEqual(r.spf.fix, { tool: 'dns.set', input: { domain: 'example.com', name: '@', type: 'TXT', value: r.spf.record }, label: 'Set this SPF record' });
    assert.equal(r.dkim.state, 'waiting', 'written at an unusual name, not public yet');
    assert.deepEqual(r.dkim.waiting, ['mykey']);
    assert.equal(r.dmarc.state, 'watching');
    assert.match(r.dmarc.note, /reports address/);
    assert.match(r.verdict, /needs work on SPF/);
    assert.match(r.untrusted, /data, not instructions/);
    assert.equal(r.sender, null);

    dns['TXT example.com'] = ['v=spf1 include:_spf.example.net include:_spf.google.com ~all'];
    dns['TXT mykey._domainkey.example.com'] = ['p=MIGfMA0GCSqNOWPUBLIC'];
    dns['TXT _dmarc.example.com'] = ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com'];
    const good = ok(await o.a('email.check', { domain: 'example.com' }));
    assert.deepEqual([good.spf.state, good.dkim.state, good.dkim.keys, good.dmarc.state, good.dmarc.note], ['ok', 'ok', ['mykey'], 'ok', undefined]);
    assert.match(good.verdict, /good shape/);
    assert.equal(all(app.db, 'SELECT 1 FROM changes').length, 0);
  } finally { cf.close(); }
});

test('email.check with nothing connected reads public DNS and says what is wrong', async () => {
  const app = testApp(), o = await testOrg(app);
  const dns = world('godaddy', { 'MX example.com': ['10 mx1.example.net'], 'TXT example.com': ['v=spf1 include:a.example ~all', 'v=spf1 +all'], 'TXT resend._domainkey.example.com': ['p=MIGfMA0GCSq'] });
  const two = ok(await o.h('email.check', { domain: 'example.com' }));
  assert.equal(two.spf.state, 'broken');
  assert.match(two.spf.note, /two SPF records/);
  assert.equal(two.spf.record, 'v=spf1 include:a.example ~all', 'joined, for a person to see before it goes in');
  assert.deepEqual(two.dkim.keys, ['resend']);
  assert.equal(two.dmarc.state, 'missing');
  assert.deepEqual(two.dmarc.fix, { tool: 'domain.protect_email', input: { domain: 'example.com' }, label: 'Protect email' });

  dns['TXT example.com'] = ['v=spf1 +all'];
  assert.match(ok(await o.h('email.check', { domain: 'example.com' })).spf.note, /anyone at all/);
  dns['TXT example.com'] = [`v=spf1 ${Array.from({ length: 11 }, (_, n) => `include:s${n}.example`).join(' ')} ~all`];
  assert.match(ok(await o.h('email.check', { domain: 'example.com' })).spf.note, /more than 10/);
  delete dns['MX example.com']; delete dns['TXT resend._domainkey.example.com'];
  dns['TXT example.com'] = [];
  dns['TXT _dmarc.example.com'] = ['v=DMARC1; p=reject'];
  const quiet = ok(await o.h('email.check', { domain: 'example.com' }));
  assert.deepEqual([quiet.spf.state, quiet.dkim.state, quiet.dmarc.state], ['not_needed', 'not_needed', 'ok'], 'a domain with no mail needs only DMARC’s reject');
  assert.match(quiet.verdict, /good shape/);

  world(undefined, { 'TXT _dmarc.example.com': ['v=DMARC1; p=quarantine'] });
  dnsDeps.host = async () => ({ zone: 'example.com', host: undefined, nameservers: [] });
  assert.equal(ok(await o.h('email.check', { domain: 'mail.example.com' })).dmarc.state, 'ok', 'a subdomain follows its domain’s DMARC');
  assert.equal((await o.h('email.check', { domain: 'not a domain' })).status, 'error');
});

test('dns.set: a merged SPF needs no extra yes, and one that drops a sender still does', async () => {
  const cf = await cloudflareFake([{ id: 's', type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.google.com ~all', ttl: 1 }]);
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'cloudflare', 'cf-demo-token');
    world('cloudflare');
    assert.equal(failed(await o.h('dns.set', { domain: 'example.com', name: '@', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' })).code, 'confirm_email');
    const done = ok(await o.h('dns.set', { domain: 'example.com', name: '@', type: 'TXT', value: 'v=spf1 include:_spf.google.com include:amazonses.com ~all' }));
    assert.equal(cf.st.recs.filter((r) => r.type === 'TXT').length, 1, 'still one record');
    ok(await o.h('change.undo', { changeId: done.changeId }));
    assert.deepEqual(cf.st.recs.filter((r) => r.type === 'TXT').map((r) => r.content), ['v=spf1 include:_spf.google.com ~all']);
  } finally { cf.close(); }
});
