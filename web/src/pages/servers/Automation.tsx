// Things Unit7 now does by itself on a server, inside rules a person set: the first key from the root password (a
// centred pop-up: the fingerprint, the password once, the result), a fresh server preparing itself (live progress, or
// "Unit7 will share it"), the restart window, and the switch for safe fixes Warden makes by itself.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Fingerprint, KeyRound, Lock, RotateCw, Share2, Wrench } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { act, Badge, Button, Card, CardHeader, Field, IconCircle, Input, Modal, Select, Skeleton, SwitchRow, cx, timeAgo, StatusMark } from '../../ui';
import { tidy } from '../../lib/words';

// --- the first key, from the root password ---------------------------------------------------------------------------
type Identity = { fingerprint: string; known: 'new' | 'pinned' | 'changed'; host: string; port: number; user: string };
type Added = { server: string; macKey: 'added' | 'present' | 'none'; prepare?: string; suggest?: { tool: string; input: unknown; label: string; why: string }; note?: string };

export function FirstKeyButton({ serverId, name, onDone, label = 'Use the root password once', size = 'sm', variant = 'secondary' }: {
  serverId: string; name: string; onDone?: () => void; label?: string; size?: 'sm' | 'md'; variant?: 'primary' | 'secondary' | 'soft';
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} icon={<KeyRound size={size === 'sm' ? 13 : 15} />} onClick={() => setOpen(true)}>{label}</Button>
      <FirstKeyModal open={open} serverId={serverId} name={name} onClose={() => setOpen(false)} onDone={onDone} />
    </>
  );
}

