// Removing one DNS record wherever a domain's DNS lives (Cloudflare, Hostinger, GoDaddy, Vercel, DigitalOcean, Porkbun,
// Name.com, Google Cloud DNS, Route 53, Azure DNS, Hetzner). First it says what answers for that name right now (public
// DNS) and what stops working (a site, email, a takeover risk that goes away); people type the record's name, an AI asks
// first. Never NS or SOA at the bare domain (that takes the whole domain offline), never MX unless a person says email
// may stop. What was deleted is kept as an undo in changes, so Activity's Undo puts it back exactly.
import { z } from 'zod';
import { Resolver } from 'node:dns/promises';
import { defineTool, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid } from './helpers.ts';
import { EDITORS, DNS_ACCOUNT, SAME_SIGNIN, fqName, matches, type FullRec } from '../connectors/dnswrite.ts';
import { dnsHost } from '../connectors/dnsinfo.ts';
import { CHANGE_UNDO } from './manage.ts';

// what public DNS answers for a name (asked of public resolvers, like dnsinfo); tests swap these
async function publicAnswers(name: string, type: string): Promise<string[]> {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  const t = type === 'ALIAS' ? 'A' : type;
  try {
    if (t === 'A') return await r.resolve4(name);
    if (t === 'AAAA') return await r.resolve6(name);
    if (t === 'CNAME') return await r.resolveCname(name);
    if (t === 'MX') return (await r.resolveMx(name)).map((m) => `${m.priority} ${m.exchange}`);
    if (t === 'TXT') return (await r.resolveTxt(name)).map((x) => x.join(''));
    if (t === 'NS') return await r.resolveNs(name);
  } catch { /* nothing answers */ }
  return [];
}
export const dnsDeps = { host: dnsHost, answers: publicAnswers };

export const DNS_NAMES: Record<string, string> = {
  cloudflare: 'Cloudflare', hostinger: 'Hostinger', godaddy: 'GoDaddy', vercel: 'Vercel', digitalocean: 'DigitalOcean', porkbun: 'Porkbun', namecom: 'Name.com',
  gcp: 'Google Cloud DNS', firebase: 'Google Cloud DNS', aws: 'Route 53', azure: 'Azure DNS', hetzner: 'Hetzner DNS',
};

// Names go into DNS providers' URL paths, so a hostname and nothing else: labels of letters, digits and hyphens (a record's
// name may also carry underscores, like _dmarc, start with *. or be @), no empty labels, no '/', '%' or '?'
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', RLABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const HOST = new RegExp(`^(?:${LABEL}\\.)*${LABEL}\\.?$`, 'i'), RECORD = new RegExp(`^(?:@|(?:\\*\\.)?(?:${RLABEL}\\.)*${RLABEL}\\.?)$`, 'i');
const hostname = z.string().min(3).max(253).regex(HOST, 'must be a domain name, like example.com');
const Input = z.object({
  domain: hostname.optional().describe('The domain (or any name in it), when name is relative'),
  zone: hostname.optional().describe('The DNS zone, if known (the bare domain)'),
  name: z.string().min(1).max(253).regex(RECORD, 'must be a record name: www, www.example.com, *.example.com or @').describe('The record’s name: full (www.example.com), relative (www) or @ for the bare domain'),
  type: z.string().regex(/^[A-Za-z]{1,10}$/).transform((s) => s.toUpperCase()),
  value: z.string().max(4000).optional().describe('Only the record with this value (others at the same name and type stay); all of them when left out'),
  accountId: fid('acc').optional().describe('The connected DNS account, when there are several'),
  confirmName: z.string().max(253).optional().describe('The record’s full name, typed by the person (an AI gives it; the person approving types it again)'),
  breakEmail: z.boolean().optional().describe('MX only, people only: yes, email to this name may stop arriving'),
});
type In = z.infer<typeof Input>;

// the full name, its zone, who serves the zone's DNS and which account kind edits it
const clean = (s?: string) => s?.trim().toLowerCase().replace(/\.$/, '') || undefined;
async function locate(ctx: Ctx, i: In) {
  const raw = clean(i.name)!, base = clean(i.zone) ?? clean(i.domain);
  if (!base && (raw === '@' || !raw.includes('.'))) throw new Unit7Error('invalid_input', 'Give the record’s full name (like www.example.com), or the domain it’s in.', 400);
  const info = await dnsDeps.host(clean(i.zone) ?? base ?? raw);
  const zone = clean(i.zone) ?? info.zone;
  if (!zone) throw new Unit7Error('not_found', `${base ?? raw} isn’t in public DNS. Is the domain registered?`, 404);
  const name = fqName(raw === '@' ? zone : raw === zone || raw.endsWith(`.${zone}`) ? raw : `${raw}.${zone}`, zone);
  const host = info.zone === zone ? info.host : (await dnsDeps.host(zone)).host;
  const pinned = i.accountId ? get<{ provider: string }>(ctx.db, 'SELECT provider FROM accounts WHERE id = ? AND org_id = ?', i.accountId, ctx.orgId)?.provider : undefined;
  return { name, zone, host, provider: pinned ?? (host && (DNS_ACCOUNT[host] ?? host)) };
}

