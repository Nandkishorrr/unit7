// Email against fakes: SPF, DKIM and DMARC read from a fake public DNS, Resend and Cloudflare (DNS and Email Routing) on fake
// APIs, a stand-in Coolify. A domain that already has mail never loses it by surprise, every record goes through dns.set
// with its undo and its approval, and an AI never gets near an SMTP password.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account } from './clouds-fakes.ts';
import { COOLIFY_HOST } from './xray-fixtures.ts';
import { all, id, run } from '../src/db.ts';
import type { App } from '../src/app.ts';
import { CURL, coolifyTiming } from '../src/connectors/coolify.ts';
import { dnsLook } from '../src/connectors/dnswrite.ts';
import { packFolder, saveUpload } from '../src/connectors/folder.ts';
import { ssh, type ExecOptions } from '../src/connectors/ssh.ts';
import { envRefs } from '../src/discovery/model.ts';
import { buildInventory, type Inventory } from '../src/discovery/xray.ts';
import { addHost } from '../src/live/hosts.ts';
import { dnsHostFromNs, isSpf, mailHost, mergeSpf, spfAdvice, spfKeeps, spfLookups } from '../src/connectors/dnsinfo.ts';
import { CATALOG } from '../src/connectors/oneclick.ts';
import { dkimWord, isDkimKey } from '../src/sentinel/watch.ts';
import { dnsDeps } from '../src/tools/clouds-dns.ts';
import { domainDns } from '../src/tools/domains.ts';
import { emailTiming } from '../src/tools/email.ts';
import { manageTiming } from '../src/tools/manage.ts';
import { decideApproval, getTool, viewInput, type ToolResult } from '../src/tools/runtime.ts';
import { saveXray } from '../src/tools/xray.ts';

process.env.UNIT7_RECHECK = 'off';
coolifyTiming.pollMs = 1;
Object.assign(manageTiming, { settleMs: 0, pollMs: 1, deadlineMs: 30 });

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
  const st = { recs, n: 1, enabled: false, addresses: [] as any[], rules: [] as any[], refused: undefined as RegExp | undefined, mxWhenOn: undefined as string[] | undefined };
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
    if (rec && method === 'PUT') { st.recs[st.recs.findIndex((r) => r.id === rec[1])] = { id: rec[1], ...JSON.parse(body) }; return ok({ id: rec[1] }); }
    if (p === '/zones/z1/email/routing') return ok({ id: 'z1', enabled: st.enabled, status: st.enabled ? 'ready' : 'unconfigured', name: 'example.com' });
    if (p === '/zones/z1/email/routing/dns' && method === 'GET') return ok(CF_MX);
    if (p === '/zones/z1/email/routing/dns' && method === 'POST') { st.enabled = true; st.mxWhenOn = st.recs.filter((r) => r.type === 'MX').map((r) => r.content); return ok({ id: 'z1', enabled: true, status: 'ready' }); }
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
    assert.deepEqual(r.spf.fix, { tool: 'dns.set', input: { domain: 'example.com', name: 'example.com', type: 'TXT', value: r.spf.record }, label: 'Set this SPF record' });
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

// --- Resend, and a domain set up through it ---------------------------------------------------------------------------------
const FULL_KEY = 're_fullAcc3ss_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', SEND_KEY = 're_sendOnly9_zYxWvUtSrQpOnMlKjIhGfEdCbA987654', DKIM = 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDdemoKey';
const SES_MX = 'feedback-smtp.us-east-1.amazonses.com', SES_SPF = 'v=spf1 include:amazonses.com ~all';
const recordsFor = (sub = '') => [
  { record: 'DKIM', name: `resend._domainkey${sub}`, type: 'TXT', value: DKIM, ttl: 'Auto', status: 'not_started' },
  { record: 'SPF', name: `send${sub}`, type: 'MX', value: SES_MX, priority: 10, ttl: 'Auto', status: 'not_started' },
  { record: 'SPF', name: `send${sub}`, type: 'TXT', value: SES_SPF, ttl: 'Auto', status: 'not_started' },
];
async function resendFake(o: { verifyAfter?: number; ends?: string; sub?: string; refuse?: unknown } = {}) {
  const st = { domains: [] as any[], keys: [] as any[], checks: 0, verifies: 0 };
  const api = await fakeApi(({ method, path, body, auth }) => {
    if (auth !== `Bearer ${FULL_KEY}`) return [401, { name: 'missing_api_key', message: 'Missing API key' }];
    if (o.refuse) return o.refuse;
    if (path === '/domains' && method === 'GET') return { object: 'list', has_more: false, data: st.domains.map(({ records: _r, ...d }) => d) };
    if (path === '/domains' && method === 'POST') { const d = { id: 'dom-uuid-1', name: JSON.parse(body).name, status: 'not_started', region: JSON.parse(body).region ?? 'us-east-1', records: recordsFor(o.sub) }; st.domains.push(d); return [201, d]; }
    const m = /^\/domains\/([\w-]+)(\/verify)?$/.exec(path), d = st.domains.find((x) => x.id === m?.[1]);
    if (m?.[2] && d && method === 'POST') { st.verifies++; d.status = 'pending'; return { object: 'domain', id: d.id }; }
    if (d && method === 'GET') {
      if (d.status === 'pending' && ++st.checks >= (o.verifyAfter ?? 2)) { d.status = o.ends ?? 'verified'; for (const r of d.records) r.status = d.status; }
      return d;
    }
    if (path === '/api-keys' && method === 'POST') { st.keys.push(JSON.parse(body)); return [201, { id: 'key-1', object: 'api_key', token: SEND_KEY }]; }
  });
  const off = setEnv('UNIT7_RESEND_API', api.base);
  return { st, api, close: () => { api.close(); off(); } };
}
async function sendable(recs: any[] = [], o: Parameters<typeof resendFake>[0] = {}, host = 'cloudflare') {
  const [cf, rs] = [await cloudflareFake(recs), await resendFake(o)];
  const app = testApp(), org = await testOrg(app);
  if (host === 'cloudflare') account(app, org.orgId, 'cloudflare', 'cf-demo-token');
  const resendAcc = account(app, org.orgId, 'resend', FULL_KEY);
  const dns = world(host);
  return { app, o: org, cf, rs, dns, resendAcc, close: () => { cf.close(); rs.close(); } };
}
const zoneOf = (recs: any[], name: string, type: string) => recs.filter((r) => r.name === name && r.type === type);
Object.assign(emailTiming, { pollMs: 1, waitMs: 200 });

test('email.setup with Resend: the domain, its records through dns.set, verified, and a send-only key in the vault', async () => {
  const f = await sendable();
  try {
    const dry = await f.o.h('email.setup', { domain: 'example.com' }, { dryRun: true });
    assert.equal(dry.status, 'dry_run');
    assert.equal((dry as any).plan.resend, 'not added yet');
    assert.equal(f.rs.st.domains.length, 0, 'a dry run adds nothing');

    const r = ok(await f.o.h('email.setup', { domain: 'example.com', from: 'hello@example.com' }));
    assert.equal(r.ready, true);
    assert.equal(r.resend, 'verified');
    assert.deepEqual(r.wrote, [`TXT resend._domainkey.example.com → ${DKIM}`, `MX send.example.com → 10 ${SES_MX}`, `TXT send.example.com → ${SES_SPF}`]);
    assert.equal(r.changes.length, 3, 'each record keeps its own undo');
    assert.deepEqual(zoneOf(f.cf.st.recs, 'send.example.com', 'MX').map((x) => [x.content, x.priority]), [[SES_MX, 10]]);
    assert.equal(zoneOf(f.cf.st.recs, 'resend._domainkey.example.com', 'TXT')[0].content, DKIM);
    assert.equal(f.rs.st.verifies, 1);

    // apps get a key that only sends, from this domain; the account's own key stays where it is
    assert.deepEqual(f.rs.st.keys, [{ name: 'Unit7 example.com', permission: 'sending_access', domain_id: 'dom-uuid-1' }]);
    assert.deepEqual(r.sender, { host: 'smtp.resend.com', port: 465, user: 'resend', from: 'hello@example.com', via: 'Resend', stored: 'credential://smtp/example-com/password' });
    assert.equal(f.app.vault.resolve(f.o.orgId, r.sender.stored), SEND_KEY);
    assert.ok(!JSON.stringify(r).includes(SEND_KEY) && !everywhere(f.app).includes(SEND_KEY), 'only in the vault’s ciphertext');
    assert.match(r.next, /domain\.protect_email adds DMARC/);
    assert.match(r.next, /email\.connect_app/);

    // again: nothing asked, nothing added, no second key
    const again = ok(await f.o.h('email.setup', { domain: 'example.com' }));
    assert.equal(again.ready, true);
    assert.equal(f.rs.st.domains.length, 1);
    assert.equal(f.rs.st.keys.length, 1);
    assert.equal(again.wrote, undefined);

    // Undo takes a record back
    ok(await f.o.h('change.undo', { changeId: r.changes[1] }));
    assert.equal(zoneOf(f.cf.st.recs, 'send.example.com', 'MX').length, 0);
  } finally { f.close(); }
});

