// The big clouds, all offline: Google Cloud + Firebase (a pasted service account key, gcloud signed in on this Mac, or
// only the Firebase CLI), against a fake Google API and a stand-in CLI. A refused sign-in fails the scan and the
// last good one stays; things Google made for another product show once; domains join the domain list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { testApp, testOrg, ok } from './helpers.ts';
import { connections, connectCloudCli, cloudClis } from '../src/connectors/oneclick.ts';
import { forgetSignedIn, dropCached } from '../src/connectors/cloudcli.ts';
import { get } from '../src/db.ts';

const CLI = fileURLToPath(new URL('./fake-cloud-cli.mjs', import.meta.url));
for (const v of ['UNIT7_GCLOUD_BIN', 'UNIT7_FIREBASE_BIN', 'UNIT7_AWS_BIN', 'UNIT7_AZ_BIN']) process.env[v] = CLI;
const signedOut = (tools: string) => { process.env.FAKE_CLOUD_SIGNED_OUT = tools; forgetSignedIn(); };

type Handler = (req: { method: string; path: string; auth: string; body: string }) => unknown;
// a fake API on 127.0.0.1: the handler returns a body (200), [status, body], or undefined (404)
async function fakeApi(handler: Handler) {
  const calls: { method: string; path: string; auth: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = ''; for await (const c of req) body += c;
    const r = { method: req.method!, path: req.url!, auth: String(req.headers.authorization ?? ''), body };
    calls.push(r);
    const out = handler(r);
    const [status, data] = Array.isArray(out) && typeof out[0] === 'number' ? out as [number, unknown] : out === undefined ? [404, { error: { code: 404, message: 'Requested entity was not found.' } }] : [200, out];
    res.writeHead(status, { 'content-type': 'application/json' }).end(typeof data === 'string' ? data : JSON.stringify(data));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, close: () => server.close() };
}

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const saKey = JSON.stringify({ type: 'service_account', project_id: 'shop-prod', client_email: 'unit7-viewer@shop-prod.iam.gserviceaccount.com', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const disabled = [403, { error: { code: 403, message: 'Cloud Realtime Database API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED' } }];

// one Google project with a bit of everything
function google(o: { refuse?: () => boolean; token?: string } = {}): Handler {
  return ({ method, path, auth, body }) => {
    if (path === '/oauth2/token') {
      const jwt = new URLSearchParams(body).get('assertion')!.split('.');
      const good = createVerify('RSA-SHA256').update(`${jwt[0]}.${jwt[1]}`).verify(keys.publicKey, Buffer.from(jwt[2]!, 'base64url'));
      return good ? { access_token: 'ya29.from-key', expires_in: 3600 } : [400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }];
    }
    if (o.refuse?.() || auth !== `Bearer ${o.token ?? 'ya29.from-key'}`) return [401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }];
    if (method !== 'GET') return [405, {}];
    const p = path.replace(/\?.*$/, '');
    const R: Record<string, unknown> = {
      '/cloudresourcemanager/v1/projects': { projects: [{ projectId: 'shop-prod', name: 'Shop', lifecycleState: 'ACTIVE' }] },
      '/run/apis/serving.knative.dev/v1/namespaces/shop-prod/services': { items: [
        { metadata: { name: 'api', labels: { 'cloud.googleapis.com/location': 'us-central1' } }, spec: { template: { spec: { containers: [{ env: [{ name: 'DATABASE_URL', value: 'postgresql://app:pw@203.0.113.7:5432/shop' }, { name: 'STRIPE_KEY', valueFrom: {} }] }] } } },
          status: { url: 'https://api-abc123-uc.a.run.app', conditions: [{ type: 'Ready', status: 'True' }] } },
        { metadata: { name: 'sendmail', labels: { 'cloud.googleapis.com/location': 'us-central1', 'goog-managed-by': 'cloudfunctions' } }, status: { url: 'https://sendmail-abc123-uc.a.run.app' } },
      ] },
      '/run/apis/domains.cloudrun.com/v1/namespaces/shop-prod/domainmappings': { items: [{ metadata: { name: 'api.example.com' }, spec: { routeName: 'api' } }] },
      '/cloudfunctions/v2/projects/shop-prod/locations/-/functions': { functions: [{ name: 'projects/shop-prod/locations/us-central1/functions/sendmail', state: 'ACTIVE', labels: { 'deployment-tool': 'cli-firebase' }, serviceConfig: { uri: 'https://sendmail-abc123-uc.a.run.app' } }] },
      '/sqladmin/v1/projects/shop-prod/instances': { items: [{ name: 'shop-db', databaseVersion: 'POSTGRES_15', state: 'RUNNABLE', ipAddresses: [{ ipAddress: '203.0.113.7', type: 'PRIMARY' }] }] },
      '/dns/dns/v1/projects/shop-prod/managedZones': { managedZones: [{ name: 'example-com', dnsName: 'example.com.', visibility: 'public' }, { name: 'internal', dnsName: 'corp.internal.', visibility: 'private' }] },
      '/dns/dns/v1/projects/shop-prod/managedZones/example-com/rrsets': { rrsets: [
        { name: 'example.com.', type: 'A', rrdatas: ['199.36.158.100'] }, { name: 'www.example.com.', type: 'CNAME', rrdatas: ['shop-web.web.app.'] },
        { name: 'api.example.com.', type: 'CNAME', rrdatas: ['ghs.googlehosted.com.'] }, { name: 'example.com.', type: 'MX', rrdatas: ['1 smtp.google.com.'] },
      ] },
      '/domains/v1/projects/shop-prod/locations/global/registrations': { registrations: [{ domainName: 'example.com', state: 'ACTIVE', expireTime: '2027-03-01T00:00:00Z', managementSettings: { renewalMethod: 'AUTOMATIC_RENEWAL' } }] },
      '/firebase/v1beta1/projects': { results: [{ projectId: 'shop-prod', displayName: 'Shop' }] },
      '/firebasehosting/v1beta1/projects/shop-prod/sites': { sites: [{ name: 'projects/shop-prod/sites/shop-web', defaultUrl: 'https://shop-web.web.app', type: 'DEFAULT_SITE' }] },
      '/firebasehosting/v1beta1/projects/shop-prod/sites/shop-web/customDomains': { customDomains: [{ name: 'projects/shop-prod/sites/shop-web/customDomains/www.example.com', hostState: 'HOST_ACTIVE' }] },
      '/firebasehosting/v1beta1/sites/shop-web/domains': { domains: [{ domainName: 'example.com' }, { domainName: 'shop-web.web.app' }] },
      '/firestore/v1/projects/shop-prod/databases': { databases: [{ name: 'projects/shop-prod/databases/(default)', locationId: 'nam5', type: 'FIRESTORE_NATIVE' }] },
      '/firebasedatabase/v1beta/projects/shop-prod/locations/-/instances': disabled,
      '/firebaseapphosting/v1beta/projects/shop-prod/locations/-/backends': disabled,
      '/cloudbilling/v1/projects/shop-prod/billingInfo': { billingAccountName: 'billingAccounts/0A0A0A-1B1B1B-2C2C2C', billingEnabled: true },
      '/cloudbilling/v1/billingAccounts': { billingAccounts: [{ name: 'billingAccounts/0A0A0A-1B1B1B-2C2C2C', displayName: 'My billing account', open: true, currencyCode: 'USD' }] },
      '/billingbudgets/v1/billingAccounts/0A0A0A-1B1B1B-2C2C2C/budgets': {},
    };
    return R[p]; // App Engine: no app in this project (404)
  };
}

