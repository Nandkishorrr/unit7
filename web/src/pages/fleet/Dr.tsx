// A warm standby on the app page. Not set up: one line of why, a server and how often its data is copied, "Keep a warm
// copy". Set up: the promise in one big line ("If this server dies, you're back in about 7 minutes, losing at most 6
// hours of data"), where the copy is and how fresh its data is, the last drill, and "Test it now" / "Switch to the
// standby" (both hold-to-confirm). While visitors are on the standby: a red note and "Switch back".
import { useState } from 'react';
import { ArrowLeftRight, LifeBuoy, MoreHorizontal, ShieldCheck, Undo2 } from 'lucide-react';
import { act, Badge, Button, Card, CardHeader, ChipSelect, HoldButton, HoverCard, Illustration, Select, Skeleton, StatusMark, cx, timeAgo } from '../../ui';
import { Menu } from '../kit';
import { useTool } from '../care/data';

interface Drill { at: string; ok: boolean; refreshSeconds?: number; answerMs?: number; requests: number; failed: number; note: string }
interface Standby {
  serverId: string; server: string; status: 'preparing' | 'ready' | 'active' | 'failed'; hours: number; version: number | null; health: string | null; refreshedAt: string | null; dataAt: string | null; refreshError: string | null;
  databases: { name: string; engine: string; copied: boolean }[]; drill: Drill | null; failoverAt: string | null; auto: boolean; dnsEditable: boolean;
}
interface Dr { standby: Standby | null; promise: { ready: boolean; minutes: number | null; hoursLost: number | null; auto: boolean; words: string } | null; notes?: string[] }
interface Candidates { candidates: { serverId: string; name: string; ready: boolean }[]; servers: { serverId: string; role?: string }[] }

function Setup({ serviceId, name, onDone }: { serviceId: string; name: string; onDone: () => void }) {
  const f = useTool<Candidates>('fleet.get', { serviceId });
  const [server, setServer] = useState<string | null>(null);
  const [hours, setHours] = useState('6');
  const [busy, setBusy] = useState(false);
  const options = f.data?.candidates ?? [];
  const chosen = server ?? options[0]?.serverId ?? null;
  const go = async () => { if (!chosen) return; setBusy(true); await act('dr.setup', { serviceId, serverId: chosen, hours: Number(hours) }, { success: `${name} has a warm standby now` }); setBusy(false); onDone(); };
  return (
    <div className="mt-4 flex flex-wrap items-end gap-3">
      {options.length ? (
        <>
          <label className="min-w-[180px] flex-1 text-[12.5px] text-muted">On which server
            <Select value={chosen ?? ''} onChange={setServer} options={options.map((o) => ({ value: o.serverId, label: `${o.name}${o.ready ? '' : ' (Unit7 prepares it first)'}` }))} className="mt-1 w-full" />
          </label>
          <div className="text-[12.5px] text-muted"><p className="mb-1">Copy its data every</p><ChipSelect label="Copy its data every" value={hours} onChange={setHours} options={['2', '6', '12', '24'].map((h) => ({ value: h, label: `${h} h` }))} /></div>
          <Button variant="dark" icon={<LifeBuoy size={15} />} loading={busy} onClick={() => void go()}>Keep a warm copy</Button>
        </>
      ) : <p className="text-[12.5px] text-ink-2">It needs a second server. Connect one on Servers (Unit7 never buys one for you).</p>}
    </div>
  );
}

