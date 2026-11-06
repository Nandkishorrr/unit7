// "Make a test copy": the button (for a project, an app, or a project in a server's pop-up) and the centred pop-up it
// opens. At rest the pop-up shows only what matters: what the copy gets, the live keys it leaves out (each with "use a
// test key" or "copy anyway"), the data (copied, names replaced) and the room it needs. Then the steps as they happen,
// and the moment it's live. A copy that's up can be opened or taken down from the same pop-up.
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FlaskConical, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { runTool, type ToolResult } from '../../lib/api';
import { secretWords, tidy } from '../../lib/words';
import { A, Badge, Button, HoldButton, HoverCard, Input, Modal, Select, Switch, cx, timeAgo, toast } from '../../ui';
import { LiveMoment, Note, RoomMeter, Segmented, StepList, host, useSteps } from './parts';

export interface StagingTarget { projectId?: string; serverId?: string; app?: string; name: string }
interface Live { key: string; app: string; why: string; choice: string }
interface Col { table: string; column: string; as: 'email' | 'name' | 'phone' }
export interface StagingPlan {
  kind: 'unit7' | 'coolify'; name: string; from: string; to: string; steps: string[]; liveKeys: Live[]; skipped: string[];
  databases: { name: string; engine: string; copy: boolean; anonymize?: Col[]; note?: string }[];
  room: { needMb: number; freeMb?: number; fits?: boolean }; card: { changes: { label: string; after: string }[] };
  existing: { at: string; url?: string; urls?: Record<string, string> } | null;
}
type Ran = { created?: boolean; removed?: boolean; url?: string; failed?: { step: string; why: string; approvalId?: string }; next?: string; leftOut?: string[] };
type Phase = { at: 'plan' } | { at: 'running'; steps: string[] } | { at: 'done'; r: Ran } | { at: 'stopped'; r: Ran; steps: string[] };

const where = (t: StagingTarget) => (t.projectId ? { projectId: t.projectId } : { serverId: t.serverId, app: t.app });
const outOf = (r: ToolResult): Ran => (r.status === 'ok' ? { ...r.output, ...(r.output?.failed && { failed: { ...r.output.failed, why: tidy(r.output.failed.why) } }), ...(r.output?.next && { next: tidy(r.output.next) }) }
  : { failed: { step: '', why: tidy(r.status === 'error' ? r.error.message : r.status === 'denied' || r.status === 'approval_required' ? r.why : 'It didn’t go through.') } });
const REF = /^credential:\/\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/;
const INTERNAL = /^credential:\/\/(unit7|forge|ssh|storage|ntfy|webhook)\//;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
const plain = (s: string) => s.replace(/^\d+\.\s*/, '');

