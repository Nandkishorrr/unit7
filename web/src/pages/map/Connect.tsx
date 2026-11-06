// Unused subdomains are a chance to act: point one at an app (picked, or dropped onto it on the canvas), point them
// all at once with a suggestion each, or remove one that looks abandoned (Unit7 stops serving it, or its DNS record
// goes where the DNS lives, through the clouds' Remove pop-up). Every step is the normal tool call, so approvals and
// Autopilot levels still apply; the pop-up says what happened to each.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Clock, Sparkles, Trash2, X } from 'lucide-react';
import { A, Badge, Button, Modal, cx, toast } from '../../ui';
import { runTool } from '../../lib/api';
import { tidy } from '../../lib/words';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { RemoveRecordDialog, type DnsRecordRef } from '../clouds';
import { abandoned, logoOf, pointInput, pointable, suggestApp, targetsOf, type Asset } from './data';
import { plural, short, useMap, type ConnectReq } from './parts';

type Outcome = { tone: 'ok' | 'wait' | 'bad' | 'you'; text: string };
const LEAVE = '', REMOVE = '-remove';

export function ConnectDialog({ req, onChange, onClose }: { req: ConnectReq | null; onChange: (r: ConnectReq) => void; onClose: () => void }) {
  const { v, managed, reload } = useMap();
  // an abandoned name Unit7 doesn't serve itself: its record goes where the DNS lives, through the clouds' Remove pop-up
  // (a dry run of what changes, the takeover it closes, the typed name, a hold to confirm)
  const gone = req?.remove && !managed.get(req.subs[0]!.name) ? req.subs[0] : undefined;
  const rec = gone && recordOf(v, gone, req!.root);
  const last = useRef<DnsRecordRef | undefined>(undefined);
  if (rec) last.current = rec; // kept while it animates out
  const title = !req ? '' : req.remove ? `Remove ${req.subs[0]?.name}?` : req.all ? `Connect ${plural(req.subs.length, 'unused subdomain')} of ${req.root}` : `Connect ${req.subs[0]?.name}`;
  return (
    <>
      <Modal open={!!req && !rec} onClose={onClose} title={title} size={req?.all ? 'lg' : 'md'}>
        {req && !rec && (req.remove ? <Remove key={req.subs[0]!.id} d={req.subs[0]!} onClose={onClose} /> : req.all ? <ConnectAll key={req.root} req={req} onClose={onClose} onRemove={(d) => onChange({ root: req.root, subs: [d], remove: true })} /> : <ConnectOne key={req.subs[0]!.id + (req.app ?? '')} req={req} onClose={onClose} onRemove={() => onChange({ ...req, remove: true })} />)}
      </Modal>
      {last.current && <RemoveRecordDialog record={last.current} open={!!rec} onClose={onClose} onRemoved={() => reload()} />}
    </>
  );
}

// the record behind an abandoned subdomain: a takeover is a CNAME left pointing at an app that's gone; one where nothing
// answers is most often an A record. The zone's account is the one the last sync read it from.
// ponytail: the record type is a guess from the map (it doesn't keep records); a wrong guess shows "no such record"
function recordOf(v: ReturnType<typeof useMap>['v'], d: Asset, root: string): DnsRecordRef {
  const account = d.account ?? v.groups.find((g) => g.root === root)?.asset?.account;
  return { zone: root, name: d.name, type: abandoned(v, d) === 'takeover' ? 'CNAME' : 'A', accountId: v.accounts.find((a) => a.name === account)?.id };
}

// the apps a subdomain can point at, best guess first
function useTargets(root: string) {
  const { v, label } = useMap();
  return useMemo(() => {
    const apps = v.assets.filter((a) => pointable(a) && !a.archived).sort((a, b) => label(a).localeCompare(label(b)));
    const g = v.groups.find((x) => x.root === root);
    // what this domain's other names already open, the bare domain first
    const near = [...new Set([g?.asset, ...(g?.subs ?? [])].flatMap((d) => (d ? targetsOf(v, d).map((t) => t.asset.id) : [])))];
    const guess = (d: Asset) => suggestApp(d.name, root, apps.map((a) => ({ id: a.id, name: label(a) })), near);
    return { apps, guess, near };
  }, [v, label, root]);
}

