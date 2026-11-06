// The map: every account you've connected, and inside them every domain, app, server and database, and what points
// at what, on one screen. Map (the canvas, the default), Overview (everything as a normal page) or List. Search flies to a thing; filters show only what
// needs attention, or one provider's things, each with its whole path. What's open lives in the address, so reload
// and back keep your place. Warden syncs on the schedule picked here (every 6 hours unless changed).
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, Archive, EyeOff, LayoutGrid, List, Map as MapIcon, Plus, RefreshCw, Search, X } from 'lucide-react';
import { onLive, runTool, useApi } from '../lib/api';
import { match, usePath, useQuery } from '../lib/router';
import { A, Button, ChipSelect, Empty, HoverCard, Illustration, Skeleton, Tabs, act, cx, timeAgo } from '../ui';
import { BrandLogo, providerName } from '../brand/BrandLogo';
import { AUTO_SYNC, derive, logoOf, nextSyncWords, type Asset, type Derived, type Managed, type MapData } from './map/data';
import { Ctx, plural, type ConnectReq, type MapCtx, type SvcInfo } from './map/parts';
import { Canvas, type CanvasHandle } from './map/Canvas';
import { ListView } from './map/List';
import { Overview, scrollInside } from './map/Overview';
import { ConnectDialog } from './map/Connect';
import { Inside } from './map/Inside';
import type { Me } from '../App';
import { ClientFilter, useClientFilter } from './organize';
import { needs as needsLook } from './map/sections';

// --- the address is the state: filters replace, opening something pushes (so back closes it) -----
function setParams(patch: Record<string, string | null>, push = false) {
  const u = new URL(location.href);
  for (const [k, val] of Object.entries(patch)) if (val) u.searchParams.set(k, val); else u.searchParams.delete(k);
  const depth = ((history.state as { mapDepth?: number } | null)?.mapDepth ?? 0) + (push ? 1 : 0);
  history[push ? 'pushState' : 'replaceState']({ ...(history.state as object | null), mapDepth: depth }, '', u.pathname + u.search);
  dispatchEvent(new PopStateEvent('popstate'));
}
function closeInside() {
  const depth = (history.state as { mapDepth?: number } | null)?.mapDepth ?? 0;
  if (depth > 0) history.go(-depth); else setParams({ open: null });
}
// on a phone the Overview is the default: its sections stack in one column and keep each thing's status and where it
// points, which the List hides at that width (the canvas is there too, with touch pan and pinch)
const phoneQuery = '(max-width: 767px)';
const usePhone = () => useSyncExternalStore((cb) => { const mq = matchMedia(phoneQuery); mq.addEventListener('change', cb); return () => mq.removeEventListener('change', cb); }, () => matchMedia(phoneQuery).matches);

const STACK: Record<string, string> = { next: 'nextjs', nextjs: 'nextjs', node: 'node', postgres: 'postgres', mysql: 'mysql', mariadb: 'mysql', redis: 'redis' };
const POPULAR = ['vercel', 'hostinger', 'cloudflare', 'supabase', 'netlify', 'render', 'railway', 'neon', 'digitalocean', 'godaddy'];
const TOP = new Set(['app', 'service', 'database', 'server', 'domain']);
type Graph = { servers: { id: string; name: string }[]; projects: { id: string; name: string; environments: { name: string; services: { id: string; kind: string; config?: { detection?: { stack?: string } }; deployment?: { number: number; status: string; finished_at: string | null; started_at: string | null } | null }[] }[] }[] };

