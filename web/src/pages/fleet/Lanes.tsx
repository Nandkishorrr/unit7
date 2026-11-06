// Release lanes: one row per server, the steps as columns, filling left to right as the rollout moves (the shared Release
// timeline's `lanes`). On top: how far it got, and Pause, Continue and "Roll back everything" while it runs. A copy on
// another server gets its image from the main server (the Build column); tests and database changes ran once, on the main
// server, so they show as skipped there; the watch after the switch belongs to the main server's release.
import { Pause, Play, RotateCcw } from 'lucide-react';
import { act, Badge, Button, cx, HoldButton, HoverCard } from '../../ui';
import { tidy } from '../../lib/words';
import { ReleaseTimeline, type Lane as ReleaseLane, type Step } from '../release';
import { running, type Lane, type Run } from './data';

const MINE = ['image', 'start', 'check', 'switch', 'done'] as const;
const AT: Record<string, number> = { build: 0, start: 1, check: 2, switch: 3, drain: 4, done: 5 };
export function laneSteps(l: Lane, build: boolean): Step[] {
  const at = l.state === 'done' ? 6 : l.step ? [0, 1, 2, 3, 5][MINE.indexOf(l.step)] ?? -1 : -1;
  return ['build', 'test', 'database', 'start', 'check', 'switch', 'drain', 'watch', 'done'].map((key): Step => {
    if (key === 'test' || key === 'database' || key === 'watch') return { key, state: l.primary && build ? (l.state === 'done' || l.state === 'undone' ? 'done' : 'todo') : 'skipped' };
    if (l.state === 'undone') return { key, state: key === 'build' ? 'done' : 'skipped', ...(key === 'switch' && { note: 'Back on the version before' }) };
    const k = AT[key]!;
    if (k < at) return { key, state: 'done' };
    if (k === Math.max(0, at)) return { key, state: l.state === 'failed' ? 'failed' : l.state === 'running' ? 'active' : 'todo', ...(l.detail && { note: l.detail }) };
    return { key, state: 'todo' };
  });
}
const word = (l: Lane) => l.state === 'done' ? 'Done' : l.state === 'failed' ? (l.detail ? tidy(l.detail) : 'Stopped here') : l.state === 'undone' ? 'Back on the version before' : l.state === 'skipped' ? 'Didn’t start: still on the version before' : l.state === 'running' ? (l.detail ? tidy(l.detail) : 'Updating') : 'Waiting its turn';

export function Lanes({ run, serviceId, className }: { run: Run; serviceId: string; className?: string }) {
  const live = running(run);
  const build = run.lanes.some((l) => l.primary);
  const doneN = run.lanes.filter((l) => l.state === 'done').length;
  const ctl = (action: 'pause' | 'continue' | 'cancel') => act('fleet.control', { serviceId, action }, { success: action === 'pause' ? 'Pausing after this server' : action === 'continue' ? 'Carrying on' : 'Rolling everything back', undo: false });
  const lanes: ReleaseLane[] = run.lanes.map((l) => ({ key: l.serverId, label: <>{l.name}{l.primary && <span className="ml-1 font-normal text-muted">· main</span>}</>, steps: laneSteps(l, build), note: word(l) }));
  return (
    <section aria-label="Release across servers" className={cx('rounded-[20px] border border-line bg-surface p-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold text-ink">{live ? 'Rolling out' : run.status === 'done' ? 'Last release' : run.status === 'cancelled' ? 'Rollout cancelled' : 'Rollout stopped'}</h3>
        <Badge tone={run.status === 'done' ? 'ok' : live ? 'info' : 'warn'}>{run.status === 'paused' ? 'Paused' : `${doneN} of ${run.lanes.length} done`}</Badge>
        <span className="text-[12px] text-muted">{run.batch === 1 ? 'one server at a time' : `${run.batch} at a time`}</span>
        {live && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            {run.status === 'paused' ? <Button size="sm" variant="soft" icon={<Play size={13} />} onClick={() => ctl('continue')}>Continue</Button>
              : <Button size="sm" variant="soft" icon={<Pause size={13} />} onClick={() => ctl('pause')} disabled={run.status === 'cancelling'}>Pause</Button>}
            <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">Stops here and puts every server already updated back on the version before, so they all match again.</p>}>
              <HoldButton size="sm" icon={<RotateCcw size={13} />} onConfirm={() => ctl('cancel')} disabled={run.status === 'cancelling'}>Roll back everything</HoldButton>
            </HoverCard>
          </div>
        )}
      </div>
      <ReleaseTimeline lanes={lanes} className="mt-3" />
      {run.error && !live && <p className="mt-2 text-[12.5px] text-bad">{tidy(run.error)}</p>}
    </section>
  );
}
