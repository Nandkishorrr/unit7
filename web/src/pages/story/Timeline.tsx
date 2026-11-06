// "What changed": one timeline for an app, a project or a server (or everything), newest first and grouped by day.
// Each line: an icon or the provider's logo, a plain sentence, who did it and when, and Undo where Unit7 already has
// one (through the gate, so it may ask for approval). Hover a line for its details, click it for the pop-up.
// "Since it last worked" shows only what changed after the last healthy moment, with the likely culprit on top.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, History, RefreshCw, Target, Undo2 } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { BrandLogo } from '../../brand/BrandLogo';
import { act, Badge, Button, Card, CardHeader, ChipSelect, confirmDialog, cx, HoverCard, IconCircle, Modal, Skeleton } from '../../ui';
import { rawWords, tidy } from '../../lib/words';
import { KIND, KIND_FILTER, WHO, WHO_FILTER, byDay, filterItems, hhmm, initials, longWhen, type Item, type TimelineOut, type Who } from './shape';

export interface TimelineProps { serverId?: string; projectId?: string; serviceId?: string; className?: string; title?: string; startHealthy?: boolean }
type Mode = 'all' | 'healthy';
const LIVE = /^(deployment\.|change\.|env\.|coolify\.|site\.|service\.|approval\.(approved|rejected)|action\.completed|domain\.|link\.)/;

// the data, reloaded when something changes
export function useTimeline(scope: { serverId?: string; projectId?: string; serviceId?: string }, mode: Mode) {
  const [s, set] = useState<{ data?: TimelineOut; error?: string; loading: boolean }>({ loading: true });
  const key = JSON.stringify([scope.serverId, scope.projectId, scope.serviceId, mode]);
  const load = useCallback(async () => {
    set((x) => ({ ...x, loading: true }));
    try {
      const r = await runTool('story.timeline', { ...scope, untilHealthy: mode === 'healthy' });
      set(r.status === 'ok' ? { data: r.output, loading: false } : { error: r.status === 'error' ? tidy(r.error.message) : 'Not allowed.', loading: false });
    } catch (e) { set({ error: (e as Error).message, loading: false }); }
  }, [key]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => { if (!e.live && LIVE.test(e.type)) { clearTimeout(t); t = setTimeout(load, 600); } });
    return () => { off(); clearTimeout(t); };
  }, [load]);
  return { ...s, reload: load };
}

export async function undoItem(it: Item, done?: () => void) {
  if (!it.undo) return;
  const ok = await confirmDialog({ title: `${it.undo.label}?`, body: `This takes back: ${rawWords(it.text).replace(/^\w/, (c) => c.toLowerCase())}. Unit7 runs its own safe step for it, the same one its page uses. If the rules say a person approves it first, it waits on the Approvals page.`, confirm: it.undo.label });
  if (!ok) return;
  if (await act(it.undo.tool, it.undo.input, { success: 'Undone', undo: false })) done?.();
}

// --- who did it: a small face for a person, the AI mark, Warden's shield -------------------------------------------
export function WhoChip({ who, className }: { who: Who; className?: string }) {
  const W = WHO[who.kind].icon;
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5', className)} title={WHO[who.kind].word}>
      {who.kind === 'person'
        ? <span aria-hidden className="grid size-[18px] shrink-0 place-items-center rounded-full bg-ink text-[9px] font-semibold text-bg">{initials(who.name)}</span>
        : <span aria-hidden className={cx('grid size-[18px] shrink-0 place-items-center rounded-full', who.kind === 'ai' ? 'bg-blue-soft text-blue-text' : who.kind === 'warden' ? 'bg-lime text-lime-ink' : 'bg-raised text-muted')}><W size={11} /></span>}
      <span className="truncate">{rawWords(who.name)}</span>
    </span>
  );
}

