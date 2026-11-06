// The big clouds, acting (all offline, against fakes): redeploys, restarts and rollbacks with honest tiers; a spending
// alert in one click; Google's spend from the billing export; a cost spike with the plan to stop it (always a person,
// never a delete, Undo starts it again); and database sizes on the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { testApp, testOrg, ok } from './helpers.ts';
import { fakeApi, account } from './clouds-fakes.ts';
import { deployTiming } from '../src/tools/clouds-deploy.ts';
import { spikeOf, culpritsOf, exportSql, ALERT_NAME } from '../src/tools/clouds-money.ts';
import { all, get, run } from '../src/db.ts';
import type { App } from '../src/app.ts';

process.env.UNIT7_GCLOUD_BIN = fileURLToPath(new URL('./fake-cloud-cli.mjs', import.meta.url));
deployTiming.pollMs = 1;
const GCLOUD = JSON.stringify({ cli: 'gcloud', account: 'sam@example.com' });
const AWSKEY = 'AKIAEXAMPLEGOOD1234:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const asset = (app: App, orgId: string, id: string, acc: string, provider: string, kind: string, ext: string, name: string, meta: object = {}) =>
  run(app.db, `INSERT INTO assets (id, org_id, account_id, provider, kind, ext_id, name, meta, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-07')`, id, orgId, acc, provider, kind, ext, name, JSON.stringify(meta));
const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8"?>${s}`;
const day = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);

test('spike: the day before (or today’s run-rate) at 3× the week before and $5 a day more; culprits by what rose most', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const rows = (ec2Yesterday: number) => [...Array(9)].flatMap((_x, k) => {
    const d = new Date(now.getTime() + (k - 8) * 86400_000).toISOString().slice(0, 10);
    return [{ day: d, key: 'EC2', amount: k === 7 ? ec2Yesterday : 2, currency: 'USD' }, { day: d, key: 'S3', amount: 0.3, currency: 'USD' }];
  });
  const hot = spikeOf(rows(30), now);
  assert.equal(hot.spike, true);
  assert.equal(hot.normal, 2.3);
  assert.equal(hot.latest, 30.3);
  assert.equal(spikeOf(rows(6), now).spike, false, 'about 3× but only $4 more: not worth waking anyone');
  assert.equal(culpritsOf(rows(30), now)[0]!.key, 'EC2');
  // today so far, as a run-rate, after a few hours
  const today = [...rows(2), { day: '2026-10-08', key: 'EC2', amount: 20, currency: 'USD' }];
  assert.equal(spikeOf(today, now).runRate, 44.6, '22.30 in 12 hours');
  assert.equal(spikeOf(today, now).spike, true);
  assert.equal(spikeOf(today, new Date('2026-10-08T01:00:00Z')).runRate, 0, 'not in the first hours of a day');
});

