// The Check-up page: the first line is always a verdict, then four sentences (room, protection, safety, app behaviour),
// what was and wasn't checked, what Unit7 already did, what to do first and who does it, and what can be reduced. One
// recommended action per thing. Everything here comes from checkup.run, which needs no AI.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, ChevronDown, EyeOff, Loader2, Play, Shield, Sparkles, Stethoscope, ThumbsDown, ThumbsUp } from 'lucide-react';
import { runTool } from '../../lib/api';
import { navigate, useQuery } from '../../lib/router';
import { act, AiButton, Badge, Button, Card, Meter, Modal, PageHeader, Skeleton, StatusMark, cx, timeAgo, toast } from '../../ui';
import { useTool } from '../care/data';
import { GiveToAI, StatusChip } from './GiveToAI';
import { askOnHome } from '../Help';
import { AREA_WORDS, WHO_WORDS, bytes, checkedLine, fullIn, type Area, type Checkup, type History, type Item, type RoomServer, type Saving, type Tone } from './shape';

const TONE_MARK = { good: 'ok', look: 'warn', act: 'bad' } as const;
const WHO_TONE = { unit7: 'info', 'your-ai': 'neutral', you: 'warn' } as const;

function Verdicts({ c }: { c: Checkup }) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {(Object.keys(AREA_WORDS) as Area[]).map((a) => {
        const v = c.verdicts[a];
        return (
          <Card key={a} className="p-4">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted">{AREA_WORDS[a]}</p>
            <p className="mt-2 flex items-center gap-2 text-[17px] font-semibold tracking-[-0.02em] text-ink"><StatusMark state={TONE_MARK[v.tone]} size={18} />{v.word}</p>
            <p className="mt-1 text-[13px] text-ink-2">{v.line}</p>
            {a === 'room' && fullIn(c.room[0]?.disk.daysLeft) && <p className="mt-1 text-[12.5px] text-muted">{fullIn(c.room[0]?.disk.daysLeft)}</p>}
          </Card>
        );
      })}
    </div>
  );
}

function CheckedRow({ c }: { c: Checkup }) {
  const [open, setOpen] = useState(false);
  const skipped = c.checked.filter((x) => !x.ok);
  return (
    <div className="mt-4 text-[13px] text-ink-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded-full hover:text-ink">
        {checkedLine(c.checked)}{skipped.length ? ` · ${skipped.length} skipped` : ''}<ChevronDown size={14} aria-hidden className={cx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="mt-2 space-y-1">
          {skipped.map((x) => <li key={x.id} className="flex gap-2"><StatusMark state="warn" size={15} className="mt-0.5" /><span><b className="font-medium text-ink">{x.label}</b>{x.why ? <span className="text-muted">: {x.why}</span> : null}</span>{x.fix && <Button size="sm" variant="ghost" className="ml-auto shrink-0" onClick={() => act(x.fix!.tool, x.fix!.input, { success: `${x.fix!.label}: started` })}>{x.fix.label}</Button>}</li>)}
          {c.checked.filter((x) => x.ok).map((x) => <li key={x.id} className="flex gap-2 text-muted"><StatusMark state="ok" size={15} className="mt-0.5" />{x.label}</li>)}
        </ul>
      )}
    </div>
  );
}