const assetsOf = async (o: Awaited<ReturnType<typeof testOrg>>) => ok(await o.h('map.get')) as { assets: { id: string; provider: string; kind: string; name: string; url: string | null; account?: string; registrar?: string; expires?: string; dns?: string }[]; edges: { source: string; target: string; kind: string; status: string }[]; accounts: { name: string; provider: string; ok: boolean; found: number; note?: string }[]; issues: { key: string; text: string }[] };

test('Google Cloud + Firebase with a service account key: everything on the map, wired, and the bill', async () => {
  let refuse = false;
  const api = await fakeApi(google({ refuse: () => refuse }));
  process.env.UNIT7_GOOGLE_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const c = ok(await o.h('account.connect', { provider: 'gcp', token: saKey }));
    assert.equal(c.status, 'verified', 'the key was proven before it counts');
    assert.equal(c.facts.projects, 1);
    ok(await o.h('account.connect', { provider: 'firebase', token: saKey })); // the same key on the Firebase tile
    ok(await o.h('sync.run'));
    const m = await assetsOf(o);
    const by = (provider: string, name: string) => m.assets.find((a) => a.provider === provider && a.name === name);
    const run = by('cloudrun', 'api'), db = by('cloudsql', 'shop-db'), site = by('firebase', 'shop-web'), fn = by('firebase', 'sendmail');
    assert.ok(run && db && site && fn && by('firestore', 'shop-prod'), 'Cloud Run, Cloud SQL, a Hosting site, a Firebase function and Firestore are all there');
    assert.equal(run!.url, 'https://api.example.com');
    assert.equal(run!.account, 'Google Cloud · shop-prod', 'named after the project the key belongs to');
    assert.equal(site!.account, 'Firebase · shop-prod', 'Firebase things sit under the Firebase tile, Cloud things under Google Cloud');
    assert.ok(!m.issues.some((i) => i.key.startsWith('dup:')), 'one Google sign-in on both tiles: nothing counted twice');
    assert.equal(m.assets.filter((a) => a.name === 'sendmail').length, 1, 'the Cloud Run service behind a Firebase function shows once');
    assert.ok(!m.assets.some((a) => a.provider === 'appengine'), 'no App Engine app: nothing made up');
    const edge = (from: string, to: string, kind: string) => m.edges.find((e) => e.source === from && e.target === to && e.kind === kind);
    const dom = (name: string) => m.assets.find((a) => a.kind === 'domain' && a.name === name)!;
    assert.equal(edge(dom('api.example.com').id, run!.id, 'domain')?.status, 'ok', 'api.example.com is mapped on Cloud Run and its DNS agrees');
    assert.equal(edge(dom('www.example.com').id, site!.id, 'domain')?.status, 'ok', 'www is on Firebase Hosting and its DNS agrees');
    assert.equal(edge(dom('example.com').id, site!.id, 'domain')?.status, 'ok', 'the bare domain points at Firebase Hosting’s address');
    assert.ok(edge(run!.id, db!.id, 'env'), 'the API uses the Cloud SQL database (its DATABASE_URL holds the address)');
    assert.equal(dom('example.com').dns, 'gcp');
    assert.equal(dom('example.com').registrar, 'gcp');
    assert.ok(dom('example.com').expires?.startsWith('2027-03-01'));
    assert.ok(!m.assets.some((a) => a.name.endsWith('corp.internal')), 'private zones stay private');

    const bill = ok(await o.h('cloud.billing', { accountId: c.accountId }));
    assert.equal(bill.spend, null, 'Google doesn’t say what was spent: never a made-up zero');
    assert.deepEqual(bill.budgets, [], 'no budget is set (the drawer says so)');
    assert.deepEqual(bill.payers, [{ name: 'My billing account', projects: ['shop-prod'] }]);

    // the key stops working: the scan fails and the map keeps what it had
    refuse = true;
    ok(await o.h('sync.run'));
    const after = await assetsOf(o);
    assert.equal(after.accounts.find((a) => a.name === 'Google Cloud · shop-prod')?.ok, false);
    assert.ok(after.assets.some((a) => a.provider === 'cloudrun'), 'the last good scan stays on the map');
  } finally { api.close(); delete process.env.UNIT7_GOOGLE_API; }
});

