// What Unit7 has seen of each Supabase's sign-in: who sends its emails, and where it sends people. Hosted from the last sync,
// self-hosted from the X-ray, which keeps where a setting points and never a secret. Only Unit7's own records, so the
// readiness list and the Check-up can use it without a trip to anywhere.
import { all, get, json, type DB } from '../db.ts';
import { makeRef } from '../vault.ts';
import type { Inventory, Part } from '../discovery/xray.ts';
import { lastXray } from '../tools/xray.ts';
import { apexOf, isTestHost, type Fix } from './readiness.ts';

export interface SeenAuth { key: string; name: string; at: { ref: string } | { serverId: string; part: string }; sender: 'own' | 'built-in' | 'none'; site?: string; apps: string[]; domain?: string; api?: string[] }

const ownHost = (h?: string) => (h && !isTestHost(h) ? h : undefined);
// the sign-in a stack on a server runs: GoTrue's settings, as the X-ray read them. A site address that's the stack's own API
// (how Coolify's template starts) isn't an app people can land on.
export function stackAuth(serverId: string, inv: Inventory, p: Part): SeenAuth {
  const env = p.env ?? [], via = (k: string) => { const e = env.find((x) => x.via === k); return e?.host ?? e?.ip; };
  const project = inv.projects.find((x) => x.parts.includes(p.id)), apps = project ? inv.parts.filter((x) => project.parts.includes(x.id) && x.kind === 'app').map((x) => x.name) : [];
  const domain = project?.domains.find(ownHost), site = via('GOTRUE_SITE_URL');
  return { key: `stack:${serverId}:${p.id}`, name: p.name, at: { serverId, part: p.id }, sender: via('GOTRUE_SMTP_HOST') ? 'own' : 'none', ...(site && !p.hosts?.includes(site) && { site }), apps, ...(domain && { domain: apexOf(domain) }), api: p.hosts ?? [] };
}
// hosted projects a sync could read (a one-click sign-in can't, so those stay unknown and out of it)
export function hostedAuth(db: DB, orgId: string): SeenAuth[] {
  return all<{ id: string; ext_id: string; name: string; meta: string }>(db, `SELECT id, ext_id, name, meta FROM assets WHERE org_id = ? AND provider = 'supabase'`, orgId).flatMap((a) => {
    const seen = json<{ auth?: { smtp: boolean; site?: string } }>(a.meta, {}).auth;
    if (!seen) return [];
    const apps = all<{ name: string; url: string | null; meta: string }>(db, `SELECT s.name, s.url, s.meta FROM edges e JOIN assets s ON s.id = e.source WHERE e.org_id = ? AND e.target = ? AND s.kind = 'app'`, orgId, a.id);
    const domain = apps.flatMap((x) => json<{ hosts?: string[] }>(x.meta, {}).hosts ?? []).find(ownHost);
    return [{ key: `supabase:${a.ext_id}`, name: a.name, at: { ref: a.ext_id }, sender: seen.smtp ? 'own' as const : 'built-in' as const, ...(seen.site && URL.canParse(seen.site) && { site: new URL(seen.site).hostname }), apps: apps.map((x) => x.name), ...(domain && { domain: apexOf(domain) }) }];
  });
}
// every Supabase Unit7 knows of, with an app on a hosted one (one nothing uses has nobody to fail); serverId: only that server's
export function seenAuth(db: DB, orgId: string, serverId?: string): SeenAuth[] {
  const stacks = all<{ id: string }>(db, 'SELECT id FROM servers WHERE org_id = ? AND (? IS NULL OR id = ?)', orgId, serverId ?? null, serverId ?? null).flatMap((s) => {
    const inv = lastXray(db, orgId, s.id)?.data;
    return inv ? inv.parts.filter((p) => p.product?.id === 'supabase').map((p) => stackAuth(s.id, inv, p)) : [];
  });
  return [...stacks, ...(serverId ? [] : hostedAuth(db, orgId).filter((h) => h.apps.length))];
}

