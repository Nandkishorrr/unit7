import { ProjectWarden } from '../mascot/WardenMascot';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Archive, Sparkles, FolderKanban, Plus, Eye, EyeOff, Trash2, Upload, Lock, Link2, Search, Rocket, ArrowUpRight, ChevronDown, Settings2, Copy,
  KeyRound, Globe, ArrowRight, Plug, Gauge as GaugeIcon, SlidersHorizontal, FolderOpen, FlaskConical,
} from 'lucide-react';
import { api, useApi } from '../lib/api';
import { navigate, useQuery } from '../lib/router';
import { BrandLogo, providerName } from '../brand/BrandLogo';
import {
  A, act, AiButton, Badge, Button, Card, CardHeader, ChipSelect, CopyButton, Dialog, Dot, Drawer, Empty, Field, Input, Mono, PageHeader,
  Select, Skeleton, StatusMark, Tabs, Textarea, toast, cx, type MarkState, Illustration,
} from '../ui';
import { ServiceList } from './Services';
import { NewProject } from './NewProject';
import { AskButton, askOnHome } from './Help';
import { LEVELS, LevelPicker, recommendedLevel } from './Autopilot';
import { LifecycleMenu, DeleteDialog, CleanUp, useArchived, KeepStar, UsedPulse } from './lifecycle';
import { ReadinessBadge, ReadinessCard } from './care';
import { Timeline } from './story';
import { ClientFilter, MoveToClientDialog, moveToClientItem, useClientFilter } from './organize';
import { StagingPlanModal } from './make/Staging';
import { EnvSwitcher, setEnvInUrl } from './envs/EnvSwitcher';
import { deployTime, dnsOf, envHealth, envLabel, isDb, isInstant, LogoTile, mainDomain, Menu, sortEnvs, stackLogo, svcState, urlOf, type MenuItem, type Tone, ago } from './kit';

// ---------------------------------------------------------------------------------------------
// What a project looks like at a glance
function summarize(p: any) {
  const envs = sortEnvs<any>(p.environments);
  const svcs = envs.flatMap((e) => e.services.map((s: any) => ({ ...s, env: e })));
  const prod = envs.find((e) => e.kind === 'production');
  const tones = envs.map(envHealth);
  const attention = svcs.filter((s) => svcState(s).tone === 'bad').length + svcs.flatMap((s) => s.domains ?? []).filter((d: any) => d.status === 'broken').length;
  const tone: Tone = attention ? 'bad' : tones.includes('work') ? 'work' : prod && envHealth(prod) === 'ok' ? 'ok' : tones.includes('ok') ? 'ok' : 'idle';
  const main = (prod?.services ?? []).find((s: any) => !isDb(s.kind)) ?? svcs.find((s) => !isDb(s.kind)) ?? svcs[0];
  const last = svcs.map((s) => s.deployment).filter(Boolean).sort((a, b) => deployTime(b) - deployTime(a))[0];
  // the first thing that needs a look, in words, and where it is on the page
  const badSvc = svcs.find((s) => svcState(s).tone === 'bad');
  const badDom = svcs.flatMap((s) => (s.domains ?? []).filter((d: any) => d.status === 'broken').map((d: any) => ({ d, s })))[0];
  const issue = badSvc ? { envId: badSvc.env.id, anchor: `svc-${badSvc.id}`, text: `${badSvc.name} in ${badSvc.env.name} ${svcState(badSvc).word === 'Down' ? 'is down' : 'needs a look'}` }
    : badDom ? { envId: badDom.s.env.id, anchor: 'env-domains', text: `${badDom.d.hostname} isn’t reaching ${badDom.s.name} in ${badDom.s.env.name}` } : null;
  return {
    p, envs, svcs, prod, tone, attention, main, last, issue,
    live: !!prod?.services.some((s: any) => svcState(s).tone === 'ok'),
    domain: prod ? mainDomain(prod.services) : undefined,
    prodApps: prod?.services ?? [],
  };
}
type Summary = ReturnType<typeof summarize>;
const STATUS: Record<Tone, string> = { ok: 'All good', bad: 'Needs a look', work: 'Deploying', warn: 'Needs a look', idle: 'Not live yet' };
const MARK: Record<Tone, MarkState> = { ok: 'ok', bad: 'bad', work: 'work', warn: 'warn', idle: 'off' };

const lastWord = (s: Summary) => (s.last ? `v${s.last.number} · ${ago(s.last.finished_at ?? s.last.started_at)}` : 'Never deployed');