export function StagingButton({ target, size = 'md', variant = 'secondary', className, label = 'Make a test copy' }: { target: StagingTarget; size?: 'sm' | 'md'; variant?: 'secondary' | 'soft' | 'primary'; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} icon={<FlaskConical size={size === 'sm' ? 14 : 15} />} onClick={() => setOpen(true)} className={className}>{label}</Button>
      <StagingPlanModal target={target} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function StagingPlanModal({ target: t, open, onClose }: { target: StagingTarget; open: boolean; onClose: () => void }) {
  const [plan, setPlan] = useState<StagingPlan | null>(null);
  const [err, setErr] = useState<string>();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [copyData, setCopyData] = useState(true);
  const [anonymize, setAnonymize] = useState(true);
  const [phase, setPhase] = useState<Phase>({ at: 'plan' });
  const [down, setDown] = useState<{ busy?: boolean; why?: string; approval?: boolean }>({});
  const live = useSteps('staging.create', phase.at === 'running');
  const load = () => {
    setErr(undefined);
    runTool('staging.plan', where(t)).then((r) => (r.status === 'ok' ? setPlan(r.output) : setErr(outOf(r).failed!.why)), (e: Error) => setErr(e.message));
  };
  useEffect(() => { if (open) { setPhase({ at: 'plan' }); setPlan(null); setChoices({}); setDown({}); load(); } }, [open]);

  const missing = Object.entries(choices).filter(([, v]) => v === 'test').map(([k]) => k);
  const go = async () => {
    const input = { ...where(t), liveKeys: Object.fromEntries(Object.entries(choices).filter(([, v]) => v !== 'test')), copyData, anonymize };
    // the steps as they'll run with these choices, so the list below matches what happens
    const fresh = await runTool('staging.plan', input).catch(() => undefined);
    const steps = (fresh?.status === 'ok' ? (fresh.output as StagingPlan).steps : plan?.steps ?? []).map(plain);
    setPhase({ at: 'running', steps });
    const r = outOf(await runTool('staging.create', input).catch((e: Error) => ({ status: 'error', error: { code: 'network', message: e.message } }) as ToolResult));
    setPhase(r.created ? { at: 'done', r } : { at: 'stopped', r, steps });
  };
  const takeDown = async () => {
    setDown({ busy: true });
    const r = outOf(await runTool('staging.remove', where(t)).catch((e: Error) => ({ status: 'error', error: { code: 'network', message: e.message } }) as ToolResult));
    if (r.removed) { toast('ok', `The test copy of ${t.name} is down`, 'Production wasn’t touched.'); setDown({}); setPlan(null); load(); onClose(); return; }
    setDown({ why: r.failed?.why, approval: !!r.failed?.approvalId });
  };

  const title = phase.at === 'done' ? `A test copy of ${t.name}` : `Make a test copy of ${t.name}`;
  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      {phase.at === 'running' && (
        <div className="space-y-4">
          <StepList steps={phase.steps} at={live.at} note={live.note} />
          <p className="text-[12.5px] text-muted">It carries on if you close this; Activity shows how it went.</p>
        </div>
      )}
      {phase.at === 'stopped' && (
        <div className="space-y-4">
          {phase.r.failed?.step ? <StepList steps={phase.steps} at={0} failed={{ step: phase.r.failed.step, why: phase.r.failed.why }} /> : <Note tone="bad">{phase.r.failed?.why}</Note>}
          {phase.r.next && <Note>{phase.r.failed?.approvalId ? <>It waits for a person’s OK. <A href="/approvals" className="font-medium text-blue-text hover:underline">Open Approvals</A>, then make the copy again: what’s done is kept.</> : phase.r.next}</Note>}
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" onClick={() => { setPhase({ at: 'plan' }); load(); }}>Try again</Button></div>
        </div>
      )}
      {phase.at === 'done' && (
        <LiveMoment title={`${t.name}’s test copy is live`} url={phase.r.url}>
          {phase.r.leftOut?.length ? <Note tone="warn">Left out, because they look live: {phase.r.leftOut.join(', ')}. Give the copy test keys for them any time.</Note> : null}
          <div className="mt-4 flex justify-end"><Button variant="dark" onClick={onClose}>Done</Button></div>
        </LiveMoment>
      )}
      {phase.at === 'plan' && (err ? <Note tone="bad">{err}</Note> : !plan ? <PlanSkeleton /> : (
        <div className="space-y-5">
          {plan.existing && (
            <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-raised/60 px-4 py-3">
              <span aria-hidden className="grid size-8 place-items-center rounded-full bg-ok-solid text-white"><FlaskConical size={15} /></span>
              <div className="min-w-0 flex-1 text-[13px]">
                <p className="font-medium text-ink">{plan.existing.url ?? Object.values(plan.existing.urls ?? {})[0] ? 'A test copy is up' : 'A test copy was started'}</p>
                <p className="truncate text-muted">{plan.existing.url ?? Object.values(plan.existing.urls ?? {})[0] ? 'Made' : 'Not finished yet · started'} {timeAgo(plan.existing.at)}{(plan.existing.url ?? Object.values(plan.existing.urls ?? {})[0]) && <> · <a className="text-blue-text hover:underline" href={plan.existing.url ?? Object.values(plan.existing.urls ?? {})[0]} target="_blank" rel="noopener">{host(plan.existing.url ?? Object.values(plan.existing.urls ?? {})[0])}</a></>}</p>
              </div>
              <HoldButton size="sm" icon={<Trash2 size={14} />} loading={down.busy} onConfirm={takeDown}>Take it down</HoldButton>
              {down.why && <p className="w-full text-[12.5px] text-bad">{down.approval ? <>Deleting the copy’s data waits for your OK. <A href="/approvals" className="font-medium underline">Open Approvals</A>, then take it down again.</> : down.why}</p>}
            </div>
          )}
          <div className="flex items-center gap-2 text-[13px]">
            <Badge tone="neutral">{plan.from}</Badge><ArrowRight size={14} aria-hidden className="text-muted" /><Badge tone="info">{plan.to}</Badge>
            <span className="min-w-0 truncate text-muted">a working copy you can break</span>
          </div>
          <ul className="divide-y divide-line rounded-[18px] border border-line">
            {plan.card.changes.filter((c) => !/^(Settings|Data|Room)$/.test(c.label)).slice(0, 5).map((c) => (
              <li key={c.label} className="flex items-baseline gap-3 px-4 py-2.5 text-[13px]"><span className="w-28 shrink-0 text-muted">{c.label}</span><span className="min-w-0 flex-1 text-ink">{c.after}</span></li>
            ))}
          </ul>
          {plan.liveKeys.length > 0 && (
            <section aria-label="Live keys">
              <h3 className="mb-1 flex items-center gap-2 text-[14px] font-semibold text-ink"><KeyRound size={15} aria-hidden />Live keys stay out<span className="tabular rounded-full bg-raised px-2 text-[12px] font-medium text-ink-2">{plan.liveKeys.length}</span></h3>
              <p className="mb-2.5 text-[12.5px] text-muted">These look live. The copy doesn’t get them unless you say so, so a test never charges a card or emails a customer.</p>
              <ul className="space-y-2.5">
                {plan.liveKeys.map((l) => <LiveRow key={l.key} live={l} value={choices[l.key] ?? 'skip'} project={t.name} onChange={(v) => setChoices((c) => ({ ...c, [l.key]: v }))} />)}
              </ul>
            </section>
          )}
          {plan.databases.length > 0 && (
            <section aria-label="Data" className="rounded-[18px] border border-line px-4 py-1">
              <div className="flex items-center gap-4 py-2.5">
                <div className="min-w-0 flex-1"><p className="text-[13.5px] font-medium text-ink">Copy production’s data</p><p className="text-[12.5px] text-muted">From a fresh backup, into new databases. Production’s stay as they are.</p></div>
                <Switch checked={copyData} onChange={setCopyData} label="Copy production’s data" />
              </div>
              {copyData && (
                <div className="flex items-center gap-4 border-t border-line py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium text-ink">Replace names, emails and phones</p>
                    <Columns dbs={plan.databases} on={anonymize} />
                  </div>
                  <Switch checked={anonymize} onChange={setAnonymize} label="Replace names, emails and phones" />
                </div>
              )}
            </section>
          )}
          {plan.skipped.length > 0 && <Note tone="warn">{plan.skipped.join(' ')}</Note>}
          <RoomMeter needMb={plan.room.needMb} freeMb={plan.room.freeMb} fits={plan.room.fits} />
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
            <p className="mr-auto flex min-w-[180px] flex-1 items-center gap-1.5 text-[12.5px] text-muted"><ShieldCheck size={14} aria-hidden className="shrink-0 text-ok" />Take it down any time. Production is never changed.</p>
            <Button variant="ghost" onClick={onClose}>Not now</Button>
            <Button variant="primary" icon={<FlaskConical size={15} />} disabled={missing.length > 0} title={missing.length ? `Pick a test key for ${missing.join(', ')}` : undefined} onClick={go}>{plan.existing ? 'Update the copy' : 'Make the copy'}</Button>
          </div>
        </div>
      ))}
    </Modal>
  );
}

