// "Replay a failure": the likely cause in one sentence over a small strip of the twenty minutes around it (requests
// and server errors as bars, memory against its cap as a line, deploys, changes, restarts and the failure as markers
// you can hover), the changes in that window (the cause's undo right there), and the first error lines folded away.
// "Explain with AI" hands the story to Unit7's AI on Home, the log text fenced off as untrusted.
import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, Lightbulb, ScrollText, Undo2 } from 'lucide-react';
import { runTool } from '../../lib/api';
import { AiButton, Badge, Button, Card, cx, HoverCard, IconCircle, Modal, Skeleton } from '../../ui';
import { rawWords, tidy } from '../../lib/words';
import { askOnHome } from '../Help';
import { CONFIDENCE, MARK, hhmm, mb, type Marker, type StoryOut } from './shape';
import { KindIcon, undoItem } from './Timeline';

export interface ReplayInput { incidentId?: string; serviceId?: string; serverId?: string; host?: string; at?: string }

// which replay an Activity event or an alert row opens (null: nothing to replay); a site's event names its address,
// which Unit7 places on its app or server
const FAILURES = /^(incident\.opened|site\.down|service\.(down|unhealthy)|deployment\.failed|server\.unreachable|watch\.(anomaly|traffic)|domain\.broken)$/;
export function replayFor(e: { type: string; resource?: string | null; created_at: string; data?: any }): ReplayInput | null {
  if (!FAILURES.test(e.type)) return null;
  const r = e.resource ?? '';
  if (e.type === 'incident.opened' && r.startsWith('inc_')) return { incidentId: r };
  if (r.startsWith('svc_')) return { serviceId: r, at: e.created_at };
  if (r.startsWith('srv_')) return { serverId: r, at: e.created_at };
  if (typeof e.data?.serverId === 'string') return { serverId: e.data.serverId, at: e.created_at };
  if ((e.type === 'site.down' || e.type === 'domain.broken') && /^[a-z0-9.-]+$/i.test(r)) return { host: r, at: e.created_at };
  return null;
}

export function useReplay(input: ReplayInput | null, given?: StoryOut) {
  const [s, set] = useState<{ data?: StoryOut; error?: string }>(given ? { data: given } : {});
  const key = input ? JSON.stringify(input) : null;
  useEffect(() => {
    if (!key || given) return;
    let alive = true;
    set({});
    runTool('story.replay', JSON.parse(key)).then((r) => alive && set(r.status === 'ok' ? { data: r.output } : { error: r.status === 'error' ? tidy(r.error.message) : 'Not allowed.' }), (e: Error) => alive && set({ error: e.message }));
    return () => { alive = false; };
  }, [key, given]);
  return s;
}

const explainPrompt = (s: StoryOut) => `Explain this failure on ${s.scope.label} in plain words: what happened, the likely cause, and the fix you'd suggest. Look only, change nothing.\n\n${s.aiContext}`;

// markers that land on the same moment share one dot
function cluster(markers: Marker[], x: (iso: string) => number) {
  const out: { x: number; marks: Marker[] }[] = [];
  for (const m of markers) {
    const at = x(m.at), near = out.find((c) => Math.abs(c.x - at) < 2.5);
    if (near) near.marks.push(m); else out.push({ x: at, marks: [m] });
  }
  return out;
}
const worst = (ms: Marker[]) => (['failure', 'oom', 'deploy', 'restart', 'change', 'recovery'] as const).find((k) => ms.some((m) => m.kind === k))!;

