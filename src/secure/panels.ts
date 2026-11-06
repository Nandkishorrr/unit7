// Control panels and what's really running. A panel on the open internet is a front door, so: is it public, is it behind, is there a
// known hole in this version? And the framework a live site reveals, including sites on Vercel or Netlify, checked against OSV.
import { z } from 'zod';
import { all } from '../db.ts';
import { defineTool, type Ctx } from '../tools/runtime.ts';
import { lastXray } from '../tools/xray.ts';
import { assertReachable } from '../netguard.ts';
import { ownHosts } from './stranger.ts';
import type { Finding } from '../tools/security.ts';
import type { ServerRow } from '../connectors/ssh.ts';
import type { Inventory } from '../discovery/xray.ts';

const GH = () => process.env.UNIT7_GITHUB_API ?? 'https://api.github.com', OSV = () => process.env.UNIT7_OSV_API ?? 'https://api.osv.dev';
const REPOS: Record<string, string> = { coolify: 'coollabsio/coolify', n8n: 'n8n-io/n8n', portainer: 'portainer/portainer', grafana: 'grafana/grafana', gitea: 'go-gitea/gitea', minio: 'minio/minio' };
// (pure) versions with a pre-release tail, like 4.0.0-beta.434
const parts = (v: string) => v.replace(/^v/, '').split(/[-+.]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
export function cmpVersion(a: string, b: string) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === undefined) return typeof q === 'number' ? -1 : 1; // 1.0 is later than 1.0-beta
    if (q === undefined) return typeof p === 'number' ? 1 : -1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p !== typeof q) return typeof p === 'number' ? 1 : -1;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}
