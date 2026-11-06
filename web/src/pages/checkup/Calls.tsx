// The Call Inspector: wrong calls, repeated calls and waste, read from the proxy log and the database's own counters. For its first
// week it listens quietly, so the page says so and keeps what it heard behind one line, instead of raising false alarms.
import { useState } from 'react';
import { Radar } from 'lucide-react';
import { useTool } from '../care/data';
import { act, AiButton, Badge, Button, Card, PageHeader, Skeleton, timeAgo } from '../../ui';
import { GiveToAI } from './GiveToAI';

interface Signal { key: string; detector: string; title: string; plain: string; confidence: string; who: string; windows: number; hours: number; route?: string; host?: string; lastSeen: string }
interface List { learning: boolean; until: string; shown: Signal[]; quiet: Signal[] }
const SURE: Record<string, string> = { high: 'Measured', medium: 'Likely, not proven', low: 'A guess' };

function Row({ s, muted }: { s: Signal; muted?: boolean }) {
  const [give, setGive] = useState<'fix' | 'ticket'>();
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-[300px]">
        <p className="text-[14px] font-medium text-ink">{s.title}</p>
        <p className="mt-0.5 text-[13px] text-ink-2">{s.plain}</p>
        <p className="mt-0.5 text-[12.5px] text-muted">{[s.route, s.host].filter(Boolean).join(' · ')}{s.route || s.host ? ' · ' : ''}seen in {s.windows} check{s.windows === 1 ? '' : 's'}, last {timeAgo(s.lastSeen)}</p>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        <Badge tone="neutral">{SURE[s.confidence] ?? s.confidence}</Badge>
        {!muted && (s.who === 'you' ? <Button size="sm" variant="secondary" onClick={() => setGive('ticket')}>Write my support ticket</Button> : <AiButton size="sm" onClick={() => setGive('fix')}>Give this to my AI</AiButton>)}
      </span>
      {give && <GiveToAI open onClose={() => setGive(undefined)} refId={s.key} title={s.title} start={give} />}
    </li>
  );
}

export function CallsPage() {
  const { data, reload } = useTool<List>('inspect.list', {});
  const [more, setMore] = useState(false);
  return (
    <div>
      <PageHeader title="Call Inspector" subtitle="Wrong calls, repeated calls and waste, from your proxy log and your database’s own counters. Nothing to install." />
      {!data && <Skeleton className="mt-6 h-40 w-full" />}
      {data?.learning && (
        <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] bg-raised px-4 py-3 text-[13.5px] text-ink-2">
          <Radar size={16} aria-hidden className="shrink-0 text-blue" />
          <span className="min-w-0 flex-1 basis-[260px]">Listening quietly until {new Date(data.until).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, so a false alarm is caught before it bothers you.</span>
          <Button size="sm" variant="secondary" onClick={async () => { await act('inspect.show', { show: true }, { success: 'Showing what it found', undo: false }); reload(); }}>Show what it found</Button>
        </p>
      )}
      {data && !data.shown.length && !data.learning && <Card className="mt-6 p-8 text-center text-[13.5px] text-muted">Nothing wasteful seen so far. A signal has to repeat before it shows here.</Card>}
      {data && data.shown.length > 0 && <Card className="mt-5 px-5"><ul className="divide-y divide-line">{data.shown.map((s) => <Row key={s.key} s={s} />)}</ul></Card>}
      {data && data.quiet.length > 0 && (
        <section className="mt-6">
          <button type="button" onClick={() => setMore((m) => !m)} className="text-[13px] font-medium text-blue-text hover:underline">{more ? 'Hide' : `Show ${data.quiet.length} still being checked`}</button>
          {more && <Card className="mt-2 px-5"><ul className="divide-y divide-line">{data.quiet.map((s) => <Row key={s.key} s={s} muted />)}</ul></Card>}
        </section>
      )}
    </div>
  );
}
