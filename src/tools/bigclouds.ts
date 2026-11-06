// The big clouds as accounts: the live check behind "Check it works" (and the automatic name, "Google Cloud ·
// my-project"), and the bill in plain words: what it cost so far this month where the provider says, and whether
// a spending alert (a budget) is set, the one thing that stops a runaway bill from surprising you.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { get } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { verifiers } from './core.ts';
import { pool } from '../discovery/scanners.ts';
import { fid } from './helpers.ts';
import { google, googleCred, firebaseCli, viaFirebaseCli } from '../connectors/google.ts';
import { aws } from '../connectors/aws.ts';
import { azure } from '../connectors/azure.ts';
import { hetzner } from '../connectors/hetzner.ts';
import { SPEND } from './budget.ts';

verifiers.gcp = verifiers.firebase = async (ctx, a) => {
  const fb = viaFirebaseCli(ctx, a.id);
  const projects = fb ? await firebaseCli.projects(fb.account) : await google.projects(ctx, a.id);
  const c = googleCred(ctx, a.id);
  return { label: 'cli' in c ? c.account : c.project_id ?? c.client_email.split('@')[0], projects: projects.length };
};

verifiers.aws = async (ctx, a) => { const w = await aws.whoami(ctx, a.id); return { label: w.account, arn: w.arn }; };
verifiers.azure = async (ctx, a) => { const subs = await azure.subscriptions(ctx, a.id); return { label: subs[0]?.displayName, subscriptions: subs.length }; };
verifiers.hetzner = async (ctx, a) => ({ servers: (await hetzner.servers(ctx, a.id)).length });

// spend: this month so far (null: the provider doesn't say through its API); budgets: null when they couldn't be
// read, [] when none is set (the drawer then says so)
export interface Bill {
  spend: { amount: number; currency: string } | null;
  budgets: { name: string; amount: number; currency: string; spent?: number; alertsAt?: number[] }[] | null;
  payers?: { name: string; projects: string[] }[]; // Google: which billing account pays for which projects
  free?: string[];                                  // Google: projects with billing off (free tier only, can't run up a bill)
  note?: string;
  manageUrl: string;
  // Google: the billing export to BigQuery (tools/clouds-money.ts): where it is and when it was read, or the steps to switch it on
  export?: { found: true; table: string; project: string; from?: string; readAt?: string; problem?: string } | { found: false; steps: string[]; link: string; pinned?: string };
}

async function googleBill(ctx: Ctx, acc: string): Promise<Bill> {
  if (viaFirebaseCli(ctx, acc)) return { spend: null, budgets: null, note: 'Billing needs gcloud or a key: the Firebase CLI can’t read it.', manageUrl: 'https://console.firebase.google.com/project/_/usage/details' };
  const projects = await google.projects(ctx, acc);
  const info = await pool(projects, 4, async (p) => ({ project: p.projectId, ...(await google.billingInfo(ctx, acc, p.projectId).catch(() => ({ billingAccountName: undefined, billingEnabled: undefined }))) }));
  const names = await google.billingAccounts(ctx, acc).catch(() => []);
  const payers = [...new Set(info.map((i) => i.billingAccountName).filter((x): x is string => !!x))];
  let unreadable = false;
  const budgets = (await pool(payers, 2, async (ba) => (await google.budgets(ctx, acc, ba).catch(() => { unreadable = true; return []; })).map((b) => ({
    name: b.displayName || 'Budget', amount: Number(b.amount?.specifiedAmount?.units ?? 0), currency: b.amount?.specifiedAmount?.currencyCode ?? names.find((n) => n.name === ba)?.currencyCode ?? 'USD',
    alertsAt: (b.thresholdRules ?? []).map((t) => Math.round(t.thresholdPercent * 100)),
  })))).flat();
  return {
    spend: null, budgets: unreadable && !budgets.length ? null : budgets,
    payers: payers.map((ba) => ({ name: names.find((n) => n.name === ba)?.displayName ?? ba.split('/')[1]!, projects: info.filter((i) => i.billingAccountName === ba && i.billingEnabled).map((i) => i.project) })),
    free: info.filter((i) => i.billingEnabled === false).map((i) => i.project),
    note: 'Google shows what you’ve spent only in its console (or a billing export). Unit7 reads who pays and which alerts are set.',
    manageUrl: payers[0] ? `https://console.cloud.google.com/billing/${payers[0].split('/')[1]}/budgets` : 'https://console.cloud.google.com/billing',
  };
}