export function FirstKeyModal({ open, serverId, name, onClose, onDone }: { open: boolean; serverId: string; name: string; onClose: () => void; onDone?: () => void }) {
  const [id, setId] = useState<Identity | null>(null);
  const [idErr, setIdErr] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Added | null>(null);
  const [hardened, setHardened] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (id && id.known !== 'changed') requestAnimationFrame(() => field.current?.focus()); }, [id]); // the field opens once the identity is shown
  useEffect(() => {
    if (!open) { setPw(''); return; } // closing forgets whatever was typed
    setId(null); setIdErr(null); setErr(null); setDone(null); setHardened(false);
    runTool('server.fingerprint', { serverId }).then((r) => (r.status === 'ok' ? setId(r.output as Identity) : setIdErr(r.status === 'error' ? r.error.message : 'Unit7 isn’t allowed to look.')), (e: Error) => setIdErr(e.message));
  }, [open, serverId]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id || !pw) return;
    const password = pw;
    setPw(''); // out of the page as soon as it's sent
    setBusy(true); setErr(null);
    const r = await runTool('server.install_key_with_password', { serverId, password, fingerprint: id.fingerprint }).catch((x: Error) => ({ status: 'error' as const, error: { code: 'network', message: x.message } }));
    setBusy(false);
    if (r.status === 'ok') setDone(r.output as Added);
    else { setErr(r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'That didn’t work.'); setTimeout(() => field.current?.focus(), 0); }
  };
  const who = id?.user === 'root' || !id ? 'root' : id.user;
  // the page moves on (reloads, opens the server) once the person has read the result
  const close = () => { onClose(); if (done) onDone?.(); };
  return (
    <Modal open={open} onClose={close} size="sm" title={done ? 'Unit7 can sign in now' : 'Use the root password once'}>
      {done ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-[18px] bg-ok/[0.07] p-4">
            <StatusMark state="ok" size={34} solid label="Done" className="shrink-0" />
            <p className="min-w-0 text-[13.5px] text-ink">Unit7’s key works on {name}. <span className="font-medium">The password is forgotten:</span> it wasn’t saved anywhere.</p>
          </div>
          <ul className="space-y-1.5 text-[13px] text-ink-2">
            {done.macKey !== 'none' && <li className="flex gap-2"><StatusMark state="ok" size={15} label="Done" className="mt-0.5 shrink-0" />This Mac’s own key is on the server too, so you can always get in.</li>}
            {done.prepare === 'checking' && <li className="flex gap-2"><StatusMark state="work" size={15} label="Checking" className="mt-0.5 shrink-0" />Unit7 is looking inside now. A fresh server gets prepared by itself; one that already runs things is shared and left as it is.</li>}
            {done.note && <li className="flex gap-2"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />{done.note}</li>}
          </ul>
          {done.suggest && !hardened && (
            <div className="rounded-[18px] border border-line p-4">
              <p className="text-[13.5px] font-medium">Next: turn password sign-in off</p>
              <p className="mt-0.5 text-[12.5px] text-muted">Bots try passwords all day; they can’t guess a key. You keep getting in with this Mac’s key.</p>
              <Button className="mt-3" size="sm" variant="primary" icon={<Lock size={13} />} onClick={async () => { if (await act(done.suggest!.tool, done.suggest!.input, { success: 'Passwords are off. Keys still work.' })) setHardened(true); }}>{done.suggest.label}</Button>
            </div>
          )}
          <div className="flex justify-end"><Button variant={done.suggest && !hardened ? 'ghost' : 'primary'} onClick={close}>Done</Button></div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit} autoComplete="on">
          {idErr ? <p role="alert" className="rounded-[14px] bg-bad/8 px-3.5 py-2.5 text-[13px] text-ink-2">{tidy(idErr)}</p>
            : !id ? <div aria-busy="true"><Skeleton className="h-[86px] rounded-[18px]" /><p className="sr-only">Reading the server’s identity…</p></div>
            : id.known === 'changed' ? (
              <div role="alert" className="flex items-start gap-3 rounded-[18px] bg-bad/8 p-4 text-[13px] text-ink-2">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />
                <p>This server shows a different identity (<span className="break-all font-mono text-[12px] text-ink">{id.fingerprint}</span>) from the one Unit7 knows. Don’t type a password here. If you rebuilt it, trust the new identity in its health check first.</p>
              </div>
            ) : (
              <div className="rounded-[18px] bg-raised p-4">
                <p className="flex items-center gap-2 text-[13px] text-ink-2"><Fingerprint size={15} className="shrink-0 text-blue-text" aria-hidden />You’re connecting to a server whose fingerprint is</p>
                <p className="mt-1.5 break-all font-mono text-[12.5px] font-medium text-ink">{id.fingerprint}</p>
                <p className="mt-1.5 text-[12px] text-muted">{id.known === 'pinned' ? 'The same one Unit7 trusted before.' : `First time Unit7 sees ${id.host}. Your provider’s console shows the same fingerprint if you want to compare.`}</p>
              </div>
            )}
          <Field label={`${who === 'root' ? 'Root' : `${who}’s`} password`} hint={<>Use it once and forget it: Unit7 signs in once, adds its own key, checks the key works, and forgets the password. It’s never saved, logged or shown to an AI.</>}>
            <Input ref={field} type="password" name="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} disabled={!id || id.known === 'changed' || busy} spellCheck={false} />
          </Field>
          {/* tells a password manager whose password this is, so it never fills in your Unit7 password here */}
          <input type="text" name="username" autoComplete="username" value={id ? `${id.user}@${id.host}` : ''} readOnly tabIndex={-1} aria-hidden className="sr-only" />
          {err && <p role="alert" className="rounded-[14px] bg-warn/10 px-3.5 py-2.5 text-[13px] text-ink-2">{tidy(err)}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!id || id.known === 'changed' || !pw}>Add Unit7’s key</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// --- a fresh server preparing itself (live), or shared ---------------------------------------------------------------
export function PrepStatus({ serverId, status, facts, onChanged }: { serverId: string; status: string; facts: { caddy?: string; sharedHost?: string; web?: string }; onChanged?: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'failed'>(status === 'bootstrapping' ? 'running' : 'idle');
  const [shared, setShared] = useState<string | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => { if (status === 'bootstrapping') setPhase('running'); }, [status]);
  useEffect(() => onLive((e) => {
    if (e.resource !== serverId) return;
    if (e.type === 'server.preparing') { setPhase('running'); setLines([]); }
    else if (e.type === 'server.prep') { setPhase('running'); setLines((l) => [...l.slice(-5), e.message]); }
    else if (e.type === 'server.ready') { setPhase('done'); changed.current?.(); }
    else if (e.type === 'server.shared') { setShared(e.message); changed.current?.(); }
    else if (e.type === 'server.prep_failed') setPhase('failed');
  }), [serverId]);
  const prepared = !!facts.caddy?.startsWith('Up') || /coolify-proxy/.test(facts.web ?? '');
  if (phase === 'running' || phase === 'done' || phase === 'failed') {
    return (
      <Card className="mb-4 p-5 md:p-6">
        <div className="flex items-start gap-3">
          <IconCircle size={36} tone={phase === 'done' ? 'ok' : phase === 'failed' ? 'bad' : 'soft'}>
            {phase === 'done' ? <Check size={16} strokeWidth={3} /> : phase === 'failed' ? <AlertTriangle size={15} /> : <Wrench size={16} className="motion-safe:animate-pulse" />}
          </IconCircle>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-medium">{phase === 'done' ? 'Ready for apps' : phase === 'failed' ? 'Preparing it stopped' : 'Preparing it, by itself'}</p>
            <p className="text-[12.5px] text-muted">{phase === 'done' ? 'Docker, automatic HTTPS, a firewall and security updates are on.' : phase === 'failed' ? 'Activity says why. Prepare it again from the Advanced tab once that’s sorted.' : 'A fresh server: Docker, automatic HTTPS, a firewall and security updates. A few minutes.'}</p>
            {lines.length > 0 && (
              <ol aria-live="polite" className="mt-3 space-y-1 border-l-2 border-line pl-3 text-[12.5px] text-ink-2">
                {lines.map((l, i) => <li key={`${i}${l}`} className={cx(i === lines.length - 1 && phase === 'running' && 'font-medium text-ink')}>{tidy(l)}</li>)}
              </ol>
            )}
          </div>
        </div>
      </Card>
    );
  }
  if ((shared || facts.sharedHost) && !prepared) {
    return (
      <Card className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 p-5 md:p-6">
        <IconCircle size={36} tone="soft"><Share2 size={16} /></IconCircle>
        <div className="min-w-0 flex-1 basis-[240px]">
          <p className="text-[14.5px] font-medium">This server already runs things: Unit7 will share it</p>
          <p className="text-[12.5px] text-muted">Unit7 didn’t change anything by itself. When you prepare it, the firewall stays as it is, so nothing running is cut off.</p>
        </div>
        <Button size="sm" variant="secondary" icon={<Wrench size={13} />} onClick={() => act('server.bootstrap', { serverId }, { success: 'Prepared alongside what runs there' }).then(() => changed.current?.())}>Prepare it alongside them</Button>
      </Card>
    );
  }
  return null;
}

// --- the restart window -------------------------------------------------------------------------------------------------
type RebootView = { words: string | null; window: { days: number[]; start: string; minutes: number } | null; next: string | null; inside: boolean; needsRestart: boolean | null; coolify: boolean; lastRestart: string | null; lastResult: string | null; clockKnown?: boolean };
const DAYS = [['S', 'Sunday'], ['M', 'Monday'], ['T', 'Tuesday'], ['W', 'Wednesday'], ['T', 'Thursday'], ['F', 'Friday'], ['S', 'Saturday']] as const;
const LENGTHS = [{ value: '30', label: '30 minutes' }, { value: '60', label: '1 hour' }, { value: '120', label: '2 hours' }, { value: '240', label: '4 hours' }];
const when = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} your time`; };

export function RebootWindowCard({ serverId, name, className }: { serverId: string; name: string; className?: string }) {
  const [v, setV] = useState<RebootView | null>(null);
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState<number[]>([0]);
  const [start, setStart] = useState('03:00');
  const [minutes, setMinutes] = useState('60');
  const [busy, setBusy] = useState(false);
  const load = () => runTool('reboot.status', { serverId }).then((r) => { if (r.status === 'ok') setV(r.output as RebootView); }, () => undefined);
  useEffect(() => { void load(); return onLive((e) => { if (e.resource === serverId && e.type.startsWith('reboot.')) void load(); }); }, [serverId]);
  const edit = () => { if (v?.window) { setDays(v.window.days); setStart(v.window.start); setMinutes(String(v.window.minutes)); } setEditing(true); };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await act('reboot.window', { serverId, days, start, minutes: Number(minutes) }, { success: 'Restart window saved', undo: false });
    setBusy(false);
    if (r) { setV(r.output as RebootView); setEditing(false); }
  };
  const remove = async () => { const r = await act('reboot.window', { serverId, off: true }, { success: 'Restart window removed', undo: false }); if (r) setV(r.output as RebootView); };
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<RotateCw size={19} />} title="Restart window" sub="For updates that need a restart" />
      {!v ? <Skeleton className="mt-4 h-20" /> : editing ? (
        <form onSubmit={save} className="mt-4 space-y-4">
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Days</legend>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map(([d, full], n) => {
                const on = days.includes(n);
                return <button key={full} type="button" aria-label={full} aria-pressed={on} onClick={() => setDays(on ? days.filter((x) => x !== n) : [...days, n].sort())}
                  className={cx('grid size-9 place-items-center rounded-full text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-soft', on ? 'bg-ink text-bg' : 'bg-raised text-ink-2 hover:bg-sunken')}>{d}</button>;
              })}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts at" hint="The server’s own clock"><Input type="time" required value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="For"><Select className="flex w-full [&>select]:w-full" value={minutes} onChange={setMinutes} options={LENGTHS} /></Field>
          </div>
          {v.coolify && <p className="rounded-[14px] bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-ink-2">Coolify runs here: its apps restart too, and come back by themselves.</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!days.length || !start}>Save</Button></div>
        </form>
      ) : v.window ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-[18px] bg-raised p-4">
            <p className="text-[15px] font-semibold tracking-[-0.01em]">{v.words}</p>
            <p className="mt-0.5 text-[12.5px] text-muted">{v.inside ? 'The window is open now.' : v.next ? `Next: ${when(v.next)}` : ''}{v.clockKnown === false ? ' (Unit7 reads the server’s clock when it next answers.)' : ''}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {v.needsRestart ? <Badge tone="warn">Updates are waiting for a restart</Badge> : v.needsRestart === false ? <Badge tone="ok">No restart needed</Badge> : null}
              {v.lastRestart && <Badge tone={v.lastResult === 'ok' ? 'ok' : 'warn'}>Last restart {timeAgo(v.lastRestart)}{v.lastResult && v.lastResult !== 'ok' ? `: ${v.lastResult}` : ''}</Badge>}
            </div>
          </div>
          <p className="text-[12.5px] text-muted">Unit7 warns you 10 minutes before, backs up its databases first, and checks every site comes back.{v.coolify ? ' Coolify’s apps restart too; they come back by themselves.' : ''}</p>
          <div className="flex gap-2"><Button size="sm" variant="soft" onClick={edit}>Change</Button><Button size="sm" variant="ghost" onClick={remove}>Remove</Button></div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-[13px] text-ink-2">Some security updates only finish after a restart. Pick a quiet hour and Unit7 restarts {name} there by itself: a warning 10 minutes before, a backup first, and a check that every site comes back.</p>
          <p className="text-[12.5px] text-muted">Without a window, a restart waits for you.</p>
          <Button size="sm" variant="primary" icon={<RotateCw size={13} />} onClick={edit}>Set a window</Button>
        </div>
      )}
    </Card>
  );
}

// --- safe fixes Warden makes by itself (Settings and Autopilot) -----------------------------------------------------------
type Autofix = { on: boolean; level: number; paused: boolean; working: boolean; limits: { perHour: number }; recent: { id: string; title: string; status: string; at: string }[] };
export function AutofixCard({ canChange, className }: { canChange: boolean; className?: string }) {
  const [v, setV] = useState<Autofix | null>(null);
  const load = () => runTool('autofix.status', {}).then((r) => { if (r.status === 'ok') setV(r.output as Autofix); }, () => undefined);
  useEffect(() => { void load(); return onLive((e) => { if (e.type === 'autofix.applied' || e.type.startsWith('autopilot.') || e.type === 'policy.changed') void load(); }); }, []);
  const set = async (on: boolean) => { const r = await act('autofix.settings', { on }, { success: on ? 'Warden fixes safe things by itself' : 'Safe fixes wait for you now', undo: false }); if (r) setV(r.output as Autofix); };
  const state = !v ? '' : !v.on ? 'Off: safe fixes wait for you, as suggestions.' : v.paused ? 'Autopilot is paused, so nothing is fixed by itself right now.'
    : v.level < 3 ? 'Your Autopilot level is below “Fix itself”, so these stay suggestions.' : `On. At most ${v.limits.perHour} an hour, and the same fix never twice.`;
  const applied = v?.recent.filter((r) => r.status === 'applied') ?? [];
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<Wrench size={19} />} title="Fixes by itself" sub="Only safe ones, each with an undo" />
      {!v ? <Skeleton className="mt-4 h-16" /> : (
        <>
          <SwitchRow title="Let Warden fix safe things by itself" checked={v.on} disabled={!canChange} onChange={(on) => void set(on)}
            body="Like closing a database that answers the internet. Each one shows in Activity with Undo, and on your phone." />
          <p className={cx('text-[12.5px]', v.working ? 'text-ok' : 'text-muted')}>{state}</p>
          {applied.length > 0 && (
            <ul className="mt-3 divide-y divide-line border-t border-line">
              {applied.slice(0, 3).map((r) => <li key={r.id} className="flex items-center gap-2 py-2 text-[12.5px]"><StatusMark state="ok" size={14} label="Fixed" className="shrink-0" /><span className="min-w-0 flex-1 truncate text-ink-2">{tidy(r.title)}</span><span className="shrink-0 text-muted">{timeAgo(r.at)}</span></li>)}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
