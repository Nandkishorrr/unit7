// Approvals: what's waiting for your OK, as big clear cards (what, who asked, where, what will
// change), then everything you decided before. The bell in the header opens the same cards, small.
import { useEffect, useRef, useState } from 'react';
import { Check, ShieldCheck, Clock, Bell, Gauge, ArrowRight } from 'lucide-react';
import { navigate, usePath } from '../lib/router';
import { AskButton } from './Help';
import { api, useApi } from '../lib/api';
import { approvalWords, changeWords, foldRuns, tidy, whoWords, type Tone } from '../lib/words';
import { Badge, Button, Card, IconCircle, Input, PageHeader, Skeleton, StatusMark, cx, nextAction, timeAgo, toast, askAction } from '../ui';
import { LoadError, useNames, WhoMark } from './Activity';
import type { Me } from '../App';
import { APPROVAL_LABELS, ExplainBlock, approvalExplain } from './explain';
import { Choices } from './choices';
import { approvalChoices } from '../lib/choices';

// "Review it first": to the typed name when it needs one, else the plain words with their detail open
function review(id: string) {
  const plain = document.getElementById(`plain-${id}`);
  plain?.querySelector('details')?.setAttribute('open', '');
  const to = document.getElementById(`confirm-${id}`) ?? plain;
  to?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  (to as HTMLElement | null)?.focus?.({ preventScroll: true });
}

const until = (iso: string) => {
  const h = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
  return h <= 1 ? 'within the hour' : `in ${h} hours`;
};

// how to take it back, so saying yes never feels final
const UNDO: Record<string, string> = {
  'domain.point': 'To undo, take the domain off the app. Its DNS record stays where it is.',
  'domain.remove': 'To undo, add the domain to the app again.',
  'domain.protect_email': 'To undo, ask Unit7 to remove the records it added.',
  'domain.move_dns': 'To undo, switch the nameservers back. The old records stay where they are.',
  'service.stop': 'To undo, deploy it again.',
  'deployment.create': 'To undo, go back to the version before. One click on the app’s page.',
  'deployment.rollback': 'To undo, deploy the newer version again from the app’s page.',
  'backup.restore': 'Unit7 backs up what’s there now first, so you can go back to it.',
  'env.set': 'To undo, set the old value again. Every change is kept in its history.',
  'server.close_port': 'To undo, open the port again: one click in Activity.',
  'part.backup_schedule': 'To undo, stop the backups from Activity. Copies already made stay.',
  'part.restore': 'Unit7 backs up what’s there now first, so you can go back to it.',
  'server.reboot': 'Nothing to undo: the server comes back by itself in a minute or two.',
};
// "Unit7 wants to: … It will: … To undo: …"
export const explainOf = (a: any, w: ReturnType<typeof approvalWords>, change: string) => approvalExplain({ title: w.title, change, undo: UNDO[a.tool], tier: a.tier, why: w.why, raw: w.raw });

// the approval's own names first (they outlive a removed app), then what the graph knows
const nameIn = (a: any, names: { name: (id?: string | null) => string | undefined }) => (id?: string) => (id ? a.names?.[id] ?? names.name(id) : undefined);
// a hard-to-undo one (data, or it can't be taken back) waits for its name to be typed before Approve works
const hard = (a: any) => (a.tier ?? 0) >= 3 && !!a.confirm;
const typedOk = (a: any, typed: string) => !hard(a) || typed.trim().toLowerCase() === String(a.confirm).toLowerCase();
const isPending = (a: any) => a.status === 'pending' && (!a.expires_at || a.expires_at > new Date().toISOString());

// Approve or say not now; the same on this page and in the bell
async function decideOne(id: string, approve: boolean, confirm?: string): Promise<boolean> {
  try {
    const r = await api(`/api/approvals/${id}/${approve ? 'approve' : 'reject'}`, { body: confirm ? { confirm } : {} });
    if (r.status === 'ok') toast('ok', 'Approved and done', undefined, { action: nextAction(r.output) });
    else if (r.status === 'rejected') toast('info', 'Okay, not now', 'Nothing was changed.');
    else if (r.status === 'error') toast('bad', 'Approved, but it didn’t work', tidy(r.error.message), { action: askAction(`I approved an action and it didn’t work: “${tidy(r.error.message).slice(0, 240)}”. Why, and how do I fix it?`) });
    else if (r.status === 'denied') toast('bad', 'Your rules blocked it', tidy(r.why));
    return r.status === 'ok' || r.status === 'rejected';
  } catch (e) {
    toast('bad', 'Couldn’t record that', tidy((e as Error).message));
    return false;
  }
}