export function KindIcon({ it, size = 32 }: { it: Pick<Item, 'kind' | 'logo' | 'status'>; size?: number }) {
  if (it.logo) return <span aria-hidden className="grid shrink-0 place-items-center rounded-full border border-line bg-surface" style={{ width: size, height: size }}><BrandLogo id={it.logo} size={Math.round(size * 0.5)} /></span>;
  const k = KIND[it.kind], I = it.status === 'failed' ? AlertTriangle : k.icon;
  return <IconCircle size={size} tone={it.status === 'failed' ? 'bad' : k.tone}><I size={Math.round(size * 0.45)} /></IconCircle>;
}

function Status({ it }: { it: Item }) {
  return <>
    {it.culprit && <Badge tone="bad" className="!h-5 !px-2 !text-[11px]"><Target size={11} />Likely culprit</Badge>}
    {it.status === 'failed' && <Badge tone="bad" className="!h-5 !px-2 !text-[11px]">Didn’t work</Badge>}
    {it.status === 'undone' && <Badge className="!h-5 !px-2 !text-[11px]">Taken back</Badge>}
    {it.status === 'working' && <Badge tone="info" className="!h-5 !px-2 !text-[11px]">In progress</Badge>}
    {it.children && <Badge className="!h-5 !px-2 !text-[11px]">{it.children.length} at once</Badge>}
  </>;
}

export function Details({ it }: { it: Item }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] text-muted">{longWhen(it.at)} · {KIND[it.kind].word}</p>
      <p className="font-medium leading-snug">{rawWords(it.text)}</p>
      <p className="text-[12.5px] text-ink-2"><WhoChip who={it.who} /></p>
      {it.detail?.map((d) => <p key={d} className="text-[12.5px] text-muted">{rawWords(d)}</p>)}
      {it.undo && <p className="text-[12px] text-blue-text">Can be undone: {it.undo.label.toLowerCase()}</p>}
    </div>
  );
}

export function Line({ it, onOpen, onUndo, compact }: { it: Item; onOpen: (it: Item) => void; onUndo: (it: Item) => void; compact?: boolean }) {
  return (
    <li className={cx('relative flex items-start gap-3 rounded-[18px] p-2 transition-colors animate-rise', it.culprit ? 'bg-bad/[0.06] ring-1 ring-bad/25' : 'hover:bg-raised')}>
      {!compact && <time dateTime={it.at} className="tabular w-[60px] shrink-0 whitespace-nowrap pt-[7px] text-right text-[12px] text-muted">{hhmm(it.at)}</time>}
      <span className="relative z-10 rounded-full ring-4 ring-surface"><KindIcon it={it} size={30} /></span>
      <div className="min-w-0 flex-1 pt-0.5">
        <HoverCard content={<Details it={it} />}>
          <button type="button" onClick={() => onOpen(it)} className="block max-w-full text-left text-[13.5px] font-medium leading-snug text-ink decoration-line-strong underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue rounded-md">
            {rawWords(it.text)}
          </button>
        </HoverCard>
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
          <WhoChip who={it.who} className="max-w-[60%]" />{compact && <span className="tabular">{hhmm(it.at)}</span>}<Status it={it} />
        </p>
        {/* on a phone the undo sits under the line, so the sentence keeps its width */}
        {it.undo && <Button size="sm" variant={it.culprit ? 'primary' : 'soft'} icon={<Undo2 size={13} />} className="mt-2 sm:hidden" onClick={() => onUndo(it)} aria-label={`${it.undo.label}: ${it.text}`}>{it.culprit ? it.undo.label : 'Undo'}</Button>}
      </div>
      {it.undo && <Button size="sm" variant={it.culprit ? 'primary' : 'soft'} icon={<Undo2 size={13} />} className="shrink-0 max-sm:hidden" onClick={() => onUndo(it)} aria-label={`${it.undo.label}: ${it.text}`}>{it.culprit ? it.undo.label : 'Undo'}</Button>}
    </li>
  );
}

