// Activity: everything that happened, by day, in plain words. Filter by kind, search, and open a
// row for its details (the raw message is there too, small). "Who did what" is the full record of
// every action, for when you need to know exactly who changed what.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity as ActivityIcon, ChevronDown, Eye, EyeOff, Rocket, Globe, DatabaseBackup, Server, Box, ShieldCheck, Sparkles, Shield, Wallet, Siren, RefreshCw, Plug, CircleDot, Wrench, KeyRound, Bot, ArrowUpRight, CircleAlert, SearchX, Network, Undo2,
} from 'lucide-react';
import { onLive, runTool, useApi, type LiveEvent } from '../lib/api';
import { ExplainBlock, SnoozeMenu, bringBack, useHidden } from './explain';
import { navigate } from '../lib/router';
import { eventKind, eventWords, foldEchoes, PROVIDER_NAMES, providerName, rawWords, tidy, toolWords, whoWords, type Said, type Tone } from '../lib/words';
import { A, act, Badge, Button, Card, Dot, Empty, IconCircle, PageHeader, SearchInput, Skeleton, Switch, Tabs, cx, timeAgo, Illustration } from '../ui';
import { BrandLogo } from '../brand/BrandLogo';
import { LOGOS } from '../brand/logos.generated';
import { AskButton } from './Help';
import { ReplayButton, replayFor } from './story';
import { ReleaseTimeline } from './release';

export function ActivityPage() {
  const [view, setView] = useState<'events' | 'record'>('events');
  return (
    <>
      <PageHeader title="Activity" subtitle="Everything that happened, in plain words."
        actions={<Tabs value={view} onChange={setView} tabs={[{ value: 'events', label: 'What happened' }, { value: 'record', label: 'Who did what' }]} />} />
      {view === 'events' ? <Timeline /> : <Record />}
    </>
  );
}

// --- names for ids, from the graph ---------------------------------------------------------------------
export interface Names { name: (id?: string | null) => string | undefined; href: (id?: string | null) => string | undefined; project: (id?: string | null) => string | undefined }
export function useNames(): Names {
  const g = useApi<any>('/api/graph', { live: false });
  return useMemo(() => {
    const map = new Map<string, { name: string; href: string }>();
    for (const p of g.data?.projects ?? []) {
      map.set(p.id, { name: p.name, href: `/projects/${p.id}` });
      for (const e of p.environments ?? []) for (const s of e.services ?? []) map.set(s.id, { name: s.name, href: `/projects/${p.id}/services/${s.id}` });
    }
    for (const s of g.data?.servers ?? []) map.set(s.id, { name: s.name, href: `/servers/${s.id}` });
    return { name: (id) => (id ? map.get(id)?.name : undefined), href: (id) => (id ? map.get(id)?.href : undefined), project: (id) => (id ? map.get(id)?.name : undefined) };
  }, [g.data]);
}

// the logo for whoever did something: an AI app's own logo, Warden's shield, or a person's initial
const BY_NAME = new Map(Object.entries(PROVIDER_NAMES).map(([id, n]) => [n, id]));
export function WhoMark({ who, size = 36 }: { who: string; size?: number }) {
  const brand = BY_NAME.get(who);
  if (brand) return <span className="grid shrink-0 place-items-center rounded-full bg-raised" style={{ width: size, height: size }}><BrandLogo id={brand} size={size * 0.48} /></span>;
  if (who === 'Warden') return <IconCircle size={size} tone="dark"><Shield size={size * 0.44} /></IconCircle>;
  return <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-lime font-semibold text-lime-ink" style={{ width: size, height: size, fontSize: size * 0.38 }}>{who.charAt(0).toUpperCase()}</span>;
}