// ---------------------------------------------------------------------------------------------
export function Projects() {
  const graph = useApi<any>('/api/graph');
  const audit = useApi<any[]>('/api/audit?tool=deployment.create&limit=500', { live: (e) => e.type.startsWith('deployment.') });
  const q = useQuery();
  const [open, setOpen] = useState(q.get('new') === '1');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'live' | 'attention'>('all');
  const [cleaning, setCleaning] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const archived = useArchived();
  const clients = useClientFilter();
  const everything = useMemo(() => (graph.data?.projects ?? []).map(summarize)
    .sort((a: Summary, b: Summary) => Number(!!b.attention) - Number(!!a.attention) || deployTime(b.last) - deployTime(a.last)), [graph.data]);
  // archived projects (Unit7 doesn't look at them) sit on a quiet shelf below, out of the counts
  const all = everything.filter((s: Summary) => !archived.has(s.p.id) && clients.has(s.p.id));
  const shelf = everything.filter((s: Summary) => archived.has(s.p.id) && clients.has(s.p.id));
  const shown = all.filter((s: Summary) => (filter === 'all' || (filter === 'live' ? s.live : s.attention > 0)) && s.p.name.toLowerCase().includes(search.trim().toLowerCase()));
  const count = (f: (s: Summary) => boolean) => <span className="tabular ml-1 text-[12px] font-semibold">{all.filter(f).length}</span>;

  return (
    <>
      <PageHeader title="Projects" subtitle="Each app you build, with its live site, its test copies and everything they run on."
        actions={<><ClientFilter /><Button variant="secondary" icon={<Sparkles size={15} />} onClick={() => setCleaning(true)}>Clean up</Button><Button variant="primary" icon={<Plus size={15} />} onClick={() => setOpen(true)}>New project</Button></>} />
      {!graph.data ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 min-[105rem]:grid-cols-4" aria-busy="true" aria-label="Loading projects">
          <Skeleton className="h-[244px] rounded-[24px] lg:col-span-2" /><Skeleton className="h-[244px] rounded-[24px]" /><Skeleton className="h-[244px] rounded-[24px]" />
        </div>
      ) : everything.length === 0 ? (
        <Empty art={<Illustration name="projects" size={112} />} title="No projects yet" body="A project holds one app: its live site, a test copy and a place to try things." action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setOpen(true)}>Create your first project</Button>} />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3 animate-rise">
            <label className="relative min-w-[220px] flex-1 sm:max-w-[340px]">
              <span className="sr-only">Search projects</span>
              <Search size={16} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects"
                className="h-11 w-full rounded-full border border-line bg-surface pl-10 pr-4 text-[14px] text-ink shadow-soft outline-none transition placeholder:text-faint focus:border-blue focus:ring-4 focus:ring-blue-soft" />
            </label>
            <Tabs value={filter} onChange={setFilter} tabs={[
              { value: 'all', label: <>All{count(() => true)}</> },
              { value: 'live', label: <>Live{count((s) => s.live)}</> },
              { value: 'attention', label: <>Needs attention{count((s) => s.attention > 0)}</> },
            ]} />
          </div>
          {shown.length === 0 ? (
            <Empty icon={<Search size={22} />} title="No projects match" body={search ? `Nothing called “${search}” here.` : 'Nothing in this group right now.'}
              action={<Button variant="soft" onClick={() => { setSearch(''); setFilter('all'); }}>Show all projects</Button>} />
          ) : (
            <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 min-[105rem]:grid-cols-4">
              {shown.map((s: Summary, i: number) => <ProjectCard key={s.p.id} s={s} big={i === 0 && shown.length >= 3} audit={audit.data} onChanged={graph.reload} />)}
              <button type="button" onClick={() => setOpen(true)}
                className="illo-host lift group flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-[24px] border-2 border-dashed border-line-strong p-5 text-muted transition-colors hover:border-blue hover:text-blue-text">
                <Illustration name="projects" size={80} />
                <span className="mt-1 inline-flex items-center gap-1.5 text-[14.5px] font-semibold text-ink group-hover:text-blue-text"><Plus size={16} aria-hidden />New project</span>
                <span className="max-w-[240px] text-center text-[12.5px]">From GitHub, a folder, or start empty.</span>
              </button>
            </div>
          )}
        </>
      )}
      <NewProject open={open} canDeploy={!!graph.data?.servers.some((x: any) => x.status === 'ready')} onClose={() => { setOpen(false); if (q.get('new')) navigate('/projects', { replace: true }); }} />
      {shelf.length > 0 && (
        <section className="mt-8" aria-label="Archived projects">
          <button type="button" aria-expanded={shelfOpen} onClick={() => setShelfOpen((v) => !v)}
            className="inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium text-muted transition hover:bg-surface hover:text-ink">
            <Archive size={15} />Archived<span className="tabular rounded-full bg-sunken px-2 py-0.5 text-[11.5px] font-semibold text-ink-2">{shelf.length}</span>
            <ChevronDown size={14} className={cx('transition-transform', shelfOpen && 'rotate-180')} />
          </button>
          {shelfOpen && (
            <>
              <p className="mb-3 ml-3.5 mt-1 text-[12.5px] text-muted">Unit7 won’t watch, alert on or change these. They keep running where they are.</p>
              <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 min-[105rem]:grid-cols-4">
                {shelf.map((s: Summary) => <ProjectCard key={s.p.id} s={s} big={false} audit={audit.data} onChanged={graph.reload} archived />)}
              </div>
            </>
          )}
        </section>
      )}
      <CleanUp open={cleaning} onClose={() => setCleaning(false)} onChanged={graph.reload} />
    </>
  );
}

