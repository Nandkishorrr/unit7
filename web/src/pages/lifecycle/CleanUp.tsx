// "Clean up": what looks abandoned (no deploy in 90+ days, no visitors, no domain…), each with why, and three answers:
// Keep it (it's in use, with an optional Important star), Archive, or Delete. Keep it folds the row away with "Got it"
// and an Undo. Quick to go through, but every delete is still its own pop-up with what it affects and the typed name.
import { useEffect, useRef, useState } from 'react';
import { Archive, Check, ChevronRight, CircleCheck, Star, Trash2 } from 'lucide-react';
import { runTool } from '../../lib/api';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { Button, cx, HoverCard, Illustration, Modal, toast, StatusMark } from '../../ui';
import { DeleteDialog, placeWords, useArchived, type LifecycleItem } from './Lifecycle';
import { useInUse } from './InUse';

interface Candidate { key: string; name: string; kind: string; provider: string; account?: string; reasons: string[]; why?: string }
interface Kept { important: boolean; undo?: { tool: string; input: Record<string, unknown> } }
interface Left { key: string; name: string; provider: string; why: string }

export function CleanUp({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<LifecycleItem | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [kept, setKept] = useState<Map<string, Kept>>(new Map());
  const [left, setLeft] = useState<Left[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const { toggle } = useArchived();
  const { reload: reloadInUse } = useInUse();
  useEffect(() => {
    if (!open) return;
    setItems(null); setError(undefined); setLeaving(new Set()); setKept(new Map());
    runTool('asset.cleanup').then((r) => {
      if (r.status !== 'ok') return setError(r.status === 'error' ? r.error.message : 'Unit7 couldn’t look.');
      const o = r.output as { items: Candidate[]; left?: Left[] };
      setItems(o.items); setLeft(o.left ?? []);
    }).catch((e: Error) => setError(e.message));
  }, [open]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  // a row slides out, then leaves the list
  const done = (key: string) => {
    setLeaving((s) => new Set(s).add(key));
    setTimeout(() => setItems((xs) => xs?.filter((x) => x.key !== key) ?? null), 260);
    onChanged?.();
  };
  // "It's in use": the row folds into "Got it" for a few seconds (with Undo), then leaves
  const keepIt = async (c: Candidate, important: boolean) => {
    setBusy(c.key);
    const r = await runTool('asset.keep', { key: c.key, important }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setBusy(null);
    if (r.status !== 'ok') { toast(r.status === 'approval_required' ? 'warn' : 'bad', r.status === 'approval_required' ? 'Waiting for approval' : 'That didn’t work', r.status === 'error' ? r.error.message : 'why' in r ? r.why : undefined); return; }
    setKept((m) => new Map(m).set(c.key, { important, undo: (r.output as { undo?: Kept['undo'] }).undo }));
    void reloadInUse();
    timers.current.set(c.key, setTimeout(() => done(c.key), 4500));
  };
  const undoKeep = async (c: Candidate) => {
    clearTimeout(timers.current.get(c.key));
    const u = kept.get(c.key)?.undo ?? { tool: 'asset.keep', input: { key: c.key, kept: false } };
    const r = await runTool(u.tool, u.input).catch(() => undefined);
    if (r?.status !== 'ok') { toast('bad', 'Couldn’t undo that', r?.status === 'error' ? r.error.message : undefined, { action: { label: 'Try again', onClick: () => undoKeep(c) } }); return; }
    setKept((m) => { const n = new Map(m); n.delete(c.key); return n; });
    void reloadInUse();
  };
  const item = (c: Candidate): LifecycleItem => ({ key: c.key, name: c.name, kind: c.kind, provider: c.provider, ...(c.key.startsWith('prj_') && { projectId: c.key }) });
  return (
    <>
      <Modal open={open && !deleting} onClose={onClose} title="Clean up" size="lg">
        <p className="-mt-1 mb-4 text-[13.5px] text-muted">These look like things nobody uses any more. If one is in use (an API other servers call, a worker), say so and Unit7 won’t suggest it again. Otherwise archive it (Unit7 stops watching it, it keeps running) or delete it, one at a time.</p>
        {error && <p role="alert" className="rounded-[16px] bg-bad/8 px-4 py-3 text-[13px]">{error}</p>}
        {!items && !error && <div className="space-y-2" aria-busy="true" aria-label="Looking for unused things">{[0, 1, 2].map((n) => <span key={n} className="skeleton block h-[72px] rounded-[18px]" />)}</div>}
        {items?.length === 0 && (
          <div className="illo-host flex flex-col items-center py-8 text-center">
            <Illustration name="cleanup" size={104} className="animate-pop" />
            <p className="mt-3 text-[15px] font-semibold">Nothing looks abandoned</p>
            <p className="mt-1 text-[13px] text-muted">Everything has visitors, apps that use it, a domain, or a recent deploy.</p>
          </div>
        )}
        {!!items?.length && (
          <ul className="stagger space-y-2">
            {items.map((c) => {
              const k = kept.get(c.key);
              return (
                <li key={c.key} className={cx('flex flex-wrap items-center gap-3 rounded-[18px] border p-3 transition-[opacity,transform,background-color,border-color] duration-200', k ? 'border-ok/25 bg-ok/[0.06]' : 'border-line', leaving.has(c.key) && 'translate-x-4 opacity-0')}>
                  {k ? (
                    <div role="status" className="flex w-full min-w-0 animate-[fade_0.25s_ease-out] items-center gap-3">
                      <StatusMark state="ok" size={32} solid label="Kept" />
                      <p className="min-w-0 flex-1 text-[13.5px] text-ink-2"><span className="font-semibold text-ink">Got it:</span> Unit7 won’t suggest {c.name} again{k.important ? ', and takes extra care with it' : ''}.</p>
                      <Button size="sm" variant="ghost" onClick={() => void undoKeep(c)}>Undo</Button>
                    </div>
                  ) : (
                    <>
                      <span className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-raised"><BrandLogo id={c.provider} size={20} /></span>
                      <span className="min-w-0 flex-1 basis-[12rem]">
                        <span className="block truncate text-[14px] font-semibold">{c.name}</span>
                        <span className="block truncate text-[12px] text-muted">{c.provider === 'unmanaged' ? `Running on its own${c.account ? ` on ${c.account}` : ''}` : placeWords(providerName(c.provider), c.account)}</span>
                        {/* why it's listed, in one line; the separate signs on hover */}
                        <HoverCard content={<ul className="w-[min(260px,calc(100vw-48px))] space-y-1 text-[12.5px] text-ink-2">{c.reasons.map((r) => <li key={r} className="flex gap-2"><span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-line-strong" />{r}</li>)}</ul>}>
                          <span tabIndex={0} className="mt-0.5 block rounded text-[12px] leading-snug text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-blue">{c.why ?? c.reasons.join(' · ')}</span>
                        </HoverCard>
                      </span>
                      <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                        {/* the third answer: it's in use. One click keeps it; the star keeps it as important */}
                        <span className="inline-flex h-8 items-stretch overflow-hidden rounded-full border border-ok/30 bg-ok/[0.07] text-ok">
                          <button type="button" disabled={busy === c.key} onClick={() => void keepIt(c, false)} aria-label={`It’s in use: keep ${c.name}`} title="It’s in use: Unit7 won’t suggest it again"
                            className="inline-flex items-center gap-1.5 pl-3 pr-2.5 text-[12.5px] font-medium outline-none transition hover:bg-ok/12 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue disabled:opacity-60">
                            <Check size={13} strokeWidth={2.6} aria-hidden />Keep it
                          </button>
                          <button type="button" disabled={busy === c.key} onClick={() => void keepIt(c, true)} aria-label={`Keep ${c.name} and mark it important`} title="Keep it and mark it important"
                            className="group/star grid w-8 place-items-center border-l border-ok/25 text-warn outline-none transition hover:bg-warn/12 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue disabled:opacity-60">
                            <Star size={13} strokeWidth={2.4} className="transition group-hover/star:fill-current" aria-hidden />
                          </button>
                        </span>
                        <Button size="sm" variant="secondary" icon={<Archive size={13} />} onClick={async () => { if (await toggle(item(c), true)) done(c.key); }}>Archive</Button>
                        <Button size="sm" variant="ghost" className="text-bad hover:bg-bad/8" icon={<Trash2 size={13} />} onClick={() => setDeleting(item(c))}>Delete…</Button>
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {/* what looks quiet by visitors alone but is in use: left out, and why (an API other servers call…) */}
        {items && left.length > 0 && (
          <details className="group mt-4 rounded-[18px] border border-dashed border-line-strong px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-blue [&::-webkit-details-marker]:hidden">
              <ChevronRight size={15} className="shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden />
              <CircleCheck size={15} className="shrink-0 text-ok" aria-hidden />
              <span><span className="font-medium text-ink">{left.length} more look quiet but are in use</span>, so they’re left out</span>
            </summary>
            <ul className="mt-2.5 space-y-2 pl-6">
              {left.map((x) => (
                <li key={x.key} className="flex min-w-0 items-start gap-2.5 text-[12.5px]">
                  <span className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={x.provider} size={13} /></span>
                  <span className="min-w-0"><span className="font-medium text-ink">{x.name}</span><span className="block text-muted">{x.why}</span></span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Modal>
      {deleting && <DeleteDialog item={deleting} open onClose={() => setDeleting(null)} onDeleted={() => done(deleting.key)} />}
    </>
  );
}