// --- the timeline ---------------------------------------------------------------------------------------
type Filter = 'all' | 'deploys' | 'fixes' | 'security' | 'backups' | 'problems';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'deploys', label: 'Deploys' }, { value: 'fixes', label: 'Fixes' },
  { value: 'security', label: 'Security' }, { value: 'backups', label: 'Backups' }, { value: 'problems', label: 'Problems' },
];
const KIND_WORD: Record<string, string> = { deploys: 'Deploy', fixes: 'Fix', security: 'Security', backups: 'Backup', other: 'Update' };
const ICON: [string, typeof Rocket][] = [
  ['deployment', Rocket], ['domain', Globe], ['backup', DatabaseBackup], ['server', Server], ['service', Box], ['approval', ShieldCheck], ['agent', Sparkles],
  ['shield', Shield], ['secret', KeyRound], ['budget', Wallet], ['site', ActivityIcon], ['incident', Siren], ['sync', RefreshCw], ['account', Plug], ['policy', Bot], ['environment', Bot], ['autopilot', Bot], ['project', Box], ['database', DatabaseBackup], ['env', KeyRound], ['action', CircleDot],
];
const BRANDS = Object.keys(LOGOS).filter((id) => providerName(id).length > 3);
function brandOf(e: LiveEvent): string | null {
  const p = e.data?.provider;
  if (typeof p === 'string' && LOGOS[p]) return p;
  const msg = e.message.toLowerCase();
  return BRANDS.find((id) => new RegExp(`\\b${providerName(id).toLowerCase().replace('.', '\\.')}\\b`).test(msg)) ?? null;
}
const TONE_CIRCLE: Record<Tone, string> = { ok: 'bg-raised text-ink-2', neutral: 'bg-raised text-ink-2', warn: 'bg-warn/12 text-warn', bad: 'bg-bad/10 text-bad' };

