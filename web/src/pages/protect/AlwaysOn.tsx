// Always on: was anyone watching, and how to make sure someone is. The honest number comes first. On a computer that sleeps, Unit7
// misses hours, so this page says which, and offers the ways out, smallest first.
import { useState } from 'react';
import { Satellite } from 'lucide-react';
import { useTool } from '../care/data';
import { act, Badge, Button, Card, Input, PageHeader, Skeleton, SwitchRow, timeAgo } from '../../ui';

interface Status { watched: number; gaps: { from: string; to: string }[]; stayAwake: boolean; mac: boolean; heartbeat: boolean; phone: boolean; servers: { id: string; name: string; outpost: boolean; lastReading?: string }[] }
const stamp = (at: string) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function AlwaysOnPage() {
  const { data: d, reload } = useTool<Status>('always.status', {});
  const [url, setUrl] = useState('');
  return (
    <div>
      <PageHeader title="Always on" subtitle="Unit7 runs on this computer, so it stops when this computer sleeps. Here’s what it missed, and how to fix that." />
      {!d && <Skeleton className="mt-6 h-48 w-full" />}
      {d && (
        <>
          <p className="mt-5 text-[26px] font-semibold tracking-[-0.03em] text-ink">{d.watched >= 99 ? 'Watching all week.' : `Watching ${d.watched}% of this week.`}</p>
          {d.gaps.length > 0 && <ul className="mt-2 space-y-0.5 text-[13.5px] text-ink-2">{d.gaps.slice(-5).reverse().map((g) => <li key={g.from}>I wasn’t watching from {stamp(g.from)} to {stamp(g.to)}.</li>)}</ul>}
          <Card className="mt-5 px-5">
            <h2 className="pt-4 text-[15px] font-semibold tracking-[-0.015em]">Outpost</h2>
            <p className="text-[13px] text-muted">One small script on the server. It keeps measuring, checks your sites from inside, takes the nightly copies and sends phone alerts by itself. It opens no port, and holds only the alert channel.{!d.phone ? ' Connect phone alerts first so it can reach you.' : ''}</p>
            <ul className="mt-1 divide-y divide-line">{d.servers.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <div className="min-w-0 flex-1 basis-[200px]"><p className="text-[14px] font-medium text-ink">{s.name}</p><p className="text-[12.5px] text-muted">{s.outpost ? (s.lastReading ? `Last reading ${timeAgo(s.lastReading)}` : 'Installed, waiting for its first reading') : 'Not installed'}</p></div>
                {s.outpost && <Badge tone="ok"><Satellite size={13} aria-hidden />On</Badge>}
                {s.outpost ? <><Button size="sm" variant="secondary" onClick={async () => { await act('outpost.install', { serverId: s.id }, { success: 'Updated' }); reload(); }}>Update</Button><Button size="sm" variant="ghost" onClick={async () => { await act('outpost.remove', { serverId: s.id }, { success: 'Removed', undo: false }); reload(); }}>Remove</Button></>
                  : <Button size="sm" variant="primary" onClick={async () => { await act('outpost.install', { serverId: s.id }, { success: 'The Outpost is on' }); reload(); }}>Install</Button>}
              </li>
            ))}</ul>
          </Card>
          <Card className="mt-4 divide-y divide-line px-5">
            {d.mac && <SwitchRow title="Keep this Mac awake" body="Stays awake while it’s plugged in. A cheap stopgap: on battery it sleeps as usual." checked={d.stayAwake} onChange={async (on) => { await act('always.stay_awake', { on }, { success: on ? 'This Mac stays awake while plugged in' : 'This Mac sleeps as usual', undo: false }); reload(); }} />}
            <div className="py-3.5">
              <p className="text-[14px] font-medium text-ink">Outside heartbeat {d.heartbeat && <Badge tone="ok">On</Badge>}</p>
              <p className="text-[13px] text-muted">Only something outside can report a dead server. Paste a check address from a service like healthchecks.io, and it tells you if both this computer and the server go quiet.</p>
              <form className="mt-2 flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); await act('always.heartbeat', { url }, { success: url ? 'Heartbeat set' : 'Heartbeat removed', undo: false }); setUrl(''); reload(); }}>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hc-ping.com/…" className="min-w-0 flex-1 basis-[240px]" aria-label="Heartbeat address" />
                <Button type="submit" size="sm" variant="secondary">{url || !d.heartbeat ? 'Save' : 'Remove'}</Button>
              </form>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
