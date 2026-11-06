// Money on the big clouds (Phases 2–4). Google's spend through the person's billing export to BigQuery; a spending
// alert in one click (Google Budgets, AWS Budgets, Azure Consumption budgets); the last days' spend and a spike check
// (today's run-rate or yesterday well above the week before, or a budget past 100%); and "stop the runaway thing": a
// plan with the likely culprits and the safest stop for each, which always waits for a person and never deletes
// anything. Each stop keeps an undo (start it again) in changes, so Activity's Undo works.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid } from './helpers.ts';
import { pool } from '../discovery/scanners.ts';
import { cached, dropCached } from '../connectors/cloudcli.ts';
import { google, googleBilling, googleCred, viaFirebaseCli, cloudRun } from '../connectors/google.ts';
import { aws, awsMoney, awsOps } from '../connectors/aws.ts';
import { azure, azureMoney, webAppPower } from '../connectors/azure.ts';
import { SPEND } from './budget.ts';
import { BILLS, type Bill } from './bigclouds.ts';
import { CHANGE_UNDO } from './manage.ts';

const r2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (at: Date, d = 0) => new Date(at.getTime() + d * 86400_000).toISOString().slice(0, 10);
const BIG = ['gcp', 'firebase', 'aws', 'azure'];

// --- Google: the billing export in BigQuery ------------------------------------------------------------------------
// The person switches the export on in Google's console (there's no API for the standard export); Unit7 finds its
// table (gcp_billing_export_v1_…, or the detailed _resource_v1_ one) in any project the sign-in sees, and reads it with
// one small query at most every 6 hours. BigQuery bills a query by the data it reads (at least 10 MB; the first TiB a
// month is free), so each read costs a fraction of a cent, capped at 5 GB.
// https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup · https://cloud.google.com/bigquery/pricing
export const moneyTiming = { exportMs: 6 * 3600_000, maxBytes: 5e9 };
export const EXPORT_LINK = 'https://console.cloud.google.com/billing/export';
export const EXPORT_STEPS = [
  'Open Billing export in Google Cloud’s console and pick your billing account.',
  'On the BigQuery export tab, press Edit settings under Standard usage cost.',
  'Pick a project, create a dataset (for example billing_export, in the US or EU multi-region), and save.',
  'Google starts filling it within a day, back to the start of last month. Unit7 finds it by itself.',
];
export interface ExportAt { project: string; dataset: string; table: string; location?: string; partition?: string; billingAccount: string }
export interface ExportRow { day: string; project: string; service: string; currency: string; cost: number }

// The export Unit7 reads is pinned to the account the first time it's found (and the billing card says which): another
// table is never switched to silently, since a project someone shared could hold a planted one. A person confirms a
// different one (cloud.billing_export_use).
export type Pin = Pick<ExportAt, 'project' | 'dataset' | 'table'>;
export const pinOf = (ctx: Pick<Ctx, 'db' | 'orgId'>, acc: string) =>
  json<{ billingExport?: Pin }>(get<{ meta: string }>(ctx.db, 'SELECT meta FROM accounts WHERE id = ? AND org_id = ?', acc, ctx.orgId)?.meta, {}).billingExport;
const pinIt = (ctx: Pick<Ctx, 'db' | 'orgId'>, acc: string, at: Pin) => run(ctx.db, `UPDATE accounts SET meta = json_set(meta, '$.billingExport', json(?)) WHERE id = ? AND org_id = ?`,
  JSON.stringify({ project: at.project, dataset: at.dataset, table: at.table }), acc, ctx.orgId);
const where = (at: Pin) => `${at.project}.${at.dataset}`;