function dayKey(iso: string) { const d = new Date(iso); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayLabel(t: number) {
  const today = dayKey(new Date().toISOString());
  if (t === today) return 'Today';
  if (t === today - 86_400_000) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, today - t < 6 * 86_400_000 ? { weekday: 'long', month: 'short', day: 'numeric' } : { month: 'long', day: 'numeric' });
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
// a day's rhythm at a glance: 24 thin bars, one per hour, as tall as how much happened (red where something went wrong)
function DaySpark({ rows }: { rows: { e: LiveEvent; times: number; problem: boolean }[] }) {
  const hours = Array.from({ length: 24 }, () => ({ n: 0, bad: false }));
  for (const r of rows) { const h = hours[new Date(r.e.created_at).getHours()]!; h.n += r.times; h.bad ||= r.problem; }
  const max = Math.max(1, ...hours.map((h) => h.n));
  const busiest = hours.reduce((b, h, i) => (h.n > hours[b]!.n ? i : b), 0);
  const at = new Date(2000, 0, 1, busiest).toLocaleTimeString(undefined, { hour: 'numeric' });
  return (
    <span role="img" aria-label={`Busiest around ${at}`} title={`Busiest around ${at}`} className="ml-auto flex h-7 items-end gap-[3px] self-end">
      {hours.map((h, i) => (
        <span key={i} className={cx('w-1 origin-bottom rounded-full animate-grow', h.n ? (h.bad ? 'bg-bad/75' : 'bg-blue/70') : 'bg-line-strong')}
          style={{ height: h.n ? `${Math.max(22, (h.n / max) * 100)}%` : '4px', animationDelay: `${i * 12}ms` }} />
      ))}
    </span>
  );
}

// Changes on a server that can still be taken back (change.list), and how many things need a look right now: the
// Map's own count (map.get), so "Map refreshed · 7 things to look at" and the Map never disagree. Both follow live.
function useLiveFacts() {
  const [undoable, setUndoable] = useState<Set<string>>(() => new Set());
  const [attention, setAttention] = useState<number | undefined>();
  const changes = useCallback(() => runTool('change.list', { limit: 200 }).then((r) => { if (r.status === 'ok') setUndoable(new Set((r.output as { changeId: string; canUndo: boolean }[]).filter((c) => c.canUndo).map((c) => c.changeId))); }).catch(() => {}), []);
  const map = useCallback(() => runTool('map.get').then((r) => { if (r.status === 'ok') setAttention(((r.output as { issues?: unknown[] }).issues ?? []).length); }).catch(() => {}), []);
  useEffect(() => {
    void changes(); void map();
    return onLive((e) => {
      if (e.live && e.type !== 'map.rechecked') return;
      if (e.type.startsWith('change.')) void changes();
      if (e.type === 'sync.done' || e.type === 'map.rechecked' || e.type.startsWith('site.') || e.type.startsWith('watch.') || (e.type === 'action.completed' && /^snooze\./.test(String(e.data?.tool)))) void map();
    });
  }, [changes, map]);
  return { undoable, attention };
}

function Timeline() {
  const events = useApi<LiveEvent[]>('/api/events?limit=300');
  const names = useNames();
  const facts = useLiveFacts();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(60);
  const [progress, setProgress] = useState<LiveEvent[]>([]);
  // a problem a person hid ("This is fine" on its row) leaves the list at once and stays out after a reload, until its
  // time is up; "Hidden (N)" shows those rows again, each with Bring back
  // ponytail: matched by type and thing here; one that came back worse still shows on its phone alert (notify.ts)
  const hiddenStore = useHidden();
  const hiddenKeys = useMemo(() => new Set(hiddenStore.rows.map((h) => h.key)), [hiddenStore.rows]);
  const [withHidden, setWithHidden] = useState(false);
  // progress lines are live-only: show the last few as they stream in
  useEffect(() => onLive((e) => { if (e.type === 'tool.progress') setProgress((p) => [...p.slice(-3), e]); }), []);
  useEffect(() => setLimit(60), [filter, q]);

  // one row per thing that happened: an action and its echo ("Removed preview-web") fold into one, and the
  // same thing happening again and again in a row is one line that says how many times
  const rows = useMemo(() => {
    const out: { e: LiveEvent; said: Said; kind: ReturnType<typeof eventKind>; problem: boolean; hidden: boolean; where?: string; place?: string; times: number; latest: boolean; undo?: string }[] = [];
    let newestSync = true;
    // a change someone already took back shows no Undo, even before the list catches up
    const undone = new Set((events.data ?? []).filter((x) => x.type === 'change.undone').map((x) => x.data?.changeId));
    for (const e of foldEchoes((events.data ?? []).filter((x) => x.type !== 'tool.progress'))) {
      // only the newest map refresh says how many things need a look, and it says the Map's number
      const live = e.type === 'sync.done' && newestSync ? { attention: facts.attention } : {};
      if (e.type === 'sync.done') newestSync = false;
      const said = e.by ? { ...eventWords(e, live), tone: 'ok' as Tone, word: 'Done' } : eventWords(e, live);
      const undo = typeof e.data?.changeId === 'string' && facts.undoable.has(e.data.changeId) && !undone.has(e.data.changeId) ? e.data.changeId as string : undefined;
      const place = names.name(e.resource) ?? names.project(e.project_id) ?? (e.data?.provider ? providerName(e.data.provider) : undefined);
      const where = [e.by && !said.text.startsWith(e.by) ? `by ${e.by}` : null, place].filter(Boolean).join(' · ') || undefined;
      const prev = out.at(-1);
      if (prev && prev.e.type === e.type && prev.said.text === said.text && prev.where === where && dayKey(prev.e.created_at) === dayKey(e.created_at)) { prev.times++; continue; }
      const bad = said.tone === 'bad' || said.tone === 'warn', hidden = bad && hiddenKeys.has(`event:${e.type}:${e.resource ?? ''}`);
      out.push({ e, said, kind: eventKind(e.type), problem: bad && !hidden, hidden, where, place, times: 1, latest: false, undo });
    }
    // only the newest of the same thing offers the fix on the row; older ones keep it in their details
    const seen = new Set<string>();
    for (const r of out) { const k = `${r.e.type}|${r.said.text}|${r.where ?? ''}`; r.latest = !seen.has(k); seen.add(k); }
    return out;
  }, [events.data, names, facts, hiddenKeys]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, deploys: 0, fixes: 0, security: 0, backups: 0, problems: 0 };
    for (const r of rows) { if (r.kind !== 'other') c[r.kind]++; if (r.problem) c.problems++; }
    return c;
  }, [rows]);
  const needle = q.trim().toLowerCase();
  const nHidden = rows.filter((r) => r.hidden).length;
  const shown = rows.filter((r) => (withHidden || !r.hidden) && (filter === 'all' || (filter === 'problems' ? r.problem || r.hidden : r.kind === filter))
    && (!needle || `${r.said.text} ${r.where ?? ''} ${r.e.message}`.toLowerCase().includes(needle)));
  const days: { t: number; rows: typeof shown }[] = [];
  for (const r of shown.slice(0, limit)) {
    const t = dayKey(r.e.created_at);
    if (days.at(-1)?.t !== t) days.push({ t, rows: [] });
    days.at(-1)!.rows.push(r);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1 [&>div]:[scrollbar-width:none]">
          <Tabs value={filter} onChange={setFilter} tabs={FILTERS.map((f) => ({ value: f.value, label: <>{f.label}{events.data && <span className="tabular text-[12px] opacity-60">{counts[f.value]}</span>}</> }))} />
        </div>
        {(nHidden > 0 || withHidden) && (
          <Button size="sm" variant={withHidden ? 'dark' : 'ghost'} icon={<EyeOff size={13} />} aria-pressed={withHidden} onClick={() => setWithHidden((x) => !x)} className="shrink-0 self-start md:self-auto">
            {withHidden ? 'Hide them again' : `Hidden (${nHidden})`}
          </Button>
        )}
        <SearchInput value={q} onChange={setQ} placeholder="Search activity" label="Search activity" className="md:w-[280px]" />
      </div>

      {progress.length > 0 && (
        <Card className="animate-rise space-y-1.5 p-4">
          {progress.map((p) => <p key={p.id} className="flex items-center gap-2.5 text-[13px] text-ink-2"><Dot tone="work" working />{tidy(p.message)}</p>)}
        </Card>
      )}

      {!events.data ? (events.error ? <LoadError what="activity" reload={events.reload} /> : <TimelineSkeleton />)
        : !rows.length ? <Empty art={<Illustration name="clear" size={96} />} title="Quiet so far" body="Deploys, fixes, alerts and approvals show up here the moment they happen." />
        : !shown.length ? <Empty icon={<SearchX size={24} />} title="Nothing matches" body={needle ? `No activity mentions “${q.trim()}”${filter !== 'all' ? ' in this filter' : ''}.` : 'Nothing of this kind yet.'}
            action={<Button variant="soft" onClick={() => { setFilter('all'); setQ(''); }}>Show everything</Button>} />
        : (
          <div className="space-y-8">
            {days.map((d, i) => (
              <section key={d.t} aria-label={dayLabel(d.t)} className="animate-rise" style={{ animationDelay: `${Math.min(i, 6) * 70}ms` }}>
                <h2 className="mb-3 flex items-baseline gap-2 px-1 text-[15px] font-semibold tracking-[-0.015em]">{dayLabel(d.t)}<span className="text-[12.5px] font-normal text-muted tabular">{d.rows.length}</span><DaySpark rows={d.rows} /></h2>
                <Card className="overflow-hidden p-1.5">
                  <ul className="divide-y divide-line">
                    {d.rows.map(({ e, said, kind, where, place, times, latest, undo, hidden }) => (
                      <EventRow key={e.id} e={e} said={said} kind={kind} where={where} place={place} times={times} latest={latest} changeId={undo} href={names.href(e.resource) ?? names.href(e.project_id)} hidden={hidden}
                        open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
                    ))}
                  </ul>
                </Card>
              </section>
            ))}
            {shown.length > limit && <div className="flex justify-center"><Button variant="soft" onClick={() => setLimit((n) => n + 80)}>Show more ({shown.length - limit} left)</Button></div>}
          </div>
        )}
    </div>
  );
}