function ProjectCard({ s, big, audit, onChanged, archived }: { s: Summary; big: boolean; audit?: any[]; onChanged: () => void; archived?: boolean }) {
  const { p } = s;
  const [moving, setMoving] = useState(false);
  const items: MenuItem[] = [
    { label: 'Open project', icon: <FolderOpen size={16} />, href: `/projects/${p.id}` },
    ...(s.domain ? [{ label: 'Visit the live site', icon: <ArrowUpRight size={16} />, onSelect: () => window.open(urlOf(s.domain), '_blank', 'noopener') }] : []),
    moveToClientItem(() => setMoving(true)),
  ];
  return (
    <article className={cx('lift relative flex min-w-0 min-h-[200px] has-[[aria-expanded=true]]:z-30 flex-col rounded-[24px] border border-line bg-surface p-5 shadow-soft md:p-6', big && 'md:col-span-2', archived && 'border-dashed bg-surface/70 shadow-none [&_h2]:text-ink-2')}>
      <div className="flex items-start gap-3.5">
        <span className="relative shrink-0">
          <LogoTile id={s.main ? stackLogo(s.main) : undefined} size={big ? 56 : 48}>{!s.main && <FolderKanban size={20} className="text-muted" />}</LogoTile>
          {/* its health as a live ring on the logo's corner: it breathes while a deploy runs */}
          {!archived && s.svcs.length > 0 && <span className="absolute -bottom-1.5 -right-1.5 grid place-items-center rounded-full bg-surface p-[2px] shadow-soft"><StatusMark state={MARK[s.tone]} size={big ? 20 : 18} label={STATUS[s.tone]} /></span>}
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className={cx('truncate font-semibold tracking-[-0.025em]', big ? 'text-[22px]' : 'text-[18px]')}>
            <A href={`/projects/${p.id}`} className="outline-none after:absolute after:inset-0 after:rounded-[24px] focus-visible:after:ring-2 focus-visible:after:ring-blue">{p.name}</A>
            <KeepStar k={p.id} className="ml-1.5 align-[3px]" />
          </h2>
          {s.domain ? (
            <a href={urlOf(s.domain)} target="_blank" rel="noopener" className="relative z-10 inline-flex max-w-full items-center gap-1 text-[13px] font-medium text-blue-text hover:underline">
              <span className="truncate">{s.domain.hostname}</span><ArrowUpRight size={13} className="shrink-0" />
            </a>
          ) : <p className="text-[13px] text-muted">{s.svcs.length ? 'Not in production yet' : 'Nothing deployed yet'}</p>}
          {/* when it was last used, from the strongest sign Unit7 has (nothing when nothing is known) */}
          {!archived && <div className="mt-1 flex min-w-0 empty:hidden"><UsedPulse k={p.id} except={['Deployed']} /></div>}
        </div>
        <div className="relative z-10 flex items-center gap-2">
          {archived ? <Badge>Archived</Badge> : s.attention > 0 && <span className="hidden sm:block" title={s.issue?.text}><Badge tone="bad" solid>{s.attention} need{s.attention === 1 ? 's' : ''} a look</Badge></span>}
          {!archived && <ReadinessBadge projectId={p.id} />}
          <LifecycleMenu item={{ key: p.id, name: p.name, kind: 'project', provider: 'unit7', projectId: p.id }} items={items} onChanged={onChanged} />
        </div>
      </div>
      <MoveToClientDialog item={{ key: p.id, name: p.name }} open={moving} onClose={() => setMoving(false)} onMoved={onChanged} />

      <div className="mt-4 flex flex-wrap gap-1.5">
        {s.envs.length ? s.envs.map((e: any) => <EnvPill key={e.id} e={e} />) : (
          <p className="relative z-10 w-full rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">
            An empty project. <A href={`/projects/${p.id}`} className="font-medium text-blue-text hover:underline">Add an environment</A>, then deploy into it.
          </p>
        )}
        {s.attention > 0 && <span className="sm:hidden" title={s.issue?.text}><Badge tone="bad" solid>{s.attention} need{s.attention === 1 ? 's' : ''} a look</Badge></span>}
      </div>

      {s.svcs.length > 0 && (big ? (
        <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="What runs in it">
          {s.svcs.slice(0, 6).map((x: any) => (
            <li key={x.id} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line pl-1 pr-3 text-[12.5px] font-medium">
              <span className="grid size-6 place-items-center rounded-full bg-raised"><BrandLogo id={stackLogo(x)} size={14} /></span>{x.name}<span className="font-normal text-muted">· {envLabel(x.env)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-4 flex items-center gap-2.5">
          <span className="flex -space-x-1.5">
            {[...new Set(s.svcs.map((x: any) => stackLogo(x)))].slice(0, 4).map((id) => <span key={id} className="grid size-7 place-items-center rounded-full bg-raised ring-2 ring-surface"><BrandLogo id={id} size={14} /></span>)}
          </span>
          <span className="text-[12.5px] text-muted">{s.svcs.length} app{s.svcs.length === 1 ? '' : 's'} across {s.envs.filter((e: any) => e.services.length).length} environment{s.envs.filter((e: any) => e.services.length).length === 1 ? '' : 's'}</span>
        </div>
      ))}

      <div className="mt-auto flex items-end justify-between gap-4 pt-6">
        <div className="min-w-0">
          <p className="text-[12px] text-muted">Last deploy</p>
          <p className="tabular truncate text-[15px] font-semibold tracking-[-0.01em]">{lastWord(s)}</p>
        </div>
        <DeployBars rows={audit} projectId={p.id} big={big} />
      </div>
    </article>
  );
}

const ENV_DOT: Record<Tone, 'ok' | 'bad' | 'work' | 'idle' | 'warn'> = { ok: 'ok', bad: 'bad', work: 'work', idle: 'idle', warn: 'warn' };
function EnvPill({ e }: { e: any }) {
  const t = envHealth(e);
  return (
    <span title={`${e.name}: ${e.services.length ? STATUS[t].toLowerCase() : 'empty'}`} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-raised px-2.5 text-[12px] font-medium text-ink-2">
      <Dot tone={ENV_DOT[t]} working={t === 'work'} />{envLabel(e)}
    </span>
  );
}

// deploys over the last 7 days: one little bar a day, the failed part on top in red
function DeployBars({ rows, projectId, big }: { rows?: any[]; projectId: string; big?: boolean }) {
  const days = useMemo(() => {
    const out = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i)); return { date: d, ok: 0, bad: 0 }; });
    for (const a of rows ?? []) {
      if (a.project_id !== projectId) continue;
      const t = new Date(a.created_at); t.setHours(0, 0, 0, 0);
      const day = out.find((d) => d.date.getTime() === t.getTime());
      if (day) { if (a.result === 'success') day.ok++; else if (a.result === 'error') day.bad++; }
    }
    return out;
  }, [rows, projectId]);
  const max = Math.max(1, ...days.map((d) => d.ok + d.bad));
  const total = days.reduce((n, d) => n + d.ok + d.bad, 0);
  const h = big ? 44 : 32;
  if (!rows) return <span className="skeleton block h-8 w-[76px]" />;
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div role="img" aria-label={`${total} deploy${total === 1 ? '' : 's'} in the last 7 days`} className={cx('flex items-end', big ? 'gap-1.5' : 'gap-1')} style={{ height: h }}>
        {days.map((d, i) => {
          const n = d.ok + d.bad;
          return (
            <span key={i} title={`${d.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${n} deploy${n === 1 ? '' : 's'}${d.bad ? `, ${d.bad} didn’t work` : ''}`}
              className={cx('animate-grow flex flex-col overflow-hidden rounded-full', big ? 'w-2.5' : 'w-[7px]', !n && 'bg-sunken')}
              style={{ height: n ? `${30 + (n / max) * 70}%` : 4, animationDelay: `${250 + i * 40}ms` }}>
              {n > 0 && <><span className="w-full shrink-0 bg-bad-solid" style={{ height: `${(d.bad / n) * 100}%` }} /><span className="w-full flex-1 bg-blue" /></>}
            </span>
          );
        })}
      </div>
      <span className="text-[11px] text-muted">{total ? `${total} this week` : 'quiet week'}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
export function ProjectDetail({ id }: { id: string }) {
  const graph = useApi<any>(`/api/graph?projectId=${id}`);
  const q = useQuery();
  const [envId, setEnvId] = useState<string | null>(q.get('env'));
  const [panel, setPanel] = useState<'settings' | 'rules' | 'accounts' | null>(q.get('tab') === 'settings' ? 'settings' : q.get('tab') === 'policy' ? 'rules' : null);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [staging, setStaging] = useState(false);
  // keep showing the project while its delete dialog finishes, after it's gone from the list
  const kept = useRef<any>(null);
  const raw = graph.data?.projects[0] ?? (deleting ? kept.current : undefined);
  if (raw) kept.current = raw;
  const s = useMemo(() => (raw ? summarize(raw) : null), [raw]);
  useEffect(() => {
    if (s && (!envId || !s.envs.some((e: any) => e.id === envId))) setEnvId((s.prod ?? s.envs[0])?.id ?? null);
  }, [s, envId]);
  // a link like ?env=…&tab=variables (Warden's "Set them") opens that environment's Variables, even from this same page
  const wantEnv = q.get('env'), wantTab = q.get('tab');
  useEffect(() => { if (wantEnv) setEnvId(wantEnv); }, [wantEnv]);
  useEffect(() => { if (s && wantTab === 'variables') requestAnimationFrame(() => document.getElementById('variables')?.scrollIntoView({ behavior: 'smooth' })); }, [!!s, wantEnv, wantTab]);
  if (graph.loading && !s) return <div className="space-y-4"><Skeleton className="h-[230px] rounded-[24px]" /><Skeleton className="h-[300px] rounded-[24px]" /></div>;
  if (!s) return <Empty title="Project not found" body="It may have been deleted, or it belongs to another organization." action={<A href="/projects" className="font-medium text-blue-text hover:underline">Back to projects</A>} />;
  const p = s.p;
  const env = s.envs.find((e: any) => e.id === envId);
  const blocked = s.prodApps.length > 0;
  const menu: MenuItem[] = [
    { label: 'Make a test copy', icon: <FlaskConical size={16} />, hint: 'A staging copy to try changes safely', onSelect: () => setStaging(true) },
    { label: 'Project settings', icon: <Settings2 size={16} />, onSelect: () => setPanel('settings') },
    { label: 'Copy project ID', icon: <Copy size={16} />, onSelect: () => { void navigator.clipboard.writeText(p.id); toast('ok', 'Copied the project ID'); } },
    moveToClientItem(() => setMoving(true)),
  ];
  const item = { key: p.id, name: p.name, kind: 'project', provider: 'unit7', projectId: p.id };

  return (
    <>
      <ProjectHero s={s} env={env} menu={menu} item={item} onIssue={() => {
        const it = s.issue;
        if (!it) return;
        setEnvId(it.envId);
        setTimeout(() => {
          const el = document.getElementById(it.anchor);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (el && !matchMedia('(prefers-reduced-motion: reduce)').matches) el.animate([{ boxShadow: '0 0 0 4px rgb(220 38 38 / 0.35)' }, { boxShadow: '0 0 0 4px transparent' }], { duration: 1600, delay: 300, easing: 'ease-out' });
        }, 80);
      }} />
      {s.envs.length === 0 ? (
        <Empty art={<Illustration name="deploy" size={96} />} title="No environments yet" body="Add one to give your app a place to run, like production for the live site." action={<NewEnvButton projectId={p.id} primary />} />
      ) : (
        <>
          {/* Production · Staging · Development: the pick is in the URL (?env=), and everything below follows it */}
          <div className="mb-5 flex flex-wrap items-center gap-3 animate-rise">
            <EnvSwitcher project={p} envId={env?.id} onSelect={(e) => { setEnvId(e.id); setEnvInUrl(e.id); }} onChanged={() => graph.reload()} className="min-w-0 flex-1" />
            <NewEnvButton projectId={p.id} />
          </div>
          {env && (
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
              <div className="space-y-4 lg:col-span-8">
                <section aria-label={`What runs in ${env.name}`}><ServiceList project={p} env={env} servers={graph.data.servers} /></section>
                <div id="variables" className="scroll-mt-24 animate-rise"><EnvVars scope={{ environmentId: env.id }} projectId={p.id} envName={env.name} /></div>
              </div>
              <div className="stagger space-y-4 lg:col-span-4">
                <ReadinessCard projectId={p.id} />
                <AutonomyCard env={env} onRules={() => setPanel('rules')} />
                <div id="env-domains" className="scroll-mt-24 rounded-[24px]"><EnvDomains env={env} projectId={p.id} /></div>
                <EnvAccountsCard env={env} onChange={() => setPanel('accounts')} />
              </div>
            </div>
          )}
        </>
      )}
      <Timeline projectId={p.id} title={`What changed in ${p.name}`} className="mt-4" />
      <div className="mt-8"><ProjectWarden projectId={p.id} /></div>
      <Drawer open={panel === 'settings'} onClose={() => setPanel(null)} title="Project settings">
        <ProjectSettings p={p} env={env} blocked={blocked} onDelete={() => { setPanel(null); setDeleting(true); }} />
      </Drawer>
      <Drawer open={panel === 'rules' && !!env} onClose={() => setPanel(null)} title={`Rules in ${env?.name ?? ''}`}>{env && <Rules envId={env.id} />}</Drawer>
      <Drawer open={panel === 'accounts' && !!env} onClose={() => setPanel(null)} title={`Accounts ${env?.name ?? ''} uses`}>{env && <EnvAccounts env={env} />}</Drawer>
      <MoveToClientDialog item={{ key: p.id, name: p.name }} open={moving} onClose={() => setMoving(false)} />
      <StagingPlanModal target={{ projectId: p.id, name: p.name }} open={staging} onClose={() => setStaging(false)} />
      <DeleteDialog item={item} open={deleting} onClose={() => { setDeleting(false); if (!graph.data?.projects[0]) navigate('/projects'); }} onDeleted={() => graph.reload()} />
    </>
  );
}

// logo, name, address, the one big status, and the three things to do
function ProjectHero({ s, env, menu, item, onIssue }: { s: Summary; env: any; menu: MenuItem[]; item: { key: string; name: string; kind: string; provider: string; projectId: string }; onIssue: () => void }) {
  const { p } = s;
  const deployable = (env?.services ?? []).filter((x: any) => !isDb(x.kind));
  const url = s.domain ?? (env ? mainDomain(env.services) : undefined);
  const live = s.svcs.filter((x) => svcState(x).tone === 'ok').length;
  const deploy = (x: any) => act('deployment.create', { serviceId: x.id }, { success: `Deploying ${x.name}` });
  const tone = s.tone;
  return (
    <Card className="mb-6 animate-rise">
      <div className="flex flex-wrap items-start gap-4 p-5 md:p-7">
        <LogoTile id={s.main ? stackLogo(s.main) : undefined} size={64}>{!s.main && <FolderKanban size={26} className="text-muted" />}</LogoTile>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-muted"><A href="/projects" className="hover:text-ink hover:underline">Projects</A> <span aria-hidden>/</span></p>
          <h1 className="truncate text-[30px] font-semibold leading-tight tracking-[-0.04em] md:text-[36px]">{p.name}<KeepStar k={p.id} className="ml-2 align-[6px]" /></h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13.5px]">
            {url ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <a href={urlOf(url)} target="_blank" rel="noopener" className="truncate font-medium text-blue-text hover:underline">{url.hostname}</a><CopyButton text={urlOf(url)} />
              </span>
            ) : <span className="text-muted">No address yet</span>}
            {p.repo && <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-2"><BrandLogo id="github" size={15} /><span className="truncate">{p.repo}</span></span>}
            <UsedPulse k={p.id} except={['Deployed']} />
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {deployable.length > 1 ? (
            <Menu label="Deploy" align="right" items={deployable.map((x: any) => ({ label: `Deploy ${x.name}`, hint: x.deployment ? `Now v${x.deployment.number}` : 'First deploy', icon: <BrandLogo id={stackLogo(x)} size={16} />, onSelect: () => void deploy(x) }))}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-blue px-4.5 text-[13.5px] font-medium text-white transition hover:brightness-110">
              <Rocket size={15} />Deploy<ChevronDown size={14} />
            </Menu>
          ) : (
            deployable.length ? <Button variant="primary" icon={<Rocket size={15} />} onClick={() => void deploy(deployable[0])}>Deploy</Button>
              : <AiButton strong title={`Nothing runs in ${env?.name ?? 'this project'} yet. Unit7 can put your app here.`}
                  onClick={() => askOnHome(`Deploy ${p.repo ?? p.name} to ${(env?.name ?? 'production').toLowerCase()} and give me the link`)}>Deploy here</AiButton>
          )}
          {url ? <a href={urlOf(url)} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4.5 text-[13.5px] font-medium text-bg transition hover:opacity-90"><ArrowUpRight size={15} />Open</a>
            : <Button variant="dark" disabled icon={<ArrowUpRight size={15} />}>Open</Button>}
          <LifecycleMenu item={item} items={menu} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 rounded-b-[23px] border-t border-line bg-raised/40 px-5 py-5 md:px-7">
        <div className="flex items-center gap-3.5">
          <StatusMark state={s.svcs.length ? MARK[tone] : 'off'} size={48} solid={tone === 'ok' || tone === 'bad'} label={s.svcs.length ? STATUS[tone] : 'Empty'} />
          <div>
            <p className="text-[12.5px] text-muted">Status</p>
            <p className="text-[28px] font-semibold leading-none tracking-[-0.04em] md:text-[34px]">{s.svcs.length ? STATUS[tone] : 'Empty'}</p>
            {s.issue && <button type="button" onClick={onIssue} className="mt-1.5 inline-flex items-center gap-1 rounded-full text-left text-[13px] font-medium text-bad hover:underline">{s.issue.text}<span className="whitespace-nowrap">· Show me<ArrowRight size={13} className="ml-0.5 inline" /></span></button>}
            {s.issue && <div className="mt-2.5"><AskButton variant="primary" about={{ kind: 'project', id: p.id, name: p.name }} prompt={`In ${p.name}: ${s.issue.text}. Find out why and fix it, and tell me what changes first.`} /></div>}
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[13px]">
          <div><dt className="text-muted">Apps live</dt><dd className="tabular text-[17px] font-semibold">{live}<span className="text-faint"> / {s.svcs.length}</span></dd></div>
          <div><dt className="text-muted">Environments</dt><dd className="tabular text-[17px] font-semibold">{s.envs.length}</dd></div>
          <div><dt className="text-muted">Last deploy</dt><dd className="tabular text-[17px] font-semibold">{lastWord(s)}</dd></div>
          {s.attention > 0 && <div><dt className="text-muted">Needs a look</dt><dd><button type="button" onClick={onIssue} title={s.issue?.text} className="tabular rounded-md text-[17px] font-semibold text-bad underline decoration-bad/40 underline-offset-4 hover:decoration-bad">{s.attention}</button></dd></div>}
        </dl>
      </div>
    </Card>
  );
}