// --- redeploys ------------------------------------------------------------------------------------------------------
test('cloud.redeploy: Cloud Run, Firebase Hosting, Amplify and EC2, each with its honest tier and plain progress', async () => {
  const svc = { name: 'projects/shop-prod/locations/us-central1/services/api', etag: 'e1', latestReadyRevision: 'projects/shop-prod/locations/us-central1/services/api/revisions/api-00003', traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }] as any[], template: { scaling: { maxInstanceCount: 20 } } };
  const patches: { query: string; body: any }[] = [], releases: string[] = [], jobs: any[] = [], ec2: string[] = [];
  const rev = (n: number, ok = true) => ({ name: `${svc.name}/revisions/api-0000${n}`, conditions: [{ type: 'Ready', state: ok ? 'CONDITION_SUCCEEDED' : 'CONDITION_FAILED' }] });
  const api = await fakeApi(({ method, path, body, auth }) => {
    const u = new URL(path, 'http://x');
    if (u.pathname.startsWith('/run/')) {
      if (auth !== 'Bearer ya29.from-gcloud') return [401, {}];
      if (u.pathname === `/run/v2/${svc.name}` && method === 'GET') return svc;
      if (u.pathname === `/run/v2/${svc.name}` && method === 'PATCH') { patches.push({ query: u.search, body: JSON.parse(body) }); if (u.searchParams.get('forceNewRevision')) svc.latestReadyRevision = `${svc.name}/revisions/api-00004`; svc.traffic = JSON.parse(body).traffic; return { name: 'projects/shop-prod/locations/us-central1/operations/op1', done: false }; }
      if (u.pathname === '/run/v2/projects/shop-prod/locations/us-central1/operations/op1') return { name: 'op1', done: true };
      if (u.pathname === `/run/v2/${svc.name}/revisions`) return { revisions: [rev(4), rev(3), rev(2, false), rev(1)] };
    }
    if (u.pathname === '/firebasehosting/v1beta1/sites/shop-web/channels/live/releases' && method === 'GET') return { releases: [
      { name: 'r1', releaseTime: '2026-10-01T00:00:00Z', version: { name: 'sites/shop-web/versions/v1', status: 'FINALIZED' } },
      { name: 'r2', releaseTime: '2026-10-05T00:00:00Z', version: { name: 'sites/shop-web/versions/v2', status: 'FINALIZED' } }] };
    if (u.pathname === '/firebasehosting/v1beta1/sites/shop-web/channels/live/releases' && method === 'POST') { releases.push(u.searchParams.get('versionName')!); return { name: 'r3' }; }
    if (u.pathname === '/amplify.us-east-1.amazonaws.com/apps/d1abc') return { app: { appId: 'd1abc', name: 'shop-site', repository: 'https://github.com/example/shop', productionBranch: { branchName: 'main' } } };
    if (u.pathname === '/amplify.us-east-1.amazonaws.com/apps/d1abc/branches/main/jobs' && method === 'GET') return { jobSummaries: [{ jobId: '10', status: 'SUCCEED' }, { jobId: '12', status: 'SUCCEED' }, { jobId: '11', status: 'FAILED' }] };
    if (u.pathname === '/amplify.us-east-1.amazonaws.com/apps/d1abc/branches/main/jobs' && method === 'POST') { jobs.push(JSON.parse(body)); return { jobSummary: { jobId: '13', status: 'PENDING' } }; }
    if (u.pathname === '/amplify.us-east-1.amazonaws.com/apps/d1abc/branches/main/jobs/13') return { job: { summary: { jobId: '13', status: 'SUCCEED' } } };
    if (u.pathname === '/ec2.us-east-1.amazonaws.com/') { ec2.push(u.searchParams.get('Action')!); return xml('<RebootInstancesResponse><return>true</return></RebootInstancesResponse>'); }
  });
  process.env.UNIT7_GOOGLE_API = api.base; process.env.UNIT7_AWS_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const g = account(app, o.orgId, 'gcp', GCLOUD, 'Google Cloud'), a = account(app, o.orgId, 'aws', AWSKEY, 'AWS');
    asset(app, o.orgId, 'ast_cloudrun0001', g, 'cloudrun', 'app', 'shop-prod/us-central1/api', 'api');
    asset(app, o.orgId, 'ast_hosting00001', g, 'firebase', 'app', 'shop-prod/hosting/shop-web', 'shop-web');
    asset(app, o.orgId, 'ast_amplify00001', a, 'amplify', 'app', 'us-east-1/d1abc', 'shop-site');
    asset(app, o.orgId, 'ast_ec2machine01', a, 'ec2', 'server', 'us-east-1/i-0aaa', 'web');
    asset(app, o.orgId, 'ast_swa000000001', a, 'azure', 'app', 'swa/sub/site', 'static');

    // an AI may restart by itself (easy to undo); a redeploy changes what's live, so it asks first
    const r = ok(await o.a('cloud.redeploy', { asset: 'ast_ec2machine01', mode: 'restart' }));
    assert.equal(r.said, 'rebooting; it’s back in a minute or two');
    assert.deepEqual(ec2, ['RebootInstances']);
    const asked = await o.a('cloud.redeploy', { asset: 'ast_cloudrun0001' });
    assert.equal(asked.status, 'approval_required');
    assert.match((asked as any).why, /new revision of api from the same image/);

    const d = ok(await o.h('cloud.redeploy', { asset: 'ast_cloudrun0001' }));
    assert.equal(patches[0]!.query, '?forceNewRevision=true', 'a fresh revision from the same template');
    assert.deepEqual(patches[0]!.body.traffic, [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }]);
    assert.equal(d.revision, 'api-00004');
    assert.deepEqual(d.undo, { tool: 'cloud.redeploy', input: { asset: 'ast_cloudrun0001', mode: 'rollback' } }, 'the toast offers Undo');
    const back = ok(await o.h('cloud.redeploy', { asset: 'ast_cloudrun0001', mode: 'rollback' }));
    assert.equal(patches[1]!.query, '?updateMask=traffic');
    assert.deepEqual(patches[1]!.body.traffic, [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'api-00003', percent: 100 }], 'the working revision before the live one');
    assert.equal(back.said, 'rolled back to api-00003');

    ok(await o.h('cloud.redeploy', { asset: 'ast_hosting00001', mode: 'rollback' }));
    assert.deepEqual(releases, ['sites/shop-web/versions/v1'], 'the release before the live one (newest first, whatever order Google lists them)');

    const built = ok(await o.h('cloud.redeploy', { asset: 'ast_amplify00001' }));
    assert.deepEqual(jobs[0], { jobType: 'RELEASE', jobReason: 'Redeployed by Unit7' });
    assert.equal(built.said, 'build 13 is live');
    ok(await o.h('cloud.redeploy', { asset: 'ast_amplify00001', mode: 'rollback' }));
    assert.deepEqual(jobs[1], { jobType: 'RETRY', jobId: '10', jobReason: 'Rolled back by Unit7' }, 'the last good build before the live one');

    const swa = await o.h('cloud.redeploy', { asset: 'ast_swa000000001' });
    assert.match((swa as any).error.message, /rebuild from your code/);
    assert.ok(all<{ type: string }>(app.db, 'SELECT type FROM events WHERE org_id = ?', o.orgId).some((e) => e.type === 'cloud.rolled_back'));
  } finally { api.close(); delete process.env.UNIT7_GOOGLE_API; delete process.env.UNIT7_AWS_API; }
});

