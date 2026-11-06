// Keep, archive or delete something: a Unit7 project or anything on the map. The "…" menu (LifecycleMenu), the archive
// pop-up (with "Archive and stop it" where something can be stopped), the delete pop-up with what it affects
// (DeleteDialog), and useArchived() for pages that hide archived things.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, ArchiveRestore, Check, CircleCheck, CircleSlash, Clock, Database, Eye, Globe, Loader2, PauseCircle, PowerOff, ShieldCheck, Star, StarOff, Trash2, TriangleAlert, Users, Wallet, X } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { act, Badge, Button, cx, HoldButton, Input, Modal, timeAgo, StatusMark } from '../../ui';
import { plainError } from '../../lib/words';
import { Menu, type MenuItem } from '../kit';
import { keep, useInUse } from './InUse';

export interface LifecycleItem { key: string; name: string; kind: string; provider?: string; projectId?: string }
export interface ArchivedRow { key: string; name: string; kind: string; provider: string | null; by: string | null; created_at: string; onMap: boolean }
// "Vercel · sam" already says Vercel: the account's name alone, else "Vercel · sam" built from both
export const placeWords = (provider: string, account?: string) => (!account ? provider : account.toLowerCase().startsWith(provider.toLowerCase()) ? account : `${provider} · ${account}`);
export const ARCHIVED_WORDS = 'Archived: Unit7 won’t watch, alert on or change it. It keeps running where it is.';

// --- the archived list, shared by every page: one fetch, refreshed when something is archived or deleted ------------
let rows: ArchivedRow[] = [];
let loaded = false, loading: Promise<void> | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());
function load() {
  loading ??= runTool('asset.archived').then((r) => { if (r.status === 'ok') { rows = r.output as ArchivedRow[]; loaded = true; tell(); } }).catch(() => {}).finally(() => { loading = null; });
  return loading;
}
let offLive: (() => void) | undefined;
function subscribe(f: () => void) {
  subs.add(f);
  if (!loaded) void load();
  offLive ??= onLive((e) => { if (/^asset\.(archived|unarchived|deleted)$/.test(e.type)) void load(); });
  return () => { subs.delete(f); };
}
let snap = { rows, loaded };
const snapshot = () => (snap.rows === rows && snap.loaded === loaded ? snap : (snap = { rows, loaded }));

// The archived keys plus a toggle. toggle(item) flips it; toggle(item, true|false) sets it. Resolves to whether it worked.
export function useArchived() {
  const s = useSyncExternalStore(subscribe, snapshot);
  const keys = new Set(s.rows.map((r) => r.key));
  const toggle = async (item: LifecycleItem, on = !keys.has(item.key)) => {
    const r = await act('asset.archive', { key: item.key, archived: on }, { success: on ? `Archived ${item.name}` : `${item.name} is back`, ...(on ? {} : { undo: false as const }) });
    if (r) await load();
    return !!r;
  };
  return { keys, rows: s.rows, loaded: s.loaded, toggle, reload: load, has: (key: string) => keys.has(key) };
}

