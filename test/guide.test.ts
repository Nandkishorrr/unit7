// Start free: the plans data is complete and honest (a source and a checked date on every plan, a limit or "check their
// page", an assumption behind every estimate, one recommended pick per need), it only points at Connections tiles and
// Add to my server cards that exist, and the stack recommender is a pure function with a sensible answer for each goal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKED, GOALS, NEEDS, PLANS, plan, plansFor, recommend, summarize, toggle, type Goal } from '../web/src/pages/guide/plans.ts';
import { CATALOG } from '../src/connectors/oneclick.ts';
import { ADDONS } from '../src/tools/addons.ts';

test('every plan has a source, the checked date, a known need, and a limit or "check their page"', () => {
  const ids = new Set<string>();
  const needs = new Set(NEEDS.map((n) => n.id));
  for (const p of PLANS) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`); ids.add(p.id);
    assert.match(p.source, /^https:\/\/[^\s]+\.[a-z]{2,}\//, `${p.id}: source URL`);
    assert.equal(p.checked, CHECKED, `${p.id}: checked date`);
    assert.equal(CHECKED, '2026-10');
    assert.ok(needs.has(p.need), `${p.id}: need ${p.need}`);
    assert.ok(p.key.trim(), `${p.id}: key limit`);
    assert.ok(p.limits.length && p.limits.every((l) => l.trim()), `${p.id}: a limit or "check their page"`);
    assert.ok(p.paid.name.trim() && p.paid.price.trim(), `${p.id}: first paid step`);
    if (p.fits !== undefined) {
      assert.ok(Number.isFinite(p.fits) && p.fits > 0, `${p.id}: fits is a positive number`);
      assert.ok(p.assumes?.trim(), `${p.id}: an estimate says what it assumes`);
      assert.ok(!p.uncapped, `${p.id}: either a count or no cap`);
    }
    if (p.need === 'domains') assert.ok(p.price?.firstYear && p.price.renewal, `${p.id}: first-year and renewal price`);
    // plain words on screen: no ids, no credential strings
    for (const s of [p.name, p.key, ...p.limits, ...p.gotchas, p.paid.name, p.paid.price, p.best ?? '']) assert.doesNotMatch(s, /credential:\/\/|undefined|NaN/);
  }
  assert.ok(PLANS.length >= 50, `${PLANS.length} plans`);
});

test('every need has plans and exactly one recommended pick, listed first', () => {
  for (const n of NEEDS) {
    const list = plansFor(n.id);
    assert.ok(list.length >= 1, `${n.id} has plans`);
    assert.equal(list.filter((p) => p.best).length, 1, `${n.id}: one recommended`);
    assert.ok(list[0]!.best, `${n.id}: recommended first`);
  }
});

test('honest about plans that are not free any more', () => {
  assert.equal(plan('planetscale')!.free, 'none');
  assert.equal(plan('fly')!.free, 'trial');
  assert.equal(plan('plausible')!.free, 'trial');
  assert.match(plan('vercel')!.gotchas.join(' '), /non-commercial/);
  // a renewal trap is visible in the numbers
  const h = plan('hostinger-domains')!.price!;
  assert.ok(parseFloat(h.renewal.slice(1)) > parseFloat(h.firstYear.slice(1)) * 10);
});

test('Connect and "On my server" only point at things Unit7 has', () => {
  const tiles = new Set(CATALOG.map((c) => c.id));
  const addons = new Set(ADDONS.map((a) => a.id));
  for (const p of PLANS) {
    if (p.connect) assert.ok(tiles.has(p.connect), `${p.id}: Connections tile ${p.connect}`);
    if (p.selfHost) assert.ok(addons.has(p.selfHost), `${p.id}: Add to my server card ${p.selfHost}`);
  }
  for (const id of ['umami', 'uptime-kuma', 'listmonk']) assert.ok(PLANS.some((p) => p.selfHost === id), `${id} links to Add to my server`);
});

test('the recommender: a $0 stack for each goal, with where you would start paying', () => {
  const expect: Record<Goal, { needs: string[]; users: number | null; first: string | null }> = {
    website: { needs: ['hosting', 'dns', 'domains', 'analytics'], users: 150_000, first: 'cloudflare-pages' },
    app: { needs: ['hosting', 'database', 'auth', 'email', 'domains'], users: 1000, first: 'resend' },
    saas: { needs: ['hosting', 'database', 'auth', 'payments', 'email', 'monitoring', 'domains'], users: 1000, first: 'resend' },
    newsletter: { needs: ['newsletter', 'hosting', 'domains'], users: 300, first: 'brevo-news' },
    ai: { needs: ['ai', 'hosting', 'database', 'auth'], users: 5000, first: 'vercel' },
  };
  assert.deepEqual(GOALS.map((g) => g.id).sort(), Object.keys(expect).sort());
  for (const g of GOALS) {
    const r = recommend(g.id);
    const want = expect[g.id];
    assert.equal(r.goal, g.id);
    assert.deepEqual(r.picks.map((x) => x.need), want.needs, `${g.id}: one pick per need`);
    for (const pk of r.picks) {
      const p = plan(pk.plan)!;
      assert.ok(p, `${g.id}: ${pk.plan} exists`);
      assert.equal(p.need, pk.need, `${g.id}: ${pk.plan} is a ${pk.need}`);
      assert.ok(['free', 'self-host', 'per-sale'].includes(p.free) || p.need === 'domains', `${g.id}: ${pk.plan} costs nothing a month`);
      assert.ok(pk.why.trim(), `${g.id}: a why for ${pk.plan}`);
    }
    assert.equal(r.users, want.users, `${g.id}: free until`);
    assert.equal(r.first?.id ?? null, want.first, `${g.id}: first to upgrade`);
    assert.ok(r.first!.paid.price, `${g.id}: its paid step has a price`);
    assert.equal(r.domain?.id, g.id === 'app' || g.id === 'saas' || g.id === 'website' || g.id === 'newsletter' ? 'cf-registrar' : undefined);
    assert.deepEqual(recommend(g.id), r, 'pure: same answer twice');
  }
  assert.deepEqual(recommend('saas').perSale.map((p) => p.id), ['stripe']);
  assert.deepEqual(recommend('ai').uncounted.map((p) => p.id), ['gemini'], 'a limit with no number is said, not guessed');
  assert.deepEqual(recommend('saas').uncounted, [], 'errors and sales are not counted in users');
});

test('building a stack by hand: one per need, swap in place, take out, recount', () => {
  let s = recommend('app').picks;
  s = toggle(s, plan('neon')!); // swaps the database in place
  assert.equal(s.length, 5);
  assert.equal(s.find((x) => x.need === 'database')!.plan, 'neon');
  s = toggle(s, plan('resend')!); // takes it out
  assert.ok(!s.some((x) => x.plan === 'resend'));
  assert.equal(summarize(s.map((x) => x.plan)).users, 5000); // Vercel is now the first to run out
  s = toggle(s, plan('posthog')!); // a new need goes on the end
  assert.equal(s.at(-1)!.need, 'analytics');
  assert.deepEqual(summarize([]), { users: null, first: null, uncounted: [], perSale: [], domain: null });
});