// the pinned export (or, with none pinned yet, the first one found, which is then pinned); `any` looks everywhere
export async function findExport(ctx: Ctx, acc: string, fresh = false, any = false): Promise<ExportAt | null> {
  const pin = any ? undefined : pinOf(ctx, acc);
  if (fresh || any) dropCached(`gexport:${acc}`);
  const v = await cached(`gexport:${acc}`, async () => {
    // ponytail: the first 30 projects; billing exports usually sit in one admin project
    const projects = pin ? [{ projectId: pin.project }] : (await google.projects(ctx, acc)).slice(0, 30);
    const found = (await pool(projects, 4, async ({ projectId: p }) => {
      for (const d of (await googleBilling.datasets(ctx, acc, p).catch(() => [])).filter((x) => !pin || x.datasetReference.datasetId === pin.dataset)) {
        const tables = await googleBilling.tables(ctx, acc, p, d.datasetReference.datasetId).catch(() => []);
        const t = pin ? tables.find((x) => x.tableReference.tableId === pin.table)
          : tables.find((x) => x.tableReference.tableId.startsWith('gcp_billing_export_v1_')) ?? tables.find((x) => x.tableReference.tableId.startsWith('gcp_billing_export_resource_v1_'));
        if (t) {
          const tid = t.tableReference.tableId;
          return { project: p, dataset: d.datasetReference.datasetId, table: tid, location: d.location, billingAccount: tid.replace(/^gcp_billing_export_(resource_)?v1_/, '').replace(/_/g, '-'),
            ...(t.timePartitioning && { partition: t.timePartitioning.field ?? '_PARTITIONTIME' }) } satisfies ExportAt;
        }
      }
      return undefined;
    })).find(Boolean);
    return { value: JSON.stringify(found ?? null), until: Date.now() + moneyTiming.exportMs };
  }, moneyTiming.exportMs);
  if (any) dropCached(`gexport:${acc}`); // a look elsewhere never stands in for the pinned one
  const at = JSON.parse(v) as ExportAt | null;
  if (at && !pin && !any) pinIt(ctx, acc, at);
  return at;
}

// this month and the last 8 days, by day, project and service, credits included (Google's own cost query, grouped)
// https://docs.cloud.google.com/billing/docs/how-to/bq-examples
export function exportSql(at: ExportAt, now = new Date()) {
  const first = `${now.toISOString().slice(0, 8)}01`, since = [first, dayOf(now, -8)].sort()[0]!;
  const part = at.partition ? ` AND ${at.partition === '_PARTITIONTIME' ? '_PARTITIONTIME' : `\`${at.partition}\``} >= TIMESTAMP('${since}')` : '';
  return `SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS day, project.id AS project, service.description AS service, currency,
  SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS cost
