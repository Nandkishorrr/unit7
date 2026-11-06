// The security jobs that aren't a yes or no: who can get in, a company got hacked, could one night cost me a fortune, and if this
// server died today. The checks that find problems put them on the Check-up. This is where you go to ask.
import { useState } from 'react';
import { useTool } from '../care/data';
import { runTool } from '../../lib/api';
import { act, Badge, Button, Card, Input, PageHeader, Skeleton, toast } from '../../ui';

interface Who { servers: { server: string; keys: { key: string; fresh: boolean }[]; users: { user: string; root: boolean; fresh: boolean }[] }[]; unit7Keys: { name: string; role: string; lastUsed: string | null }[] }
interface Brake { line: string; worst?: string; list: { provider: string; brake: string; words: string }[] }
interface Tick { app: string; key: string; done: boolean }
const BRAKE_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'neutral'> = { fixed: 'ok', prepaid: 'ok', 'needs-setup': 'warn', none: 'bad', unknown: 'neutral' };
const BRAKE_WORD: Record<string, string> = { fixed: 'Fixed price', prepaid: 'Prepaid', 'needs-setup': 'Needs turning on', none: 'No brake', unknown: 'Check it' };

function WhoCard() {
  const [d, setD] = useState<Who>(), [busy, setBusy] = useState(false);
  const look = async () => { setBusy(true); const r = await runTool('security.who', {}); setBusy(false); if (r.status === 'ok') setD(r.output as Who); else toast('bad', 'That didn’t work', r.status === 'error' ? r.error.message : undefined); };
  return (
    <Card className="p-5"><h2 className="text-[15px] font-semibold tracking-[-0.015em]">Who can get in</h2><p className="text-[13px] text-muted">Every key and user on your servers, with anything new marked.</p>
      {!d && <Button size="sm" variant="secondary" className="mt-3" loading={busy} onClick={look}>Show me</Button>}
      {d?.servers.map((s) => <div key={s.server} className="mt-3"><p className="text-[13.5px] font-medium text-ink">{s.server}</p><ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-2">{s.users.map((u) => <li key={u.user} className="flex items-center gap-2">{u.user}{u.root && <Badge tone="warn">all-powerful</Badge>}{u.fresh && <Badge tone="bad">new</Badge>}</li>)}{s.keys.map((k) => <li key={k.key} className="flex items-center gap-2 truncate">{k.key}{k.fresh && <Badge tone="bad">new</Badge>}</li>)}</ul></div>)}
    </Card>
  );
}
function BreachCard() {
  const [provider, setProvider] = useState(''), [list, setList] = useState<{ id: string; items: Tick[]; note: string }>(), [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); const r = await runTool('security.breach', { provider }); setBusy(false); if (r.status === 'ok') setList(r.output as never); else toast('bad', 'That didn’t work', r.status === 'error' ? r.error.message : undefined); };
  const tick = async (t: Tick) => { await runTool('security.breach_tick', { id: list!.id, app: t.app, key: t.key, done: !t.done }); setList({ ...list!, items: list!.items.map((x) => (x === t ? { ...x, done: !x.done } : x)) }); };
  return (
    <Card className="p-5"><h2 className="text-[15px] font-semibold tracking-[-0.015em]">A company got hacked</h2><p className="text-[13px] text-muted">Unit7 takes a fresh copy, then lists every setting of yours from that company, most dangerous first.</p>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={go}><Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="vercel, supabase, stripe…" aria-label="Which company" className="min-w-0 flex-1 basis-[180px]" /><Button type="submit" size="sm" variant="secondary" loading={busy} disabled={provider.length < 2}>Make my list</Button></form>
      {list && <><p className="mt-3 text-[13px] text-ink-2">{list.note}</p><ul className="mt-1 space-y-1">{list.items.map((t) => <li key={t.app + t.key}><label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={t.done} onChange={() => tick(t)} /><span className={t.done ? 'line-through' : ''}>{t.key}</span><span className="text-muted">{t.app}</span></label></li>)}</ul></>}
    </Card>
  );
}
function BrakeCard() {
  const { data } = useTool<Brake>('spend.brake', {});
  return (
    <Card className="p-5"><h2 className="text-[15px] font-semibold tracking-[-0.015em]">Could one night cost me a fortune?</h2>
      {!data ? <Skeleton className="mt-2 h-16 w-full" /> : <><p className="mt-1 text-[13.5px] text-ink">{data.line}</p>{data.worst && <p className="text-[13px] text-ink-2">{data.worst}</p>}<ul className="mt-2 divide-y divide-line">{data.list.map((b) => <li key={b.provider} className="flex flex-wrap items-center gap-2 py-2"><span className="text-[13.5px] font-medium capitalize text-ink">{b.provider}</span><Badge tone={BRAKE_TONE[b.brake] ?? 'neutral'}>{BRAKE_WORD[b.brake] ?? b.brake}</Badge><p className="w-full text-[12.5px] text-muted">{b.words}</p></li>)}</ul></>}
    </Card>
  );
}
function DrillCard() {
  const { data } = useTool<{ guarded: { serverId: string; part: string; name: string; important: boolean; lastCopy?: string; service?: string }[] }>('safety.status', {});
  const [out, setOut] = useState<{ line: string; steps: { step: string; minutes: number; measured: boolean }[]; gaps: string[] }>();
  const list = data?.guarded.filter((g) => g.important && g.lastCopy && !g.service) ?? [];
  return (
    <Card className="p-5"><h2 className="text-[15px] font-semibold tracking-[-0.015em]">If this server died today</h2><p className="text-[13px] text-muted">A real restore into a throwaway, timed. Your live data isn’t touched.</p>
      {!list.length && <p className="mt-2 text-[13px] text-muted">It needs a copy to restore first.</p>}
      <div className="mt-2 flex flex-wrap gap-2">{list.slice(0, 4).map((g) => <Button key={g.part} size="sm" variant="secondary" onClick={async () => { const r = await act('safety.fire_drill', { serverId: g.serverId, part: g.part }, { success: 'Drill finished', undo: false }); if (r) setOut(r.output as never); }}>Drill {g.name}</Button>)}</div>
      {out && <><p className="mt-3 text-[16px] font-medium text-ink">{out.line}</p><ul className="mt-1 text-[13px] text-ink-2">{out.steps.map((s) => <li key={s.step}>{s.step}: {s.measured ? `${s.minutes} min, measured` : `about ${s.minutes} min`}</li>)}</ul>{out.gaps.map((g) => <p key={g} className="mt-1 text-[13px] text-warn">{g}</p>)}</>}
    </Card>
  );
}
export function DeepPage() {
  return (
    <div>
      <PageHeader title="Deep security" subtitle="What a stranger can do, door rules and break-in signs come with each full Check-up. These you ask for." />
      <div className="mt-5 grid gap-4 lg:grid-cols-2"><DrillCard /><BreachCard /><BrakeCard /><WhoCard /></div>
    </div>
  );
}