// the pop-up: everything about one line, the lines inside a group, and its undo
export function ItemModal({ it, onClose, onUndo }: { it: Item | null; onClose: () => void; onUndo: (it: Item) => void }) {
  return (
    <Modal open={!!it} onClose={onClose} title={it ? rawWords(it.text) : ''} size="md">
      {it && (
        <div className="space-y-4">
          <div className="flex items-center gap-3"><KindIcon it={it} size={40} /><div className="min-w-0"><p className="text-[13.5px] font-medium">{KIND[it.kind].word}</p><p className="text-[12.5px] text-muted">{longWhen(it.at)}</p></div></div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-[18px] bg-raised p-4 text-[13px]">
            <dt className="text-muted">Who</dt><dd className="min-w-0"><WhoChip who={it.who} /> <span className="text-muted">· {WHO[it.who.kind].word.toLowerCase()}</span></dd>
            {it.detail?.map((d, i) => <Fragment key={i}><dt className="text-muted">{i === 0 ? 'Details' : ''}</dt><dd className="min-w-0 break-words">{rawWords(d)}</dd></Fragment>)}
            {it.culprit && <><dt className="text-muted">Why it’s marked</dt><dd>The closest change before it stopped working{it.kind === 'deploy' ? ', and a deploy' : ''}.</dd></>}
          </dl>
          {it.children && (
            <ul className="space-y-1">{it.children.map((c) => <Line key={c.id} it={c} compact onOpen={() => undefined} onUndo={onUndo} />)}</ul>
          )}
          {it.undo ? (
            <div className="rounded-[18px] border border-line p-4">
              <p className="text-[13.5px] font-medium">{it.undo.label}</p>
              <p className="mt-0.5 text-[12.5px] text-muted">Unit7 already keeps this undo. It runs through the same rules as everything else, so it may wait for your OK.</p>
              <Button className="mt-3" variant="primary" size="sm" icon={<Undo2 size={13} />} onClick={() => onUndo(it)}>{it.undo.label}</Button>
            </div>
          ) : !it.children && <p className="text-[12.5px] text-muted">There’s no undo for this one, so Unit7 doesn’t offer one.</p>}
        </div>
      )}
    </Modal>
  );
}

// "since it last worked": broken since when, last good when; or all fine
function HealthBanner({ d }: { d: TimelineOut }) {
  const h = d.health;
  if (!h) return null;
  const tone = h.state === 'failing' ? 'bad' : 'ok';
  const [title, sub]: [string, ReactNode] = h.state === 'failing' && h.failingSince
    ? [`Not working since ${hhmm(h.failingSince)}`, <>{rawWords(h.what ?? '')}{h.what ? '. ' : ''}{h.guessed ? `No earlier check to go by, so this shows the 6 hours before it.` : `It last worked at ${hhmm(h.healthyAt!)}${d.leadMinutes ? `; changes from ${d.leadMinutes} minutes before that count too, since some take a moment to break things` : ''}.`}</>]
    : h.failingSince ? [`Working now`, <>The last problem began at {hhmm(h.failingSince)}{h.recoveredAt ? ` and cleared at ${hhmm(h.recoveredAt)}` : ''}. Below: what changed before it.</>]
    : ['Everything works', 'Nothing failed in the last 30 days, so there’s no last-worked moment to start from.'];
  return (
    <div className={cx('mt-4 flex items-start gap-3 rounded-[18px] p-3.5', tone === 'bad' ? 'bg-bad/[0.07]' : 'bg-ok/10')} role="status">
      <IconCircle size={32} tone={tone}>{tone === 'bad' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}</IconCircle>
      <div className="min-w-0"><p className="text-[14px] font-semibold">{title}</p><p className="text-[12.5px] text-ink-2">{sub}</p></div>
    </div>
  );
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div role="radiogroup" aria-label="Which changes" className="inline-flex rounded-full bg-raised p-1">
      {(['all', 'healthy'] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => onChange(m)}
          className={cx('h-8 rounded-full px-3.5 text-[12.5px] font-medium transition-colors', mode === m ? 'bg-ink text-bg shadow-soft' : 'text-ink-2 hover:text-ink')}>
          {m === 'all' ? 'All changes' : 'Since it last worked'}
        </button>
      ))}
    </div>
  );
}