// --- AWS money: an alert, a spike, the stop plan --------------------------------------------------------------------
function awsMoneyApi(state: { budgets: any[]; created: any[]; ec2: string[]; ce: number }) {
  return ({ method, path, body }: { method: string; path: string; body: string }) => {
    const u = new URL(path, 'http://x');
    if (u.pathname.startsWith('/sts.amazonaws.com')) return xml('<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/unit7</Arn><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>');
    if (u.pathname.startsWith('/budgets.amazonaws.com')) {
      const b = JSON.parse(body);
      if (b.Budget) { state.created.push(b); state.budgets.push({ BudgetName: b.Budget.BudgetName, BudgetLimit: b.Budget.BudgetLimit }); return {}; }
      return { Budgets: state.budgets };
    }
    if (u.pathname.startsWith('/ce.us-east-1.amazonaws.com')) {
      state.ce++;
      const b = JSON.parse(body);
      if (b.Granularity === 'MONTHLY') return { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '60', Unit: 'USD' } } }] };
      const out = [];
      for (let k = -8; k <= 0; k++) out.push({ TimePeriod: { Start: day(k) }, Groups: [
        { Keys: ['Amazon Elastic Compute Cloud - Compute'], Metrics: { UnblendedCost: { Amount: String(k === -1 ? 40 : 1), Unit: 'USD' } } },
        { Keys: ['AWS Amplify'], Metrics: { UnblendedCost: { Amount: '0.5', Unit: 'USD' } } }] });
      return { ResultsByTime: out };
    }
    if (u.pathname === '/ec2.us-east-1.amazonaws.com/' && method === 'GET') { state.ec2.push(`${u.searchParams.get('Action')} ${u.searchParams.get('InstanceId.1')}`); return xml('<StopInstancesResponse/>'); }
  };
}

