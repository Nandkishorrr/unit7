// A monthly budget across every provider. Unit7 reads what it can (spent so far this month from Vercel, Railway
// and DigitalOcean; fixed monthly prices from Hostinger subscriptions, Cloudflare plans and Heroku's last
// invoice), adds the amounts you enter for providers with no billing API (Render, Netlify, Supabase, Fly.io…),
// converts currencies, and forecasts the month. It warns once at an 80% forecast and once when the budget is
// actually spent; optional actions then trim what Unit7 itself runs.
import { z } from 'zod';
import { defineTool, execute, noteAccountTrouble, type Ctx } from './runtime.ts';
import { all, get, json, now, run } from '../db.ts';
import { vercel } from '../connectors/clouds.ts';
import { railway, digitalocean, heroku } from '../connectors/hosts.ts';
import { cloudflare } from '../connectors/cloudflare.ts';
import { hostinger } from '../connectors/hostinger.ts';
import { pool } from '../discovery/scanners.ts';

// spent: usage this calendar month; period: usage in the provider's own billing period (its dates unknown, so
// counted as it is, never projected over the month); monthly: a fixed price; unknown: it's there but Unit7 can't put a
// number on it (kept at 0 and never added up, with why it's unknown)
export type CostKind = 'spent' | 'period' | 'monthly' | 'unknown';
export interface Cost { provider: string; account: string; label: string; amount: number; currency: string; kind: CostKind; why?: string }
interface Budget { monthly: number | null; currency: string; actions: { scaleDown?: boolean; stopPreviews?: boolean }; manual: { label: string; monthly: number }[] }

export const perMonth = (amount: number, period: number, unit: string) => {
  const u = unit.toLowerCase(), months = u.startsWith('year') ? period * 12 : u.startsWith('day') ? period / 30.4 : u.startsWith('week') ? period / 4.35 : u.startsWith('quarter') ? period * 3 : period;
  return months > 0 ? amount / months : amount;
};

// One Hostinger subscription as a monthly cost, field by field from its API docs (Billing.V1.Subscription.SubscriptionResource).
// Status: active and in_trial bill. not_renewing is auto-renew switched off: paid for and live until expires_at, so it still
// counts (this is how a VPS paid for up front used to vanish from the bill). paused and future don't bill now. cancelled and
// transferred are gone. Prices are in cents, and renewal_price can be 0 on a plan that won't renew: the first price above 0 counts.
export interface HostingerSub { id?: unknown; name?: string; status?: string; billing_period?: number; billing_period_unit?: string; currency_code?: string; renewal_price?: number | null; total_price?: number | null; expires_at?: string | null }
export function subCost(s: HostingerSub, at = Date.now()): { monthly: number; currency: string } | { why: string } | undefined {
  const status = (s.status ?? '').toLowerCase();
  if (status === 'cancelled' || status === 'transferred') return undefined;
  if (status === 'not_renewing' && s.expires_at && Date.parse(s.expires_at) < at) return undefined;
  if (!['active', 'in_trial', 'not_renewing'].includes(status)) return { why: `its status is ${status.replace(/_/g, ' ') || 'missing'}` };
  const cents = [s.renewal_price, s.total_price].map(Number).find((c) => c > 0);
  if (!cents) return { why: 'Hostinger gave no price' };
  if (!(Number(s.billing_period) > 0) || !s.billing_period_unit) return { why: 'Hostinger didn’t say how often it’s billed' };
  if (!s.currency_code) return { why: 'Hostinger gave no currency' };
  return { monthly: perMonth(cents / 100, Number(s.billing_period), s.billing_period_unit), currency: s.currency_code.toUpperCase() };
}

// Providers that read their own spending register here (AWS and Azure, in tools/bigclouds.ts): this month so far
export const SPEND: Record<string, (ctx: Ctx, accountId: string) => Promise<{ label: string; amount: number; currency: string }[]>> = {};

