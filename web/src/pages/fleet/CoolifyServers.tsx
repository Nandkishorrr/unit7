// D6: a Coolify app's servers, in the same release lanes as Unit7's own (one row per server, its last deploy). Coolify
// runs the app on each server itself; Unit7 adds or removes a server through Coolify's API, and says plainly what
// Coolify can't do (Docker Compose, files in a volume, no registry image) and that visitors still need spreading.
import { useState } from 'react';
import { Layers, Plus } from 'lucide-react';
import { act, Button, HoverCard, Select, Skeleton, cx } from '../../ui';
import { ReleaseTimeline, STEPS, type Lane as ReleaseLane, type Step } from '../release';
import { useTool } from '../care/data';

interface CoolLane { serverUuid: string; name: string; primary: boolean; state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string }
interface CoolFleet { app: { name: string; image: string | null }; servers: { uuid: string; serverUuid: string; server: string; primary: boolean; unit7Name?: string }[]; lanes: CoolLane[]; candidates: { uuid: string; name: string }[]; refusal?: { reason: string; fix?: string }; traffic: string }

// a Coolify deploy has fewer steps than Unit7's: the main server builds and pushes, the others pull, start and switch
export function coolifySteps(l: CoolLane): Step[] {
  const s = l.state === 'done' ? 'done' : l.state === 'failed' ? 'failed' : l.state === 'running' ? 'active' : 'todo';
  return STEPS.map(({ key }): Step => {
    if (key === 'build') return { key, state: l.primary ? (s === 'todo' ? 'todo' : s === 'active' ? 'active' : s === 'failed' ? 'failed' : 'done') : 'skipped' };
    if (key === 'start' || key === 'switch') return { key, state: s === 'active' ? (key === 'start' ? 'active' : 'todo') : s };
    if (key === 'done') return { key, state: s === 'done' ? 'done' : 'todo' };
    return { key, state: 'skipped' };
  });
}

export function CoolifyServers({ serverId, uuid, human, className }: { serverId: string; uuid: string; human: boolean; className?: string }) {
  const { data, reload, error } = useTool<CoolFleet>('coolify.servers', { serverId, uuid });
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return null; // an older Coolify, or a token that can't read it: nothing to show
  if (!data) return <Skeleton className={cx('h-[72px] rounded-[18px]', className)} />;
  const many = data.servers.length > 1;
  const pick = to ?? data.candidates[0]?.uuid ?? null;
  const add = async () => { if (!pick) return; setBusy(true); await act('coolify.add_server', { serverId, uuid, to: pick }, { success: `${data.app.name} runs on one more server (through Coolify)` }); setBusy(false); void reload(); };
  const lanes: ReleaseLane[] = data.lanes.map((l) => ({ key: l.serverUuid, label: <>{l.name}{l.primary && <span className="ml-1 font-normal text-muted">· main</span>}</>, steps: coolifySteps(l), note: l.detail ?? 'No deploy yet' }));
  return (
    <section aria-label="Servers" className={cx('space-y-2.5', className)}>
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink"><Layers size={14} aria-hidden />{many ? `On ${data.servers.length} servers, through Coolify` : 'On one server'}</h3>
      {many && <ReleaseTimeline lanes={lanes} />}
      {many && <p className="text-[12px] text-muted">{data.traffic}</p>}
      {data.refusal ? (
        <p className="rounded-[16px] bg-raised px-3.5 py-2.5 text-[12.5px] text-ink-2"><span className="font-medium text-ink">Can’t run on more servers yet:</span> {data.refusal.reason}{data.refusal.fix && <> {data.refusal.fix}</>}</p>
      ) : human && data.candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={pick ?? ''} onChange={setTo} options={data.candidates.map((c) => ({ value: c.uuid, label: c.name }))} className="min-w-[160px]" />
          <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">Coolify builds it once, pushes it to {data.app.image ?? 'its registry image'}, and every server pulls that same image.</p>}>
            <Button size="sm" variant="soft" icon={<Plus size={13} />} loading={busy} onClick={() => void add()}>Run it there too</Button>
          </HoverCard>
        </div>
      )}
    </section>
  );
}
