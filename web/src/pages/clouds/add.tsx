// Add a database or a cron job beside an app on a hosted platform, or a new database on PlanetScale. A person's step: what costs money
// never starts from an AI, so this is how a paid plan gets chosen. Plans and prices come from hosted.plans and planetscale.sizes; a paid
// one then waits for a yes on Approvals.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { runTool, type ToolResult } from '../../lib/api';
import { navigate } from '../../lib/router';
import { tidy } from '../../lib/words';
import { Button, Dialog, Field, HoldButton, Input, Select, Skeleton, cx, toast } from '../../ui';
import { useTool } from '../care/data';
import { sizeChoices, type HostedSize } from '../servers/shape';

export interface Add { tool: string; input: Record<string, unknown> }
export type Adds = { database?: Add; cron?: Add };
interface Plan { id: string; label: string; price: string; paid?: boolean }
interface Plans { render: { postgres: Plan[]; cron: Plan[]; freePostgres: string }; railway: { databases: string[]; price: string } }
interface Sizes { orgs?: string[]; sizes: HostedSize[] }
const ENGINE: Record<string, string> = { postgres: 'Postgres', redis: 'Redis', mysql: 'MySQL' };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44) || 'app';
const ENGINES = [{ value: 'postgresql', label: 'Postgres' }, { value: 'mysql', label: 'MySQL' }];

function PlanPicker({ label, options, on, onPick }: { label: string; options: { id: string; label: string; price?: string; detail?: string }[]; on?: string; onPick: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-2">
      {options.map((x) => (
        <button key={x.id} type="button" role="radio" aria-checked={x.id === on} onClick={() => onPick(x.id)} className={cx('flex flex-col gap-0.5 rounded-[18px] border p-3 text-left transition', x.id === on ? 'border-blue bg-blue-soft' : 'border-line hover:border-line-strong')}>
          <span className="text-[13.5px] font-medium text-ink">{x.label}</span>
          {x.detail && <span className="text-[12px] text-muted">{x.detail}</span>}
          {x.price && <span className="text-[12px] text-muted">{x.price}</span>}
        </button>
      ))}
    </div>
  );
}
// what came back: a paid one waits for one last yes on Approvals
function finish(r: ToolResult, done: string, note: string | undefined, onClose: () => void, onDone?: () => void) {
  if (r.status === 'approval_required') { toast('info', 'One last yes', 'Confirm it on Approvals, then Unit7 sets it up.'); onClose(); navigate('/approvals'); }
  else if (r.status === 'ok') { toast('ok', done, note); onClose(); onDone?.(); }
  else toast('bad', 'That didn’t work', r.status === 'error' ? tidy(r.error.message) : r.status === 'denied' ? r.why : undefined);
}

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
    finish(r, cron ? 'Cron job added' : 'Database added', r.status === 'ok' ? r.output.next ?? r.output.note : undefined, onClose, onDone);
  };
  return (
    <Dialog open onClose={onClose} title={cron ? `Add a cron job for ${app}` : `Add a database for ${app}`} wide>
      {error ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">{tidy(error)}</p> : !data ? <Skeleton className="h-[120px] rounded-[18px]" /> : (
        <div className="space-y-3">
          <PlanPicker label={railway ? 'Kind of database' : 'Plan'} options={railway ? options.map(({ id, label }) => ({ id, label })) : options} on={p?.id} onPick={setPicked} />
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

// A new database on PlanetScale. It has no free plan, so this is the only way one starts: a person picks a size with its rate in view,
// and typing the name here counts as confirmName, the one Approvals asks for again.
export function NewDatabaseDialog({ accountId, onClose, onDone }: { accountId: string; onClose: () => void; onDone?: () => void }) {
  const [engine, setEngine] = useState('postgresql');
  const [org, setOrg] = useState('');
  const { data, error } = useTool<Sizes>('planetscale.sizes', { accountId, engine, ...(org && { org }) });
  const [picked, setPicked] = useState<string>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const options = sizeChoices(data?.sizes ?? []), p = options.find((o) => o.id === picked) ?? options[0], orgs = data?.orgs ?? [];
  const go = async () => {
    setBusy(true);
    const r: ToolResult = await runTool('planetscale.create_database', { accountId, ...(org && { org }), name, size: p!.id, engine, confirmName: name }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setBusy(false);
    finish(r, 'Database created', `${name} is starting on PlanetScale. Connect it to an app on Wiring.`, onClose, onDone);
  };
  return (
    <Dialog open onClose={onClose} title="New PlanetScale database" wide>
      {error ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">{tidy(error)}</p> : !data ? <Skeleton className="h-[120px] rounded-[18px]" /> : (
        <div className="space-y-3">
          {orgs.length > 1 && <Field label="Organisation"><Select className="w-full" value={org} onChange={setOrg} options={[...(org ? [] : [{ value: '', label: 'Pick the one that pays' }]), ...orgs.map((o) => ({ value: o, label: o }))]} /></Field>}
          <Field label="Kind"><Select className="w-full" value={engine} onChange={setEngine} options={ENGINES} /></Field>
          {options.length > 0 ? <>
            <PlanPicker label="Size" options={options} on={p?.id} onPick={setPicked} />
            <p className="text-[12.5px] text-muted">PlanetScale has no free plan, so this adds to your bill from the start. The rate is its own number: <a className="underline" href="https://planetscale.com/pricing" target="_blank" rel="noreferrer">planetscale.com/pricing</a> says what it comes to a month.</p>
            <Field label="Name" hint="Small letters, digits and dashes."><Input value={name} autoComplete="off" onChange={(e) => setName(e.target.value.toLowerCase())} /></Field>
          </> : (org || orgs.length < 2) && <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">PlanetScale didn’t give a rate for any size here, so Unit7 can’t show a price. Create it at app.planetscale.com, and it shows on the map after the next sync.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <HoldButton size="md" loading={busy} disabled={!p || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)} icon={<Plus size={14} />} onConfirm={() => void go()}>Create it</HoldButton>
          </div>
        </div>
      )}
    </Dialog>
  );
}