FROM \`${at.project}.${at.dataset}.${at.table}\`
WHERE usage_start_time >= TIMESTAMP('${since}')${part}
GROUP BY day, project, service, currency
ORDER BY day DESC
LIMIT 3000`;
}
export async function exportRows(ctx: Ctx, acc: string, at: ExportAt): Promise<{ rows: ExportRow[]; bytes: number; at: string }> {
  const v = await cached(`gexport-rows:${acc}`, async () => {
    const r = await googleBilling.query(ctx, acc, at.project, exportSql(at), { location: at.location, maxBytes: moneyTiming.maxBytes });
    if (r.jobComplete === false) throw new Unit7Error('slow', 'BigQuery didn’t finish reading the billing export in 30 seconds. Unit7 tries again later.', 504);
    const names = (r.schema?.fields ?? []).map((f) => f.name);
    const col = (row: { f: { v: string | null }[] }, n: string) => row.f[names.indexOf(n)]?.v ?? '';
    const rows = (r.rows ?? []).map((row): ExportRow => ({ day: col(row, 'day'), project: col(row, 'project') || 'no project', service: col(row, 'service'), currency: col(row, 'currency') || 'USD', cost: Number(col(row, 'cost')) || 0 }));
    return { value: JSON.stringify({ rows, bytes: Number(r.totalBytesBilled ?? r.totalBytesProcessed ?? 0), at: new Date().toISOString() }), until: Date.now() + moneyTiming.exportMs };
  }, moneyTiming.exportMs);
  return JSON.parse(v);
}
const monthOf = (rows: ExportRow[], now = new Date()) => {
  const first = `${now.toISOString().slice(0, 8)}01`, mine = rows.filter((r) => r.day >= first);
  return { amount: r2(mine.reduce((n, r) => n + r.cost, 0)), currency: mine[0]?.currency ?? rows[0]?.currency ?? 'USD' };
};
const bytesWords = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(10, Math.round(b / 1e6))} MB`);

// cloud.billing for Google: spend from the export when it's there, else the steps to switch it on
const plainGoogle = BILLS.gcp!;
BILLS.gcp = BILLS.firebase = async (ctx, acc): Promise<Bill> => {
  const b = await plainGoogle(ctx, acc);
  if (viaFirebaseCli(ctx, acc)) return b;
  const at = await findExport(ctx, acc).catch(() => null);
  const pin = pinOf(ctx, acc);
  if (!at) return { ...b, note: pin ? `Unit7 reads costs only from ${where(pin)} (${pin.table}), and it isn’t there now. A person confirms a different table.` : undefined,
    export: { found: false, steps: EXPORT_STEPS, link: EXPORT_LINK, ...(pin && { pinned: `${where(pin)}.${pin.table}` }) } }; // the steps say it
  try {
    const r = await exportRows(ctx, acc, at);
    return { ...b, spend: monthOf(r.rows), note: `Reading costs from ${where(at)}. Read at most every 6 hours; each read costs a fraction of a cent (about ${bytesWords(r.bytes)} of BigQuery).`,
      export: { found: true, table: `${at.dataset}.${at.table}`, project: at.project, from: where(at), readAt: r.at } };
  } catch (e) {
    return { ...b, export: { found: true, table: `${at.dataset}.${at.table}`, project: at.project, from: where(at), problem: (e as Error).message.slice(0, 200) } };
  }
};

// the monthly budget (budget.check, then the cost radar) counts Google's spend from the export; the same export seen
// through both Google tiles is counted once
const claimed = new Map<string, { acc: string; at: number }>();
for (const p of ['gcp', 'firebase']) SPEND[p] = async (ctx, acc) => {
  if (viaFirebaseCli(ctx, acc)) return [];
  const at = await findExport(ctx, acc);
  if (!at) return [];
  const key = `${ctx.orgId}:${at.project}.${at.dataset}.${at.table}`, c = claimed.get(key);
  if (c && c.acc !== acc && Date.now() - c.at < 10 * 60_000) return [];
  claimed.set(key, { acc, at: Date.now() });
  const m = monthOf((await exportRows(ctx, acc, at)).rows);
  return m.amount ? [{ label: 'usage this month (billing export)', ...m }] : [];
};

// --- a spending alert in one click --------------------------------------------------------------------------------
export const ALERT_NAME = 'Unit7 monthly alert';
const accountOf = (ctx: Ctx, accountId: string) => {
  const a = get<{ id: string; provider: string; name: string; status: string }>(ctx.db, 'SELECT id, provider, name, status FROM accounts WHERE id = ? AND org_id = ?', accountId, ctx.orgId);
  if (!a || !BIG.includes(a.provider)) throw new Unit7Error('unsupported', 'That isn’t a Google Cloud, Firebase, AWS or Azure account.', 400);
  return a;
};
const myEmail = (ctx: Ctx) => (ctx.actor.userId ? get<{ email: string }>(ctx.db, 'SELECT email FROM users WHERE id = ?', ctx.actor.userId)?.email : undefined);

defineTool({
  name: 'cloud.budget_set', title: 'Set a spending alert', risk: 'write', action: 'budget_alert', timeoutMs: 60_000,
  description: 'Add a monthly budget with email alerts to a Google Cloud / Firebase billing account (Google emails the billing account’s admins), an AWS account or an Azure subscription (they email the address given, by default yours). Default alerts at 50%, 90% and 100% of the amount. It only warns; it never stops anything. A person, or an AI with a person’s yes.',
  input: z.object({
    accountId: fid('acc'), amount: z.number().positive().max(1_000_000), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    thresholds: z.array(z.number().int().min(1).max(1000)).min(1).max(5).default([50, 90, 100]),
    email: z.string().email().max(200).optional().describe('AWS and Azure: who gets the alert emails (default: you)'),
    scope: z.string().max(200).optional().describe('Google: the billing account (billingAccounts/…); Azure: the subscription id. Default: the first one'),
  }),
  assess: (c, i) => ({ tier: 2, ask: 'A spending alert is added only with a person’s yes.', impact: `Adds a monthly budget of ${i.amount}${i.currency ? ` ${i.currency}` : ''} that emails at ${i.thresholds.join(', ')}%. It only warns; nothing is stopped.` }),
  async run(ctx, i) {
    const a = accountOf(ctx, i.accountId);
    const bill = await BILLS[a.provider]!(ctx, a.id).catch(() => undefined);
    if (bill?.budgets?.some((b) => b.name === ALERT_NAME)) throw new Unit7Error('exists', `${a.name} already has Unit7’s spending alert. Change it in the provider’s billing page.`, 409);
    const thresholds = [...new Set(i.thresholds)].sort((x, y) => x - y);
    ctx.progress(`Adding a spending alert to ${a.name}…`);
    if (a.provider === 'gcp' || a.provider === 'firebase') {
      if (viaFirebaseCli(ctx, a.id)) throw new Unit7Error('unsupported', 'The Firebase CLI can’t set budgets. Connect Google Cloud with gcloud (or a key) first.', 400);
      const projects = await google.projects(ctx, a.id);
      const info = await pool(projects.slice(0, 20), 4, async (p) => ({ p: p.projectId, ...(await google.billingInfo(ctx, a.id, p.projectId).catch(() => ({ billingAccountName: undefined, billingEnabled: false }))) }));
      const ba = i.scope ?? info.find((x) => x.billingEnabled && x.billingAccountName)?.billingAccountName;
      if (!ba || !/^billingAccounts\/[A-Z0-9-]+$/.test(ba)) throw new Unit7Error('no_billing', 'None of these projects has billing switched on, so there’s nothing to alert on yet (free tier only).', 409);
      const currency = (await google.billingAccounts(ctx, a.id).catch(() => [])).find((x) => x.name === ba)?.currencyCode;
      if (i.currency && currency && i.currency !== currency) throw new Unit7Error('currency', `That billing account is in ${currency}; Google needs the budget in the same currency.`, 400);
      // a person's own Google login (gcloud) is billed for API calls through a project: one this account pays for
      const cred = googleCred(ctx, a.id), quota = 'cli' in cred ? info.find((x) => x.billingAccountName === ba)?.p : undefined;
      const r = await googleBilling.createBudget(ctx, a.id, ba, { displayName: ALERT_NAME, amount: { specifiedAmount: { ...((i.currency ?? currency) && { currencyCode: i.currency ?? currency }), units: String(Math.round(i.amount)) } },
        thresholdRules: thresholds.map((t) => ({ thresholdPercent: t / 100, spendBasis: 'CURRENT_SPEND' })), budgetFilter: { calendarPeriod: 'MONTH' } }, quota);
      ctx.emit('cloud.budget_set', `Spending alert added to ${a.name}: ${Math.round(i.amount)} ${i.currency ?? currency ?? ''} a month, emails at ${thresholds.join(', ')}%`, { severity: 'success', resource: a.id });
      return { account: a.name, budget: { name: ALERT_NAME, amount: Math.round(i.amount), currency: i.currency ?? currency ?? 'USD', alertsAt: thresholds }, emails: 'the billing account’s admins', id: r.name, manageUrl: `https://console.cloud.google.com/billing/${ba.split('/')[1]}/budgets` };
    }
    const email = i.email ?? myEmail(ctx);
    if (!email) throw new Unit7Error('invalid_input', 'Give the email address the alerts go to.', 400);
    const currency = i.currency ?? bill?.spend?.currency ?? 'USD';
    if (a.provider === 'aws') {
      const { account } = await aws.whoami(ctx, a.id);
      await awsMoney.createBudget(ctx, a.id, { accountId: account, name: ALERT_NAME, amount: i.amount, currency, thresholds, email });
    } else {
      const s = i.scope ?? (await azure.subscriptions(ctx, a.id)).find((x) => x.state !== 'Disabled')?.subscriptionId;
      if (!s) throw new Unit7Error('no_subscription', 'This Azure sign-in sees no active subscription.', 409);
      await azureMoney.createBudget(ctx, a.id, s, { name: 'unit7-monthly-alert', amount: i.amount, thresholds, email });
    }
    ctx.emit('cloud.budget_set', `Spending alert added to ${a.name}: ${i.amount} ${currency} a month, emails at ${thresholds.join(', ')}%`, { severity: 'success', resource: a.id });
    return { account: a.name, budget: { name: ALERT_NAME, amount: i.amount, currency, alertsAt: thresholds }, emails: email, manageUrl: bill?.manageUrl };
  },
});