export function StandbyPanel({ serviceId, name, className }: { serviceId: string; name: string; className?: string }) {
  const { data, reload } = useTool<Dr>('dr.status', { serviceId });
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return <Skeleton className={cx('h-[120px] rounded-[24px]', className)} />;
  const s = data.standby, p = data.promise;
  const run = async (key: string, tool: string, input: Record<string, unknown>, success: string) => { setBusy(key); await act(tool, { serviceId, ...input }, { success, undo: false }); setBusy(null); void reload(); };
  if (!s || s.status === 'failed') {
    return (
      <Card className={cx('illo-host p-5 md:p-6', className)}>
        <div className="flex flex-wrap items-center gap-4">
          <Illustration name="backup" size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium tracking-[-0.015em] text-ink">If this server dies</h2>
            <p className="text-[12.5px] text-muted">{s?.status === 'failed' ? `The standby couldn’t be set up: ${s.refreshError ?? 'try again'}.` : `A warm copy of ${name} on a second server takes over in minutes, with its data copied every few hours.`}</p>
          </div>
        </div>
        <Setup serviceId={serviceId} name={name} onDone={() => void reload()} />
      </Card>
    );
  }
  const active = s.status === 'active';
  const fresh = s.dataAt ? timeAgo(s.dataAt) : null;
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<LifeBuoy size={19} />} title="Warm standby" sub={<>On {s.server}{s.version ? ` · v${s.version}` : ''}{fresh ? ` · data from ${fresh}` : ''}</>}
        actions={!active ? (
          <Menu label="More for the standby" items={[{ label: 'Stop keeping a standby', danger: true, onSelect: () => void run('remove', 'dr.remove', {}, 'The standby is gone; the live app is untouched') }]}>
            <MoreHorizontal size={16} />
          </Menu>
        ) : undefined} />
      {active ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[18px] bg-bad/8 px-4 py-3">
          <StatusMark state="bad" size={20} label="On the standby" />
          <p className="min-w-0 flex-1 text-[13.5px] text-ink"><span className="font-medium">Visitors are on the standby{ s.failoverAt ? ` since ${timeAgo(s.failoverAt)}` : ''}.</span> <span className="text-ink-2">Switch back once the main server is fine: what the standby collected goes back first, so the app is offline for the few minutes that takes.</span></p>
          <HoldButton icon={<Undo2 size={14} />} className="bg-ink text-bg" fillClassName="bg-white/25" loading={busy === 'back'} onConfirm={() => run('back', 'dr.failover', { back: true }, 'Visitors are back on the main server')}>Switch back</HoldButton>
        </div>
      ) : (
        <>
          <p className={cx('mt-4 text-[17px] font-medium leading-snug tracking-[-0.01em]', p?.ready ? 'text-ink' : 'text-ink-2')}>{p?.words}</p>
          {s.refreshError && <p className="mt-1.5 text-[12.5px] text-warn">The last data copy didn’t work: {s.refreshError}</p>}
          {data.notes?.map((n) => <p key={n} className="mt-1.5 text-[12.5px] text-warn">{n}</p>)}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-muted">
            {s.drill ? (
              <HoverCard content={<p className="max-w-[280px] text-[12.5px] text-ink-2">{s.drill.note}</p>}>
                <span tabIndex={0} className="inline-flex cursor-help items-center gap-1.5"><StatusMark state={s.drill.ok ? 'ok' : 'bad'} size={15} label={s.drill.ok ? 'Drill passed' : 'Drill found a problem'} />Last drill {timeAgo(s.drill.at)}: {s.drill.ok ? 'passed' : 'found a problem'}</span>
              </HoverCard>
            ) : <span className="inline-flex items-center gap-1.5"><StatusMark state="off" size={15} label="Not tested yet" />Not tested yet: a drill runs once a month in a quiet hour</span>}
            <span>{s.databases.length ? `${s.databases.filter((d) => d.copied).map((d) => d.name).join(', ') || 'Its cache'} copied every ${s.hours} h` : 'No database on this server to copy'}</span>
            <HoverCard content={<p className="max-w-[260px] text-[12.5px] text-ink-2">{s.auto ? 'If the main server stops answering for 5 minutes, Unit7 switches by itself and tells your phone.' : 'If the main server stops answering, Unit7 asks you on your phone: one tap switches.'}{s.dnsEditable ? '' : ' Unit7 can’t edit this domain’s DNS, so the switch is a record you change.'}</p>}>
              <Badge tone={s.auto ? 'ok' : 'neutral'} className="cursor-help">{s.auto ? 'Switches by itself' : 'Asks you first'}</Badge>
            </HoverCard>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <HoverCard content={<p className="max-w-[260px] text-[12.5px] text-ink-2">Copies fresh data to the standby, then asks it for your site by its real name over HTTPS, the way visitors would reach it. Real visitors stay where they are.</p>}>
              <HoldButton size="sm" icon={<ShieldCheck size={13} />} className="border border-line-strong bg-surface text-ink hover:bg-raised" fillClassName="bg-ok/25" loading={busy === 'drill'} disabled={s.status !== 'ready'} onConfirm={() => run('drill', 'dr.drill', {}, 'Drill done')}>Test it now</HoldButton>
            </HoverCard>
            <HoverCard content={<p className="max-w-[260px] text-[12.5px] text-ink-2">Every visitor goes to the standby until you switch back. Its data is from {fresh ?? 'the last copy'}.</p>}>
              <HoldButton size="sm" icon={<ArrowLeftRight size={13} />} className="border border-bad/40 bg-surface text-bad hover:bg-bad/8" fillClassName="bg-bad/20" loading={busy === 'switch'} disabled={s.status !== 'ready'} onConfirm={() => run('switch', 'dr.failover', {}, 'Visitors are on the standby now')}>Switch to the standby</HoldButton>
            </HoverCard>
            {s.status === 'preparing' && <span className="text-[12.5px] text-muted">Getting ready…</span>}
          </div>
        </>
      )}
    </Card>
  );
}
