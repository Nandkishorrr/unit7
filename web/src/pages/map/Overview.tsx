// The map as a normal page: every account, domain, app, database, service and server, each kind in its own calm
// section with its count and how many need a look. Long sections fold ("Show all 40"); anything opens the same
// centred pop-up the canvas uses. Built from the same derive() data; search and every filter apply here too.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, AppWindow, ArrowRight, ArrowUpRight, Boxes, ChevronDown, ChevronUp, Database, Globe, KeyRound, Layers, Plus, Server } from 'lucide-react';
import { A, Badge, Button, HoverCard, Modal, cx, timeAgo } from '../../ui';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { OWNER_NAME, ownerLogo, size as bytes } from '../servers/shape';
import { abandoned, acctLabel, engineOf, liveOf, logoOf, targetsOf, type Asset, type Derived } from './data';
import { appGroups, countOf, domainCards, fold, foldGroups, listOf, needs, providersOf, serviceGroups, type Bucket, type DomainCard, type ProviderAccounts, type Tone } from './sections';
import { KIND_ICON, KIND_NAME, plural, short, useMap } from './parts';
import { DbMark, dbSize } from './Canvas';
import { ReadinessRing } from '../care';
import { useReadinessOf } from '../care/data';
import { IssueItem } from './Inside';

// scroll only the view's own box (scrollIntoView would also shift the page's fixed frame around it)
export function scrollInside(el: HTMLElement | null, block: 'start' | 'center', offset = 0) {
  let box = el?.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!el || !box) return;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  const top = box.scrollTop + r.top - b.top - (block === 'center' ? (b.height - r.height) / 2 : offset);
  box.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