function ItemAction({ i, onDone }: { i: Item; onDone: () => void }) {
  const f = i.fix;
  const [give, setGive] = useState<'fix' | 'ticket'>();
  if (i.who !== 'unit7') return (
    <>
      {i.who === 'your-ai' ? <AiButton size="sm" onClick={() => setGive('fix')}>Give this to my AI</AiButton> : f?.href ? <Button size="sm" variant="secondary" onClick={() => navigate(f.href!)}>{f.label ?? 'Open'}</Button> : <Button size="sm" variant="secondary" onClick={() => setGive('ticket')}>Write my support ticket</Button>}
      {give && <GiveToAI open onClose={() => setGive(undefined)} refId={i.id} title={i.title} start={give} onSent={onDone} />}
    </>
  );
  if (f?.tool) return <Button size="sm" variant="primary" onClick={async () => { const r = await act(f.tool!, f.input ?? {}, { success: `${f.label ?? 'Done'}: done` }); if (r?.status === 'ok') onDone(); }}>{f.label ?? 'Fix it'}</Button>;
  if (f?.ask) return <Button size="sm" variant="secondary" onClick={() => askOnHome(f.ask!)}>{f.label ?? 'Ask Unit7'}</Button>;
  if (f?.href) return <Button size="sm" variant="secondary" onClick={() => navigate(f.href!)}>{f.label ?? 'Open'}</Button>;
  return null;
}

// Right or Wrong: the only confidence number Unit7 shows comes from these taps
function Judge({ k }: { k: string }) {
  const [said, setSaid] = useState<boolean>();
  const say = async (right: boolean) => { setSaid(right); await runTool('finding.judge', { key: k, right }); };
  if (said !== undefined) return <span className="text-[12px] text-muted">{said ? 'Noted: right' : 'Noted: wrong'}</span>;
  return <span className="flex items-center gap-1"><button type="button" aria-label="This was right" title="This was right" onClick={() => say(true)} className="grid size-7 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><ThumbsUp size={14} aria-hidden /></button><button type="button" aria-label="This was wrong" title="This was wrong" onClick={() => say(false)} className="grid size-7 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><ThumbsDown size={14} aria-hidden /></button></span>;
}

function Learned({ c }: { c: Checkup }) {
  const [gone, setGone] = useState<string[]>([]);
  const list = (c.learn ?? []).filter((l) => !gone.includes(l.finding));
  if (!list.length) return null;
  return (
    <section className="mt-6"><h2 className="text-[16px] font-semibold tracking-[-0.015em]">That worked</h2>
      <ul className="mt-2 divide-y divide-line">{list.map((l) => (
        <li key={l.finding} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"><p className="min-w-0 flex-1 basis-[260px] text-[13.5px] text-ink-2">{l.title}: your fix worked. Do this by itself next time?</p>
          <Button size="sm" variant="secondary" onClick={async () => { await act('playbook.learn', { finding: l.finding, tool: l.tool }, { success: 'Unit7 will do this by itself next time', undo: false }); setGone((g) => [...g, l.finding]); }}>Yes, next time</Button>
          <Button size="sm" variant="ghost" onClick={() => setGone((g) => [...g, l.finding])}>No</Button></li>
      ))}</ul>
    </section>
  );
}

function Items({ c, onDone }: { c: Checkup; onDone: () => void }) {
  const [all, setAll] = useState(false);
  const list = c.items.filter((i) => !['info'].includes(i.severity));
  const shown = all ? list : list.slice(0, 6);
  if (!list.length) return null;
  return (
    <section aria-labelledby="todo-h" className="mt-7">
      <h2 id="todo-h" className="text-[16px] font-semibold tracking-[-0.015em]">Do these first</h2>
      <ol className="mt-2 divide-y divide-line">
        {shown.map((i, n) => (
          <li key={i.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
            <span aria-hidden className="tabular mt-0.5 w-5 shrink-0 text-[13px] text-faint">{n + 1}</span>
            <div className="min-w-0 flex-1 basis-[280px]">
              <p className="text-[14px] font-medium text-ink">{i.title}</p>
              <p className="mt-0.5 text-[13px] text-ink-2">{i.why}</p>
              {i.fix?.manual && <ul className="mt-1 list-disc pl-4 text-[12.5px] text-muted">{i.fix.manual.map((m) => <li key={m}>{m}</li>)}</ul>}
            </div>
            <span className="flex shrink-0 flex-wrap items-center gap-2"><Badge tone={WHO_TONE[i.who]}>{WHO_WORDS[i.who]}</Badge><ItemAction i={i} onDone={onDone} /><Judge k={i.id} /></span>
          </li>
        ))}
      </ol>
      {list.length > 6 && <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 text-[13px] font-medium text-blue-text hover:underline">{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </section>
  );
}

interface Tracked { id: string; title: string; app: string; status: string; statusWords: string; win?: string | null }
function WithYourAI({ c }: { c: Checkup }) {
  const { data } = useTool<{ findings: Tracked[] }>('findings.list', { limit: 30 });
  const list = (data?.findings ?? []).filter((f) => f.status !== 'open').slice(0, 8);
  if (!list.length) return null;
  return (
    <section aria-labelledby="ai-h" className="mt-7" data-at={c.at}>
      <h2 id="ai-h" className="text-[16px] font-semibold tracking-[-0.015em]">With your AI</h2>
      <ul className="mt-2 divide-y divide-line">{list.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
          <div className="min-w-0 flex-1 basis-[280px]"><p className="text-[14px] font-medium text-ink">{f.title}</p>{f.win && <p className="text-[13px] text-ok">{f.win}</p>}<p className="text-[12.5px] text-muted">{f.app}</p></div>
          <StatusChip status={f.status} words={f.statusWords} />
        </li>
      ))}</ul>
    </section>
  );
}