// --- the last days' spend, and a spike ------------------------------------------------------------------------------
export interface DaySpend { day: string; key: string; amount: number; currency: string }
// how far above normal counts as a spike: 3× the week before and at least $5 a day more
export const SPIKE = { ratio: 3, floor: 5 };
export interface Spike { normal: number; latest: number; runRate: number; worst: number; excess: number; spike: boolean }
// pure: the day before today against the 7 days before it, and today so far as a run-rate (after its first 3 hours;
// providers report today late, so a run-rate only ever runs low)
export function spikeOf(rows: { day: string; amount: number }[], now = new Date()): Spike {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.day, (by.get(r.day) ?? 0) + r.amount);
  const normal = r2([...Array(7)].reduce((n, _x, k) => n + (by.get(dayOf(now, -2 - k)) ?? 0), 0) / 7);
  const latest = r2(by.get(dayOf(now, -1)) ?? 0);
  const hours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const runRate = hours >= 3 ? r2(((by.get(dayOf(now)) ?? 0) / hours) * 24) : 0;
  const worst = Math.max(latest, runRate), excess = r2(worst - normal);
  return { normal, latest, runRate, worst, excess, spike: excess >= SPIKE.floor && worst >= SPIKE.ratio * Math.max(normal, 0.01) };
}
// what rose the most: each service / resource on its own, biggest rise first
export function culpritsOf(rows: DaySpend[], now = new Date()) {
  const keys = [...new Set(rows.map((r) => r.key))];
  return keys.map((key) => ({ key, ...spikeOf(rows.filter((r) => r.key === key), now) })).filter((c) => c.excess > 0.5).sort((a, b) => b.excess - a.excess).slice(0, 3);
}