// What to do about a row, in one or two buttons: review it, connect what's missing, or ask Unit7 to fix it.
// Problems that are gone (an older failure) keep theirs in the details only.
export function nextStep(e: Pick<LiveEvent, 'type' | 'message'>, said: Said, place?: string, href?: string): ReactNode {
  if (e.type === 'approval.requested') return <Button size="sm" variant="primary" icon={<ShieldCheck size={13} />} onClick={() => navigate('/approvals')}>Review it</Button>;
  if (e.type === 'sync.done' && /\d+ thing/.test(said.text)) return <Button size="sm" variant="soft" icon={<Network size={13} />} onClick={() => navigate('/map?status=attention')}>Show me</Button>;
  if (said.tone !== 'bad' && said.tone !== 'warn') return null;
  // "Connect the Hostinger account…", "isn't signed in to Vercel yet": the fix is a sign-in
  const missing = said.text.match(/Connect the (\S+(?: \S+)?) account|signed in to (.+?) yet/);
  const open = href && place ? <Button size="sm" variant="ghost" onClick={() => navigate(href)}>Open {place}<ArrowUpRight size={13} /></Button> : null;
  return (
    <>
      {missing ? <Button size="sm" variant="primary" icon={<Plug size={13} />} onClick={() => navigate('/connections')}>Connect {missing[1] ?? missing[2]}</Button>
        : <AskButton variant="primary" prompt={`${said.text.replace(/\.$/, '')}${place ? ` (${place})` : ''}. What happened, and can you fix it?`} />}
      {open}
    </>
  );
}

