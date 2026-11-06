// Settings → Watch: how often Unit7 reads each server's traffic and logs, what it watches, quiet hours for
// the phone, and a way through to the alert channels. Every change saves at once.
import { useEffect, useState } from 'react';
import { Activity, BellOff, Bell, Moon } from 'lucide-react';
import { runTool } from '../../lib/api';
import { navigate } from '../../lib/router';
import { Button, Card, CardHeader, Input, Skeleton, Switch, SwitchRow, cx, toast } from '../../ui';
import { tidy } from '../../lib/words';
import type { WatchSettingsOut } from './shape';

const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();

export function WatchTab({ canChange }: { canChange: boolean }) {
  const [s, setS] = useState<WatchSettingsOut | null>(null);
  const [quiet, setQuiet] = useState({ from: '22:00', to: '07:00' });
  useEffect(() => {
    runTool('watch.settings', {}).then((r) => { if (r.status === 'ok') { setS(r.output); if (r.output.quiet) setQuiet({ from: r.output.quiet.from, to: r.output.quiet.to }); } }, () => undefined);
  }, []);
  const save = async (patch: Partial<WatchSettingsOut>) => {
    const before = s;
    setS((x) => (x ? { ...x, ...patch } : x));
    try {
      const r = await runTool('watch.settings', { ...patch, ...(TZ && { tz: TZ }) });
      if (r.status === 'ok') setS(r.output);
      else { setS(before); toast('bad', 'Couldn’t save that', r.status === 'error' ? tidy(r.error.message) : r.status === 'denied' ? r.why : 'It needs approval.', { action: r.status === 'error' ? { label: 'Try again', onClick: () => save(patch) } : undefined }); }
    } catch (e) { setS(before); toast('bad', 'Couldn’t save that', (e as Error).message, { action: { label: 'Try again', onClick: () => save(patch) } }); }
  };
  if (!s) return <><Skeleton className="h-72" /><Skeleton className="h-72" /></>;
  const row = (key: keyof Pick<WatchSettingsOut, 'usage' | 'traffic' | 'logs' | 'findings' | 'digest' | 'investigate'>, title: string, body: string) =>
    <SwitchRow title={title} body={body} checked={s[key]} disabled={!canChange} onChange={(on) => save({ [key]: on })} />;
  const setQuietHours = (on: boolean) => save({ quiet: on ? { ...quiet, ...(TZ && { tz: TZ }) } : null });
  return (
    <>
      <Card className="p-5 md:p-6">
        <CardHeader icon={<Activity size={20} />} title="Server watch" sub="Learns what’s normal, tells you what jumps." />
        <div className="mt-5">
          <p className="text-[14px] font-medium text-ink">Read traffic and logs every</p>
          <div role="radiogroup" aria-label="How often" className="mt-2 grid grid-cols-2 gap-2">
            {([30, 60] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={s.every === m} disabled={!canChange} onClick={() => save({ every: m })}
                className={cx('h-11 rounded-[16px] border text-[13.5px] font-medium transition disabled:opacity-60', s.every === m ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2 hover:bg-raised')}>
                {m === 30 ? '30 minutes' : '1 hour'}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12.5px] text-muted">Usage is sampled every {s.sampleEvery} minutes. When something jumps, Unit7 reads the logs straight away.</p>
        </div>
        <div className="mt-3 divide-y divide-line border-t border-line">
          {row('usage', 'Unusual jumps', 'CPU or memory far above its usual, memory climbing like a leak, restart loops, the disk filling fast.')}
          {row('traffic', 'Traffic and anonymous calls', 'Floods, many calls without signing in, password guessing, bots probing for weak spots.')}
          {row('logs', 'Errors in app logs', 'An app suddenly writing many more errors than usual.')}
          {row('findings', 'New risks', 'A database or admin page open to the internet, no backups, a disk that will be full soon.')}
          {row('investigate', 'Let the AI look into serious ones', s.investigate && s.investigateReady === false ? 'This can’t run yet: automatic looks need an API key or a local model, because a personal subscription is only for requests you type. Connect one on Connections.' : 'A read-only look at recent changes and logs, attached to the alert. It never changes anything.')}
          {row('digest', 'Weekly digest', 'Monday morning: visits, what happened and was fixed, disk growth, updates waiting.')}
          <SwitchRow title="Morning brief" body="09:00 on your clock (after quiet hours, if those run later): yesterday, what Unit7 fixed overnight, and the one thing that needs you." checked={s.brief !== false} disabled={!canChange} onChange={(on) => save({ brief: on })} />
        </div>
      </Card>
      <Card className="p-5 md:p-6">
        <CardHeader icon={<Moon size={20} />} title="Quiet hours" sub="Watch alerts wait in Activity; only critical ones reach your phone." />
        <div className="mt-4 flex items-center justify-between gap-4">
          <p className="text-[14px] font-medium text-ink">Quiet hours</p>
          <Switch checked={!!s.quiet} disabled={!canChange} label="Quiet hours" onChange={setQuietHours} />
        </div>
        <div className={cx('mt-3 grid grid-cols-2 gap-3 transition-opacity', !s.quiet && 'opacity-50')}>
          {(['from', 'to'] as const).map((k) => (
            <label key={k} className="block text-[12.5px] text-muted">{k === 'from' ? 'From' : 'Until'}
              <Input type="time" value={quiet[k]} disabled={!canChange || !s.quiet} className="mt-1"
                onChange={(e) => setQuiet((q) => ({ ...q, [k]: e.target.value }))} onBlur={() => s.quiet && save({ quiet: { ...quiet, ...(TZ && { tz: TZ }) } })} />
            </label>
          ))}
        </div>
        <p className="mt-2 text-[12.5px] text-muted">{TZ ? `Your time (${TZ.replace(/_/g, ' ')}).` : 'In UTC.'}</p>
        <div className="mt-5 rounded-[18px] bg-raised px-4 py-3.5">
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink">{s.channels.length ? <Bell size={15} /> : <BellOff size={15} />}{s.channels.length ? `Alerts go to ${s.channels.map((c) => (c === 'ntfy' ? 'your phone' : 'a team channel')).join(' and ')}` : 'No alert channel yet'}</p>
          <p className="mt-0.5 text-[12.5px] text-muted">{s.channels.length ? 'Same channels as every other alert.' : 'Without one, the watch still shows everything in Activity.'}</p>
          <Button className="mt-3" size="sm" variant="soft" onClick={() => navigate('/connections#alerts')}>{s.channels.length ? 'Alert channels' : 'Set up alerts'}</Button>
        </div>
      </Card>
    </>
  );
}
