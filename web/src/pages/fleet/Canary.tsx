// D3 on the app page: a new version tried on some visitors first. At rest: the share as a slider (the steps marked on
// it), two thin lines (the new version's errors against the old one's over the same minutes), one sentence, and Promote
// now / Hold / Roll back. Starting one is a small centred pop-up: the first share, how long each step holds, and what
// happens in one line each. Everything the panel shows is fleet.get's `canary`.
import { useEffect, useId, useState } from 'react';
import { FlaskConical, Pause, Play, RotateCcw, Rocket } from 'lucide-react';
import { act, Badge, Button, ChipSelect, HoldButton, HoverCard, Modal, StatusMark, cx } from '../../ui';
import { canaryLive, type Canary, type CanaryPoint, type Fleet } from './data';

const W = 320, H = 64;
// the two lines: the new version (blue) and the old one (grey), errors in % over the looks so far
export function TwoLines({ points, className }: { points: CanaryPoint[]; className?: string }) {
  const pts = points.filter((p) => p.newRate !== null || p.oldRate !== null);
  const max = Math.max(1, ...pts.flatMap((p) => [p.newRate ?? 0, p.oldRate ?? 0])) * 1.15;
  const path = (key: 'newRate' | 'oldRate') => pts.map((p, i) => `${i ? 'L' : 'M'}${pts.length < 2 ? W / 2 : (i / (pts.length - 1)) * W} ${H - 4 - ((p[key] ?? 0) / max) * (H - 10)}`).join(' ');
  const last = pts.at(-1);
  const said = last ? `New version ${last.newRate ?? 0}% errors, old version ${last.oldRate ?? 0}%` : 'No visits counted yet';
  return (
    <figure className={cx('min-w-0', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-16 w-full overflow-visible" role="img" aria-label={said}>
        <line x1="0" x2={W} y1={H - 4} y2={H - 4} stroke="var(--line)" strokeWidth="1" />
        {pts.length > 0 && <>
          <path d={path('oldRate')} fill="none" stroke="var(--faint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={path('newRate')} fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="motion-safe:animate-[fade_.5s_ease-out_both]" />
        </>}
        {!pts.length && <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="11" fill="var(--muted)">Waiting for the first visits</text>}
      </svg>
      <figcaption className="mt-1 flex gap-3 text-[11.5px] text-muted">
        <span className="inline-flex items-center gap-1"><span aria-hidden className="h-0.5 w-3 rounded-full bg-blue" />New version</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden className="h-0.5 w-3 rounded-full bg-faint" />Old version</span>
      </figcaption>
    </figure>
  );
}

// the share: a slider with the plan's steps marked; letting go sets it (a person's own choice, through the gate)
function ShareSlider({ c, serviceId }: { c: Canary; serviceId: string }) {
  const [v, setV] = useState(c.share);
  const id = useId();
  useEffect(() => setV(c.share), [c.share]);
  const commit = () => { if (v !== c.share) void act('fleet.canary_control', { serviceId, action: 'share', share: v }, { success: v >= 100 ? 'Every visitor gets the new version' : `${v}% of visitors get the new version`, undo: false }); };
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <label htmlFor={id} className="text-muted">Share of visitors on the new version</label>
        <span className="tabular text-[15px] font-semibold text-ink">{v}%</span>
      </div>
      <input id={id} type="range" min={1} max={100} step={1} value={v} disabled={c.status === 'starting'} onChange={(e) => setV(Number(e.target.value))} onPointerUp={commit} onKeyUp={(e) => { if (/Arrow|Home|End|Page/.test(e.key)) commit(); }} onBlur={commit}
        className="mt-1.5 w-full accent-[var(--blue)]" aria-valuetext={`${v}% of visitors`} />
      <div aria-hidden className="relative h-3 text-[10.5px] text-faint">
        {c.steps.map((s) => <span key={s} className={cx('absolute tabular', s >= 100 ? 'right-0' : '-translate-x-1/2', s <= c.share && 'text-ink-2')} style={s >= 100 ? undefined : { left: `${s}%` }}>{s}</span>)}
      </div>
    </div>
  );
}

const STATUS: Record<Canary['status'], { word: string; mark: 'ok' | 'warn' | 'bad' | 'work' | 'off' }> = {
  starting: { word: 'Starting the new version', mark: 'work' }, running: { word: 'Trying it on some visitors', mark: 'work' }, held: { word: 'Held at this share', mark: 'warn' },
  done: { word: 'Took over every visitor', mark: 'ok' }, rolled_back: { word: 'Rolled back', mark: 'bad' }, failed: { word: 'Didn’t start', mark: 'bad' },
};

export function CanaryPanel({ f, onChange, className }: { f: Fleet; onChange: () => void; className?: string }) {
  const c = f.canary;
  if (!c) return null;
  const live = canaryLive(c);
  // a finished try stays a quiet line for a day
  if (!live) {
    if (Date.now() - Date.parse(c.finishedAt ?? c.startedAt) > 86400_000) return null;
    return (
      <p className={cx('flex items-center gap-2 rounded-[16px] bg-raised/70 px-3.5 py-2.5 text-[12.5px] text-ink-2', className)}>
        <StatusMark state={STATUS[c.status].mark} size={16} label={STATUS[c.status].word} />
        <span className="min-w-0 flex-1"><span className="font-medium text-ink">v{c.version ?? '?'} {c.status === 'done' ? 'took over' : c.status === 'rolled_back' ? 'was rolled back' : 'didn’t start'}.</span> {c.words}</span>
      </p>
    );
  }
  const ctl = (action: 'promote' | 'hold' | 'resume' | 'rollback') => act('fleet.canary_control', { serviceId: f.serviceId, action },
    { success: action === 'promote' ? 'The new version takes every visitor' : action === 'hold' ? 'Held at this share' : action === 'resume' ? 'Carrying on' : 'Every visitor is on the old version again', undo: false }).then(onChange);
  return (
    <section aria-label="New version on some visitors" className={cx('rounded-[20px] border border-blue/25 bg-blue-soft/40 p-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusMark state={STATUS[c.status].mark} size={18} label={STATUS[c.status].word} />
        <h3 className="text-[14px] font-semibold text-ink">Trying v{c.version ?? '…'} on {c.share}% of visitors</h3>
        <HoverCard content={<p className="max-w-[260px] text-[12.5px] text-ink-2">{f.words.canary ?? 'Canary: the new version first gets a small share of visitors, and more only while it does as well as the old one.'}</p>}>
          <Badge tone="info" className="cursor-help">Canary</Badge>
        </HoverCard>
        <span className="ml-auto text-[12px] text-muted">{c.steps.join(' → ')}% · {c.holdMinutes} min each</span>
      </div>
      <p className="mt-2 text-[13px] text-ink">{c.words}</p>
      <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ShareSlider c={c} serviceId={f.serviceId} />
        <TwoLines points={c.points} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="dark" icon={<Rocket size={13} />} disabled={c.status === 'starting'} onClick={() => void ctl('promote')}>Promote now</Button>
        {c.status === 'held' ? <Button size="sm" variant="soft" icon={<Play size={13} />} onClick={() => void ctl('resume')}>Carry on</Button>
          : <Button size="sm" variant="soft" icon={<Pause size={13} />} disabled={c.status === 'starting'} onClick={() => void ctl('hold')}>Hold</Button>}
        <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">Every visitor goes back to v{c.from ?? 'before'}, which kept running all along. It also happens by itself if the new one does clearly worse.</p>}>
          <HoldButton size="sm" icon={<RotateCcw size={13} />} disabled={c.status === 'starting'} onConfirm={() => ctl('rollback')}>Roll back</HoldButton>
        </HoverCard>
      </div>
    </section>
  );
}

// the way in: "Try it on some visitors first", with the first share and the hold per step
export function StartCanary({ f, onStarted }: { f: Fleet; onStarted: () => void }) {
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState('10');
  const [hold, setHold] = useState('5');
  const [busy, setBusy] = useState(false);
  if (canaryLive(f.canary)) return null;
  const why = f.canaryWhyNot;
  const button = <Button size="sm" variant="soft" icon={<FlaskConical size={13} />} disabled={!!why} onClick={() => setOpen(true)}>Try on some visitors</Button>;
  const steps = [Number(share), ...[50, 100].filter((x) => x > Number(share))];
  const start = async () => {
    setBusy(true);
    setOpen(false);
    await act('fleet.canary', { serviceId: f.serviceId, share: Number(share), holdMinutes: Number(hold) }, { success: `The new version gets ${share}% of visitors first`, undo: false });
    setBusy(false);
    onStarted();
  };
  return (
    <>
      {why ? <HoverCard content={<p className="max-w-[260px] text-[12.5px] text-ink-2">{why}</p>}><span>{button}</span></HoverCard> : busy ? <Button size="sm" variant="soft" loading>Starting…</Button> : button}
      <Modal open={open} onClose={() => setOpen(false)} title="Try the new version on some visitors first" size="md">
        <p className="text-[13.5px] text-ink-2">Unit7 deploys the latest version as usual, but only some visitors get it while the rest stay on v{f.servers[0]?.version ?? 'now'}. It compares their errors and speed, and moves on only while the new one does as well. Clearly worse, and it rolls back by itself.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div><p className="mb-1.5 text-[12.5px] font-medium text-ink">First share</p><ChipSelect label="First share" value={share} onChange={setShare} options={['5', '10', '25'].map((v) => ({ value: v, label: `${v}%` }))} /></div>
          <div><p className="mb-1.5 text-[12.5px] font-medium text-ink">Each step holds</p><ChipSelect label="Each step holds" value={hold} onChange={setHold} options={['2', '5', '10'].map((v) => ({ value: v, label: `${v} min` }))} /></div>
        </div>
        <ol className="mt-4 flex flex-wrap items-center gap-1.5 text-[12.5px]" aria-label="The steps">
          {steps.map((s, i) => <li key={s} className="inline-flex items-center gap-1.5"><span className="tabular rounded-full bg-raised px-2.5 py-1 font-medium text-ink">{s}%</span>{i < steps.length - 1 && <span aria-hidden className="text-faint">→</span>}</li>)}
          <li className="text-muted">· {hold} min each, then every visitor</li>
        </ol>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>Not now</Button>
          <Button variant="primary" icon={<FlaskConical size={15} />} onClick={() => void start()}>Start with {share}%</Button>
        </div>
      </Modal>
    </>
  );
}