export function MapPage({ me }: { me: Me }) {
  const path = usePath();
  const q = useQuery();
  const phone = usePhone();
  const routeAcct = match('/map/account/:id', path)?.id;
  const home = phone ? 'overview' : 'map';
  const view = (['map', 'list', 'overview'] as const).find((x) => x === q.get('view')) ?? home;
  const attention = q.get('show') === 'attention';
  const provider = q.get('p');
  const acctId = routeAcct ?? q.get('acct');
  const withArchived = q.get('archived') === '1';
  const withHidden = q.get('hidden') === '1'; // what a person hid ("This is fine"), shown again
  const openId = q.get('open');
  const human = me.role !== 'agent';
  const admin = me.role === 'owner' || me.role === 'admin';

  const [m, setM] = useState<MapData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [managed, setManaged] = useState<Managed[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [req, setReq] = useState<ConnectReq | null>(null);
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const canvas = useRef<CanvasHandle>(null);
  const clients = useClientFilter();
  // the lines draw in once, the first time the canvas appears; a new filter just shows its map
  const intro = useRef(true);
  useEffect(() => { if (m) { const t = setTimeout(() => (intro.current = false), 50); return () => clearTimeout(t); } }, [m]);
  const graph = useApi<Graph>('/api/graph', { live: false });

  const load = useCallback(async () => {
    try {
      // archived things come too, marked, so "Show archived (N)" can count them
      const [r, d] = await Promise.all([runTool('map.get', { includeArchived: true, includeHidden: withHidden }), runTool('domain.list').catch(() => null)]);
      if (r.status === 'ok') { setM(r.output); setErr(null); if (r.output.running) setProgress((p) => p ?? 'Syncing…'); }
      else setErr(r.status === 'error' ? r.error.message : 'The map isn’t available to you.');
      if (d?.status === 'ok') setManaged(d.output);
    } catch (e) { setErr((e as Error).message); }
  }, [withHidden]);
  useEffect(() => { void load(); }, [load]);
  // "next in 5h 48m" counts down while the page is open
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { const t = setInterval(tick, 60_000); return () => clearInterval(t); }, []);
  useEffect(() => onLive((e) => {
    if (e.type === 'sync.done') { setProgress(null); void load(); }
    if (e.type === 'tool.progress' && e.data?.tool === 'sync.run') setProgress(e.message);
    if (e.type.startsWith('domain.') || e.type.startsWith('asset.')) void load();
    // a check that ran anywhere (Check again, or after a fix), and something hidden or brought back
    if (e.type === 'map.rechecked' || (e.type === 'action.completed' && /^(snooze|home)\.(set|clear|dismiss)$/.test(String(e.data?.tool)))) void load();
  }), [load]);
  const sync = async () => { setProgress('Starting…'); if (!(await act('sync.start', {}))) setProgress(null); };
  const setEvery = async (every: string) => {
    const words = AUTO_SYNC.find((o) => o.value === every)?.label.toLowerCase();
    if (await act('sync.schedule', { every }, { success: every === 'off' ? 'Auto-sync is off' : `The map syncs ${words} by itself` })) void load();
  };

  const v = useMemo(() => (m ? derive(m) : null), [m]);
  const svcs = useMemo(() => {
    const out = new Map<string, SvcInfo>();
    for (const p of graph.data?.projects ?? []) for (const e of p.environments) for (const s of e.services) {
      out.set(s.id, { href: `/projects/${p.id}/services/${s.id}`, project: p.name, projectId: p.id, env: e.name, stack: STACK[s.config?.detection?.stack ?? s.kind],
        deploy: s.deployment ? { at: s.deployment.finished_at ?? s.deployment.started_at, status: s.deployment.status, number: s.deployment.number } : undefined });
    }
    return out;
  }, [graph.data]);
  // three apps called "web": "acme · web", "acme · web (staging)"; elsewhere a shared name gets its address
  const label = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of v?.assets ?? []) if (a.kind === 'app') seen.set(a.name, (seen.get(a.name) ?? 0) + 1);
    return (a: Asset) => {
      const sv = a.end?.kind === 'unit7' ? svcs.get(a.end.serviceId!) : undefined;
      if (sv) { const env = sv.env.toLowerCase(); return `${sv.project} · ${a.name}${/^prod/.test(env) || a.name.toLowerCase().includes(env) ? '' : ` (${env})`}`; }
      if (a.kind === 'app' && (seen.get(a.name) ?? 0) > 1 && a.url) return `${a.name} · ${a.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}`;
      return a.name;
    };
  }, [v, svcs]);
  const ctx = useMemo<MapCtx | null>(() => {
    if (!v) return null;
    return {
      v, human, reload: load, label, connect: setReq, product: (id) => m?.groups?.find((g) => g.id === id)?.name,
      open: (id) => setParams({ open: id }, true),
      managed: new Map(managed.map((d) => [d.hostname, d])),
      service: (a) => (a.end?.kind === 'unit7' ? svcs.get(a.end.serviceId!) : undefined),
      serverHref: (a) => { const id = a.kind === 'server' && (a.provider === 'unit7' || a.also?.some((x) => x.provider === 'unit7')) ? graph.data?.servers.find((s) => s.name === a.name)?.id : undefined; return id && `/servers/${id}`; },
    };
  }, [v, m, human, load, managed, graph.data, svcs, label]);

  const acc = v?.accounts.find((a) => a.id === acctId);
  const archived = v ? v.assets.filter((a) => a.archived && TOP.has(a.kind)).length : 0;
  // counted like the Overview: a domain with its subdomains once, a database open to the internet too
  const needs = v ? v.groups.filter((g) => [g.asset, ...g.subs].some((d) => d && !d.archived && v.attention(d))).length
    + v.assets.filter((a) => TOP.has(a.kind) && a.kind !== 'domain' && !a.archived && needsLook(v, a)).length : 0;
  // what the map shows: everything, or only what matches with its whole path (so a match is never an island)
  const show = useMemo(() => {
    if (!v) return new Set<string>();
    const base = v.assets.filter((a) => withArchived || !a.archived);
    const chosen = attention ? base.filter((a) => TOP.has(a.kind) && needsLook(v, a))
      : provider ? base.filter((a) => a.provider === provider || a.dns === provider || a.also?.some((x) => x.provider === provider) || (a.kind === 'domain' && v.groupOf.get(a.id)?.dns === provider))
        : acc ? base.filter((a) => v.inAccount(acc, a)) : null;
    // one client's things (or your own), each with its whole path like any other filter
    const pick = clients.active ? (chosen ?? base).filter((a) => clients.has(a.id)) : chosen;
    if (!pick) return new Set(base.map((a) => a.id));
    const ok = new Set(base.map((a) => a.id)), set = new Set(pick.map((a) => a.id));
    for (const dir of ['down', 'up'] as const) {
      const queue = [...set];
      while (queue.length) {
        const n = queue.shift()!;
        for (const e of v.edges) {
          if (dir === 'up' && e.kind === 'runs_on') continue; // a server's path isn't everything on it
          const [from, to] = dir === 'down' ? [e.source, e.target] : [e.target, e.source];
          if (from === n && ok.has(to) && !set.has(to)) { set.add(to); queue.push(to); }
        }
      }
    }
    return set;
  }, [v, attention, provider, acc, withArchived, clients.picked, clients.clients]);

  const pick = (a: Asset) => {
    setFocus(a.id);
    if (view === 'map') canvas.current?.fly(a.id);
    else if (view === 'list') requestAnimationFrame(() => scrollInside(document.getElementById(`row-${a.id}`), 'center'));
    // the Overview opens the section it's in and brings it into view itself
  };

  if (err && !m) return <><MapHeader /><Empty icon={<AlertTriangle size={26} />} title="The map didn’t load" body={err} action={<Button variant="dark" onClick={() => void load()}>Try again</Button>} /></>;
  if (!v || !ctx) return <MapSkeleton />;

  const outside = v.accounts.filter((a) => a.provider !== 'unit7');
  const next = m!.syncedAt ? nextSyncWords(m!.autoSync) : '';
  const syncLine = progress ?? (m!.syncedAt ? `Synced ${timeAgo(m!.syncedAt)}${next ? ` · ${next}` : ''}` : 'Not synced yet');
  const step = progress && /^(\d+)\/(\d+)/.exec(progress);
  const empty = !m!.syncedAt && !progress && !v.assets.length;

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 pt-1 lg:pt-2">
        <MapHeader acct={routeAcct ? acc?.name ?? routeAcct : undefined}>
          <span aria-live="polite" className="hidden min-w-0 flex-col items-end text-[12.5px] text-muted sm:flex">
            <span className="max-w-[240px] truncate">{syncLine}</span>
            {step && <span className="mt-1 h-1 w-28 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full bg-blue transition-[width] duration-500" style={{ width: `${(+step[1]! / +step[2]!) * 100}%` }} /></span>}
          </span>
          {admin && m!.autoSync && <span className="hidden lg:block"><ChipSelect label="Auto-sync" value={m!.autoSync.every} onChange={(x) => void setEvery(x)} options={AUTO_SYNC.map((o) => ({ value: o.value, label: `Auto-sync: ${o.label.toLowerCase()}` }))} /></span>}
          <ClientFilter />
          <Button variant="dark" size="sm" loading={!!progress} icon={<RefreshCw size={14} />} onClick={() => void sync()}><span className="max-sm:sr-only">{progress ? 'Syncing' : 'Sync now'}</span></Button>
          <Tabs value={view} onChange={(x) => setParams({ view: x === home ? null : x })}
            tabs={[{ value: 'map', label: <><MapIcon size={15} /><span className="sr-only sm:not-sr-only">Map</span></> }, { value: 'overview', label: <><LayoutGrid size={15} /><span className="sr-only sm:not-sr-only">Overview</span></> },
              { value: 'list', label: <><List size={15} /><span className="sr-only sm:not-sr-only">List</span></> }]} />
        </MapHeader>

        {empty ? (
          outside.length ? <Empty art={<Illustration name="map" size={120} />} title="Nothing synced yet" body="Sync reads every account you’ve connected and draws what’s connected to what." action={<Button variant="primary" onClick={() => void sync()}>Sync now</Button>} />
            : <FirstRun onSync={() => void sync()} />
        ) : (
          <div className={cx('relative min-h-0 flex-1 rounded-[28px] border border-line bg-surface shadow-soft', view === 'map' ? 'overflow-hidden' : 'flex flex-col overflow-hidden')}>
            <Toolbar v={v} floating={view === 'map'} accounts={view !== 'overview'} search={search} setSearch={setSearch} onPick={pick} attention={attention} needs={needs} provider={provider} archived={archived} withArchived={withArchived} hidden={m!.hidden ?? 0} withHidden={withHidden}
              acct={acc && !routeAcct ? `${providerName(acc.provider)}${acc.name.includes(' · ') ? ` · ${acc.name.slice(acc.name.indexOf(' · ') + 3)}` : ''}` : undefined} />
            {view === 'map' ? <Canvas ref={canvas} show={show} intro={intro.current} key={`${attention}|${provider}|${acctId}|${withArchived}|${withHidden}|${clients.picked}`} />
              : <div className={cx('min-h-0 flex-1 overflow-y-auto overscroll-contain max-lg:pb-14', view === 'list' && 'pt-1')}>{view === 'overview'
                ? <Overview show={show} q={search} focus={focus} filtered={attention || !!provider || !!acc || clients.active} provider={provider} onProvider={(p) => setParams({ p, show: null, acct: null })} />
                : <ListView show={show} q={search} focus={focus} />}</div>}
          </div>
        )}
      </div>
      <Inside id={openId} onClose={closeInside} />
      <ConnectDialog req={req} onChange={setReq} onClose={() => setReq(null)} />
    </Ctx.Provider>
  );
}