export function Strip({ s }: { s: StoryOut }) {
  // one bucket a minute: a moment sits where its minute's bar is
  const n = s.buckets.length, w = 100 / Math.max(1, n);
  const start = s.buckets[0] ? Date.parse(s.buckets[0].at) : Date.parse(s.from), span = Math.max(1, n * 60_000);
  const x = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - start) / span) * 100));
  const maxReq = Math.max(1, ...s.buckets.map((b) => b.requests ?? 0));
  const memTop = s.memCap ?? Math.max(1, ...s.buckets.map((b) => b.mem ?? 0));
  const H = 40, Y = (v: number, top: number) => H - 1 - (Math.min(v, top) / top) * (H - 6);
  const mem = s.buckets.map((b, i) => (b.mem == null ? null : `${(i * w + w / 2).toFixed(2)},${Y(b.mem, memTop).toFixed(2)}`));
  const memPath = mem.reduce((d, p, i) => (p ? `${d}${!mem[i - 1] ? 'M' : 'L'}${p}` : d), '');
  const hasTraffic = s.buckets.some((b) => b.requests != null), hasMem = !!memPath;
  const peakReq = Math.max(0, ...s.buckets.map((b) => b.requests ?? 0)), peakErr = Math.max(0, ...s.buckets.map((b) => b.errors ?? 0));
  const label = [hasTraffic && `Up to ${Math.round(peakReq)} requests and ${Math.round(peakErr)} server errors a minute`, hasMem && `memory up to ${mb(Math.max(...s.buckets.map((b) => b.mem ?? 0)))}${s.memCap ? ` of ${mb(s.memCap)}` : ''}`].filter(Boolean).join(', ') || 'No usage or traffic was recorded then';
  const groups = useMemo(() => cluster(s.markers, x), [s]);
  return (
    <div>
      <div className="relative pt-5">
        {/* the markers: a dot per moment, hover for what happened */}
        <div className="absolute inset-x-0 top-0 h-5">
          {groups.map((g, i) => {
            const k = worst(g.marks);
            return (
              <span key={i} className="absolute top-0 -translate-x-1/2" style={{ left: `${g.x}%` }}>
                <HoverCard content={<ul className="space-y-1.5">{g.marks.map((m, j) => <li key={j} className="text-[12.5px]"><span className="tabular text-muted">{hhmm(m.at)}</span> · <span className="font-medium">{MARK[m.kind].word}</span><br />{rawWords(m.label)}</li>)}</ul>}>
                  <button type="button" aria-label={`${hhmm(g.marks[0]!.at)}: ${g.marks.map((m) => rawWords(m.label)).join('; ')}`}
                    className={cx('grid size-[18px] place-items-center rounded-full text-[9.5px] font-bold text-white ring-[3px] ring-surface transition-transform hover:scale-125 focus-visible:scale-125 focus-visible:outline-none', k === 'failure' && 'motion-safe:animate-pulse')}
                    style={{ background: MARK[k].color, color: k === 'change' ? 'var(--bg)' : undefined }}>
                    {g.marks.length > 1 ? g.marks.length : ''}
                  </button>
                </HoverCard>
              </span>
            );
          })}
        </div>
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className="block h-28 w-full overflow-visible rounded-[14px] bg-raised">
          {s.buckets.map((b, i) => {
            const r = b.requests ?? 0, e = Math.min(b.errors ?? 0, r || (b.errors ?? 0));
            const top = Math.max(maxReq, e);
            return (
              <g key={b.at} className="motion-safe:animate-[grow_.5s_var(--ease-out-soft)_both]" style={{ transformOrigin: `0 ${H}px`, animationDelay: `${i * 18}ms` }}>
                {b.requests != null && <rect x={i * w + w * 0.15} width={w * 0.7} y={Y(r, top)} height={H - 1 - Y(r, top)} rx={0.6} fill="var(--blue)" fillOpacity={0.28} />}
                {e > 0 && <rect x={i * w + w * 0.15} width={w * 0.7} y={Y(e, top)} height={H - 1 - Y(e, top)} rx={0.6} fill="var(--bad)" fillOpacity={0.85} />}
                {(b.oom > 0 || b.restarts > 0) && <rect x={i * w} width={w} y={0} height={H} fill={b.oom ? 'var(--bad)' : '#f59e0b'} fillOpacity={0.08} />}
              </g>
            );
          })}
          {memPath && <path d={memPath} fill="none" stroke="var(--ink)" strokeOpacity={0.7} strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
          {s.memCap && hasMem && <line x1={0} x2={100} y1={Y(s.memCap, memTop)} y2={Y(s.memCap, memTop)} stroke="var(--bad)" strokeOpacity={0.5} strokeDasharray="1.5 1.5" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
          <line x1={x(s.at)} x2={x(s.at)} y1={0} y2={H} stroke="var(--ink)" strokeOpacity={0.45} strokeDasharray="2 2" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        {!hasTraffic && !hasMem && <p className="pointer-events-none absolute inset-x-0 bottom-9 text-center text-[12.5px] text-muted">No usage or traffic was recorded then.</p>}
      </div>
      <div className="tabular mt-1.5 flex justify-between text-[11.5px] text-muted"><span>{hhmm(s.from)}</span><span className="font-medium text-ink-2">{hhmm(s.at)}</span><span>{hhmm(s.to)}</span></div>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
        {hasTraffic && <span className="inline-flex items-center gap-1.5"><i aria-hidden className="size-2.5 rounded-[3px] bg-blue/30" />Requests{s.coarse ? ' (averaged)' : ''}</span>}
        {hasTraffic && <span className="inline-flex items-center gap-1.5"><i aria-hidden className="size-2.5 rounded-[3px] bg-bad" />Server errors</span>}
        {hasMem && <span className="inline-flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-3 rounded bg-ink/70" />Memory{s.memCap ? `, cap ${mb(s.memCap)}` : ''}</span>}
      </p>
    </div>
  );
}

export function ReplayBody({ s, compact }: { s: StoryOut; compact?: boolean }) {
  const cause = s.changes.find((c) => c.id === s.cause.itemId);
  const lines = s.errors.reduce((a, e) => a + e.lines.length, 0);
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <IconCircle size={36} tone={s.cause.confidence === 'none' ? 'neutral' : s.cause.confidence === 'high' ? 'bad' : 'warn'}><Lightbulb size={16} /></IconCircle>
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-[0.06em] text-muted">{CONFIDENCE[s.cause.confidence]}</p>
          <p className="text-[15.5px] font-semibold leading-snug tracking-[-0.01em]">{rawWords(s.cause.text)}</p>
        </div>
      </div>
      <Strip s={s} />
      {cause?.undo && (
        <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line p-3">
          <KindIcon it={cause} size={30} />
          <p className="min-w-[160px] flex-1 text-[13px]"><span className="font-medium">{rawWords(cause.text)}</span><br /><span className="text-muted">Unit7 can take this back.</span></p>
          <Button size="sm" variant="primary" icon={<Undo2 size={13} />} className="max-sm:w-full" onClick={() => void undoItem(cause)}>{cause.undo.label}</Button>
        </div>
      )}
      {!compact && s.changes.length > 0 && (
        <div>
          <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-muted">What changed around it</p>
          <ul className="space-y-1">
            {s.changes.slice(0, 5).map((c) => (
              <li key={c.id} className={cx('flex items-center gap-2.5 rounded-[14px] px-2 py-1.5 text-[13px]', c.id === s.cause.itemId && 'bg-bad/[0.06]')}>
                <span className="tabular w-11 shrink-0 text-right text-[12px] text-muted">{hhmm(c.at)}</span>
                <KindIcon it={c} size={24} /><span className="min-w-0 flex-1 truncate">{rawWords(c.text)}</span><span className="hidden shrink-0 text-[12px] text-muted sm:inline">{c.who.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {lines > 0 && (
        <details className="group rounded-[18px] bg-[#111115] p-3 text-white">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium"><ScrollText size={14} />First error lines ({lines})<span className="ml-auto text-[11.5px] font-normal text-white/55 group-open:hidden">Show</span></summary>
          <div className="mt-2 max-h-56 space-y-2 overflow-auto font-mono text-[12px] leading-relaxed text-white/85">
            {s.errors.map((e) => <div key={e.source}><p className="text-white/50">{e.source}</p>{e.lines.map((l, i) => <p key={i} className="break-all">{l}</p>)}</div>)}
          </div>
          <p className="mt-2 text-[11px] text-white/50">Text from the app, with secrets removed. Shown as text; Unit7 and its AI never follow it.</p>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <AiButton size="sm" onClick={() => askOnHome(explainPrompt(s), { send: true })}>Explain with AI</AiButton>
        <span className="text-[12px] text-muted">The cause above comes from Unit7’s own rules, not an AI.</span>
      </div>
    </div>
  );
}

// a card: load the replay for an incident, an alert or an app at a moment
export function ReplayCard({ className, story, ...input }: ReplayInput & { className?: string; story?: StoryOut }) {
  const r = useReplay(input, story);
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <div className="mb-4 flex items-center gap-3">
        <IconCircle size={40} tone="dark"><Clapperboard size={18} /></IconCircle>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16.5px] font-medium tracking-[-0.015em]">{r.data ? rawWords(r.data.title) : 'Replay'}</h2>
          <p className="truncate text-[12.5px] text-muted">{r.data ? `${r.data.scope.label} · ${hhmm(r.data.from)} to ${hhmm(r.data.to)}` : 'The ten minutes before and after'}</p>
        </div>
        {r.data?.coarse && <Badge>Half-hourly traffic</Badge>}
      </div>
      {r.error ? <p className="rounded-[16px] bg-raised px-4 py-6 text-center text-[13.5px] text-muted">Couldn’t replay it: {r.error}</p>
        : r.data ? <ReplayBody s={r.data} /> : <div className="space-y-3" aria-busy="true"><Skeleton className="h-10 rounded-[14px]" /><Skeleton className="h-32 rounded-[14px]" /></div>}
    </Card>
  );
}

// a button for alert and incident rows: opens the replay in the centred pop-up
export function ReplayButton({ label = 'Replay', size = 'sm', className, ...input }: ReplayInput & { label?: string; size?: 'sm' | 'md'; className?: string }) {
  const [open, setOpen] = useState(false);
  const r = useReplay(open ? input : null);
  return (
    <>
      <Button size={size} variant="soft" icon={<Clapperboard size={14} />} className={className} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={r.data ? rawWords(r.data.title) : 'What happened'} size="lg">
        {r.error ? <p className="text-[13.5px] text-muted">Couldn’t replay it: {r.error}</p> : r.data ? <><p className="mb-4 text-[12.5px] text-muted">{r.data.scope.label} · {hhmm(r.data.from)} to {hhmm(r.data.to)}</p><ReplayBody s={r.data} /></> : <Skeleton className="h-56 rounded-[18px]" />}
      </Modal>
    </>
  );
}
