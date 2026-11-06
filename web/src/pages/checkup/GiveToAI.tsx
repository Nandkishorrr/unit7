// Give this to my AI: two choices only, what and where. The prompt is shown before it leaves, with how much was hidden, and a
// link only ever fills the box: the person presses send. Afterwards Unit7 watches the next deploy and says whether it worked.
import { useEffect, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { runTool } from '../../lib/api';
import { Badge, Button, Modal, Skeleton, Tabs, cx, toast } from '../../ui';

type What = 'fix' | 'explain' | 'evidence' | 'ticket';
type Where = 'copy' | 'cursor' | 'claude-code' | 'claude-web' | 'codex' | 'lovable';
interface Prompt { id: string; status: string; text: string; hidden: string; chars: number; links: Partial<Record<Where, string>>; last?: Where; subject?: string; repo?: string }
const WHAT: { id: What; label: string }[] = [{ id: 'fix', label: 'Fix it' }, { id: 'explain', label: 'Explain it' }, { id: 'evidence', label: 'Just the evidence' }];
const WHERE: { id: Where; label: string }[] = [{ id: 'cursor', label: 'Cursor' }, { id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }, { id: 'lovable', label: 'Lovable' }, { id: 'claude-web', label: 'Claude on the web' }];
const PASTE: Record<Where, string> = { copy: 'Paste it into your AI.', cursor: 'It’s waiting in Cursor.', 'claude-code': 'It’s waiting in Claude Code.', 'claude-web': 'It’s waiting in Claude.', codex: 'It’s waiting in Codex.', lovable: 'It’s waiting in Lovable.' };

export const STATUS_TONE: Record<string, 'neutral' | 'info' | 'ok' | 'warn' | 'bad'> = { open: 'neutral', sent: 'info', watching: 'info', fixed: 'ok', still: 'warn', thin: 'neutral', back: 'bad', 'on-purpose': 'neutral' };

export function GiveToAI({ open, onClose, refId, title, start = 'fix', onSent }: { open: boolean; onClose: () => void; refId: string; title: string; start?: What; onSent?: () => void }) {
  const [what, setWhat] = useState<What>(start);
  const [p, setP] = useState<Prompt>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    setP(undefined); setErr(undefined);
    void runTool('finding.prompt', { ref: refId, what }).then((r) => { if (!live) return; if (r.status === 'ok') setP(r.output as Prompt); else setErr(r.status === 'error' ? r.error.message : 'Unit7 couldn’t write the prompt.'); });
    return () => { live = false; };
  }, [open, refId, what]);
  const sent = async (where: Where) => {
    await runTool('finding.sent', { ref: refId, where, ...(p?.repo && { repo: p.repo }) });
    toast('ok', PASTE[where], 'I’ll check after your next deploy.');
    onSent?.(); onClose();
  };
  const copy = async () => { if (p) { await navigator.clipboard.writeText(p.subject ? `${p.subject}\n\n${p.text}` : p.text); if (what === 'ticket') { toast('ok', 'Copied', 'Send it to their support.'); onClose(); } else void sent('copy'); } };
  const ticket = what === 'ticket';
  return (
    <Modal open={open} onClose={onClose} title={ticket ? 'Write my support ticket' : 'Give this to my AI'} size="lg">
      <div className="space-y-4">
        <p className="text-[13.5px] text-ink-2">{title}</p>
        {!ticket && <Tabs value={what} onChange={setWhat} tabs={WHAT.map((w) => ({ value: w.id, label: w.label }))} />}
        {err && <p className="rounded-[12px] bg-bad/10 px-3 py-2 text-[13px] text-bad">{err}</p>}
        {!p && !err && <Skeleton className="h-52 w-full" />}
        {p && (
          <>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-[14px] bg-sunken px-3.5 py-3 text-[12.5px] leading-[1.55] text-ink-2">{p.subject ? `${p.subject}\n\n` : ''}{p.text}</pre>
            {p.hidden && <p className="text-[12.5px] text-muted">Hidden before it leaves: {p.hidden}.</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={<Copy size={15} />} onClick={copy}>Copy</Button>
              {!ticket && WHERE.filter((w) => p.links[w.id]).sort((a, b) => Number(b.id === p.last) - Number(a.id === p.last)).map((w) => (
                <a key={w.id} href={p.links[w.id]} target="_blank" rel="noopener" onClick={() => void sent(w.id)} className={cx('inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 text-[13px] font-medium text-ink-2 transition hover:border-ink hover:text-ink', w.id === p.last && 'border-ink text-ink')}>{w.label}<ExternalLink size={13} aria-hidden /></a>
              ))}
            </div>
            {!ticket && <p className="text-[12.5px] text-muted">Links fill the box and never send. Unit7 doesn’t write your code: your AI does, and Unit7 checks production afterwards.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

export function StatusChip({ status, words }: { status: string; words: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{words}</Badge>;
}