// what the tool said, in a line
function outcomeOf(r: Awaited<ReturnType<typeof runTool>>): Outcome {
  if (r.status === 'ok') {
    const o = r.output as { dns?: string; at?: string; addThese?: { type: string; name: string; value: string }[] };
    if (o.dns === 'needs you') return { tone: 'you', text: `Add ${plural(o.addThese?.length ?? 1, 'record')} at ${o.at}: ${o.addThese?.map((x) => `${x.type} ${x.name} → ${x.value}`).join(', ')}` };
    return { tone: 'ok', text: 'Connected. HTTPS turns on by itself in a minute or two.' };
  }
  if (r.status === 'approval_required') return { tone: 'wait', text: 'Waiting for approval on the Approvals page' };
  // what a tool says goes through tidy: a secret's address or an id never reaches the screen
  if (r.status === 'denied') return { tone: 'bad', text: tidy(r.why) };
  if (r.status === 'error') return { tone: 'bad', text: tidy(r.error.message) };
  return { tone: 'bad', text: 'Nothing happened' };
}
const OUT_ICON = { ok: <Check size={14} />, wait: <Clock size={14} />, bad: <X size={14} />, you: <ArrowRight size={14} /> };
function Said({ o }: { o: Outcome }) {
  return (
    <p role="status" className={cx('flex items-start gap-2 rounded-[14px] px-3 py-2 text-[12.5px]', o.tone === 'ok' ? 'bg-ok/10 text-ok' : o.tone === 'bad' ? 'bg-bad/10 text-bad' : o.tone === 'wait' ? 'bg-warn/10 text-warn' : 'bg-blue-soft text-blue-text')}>
      <span className="mt-0.5 shrink-0">{OUT_ICON[o.tone]}</span><span className="min-w-0 break-words">{o.text}{o.tone === 'wait' && <> · <A href="/approvals" className="font-medium underline underline-offset-2">Open it</A></>}</span>
    </p>
  );
}

function Risk({ d }: { d: Asset }) {
  const { v } = useMap();
  const why = abandoned(v, d);
  if (!why) return null;
  return (
    <p className="flex gap-2.5 rounded-[16px] bg-bad/8 px-3.5 py-3 text-[13px] text-ink-2">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-bad" />
      {why === 'takeover' ? <span><b className="font-semibold text-bad">Anyone could take this one over.</b> Its record points at something that no longer exists. Connecting it to your app, or removing it, closes that hole.</span>
        : <span>Nothing answers at this name right now. If you don’t use it, removing it keeps things tidy.</span>}
    </p>
  );
}

function AppPick({ apps, value, onChange, guess }: { apps: Asset[]; value: string | null; onChange: (id: string) => void; guess?: string }) {
  const { label } = useMap();
  const list = guess ? [apps.find((a) => a.id === guess)!, ...apps.filter((a) => a.id !== guess)] : apps;
  if (!apps.length) return <p className="text-[13px] text-muted">No apps that a domain can point at yet. Deploy one, or connect Vercel, Netlify, Render or Railway.</p>;
  return (
    <div role="radiogroup" aria-label="Point it at" className="-mx-1 max-h-[300px] space-y-1 overflow-y-auto px-1 py-0.5">
      {list.map((a) => (
        <button key={a.id} type="button" role="radio" aria-checked={value === a.id} onClick={() => onChange(a.id)}
          className={cx('flex h-12 w-full items-center gap-3 rounded-[16px] border px-3 text-left transition', value === a.id ? 'border-blue bg-blue-soft' : 'border-line hover:border-line-strong hover:bg-raised')}>
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={logoOf(a)} size={16} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium">{label(a)}</span>{a.url && <span className="block truncate text-[12px] text-muted">{a.url.replace(/^https?:\/\//, '')}</span>}</span>
          {a.id === guess && <Badge tone="info"><Sparkles size={11} />Best fit</Badge>}
          <span className={cx('grid size-5 shrink-0 place-items-center rounded-full border-2', value === a.id ? 'border-blue bg-blue text-white' : 'border-line-strong')}>{value === a.id && <Check size={12} strokeWidth={3} />}</span>
        </button>
      ))}
    </div>
  );
}

