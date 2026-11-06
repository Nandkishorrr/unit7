// Plain words for everything that needs a person, and the quiet "This is fine" menu.
// ExplainBlock: what happened, what it can cause, what Unit7 will do (three short lines with small icons), and the
// technical detail behind "Advanced". SnoozeMenu: hide until tomorrow, for 7 or 15 days, or "This is fine, don't show it
// again" with an optional reason (people only; an AI never hides a risk). HiddenList: what's hidden, to bring it back.
// The words come from the server (src/explain.ts); approvals are worded here from what the card already says.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CalendarClock, ChevronRight, CircleAlert, Eye, EyeOff, Info, ThumbsUp, Wand2 } from 'lucide-react';
import { runTool } from '../../lib/api';
import { Badge, Button, cx, Input, Modal, toast } from '../../ui';
import { Menu } from '../kit';
import { tidy } from '../../lib/words';

export interface Explain { what: string; why: string; next: string; advanced?: string }
export type SnoozeFor = 'tomorrow' | '7d' | '15d' | 'forever';

// --- the three lines ------------------------------------------------------------------------------------------------
const LINES = [
  { icon: Info, tone: 'bg-blue-soft text-blue-text' },
  { icon: CircleAlert, tone: 'bg-[#f59e0b]/15 text-warn' },
  { icon: Wand2, tone: 'bg-ok/12 text-ok' },
] as const;
export const EXPLAIN_LABELS: [string, string, string] = ['What happened', 'What it can cause', 'What Unit7 will do'];
export const APPROVAL_LABELS: [string, string, string] = ['Unit7 wants to', 'It will', 'To undo'];

export function ExplainBlock({ e, labels = EXPLAIN_LABELS, compact, open, children, className }: { e: Explain; labels?: [string, string, string]; compact?: boolean; open?: boolean; children?: ReactNode; className?: string }) {
  const lines = [e.what, e.why, e.next];
  const advanced = e.advanced || children;
  return (
    <div className={cx('min-w-0', className)}>
      <ul className={cx('space-y-1.5', compact && 'space-y-1')}>
        {lines.map((text, i) => text ? (
          <li key={i} className="flex items-start gap-2.5">
            <span aria-hidden className={cx('mt-px grid shrink-0 place-items-center rounded-full', compact ? 'size-[18px]' : 'size-5', LINES[i]!.tone)}>{(() => { const I = LINES[i]!.icon; return <I size={compact ? 11 : 12} strokeWidth={2.4} />; })()}</span>
            <p className={cx('min-w-0 leading-snug', compact ? 'text-[12.5px]' : 'text-[13px]')}><span className="sr-only">{labels[i]}: </span><span className="font-medium text-muted" aria-hidden>{labels[i]}: </span><span className="text-ink">{tidy(text)}</span></p>
          </li>
        ) : null)}
      </ul>
      {advanced && (
        <details className="group mt-2" open={open}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-full text-[12px] font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />Advanced
          </summary>
          <div className="mt-1.5 space-y-2 rounded-[14px] bg-raised px-3 py-2.5 text-[12.5px] text-ink-2">
            {e.advanced && <p className="break-words">{tidy(e.advanced)}</p>}
            {children}
          </div>
        </details>
      )}
    </div>
  );
}

// "Back after 7 days: still here"
export const BackBadge = ({ back }: { back?: string }) => (back ? <Badge tone="warn"><CalendarClock size={11} />{back}</Badge> : null);

// --- what's hidden: one list for every page, refreshed when something is hidden or brought back -------------------------
interface HiddenRow { key: string; title: string; kind: string; until: string | null; forGood: boolean; reason: string | null; by: string | null; at: string }
let rows: HiddenRow[] = [], loaded = false, inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());
const load = () => (inflight ??= runTool('snooze.list').then((r) => { if (r.status === 'ok') { rows = (r.output as { hidden: HiddenRow[] }).hidden; loaded = true; tell(); } }).catch(() => {}).finally(() => { inflight = null; }));
let snap = { rows, loaded };
export function useHidden() {
  const s = useSyncExternalStore((f) => { subs.add(f); if (!loaded) void load(); return () => { subs.delete(f); }; }, () => (snap.rows === rows && snap.loaded === loaded ? snap : (snap = { rows, loaded })));
  return { ...s, reload: load };
}

const UNTIL: Record<Exclude<SnoozeFor, 'forever'>, string> = { tomorrow: 'until tomorrow', '7d': 'for 7 days', '15d': 'for 15 days' };
const SEVERITIES = ['critical', 'high', 'warning', 'medium', 'low', 'info'];
export async function hide(key: string, f: SnoozeFor, { severity, ...o }: { title?: string; kind?: string; reason?: string; severity?: string } = {}): Promise<boolean> {
  try {
    // how serious it is as shown: one that comes back worse shows again
    const r = await runTool('snooze.set', { key, for: f, ...o, ...(severity && SEVERITIES.includes(severity) && { severity }) });
    if (r.status !== 'ok') { toast('bad', 'Couldn’t hide it', r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : undefined, { action: r.status === 'error' ? { label: 'Try again', onClick: () => hide(key, f, { severity, ...o }) } : undefined }); return false; }
    void load();
    toast('info', f === 'forever' ? 'Okay, it’s fine' : `Hidden ${UNTIL[f]}`, f === 'forever' ? 'Unit7 won’t show it again. Hidden in Settings brings it back.' : 'It comes back by itself if it’s still there.',
      { action: { label: 'Undo', onClick: async () => { await runTool('snooze.clear', { key }); void load(); } } });
    return true;
  } catch (e) { toast('bad', 'Couldn’t hide it', (e as Error).message, { action: { label: 'Try again', onClick: () => hide(key, f, { severity, ...o }) } }); return false; }
}
export async function bringBack(key: string) {
  const r = await runTool('snooze.clear', { key }).catch(() => undefined);
  void load();
  return r?.status === 'ok';
}

