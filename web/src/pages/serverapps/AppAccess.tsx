// Access to the self-hosted apps in a server project (Supabase, Postgres, MySQL, Redis, MongoDB, MinIO, Grafana, n8n):
// each one's logo, address and access, with Connect (Unit7 makes a scoped key over root SSH and keeps it in the vault),
// "Use in my app…" (its address and keys go into another app through a connection, never through a chat) and Open.
// Calm at rest: one line per app; keys, reveals and disconnect come on click. Mount it in the server project pop-up
// (pages/servers/ProjectDrawer.tsx) with the project's part ids: <AppAccess serverId={x.serverId} parts={c.parts.map((p) => p.id)} human={human} />
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown, Eye, EyeOff, Info, KeyRound, Link2, Loader2, Plug, ShieldCheck, Unplug } from 'lucide-react';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { onLive, runTool, type ToolResult } from '../../lib/api';
import { tidy } from '../../lib/words';
import { Badge, Button, CopyButton, Dot, HoverCard, Input, Modal, act, confirmDialog, cx, toast, StatusMark, stepAction } from '../../ui';
import { useWorld } from '../chat/cards/kit';

export interface ServerApp {
  part: string; app: string; name: string; label: string; project?: string; url?: string; version?: string; health?: { status: string; reason?: string };
  environment?: string; production: boolean; access: 'connected' | 'ready' | 'paste'; keys: number; canConnect: boolean; makes: string; actions: string[];
}
interface Key { name: string; label: string; scope: string; madeByUnit7: boolean; login?: string; public?: boolean; peopleOnly?: boolean }
const errOf = (r: ToolResult) => (r.status === 'error' ? tidy(r.error.message) : r.status === 'denied' ? r.why : r.status === 'approval_required' ? 'It’s waiting for an approval.' : 'That didn’t work.');
const call = (name: string, input: unknown) => runTool(name, input).catch((e: Error): ToolResult => ({ status: 'error', error: { code: 'network', message: e.message } }));
const tone = (h?: { status: string }) => (!h ? 'idle' : h.status === 'ok' ? 'ok' : h.status === 'warn' ? 'warn' : h.status === 'bad' ? 'bad' : 'idle');

// the apps on a server, kept fresh when something about them changes
export function useServerApps(serverId: string) {
  const [apps, setApps] = useState<ServerApp[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => void call('serverapp.list', { serverId }).then((r) => (r.status === 'ok' ? (setApps((r.output as { apps: ServerApp[] }).apps), setErr(null)) : setErr(errOf(r)))), [serverId]);
  useEffect(() => {
    load();
    return onLive((e) => { if (!e.live && e.resource === serverId && /^(change\.|serverapp\.|secret\.)/.test(e.type)) load(); });
  }, [load, serverId]);
  return { apps, err, reload: load };
}

export function AppAccess({ serverId, parts, human = true, className, empty = null }: { serverId: string; parts?: string[]; human?: boolean; className?: string; empty?: ReactNode }) {
  const { apps, err, reload } = useServerApps(serverId);
  const mine = (apps ?? []).filter((a) => !parts || parts.includes(a.part));
  if (err) return <p role="alert" className="text-[12.5px] text-bad">{err}</p>;
  if (!apps) return <div aria-hidden className="skeleton h-16 rounded-[18px]" />;
  if (!mine.length) return <>{empty}</>;
  return (
    <section aria-labelledby={`access-${serverId}`} className={cx('min-w-0', className)}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-full bg-raised text-ink-2"><KeyRound size={14} /></span>
        <h3 id={`access-${serverId}`} className="flex-1 text-[14px] font-semibold">Access</h3>
        <span className="text-[12px] text-muted tabular">{mine.filter((a) => a.access === 'connected').length} of {mine.length} connected</span>
      </div>
      <ul className="stagger divide-y divide-line rounded-[18px] border border-line">
        {mine.map((a) => <AppRow key={a.part} serverId={serverId} a={a} human={human} onChanged={reload} />)}
      </ul>
    </section>
  );
}

