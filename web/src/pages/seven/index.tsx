// Seven: the agent on shift. The whole page answers three things: does it need me, what did it do, and is it working. No chat box.
// A question has one Yes and one No. Everything else stays folded away until someone goes looking for it.
import { useState } from 'react';
import { CheckCircle2, ChevronDown, CircleSlash, Eye, Loader2, Sparkles } from 'lucide-react';
import { api, runTool } from '../../lib/api';
import { navigate } from '../../lib/router';
import { act, AiButton, Badge, Button, Card, Input, PageHeader, Skeleton, StatusMark, SwitchRow, cx, promptDialog, timeAgo, toast } from '../../ui';
import { useTool } from '../care/data';
import { GiveToAI } from '../checkup/GiveToAI';

export interface Ask { approvalId: string; question: string; why: string; change?: string; at: string; confirm?: string }
interface Handed { key: string; why: string; at: string }
interface Done { word: string; why: string; status: string; at: string; by: string }
interface ShiftRow { id: string; trigger: string; line: string | null; level: string | null; brain: string; cost: number; started_at: string }
interface Settings { on: boolean; budget: number; asks: number; web: boolean; code: boolean }
export interface Status { on: boolean; settings: Settings; working: boolean; line?: string; level?: string; lastAt?: string; nextAt?: string; notes: string[]; brain?: string; spent: number; asks: Ask[]; done: Done[]; handed: Handed[]; shifts: ShiftRow[]; notesFromYou: { key: string; value: string }[]; mind: { label: string } | null }
interface Shift { why: string | null; notes: string[]; thoughts: string[]; actions: { tool: string; why: string; status: string; result: string | null }[]; cost: number; turns: number }

const MARK = { calm: 'ok', look: 'warn', act: 'bad' } as const;
const nextIn = (at?: string) => { const h = at ? Math.round((Date.parse(at) - Date.now()) / 3600_000) : 0; return h >= 1 ? `Next look in about ${h} hour${h === 1 ? '' : 's'}` : 'Next look soon'; };
const money = (n: number) => `$${n < 0.1 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(2)}`;
const KIND: Record<string, string> = { round: 'Regular look', review: 'Daily review', event: 'Something happened', look: 'You asked' };
const STATUS: Record<string, { word: string; tone: 'ok' | 'warn' | 'neutral' }> = { fixed: { word: 'It worked', tone: 'ok' }, still: { word: 'It didn’t help', tone: 'warn' }, done: { word: 'Checking', tone: 'neutral' }, approved: { word: 'You said yes', tone: 'neutral' } };
const brainWord = (b?: string) => (!b || b === 'rules' ? 'fixed rules' : b === 'your-claude' ? 'your Claude' : b.split(':').slice(1).join(':') || b);

function Question({ a, onDone }: { a: Ask; onDone: () => void }) {
  const [busy, setBusy] = useState<'yes' | 'no'>();
  const answer = async (yes: boolean) => {
    // what can't be taken back gets its name typed, the same as on Approvals
    const confirm = yes && a.confirm ? await promptDialog({ title: 'This is hard to undo', label: `Type ${a.confirm} to say yes`, placeholder: a.confirm, confirm: 'Yes, do it' }) : undefined;
    if (confirm === null) return;
    setBusy(yes ? 'yes' : 'no');
    try { await api(`/api/approvals/${a.approvalId}/${yes ? 'approve' : 'reject'}`, { body: confirm ? { confirm } : {} }); toast('ok', yes ? 'Done' : 'OK, I’ll leave it', yes ? undefined : 'I won’t ask again for 30 days.'); onDone(); }
    catch (e) { toast('bad', 'That didn’t go through', (e as Error).message); }
    setBusy(undefined);
  };
  return (
    <Card className="p-5">
      <p className="text-[16px] font-semibold tracking-[-0.015em] text-ink">{a.question}</p>
      <p className="mt-1 text-[13.5px] text-ink-2">{a.why}</p>
      {a.change && <p className="mt-1 text-[13px] text-muted">{a.change}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" loading={busy === 'yes'} disabled={!!busy} onClick={() => answer(true)}>Yes, do it</Button>
        <Button variant="secondary" size="sm" loading={busy === 'no'} disabled={!!busy} onClick={() => answer(false)}>No</Button>
      </div>
    </Card>
  );
}

function HandedRow({ h, onDone }: { h: Handed; onDone: () => void }) {
  const [give, setGive] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <p className="min-w-0 flex-1 basis-[280px] text-[13.5px] text-ink-2">{h.why}</p>
      <AiButton size="sm" onClick={() => setGive(true)}>Give this to my AI</AiButton>
      {give && <GiveToAI open onClose={() => setGive(false)} refId={h.key} title={h.why} onSent={onDone} />}
    </li>
  );
}