function MapHeader({ acct, children }: { acct?: string; children?: React.ReactNode }) {
  return (
    <div className="relative z-20 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="text-[26px] font-semibold leading-none tracking-[-0.035em] md:text-[30px]">Map</h1>
      {acct && <A href="/map" className="inline-flex h-8 items-center gap-1.5 rounded-full bg-raised pl-3 pr-2 text-[12.5px] font-medium text-ink-2 hover:text-ink">{acct}<X size={13} /></A>}
      <span className="ml-auto flex min-w-0 items-center gap-2">{children}</span>
    </div>
  );
}

// --- search, filters and the accounts strip: one slim bar ---------------------------------------------------------------
function Toolbar({ v, floating, accounts = true, search, setSearch, onPick, attention, needs, provider, archived, withArchived, hidden, withHidden, acct }: {
  v: Derived; floating: boolean; accounts?: boolean; search: string; setSearch: (s: string) => void; onPick: (a: Asset) => void; attention: boolean; needs: number; provider: string | null; archived: number; withArchived: boolean; hidden: number; withHidden: boolean; acct?: string;
}) {
  const filter = attention ? 'attention' : 'all';
  return (
    <div data-bar="" data-toolbar="" className={cx('flex flex-wrap items-center gap-2', floating ? 'pointer-events-none absolute inset-x-3 top-3 z-20 [&>*]:pointer-events-auto' : 'border-b border-line px-3 py-3 sm:px-4')}>
      <SearchBox v={v} value={search} onChange={setSearch} onPick={onPick} jump={floating} />
      <div role="radiogroup" aria-label="Show" className="flex h-10 items-center rounded-full border border-line bg-surface/90 p-1 shadow-soft backdrop-blur">
        {([['all', 'All'], ['attention', 'Needs attention']] as const).map(([k, t]) => (
          <button key={k} type="button" role="radio" aria-checked={filter === k} onClick={() => setParams({ show: k === 'all' ? null : k, p: null, acct: null })}
            className={cx('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition', filter === k && !provider && !acct ? 'bg-ink text-bg' : 'text-ink-2 hover:text-ink')}>
            {k === 'attention' && needs > 0 && <span className={cx('size-1.5 rounded-full', filter === k ? 'bg-[#fbbf24]' : 'bg-[#f59e0b]')} />}{t}{k === 'attention' && needs > 0 && <span className="tabular opacity-70">{needs}</span>}
          </button>
        ))}
      </div>
      {acct && <button type="button" onClick={() => setParams({ acct: null })} className="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink pl-3.5 pr-2.5 text-[12.5px] font-medium text-bg">{acct}<X size={13} /></button>}
      {/* the Overview has its own Accounts section, with each one's pop-up; a provider picked there shows here, to clear */}
      {accounts ? <Accounts v={v} active={provider} />
        : provider && <button type="button" aria-label={`Show everything, not only ${providerName(provider)}’s things`} onClick={() => setParams({ p: null })} className="inline-flex h-10 items-center gap-2 rounded-full bg-ink pl-2 pr-3 text-[12.5px] font-medium text-bg"><span className="grid size-6 place-items-center rounded-full bg-white"><BrandLogo id={provider} size={13} /></span>{providerName(provider)}<X size={13} /></button>}
      {/* what a person hid ("This is fine"), back on the map until they turn it off again */}
      {(hidden > 0 || withHidden) && (
        <button type="button" aria-pressed={withHidden} onClick={() => setParams({ hidden: withHidden ? null : '1' })} title={withHidden ? 'Hide them again' : 'Show the problems you hid, with Bring back'}
          className={cx('ml-auto inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-medium shadow-soft transition', withHidden ? 'border-ink bg-ink text-bg' : 'border-line bg-surface/90 text-ink-2 backdrop-blur hover:text-ink')}>
          <EyeOff size={14} />{withHidden ? 'Hide them again' : `Hidden (${hidden})`}
        </button>
      )}
      {archived > 0 && (
        <button type="button" aria-pressed={withArchived} onClick={() => setParams({ archived: withArchived ? null : '1' })}
          className={cx(!(hidden > 0 || withHidden) && 'ml-auto', 'inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-medium shadow-soft transition', withArchived ? 'border-ink bg-ink text-bg' : 'border-line bg-surface/90 text-ink-2 backdrop-blur hover:text-ink')}>
          <Archive size={14} />{withArchived ? 'Hide archived' : `Show archived (${archived})`}
        </button>
      )}
    </div>
  );
}

