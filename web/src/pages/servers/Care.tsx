// A person's side of looking after a server, on its Advanced tab: who can sign in, a port, snapshots, its plan, power, and
// moving it. Several of these are people only, so this is where they're done. Each card reads through one tool and changes
// through the gate like everything else. What a server or provider says is shown as text, never as a link Unit7 didn't make.
import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUpRight, Camera, DoorOpen, KeyRound, Power, Scaling, Trash2, Truck, UserPlus } from 'lucide-react';
import { runTool } from '../../lib/api';
import { tidy } from '../../lib/words';
import { act, Badge, Button, Card, CardHeader, Dialog, Field, HoldButton, Input, Select, Skeleton, SwitchRow, Textarea, confirmDialog, promptDialog, timeAgo, toast } from '../../ui';
import { useTool } from '../care/data';

const failed = (r: Awaited<ReturnType<typeof runTool>>) => tidy(r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'That didn’t work.');
const Note = ({ children }: { children: ReactNode }) => <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">{children}</p>;

// --- who can sign in -------------------------------------------------------------------------------------------------------
interface Keys { server: string; accounts: { user: string; canSignIn: boolean; keys: { fingerprint: string; type: string; comment: string; unit7: boolean; limited?: string }[] }[] }
function SignIn({ serverId, name }: { serverId: string; name: string }) {
  const { data, error, reload } = useTool<Keys>('server.ssh_keys', { serverId });
  const [add, setAdd] = useState<'key' | 'user' | null>(null);
  const [f, setF] = useState({ user: '', key: '', sudo: false });
  const done = () => { setAdd(null); setF({ user: '', key: '', sudo: false }); void reload(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = add === 'key' ? await act('server.ssh_keys', { serverId, op: 'add', user: f.user || undefined, publicKey: f.key }, { success: 'Key added' })
      : await act('server.users', { serverId, op: 'add', user: f.user, sudo: f.sudo, publicKeys: f.key ? [f.key] : [] }, { success: `${f.user} can sign in now` });
    if (r) done();
  };
  const removeKey = async (user: string, fingerprint: string) => {
    if (await confirmDialog({ title: 'Remove this key?', body: `Whoever holds it can’t sign in as ${user} on ${name} any more.`, confirm: 'Remove it', danger: true })) { await act('server.ssh_keys', { serverId, op: 'remove', user, fingerprint }, { success: 'Key removed' }); void reload(); }
  };
  const removeUser = async (user: string) => {
    if (await confirmDialog({ title: `Take ${user} off ${name}?`, body: 'They can’t sign in any more. Their files stay on the server.', confirm: 'Take them off', danger: true })) { await act('server.users', { serverId, op: 'remove', user }, { success: `${user} is off ${name}` }); void reload(); }
  };
  return (
    <Card className="min-w-0 self-start p-5 md:p-6 lg:col-span-7">
      <CardHeader icon={<KeyRound size={19} />} title="Who can sign in" sub="The last working key always stays" />
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" icon={<KeyRound size={13} />} onClick={() => setAdd('key')}>Add a key</Button><Button size="sm" icon={<UserPlus size={13} />} onClick={() => setAdd('user')}>Add a person</Button></div>
      {error ? <div className="mt-4"><Note>{tidy(error)}</Note></div> : !data ? <Skeleton className="mt-4 h-20" /> : (
        <ul className="mt-3 divide-y divide-line">
          {data.accounts.map((a) => (
            <li key={a.user} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{a.user}{!a.canSignIn && <span className="font-normal text-muted"> · can’t sign in</span>}</p>
                {a.user !== 'root' && <Button size="sm" variant="ghost" onClick={() => void removeUser(a.user)}>Take off</Button>}
              </div>
              {a.keys.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {a.keys.map((k) => (
                    <li key={k.fingerprint} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
                      <span className="min-w-0 flex-1 basis-[180px] truncate font-mono" title={k.fingerprint}>{k.comment || k.fingerprint}</span>
                      {k.unit7 ? <Badge tone="info">Unit7</Badge> : <button type="button" aria-label={`Remove the key ${k.comment || k.fingerprint}`} onClick={() => void removeKey(a.user, k.fingerprint)} className="grid size-8 place-items-center rounded-full transition hover:bg-raised hover:text-bad"><Trash2 size={14} /></button>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!add} onClose={() => setAdd(null)} title={add === 'key' ? 'Add an SSH key' : 'Add a person to this server'}>
        <form onSubmit={submit} className="space-y-4">
          <Field label={add === 'key' ? 'User on the server' : 'Their user name'} hint={add === 'key' ? 'Leave it empty for the one Unit7 signs in as.' : 'Small letters, digits, - and _.'}><Input required={add === 'user'} pattern="[a-z_][a-z0-9_\-]{0,31}" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} /></Field>
          <Field label="Their public key" hint="The one line from a .pub file. Never the private key."><Textarea required={add === 'key'} rows={3} className="font-mono text-[12.5px]" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>
          {add === 'user' && <SwitchRow title="Let them do anything on this server" body="Full control (sudo). Leave it off unless they need it." checked={f.sudo} onChange={(sudo) => setF({ ...f, sudo })} />}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setAdd(null)}>Cancel</Button><Button variant="primary">{add === 'key' ? 'Add the key' : 'Add them'}</Button></div>
        </form>
      </Dialog>
    </Card>
  );
}

// --- one port ---------------------------------------------------------------------------------------------------------------
function OpenPort({ serverId }: { serverId: string }) {
  const [port, setPort] = useState('');
  const [reason, setReason] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = { serverId, port: Number(port), reason };
    const plan = await runTool('server.open_port', input, { dryRun: true }).catch((x: Error) => ({ status: 'error' as const, error: { code: 'network', message: x.message } }));
    if (plan.status !== 'dry_run') { toast('bad', 'That didn’t work', failed(plan)); return; }
    const warning = (plan.plan as { warning?: string }).warning;
    if (!await confirmDialog({ title: `Open port ${port} to the internet?`, body: plan.plan.change, ...(warning && { warning }), confirm: warning ? 'Open it anyway' : 'Open it', danger: !!warning })) return;
    if (await act('server.open_port', { ...input, anyway: !!warning }, { success: `Port ${port} is open` })) { setPort(''); setReason(''); }
  };
  return (
    <Card className="min-w-0 self-start p-5 md:p-6 lg:col-span-5">
      <CardHeader icon={<DoorOpen size={19} />} title="Open a port" sub="It survives a restart" />
      <form onSubmit={submit} className="mt-4 space-y-3">
        <Field label="Port"><Input required inputMode="numeric" pattern="[0-9]{1,5}" value={port} onChange={(e) => setPort(e.target.value)} /></Field>
        <Field label="Why it needs to be open" hint="It stays on record."><Input required minLength={5} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end"><Button variant="primary">Open it</Button></div>
      </form>
    </Card>
  );
}

// --- snapshots --------------------------------------------------------------------------------------------------------------
interface Snaps { provider: string; snapshots: { id: string; name: string; at?: string; sizeGb?: number }[]; note?: string; billed?: string }
function Snapshots({ serverId, name }: { serverId: string; name: string }) {
  const { data, error } = useTool<Snaps>('server.snapshot', { serverId });
  const take = async () => {
    const r = await runTool('server.snapshot', { serverId, op: 'create' }).catch((x: Error) => ({ status: 'error' as const, error: { code: 'network', message: x.message } }));
    if (r.status === 'ok') { toast('ok', 'Snapshot started', r.output.note); return; }
    if (r.status !== 'error' || r.error.code !== 'snapshot_exists') { toast('bad', 'That didn’t work', failed(r)); return; }
    if (await confirmDialog({ title: 'Replace the snapshot that’s there?', body: tidy(r.error.message), confirm: 'Replace it', danger: true })) await act('server.snapshot', { serverId, op: 'create', replace: true }, { success: 'Snapshot started' });
  };
  const back = async (id: string, at?: string) => {
    if (await confirmDialog({ title: `Take ${name} back to this snapshot?`, body: `Everything saved since ${at ? new Date(at).toLocaleString() : 'then'} is lost, and the server restarts.`, confirm: 'Go on', danger: true })) await act('server.snapshot', { serverId, op: 'restore', snapshot: id });
  };
  return (
    <Card className="min-w-0 self-start p-5 md:p-6 lg:col-span-6">
      <CardHeader icon={<Camera size={19} />} title="Snapshots" sub={data ? `Kept at ${data.provider}` : 'The whole server'} actions={data && <Button size="sm" variant="ghost" onClick={() => void take()}>Take one</Button>} />
      {(data?.billed ?? data?.note) && <p className="mt-2 text-[12.5px] text-muted">{data?.billed ?? data?.note}</p>}
      {error ? <div className="mt-4"><Note>{tidy(error)}</Note></div> : !data ? <Skeleton className="mt-4 h-12" /> : !data.snapshots.length ? <p className="mt-4 text-[13px] text-muted">None yet.</p> : (
        <ul className="mt-3 divide-y divide-line">
          {data.snapshots.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1 basis-[160px] truncate">{s.name}</span>
              <span className="text-[12.5px] text-muted">{s.at ? timeAgo(s.at) : ''}{s.sizeGb ? ` · ${s.sizeGb} GB` : ''}</span>
              <Button size="sm" variant="ghost" onClick={() => void back(s.id, s.at)}>Go back to it</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- its plan ---------------------------------------------------------------------------------------------------------------
interface Plan { plan: string; label: string; diskGb: number; monthly: number | null; currency: string; current?: boolean; fits?: boolean; why?: string }
interface Fit { uses: { memoryPeakGb: number; cpuBusyPercent: number; diskUsedGb: number; biggest?: { name: string; gb: number }[]; cleanableGb?: number }; plans: Plan[]; how: { page?: string; say: string } }
const money = (n: number | null, c: string) => (n === null ? 'price unknown' : new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(n));
function Size({ serverId }: { serverId: string }) {
  const [fit, setFit] = useState<Fit | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const look = async () => {
    setBusy(true); setErr(null);
    const r = await runTool('server.resize', { serverId }).catch((x: Error) => ({ status: 'error' as const, error: { code: 'network', message: x.message } }));
    setBusy(false);
    if (r.status === 'ok') setFit(r.output as Fit); else setErr(failed(r));
  };
  return (
    <Card className="min-w-0 self-start p-5 md:p-6 lg:col-span-6">
      <CardHeader icon={<Scaling size={19} />} title="Size and plan" sub="Does it still fit?" actions={<Button size="sm" variant="ghost" loading={busy} onClick={() => void look()}>{fit ? 'Look again' : 'See what fits'}</Button>} />
      {err && <div className="mt-4"><Note>{err}</Note></div>}
      {fit && (
        <>
          <p className="mt-3 text-[13px] text-ink-2">It peaks at {fit.uses.memoryPeakGb} GB of memory, its CPU is busy about {fit.uses.cpuBusyPercent}% of the time, and it holds {fit.uses.diskUsedGb} GB on disk.{fit.uses.biggest?.[0] ? ` The biggest is ${fit.uses.biggest[0].name}, at ${fit.uses.biggest[0].gb} GB.` : ''}</p>
          <ul className="mt-2 divide-y divide-line">
            {fit.plans.map((p) => (
              <li key={p.plan} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1 basis-[180px]"><p className="truncate font-medium">{p.label} · {p.diskGb} GB</p><p className="text-[12.5px] text-muted">{money(p.monthly, p.currency)} a month{p.why ? ` · ${p.why}` : ''}</p></div>
                {p.current ? <Badge>Now</Badge> : !p.fits ? <Badge tone="warn">Too small</Badge> : fit.how.page
                  ? <a href={fit.how.page} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-text hover:underline">Change it<ArrowUpRight size={13} /></a>
                  : <HoldButton size="sm" onConfirm={() => void act('server.resize', { serverId, plan: p.plan }, { success: `Moving to ${p.plan}` })}>Move to it</HoldButton>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12.5px] text-muted">{fit.how.say} Unit7 never pays by itself.</p>
        </>
      )}
    </Card>
  );
}

// --- Hetzner: off, on, and gone -----------------------------------------------------------------------------------------------
function PowerCard({ serverId, name }: { serverId: string; name: string }) {
  const off = async () => { if (await confirmDialog({ title: `Turn ${name} off?`, body: 'Every app on it stops until you turn it on again. Hetzner keeps billing for it.', confirm: 'Turn it off', danger: true })) await act('server.power', { serverId, op: 'off' }, { success: `${name} is turning off` }); };
  const gone = async () => {
    const typed = await promptDialog({ title: `Delete ${name} for good?`, label: 'Type its name', hint: 'Everything on it goes, and you stop paying for it. This can’t be undone.', confirm: 'Delete it' });
    if (typed !== null) await act('server.delete', { serverId, confirmName: typed }, { success: `${name} is deleted` });
  };
  return (
    <Card className="min-w-0 self-start p-5 md:p-6 lg:col-span-5">
      <CardHeader icon={<Power size={19} />} title="Power" sub="At Hetzner" />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void off()}>Turn off</Button>
        <Button size="sm" onClick={() => void act('server.power', { serverId, op: 'on' }, { success: `${name} is turning on` })}>Turn on</Button>
        <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void gone()}>Delete it</Button>
      </div>
    </Card>
  );
}

// --- moving a whole Coolify server --------------------------------------------------------------------------------------------
interface MovePlan { to?: string; ready?: boolean; problems?: string[]; about: { minutes: number; gb: number }; moves: { volumes: unknown[]; databases: unknown[] }; leftBehind: string[]; warnings?: string[] }
interface Moved { proven: boolean; problems?: string[]; then?: { step: string; tool: string }[] }
function Move({ serverId, others }: { serverId: string; others: { id: string; name: string }[] }) {
  const [to, setTo] = useState(others[0]?.id ?? '');
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [moved, setMoved] = useState<Moved | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const look = async () => {
    setBusy(true); setErr(null); setPlan(null); setMoved(null);
    const r = await runTool('server.move_plan', { serverId, toServerId: to }).catch((x: Error) => ({ status: 'error' as const, error: { code: 'network', message: x.message } }));
    setBusy(false);
    if (r.status === 'ok') setPlan(r.output as MovePlan); else setErr(failed(r));
  };
  const copy = async () => { setBusy(true); const r = await act('server.move', { serverId, toServerId: to }, { success: 'The copy is done', undo: false }); setBusy(false); if (r) setMoved(r.output as Moved); };
  return (
    <Card className="min-w-0 self-start p-5 md:p-6 lg:col-span-12">
      <CardHeader icon={<Truck size={19} />} title="Move to a new server" sub="Copy first, switch later" />
      <p className="mt-2 text-[13px] text-muted">Copies Coolify’s data, volumes and databases to an empty server. This one keeps running, untouched. The switch is yours, one step at a time.</p>
      {!others.length ? <p className="mt-4 text-[13px] text-muted">Add the new server first. It has to be empty.</p> : (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1"><Field label="The new server"><Select className="w-full" value={to} onChange={(v) => { setTo(v); setPlan(null); setMoved(null); }} options={others.map((o) => ({ value: o.id, label: o.name }))} /></Field></div>
          <Button loading={busy && !plan} onClick={() => void look()}>See the plan</Button>
        </div>
      )}
      {err && <div className="mt-4"><Note>{err}</Note></div>}
      {plan && !moved && (
        <div className="mt-4 space-y-3 text-[13px] text-ink-2">
          <p>About {plan.about.minutes} minutes for {plan.about.gb} GB: {plan.moves.databases.length} database{plan.moves.databases.length === 1 ? '' : 's'}, {plan.moves.volumes.length} volume{plan.moves.volumes.length === 1 ? '' : 's'} and Coolify’s own files.</p>
          {[...(plan.problems ?? []), ...(plan.warnings ?? [])].map((p) => <Note key={p}>{tidy(p)}</Note>)}
          <div><p className="font-medium text-ink">What’s left behind</p><ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{plan.leftBehind.map((l) => <li key={l}>{l}</li>)}</ul></div>
          <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={plan.ready === false} onClick={() => void copy()}>Copy it to {plan.to}</Button></div>
        </div>
      )}
      {moved && (
        <div className="mt-4 space-y-3 text-[13px] text-ink-2">
          {moved.problems?.map((p) => <Note key={p}>{tidy(p)}</Note>)}
          {moved.proven && <>
            <p className="font-medium text-ink">The copy is proven. The switch is yours, one step at a time:</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted">{moved.then?.map((s) => <li key={s.step}>{s.step}</li>)}</ol>
            <div className="flex justify-end"><HoldButton size="md" onConfirm={() => void act('server.move_start', { serverId, toServerId: to }, { success: 'Coolify is running on the new server', undo: false })}>Start Coolify on the new server</HoldButton></div>
          </>}
        </div>
      )}
    </Card>
  );
}

export function ServerCare({ serverId, name, provider, coolify, others }: { serverId: string; name: string; provider: string | null; coolify: boolean; others: { id: string; name: string }[] }) {
  return (
    <>
      <SignIn serverId={serverId} name={name} />
      <OpenPort serverId={serverId} />
      {provider && <Snapshots serverId={serverId} name={name} />}
      {provider && <Size serverId={serverId} />}
      {provider === 'hetzner' && <PowerCard serverId={serverId} name={name} />}
      {coolify && <Move serverId={serverId} others={others} />}
    </>
  );
}
