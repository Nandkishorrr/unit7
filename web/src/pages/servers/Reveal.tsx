// A Coolify app's settings with Show: a value only when a person asks, hidden again after 30 seconds. When Coolify
// leaves the value out (Unit7's key there can't read values), the row offers the two ways around it right there:
// let Unit7's own key read values (a new key; the old one is deleted), or read that one value from the running app
// over the server connection. Public values (NEXT_PUBLIC_…) get a calm note instead of the secret one.
// Used by the project pop-up's Settings (./ProjectDrawer.tsx) and the chat card for Coolify's settings.
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Eye, EyeOff, Globe, KeyRound, Loader2, Server, ShieldAlert } from 'lucide-react';
import { Button, CopyButton, cx, dismissToast, stepAction, toast } from '../../ui';
import { isPublicKey, revealProblem } from '../../lib/nextstep';
import { tidy } from '../../lib/words';
import type { ToolResult } from '../../lib/api';
import { call } from './Xray';
import { ConnectFlow } from './CoolifyTile';

export interface RevealTarget { serverId: string; serverName?: string; uuid: string; kind: string }
interface Shown { value: string; from: 'coolify' | 'running' }
interface KeyInfo { automatic?: boolean; dashboard?: string; sensitive?: boolean }
const errOf = (r: ToolResult) => tidy(r.status === 'error' ? r.error.message : r.status === 'denied' || r.status === 'approval_required' ? r.why : 'That didn’t work.');
const unwrap = (r: ToolResult & { status: 'ok' }) => { const v = (r.output as { value: string | { __reveal: string } }).value; return typeof v === 'string' ? v : v.__reveal; };

export function useReveal(t: RevealTarget, connected: boolean) {
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const [need, setNeed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const asked = useRef<number>(undefined); // the "Coolify didn't send it" toast, gone once it's answered here
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  const hide = (key: string) => { clearTimeout(timers.current[key]); setShown(({ [key]: _gone, ...rest }) => rest); };
  const show = (key: string, value: string, from: Shown['from']) => {
    dismissToast(asked.current);
    setShown((s) => ({ ...s, [key]: { value, from } }));
    setNeed((n) => (n === key ? null : n));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => hide(key), 30_000); // hidden again after 30 seconds
  };
  // what Unit7's Coolify key is: made by Unit7 (it can make a new one) or pasted (the person changes it in Coolify)
  const loadInfo = async () => {
    const r = await call('coolify.connect', { serverId: t.serverId });
    const o = r.status === 'ok' ? (r.output as { dashboard?: string; connected: null | { automatic?: boolean; abilities: string[] } }) : undefined;
    const i = { automatic: o?.connected ? !!o.connected.automatic : true, dashboard: o?.dashboard, sensitive: !!o?.connected?.abilities.includes('read:sensitive') };
    setInfo(i);
    return i;
  };
  const fromServer = async (key: string) => {
    setBusy(key);
    const r = await call('coolify.running_value', { serverId: t.serverId, uuid: t.uuid, kind: t.kind, key });
    setBusy(null);
    if (r.status === 'ok') show(key, unwrap(r), 'running');
    else toast('bad', `Couldn’t read ${key} from the server`, errOf(r), { action: stepAction(r, { input: t, retry: () => fromServer(key) }) });
  };
  const reveal = async (key: string) => {
    if (shown[key]) { hide(key); return; }
    if (!connected) { await fromServer(key); return; }
    setBusy(key);
    const r = await call('coolify.envs', { serverId: t.serverId, uuid: t.uuid, kind: t.kind, op: 'reveal', key });
    setBusy(null);
    if (r.status === 'ok') { show(key, unwrap(r), 'coolify'); return; }
    if (revealProblem(r)) {
      setNeed(key); void loadInfo();
      dismissToast(asked.current);
      asked.current = toast('bad', `Couldn’t show ${key}`, 'Coolify didn’t send the value: Unit7’s key there can only see names.', {
        action: { label: 'Allow Unit7 to see values', onClick: () => allow(key) },
        more: { label: 'Read it from the server', onClick: () => fromServer(key) },
      });
      return;
    }
    toast('bad', `Couldn’t show ${key}`, errOf(r), { action: stepAction(r, { input: t, retry: () => reveal(key) }) });
  };
  // Option A: Unit7's own key, made again with read:sensitive (Coolify deletes the old one), then the value at once
  const allow = async (key: string) => {
    setNeed(key);
    const i = info ?? await loadInfo();
    if (!i.automatic) return; // a pasted token: the panel says how to change it in Coolify
    setBusy(`allow:${key}`);
    const r = await call('coolify.connect', { serverId: t.serverId, auto: true, readSecrets: true });
    const o = r.status === 'ok' ? (r.output as { status: string; problem?: string }) : undefined;
    setBusy(null);
    if (o?.status !== 'verified') {
      toast('bad', 'Unit7 couldn’t make the new key', o?.problem ? tidy(o.problem) : errOf(r), { action: { label: 'Try again', onClick: () => allow(key) } });
      return;
    }
    setInfo({ ...i, sensitive: true });
    toast('ok', 'Unit7 can see setting values now', 'Its old key in Coolify is deleted.');
    await reveal(key);
  };
  return { target: t, shown, need, busy, info, reveal, fromServer, allow, hide, closeNeed: () => { dismissToast(asked.current); setNeed(null); } };
}