test('a bad Google key fails, never "0 found"', async () => {
  const api = await fakeApi(google());
  process.env.UNIT7_GOOGLE_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const c = ok(await o.h('account.connect', { provider: 'firebase', token: JSON.stringify({ ...JSON.parse(saKey), private_key: other }) }));
    assert.equal(c.status, 'failing');
    assert.equal((await o.h('account.connect', { provider: 'gcp', token: '{"type":"authorized_user"}' })).status, 'ok', 'stored but…');
    ok(await o.h('sync.run'));
    const m = await assetsOf(o);
    assert.deepEqual(m.accounts.filter((a) => a.provider !== 'unit7').map((a) => a.ok), [false, false], 'neither account counts as an empty one');
  } finally { api.close(); delete process.env.UNIT7_GOOGLE_API; }
});

test('gcloud signed in on this Mac: one click, a fresh token each time, and a signed-out CLI stops the scan', async () => {
  const api = await fakeApi(google({ token: 'ya29.from-gcloud' }));
  process.env.UNIT7_GOOGLE_API = api.base;
  signedOut('');
  try {
    const app = testApp(), o = await testOrg(app);
    assert.deepEqual(await cloudClis(), { gcp: 'gcloud', firebase: 'gcloud', aws: 'AWS CLI', azure: 'Azure CLI' });
    const tiles = connections(app, o.orgId, { clis: await cloudClis() });
    assert.equal(tiles.find((t) => t.id === 'gcp')?.cli, true);
    assert.equal(tiles.find((t) => t.id === 'gcp')?.cliName, 'gcloud');
    assert.equal(tiles.find((t) => t.id === 'hetzner')?.cli, false);
    const r = await connectCloudCli(app, o.orgId, 'gcp');
    assert.equal(r.name, 'Google Cloud · sam@example.com');
    await assert.rejects(connectCloudCli(app, o.orgId, 'gcp'), /This Google account is already connected/, 'the same Google account is never added twice');
    const ref = JSON.parse(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', r.accountId)!.meta).ref;
    assert.deepEqual(JSON.parse(app.vault.resolve(o.orgId, ref)), { cli: 'gcloud', account: 'sam@example.com' }, 'no token is stored, only which sign-in');
    ok(await o.h('sync.run'));
    assert.ok((await assetsOf(o)).assets.some((a) => a.provider === 'cloudrun' && a.account === 'Google Cloud · sam@example.com'));

    signedOut('gcloud');
    dropCached(`google:${r.accountId}`);
    ok(await o.h('sync.run'));
    const m = await assetsOf(o);
    assert.match(m.accounts.find((a) => a.name.startsWith('Google Cloud'))!.note ?? '', /signed out/);
    assert.ok(m.assets.some((a) => a.provider === 'cloudrun'), 'the last good scan stays');
    assert.equal(ok(await o.h('account.list', { provider: 'gcp' }))[0].status, 'failing', 'background work leaves it alone until a person signs in again');
  } finally { api.close(); delete process.env.UNIT7_GOOGLE_API; signedOut(''); }
});

test('only the Firebase CLI signed in: Firebase connects through it (sites and Firestore)', async () => {
  signedOut('gcloud');
  try {
    const app = testApp(), o = await testOrg(app);
    const clis = await cloudClis();
    assert.equal(clis.firebase, 'Firebase CLI');
    assert.equal(clis.gcp, undefined, 'Google Cloud needs gcloud (or a key)');
    await assert.rejects(connectCloudCli(app, o.orgId, 'gcp'), /Nothing is signed in/);
    const r = await connectCloudCli(app, o.orgId, 'firebase');
    assert.equal(r.name, 'Firebase · sam@example.com');
    ok(await o.h('sync.run'));
    const m = await assetsOf(o);
    assert.deepEqual(m.assets.filter((a) => a.account === r.name).map((a) => `${a.provider}:${a.name}`).sort(), ['firebase:shop-web', 'firestore:shop-prod']);
    assert.equal(m.assets.find((a) => a.name === 'shop-web')?.url, 'https://shop-web.web.app');
  } finally { signedOut(''); }
});

// --- AWS ---------------------------------------------------------------------------------------------------
const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8"?>${s}`;
function awsApi(seen: { ce: number; auth: string[] }): Handler {
  return ({ method, path, auth, body }) => {
    seen.auth.push(auth);
    const [, host = '', ...rest] = path.split('/');
    const p = `/${rest.join('/')}`;
    if (!/^AWS4-HMAC-SHA256 Credential=(AKIA|ASIA)[A-Z0-9]+\/\d{8}\/[a-z0-9-]+\/[a-z0-9]+\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(auth)) return [403, xml('<ErrorResponse><Error><Code>IncompleteSignature</Code><Message>no signature</Message></Error></ErrorResponse>')];
    if (auth.includes('AKIABADBADBADBAD')) return [403, xml('<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error></ErrorResponse>')];
    const scope = /Credential=[A-Z0-9]+\/\d{8}\/([a-z0-9-]+)\/([a-z0-9]+)\//.exec(auth)!;
    if (host === 'sts.amazonaws.com') return xml('<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/unit7</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>');
    if (host === 'ec2.us-east-1.amazonaws.com' && p.includes('DescribeRegions')) return xml('<DescribeRegionsResponse><regionInfo><item><regionName>us-east-1</regionName></item><item><regionName>eu-west-1</regionName></item></regionInfo></DescribeRegionsResponse>');
    if (host === 'ec2.us-east-1.amazonaws.com') {
      assert.deepEqual(scope.slice(1), ['us-east-1', 'ec2'], 'signed for the region and service it goes to');
      return xml(`<DescribeInstancesResponse><reservationSet><item><reservationId>r-1</reservationId><instancesSet>
        <item><instanceId>i-0aaa</instanceId><instanceState><code>16</code><name>running</name></instanceState><ipAddress>198.51.100.4</ipAddress>
          <networkInterfaceSet><item><privateIpAddress>10.0.0.4</privateIpAddress><association><publicIp>198.51.100.4</publicIp></association></item></networkInterfaceSet>
          <tagSet><item><key>Team</key><value>shop</value></item><item><key>Name</key><value>web &amp; api</value></item></tagSet></item>
        <item><instanceId>i-0bbb</instanceId><instanceState><code>48</code><name>terminated</name></instanceState></item>
      </instancesSet></item></reservationSet></DescribeInstancesResponse>`);
    }
    if (host === 'ec2.eu-west-1.amazonaws.com') return [403, xml('<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized to perform this operation.</Message></Error></Errors></Response>')];
    if (host === 'rds.eu-west-1.amazonaws.com') return xml('<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>shop-db</DBInstanceIdentifier><Engine>postgres</Engine><DBInstanceStatus>available</DBInstanceStatus><Endpoint><Address>shop-db.abc123.eu-west-1.rds.amazonaws.com</Address><Port>5432</Port></Endpoint></DBInstance></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>');
    if (host.startsWith('rds.')) return xml('<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>');
    if (host === 'amplify.us-east-1.amazonaws.com' && p.startsWith('/apps/d1abc/domains')) return { domainAssociations: [{ domainName: 'example.com', subDomains: [{ subDomainSetting: { prefix: '' } }, { subDomainSetting: { prefix: 'www' } }] }] };
    if (host === 'amplify.us-east-1.amazonaws.com') return { apps: [{ appId: 'd1abc', name: 'shop-site', defaultDomain: 'd1abc.amplifyapp.com', productionBranch: { branchName: 'main', status: 'SUCCEED' } }] };
    if (host.startsWith('amplify.')) return { apps: [] };
    if (host === 'lightsail.us-east-1.amazonaws.com') return { instances: [{ name: 'blog', publicIpAddress: '192.0.2.10', state: { name: 'running' } }] };
    if (host.startsWith('lightsail.')) return { instances: [] };
    if (host === 'route53.amazonaws.com' && p === '/2013-04-01/hostedzone') return xml('<ListHostedZonesResponse><HostedZones><HostedZone><Id>/hostedzone/Z1</Id><Name>example.com.</Name><Config><PrivateZone>false</PrivateZone></Config></HostedZone></HostedZones></ListHostedZonesResponse>');
    if (host === 'route53.amazonaws.com') return xml(`<ListResourceRecordSetsResponse><ResourceRecordSets>
      <ResourceRecordSet><Name>example.com.</Name><Type>A</Type><AliasTarget><DNSName>d2xyz.cloudfront.net.</DNSName></AliasTarget></ResourceRecordSet>
      <ResourceRecordSet><Name>www.example.com.</Name><Type>CNAME</Type><ResourceRecords><ResourceRecord><Value>d2xyz.cloudfront.net</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>
      <ResourceRecordSet><Name>api.example.com.</Name><Type>A</Type><ResourceRecords><ResourceRecord><Value>198.51.100.4</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>
      <ResourceRecordSet><Name>\\052.example.com.</Name><Type>A</Type><ResourceRecords><ResourceRecord><Value>198.51.100.4</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>
    </ResourceRecordSets></ListResourceRecordSetsResponse>`);
    if (host === 'route53domains.us-east-1.amazonaws.com') return { Domains: [{ DomainName: 'example.com', AutoRenew: true, Expiry: 1803859200 }] };
    if (host === 'ce.us-east-1.amazonaws.com') { seen.ce++; assert.equal(JSON.parse(body).Granularity, 'MONTHLY'); return { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '12.3456', Unit: 'USD' } } }] }; }
    if (host === 'budgets.amazonaws.com') { assert.equal(JSON.parse(body).AccountId, '123456789012'); return { Budgets: [{ BudgetName: 'Monthly cap', BudgetLimit: { Amount: '50.0', Unit: 'USD' }, CalculatedSpend: { ActualSpend: { Amount: '12.35', Unit: 'USD' } } }] }; }
    return method === 'GET' ? undefined : [400, { __type: 'UnknownOperationException' }];
  };
}

