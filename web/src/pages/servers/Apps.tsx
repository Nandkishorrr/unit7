// The server page's Apps tab: every project as a small card (logo, name, one dot, its domains, a thin memory bar),
// grouped by who runs it when there's more than one, each group folding away, with a search once there are many.
// Hovering a card shows its domains, databases and last deploy; clicking opens it in the pop-up. What isn't part
// of a project, and the system's own, is one folded row. Domains, databases and jobs are one switch away.
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, Database, Globe, Rocket } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { A, Button, HoverCard, SearchInput, cx, timeAgo, StatusMark } from '../../ui';
import { OWNER_NAME, healthTone, healthWords, money, ownerLogo, partLogo, partWhat, size, type Card, type XPart, type Xray } from './shape';
import { AiButton, CardsSkeleton, looseOf, type ServerXray } from './Xray';
import { DatabasesTab, DomainsTab, JobsTab, type ServerPage } from './Overview';
import { LifecycleMenu, useArchived, KeepStar, PulseDetail, UsedPulse } from '../lifecycle';
import { useServerApps } from '../serverapps/AppAccess';

export type AppsView = 'projects' | 'domains' | 'databases' | 'jobs';
const DOT = { ok: 'bg-ok', warn: 'bg-[#f59e0b]', bad: 'bg-bad', idle: 'bg-line-strong' } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// the newest deploy Unit7 can see for a project: Coolify's, or the last change in its folder's git
function lastDeploy(c: Card): { at?: string; words: string } | null {
  const d = c.parts.map((p) => p.coolify?.lastDeploy).filter((x): x is NonNullable<typeof x> => !!x?.at).sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0];
  if (d) return { at: d.at, words: `${timeAgo(d.at)}${d.status ? ` · ${d.status.replace(/_/g, ' ')}` : ''}${d.commit ? ` · ${d.commit.slice(0, 7)}` : ''}` };
  const g = c.parts.find((p) => p.git?.last)?.git;
  return g?.last ? { words: `Last change ${g.last}${g.dirty ? ` · ${plural(g.dirty, 'unsaved change')}` : ''}` } : null;
}

function Peek({ c, cost, currency, k }: { c: Card; cost?: number; currency?: string; k?: string }) {
  const t = healthTone(c.health);
  const dbs = c.parts.filter((p) => p.kind === 'database' || p.product?.id === 'supabase');
  const dep = lastDeploy(c);
  return (
    <div className="w-[min(300px,calc(100vw-48px))] space-y-3">
      <div>
        <p className="flex items-center gap-2 font-semibold"><span className={cx('size-2 rounded-full', DOT[t])} />{c.name}</p>
        <p className={cx('mt-0.5 text-[12.5px]', t === 'bad' ? 'text-bad' : t === 'warn' ? 'text-warn' : 'text-muted')}>{healthWords(c.health)} · {c.what}{c.environment ? ` · ${c.environment}` : ''}</p>
      </div>
      <Peeks title="Domains" icon={<Globe size={12} />} empty="No domain points here" items={c.domains.map((d) => <span key={d} className="truncate">{d}</span>)} />
      <Peeks title="Databases" icon={<Database size={12} />} empty="No database" items={dbs.map((p) => <span key={p.id} className="flex min-w-0 items-center gap-1.5"><BrandLogo id={partLogo(p)} size={12} /><span className="truncate">{p.name}</span><span className="shrink-0 text-muted">{partWhat(p)}</span></span>)} />
      <p className="flex items-center gap-1.5 border-t border-line pt-2.5 text-[12px] text-muted"><Rocket size={12} />{dep ? <>Last deploy {dep.words}</> : 'No deploy seen yet'}</p>
      <PulseDetail k={k} />
      {(c.mem || cost != null) && <p className="tabular text-[12px] text-muted">{[c.mem ? `${size(c.mem)} memory` : '', c.disk ? `${size(c.disk)} on disk` : '', cost != null ? `${money(cost, currency)}/mo` : ''].filter(Boolean).join(' · ')}</p>}
    </div>
  );
}
function Peeks({ title, icon, items, empty }: { title: string; icon: ReactNode; items: ReactNode[]; empty: string }) {
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{icon}{title}{items.length > 0 && <span className="font-normal normal-case tracking-normal">· {items.length}</span>}</p>
      {items.length ? <ul className="space-y-0.5 text-[12.5px] text-ink-2">{items.slice(0, 4).map((x, i) => <li key={i} className="flex min-w-0">{x}</li>)}{items.length > 4 && <li className="text-muted">+{items.length - 4} more</li>}</ul> : <p className="text-[12.5px] text-muted">{empty}</p>}
    </div>
  );
}