async function dailyOf(ctx: Ctx, a: { id: string; provider: string }): Promise<DaySpend[] | null> {
  if (a.provider === 'aws') return awsMoney.daily(ctx, a.id);
  if (a.provider === 'azure') return (await pool((await azure.subscriptions(ctx, a.id)).filter((s) => s.state !== 'Disabled'), 2, (s) => azureMoney.daily(ctx, a.id, s.subscriptionId))).flat();
  if (viaFirebaseCli(ctx, a.id)) return null;
  const at = await findExport(ctx, a.id);
  return at ? (await exportRows(ctx, a.id, at)).rows.map((r) => ({ day: r.day, key: `${r.project} · ${r.service}`, amount: r.cost, currency: r.currency })) : null;
}

// --- the safest stop for each culprit (never a delete) ----------------------------------------------------------------
export type StopKind = 'cloudrun' | 'ec2' | 'lightsail' | 'appservice';
export interface StopStep { id: string; kind: StopKind; ref: string; name: string; what: string; note: string; perDay?: number }
const STOP: Record<StopKind, { what: string; note: string }> = {
  cloudrun: { what: 'Cap it at one copy (at most 1 instance, none kept warm)', note: 'It keeps answering, slower when busy. Undo puts its old limits back.' },
  ec2: { what: 'Stop the machine (not terminate)', note: 'Its disk stays (and is still billed). Its public address changes unless it has an Elastic IP; anything in instance storage is lost. Undo starts it again.' },
  lightsail: { what: 'Stop the machine', note: 'Lightsail still bills a stopped machine: this ends runaway traffic and work, not the plan’s price. Its address changes unless it has a static IP. Undo starts it again.' },
  appservice: { what: 'Stop the app', note: 'Its App Service plan keeps billing while the app is stopped; this stops the app answering and working. Undo starts it again.' },
};
const step = (kind: StopKind, ref: string, name: string, perDay?: number): StopStep => ({ id: `${kind}:${ref}`, kind, ref, name, ...STOP[kind], ...(perDay !== undefined && { perDay: r2(perDay) }) });
const assetsOf = (ctx: Ctx, acc: string, provider: string) => all<{ ext_id: string; name: string; meta: string }>(ctx.db, 'SELECT ext_id, name, meta FROM assets WHERE org_id = ? AND account_id = ? AND provider = ?', ctx.orgId, acc, provider)
  .filter((x) => !/stopped|terminated/i.test(json<{ status?: string }>(x.meta, {}).status ?? ''));
function stopsFor(ctx: Ctx, a: { id: string; provider: string }, c: { key: string; worst: number }): { steps: StopStep[]; why?: string } {
  if (a.provider === 'aws') {
    if (/Elastic Compute Cloud|EC2/i.test(c.key) && !/Other/i.test(c.key)) return { steps: assetsOf(ctx, a.id, 'ec2').map((x) => step('ec2', x.ext_id, x.name)) };
    if (/Lightsail/i.test(c.key)) return { steps: assetsOf(ctx, a.id, 'lightsail').map((x) => step('lightsail', x.ext_id, x.name)) };
    if (/Amplify/i.test(c.key)) return { steps: [], why: 'Amplify has no off switch: it bills builds, hosting traffic and requests. Turn off auto-build or limit who can reach the app in the Amplify console. Unit7 never deletes the app.' };
    return { steps: [], why: `Unit7 has no safe stop for ${c.key}. Look at it in AWS Cost Explorer.` };
  }
  if (a.provider === 'azure') {
    const site = /\/providers\/microsoft\.web\/sites\/([^/]+)$/i.exec(c.key);
    if (site) return { steps: [step('appservice', c.key, site[1]!, c.worst)] };
    return { steps: [], why: `Unit7 has no safe stop for ${c.key.split('/').slice(-2).join(' ')}. Look at it in Azure’s Cost analysis.` };
  }
  const [project = '', service = ''] = c.key.split(' · ');
  if (/^Cloud Run$/i.test(service)) return { steps: assetsOf(ctx, a.id, 'cloudrun').filter((x) => x.ext_id.startsWith(`${project}/`)).map((x) => step('cloudrun', x.ext_id, x.name)) };
  return { steps: [], why: `Unit7 has no safe stop for ${service || c.key} in ${project}. Look at it in Google Cloud’s billing reports.` };
}