function ShiftLine({ s }: { s: ShiftRow }) {
  const [open, setOpen] = useState(false), [d, setD] = useState<Shift>();
  const toggle = async () => { setOpen((o) => !o); if (!d) { const r = await runTool('seven.shift', { id: s.id }); if (r.status === 'ok') setD(r.output as Shift); } };
  return (
    <li className="py-2.5">
      <button type="button" aria-expanded={open} onClick={toggle} className="flex w-full items-start gap-3 text-left">
        <StatusMark state={MARK[(s.level ?? 'calm') as keyof typeof MARK] ?? 'ok'} size={16} className="mt-0.5" />
        <span className="min-w-0 flex-1 text-[13.5px] text-ink-2">{s.line}</span>
        <span className="shrink-0 text-[12px] text-muted">{timeAgo(s.started_at)}</span>
        <ChevronDown size={14} aria-hidden className={cx('mt-0.5 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 pl-7 text-[12.5px] text-muted">
          <p>{KIND[s.trigger] ?? s.trigger} · {brainWord(s.brain)}{s.cost ? ` · ${money(s.cost)}` : ''}{d?.why ? ` · ${d.why}` : ''}</p>
          {d?.thoughts.map((t, i) => <p key={i}>{t}</p>)}
          {d?.notes.map((t, i) => <p key={i} className="text-ink-2">{t}</p>)}
          {d?.actions.map((a, i) => <p key={i}>{a.status === 'asked' ? 'Asked' : a.status === 'refused' ? 'Stopped at the gate' : a.status === 'failed' ? 'Failed' : 'Did'}: {a.why}{a.result ? ` (${a.result})` : ''}</p>)}
        </div>
      )}
    </li>
  );
}

function Settings({ s, notes, reload }: { s: Settings; notes: Status['notesFromYou']; reload: () => void }) {
  const [text, setText] = useState('');
  const set = async (v: Partial<Settings>) => { await act('seven.settings', v, { success: 'Saved', undo: false }); reload(); };
  return (
    <Card className="mt-3 divide-y divide-line px-5">
      <SwitchRow title="Seven" body="Only a person can turn it off. Pause in Autopilot stops it too." checked={s.on} onChange={(on) => set({ on })} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3.5 text-[13.5px] text-ink-2">
        <label className="flex items-center gap-2 whitespace-nowrap">AI budget a day, in dollars <Input type="number" min={0} max={100} step={0.5} defaultValue={s.budget} className="h-8 !w-20" onBlur={(e) => { const v = Number(e.target.value); if (v !== s.budget) void set({ budget: v }); }} /></label>
        <label className="flex items-center gap-2 whitespace-nowrap">Questions a day <Input type="number" min={0} max={20} defaultValue={s.asks} className="h-8 !w-16" onBlur={(e) => { const v = Number(e.target.value); if (v !== s.asks) void set({ asks: v }); }} /></label>
      </div>
      <SwitchRow title="Read my code on GitHub" body="So a cause can name its file and line. Files made to hold secrets are refused." checked={s.code} onChange={(code) => set({ code })} />
      <SwitchRow title="Search the web" body="For what’s newer than the AI’s training. Only with Claude." checked={s.web} onChange={(web) => set({ web })} />
      <div className="py-3.5">
        <p className="text-[14px] font-medium text-ink">Tell Seven</p>
        <p className="text-[13px] text-muted">It reads these every shift: what’s normal here, what to leave alone.</p>
        <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">{notes.map((n) => <li key={n.key} className="flex items-center gap-2"><span className="min-w-0 flex-1">{n.value}</span><button type="button" className="text-[12.5px] text-muted hover:text-ink" onClick={async () => { await act('seven.note', { remove: n.key }, { undo: false }); reload(); }}>Remove</button></li>)}</ul>
        <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (text.trim().length < 3) return; await act('seven.note', { text }, { undo: false }); setText(''); reload(); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={400} placeholder="The preview site is a test copy. Leave it alone." className="min-w-0 flex-1" />
          <Button type="submit" size="sm" variant="secondary">Add</Button>
        </form>
      </div>
    </Card>
  );
}