async function awsBill(ctx: Ctx, acc: string): Promise<Bill> {
  const { account } = await aws.whoami(ctx, acc);
  const [spend, budgets] = await Promise.all([aws.monthToDate(ctx, acc).catch(() => null), aws.budgets(ctx, acc, account).catch(() => null)]);
  return {
    spend, budgets: budgets && budgets.map((b) => ({ name: b.BudgetName, amount: Number(b.BudgetLimit?.Amount ?? 0), currency: b.BudgetLimit?.Unit ?? 'USD', ...(b.CalculatedSpend?.ActualSpend && { spent: Number(b.CalculatedSpend.ActualSpend.Amount) }) })),
    note: spend ? 'AWS charges a cent each time the cost is read, so Unit7 reads it at most twice a day.' : 'This sign-in can’t read costs: it needs Cost Explorer access (and, for an IAM user, billing access switched on by the account owner).',
    manageUrl: 'https://console.aws.amazon.com/billing/home#/budgets',
  };
}

async function azureBill(ctx: Ctx, acc: string): Promise<Bill> {
  const subs = (await azure.subscriptions(ctx, acc)).filter((s) => s.state !== 'Disabled');
  const [costs, budgets] = await Promise.all([pool(subs, 3, (s) => azure.monthToDate(ctx, acc, s.subscriptionId).catch(() => null)), pool(subs, 3, (s) => azure.budgets(ctx, acc, s.subscriptionId).catch(() => null))]);
  const known = costs.filter((c): c is { amount: number; currency: string } => !!c);
  return {
    // ponytail: subscriptions billed in different currencies are added as if they were one; split them when someone has that
    spend: known.length ? { amount: known.reduce((n, c) => n + c.amount, 0), currency: known[0]!.currency } : null,
    budgets: budgets.every((b) => b === null) ? null : budgets.flatMap((b) => b ?? []).map((b) => ({ name: b.name, amount: b.properties?.amount ?? 0, currency: b.properties?.currentSpend?.unit ?? known[0]?.currency ?? 'USD', ...(b.properties?.currentSpend?.amount !== undefined && { spent: b.properties.currentSpend.amount }) })),
    note: known.length ? undefined : 'This sign-in can’t read costs: give it the Cost Management Reader role.',
    manageUrl: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/overview',
  };
}

export const BILLS: Record<string, (ctx: Ctx, acc: string) => Promise<Bill>> = { gcp: googleBill, firebase: googleBill, aws: awsBill, azure: azureBill };
// the monthly budget (budget.check) counts what AWS and Azure say was spent
for (const p of ['aws', 'azure']) SPEND[p] = async (ctx, acc) => { const s = (await BILLS[p]!(ctx, acc)).spend; return s?.amount ? [{ label: 'usage this month', ...s }] : []; };

defineTool({
  name: 'cloud.billing', title: 'See what a cloud account costs', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'For a Google Cloud, Firebase, AWS or Azure account: spending so far this month (where the provider shares it), the budgets (spending alerts) set on it, and for Google which billing account pays for which project. No budget means nothing warns before a bill runs away.',
  input: z.object({ accountId: fid('acc') }),
  async run(ctx, i) {
    const a = get<{ provider: string; name: string }>(ctx.db, 'SELECT provider, name FROM accounts WHERE id = ? AND org_id = ?', i.accountId, ctx.orgId)!;
    const bill = BILLS[a.provider];
    if (!bill) throw new Unit7Error('unsupported', `Unit7 doesn’t read ${a.name}’s bill yet.`, 400);
    return { account: a.name, provider: a.provider, ...(await bill(ctx, i.accountId)) };
  },
});