export async function spendOf(ctx: Ctx, accountId: string, now = new Date()) {
  const a = accountOf(ctx, accountId);
  const rows = await dailyOf(ctx, a);
  const bill = await BILLS[a.provider]!(ctx, a.id).catch(() => undefined);
  const over = (bill?.budgets ?? []).filter((b) => b.spent !== undefined && b.amount > 0 && b.spent >= b.amount).map((b) => ({ name: b.name, amount: b.amount, spent: b.spent!, currency: b.currency }));
  if (!rows) return { account: a.name, provider: a.provider, currency: bill?.spend?.currency ?? 'USD', days: [], spike: null, culprits: [], steps: [], explain: [], over,
    note: a.provider === 'aws' || a.provider === 'azure' ? undefined : 'Google’s daily spend needs the billing export switched on.' };
  const currency = rows[0]?.currency ?? bill?.spend?.currency ?? 'USD';
  const days = [...Array(9)].map((_x, k) => dayOf(now, k - 8)).map((day) => ({ day, amount: r2(rows.filter((r) => r.day === day).reduce((n, r) => n + r.amount, 0)) }));
  const spike = spikeOf(rows, now);
  const culprits = spike.spike || over.length ? culpritsOf(rows, now) : [];
  const steps: StopStep[] = [], explain: { name: string; why: string }[] = [];
  for (const c of culprits) {
    const s = stopsFor(ctx, a, c);
    for (const x of s.steps) if (!steps.some((y) => y.id === x.id)) steps.push(x);
    if (s.why) explain.push({ name: c.key.includes('/providers/') ? c.key.split('/').pop()! : c.key, why: s.why });
  }
  return { account: a.name, provider: a.provider, currency, days, spike, over, culprits: culprits.map((c) => ({ name: c.key.includes('/providers/') ? c.key.split('/').pop()! : c.key, normal: c.normal, latest: c.worst, rise: c.excess })),
    steps, explain, doNothing24h: r2(spike.worst), extra24h: r2(Math.max(0, spike.excess)) };
}

defineTool({
  name: 'cloud.spend', title: 'Spending by day on a cloud account', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'For a Google Cloud / Firebase (needs the billing export), AWS or Azure account: the last 9 days’ spend, whether it spiked (the day before or today’s run-rate at 3× the week before and $5 a day more), budgets past 100%, the likely culprits (what rose most) and the safest stop for each, and what doing nothing costs over 24 hours. cloud.stop_runaway carries out a stop; it always waits for a person. AWS charges a cent per cost read, so it’s read at most twice a day.',
  input: z.object({ accountId: fid('acc') }),
  run: (ctx, i) => spendOf(ctx, i.accountId),
});

// Warden, twice a day: each big-cloud account's spend; a spike (or a budget past 100%) alerts once a day with the plan
defineTool({
  name: 'cloud.spend_watch', title: 'Watch cloud spending', risk: 'read', action: 'read', timeoutMs: 5 * 60_000,
  description: 'Check every Google Cloud, Firebase, AWS and Azure account for a spending spike or a budget past 100%, and alert once a day per account with a plan to stop the runaway thing (which waits for a person). Warden runs it twice a day.',
  input: z.object({}),
  async run(ctx) {
    const accounts = all<{ id: string; name: string; provider: string }>(ctx.db, `SELECT id, name, provider FROM accounts WHERE org_id = ? AND provider IN ('gcp', 'firebase', 'aws', 'azure') AND status != 'failing'`, ctx.orgId);
    const out: { account: string; spike: boolean; over: number }[] = [];
    for (const a of accounts) {
      const s = await spendOf(ctx, a.id).catch(() => undefined);
      if (!s) continue;
      const hot = !!s.spike?.spike || s.over.length > 0;
      out.push({ account: a.name, spike: !!s.spike?.spike, over: s.over.length });
      if (!hot || get(ctx.db, `SELECT 1 FROM events WHERE org_id = ? AND type = 'cost.spike' AND resource = ? AND created_at > ?`, ctx.orgId, a.id, `${dayOf(new Date())}T00:00:00`)) continue;
      const money = (n: number) => `${n.toFixed(2)} ${s.currency}`;
      const why = s.spike?.spike ? `about ${money(s.spike.worst)} a day against ${money(s.spike.normal)} usually` : `${s.over[0]!.name} is past 100% (${money(s.over[0]!.spent)} of ${money(s.over[0]!.amount)})`;
      ctx.emit('cost.spike', `Spending on ${a.name} jumped: ${why}.${s.steps.length ? ' Unit7 has a plan to stop the runaway thing; it waits for you.' : ''}`, { severity: 'critical', resource: a.id, data: { accountId: a.id, provider: a.provider, steps: s.steps.length } });
    }
    return out;
  },
});

