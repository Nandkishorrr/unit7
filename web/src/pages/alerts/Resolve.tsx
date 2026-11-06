// One alert's way forward, the same everywhere (the Map's pop-up, a server's risks, Home): its fix, "Check again" and
// "Ask Unit7 to fix it". Nothing here says "fixed" on its own: a fix's result carries verified (Unit7 looked again at
// just what it touched), and without one "Check again" runs. Fixed: the mark turns into a tick, "Fixed and checked",
// and the alert folds away. Still there: why, with the next option right under it.
import { useState, type ReactNode } from 'react';
import { ArrowUpRight, RefreshCw, Route, Wand2 } from 'lucide-react';
import { runTool } from '../../lib/api';
import { A, AiButton, Button, StatusMark, cx, promptDialog } from '../../ui';
import { tidy } from '../../lib/words';
import { askOnHome } from '../Help';
import { verifiedOf, type AlertAction, type AlertFix, type Verified } from '../../lib/alertActions';
import { alertChoices, type Choice } from '../../lib/choices';
import { Choices } from '../choices';

interface RouteRow { host: string; via: string; file?: string; upstream?: string; live: boolean; serves?: { name: string }; fix?: AlertFix; ask?: string }
type St = { s: 'idle' } | { s: 'busy'; what: string } | { s: 'fixed' } | { s: 'still'; why: string } | { s: 'wait' } | { s: 'error'; why: string } | { s: 'routes'; answer: string; routes: RouteRow[] };

// the typed name goes where the tool asks for it
const confirmKey = (tool: string) => (/^(coolify|asset)\.|^domain\.remove_record$/.test(tool) ? 'confirmName' : 'confirm');

// extra: more in the same row, after the actions (the Map's "This is fine")
export function Resolve({ k, serverId, about, actions, onResolved, className, extra }: { k: string; serverId?: string; about?: string; actions: AlertAction[]; onResolved?: () => void; className?: string; extra?: ReactNode }) {
  const [st, setSt] = useState<St>({ s: 'idle' });
  const busy = st.s === 'busy';
  const settle = (v: Verified) => {
    if (!v.fixed) return setSt({ s: 'still', why: v.still ?? 'The check still sees it.' });
    setSt({ s: 'fixed' });
    setTimeout(() => onResolved?.(), 1500);
  };
  const check = async () => {
    setSt({ s: 'busy', what: 'Checking again…' });
    try {
      const r = await runTool('alert.recheck', { key: k, ...(serverId && { serverId }), ...(about && { about }) });
      if (r.status === 'ok') return settle({ fixed: !!r.output?.fixed, still: r.output?.still ?? r.output?.note });
      if (r.status === 'error' && r.error.code === 'not_found') return settle({ fixed: true }); // already gone
      setSt({ s: 'error', why: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'It needs approval.' });
    } catch (e) { setSt({ s: 'error', why: (e as Error).message }); }
  };
  const fix = async (f: AlertFix) => {
    let input = f.input;
    if (f.typeName) {
      const typed = await promptDialog({ title: `${f.label}?`, label: `Type ${f.typeName} to confirm`, placeholder: f.typeName, hint: f.change, confirm: f.label,
        warn: (v) => (v && v.toLowerCase() !== f.typeName!.toLowerCase() ? 'That isn’t the name.' : undefined) });
      if (!typed || typed.toLowerCase() !== f.typeName.toLowerCase()) return;
      input = { ...input, [confirmKey(f.tool)]: typed };
    }
    setSt({ s: 'busy', what: f.look ? 'Looking, without changing anything…' : `${f.label}, then checking…` });
    try {
      const r = await runTool(f.tool, input);
      if (r.status === 'approval_required') return setSt({ s: 'wait' });
      if (r.status !== 'ok') return setSt({ s: 'error', why: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'That didn’t run.' });
      if (f.look && Array.isArray(r.output?.routes)) return setSt({ s: 'routes', answer: r.output.answer, routes: r.output.routes });
      if (r.output?.changed === false) return setSt({ s: 'still', why: r.output.why ?? 'It didn’t take, so Unit7 put it back as it was.' });
      const v = verifiedOf(r.output);
      return v ? settle(v) : check();
    } catch (e) { setSt({ s: 'error', why: (e as Error).message }); }
  };

  // the actions as the shared choice row: the first real fix recommended; each runs its own way here (checked after)
  const pickOne = (c: Choice) => {
    const n = c.key?.startsWith('fix:') ? Number(c.key.slice(4)) : -1;
    const a = n > -1 ? actions[n] : undefined;
    if (a?.kind === 'fix') { void fix(a.fix); return true; }
    if (c.key === 'check') { void check(); return true; }
    if (c.key === 'ask' && c.ask) { askOnHome(c.ask, { send: true }); return true; }
    return false; // a page: the row opens it
  };
  const mark: ReactNode = st.s === 'busy' || st.s === 'fixed' || st.s === 'still'
    ? <StatusMark state={st.s === 'busy' ? 'work' : st.s === 'fixed' ? 'ok' : 'warn'} size={18} label={st.s === 'busy' ? 'Checking' : st.s === 'fixed' ? 'Fixed' : 'Still there'} /> : null;
  return (
    <div className={cx('min-w-0', className)}>
      {st.s !== 'fixed' && (
        <Choices label="Ways to fix it" disabled={busy} choices={alertChoices(actions)} onPick={pickOne} extra={extra} />
      )}
      <div aria-live="polite">
        {mark && (
          <p className={cx('mt-2.5 flex items-start gap-2 text-[12.5px] animate-pop', st.s === 'still' ? 'text-ink' : st.s === 'fixed' ? 'font-medium text-ok' : 'text-muted')}>
            <span className="-mt-px shrink-0">{mark}</span>
            <span className="min-w-0">{st.s === 'busy' ? st.what : st.s === 'fixed' ? 'Fixed and checked' : <><span className="font-medium">Still there:</span> {tidy((st as { why: string }).why)}</>}</span>
          </p>
        )}
        {st.s === 'wait' && <A href="/approvals" className="mt-2.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-warn hover:underline">Waiting for your OK<ArrowUpRight size={12} /></A>}
        {st.s === 'error' && <p role="alert" className="mt-2.5 text-[12.5px] text-bad">{tidy(st.why)}</p>}
        {st.s === 'routes' && <Routes answer={st.answer} routes={st.routes} onFix={(f) => void fix(f)} />}
      </div>
    </div>
  );
}