// one setting: its name, its value when shown (with what kind of value it is), and Show / Hide
export function RevealRow({ k, r, human, canShow, compact }: { k: string; r: ReturnType<typeof useReveal>; human: boolean; canShow: boolean; compact?: boolean }) {
  const s = r.shown[k];
  const pub = isPublicKey(k);
  return (
    <li className={cx('px-3.5', compact ? 'py-1' : 'py-1.5')}>
      <div className="flex min-h-9 items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium" title={k}>{k}</code>
        {pub && !s && <span title="Sent to every visitor’s browser" className="hidden shrink-0 rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-muted sm:inline">Public</span>}
        {s ? <><code className="max-w-[45%] truncate rounded-md bg-raised px-1.5 py-0.5 font-mono text-[12px]">{s.value || '(empty)'}</code><CopyButton text={s.value} /></>
          : <span aria-hidden className="font-mono text-[12px] tracking-widest text-faint">••••••</span>}
        {human && canShow && (
          <button type="button" onClick={() => void r.reveal(k)} disabled={r.busy === k} aria-label={s ? `Hide ${k}` : `Show ${k}`}
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink disabled:opacity-60">
            {r.busy === k ? <Loader2 size={14} className="animate-spin" /> : s ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
      {s && (
        <p className={cx('animate-rise mb-1 flex items-start gap-1.5 text-[11.5px]', pub ? 'text-muted' : 'text-warn')}>
          {pub ? <Globe size={12} className="mt-px shrink-0" /> : <ShieldAlert size={12} className="mt-px shrink-0" />}
          <span>{s.from === 'running' && <span className="text-blue-text">This is the value the app is running with now. </span>}
            {pub ? 'This value is public: it’s sent to every visitor’s browser.' : 'A secret: don’t paste it in a chat.'} Hides again in 30 seconds.</span>
        </p>
      )}
      {r.need === k && !s && <NoValue k={k} r={r} />}
    </li>
  );
}

// Coolify left the value out: the two ways to see it, right under the setting
function NoValue({ k, r }: { k: string; r: ReturnType<typeof useReveal> }) {
  const [pasting, setPasting] = useState(false);
  const pasted = r.info && !r.info.automatic;
  return (
    <div role="group" aria-label={`Ways to see ${k}`} className="animate-rise mb-2 mt-1 space-y-2.5 rounded-[16px] bg-raised p-3">
      <p className="text-[12.5px] text-ink-2">Coolify didn’t send this value: Unit7’s key there can only see setting names. Two ways to see it:</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-[14px] bg-surface p-3 ring-1 ring-line">
          <p className="flex items-center gap-2 text-[13px] font-semibold"><KeyRound size={14} className="shrink-0 text-blue-text" />Allow Unit7 to see setting values</p>
          {pasted ? (
            <p className="text-[12px] text-muted">Unit7 uses a token you pasted, so you change it in Coolify: Keys &amp; Tokens → API Tokens, make a token with “read” and “read:sensitive” (or “root”), then paste it here. Coolify 4.4 and newer need this for logs too.</p>
          ) : (
            <p className="text-[12px] text-muted">Unit7 makes itself a new key in Coolify that can read values, and deletes the old one. Coolify 4.4 and newer need this for logs too. Values are only ever shown to people.</p>
          )}
          <div className="mt-auto flex flex-wrap gap-1.5">
            {pasted ? <>
              {r.info?.dashboard && <a href={`${r.info.dashboard}/security/api-tokens`} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12.5px] font-medium transition hover:bg-raised">Open API tokens<ExternalLink size={12} /></a>}
              <Button size="sm" variant="primary" onClick={() => setPasting(true)}>Paste a new token</Button>
            </> : <Button size="sm" variant="primary" loading={r.busy === `allow:${k}`} disabled={!r.info} onClick={() => void r.allow(k)}>Allow</Button>}
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-[14px] bg-surface p-3 ring-1 ring-line">
          <p className="flex items-center gap-2 text-[13px] font-semibold"><Server size={14} className="shrink-0 text-blue-text" />Read it from the server instead</p>
          <p className="text-[12px] text-muted">Unit7 reads only this one setting from the running app, over its server connection. Nothing else is read, and it’s noted in Activity.</p>
          <div className="mt-auto"><Button size="sm" variant="secondary" loading={r.busy === k} onClick={() => void r.fromServer(k)}>Read from the server</Button></div>
        </div>
      </div>
      {pasting && r.info && (
        <div className="rounded-[14px] bg-surface p-3 ring-1 ring-line">
          <ConnectFlow serverId={r.target.serverId} serverName={r.target.serverName ?? 'this server'} human paste onConnected={() => { setPasting(false); void r.reveal(k); }} />
        </div>
      )}
      <div className="flex justify-end"><button type="button" onClick={r.closeNeed} className="text-[12px] font-medium text-muted hover:text-ink">Not now</button></div>
    </div>
  );
}

// Logs Coolify won't send (4.4 and newer need read:sensitive for them): the same permission, one click when the key
// is Unit7's own; how to change it in Coolify when it was pasted
export function GivePermission({ serverId, human, onDone }: { serverId: string; human: boolean; onDone: () => void }) {
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call('coolify.connect', { serverId }).then((r) => {
      const o = r.status === 'ok' ? (r.output as { dashboard?: string; connected: null | { automatic?: boolean } }) : undefined;
      setInfo({ automatic: o?.connected ? !!o.connected.automatic : true, dashboard: o?.dashboard });
    });
  }, [serverId]);
  if (!human || !info) return null;
  const allow = async () => {
    setBusy(true);
    const r = await call('coolify.connect', { serverId, auto: true, readSecrets: true });
    setBusy(false);
    const o = r.status === 'ok' ? (r.output as { status: string; problem?: string }) : undefined;
    if (o?.status === 'verified') { toast('ok', 'Unit7 can read logs and setting values now', 'Its old key in Coolify is deleted.'); onDone(); }
    else toast('bad', 'Unit7 couldn’t make the new key', o?.problem ? tidy(o.problem) : errOf(r), { action: { label: 'Try again', onClick: allow } });
  };
  return info.automatic
    ? <Button size="sm" variant="primary" loading={busy} icon={<KeyRound size={13} />} onClick={() => void allow()} className="mt-3">Allow Unit7 to read logs</Button>
    : info.dashboard ? <a href={`${info.dashboard}/security/api-tokens`} target="_blank" rel="noopener" className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-white/12 px-3 text-[12.5px] font-medium text-white transition hover:bg-white/20">Give the token “read:sensitive” in Coolify<ExternalLink size={12} /></a> : null;
}
