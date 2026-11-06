// AWS: the AWS CLI signed in on this Mac (Unit7 asks it for short-lived keys each time, `aws configure
// export-credentials`), or an access key pasted as KEY_ID:SECRET (a user with ReadOnlyAccess). Every request is
// signed (SigV4, the signer in s3.ts). AWS speaks four dialects: XML queries (STS, EC2, RDS), JSON with a target
// header (Lightsail, Route 53 Domains, Cost Explorer, Budgets), REST JSON (Amplify) and REST XML (Route 53).
// Everything here only reads. UNIT7_AWS_API points every host at a fake for offline tests.
import { createHash } from 'node:crypto';
import type { Ctx } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';
import { signV4 } from './s3.ts';
import { cached, cliJson } from './cloudcli.ts';

type Creds = { accessKeyId: string; secret: string; token?: string };
export async function awsCreds(ctx: Ctx, acc: string): Promise<Creds> {
  const { value } = ctx.credentialFor('aws', acc);
  let marker: { cli?: string; profile?: string } | undefined;
  try { marker = JSON.parse(value); } catch { /* a pasted key */ }
  if (marker?.cli === 'aws') {
    const raw = await cached(`aws:${acc}`, async () => {
      const r = await cliJson<{ AccessKeyId: string; SecretAccessKey: string; SessionToken?: string; Expiration?: string }>('aws', ['configure', 'export-credentials', '--profile', marker!.profile ?? 'default', '--format', 'process']);
      return { value: JSON.stringify(r), until: r.Expiration ? Date.parse(r.Expiration) : undefined };
    });
    const r = JSON.parse(raw) as { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string };
    ctx.redactor.add(r.SecretAccessKey, 'aws secret');
    if (r.SessionToken) ctx.redactor.add(r.SessionToken, 'aws session');
    return { accessKeyId: r.AccessKeyId, secret: r.SecretAccessKey, token: r.SessionToken };
  }
  const [accessKeyId, secret] = value.trim().split(':');
  if (!accessKeyId || !secret || !/^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(accessKeyId)) throw new Unit7Error('bad_key', 'Paste the AWS access key as KEY_ID:SECRET (the ID starts with AKIA).', 400);
  return { accessKeyId, secret };
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
// what AWS says when the key itself is no good (as opposed to "this key may not do that")
const REFUSED = /^(InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken|ExpiredTokenException|UnrecognizedClientException|AuthFailure|InvalidAccessKeyId|IncompleteSignature|InvalidSignatureException)$/;

export async function awsCall(ctx: Ctx, acc: string, o: { host: string; region: string; service: string; method?: string; path?: string; query?: Record<string, string>; target?: string; body?: unknown; xml?: string }): Promise<string> {
  const c = await awsCreds(ctx, acc);
  const url = new URL(`${process.env.UNIT7_AWS_API ? `${process.env.UNIT7_AWS_API}/${o.host}` : `https://${o.host}`}${o.path ?? '/'}`);
  await assertReachable(url.hostname);
  const query = Object.entries(o.query ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  // a REST-XML body (Route 53's ChangeResourceRecordSets) is sent as it is
  const body = o.xml ?? (o.body === undefined ? '' : JSON.stringify(o.body));
  const method = o.method ?? (o.body !== undefined || o.xml !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { host: url.host, 'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), 'x-amz-content-sha256': hex(body),
    ...(c.token && { 'x-amz-security-token': c.token }), ...(o.target ? { 'x-amz-target': o.target, 'content-type': 'application/x-amz-json-1.1' } : o.xml !== undefined ? { 'content-type': 'text/xml' } : o.body !== undefined && { 'content-type': 'application/json' }) };
  const authorization = signV4({ method, path: url.pathname, query, headers, region: o.region, accessKeyId: c.accessKeyId, secret: c.secret, service: o.service });
  const res = await fetch(`${url.origin}${url.pathname}${query ? `?${query}` : ''}`, { method, headers: { ...headers, authorization, accept: o.target || o.service === 'amplify' ? 'application/json' : 'application/xml' }, body: body || undefined, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) {
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? /"__type"\s*:\s*"(?:[^"#]*#)?([^"]+)"/.exec(text)?.[1] ?? res.headers.get('x-amzn-errortype')?.split(':')[0] ?? '';
    const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? /"[mM]essage"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? res.statusText;
    const status = REFUSED.test(code) ? 401 : res.status === 429 || /Throttl/.test(code) ? 429 : res.status === 404 ? 404 : 403;
    // only a refused key may say "unauthorized": a key that just may not do one thing (UnauthorizedOperation) mustn't stop it
    throw new Unit7Error(status === 401 ? 'provider_refused' : 'provider_error', `AWS: ${status === 401 ? `unauthorized, ${code}: ` : ''}${msg}`.slice(0, 300), status);
  }
  return text;
}
const json = async <T>(p: Promise<string>) => JSON.parse(await p) as T;

// tiny XML reading: the value of a tag, every block of a tag (blocks that don't nest)
export const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
export const blocks = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]!);
const unxml = (s?: string) => s?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

// ponytail: Lightsail runs in these regions only (2026); asking the others just fails, so they're skipped
const LIGHTSAIL = new Set(['us-east-1', 'us-east-2', 'us-west-2', 'ca-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3']);
export { LIGHTSAIL };

export const aws = {
  // who this key is; a refused key fails here, before anything else is asked
  whoami: async (ctx: Ctx, acc: string) => {
    const x = await awsCall(ctx, acc, { host: 'sts.amazonaws.com', region: 'us-east-1', service: 'sts', query: { Action: 'GetCallerIdentity', Version: '2011-06-15' } });
    return { account: tag(x, 'Account')!, arn: tag(x, 'Arn') ?? '' };
  },
  regions: async (ctx: Ctx, acc: string) => blocks(await awsCall(ctx, acc, { host: 'ec2.us-east-1.amazonaws.com', region: 'us-east-1', service: 'ec2', query: { Action: 'DescribeRegions', Version: '2016-11-15' } }), 'regionName'),
  // ponytail: one page each (1000 instances, 100 databases a region); add NextToken / Marker paging when someone has more
  async instances(ctx: Ctx, acc: string, region: string) {
    const x = await awsCall(ctx, acc, { host: `ec2.${region}.amazonaws.com`, region, service: 'ec2', query: { Action: 'DescribeInstances', Version: '2016-11-15', MaxResults: '1000' } });
    // an instance's fields run from its instanceId to the next one (its tags and network cards nest <item>s)
    return x.split('<instanceId>').slice(1).map((chunk) => ({ id: chunk.slice(0, chunk.indexOf('<')), state: /<instanceState>\s*<code>\d+<\/code>\s*<name>([^<]+)<\/name>/.exec(chunk)?.[1],
      ip: tag(chunk, 'ipAddress'), name: unxml(/<key>Name<\/key>\s*<value>([^<]*)<\/value>/.exec(chunk)?.[1]) }));
  },
  async databases(ctx: Ctx, acc: string, region: string) {
    const x = await awsCall(ctx, acc, { host: `rds.${region}.amazonaws.com`, region, service: 'rds', query: { Action: 'DescribeDBInstances', Version: '2014-10-31', MaxRecords: '100' } });
    return blocks(x, 'DBInstance').map((d) => ({ id: tag(d, 'DBInstanceIdentifier')!, engine: tag(d, 'Engine'), status: tag(d, 'DBInstanceStatus'), host: tag(d, 'Address'), allocatedGiB: Number(tag(d, 'AllocatedStorage') ?? 0) || undefined }));
  },
  lightsail: async (ctx: Ctx, acc: string, region: string) => (await json<{ instances?: { name: string; publicIpAddress?: string; state?: { name?: string }; blueprintId?: string }[] }>(
    awsCall(ctx, acc, { host: `lightsail.${region}.amazonaws.com`, region, service: 'lightsail', target: 'Lightsail_20161128.GetInstances', body: {} }))).instances ?? [],
  amplifyApps: async (ctx: Ctx, acc: string, region: string) => (await json<{ apps?: { appId: string; name: string; defaultDomain: string; productionBranch?: { branchName?: string; status?: string } }[] }>(
    awsCall(ctx, acc, { host: `amplify.${region}.amazonaws.com`, region, service: 'amplify', path: '/apps', query: { maxResults: '100' } }))).apps ?? [],
  amplifyDomains: async (ctx: Ctx, acc: string, region: string, appId: string) => (await json<{ domainAssociations?: { domainName: string; subDomains?: { subDomainSetting?: { prefix?: string } }[] }[] }>(
    awsCall(ctx, acc, { host: `amplify.${region}.amazonaws.com`, region, service: 'amplify', path: `/apps/${appId}/domains` }))).domainAssociations ?? [],
  zones: async (ctx: Ctx, acc: string) => blocks(await awsCall(ctx, acc, { host: 'route53.amazonaws.com', region: 'us-east-1', service: 'route53', path: '/2013-04-01/hostedzone' }), 'HostedZone')
    .map((z) => ({ id: tag(z, 'Id')!.replace('/hostedzone/', ''), name: tag(z, 'Name')!.replace(/\.$/, '').toLowerCase(), private: tag(z, 'PrivateZone') === 'true' })),
  async records(ctx: Ctx, acc: string, zoneId: string) {
    const x = await awsCall(ctx, acc, { host: 'route53.amazonaws.com', region: 'us-east-1', service: 'route53', path: `/2013-04-01/hostedzone/${zoneId}/rrset` });
    // an alias (A → CloudFront, a load balancer…) counts as an ALIAS to that name
    return blocks(x, 'ResourceRecordSet').flatMap((r) => {
      const name = tag(r, 'Name')!.replace(/\.$/, ''), alias = tag(r, 'DNSName');
      if (name.includes('\\')) return []; // wildcards come escaped (\052)
      return alias ? [{ name, type: 'ALIAS', value: alias.replace(/\.$/, '').replace(/^dualstack\./, '') }] : blocks(r, 'Value').map((v) => ({ name, type: tag(r, 'Type')!, value: unxml(v)! }));
    });
  },
  registered: async (ctx: Ctx, acc: string) => (await json<{ Domains?: { DomainName: string; AutoRenew?: boolean; Expiry?: number }[] }>(
    awsCall(ctx, acc, { host: 'route53domains.us-east-1.amazonaws.com', region: 'us-east-1', service: 'route53domains', target: 'Route53Domains_v20140515.ListDomains', body: { MaxItems: 100 } }))).Domains ?? [],
  // this month so far. AWS charges a cent per Cost Explorer request, so it's asked at most twice a day per account.
  monthToDate: (ctx: Ctx, acc: string) => cached(`aws-cost:${acc}`, async () => {
    const now = new Date(), start = `${now.toISOString().slice(0, 8)}01`, end = new Date(now.getTime() + 86400_000).toISOString().slice(0, 10);
    const r = await json<{ ResultsByTime?: { Total?: { UnblendedCost?: { Amount: string; Unit: string } } }[] }>(awsCall(ctx, acc, { host: 'ce.us-east-1.amazonaws.com', region: 'us-east-1', service: 'ce', target: 'AWSInsightsIndexService.GetCostAndUsage',
      body: { TimePeriod: { Start: start, End: end }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'] } }));
    const t = r.ResultsByTime?.[0]?.Total?.UnblendedCost;
    return { value: JSON.stringify({ amount: Number(t?.Amount ?? 0), currency: t?.Unit ?? 'USD' }), until: Date.now() + 12 * 3600_000 };
  }, 12 * 3600_000).then((v) => JSON.parse(v) as { amount: number; currency: string }),
  budgets: async (ctx: Ctx, acc: string, accountId: string) => (await json<{ Budgets?: { BudgetName: string; BudgetLimit?: { Amount: string; Unit: string }; CalculatedSpend?: { ActualSpend?: { Amount: string } }; TimeUnit?: string }[] }>(
    awsCall(ctx, acc, { host: 'budgets.amazonaws.com', region: 'us-east-1', service: 'budgets', target: 'AWSBudgetServiceGateway.DescribeBudgets', body: { AccountId: accountId, MaxResults: 100 } }))).Budgets ?? [],
};

// --- money (Phase 2/3): a budget with email alerts, and the last days' spend by service --------------------------
// CreateBudget: notifications are free; only budgets with actions cost money (none here).
// https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_CreateBudget.html · https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/
export const awsMoney = {
  createBudget: (ctx: Ctx, acc: string, o: { accountId: string; name: string; amount: number; currency: string; thresholds: number[]; email: string }) =>
    awsCall(ctx, acc, { host: 'budgets.amazonaws.com', region: 'us-east-1', service: 'budgets', target: 'AWSBudgetServiceGateway.CreateBudget', body: {
      AccountId: o.accountId,
      Budget: { BudgetName: o.name, BudgetLimit: { Amount: o.amount.toFixed(2), Unit: o.currency }, TimeUnit: 'MONTHLY', BudgetType: 'COST' },
      NotificationsWithSubscribers: o.thresholds.slice(0, 5).map((t) => ({ Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: t, ThresholdType: 'PERCENTAGE' }, Subscribers: [{ SubscriptionType: 'EMAIL', Address: o.email }] })),
    } }),
  // the last 8 days, a day at a time, by service: one Cost Explorer request (a cent), asked at most twice a day per account
  // (End is exclusive). https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html
  daily: (ctx: Ctx, acc: string) => cached(`aws-daily:${acc}`, async () => {
    const day = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
    const r = await json<{ ResultsByTime?: { TimePeriod: { Start: string }; Groups?: { Keys: string[]; Metrics: { UnblendedCost: { Amount: string; Unit: string } } }[] }[] }>(awsCall(ctx, acc, { host: 'ce.us-east-1.amazonaws.com', region: 'us-east-1', service: 'ce', target: 'AWSInsightsIndexService.GetCostAndUsage',
      body: { TimePeriod: { Start: day(-8), End: day(1) }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] } }));
    const rows = (r.ResultsByTime ?? []).flatMap((t) => (t.Groups ?? []).map((g) => ({ day: t.TimePeriod.Start, key: g.Keys[0] ?? 'Other', amount: Number(g.Metrics.UnblendedCost.Amount), currency: g.Metrics.UnblendedCost.Unit })));
    return { value: JSON.stringify(rows), until: Date.now() + 12 * 3600_000 };
  }, 12 * 3600_000).then((v) => JSON.parse(v) as { day: string; key: string; amount: number; currency: string }[]),
};

// Route 53: one record set read (ListResourceRecordSets starts AT name+type, so the answer is checked), and changed with
// ChangeResourceRecordSets: UPSERT replaces that one name + type; DELETE must name the set exactly (TTL and every value).
// https://docs.aws.amazon.com/Route53/latest/APIReference/API_ListResourceRecordSets.html · …/API_ChangeResourceRecordSets.html
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export interface R53Set { name: string; type: string; ttl: number; values: string[]; alias?: string }
export const route53 = {
  async get(ctx: Ctx, acc: string, zoneId: string, fqdn: string, type: string): Promise<R53Set | undefined> {
    const x = await awsCall(ctx, acc, { host: 'route53.amazonaws.com', region: 'us-east-1', service: 'route53', path: `/2013-04-01/hostedzone/${zoneId}/rrset`, query: { name: `${fqdn}.`, type, maxitems: '1' } });
    const r = blocks(x, 'ResourceRecordSet')[0];
    if (!r || tag(r, 'Name')?.replace(/\.$/, '').toLowerCase() !== fqdn || tag(r, 'Type') !== type) return undefined;
    return { name: fqdn, type, ttl: Number(tag(r, 'TTL') ?? 300), values: blocks(r, 'Value').map((v) => unxml(v)!), alias: tag(r, 'DNSName') };
  },
  // every set in the zone, page by page (Route 53 writes a wildcard's * as \052); an alias shows as an ALIAS to its target
  async list(ctx: Ctx, acc: string, zoneId: string) {
    const out: { name: string; type: string; ttl?: number; values: string[] }[] = [];
    let next: Record<string, string> = {};
    for (let page = 0; page < 50; page++) {
      const x = await awsCall(ctx, acc, { host: 'route53.amazonaws.com', region: 'us-east-1', service: 'route53', path: `/2013-04-01/hostedzone/${zoneId}/rrset`, query: { maxitems: '300', ...next } });
      for (const r of blocks(x, 'ResourceRecordSet')) {
        const alias = tag(r, 'DNSName');
        out.push({ name: tag(r, 'Name')!.replace(/\\052/g, '*').replace(/\.$/, ''), type: alias ? 'ALIAS' : tag(r, 'Type')!, ttl: Number(tag(r, 'TTL') ?? 0) || undefined, values: alias ? [alias] : blocks(r, 'Value').map((v) => unxml(v)!) });
      }
      if (tag(x, 'IsTruncated') !== 'true') break;
      next = { name: tag(x, 'NextRecordName')!, type: tag(x, 'NextRecordType')! };
    }
    return out;
  },
  change: (ctx: Ctx, acc: string, zoneId: string, action: 'UPSERT' | 'DELETE', s: R53Set) => awsCall(ctx, acc, { host: 'route53.amazonaws.com', region: 'us-east-1', service: 'route53', path: `/2013-04-01/hostedzone/${zoneId}/rrset/`,
    xml: `<?xml version="1.0" encoding="UTF-8"?><ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Comment>Unit7</Comment><Changes><Change><Action>${action}</Action><ResourceRecordSet><Name>${esc(s.name)}.</Name><Type>${s.type}</Type><TTL>${s.ttl}</TTL><ResourceRecords>${s.values.map((v) => `<ResourceRecord><Value>${esc(v)}</Value></ResourceRecord>`).join('')}</ResourceRecords></ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>` }),
};

// --- power and deploys (Phase 2/4): reboot, stop and start a machine; Amplify builds ---------------------------------
// EC2 (query API): https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_StopInstances.html (and Start/Reboot)
// Lightsail (JSON 1.1): https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_StopInstance.html
// Amplify (REST JSON): https://docs.aws.amazon.com/amplify/latest/APIReference/API_StartJob.html · …/API_ListJobs.html · …/API_GetJob.html
export type Power = 'reboot' | 'stop' | 'start';
const EC2_ACTION: Record<Power, string> = { reboot: 'RebootInstances', stop: 'StopInstances', start: 'StartInstances' };
const LS_ACTION: Record<Power, string> = { reboot: 'RebootInstance', stop: 'StopInstance', start: 'StartInstance' };
export interface AmplifyJob { jobId: string; status?: string; commitId?: string; startTime?: number | string; jobType?: string }
export const awsOps = {
  ec2: (ctx: Ctx, acc: string, region: string, id: string, what: Power) => awsCall(ctx, acc, { host: `ec2.${region}.amazonaws.com`, region, service: 'ec2', query: { Action: EC2_ACTION[what], Version: '2016-11-15', 'InstanceId.1': id } }),
  lightsail: (ctx: Ctx, acc: string, region: string, name: string, what: Power) => awsCall(ctx, acc, { host: `lightsail.${region}.amazonaws.com`, region, service: 'lightsail', target: `Lightsail_20161128.${LS_ACTION[what]}`, body: { instanceName: name } }),
  amplifyApp: async (ctx: Ctx, acc: string, region: string, appId: string) => (await json<{ app: { appId: string; name: string; repository?: string; productionBranch?: { branchName?: string } } }>(
    awsCall(ctx, acc, { host: `amplify.${region}.amazonaws.com`, region, service: 'amplify', path: `/apps/${appId}` }))).app,
  amplifyJobs: async (ctx: Ctx, acc: string, region: string, appId: string, branch: string) => ((await json<{ jobSummaries?: AmplifyJob[] }>(
    awsCall(ctx, acc, { host: `amplify.${region}.amazonaws.com`, region, service: 'amplify', path: `/apps/${appId}/branches/${encodeURIComponent(branch)}/jobs`, query: { maxResults: '20' } }))).jobSummaries ?? [])
    .sort((a, b) => Number(b.jobId) - Number(a.jobId)), // the order isn't documented: job ids count up, newest first here
  amplifyStart: async (ctx: Ctx, acc: string, region: string, appId: string, branch: string, body: { jobType: 'RELEASE' | 'RETRY'; jobId?: string; jobReason: string }) => (await json<{ jobSummary: AmplifyJob }>(
    awsCall(ctx, acc, { host: `amplify.${region}.amazonaws.com`, region, service: 'amplify', path: `/apps/${appId}/branches/${encodeURIComponent(branch)}/jobs`, body }))).jobSummary,
  amplifyJob: async (ctx: Ctx, acc: string, region: string, appId: string, branch: string, jobId: string) => (await json<{ job: { summary: AmplifyJob } }>(
    awsCall(ctx, acc, { host: `amplify.${region}.amazonaws.com`, region, service: 'amplify', path: `/apps/${appId}/branches/${encodeURIComponent(branch)}/jobs/${jobId}` }))).job.summary,
  // CloudWatch (query API, free within the first million requests a month): the smallest free space an RDS database
  // had in the last hour, in bytes. https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricStatistics.html
  async rdsFreeBytes(ctx: Ctx, acc: string, region: string, db: string): Promise<number | undefined> {
    const end = new Date(), start = new Date(end.getTime() - 3600_000);
    const x = await awsCall(ctx, acc, { host: `monitoring.${region}.amazonaws.com`, region, service: 'monitoring', query: { Action: 'GetMetricStatistics', Version: '2010-08-01', Namespace: 'AWS/RDS', MetricName: 'FreeStorageSpace',
      'Dimensions.member.1.Name': 'DBInstanceIdentifier', 'Dimensions.member.1.Value': db, StartTime: start.toISOString(), EndTime: end.toISOString(), Period: '3600', 'Statistics.member.1': 'Minimum' } });
    const v = blocks(x, 'member').map((m) => Number(tag(m, 'Minimum'))).filter(Number.isFinite);
    return v.length ? Math.min(...v) : undefined;
  },
};