// what server.routes found for the name: each route, what it reaches, and its own fix
function Routes({ answer, routes, onFix }: { answer: string; routes: RouteRow[]; onFix: (f: AlertFix) => void }) {
  return (
    <div className="mt-2.5 rounded-[16px] bg-surface/70 p-3 animate-pop">
      <p className="text-[12.5px] text-ink">{tidy(answer)}</p>
      {routes.length > 0 && (
        <ul className="mt-2 space-y-2">
          {routes.map((r, i) => (
            <li key={`${r.host}${r.via}${i}`} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12.5px]">
              <span className={cx('size-1.5 shrink-0 rounded-full', r.live ? 'bg-ok' : 'bg-faint')} aria-hidden />
              <span className="min-w-0 flex-1 basis-[200px] text-ink-2"><span className="font-medium text-ink">{r.host}</span> → {r.serves ? r.serves.name : 'nothing running'}<span className="text-muted"> · {r.via}{r.file ? ` (${r.file.split('/').pop()})` : ''}</span></span>
              {r.fix ? <Button size="sm" variant="dark" icon={<Wand2 size={13} />} title={r.fix.change ? tidy(r.fix.change) : undefined} onClick={() => onFix(r.fix!)}>{r.fix.label}</Button>
                : r.ask ? <AiButton size="sm" onClick={() => askOnHome(r.ask!, { send: true })}>Ask Unit7 to remove it</AiButton> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// folds an alert away once it's fixed (height and fade; at once with reduced motion)
export function Fold({ gone, children }: { gone: boolean; children: ReactNode }) {
  return (
    <div className={cx('grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none', gone ? 'pointer-events-none grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100')} aria-hidden={gone || undefined}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
