// Help, something's wrong. One button for a bad moment: it stops automatic changes, takes a safety copy, checks everything, and hands
// back what's broken, the first step, and a message for your customers.
import { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { runTool } from '../../lib/api';
import { navigate } from '../../lib/router';
import { act, Button, Card, CopyButton, PageHeader, toast } from '../../ui';

interface Result { done: string[]; line: string; first?: { title: string; why: string; who: string }; down: string[]; changed: { summary: string; actor: string | null; created_at: string }[]; message: string; checkupId?: string; next: string }

export function HelpNowPage() {
  const [busy, setBusy] = useState(false), [r, setR] = useState<Result>();
  const press = async () => {
    setBusy(true);
    const out = await runTool('help.now', {});
    setBusy(false);
    if (out.status === 'ok') setR(out.output as Result); else toast('bad', 'That didn’t finish', out.status === 'error' ? out.error.message : undefined);
  };
  return (
    <div>
      <PageHeader title="Help, something’s wrong" subtitle="Stops automatic changes, takes a safety copy, checks everything, and shows you the first step." />
      {!r && (
        <Card className="mt-6 p-8 text-center">
          <LifeBuoy size={32} className="mx-auto text-bad" aria-hidden />
          <p className="mx-auto mt-3 max-w-md text-[14px] text-ink-2">Nothing you run gets changed. It only pauses Unit7’s own automatic steps, and you can turn those back on.</p>
          <Button variant="primary" size="lg" className="mt-4" loading={busy} onClick={press}>Help me now</Button>
          {busy && <p className="mt-3 text-[13px] text-muted">Taking a safety copy and checking everything. A minute or two.</p>}
        </Card>
      )}
      {r && (
        <div className="mt-5 space-y-4">
          <p className="text-[24px] font-semibold tracking-[-0.03em] text-ink">{r.line}</p>
          <ul className="space-y-0.5 text-[13.5px] text-ink-2">{r.done.map((d) => <li key={d}>{d}</li>)}</ul>
          {r.first && <Card className="p-5"><p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">First step</p><p className="mt-1 text-[16px] font-medium text-ink">{r.first.title}</p><p className="mt-0.5 text-[13.5px] text-ink-2">{r.first.why}</p><Button size="sm" variant="primary" className="mt-3" onClick={() => navigate(r.checkupId ? `/checkup?id=${r.checkupId}` : '/checkup')}>See everything</Button></Card>}
          {r.changed.length > 0 && <Card className="p-5"><p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">Changed in the last day</p><ul className="mt-1 space-y-0.5 text-[13.5px] text-ink-2">{r.changed.map((c) => <li key={c.created_at + c.summary}>{c.summary}{c.actor ? ` (${c.actor})` : ''}</li>)}</ul></Card>}
          <Card className="p-5"><p className="flex items-center justify-between text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">A message for your customers<CopyButton text={r.message} /></p><p className="mt-1 text-[14px] text-ink">{r.message}</p></Card>
          <Button variant="secondary" onClick={async () => { await act('autopilot.set', { paused: false }, { success: 'Automatic steps are back on', undo: false }); navigate('/autopilot'); }}>Turn automatic steps back on</Button>
        </div>
      )}
    </div>
  );
}