async function collect(ctx: Ctx): Promise<{ costs: Cost[]; problems: string[] }> {
  const costs: Cost[] = [], problems: string[] = [];
  const accounts = all<{ id: string; name: string; provider: string }>(ctx.db, `SELECT id, name, provider FROM accounts WHERE org_id = ? AND provider IN ('vercel', 'railway', 'digitalocean', 'heroku', 'cloudflare', 'hostinger', ${Object.keys(SPEND).map(() => '?').join(', ') || "''"})`, ctx.orgId, ...Object.keys(SPEND));
  await pool(accounts, 4, async (a) => {
    try {
      if (a.provider === 'vercel') for (const t of await vercel.spentThisMonth(ctx, a.id)) costs.push({ provider: 'vercel', account: a.name, label: `${t.team} (usage this month)`, amount: t.usd, currency: 'USD', kind: 'spent' });
      if (a.provider === 'railway') for (const w of await railway.spentThisPeriod(ctx, a.id)) costs.push({ provider: 'railway', account: a.name, label: `${w.workspace} (usage this period)`, amount: w.usd, currency: 'USD', kind: 'period' });
      if (a.provider === 'digitalocean') { const usd = await digitalocean.monthToDate(ctx, a.id); if (usd) costs.push({ provider: 'digitalocean', account: a.name, label: 'usage this month', amount: usd, currency: 'USD', kind: 'spent' }); }
      if (a.provider === 'heroku') { const inv = await heroku.lastInvoice(ctx, a.id); if (inv?.total) costs.push({ provider: 'heroku', account: a.name, label: `last invoice (to ${inv.period_end})`, amount: inv.total, currency: 'USD', kind: 'monthly' }); }
      if (a.provider === 'cloudflare') {
        for (const z of await cloudflare.zones(ctx, a.id)) {
          const plan = (await cloudflare.zonePlan(ctx, a.id, z.id).catch(() => undefined));
          if (plan?.price) costs.push({ provider: 'cloudflare', account: a.name, label: `${z.name} (${plan.name})`, amount: perMonth(plan.price, 1, plan.frequency ?? 'monthly'), currency: plan.currency ?? 'USD', kind: 'monthly' });
        }
      }
      for (const c of SPEND[a.provider] ? await SPEND[a.provider]!(ctx, a.id) : []) costs.push({ provider: a.provider, account: a.name, ...c, kind: 'spent' });
      if (a.provider === 'hostinger') {
        const text = await hostinger(ctx.app).call(ctx, a.id, 'execute', { operation: 'billing_subscriptions_list', params: {} }, 60_000);
        const got = JSON.parse(text) as HostingerSub[] | { data?: HostingerSub[] }, subs = Array.isArray(got) ? got : got.data ?? [];
        for (const s of subs) {
          const c = subCost(s), label = s.name ?? 'A Hostinger plan';
          if (c) costs.push('why' in c ? { provider: 'hostinger', account: a.name, label, amount: 0, currency: 'USD', kind: 'unknown', why: c.why } : { provider: 'hostinger', account: a.name, label, amount: c.monthly, currency: c.currency, kind: 'monthly' });
        }
      }
    } catch (e) { noteAccountTrouble(ctx.app, a.id, e); problems.push(`${a.name}: ${(e as Error).message.slice(0, 120)}`); }
  });
  return { costs, problems };
}

// one rate per currency into the budget's currency (ECB rates via frankfurter.app); a cost with no rate is marked unknown
async function rates(from: string[], to: string): Promise<Record<string, number>> {
  const out: Record<string, number> = { [to]: 1 };
  for (const c of [...new Set(from)].filter((x) => x !== to)) {
    try { const r = await fetch(`https://api.frankfurter.app/latest?from=${c}&to=${to}`, { signal: AbortSignal.timeout(10_000) }).then((x) => x.json()) as { rates?: Record<string, number> }; if (r.rates?.[to]) out[c] = r.rates[to]!; } catch { /* left out */ }
  }
  return out;
}

export function budgetOf(ctx: Pick<Ctx, 'db' | 'orgId'>): Budget {
  const o = get<{ budget_monthly: number | null; budget_currency: string; budget_actions: string; budget_manual: string }>(ctx.db, 'SELECT budget_monthly, budget_currency, budget_actions, budget_manual FROM orgs WHERE id = ?', ctx.orgId)!;
  return { monthly: o.budget_monthly, currency: o.budget_currency, actions: json(o.budget_actions, {}), manual: json(o.budget_manual, []) };
}