// one circle per provider, with how many accounts it has; tap to show only that provider's things
function Accounts({ v, active }: { v: Derived; active: string | null }) {
  const by = new Map<string, { n: number; bad: number }>();
  for (const a of v.accounts) if (a.provider !== 'unit7') { const x = by.get(a.provider) ?? { n: 0, bad: 0 }; by.set(a.provider, { n: x.n + 1, bad: x.bad + (a.ok ? 0 : 1) }); }
  if (!by.size) return null;
  return (
    <div role="group" aria-label="Accounts" className="flex h-10 max-w-full items-center gap-1 overflow-x-auto rounded-full border border-line bg-surface/90 px-1 shadow-soft backdrop-blur [scrollbar-width:none]">
      {[...by.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).map(([p, x]) => {
        const on = active === p;
        return (
          <HoverCard key={p} content={<p className="text-[12.5px]"><b className="font-semibold">{providerName(p)}</b> · {plural(x.n, 'account')}{x.bad ? <span className="text-bad"> · {x.bad} couldn’t be read</span> : null}<span className="mt-1 block text-muted">{on ? 'Click to show everything again' : 'Click to show only these'}</span></p>}>
            <button type="button" aria-pressed={on} aria-label={`${providerName(p)}: ${plural(x.n, 'account')}${x.bad ? `, ${x.bad} couldn’t be read` : ''}`} onClick={() => setParams({ p: on ? null : p, show: null, acct: null })}
              className={cx('relative grid size-8 shrink-0 place-items-center rounded-full transition', on ? 'bg-ink ring-2 ring-blue/50' : 'bg-raised hover:bg-sunken', x.bad > 0 && !on && 'ring-2 ring-bad/40')}>
              <span className={cx('grid size-6 place-items-center rounded-full', on && 'bg-white')}><BrandLogo id={p} size={15} /></span>
              <span className="tabular absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-ink px-1 text-[9.5px] font-semibold leading-none text-bg ring-2 ring-surface">{x.n}</span>
            </button>
          </HoverCard>
        );
      })}
      <A href="/connections" aria-label="Connect another account" title="Connect another account" className="grid size-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><Plus size={15} /></A>
    </div>
  );
}