test('AWS with an access key: every region, Route 53, the bill (asked twice a day at most), and a bad key fails', async () => {
  const seen = { ce: 0, auth: [] as string[] };
  const api = await fakeApi(awsApi(seen));
  process.env.UNIT7_AWS_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const c = ok(await o.h('account.connect', { provider: 'aws', token: 'AKIAEXAMPLEGOOD1234:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }));
    assert.equal(c.status, 'verified');
    ok(await o.h('sync.run'));
    const m = await assetsOf(o);
    const by = (provider: string, name: string) => m.assets.find((a) => a.provider === provider && a.name === name);
    const web = by('ec2', 'web & api'), site = by('amplify', 'shop-site');
    assert.ok(web && site && by('lightsail', 'blog') && by('rds', 'shop-db'), 'EC2, Amplify, Lightsail and RDS are there');
    assert.ok(!m.assets.some((a) => a.name === 'i-0bbb'), 'terminated machines are gone');
    assert.equal(site!.url, 'https://example.com');
    const dom = (name: string) => m.assets.find((a) => a.kind === 'domain' && a.name === name)!;
    assert.equal(m.edges.find((e) => e.source === dom('www.example.com').id && e.target === site!.id)?.status, 'ok', 'www is on Amplify and DNS (CloudFront) agrees');
    assert.ok(m.edges.some((e) => e.source === dom('api.example.com').id && e.target === web!.id), 'api.example.com points at the EC2 machine');
    assert.equal(dom('example.com').dns, 'route53');
    assert.equal(dom('example.com').registrar, 'route53');
    assert.ok(dom('example.com').expires?.startsWith('2027-03-01'));
    assert.ok(!m.assets.some((a) => a.name.includes('052')), 'wildcards skipped');
    assert.ok(m.accounts.find((a) => a.provider === 'aws')?.ok, 'a region it may not read is skipped, not a failure');

    const bill = ok(await o.h('cloud.billing', { accountId: c.accountId }));
    assert.deepEqual(bill.spend, { amount: 12.3456, currency: 'USD' });
    assert.deepEqual(bill.budgets, [{ name: 'Monthly cap', amount: 50, currency: 'USD', spent: 12.35 }]);
    const b = ok(await o.h('budget.check'));
    assert.ok(b.costs.some((x: { provider: string; amount: number }) => x.provider === 'aws' && x.amount === 12.35), 'the monthly budget counts AWS');
    assert.equal(seen.ce, 1, 'Cost Explorer costs a cent a call: asked once, then remembered');

    const bad = ok(await o.h('account.connect', { provider: 'aws', token: 'AKIABADBADBADBAD1234:nope' }));
    assert.equal(bad.status, 'failing');
    assert.match(bad.problem, /security token included in the request is invalid/);
  } finally { api.close(); delete process.env.UNIT7_AWS_API; }
});

test('the AWS CLI signed in: every call is signed with the short-lived key it hands out', async () => {
  const seen = { ce: 0, auth: [] as string[] };
  const api = await fakeApi(awsApi(seen));
  process.env.UNIT7_AWS_API = api.base;
  signedOut('');
  try {
    const app = testApp(), o = await testOrg(app);
    const r = await connectCloudCli(app, o.orgId, 'aws');
    assert.equal(r.name, 'AWS · default');
    ok(await o.h('sync.run'));
    assert.ok((await assetsOf(o)).assets.some((a) => a.provider === 'amplify'));
    assert.ok(seen.auth.every((h) => h.includes('Credential=ASIAFAKEEXAMPLE12345/')), 'signed with the CLI’s temporary key');
  } finally { api.close(); delete process.env.UNIT7_AWS_API; }
});

// --- Azure and Hetzner ---------------------------------------------------------------------------------------
const SUB = '00000000-0000-0000-0000-000000000001';
const azureApi: Handler = ({ method, path, auth, body }) => {
  if (path.startsWith('/login/')) {
    const f = new URLSearchParams(body);
    return f.get('client_secret') === 'good-secret' && f.get('scope') === 'https://management.azure.com/.default' ? { access_token: 'eyJ.from-sp', expires_in: 3600 } : [401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }];
  }
  if (!['Bearer eyJ.from-sp', 'Bearer eyJ.from-az'].includes(auth)) return [401, { error: { code: 'InvalidAuthenticationToken', message: 'The access token is invalid.' } }];
  const p = path.replace(/^\/arm/, '').replace(/\?.*$/, '');
  const zone = `/subscriptions/${SUB}/resourceGroups/web/providers/Microsoft.Network/dnszones/example.org`;
  const R: Record<string, unknown> = {
    '/subscriptions': { value: [{ subscriptionId: SUB, displayName: 'Pay-As-You-Go', state: 'Enabled' }] },
    [`/subscriptions/${SUB}/providers/Microsoft.Web/staticSites`]: { value: [{ id: 'x', name: 'shop-site', properties: { defaultHostname: 'happy-sea-123.azurestaticapps.net', customDomains: ['www.example.org'] } }] },
    [`/subscriptions/${SUB}/providers/Microsoft.Web/sites`]: { value: [{ id: 'y', name: 'shop-api', properties: { defaultHostName: 'shop-api.azurewebsites.net', hostNames: ['shop-api.azurewebsites.net', 'api.example.org'], state: 'Running' } }] },
    [`/subscriptions/${SUB}/providers/Microsoft.DBforPostgreSQL/flexibleServers`]: { value: [{ id: 'z', name: 'shopdb', properties: { fullyQualifiedDomainName: 'shopdb.postgres.database.azure.com', state: 'Ready' } }] },
    [`/subscriptions/${SUB}/providers/Microsoft.Sql/servers`]: { value: [] },
    [`/subscriptions/${SUB}/providers/Microsoft.Network/dnszones`]: { value: [{ id: zone, name: 'example.org' }] },
    [`${zone}/all`]: { value: [
      { id: 'a', name: 'www', type: 'Microsoft.Network/dnszones/CNAME', properties: { CNAMERecord: { cname: 'happy-sea-123.azurestaticapps.net' } } },
      { id: 'b', name: 'api', type: 'Microsoft.Network/dnszones/CNAME', properties: { CNAMERecord: { cname: 'shop-api.azurewebsites.net' } } },
      { id: 'c', name: '@', type: 'Microsoft.Network/dnszones/A', properties: { ARecords: [{ ipv4Address: '203.0.113.50' }] } },
    ] },
    [`/subscriptions/${SUB}/providers/Microsoft.CostManagement/query`]: method === 'POST' ? { properties: { columns: [{ name: 'Cost' }, { name: 'Currency' }], rows: [[7.5, 'USD']] } } : undefined,
    [`/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets`]: { value: [] },
  };
  return R[p];
};

test('Azure with a service principal (or az login): sites, databases, Azure DNS and this month’s cost', async () => {
  const api = await fakeApi(azureApi);
  process.env.UNIT7_AZURE_API = `${api.base}/arm`; process.env.UNIT7_AZURE_LOGIN = `${api.base}/login`;
  try {
    const app = testApp(), o = await testOrg(app);
    const c = ok(await o.h('account.connect', { provider: 'azure', token: `tenant-1:${SUB}:good-secret` }));
    assert.equal(c.status, 'verified');
    assert.equal(ok(await o.h('account.connect', { provider: 'azure', token: `tenant-1:${SUB}:wrong` })).status, 'failing');
    ok(await o.h('sync.run'));
    const m = await assetsOf(o);
    const site = m.assets.find((a) => a.name === 'shop-site'), apiApp = m.assets.find((a) => a.name === 'shop-api');
    assert.ok(site && apiApp && m.assets.some((a) => a.name === 'shopdb' && a.kind === 'database'));
    const dom = (name: string) => m.assets.find((a) => a.kind === 'domain' && a.name === name)!;
    assert.equal(m.edges.find((e) => e.source === dom('www.example.org').id && e.target === site!.id)?.status, 'ok');
    assert.equal(m.edges.find((e) => e.source === dom('api.example.org').id && e.target === apiApp!.id)?.status, 'ok');
    assert.equal(dom('example.org').dns, 'azure');
    const bill = ok(await o.h('cloud.billing', { accountId: c.accountId }));
    assert.deepEqual(bill.spend, { amount: 7.5, currency: 'USD' });
    assert.deepEqual(bill.budgets, [], 'no budget set: the drawer warns');

    signedOut('');
    const viaCli = await connectCloudCli(app, o.orgId, 'azure');
    assert.equal(viaCli.name, 'Microsoft Azure · sam@example.com');
    assert.equal(ok(await o.h('account.verify', { accountId: viaCli.accountId })).status, 'verified', 'az login works the same way');
  } finally { api.close(); delete process.env.UNIT7_AZURE_API; delete process.env.UNIT7_AZURE_LOGIN; }
});

test('Hetzner Cloud: servers and the DNS zones that point at them', async () => {
  const api = await fakeApi(({ path, auth }) => {
    if (auth !== 'Bearer hz-good-token-123') return [401, { error: { code: 'unauthorized', message: 'unable to authenticate' } }];
    if (path.startsWith('/hz/servers')) return { servers: [{ id: 7, name: 'box-1', status: 'running', public_net: { ipv4: { ip: '203.0.113.80' } } }], meta: { pagination: { next_page: null } } };
    if (path.startsWith('/hz/zones/9/rrsets')) return { rrsets: [{ name: '@', type: 'A', records: [{ value: '203.0.113.80' }] }, { name: 'www', type: 'CNAME', records: [{ value: 'example.net.' }] }], meta: {} };
    if (path.startsWith('/hz/zones')) return { zones: [{ id: 9, name: 'example.net' }], meta: {} };
  });
  process.env.UNIT7_HETZNER_API = `${api.base}/hz`;
  try {
    const app = testApp(), o = await testOrg(app);
    assert.equal(ok(await o.h('account.connect', { provider: 'hetzner', token: 'hz-bad-token-123' })).status, 'failing');
    ok(await o.h('account.connect', { provider: 'hetzner', token: 'hz-good-token-123' }));
    ok(await o.h('sync.run'));
    const m = await assetsOf(o);
    const box = m.assets.find((a) => a.provider === 'hetzner' && a.kind === 'server');
    assert.equal(box?.name, 'box-1');
    assert.ok(m.edges.some((e) => e.target === box!.id && e.kind === 'dns'), 'example.net points at the server');
    assert.equal(m.assets.find((a) => a.name === 'example.net')?.dns, 'hetzner');
  } finally { api.close(); delete process.env.UNIT7_HETZNER_API; }
});

test('what to connect next: Coolify found on a server, until it is connected there', async () => {
  const app = testApp(), o = await testOrg(app);
  const { run } = await import('../src/db.ts');
  run(app.db, `INSERT INTO servers (id, org_id, name, host, key_ref, status) VALUES ('srv_box1', ?, 'box-1', '192.0.2.5', 'credential://ssh/box-1/key', 'ready')`, o.orgId);
  const asset = (id: string, kind: string, name: string, meta: object) => run(app.db, `INSERT INTO assets (id, org_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, 'unit7', ?, ?, ?, ?, '2026-10-07')`, id, o.orgId, kind, id, name, JSON.stringify(meta));
  asset('ast_p1', 'project', 'shop', { owner: 'coolify', server: 'unit7:srv_box1' });
  asset('ast_d1', 'domain', 'example.com', { dns: 'cloudflare', zone: 'example.com' }); // its DNS account is connected: nothing to ask
  assert.deepEqual(ok(await o.h('connection.suggestions')), [{ provider: 'coolify', name: 'Coolify', why: 'Coolify is on box-1', href: '/servers/srv_box1#coolify-connect' }]);
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta) VALUES ('acc_cool1', ?, 'coolify', 'Coolify', 'coolify', '{"serverId":"srv_box1"}')`, o.orgId);
  assert.deepEqual(ok(await o.h('connection.suggestions')), []);
});