// what an app of a project found on a server talks to: a stack in the project, or one its settings name
export function authOfParts(db: DB, orgId: string, serverId: string, inv: Inventory, parts: Part[]): SeenAuth[] {
  const env = parts.flatMap((p) => p.env ?? []), hosts = new Set(env.flatMap((e) => e.host ?? []));
  const stacks = inv.parts.filter((p) => p.product?.id === 'supabase' && (parts.includes(p) || p.hosts?.some((h) => hosts.has(h))));
  const refs = new Set(env.flatMap((e) => e.supabase ?? /^(?:db\.)?([a-z0-9]{20})\.supabase\.co$/.exec(e.host ?? '')?.[1] ?? []));
  return [...stacks.map((p) => stackAuth(serverId, inv, p)), ...hostedAuth(db, orgId).filter((h) => 'ref' in h.at && refs.has(h.at.ref))];
}
// what a Unit7 project's services are linked to
export function authOfServices(db: DB, orgId: string, serviceIds: string[]): SeenAuth[] {
  return all<{ source: string; target: string }>(db, 'SELECT source, target FROM links WHERE org_id = ?', orgId).flatMap((l) => {
    const to = json<{ kind?: string; serviceId?: string }>(l.target, {}), from = json<{ kind?: string; ref?: string; serverId?: string; part?: string }>(l.source, {});
    if (to.kind !== 'unit7' || !serviceIds.includes(to.serviceId ?? '')) return [];
    if (from.kind === 'supabase') return hostedAuth(db, orgId).filter((h) => 'ref' in h.at && h.at.ref === from.ref);
    const inv = from.kind === 'serverapp' ? lastXray(db, orgId, from.serverId!)?.data : undefined, p = inv?.parts.find((x) => x.id === from.part);
    return inv && p?.product?.id === 'supabase' ? [stackAuth(from.serverId!, inv, p)] : [];
  });
}

export const senderProblem = (s: SeenAuth) => (s.sender === 'built-in' ? { title: `${s.name}: sign-up emails stop after 2 an hour`, why: 'Supabase’s built-in sender is for testing: 2 emails an hour, and only to your own team. Real people won’t get their sign-up and password emails.' }
  : { title: `${s.name}: sign-up emails can’t leave`, why: 'Its mail settings point at no real server, so sign-up and password emails never arrive.' });
const hasLogin = (db: DB, orgId: string, domain: string) => !!get(db, 'SELECT 1 FROM secrets WHERE org_id = ? AND ref = ? AND retired_at IS NULL', orgId, makeRef('smtp', domain, 'password'));
// a button when one tool finishes it; setting up a sender takes a few steps, and login leaves something to paste, so those
// go to the person's AI, which can say so (a fix button only shows Done)
export function senderFix(db: DB, orgId: string, s: SeenAuth): Fix {
  return s.domain && hasLogin(db, orgId, s.domain) ? { tool: 'email.connect_app', input: { domain: s.domain, ...s.at }, label: 'Connect the sender' } : { ask: `Set up email sending${s.domain ? ` from ${s.domain}` : ''} for ${s.name}`, label: 'Set up with AI' };
}

export function mailChecks(db: DB, orgId: string, seen: SeenAuth[], own: string[], add: (key: string, label: string, ok: boolean, detail: string, fix?: Fix) => void) {
  if (!seen.length) return;
  const weak = seen.find((s) => s.sender !== 'own');
  add('sender', 'Sign-up emails get out', !weak, weak ? `${senderProblem(weak).title}. ${senderProblem(weak).why}` : 'They go through your own sender', weak && senderFix(db, orgId, weak));
  const sites = own.filter((h) => !seen.some((s) => s.api?.includes(h)));
  if (!sites.length) return;
  const apexes = sites.map((h) => apexOf(h)), off = seen.find((s) => !s.site || !apexes.includes(apexOf(s.site)));
  add('login', 'Login works on its domain', !off, off ? `${off.name} still sends people to ${off.site ?? 'a local address or its own API'}` : 'Sign-in sends people to its own domain', off && { ask: `Make login work on https://${sites[0]} for ${off.name}, and tell me what to change at Google or GitHub`, label: 'Fix with AI' });
}

// mail from its domains is signed, from the daily check (a domain with no mail has nothing to sign)
export function dkimCheck(rows: { a: string; value?: string | null }[], add: (key: string, label: string, ok: boolean, detail: string, fix?: Fix) => void) {
  const sends = rows.filter((r) => r.value && r.value !== 'silent'), bare = sends.find((r) => r.value === 'unsigned');
  if (sends.length) add('dkim', 'Email is signed', !bare, bare ? `${bare.a}: no DKIM key found, so mail from it can land in spam` : 'DKIM keys found', bare && { ask: `Check ${bare.a}’s email and help me sign it with DKIM`, label: 'Fix with AI' });
}

// said in a result, never done: only a person's or an AI's next step changes anything
export function loginHint(db: DB, orgId: string, hostname: string) {
  if (hostname.startsWith('*.') || isTestHost(hostname)) return undefined;
  const known = get(db, `SELECT 1 FROM accounts WHERE org_id = ? AND provider = 'supabase'`, orgId) || seenAuth(db, orgId).length;
  return known ? `If this app signs people in with Supabase, run auth.urls with url https://${hostname}, or login keeps pointing at the old address.` : undefined;
}