// type to find; Enter or a click flies there (the list scrolls to it). "/" from anywhere on the page.
function SearchBox({ v, value, onChange, onPick, jump }: { v: Derived; value: string; onChange: (s: string) => void; onPick: (a: Asset) => void; jump: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable=true], dialog[open]')) return;
      e.preventDefault(); ref.current?.focus();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  const s = value.trim().toLowerCase();
  const hits = useMemo(() => !s ? [] : v.assets.filter((a) => TOP.has(a.kind) && (a.name.toLowerCase().includes(s) || !!a.url?.toLowerCase().includes(s)))
    .sort((a, b) => +!a.name.toLowerCase().startsWith(s) - +!b.name.toLowerCase().startsWith(s) || a.name.length - b.name.length).slice(0, 8), [v, s]);
  const go = (a: Asset) => { onPick(a); setOpen(false); if (jump) ref.current?.blur(); };
  return (
    <div className="relative w-full sm:w-[280px]">
      <label className="flex h-10 items-center gap-2 rounded-full border border-line bg-surface/90 px-3.5 shadow-soft backdrop-blur transition focus-within:border-blue focus-within:ring-4 focus-within:ring-blue-soft">
        <Search size={15} className="shrink-0 text-muted" /><span className="sr-only">Find</span>
        <input ref={ref} value={value} role="combobox" aria-expanded={open && hits.length > 0} aria-controls="map-hits" aria-autocomplete="list"
          onChange={(e) => { onChange(e.target.value); setOpen(true); setAt(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt((x) => Math.min(x + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setAt((x) => Math.max(x - 1, 0)); }
            if (e.key === 'Enter' && hits[at]) { e.preventDefault(); go(hits[at]!); }
            if (e.key === 'Escape') { onChange(''); setOpen(false); ref.current?.blur(); }
          }}
          placeholder="Find a domain, app or database" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint focus-visible:outline-none" />
        {value ? <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="grid size-6 place-items-center rounded-full text-muted hover:bg-raised hover:text-ink"><X size={13} /></button>
          : <kbd className="hidden rounded-md border border-line px-1.5 text-[11px] text-faint sm:block">/</kbd>}
      </label>
      {open && hits.length > 0 && (
        <ul id="map-hits" role="listbox" className="animate-pop absolute left-0 top-full z-30 mt-1.5 w-full min-w-[280px] rounded-[18px] border border-line bg-surface p-1.5 shadow-float">
          {hits.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === at}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(a)} onMouseEnter={() => setAt(i)}
                className={cx('flex h-10 w-full items-center gap-2.5 rounded-[12px] px-2.5 text-left text-[13px] transition', i === at ? 'bg-raised' : '')}>
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={a.kind === 'domain' ? a.dns ?? 'domain' : logoOf(a)} size={13} /></span>
                <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                <span className="shrink-0 text-[11.5px] text-muted">{a.kind === 'database' ? 'Database' : a.kind === 'domain' ? 'Domain' : a.kind === 'server' ? 'Server' : 'App'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- first run and loading -------------------------------------------------------------------------
function FirstRun({ onSync }: { onSync: () => void }) {
  return (
    <section className="illo-host relative overflow-hidden rounded-[32px] border border-line bg-surface px-6 py-12 text-center shadow-soft md:py-16 animate-rise">
      <Illustration name="map" size={120} className="mx-auto mb-6" />
      <div className="mx-auto flex max-w-[420px] flex-wrap justify-center gap-3">
        {POPULAR.map((p, i) => <span key={p} className="grid size-14 place-items-center rounded-[18px] bg-raised shadow-soft animate-rise" style={{ animationDelay: `${i * 45}ms` }}><BrandLogo id={p} size={26} /></span>)}
      </div>
      <h2 className="mx-auto mt-8 max-w-lg text-[24px] font-semibold tracking-[-0.03em]">See everything you run, in one place</h2>
      <p className="mx-auto mt-2 max-w-md text-[14.5px] text-muted">Connect Vercel, Hostinger, Cloudflare or any account you use. Unit7 finds every domain, app and database, and shows what points where.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <A href="/connections" className="inline-flex h-12 items-center gap-2 rounded-full bg-blue px-6 text-[14.5px] font-medium text-white hover:brightness-110"><Plus size={17} /> Connect your first account</A>
        <Button size="lg" variant="soft" onClick={onSync}>Map what’s here</Button>
      </div>
    </section>
  );
}

function MapSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the map" className="flex min-h-0 flex-1 flex-col gap-3 pt-1 lg:pt-2">
      <MapHeader />
      <div className="relative min-h-[420px] flex-1 overflow-hidden rounded-[28px] border border-line bg-surface p-6">
        <div className="flex gap-2"><Skeleton className="h-10 w-[280px] rounded-full" /><Skeleton className="h-10 w-[200px] rounded-full" /></div>
        <div className="mt-16 grid grid-cols-3 gap-24 px-8">{[0, 1, 2].map((c) => <div key={c} className="space-y-3">{Array.from({ length: 5 - c }, (_, i) => <Skeleton key={i} className="h-10 rounded-full" />)}</div>)}</div>
      </div>
    </div>
  );
}