test('email.setup by an AI: every mail record waits for a person, once, and a run after the OK finishes', async () => {
  const f = await sendable();
  try {
    run(f.app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', f.o.orgId);
    const first = ok(await f.o.a('email.setup', { domain: 'example.com' }));
    assert.equal(first.ready, false);
    assert.equal(first.waiting.length, 3);
    assert.match(first.note, /3 DNS changes wait for a person on Approvals/);
    assert.equal(f.cf.st.recs.length, 0, 'nothing written');
    assert.equal(f.rs.st.verifies, 0, 'nothing to verify yet');

    const again = ok(await f.o.a('email.setup', { domain: 'example.com' }));
    assert.equal(again.waiting.length, 3);
    const asks = all<{ id: string; tool: string }>(f.app.db, `SELECT id, tool FROM approvals WHERE status = 'pending'`);
    assert.deepEqual(asks.map((a) => a.tool), ['dns.set', 'dns.set', 'dns.set'], 'no second copy of the same ask');

    for (const a of asks) assert.equal((await decideApproval(f.app, f.o.orgId, f.o.human, a.id, true)).status, 'ok');
    assert.equal(f.cf.st.recs.length, 3);

    const done = ok(await f.o.a('email.setup', { domain: 'example.com' }));
    assert.equal(done.ready, true);
    assert.equal(done.alreadyThere.length, 3);
    assert.equal(all(f.app.db, `SELECT 1 FROM approvals WHERE status = 'pending'`).length, 0, 'what’s done isn’t asked for again');
    assert.ok(!JSON.stringify(done).includes(SEND_KEY));
    assert.equal(f.app.vault.resolve(f.o.orgId, done.sender.stored), SEND_KEY);
  } finally { f.close(); }
});

test('email.setup on a domain that already has mail: SPF joins, the bare domain stays as it was, and an MX in the way asks first', async () => {
  const mail = [{ id: 'mx', type: 'MX', name: 'example.com', content: 'mx1.mailhost.example', priority: 10, ttl: 1 }, { id: 'spf', type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.mailhost.example ~all', ttl: 1 },
    // Cloudflare can hand a TXT back in quotes: it's still the record that's there
    { id: 's1', type: 'TXT', name: 'send.example.com', content: '"v=spf1 include:_spf.oldsender.example -all"', ttl: 1 }, { id: 's2', type: 'MX', name: 'send.example.com', content: 'bounce.oldsender.example', priority: 5, ttl: 1 }];
  const f = await sendable(mail);
  try {
    assert.equal(failed(await f.o.h('email.setup', { domain: 'example.com' })).code, 'confirm_email', 'the first run stops at the MX');
    const plan = (await f.o.h('email.setup', { domain: 'example.com' }, { dryRun: true }) as any).plan;
    assert.deepEqual(plan.willWrite.map((p: any) => p.record).slice(-1), [`TXT send.example.com → v=spf1 include:_spf.oldsender.example include:amazonses.com -all`], 'the dry run shows the merged line');
    assert.match(plan.willWrite.find((p: any) => p.record.startsWith('MX')).stops[0], /Some email to @send\.example\.com may go to/);

    const no = failed(await f.o.h('email.setup', { domain: 'example.com' }));
    assert.equal(no.code, 'confirm_email');
    assert.match(no.message, /replaceMail/);
    assert.deepEqual(zoneOf(f.cf.st.recs, 'send.example.com', 'MX').map((x) => x.content), ['bounce.oldsender.example'], 'the old sender’s record is left alone');

    const yes = ok(await f.o.h('email.setup', { domain: 'example.com', replaceMail: true }));
    assert.equal(yes.ready, true);
    assert.deepEqual(zoneOf(f.cf.st.recs, 'send.example.com', 'MX').map((x) => x.content).sort(), ['bounce.oldsender.example', SES_MX]);
    assert.deepEqual(zoneOf(f.cf.st.recs, 'send.example.com', 'TXT').map((x) => x.content), ['v=spf1 include:_spf.oldsender.example include:amazonses.com -all'], 'one line, every sender, its strict ending kept');
    assert.deepEqual(zoneOf(f.cf.st.recs, 'example.com', 'MX').map((x) => x.content), ['mx1.mailhost.example'], 'the domain’s own mail never moved');
    assert.deepEqual(zoneOf(f.cf.st.recs, 'example.com', 'TXT').map((x) => x.content), ['v=spf1 include:_spf.mailhost.example ~all']);
  } finally { f.close(); }
});

test('email.setup works on a DNS host with another shape, and says exactly what to add where Unit7 can’t write', async () => {
  const rows: any[] = [{ type: 'TXT', name: 'send', data: 'v=spf1 mx ~all', ttl: 600 }];
  const gd = await fakeApi(({ method, path, body }) => {
    const p = decodeURIComponent(path.split('?')[0]!);
    if (p === '/v1/domains/example.com') return { domain: 'example.com' };
    if (p === '/v1/domains/example.com/records' && method === 'GET') return rows;
    if (p === '/v1/domains/example.com/records' && method === 'PATCH') { rows.push(...JSON.parse(body)); return {}; }
    const m = /^\/v1\/domains\/example\.com\/records\/([A-Z]+)\/(.+)$/.exec(p);
    if (!m) return undefined;
    const here = (r: any) => r.type === m[1] && r.name === m[2];
    if (method === 'GET') return rows.filter(here);
    const others = rows.filter((r) => !here(r));
    rows.length = 0; rows.push(...others);
    if (method === 'PUT') rows.push(...JSON.parse(body).map((r: any) => ({ ...r, type: m[1], name: m[2] })));
    return {};
  });
  const off = setEnv('UNIT7_GODADDY_API', gd.base);
  const f = await sendable([], {}, 'godaddy');
  try {
    account(f.app, f.o.orgId, 'godaddy', 'gd-pat-token-123456');
    const r = ok(await f.o.h('email.setup', { domain: 'example.com' }));
    assert.equal(r.ready, true);
    assert.deepEqual(rows.filter((x) => x.type === 'TXT' && x.name === 'send').map((x) => x.data), ['v=spf1 mx include:amazonses.com ~all']);
    assert.deepEqual(rows.filter((x) => x.type === 'MX').map((x) => [x.name, x.data, x.priority]), [['send', SES_MX, 10]]);
    assert.deepEqual(rows.filter((x) => x.name === 'resend._domainkey').map((x) => x.data), [DKIM]);
  } finally { f.close(); gd.close(); off(); }

  const g = await sendable([], {}, 'namecheap');
  try {
    g.dns['TXT send.example.com'] = ['v=spf1 mx ~all'];
    const r = ok(await g.o.h('email.setup', { domain: 'example.com' }));
    assert.equal(r.ready, false);
    assert.equal(r.dns, 'needs you');
    assert.match(r.why, /namecheap, which Unit7 can’t edit/);
    assert.deepEqual(r.addThese, [{ type: 'TXT', name: 'resend._domainkey.example.com', value: DKIM }, { type: 'MX', name: 'send.example.com', value: SES_MX, priority: 10 }, { type: 'TXT', name: 'send.example.com', value: 'v=spf1 mx include:amazonses.com ~all' }], 'the SPF merged with what public DNS shows');
    assert.equal(g.rs.st.verifies, 0);
    assert.equal(g.app.vault.has(g.o.orgId, 'credential://smtp/example-com/password'), false);
  } finally { g.close(); }
});

test('email.setup: a subdomain’s records land under it, Resend taking time or failing says so, and a send-only key says what to do', async () => {
  const f = await sendable([], { sub: '.mail' });
  try {
    const r = ok(await f.o.h('email.setup', { domain: 'mail.example.com' }));
    assert.deepEqual(r.wrote.map((x: string) => x.split(' ')[1]), ['resend._domainkey.mail.example.com', 'send.mail.example.com', 'send.mail.example.com']);
  } finally { f.close(); }

  const slow = await sendable([], { verifyAfter: 1000 });
  try {
    const r = ok(await slow.o.h('email.setup', { domain: 'example.com' }));
    assert.equal(r.ready, false);
    assert.equal(r.resend, 'pending');
    assert.match(r.next, /Run this again to finish/);
    assert.equal(slow.rs.st.keys.length, 0, 'no key before the domain is proven');
  } finally { slow.close(); }

  const bad = await sendable([], { verifyAfter: 1, ends: 'failed' });
  try {
    const r = ok(await bad.o.h('email.setup', { domain: 'example.com' }));
    assert.match(r.why, /Resend couldn’t find TXT resend\._domainkey, MX send, TXT send/);
  } finally { bad.close(); }

  const only = await sendable([], { refuse: [401, { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }] });
  try {
    const e = failed(await only.o.h('email.setup', { domain: 'example.com' }));
    assert.match(e.message, /Full access key/);
    assert.equal(all<{ status: string }>(only.app.db, `SELECT status FROM accounts WHERE provider = 'resend'`)[0]!.status, 'verified', 'a key that sends is still a good key');
  } finally { only.close(); }

  const typo = await sendable();
  try {
    run(typo.app.db, 'DELETE FROM accounts WHERE id = ?', typo.resendAcc);
    account(typo.app, typo.o.orgId, 'resend', `${FULL_KEY}’`);
    assert.match(failed(await typo.o.h('email.setup', { domain: 'example.com' })).message, /stray character/);
  } finally { typo.close(); }
  const quota = await sendable([], { refuse: [403, { name: 'validation_error', message: 'You have reached your domain limit.' }] });
  try {
    const e = failed(await quota.o.h('email.setup', { domain: 'example.com' }));
    assert.match(e.message, /Resend: You have reached your domain limit/);
    assert.equal(all<{ status: string }>(quota.app.db, `SELECT status FROM accounts WHERE provider = 'resend'`)[0]!.status, 'verified', 'a plan limit isn’t a dead key');
  } finally { quota.close(); }
});

test('email.setup with no sender says which free one to connect, and how', async () => {
  const app = testApp(), o = await testOrg(app);
  world('cloudflare');
  const r = ok(await o.a('email.setup', { domain: 'example.com' }));
  assert.equal(r.connected, false);
  assert.equal(r.connect.name, 'Resend');
  assert.match(r.connect.free, /3,000 emails a month/);
  assert.match(r.connect.how, /Connections → Resend/);
  assert.match(r.orBring, /Any SMTP host/);
  assert.equal(CATALOG.find((p) => p.id === 'resend')!.alt?.keyUrl, 'https://resend.com/api-keys', 'a key works as well as the one-click sign-in');
});

test('email.setup through the one-click sign-in reads the plain text Resend’s MCP server answers in', async () => {
  const cf = await cloudflareFake(), calls: string[] = [];
  const head = (status: string) => `Name: example.com\nID: dom-mcp-1\nStatus: ${status}\nRegion: us-east-1\nSending: enabled\nReceiving: disabled\nOpen Tracking: false\nClick Tracking: false\nCreated at: 2026-11-06`;
  const recs = `DKIM (TXT):\n  Name: resend._domainkey\n  Value: ${DKIM}\n  TTL: Auto\n  Status: not_started\n\nSPF (MX):\n  Name: send\n  Value: ${SES_MX}\n  TTL: Auto\n  Status: not_started\n  Priority: 10\n\nSPF (TXT):\n  Name: send\n  Value: ${SES_SPF}\n  TTL: Auto\n  Status: not_started`;
  let status = 'not_started', created = false;
  // text blocks, as the real server sends them (resend/resend-mcp, src/tools/domains.ts and apiKeys.ts)
  const answer = (tool: string, args: any): string[] => {
    calls.push(tool);
    if (tool === 'list-domains') return created ? ['Found 1 domain(s):', head(status)] : ['No domains found.'];
    if (tool === 'create-domain') { created = true; return ['Domain created successfully.', head(status), `DNS Records to configure:\n${recs}`, 'Show these to the user, then run verify-domain.']; }
    if (tool === 'get-domain') return [head(status), `DNS Records:\n${recs}`];
    if (tool === 'verify-domain') { status = 'verified'; return ['Domain verification started. The domain status will update once DNS records are verified.', `ID: ${args.id}`]; }
    if (tool === 'create-api-key') { assert.deepEqual(args, { name: 'Unit7 example.com', permission: 'sending_access', domainId: 'dom-mcp-1' }); return ['API key created successfully.', `Name: x\nID: y\nToken: ${SEND_KEY}`, 'Save this token now: it is shown only once.']; }
    throw new Error(`no ${tool}`);
  };
  const mcp = await fakeApi(({ body }) => {
    const m = JSON.parse(body), reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {} });
    if (m.id === undefined) return [202, {}];
    if (m.method === 'tools/list') return reply({ tools: ['list-domains', 'create-domain', 'get-domain', 'verify-domain', 'create-api-key'].map((name) => ({ name })) });
    return reply({ content: answer(m.params.name, m.params.arguments).map((text) => ({ type: 'text', text })) });
  });
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'cloudflare', 'cf-demo-token');
    const acc = account(app, o.orgId, 'resend', 'unused'), ref = 'credential://resend/one-click/oauth';
    run(app.db, 'UPDATE accounts SET meta = ? WHERE id = ?', JSON.stringify({ ref, auth: 'oauth', mcpUrl: `${mcp.base}/mcp` }), acc);
    app.vault.put(o.orgId, ref, JSON.stringify({ access_token: 'oauth-access-token', expires_at: Date.now() + 3_600_000 }), { kind: 'oauth', accountId: acc });
    world('cloudflare');
    const r = ok(await o.h('email.setup', { domain: 'example.com' }));
    assert.equal(r.ready, true);
    assert.deepEqual(r.wrote.map((x: string) => x.split(' ').slice(0, 2).join(' ')), ['TXT resend._domainkey.example.com', 'MX send.example.com', 'TXT send.example.com']);
    assert.deepEqual(zoneOf(cf.st.recs, 'send.example.com', 'MX').map((x) => x.priority), [10]);
    assert.equal(app.vault.resolve(o.orgId, r.sender.stored), SEND_KEY);
    assert.deepEqual(calls.slice(0, 2), ['list-domains', 'create-domain']);
  } finally { mcp.close(); cf.close(); }
});