function MiniCard({ c, page, maxMem, archivedKeys }: { c: Card; page: ServerPage; maxMem: number; archivedKeys: Set<string> }) {
  const t = healthTone(c.health);
  // the most telling logo: Supabase or the app's own product over a plain Docker whale
  const logo = c.logos.find((l) => l !== 'docker') ?? c.logos[0] ?? ownerLogo(c.owner) ?? 'docker';
  const cost = page.ctx?.cost?.(c);
  const life = page.lifeItem(c);
  const archived = !!life && archivedKeys.has(life.key);
  return (
    // the menu sits beside the hover card's trigger, not inside it, so opening it doesn't open the card too
    <li className="relative min-w-0 focus-within:z-30">
      <HoverCard content={<Peek c={c} cost={cost} currency={page.currency} k={life?.key} />}>
        <div className={cx('lift group relative flex h-full min-w-0 flex-col rounded-[20px] border bg-surface p-3.5 shadow-soft', t === 'bad' && !archived ? 'border-bad/30' : 'border-line', archived && 'opacity-60')}>
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[13px] bg-raised"><BrandLogo id={logo} size={20} /></span>
            <div className="min-w-0 flex-1">
              <h3 className="flex min-w-0 items-center gap-2 text-[14px] font-semibold tracking-[-0.01em]">
                <button type="button" onClick={() => page.openProject(c.id)} className="min-w-0 truncate text-left outline-none after:absolute after:inset-0 after:rounded-[20px] focus-visible:after:ring-2 focus-visible:after:ring-blue">{c.name}</button>
                <span aria-hidden className={cx('size-2 shrink-0 rounded-full', DOT[t])} /><span className="sr-only">{healthWords(c.health)}</span>
                {life && <KeepStar k={life.key} plain />}
              </h3>
              <p className={cx('truncate text-[12px]', archived ? 'text-muted' : t === 'bad' ? 'text-bad' : t === 'warn' ? 'text-warn' : 'text-muted')}>
                {archived ? 'Archived: Unit7 doesn’t watch it' : t === 'bad' || t === 'warn' ? healthWords(c.health) : c.domains.length ? plural(c.domains.length, 'domain') : 'No domain'}
              </p>
            </div>
            {life && <span aria-hidden className="w-6 shrink-0" />}
          </div>
          <div className="mt-3 flex items-center gap-2" title={c.mem ? `${size(c.mem)} of memory right now` : 'Memory not measured yet'}>
            <span aria-hidden className="h-1 flex-1 overflow-hidden rounded-full bg-sunken">{c.mem ? <span className="block h-full rounded-full bg-blue/70" style={{ width: `${Math.max(4, (100 * c.mem) / Math.max(1, maxMem))}%` }} /> : null}</span>
            <span className="tabular w-12 shrink-0 text-right text-[11px] text-muted">{c.mem ? size(c.mem) : '–'}</span>
          </div>
          {/* when it was last used (its hover card says how Unit7 knows); nothing when nothing is known */}
          {life && !archived && <div className="mt-2 flex min-w-0 empty:hidden"><UsedPulse k={life.key} plain className="text-[11.5px]" /></div>}
        </div>
      </HoverCard>
      {life && <span className="absolute right-2.5 top-[18px] z-10"><LifecycleMenu item={life} onChanged={page.changed} label={`More for ${c.name}`}
        className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-blue" /></span>}
    </li>
  );
}

function Grid({ cards, page, maxMem }: { cards: Card[]; page: ServerPage; maxMem: number }) {
  const { keys } = useArchived();
  // archived ones last, quieter
  const order = [...cards].sort((a, b) => +keys.has(page.lifeItem(a)?.key ?? '') - +keys.has(page.lifeItem(b)?.key ?? ''));
  return <ul className="grid grid-cols-1 gap-2.5 min-[520px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{order.map((c) => <MiniCard key={c.id} c={c} page={page} maxMem={maxMem} archivedKeys={keys} />)}</ul>;
}

function Group({ owner, cards, page, maxMem, x, forceOpen }: { owner: string; cards: Card[]; page: ServerPage; maxMem: number; x: Xray; forceOpen: boolean }) {
  const [open, setOpen] = useState(true);
  const shown = open || forceOpen;
  const bad = cards.filter((c) => ['bad', 'warn'].includes(healthTone(c.health))).length;
  const id = `grp-${owner}`;
  return (
    <section aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="mb-2.5">
        <button type="button" aria-expanded={shown} aria-controls={id} onClick={() => setOpen(!open)} className="group flex w-full items-center gap-2.5 rounded-full py-1 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue">
          <ChevronRight size={15} className={cx('shrink-0 text-muted transition-transform', shown && 'rotate-90')} />
          <span className="grid size-6 place-items-center rounded-full bg-surface shadow-soft ring-1 ring-line">{ownerLogo(owner) ? <BrandLogo id={ownerLogo(owner)!} size={13} /> : <span className="text-[10px] text-muted">?</span>}</span>
          <span className="text-[14px] font-semibold">{owner === 'unmanaged' ? 'Running on its own' : OWNER_NAME[owner] ?? owner}</span>
          <span className="tabular text-[13px] text-muted">{cards.length}</span>
          {bad > 0 && <span className="text-[12.5px] text-warn">· {bad} need{bad === 1 ? 's' : ''} a look</span>}
          {owner === 'coolify' && x.coolify?.connected && <span className="inline-flex items-center gap-1 text-[12px] text-ok"><StatusMark state="ok" size={13} label="Connected" />connected</span>}
          <span aria-hidden className="ml-2 h-px flex-1 bg-line" />
        </button>
      </h3>
      {shown && <div id={id} className="animate-[fade_0.2s_ease-out]"><Grid cards={cards} page={page} maxMem={maxMem} /></div>}
    </section>
  );
}

// the system's own and what isn't part of a project: one folded row
function AlsoHere({ sys, x, page, serverName }: { sys: Card[]; x: Xray; page: ServerPage; serverName: string }) {
  const loose = looseOf(x);
  if (!sys.length && !loose.parts.length && !loose.unused) return null;
  const words = [sys.length ? sys.map((c) => c.name).join(', ') : '', loose.words ? `not part of a project: ${loose.words}` : ''].filter(Boolean).join(' · ');
  return (
    <details className="group rounded-[20px] border border-dashed border-line-strong bg-surface/60 px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[13px] outline-none [&::-webkit-details-marker]:hidden">
        <ChevronRight size={15} className="shrink-0 text-muted transition-transform group-open:rotate-90" />
        <span className="shrink-0 font-medium text-ink">Also on this server</span>
        <span className="min-w-0 truncate text-muted">{words}</span>
      </summary>
      <div className="mt-3 space-y-3 pl-6">
        {sys.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {sys.map((c) => (
              <li key={c.id}><button type="button" onClick={() => page.openProject(c.id)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface pl-1.5 pr-3 text-[12.5px] font-medium text-ink-2 transition hover:border-line-strong hover:text-ink">
                <BrandLogo id={c.logos[0] ?? ownerLogo(c.owner) ?? 'linux'} size={14} />{c.name}<span className={cx('size-1.5 rounded-full', DOT[healthTone(c.health)])} />
              </button></li>
            ))}
          </ul>
        )}
        {loose.parts.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {loose.parts.slice(0, 12).map((p: XPart) => (
              <li key={p.id} title={healthWords(p.health)} className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-full bg-raised pl-1.5 pr-2.5 text-[12px] font-medium text-ink-2">
                <BrandLogo id={partLogo(p)} size={12} /><span className="truncate">{p.name}</span><span className="shrink-0 font-normal text-muted">{partWhat(p)}</span>
              </li>
            ))}
            {loose.parts.length > 12 && <li className="inline-flex h-7 items-center text-[12px] text-muted">+{loose.parts.length - 12} more</li>}
          </ul>
        )}
        {(loose.parts.length > 0 || loose.unused) && <AiButton prompt={`On ${serverName}, look at what isn't part of a project and help me tidy it up safely. Tell me what each thing is first.`}>Tidy up</AiButton>}
      </div>
    </details>
  );
}