test('AWS: a spending alert in one click, a spike with the plan to stop it, and Undo starts it again', async () => {
  const state = { budgets: [] as any[], created: [] as any[], ec2: [] as string[], ce: 0 };
  const api = await fakeApi(awsMoneyApi(state));
  process.env.UNIT7_AWS_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = account(app, o.orgId, 'aws', AWSKEY, 'AWS');
    asset(app, o.orgId, 'ast_ec2machine01', acc, 'ec2', 'server', 'us-east-1/i-0aaa', 'web');
    asset(app, o.orgId, 'ast_ec2machine02', acc, 'ec2', 'server', 'us-east-1/i-0bbb', 'old', { status: 'stopped' });
    run(app.db, 'UPDATE orgs SET autonomy = 4 WHERE id = ?', o.orgId); // Full autopilot: still a person's yes

    const asked = await o.a('cloud.budget_set', { accountId: acc, amount: 40 });
    assert.equal(asked.status, 'approval_required', 'an AI asks, even at Full autopilot');
    assert.match((asked as any).why, /only with a person’s yes/);
    const set = ok(await o.h('cloud.budget_set', { accountId: acc, amount: 40 }));
    const email = get<{ email: string }>(app.db, 'SELECT email FROM users WHERE id = ?', o.userId)!.email;
    assert.equal(set.emails, email, 'alerts go to the person who set it');
    assert.deepEqual(state.created[0], { AccountId: '123456789012', Budget: { BudgetName: ALERT_NAME, BudgetLimit: { Amount: '40.00', Unit: 'USD' }, TimeUnit: 'MONTHLY', BudgetType: 'COST' },
      NotificationsWithSubscribers: [50, 90, 100].map((t) => ({ Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: t, ThresholdType: 'PERCENTAGE' }, Subscribers: [{ SubscriptionType: 'EMAIL', Address: email }] })) });
    assert.equal((await o.h('cloud.budget_set', { accountId: acc, amount: 40 }) as any).error.code, 'exists', 'never twice');

    const s = ok(await o.h('cloud.spend', { accountId: acc }));
    assert.equal(s.spike.spike, true);
    assert.equal(s.days.length, 9);
    assert.equal(s.culprits[0].name, 'Amazon Elastic Compute Cloud - Compute');
    assert.deepEqual(s.steps.map((x: any) => x.id), ['ec2:us-east-1/i-0aaa'], 'the running machine; the stopped one isn’t offered');
    assert.match(s.steps[0].what, /not terminate/);
    assert.equal(s.doNothing24h, 40.5);
    const ceAfter = state.ce;
    ok(await o.h('cloud.spend', { accountId: acc }));
    assert.equal(state.ce, ceAfter, 'Cost Explorer costs a cent a call: remembered for 12 hours');

    // Warden's twice-daily look: one alert a day
    ok(await o.h('cloud.spend_watch'));
    ok(await o.h('cloud.spend_watch'));
    const alerts = all<{ message: string; severity: string }>(app.db, `SELECT message, severity FROM events WHERE org_id = ? AND type = 'cost.spike'`, o.orgId);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.message, /Spending on AWS jumped: about 40\.50 USD a day against 1\.50 USD usually\. Unit7 has a plan/);

    // stopping always waits for a person, and a person types the account's name
    const ai = await o.a('cloud.stop_runaway', { accountId: acc, steps: ['ec2:us-east-1/i-0aaa'], confirmName: 'AWS' });
    assert.equal(ai.status, 'approval_required', 'even at Full autopilot');
    assert.equal((await o.h('cloud.stop_runaway', { accountId: acc, steps: ['ec2:us-east-1/i-0aaa'] }) as any).error.code, 'confirm_needed');
    const odd = ok(await o.h('cloud.stop_runaway', { accountId: acc, steps: ['ec2:us-east-1/i-0bbb'], confirmName: 'AWS' }));
    assert.deepEqual(odd.stopped, [], 'only what the plan offers can be stopped');
    const done = ok(await o.h('cloud.stop_runaway', { accountId: acc, steps: ['ec2:us-east-1/i-0aaa'], confirmName: 'aws' }));
    assert.deepEqual(state.ec2, ['StopInstances i-0aaa']);
    assert.equal(done.stopped.length, 1);
    ok(await o.h('change.undo', { changeId: done.stopped[0].changeId }));
    assert.deepEqual(state.ec2, ['StopInstances i-0aaa', 'StartInstances i-0aaa'], 'Undo starts it again');
  } finally { api.close(); delete process.env.UNIT7_AWS_API; }
});

