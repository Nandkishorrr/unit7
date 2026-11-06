// The map canvas, worked out in one pass (pure, so test/map-canvas.test.ts runs it under Node). Left to right:
// domains in a frame per DNS host → apps in a frame per server or account, with a band per project → their data.
// A closed frame is one bubble with counts, and what's inside hands its lines to the bubble. Each column is ordered
// so lines run as flat as they can: data sits level with the apps that use it, domains level with what they open.
import type { Asset, Derived, Edge, Group } from './data.ts';

// sizes in canvas pixels (at 100%)
export const S = {
  DW: 284, G1: 150, AW: 216, G2: 112, DBW: 190,
  PILL: 38, PILL_GAP: 8, CL: 28, ROW: 50, NODE: 40, DB: 44,
  DNS_HEAD: 42, OWN_HEAD: 50, BAND_HEAD: 32, BUBBLE: 64, BAND_BUBBLE: 48, DNS_BUBBLE: 60, GAP: 24,
} as const;
export const AX = S.DW + S.G1;            // the apps column
export const DX = AX + S.AW + S.G2;       // the data column

export type FrameKind = 'dns' | 'owner' | 'band';
export interface Box { x: number; y: number; w: number; h: number }
export interface MNode extends Box {
  id: string; kind: 'domain' | 'cluster' | 'app' | 'db' | 'server'; col: 0 | 1 | 2; asset?: Asset; group?: Group;
  linked?: Asset[]; unused?: Asset[]; // a domain pill: its subdomains that reach something; a cluster: the ones that don't
}
export interface MFrame extends Box {
  id: string; kind: FrameKind; open: boolean; title: string; logo: string; sub?: string; asset?: Asset; parent?: string;
  counts: { domains: number; subs: number; apps: number; dbs: number; projects: number }; attention: number; members: string[];
}
export interface MEdge { id: string; from: string; to: string; status: Edge['status']; n: number; d: string; end: [number, number] }
export interface MapLayout {
  nodes: MNode[]; frames: MFrame[]; edges: MEdge[]; links: [string, string][]; w: number; h: number;
  box: Map<string, Box>; nodeOf: Map<string, string>; rep: (id: string) => string; within: Map<string, string[]>;
}

// --- who holds what: the frames, before any of it is placed -----------------------------------------------------------
export interface Band { id: string; name: string; logo: string; apps: Asset[]; dbs: Asset[]; system?: boolean }
export interface Owner { id: string; title: string; sub?: string; logo: string; asset?: Asset; bands: Band[]; apps: Asset[]; dbs: Asset[] }
export interface Hooks { projectOf?: (a: Asset) => { id: string; name: string } | undefined; title?: (provider: string) => string; owner?: (owner: string) => string | undefined; product?: (id: string) => string | undefined }

