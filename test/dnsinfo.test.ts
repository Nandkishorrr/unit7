// DNS facts: the zone is found by asking DNS (so example.co.uk works), the DNS host is recognised
// from nameservers, and "has it propagated?" accepts flattened apex records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneOf, dnsHostFromNs, resolvesTo, type Lookup } from '../src/connectors/dnsinfo.ts';

const fake = (zones: string[], a: Record<string, string[]> = {}, cname: Record<string, string[]> = {}): Lookup => ({
  soa: async (n) => { if (!zones.includes(n)) throw new Error('ENODATA'); return {}; },
  ns: async () => [],
  a: async (n) => { if (!a[n]) throw new Error('ENOTFOUND'); return a[n]!; },
  cname: async (n) => { if (!cname[n]) throw new Error('ENODATA'); return cname[n]!; },
});

test('the zone comes from DNS, not from counting labels', async () => {
  assert.equal(await zoneOf('shop.example.co.uk', fake(['example.co.uk', 'co.uk'])), 'example.co.uk');
  assert.equal(await zoneOf('a.b.example.com', fake(['example.com'])), 'example.com');
  assert.equal(await zoneOf('api.dev.example.com', fake(['dev.example.com', 'example.com'])), 'dev.example.com', 'a delegated subzone wins');
  assert.equal(await zoneOf('nothing.invalid', fake([])), undefined);
  // www is a CNAME: it answers SOA with its target's zone, so it must not count as a zone itself
  const viaCname: Lookup = { ...fake(['www.example.com', 'example.com'], {}, { 'www.example.com': ['example.com.'] }) };
  assert.equal(await zoneOf('www.example.com', viaCname), 'example.com');
});

test('DNS hosts recognised from nameservers', () => {
  assert.equal(dnsHostFromNs(['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']), 'cloudflare');
  assert.equal(dnsHostFromNs(['ns1.dns-parking.com.', 'ns2.dns-parking.com.']), 'hostinger');
  assert.equal(dnsHostFromNs(['ns47.domaincontrol.com']), 'godaddy');
  assert.equal(dnsHostFromNs(['dns1.registrar-servers.com']), 'namecheap');
  assert.equal(dnsHostFromNs(['ns1.vercel-dns.com']), 'vercel');
  assert.equal(dnsHostFromNs(['ns.example.net']), undefined);
});

test('propagation: A records, CNAMEs, and flattened apex (ALIAS) all count', async () => {
  const dns = fake([], { 'example.com': ['76.76.21.21'], 'cname.vercel-dns.com': ['76.76.21.21'], 'srv.example.com': ['203.0.113.7'] }, { 'www.example.com': ['cname.vercel-dns.com.'] });
  assert.equal((await resolvesTo('srv.example.com', { a: ['203.0.113.7'] }, dns)).ok, true);
  assert.equal((await resolvesTo('srv.example.com', { a: ['198.51.100.1'] }, dns)).ok, false);
  assert.equal((await resolvesTo('www.example.com', { cname: 'cname.vercel-dns.com' }, dns)).ok, true);
  assert.equal((await resolvesTo('example.com', { cname: 'cname.vercel-dns.com' }, dns)).ok, true, 'apex flattened to the same IPs');
});