function Line({ from, to }: { from: ReactNode; to: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-2.5 rounded-[18px] bg-raised px-3.5 py-3 text-[13.5px] font-medium">{from}<ArrowRight size={15} className="shrink-0 text-faint" />{to}</div>;
}

function ConnectOne({ req, onClose, onRemove }: { req: ConnectReq; onClose: () => void; onRemove: () => void }) {
  const { v, label, reload } = useMap();
  const d = req.subs[0]!;
  const { apps, guess } = useTargets(req.root);
  const g = guess(d);
  const [pick, setPick] = useState<string | null>(req.app ?? g ?? null);
  const [sure, setSure] = useState(!!req.app); // dropped onto an app: straight to the check
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Outcome | null>(null);
  const app = pick ? v.byId.get(pick) : undefined;
  const dns = v.groups.find((x) => x.root === req.root)?.dns;
  const go = async () => {
    if (!app) return;
    setBusy(true);
    const r = await runTool('domain.point', pointInput(d.name, app)).catch((e: Error) => ({ status: 'error' as const, error: { code: 'http', message: e.message } }));
    setBusy(false);
    const o = outcomeOf(r);
    setSaid(o);
    if (o.tone === 'ok' || o.tone === 'you') { toast('ok', `${d.name} → ${label(app)}`, 'It shows on the map after the next sync.'); reload(); }
  };
  if (app && sure) return (
    <div className="space-y-4">
      <Line from={<span className="truncate">{d.name}</span>} to={<span className="flex min-w-0 items-center gap-2"><BrandLogo id={logoOf(app)} size={16} /><span className="truncate">{label(app)}</span></span>} />
      <Risk d={d} />
      <ul className="space-y-1.5 text-[13px] text-ink-2">
        <li>• {dns ? <>Unit7 adds the DNS record at {providerName(dns)} for you.</> : <>If Unit7 can’t reach where this domain’s DNS lives, it shows you the one record to add.</>}</li>
        <li>• {app.provider === 'unit7' ? 'Unit7 routes it to the app and turns on HTTPS.' : `${providerName(app.provider)} adds it to the app and turns on HTTPS.`}</li>
        <li>• To undo it later, open {d.name} and remove it.</li>
      </ul>
      {said && <Said o={said} />}
      <div className="flex justify-end gap-2 pt-1">
        {said ? <Button variant="dark" onClick={onClose}>Done</Button> : <>
          <Button variant="ghost" onClick={() => setSure(false)}>Back</Button>
          <Button variant="primary" loading={busy} onClick={() => void go()}>Connect</Button>
        </>}
      </div>
    </div>
  );
  return (
    <div className="space-y-4">
      <p className="text-[13.5px] text-muted">Nothing uses {short(d, req.root)} yet. Pick the app it should open.</p>
      <Risk d={d} />
      <AppPick apps={apps} value={pick} onChange={setPick} guess={g} />
      <div className="flex items-center justify-between gap-2 pt-1">
        {abandoned(v, d) ? <Button variant="ghost" className="text-bad" icon={<Trash2 size={15} />} onClick={onRemove}>Remove it instead</Button> : <span />}
        <Button variant="primary" disabled={!app} onClick={() => setSure(true)}>Next</Button>
      </div>
    </div>
  );
}

// every unused subdomain, each with the best guess (the person can change it), then one button for all of them
function ConnectAll({ req, onClose, onRemove }: { req: ConnectReq; onClose: () => void; onRemove: (d: Asset) => void }) {
  const { v, label, reload, managed } = useMap();
  const { apps, guess } = useTargets(req.root);
  const [plan, setPlan] = useState<Record<string, string>>(() => Object.fromEntries(req.subs.map((d) => [d.id, guess(d) ?? (abandoned(v, d) && managed.get(d.name) ? REMOVE : LEAVE)])));
  const [said, setSaid] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false);
  const [byHand, setByHand] = useState<string[]>([]); // abandoned records only the DNS host can delete
  const connecting = req.subs.filter((d) => plan[d.id] && plan[d.id] !== REMOVE);
  const removing = req.subs.filter((d) => plan[d.id] === REMOVE);
  const ran = Object.keys(said).length > 0;
  const go = async () => {
    setBusy(true);
    const hand: string[] = [];
    for (const d of [...connecting, ...removing]) { // one after another, each through the gate
      const to = plan[d.id]!;
      let o: Outcome;
      if (to === REMOVE) {
        const m = managed.get(d.name);
        if (!m) { hand.push(d.name); o = { tone: 'you', text: 'Its record lives at your DNS host: remove it below, after a look at what changes' }; }
        else o = outcomeOf(await runTool('domain.remove', { domainId: m.id }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'http', message: e.message } })));
        if (o.tone === 'ok') o = { tone: 'ok', text: 'Removed' };
      } else o = outcomeOf(await runTool('domain.point', pointInput(d.name, v.byId.get(to)!)).catch((e: Error) => ({ status: 'error' as const, error: { code: 'http', message: e.message } })));
      setSaid((s) => ({ ...s, [d.id]: o }));
    }
    setByHand(hand);
    setBusy(false);
    reload();
  };
  const options = (d: Asset) => [
    { value: LEAVE, label: 'Leave it for now' },
    ...(abandoned(v, d) ? [{ value: REMOVE, label: 'Remove it' }] : []),
    ...apps.map((a) => ({ value: a.id, label: `${label(a)}${a.id === guess(d) ? '  (best fit)' : ''}` })),
  ];
  const n = connecting.length, r = removing.length;
  return (
    <div className="space-y-4">
      <p className="text-[13.5px] text-muted">Each one gets a best guess from its name. Change any of them, or leave one for later.</p>
      <ul className="divide-y divide-line rounded-[20px] border border-line">
        {req.subs.map((d) => {
          const risk = abandoned(v, d);
          const to = plan[d.id] ?? LEAVE;
          return (
            <li key={d.id} className="px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="flex min-w-[140px] flex-1 items-center gap-2 text-[13.5px] font-medium">
                  <span className="truncate">{short(d, req.root)}<span className="font-normal text-faint">.{req.root}</span></span>
                  {risk === 'takeover' && <Badge tone="bad"><AlertTriangle size={11} />Can be taken over</Badge>}
                  {risk === 'gone' && <Badge tone="warn">Nothing answers</Badge>}
                </span>
                <ArrowRight size={14} aria-hidden className="hidden shrink-0 text-faint sm:block" />
                <label className="relative inline-flex w-full sm:w-[260px]">
                  <span className="sr-only">Point {d.name} at</span>
                  <select value={to} disabled={busy || ran} onChange={(e) => setPlan((p) => ({ ...p, [d.id]: e.target.value }))}
                    className={cx('h-10 w-full appearance-none truncate rounded-full border bg-surface pl-3.5 pr-9 text-[13px] outline-none transition focus:border-blue focus:ring-4 focus:ring-blue-soft disabled:opacity-70',
                      to === REMOVE ? 'border-bad/40 text-bad' : to ? 'border-blue/40 font-medium text-ink' : 'border-line-strong text-muted')}>
                    {options(d).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <ChevronDown size={15} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
                </label>
              </div>
              {said[d.id] && <div className="mt-2"><Said o={said[d.id]!} /></div>}
            </li>
          );
        })}
      </ul>
      {byHand.length > 0 && (
        <div className="space-y-2 rounded-[18px] bg-raised px-4 py-3">
          <p className="text-[13px] text-ink-2">{plural(byHand.length, 'record')} to delete where the DNS lives. Each shows what changes first.</p>
          <ul className="flex flex-wrap gap-2">
            {byHand.map((h) => { const d = req.subs.find((x) => x.name === h)!; return <li key={h}><Button size="sm" variant="secondary" className="text-bad" icon={<Trash2 size={14} />} onClick={() => onRemove(d)}>Remove {short(d, req.root)}…</Button></li>; })}
          </ul>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        {ran ? <Button variant="dark" onClick={onClose}>Done</Button> : <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!n && !r} onClick={() => void go()}>
            {n ? `Connect ${n}` : ''}{n && r ? ` and remove ${r}` : r ? `Remove ${r}` : ''}{!n && !r ? 'Pick at least one' : ''}
          </Button>
        </>}
      </div>
    </div>
  );
}

// an abandoned subdomain Unit7 serves itself: it stops serving it (its DNS record stays where it is)
function Remove({ d, onClose }: { d: Asset; onClose: () => void }) {
  const { managed, reload } = useMap();
  const m = managed.get(d.name)!;
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Outcome | null>(null);
  return (
    <div className="space-y-4">
      <Risk d={d} />
      <p className="text-[13.5px] text-ink-2">Unit7 stops serving it, so nothing answers at this name any more. Its DNS record stays where it is.</p>
      {said && <Said o={said} />}
      <div className="flex justify-end gap-2 pt-1">
        {said ? <Button variant="dark" onClick={onClose}>Done</Button> : <>
          <Button variant="ghost" onClick={onClose}>Keep it</Button>
          <Button variant="danger" loading={busy} icon={<Trash2 size={15} />} onClick={async () => {
            setBusy(true);
            const o = outcomeOf(await runTool('domain.remove', { domainId: m.id }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'http', message: e.message } })));
            setBusy(false); setSaid(o.tone === 'ok' ? { tone: 'ok', text: 'Removed' } : o); reload();
          }}>Remove it</Button>
        </>}
      </div>
    </div>
  );
}
