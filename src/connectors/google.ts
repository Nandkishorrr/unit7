// Google Cloud and Firebase: one Google sign-in sees both (a Firebase project IS a Google Cloud project).
// The sign-in is gcloud on this Mac (Unit7 asks it for a one-hour token each time), or a service account's JSON
// key pasted once (Unit7 signs its own one-hour tokens with it), or, for Firebase only, the Firebase CLI (Unit7
// runs its read-only list commands). Everything here only reads. Base URLs are overridable for offline tests.
import { createSign } from 'node:crypto';
import type { Ctx } from '../tools/runtime.ts';
import { get } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { cached, call, cli, cliJson } from './cloudcli.ts';

const G = (svc: string) => (process.env.UNIT7_GOOGLE_API ? `${process.env.UNIT7_GOOGLE_API}/${svc}` : `https://${svc}.googleapis.com`);
type Cred = { cli: 'gcloud' | 'firebase'; account?: string } | { type: 'service_account'; client_email: string; private_key: string; project_id?: string };

// the account's own provider (a Google sign-in can sit on the Google Cloud tile or the Firebase one)
export function googleCred(ctx: Ctx, acc: string): Cred {
  const provider = get<{ provider: string }>(ctx.db, 'SELECT provider FROM accounts WHERE id = ? AND org_id = ?', acc, ctx.orgId)?.provider ?? 'gcp';
  return parseGoogleKey(ctx.credentialFor(provider, acc).value);
}
export function parseGoogleKey(value: string): Cred {
  let c: any;
  try { c = JSON.parse(value); } catch { throw new Unit7Error('bad_key', 'That isn’t a Google service account key. Paste the whole .json file (it starts with {).', 400); }
  if (c?.cli === 'gcloud' || c?.cli === 'firebase') return c;
  if (c?.type !== 'service_account' || !c.client_email || !c.private_key) throw new Unit7Error('bad_key', 'That JSON isn’t a service account key (it needs "type": "service_account", a client_email and a private_key).', 400);
  return c;
}
export const viaFirebaseCli = (ctx: Ctx, acc: string) => { const c = googleCred(ctx, acc); return 'cli' in c && c.cli === 'firebase' ? c : undefined; };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export async function googleToken(ctx: Ctx, acc: string): Promise<string> {
  const c = googleCred(ctx, acc);
  const token = await cached(`google:${acc}`, async () => {
    if ('cli' in c) {
      if (c.cli !== 'gcloud') throw new Unit7Error('unsupported', 'This Firebase sign-in works through the Firebase CLI only.', 400);
      // always this account's own sign-in, never whichever one gcloud has active
      return { value: await cli('gcloud', ['auth', 'print-access-token', ...(c.account ? [`--account=${c.account}`] : []), '--quiet']) };
    }
    // a service account signs a one-hour grant for itself (OAuth 2.0 JWT bearer flow)
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    let jwt: string;
    try { jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(c.private_key).toString('base64url')}`; } catch { throw new Unit7Error('bad_key', 'The private key in that service account file is damaged. Download a fresh key.', 401); }
    const r = await call<{ access_token: string; expires_in: number }>('Google', `${G('oauth2')}/token`, { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt } });
    return { value: r.access_token, until: Date.now() + r.expires_in * 1000 };
  });
  ctx.redactor.add(token, 'google token');
  return token;
}

async function gget<T = any>(ctx: Ctx, acc: string, url: string): Promise<T> {
  return call<T>('Google Cloud', url, { headers: { authorization: `Bearer ${await googleToken(ctx, acc)}` } });
}
// every page of a list (Google's pageToken / nextPageToken)
async function glist<T>(ctx: Ctx, acc: string, url: string, field: string): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await gget<Record<string, any>>(ctx, acc, `${url}${url.includes('?') ? '&' : '?'}${token ? `pageToken=${encodeURIComponent(token)}` : ''}`);
    out.push(...(r[field] ?? []));
    token = r.nextPageToken;
    if (!token) break;
  }
  return out;
}
const tail = (name: string) => name.split('/').pop()!;

export interface RunService { metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: { template?: { spec?: { containers?: { env?: { name: string; value?: string }[] }[] } } }; status?: { url?: string; conditions?: { type: string; status: string; message?: string }[] } }
export interface SqlInstance { name: string; databaseVersion?: string; state?: string; region?: string; ipAddresses?: { ipAddress: string; type: string }[]; connectionName?: string; dnsName?: string; settings?: { tier?: string; activationPolicy?: string } }

// A product never set up in a project (no App Engine app, an API never switched on) answers 403 or 404: the
// scanner counts that as none. Only a refused sign-in (401) or "slow down" (429) stops a scan.
export const google = {
  // the projects this sign-in can see; a refused sign-in fails here, before anything else is asked
  projects: (ctx: Ctx, acc: string) => glist<{ projectId: string; name?: string; projectNumber?: string; lifecycleState?: string }>(ctx, acc, `${G('cloudresourcemanager')}/v1/projects?filter=${encodeURIComponent('lifecycleState:ACTIVE')}`, 'projects'),
  // Cloud Run, every region at once (the global v1 endpoint)
  runServices: (ctx: Ctx, acc: string, p: string) => gget<{ items?: RunService[] }>(ctx, acc, `${G('run')}/apis/serving.knative.dev/v1/namespaces/${p}/services`).then((r) => r.items ?? []),
  runDomains: (ctx: Ctx, acc: string, p: string) => gget<{ items?: { metadata: { name: string }; spec?: { routeName?: string } }[] }>(ctx, acc, `${G('run')}/apis/domains.cloudrun.com/v1/namespaces/${p}/domainmappings`).then((r) => r.items ?? []),
  appEngine: (ctx: Ctx, acc: string, p: string) => gget<{ id: string; defaultHostname?: string; servingStatus?: string }>(ctx, acc, `${G('appengine')}/v1/apps/${p}`),
  appEngineServices: (ctx: Ctx, acc: string, p: string) => glist<{ id: string }>(ctx, acc, `${G('appengine')}/v1/apps/${p}/services`, 'services'),
  appEngineDomains: (ctx: Ctx, acc: string, p: string) => glist<{ id: string }>(ctx, acc, `${G('appengine')}/v1/apps/${p}/domainMappings`, 'domainMappings'),
  functions: (ctx: Ctx, acc: string, p: string) => glist<{ name: string; state?: string; url?: string; environment?: string; labels?: Record<string, string>; serviceConfig?: { uri?: string; environmentVariables?: Record<string, string> } }>(ctx, acc, `${G('cloudfunctions')}/v2/projects/${p}/locations/-/functions`, 'functions'),
  sql: (ctx: Ctx, acc: string, p: string) => glist<SqlInstance>(ctx, acc, `${G('sqladmin')}/v1/projects/${p}/instances`, 'items'),
  dnsZones: (ctx: Ctx, acc: string, p: string) => glist<{ name: string; dnsName: string; visibility?: string }>(ctx, acc, `${G('dns')}/dns/v1/projects/${p}/managedZones`, 'managedZones'),
  dnsRecords: (ctx: Ctx, acc: string, p: string, zone: string) => glist<{ name: string; type: string; ttl?: number; rrdatas?: string[] }>(ctx, acc, `${G('dns')}/dns/v1/projects/${p}/managedZones/${zone}/rrsets`, 'rrsets'),
  registrations: (ctx: Ctx, acc: string, p: string) => glist<{ domainName: string; expireTime?: string; state?: string; managementSettings?: { renewalMethod?: string } }>(ctx, acc, `${G('domains')}/v1/projects/${p}/locations/global/registrations`, 'registrations'),
  // Firebase
  firebaseProjects: (ctx: Ctx, acc: string) => glist<{ projectId: string; displayName?: string }>(ctx, acc, `${G('firebase')}/v1beta1/projects`, 'results'),
  sites: (ctx: Ctx, acc: string, p: string) => glist<{ name: string; defaultUrl?: string; type?: string }>(ctx, acc, `${G('firebasehosting')}/v1beta1/projects/${p}/sites`, 'sites'),
  siteDomains: async (ctx: Ctx, acc: string, p: string, site: string) => {
    const [custom, legacy] = await Promise.all([
      glist<{ name: string; hostState?: string }>(ctx, acc, `${G('firebasehosting')}/v1beta1/projects/${p}/sites/${site}/customDomains`, 'customDomains'),
      glist<{ domainName: string }>(ctx, acc, `${G('firebasehosting')}/v1beta1/sites/${site}/domains`, 'domains'),
    ]);
    return [...new Set([...custom.map((d) => tail(d.name)), ...legacy.map((d) => d.domainName)].map((d) => d.toLowerCase()))].filter((d) => !/\.(web\.app|firebaseapp\.com)$/.test(d));
  },
  appHosting: (ctx: Ctx, acc: string, p: string) => glist<{ name: string; uri?: string; displayName?: string }>(ctx, acc, `${G('firebaseapphosting')}/v1beta/projects/${p}/locations/-/backends`, 'backends'),
  firestore: (ctx: Ctx, acc: string, p: string) => gget<{ databases?: { name: string; locationId?: string; type?: string }[] }>(ctx, acc, `${G('firestore')}/v1/projects/${p}/databases`).then((r) => r.databases ?? []),
  rtdb: (ctx: Ctx, acc: string, p: string) => glist<{ name: string; databaseUrl?: string; state?: string }>(ctx, acc, `${G('firebasedatabase')}/v1beta/projects/${p}/locations/-/instances`, 'instances'),
  // Billing: which billing account pays for each project, and the budgets (alerts) on it. Google's API has no
  // "spent so far": that lives in the console, or in a billing export to BigQuery.
  billingInfo: (ctx: Ctx, acc: string, p: string) => gget<{ billingAccountName?: string; billingEnabled?: boolean }>(ctx, acc, `${G('cloudbilling')}/v1/projects/${p}/billingInfo`),
  billingAccounts: (ctx: Ctx, acc: string) => glist<{ name: string; displayName?: string; open?: boolean; currencyCode?: string }>(ctx, acc, `${G('cloudbilling')}/v1/billingAccounts`, 'billingAccounts'),
  budgets: (ctx: Ctx, acc: string, billingAccount: string) => glist<{ displayName?: string; amount?: { specifiedAmount?: { currencyCode?: string; units?: string }; lastPeriodAmount?: object }; thresholdRules?: { thresholdPercent: number }[]; budgetFilter?: { projects?: string[] } }>(ctx, acc, `${G('billingbudgets')}/v1/${billingAccount}/budgets`, 'budgets'),
};

// --- Firebase through the Firebase CLI (no gcloud on this Mac): its read-only list commands, as JSON ---------
const fb = <T>(account: string | undefined, args: string[]) => cliJson<{ status?: string; result?: T; error?: string }>('firebase', [...args, '--json', ...(account ? ['--account', account] : [])]).then((r) => {
  if (r.status && r.status !== 'success') throw new Unit7Error('cli_failed', `Firebase CLI: ${r.error ?? r.status}`, 502);
  return r.result as T;
});
export const firebaseCli = {
  projects: (account?: string) => fb<{ projectId: string; displayName?: string }[]>(account, ['projects:list']),
  sites: (account: string | undefined, p: string) => fb<{ sites?: { name: string; defaultUrl?: string }[] }>(account, ['hosting:sites:list', '--project', p]).then((r) => r?.sites ?? []),
  firestore: (account: string | undefined, p: string) => fb<{ name: string; locationId?: string }[]>(account, ['firestore:databases:list', '--project', p]).then((r) => r ?? []),
};
export { tail as lastPart };

// --- changes (Phase 2+): only ever called by Unit7's tools, each through the gate (tools/clouds-*.ts) -------------
// One call that changes something. A gcloud sign-in is a person's own login, which Google bills API calls to through a
// "quota project"; some APIs (Budgets) refuse without one, so it can be named (x-goog-user-project).
export async function gsend<T = any>(ctx: Ctx, acc: string, url: string, o: { method?: string; body?: unknown; quotaProject?: string } = {}): Promise<T> {
  return call<T>('Google Cloud', url, { method: o.method ?? 'POST', body: o.body, headers: { authorization: `Bearer ${await googleToken(ctx, acc)}`, ...(o.quotaProject && { 'x-goog-user-project': o.quotaProject }) } });
}
export const gread = gget;

export interface GBudget { displayName: string; amount: { specifiedAmount: { currencyCode?: string; units: string } }; thresholdRules: { thresholdPercent: number; spendBasis?: string }[]; budgetFilter?: { projects?: string[]; calendarPeriod?: string }; notificationsRule?: { pubsubTopic?: string; schemaVersion?: string; disableDefaultIamRecipients?: boolean } }
export const googleBilling = {
  // a budget on a billing account. With no notificationsRule Google emails the account's Billing Account Administrators
  // and Users at each threshold. https://docs.cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets/create
  // (the quota-project header: https://docs.cloud.google.com/billing/docs/how-to/budget-api)
  createBudget: (ctx: Ctx, acc: string, billingAccount: string, b: GBudget, quotaProject?: string) =>
    gsend<{ name: string }>(ctx, acc, `${G('billingbudgets')}/v1/${billingAccount}/budgets`, { body: b, quotaProject }),
  // BigQuery: the datasets of a project, a dataset's tables, and one query (max bytes billed caps what it can cost)
  // https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/datasets/list · …/tables/list · …/jobs/query
  datasets: (ctx: Ctx, acc: string, p: string) => glist<{ datasetReference: { datasetId: string; projectId: string }; location?: string }>(ctx, acc, `${G('bigquery')}/bigquery/v2/projects/${p}/datasets?maxResults=200`, 'datasets'),
  tables: (ctx: Ctx, acc: string, p: string, d: string) => glist<{ tableReference: { tableId: string }; timePartitioning?: { type?: string; field?: string } }>(ctx, acc, `${G('bigquery')}/bigquery/v2/projects/${p}/datasets/${d}/tables?maxResults=1000`, 'tables'),
  query: (ctx: Ctx, acc: string, p: string, sql: string, o: { location?: string; maxBytes: number }) =>
    gsend<{ jobComplete?: boolean; rows?: { f: { v: string | null }[] }[]; schema?: { fields: { name: string }[] }; totalBytesBilled?: string; totalBytesProcessed?: string }>(ctx, acc, `${G('bigquery')}/bigquery/v2/projects/${p}/queries`,
      { body: { query: sql, useLegacySql: false, maximumBytesBilled: String(o.maxBytes), timeoutMs: 30_000, ...(o.location && { location: o.location }) } }),
};

// Cloud DNS: one record set (name + type) read, and changed atomically. A change's deletions must match what's there
// exactly, so a set someone edited a moment ago makes the change fail instead of being overwritten.
// https://docs.cloud.google.com/dns/docs/reference/rest/v1/resourceRecordSets/list · …/v1/changes/create
export interface GRRSet { name: string; type: string; ttl?: number; rrdatas?: string[] }
export const googleDns = {
  rrset: (ctx: Ctx, acc: string, p: string, mz: string, fqdn: string, type: string) =>
    gget<{ rrsets?: GRRSet[] }>(ctx, acc, `${G('dns')}/dns/v1/projects/${p}/managedZones/${mz}/rrsets?name=${encodeURIComponent(`${fqdn}.`)}&type=${type}`).then((r) => r.rrsets?.find((x) => x.name.toLowerCase() === `${fqdn}.` && x.type === type)),
  change: (ctx: Ctx, acc: string, p: string, mz: string, c: { additions?: GRRSet[]; deletions?: GRRSet[] }) =>
    gsend<{ id: string; status: string }>(ctx, acc, `${G('dns')}/dns/v1/projects/${p}/managedZones/${mz}/changes`, { body: c }),
};

// Cloud Run (Admin API v2): a service, its revisions (newest first), and a change to it, which Google carries out as a
// long-running operation. forceNewRevision makes a fresh revision from the same template (the same image).
// https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch · …/revisions/list · …/operations/get
export interface RunV2 { name: string; etag?: string; latestReadyRevision?: string; template?: { scaling?: { minInstanceCount?: number; maxInstanceCount?: number }; [k: string]: unknown }; traffic?: { type?: string; revision?: string; percent?: number }[]; [k: string]: unknown }
const runName = (p: string, region: string, s: string) => `projects/${p}/locations/${region}/services/${s}`;
export const cloudRun = {
  get: (ctx: Ctx, acc: string, p: string, region: string, s: string) => gget<RunV2>(ctx, acc, `${G('run')}/v2/${runName(p, region, s)}`),
  patch: (ctx: Ctx, acc: string, svc: RunV2, o: { forceNewRevision?: boolean; updateMask?: string } = {}) =>
    gsend<{ name: string; done?: boolean; error?: { message?: string } }>(ctx, acc, `${G('run')}/v2/${svc.name}?${new URLSearchParams({ ...(o.forceNewRevision && { forceNewRevision: 'true' }), ...(o.updateMask && { updateMask: o.updateMask }) })}`, { method: 'PATCH', body: svc }),
  revisions: (ctx: Ctx, acc: string, svcName: string) => glist<{ name: string; createTime?: string; conditions?: { type: string; state?: string }[] }>(ctx, acc, `${G('run')}/v2/${svcName}/revisions?pageSize=20`, 'revisions'),
  operation: (ctx: Ctx, acc: string, name: string) => gget<{ name: string; done?: boolean; error?: { message?: string } }>(ctx, acc, `${G('run')}/v2/${name}`),
};
// App Engine: the version taking traffic, its instances, and stopping one (App Engine starts a fresh one in its place)
// https://docs.cloud.google.com/appengine/docs/admin-api/reference/rest/v1/apps.services.versions.instances/delete
export const appEngine = {
  service: (ctx: Ctx, acc: string, p: string, s: string) => gget<{ split?: { allocations?: Record<string, number> } }>(ctx, acc, `${G('appengine')}/v1/apps/${p}/services/${s}`),
  instances: (ctx: Ctx, acc: string, p: string, s: string, v: string) => glist<{ name: string; id: string }>(ctx, acc, `${G('appengine')}/v1/apps/${p}/services/${s}/versions/${v}/instances`, 'instances'),
  stopInstance: (ctx: Ctx, acc: string, p: string, s: string, v: string, i: string) => gsend(ctx, acc, `${G('appengine')}/v1/apps/${p}/services/${s}/versions/${v}/instances/${i}`, { method: 'DELETE' }),
};
// Firebase Hosting: the live channel's releases, and a new release of a version that's already there (a re-release or
// a rollback). https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.channels.releases
export interface HostingRelease { name: string; type?: string; releaseTime?: string; version?: { name: string; status?: string } }
export const hosting = {
  releases: (ctx: Ctx, acc: string, site: string) => glist<HostingRelease>(ctx, acc, `${G('firebasehosting')}/v1beta1/sites/${site}/channels/live/releases?pageSize=20`, 'releases')
    .then((r) => r.sort((a, b) => (b.releaseTime ?? '').localeCompare(a.releaseTime ?? ''))), // the order isn't documented: newest first here
  release: (ctx: Ctx, acc: string, site: string, version: string, message: string) => gsend<HostingRelease>(ctx, acc, `${G('firebasehosting')}/v1beta1/sites/${site}/channels/live/releases?versionName=${encodeURIComponent(version)}`, { body: { message } }),
};
// Cloud Monitoring: how many bytes each Cloud SQL instance in a project stores, in one call per project (the newest point
// of the last 15 minutes). https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list
export async function sqlBytesUsed(ctx: Ctx, acc: string, p: string): Promise<Map<string, number>> {
  const end = new Date(), start = new Date(end.getTime() - 15 * 60_000);
  const q = new URLSearchParams({ filter: 'metric.type="cloudsql.googleapis.com/database/disk/bytes_used"', 'interval.startTime': start.toISOString(), 'interval.endTime': end.toISOString(), view: 'FULL' });
  const r = await gget<{ timeSeries?: { resource?: { labels?: Record<string, string> }; points?: { value?: { int64Value?: string; doubleValue?: number } }[] }[] }>(ctx, acc, `${G('monitoring')}/v3/projects/${p}/timeSeries?${q}`);
  const out = new Map<string, number>();
  for (const t of r.timeSeries ?? []) {
    const idl = t.resource?.labels?.database_id ?? '', v = t.points?.[0]?.value;
    const n = Number(v?.int64Value ?? v?.doubleValue);
    if (idl && Number.isFinite(n)) out.set(idl.split(':').pop()!, n); // "project:instance"
  }
  return out;
}
