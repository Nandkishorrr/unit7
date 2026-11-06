// What needs a look on a server, as one list: the watch's risks, waste and tips (each with its fix) and the jumps in
// usage that are unusual right now, most serious first, each said once. A short list shows the top few with one button
// each; the pop-up has the details, the full fixes with their undo, and everything else.
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronRight, RefreshCw } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { A, AiButton, Button, Modal, Skeleton, cx, timeAgo, StatusMark } from '../../ui';
import { tidy } from '../../lib/words';
import { askOnHome } from '../Help';
import { ByHand, FixButton, SEV, handSteps } from '../security/SecurityCheck';
import { BackBadge, ExplainBlock, HiddenList, SnoozeMenu, type Explain } from '../explain';
import { AnomalyList, FindingsPanel, FixAction, investigatePrompt, isToolFix, type FindingsOut, type WAlert, type WFinding } from '../watch';
import { attentionItems, type Bucket, type Item as AnyItem } from './shape';
import { openCoolifyDomain } from './CoolifyDomain';
import { Choices } from '../choices';
import { findingChoices, type FindingLike } from '../../lib/choices';

export type { Bucket };
export type Item = AnyItem<WFinding, WAlert>;


export function useServerWatch(serverId: string) {
  const [findings, setFindings] = useState<FindingsOut | null>(null);
  const [alerts, setAlerts] = useState<{ open: WAlert[]; cleared: WAlert[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadFindings = async (fresh = false) => {
    setBusy(true);
    try { const r = await runTool('server.findings', { serverId, fresh }); if (r.status === 'ok') { setFindings(r.output); setErr(null); } else setErr(r.status === 'error' ? r.error.message : 'Not allowed'); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const loadAlerts = () => runTool('watch.anomalies', { serverId }).then((r) => { if (r.status === 'ok') setAlerts(r.output); }, () => undefined);
  useEffect(() => {
    setFindings(null); setAlerts(null);
    void loadFindings(); void loadAlerts();
    return onLive((e) => { if (e.type.startsWith('watch.')) void loadAlerts(); });
  }, [serverId]);
  const items = useMemo(() => attentionItems(findings, alerts?.open ?? []), [findings, alerts]);
  const counts = { risk: items.filter((i) => i.bucket === 'risk').length, waste: items.filter((i) => i.bucket === 'waste').length, tip: items.filter((i) => i.bucket === 'tip').length };
  return { findings, alerts, items, counts, err, busy, loading: !findings && !err, reload: (fresh = false) => { void loadFindings(fresh); void loadAlerts(); } };
}
export type ServerWatch = ReturnType<typeof useServerWatch>;

export const BUCKET_WORD: Record<Bucket, [one: string, many: string]> = { risk: ['risk', 'risks'], waste: ['waste', 'waste'], tip: ['tip', 'tips'] };
export const countsLine = (c: ServerWatch['counts']) => (['risk', 'waste', 'tip'] as const).filter((b) => c[b]).map((b) => `${c[b]} ${BUCKET_WORD[b][c[b] === 1 ? 0 : 1]}`).join(' · ');

// the one next step for a row: its fix, or the AI's look at something unusual
export function ItemAction({ it, onDetails, strong }: { it: Item; onDetails: () => void; strong?: boolean }) {
  if (it.alert && !it.fix) return it.alert.conversationId
    ? <A href={`/?c=${it.alert.conversationId}`} className="relative z-10 inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-blue-soft px-3 text-[12.5px] font-medium text-blue-text hover:underline">See what Unit7 found<ArrowUpRight size={12} /></A>
    : <AiButton size="sm" className="relative z-10 shrink-0" onClick={(e) => { e.stopPropagation(); askOnHome(investigatePrompt(it.alert!), { send: true }); }}>Ask Unit7 why</AiButton>;
  return <FixAction fix={it.fix} strong={strong} onDetails={onDetails} />;
}

// what "This is fine" hides: the finding itself, or the alert's own key
const snoozeKeyOf = (it: Item) => it.finding?.id ?? (it.alert as WAlert & { snoozeKey?: string } | undefined)?.snoozeKey ?? it.id;
export function Row({ it, onOpen, onHide }: { it: Item; onOpen: (it: Item) => void; onHide?: () => void }) {
  return (
    <li className="relative flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[18px] px-3 py-3 transition hover:bg-raised/70 sm:flex-nowrap">
      <span aria-hidden className={cx('size-2.5 shrink-0 rounded-full', SEV[it.severity].dot, it.severity === 'critical' && 'animate-working')} />
      <button type="button" onClick={() => onOpen(it)} className="min-w-0 flex-1 basis-[200px] text-left text-[13.5px] leading-snug text-ink outline-none after:absolute after:inset-0 after:rounded-[18px] focus-visible:after:ring-2 focus-visible:after:ring-blue">
        {tidy(it.title)}<span className="sr-only">. {SEV[it.severity].label}. Open the details.</span>
        {it.finding?.back && <span className="ml-2 align-middle"><BackBadge back={it.finding.back} /></span>}
      </button>
      <span className="ml-[22px] flex shrink-0 items-center gap-1 sm:ml-0">
        <SnoozeMenu id={snoozeKeyOf(it)} title={it.title} kind={it.finding ? 'finding' : 'alert'} small onDone={onHide} />
        <ItemAction it={it} onDetails={() => onOpen(it)} />
      </span>
    </li>
  );
}

export function AttentionList({ w, onOpen, limit = 3 }: { w: ServerWatch; onOpen: (x: Item | 'all') => void; limit?: number }) {
  if (w.loading) return <div className="space-y-2" aria-busy="true"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>;
  if (!w.items.length) return (
    <div className="flex items-center gap-3 rounded-[18px] bg-ok/[0.07] px-4 py-3.5">
      <StatusMark state="ok" size={32} solid label="All good" className="shrink-0" />
      <p className="text-[13.5px] text-ink">{w.err ? tidy(w.err) : 'Nothing to fix and nothing wasted that Unit7 can see.'}</p>
    </div>
  );
  return (
    <div>
      <ul className="-mx-3 divide-y divide-line">{w.items.slice(0, limit).map((it) => <Row key={it.id} it={it} onOpen={onOpen} onHide={() => w.reload()} />)}</ul>
      {w.items.length > limit && (
        <button type="button" onClick={() => onOpen('all')} className="mt-2 inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-blue-text transition hover:bg-blue-soft">
          Show all {w.items.length}<ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}

// one finding in full: what it is, the evidence, and its fix with what changes and its undo (or the steps)
function ItemDetail({ f, onDone, onHide }: { f: WFinding & { explain?: Explain; back?: string }; onDone: () => void; onHide: () => void }) {
  const fix = f.fix;
  const hand = f.explain ? handSteps(fix) : undefined;
  return (
    <div className={cx('rounded-[20px] border p-4 md:p-5', SEV[f.severity].ring)}>
      <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.07em] text-muted"><span className={cx('size-2 rounded-full', SEV[f.severity].dot)} />{SEV[f.severity].label}
        <span className="ml-auto normal-case tracking-normal"><SnoozeMenu id={f.id} title={f.title} severity={f.severity} small onDone={onHide} /></span></div>
      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[15px] font-medium tracking-[-0.01em] text-ink">{tidy(f.title)}<BackBadge back={f.back} /></p>
      {f.explain ? <ExplainBlock e={f.explain} className="mt-2.5">{hand?.length ? <ByHand steps={hand} /> : null}</ExplainBlock> : <>
        <p className="mt-1 text-[13.5px] text-ink-2">{tidy(f.detail)}</p>
        {f.evidence && <p className="mt-3 break-words rounded-[12px] bg-raised px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">{tidy(f.evidence)}</p>}
      </>}
      {/* a fix Unit7 runs keeps its full button (what changes, its undo); the rest is the shared choice row: the AI's
          look, a guided pop-up, a person's steps, Check again, or asking Unit7 when there's no fix at all */}
      {isToolFix(fix) ? <FixButton fix={f.explain ? { ...fix, byHand: undefined } : fix} strong={f.severity === 'critical' || f.severity === 'high'} onDone={onDone} quiet={!!f.explain} />
        : <Choices className="mt-3" label="What to do" choices={findingChoices({ ...f, by: 'unit7' } as FindingLike)} onDone={onDone} />}
    </div>
  );
}

const TITLE: Record<Bucket, string> = { risk: 'Risk', waste: 'Waste', tip: 'Tip' };
export function AttentionModal({ w, open, onClose }: { w: ServerWatch; open: Item | 'all' | null; onClose: () => void }) {
  const it = open && open !== 'all' ? open : null;
  const usage = [...(w.alerts?.open ?? []), ...(w.alerts?.cleared ?? [])].filter((a) => a.source === 'usage');
  return (
    <Modal open={!!open} onClose={onClose} size={it ? 'md' : 'lg'} title={it ? (it.alert ? 'Unusual right now' : TITLE[it.bucket]) : 'Risks, waste and tips'}>
      {it?.finding && <ItemDetail f={it.finding} onDone={() => w.reload()} onHide={() => { onClose(); w.reload(); }} />}
      {it?.alert && <AnomalyList alerts={[it.alert]} />}
      {open === 'all' && (
        <div className="space-y-5">
          {usage.some((a) => !a.cleared) && <section aria-label="Unusual right now"><h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">Unusual right now</h3><AnomalyList alerts={usage} /></section>}
          {w.findings && <FindingsPanel data={w.findings} />}
          <HiddenList />
          <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <span className="min-w-0 flex-1">{w.findings?.at.xray ? `From what Unit7 saw ${timeAgo(w.findings.at.xray)}` : 'From what Unit7 last saw'}</span>
            <Button size="sm" variant="ghost" loading={w.busy} icon={<RefreshCw size={13} />} onClick={() => w.reload(true)}>Check again</Button>
          </p>
        </div>
      )}
    </Modal>
  );
}