export function inRange(version: string, range: string) {
  return range.split(',').map((c) => c.trim()).filter(Boolean).every((c) => {
    const m = /^(<=|>=|<|>|=)?\s*v?(\S+)$/.exec(c);
    if (!m) return false;
    const r = cmpVersion(version, m[2]!);
    return ({ '<': r < 0, '<=': r <= 0, '>': r > 0, '>=': r >= 0, '=': r === 0, '': r === 0 })[m[1] ?? '']!;
  });
}
interface Advisory { ghsa_id: string; severity: string; summary: string; vulnerabilities?: { vulnerable_version_range?: string; patched_versions?: string }[] }
export const advisoriesFor = (list: Advisory[], version: string) => list.filter((a) => a.vulnerabilities?.some((v) => v.vulnerable_version_range && inRange(version, v.vulnerable_version_range)));
const gh = async <T>(path: string) => { const r = await fetch(`${GH()}${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Unit7' }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined); return r?.ok ? await r.json() as T : undefined; };

export function panelFinding(s: Pick<ServerRow, 'id' | 'name'>, name: string, o: { version?: string; latest?: string; advisories: Advisory[]; open?: boolean }): Finding[] {
  const out: Finding[] = [], base = { area: 'server' as const, by: 'unit7' as const, serverId: s.id, about: { kind: 'server' as const, id: s.id, name: s.name } }, slug = name.toLowerCase().replace(/\W+/g, '-');
  const steps = { label: 'Ask Unit7 to help', ask: `${name} on ${s.name} needs updating. Tell me the safest way, with a backup first.`, manual: [`Update ${name}.`] };
  if (o.advisories.length) { const bad = o.advisories.some((a) => ['critical', 'high'].includes(a.severity)); out.push({ ...base, id: `panel:advisory:${s.id}:${slug}`, severity: bad && o.open ? 'critical' : bad ? 'high' : 'medium', title: `${name} ${o.version} has ${o.advisories.length} known security hole${o.advisories.length === 1 ? '' : 's'}`, detail: o.open ? 'It’s also open to the internet, so anyone can try these.' : 'It isn’t open to the internet, which helps.', evidence: o.advisories.slice(0, 3).map((a) => `${a.ghsa_id} (${a.severity})`).join(', '), fix: steps }); }
  else if (o.version && o.latest && cmpVersion(o.version, o.latest) < 0) out.push({ ...base, id: `panel:behind:${s.id}:${slug}`, severity: 'low', title: `${name} is behind`, detail: `It runs ${o.version}, and ${o.latest} is out. No known hole in your version.`, fix: steps });
  return out;
}
export async function panelCheck(ctx: Ctx, s: ServerRow, inv: Inventory) {
  const list: { name: string; repo: string; version?: string; open?: boolean }[] = [];
  if (inv.coolify?.version) list.push({ name: 'Coolify', repo: REPOS.coolify!, version: inv.coolify.version, open: !!inv.coolify.dashboard });
  for (const p of inv.parts) { const repo = REPOS[p.product?.id ?? '']; if (repo && p.version) list.push({ name: p.product!.name, repo, version: p.version, open: !!p.exposed || !!p.hosts?.length }); }
  const out: Finding[] = [];
  for (const x of list.slice(0, 8)) {
    const [latest, adv] = await Promise.all([gh<{ tag_name?: string }>(`/repos/${x.repo}/releases/latest`), gh<Advisory[]>(`/repos/${x.repo}/security-advisories?per_page=50`)]);
    out.push(...panelFinding(s, x.name, { ...(x.version && { version: x.version }), ...(latest?.tag_name && { latest: latest.tag_name }), advisories: advisoriesFor(adv ?? [], x.version ?? '0'), ...(x.open && { open: true }) }));
  }
  return { checked: list.map((x) => x.name), findings: out };
}
defineTool({
  name: 'security.panels', title: 'Is my panel safe?', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'For Coolify, n8n, Portainer, Grafana and similar on your servers: is it open to the internet, is it behind, and does its version have a published security advisory?',
  input: z.object({}),
  async run(ctx) {
    if (process.env.UNIT7_SKIP_NET_PROBE) return { checked: [], findings: [] };
    const out = { checked: [] as string[], findings: [] as Finding[] };
    for (const s of all<ServerRow>(ctx.db, `SELECT * FROM servers WHERE org_id = ? AND status = 'ready'`, ctx.orgId)) { const inv = lastXray(ctx.db, ctx.orgId, s.id)?.data; if (!inv) continue; const r = await panelCheck(ctx, s, inv); out.checked.push(...r.checked); out.findings.push(...r.findings); }
    return out;
  },
});

// (pure) what a site gives away about itself
export function versionsIn(headers: Record<string, string>, html: string, js = '') {
  const out: { name: string; ecosystem: string; version: string }[] = [];
  const next = /window\.next\s*=\s*\{\s*version:\s*"(\d+\.\d+\.\d+[\w.-]*)"/.exec(js) ?? /"next":\s*"(\d+\.\d+\.\d+)"/.exec(js) ?? /next\.js[/ @]v?(\d+\.\d+\.\d+)/i.exec(js);
  if (next) out.push({ name: 'next', ecosystem: 'npm', version: next[1]! });
  const wp = /<meta name="generator" content="WordPress (\d+\.\d+(?:\.\d+)?)"/i.exec(html);
  if (wp) out.push({ name: 'wordpress', ecosystem: 'WordPress', version: wp[1]! });
  const php = /PHP\/(\d+\.\d+\.\d+)/.exec(headers['x-powered-by'] ?? '');
  if (php) out.push({ name: 'php', ecosystem: 'Packagist', version: php[1]! });
  return out;
}
const osv = async (p: { name: string; ecosystem: string; version: string }) => { const r = await fetch(`${OSV()}/v1/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: p.version, package: { name: p.name, ecosystem: p.ecosystem } }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined); return r?.ok ? ((await r.json()) as { vulns?: { id: string; summary?: string }[] }).vulns ?? [] : undefined; };
defineTool({
  name: 'security.running', title: 'Holes in what’s really running', risk: 'read', action: 'read', timeoutMs: 120_000,
  description: 'Read the framework version a live site gives away (Next.js, WordPress), on any host, Vercel and Netlify included, and look it up in OSV for known holes. Only your own addresses.',
  input: z.object({}),
  async run(ctx) {
    if (process.env.UNIT7_SKIP_NET_PROBE) return { sites: [], findings: [] };
    const findings: Finding[] = [], sites: { host: string; found: string[] }[] = [];
    for (const host of ownHosts(ctx).slice(0, 12)) {
      try { await assertReachable(host); } catch { continue; }
      const r = await fetch(`https://${host}/`, { headers: { 'user-agent': 'Unit7 security check' }, signal: AbortSignal.timeout(8000) }).catch(() => undefined);
      if (!r) continue;
      const html = (await r.text().catch(() => '')).slice(0, 600_000), first = /<script[^>]+src=["']([^"']*(?:main|webpack|polyfills|framework)[^"']*)["']/i.exec(html)?.[1];
      const js = first ? await fetch(new URL(first, `https://${host}`).href, { signal: AbortSignal.timeout(8000) }).then((x) => x.text()).catch(() => '') : '';
      const found = versionsIn(Object.fromEntries(r.headers), html, js);
      sites.push({ host, found: found.map((f) => `${f.name} ${f.version}`) });
      for (const f of found) { const v = await osv(f); if (v?.length) findings.push({ id: `running:${host}:${f.name}`, severity: 'high', area: 'app', by: 'unit7', title: `${host} runs ${f.name} ${f.version}, which has ${v.length} known hole${v.length === 1 ? '' : 's'}`, detail: 'A stranger can read this version from your site, the same way Unit7 just did.', evidence: v.slice(0, 3).map((x) => x.id).join(', '), fix: { label: 'Give this to my AI', ask: `${host} runs ${f.name} ${f.version}, with known holes: ${v.slice(0, 3).map((x) => x.id).join(', ')}. Upgrade it, and run the tests.`, manual: [`Upgrade ${f.name}.`] } }); }
    }
    return { sites, findings };
  },
});