function Projects({ sx, page, serverName, q }: { sx: ServerXray; page: ServerPage; serverName: string; q: string }) {
  const x = sx.x!;
  const own = page.cards.filter((c) => !c.system), sys = page.cards.filter((c) => c.system);
  const needle = q.trim().toLowerCase();
  const shown = needle ? own.filter((c) => [c.name, c.what, ...c.domains, ...c.parts.map((p) => p.name)].some((s) => s.toLowerCase().includes(needle))) : own;
  const maxMem = Math.max(0, ...own.map((c) => c.mem ?? 0));
  const groups = useMemo(() => [...shown.reduce((m, c) => m.set(c.owner, [...(m.get(c.owner) ?? []), c]), new Map<string, Card[]>())]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])), [shown]);
  if (!own.length) return (
    <div className="rounded-[24px] border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="text-[15px] font-semibold">Nothing runs here yet apart from the system</p>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted">Deploy an app and it shows up here as a project.</p>
      <AiButton size="md" className="mt-4" prompt={`Deploy an app to ${serverName}`}>Deploy something here</AiButton>
      <div className="mt-4 text-left"><AlsoHere sys={sys} x={x} page={page} serverName={serverName} /></div>
    </div>
  );
  return (
    <div className="space-y-5">
      {!shown.length && <p className="rounded-[18px] bg-raised px-4 py-6 text-center text-[13px] text-muted">Nothing here matches “{q.trim()}”.</p>}
      {groups.length > 1 ? groups.map(([owner, cs]) => <Group key={owner} owner={owner} cards={cs} page={page} maxMem={maxMem} x={x} forceOpen={!!needle} />)
        : <Grid cards={shown} page={page} maxMem={maxMem} />}
      {!needle && <AlsoHere sys={sys} x={x} page={page} serverName={serverName} />}
    </div>
  );
}

