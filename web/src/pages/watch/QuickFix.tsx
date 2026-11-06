// One fix as one small button, for rows and tiles where the full fix (what changes, undo) would be too much: what it
// changes is in its tooltip, and the outcome replaces it in place. The pop-up shows the full fix with its undo.
// FixAction picks the button for any fix: run it, ask Unit7, or "Show me how" (the steps open in the pop-up).
import { useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, Undo2, Wand2 } from 'lucide-react';
import { runTool } from '../../lib/api';
import { A, act, AiButton, Button, cx, promptDialog } from '../../ui';
import { tidy } from '../../lib/words';
import { askOnHome } from '../Help';
import type { Fix } from '../security/SecurityCheck';
import { verifiedOf } from '../../lib/alertActions';
import { openCoolifyDomain } from '../servers/CoolifyDomain';

export type ToolFix = Extract<Fix, { tool: string }>;
export const isToolFix = (f?: Fix | null): f is ToolFix => !!f && 'tool' in f;
type Act = { tool: string; input: Record<string, unknown>; label: string };
type St = { s: 'busy' } | { s: 'done'; undo?: Act; next?: Act; checked?: boolean } | { s: 'undone' } | { s: 'wait' } | { s: 'no'; why: string };
// the typed name goes where the tool asks for it: Coolify's and the map's deletes say confirmName, server parts say confirm
export const confirmField = (tool: string) => (/^(coolify|asset)\.|^domain\.remove_record$/.test(tool) ? 'confirmName' : 'confirm');

async function run(a: Act): Promise<St> {
  try {
    const r = await runTool(a.tool, a.input);
    if (r.status === 'ok') {
      const o = r.output as { changed?: boolean; why?: string; undo?: Act; changeId?: string; next?: Act } | undefined;
      // a change its health check put back didn't happen
      if (o?.changed === false) return { s: 'no', why: o.why ?? 'It didn’t take, so Unit7 put it back as it was.' };
      // Unit7 looked again at what it touched: still there is said plainly, never "Done"
      const v = verifiedOf(o);
      if (v && !v.fixed) return { s: 'no', why: `Still there: ${v.still ?? 'the check still sees it'}` };
      // next: the step a fix suggests after it (a Coolify health check: "Deploy again to test it")
      return { s: 'done', checked: !!v, ...(o?.next && typeof o.next === 'object' && typeof o.next.tool === 'string' && { next: o.next }), undo: o?.undo && typeof o.undo === 'object' ? o.undo : o?.changeId ? { tool: 'change.undo', input: { changeId: o.changeId }, label: 'Undo' } : undefined };
    }
    return r.status === 'approval_required' ? { s: 'wait' } : { s: 'no', why: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'That didn’t run.' };
  } catch (e) { return { s: 'no', why: (e as Error).message }; }
}

export function QuickFix({ fix, strong, onDone, className }: { fix: ToolFix; strong?: boolean; onDone?: () => void; className?: string }) {
  const [st, setSt] = useState<St | null>(null);
  const go = async () => {
    let input = fix.input;
    // hard to undo: the person types the name first, as in the full fix
    if (fix.typeName) {
      const typed = await promptDialog({ title: `${fix.label}?`, label: `Type ${fix.typeName} to confirm`, placeholder: fix.typeName, hint: fix.change, confirm: fix.label,
        warn: (v) => (v && v.toLowerCase() !== fix.typeName!.toLowerCase() ? 'That isn’t the name.' : undefined) });
      if (!typed || typed.toLowerCase() !== fix.typeName.toLowerCase()) return;
      input = { ...fix.input, [confirmField(fix.tool)]: typed };
    }
    setSt({ s: 'busy' });
    const r = await run({ ...fix, input });
    setSt(r);
    if (r.s === 'done') onDone?.();
  };
  const undo = async (a: Act) => { setSt({ s: 'busy' }); const r = await run(a); setSt(r.s === 'done' ? { s: 'undone' } : r); if (r.s === 'done') onDone?.(); };
  if (st?.s === 'done') return (
    <span role="status" className={cx('relative z-10 inline-flex h-8 items-center gap-2 text-[12.5px] animate-pop', className)}>
      <span className="inline-flex items-center gap-1.5 font-medium text-ok"><Check size={14} strokeWidth={3} />{st.checked ? 'Fixed and checked' : 'Done'}</span>
      {st.undo && <button type="button" onClick={(e) => { e.stopPropagation(); void undo(st.undo!); }} className="inline-flex items-center gap-1 rounded-full px-1.5 font-medium text-muted hover:text-ink"><Undo2 size={12} />{st.undo.label}</button>}
      {st.next && <Button size="sm" variant="soft" onClick={(e) => { e.stopPropagation(); void act(st.next!.tool, st.next!.input, { success: 'Done', undo: false }); }}>{st.next.label}</Button>}
    </span>
  );
  if (st?.s === 'undone') return <span role="status" className={cx('relative z-10 inline-flex h-8 items-center text-[12.5px] text-muted', className)}>Put back the way it was</span>;
  if (st?.s === 'wait') return <A href="/approvals" className={cx('relative z-10 inline-flex h-8 items-center gap-1 text-[12.5px] font-medium text-warn hover:underline', className)}>Waiting for your OK<ArrowUpRight size={12} /></A>;
  return (
    <span className={cx('relative z-10 inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1', className)}>
      <Button size="sm" variant={strong ? 'primary' : 'dark'} loading={st?.s === 'busy'} icon={<Wand2 size={13} />} title={tidy(fix.change)} onClick={(e) => { e.stopPropagation(); void go(); }}>{fix.label}</Button>
      {st?.s === 'no' && <span role="alert" className="min-w-0 text-[12px] text-bad">{tidy(st.why)}</span>}
    </span>
  );
}

// the one button a finding gets in a short list
export function FixAction({ fix, strong, onDetails, onDone, className }: { fix?: Fix; strong?: boolean; onDetails: () => void; onDone?: () => void; className?: string }) {
  if (isToolFix(fix)) return <QuickFix fix={fix} strong={strong} onDone={onDone} className={className} />;
  if (fix && 'flow' in fix && fix.flow) return <Button size="sm" variant={strong ? 'primary' : 'dark'} className={cx('relative z-10', className)} icon={<Wand2 size={13} />} onClick={(e) => { e.stopPropagation(); openCoolifyDomain(fix.flow!.serverId); }}>{fix.label ?? 'Show me'}</Button>;
  if (fix?.ask) return <AiButton size="sm" className={cx('relative z-10', className)} onClick={(e) => { e.stopPropagation(); askOnHome(fix.ask!, { send: true }); }}>{fix.label ?? 'Ask Unit7'}</AiButton>;
  return (
    <Button size="sm" variant="soft" className={cx('relative z-10', className)} icon={<ChevronRight size={13} />} onClick={(e) => { e.stopPropagation(); onDetails(); }}>
      {fix ? 'Show me how' : 'Show me'}
    </Button>
  );
}

// the same run for the shared choice row (pages/choices): changed or not, verified or still there, its undo
export { run as runAct, type St as ActResult };