export function SevenPage() {
  const { data: s, reload } = useTool<Status>('seven.status', {});
  const [busy, setBusy] = useState(false), [more, setMore] = useState(false);
  const look = async () => { setBusy(true); const r = await act('seven.look', {}, { undo: false }); setBusy(false); if (r) reload(); };
  const turnOn = async () => { await act('seven.settings', { on: true }, { success: 'Seven is on', undo: false }); reload(); };
  return (
    <div>
      <PageHeader title="Seven" subtitle="Your engineer on shift. It checks everything, does the safe work, and asks when it must."
        actions={<Button variant="primary" icon={busy || s?.working ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />} loading={busy} onClick={look}>Look now</Button>} />
      {!s && <Skeleton className="mt-6 h-40 w-full" />}
      {s && (
        <>
          <div className="mt-5">
            <h2 className="text-[26px] font-semibold tracking-[-0.03em] text-ink">{!s.on ? 'Off. I only look when you ask.' : s.working ? 'Looking now…' : s.line ?? 'Starting my first shift soon.'}</h2>
            <p className="mt-1 text-[13px] text-muted">{s.lastAt ? `Last look ${timeAgo(s.lastAt)}` : 'No shift yet'} · {s.on ? nextIn(s.nextAt) : 'Look now shows what I’d do'} · today {money(s.spent)} of {money(s.settings.budget)}</p>
            {!s.on && <Button size="sm" variant="secondary" className="mt-3" onClick={turnOn}>Turn Seven on</Button>}
          </div>
          {s.asks.length > 0 && (
            <section aria-labelledby="ask-h" className="mt-7">
              <h2 id="ask-h" className="text-[16px] font-semibold tracking-[-0.015em]">Should I?</h2>
              <div className="mt-2 space-y-3">{s.asks.map((a) => <Question key={a.approvalId} a={a} onDone={reload} />)}</div>
            </section>
          )}
          {!s.mind && (
            <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] bg-raised px-4 py-3 text-[13.5px] text-ink-2">
              <Sparkles size={16} aria-hidden className="shrink-0 text-blue" />
              <span className="min-w-0 flex-1 basis-[260px]">I’m working from fixed rules. They check, protect and ask, but don’t read your logs or code. An API key or a local model lets me do that on my own. Look now can use your Claude.</span>
              <Button size="sm" variant="secondary" onClick={() => navigate('/connections')}>Connect a model</Button>
            </p>
          )}
          {s.notes.length > 0 && <ul className="mt-5 space-y-1 text-[13.5px] text-ink-2">{s.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {s.handed.length > 0 && (
            <section aria-labelledby="hand-h" className="mt-7">
              <h2 id="hand-h" className="text-[16px] font-semibold tracking-[-0.015em]">For your AI</h2>
              <p className="text-[13px] text-muted">These are in your app’s code, so your builder fixes them. I’ll check production after your next deploy.</p>
              <ul className="mt-1 divide-y divide-line">{s.handed.map((h) => <HandedRow key={h.key} h={h} onDone={reload} />)}</ul>
            </section>
          )}
          {s.done.length > 0 && (
            <section aria-labelledby="done-h" className="mt-7">
              <h2 id="done-h" className="text-[16px] font-semibold tracking-[-0.015em]">Done for you</h2>
              <ul className="mt-2 divide-y divide-line">{s.done.map((d, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  {d.status === 'still' ? <CircleSlash size={16} className="shrink-0 text-warn" aria-hidden /> : <CheckCircle2 size={16} className="shrink-0 text-ok" aria-hidden />}
                  <span className="min-w-0 flex-1 basis-[240px] text-[13.5px] text-ink-2">{d.why}</span>
                  {STATUS[d.status] && <Badge tone={STATUS[d.status]!.tone}>{STATUS[d.status]!.word}</Badge>}
                  <span className="text-[12px] text-muted">{timeAgo(d.at)}</span>
                </li>
              ))}</ul>
            </section>
          )}
          {s.shifts.length > 0 && (
            <section aria-labelledby="shifts-h" className="mt-7">
              <h2 id="shifts-h" className="text-[16px] font-semibold tracking-[-0.015em]">Shifts</h2>
              <ul className="mt-1 divide-y divide-line">{s.shifts.slice(0, 7).map((x) => <ShiftLine key={x.id} s={x} />)}</ul>
            </section>
          )}
          <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-blue-text hover:underline">Settings<ChevronDown size={14} aria-hidden className={cx('transition-transform', more && 'rotate-180')} /></button>
          {more && <Settings s={s.settings} notes={s.notesFromYou} reload={reload} />}
        </>
      )}
    </div>
  );
}

// One line on Home: what Seven last said, and the first question if there is one
export function SevenLine() {
  const { data: s } = useTool<Status>('seven.status', {});
  if (!s?.on || (!s.line && !s.asks.length)) return null;
  return (
    <button type="button" onClick={() => navigate('/seven')} className="flex w-full items-center gap-3 rounded-[16px] border border-line bg-surface px-4 py-3 text-left shadow-soft transition hover:border-line-strong">
      <StatusMark state={s.asks.length ? 'warn' : MARK[(s.level ?? 'calm') as keyof typeof MARK] ?? 'ok'} size={18} />
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-2"><b className="font-medium text-ink">Seven:</b> {s.asks.length ? s.asks[0]!.question : s.line}</span>
      {s.lastAt && <span className="shrink-0 text-[12px] text-muted">{timeAgo(s.lastAt)}</span>}
    </button>
  );
}