// --- the "…" menu --------------------------------------------------------------------------------------------------
export function LifecycleMenu({ item, onChanged, items = [], label, className }: { item: LifecycleItem; onChanged?: () => void; items?: MenuItem[]; label?: string; className?: string }) {
  const { has, toggle } = useArchived();
  const [open, setOpen] = useState<'archive' | 'delete' | null>(null);
  const archived = has(item.key);
  const mark = useInUse().kept.get(item.key);
  const marked = (r: unknown) => { if (r) onChanged?.(); };
  const menu: MenuItem[] = [
    ...items,
    { section: 'Keep it' },
    // "it's in use" / "important": Clean up and the savings ideas never suggest it; important = extra care
    ...(!mark ? [
      { label: 'It’s in use', icon: <CircleCheck size={16} />, hint: 'Unit7 won’t suggest archiving or deleting it', onSelect: async () => marked(await keep(item)) },
      { label: 'Mark as important', icon: <Star size={16} />, hint: 'In use, and Unit7 takes extra care with it', onSelect: async () => marked(await keep(item, { important: true })) },
    ] : [
      mark.important
        ? { label: 'Not important any more', icon: <StarOff size={16} />, hint: 'Still in use; changes go back to the usual rules', onSelect: async () => marked(await keep(item, { important: false })) }
        : { label: 'Mark as important', icon: <Star size={16} />, hint: 'Unit7 takes extra care with it', onSelect: async () => marked(await keep(item, { important: true })) },
      { label: 'Not in use any more', icon: <CircleSlash size={16} />, hint: 'Clean up may suggest it again', onSelect: async () => marked(await keep(item, { kept: false })) },
    ]),
    archived
      ? { label: 'Bring back', icon: <ArchiveRestore size={16} />, hint: 'Unit7 watches it again', onSelect: async () => { if (await toggle(item, false)) onChanged?.(); } }
      : { label: 'Archive…', icon: <Archive size={16} />, hint: 'Unit7 stops watching it. It keeps running.', onSelect: () => setOpen('archive') },
    { section: 'Danger zone' },
    { label: 'Delete…', icon: <Trash2 size={16} />, danger: true, hint: 'See what it affects first', onSelect: () => setOpen('delete') },
  ];
  return (
    <>
      <Menu label={label ?? `More for ${item.name}`} items={menu} className={className} />
      <ArchiveDialog item={item} open={open === 'archive'} onClose={() => setOpen(null)} onDone={() => { setOpen(null); onChanged?.(); }} />
      <DeleteDialog item={item} open={open === 'delete'} onClose={() => setOpen(null)} onDeleted={() => onChanged?.()} />
    </>
  );
}

// --- the impact, as the server says it ----------------------------------------------------------------------------
interface Item { name: string; logo?: string; detail?: string; backup?: string }
interface Stop { tool: string; input: Record<string, unknown>; label: string }
export interface Impact {
  key: string; name: string; kind: string; provider: string; providerName: string; account?: string; url?: string; archived: boolean;
  production: { yes: boolean; why?: string }; breaks: Item[]; deletes: Item[]; stays: Item[]; data: Item[]; dataGoes: 'always' | 'optional' | 'never';
  facts: { lastDeploy?: string; requests?: { n: number; days: number }; site?: { status: string; checkedAt: string | null }; cost?: { amount: number; currency: string } };
  can: { delete: boolean; why?: string; how?: string; pause?: boolean; stop: Stop[]; stopFirst?: Stop[] }; // stopFirst: production runs; the guided delete stops it first
  recommend?: { choice: 'archive' | 'delete'; why: string };                                               // archive when it looks used
  use?: { kept: boolean; important: boolean; signs: string[] }; // in use or marked important: said first
}
function useImpact(key: string, open: boolean) {
  const [s, setS] = useState<{ data?: Impact; error?: string }>({});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setS({});
    runTool('asset.impact', { key }).then((r) => { if (alive) setS(r.status === 'ok' ? { data: r.output as Impact } : { error: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'Unit7 couldn’t read what it affects.' }); })
      .catch((e: Error) => { if (alive) setS({ error: e.message }); });
    return () => { alive = false; };
  }, [key, open]);
  return s;
}

const Logo = ({ id, size = 18 }: { id?: string; size?: number }) => (!id ? <span aria-hidden className="size-1.5 rounded-full bg-current opacity-50" />
  : id === 'domain' ? <Globe size={size - 2} className="text-muted" aria-hidden /> : <BrandLogo id={id} size={size} />);