const APPISH = new Set(['app', 'service']);
export function ownersOf(v: Derived, show: Set<string>, h: Hooks = {}): Owner[] {
  const title = h.title ?? ((p: string) => p);
  const seen = (a: Asset) => show.has(a.id);
  const servers = v.assets.filter((a) => a.kind === 'server' && seen(a));
  const serverIds = new Set(servers.map((s) => s.id));
  const owners = new Map<string, Owner>();
  for (const s of servers) owners.set(s.id, { id: s.id, title: s.name, logo: s.provider, asset: s, bands: [], apps: [], dbs: [], sub: [s.provider, ...(s.also ?? []).map((x) => x.provider)].filter((x, i, l) => l.indexOf(x) === i).map(title).join(' · ') });
  const bandOf = new Map<string, Band>();
  for (const a of v.assets) {
    if (!seen(a) || !(APPISH.has(a.kind) || a.kind === 'database')) continue;
    const on = a.server && serverIds.has(a.server) ? a.server : v.out(a.id, 'runs_on').map((e) => e.target).find((t) => serverIds.has(t));
    let o: Owner;
    if (on) o = owners.get(on)!;
    else {
      const key = a.provider === 'unit7' ? 'acct:unit7' : `acct:${a.account ?? a.provider}`;
      o = owners.get(key) ?? { id: key, title: a.provider === 'unit7' ? 'Unit7' : title(a.provider), sub: a.account?.includes(' · ') ? a.account.slice(a.account.indexOf(' · ') + 3) : undefined, logo: a.provider, bands: [], apps: [], dbs: [] };
      owners.set(key, o);
    }
    // its project: what the server's X-ray grouped it into, the Unit7 project it was deployed from, or the product it's in
    const xp = a.project ? v.byId.get(a.project) : undefined;
    const up = !xp ? h.projectOf?.(a) : undefined;
    const gp = !xp && !up && a.group ? h.product?.(a.group) : undefined;
    const pid = xp ? xp.id : up ? `prj:${up.id}:${o.id}` : gp ? `grp:${a.group}:${o.id}` : undefined;
    if (pid) {
      let b = bandOf.get(pid);
      if (!b) { b = { id: pid, name: xp?.name ?? up?.name ?? gp!, logo: xp ? h.owner?.(xp.owner ?? '') ?? 'docker' : up ? 'unit7' : a.provider, apps: [], dbs: [], ...(xp?.system && { system: true }) }; bandOf.set(pid, b); o.bands.push(b); }
      (a.kind === 'database' ? b.dbs : b.apps).push(a);
    } else (a.kind === 'database' ? o.dbs : o.apps).push(a);
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  // a server's own machinery (Coolify itself) goes after the projects people made
  for (const o of owners.values()) { o.bands.sort((a, b) => +!!a.system - +!!b.system || byName(a, b)); o.apps.sort(byName); o.dbs.sort(byName); for (const b of o.bands) b.apps.sort(byName); }
  // servers first (Unit7's own on top), then accounts with apps, then accounts that only hold data
  const rank = (o: Owner) => (o.asset ? (o.asset.provider === 'unit7' ? 0 : 1) : appsIn(o) ? 2 : 3);
  return [...owners.values()].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title) || (a.sub ?? '').localeCompare(b.sub ?? ''));
}
export const appsIn = (o: Owner) => o.apps.length + o.bands.reduce((n, b) => n + b.apps.length, 0);
export const dbsIn = (o: Owner) => o.dbs.length + o.bands.reduce((n, b) => n + b.dbs.length, 0);

// --- placing it ---------------------------------------------------------------------------------------------------------
export interface LayoutIn extends Hooks {
  v: Derived; show: Set<string>;
  // whether a frame is open; size is how many things are in it
  open?: (id: string, kind: FrameKind, size: number) => boolean;
}