// --- Google: the billing export, and a budget ------------------------------------------------------------------------
function googleMoneyApi(o: { exportOn: boolean; queries: string[]; budgets: { body: any; quota?: string }[] }) {
  return ({ method, path, body, auth, headers }: { method: string; path: string; body: string; auth: string; headers: Record<string, any> }) => {
    if (auth !== 'Bearer ya29.from-gcloud') return [401, {}];
    const u = new URL(path, 'http://x'), p = u.pathname;
    if (p === '/cloudresourcemanager/v1/projects') return { projects: [{ projectId: 'shop-prod' }] };
    if (p === '/cloudbilling/v1/projects/shop-prod/billingInfo') return { billingAccountName: 'billingAccounts/0A0A0A-1B1B1B-2C2C2C', billingEnabled: true };
    if (p === '/cloudbilling/v1/billingAccounts') return { billingAccounts: [{ name: 'billingAccounts/0A0A0A-1B1B1B-2C2C2C', displayName: 'My billing account', currencyCode: 'EUR' }] };
    if (p === '/billingbudgets/v1/billingAccounts/0A0A0A-1B1B1B-2C2C2C/budgets' && method === 'GET') return {};
    if (p === '/billingbudgets/v1/billingAccounts/0A0A0A-1B1B1B-2C2C2C/budgets' && method === 'POST') { o.budgets.push({ body: JSON.parse(body), quota: headers['x-goog-user-project'] }); return { name: 'billingAccounts/0A0A0A-1B1B1B-2C2C2C/budgets/b1' }; }
    if (p === '/bigquery/bigquery/v2/projects/shop-prod/datasets') return o.exportOn ? { datasets: [{ datasetReference: { datasetId: 'billing', projectId: 'shop-prod' }, location: 'EU' }] } : {};
    if (p === '/bigquery/bigquery/v2/projects/shop-prod/datasets/billing/tables') return { tables: [{ tableReference: { tableId: 'gcp_billing_export_v1_0A0A0A_1B1B1B_2C2C2C' }, timePartitioning: { type: 'DAY' } }] };
    if (p === '/bigquery/bigquery/v2/projects/shop-prod/queries' && method === 'POST') {
      const q = JSON.parse(body); o.queries.push(q.query);
      assert.equal(q.maximumBytesBilled, '5000000000', 'capped: a runaway query can’t cost more than a few cents');
      assert.equal(q.location, 'EU');
      const row = (d: string, svc: string, cost: number) => ({ f: [{ v: d }, { v: 'shop-prod' }, { v: svc }, { v: 'EUR' }, { v: String(cost) }] });
      return { jobComplete: true, totalBytesBilled: '10485760', schema: { fields: ['day', 'project', 'service', 'currency', 'cost'].map((name) => ({ name })) },
        rows: [row(day(0), 'Cloud Run', 2), row(day(-1), 'Cloud Run', 30), row(day(-2), 'Cloud Run', 1), row(day(-3), 'Cloud Run', 1)] };
    }
  };
}