function refuse(name: string, zone: string, type: string, i: In) {
  if (type === 'SOA' || (type === 'NS' && name === zone)) throw new Unit7Error('refused', `Unit7 never deletes the ${type} record${type === 'NS' ? 's' : ''} of ${zone}: that takes the whole domain offline. To move its DNS somewhere else, change the nameservers at the registrar.`, 403);
  if (type === 'MX' && !i.breakEmail) throw new Unit7Error('confirm_email', `Deleting the MX record${i.value ? '' : 's'} of ${name} stops email to it arriving. Only a person can do it, by saying yes to that.`, 400, { confirm: 'breakEmail' });
}

async function editorFor(ctx: Ctx, provider: string | undefined, zone: string, accountId?: string) {
  const ed = provider ? EDITORS[provider] : undefined;
  if (!provider || !ed) throw new Unit7Error('unsupported', `${zone}’s DNS is ${provider ? `at ${provider}, which Unit7 can’t edit` : 'somewhere Unit7 can’t tell'}. Remove the record where its DNS is managed.`, 400);
  const kinds = SAME_SIGNIN[provider] ?? [provider];
  const accounts = accountId ? [accountId] : all<{ id: string }>(ctx.db, `SELECT id FROM accounts WHERE org_id = ? AND provider IN (${kinds.map(() => '?').join(', ')})`, ctx.orgId, ...kinds).map((a) => a.id);
  if (!accounts.length) throw new Unit7Error('no_account', `${zone}’s DNS is at ${DNS_NAMES[provider] ?? provider}. Connect that account first.`, 409);
  return { ed, accounts };
}

// what deleting it would change, from public DNS and what Unit7 knows (the map, its own domains, the last sync's warnings)
function consequences(ctx: Ctx, name: string, zone: string, type: string, going: FullRec[]) {
  const stops: string[] = [];
  let email = false;
  if (['A', 'AAAA', 'CNAME', 'ALIAS'].includes(type)) {
    const apps = all<{ name: string; meta: string }>(ctx.db, `SELECT name, meta FROM assets WHERE org_id = ? AND kind = 'app'`, ctx.orgId)
      .filter((a) => (json<{ hosts?: string[] }>(a.meta, {}).hosts ?? []).some((h) => h.toLowerCase() === name)).map((a) => a.name);
    const mine = all<{ name: string }>(ctx.db, 'SELECT s.name FROM domains d JOIN services s ON s.id = d.service_id WHERE d.org_id = ? AND d.hostname = ?', ctx.orgId, name).map((s) => s.name);
    for (const a of [...new Set([...mine, ...apps])]) stops.push(`${a} stops answering at ${name}`);
    if (!stops.length) stops.push(`Anything visiting ${name} stops reaching where it points now`);
  }
  if (type === 'MX') { email = true; stops.push(`Email to addresses @${name} stops arriving`); }
  if (type === 'TXT') for (const r of going) {
    if (/^v=spf1/i.test(r.content)) { email = true; stops.push(`Email sent as ${name} may land in spam or be refused (its SPF goes)`); }
    else if (/^v=dmarc1/i.test(r.content)) { email = true; stops.push(`Receivers stop being told to reject fake email from ${name.replace(/^_dmarc\./, '')}`); }
    else if (/^v=dkim1/i.test(r.content) || name.includes('._domainkey.')) { email = true; stops.push('Email signed with this key starts failing checks'); }
    else if (/verification|verify|^_/i.test(`${r.content} ${name}`)) stops.push('A service that checks this record may stop seeing you as the domain’s owner');
  }
  const summary = json<{ issues?: { key: string }[] }>(get<{ summary: string }>(ctx.db, `SELECT summary FROM sync_runs WHERE org_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`, ctx.orgId)?.summary ?? '{}', {});
  const takeover = (summary.issues ?? []).some((x) => x.key === `takeover:${name}`) && ['CNAME', 'ALIAS', 'A', 'AAAA'].includes(type);
  return { stops, email, takeoverCleared: takeover };
}

async function plan(ctx: Ctx, i: In) {
  const { name, zone, provider } = await locate(ctx, i);
  refuse(name, zone, i.type, i);
  const { ed, accounts } = await editorFor(ctx, provider, zone, i.accountId);
  let found: { acc: string; recs: FullRec[] } | undefined;
  const problems: string[] = [];
  for (const acc of accounts) {
    try { found = { acc, recs: await ed.find(ctx, acc, zone, { name, type: i.type }) }; break; } catch (e) { problems.push((e as Error).message); }
  }
  if (!found) throw new Unit7Error('not_found', problems.find((p) => !/isn’t in this/.test(p)) ?? `None of your connected ${DNS_NAMES[provider!] ?? provider} accounts holds ${zone}.`, 404);
  const going = found.recs.filter((r) => matches(r, i.value));
  return { name, zone, provider: provider!, ed, acc: found.acc, all: found.recs, going, answersNow: await dnsDeps.answers(name, i.type), ...consequences(ctx, name, zone, i.type, going) };
}