const PlanSkeleton = () => <div className="space-y-3" aria-busy="true" aria-label="Planning the copy"><div className="skeleton h-5 w-2/3" /><div className="skeleton h-28" /><div className="skeleton h-16" /></div>;

// which columns get stand-ins, on hover
function Columns({ dbs, on }: { dbs: StagingPlan['databases']; on: boolean }) {
  const cols = dbs.flatMap((d) => (d.anonymize ?? []).map((c) => ({ ...c, db: d.name })));
  const note = dbs.find((d) => d.note)?.note;
  if (!on) return <p className="text-[12.5px] text-muted">Real names and emails go into the copy.</p>;
  if (!cols.length) return <p className="text-[12.5px] text-muted">{note ?? 'Unit7 checks the columns once the data is copied.'}</p>;
  return (
    <HoverCard content={<ul className="space-y-1 text-[12.5px]">{cols.slice(0, 12).map((c) => <li key={`${c.db}.${c.table}.${c.column}`} className="flex justify-between gap-4"><span className="font-mono text-ink">{c.table}.{c.column}</span><span className="text-muted">{c.as === 'email' ? 'u…@example.com' : c.as === 'phone' ? '+1555…' : 'Person …'}</span></li>)}{cols.length > 12 && <li className="text-muted">and {cols.length - 12} more</li>}</ul>}>
      <button type="button" className="text-left text-[12.5px] text-blue-text underline decoration-dotted underline-offset-4">{cols.length} column{cols.length === 1 ? '' : 's'} in {[...new Set(cols.map((c) => c.db))].join(', ')} get stand-ins</button>
    </HoverCard>
  );
}

