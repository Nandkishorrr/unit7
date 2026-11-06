// "Remove this DNS record": a centred pop-up that first asks Unit7 what removing it does (a dry run of
// domain.remove_record: what answers now, what stops working, a takeover risk it clears), then a typed name and a hold to
// confirm. Email records need a person to tick "email may stop"; NS and SOA at the bare domain are refused by Unit7.
// The Map's "Remove" mounts it.
import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { runTool } from '../../lib/api';
import { tidy } from '../../lib/words';
import { HoldButton, Input, Modal, cx, toast } from '../../ui';

export interface DnsRecordRef { name: string; type: string; value?: string; domain?: string; zone?: string; accountId?: string }
interface Preview { name: string; zone: string; at: string; type: string; willDelete: string[]; stays: string[]; answersNow: string[]; stops: string[]; email: boolean; takeoverCleared: boolean; confirm: string; nothing: boolean }

export function RemoveRecordDialog({ record, open, onClose, onRemoved }: { record: DnsRecordRef; open: boolean; onClose: () => void; onRemoved?: (out: { removed: string[]; changeId: string }) => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [email, setEmail] = useState(false);
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  const input = { ...(record.domain && { domain: record.domain }), ...(record.zone && { zone: record.zone }), name: record.name, type: record.type, ...(record.value && { value: record.value }), ...(record.accountId && { accountId: record.accountId }) };
  useEffect(() => {
    if (!open) return;
    let live = true;
    setP(null); setErr(null); setTyped(''); setEmail(false); setState({});
    runTool('domain.remove_record', input, { dryRun: true }).then((r) => {
      if (!live) return;
      if (r.status === 'dry_run') setP(r.plan as Preview);
      else setErr(r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'Couldn’t read that record.');
    }, (e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [open, record.name, record.type, record.value, record.zone, record.domain]);
  const mx = record.type.toUpperCase() === 'MX';
  const ready = !!p && !p.nothing && typed.trim().toLowerCase().replace(/\.$/, '') === p.confirm && (!mx || email) && !state.busy;
  const go = async () => {
    setState({ busy: true });
    const r = await runTool('domain.remove_record', { ...input, confirmName: typed.trim(), ...(mx && { breakEmail: true }) }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    if (r.status === 'ok') {
      const out = r.output as { removed: string[]; changeId: string };
      setState({}); onClose();
      toast('ok', 'Record removed', 'Undo in Activity puts it back.', { action: { label: 'Undo', onClick: () => runTool('change.undo', { changeId: out.changeId }) } });
      onRemoved?.(out);
      return;
    }
    setState({ error: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? `Waiting for approval: ${r.why}` : 'That didn’t work.' });
  };
  return (
    <Modal open={open} onClose={onClose} title={`Remove the ${record.type.toUpperCase()} record for ${p?.name ?? record.name}?`} size="md">
      <div className="space-y-4">
        {!p && !err && <div className="space-y-3" aria-busy="true" aria-label="Asking what it affects"><span className="skeleton block h-6 w-1/2" /><span className="skeleton block h-24" /></div>}
        {err && <p role="alert" className="rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink-2">{tidy(err)}</p>}
        {p && (
          <>
            <p className="text-[13px] text-muted">At {p.at}{p.answersNow.length ? <> · answering now: <span className="font-mono text-[12px] text-ink-2">{p.answersNow.slice(0, 3).join(', ')}</span></> : ' · nothing answers for it right now'}</p>
            {p.nothing ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">There’s no such record there anymore.</p> : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Col title="Will stop working" tone="bad" icon={<TriangleAlert size={14} />} items={p.stops} empty="Nothing Unit7 knows of uses it." />
                <Col title="Will be removed" tone="bad" icon={<Trash2 size={14} />} items={p.willDelete} mono />
              </div>
            )}
            {p.takeoverCleared && <p className="flex items-start gap-2 rounded-[16px] bg-ok/10 px-4 py-3 text-[13px] text-ink"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-ok" aria-hidden />It points at an app that’s gone. Removing it means nobody can take this name over.</p>}
            {p.stays.length > 0 && <p className="text-[12.5px] text-muted">Stays: <span className="font-mono text-[12px]">{p.stays.join(', ')}</span></p>}
            {!p.nothing && (
              <form onSubmit={(e) => e.preventDefault()} className="space-y-3 border-t border-line pt-4">
                {mx && (
                  <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                    <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} className="mt-0.5 size-4 accent-[var(--bad-solid)]" />
                    <span><span className="font-medium">Yes, email to {p.name} may stop arriving</span><span className="block text-muted">Only a person can remove email records.</span></span>
                  </label>
                )}
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium">Type <span className="font-semibold">{p.confirm}</span> to confirm</span>
                  <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={p.confirm} autoComplete="off" spellCheck={false} />
                </label>
                {state.error && <p role="alert" className="flex gap-2 rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink-2"><X size={15} className="mt-0.5 shrink-0 text-bad" />{tidy(state.error)}</p>}
                <div className="flex justify-end"><HoldButton icon={state.busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} disabled={!ready} onConfirm={go}>Remove the record</HoldButton></div>
                <p className="text-[12px] text-faint">Undo in Activity puts it back exactly.</p>
              </form>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function Col({ title, icon, tone, items, empty, mono }: { title: string; icon: React.ReactNode; tone: 'bad' | 'ok'; items: string[]; empty?: string; mono?: boolean }) {
  return (
    <div className="rounded-[16px] border border-line p-3">
      <p className={cx('flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.05em]', tone === 'bad' ? 'text-bad' : 'text-ok')}>{icon}{title}</p>
      {items.length ? <ul className="mt-1.5 space-y-1">{items.map((x) => <li key={x} className={cx('text-[13px] text-ink-2', mono && 'break-all font-mono text-[12px]')}>{x}</li>)}</ul>
        : <p className="mt-1.5 text-[13px] text-muted">{empty}</p>}
    </div>
  );
}