function EventRow({ e, said, kind, where, place, href, times, latest, changeId, open, onToggle, hidden }: { e: LiveEvent; said: Said; kind: string; where?: string; place?: string; href?: string; times: number; latest: boolean; changeId?: string; open: boolean; onToggle: () => void; hidden?: boolean }) {
  const brand = brandOf(e);
  // "Sam: protect a domain's email" is an action event: its icon comes from the action itself
  const type = /^(action|approval)\./.test(e.type) && typeof e.data?.tool === 'string' ? e.data.tool : e.type;
  const Icon = kind === 'fixes' ? Wrench : ICON.find(([k]) => type.startsWith(k))?.[1] ?? CircleDot;
  const [undoing, setUndoing] = useState(false);
  // a product Unit7 made by itself says how to take it apart again
  const auto: { tool: string; input: unknown; label?: string } | null = (e.type === 'group.auto' || e.type === 'asset.ai_archived' || e.type === 'autofix.applied') && typeof e.data?.undo?.tool === 'string' ? e.data.undo : null;
  const undo = changeId ? <Button size="sm" variant="secondary" icon={<Undo2 size={13} />} loading={undoing} onClick={async () => { setUndoing(true); await act('change.undo', { changeId }, { success: 'Undone. It’s back the way it was.', undo: false }); setUndoing(false); }}>Undo</Button>
    : auto ? <Button size="sm" variant="secondary" icon={<Undo2 size={13} />} loading={undoing} onClick={async () => { setUndoing(true); await act(auto.tool, auto.input, { success: 'Undone', undo: false }); setUndoing(false); }}>{auto.label ?? 'Undo'}</Button> : null;
  const next = nextStep(e, said, place, href);
  const rp = replayFor(e);
  const replay = rp ? <ReplayButton {...rp} /> : null;
  const problem = said.tone === 'bad' || said.tone === 'warn';
  const fine = hidden ? <Button size="sm" variant="ghost" icon={<Eye size={13} />} onClick={() => void bringBack(`event:${e.type}:${e.resource ?? ''}`)}>Bring back</Button>
    : problem && e.type !== 'approval.requested' ? <SnoozeMenu id={`event:${e.type}:${e.resource ?? ''}`} title={said.text} kind="event" small /> : null;
  const step = undo || next || replay ? <>{undo}{replay}{next}{fine}</> : fine;
  const fresh = Date.now() - new Date(e.created_at).getTime() < 86_400_000;
  return (
    <li className="py-0.5">
      <button type="button" aria-expanded={open} onClick={onToggle}
        className={cx('flex w-full items-center gap-3.5 rounded-[18px] px-3 py-2.5 text-left transition-colors hover:bg-raised/70 md:px-3.5', open && 'bg-raised/70')}>
        <span className={cx('grid size-10 shrink-0 place-items-center rounded-full', brand ? 'bg-raised' : TONE_CIRCLE[said.tone])}>
          {brand ? <BrandLogo id={brand} size={19} /> : <Icon size={17} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[14px] leading-snug text-ink md:line-clamp-1">{said.text}</span>
          <span className="mt-0.5 block truncate text-[12.5px] text-muted">{where ? <>{where} · </> : null}<span title={new Date(e.created_at).toLocaleString()}>{timeAgo(e.created_at)}</span>{times > 1 && <> · {times} times</>}</span>
        </span>
        <Badge tone={said.tone} solid={said.tone !== 'neutral'}>{said.word}</Badge>
        <ChevronDown size={16} aria-hidden className={cx('hidden shrink-0 text-muted transition-transform duration-300 sm:block', open && 'rotate-180')} />
      </button>
      {step && (undo || (fresh && latest)) && !open && <div className="flex flex-wrap gap-1.5 pb-2 pl-[66px] pr-3 md:pl-[68px]">{step}</div>}
      {open && (
        <div className="animate-rise mx-2 mb-2 mt-1 grid gap-4 rounded-[18px] border border-line bg-surface p-4 text-[13px] md:grid-cols-[220px_1fr] md:mx-3.5">
          <dl className="space-y-2.5">
            <Fact k="When">{new Date(e.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Fact>
            <Fact k="Kind">{KIND_WORD[kind]}</Fact>
            {place && <Fact k="Where">{href ? <A href={href} className="inline-flex min-h-6 items-center gap-0.5 font-medium text-blue-text hover:underline">{place}<ArrowUpRight size={13} /></A> : place}</Fact>}
            {step && <div className="flex flex-wrap gap-1.5 pt-1">{step}</div>}
          </dl>
          <div className="min-w-0">
            {e.explain?.why ? <ExplainBlock e={{ ...e.explain, what: said.text, advanced: undefined }} className="mb-3" /> : null}
            {/* a deploy opens into its release: the steps, the proof, the watch */}
            {e.type.startsWith('deployment.') && typeof e.data?.deploymentId === 'string' && <ReleaseTimeline deploymentId={e.data.deploymentId} compact className="mb-3" />}
            <p className="mb-1.5 text-[12px] text-muted">Exactly what was recorded</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[14px] bg-raised p-3 font-mono text-[12px] leading-relaxed text-ink-2">{raw(e.message)}</pre>
          </div>
        </div>
      )}
    </li>
  );
}

// raw text stays raw, except the old product name
const raw = rawWords;
const Fact = ({ k, children }: { k: string; children: ReactNode }) => (
  <div><dt className="text-[12px] text-muted">{k}</dt><dd className="text-ink">{children}</dd></div>
);

function TimelineSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading activity">
      {[5, 3].map((n, i) => (
        <div key={i}>
          <Skeleton className="mb-3 h-5 w-28" />
          <Card className="space-y-1 p-3">{Array.from({ length: n }, (_, j) => <div key={j} className="flex items-center gap-3.5 p-2"><Skeleton className="size-10 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-3 w-1/4" /></div><Skeleton className="h-6 w-16 rounded-full" /></div>)}</Card>
        </div>
      ))}
    </div>
  );
}

export function LoadError({ what, reload }: { what: string; reload: () => void }) {
  return (
    <Card className="flex flex-wrap items-center gap-4 p-5">
      <IconCircle tone="bad"><CircleAlert size={20} /></IconCircle>
      <p className="min-w-0 grow basis-[220px] text-[14px]">Couldn’t load {what}. <span className="text-muted">Is Unit7 still running?</span></p>
      <Button variant="soft" onClick={reload}>Try again</Button>
    </Card>
  );
}

// --- who did what: the full record ------------------------------------------------------------------------
const RESULT: Record<string, [Tone, string]> = {
  success: ['ok', 'Done'], error: ['bad', 'Didn’t work'], denied: ['bad', 'Blocked'], pending_approval: ['warn', 'Asked first'], dry_run: ['neutral', 'Practice run'],
};
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : undefined; } catch { return s; } };