test('Google: spend from the billing export (or the steps to switch it on), counted once in the budget, and a budget alert', async () => {
  const state = { exportOn: false, queries: [] as string[], budgets: [] as { body: any; quota?: string }[] };
  const api = await fakeApi(googleMoneyApi(state) as never);
  process.env.UNIT7_GOOGLE_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    const g = account(app, o.orgId, 'gcp', GCLOUD, 'Google Cloud');
    const off = ok(await o.h('cloud.billing', { accountId: g }));
    assert.equal(off.spend, null, 'no export: never a made-up number');
    assert.equal(off.export.found, false);
    assert.equal(off.export.link, 'https://console.cloud.google.com/billing/export');
    assert.equal(off.export.steps.length, 4);

    state.exportOn = true;
    const g2 = account(app, o.orgId, 'gcp', GCLOUD, 'Google Cloud 2'), fb = account(app, o.orgId, 'firebase', GCLOUD, 'Firebase');
    const bill = ok(await o.h('cloud.billing', { accountId: g2 }));
    const thisMonth = [day(0), day(-1), day(-2), day(-3)].filter((d) => d >= `${day(0).slice(0, 8)}01`).length;
    assert.equal(bill.export.found, true);
    assert.equal(bill.export.table, 'billing.gcp_billing_export_v1_0A0A0A_1B1B1B_2C2C2C');
    assert.equal(bill.spend.currency, 'EUR');
    assert.equal(bill.spend.amount, [2, 30, 1, 1].slice(0, thisMonth).reduce((n, x) => n + x, 0));
    assert.match(state.queries[0]!, /FROM `shop-prod\.billing\.gcp_billing_export_v1_0A0A0A_1B1B1B_2C2C2C`/);
    assert.match(state.queries[0]!, /_PARTITIONTIME >= TIMESTAMP\('\d{4}-\d{2}-\d{2}'\)/, 'only the partitions it needs: a tiny read');
    assert.match(state.queries[0]!, /UNNEST\(credits\)/, 'credits included');
    ok(await o.h('cloud.billing', { accountId: g2 }));
    assert.equal(state.queries.length, 1, 'read at most every 6 hours');

    // the same export seen through the Google Cloud tile and the Firebase tile counts once
    run(app.db, 'UPDATE orgs SET budget_monthly = 500, budget_currency = ? WHERE id = ?', 'EUR', o.orgId);
    const b = ok(await o.h('budget.check'));
    assert.equal(b.costs.filter((c: { provider: string }) => c.provider === 'gcp' || c.provider === 'firebase').length, bill.spend.amount ? 1 : 0);

    const spend = ok(await o.h('cloud.spend', { accountId: g2 }));
    assert.equal(spend.spike.spike, true, 'Cloud Run jumped from 1 to 30 a day');
    assert.equal(spend.culprits[0].name, 'shop-prod · Cloud Run');
    assert.ok(fb);

    const set = ok(await o.h('cloud.budget_set', { accountId: g2, amount: 50 }));
    assert.equal(set.emails, 'the billing account’s admins');
    assert.deepEqual(state.budgets[0], { quota: 'shop-prod', body: { displayName: ALERT_NAME, amount: { specifiedAmount: { currencyCode: 'EUR', units: '50' } },
      thresholdRules: [0.5, 0.9, 1].map((t) => ({ thresholdPercent: t, spendBasis: 'CURRENT_SPEND' })), budgetFilter: { calendarPeriod: 'MONTH' } } }, 'gcloud’s login names a quota project; the account’s own currency');
    assert.match((await o.h('cloud.budget_set', { accountId: g2, amount: 50, currency: 'USD' }) as any).error.message, /in EUR/);
  } finally { api.close(); delete process.env.UNIT7_GOOGLE_API; }
});

test('the export query reads only what it needs', () => {
  const sql = exportSql({ project: 'p', dataset: 'd', table: 't', billingAccount: 'x', partition: 'export_time' }, new Date('2026-10-03T00:00:00Z'));
  assert.match(sql, /usage_start_time >= TIMESTAMP\('2026-09-25'\) AND `export_time` >= TIMESTAMP\('2026-09-25'\)/, 'early in a month it reaches back 8 days');
  assert.match(sql, /LIMIT 3000/);
});