export function Approvals({ me }: { me: Me }) {
  const list = useApi<any[]>('/api/approvals', { live: (e) => e.type.startsWith('approval.') || e.type.startsWith('action.') });
  const names = useNames();
  const [busy, setBusy] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  // a decided card folds into a line with a check that draws itself, and stays there while you're on the page
  const [decided, setDecided] = useState<{ id: string; title: string; ok: boolean }[]>([]);
  const canDecide = ['owner', 'admin', 'developer'].includes(me.role);
  const pending = (list.data ?? []).filter((a) => isPending(a) && !decided.some((f) => f.id === a.id));
  const past = (list.data ?? []).filter((a) => !isPending(a) && !decided.some((f) => f.id === a.id));
  const decide = async (id: string, approve: boolean) => {
    const a = pending.find((x) => x.id === id);
    setBusy(id);
    if (await decideOne(id, approve, typed[id]) && a) setDecided((f) => [{ id, title: approvalWords(a, nameIn(a, names)).title, ok: approve }, ...f]);
    setBusy(null);
    list.reload();
  };
  // the same decision about the same thing, again and again, is one line
  const folded = foldRuns(past.slice(0, 80).map((a) => ({ a, w: approvalWords(a, nameIn(a, names)), d: decision(a) })), (x) => `${x.w.title}|${x.d[1]}|${x.a.environment ?? ''}`);

  return (
    <>
      <PageHeader title="Approvals" subtitle="Risky things wait here for your OK. Nothing happens until you say yes."
        actions={list.data && pending.length > 0 && <Badge tone="ember" solid className="tabular">{pending.length} waiting</Badge>} />
      {!list.data ? (list.error ? <LoadError what="approvals" reload={list.reload} /> : <div className="space-y-4"><Skeleton className="h-[260px] rounded-[24px]" /><Skeleton className="h-[220px] rounded-[24px]" /></div>) : (
        <div className="space-y-12">
          {decided.length > 0 && (
            <ul aria-label="Just decided" className="!mb-4 space-y-3">
              {decided.map((d) => (
                <li key={d.id} role="status" className="approve-fold flex items-center gap-3.5 rounded-[24px] border border-line bg-surface px-5 py-4 shadow-soft">
                  <StatusMark state={d.ok ? 'ok' : 'off'} size={30} solid={d.ok} label={d.ok ? 'Approved' : 'Not now'} />
                  <p className="min-w-0 flex-1 truncate text-[14.5px] text-ink"><b className="font-semibold">{d.ok ? 'Approved' : 'Not now'}</b><span className="text-muted"> · {d.title}</span></p>
                </li>
              ))}
            </ul>
          )}
          {pending.length === 0 ? (
            <Card className="animate-rise flex flex-col items-center px-6 py-12 text-center">
              <StatusMark state="ok" size={56} solid label="All clear" />
              <h2 className="mt-5 text-[20px] font-semibold tracking-[-0.025em]">Nothing needs you</h2>
              <p className="mt-1.5 max-w-md text-[14px] text-muted">When Unit7 or your AI wants to do something risky, like deleting an app or changing a live domain, it waits here for your OK.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button variant="soft" icon={<Bell size={15} />} onClick={() => navigate('/connections#alerts')}>Approve from your phone</Button>
                <Button variant="ghost" icon={<Gauge size={15} />} onClick={() => navigate('/autopilot')}>Choose what needs your OK</Button>
              </div>
            </Card>
          ) : (
            <section aria-label="Waiting for you" className="stagger space-y-4">
              {pending.map((a) => {
                const w = approvalWords(a, nameIn(a, names));
                const who = whoWords(a.actor);
                return (
                  <Card key={a.id} className="border-blue/20 p-5 ring-4 ring-blue-soft md:p-7">
                    <div className="flex flex-wrap items-start gap-4">
                      <IconCircle tone="blue" size={48}><ShieldCheck size={22} /></IconCircle>
                      <div className="min-w-0 flex-1">
                        <h2 className="text-[20px] font-semibold leading-snug tracking-[-0.025em] md:text-[22px]">{w.title}</h2>
                        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted">
                          <span className="inline-flex items-center gap-2 text-ink-2"><WhoMark who={who} size={28} />Asked by {who}</span>
                          <Badge tone={a.environment ? 'ember' : 'neutral'}>{a.environment ?? 'Whole account'}</Badge>
                          {hard(a) && <Badge tone="warn">Hard to undo</Badge>}
                          <span className="inline-flex items-center gap-1"><Clock size={13} />{timeAgo(a.created_at)}{a.expires_at && ` · expires ${until(a.expires_at)}`}</span>
                        </p>
                      </div>
                    </div>
                    <div id={`plain-${a.id}`} tabIndex={-1} className="mt-5 rounded-[20px] bg-raised p-4 outline-none md:ml-16">
                      <p className="mb-2 text-[12px] font-medium uppercase tracking-[0.06em] text-faint">In plain words</p>
                      <ExplainBlock e={{ ...explainOf(a, w, changeWords(a.tool, a.input, nameIn(a, names))), advanced: w.why }} labels={APPROVAL_LABELS}>
                        {w.raw && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[14px] bg-surface p-3 font-mono text-[12px] text-ink-2">{tidy(w.raw)}</pre>}
                      </ExplainBlock>
                    </div>
                    {canDecide && hard(a) && (
                      <label className="mt-4 block md:ml-16">
                        <span className="block text-[13px] font-medium text-ink-2">This is hard to undo. Type <b className="font-semibold text-ink">{a.confirm}</b> to approve it.</span>
                        <Input id={`confirm-${a.id}`} className="mt-1.5 max-w-sm font-mono" value={typed[a.id] ?? ''} onChange={(e) => setTyped({ ...typed, [a.id]: e.target.value })} placeholder={a.confirm} autoComplete="off" spellCheck={false} aria-label={`Type ${a.confirm} to approve`} />
                      </label>
                    )}
                    <div className="mt-5 flex flex-wrap justify-end gap-2">
                      {/* Approve recommended when Unit7 thinks it's safe; a hard-to-undo one: Review it first, Approve is held */}
                      {canDecide ? <Choices size="md" label="Your OK" disabled={!!busy} className="w-full sm:w-auto" choices={approvalChoices({ tier: a.tier, hard: hard(a) })}
                        onPick={(c) => {
                          if (c.key === 'reject') void decide(a.id, false);
                          else if (c.key === 'review') review(a.id);
                          else if (c.key === 'approve') {
                            if (typedOk(a, typed[a.id] ?? '')) void decide(a.id, true);
                            else { toast('info', `Type ${a.confirm} first`, 'It’s hard to undo, so the name is typed before it’s approved.'); review(a.id); }
                          }
                          return true;
                        }} /> : <Badge tone="warn">An admin needs to decide this</Badge>}
                    </div>
                  </Card>
                );
              })}
            </section>
          )}

          {past.length > 0 && (
            <section aria-labelledby="past-h" className="space-y-4">
              <h2 id="past-h" className="px-1 text-[18px] font-semibold tracking-[-0.025em]">Decided before</h2>
              <Card className="animate-rise overflow-hidden p-1.5">
                <ul className="divide-y divide-line">
                  {folded.slice(0, 50).map(({ a, w, d: [tone, word], times }) => (
                    <li key={a.id} className="flex items-center gap-3.5 px-3 py-3 md:px-3.5">
                      <WhoMark who={whoWords(a.actor)} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] text-ink" title={w.raw || undefined}>{w.title}{times > 1 && <span className="text-muted"> · {times} times</span>}</p>
                        <p className="truncate text-[12.5px] text-muted">Asked by {w.who}{a.decided_by ? ` · decided by ${a.decided_by}` : ''} · {timeAgo(a.decided_at ?? a.created_at)}</p>
                      </div>
                      {a.environment && <Badge className="hidden sm:inline-flex">{a.environment}</Badge>}
                      {a.status === 'done' && a.result !== 'success' && canDecide && <AskButton label="Ask why" prompt={`I approved “${w.title}” and it didn’t work. What went wrong, and can you fix it?`} />}
                      <Badge tone={tone} solid={tone !== 'neutral'} className={cx(tone === 'neutral' && 'bg-sunken')}>{word}</Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function decision(a: any): [Tone, string] {
  if (a.status === 'done') return a.result === 'success' ? ['ok', 'Approved'] : ['bad', 'Approved, didn’t work'];
  if (a.status === 'rejected') return ['neutral', 'Not now'];
  if (a.status === 'expired' || a.status === 'pending') return ['neutral', 'Expired'];
  if (a.status === 'approved') return ['ok', 'Approved'];
  return ['neutral', a.status];
}

// --- the bell: what's waiting, approved where you are -----------------------------------------------------------
// Each waiting approval as a small card with Approve and Not now. Hard-to-undo ones open the full page instead, where
// their name is typed. A decided card folds into a line with a check, and the count goes down.
export function ApprovalBell({ me, list, reload, className }: { me: Me; list?: any[]; reload: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const path = usePath();
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pending = (list ?? []).filter(isPending);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button ref={btn} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog"
        aria-label={pending.length ? `Approvals: ${pending.length} waiting for you` : 'Approvals: nothing waiting'} title="Approvals" className={className}>
        <Bell size={17} />
        {pending.length > 0 && <span key={pending.length} className="animate-pop absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-bad-solid px-1 text-[10.5px] font-semibold text-white ring-2 ring-bg">{pending.length}</span>}
      </button>
      {open && <BellPanel me={me} pending={pending} reload={reload} />}
    </div>
  );
}

// opened only when needed, so the names it shows are fetched only then
function BellPanel({ me, pending, reload }: { me: Me; pending: any[]; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; title: string; ok: boolean }[]>([]);
  const names = useNames();
  const canDecide = ['owner', 'admin', 'developer'].includes(me.role);
  const decide = async (a: any, approve: boolean) => {
    setBusy(a.id);
    if (await decideOne(a.id, approve)) setDone((d) => [...d, { id: a.id, title: approvalWords(a, nameIn(a, names)).title, ok: approve }]);
    setBusy(null);
    reload();
  };
  const shown = pending.filter((a) => !done.some((d) => d.id === a.id));
  return (
    <div role="dialog" aria-label="Waiting for your OK" className="animate-pop absolute right-0 top-full z-40 mt-2 w-[360px] max-w-[calc(100vw-24px)] origin-top-right overflow-hidden rounded-[24px] border border-line bg-surface shadow-float max-sm:fixed max-sm:inset-x-3 max-sm:top-[76px] max-sm:mt-0 max-sm:w-auto">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p className="text-[14.5px] font-medium">{pending.length ? `${pending.length} waiting for you` : 'Nothing waiting'}</p>
        <button type="button" onClick={() => navigate('/approvals')} className="inline-flex items-center gap-1 rounded-full text-[12.5px] font-medium text-blue-text hover:underline">See all<ArrowRight size={13} /></button>
      </div>
      <div className="max-h-[60vh] divide-y divide-line overflow-y-auto">
        {done.map((d) => (
          <p key={d.id} className="approve-fold flex items-center gap-2.5 px-4 py-3 text-[13px] text-muted [--fold:44px]">
            <StatusMark state={d.ok ? 'ok' : 'off'} size={22} solid={d.ok} label={d.ok ? 'Approved' : 'Not now'} />
            <span className="min-w-0 flex-1 truncate">{d.ok ? 'Approved' : 'Not now'}: {d.title}</span>
          </p>
        ))}
        {!shown.length && !done.length && (
          <p className="flex items-center gap-2.5 px-4 py-5 text-[13.5px] text-muted"><StatusMark state="ok" size={22} label="All clear" />Nothing needs your OK right now.</p>
        )}
        {shown.slice(0, 4).map((a) => {
          const w = approvalWords(a, nameIn(a, names));
          return (
            <div key={a.id} className="px-4 py-3.5">
              <p className="text-[14px] font-medium leading-snug text-ink">{w.title}</p>
              <p className="mt-0.5 truncate text-[12px] text-muted">{whoWords(a.actor)} · {a.environment ?? 'Whole account'} · {timeAgo(a.created_at)}</p>
              <ExplainBlock compact className="mt-2" e={{ ...explainOf(a, w, changeWords(a.tool, a.input, nameIn(a, names))), what: '', advanced: w.raw || undefined }} labels={APPROVAL_LABELS} />
              <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
                {!canDecide ? <Badge tone="warn">An admin decides this</Badge>
                  : <>{hard(a) && <Badge tone="warn" className="mr-auto">Hard to undo</Badge>}
                    {/* the same choice row as everywhere: Approve when it's safe; a hard one is reviewed on Approvals (its name gets typed there) */}
                    <Choices label="Your OK" disabled={!!busy} choices={approvalChoices({ tier: a.tier, hard: hard(a) }).filter((c) => !(hard(a) && c.key === 'approve'))}
                      onPick={(c) => (c.key === 'approve' ? (void decide(a, true), true) : c.key === 'reject' ? (void decide(a, false), true) : false)} />
                  </>}
              </div>
            </div>
          );
        })}
        {shown.length > 4 && <button type="button" onClick={() => navigate('/approvals')} className="block w-full px-4 py-3 text-left text-[13px] font-medium text-blue-text hover:bg-raised">{shown.length - 4} more on Approvals</button>}
      </div>
    </div>
  );
}