// The quiet menu: "This is fine" with the snooze choices. onDone runs after it's hidden (the list drops it).
export function SnoozeMenu({ id, title, kind = 'finding', severity, onDone, className, small, iconOnly }: { id: string; title: string; kind?: 'finding' | 'alert' | 'suggestion' | 'task' | 'event'; severity?: string; onDone?: () => void; className?: string; small?: boolean; iconOnly?: boolean }) {
  const [asking, setAsking] = useState(false);
  const go = async (f: SnoozeFor, reason?: string) => { if (await hide(id, f, { title: tidy(title).slice(0, 200), kind, severity, ...(reason && { reason }) })) onDone?.(); };
  return (
    <>
      <Menu label="This is fine" align="right" items={[
        { section: 'Hide it for now' },
        { label: 'Hide until tomorrow', icon: <EyeOff size={15} />, onSelect: () => void go('tomorrow') },
        { label: 'Hide for 7 days', icon: <EyeOff size={15} />, onSelect: () => void go('7d') },
        { label: 'Hide for 15 days', icon: <EyeOff size={15} />, onSelect: () => void go('15d'), hint: 'It comes back if it’s still there' },
        { section: 'For good' },
        // a critical one is never hidden for good (src/snooze.ts stillHidden), so it isn't offered
        severity === 'critical'
          ? { label: 'This is fine, don’t show it again', icon: <ThumbsUp size={15} />, disabled: true, hint: 'Serious ones can only be hidden for a while' }
          : { label: 'This is fine, don’t show it again', icon: <ThumbsUp size={15} />, onSelect: () => setAsking(true), hint: 'You can bring it back from Hidden' },
      ]} className={className ?? cx('relative z-10 inline-flex shrink-0 items-center gap-1 rounded-full font-medium text-muted transition hover:bg-raised hover:text-ink', iconOnly ? 'size-7 justify-center' : 'px-2.5', small || iconOnly ? 'h-7 text-[12px]' : 'h-8 text-[12.5px]')}>
        <ThumbsUp size={small || iconOnly ? 12 : 13} aria-hidden />{!iconOnly && <span className={small ? 'max-sm:sr-only' : undefined}>This is fine</span>}
      </Menu>
      <FineDialog open={asking} title={title} onClose={() => setAsking(false)} onConfirm={(why) => { setAsking(false); void go('forever', why); }} />
    </>
  );
}

function FineDialog({ open, title, onClose, onConfirm }: { open: boolean; title: string; onClose: () => void; onConfirm: (why?: string) => void }) {
  const [why, setWhy] = useState('');
  useEffect(() => { if (open) setWhy(''); }, [open]);
  return (
    <Modal open={open} onClose={onClose} size="sm" title="This is fine?">
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(why.trim() || undefined); }} className="space-y-4">
        <p className="text-[13.5px] text-ink-2">Unit7 stops showing <b className="font-medium text-ink">{tidy(title)}</b> and won’t alert you about it. You can bring it back any time from Hidden.</p>
        <label className="block">
          <span className="text-[13px] font-medium text-ink-2">Why is it fine? <span className="font-normal text-muted">(optional)</span></span>
          <Input className="mt-1.5" value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} placeholder="For example: it’s a test server" autoComplete="off" />
        </label>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<ThumbsUp size={15} />}>Don’t show it again</Button></div>
      </form>
    </Modal>
  );
}

// "Hidden (N)": what's hidden, until when, why, and Bring back
export function HiddenList({ className, empty = true }: { className?: string; empty?: boolean }) {
  const { rows: list, loaded } = useHidden();
  const [busy, setBusy] = useState<string | null>(null);
  if (!loaded || (!list.length && !empty)) return null;
  return (
    <details className={cx('group rounded-[18px] border border-line px-4 py-3', className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className="transition-transform group-open:rotate-90 motion-reduce:transition-none" /><EyeOff size={14} className="text-muted" />Hidden ({list.length})
        <span className="font-normal text-muted">things you said are fine, or hid for now</span>
      </summary>
      {!list.length ? <p className="mt-3 text-[12.5px] text-muted">Nothing hidden. “This is fine” on any finding or alert puts it here.</p> : (
        <ul className="mt-2 divide-y divide-line">
          {list.map((h) => (
            <li key={h.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <div className="min-w-0 flex-1 basis-[220px]">
                <p className="truncate text-[13px] text-ink" title={h.title}>{tidy(h.title)}</p>
                <p className="text-[12px] text-muted">{h.forGood ? 'Fine for good' : `Back on ${new Date(h.until!).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`}{h.by ? ` · ${h.by}` : ''}{h.reason ? ` · “${h.reason}”` : ''}</p>
              </div>
              <Button size="sm" variant="ghost" loading={busy === h.key} icon={<Eye size={13} />} onClick={async () => { setBusy(h.key); await bringBack(h.key); setBusy(null); }}>Bring back</Button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

// --- approvals: "Unit7 wants to: … It will: … To undo: …" from what the card already knows ---------------------------------
export function approvalExplain(o: { title: string; change: string; undo?: string; tier?: number; why?: string; raw?: string }): Explain {
  const undo = o.undo?.replace(/^To undo, /, '').replace(/^./, (c) => c.toUpperCase())
    ?? ((o.tier ?? 0) >= 3 ? 'This one is hard to undo, so Unit7 takes a fresh backup first.' : 'Activity has an Undo for it afterwards.');
  return { what: o.title.replace(/\.?$/, '.'), why: o.change, next: undo, advanced: [o.why, o.raw].filter(Boolean).join(' · ') || undefined };
}