export function layoutMap(i: LayoutIn): MapLayout {
  const { v, show } = i;
  const isOpen = i.open ?? (() => true);
  const title = i.title ?? ((p: string) => p);
  const nodes: MNode[] = [], frames: MFrame[] = [];
  const box = new Map<string, Box>();
  const nodeOf = new Map<string, string>(); // asset id → the node that stands for it
  const repOf = new Map<string, string>();  // node id → the closed frame it's folded into
  const within = new Map<string, string[]>(); // node id → the frames around it, outermost first
  const add = (n: MNode, chain: string[]) => { nodes.push(n); box.set(n.id, n); within.set(n.id, chain); const shut = chain.find((f) => !frames.find((x) => x.id === f)?.open); if (shut) repOf.set(n.id, shut); };
  const consumers = (db: Asset) => [...v.inc(db.id, 'env'), ...v.inc(db.id, 'uses')].map((e) => e.source);

  // 1. the right side: apps lane and data lane, frames stacked down each
  const owners = ownersOf(v, show, i);
  let yA = 0;
  const reserved: [number, number][] = []; // the data lane's busy stretches (open frames that hold data)
  const pending: { o: Owner; f: MFrame }[] = [];
  const counts = (apps: number, dbs: number, projects = 0) => ({ domains: 0, subs: 0, apps, dbs, projects });
  const attention = (xs: Asset[]) => xs.filter(v.attention).length;

  // rows inside a container: apps one under another; each database level with the apps that use it
  const rows = (apps: Asset[], dbs: Asset[], top: number, chain: string[]) => {
    const row = new Map(apps.map((a, n) => [a.id, n]));
    apps.forEach((a, n) => add({ id: a.id, kind: 'app', col: 1, asset: a, x: AX, y: top + n * S.ROW, w: S.AW, h: S.NODE }, chain));
    const bary = (d: Asset) => { const r = consumers(d).map((c) => row.get(c)).filter((x): x is number => x !== undefined); return r.length ? r.reduce((p, q) => p + q, 0) / r.length : Infinity; };
    let last = -1;
    for (const d of [...dbs].sort((p, q) => bary(p) - bary(q) || p.name.localeCompare(q.name))) {
      const want = bary(d);
      const r = Math.max(last + 1, Number.isFinite(want) ? Math.round(want) : last + 1);
      add({ id: d.id, kind: 'db', col: 2, asset: d, x: DX, y: top + r * S.ROW - (S.DB - S.NODE) / 2, w: S.DBW, h: S.DB }, chain);
      last = r;
    }
    return Math.max(apps.length, last + 1);
  };

  for (const o of owners) {
    const nApps = appsIn(o), nDbs = dbsIn(o);
    const all = [...o.apps, ...o.dbs, ...o.bands.flatMap((b) => [...b.apps, ...b.dbs])];
    const f: MFrame = { id: o.id, kind: 'owner', open: isOpen(o.id, 'owner', nApps + nDbs), title: o.title, sub: o.sub, logo: o.logo, asset: o.asset, x: 0, y: 0, w: 0, h: 0,
      counts: counts(nApps, nDbs, o.bands.length), attention: attention(o.asset ? [o.asset, ...all] : all), members: all.map((a) => a.id) };
    frames.push(f);
    if (!nApps && nDbs) { pending.push({ o, f }); continue; } // data only: placed in the data lane, level with its users
    const wide = f.open && nDbs > 0;
    f.x = AX - 24; f.y = yA; f.w = wide ? DX + S.DBW + 24 - f.x : S.AW + 48;
    if (o.asset) add({ id: o.asset.id, kind: 'server', col: 1, asset: o.asset, x: f.x, y: f.y, w: f.w, h: S.OWN_HEAD }, []);
    if (!f.open) { f.h = S.BUBBLE; box.set(f.id, f); for (const a of all) add(placeholder(a), [o.id]); yA += f.h + S.GAP; continue; }
    let cy = f.y + S.OWN_HEAD;
    for (const b of o.bands) {
      const bf: MFrame = { id: b.id, kind: 'band', parent: o.id, open: isOpen(b.id, 'band', b.apps.length + b.dbs.length), title: b.name, logo: b.logo, x: AX - 12, y: cy, w: 0, h: 0,
        counts: counts(b.apps.length, b.dbs.length), attention: attention([...b.apps, ...b.dbs]), members: [...b.apps, ...b.dbs].map((a) => a.id), asset: v.byId.get(b.id) };
      frames.push(bf);
      if (!bf.open) {
        bf.w = S.AW + 24; bf.h = S.BAND_BUBBLE; box.set(bf.id, bf);
        for (const a of [...b.apps, ...b.dbs]) add(placeholder(a), [o.id, b.id]);
      } else {
        bf.w = (b.dbs.length ? DX + S.DBW + 12 : AX + S.AW + 12) - bf.x;
        const n = rows(b.apps, b.dbs, cy + S.BAND_HEAD, [o.id, b.id]);
        bf.h = S.BAND_HEAD + Math.max(1, n) * S.ROW;
      }
      cy += bf.h + 10;
    }
    const n = rows(o.apps, o.dbs, cy + 2, [o.id]);
    cy += n * S.ROW + (n ? 2 : 0);
    if (!nApps && !nDbs) cy += 30; // a server with nothing found on it yet: room for a line saying so
    f.h = Math.max(S.OWN_HEAD + 30, cy - f.y + 4);
    if (o.asset) box.set(o.asset.id, { x: f.x, y: f.y, w: f.w, h: S.OWN_HEAD });
    if (wide) reserved.push([f.y, f.y + f.h]);
    yA += f.h + S.GAP;
  }

  // 2. frames that only hold data, each level with the apps that use it (free stretches of the data lane only)
  const centre = (id: string) => { const b = box.get(repOf.get(id) ?? id); return b && b.w ? b.y + Math.min(b.h, 64) / 2 : undefined; };
  const want = (o: Owner) => {
    const ys = [...o.dbs, ...o.bands.flatMap((b) => b.dbs)].flatMap((d) => consumers(d).map(centre)).filter((y): y is number => y !== undefined);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
  };
  const slot = (y0: number, h: number) => {
    let y = Math.max(0, y0);
    for (let moved = true; moved;) { moved = false; for (const [a, b] of reserved) if (y < b + S.GAP && y + h + S.GAP > a) { y = b + S.GAP; moved = true; } }
    reserved.push([y, y + h]);
    return y;
  };
  let tail = yA;
  for (const { o, f } of pending.map((p) => ({ ...p, k: want(p.o) })).sort((a, b) => a.k - b.k)) {
    const dbs = [...o.dbs, ...o.bands.flatMap((b) => b.dbs)];
    // its databases in the order of whoever uses them
    const order = dbs.map((d) => { const ys = consumers(d).map(centre).filter((y): y is number => y !== undefined); return { d, y: ys.length ? Math.min(...ys) : Infinity }; }).sort((a, b) => a.y - b.y || a.d.name.localeCompare(b.d.name));
    const h = f.open ? S.OWN_HEAD + order.length * S.ROW : S.BUBBLE;
    const k = want(o);
    const y = slot(Number.isFinite(k) ? k - h / 2 : tail, h);
    tail = Math.max(tail, y + h + S.GAP);
    Object.assign(f, { x: DX - 24, y, w: S.DBW + 48, h });
    if (!f.open) { for (const d of dbs) add(placeholder(d), [o.id]); continue; }
    order.forEach(({ d }, n) => add({ id: d.id, kind: 'db', col: 2, asset: d, x: DX, y: y + S.OWN_HEAD + n * S.ROW - (S.DB - S.NODE) / 2, w: S.DBW, h: S.DB }, [o.id]));
  }
  for (const f of frames) if (!f.open) box.set(f.id, f);

  // 3. domains: a pill per root (its subdomains that reach something ride on it), the unused ones in a cluster under it
  const roots: { g: Group; id: string; linked: Asset[]; unused: Asset[]; targets: string[]; dns: string }[] = [];
  for (const g of v.groups) {
    const members = [g.asset, ...g.subs].filter((d): d is Asset => !!d && show.has(d.id));
    if (!members.length) continue;
    const subs = g.subs.filter((d) => show.has(d.id));
    const reach = (d: Asset) => v.out(d.id).filter((e) => e.kind === 'domain' || e.kind === 'dns');
    const linked = subs.filter((d) => reach(d).length), unused = subs.filter((d) => !reach(d).length);
    const targets = [...new Set([g.asset, ...linked].flatMap((d) => (d && show.has(d.id) ? reach(d).map((e) => e.target) : [])))].filter((t) => box.has(t) || repOf.has(t));
    roots.push({ g, id: g.asset?.id ?? `root:${g.root}`, linked, unused, targets, dns: g.dns ?? (/(^|\.)(sslip\.io|nip\.io)$/.test(g.root) ? 'test' : 'elsewhere') });
  }
  const level = (r: (typeof roots)[number]) => { const ys = r.targets.map(centre).filter((y): y is number => y !== undefined); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity; };
  const hosts = new Map<string, (typeof roots)[number][]>();
  for (const r of roots) hosts.set(r.dns, [...(hosts.get(r.dns) ?? []), r]);
  const dnsFrames = [...hosts.entries()].map(([dns, rs]) => {
    const sorted = rs.map((r) => ({ r, k: level(r) })).sort((a, b) => a.k - b.k || a.r.g.root.localeCompare(b.r.g.root));
    const ks = sorted.map((x) => x.k).filter(Number.isFinite);
    return { dns, rs: sorted.map((x) => x.r), k: ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : Infinity };
  }).sort((a, b) => a.k - b.k || a.dns.localeCompare(b.dns));
  let yD = 0;
  for (const { dns, rs } of dnsFrames) {
    const id = `dns:${dns}`;
    const subs = rs.reduce((n, r) => n + r.linked.length + r.unused.length, 0);
    const f: MFrame = { id, kind: 'dns', open: isOpen(id, 'dns', rs.length), title: dns === 'elsewhere' ? 'DNS elsewhere' : dns === 'test' ? 'Test addresses' : title(dns), logo: dns, x: 0, y: 0, w: S.DW, h: 0,
      counts: { domains: rs.length, subs, apps: 0, dbs: 0, projects: 0 }, attention: rs.filter((r) => v.groupAttention(r.g)).length, members: rs.flatMap((r) => [r.id, ...(r.unused.length ? [`unused:${r.g.root}`] : [])]) };
    frames.push(f);
    const h = f.open ? S.DNS_HEAD + rs.reduce((n, r) => n + S.PILL + S.PILL_GAP + (r.unused.length ? S.CL + 8 : 0), 0) + 4 : S.DNS_BUBBLE;
    // level with what its domains open, never over the frame above
    const k = level({ targets: rs.flatMap((r) => r.targets) } as (typeof roots)[number]);
    f.y = Math.max(yD, Number.isFinite(k) ? k - h / 2 : yD); f.h = h;
    yD = f.y + h + 20;
    if (!f.open) box.set(id, f);
    let cy = f.y + S.DNS_HEAD;
    for (const r of rs) {
      const chain = [id];
      add({ id: r.id, kind: 'domain', col: 0, asset: r.g.asset, group: r.g, linked: r.linked, x: 12, y: cy, w: S.DW - 24, h: S.PILL }, chain);
      for (const d of [r.g.asset, ...r.linked]) if (d) nodeOf.set(d.id, r.id);
      cy += S.PILL + S.PILL_GAP;
      if (r.unused.length) {
        const cid = `unused:${r.g.root}`;
        add({ id: cid, kind: 'cluster', col: 0, group: r.g, unused: r.unused, x: 30, y: cy - 2, w: 156, h: S.CL }, chain);
        for (const d of r.unused) nodeOf.set(d.id, cid);
        cy += S.CL + 8;
      }
    }
  }
  // a placeholder holds a folded thing's place in the lookup tables, it isn't drawn
  for (const n of nodes) if (n.asset && !nodeOf.has(n.asset.id)) nodeOf.set(n.asset.id, n.id);

  // 4. lines between whatever stands for each end, the same pair drawn once
  const rep = (id: string) => repOf.get(id) ?? id;
  const drawn = new Map<string, { from: string; to: string; status: Edge['status']; n: number }>();
  const links: [string, string][] = [];
  const worse = (a: Edge['status'], b: Edge['status']) => (a === 'misconfigured' || b === 'misconfigured' ? 'misconfigured' : a === 'unknown' && b === 'unknown' ? 'unknown' : 'ok');
  for (const e of v.edges) {
    if (!show.has(e.source) || !show.has(e.target)) continue;
    const s = nodeOf.get(e.source), t = nodeOf.get(e.target);
    if (!s || !t) continue;
    const a = rep(s), b = rep(t);
    if (a === b) continue;
    links.push([a, b]);
    if (e.kind === 'runs_on') continue; // drawn as the frame around it
    const k = `${a}|${b}`, x = drawn.get(k);
    drawn.set(k, x ? { ...x, n: x.n + 1, status: worse(x.status, e.status) } : { from: a, to: b, status: e.status, n: 1 });
  }
  const edges: MEdge[] = [];
  for (const [id, e] of drawn) {
    const s = box.get(e.from), t = box.get(e.to);
    if (!s || !t) continue;
    const sx = s.x + s.w, sy = s.y + Math.min(s.h, 64) / 2, tx = t.x, ty = t.y + Math.min(t.h, 64) / 2;
    let d: string, end: [number, number];
    if (tx > sx + 8) { const dx = Math.max(36, (tx - sx) * 0.5); d = `M${sx} ${sy}C${sx + dx} ${sy} ${tx - dx} ${ty} ${tx} ${ty}`; end = [tx, ty]; }
    else { const rx = t.x + t.w, x = Math.max(sx, rx) + 48; d = `M${sx} ${sy}C${x} ${sy} ${x} ${ty} ${rx} ${ty}`; end = [rx, ty]; } // same column: out the right side and back in
    edges.push({ id, ...e, d, end });
  }
  const placed = [...nodes.filter((n) => !repOf.has(n.id) && n.w), ...frames.filter((f) => !f.parent || frames.find((p) => p.id === f.parent)?.open)];
  return {
    nodes: nodes.filter((n) => n.w > 0 && !repOf.has(n.id)), frames: frames.filter((f) => f.w > 0 && (!f.parent || frames.find((p) => p.id === f.parent)?.open)),
    edges, links, box, nodeOf, rep, within,
    w: Math.max(S.DW, ...placed.map((b) => b.x + b.w)), h: Math.max(0, ...placed.map((b) => b.y + b.h)),
  };
}

// a thing folded into a closed frame: in the tables (so its lines and search find the frame), never drawn
const placeholder = (a: Asset): MNode => ({ id: a.id, kind: a.kind === 'database' ? 'db' : 'app', col: a.kind === 'database' ? 2 : 1, asset: a, x: 0, y: 0, w: 0, h: 0 });