function NewEnvButton({ projectId, primary }: { projectId: string; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <>
      <Button size={primary ? 'md' : 'sm'} variant={primary ? 'primary' : 'soft'} icon={<Plus size={14} />} onClick={() => setOpen(true)}>Add environment</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add an environment">
        <form onSubmit={async (e) => { e.preventDefault(); if (await act('environment.create', { projectId, name }, { success: `Added ${name}` })) { setOpen(false); setName(''); } }} className="space-y-4">
          <Field label="Name" hint="For example preview, qa or demo."><Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary">Add</Button></div>
        </form>
      </Dialog>
    </>
  );
}

// --- how much Unit7 may do by itself, 0–4: the same control and words as Autopilot ---

function AutonomyCard({ env, onRules }: { env: any; onRules: () => void }) {
  const [v, setV] = useState<number>(env.autonomy);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setV(env.autonomy), [env.id, env.autonomy]);
  useEffect(() => () => clearTimeout(t.current), []);
  const change = (n: number) => {
    setV(n);
    clearTimeout(t.current);
    t.current = setTimeout(async () => { if (!(await act('environment.policy', { environmentId: env.id, autonomy: n }, { success: `${env.name}: ${LEVELS[n]!.name.toLowerCase()}` }))) setV(env.autonomy); }, 600);
  };
  const rec = recommendedLevel(env.kind);
  return (
    <Card className="p-5">
      <CardHeader icon={<GaugeIcon size={19} />} title="On its own" sub={`What Unit7 may do in ${env.name}`} />
      <div className="mt-5 flex items-start gap-3">
        <p className="tabular text-[44px] font-semibold leading-[0.9] tracking-[-0.05em]">{v}<span className="text-[18px] font-medium tracking-normal text-faint">/4</span></p>
        <p className="pt-0.5 text-[13.5px] leading-snug text-muted" aria-live="polite"><span className="block font-medium text-ink">{LEVELS[v]?.name}{v === rec && <Badge tone="lime" className="ml-1.5 align-middle">Recommended</Badge>}</span>{LEVELS[v]?.means}</p>
      </div>
      <LevelPicker className="mt-5" value={v} onChange={change} rec={rec} label={`How much Unit7 may do on its own in ${env.name}`} />
      {v !== rec && <button type="button" onClick={() => change(rec)} className="mt-3 inline-flex items-center gap-1.5 rounded-full text-[13px] font-medium text-blue-text hover:underline"><span aria-hidden className="size-2 rounded-full bg-lime ring-1 ring-lime-ink/30" />Use the recommended level</button>}
      <button type="button" onClick={onRules} className="mt-4 inline-flex items-center gap-1.5 rounded-full text-[13px] font-medium text-blue-text hover:underline"><SlidersHorizontal size={14} />Fine-tune the rules</button>
    </Card>
  );
}