// --- stop the runaway thing: always a person's yes, never a delete, each with an undo ---------------------------------
defineTool({
  name: 'cloud.stop_runaway', title: 'Stop the runaway thing', risk: 'destructive', action: 'stop_runaway', timeoutMs: 5 * 60_000,
  description: 'Carry out stops from cloud.spend’s plan (steps: their ids): cap a Cloud Run service at one instance, stop an EC2 or Lightsail machine (never terminate), stop an Azure App Service app. Nothing is deleted. Always waits for a person, even at Full autopilot; confirmName is the account’s name (the person approving types it again). Each stop has an undo (start it again) in Activity.',
  input: z.object({ accountId: fid('acc'), steps: z.array(z.string().max(600)).min(1).max(20), confirmName: z.string().max(200).optional() }),
  assess: (c, i) => {
    if ((c.actor.kind === 'agent' || c.actor.role === 'agent') && !c.dryRun && !i.confirmName) throw new Unit7Error('invalid_input', 'Give confirmName: the account’s name. The person approving types it again.', 400);
    return { tier: 3, ask: 'Stopping things to save money always waits for a person, even at Full autopilot.', impact: `Stops ${i.steps.length} thing${i.steps.length === 1 ? '' : 's'} on this account (${i.steps.map((s) => s.split(':')[0]).join(', ')}). Nothing is deleted; each can be started again from Activity.` };
  },
  async run(ctx, i) {
    const a = accountOf(ctx, i.accountId);
    if ((i.confirmName ?? '').trim().toLowerCase() !== a.name.toLowerCase()) throw new Unit7Error('confirm_needed', `Type the account’s name (${a.name}) to stop these.`, 400, { confirm: a.name });
    const plan = await spendOf(ctx, a.id);
    const stopped: { name: string; what: string; changeId: string }[] = [], failed: { name: string; why: string }[] = [];
    for (const sid of i.steps) {
      const s = plan.steps.find((x) => x.id === sid);
      if (!s) { failed.push({ name: sid.split(':').slice(1).join(':'), why: 'It isn’t in the current plan anymore.' }); continue; }
      ctx.progress(`${s.what}: ${s.name}…`);
      try {
        const prev = await stopOne(ctx, a.id, s);
        const changeId = id('chg'), summary = `${s.kind === 'cloudrun' ? `Capped ${s.name} at one instance` : `Stopped ${s.name}`} (${a.name})`;
        run(ctx.db, 'INSERT INTO changes (id, org_id, server_id, part, verb, summary, undo, status, actor) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
          changeId, ctx.orgId, s.id, 'cloud.stop', summary, JSON.stringify({ steps: [], accountId: a.id, kind: s.kind, ref: s.ref, prev }), 'done', ctx.actor.name);
        ctx.emit('change.made', `${summary} to stop a cost spike. It can be undone.`, { severity: 'warning', resource: a.id, data: { changeId, part: s.id, undo: 'change.undo' } });
        stopped.push({ name: s.name, what: s.what, changeId });
      } catch (e) { failed.push({ name: s.name, why: (e as Error).message.slice(0, 200) }); }
    }
    return { account: a.name, stopped, failed, undo: stopped.length ? 'Each one starts again with Undo in Activity (change.undo with its changeId).' : undefined };
  },
});

async function stopOne(ctx: Ctx, acc: string, s: StopStep): Promise<unknown> {
  if (s.kind === 'ec2') { const [region, iid] = s.ref.split('/') as [string, string]; await awsOps.ec2(ctx, acc, region, iid, 'stop'); return null; }
  if (s.kind === 'lightsail') { const [region, name] = s.ref.split('/') as [string, string]; await awsOps.lightsail(ctx, acc, region, name, 'stop'); return null; }
  if (s.kind === 'appservice') { await webAppPower(ctx, acc, s.ref, 'stop'); return null; }
  // Cloud Run: at most one instance (max instances can't go below 1), none kept warm; the old limits are kept for the undo
  const [p, region, name] = s.ref.split('/') as [string, string, string];
  const svc = await cloudRun.get(ctx, acc, p, region, name);
  const prev = svc.template?.scaling ?? {};
  await cloudRun.patch(ctx, acc, { ...svc, template: { ...svc.template, scaling: { ...prev, minInstanceCount: 0, maxInstanceCount: 1 } } });
  return prev;
}