test('bringing your own SMTP host: the password goes straight into the vault, and an AI never holds it', async () => {
  const PASSWORD = 'My-Sm7p-Passw0rd-from-a-person';
  const cf = await cloudflareFake([{ id: 'spf', type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.google.com ~all', ttl: 1 }]);
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'cloudflare', 'cf-demo-token');
    const dns = world('cloudflare');
    const given = { domain: 'example.com', smtpHost: 'smtp.mailhost.example', smtpPort: 2525, smtpUser: 'mailer@example.com', spfInclude: '_spf.mailhost.example' };
    assert.match(failed(await o.h('email.setup', { domain: 'example.com', smtpHost: 'smtp.mailhost.example' })).message, /together/);

    // an AI can't type a password, and asking doesn't leave it anywhere
    const denied = await o.a('email.setup', { ...given, smtpPassword: PASSWORD });
    assert.equal(denied.status, 'denied');
    assert.match((denied as any).why, /An AI never handles a password/);
    assert.ok(!everywhere(app).includes(PASSWORD));
    assert.equal(app.vault.has(o.orgId, 'credential://smtp/example-com/password'), false);

    const r = ok(await o.h('email.setup', { ...given, smtpPassword: PASSWORD, from: 'hello@example.com' }));
    assert.equal(r.ready, true);
    assert.deepEqual(r.sender, { host: 'smtp.mailhost.example', port: 2525, user: 'mailer@example.com', from: 'hello@example.com', via: 'your SMTP host', stored: 'credential://smtp/example-com/password' });
    assert.equal(app.vault.resolve(o.orgId, r.sender.stored), PASSWORD);
    assert.ok(!everywhere(app).includes(PASSWORD), 'not in audit, events or the output');
    assert.deepEqual(zoneOf(cf.st.recs, 'example.com', 'TXT').map((x) => x.content), ['v=spf1 include:_spf.google.com include:_spf.mailhost.example ~all'], 'joined to what was there');
    assert.match(r.next, /Unit7 didn’t try the login/);

    // a login someone brought stays, Resend connected or not
    const rs = await resendFake();
    try {
      account(app, o.orgId, 'resend', FULL_KEY);
      const kept = ok(await o.h('email.setup', { domain: 'example.com' }));
      assert.equal(kept.sender.host, 'smtp.mailhost.example');
      assert.match(kept.next, /replaceMail moves it to Resend/);
      assert.equal(rs.st.domains.length, 0);
      run(app.db, `DELETE FROM accounts WHERE provider = 'resend'`);
    } finally { rs.close(); }

    // what an AI can read of it: the host, never the password
    dns['TXT example.com'] = ['v=spf1 include:_spf.google.com include:_spf.mailhost.example ~all'];
    const seen = JSON.stringify([ok(await o.a('email.check', { domain: 'example.com' })), ok(await o.a('vault.list', {}))]);
    assert.match(seen, /smtp\.mailhost\.example/);
    assert.ok(!seen.includes(PASSWORD));
    assert.equal((await o.a('vault.set', { ref: 'credential://smtp/example-com/password', value: 'x' })).status, 'denied');

    // an AI may pass a reference a person made, but never one of Unit7's own keys or a connected account's token
    app.vault.put(o.orgId, 'credential://generic/mine/smtp', 'stored-by-a-person', { by: 'Ada' });
    const ref = await o.a('email.setup', { ...given, domain: 'shop.example.com', spfInclude: undefined, smtpPassword: 'credential://generic/mine/smtp' }, { approvalId: undefined });
    assert.equal(ok(ref).ready, true);
    assert.equal(app.vault.resolve(o.orgId, 'credential://smtp/shop-example-com/password'), 'stored-by-a-person');
    assert.ok(!JSON.stringify(ref).includes('stored-by-a-person'));
    app.vault.put(o.orgId, 'credential://ntfy/phone/topic', 'approve-codes-go-here', { by: 'Ada' });
    const fresh = { ...given, domain: 'new.example.com', spfInclude: undefined };
    assert.match(failed(await o.a('email.setup', { ...fresh, smtpPassword: 'credential://ntfy/phone/topic' })).message, /one of Unit7's own keys/);
    const cfRef = all<{ meta: string }>(app.db, `SELECT meta FROM accounts WHERE provider = 'cloudflare'`)[0]!, token = JSON.parse(cfRef.meta).ref;
    assert.match(failed(await o.a('email.setup', { ...fresh, smtpPassword: token })).message, /isn't bound to this environment/);
    // and a login already in use is a person's to change, as any credential is
    assert.match(failed(await o.a('email.setup', { ...given, smtpHost: 'smtp.somewhere-else.example', smtpPassword: 'credential://generic/mine/smtp' })).message, /Only a person can change it/);
    assert.equal(ok(await o.a('email.check', { domain: 'example.com' })).sender.host, 'smtp.mailhost.example');
  } finally { cf.close(); }
});

test('domain.protect_email says the whole SPF line, with what is there kept in it', async () => {
  const cf = await cloudflareFake();
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'cloudflare', 'cf-demo-token');
    world('cloudflare', { 'MX example.com': ['1 aspmx.l.google.com'], 'TXT example.com': ['v=spf1 include:_spf.example.net ~all'] });
    const r = ok(await o.h('domain.protect_email', { domain: 'example.com' }));
    assert.equal(r.dmarc, 'v=DMARC1; p=none');
    assert.match(r.spf, /"v=spf1 include:_spf\.example\.net include:_spf\.google\.com ~all"/);
    assert.match(r.spf, /keeps every sender already there/);
    world('cloudflare', {});
    assert.match(ok(await o.h('domain.protect_email', { domain: 'example.com' })).spf, /"v=spf1 -all".*sends no email/);
    world('cloudflare', { 'TXT example.com': ['v=spf1 mx ~all'] });
    assert.equal(ok(await o.h('domain.protect_email', { domain: 'example.com' })).spf, undefined, 'nothing to add');
  } finally { cf.close(); }
});

// --- email.connect_app: a stand-in Coolify with an app and a self-hosted Supabase ------------------------------------------
const PASSWORD = 'My-Sm7p-Passw0rd-from-a-person', REF = 'abcdefghijklmnop12';
const WIRED: Record<string, string> = { ADDITIONAL_REDIRECT_URLS: 'GOTRUE_URI_ALLOW_LIST', GOTRUE_SITE_URL: 'GOTRUE_SITE_URL', API_EXTERNAL_URL: 'API_EXTERNAL_URL', SMTP_HOST: 'GOTRUE_SMTP_HOST', SMTP_PORT: 'GOTRUE_SMTP_PORT', SMTP_USER: 'GOTRUE_SMTP_USER', SMTP_ADMIN_EMAIL: 'GOTRUE_SMTP_ADMIN_EMAIL' };
function standIn(app: App, o: { appEnvs?: Record<string, string>; hardWired?: string[]; deploy?: string } = {}) {
  const envs: Record<string, Map<string, { value: string; literal?: boolean }>> = {
    shopapp01: new Map(Object.entries(o.appEnvs ?? {}).map(([k, value]) => [k, { value }])),
    shopsupa01: new Map([['ADDITIONAL_REDIRECT_URLS', { value: 'https://old.example.com' }], ['SMTP_HOST', { value: '' }], ['SMTP_PORT', { value: '2500' }], ['SMTP_USER', { value: 'fake' }], ['SMTP_PASS', { value: 'fake-password' }], ['SMTP_ADMIN_EMAIL', { value: 'admin@example.com' }], ['API_EXTERNAL_URL', { value: 'http://supabase-kong:8000' }]]),
  };
  const live: Record<string, string> = { GOTRUE_DISABLE_SIGNUP: 'false', GOTRUE_URI_ALLOW_LIST: 'https://old.example.com', GOTRUE_SITE_URL: 'http://localhost:3000', API_EXTERNAL_URL: 'http://supabase-kong:8000', GOTRUE_SMTP_HOST: 'supabase-mail', GOTRUE_SMTP_PORT: '2500', GOTRUE_SMTP_USER: 'fake', GOTRUE_SMTP_ADMIN_EMAIL: 'admin@example.com', GOTRUE_EXTERNAL_GOOGLE_ENABLED: 'true', GOTRUE_EXTERNAL_GITHUB_ENABLED: 'false' };
  const seen = { commands: [] as string[], api: [] as { method: string; path: string; body?: any }[], deploys: 0 };
  ssh(app).exec = async (_s, command, opt: ExecOptions = {}) => {
    seen.commands.push(command);
    if (command === CURL) {
      const stdin = String(opt.stdin), url = new URL(/^url = "(.*)"$/m.exec(stdin)![1]!), method = /^request = "(.*)"$/m.exec(stdin)![1]!;
      const raw = /^data-binary = "(.*)"$/m.exec(stdin)?.[1], body = raw ? JSON.parse(raw.replace(/\\(.)/g, '$1')) : undefined;
      const path = url.pathname.replace('/api/v1', ''), r = `${method} ${path}`;
      seen.api.push({ method, path, body });
      const send = (status: number, b: unknown) => ({ code: 0, stdout: `${JSON.stringify(b)}\n${status}`, stderr: '', truncated: false });
      const m = /^(GET|POST|PATCH) \/(?:applications|services)\/(\w+)\/envs$/.exec(r);
      if (m?.[1] === 'GET') return send(200, [...envs[m[2]!]!].map(([key], n) => ({ uuid: `env${n}`, key, is_preview: false })));
      if (m) { envs[m[2]!]!.set(body.key, { value: body.value, literal: body.is_literal }); return send(201, { uuid: 'e' }); }
      const del = /^DELETE \/(?:applications|services)\/(\w+)\/envs\/env(\d+)$/.exec(r);
      if (del) { envs[del[1]!]!.delete([...envs[del[1]!]!.keys()][Number(del[2])]!); return send(200, {}); }
      if (r === 'POST /deploy') {
        seen.deploys++;
        for (const [k, v] of Object.entries(WIRED)) if (!o.hardWired?.includes(k) && envs.shopsupa01!.has(k)) live[v] = envs.shopsupa01!.get(k)!.value;
        return send(200, { deployments: [{ message: 'Deploying', resource_uuid: url.searchParams.get('uuid'), ...(url.searchParams.get('uuid') === 'shopapp01' && { deployment_uuid: 'd1' }) }] });
      }
      if (r === 'GET /deployments/d1') return send(200, { status: o.deploy ?? 'finished' });
      if (r === 'GET /services/shopsupa01') return send(200, { status: 'running:healthy' });
      return send(404, { message: 'Not found.' });
    }
    if (command.includes('@@unit7:keys')) {
      const lines = Object.entries(live).filter(([k]) => command.includes(`"${k}"`)).map(([k, v]) => `/supabase-auth-shopsupa01|${JSON.stringify(`${k}=${v}`)}`);
      return { code: 0, stdout: `\n@@unit7:keys\n${lines.join('\n')}\n`, stderr: '', truncated: false };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return { envs, live, seen };
}
function onServer(host = COOLIFY_HOST, change?: (inv: Inventory) => void) {
  return (async () => {
    const app = testApp(), o = await testOrg(app), srv = id('srv'), inv = buildInventory(host);
    change?.(inv);
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', ?)`, srv, o.orgId, JSON.stringify({ sudo: 'root' }));
    saveXray(app.db, o.orgId, srv, 'fast', inv);
    const coolify = account(app, o.orgId, 'coolify', '3|unit7testtokenAbC123xyz', 'Coolify on box');
    run(app.db, `UPDATE accounts SET meta = json_set(meta, '$.serverId', ?, '$.facts', json(?)) WHERE id = ?`, srv, JSON.stringify({ abilities: ['read', 'write', 'deploy'] }), coolify);
    app.vault.put(o.orgId, 'credential://smtp/example-com/password', PASSWORD, { kind: 'smtp', meta: { host: 'smtp.mailhost.example', port: 2525, user: 'mailer', from: 'hello@example.com', via: 'your SMTP host' } });
    return { app, o, srv };
  })();
}

test('email.connect_app into a Coolify app: the password comes from the vault, a redeploy once, and Undo takes it out', async () => {
  const { app, o, srv } = await onServer(), c = standIn(app);
  run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId);
  const asked = await o.a('email.connect_app', { domain: 'example.com', serverId: srv, uuid: 'shopapp01' });
  assert.equal(asked.status, 'approval_required', 'an AI asks first, even at full autopilot');
  assert.match((asked as any).why, /can send as the domain/);
  assert.equal(c.envs.shopapp01!.size, 0);
  const viaAi = await decideApproval(app, o.orgId, o.human, (asked as any).approvalId, true);
  assert.equal(viaAi.status, 'ok', JSON.stringify(viaAi));
  assert.ok(!JSON.stringify(viaAi).includes(PASSWORD));
  assert.equal(c.envs.shopapp01!.get('SMTP_PASS')!.value, PASSWORD);
  c.envs.shopapp01!.clear(); c.seen.deploys = 0;

  const r = ok(await o.h('email.connect_app', { domain: 'example.com', serverId: srv, uuid: 'shopapp01' }));
  assert.equal(r.connected, true);
  assert.deepEqual(r.set, ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
  const e = c.envs.shopapp01!;
  assert.deepEqual([e.get('SMTP_HOST')!.value, e.get('SMTP_PORT')!.value, e.get('SMTP_USER')!.value, e.get('SMTP_FROM')!.value], ['smtp.mailhost.example', '2525', 'mailer', 'hello@example.com']);
  assert.equal(e.get('SMTP_PASS')!.value, PASSWORD, 'the app gets the real value');
  assert.equal(e.get('SMTP_PASS')!.literal, true, 'a $ in a password stays a $');
  assert.equal(c.seen.deploys, 1);
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  assert.ok(!everywhere(app).includes(PASSWORD), 'not in audit, events or the undo');

  ok(await o.h('change.undo', { changeId: r.changeId }));
  assert.equal(e.size, 0);
  assert.equal(c.seen.deploys, 2);
});

test('email.connect_app into an app with mail settings of its own: its names are used, and nothing changes without a yes', async () => {
  const { app, o, srv } = await onServer(), c = standIn(app, { appEnvs: { MAIL_HOST: 'smtp.old.example', MAIL_PASSWORD: 'the-old-one', DATABASE_URL: 'postgres://db' } });
  const no = failed(await o.h('email.connect_app', { domain: 'example.com', serverId: srv, uuid: 'shopapp01' }));
  assert.equal(no.code, 'confirm_needed');
  assert.match(no.message, /already has MAIL_HOST, MAIL_PASSWORD/);
  assert.equal(c.envs.shopapp01!.get('MAIL_HOST')!.value, 'smtp.old.example');
  assert.equal(c.seen.deploys, 0);

  const r = ok(await o.h('email.connect_app', { domain: 'example.com', serverId: srv, uuid: 'shopapp01', replace: true, redeploy: false, from: 'shop@example.com' }));
  assert.deepEqual(r.set, ['MAIL_HOST', 'SMTP_PORT', 'SMTP_USER', 'MAIL_PASSWORD', 'SMTP_FROM']);
  assert.deepEqual(r.replaced, ['MAIL_HOST', 'MAIL_PASSWORD']);
  assert.equal(c.envs.shopapp01!.get('MAIL_PASSWORD')!.value, PASSWORD);
  assert.equal(c.envs.shopapp01!.get('SMTP_FROM')!.value, 'shop@example.com');
  assert.equal(c.envs.shopapp01!.get('DATABASE_URL')!.value, 'postgres://db', 'what isn’t mail stays');
  assert.equal(c.seen.deploys, 0);
  assert.match(r.note, /next deploy/);
  assert.match(r.undo, /keep their new values/);
  assert.equal(failed(await o.h('email.connect_app', { domain: 'example.com', serverId: srv, uuid: 'shopapp01', from: 'x@elsewhere.example' })).code, 'invalid_input');
  assert.equal(failed(await o.h('email.connect_app', { domain: 'example.com', ref: REF, serverId: srv, uuid: 'shopapp01' })).code, 'invalid_input', 'one target');
  assert.equal(failed(await o.h('email.connect_app', { domain: 'other.example', serverId: srv, uuid: 'shopapp01' })).code, 'no_sender');
});

test('a failed deploy says so, with the settings left in', async () => {
  const { app, o, srv } = await onServer();
  standIn(app, { deploy: 'failed' });
  const r = ok(await o.h('email.connect_app', { domain: 'example.com', serverId: srv, uuid: 'shopapp01' }));
  assert.equal(r.connected, false);
  assert.match(r.why, /deploy failed/);
});

test('email.connect_app into self-hosted Supabase: GOTRUE_SMTP settings by the stack’s own names, an AI’s asks first and shows only the reference', async () => {
  const { app, o, srv } = await onServer(), c = standIn(app);
  const asked = ok(await o.a('email.connect_app', { domain: 'example.com', serverId: srv, part: 'shop-supabase' }));
  assert.equal(asked.connected, false);
  assert.match(asked.waiting, /Approvals/);
  assert.equal(c.seen.deploys, 0);
  const card = all<{ id: string; input: string }>(app.db, `SELECT id, input FROM approvals WHERE tool = 'supabase.auth' AND status = 'pending'`)[0]!;
  assert.deepEqual(viewInput(card.input).smtpPass, 'credential://smtp/example-com/password', 'the approver sees the reference');
  assert.ok(!everywhere(app).includes(PASSWORD));

  const done = await decideApproval(app, o.orgId, o.human, card.id, true);
  assert.equal(done.status, 'ok', JSON.stringify(done));
  assert.equal(c.envs.shopsupa01!.get('SMTP_HOST')!.value, 'smtp.mailhost.example');
  assert.equal(c.envs.shopsupa01!.get('SMTP_PASS')!.value, PASSWORD);
  assert.equal(c.envs.shopsupa01!.get('SMTP_PORT')!.value, '2525');
  assert.equal(c.envs.shopsupa01!.get('SMTP_ADMIN_EMAIL')!.value, 'hello@example.com');
  assert.equal(c.live.GOTRUE_SMTP_HOST, 'smtp.mailhost.example');
  assert.equal(c.seen.deploys, 1);
  assert.ok(!everywhere(app).includes(PASSWORD));

  // now it has a real sender: another one is a yes
  app.vault.put(o.orgId, 'credential://smtp/shop-example-com/password', 'other', { kind: 'smtp', meta: { host: 'smtp.other.example', user: 'u' } });
  assert.equal(failed(await o.h('email.connect_app', { domain: 'shop.example.com', serverId: srv, part: 'shop-supabase' })).code, 'confirm_needed');
  ok(await o.h('email.connect_app', { domain: 'shop.example.com', serverId: srv, part: 'shop-supabase', replace: true }));
  assert.equal(c.live.GOTRUE_SMTP_HOST, 'smtp.other.example');

  const hard = await onServer(), h = standIn(hard.app, { hardWired: ['SMTP_HOST'] });
  const stuck = ok(await hard.o.h('email.connect_app', { domain: 'example.com', serverId: hard.srv, part: 'shop-supabase' }));
  assert.equal(stuck.connected, false);
  assert.match(stuck.why, /Compose file/);
  assert.equal(h.envs.shopsupa01!.get('SMTP_HOST')!.value, 'supabase-mail', 'put back to what ran');
});

async function hostedSupabase(auth: Record<string, unknown>) {
  const st = { auth };
  const f = { st, custom: undefined as unknown, projects: [] as unknown[] };
  const api = await fakeApi(({ method, path, body }) => {
    if (path === '/v1/projects') return f.projects;
    if (path === `/v1/projects/${REF}/config/auth` && method === 'GET') return st.auth;
    if (path === `/v1/projects/${REF}/config/auth` && method === 'PATCH') { Object.assign(st.auth, JSON.parse(body)); return st.auth; }
    if (path === `/v1/projects/${REF}/custom-hostname`) return f.custom ?? [404, { message: 'none' }];
  });
  const off = setEnv('UNIT7_SUPABASE_API', `${api.base}/v1`);
  return Object.assign(f, { api, close: () => { api.close(); off(); } });
}

test('email.connect_app into hosted Supabase: through supabase.auth, with the sender’s limits said, and an existing sender kept unless replaced', async () => {
  const s = await hostedSupabase({ site_url: 'http://localhost:3000', uri_allow_list: '', smtp_host: '', external_google_enabled: true });
  try {
    const { app, o } = await onServer();
    account(app, o.orgId, 'supabase', `sbp_${'a1'.repeat(20)}`, 'Supabase');
    const r = ok(await o.h('email.connect_app', { domain: 'example.com', ref: REF, senderName: 'Shop' }));
    assert.equal(r.connected, true);
    assert.match(r.note, /30 emails an hour/);
    assert.deepEqual([s.st.auth.smtp_host, s.st.auth.smtp_port, s.st.auth.smtp_user, s.st.auth.smtp_admin_email, s.st.auth.smtp_sender_name], ['smtp.mailhost.example', '2525', 'mailer', 'hello@example.com', 'Shop']);
    assert.equal(s.st.auth.smtp_pass, PASSWORD);
    assert.ok(!JSON.stringify(r).includes(PASSWORD) && !everywhere(app).includes(PASSWORD));

    Object.assign(s.st.auth, { smtp_host: 'smtp.theirs.example' });
    assert.equal(failed(await o.h('email.connect_app', { domain: 'example.com', ref: REF })).code, 'confirm_needed');
    assert.equal(s.st.auth.smtp_host, 'smtp.theirs.example');
    ok(await o.h('change.undo', { changeId: r.changeId }));
    assert.equal(s.st.auth.smtp_host, '', 'Undo puts the old settings back');
  } finally { s.close(); }
});

// --- email.forward -----------------------------------------------------------------------------------------------------------
const HELLO = { from: 'hello@example.com', to: 'ada@inbox.example' };
async function forwardable(recs: any[] = []) {
  const cf = await cloudflareFake(recs), app = testApp(), o = await testOrg(app);
  account(app, o.orgId, 'cloudflare', 'cf-demo-token');
  world('cloudflare');
  const clicked = () => { cf.st.addresses[0].verified = '2026-11-06T10:00:00Z'; };
  return { app, o, cf, clicked, close: cf.close };
}
const mxOf = (f: { cf: { st: { recs: any[] } } }) => zoneOf(f.cf.st.recs, 'example.com', 'MX').map((r) => `${r.priority} ${r.content}`).sort();

test('email.forward: the inbox proves itself first, then the rule, the records and the switch, and Undo takes it all back', async () => {
  const f = await forwardable();
  try {
    const dry = (await f.o.h('email.forward', HELLO, { dryRun: true }) as any).plan;
    assert.equal(dry.inbox, 'Cloudflare emails it a link to click');
    assert.deepEqual(dry.willWrite.map((p: any) => p.record), ['MX example.com → 13 route1.mx.cloudflare.net', 'MX example.com → 86 route2.mx.cloudflare.net', 'TXT example.com → v=spf1 include:_spf.mx.cloudflare.net ~all']);
    assert.equal(f.cf.st.addresses.length, 0, 'a dry run sends no email');

    const first = ok(await f.o.h('email.forward', HELLO));
    assert.equal(first.forwarded, false);
    assert.equal(first.waiting, 'inbox');
    assert.match(first.note, /sent a link to ada@inbox\.example/);
    assert.match(first.note, /Nothing about example\.com’s mail has changed/);
    assert.deepEqual([f.cf.st.addresses.map((a) => a.email), f.cf.st.rules.length, f.cf.st.recs.length, f.cf.st.enabled], [['ada@inbox.example'], 0, 0, false]);

    assert.match(ok(await f.o.h('email.forward', HELLO)).note, /already sent a link/);
    assert.equal(f.cf.st.addresses.length, 1, 'one email is enough');

    f.clicked();
    const done = ok(await f.o.h('email.forward', HELLO));
    assert.equal(done.forwarded, true);
    assert.deepEqual(f.cf.st.rules.map((r) => [r.matchers[0], r.actions[0], r.enabled]), [[{ type: 'literal', field: 'to', value: 'hello@example.com' }, { type: 'forward', value: ['ada@inbox.example'] }, true]]);
    assert.deepEqual(mxOf(f), ['13 route1.mx.cloudflare.net', '86 route2.mx.cloudflare.net']);
    assert.deepEqual(f.cf.st.mxWhenOn, ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'], 'the records were in, through dns.set, before the switch');
    assert.equal(done.changes.length, 3);

    const again = ok(await f.o.h('email.forward', HELLO));
    assert.equal(again.forwarded, true);
    assert.equal(again.changeId, undefined, 'nothing to change, nothing to undo');
    assert.equal(f.cf.st.rules.length, 1);

    ok(await f.o.h('change.undo', { changeId: done.changeId }));
    assert.deepEqual([f.cf.st.rules.length, f.cf.st.enabled, f.cf.st.recs.length], [0, false, 0]);
  } finally { f.close(); }
});

test('email.forward with mail already going somewhere: nothing changes without a yes, the old host’s SPF stays, and Undo brings it all back', async () => {
  const f = await forwardable([{ id: 'mx1', type: 'MX', name: 'example.com', content: 'mx1.mailhost.example', priority: 10, ttl: 1 }, { id: 'mx2', type: 'MX', name: 'example.com', content: 'mx2.mailhost.example', priority: 20, ttl: 1 }, { id: 'spf', type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.mailhost.example -all', ttl: 1 }]);
  try {
    const no = failed(await f.o.h('email.forward', HELLO));
    assert.equal(no.code, 'confirm_email');
    assert.match(no.message, /goes to mx1\.mailhost\.example, mx2\.mailhost\.example now/);
    assert.match(no.message, /every address/);
    assert.equal(f.cf.st.addresses.length, 0, 'not even the email to the inbox');
    assert.deepEqual(mxOf(f), ['10 mx1.mailhost.example', '20 mx2.mailhost.example']);
    const dry = (await f.o.h('email.forward', { ...HELLO, replaceMail: true }, { dryRun: true }) as any).plan;
    assert.equal(dry.stopsThere, true);
    assert.deepEqual(dry.willWrite[0].replaces, ['MX example.com → 10 mx1.mailhost.example', 'MX example.com → 20 mx2.mailhost.example'], 'the dry run shows what goes');

    ok(await f.o.h('email.forward', { ...HELLO, replaceMail: true }));
    f.clicked();
    const done = ok(await f.o.h('email.forward', { ...HELLO, replaceMail: true }));
    assert.equal(done.forwarded, true);
    assert.match(done.note, /no longer goes to mx1\.mailhost\.example/);
    assert.deepEqual(mxOf(f), ['13 route1.mx.cloudflare.net', '86 route2.mx.cloudflare.net']);
    assert.deepEqual(zoneOf(f.cf.st.recs, 'example.com', 'TXT').map((r) => r.content), ['v=spf1 include:_spf.mailhost.example include:_spf.mx.cloudflare.net -all'], 'one SPF, the old sender in it');

    ok(await f.o.h('change.undo', { changeId: done.changeId }));
    assert.deepEqual(mxOf(f), ['10 mx1.mailhost.example', '20 mx2.mailhost.example']);
    assert.deepEqual(zoneOf(f.cf.st.recs, 'example.com', 'TXT').map((r) => r.content), ['v=spf1 include:_spf.mailhost.example -all']);
    assert.equal(f.cf.st.enabled, false);
  } finally { f.close(); }
});

test('email.forward by an AI: a person says yes once, MX goes through dns.set’s own approval, and existing mail needs the words too', async () => {
  const f = await forwardable();
  try {
    run(f.app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', f.o.orgId);
    const asked = await f.o.a('email.forward', HELLO);
    assert.equal(asked.status, 'approval_required', 'even at full autopilot');
    assert.match((asked as any).why, /Where a domain’s email goes is a person’s call.*ada@inbox\.example.*password resets/);
    assert.equal(f.cf.st.addresses.length, 0);
    const first = await decideApproval(f.app, f.o.orgId, f.o.human, (asked as any).approvalId, true);
    assert.equal(first.status, 'ok', JSON.stringify(first));
    assert.equal((first as any).output.waiting, 'inbox');

    f.clicked();
    const second = ok(await f.o.a('email.forward', HELLO));
    assert.equal(second.forwarded, false);
    assert.equal(second.waiting.length, 3);
    assert.match(second.note, /run this again and forwarding turns on/);
    assert.deepEqual([f.cf.st.recs.length, f.cf.st.enabled], [0, false], 'no MX without dns.set’s approval');
    const asks = all<{ id: string; tool: string }>(f.app.db, `SELECT id, tool FROM approvals WHERE status = 'pending'`);
    assert.deepEqual(asks.map((a) => a.tool), ['dns.set', 'dns.set', 'dns.set']);

    assert.equal(ok(await f.o.a('email.forward', HELLO)).waiting.length, 3);
    assert.equal(all(f.app.db, `SELECT 1 FROM approvals WHERE status = 'pending'`).length, 3, 'asking again files nothing new');
    for (const a of asks) assert.equal((await decideApproval(f.app, f.o.orgId, f.o.human, a.id, true)).status, 'ok');

    const third = ok(await f.o.a('email.forward', HELLO));
    assert.equal(third.forwarded, true);
    assert.equal(f.cf.st.enabled, true);
    assert.deepEqual(mxOf(f), ['13 route1.mx.cloudflare.net', '86 route2.mx.cloudflare.net']);

    // a different inbox is a different forward: a new yes, and the old one isn't replaced unasked
    const other = await f.o.a('email.forward', { ...HELLO, to: 'someone@else.example' });
    assert.equal(other.status, 'approval_required');
    const ruled = await decideApproval(f.app, f.o.orgId, f.o.human, (other as any).approvalId, true);
    assert.equal(ruled.status, 'error');
    assert.match((ruled as any).error.message, /goes to ada@inbox\.example now/);
    assert.deepEqual(f.cf.st.rules[0].actions, [{ type: 'forward', value: ['ada@inbox.example'] }]);
  } finally { f.close(); }
});

test('email.forward moves an address to a new inbox with a yes, and leaves the domain on when others still forward', async () => {
  const f = await forwardable();
  try {
    ok(await f.o.h('email.forward', HELLO));
    f.clicked();
    const first = ok(await f.o.h('email.forward', HELLO));
    f.cf.st.addresses.push({ id: 'a9', email: 'new@inbox.example', verified: '2026-11-06T10:00:00Z' }, { id: 'a8', email: 'sales@inbox.example', verified: '2026-11-06T10:00:00Z' });
    assert.equal(failed(await f.o.h('email.forward', { ...HELLO, to: 'new@inbox.example' })).code, 'confirm_email');
    const moved = ok(await f.o.h('email.forward', { ...HELLO, to: 'new@inbox.example', replaceMail: true }));
    assert.deepEqual(f.cf.st.rules.map((r) => r.actions[0].value[0]), ['new@inbox.example']);
    ok(await f.o.h('change.undo', { changeId: moved.changeId }));
    assert.deepEqual(f.cf.st.rules.map((r) => r.actions[0].value[0]), ['ada@inbox.example'], 'Undo puts the old inbox back');

    ok(await f.o.h('email.forward', { from: 'sales@example.com', to: 'sales@inbox.example' }));
    const off = ok(await f.o.h('change.undo', { changeId: first.changeId }));
    assert.match(off.note, /Other addresses still forward/);
    assert.equal(f.cf.st.enabled, true);
    assert.deepEqual(f.cf.st.rules.map((r) => r.matchers[0].value), ['sales@example.com']);
  } finally { f.close(); }
});

test('email.forward says what to do where it can’t: another DNS host, no account, an old key, odd addresses', async () => {
  const app = testApp(), o = await testOrg(app);
  world('hostinger', { 'MX example.com': ['5 mx1.hostinger.com'] });
  const r = ok(await o.h('email.forward', HELLO));
  assert.equal(r.forwarded, false);
  assert.equal(r.at, 'Hostinger');
  assert.match(r.steps[0], /goes to Hostinger Email now: add a forward from hello@example\.com to ada@inbox\.example there/);
  assert.match(r.steps[1], /domain\.move_dns/);
  world('namecheap');
  assert.match(ok(await o.h('email.forward', HELLO)).steps[0], /Look for email forwarding/);
  world('cloudflare');
  assert.equal(failed(await o.h('email.forward', HELLO)).code, 'no_account');
  assert.match(failed(await o.h('email.forward', { from: 'hello@example.com', to: 'me@example.com' })).message, /another domain/);

  const f = await forwardable();
  try {
    f.cf.st.refused = /email\/routing/;
    const e = failed(await f.o.h('email.forward', HELLO));
    assert.equal(e.code, 'cloudflare_key');
    assert.match(e.message, /Email Routing Addresses: Edit/);
    assert.equal(all<{ status: string }>(f.app.db, `SELECT status FROM accounts WHERE provider = 'cloudflare'`)[0]!.status, 'verified', 'the key still does everything else');
    f.cf.st.refused = undefined;
    assert.match(failed(await f.o.h('email.forward', { from: 'hello@mail.example.com', to: 'me@inbox.example' })).message, /on example\.com itself/);
  } finally { f.close(); }
  assert.match(decodeURIComponent(CATALOG.find((p) => p.id === 'cloudflare')!.method.kind === 'key' ? (CATALOG.find((p) => p.id === 'cloudflare')!.method as { keyUrl: string }).keyUrl : ''), /email_routing_rule/, 'a new key can do this');
});

// --- auth.urls: login on a real domain ----------------------------------------------------------------------------------------
test('auth.urls on a hosted project: the new address, every old one kept, what to paste at Google, and an AI waits', async () => {
  const s = await hostedSupabase({ site_url: 'https://shop-abc.vercel.app', uri_allow_list: 'http://localhost:3000/**,https://staging.example.com/**', external_google_enabled: true, external_github_enabled: false });
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'supabase', `sbp_${'a1'.repeat(20)}`, 'Supabase');
    const dry = (await o.h('auth.urls', { ref: REF, url: 'app.example.com' }, { dryRun: true }) as any).plan;
    assert.equal(dry.site, 'https://app.example.com', 'a bare domain is fine');
    assert.deepEqual(dry.addedToAllowed, ['https://shop-abc.vercel.app/**', 'https://app.example.com/**']);
    assert.equal(s.st.auth.site_url, 'https://shop-abc.vercel.app', 'a dry run changes nothing');

    const asked = ok(await o.a('auth.urls', { ref: REF, url: 'https://app.example.com/dashboard' }));
    assert.equal(asked.changed, false);
    assert.match(asked.waiting, /Approvals/);
    assert.equal(asked.byHand.length, 1, 'what’s by hand is said either way');
    const card = all<{ id: string }>(app.db, `SELECT id FROM approvals WHERE tool = 'supabase.auth' AND status = 'pending'`)[0]!;
    assert.equal((await decideApproval(app, o.orgId, o.human, card.id, true)).status, 'ok');
    assert.equal(s.st.auth.site_url, 'https://app.example.com');
    assert.equal(s.st.auth.uri_allow_list, 'http://localhost:3000/**,https://staging.example.com/**,https://shop-abc.vercel.app/**,https://app.example.com/**');

    const after = ok(await o.h('auth.urls', { ref: REF, url: 'https://app.example.com' }));
    assert.equal(after.changed, false, 'already right');
    assert.equal(after.callback, `https://${REF}.supabase.co/auth/v1/callback`);
    assert.deepEqual(after.byHand.map((b: any) => b.where), ['Google sign-in'], 'only what’s turned on');
    assert.deepEqual(after.byHand[0].paste, { origin: 'https://app.example.com', redirect: `https://${REF}.supabase.co/auth/v1/callback` });
    assert.match(after.byHand[0].open, /console\.cloud\.google\.com/);

    s.st.auth.external_github_enabled = true;
    s.st.auth.site_url = 'https://old.example.com';
    const moved = ok(await o.h('auth.urls', { ref: REF, url: 'https://new.example.com' }));
    assert.equal(moved.changed, true);
    assert.deepEqual(moved.byHand.map((b: any) => Object.keys(b.paste)), [['origin', 'redirect'], ['homepage', 'callback']]);
    ok(await o.h('change.undo', { changeId: moved.changeId }));
    assert.equal(s.st.auth.site_url, 'https://old.example.com');

    assert.equal(failed(await o.h('auth.urls', { ref: REF, url: 'https://x.example.com', apiUrl: 'https://api.example.com' })).code, 'invalid_input', 'a hosted API address is Supabase’s');
    assert.equal(failed(await o.h('auth.urls', { ref: REF, url: 'ftp://x.example.com' })).code, 'invalid_input');
    assert.equal(failed(await o.h('supabase.auth', { ref: REF, op: 'set', apiUrl: 'https://api.example.com' })).code, 'invalid_input');
  } finally { s.close(); }
});

test('auth.urls on a custom API domain: the callback to paste is that one', async () => {
  const s = await hostedSupabase({ site_url: '', uri_allow_list: '', external_google_enabled: true });
  try {
    s.custom = { status: '5_services_reconfigured', custom_hostname: 'api.example.com' };
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'supabase', `sbp_${'a1'.repeat(20)}`, 'Supabase');
    assert.equal(ok(await o.h('auth.urls', { ref: REF, url: 'https://app.example.com' })).callback, 'https://api.example.com/auth/v1/callback');
  } finally { s.close(); }
});

test('auth.urls on a self-hosted stack: GOTRUE_SITE_URL, the allow list and API_EXTERNAL_URL, a redeploy, and a Compose file that holds them', async () => {
  const { app, o, srv } = await onServer(), c = standIn(app);
  const r = ok(await o.h('auth.urls', { serverId: srv, part: 'shop-supabase', url: 'https://shop.example.com' }));
  assert.equal(r.changed, true);
  assert.equal(c.envs.shopsupa01!.get('GOTRUE_SITE_URL')!.value, 'https://shop.example.com');
  assert.equal(c.envs.shopsupa01!.get('ADDITIONAL_REDIRECT_URLS')!.value, 'https://old.example.com,http://localhost:3000/**,https://shop.example.com/**', 'the stack’s own name for the list');
  assert.equal(c.envs.shopsupa01!.get('API_EXTERNAL_URL')!.value, 'https://api.shop.example.com', 'an inside address can’t be a callback: the stack’s public one from the X-ray');
  assert.equal(c.live.GOTRUE_SITE_URL, 'https://shop.example.com');
  assert.equal(c.seen.deploys, 1);
  assert.equal(r.callback, 'https://api.shop.example.com/auth/v1/callback');
  assert.deepEqual(r.byHand.map((b: any) => b.where), ['Google sign-in'], 'read from the running stack');
  ok(await o.h('change.undo', { changeId: r.changeId }));
  assert.equal(c.envs.shopsupa01!.get('API_EXTERNAL_URL')!.value, 'http://supabase-kong:8000');

  const hard = await onServer(), h = standIn(hard.app, { hardWired: ['GOTRUE_SITE_URL'] });
  const stuck = ok(await hard.o.h('auth.urls', { serverId: hard.srv, part: 'shop-supabase', url: 'https://shop.example.com', apiUrl: 'https://auth.example.com' }));
  assert.equal(stuck.changed, false);
  assert.match(stuck.why, /Compose file/);
  assert.deepEqual(Object.keys(stuck.inCompose), ['GOTRUE_SITE_URL', 'GOTRUE_URI_ALLOW_LIST', 'API_EXTERNAL_URL']);
  assert.equal(stuck.inCompose.API_EXTERNAL_URL, 'https://auth.example.com');
  assert.equal(h.live.GOTRUE_SITE_URL, 'http://localhost:3000', 'nothing half done');

  // no public address at all: it says so instead of giving a callback that can't work
  const none = await onServer(COOLIFY_HOST, (inv) => { inv.parts.find((p) => p.name === 'shop-supabase')!.hosts = []; }), n = standIn(none.app);
  const r2 = ok(await none.o.h('auth.urls', { serverId: none.srv, part: 'shop-supabase', url: 'https://shop.example.com' }));
  assert.equal(r2.callback, undefined);
  assert.match(r2.note, /no public address/);
  assert.equal(n.envs.shopsupa01!.get('API_EXTERNAL_URL')!.value, 'http://supabase-kong:8000');
});

test('domain.point and live.put suggest auth.urls, and only suggest it', async () => {
  const s = await hostedSupabase({ site_url: 'https://old.example.com', uri_allow_list: '' });
  const cf = await cloudflareFake();
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
  addHost({ id: 'test-place', name: 'Test place', builds: true, places: () => [{ host: 'test-place', label: 'Test' }], fit: () => ({ ok: true, why: '', best: true }), put: async (_c, p) => ({ url: `http://127.0.0.1:9/${p.name}`, project: p.name, point: false }) });
  try {
    const app = testApp(), o = await testOrg(app), srv = id('srv');
    run(app.db, `INSERT INTO servers (id, org_id, name, host, username, key_ref, status, facts) VALUES (?, ?, 'box', '203.0.113.9', 'root', 'credential://ssh/box/private-key', 'ready', '{}')`, srv, o.orgId);
    account(app, o.orgId, 'cloudflare', 'cf-demo-token');
    world('cloudflare');
    const before = ok(await o.h('domain.point', { hostname: 'app.example.com', server: { serverId: srv } }));
    assert.equal(before.suggest, undefined, 'nothing to say with no Supabase around');

    account(app, o.orgId, 'supabase', `sbp_${'a1'.repeat(20)}`, 'Supabase');
    const r = ok(await o.h('domain.point', { hostname: 'shop.example.com', server: { serverId: srv } }));
    assert.match(r.suggest, /run auth\.urls with url https:\/\/shop\.example\.com/);
    assert.equal(ok(await o.h('domain.point', { hostname: '*.example.com', server: { serverId: srv } })).suggest, undefined, 'a wildcard isn’t where anyone logs in');
    assert.equal(s.api.calls.length, 0, 'never done by itself');

    const uploadId = await saveUpload(app, o.orgId, o.userId, await packFolder(dir, undefined, { keepBuild: true }));
    const live = ok(await o.h('live.put', { uploadId, to: 'test-place', name: 'shop', domain: 'shop.example.com' }));
    assert.match(live.suggest, /auth\.urls/);
    assert.equal(s.api.calls.length, 0);
  } finally { s.close(); cf.close(); }
});

// --- readiness and the Check-up ---------------------------------------------------------------------------------------------
test('the X-ray sees where GoTrue’s settings point, and nothing else of them', () => {
  const refs = envRefs('', { GOTRUE_SMTP_HOST: 'smtp.resend.com', GOTRUE_SITE_URL: 'https://app.example.com', GOTRUE_SMTP_PASS: 're_secretvalue', API_EXTERNAL_URL: 'http://supabase-kong:8000' });
  assert.deepEqual(refs.map((r) => [r.via, r.host]), [['GOTRUE_SMTP_HOST', 'smtp.resend.com'], ['GOTRUE_SITE_URL', 'app.example.com']]);
  assert.deepEqual(envRefs('', { GOTRUE_SMTP_HOST: 'supabase-mail', GOTRUE_SITE_URL: 'http://localhost:3000' }), [], 'the stand-ins a stack starts with don’t count');
});

const key = (r: { checks: { key: string }[] }, k: string) => r.checks.find((c) => c.key === k) as any;
test('project.readiness on a stack found on a server: sign-up emails and login, each with its fix', async () => {
  const { app, o, srv } = await onServer();
  run(app.db, `INSERT INTO watch (org_id, host, kind, status, detail, value) VALUES (?, 'example.com', 'email', 'ok', 'SPF and DMARC set', 'unsigned')`, o.orgId);
  let r = ok(await o.a('project.readiness', { serverId: srv, found: 'shop' }));
  assert.equal(key(r, 'sender').ok, false);
  assert.match(key(r, 'sender').detail, /can’t leave/);
  assert.deepEqual(key(r, 'sender').fix, { tool: 'email.connect_app', input: { domain: 'example.com', serverId: srv, part: 'coolify:shopsupa01' }, label: 'Connect the sender' }, 'the login is there, so this is the next step');
  assert.equal(key(r, 'login').ok, false);
  assert.deepEqual(key(r, 'login').fix, { ask: 'Make login work on https://shop.example.com for shop-supabase, and tell me what to change at Google or GitHub', label: 'Fix with AI' }, 'it leaves something to paste, which a button can’t say');
  assert.equal(key(r, 'dkim').ok, false);
  assert.match(key(r, 'dkim').detail, /no DKIM key found/);
  assert.match(key(r, 'dkim').fix.ask, /example\.com’s email/);
  { const f = key(r, 'sender').fix; assert.equal(getTool(f.tool)!.input.safeParse(f.input).success, true, 'the fix runs as it stands'); }

  const good = await onServer(COOLIFY_HOST, (inv) => { inv.parts.find((p) => p.name === 'shop-supabase')!.env = [{ via: 'GOTRUE_SMTP_HOST', host: 'smtp.resend.com' }, { via: 'GOTRUE_SITE_URL', host: 'shop.example.com' }]; });
  run(good.app.db, `INSERT INTO watch (org_id, host, kind, status, detail, value) VALUES (?, 'example.com', 'email', 'ok', 'SPF and DMARC set', 'signed')`, good.o.orgId);
  r = ok(await good.o.a('project.readiness', { serverId: good.srv, found: 'shop' }));
  assert.deepEqual([key(r, 'sender').ok, key(r, 'login').ok, key(r, 'dkim').ok], [true, true, true]);
  assert.match(key(r, 'sender').detail, /your own sender/);

  // a site address that's the stack's own API isn't an app, and a domain with no mail has nothing to sign
  const api = await onServer(COOLIFY_HOST, (inv) => { inv.parts.find((p) => p.name === 'shop-supabase')!.env = [{ via: 'GOTRUE_SITE_URL', host: 'api.shop.example.com' }]; });
  run(api.app.db, `INSERT INTO watch (org_id, host, kind, status, detail, value) VALUES (?, 'example.com', 'email', 'ok', 'DMARC rejects', 'silent')`, api.o.orgId);
  r = ok(await api.o.a('project.readiness', { serverId: api.srv, found: 'shop' }));
  assert.equal(key(r, 'login').ok, false);
  assert.equal(key(r, 'dkim'), undefined);
  assert.equal(key(ok(await api.o.a('project.readiness', { serverId: api.srv, found: 'relay' })), 'sender'), undefined, 'a project with no Supabase has no such check');
});

test('project.readiness and the Check-up flag an app on Supabase’s built-in sender, read from the last sync', async () => {
  const s = await hostedSupabase({ smtp_host: '', site_url: 'http://localhost:3000' });
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = account(app, o.orgId, 'supabase', `sbp_${'a1'.repeat(20)}`, 'Supabase');
    s.projects = [{ ref: REF, name: 'shop-db', status: 'ACTIVE_HEALTHY' }];
    ok(await o.h('sync.run', { only: [acc] }).catch(() => ({ status: 'ok', output: {} }) as any));
    const asset = all<{ id: string; meta: string }>(app.db, `SELECT id, meta FROM assets WHERE provider = 'supabase'`)[0]!;
    assert.deepEqual(JSON.parse(asset.meta).auth, { smtp: false, site: 'http://localhost:3000' }, 'a sync reads whether it has its own sender');

    // a project of Unit7's, linked to it
    const prj = ok(await o.h('project.create', { name: 'Shop' })), env = all<{ id: string }>(app.db, `SELECT id FROM environments WHERE project_id = ? ORDER BY kind = 'production' DESC`, prj.id ?? prj.projectId)[0]!, svc = id('svc');
    run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, status) VALUES (?, ?, ?, ?, 'web', 'web', 'web', 'running')`, svc, o.orgId, prj.id ?? prj.projectId, env.id);
    run(app.db, 'INSERT INTO links (id, org_id, source, target) VALUES (?, ?, ?, ?)', id('lnk'), o.orgId, JSON.stringify({ kind: 'supabase', accountId: acc, ref: REF }), JSON.stringify({ kind: 'unit7', serviceId: svc }));
    run(app.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls) VALUES (?, ?, 'shop.example.com', ?, 'active', 'active')`, id('dom'), o.orgId, svc);
    const r = ok(await o.h('project.readiness', { projectId: prj.id ?? prj.projectId }));
    assert.match(key(r, 'sender').detail, /stop after 2 an hour/);
    assert.deepEqual(key(r, 'sender').fix, { ask: 'Set up email sending for shop-db', label: 'Set up with AI' }, 'no domain seen on the map yet');
    assert.match(key(r, 'login').fix.ask, /Make login work on https:\/\/shop\.example\.com for shop-db/);

    // the Check-up says so too, once an app on the map uses it
    run(app.db, `INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, url, meta, seen_at) VALUES ('ast_appshop00001', ?, NULL, 'vercel', 'app', 'shop', 'shop', NULL, ?, '2026-11-01')`, o.orgId, JSON.stringify({ hosts: ['shop.vercel.app', 'shop.example.com'] }));
    run(app.db, `INSERT INTO edges (id, org_id, source, target, kind, via) VALUES ('edg_1', ?, 'ast_appshop00001', ?, 'env', 'SUPABASE_URL')`, o.orgId, asset.id);
    const c = ok(await o.h('checkup.run', { quick: true }));
    const item = c.items.find((i: any) => i.id === `mail:supabase:${REF}`);
    assert.match(item.title, /shop-db: sign-up emails stop after 2 an hour/);
    assert.match(item.why, /only to your own team/);
    assert.equal(item.area, 'app');
    assert.equal(item.who, 'your-ai');
    assert.equal(item.fix.ask, 'Set up email sending from example.com for shop-db');
    assert.ok(c.checked.some((x: any) => x.id === 'mail'));

    // a fix ticks now, not at the next sync
    app.vault.put(o.orgId, 'credential://smtp/example-com/password', 'a-password', { kind: 'smtp', meta: { host: 'smtp.resend.com', user: 'resend' } });
    ok(await o.h('email.connect_app', { domain: 'example.com', ref: REF }));
    ok(await o.h('auth.urls', { ref: REF, url: 'https://shop.example.com' }));
    const fine = ok(await o.h('project.readiness', { projectId: prj.id ?? prj.projectId }));
    assert.deepEqual([key(fine, 'sender').ok, key(fine, 'login').ok], [true, true]);
    assert.ok(!ok(await o.h('checkup.run', { quick: true })).items.some((i: any) => i.id.startsWith('mail:')));
  } finally { s.close(); }
});

test('the Check-up flags a stack on a server whose mail goes nowhere', async () => {
  const { app, o, srv } = await onServer();
  ssh(app).exec = async () => ({ code: 1, stdout: '', stderr: 'no', truncated: false });
  const c = ok(await o.h('checkup.run', { quick: true, serverId: srv }));
  const items = c.items.filter((i: any) => i.id.startsWith('mail:'));
  assert.equal(items.length, 3, 'three Supabase stacks in the fixture');
  assert.match(items[0].title, /sign-up emails can’t leave/);
  assert.equal(items[0].serverId, srv);
});

test('an AI trying to read the SMTP password gets nowhere, whichever way it asks', async () => {
  const s = await hostedSupabase({ smtp_host: 'smtp.mailhost.example', smtp_user: 'mailer', smtp_pass: 'stored-hash-from-supabase', site_url: 'https://shop.example.com' });
  try {
    const { app, o, srv } = await onServer(), c = standIn(app, { appEnvs: { SMTP_PASS: PASSWORD } });
    account(app, o.orgId, 'supabase', `sbp_${'a1'.repeat(20)}`, 'Supabase');
    const ref = 'credential://smtp/example-com/password';
    // reading tools show where it is, never what it is
    const read = JSON.stringify([ok(await o.a('vault.list', {})), ok(await o.a('vault.history', { ref })), ok(await o.a('coolify.envs', { serverId: srv, uuid: 'shopapp01', op: 'list' })), ok(await o.a('supabase.auth', { ref: REF })), ok(await o.a('email.check', { domain: 'example.com' }))]);
    assert.ok(!read.includes(PASSWORD) && !read.includes('stored-hash-from-supabase'));
    // the tools that do show a value are a person's
    for (const [tool, input] of [['coolify.envs', { serverId: srv, uuid: 'shopapp01', op: 'reveal', key: 'SMTP_PASS' }], ['coolify.running_value', { serverId: srv, uuid: 'shopapp01', key: 'SMTP_PASS' }], ['vault.set', { ref, value: 'x' }], ['vault.restore', { ref, version: 1 }]] as const) {
      assert.equal((await o.a(tool, input)).status, 'denied', tool);
    }
    // copying it to a login of its own shows nothing either, and the copy is as locked as the first
    const copy = await o.a('email.setup', { domain: 'shop.example.com', smtpHost: 'smtp.mailhost.example', smtpUser: 'mailer', smtpPassword: ref });
    assert.ok(!JSON.stringify(copy).includes(PASSWORD));
    assert.equal(c.seen.deploys, 0);
    // no output of any of this is kept with the value in it
    assert.ok(!everywhere(app).includes(PASSWORD));
    assert.deepEqual(getTool('email.setup')!.sensitive, ['smtpPassword']);
    assert.ok(getTool('email.check')!.risk === 'read' && !getTool('email.setup')!.green && !getTool('email.connect_app')!.green && !getTool('email.forward')?.green);
  } finally { s.close(); }
});