function AppRow({ serverId, a, human, onChanged }: { serverId: string; a: ServerApp; human: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState(false);
  const [paste, setPaste] = useState<{ steps: string[]; open?: string; why?: string } | null>(null);
  const [wire, setWire] = useState(false);
  const on = a.access === 'connected';
  const connect = async () => {
    setBusy(true);
    const r = await call('serverapp.connect', { serverId, part: a.part });
    setBusy(false);
    const o = r.status === 'ok' ? (r.output as { connected: boolean; needsPaste?: boolean; steps?: string[]; open?: string; why?: string; changeId?: string; undo?: string; note?: string }) : undefined;
    if (!o) { toast(r.status === 'approval_required' ? 'warn' : 'bad', r.status === 'approval_required' ? 'Waiting for approval' : `Couldn’t connect ${a.name}`, errOf(r)); return; }
    if (o.needsPaste) { setPaste({ steps: o.steps ?? [], open: o.open, why: o.why }); return; }
    toast('ok', `${a.name} is connected`, o.note ? tidy(o.note) : 'Its keys are in the vault.', { action: o.changeId ? { label: 'Undo', onClick: () => act('change.undo', { changeId: o.changeId }, { success: 'Taken back', undo: false }).then(onChanged) } : undefined });
    onChanged();
  };
  const disconnect = async () => {
    if (!(await confirmDialog({ title: `Disconnect ${a.name}?`, body: `Unit7 removes what it made in ${a.name} and forgets every key it keeps for it. Apps you wired to it keep the values they have.`, confirm: 'Disconnect', danger: true }))) return;
    setBusy(true);
    const r = await act('serverapp.disconnect', { serverId, part: a.part }, { success: `${a.name} disconnected` });
    setBusy(false);
    if (r) { setKeys(false); onChanged(); }
  };
  const status = on ? `${a.keys} key${a.keys === 1 ? '' : 's'} in the vault` : a.access === 'paste' ? 'Needs a key you make in it' : 'Unit7 can make its own key';
  return (
    <li className="px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="relative grid size-10 shrink-0 place-items-center rounded-[13px] bg-raised">
          <BrandLogo id={a.app} size={20} />
          {on && <span className="absolute -bottom-1.5 -right-1.5 grid place-items-center rounded-full bg-surface p-[2px]"><StatusMark state="ok" size={16} label="Connected" /></span>}
        </span>
        <div className="min-w-0 flex-1 basis-[170px]">
          <p className="flex min-w-0 items-center gap-2 text-[13.5px] font-medium">
            <span className="truncate">{a.name}</span><Dot tone={tone(a.health)} />
            {!a.production && <Badge tone="lime" className="h-5 px-2 text-[11px]">Test copy</Badge>}
            <HoverCard content={<p className="max-w-[300px] text-[12.5px] leading-snug text-ink-2">{a.makes}</p>}>
              <span tabIndex={0} aria-label={`What connecting ${a.name} does`} className="grid size-5 place-items-center rounded-full text-faint transition hover:text-ink"><Info size={13} /></span>
            </HoverCard>
          </p>
          <p className="line-clamp-2 text-[12px] text-muted sm:truncate" title={a.label}>{[a.label !== a.name && a.label, a.version && `v${a.version}`, status].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {a.url && <a href={a.url} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium transition hover:bg-raised">Open<ArrowUpRight size={12} /></a>}
          {on && human && <Button size="sm" variant="soft" icon={<Link2 size={13} />} onClick={() => setWire(true)}>Use in my app…</Button>}
          {on && <button type="button" aria-expanded={keys} onClick={() => setKeys((k) => !k)} className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 transition hover:bg-raised">Keys<ChevronDown size={13} className={cx('transition-transform', keys && 'rotate-180')} /></button>}
          {!on && human && a.canConnect && <Button size="sm" variant="primary" loading={busy} icon={<Plug size={13} />} onClick={() => void connect()}>{a.access === 'paste' ? 'Add its key' : 'Connect'}</Button>}
          {!on && !a.canConnect && <span className="text-[12px] text-muted">Needs root on the server</span>}
          {!human && !on && <span className="text-[12px] text-muted">An owner or admin connects it</span>}
        </div>
      </div>
      {paste && <PasteKey serverId={serverId} a={a} steps={paste.steps} open={paste.open} why={paste.why} onDone={() => { setPaste(null); onChanged(); }} onCancel={() => setPaste(null)} />}
      {keys && on && <Keys serverId={serverId} a={a} human={human} busy={busy} onDisconnect={() => void disconnect()} />}
      <WireModal open={wire} onClose={() => setWire(false)} serverId={serverId} a={a} />
    </li>
  );
}

// n8n (and Grafana with a changed first password): the steps, then one paste; the key goes straight to the vault
function PasteKey({ serverId, a, steps, open, why, onDone, onCancel }: { serverId: string; a: ServerApp; steps: string[]; open?: string; why?: string; onDone: () => void; onCancel: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setProblem(null);
    const r = await call('serverapp.connect', { serverId, part: a.part, token: token.trim() });
    setBusy(false);
    if (r.status !== 'ok' || !(r.output as { connected?: boolean }).connected) { setProblem(errOf(r)); return; }
    setToken(''); toast('ok', `${a.name} is connected`, 'Its key is in the vault.'); onDone();
  };
  return (
    <form className="animate-rise mt-3 space-y-3 rounded-[16px] bg-raised px-4 py-3.5" onSubmit={(e) => { e.preventDefault(); if (token.trim().length >= 8) void save(); }}>
      {why && <p className="text-[12.5px] text-ink-2">{tidy(why)}</p>}
      <ol className="list-decimal space-y-1 pl-5 text-[12.5px] text-ink-2">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
      {open && <a href={open} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium transition hover:bg-raised">Open {a.name}<ArrowUpRight size={12} /></a>}
      <label className="relative block"><span className="sr-only">{a.name} key</span>
        <KeyRound size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the key" className="pl-8 font-mono text-[12.5px]" />
      </label>
      {problem && <p role="alert" className="text-[12.5px] text-bad">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={token.trim().length < 8} icon={<ShieldCheck size={13} />}>Check and keep it</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Not now</Button>
      </div>
    </form>
  );
}

// the keys Unit7 keeps: names and what each can do; a value only for a person who asks (owners and admins)
function Keys({ serverId, a, human, busy, onDisconnect }: { serverId: string; a: ServerApp; human: boolean; busy: boolean; onDisconnect: () => void }) {
  const [list, setList] = useState<Key[] | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  useEffect(() => void call('serverapp.keys', { serverId, part: a.part }).then((r) => setList(r.status === 'ok' ? (r.output as { keys: Key[] }).keys : [])), [serverId, a.part]);
  const reveal = async (k: Key) => {
    if (shown[k.name]) { setShown(({ [k.name]: _gone, ...rest }) => rest); return; }
    const r = await call('serverapp.reveal', { serverId, part: a.part, key: k.name });
    if (r.status !== 'ok') { toast('bad', `Couldn’t show the ${k.label.toLowerCase()}`, errOf(r), { action: stepAction(r, { input: { serverId }, retry: () => reveal(k) }) }); return; }
    const v = (r.output as { value: string | { __reveal: string } }).value;
    setShown((s) => ({ ...s, [k.name]: typeof v === 'string' ? v : v.__reveal }));
    setTimeout(() => setShown(({ [k.name]: _gone, ...rest }) => rest), 30_000); // hidden again after 30 seconds
  };
  if (!list) return <div className="mt-3 flex items-center gap-2 text-[12.5px] text-muted"><Loader2 size={13} className="animate-spin" />Reading the vault…</div>;
  return (
    <div className="animate-rise mt-3 space-y-2">
      <ul className="space-y-1.5">
        {list.map((k) => (
          <li key={k.name} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[14px] bg-raised px-3 py-2">
            <KeyRound size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 basis-[200px]">
              <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">{k.label}{k.madeByUnit7 && <Badge tone="info" className="h-5 px-2 text-[11px]">Made by Unit7</Badge>}{k.public && <Badge className="h-5 bg-surface px-2 text-[11px]">Public</Badge>}</span>
              <span className="block text-[12px] text-muted">{k.scope}{k.login ? ` · login ${k.login}` : ''}</span>
            </span>
            {shown[k.name] && <span className="flex min-w-0 max-w-full items-center gap-1 rounded-full bg-surface px-2.5 py-1"><code className="truncate font-mono text-[11.5px]">{shown[k.name]}</code><CopyButton text={shown[k.name]!} /></span>}
            {human && <button type="button" onClick={() => void reveal(k)} aria-label={shown[k.name] ? `Hide the ${k.label.toLowerCase()}` : `Show the ${k.label.toLowerCase()}`} className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-ink">{shown[k.name] ? <EyeOff size={14} /> : <Eye size={14} />}</button>}
          </li>
        ))}
      </ul>
      {human && <div className="flex justify-end"><Button size="sm" variant="ghost" loading={busy} icon={<Unplug size={13} />} className="text-bad hover:bg-bad/8 hover:text-bad" onClick={onDisconnect}>Disconnect</Button></div>}
    </div>
  );
}

// "Use in my app…": pick an app (here, or on Vercel, Netlify…), and its settings get this app's address and keys
interface Thing { end: { kind: string; [k: string]: unknown }; name: string; provider: string; role: string }
function WireModal({ open, onClose, serverId, a }: { open: boolean; onClose: () => void; serverId: string; a: ServerApp }) {
  const [things, setThings] = useState<Thing[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ to: string; set: string[]; applied: string[]; note?: string } | null>(null);
  const w = useWorld();
  // three apps called "web": "Shop · web (staging)", the same words the chat cards use
  const label = (t: Thing) => (t.end.kind === 'unit7' ? w.svcLabel(w.svc(t.end.serviceId as string)) ?? t.name : t.name);
  const sorted = [...(things ?? [])].sort((x, y) => +(x.provider !== 'unit7') - +(y.provider !== 'unit7') || label(x).localeCompare(label(y)));
  useEffect(() => { if (open) { setDone(null); void call('link.options', {}).then((r) => setThings(r.status === 'ok' ? (r.output as { things: Thing[] }).things.filter((t) => t.role === 'app') : [])); } }, [open]);
  const go = async (t: Thing) => {
    setBusy(label(t));
    const r = await call('serverapp.wire', { serverId, part: a.part, target: t.end });
    setBusy(null);
    if (r.status !== 'ok') { toast(r.status === 'approval_required' ? 'warn' : 'bad', r.status === 'approval_required' ? 'Waiting for approval' : 'Couldn’t wire it', errOf(r)); return; }
    const o = r.output as { set: string[]; unchanged: string[]; applied: string[]; note?: string };
    setDone({ to: label(t), set: [...o.set, ...o.unchanged], applied: o.applied, note: o.note });
  };
  return (
    <Modal open={open} onClose={onClose} title={<span className="flex items-center gap-3"><BrandLogo id={a.app} size={22} />Use {a.name} in my app</span>}>
      {done ? (
        <div className="animate-rise space-y-3">
          <div className="flex items-center gap-3">
            <StatusMark state="ok" size={40} solid label="Done" className="shrink-0" />
            <p className="text-[15px] font-semibold">{done.to} has {a.name}’s settings</p>
          </div>
          <ul className="flex flex-wrap gap-1.5">{done.set.map((k) => <li key={k}><Badge>{k}</Badge></li>)}</ul>
          {done.applied.map((m) => <p key={m} className="text-[12.5px] text-ink-2">{tidy(m)}</p>)}
          {done.note && <p className="text-[12.5px] text-muted">{tidy(done.note)}</p>}
          <p className="text-[12px] text-faint">Unit7 keeps them in sync: a changed key reaches {done.to} by itself.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-2">Unit7 puts {a.name}’s address and keys straight into the app’s settings and keeps them in sync. Nothing to copy, nothing in a chat.</p>
          {!things ? <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="skeleton block h-11 rounded-[14px]" />)}</div>
            : !things.length ? <p className="rounded-[14px] bg-raised px-4 py-3 text-[13px] text-muted">No apps yet. Add one, or connect Vercel or another host, and it shows here.</p>
            : (
              <ul className="space-y-1.5">
                {sorted.map((t) => (
                  <li key={`${t.provider}:${JSON.stringify(t.end)}`}>
                    <button type="button" disabled={!!busy} onClick={() => void go(t)} className="flex w-full items-center gap-3 rounded-[16px] border border-line bg-surface px-3.5 py-2.5 text-left transition hover:border-ink/30 hover:bg-raised disabled:opacity-60">
                      <BrandLogo id={t.provider} size={18} />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{label(t)}</span>
                      <span className="hidden shrink-0 text-[12px] text-muted sm:inline">{t.provider === 'unit7' ? 'On Unit7' : `On ${providerName(t.provider)}`}</span>
                      {busy === label(t) ? <Loader2 size={14} className="animate-spin text-muted" /> : <Link2 size={14} className="text-faint" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </Modal>
  );
}