// one live-looking key: leave it out (the default), give the copy a test one, or copy it anyway
let vaultRefs: Promise<string[]> | undefined;
// keys a person keeps (not database passwords, connected accounts' tokens or Unit7's own)
const NOT_KEYS = new Set(['db_password', 'connection_url', 'api_token', 'oauth', 'addon_credential']);
const loadRefs = () => (vaultRefs ??= runTool('vault.list').then((r) => (r.status === 'ok' ? (r.output as { ref: string; kind: string; account_id: string | null }[]).filter((x) => !INTERNAL.test(x.ref) && !NOT_KEYS.has(x.kind) && !x.account_id).map((x) => x.ref) : []), () => []));
function LiveRow({ live, value, onChange, project }: { live: Live; value: string; onChange: (v: string) => void; project: string }) {
  const mode = value === 'skip' || value === 'copy' ? value : 'test';
  const address = /address/.test(live.why);
  return (
    <li className="rounded-[16px] border border-line px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-[11rem] flex-1"><p className="truncate font-mono text-[12.5px] font-medium text-ink">{live.key}</p><p className="text-[12px] text-muted">{live.why}</p></div>
        <Segmented label={`What the copy gets for ${live.key}`} value={mode} onChange={(m) => onChange(m === 'test' ? 'test' : m)}
          options={[{ value: 'skip', label: 'Leave out' }, { value: 'test', label: address ? 'Test address' : 'Test key' }, { value: 'copy', label: 'Copy anyway', danger: true }]} />
      </div>
      {mode === 'test' && (address
        ? <Input className="mt-2.5" placeholder="https://test.example.com" aria-label={`A test address for ${live.key}`} value={value === 'test' ? '' : value} onChange={(e) => onChange(/^https?:\/\/\S+$/.test(e.target.value) ? e.target.value : 'test')} />
        : <TestKey k={live.key} project={project} value={value} onChange={onChange} />)}
      {mode === 'copy' && <p className="mt-2 text-[12px] text-bad">Not recommended: the copy would act with your live {address ? 'site' : 'key'}.</p>}
    </li>
  );
}
function TestKey({ k, project, value, onChange }: { k: string; project: string; value: string; onChange: (v: string) => void }) {
  const [refs, setRefs] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadRefs().then(setRefs); }, []);
  const options = useMemo(() => [{ value: 'test', label: 'Pick a test key you keep in Unit7' }, ...refs.map((r) => ({ value: r, label: secretWords(r).text }))], [refs]);
  const save = async () => {
    setBusy(true);
    const ref = `credential://test/${slug(project)}/${k.toLowerCase()}`;
    const r = await runTool('vault.set', { ref, value: secret, kind: 'test_key' }).catch(() => undefined);
    setBusy(false);
    if (r?.status !== 'ok') { toast('bad', 'Couldn’t keep that key', r?.status === 'error' ? r.error.message : undefined, { action: r?.status === 'denied' ? undefined : { label: 'Try again', onClick: save } }); return; }
    vaultRefs = undefined; setRefs((x) => [...x, ref]); onChange(ref); setAdding(false); setSecret('');
  };
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="min-w-0 flex-1" value={REF.test(value) ? value : 'test'} onChange={onChange} options={options} />
        {!adding && <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setAdding(true)}>New test key</Button>}
      </div>
      {adding && (
        <div className={cx('flex flex-wrap items-center gap-2 animate-pop')}>
          <Input type="password" autoComplete="off" className="min-w-0 flex-1" placeholder={`Paste the test ${k}`} aria-label={`The test value for ${k}`} value={secret} onChange={(e) => setSecret(e.target.value)} />
          <Button size="sm" variant="dark" loading={busy} disabled={secret.trim().length < 4} onClick={save}>Keep it</Button>
        </div>
      )}
    </div>
  );
}