function Row({ it, tone }: { it: Item; tone: 'bad' | 'ok' | 'plain' }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className={cx('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full', tone === 'bad' ? 'bg-bad/10' : tone === 'ok' ? 'bg-ok/10' : 'bg-raised')}><Logo id={it.logo} size={15} /></span>
      <span className="min-w-0 flex-1 text-[13px] leading-snug"><span className="block break-words font-medium text-ink">{it.name}</span>{it.detail && <span className="block text-muted">{it.detail}</span>}</span>
    </li>
  );
}
function Column({ title, icon, tone, items, empty }: { title: string; icon: ReactNode; tone: 'bad' | 'ok' | 'plain'; items: Item[]; empty: string }) {
  const hot = tone === 'bad' && items.length > 0;
  return (
    <section className={cx('min-w-0 rounded-[20px] border p-4', hot ? 'border-bad/25 bg-bad/[0.04]' : tone === 'ok' ? 'border-ok/20 bg-ok/[0.04]' : 'border-line bg-raised/50')}>
      <h3 className={cx('mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold', hot ? 'text-bad' : tone === 'ok' ? 'text-ok' : 'text-ink-2')}>{icon}{title}<span className="tabular ml-auto font-medium text-muted">{items.length || ''}</span></h3>
      {items.length ? <ul className="divide-y divide-line">{items.map((it, i) => <Row key={`${it.name}-${i}`} it={it} tone={tone} />)}</ul> : <p className="py-1.5 text-[13px] text-muted">{empty}</p>}
    </section>
  );
}
const money = (c: { amount: number; currency: string }) => new Intl.NumberFormat(undefined, { style: 'currency', currency: c.currency, maximumFractionDigits: 0 }).format(c.amount);
function Facts({ f, production, use }: { f: Impact['facts']; production: Impact['production']; use?: Impact['use'] }) {
  const chips: { icon: ReactNode; text: string; tone?: 'bad' | 'warn' }[] = [
    ...(use?.important ? [{ icon: <Star size={13} className="fill-current" />, text: 'You marked it important', tone: 'warn' as const }] : use?.kept ? [{ icon: <CircleCheck size={13} />, text: 'You marked it in use', tone: 'warn' as const }] : []),
    ...(use?.signs.length ? [{ icon: <Users size={13} />, text: `In use: ${use.signs[0]!.charAt(0).toLowerCase()}${use.signs[0]!.slice(1)}`, tone: 'warn' as const }] : []),
    ...(production.yes ? [{ icon: <ShieldCheck size={13} />, text: production.why ?? 'Production', tone: 'bad' as const }] : []),
    { icon: <Clock size={13} />, text: f.lastDeploy ? `Last deploy ${timeAgo(f.lastDeploy)}` : 'Last deploy not known' },
    { icon: <Users size={13} />, text: f.requests ? `${f.requests.n.toLocaleString()} visit${f.requests.n === 1 ? '' : 's'} in ${f.requests.days} days` : 'Visitors not known' },
    ...(f.site ? [{ icon: <Eye size={13} />, text: f.site.status === 'up' ? 'Answering now' : f.site.status === 'down' ? 'Not answering' : `Site ${f.site.status}`, tone: f.site.status === 'down' ? 'warn' as const : undefined }] : []),
    ...(f.cost ? [{ icon: <Wallet size={13} />, text: `${money(f.cost)} a month` }] : []),
  ];
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="What Unit7 knows about it">
      {chips.map((c, i) => <li key={i} className={cx('inline-flex min-h-7 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium', c.tone === 'bad' ? 'bg-bad/10 text-bad' : c.tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-raised text-ink-2')}>{c.icon}{c.text}</li>)}
    </ul>
  );
}
function Head({ item, i }: { item: LifecycleItem; i?: Impact }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-12 shrink-0 place-items-center rounded-[16px] bg-raised"><Logo id={i?.provider ?? item.provider ?? 'unit7'} size={24} /></span>
      <div className="min-w-0">
        <p className="truncate text-[16px] font-semibold tracking-[-0.02em]">{item.name}</p>
        <p className="truncate text-[12.5px] text-muted">{i ? placeWords(i.providerName, i.account) : providerName(item.provider ?? 'unit7')}</p>
      </div>
      {i?.archived && <Badge className="ml-auto">Archived</Badge>}
    </div>
  );
}

// --- archive: what it means, plus "Archive and stop it" where a stop exists ------------------------------------------
export function ArchiveDialog({ item, open, onClose, onDone }: { item: LifecycleItem; open: boolean; onClose: () => void; onDone: () => void }) {
  const { toggle } = useArchived();
  const { data, error } = useImpact(item.key, open);
  const [busy, setBusy] = useState<'archive' | 'stop' | null>(null);
  const stops = data?.can.stop ?? [];
  const go = async (stop: boolean) => {
    setBusy(stop ? 'stop' : 'archive');
    try {
      if (!(await toggle(item, true))) return;
      // each stop is its own call through the gate: one waiting for approval doesn't undo the archive
      if (stop) for (const s of stops) await act(s.tool, s.input, { success: s.label.replace(/^Stop /, 'Stopped ').replace(/^Pause /, 'Paused '), undo: false });
      onDone();
    } finally { setBusy(null); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Archive ${item.name}?`} size={stops.length ? 'md' : 'sm'}>
      <div className="space-y-4">
        <Head item={item} i={data} />
        <div className="flex gap-3 rounded-[18px] bg-raised p-4">
          <Archive size={18} className="mt-0.5 shrink-0 text-blue-text" aria-hidden />
          <p className="text-[13.5px] leading-relaxed text-ink-2"><span className="font-semibold text-ink">Archived:</span> Unit7 won’t watch, alert on or change it. It keeps running where it is, and you can bring it back any time.</p>
        </div>
        {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
        {stops.length > 0 && (
          <div className="rounded-[18px] border border-line p-4">
            <p className="flex items-center gap-2 text-[13px] font-semibold"><PowerOff size={15} aria-hidden />Or archive and stop it</p>
            <p className="mt-1 text-[12.5px] text-muted">Nothing is deleted. {stops.length === 1 ? `${stops[0]!.label.replace(/^(Stop|Pause) /, '')} goes offline` : `${stops.length} parts go offline`} until you start {stops.length === 1 ? 'it' : 'them'} again.</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">{stops.map((s) => <li key={s.label} className="rounded-full bg-raised px-2.5 py-1 text-[12px] font-medium text-ink-2">{s.label}</li>)}</ul>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {stops.length > 0 && <Button variant="secondary" icon={<PowerOff size={14} />} loading={busy === 'stop'} disabled={!!busy} onClick={() => go(true)}>Archive and stop it</Button>}
          <Button variant="primary" icon={<Archive size={14} />} loading={busy === 'archive'} disabled={!!busy} onClick={() => go(false)}>Archive</Button>
        </div>
      </div>
    </Modal>
  );
}

// --- the moment after: its own little root, so it stays up while the page drops the deleted card ------------------
function Gone({ name, removed, dataKept, onGone }: { name: string; removed: string[]; dataKept: boolean; onGone: () => void }) {
  const [open, setOpen] = useState(true);
  useEffect(() => { if (open) return; const t = setTimeout(onGone, 300); return () => clearTimeout(t); }, [open, onGone]);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Deleted" size="sm">
      <div className="flex flex-col items-center pb-2 pt-2 text-center" aria-live="polite">
        <StatusMark state="ok" size={64} solid label="Done" />
        <p className="mt-4 text-[17px] font-semibold tracking-[-0.02em]">{name} is gone</p>
        <p className="mt-1 max-w-sm text-[13.5px] text-muted">Removed {removed.join(', ')}.{dataKept ? ' Its data was kept.' : ''} The map is already up to date, and Activity has a record of it.</p>
        <Button variant="dark" className="mt-5" onClick={() => setOpen(false)}>Done</Button>
      </div>
    </Modal>
  );
}
function celebrate(name: string, done: { removed: string[]; dataKept: boolean }) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(<Gone name={name} {...done} onGone={() => { root.unmount(); host.remove(); }} />);
}

// --- delete: what stops working, what goes, what stays; the typed name and a hold to confirm ------------------------
// When production still runs, the delete is a guided sequence in this same pop-up: 1 Stop production (each stop its own
// call through the gate), 2 Delete everything, with each step's progress, after the same typed name and hold. When it
// looks used, Archive instead is the recommended way out.
type StepState = 'todo' | 'run' | 'done' | 'bad';
export function DeleteDialog({ item, open, onClose, onDeleted, onArchived }: { item: LifecycleItem; open: boolean; onClose: () => void; onDeleted?: () => void; onArchived?: () => void }) {
  const { data: i, error } = useImpact(item.key, open);
  const { toggle } = useArchived();
  const [typed, setTyped] = useState('');
  const [alsoData, setAlsoData] = useState(false);
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  const [steps, setSteps] = useState<StepState[]>(['todo', 'todo']);
  useEffect(() => { if (open) { setTyped(''); setAlsoData(false); setState({}); setSteps(['todo', 'todo']); } }, [open, item.key]);
  const seq = i?.can.stopFirst ?? [];
  const allowed = !!i && (i.can.delete || seq.length > 0);
  const must = i?.dataGoes === 'always';
  const ready = allowed && typed.trim() === i!.name && (!must || alsoData) && !state.busy;
  const fail = (r: { status: string; error?: { message: string }; why?: string }) => (r.status === 'error' ? plainError(r.error!.message).line : r.status === 'denied' ? r.why! : r.status === 'approval_required' ? `Waiting for approval: ${r.why}` : 'That didn’t work.');
  const archiveInstead = async () => { if (await toggle(item, true)) { onClose(); onArchived?.(); } };
  const go = async () => {
    setState({ busy: true });
    const call = (tool: string, input: unknown) => runTool(tool, input).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    // 1: stop production, one app at a time; the first that doesn't stop ends it here, and nothing is deleted
    if (seq.length) {
      setSteps(['run', 'todo']);
      for (const s of seq) {
        const r = await call(s.tool, s.input);
        if (r.status !== 'ok') { setSteps(['bad', 'todo']); setState({ error: `${s.label} didn’t work, so nothing was deleted: ${fail(r)}` }); return; }
      }
      setSteps(['done', 'run']);
    }
    // 2: delete everything
    const r = await call('asset.delete', { key: item.key, confirmName: typed.trim(), alsoData });
    if (r.status === 'ok') {
      setSteps(['done', 'done']);
      setState({});
      onClose();
      celebrate(item.name, r.output as { removed: string[]; dataKept: boolean });
      onDeleted?.();
      return;
    }
    setSteps((x) => [x[0]!, 'bad']);
    setState({ error: seq.length ? `Production is stopped, but the delete didn’t work: ${fail(r)}` : fail(r) });
  };
  const title = i && !allowed ? `Unit7 can’t delete ${item.name}` : `Delete ${item.name}?`;
  const archiveFirst = i?.recommend?.choice === 'archive' && !i.archived;
  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      <div className="space-y-4">
        <Head item={item} i={i} />
        {!i && !error && <div className="space-y-3" aria-busy="true" aria-label="Reading what it affects"><span className="skeleton block h-7 w-2/3" /><div className="grid gap-3 sm:grid-cols-3"><span className="skeleton block h-36" /><span className="skeleton block h-36" /><span className="skeleton block h-36" /></div></div>}
        {error && <p role="alert" className="rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink-2">{error}</p>}
        {i && (
          <>
            <Facts f={i.facts} production={i.production} use={i.use} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Column title="Will stop working" icon={<TriangleAlert size={14} />} tone="bad" items={i.breaks} empty="Nothing Unit7 knows of points at it or uses it." />
              <Column title="Will be deleted" icon={<Trash2 size={14} />} tone={allowed ? 'bad' : 'plain'} items={i.deletes} empty="Nothing." />
              <Column title="Stays" icon={<ShieldCheck size={14} />} tone="ok" items={i.stays} empty="Nothing else is touched." />
            </div>
            {!allowed ? (
              <div className="space-y-3">
                <p className="rounded-[18px] bg-raised px-4 py-3 text-[13.5px] text-ink-2">{i.can.why}</p>
                <div className="flex flex-wrap justify-end gap-2">
                  {i.url && /^https?:/.test(i.url) && <Button variant="secondary" onClick={() => window.open(i.url, '_blank', 'noopener')}>Open in {i.providerName}</Button>}
                  {!i.archived && <Button variant="primary" icon={<Archive size={14} />} onClick={archiveInstead}>Archive it instead</Button>}
                  <Button variant="ghost" onClick={onClose}>Close</Button>
                </div>
              </div>
            ) : (
              <form onSubmit={(e) => e.preventDefault()} className="space-y-4 border-t border-line pt-4">
                {archiveFirst && (
                  <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-blue/25 bg-blue-soft/40 p-4">
                    <Archive size={18} className="shrink-0 text-blue-text" aria-hidden />
                    <p className="min-w-0 flex-1 text-[13px] text-ink-2"><span className="font-semibold text-ink">Archive instead (recommended):</span> {i.recommend!.why}. It keeps running; Unit7 stops watching it.</p>
                    <Button type="button" size="sm" variant="primary" icon={<Archive size={13} />} onClick={archiveInstead}>Archive instead</Button>
                  </div>
                )}
                {seq.length > 0 && (
                  <ol aria-label="How it goes" className="space-y-2 rounded-[18px] border border-line p-4">
                    {[{ t: 'Stop production first', d: seq.map((s) => s.label.replace(/^(Stop|Pause) /, '')).join(', ') + (seq.length === 1 ? ' goes offline' : ' go offline') },
                      { t: 'Delete everything', d: i.can.how ?? 'Unit7 removes what’s listed above' }].map((x, n) => (
                      <li key={x.t} className="flex items-start gap-3">
                        <span className={cx('grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold', steps[n] === 'done' ? 'bg-ok/12 text-ok' : steps[n] === 'bad' ? 'bg-bad/10 text-bad' : steps[n] === 'run' ? 'bg-blue-soft text-blue-text' : 'bg-raised text-ink-2')}>
                          {steps[n] === 'done' ? <Check size={14} strokeWidth={3} /> : steps[n] === 'run' ? <Loader2 size={14} className="animate-spin" /> : steps[n] === 'bad' ? <X size={14} /> : n + 1}
                        </span>
                        <span className="min-w-0 text-[13px] leading-snug"><span className="block font-medium text-ink">{x.t}</span><span className="block text-muted">{x.d}</span></span>
                      </li>
                    ))}
                  </ol>
                )}
                {i.data.length > 0 && (
                  <div className={cx('rounded-[18px] border p-4', must ? 'border-bad/30 bg-bad/[0.04]' : 'border-line')}>
                    <p className="flex items-center gap-2 text-[13px] font-semibold"><Database size={15} aria-hidden />Its data</p>
                    <ul className="mt-1.5 space-y-1">
                      {i.data.map((d, n) => (
                        <li key={n} className="flex flex-wrap items-center gap-x-2 text-[13px]">
                          <span className="font-medium">{d.name}</span><span className="text-muted">{d.detail}</span>
                          <span className={cx('ml-auto text-[12px]', d.backup ? 'text-ok' : 'text-warn')}>{d.backup ? `Backed up ${timeAgo(d.backup)}` : 'No backup Unit7 knows of'}</span>
                        </li>
                      ))}
                    </ul>
                    <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[13px]">
                      <input type="checkbox" checked={alsoData} onChange={(e) => setAlsoData(e.target.checked)} className="mt-0.5 size-4 accent-[var(--bad-solid)]" />
                      <span><span className="font-medium">Also delete its data</span><span className="block text-muted">{must ? `${i.providerName} can’t delete it without its data, so this has to be ticked.` : 'Left unticked, the data stays where it is.'}</span></span>
                    </label>
                  </div>
                )}
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium">Type <span className="font-semibold">{i.name}</span> to confirm</span>
                  <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={i.name} autoComplete="off" spellCheck={false} aria-describedby="lifecycle-how" />
                </label>
                <p id="lifecycle-how" className="text-[12.5px] text-muted">{seq.length ? 'Production goes offline first, then everything listed goes.' : `${i.can.how}.`} This can’t be undone from Unit7.</p>
                {state.error && <p role="alert" className="flex gap-2 rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink-2"><X size={15} className="mt-0.5 shrink-0 text-bad" />{state.error}</p>}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {i.can.pause && <Button type="button" variant="secondary" icon={<PauseCircle size={14} />} onClick={async () => { if (await act('asset.pause', { key: item.key }, { success: `Paused ${item.name}`, undo: false })) onClose(); }}>Pause it instead</Button>}
                  {!i.archived && !archiveFirst && <Button type="button" variant="ghost" onClick={archiveInstead}>Archive instead</Button>}
                  <HoldButton icon={state.busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} disabled={!ready} onConfirm={go}>{seq.length ? `Stop production, then delete ${i.name}` : `Delete ${i.name}`}</HoldButton>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
