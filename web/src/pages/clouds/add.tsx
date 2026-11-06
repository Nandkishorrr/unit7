// Add a database or a cron job beside an app on a hosted platform. A person's step: what costs money never starts from an AI, so this
// is how a paid plan gets chosen. Plans and prices come from hosted.plans; a paid one then waits for a yes on Approvals.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { runTool, type ToolResult } from '../../lib/api';
import { navigate } from '../../lib/router';
import { tidy } from '../../lib/words';
import { Button, Dialog, Field, HoldButton, Input, Skeleton, cx, toast } from '../../ui';
import { useTool } from '../care/data';

export interface Add { tool: string; input: Record<string, unknown> }
export type Adds = { database?: Add; cron?: Add };
interface Plan { id: string; label: string; price: string; paid?: boolean }
interface Plans { render: { postgres: Plan[]; cron: Plan[]; freePostgres: string }; railway: { databases: string[]; price: string } }
const ENGINE: Record<string, string> = { postgres: 'Postgres', redis: 'Redis', mysql: 'MySQL' };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44) || 'app';

export function AddDialog({ what, add, app, onClose, onDone }: { what: keyof Adds; add: Add; app: string; onClose: () => void; onDone?: () => void }) {
  const { data, error } = useTool<Plans>('hosted.plans', {});
  const railway = add.tool === 'railway.create_database', cron = what === 'cron';
  const options: Plan[] = !data ? [] : railway ? data.railway.databases.map((id) => ({ id, label: ENGINE[id] ?? id, price: data.railway.price, paid: true })) : cron ? data.render.cron : data.render.postgres;
  const [picked, setPicked] = useState<string>();
  const [f, setF] = useState({ name: `${slug(app)}-${cron ? 'job' : 'db'}`, schedule: '0 3 * * *', command: '', repo: '' });
  const [busy, setBusy] = useState(false);
  const p = options.find((o) => o.id === picked) ?? options[0];
  const ready = !!p && (railway || /^[a-z0-9][a-z0-9-]{0,51}$/.test(f.name)) && (!cron || (!!f.command.trim() && f.schedule.trim().split(/\s+/).length === 5 && /^[\w.-]+\/[\w.-]+$/.test(f.repo.trim())));
  const go = async () => {
    setBusy(true);
    const input = railway ? { ...add.input, engine: p!.id } : { ...add.input, plan: p!.id, name: f.name, ...(cron && { schedule: f.schedule.trim(), command: f.command.trim(), repo: f.repo.trim() }) };
    const r: ToolResult = await runTool(add.tool, input).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setBusy(false);
    if (r.status === 'approval_required') { toast('info', 'One last yes', 'Confirm it on Approvals, then Unit7 sets it up.'); onClose(); navigate('/approvals'); }
    else if (r.status === 'ok') { toast('ok', cron ? 'Cron job added' : 'Database added', r.output.next ?? r.output.note); onClose(); onDone?.(); }
    else toast('bad', 'That didn’t work', r.status === 'error' ? tidy(r.error.message) : r.status === 'denied' ? r.why : undefined);
  };
  return (
    <Dialog open onClose={onClose} title={cron ? `Add a cron job for ${app}` : `Add a database for ${app}`} wide>
      {error ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">{tidy(error)}</p> : !data ? <Skeleton className="h-[120px] rounded-[18px]" /> : (
        <div className="space-y-3">
          <div role="radiogroup" aria-label={railway ? 'Kind of database' : 'Plan'} className="grid gap-2 sm:grid-cols-2">
            {options.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={x === p} onClick={() => setPicked(x.id)} className={cx('flex flex-col gap-0.5 rounded-[18px] border p-3 text-left transition', x === p ? 'border-blue bg-blue-soft' : 'border-line hover:border-line-strong')}>
                <span className="text-[13.5px] font-medium text-ink">{x.label}</span>
                {!railway && <span className="text-[12px] text-muted">{x.price}</span>}
              </button>
            ))}
          </div>
          {railway && <p className="text-[12.5px] text-muted">{data.railway.price}</p>}
          {!cron && !railway && p?.id === 'free' && <p className="text-[12.5px] text-muted">{data.render.freePostgres}</p>}
          {!railway && <Field label="Name" hint="Small letters, digits and dashes."><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} /></Field>}
          {cron && <>
            <Field label="GitHub repo" hint="owner/name. Render builds the job from it."><Input value={f.repo} placeholder="owner/name" onChange={(e) => setF({ ...f, repo: e.target.value })} /></Field>
            <Field label="What it runs"><Input className="font-mono text-[12.5px]" value={f.command} placeholder="node sync.js" onChange={(e) => setF({ ...f, command: e.target.value })} /></Field>
            <Field label="When" hint="Five parts, in UTC. 0 3 * * * is 03:00 every day."><Input className="font-mono text-[12.5px]" value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })} /></Field>
          </>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            {p?.paid ? <HoldButton size="md" loading={busy} disabled={!ready} icon={<Plus size={14} />} onConfirm={() => void go()}>Add it</HoldButton>
              : <Button variant="primary" loading={busy} disabled={!ready} icon={<Plus size={14} />} onClick={() => void go()}>Add it</Button>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
