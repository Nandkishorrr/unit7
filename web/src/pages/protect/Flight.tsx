// What did my AI do? Every change each AI made, by session, in order, and one way back.
import { useState } from 'react';
import { useTool } from '../care/data';
import { runTool } from '../../lib/api';
import { Button, Badge, Card, PageHeader, Skeleton, act, confirmDialog, timeAgo } from '../../ui';

// the expert view: what really ran on the server
function Commands({ id }: { id: string }) {
  const [list, setList] = useState<string[]>();
  if (!list) return <button type="button" className="text-[12px] font-medium text-blue-text hover:underline" onClick={async () => { const r = await runTool('audit.commands', { auditId: id }); setList(r.status === 'ok' ? (r.output as { commands: string[] }).commands : []); }}>Exact commands</button>;
  return <pre className="mt-1 w-full max-h-48 overflow-auto whitespace-pre-wrap rounded-[10px] bg-sunken px-2.5 py-2 text-[11.5px] text-ink-2">{list.length ? list.join('\n\n') : 'Nothing ran on a server.'}</pre>;
}

interface Flight { agent: string; from: string; to: string; actions: { id: string; at: string; tool: string; result: string; reason: string | null }[]; undoable: { id: string; summary: string }[] }
export function FlightPage() {
  const { data, reload } = useTool<{ since: string; flights: Flight[] }>('ai.flight', {});
  const undoAll = async () => {
    if (!await confirmDialog({ title: 'Undo everything from the last day?', body: 'Each change goes back through its own undo, newest first. Changes with no undo stay as they are, and you’ll see which.', confirm: 'Undo all' })) return;
    await act('ai.undo_all', { since: data?.since }, { success: 'Undone', undo: false }); reload();
  };
  const can = data?.flights.reduce((n, f) => n + f.undoable.length, 0) ?? 0;
  return (
    <div>
      <PageHeader title="What did my AI do?" subtitle="Every change an AI made in the last day, by session. Warden’s own steps are in Activity." actions={can ? <Button variant="secondary" onClick={undoAll}>Undo all ({can})</Button> : undefined} />
      {!data && <Skeleton className="mt-6 h-40 w-full" />}
      {data && !data.flights.length && <Card className="mt-6 p-8 text-center text-[13.5px] text-muted">No AI changed anything in the last day.</Card>}
      <div className="mt-5 space-y-3">{data?.flights.map((f) => (
        <Card key={`${f.agent}${f.from}`} className="p-5">
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">{f.agent}<span className="text-[12.5px] font-normal text-muted">{timeAgo(f.to)} · {f.actions.length} change{f.actions.length === 1 ? '' : 's'}</span></p>
          <ul className="mt-2 divide-y divide-line">{f.actions.map((a) => <li key={a.at + a.tool} className="flex flex-wrap items-center gap-x-3 py-1.5 text-[13px]"><span className="tabular text-muted">{a.at.slice(11, 16)}</span><span className="min-w-0 flex-1 truncate text-ink-2">{a.reason ?? a.tool}</span>{a.result !== 'success' && <Badge tone="warn">{a.result}</Badge>}<Commands id={a.id} /></li>)}</ul>
        </Card>
      ))}</div>
    </div>
  );
}