type Key = 'issues' | 'accounts' | 'domains' | 'apps' | 'databases' | 'services' | 'servers';
const DOT: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-[#f59e0b]', bad: 'bg-bad', idle: 'bg-transparent ring-1 ring-inset ring-line-strong' };
const TONE_WORD: Record<Tone, string> = { ok: 'Works', warn: 'Needs a look', bad: 'Needs fixing', idle: 'Not linked yet' };
const GRID = { domains: '270px', apps: '340px', databases: '250px', services: '300px' } as const; // the narrowest a card gets before the row wraps

export function Overview({ show, q, focus, filtered, provider, onProvider }: {
  show: Set<string>; q: string; focus?: string | null; filtered: boolean; provider: string | null; onProvider: (p: string | null) => void;
}) {
  const ctx = useMap();
  const { v, label, service } = ctx;
  const needle = q.trim().toLowerCase();
  const hooks = useMemo(() => ({ label, product: ctx.product, projectOf: (a: Asset) => { const s = service(a); return s ? { id: s.projectId, name: s.project } : undefined; } }), [label, ctx.product, service]);
  const s = useMemo(() => {
    // accounts that hold something on screen (all of them when nothing is filtered); a filter for problems keeps the ones that can't be read
    const on = (acc: (typeof v.accounts)[number]) => !filtered || (provider ? acc.provider === provider : v.assets.some((a) => show.has(a.id) && a.kind !== 'domain' && v.inAccount(acc, a)) || !acc.ok);
    return {
      accounts: providersOf(v.accounts.filter(on), needle, providerName),
      domains: domainCards(v, show, needle, hooks),
      apps: appGroups(v, show, needle, hooks),
      databases: listOf(v, show, 'database', needle, hooks),
      services: serviceGroups(v, show, needle, hooks),
      servers: listOf(v, show, 'server', needle, hooks),
      // every problem on what's shown (and the accounts that can't be read), each with its way forward
      issues: v.pins.filter((p) => (p.id ? show.has(p.id) : !filtered || !!p.acct) && (!needle || p.issue.text.toLowerCase().includes(needle))),
    };
  }, [v, show, needle, hooks, filtered, provider]);

  const [open, setOpen] = useState<Set<Key>>(new Set());
  const toggle = (k: Key) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const [pop, setPop] = useState<ProviderAccounts | null>(null);

  // search picked something: open its section, bring it into view, and ring it for a moment
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    const a = v.byId.get(focus);
    if (!a) return;
    const g = a.kind === 'domain' ? v.groupOf.get(a.id) : undefined;
    const card = g ? `d:${g.root}` : a.id;
    const key: Key = g ? 'domains' : a.kind === 'app' ? 'apps' : a.kind === 'database' ? 'databases' : a.kind === 'server' ? 'servers' : 'services';
    setOpen((o) => new Set(o).add(key));
    setLit(card);
    const t = requestAnimationFrame(() => scrollInside(document.getElementById(`ov-${card}`), 'center'));
    const off = setTimeout(() => setLit(null), 2200);
    return () => { cancelAnimationFrame(t); clearTimeout(off); };
  }, [focus, v]);

  const apps = foldGroups(s.apps, { groups: 6, rows: 4 }, open.has('apps'));
  const svcs = foldGroups(s.services, { groups: 3, rows: 4 }, open.has('services'));
  const doms = fold(s.domains, 8, open.has('domains'));
  const dbs = fold(s.databases, 8, open.has('databases'));
  const srvs = fold(s.servers, 6, open.has('servers'));
  const probs = fold(s.issues, 3, open.has('issues'));
  const n = {
    issues: { total: s.issues.length, need: 0 },
    accounts: { total: s.accounts.reduce((x, p) => x + p.accounts.length, 0), need: s.accounts.reduce((x, p) => x + p.bad, 0) },
    domains: countOf(s.domains),
    apps: { total: s.apps.reduce((x, b) => x + b.items.length, 0), need: s.apps.reduce((x, b) => x + b.need, 0) },
    databases: { total: s.databases.length, need: s.databases.filter((a) => needs(v, a)).length },
    services: { total: s.services.reduce((x, b) => x + b.items.length, 0), need: s.services.reduce((x, b) => x + b.need, 0) },
    servers: { total: s.servers.length, need: s.servers.filter(v.attention).length },
  };
  if (!Object.values(n).some((x) => x.total)) return <p className="px-6 py-16 text-center text-[14px] text-muted">Nothing here matches. Try another filter.</p>;

  const head = (k: Key, title: string, icon: ReactNode, hidden: number, unit: string) => ({ k, title, icon, hidden, unit, total: n[k].total, need: n[k].need, open: open.has(k), onToggle: () => toggle(k) });
  return (
    <div className="pb-8">
      <Jump n={n} />
      <div className="space-y-9 px-3 pt-4 sm:px-5">
        {n.issues.total > 0 && (
          <Section {...head('issues', 'Problems', <AlertTriangle size={15} />, probs.hidden, 'problem')} i={0}>
            <div className="max-w-[760px] space-y-2">{probs.shown.map((p) => <IssueItem key={p.issue.key} i={p.issue} a={p.id ? v.byId.get(p.id) : undefined} compact />)}</div>
          </Section>
        )}
        {n.accounts.total > 0 && (
          <Section {...head('accounts', 'Accounts', <KeyRound size={15} />, 0, 'account')} i={0}>
            <ul className="flex flex-wrap gap-x-2 gap-y-3">
              {s.accounts.map((p) => <li key={p.provider}><ProviderCircle p={p} active={provider === p.provider} onOpen={() => setPop(p)} /></li>)}
              <li><A href="/connections" className="flex w-[76px] flex-col items-center gap-1.5 rounded-[16px] py-1 text-muted transition hover:text-ink">
                <span className="grid size-12 place-items-center rounded-full border border-dashed border-line-strong"><Plus size={18} /></span><span className="text-[11.5px]">Add one</span></A></li>
            </ul>
          </Section>
        )}
        {n.domains.total > 0 && (
          <Section {...head('domains', 'Domains', <Globe size={15} />, doms.hidden, 'domain')} i={1}>
            <Grid min={GRID.domains}>{doms.shown.map((c) => <DomainTile key={c.id} c={c} lit={lit === c.id} />)}</Grid>
          </Section>
        )}
        {n.apps.total > 0 && (
          <Section {...head('apps', 'Apps', <AppWindow size={15} />, apps.hidden, 'app')} i={2}>
            <Grid min={GRID.apps} top>{apps.groups.map((b) => <BucketCard key={b.id} b={b} shown={b.shown} more={b.more} onMore={() => toggle('apps')} row={(a) => <AppRow key={a.id} a={a} lit={lit === a.id} />} />)}</Grid>
          </Section>
        )}
        {n.databases.total > 0 && (
          <Section {...head('databases', 'Databases', <Database size={15} />, dbs.hidden, 'database')} i={3}>
            <Grid min={GRID.databases}>{dbs.shown.map((a) => <DbTile key={a.id} a={a} lit={lit === a.id} />)}</Grid>
          </Section>
        )}
        {n.services.total > 0 && (
          <Section {...head('services', 'Services', <Layers size={15} />, svcs.hidden, 'service')} i={4}>
            <Grid min={GRID.services} top>{svcs.groups.map((b) => <BucketCard key={b.id} b={b} shown={b.shown} more={b.more} onMore={() => toggle('services')} row={(a) => <ServiceRow key={a.id} a={a} lit={lit === a.id} />} />)}</Grid>
          </Section>
        )}
        {n.servers.total > 0 && (
          <Section {...head('servers', 'Servers', <Server size={15} />, srvs.hidden, 'server')} i={5}>
            <ul className="flex flex-wrap gap-2">{srvs.shown.map((a) => <li key={a.id} className="min-w-0 max-w-full"><ServerChip a={a} lit={lit === a.id} /></li>)}</ul>
          </Section>
        )}
      </div>
      <AccountsPop p={pop} active={provider} onClose={() => setPop(null)} onProvider={(x) => { setPop(null); onProvider(x); }} />
    </div>
  );
}

