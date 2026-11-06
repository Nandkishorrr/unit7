// The week on one page. Share it with a client, or read it on a Monday.
import { useTool } from '../care/data';
import { Badge, Button, Card, PageHeader, Skeleton, toast } from '../../ui';

interface Line { word: string; line: string }
interface CardData { week: string; protected: Line; up: Line; fast: Line; safe: Line; streaks: string[]; watched: number; fixed: number; markdown: string }
const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = { Good: 'ok', Fair: 'warn', 'Needs work': 'bad', 'Not measured': 'neutral' };
const ROWS = [['protected', 'Protected'], ['up', 'Up'], ['fast', 'Fast'], ['safe', 'Safe']] as const;

export function ReportCardPage() {
  const { data } = useTool<CardData>('report.card', {});
  return (
    <div>
      <PageHeader title="Weekly report" subtitle="Protected, up, fast and safe, from what Unit7 measured." actions={data ? <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(data.markdown); toast('ok', 'Copied', 'Paste it into an email for your client.'); }}>Copy</Button> : undefined} />
      {!data && <Skeleton className="mt-6 h-48 w-full" />}
      {data && (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">{ROWS.map(([k, label]) => { const r = data[k]; return <Card key={k} className="p-5"><p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted">{label}</p><p className="mt-2"><Badge tone={TONE[r.word] ?? 'neutral'}>{r.word}</Badge></p><p className="mt-1.5 text-[13.5px] text-ink-2">{r.line}</p></Card>; })}</div>
          <p className="mt-4 text-[13.5px] text-ink-2">Unit7 watched {data.watched}% of the week.{data.fixed ? ` ${data.fixed} problem${data.fixed === 1 ? '' : 's'} fixed and proven.` : ''}</p>
          {data.streaks.map((s) => <p key={s} className="mt-1 text-[13.5px] font-medium text-ok">{s}</p>)}
        </>
      )}
    </div>
  );
}