function Record() {
  const audit = useApi<any[]>('/api/audit?limit=300');
  const tools = useApi<{ name: string; title: string }[]>('/api/tools', { live: false });
  const names = useNames();
  const [q, setQ] = useState('');
  const [looks, setLooks] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(60);
  const title = (t: string) => toolWords(t, tools.data?.find((x) => x.name === t)?.title);
  const needle = q.trim().toLowerCase();
  const rows = (audit.data ?? []).filter((a) => (looks || a.risk !== 'read')
    && (!needle || `${title(a.tool)} ${whoWords(a.actor_name)} ${a.reason ?? ''} ${names.project(a.project_id) ?? ''}`.toLowerCase().includes(needle)));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <SearchInput value={q} onChange={setQ} placeholder="Search by who or what" label="Search the record" className="md:w-[320px]" />
        <label className="flex items-center gap-2.5 text-[13.5px] text-ink-2 md:ml-auto">
          <Switch checked={looks} onChange={setLooks} label="Include look-ups" />Include look-ups
        </label>
      </div>
      {!audit.data ? (audit.error ? <LoadError what="the record" reload={audit.reload} /> : <TimelineSkeleton />)
        : !rows.length ? <Empty icon={<SearchX size={24} />} title={needle ? 'Nothing matches' : 'Nothing changed yet'} body={needle ? `No action mentions “${q.trim()}”.` : 'Every change anyone makes, person or AI, is written down here for good.'} />
        : (
          <Card className="overflow-hidden p-1.5">
            <ul className="divide-y divide-line">
              {rows.slice(0, limit).map((a) => {
                const who = whoWords(a.actor_name);
                const [tone, word] = RESULT[a.result] ?? ['neutral', a.result];
                const input = parse(a.input) ?? {};
                const where = names.name(input.serviceId) ?? names.name(input.serverId) ?? names.project(a.project_id);
                const isOpen = open === a.id;
                return (
                  <li key={a.id} className="py-0.5">
                    <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)}
                      className={cx('flex w-full items-center gap-3.5 rounded-[18px] px-3 py-2.5 text-left transition-colors hover:bg-raised/70', isOpen && 'bg-raised/70')}>
                      <WhoMark who={who} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-ink"><span className="font-medium">{who}</span> <span className="text-ink-2">· {title(a.tool)}</span></span>
                        <span className="mt-0.5 block truncate text-[12.5px] text-muted">{where ? `${where} · ` : ''}{timeAgo(a.created_at)}</span>
                      </span>
                      <Badge tone={tone} solid={tone !== 'neutral'}>{word}</Badge>
                      <ChevronDown size={16} aria-hidden className={cx('hidden shrink-0 text-muted transition-transform duration-300 sm:block', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div className="animate-rise mx-2 mb-2 mt-1 grid gap-4 rounded-[18px] border border-line bg-surface p-4 text-[13px] md:mx-3.5 md:grid-cols-[220px_1fr]">
                        <dl className="space-y-2.5">
                          <Fact k="When">{new Date(a.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Fact>
                          {a.reason && <Fact k="Why">{tidy(a.reason)}</Fact>}
                          {a.duration_ms != null && <Fact k="Took">{a.duration_ms < 1000 ? 'under a second' : `${Math.round(a.duration_ms / 1000)} seconds`}</Fact>}
                          {a.error && <Fact k="What went wrong"><span className="text-bad">{tidy(String(a.error).replace(/^[a-z_]+: /, ''))}</span></Fact>}
                        </dl>
                        <div className="min-w-0">
                          <p className="mb-1.5 text-[12px] text-muted">Exactly what was recorded</p>
                          <pre className="max-h-56 overflow-auto rounded-[14px] bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{raw(JSON.stringify({ input: parse(a.input), output: parse(a.output) }, null, 2))}</pre>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      {rows.length > limit && <div className="flex justify-center"><Button variant="soft" onClick={() => setLimit((n) => n + 80)}>Show more ({rows.length - limit} left)</Button></div>}
    </div>
  );
}