// --- the frame: a slim bar of totals that jumps to each section, and the sections ------------------------------------
const JUMP: [Key, string][] = [['issues', 'Problems'], ['accounts', 'Accounts'], ['domains', 'Domains'], ['apps', 'Apps'], ['databases', 'Databases'], ['services', 'Services'], ['servers', 'Servers']];
function Jump({ n }: { n: Record<Key, { total: number; need: number }> }) {
  return (
    <nav aria-label="Sections" className="sticky top-0 z-10 border-b border-line bg-surface/90 px-3 py-2 backdrop-blur sm:px-5">
      <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
        {JUMP.filter(([k]) => n[k].total).map(([k, t]) => (
          <li key={k} className="shrink-0">
            <a href={`#ov-${k}`} onClick={(e) => { e.preventDefault(); scrollInside(document.getElementById(`ov-${k}`), 'start', 64); }}
              className="inline-flex h-9 items-center gap-2 rounded-full px-3 text-[13px] text-ink-2 transition hover:bg-raised hover:text-ink">
              <span className="tabular text-[15px] font-semibold tracking-[-0.02em] text-ink">{n[k].total}</span>{t}
              {n[k].need > 0 && <span title={`${n[k].need} to look at`} className="size-1.5 rounded-full bg-[#f59e0b]" />}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Section({ k, title, icon, total, need, hidden, unit, open, onToggle, i, children }: { k: Key; title: string; icon: ReactNode; total: number; need: number; hidden: number; unit: string; open: boolean; onToggle: () => void; i: number; children: ReactNode }) {
  return (
    <section id={`ov-${k}`} aria-labelledby={`ov-${k}-h`} style={{ animation: `rise .45s var(--ease-out-soft) ${i * 50}ms backwards` }}>
      <header className="mb-3 flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-raised text-ink-2">{icon}</span>
        <h2 id={`ov-${k}-h`} className="text-[16px] font-semibold tracking-[-0.02em]">{title} <span className="tabular font-normal text-muted">{total}</span></h2>
        {need > 0 && <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-warn/10 px-2.5 text-[12px] font-medium text-warn"><span className="size-1.5 rounded-full bg-[#f59e0b]" />{need} {k === 'accounts' ? 'can’t be read' : `need${need === 1 ? 's' : ''} a look`}</span>}
        {open && <button type="button" aria-expanded onClick={onToggle} className="ml-auto inline-flex h-8 items-center gap-1 rounded-full px-3 text-[12.5px] font-medium text-muted transition hover:bg-raised hover:text-ink">Show less<ChevronUp size={14} /></button>}
      </header>
      {children}
      {hidden > 0 && (
        <button type="button" aria-expanded={false} onClick={onToggle}
          className="mt-2.5 flex h-10 w-full items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-line-strong text-[13px] font-medium text-ink-2 transition hover:border-ink/30 hover:bg-raised hover:text-ink">
          Show all {plural(total, unit)}<span className="text-muted">· {hidden} more</span><ChevronDown size={15} />
        </button>
      )}
    </section>
  );
}
// cards of a group (apps, services) keep their own height; tiles of one kind line up
const Grid = ({ min, children, top }: { min: string; children: ReactNode; top?: boolean }) => <div className={cx('grid gap-2.5', top && 'items-start')} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}), 1fr))` }}>{children}</div>;
const Status = ({ tone, text }: { tone: Tone; text: string }) => <span className="inline-flex min-w-0 items-center gap-1.5"><span aria-hidden className={cx('size-2 shrink-0 rounded-full', DOT[tone])} /><span className="truncate">{text}</span></span>;
const ring = (lit: boolean) => lit && 'ring-2 ring-blue/50 ring-offset-2 ring-offset-surface';
const TILE = 'relative rounded-[20px] border border-line bg-surface shadow-soft transition hover:border-ink/20 hover:shadow-lift';
// a whole card that opens on click, with other buttons inside it still their own (the stretched-button pattern)
const STRETCH = 'text-left after:absolute after:inset-0 after:rounded-[20px] after:content-[""] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-blue/50';

// --- accounts -------------------------------------------------------------------------------------------------------
function ProviderCircle({ p, active, onOpen }: { p: ProviderAccounts; active: boolean; onOpen: () => void }) {
  const name = providerName(p.provider);
  return (
    <button type="button" onClick={onOpen} aria-label={`${name}: ${plural(p.accounts.length, 'account')}${p.bad ? `, ${p.bad} can’t be read` : ''}`}
      className="group/acc flex w-[76px] flex-col items-center gap-1.5 rounded-[16px] py-1 text-center">
      <span className={cx('relative grid size-12 place-items-center rounded-full bg-raised transition group-hover/acc:-translate-y-0.5 group-hover/acc:shadow-lift', active && 'bg-ink ring-2 ring-blue/50', p.bad > 0 && !active && 'ring-2 ring-bad/45')}>
        <span className={cx('grid size-9 place-items-center rounded-full', active && 'bg-white')}><BrandLogo id={p.provider} size={20} /></span>
        <span className={cx('tabular absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[10.5px] font-semibold leading-none text-white ring-2 ring-surface', p.bad ? 'bg-bad-solid' : 'bg-ok-solid')}>{p.accounts.length}</span>
      </span>
      <span className="w-full truncate text-[11.5px] text-ink-2">{name}</span>
    </button>
  );
}

function AccountsPop({ p, active, onClose, onProvider }: { p: ProviderAccounts | null; active: string | null; onClose: () => void; onProvider: (p: string | null) => void }) {
  const { v } = useMap();
  const title = p && <span className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-full bg-raised"><BrandLogo id={p.provider} size={20} /></span>{providerName(p.provider)}</span>;
  return (
    <Modal open={!!p} onClose={onClose} title={title} size="sm">
      {p && (
        <div className="space-y-5">
          <ul className="divide-y divide-line rounded-[18px] border border-line">
            {p.accounts.map((a) => {
              const issues = v.acctIssues.get(a.id) ?? [];
              return (
                <li key={a.id} className="flex min-h-14 items-center gap-3 px-3.5 py-2.5">
                  <span aria-hidden className={cx('size-2 shrink-0 rounded-full', a.ok ? 'bg-ok' : 'bg-bad')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{acctLabel(a.name) || a.name}</span>
                    <span className={cx('block text-[12px]', a.ok ? 'text-muted' : 'text-bad')}>
                      {a.ok ? `Works · ${plural(a.found, 'thing')} found` : issues[0]?.text ?? a.note ?? 'Couldn’t be read on the last sync'}{a.staleSince ? ` · last read ${timeAgo(a.staleSince)}` : ''}
                    </span>
                  </span>
                  <A href={`/map/account/${encodeURIComponent(a.id)}?view=overview`} onClick={onClose} className="shrink-0 rounded-full px-2.5 py-1.5 text-[12.5px] font-medium text-blue-text hover:bg-blue-soft">See all</A>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <A href="/connections" className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3.5 text-[13px] font-medium hover:bg-raised">Manage<ArrowUpRight size={14} /></A>
            {active === p.provider ? <Button size="sm" variant="dark" onClick={() => onProvider(null)}>Show everything again</Button>
              : <Button size="sm" variant="dark" onClick={() => onProvider(p.provider)}>Show only {providerName(p.provider)}’s things</Button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

// --- domains --------------------------------------------------------------------------------------------------------
function DomainTile({ c, lit }: { c: DomainCard; lit: boolean }) {
  const { open, label } = useMap();
  const t = c.targets[0];
  return (
    <article id={`ov-${c.id}`} className={cx(TILE, 'flex flex-col gap-2.5 p-3.5', ring(lit))}>
      <div className="flex min-w-0 items-center gap-3">
        <span className={cx('grid size-9 shrink-0 place-items-center rounded-full', c.g.dns ? 'bg-raised' : 'border border-dashed border-line-strong')}><BrandLogo id={c.g.dns ?? 'domain'} size={17} /></span>
        <span className="min-w-0 flex-1">
          <button type="button" onClick={() => c.open && open(c.open.id)} className={cx(STRETCH, 'block w-full truncate text-[14.5px] font-semibold tracking-[-0.015em]')}>{c.root}</button>
          <span className="block truncate text-[12px] text-muted"><Status tone={c.tone} text={`${TONE_WORD[c.tone]}${c.g.dns ? ` · DNS at ${providerName(c.g.dns)}` : ' · DNS elsewhere'}`} /></span>
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
        <ArrowRight size={13} aria-hidden className="shrink-0 text-faint" />
        {t ? <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ink-2"><BrandLogo id={logoOf(t)} size={13} /><span className="truncate">{label(t)}</span>{c.targets.length > 1 && <span className="shrink-0 text-muted">+{c.targets.length - 1}</span>}</span>
          : <span className="min-w-0 flex-1 truncate text-faint">Nothing yet</span>}
        {c.subs.length > 0 && <Subs c={c} />}
      </div>
    </article>
  );
}

// "+8 · 3 unused": hover (or focus, or tap) lists them and where each points
function Subs({ c }: { c: DomainCard }) {
  const { v, open, label } = useMap();
  const linked = c.subs.filter((d) => !c.unused.includes(d));
  const list = [...linked, ...c.unused.filter((d) => abandoned(v, d) === 'takeover'), ...c.unused.filter((d) => abandoned(v, d) !== 'takeover')];
  return (
    <HoverCard content={(
      <div className="w-[270px]">
        <p className="text-[12px] font-medium text-muted">{plural(c.subs.length, 'subdomain')} of {c.root}</p>
        <ul className="mt-2 space-y-1">
          {list.slice(0, 9).map((d) => {
            const t = targetsOf(v, d)[0], risk = abandoned(v, d);
            return (
              <li key={d.id}>
                <button type="button" onClick={() => open(d.id)} className="flex w-full min-w-0 items-center gap-2 rounded-[10px] px-1.5 py-1 text-left text-[12.5px] hover:bg-raised">
                  <span className="min-w-0 max-w-[45%] truncate font-medium">{short(d, c.root)}</span>
                  <ArrowRight size={11} aria-hidden className="shrink-0 text-faint" />
                  {t ? <span className="flex min-w-0 items-center gap-1 truncate text-ink-2"><BrandLogo id={logoOf(t.asset)} size={11} /><span className="truncate">{label(t.asset)}</span></span>
                    : <span className={cx('truncate', risk === 'takeover' ? 'font-medium text-bad' : 'text-faint')}>{risk === 'takeover' ? 'can be taken over' : 'not used'}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {list.length > 9 && <p className="mt-1 px-1.5 text-[12px] text-muted">and {list.length - 9} more</p>}
        <p className="mt-2 px-1.5 text-[12px] text-muted">Click one for its details</p>
      </div>
    )}>
      <button type="button" onClick={() => c.open && open(c.open.id)} aria-label={`${plural(c.subs.length, 'subdomain')}${c.unused.length ? `, ${c.unused.length} unused` : ''}${c.risky ? `, ${c.risky} can be taken over` : ''}`}
        className={cx('relative z-[1] inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium transition', c.risky ? 'bg-bad/10 text-bad' : 'bg-raised text-ink-2 hover:bg-sunken')}>
        +{c.subs.length}{c.unused.length > 0 && <span className={c.risky ? '' : 'text-muted'}>· {c.unused.length} unused</span>}
      </button>
    </HoverCard>
  );
}

// --- apps and services: a card per group, a row per thing --------------------------------------------------------------
const BUCKET_ICON: Partial<Record<Bucket['kind'], ReactNode>> = { product: <Boxes size={16} className="text-ink-2" />, tools: <Layers size={16} className="text-ink-2" />, data: <KIND_ICON.volume size={16} className="text-ink-2" />, jobs: <KIND_ICON.job size={16} className="text-ink-2" /> };
function BucketCard({ b, shown, more, onMore, row }: { b: Bucket; shown: Asset[]; more: number; onMore: () => void; row: (a: Asset) => ReactNode }) {
  const title = b.kind === 'host' ? `${providerName(b.name)}${b.sub ? ` · ${b.sub}` : ''}` : b.name;
  const kind = b.kind === 'product' ? 'Product' : b.kind === 'project' ? (b.logo === 'unit7' ? 'Unit7 project' : `${b.logo === 'unmanaged' ? 'Server' : OWNER_NAME[b.logo] ?? 'Server'} project`) : b.kind === 'host' ? 'Not in a project' : '';
  const line = [kind, b.kind === 'project' && b.sub, plural(b.items.length, b.kind === 'tools' || b.kind === 'data' || b.kind === 'jobs' ? 'thing' : 'app')].filter(Boolean).join(' · ');
  return (
    <article className="flex flex-col rounded-[22px] border border-line bg-surface p-1.5 shadow-soft">
      <header className="flex min-h-11 items-center gap-2.5 px-2.5 pt-1">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-raised">{BUCKET_ICON[b.kind] ?? <BrandLogo id={b.kind === 'project' ? ownerLogo(b.logo) ?? 'docker' : b.logo} size={16} />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold tracking-[-0.015em]">{title}</span>
          <span className="block truncate text-[11.5px] text-muted">{line}</span>
        </span>
        {b.need > 0 && <span title={`${b.need} to look at`} className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-warn/10 px-2 text-[11.5px] font-medium text-warn"><span className="size-1.5 rounded-full bg-[#f59e0b]" />{b.need}</span>}
      </header>
      <ul className="mt-1 space-y-0.5">{shown.map(row)}</ul>
      {more > 0 && <button type="button" onClick={onMore} className="mx-1 mb-0.5 mt-0.5 h-8 rounded-[12px] px-2.5 text-left text-[12.5px] font-medium text-muted transition hover:bg-raised hover:text-ink">+{more} more</button>}
    </article>
  );
}

const rowCls = (lit: boolean) => cx('flex min-h-12 w-full items-center gap-3 rounded-[14px] px-2.5 py-1.5 text-left transition hover:bg-raised focus-visible:bg-raised', lit && 'bg-blue-soft');
function appTone(v: Derived, a: Asset): { tone: Tone; text: string } {
  const live = liveOf(a), issues = v.issuesOf(a.id);
  const tone: Tone = issues.some((i) => i.severity === 'critical') || live?.tone === 'bad' ? 'bad' : issues.length || v.attention(a) || live?.tone === 'warn' ? 'warn' : live ? 'ok' : 'idle';
  return { tone, text: tone === 'idle' ? 'No checks yet' : tone === 'ok' ? live?.text ?? 'Running' : live && live.tone !== 'ok' ? live.text : 'Needs a look' };
}

function AppRow({ a, lit }: { a: Asset; lit: boolean }) {
  const { v, open, label, service } = useMap();
  const svc = service(a);
  const ready = useReadinessOf(svc?.projectId ?? '');
  const { tone, text } = appTone(v, a);
  const doms = new Set([...v.inc(a.id, 'domain'), ...v.inc(a.id, 'dns')].map((e) => e.source)).size;
  const dep = svc?.deploy;
  const meta = [doms ? plural(doms, 'domain') : 'no domain', dep && (dep.at ? `deployed ${timeAgo(dep.at)}` : 'not deployed yet')].filter(Boolean).join(' · ');
  return (
    <li id={`ov-${a.id}`}>
      <button type="button" onClick={() => open(a.id)} className={rowCls(lit)}>
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-raised"><BrandLogo id={logoOf(a)} size={16} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium tracking-[-0.01em]">{label(a)}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted"><Status tone={tone} text={text} /><span className="shrink-0 text-faint">·</span><span className="truncate">{meta}</span></span>
        </span>
        {ready?.total ? <span title={ready.ready ? 'Ready for real users' : `${ready.done} of ${ready.total} ready for real users`} className="shrink-0"><ReadinessRing done={ready.done} total={ready.total} size={24} label={false} /></span> : null}
      </button>
    </li>
  );
}

function ServiceRow({ a, lit }: { a: Asset; lit: boolean }) {
  const { v, open } = useMap();
  const live = liveOf(a);
  const srv = a.server ? v.byId.get(a.server) : undefined;
  const what = a.product?.name ?? (a.kind === 'job' ? 'Scheduled job' : a.kind === 'volume' ? (a.size ? bytes(a.size) : 'Stored data') : a.system ? 'Runs the server’s tools' : KIND_NAME[a.kind]);
  const state: { tone: Tone; text: string } | undefined = a.kind === 'job' ? undefined : a.kind === 'volume' ? (a.health?.status === 'off' ? { tone: 'warn', text: 'Unused' } : undefined)
    : live ? { tone: live.tone, text: live.tone === 'ok' ? 'Running' : live.text } : undefined;
  const Icon = KIND_ICON[a.kind];
  return (
    <li id={`ov-${a.id}`}>
      <button type="button" onClick={() => open(a.id)} className={rowCls(lit)}>
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-raised">{a.product || a.kind === 'service' ? <BrandLogo id={logoOf(a)} size={16} /> : <Icon size={15} className="text-muted" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium tracking-[-0.01em]">{a.name}</span>
          <span className="block truncate text-[12px] text-muted">{what}{srv ? ` · on ${srv.name}` : ''}</span>
        </span>
        {state && <span className="max-w-[40%] shrink-0 text-[12px] text-ink-2"><Status tone={state.tone} text={state.text} /></span>}
      </button>
    </li>
  );
}

// --- databases: the engine ring, its size, who uses it, its last backup ------------------------------------------------
function DbTile({ a, lit }: { a: Asset; lit: boolean }) {
  const { v, open, label, service } = useMap();
  const users = [...new Set([...v.inc(a.id, 'env'), ...v.inc(a.id, 'uses')].map((e) => e.source))].map((id) => v.byId.get(id)).filter((x): x is Asset => !!x);
  const live = liveOf(a);
  const need = v.attention(a);
  const size = dbSize(a);
  const eng = engineOf(a, service(a)?.stack);
  const backup = a.backups?.last ? `Backed up ${timeAgo(a.backups.last)}` : a.backups ? 'No backup finished yet' : a.provider === 'supabase' || a.provider === 'neon' ? `Backups kept by ${providerName(a.provider)}` : a.provider === 'unit7' ? 'No backups yet' : undefined;
  return (
    <article id={`ov-${a.id}`} className={cx(TILE, 'flex items-start gap-3 p-3.5', ring(lit))}>
      <DbMark a={a} sizeOf={size} />
      <span className="min-w-0 flex-1">
        <button type="button" onClick={() => open(a.id)} className={cx(STRETCH, 'block w-full truncate text-[14px] font-semibold tracking-[-0.015em]')}>{label(a)}</button>
        <span className="block truncate text-[12px] text-ink-2" title={size ? undefined : 'Size not known yet'}>{size ? bytes(size) : providerName(eng)}<span className="text-muted"> · {users.length ? `used by ${users.length === 1 ? label(users[0]!) : plural(users.length, 'app')}` : 'nothing uses it'}</span></span>
        {backup && <span className={cx('block truncate text-[12px]', backup.startsWith('No') ? 'text-warn' : 'text-muted')}>{backup}</span>}
        {(a.exposed || (need && live)) && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {a.exposed && <Badge tone="bad" className="h-5 px-2 text-[11px]">Open to the internet</Badge>}
            {need && live && live.tone !== 'ok' && <Badge tone="warn" className="h-5 px-2 text-[11px]">{live.text}</Badge>}
          </span>
        )}
      </span>
      {need && !a.exposed && !(live && live.tone !== 'ok') && <span title="Needs a look" className="mt-1.5 size-2 shrink-0 rounded-full bg-[#f59e0b]" />}
    </article>
  );
}

// --- servers: a small strip ------------------------------------------------------------------------------------------
function ServerChip({ a, lit }: { a: Asset; lit: boolean }) {
  const { v, open } = useMap();
  const on = [...new Set(v.inc(a.id, 'runs_on').map((e) => e.source))].map((id) => v.byId.get(id)).filter((x): x is Asset => !!x);
  const projects = (a.projects ?? []).filter((p) => !p.system).length;
  const appsOn = on.filter((x) => x.kind === 'app').length, dbsOn = on.filter((x) => x.kind === 'database').length;
  const sick = on.filter((x) => x.health?.status === 'bad' || x.health?.status === 'warn').length;
  const tone: Tone = v.attention(a) ? 'bad' : sick ? 'warn' : 'ok';
  const words = [projects && plural(projects, 'project'), appsOn && plural(appsOn, 'app'), dbsOn && `${dbsOn} db`].filter(Boolean).join(' · ') || 'Nothing found on it yet';
  const logos = [a.provider, ...(a.also ?? []).map((x) => x.provider)].filter((x, i, l) => l.indexOf(x) === i);
  return (
    <button id={`ov-${a.id}`} type="button" onClick={() => open(a.id)}
      className={cx('flex h-14 max-w-full items-center gap-3 rounded-full border border-line bg-surface pl-2 pr-4 text-left shadow-soft transition hover:border-ink/20 hover:shadow-lift', ring(lit))}>
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={logos[0]!} size={18} /></span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[13.5px] font-semibold tracking-[-0.01em]"><span className="truncate">{a.name}</span><span aria-hidden className={cx('size-2 shrink-0 rounded-full', DOT[tone])} /></span>
        <span className="block truncate text-[12px] text-muted"><span className="sr-only">{tone === 'ok' ? 'Healthy. ' : tone === 'warn' ? `${sick} need a look. ` : 'Needs a look. '}</span>{words}{sick ? <span className="text-warn"> · {sick} to look at</span> : null}</span>
      </span>
    </button>
  );
}