function EnvDomains({ env, projectId }: { env: any; projectId: string }) {
  const dns = dnsOf(env);
  const rows = env.services.flatMap((s: any) => (s.domains ?? []).map((d: any) => ({ ...d, s })));
  return (
    <Card className="p-5">
      <CardHeader icon={<Globe size={19} />} title="Domains" sub={rows.length ? `${rows.length} in ${env.name}` : `None in ${env.name}`} />
      {rows.length === 0 ? (
        <div className="mt-4 rounded-[16px] bg-raised px-4 py-3">
          <p className="text-[13px] text-muted">{env.services.some((x: any) => !isDb(x.kind)) ? 'Give it a real address. Unit7 sets up DNS and HTTPS for you.' : 'Once an app runs here, it can get its own address.'}</p>
          {env.services.some((x: any) => !isDb(x.kind)) && <AskButton className="mt-2.5" label="Connect a domain" prompt={`Connect a domain to ${env.services.find((x: any) => !isDb(x.kind))?.name ?? 'my app'} in ${env.name}`} />}
        </div>
      ) : (
        <ul className="mt-4 space-y-1">
          {rows.map((d: any) => {
            const instant = isInstant(d.hostname);
            const st = d.status === 'broken' ? ['bad', 'Broken'] : d.status !== 'active' ? ['warn', 'Setting up'] : d.tls !== 'active' ? ['warn', 'HTTPS soon'] : ['ok', 'Working'];
            return (
              <li key={d.id} className="-mx-2 flex items-center gap-3 rounded-[14px] px-2 py-2 hover:bg-raised">
                <LogoTile id={instant ? 'unit7' : dns} size={32}>{!instant && !dns && <Globe size={15} className="text-muted" />}</LogoTile>
                <div className="min-w-0 flex-1">
                  <a href={urlOf(d)} target="_blank" rel="noopener" className="block truncate text-[13.5px] font-medium hover:underline">{d.hostname}</a>
                  <A href={`/projects/${projectId}/services/${d.s.id}`} className="block truncate text-[12px] text-muted hover:text-ink">{instant ? 'Instant link' : dns ? `DNS at ${providerName(dns)}` : 'Custom domain'} · {d.s.name}</A>
                </div>
                <Badge tone={st[0] as 'ok' | 'bad' | 'warn'} solid={st[0] === 'bad'}>{st[1]}</Badge>
                {d.status === 'broken' && <AskButton label="Fix" variant="primary" prompt={`${d.hostname} isn’t reaching ${d.s.name} in ${env.name}. Find out why and fix it.`} />}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function EnvAccountsCard({ env, onChange }: { env: any; onChange: () => void }) {
  return (
    <Card className="p-5">
      <CardHeader icon={<Plug size={19} />} title="Accounts" sub={`What ${env.name} signs in with`} actions={<Button size="sm" variant="soft" onClick={onChange}>Change</Button>} />
      {env.accounts.length === 0 ? <p className="mt-4 text-[13px] text-muted">None picked yet. Unit7 asks the first time it needs one.</p> : (
        <ul className="mt-4 flex flex-wrap gap-2">
          {env.accounts.map((a: any) => (
            <li key={a.id} title={a.name} className="inline-flex h-9 max-w-full items-center gap-2 rounded-full bg-raised pl-1.5 pr-3 text-[12.5px] font-medium">
              <span className="grid size-6 place-items-center rounded-full bg-surface"><BrandLogo id={a.provider} size={14} /></span>
              <span className="truncate">{a.name.includes('·') ? a.name : providerName(a.provider)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- variables ---
export function EnvVars({ scope, projectId, envName }: { scope: Record<string, string>; projectId: string; envName: string }) {
  const [level, setLevel] = useState<'environment' | 'project'>('environment');
  const target = level === 'project' ? { projectId } : scope;
  const [data, setData] = useState<any>(null);
  const load = async () => {
    const r = await api('/api/tools/env.list', { body: { input: target } });
    setData(r.status === 'ok' ? r.output : { variables: [] });
  };
  useEffect(() => { void load(); }, [JSON.stringify(target)]);
  const [edit, setEdit] = useState<{ key: string; value: string; secret: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const reveal = async (key: string) => {
    if (revealed[key] !== undefined) { const { [key]: _x, ...rest } = revealed; setRevealed(rest); return; }
    const r = await act('env.reveal', { ...target, key });
    if (r) setRevealed({ ...revealed, [key]: r.output.value ?? r.output.reference });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const r = await act('env.set', { ...target, key: edit.key, value: edit.value, secret: edit.secret || undefined }, { success: `Saved ${edit.key}` });
    if (r) { (r.output.warnings ?? []).forEach((w: string) => toast('warn', 'Heads up', w)); setEdit(null); void load(); }
  };

  return (
    <Card className="p-5 md:p-6">
      <CardHeader icon={<KeyRound size={19} />} title="Variables" sub={level === 'project' ? 'Shared by every environment' : `Settings your app reads in ${envName}. Secrets stay hidden.`}
        actions={
          <div className="hidden items-center gap-2 sm:flex">
            <ChipSelect label="Which variables" value={level} onChange={(v) => setLevel(v as 'environment' | 'project')} options={[{ value: 'environment', label: `${envName} only` }, { value: 'project', label: 'All environments' }]} />
            <Button size="sm" variant="soft" icon={<Upload size={13} />} onClick={() => setImporting(true)}>Import .env</Button>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setEdit({ key: '', value: '', secret: false })}>Add</Button>
          </div>
        } />
      <div className="mt-4 flex flex-wrap gap-2 sm:hidden">
        <ChipSelect label="Which variables" value={level} onChange={(v) => setLevel(v as 'environment' | 'project')} options={[{ value: 'environment', label: `${envName} only` }, { value: 'project', label: 'All environments' }]} />
        <Button size="sm" variant="soft" icon={<Upload size={13} />} onClick={() => setImporting(true)}>Import</Button>
        <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setEdit({ key: '', value: '', secret: false })}>Add</Button>
      </div>
      {!data ? <Skeleton className="mt-5 h-32" /> : data.variables.length === 0 ? (
        <p className="mt-5 rounded-[16px] bg-raised px-4 py-6 text-center text-[13.5px] text-muted">No variables yet. Add one, or paste your .env file: secrets are spotted and locked away automatically.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {data.variables.map((v: any) => (
            <li key={v.key} className="flex items-center gap-3 py-2.5">
              <span className={cx('grid size-8 shrink-0 place-items-center rounded-[10px]', v.secret ? 'bg-ink text-bg' : 'bg-raised text-muted')}>{v.secret ? <Lock size={13} /> : <KeyRound size={13} />}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Mono className="truncate text-[13px] font-medium text-ink">{v.key}</Mono>
                  {v.reference && <Badge tone="info"><Link2 size={10} />vault</Badge>}
                  {v.from !== (level === 'project' ? 'project' : 'environment') && <Badge>from {v.from}</Badge>}
                  {v.public && v.secret && <Badge tone="bad">visible in the browser</Badge>}
                </div>
                <p className="mt-0.5 truncate font-mono text-[12px] text-muted">{revealed[v.key] ?? (v.secret ? '••••••••••••' : v.value)}</p>
              </div>
              <span className="hidden text-[11.5px] text-faint md:block">v{v.version} · {ago(v.updatedAt)}</span>
              <button aria-label={revealed[v.key] !== undefined ? `Hide ${v.key}` : `Show ${v.key}`} onClick={() => reveal(v.key)} className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink">{revealed[v.key] !== undefined ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              <button aria-label={`Remove ${v.key}`} onClick={async () => { if (confirm(`Remove ${v.key}?`) && await act('env.unset', { ...target, key: v.key }, { success: `Removed ${v.key}` })) void load(); }} className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-bad"><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!edit} onClose={() => setEdit(null)} title="Set a variable">
        {edit && (
          <form onSubmit={save} className="space-y-4">
            <Field label="Name"><Input autoFocus required value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} placeholder="DATABASE_URL" className="font-mono" /></Field>
            <Field label="Value" hint="Saved encrypted. Your app gets it when it starts."><Textarea required rows={3} value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} className="font-mono" /></Field>
            <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={edit.secret} onChange={(e) => setEdit({ ...edit, secret: e.target.checked })} /> Keep it secret (spotted automatically for most)</label>
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary">Save</Button></div>
          </form>
        )}
      </Dialog>
      <ImportDialog open={importing} onClose={() => setImporting(false)} target={target} onDone={load} />
    </Card>
  );
}

function ImportDialog({ open, onClose, target, onDone }: { open: boolean; onClose: () => void; target: object; onDone: () => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog open={open} onClose={onClose} title="Import a .env file" wide>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const r = await act('env.import', { ...target, dotenv: text });
        if (r) {
          toast('ok', `Imported ${r.output.imported} variables`, r.output.secrets.length ? `${r.output.secrets.length} spotted as secrets and locked away.` : undefined);
          r.output.warnings.forEach((w: string) => toast('warn', 'Heads up', w));
          setText(''); onClose(); onDone();
        }
      }} className="space-y-4">
        <Textarea autoFocus rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'DATABASE_URL=postgres://…\nSTRIPE_SECRET_KEY=sk_live_…\nPORT=3000'} className="font-mono text-[12.5px]" />
        <p className="text-[12.5px] text-muted">Values are encrypted the moment they arrive. Unit7 spots secrets and warns you if one would end up in the browser.</p>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary">Import</Button></div>
      </form>
    </Dialog>
  );
}

// --- accounts bound to an environment ---
function EnvAccounts({ env }: { env: any }) {
  const [accounts, setAccounts] = useState<any[] | null>(null);
  const load = async () => { const r = await api('/api/tools/account.list', { body: { input: {} } }); setAccounts(r.status === 'ok' ? r.output : []); };
  useEffect(() => { void load(); }, [env.id]);
  const providers = [...new Set((accounts ?? []).map((a) => a.provider))];
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">{env.name} uses one account per service. Unit7 never uses another account here, so client work never mixes.</p>
      {!accounts ? <Skeleton className="h-24" /> : providers.length === 0 ? (
        <Empty title="No accounts connected" body="Connect Hostinger, Cloudflare, GitHub and others first." action={<A href="/connections" className="text-[13px] font-medium text-blue-text hover:underline">Connect an account</A>} />
      ) : (
        <ul className="space-y-2">
          {providers.map((prov) => {
            const bound = env.accounts.find((a: any) => a.provider === prov);
            return (
              <li key={prov} className="flex items-center gap-3 rounded-[16px] bg-raised p-2.5">
                <LogoTile id={prov} size={36} className="bg-surface" />
                <span className="w-24 truncate text-[13.5px] font-medium">{providerName(prov)}</span>
                <Select className="min-w-0 flex-1" value={bound?.id ?? ''} onChange={async (accountId) => { if (accountId && await act('account.bind', { environmentId: env.id, accountId }, { success: 'Saved' })) void load(); }}
                  options={[{ value: '', label: 'Not set' }, ...(accounts ?? []).filter((a) => a.provider === prov).map((a) => ({ value: a.id, label: a.name }))]} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// --- the fine print under the autonomy level ---
const RULES: [string, string][] = [
  ['deploy', 'Put out a new version'], ['rollback', 'Go back to an older version'], ['restart_service', 'Restart an app'], ['backup', 'Take a backup'], ['restore', 'Restore a backup'],
  ['env_write', 'Change variables'], ['database_write', 'Change database data'], ['database_delete', 'Delete database data'], ['drop_database', 'Delete a whole database'],
  ['dns_write', 'Change DNS'], ['server_exec', 'Run commands on a server'], ['destroy_server', 'Delete a server'], ['provider_purchase', 'Buy something (domains, servers)'],
  ['vault_write', 'Save secrets'], ['vault_delete', 'Delete secrets'],
];
function Rules({ envId }: { envId: string }) {
  const [env, setEnv] = useState<any>(null);
  const load = async () => {
    const r = await api('/api/tools/environment.get', { body: { input: { environmentId: envId } } });
    setEnv(r.status === 'ok' ? r.output : { error: r.status === 'denied' ? r.why : r.error?.message });
  };
  useEffect(() => { void load(); }, [envId]);
  if (!env) return <Skeleton className="h-64" />;
  if (env.error) return <Empty title="Couldn’t load the rules" body={env.error} />;
  // rules are saved as overrides on top of the environment's defaults; "Use the level" drops the override
  const setRule = async (k: string, v: string) => {
    const { [k]: _old, ...rest } = env.overrides ?? {};
    if (await act('environment.policy', { environmentId: envId, rules: v === 'default' ? rest : { ...rest, [k]: v } }, { success: 'Saved' })) void load();
  };
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">These apply to everyone, people and AI. “Use the level” follows the slider.</p>
      <ul className="divide-y divide-line">
        {RULES.map(([k, label]) => (
          <li key={k} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 text-[13px] text-ink-2">{label}</span>
            <Select value={env.rules[k] ?? 'default'} onChange={(v) => setRule(k, v)} options={[{ value: 'default', label: 'Use the level' }, { value: 'allowed', label: 'Always OK' }, { value: 'restricted', label: 'Ask me first' }, { value: 'prohibited', label: 'Never' }]} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectSettings({ p, env, blocked, onDelete }: { p: any; env: any; blocked: boolean; onDelete: () => void }) {
  const [name, setName] = useState(p.name);
  const [repo, setRepo] = useState(p.repo ?? '');
  const ids: [string, string][] = [['Project', p.id], ...(env ? [[`Environment (${env.name})`, env.id] as [string, string]] : [])];
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Code on GitHub"><Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" /></Field>
        <div className="flex justify-end"><Button variant="primary" onClick={() => act('project.update', { projectId: p.id, name, repo: repo || undefined }, { success: 'Saved' })}>Save</Button></div>
      </section>
      <section>
        <h3 className="mb-2 text-[13px] font-medium text-muted">IDs, for your AI or scripts</h3>
        <ul className="divide-y divide-line rounded-[18px] bg-raised">
          {ids.map(([k, v]) => <li key={k} className="flex items-center gap-3 px-4 py-2.5"><span className="w-36 shrink-0 text-[12.5px] text-muted">{k}</span><Mono className="min-w-0 flex-1 truncate">{v}</Mono><CopyButton text={v} /></li>)}
        </ul>
      </section>
      <section className="rounded-[20px] border border-bad/25 p-4">
        <h3 className="text-[14px] font-semibold">Danger zone</h3>
        <p className="mt-1 text-[13px] text-muted">{blocked ? 'Production is live, so deleting stops it first, then deletes everything. You see what goes and what stays before anything happens.' : 'Deletes the project and everything in it. Your servers and your code stay.'}</p>
        <Button className="mt-3" variant="danger" size="sm" icon={<Trash2 size={13} />} onClick={onDelete}>Delete project…</Button>
      </section>
    </div>
  );
}
