// Azure: the Azure CLI signed in on this Mac (Unit7 asks it for a short-lived token, `az account get-access-token`),
// or a service principal pasted as TENANT_ID:CLIENT_ID:SECRET with the Reader role (Cost Management Reader for the
// bill). Azure Resource Manager over REST, read-only. UNIT7_AZURE_API / UNIT7_AZURE_LOGIN point at fakes in tests.
import type { Ctx } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';
import { cached, call, cliJson } from './cloudcli.ts';

const ARM = () => process.env.UNIT7_AZURE_API ?? 'https://management.azure.com';
const LOGIN = () => process.env.UNIT7_AZURE_LOGIN ?? 'https://login.microsoftonline.com';

export async function azureToken(ctx: Ctx, acc: string): Promise<string> {
  const { value } = ctx.credentialFor('azure', acc);
  let marker: { cli?: string; subscription?: string } | undefined;
  try { marker = JSON.parse(value); } catch { /* a service principal */ }
  const token = await cached(`azure:${acc}`, async () => {
    if (marker?.cli === 'az') {
      const r = await cliJson<{ accessToken: string; expires_on?: number }>('az', ['account', 'get-access-token', '--resource', 'https://management.azure.com/', ...(marker.subscription ? ['--subscription', marker.subscription] : []), '--output', 'json']);
      return { value: r.accessToken, until: r.expires_on ? r.expires_on * 1000 : undefined };
    }
    const [tenant, clientId, ...rest] = value.trim().split(':');
    if (!tenant || !clientId || !rest.length) throw new Unit7Error('bad_key', 'Paste the Azure sign-in as TENANT_ID:CLIENT_ID:SECRET (from the app registration).', 400);
    const r = await call<{ access_token: string; expires_in: number }>('Azure', `${LOGIN()}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      { form: { grant_type: 'client_credentials', client_id: clientId, client_secret: rest.join(':'), scope: 'https://management.azure.com/.default' } });
    return { value: r.access_token, until: Date.now() + r.expires_in * 1000 };
  });
  ctx.redactor.add(token, 'azure token');
  return token;
}

// every page (Azure's nextLink, followed only back to Azure itself)
async function arm<T>(ctx: Ctx, acc: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = `${ARM()}${path}`;
  for (let i = 0; url && i < 20; i++) {
    const r: { value?: T[]; nextLink?: string } = await call('Azure', url, { headers: { authorization: `Bearer ${await azureToken(ctx, acc)}` } });
    out.push(...(r.value ?? []));
    url = r.nextLink?.startsWith(ARM()) ? r.nextLink : undefined;
  }
  return out;
}
const sub = (s: string) => `/subscriptions/${encodeURIComponent(s)}`;
type Res<P> = { id: string; name: string; kind?: string; properties?: P };

export const azure = {
  // the subscriptions this sign-in sees; a refused sign-in fails here
  subscriptions: (ctx: Ctx, acc: string) => arm<{ subscriptionId: string; displayName: string; state?: string }>(ctx, acc, '/subscriptions?api-version=2022-12-01'),
  staticSites: (ctx: Ctx, acc: string, s: string) => arm<Res<{ defaultHostname?: string; customDomains?: string[] }>>(ctx, acc, `${sub(s)}/providers/Microsoft.Web/staticSites?api-version=2022-03-01`),
  webApps: (ctx: Ctx, acc: string, s: string) => arm<Res<{ defaultHostName?: string; hostNames?: string[]; state?: string }>>(ctx, acc, `${sub(s)}/providers/Microsoft.Web/sites?api-version=2022-03-01`),
  postgres: (ctx: Ctx, acc: string, s: string) => arm<Res<{ fullyQualifiedDomainName?: string; state?: string; version?: string }>>(ctx, acc, `${sub(s)}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=2022-12-01`),
  sqlServers: (ctx: Ctx, acc: string, s: string) => arm<Res<{ fullyQualifiedDomainName?: string; state?: string }>>(ctx, acc, `${sub(s)}/providers/Microsoft.Sql/servers?api-version=2021-11-01`),
  dnsZones: (ctx: Ctx, acc: string, s: string) => arm<Res<object>>(ctx, acc, `${sub(s)}/providers/Microsoft.Network/dnszones?api-version=2018-05-01`),
  records: (ctx: Ctx, acc: string, zoneId: string) => arm<Res<NonNullable<AzRecordSet['properties']>> & { type: string }>(ctx, acc, `${zoneId}/all?api-version=2018-05-01`),
  // this month so far, per subscription
  async monthToDate(ctx: Ctx, acc: string, s: string) {
    const r = await call<{ properties?: { columns?: { name: string }[]; rows?: unknown[][] } }>('Azure', `${ARM()}${sub(s)}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`, {
      headers: { authorization: `Bearer ${await azureToken(ctx, acc)}` }, body: { type: 'ActualCost', timeframe: 'MonthToDate', dataset: { aggregation: { totalCost: { name: 'Cost', function: 'Sum' } } } },
    });
    const cols = (r.properties?.columns ?? []).map((c) => c.name.toLowerCase()), row = r.properties?.rows?.[0] ?? [];
    return { amount: Number(row[cols.findIndex((c) => c.includes('cost'))] ?? 0), currency: String(row[cols.indexOf('currency')] ?? 'USD') };
  },
  budgets: (ctx: Ctx, acc: string, s: string) => arm<Res<{ amount?: number; currentSpend?: { amount?: number; unit?: string }; timeGrain?: string }>>(ctx, acc, `${sub(s)}/providers/Microsoft.Consumption/budgets?api-version=2023-05-01`),
};

// --- changes and money (Phase 2+): only ever called by Unit7's tools, each through the gate (tools/clouds-*.ts) -------
export async function armSend<T = any>(ctx: Ctx, acc: string, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  return call<T>('Azure', `${ARM()}${path}`, { method: o.method ?? 'POST', body: o.body, headers: { authorization: `Bearer ${await azureToken(ctx, acc)}`, ...o.headers } });
}
export const armGet = <T = any>(ctx: Ctx, acc: string, path: string) => armSend<T>(ctx, acc, path, { method: 'GET' });
export { arm as armList };
const firstOfMonth = () => `${new Date().toISOString().slice(0, 8)}01T00:00:00Z`;
export const azureMoney = {
  // a monthly budget on a subscription that emails at each threshold (at subscription scope an email is required)
  // https://learn.microsoft.com/en-us/rest/api/consumption/budgets/create-or-update
  createBudget: (ctx: Ctx, acc: string, s: string, o: { name: string; amount: number; thresholds: number[]; email: string }) =>
    armSend(ctx, acc, `${sub(s)}/providers/Microsoft.Consumption/budgets/${encodeURIComponent(o.name)}?api-version=2023-05-01`, { method: 'PUT', body: { properties: {
      category: 'Cost', amount: o.amount, timeGrain: 'Monthly', timePeriod: { startDate: firstOfMonth() },
      notifications: Object.fromEntries(o.thresholds.slice(0, 5).map((t) => [`Actual_GreaterThan_${t}_Percent`, { enabled: true, operator: 'GreaterThan', threshold: t, thresholdType: 'Actual', contactEmails: [o.email] }])),
    } } }),
  // the last 8 days, a day at a time, by resource: one query per subscription (Cost Management is throttled per tenant,
  // so it's cached for 12 hours). https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage
  daily: (ctx: Ctx, acc: string, s: string) => cached(`azure-daily:${acc}:${s}`, async () => {
    const day = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
    const r = await armSend<{ properties?: { columns?: { name: string }[]; rows?: unknown[][] } }>(ctx, acc, `${sub(s)}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`, { body: {
      type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: `${day(-8)}T00:00:00Z`, to: `${day(0)}T23:59:59Z` },
      dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }, grouping: [{ type: 'Dimension', name: 'ResourceId' }] },
    } });
    const cols = (r.properties?.columns ?? []).map((c) => c.name.toLowerCase());
    const at = (name: (c: string) => boolean) => cols.findIndex(name);
    const [ci, di, ri, ui] = [at((c) => c.includes('cost')), at((c) => c === 'usagedate'), at((c) => c === 'resourceid'), at((c) => c === 'currency')];
    const rows = (r.properties?.rows ?? []).map((row) => { const d = String(row[di] ?? ''); return { day: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, key: String(row[ri] ?? 'other'), amount: Number(row[ci] ?? 0), currency: String(row[ui] ?? 'USD') }; });
    return { value: JSON.stringify(rows), until: Date.now() + 12 * 3600_000 };
  }, 12 * 3600_000).then((v) => JSON.parse(v) as { day: string; key: string; amount: number; currency: string }[]),
};

// Azure DNS: one record set (zone resource id + type + relative name). PUT replaces that set; If-Match makes it fail
// instead of overwriting a set someone just changed, If-None-Match: * only creates. '@' is the apex.
// https://learn.microsoft.com/en-us/rest/api/dns/record-sets/create-or-update?view=rest-dns-2018-05-01
export type AzRecordSet = { etag?: string; properties?: { TTL?: number; ARecords?: { ipv4Address: string }[]; AAAARecords?: { ipv6Address: string }[]; CNAMERecord?: { cname: string }; TXTRecords?: { value: string[] }[]; MXRecords?: { preference: number; exchange: string }[]; SRVRecords?: { priority: number; weight: number; port: number; target: string }[]; caaRecords?: { flags: number; tag: string; value: string }[]; NSRecords?: { nsdname: string }[]; targetResource?: { id?: string } } };
export const azureDns = {
  get: (ctx: Ctx, acc: string, zoneId: string, type: string, rel: string) => armGet<AzRecordSet>(ctx, acc, `${zoneId}/${type}/${encodeURIComponent(rel)}?api-version=2018-05-01`).catch((e) => { if ((e as { status?: number }).status === 404) return undefined; throw e; }),
  put: (ctx: Ctx, acc: string, zoneId: string, type: string, rel: string, properties: AzRecordSet['properties'], etag?: string) =>
    armSend(ctx, acc, `${zoneId}/${type}/${encodeURIComponent(rel)}?api-version=2018-05-01`, { method: 'PUT', body: { properties }, headers: etag ? { 'if-match': etag } : { 'if-none-match': '*' } }),
  del: (ctx: Ctx, acc: string, zoneId: string, type: string, rel: string, etag?: string) =>
    armSend(ctx, acc, `${zoneId}/${type}/${encodeURIComponent(rel)}?api-version=2018-05-01`, { method: 'DELETE', headers: etag ? { 'if-match': etag } : {} }),
};

// App Service: restart, stop and start a web app (by its resource id). https://learn.microsoft.com/en-us/rest/api/appservice/web-apps/restart
export const webAppPower = (ctx: Ctx, acc: string, siteId: string, what: 'restart' | 'stop' | 'start') => armSend(ctx, acc, `${siteId}/${what}?api-version=2024-11-01`);
// Azure Monitor: the newest value of one metric of a resource over the last hour (bytes stored by a database)
// https://learn.microsoft.com/en-us/rest/api/monitor/metrics/list?view=rest-monitor-2023-10-01
export async function metricMax(ctx: Ctx, acc: string, resourceId: string, metric: string): Promise<number | undefined> {
  const end = new Date(), start = new Date(end.getTime() - 3600_000);
  const r = await armGet<{ value?: { timeseries?: { data?: { maximum?: number }[] }[] }[] }>(ctx, acc, `${resourceId}/providers/Microsoft.Insights/metrics?api-version=2023-10-01&metricnames=${metric}&timespan=${start.toISOString()}/${end.toISOString()}&interval=PT15M&aggregation=Maximum`);
  const pts = (r.value?.[0]?.timeseries ?? []).flatMap((t) => t.data ?? []).map((d) => d.maximum).filter((n): n is number => typeof n === 'number');
  return pts.length ? pts[pts.length - 1] : undefined;
}