// the undo: start it again (or give a Cloud Run service its old limits back)
CHANGE_UNDO['cloud.stop'] = async (ctx, ch) => {
  const u = json<{ accountId: string; kind: StopKind; ref: string; prev?: { minInstanceCount?: number; maxInstanceCount?: number } | null }>(ch.undo, { accountId: '', kind: 'ec2', ref: '' });
  if (u.kind === 'ec2') { const [region, iid] = u.ref.split('/') as [string, string]; await awsOps.ec2(ctx, u.accountId, region, iid, 'start'); }
  else if (u.kind === 'lightsail') { const [region, name] = u.ref.split('/') as [string, string]; await awsOps.lightsail(ctx, u.accountId, region, name, 'start'); }
  else if (u.kind === 'appservice') await webAppPower(ctx, u.accountId, u.ref, 'start');
  else {
    const [p, region, name] = u.ref.split('/') as [string, string, string];
    const svc = await cloudRun.get(ctx, u.accountId, p, region, name);
    await cloudRun.patch(ctx, u.accountId, { ...svc, template: { ...svc.template, scaling: { ...(u.prev ?? {}) } } });
  }
  return { started: u.ref.split('/').pop() };
};

// "Check again" after switching the export on: looks for it now instead of waiting for the 6-hour look
defineTool({
  name: 'cloud.billing_export', title: 'Look for Google’s billing export', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'For a Google Cloud or Firebase account: look now for the billing export to BigQuery (gcp_billing_export_v1_… in any project the sign-in sees). Found: where it is. Not found: the steps to switch it on in Google’s console, with the link.',
  input: z.object({ accountId: fid('acc') }),
  async run(ctx, i) {
    const a = accountOf(ctx, i.accountId);
    if (a.provider !== 'gcp' && a.provider !== 'firebase') throw new Unit7Error('unsupported', 'Only Google accounts have a billing export.', 400);
    if (viaFirebaseCli(ctx, a.id)) throw new Unit7Error('unsupported', 'The Firebase CLI can’t read billing. Connect Google Cloud with gcloud (or a key).', 400);
    dropCached(`gexport-rows:${a.id}`);
    const at = await findExport(ctx, a.id, true);
    if (at) return { found: true, table: `${at.dataset}.${at.table}`, project: at.project, from: where(at) };
    // the pinned one is gone: say where another is, and let a person confirm it (never switched by itself)
    const pin = pinOf(ctx, a.id), other = pin ? await findExport(ctx, a.id, true, true) : null;
    return { found: false, steps: EXPORT_STEPS, link: EXPORT_LINK, ...(pin && { pinned: `${where(pin)}.${pin.table}` }),
      ...(other && { other: `${where(other)}.${other.table}`, confirm: { tool: 'cloud.billing_export_use', input: { accountId: a.id, table: `${where(other)}.${other.table}` }, label: `Read costs from ${where(other)}` } }) };
  },
});

defineTool({
  name: 'cloud.billing_export_use', title: 'Read costs from this billing export', risk: 'write', action: 'settings_write', peopleOnly: true, timeoutMs: 120_000,
  description: 'People only. For a Google Cloud or Firebase account: read costs from this billing export table (project.dataset.table) from now on, instead of the one Unit7 found first. Unit7 never switches tables by itself.',
  input: z.object({ accountId: fid('acc'), table: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z0-9_]{1,1024}\.gcp_billing_export_(resource_)?v1_[A-Za-z0-9_]{1,200}$/, 'project.dataset.gcp_billing_export_v1_…') }),
  async run(ctx, i) {
    const a = accountOf(ctx, i.accountId);
    if (a.provider !== 'gcp' && a.provider !== 'firebase') throw new Unit7Error('unsupported', 'Only Google accounts have a billing export.', 400);
    const [project, dataset, table] = i.table.split('.') as [string, string, string];
    const tables = await googleBilling.tables(ctx, a.id, project, dataset).catch(() => []);
    if (!tables.some((t) => t.tableReference.tableId === table)) throw new Unit7Error('not_found', `This sign-in can’t see ${i.table}.`, 404);
    pinIt(ctx, a.id, { project, dataset, table });
    dropCached(`gexport:${a.id}`); dropCached(`gexport-rows:${a.id}`);
    ctx.emit('account.updated', `${ctx.actor.name} set ${a.name} to read costs from ${project}.${dataset}`, { resource: a.id });
    return { from: `${project}.${dataset}`, table };
  },
});