const SHOWN = 8;
export function Timeline({ serverId, projectId, serviceId, className, title = 'What changed', startHealthy }: TimelineProps) {
  const [mode, setMode] = useState<Mode>(startHealthy ? 'healthy' : 'all');
  const [kind, setKind] = useState('all');
  const [who, setWho] = useState('all');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Item | null>(null);
  const t = useTimeline({ serverId, projectId, serviceId }, mode);
  const items = filterItems(t.data?.items ?? [], kind, who);
  const culprit = mode === 'healthy' ? t.data?.items.find((x) => x.id === t.data?.culpritId) : undefined;
  const rest = culprit ? items.filter((x) => x.id !== culprit.id) : items;
  const shown = all ? rest : rest.slice(0, SHOWN);
  const onUndo = (it: Item) => void undoItem(it, () => { setOpen(null); void t.reload(); });
  const first = useRef(true);
  useEffect(() => { if (!first.current) setAll(false); first.current = false; }, [mode, kind, who]);
  const total = t.data?.items.length ?? 0;
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<History size={19} />} title={title}
        sub={t.data ? `${total ? `${total} change${total === 1 ? '' : 's'}` : 'No changes'} ${mode === 'healthy' && t.data.health?.failingSince ? (t.data.health.state === 'failing' ? 'since it last worked' : 'before the last problem') : 'in the last 7 days'}` : 'Newest first'}
        actions={<button type="button" aria-label="Refresh" onClick={() => void t.reload()} className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><RefreshCw size={15} className={cx(t.loading && t.data && 'animate-spin')} /></button>} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ModeSwitch mode={mode} onChange={setMode} />
        <span className="flex flex-wrap gap-2 sm:ml-auto">
          <ChipSelect label="What" value={kind} onChange={setKind} options={KIND_FILTER} />
          <ChipSelect label="Who" value={who} onChange={setWho} options={WHO_FILTER} />
        </span>
      </div>
      {mode === 'healthy' && t.data && <HealthBanner d={t.data} />}
      {t.error ? <p className="mt-5 rounded-[16px] bg-raised px-4 py-6 text-center text-[13.5px] text-muted">Couldn’t read the changes: {t.error}</p>
        : !t.data ? <div className="mt-5 space-y-3" aria-busy="true">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-[16px]" />)}</div>
        : (
          <>
            {culprit && (
              <div className="mt-4">
                <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-muted">Most likely culprit</p>
                <ul><Line it={culprit} onOpen={setOpen} onUndo={onUndo} /></ul>
              </div>
            )}
            {!rest.length ? (
              <p className="mt-5 rounded-[16px] bg-raised px-4 py-6 text-center text-[13.5px] text-muted">
                {kind !== 'all' || who !== 'all' ? 'Nothing like that in this range.' : mode === 'healthy' ? (culprit ? 'Nothing else changed since then.' : 'Nothing changed since it last worked.') : 'Nothing changed in the last 7 days.'}
              </p>
            ) : (
              <div className="mt-4 space-y-4">
                {byDay(shown).map((g) => (
                  <section key={g.day} aria-label={g.day}>
                    <h3 className="mb-1 pl-[80px] text-[12px] font-medium uppercase tracking-[0.06em] text-muted">{g.day}</h3>
                    <ol className="relative space-y-0.5 before:absolute before:bottom-4 before:left-[95px] before:top-4 before:w-px before:bg-line-strong">
                      {g.items.map((it) => <Line key={it.id} it={it} onOpen={setOpen} onUndo={onUndo} />)}
                    </ol>
                  </section>
                ))}
              </div>
            )}
            {rest.length > SHOWN && (
              <Button variant="ghost" size="sm" className="mt-3" icon={<ChevronDown size={14} className={cx('transition-transform', all && 'rotate-180')} />} onClick={() => setAll((x) => !x)}>
                {all ? 'Show fewer' : `Show all ${rest.length}`}
              </Button>
            )}
          </>
        )}
      <ItemModal it={open} onClose={() => setOpen(null)} onUndo={onUndo} />
    </Card>
  );
}