interface Compared { from: string; to: string; fixed: string[]; fresh: string[]; same: number; areas: { area: Area; from?: string; to: string; moved: string }[] }
function Compare({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useTool<Compared>('checkup.compare', { a: id });
  return (
    <Modal open onClose={onClose} title="What changed" size="md">
      {!data ? <Skeleton className="h-32 w-full" /> : (
        <div className="space-y-3 text-[13.5px] text-ink-2">
          <p className="text-muted">{timeAgo(data.from)} compared with {timeAgo(data.to)}: {data.fixed.length} fixed · {data.fresh.length} new · {data.same} the same</p>
          <ul className="divide-y divide-line">{data.areas.map((a) => <li key={a.area} className="flex justify-between gap-3 py-2"><span>{AREA_WORDS[a.area]}</span><span className="text-ink">{a.from && a.from !== a.to ? `${a.from} → ` : ''}{a.to}{a.moved !== 'same' ? ` (${a.moved})` : ''}</span></li>)}</ul>
          {data.fixed.length > 0 && <div><p className="font-medium text-ink">Fixed</p><ul className="list-disc pl-4">{data.fixed.map((t) => <li key={t}>{t}</li>)}</ul></div>}
          {data.fresh.length > 0 && <div><p className="font-medium text-ink">New</p><ul className="list-disc pl-4">{data.fresh.map((t) => <li key={t}>{t}</li>)}</ul></div>}
        </div>
      )}
    </Modal>
  );
}

function Reduce({ list, onDone }: { list: Saving[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const safe = list.filter((s) => s.safe && s.tool);
  if (!list.length) return null;
  const all = async () => {
    setBusy(true);
    for (const s of safe) await act(s.tool!, s.input ?? {}, { success: `${s.saves}: done` });
    setBusy(false); onDone();
  };
  return (
    <section aria-labelledby="reduce-h" className="mt-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="reduce-h" className="min-w-0 flex-1 text-[16px] font-semibold tracking-[-0.015em]">Reduce</h2>
        {safe.length > 0 && <Button size="sm" variant="primary" loading={busy} onClick={all}>Do the safe ones</Button>}
      </div>
      <ul className="mt-2 divide-y divide-line">{list.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
          <div className="min-w-0 flex-1 basis-[280px]"><p className="text-[14px] font-medium text-ink">{s.title}</p><p className="text-[13px] text-ink-2">{s.detail} <span className="text-muted">{s.undo}</span></p></div>
          {s.tool ? <Button size="sm" variant="secondary" onClick={async () => { await act(s.tool!, s.input ?? {}, { success: `${s.saves}: done` }); onDone(); }}>{s.label ?? s.saves}</Button>
            : s.ask ? <Button size="sm" variant="secondary" onClick={() => askOnHome(s.ask!)}>Ask Unit7</Button> : <span className="text-[12.5px] text-muted">{s.saves}</span>}
        </li>
      ))}</ul>
    </section>
  );
}

function Room({ s }: { s: RoomServer }) {
  const top = s.projects.filter((p) => p.mem > 0).slice(0, 6), max = Math.max(1, ...top.map((p) => p.mem));
  return (
    <Card className="p-4">
      <p className="text-[14px] font-medium text-ink">{s.name}</p>
      <dl className="mt-2 space-y-2 text-[12.5px]">
        <div><dt className="flex justify-between text-ink-2"><span>Memory</span><span className="tabular">{bytes(s.ram.used)} of {bytes(s.ram.total)}{s.ram.peakPct ? ` · peak ${s.ram.peakPct}%` : ''}</span></dt><dd className="mt-1"><Meter value={s.ram.pct} label="Memory used" /></dd></div>
        <div><dt className="flex justify-between text-ink-2"><span>Disk</span><span className="tabular">{bytes(s.disk.used)} of {bytes(s.disk.total)}</span></dt><dd className="mt-1"><Meter value={s.disk.pct} label="Disk used" /></dd></div>
        <div className="flex justify-between text-ink-2"><span>CPU</span><span className="tabular">{s.cpu.now}% now{s.cpu.peak ? ` · busiest hour ${s.cpu.peak}%` : ''}</span></div>
      </dl>
      {top.length > 0 && (
        <>
          <h3 className="mt-3 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted">Who’s using the memory</h3>
          <ul className="mt-1.5 space-y-1">{top.map((p) => (
            <li key={p.id} className="text-[12.5px]"><span className="flex justify-between gap-3"><span className="min-w-0 truncate text-ink-2">{p.name}</span><span className="tabular shrink-0 text-ink">{bytes(p.mem)}</span></span><span aria-hidden className="mt-0.5 block h-1 rounded-full bg-blue/70" style={{ width: `${(100 * p.mem) / max}%` }} /></li>
          ))}</ul>
        </>
      )}
    </Card>
  );
}

const Running = () => (
  <Card className="mt-6 flex items-center gap-4 p-6">
    <Loader2 size={22} className="shrink-0 animate-spin text-blue" aria-hidden />
    <div><p className="text-[15px] font-medium text-ink">Checking everything…</p><p className="text-[13px] text-muted">Usually about a minute. It only reads; nothing changes. You can leave this page.</p></div>
  </Card>
);

export function CheckupPage() {
  const q = useQuery();
  const [data, setData] = useState<{ report: Checkup | null; history: History[] } | null>(null);
  const [running, setRunning] = useState(false);
  const started = useRef(false);
  const load = async () => { const r = await runTool('checkup.get', q.get('id') ? { id: q.get('id') } : {}); if (r.status === 'ok') setData(r.output as never); else setData({ report: null, history: [] }); };
  const start = async (quick = false) => {
    setRunning(true);
    try {
      const r = await runTool('checkup.run', { quick });
      if (r.status !== 'ok') toast('bad', 'The Check-up didn’t finish', r.status === 'error' ? r.error.message : undefined);
      await load();
    } finally { setRunning(false); }
  };
  useEffect(() => { void load(); if (q.get('run') && !started.current) { started.current = true; navigate('/checkup', { replace: true }); void start(); } }, []);
  const c = data?.report;
  const [comparing, setComparing] = useState<string>();
  return (
    <div>
      <PageHeader title="Check-up" subtitle="Is there room, is your data safe, is anything open, and is your app behaving." actions={<Button variant="primary" icon={<Play size={15} />} loading={running} onClick={() => start()}>{c ? 'Run again' : 'Run a Check-up'}</Button>} />
      {comparing && <Compare id={comparing} onClose={() => setComparing(undefined)} />}
      {running && <Running />}
      {!data && !running && <Skeleton className="mt-6 h-40 w-full" />}
      {data && !c && !running && (
        <Card className="mt-6 p-8 text-center">
          <Stethoscope size={28} className="mx-auto text-blue" aria-hidden />
          <p className="mt-3 text-[16px] font-medium text-ink">No Check-up yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13.5px] text-muted">About a minute, free, and it only reads. No AI needed.</p>
          <Button variant="primary" className="mt-4" onClick={() => start()}>Run a Check-up</Button>
        </Card>
      )}
      {c && !running && (
        <>
          <div className="mt-5">
            <h2 className="text-[26px] font-semibold tracking-[-0.03em] text-ink">{c.line}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[13px] text-muted">
              <span>{timeAgo(c.at)} · {Math.max(1, Math.round(c.ms / 1000))}s</span>
              {c.since && (c.since.fixed.length + c.since.fresh.length > 0) && <span>Since last time: {c.since.fixed.length} fixed · {c.since.fresh.length} new · {c.since.same} the same</span>}
            </p>
          </div>
          {c.blindHours >= 1 && <p className="mt-3 flex items-center gap-2 rounded-[12px] bg-raised px-3 py-2 text-[13px] text-ink-2"><EyeOff size={15} aria-hidden className="shrink-0" />Unit7 wasn’t watching for {c.blindHours} hours this week, usually because this computer was asleep.</p>}
          <Verdicts c={c} />
          <CheckedRow c={c} />
          {c.done.length > 0 && (
            <section className="mt-6"><h2 className="text-[16px] font-semibold tracking-[-0.015em]">Done for you</h2>
              <ul className="mt-2 space-y-1 text-[13.5px] text-ink-2">{c.done.map((d) => <li key={d} className="flex items-center gap-2"><CheckCircle2 size={16} className="shrink-0 text-ok" aria-hidden />{d}. Nothing else changed.</li>)}</ul>
            </section>
          )}
          <Items c={c} onDone={load} />
          <Learned c={c} />
          <WithYourAI c={c} />
          <Reduce list={c.reduce} onDone={load} />
          {c.room.length > 0 && <section className="mt-7"><h2 className="text-[16px] font-semibold tracking-[-0.015em]">Your servers</h2><div className="mt-2 grid gap-3 lg:grid-cols-2">{c.room.map((s) => <Room key={s.id} s={s} />)}</div></section>}
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={<Shield size={14} />} onClick={() => navigate('/protect')}>See what’s protected</Button>
            <Button variant="secondary" size="sm" icon={<Sparkles size={14} />} onClick={() => askOnHome('Read my app logs and tell me about wrong or repeated calls, and what to optimise. Look first, read-only. Then give me a prompt for the AI that built my software.')}>Ask AI to read the logs too</Button>
            <Button variant="ghost" size="sm" icon={<ArrowUpRight size={14} />} onClick={() => navigate('/routines')}>Run this on a schedule</Button>
          </div>
          {data!.history.length > 1 && (
            <section className="mt-8"><h2 className="text-[13px] font-semibold text-muted">Earlier</h2>
              <ul className="mt-1 divide-y divide-line">{data!.history.slice(1, 8).map((h) => (
                <li key={h.id}><a href={`/checkup?id=${h.id}`} onClick={(e) => { e.preventDefault(); navigate(`/checkup?id=${h.id}`); void runTool('checkup.get', { id: h.id }).then((r) => r.status === 'ok' && setData(r.output as never)); }} className="flex items-center gap-2 py-2 text-[13px] text-ink-2 hover:text-ink"><StatusMark state={TONE_MARK[h.level as Tone]} size={15} /><span className="min-w-0 flex-1 truncate">{h.line}</span><span className="shrink-0 text-muted">{timeAgo(h.at)}</span></a><button type="button" onClick={() => setComparing(h.id)} className="ml-2 text-[12.5px] font-medium text-blue-text hover:underline">Compare</button></li>
              ))}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
