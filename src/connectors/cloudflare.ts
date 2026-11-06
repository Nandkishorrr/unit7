// Cloudflare DNS over the REST API. Token comes from the vault via the broker; the AI never sees it.
import type { Ctx } from '../tools/runtime.ts';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';
import { dnsHost } from './dnsinfo.ts';

export const cfApi = () => process.env.UNIT7_CLOUDFLARE_API ?? 'https://api.cloudflare.com/client/v4';

// jwt: Pages' own upload token, for the calls made with it instead of the account's token
export async function cf(ctx: Ctx, accountId: string | undefined, path: string, init: { method?: string; body?: unknown; form?: FormData; jwt?: string; timeoutMs?: number } = {}) {
  const { value } = ctx.credentialFor('cloudflare', accountId);
  await assertReachable(new URL(cfApi()).hostname);
  const res = await fetch(`${cfApi()}${path}`, {
    method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${init.jwt ?? value}`, ...(!init.form && { 'content-type': 'application/json' }) },
    body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
  });
  const data = await res.json().catch(() => ({})) as { success?: boolean; result?: any; errors?: { message: string }[] };
  if (!res.ok || data.success === false) {
    throw new Unit7Error('cloudflare_error', `Cloudflare: ${data.errors?.map((e) => e.message).join('; ') || res.statusText}`, res.status === 403 || res.status === 404 ? res.status : 502);
  }
  return data.result;
}

export const cloudflare = {
  async verify(ctx: Ctx, accountId: string) {
    const zones = await cf(ctx, accountId, '/zones?per_page=50');
    return { zones: zones.map((z: any) => z.name) };
  },
  async findZone(ctx: Ctx, accountId: string | undefined, hostname: string): Promise<{ id: string; name: string } | undefined> {
    const labels = hostname.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join('.');
      const zones = await cf(ctx, accountId, `/zones?name=${encodeURIComponent(candidate)}`);
      if (zones?.[0]) return { id: zones[0].id, name: zones[0].name };
    }
    return undefined;
  },
  async upsertRecord(ctx: Ctx, accountId: string | undefined, zoneId: string, rec: { type: string; name: string; content: string; proxied?: boolean; ttl?: number }) {
    const existing = await cf(ctx, accountId, `/zones/${zoneId}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`);
    const body = { type: rec.type, name: rec.name, content: rec.content, ttl: rec.ttl ?? 300, proxied: rec.proxied ?? false };
    if (existing?.[0]) return cf(ctx, accountId, `/zones/${zoneId}/dns_records/${existing[0].id}`, { method: 'PUT', body });
    return cf(ctx, accountId, `/zones/${zoneId}/dns_records`, { method: 'POST', body });
  },
  async listRecords(ctx: Ctx, accountId: string | undefined, zoneId: string) {
    return cf(ctx, accountId, `/zones/${zoneId}/dns_records?per_page=1000`); // ponytail: one page of 1000; page through for bigger zones
  },
  // a new zone in the token's Cloudflare account (or the one already there); Cloudflare names its nameservers
  async createZone(ctx: Ctx, accountId: string, name: string): Promise<{ id: string; name_servers: string[]; status: string }> {
    const existing = (await cf(ctx, accountId, `/zones?name=${encodeURIComponent(name)}`))?.[0];
    if (existing) return existing;
    const [account] = await cf(ctx, accountId, '/accounts?per_page=5') as { id: string }[];
    if (!account) throw new Unit7Error('cloudflare_error', 'This Cloudflare token can\u2019t see an account to create the zone in.', 403);
    return cf(ctx, accountId, '/zones', { body: { name, account: { id: account.id }, type: 'full' } }).catch((e: Unit7Error) => {
      throw /permission|auth/i.test(e.message) ? new Unit7Error('cloudflare_error', 'Your Cloudflare token can edit DNS but not add domains. In Connections, add a new Cloudflare key (the button pre-fills the right permissions).', 403) : e;
    });
  },
  addRecord: (ctx: Ctx, accountId: string, zoneId: string, r: { type: string; name: string; content?: string; data?: object; ttl?: number; priority?: number; proxied?: boolean }) =>
    cf(ctx, accountId, `/zones/${zoneId}/dns_records`, { body: { ...r, ttl: r.ttl ?? 1, proxied: r.proxied ?? false } }).catch((e: Unit7Error) => { if (!/already exists|identical record/i.test(e.message)) throw e; }),
  // the Cloudflare account a token belongs to: Pages projects live under it, not under a zone
  // ponytail: a token's first account, as createZone does; a token spanning several would need a way to choose
  async accountOf(ctx: Ctx, accountId: string): Promise<string> {
    const [account] = await cf(ctx, accountId, '/accounts?per_page=5') as { id: string }[];
    if (!account) throw new Unit7Error('cloudflare_error', 'This Cloudflare token can’t see an account. In Connections, add a new Cloudflare key (the button pre-fills the right permissions).', 403);
    return account.id;
  },
  // the account that holds a Pages project: a token can reach several
  async pagesAccount(ctx: Ctx, accountId: string, project: string): Promise<string> {
    const name = encodeURIComponent(project);
    for (const a of await cf(ctx, accountId, '/accounts?per_page=50') as { id: string }[]) if (await cf(ctx, accountId, `/accounts/${a.id}/pages/projects/${name}`).then(() => true, () => false)) return a.id;
    throw new Unit7Error('not_found', `Cloudflare has no Pages project called ${project} that this key can reach. A key needs “Cloudflare Pages: Edit” for this: add one in Connections.`, 404);
  },
  // a Pages project answers on a domain once Cloudflare knows the name and DNS points at its pages.dev address. A bare
  // domain needs a flattened CNAME (Cloudflare does it) or ALIAS, as on Heroku
  async addPagesDomain(ctx: Ctx, accountId: string, project: string, domain: string): Promise<{ type: 'CNAME' | 'ALIAS'; name: string; content: string }[]> {
    const base = `/accounts/${await cloudflare.pagesAccount(ctx, accountId, project)}/pages/projects/${encodeURIComponent(project)}`;
    await cf(ctx, accountId, `${base}/domains`, { body: { name: domain } }).catch((e: Unit7Error) => { if (!/already/i.test(e.message)) throw e; });
    return [{ type: (await dnsHost(domain)).zone === domain ? 'ALIAS' : 'CNAME', name: domain, content: (await cf(ctx, accountId, base)).subdomain ?? `${project}.pages.dev` }];
  },
  // asks Cloudflare to check the domain again now DNS points there
  confirmPagesDomain: async (ctx: Ctx, accountId: string, project: string, domain: string) => { await cf(ctx, accountId, `/accounts/${await cloudflare.pagesAccount(ctx, accountId, project)}/pages/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`, { method: 'PATCH' }).catch(() => undefined); },
  zonePlan: (ctx: Ctx, accountId: string, zoneId: string) => cf(ctx, accountId, `/zones/${zoneId}`).then((z: { plan?: { name: string; price: number; currency: string; frequency?: string } }) => z.plan),
  async zones(ctx: Ctx, accountId: string) {
    const out: { id: string; name: string; status: string }[] = [];
    for (let page = 1; page < 50; page++) {
      const z = await cf(ctx, accountId, `/zones?per_page=50&page=${page}`) as { id: string; name: string; status: string }[];
      out.push(...z);
      if (z.length < 50) break;
    }
    return out;
  },
};