export function AppsTab({ sx, page, serverName, view, onView }: { sx: ServerXray; page: ServerPage; serverName: string; view: AppsView; onView: (v: AppsView) => void }) {
  const [q, setQ] = useState('');
  if (!sx.x) return <CardsSkeleton />;
  const x = sx.x;
  const own = page.cards.filter((c) => !c.system);
  const n = { projects: own.length, domains: x.parts.filter((p) => p.kind === 'domain').length, databases: x.parts.filter((p) => p.kind === 'database').length, jobs: x.parts.filter((p) => p.kind === 'job').length };
  const views = (['projects', 'domains', 'databases', 'jobs'] as const).filter((v) => v === 'projects' || n[v] > 0 || v === view);
  const coolifyOwned = own.filter((c) => c.owner === 'coolify').length;
  return (
    <div className="space-y-4">
      {x.coolify && !x.coolify.connected && coolifyOwned > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[20px] border border-line bg-surface px-4 py-3 shadow-soft">
          <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised"><BrandLogo id="coolify" size={18} /></span>
          <p className="min-w-[200px] flex-1 text-[13px] text-ink-2"><b className="font-semibold text-ink">Coolify runs {coolifyOwned === own.length ? 'all of these' : plural(coolifyOwned, 'of these', 'of these')}.</b> Connect it to restart, deploy and read logs from here. Coolify stays in charge.</p>
          <Button size="sm" variant="primary" onClick={page.connect}>Connect Coolify</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Show" className="flex max-w-full gap-1 overflow-x-auto rounded-full bg-raised p-1">
          {views.map((v) => (
            <button key={v} role="tab" type="button" aria-selected={view === v} onClick={() => onView(v)}
              className={cx('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium capitalize transition', view === v ? 'bg-ink text-bg' : 'text-ink-2 hover:text-ink')}>
              {v}<span className={cx('tabular text-[11.5px]', view === v ? 'text-bg/70' : 'text-muted')}>{n[v]}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {view === 'projects' && own.length > 8 && <SearchInput value={q} onChange={setQ} placeholder="Find a project or domain" label="Find a project" className="w-full min-[520px]:w-[240px] [&_input]:h-9" />}
          {x.coolify && <AiButton prompt={`Make me an app on ${serverName} `}>Build an app here</AiButton>}
        </span>
      </div>
      {view === 'projects' && <Projects sx={sx} page={page} serverName={serverName} q={q} />}
      {view === 'domains' && <DomainsTab sx={sx} page={page} />}
      {view === 'databases' && <DatabasesTab sx={sx} page={page} serverName={serverName} />}
      {view === 'jobs' && <JobsTab sx={sx} page={page} serverName={serverName} />}
      <p className="flex flex-wrap justify-end gap-x-5 gap-y-1 px-1 text-[12.5px] text-muted">
        <AccessLink serverId={x.serverId} />
        <A href="/map" className="inline-flex items-center gap-1 font-medium text-blue-text hover:underline">See how they connect on the Map<ArrowUpRight size={12} /></A>
      </p>
    </div>
  );
}

// the self-hosted apps Unit7 can make its own keys in (Supabase, n8n…), on their own page
function AccessLink({ serverId }: { serverId: string }) {
  const { apps } = useServerApps(serverId);
  if (!apps?.length) return null;
  const on = apps.filter((a) => a.access === 'connected').length;
  return <A href={`/servers/${serverId}/apps`} className="inline-flex items-center gap-1 font-medium text-blue-text hover:underline">App access · {on} of {apps.length} connected<ArrowUpRight size={12} /></A>;
}