const at = (provider: string) => DNS_NAMES[provider] ?? provider;
const show = (r: FullRec) => `${r.type} ${r.name} → ${r.priority !== undefined ? `${r.priority} ` : ''}${r.content}`;

defineTool({
  name: 'domain.remove_record', title: 'Remove a DNS record', risk: 'destructive', action: 'dns_delete', timeoutMs: 2 * 60_000,
  peopleOnly: (i) => i.type === 'MX',
  description: 'Delete one DNS record (name + type; with value, only that one of several) where the domain’s DNS lives: Cloudflare, Hostinger, GoDaddy, Vercel, DigitalOcean, Porkbun, Name.com, Google Cloud DNS, Route 53, Azure DNS or Hetzner. Run it as a dry run first: it shows what answers for the name now, what stops working (sites, email) and whether it clears a takeover risk. confirmName is the record’s full name (the person approving types it again). Never NS or SOA at the bare domain; MX only by a person with breakEmail. Activity’s Undo puts the record back.',
  input: Input,
  assess: (c, i) => {
    if ((c.actor.kind === 'agent' || c.actor.role === 'agent') && !c.dryRun && !i.confirmName) throw new Unit7Error('invalid_input', 'Give confirmName: the record’s full name. The person approving types it again.', 400);
    return { tier: 3, ask: 'Deleting a DNS record can take a site or email offline, so a person says yes first.', impact: `Deletes the ${i.type} record${i.value ? ` with ${i.value}` : 's'} at ${i.name}. Activity’s Undo puts it back.` };
  },
  async dryRun(ctx, i) {
    const p = await plan(ctx, i);
    return { name: p.name, zone: p.zone, at: at(p.provider), type: i.type, willDelete: p.going.map(show), stays: p.all.filter((r) => !p.going.includes(r)).map(show), answersNow: p.answersNow,
      stops: p.stops, email: p.email, takeoverCleared: p.takeoverCleared, confirm: p.name, nothing: !p.going.length };
  },
  async run(ctx, i) {
    const p = await plan(ctx, i);
    if ((i.confirmName ?? '').trim().toLowerCase().replace(/\.$/, '') !== p.name) throw new Unit7Error('confirm_needed', `Type the record’s name (${p.name}) to delete it.`, 400, { confirm: p.name });
    if (!p.going.length) throw new Unit7Error('not_found', `There’s no ${i.type} record at ${p.name}${i.value ? ` with ${i.value}` : ''} at ${at(p.provider)}.`, 404);
    ctx.progress(`Removing ${i.type} ${p.name} at ${at(p.provider)}…`);
    const removed = await p.ed.del(ctx, p.acc, p.zone, { name: p.name, type: i.type, value: i.value });
    if (!removed.length) throw new Unit7Error('not_found', `The ${i.type} record at ${p.name} was already gone.`, 404);
    const changeId = id('chg'), summary = `Removed ${removed.length === 1 ? show(removed[0]!) : `${removed.length} ${i.type} records at ${p.name}`} at ${at(p.provider)}`;
    run(ctx.db, 'INSERT INTO changes (id, org_id, server_id, part, verb, summary, undo, status, actor) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
      changeId, ctx.orgId, `dns:${p.name}`, 'dns.remove', summary, JSON.stringify({ steps: [], provider: p.provider, accountId: p.acc, zone: p.zone, records: removed }), 'done', ctx.actor.name);
    ctx.emit('change.made', `${summary}. It can be undone.`, { resource: p.name, data: { changeId, part: `dns:${p.name}`, undo: 'change.undo', provider: p.provider } });
    return { removed: removed.map(show), at: at(p.provider), takeoverCleared: p.takeoverCleared, changeId, undo: `change.undo with changeId ${changeId} puts it back.` };
  },
});

// the undo: each deleted record added back next to whatever is there now (never a replace)
CHANGE_UNDO['dns.remove'] = async (ctx, ch) => {
  const u = json<{ provider: string; accountId: string; zone: string; records: FullRec[] }>(ch.undo, { provider: '', accountId: '', zone: '', records: [] });
  const ed = EDITORS[u.provider];
  if (!ed) throw new Unit7Error('cannot_undo', 'Unit7 can’t edit that DNS host anymore.', 409);
  for (const r of u.records) await ed.add(ctx, u.accountId, u.zone, r);
  return { restored: u.records.map(show) };
};