// --- database sizes -------------------------------------------------------------------------------------------------
test('database sizes: RDS (allocated minus CloudWatch’s free space) and Cloud SQL (Monitoring’s bytes used) fill the map’s rings', async () => {
  let cw = 0;
  const api = await fakeApi(({ path, auth }) => {
    const u = new URL(path, 'http://x'), p = u.pathname;
    if (p.startsWith('/sts.amazonaws.com')) return xml('<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/u</Arn><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>');
    if (p.startsWith('/ec2.us-east-1.amazonaws.com') && u.searchParams.get('Action') === 'DescribeRegions') return xml('<DescribeRegionsResponse><regionInfo><item><regionName>us-east-1</regionName></item></regionInfo></DescribeRegionsResponse>');
    if (p.startsWith('/rds.us-east-1.amazonaws.com')) return xml('<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>shop-db</DBInstanceIdentifier><Engine>postgres</Engine><DBInstanceStatus>available</DBInstanceStatus><AllocatedStorage>20</AllocatedStorage></DBInstance></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>');
    if (p.startsWith('/monitoring.us-east-1.amazonaws.com')) { cw++; assert.equal(u.searchParams.get('Dimensions.member.1.Value'), 'shop-db'); return xml(`<GetMetricStatisticsResponse><GetMetricStatisticsResult><Label>FreeStorageSpace</Label><Datapoints><member><Minimum>${20 * 2 ** 30 - 5e9}</Minimum><Unit>Bytes</Unit></member></Datapoints></GetMetricStatisticsResult></GetMetricStatisticsResponse>`); }
    if (auth === 'Bearer ya29.from-gcloud') {
      if (p === '/cloudresourcemanager/v1/projects') return { projects: [{ projectId: 'shop-prod' }] };
      if (p === '/sqladmin/v1/projects/shop-prod/instances') return { items: [{ name: 'shop-sql', databaseVersion: 'POSTGRES_15', state: 'RUNNABLE' }] };
      if (p === '/monitoring/v3/projects/shop-prod/timeSeries') { assert.match(u.searchParams.get('filter')!, /database\/disk\/bytes_used/); return { timeSeries: [{ resource: { labels: { database_id: 'shop-prod:shop-sql' } }, points: [{ value: { int64Value: '123456789' } }] }] }; }
    }
  });
  process.env.UNIT7_AWS_API = api.base; process.env.UNIT7_GOOGLE_API = api.base;
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'aws', AWSKEY, 'AWS');
    account(app, o.orgId, 'gcp', GCLOUD, 'Google Cloud');
    ok(await o.h('sync.run'));
    const m = ok(await o.h('map.get'));
    const size = (name: string) => m.assets.find((a: { name: string }) => a.name === name)?.size;
    assert.equal(size('shop-db'), 5e9);
    assert.equal(size('shop-sql'), 123456789);
    ok(await o.h('sync.run'));
    assert.equal(cw, 1, 'asked at most once an hour per database');
  } finally { api.close(); delete process.env.UNIT7_AWS_API; delete process.env.UNIT7_GOOGLE_API; }
});