// The month so far and the forecast, from a list of costs (pure: testable)
export function forecast(costs: { amount: number; kind: CostKind }[], at = new Date()) {
  const days = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = (at.getUTCDate() - 1 + at.getUTCHours() / 24) / days;
  const sum = (k: CostKind) => costs.filter((c) => c.kind === k).reduce((s, c) => s + c.amount, 0);
  const spent = sum('spent'), period = sum('period'), fixed = sum('monthly');
  // fixed prices count in full; this month's usage is extrapolated (after the first few days, when it means
  // something); a billing period's usage is counted as it stands
  const usageForecast = elapsed > 0.1 ? spent / elapsed : spent + (spent / Math.max(elapsed, 0.03)) * 0.25;
  return { soFar: spent + period + fixed * elapsed, forecast: usageForecast + period + fixed, spent: spent + period, fixed, elapsed };
}

export async function checkBudget(ctx: Ctx) {
  const b = budgetOf(ctx);
  const { costs, problems } = await collect(ctx);
  for (const m of b.manual) costs.push({ provider: 'manual', account: 'you', label: m.label, amount: m.monthly, currency: b.currency, kind: 'monthly' });
  const counted = costs.filter((c) => c.kind !== 'unknown');
  const fx = await rates(counted.map((c) => c.currency), b.currency);
  const usable = counted.filter((c) => fx[c.currency]).map((c) => ({ ...c, amount: c.amount * fx[c.currency]!, original: c.currency === b.currency ? undefined : `${c.amount.toFixed(2)} ${c.currency}` }));
  // never left out without a word: these show with no amount, and the totals say they don't include them
  const unknown = [...costs.filter((c) => c.kind === 'unknown'), ...counted.filter((c) => !fx[c.currency]).map((c) => ({ ...c, why: `${c.amount.toFixed(2)} ${c.currency}, no exchange rate to ${b.currency} right now` }))];
  const f = forecast(usable);
  run(ctx.db, 'DELETE FROM costs WHERE org_id = ?', ctx.orgId);
  for (const c of [...usable, ...unknown.map((u) => ({ ...u, amount: 0, kind: 'unknown' as const, original: u.why }))]) run(ctx.db, 'INSERT INTO costs (org_id, provider, account, label, amount, currency, kind, original, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ctx.orgId, c.provider, c.account, c.label, c.amount, b.currency, c.kind, c.original ?? null, now());
  const month = now().slice(0, 7);
  const alerted = get<{ budget_alerted: string | null }>(ctx.db, 'SELECT budget_alerted FROM orgs WHERE id = ?', ctx.orgId)?.budget_alerted ?? '';
  const money = (n: number) => `${n.toFixed(2)} ${b.currency}`;
  let level: 'ok' | 'warning' | 'over' = 'ok', acted: string[] = [];
  if (b.monthly) {
    if (f.soFar >= b.monthly) level = 'over'; else if (f.forecast >= b.monthly * 0.8) level = 'warning';
  }
  // under budget again (a new month, a higher budget): autoscaled apps get back the maximum they had
  if (level !== 'over') for (const s of restoreMax(ctx)) acted.push(`gave ${s} back its autoscale maximum`);
  if (b.monthly) {
    if (level !== 'ok' && alerted !== `${month}:${level}` && !(level === 'warning' && alerted === `${month}:over`)) {
      run(ctx.db, 'UPDATE orgs SET budget_alerted = ? WHERE id = ?', `${month}:${level}`, ctx.orgId);
      if (level === 'over') acted = await overBudget(ctx, b);
      ctx.emit(level === 'over' ? 'budget.over' : 'budget.warning', level === 'over'
        ? `This month's spending has reached ${money(f.soFar)} of your ${money(b.monthly)} budget.${acted.length ? ` Unit7 ${acted.join('; ')}.` : ''}`
        : `Spending is on course for ${money(f.forecast)} this month, ${Math.round((f.forecast / b.monthly) * 100)}% of your ${money(b.monthly)} budget.`, { severity: level === 'over' ? 'critical' : 'warning' });
    }
  }
  return { currency: b.currency, budget: b.monthly, soFar: Number(f.soFar.toFixed(2)), forecast: Number(f.forecast.toFixed(2)), level, acted, costs: usable.map((c) => ({ provider: c.provider, account: c.account, label: c.label, amount: Number(c.amount.toFixed(2)), kind: c.kind, original: c.original })), unknown: unknown.map((u) => ({ provider: u.provider, account: u.account, label: u.label, why: u.why })), problems };
}

// What Unit7 itself can trim (its own servers' load, not other providers' bills), only if switched on
async function overBudget(ctx: Ctx, b: Budget): Promise<string[]> {
  const done: string[] = [];
  if (b.actions.scaleDown) {
    for (const s of all<{ id: string; name: string; config: string }>(ctx.db, `SELECT id, name, config FROM services WHERE org_id = ? AND json_extract(config, '$.autoscale.on') = 1`, ctx.orgId)) {
      const c = json<{ replicas?: number; autoscale: { min: number } }>(s.config, { autoscale: { min: 1 } });
      // the maximum a person set is kept, so it comes back once spending is under budget again
      run(ctx.db, `UPDATE services SET config = json_set(config, '$.autoscale.maxBeforeBudget', coalesce(json_extract(config, '$.autoscale.maxBeforeBudget'), json_extract(config, '$.autoscale.max')),
        '$.autoscale.max', json_extract(config, '$.autoscale.min')) WHERE id = ?`, s.id);
      if ((c.replicas ?? 1) > c.autoscale.min && (await execute(ctx.app, ctx.orgId, ctx.actor, 'service.scale', { serviceId: s.id, replicas: c.autoscale.min }, { reason: 'over budget' })).status === 'ok') done.push(`scaled ${s.name} down to ${c.autoscale.min}`);
    }
  }
  if (b.actions.stopPreviews) {
    for (const s of all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM services WHERE org_id = ? AND json_extract(config, '$.previewOf') IS NOT NULL AND status != 'stopped'`, ctx.orgId)) {
      if ((await execute(ctx.app, ctx.orgId, ctx.actor, 'service.stop', { serviceId: s.id }, { reason: 'over budget' })).status === 'ok') done.push(`stopped preview ${s.name}`);
    }
  }
  return done;
}

function restoreMax(ctx: Ctx): string[] {
  const capped = all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM services WHERE org_id = ? AND json_extract(config, '$.autoscale.maxBeforeBudget') IS NOT NULL`, ctx.orgId);
  for (const s of capped) run(ctx.db, `UPDATE services SET config = json_remove(json_set(config, '$.autoscale.max', json_extract(config, '$.autoscale.maxBeforeBudget')), '$.autoscale.maxBeforeBudget') WHERE id = ?`, s.id);
  return capped.map((s) => s.name);
}

defineTool({
  name: 'budget.check', title: 'Costs and budget', risk: 'read', action: 'read', timeoutMs: 5 * 60_000,
  description: 'What this month costs so far across providers (spent from Vercel, Railway, DigitalOcean; fixed prices from Hostinger, Cloudflare, Heroku; your own entries for the rest), the forecast for the month, and how it compares with your budget. unknown lists what Unit7 knows is there but can’t price: the totals don’t include those, so say so. Warden checks daily and alerts at 80% forecast and at 100% spent.',
  input: z.object({}),
  run: (ctx) => checkBudget(ctx),
});

defineTool({
  name: 'budget.set', title: 'Set a monthly budget', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: 'Set the monthly budget (and its currency), costs Unit7 can’t read (e.g. Render, Netlify, Supabase, Fly.io plans), and what Unit7 does when the budget is spent: cap autoscaled apps at their minimum, stop preview deployments (each optional; they trim Unit7’s own servers, not other providers’ bills). People only.',
  input: z.object({ monthly: z.number().min(0).max(10_000_000).nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    manual: z.array(z.object({ label: z.string().min(1).max(80), monthly: z.number().min(0).max(1_000_000) })).max(50).optional(),
    scaleDown: z.boolean().optional(), stopPreviews: z.boolean().optional() }),
  run(ctx, i) {
    const b = budgetOf(ctx);
    run(ctx.db, 'UPDATE orgs SET budget_monthly = ?, budget_currency = ?, budget_manual = ?, budget_actions = ? WHERE id = ?',
      i.monthly === undefined ? b.monthly : i.monthly, i.currency ?? b.currency, JSON.stringify(i.manual ?? b.manual),
      JSON.stringify({ scaleDown: i.scaleDown ?? b.actions.scaleDown ?? false, stopPreviews: i.stopPreviews ?? b.actions.stopPreviews ?? false }), ctx.orgId);
    return budgetOf(ctx);
  },
});

// the exchange-rate helper, for other money views (the cost radar)
export { rates as fxRates };