test('Azure: a budget on the subscription, a spike traced to one App Service app, stopped (not deleted) and started again', async () => {
  const SUB = '00000000-0000-0000-0000-000000000001';
  const site = `/subscriptions/${SUB}/resourcegroups/web/providers/microsoft.web/sites/shop-api`;
  const seen: { method: string; path: string; body?: any }[] = [];
  const api = await fakeApi(({ method, path, body, auth }) => {
    if (path.startsWith('/login/')) return { access_token: 'eyJ.from-sp', expires_in: 3600 };
    if (auth !== 'Bearer eyJ.from-sp') return [401, {}];
    const p = path.replace(/^\/arm/, '').replace(/\?.*$/, '');
    if (method !== 'GET') seen.push({ method, path: p, body: body ? JSON.parse(body) : undefined });
    if (p === '/subscriptions') return { value: [{ subscriptionId: SUB, displayName: 'Pay-As-You-Go', state: 'Enabled' }] };
    if (p === `/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets`) return { value: [] };
    if (p.startsWith(`/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets/`)) return { name: 'unit7-monthly-alert' };
    if (p === `/subscriptions/${SUB}/providers/Microsoft.CostManagement/query`) {
      const q = JSON.parse(body);
      if (q.timeframe === 'MonthToDate') return { properties: { columns: [{ name: 'Cost' }, { name: 'Currency' }], rows: [[60, 'USD']] } };
      const rows = [];
      for (let k = -8; k <= 0; k++) rows.push([k === -1 ? 50 : 2, Number(day(k).replace(/-/g, '')), site, 'USD']);
      return { properties: { columns: [{ name: 'Cost' }, { name: 'UsageDate' }, { name: 'ResourceId' }, { name: 'Currency' }], rows } };
    }
    if (p === `${site}/stop` || p === `${site}/start`) return {};
  });
  process.env.UNIT7_AZURE_API = `${api.base}/arm`; process.env.UNIT7_AZURE_LOGIN = `${api.base}/login`;
  try {
    const app = testApp(), o = await testOrg(app);
    const acc = account(app, o.orgId, 'azure', `tenant-1:${SUB}:good-secret`, 'Azure');
    ok(await o.h('cloud.budget_set', { accountId: acc, amount: 100, thresholds: [100, 50], email: 'sam@example.com' }));
    const put = seen.find((x) => x.method === 'PUT')!;
    assert.equal(put.path, `/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets/unit7-monthly-alert`);
    assert.equal(put.body.properties.timeGrain, 'Monthly');
    assert.match(put.body.properties.timePeriod.startDate, /^\d{4}-\d{2}-01T00:00:00Z$/, 'starts on the first of the month');
    assert.deepEqual(Object.keys(put.body.properties.notifications), ['Actual_GreaterThan_50_Percent', 'Actual_GreaterThan_100_Percent']);
    assert.deepEqual(put.body.properties.notifications.Actual_GreaterThan_50_Percent.contactEmails, ['sam@example.com']);

    const s = ok(await o.h('cloud.spend', { accountId: acc }));
    assert.equal(s.spike.spike, true);
    assert.deepEqual(s.steps.map((x: any) => [x.kind, x.name]), [['appservice', 'shop-api']]);
    assert.match(s.steps[0].note, /plan keeps billing/, 'honest about what a stop saves');
    const done = ok(await o.h('cloud.stop_runaway', { accountId: acc, steps: [s.steps[0].id], confirmName: 'Azure' }));
    assert.ok(seen.some((x) => x.method === 'POST' && x.path === `${site}/stop`));
    ok(await o.h('change.undo', { changeId: done.stopped[0].changeId }));
    assert.ok(seen.some((x) => x.method === 'POST' && x.path === `${site}/start`), 'Undo starts it again');
    assert.ok(!seen.some((x) => x.method === 'DELETE'), 'nothing is ever deleted');
  } finally { api.close(); delete process.env.UNIT7_AZURE_API; delete process.env.UNIT7_AZURE_LOGIN; }
});

test('database sizes: Supabase’s disk use fills the ring; a refusal just leaves it unknown', async (t) => {
  const { lookup } = await import('node:dns/promises');
  if (!(await lookup('api.supabase.com').then(() => true, () => false))) return t.skip('offline');
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const p = new URL(url).pathname;
    asked.push(p);
    if (p === '/v1/projects') return new Response(JSON.stringify([{ ref: 'abcdefghijklmnopqrst', name: 'shop', status: 'ACTIVE_HEALTHY' }, { ref: 'tsrqponmlkjihgfedcba', name: 'old', status: 'ACTIVE_HEALTHY' }]), { status: 200 });
    if (p === '/v1/projects/abcdefghijklmnopqrst/config/disk/util') return new Response(JSON.stringify({ metrics: { fs_used_bytes: 734003200, fs_size_bytes: 8e9 } }), { status: 200 });
    return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 });
  }) as typeof fetch;
  try {
    const app = testApp(), o = await testOrg(app);
    account(app, o.orgId, 'supabase', 'sbp_0123456789abcdef0123456789abcdef01234567', 'Supabase');
    ok(await o.h('sync.run'));
    const m = ok(await o.h('map.get'));
    assert.equal(m.assets.find((a: { name: string }) => a.name === 'shop')?.size, 734003200);
    assert.equal(m.assets.find((a: { name: string }) => a.name === 'old')?.size, undefined, 'not allowed to read it: unknown, and the scan still counts');
    assert.ok(m.accounts.find((a: { provider: string }) => a.provider === 'supabase')?.ok);
  } finally { globalThis.fetch = real; }
});
