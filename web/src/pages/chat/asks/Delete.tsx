// "Delete harbor?" in the chat: an AI never deletes, so asked to, it shows this card. What goes and what stays (Unit7's
// own impact, as three counts), then the choices in order: delete (stopping production first when it runs), archive
// instead (recommended when it looks used), just stop it, not now. The person's click runs it as them, in the same
// guided pop-up as the project page (typed name, hold to confirm); the AI only hears what they did.
import { useEffect, useState } from 'react';
import { ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { runTool } from '../../../lib/api';
import { act, cx } from '../../../ui';
import type { Choice } from '../../../lib/choices';
import { Choices } from '../../choices';
import { DeleteDialog, useArchived, type Impact } from '../../lifecycle';
import { AskFrame, type KindProps } from './kit';

export function DeleteAsk({ spec, askId, busy, error, send }: KindProps<'delete'>) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [open, setOpen] = useState(false);
  const { toggle } = useArchived();
  useEffect(() => { void runTool('asset.impact', { key: spec.key }).then((r) => { if (r.status === 'ok') setImpact(r.output as Impact); }).catch(() => {}); }, [spec.key]);
  const item = { key: spec.key, name: spec.name, kind: spec.itemKind, provider: spec.provider };
  const archive = spec.recommend === 'archive';
  const choices: Choice[] = [
    ...(spec.can ? [{ key: 'delete', label: spec.live ? `Delete ${spec.name}: stop production, then delete` : `Delete ${spec.name}`, recommended: !archive,
      why: spec.live ? 'it goes step by step: production stops first, and you type its name before anything is deleted' : 'you see what goes and type its name first' }] : []),
    { key: 'archive', label: 'Archive instead', recommended: archive || !spec.can, why: archive ? 'it looks used: it keeps running and Unit7 stops watching it' : 'it keeps everything; you can bring it back any time' },
    ...(spec.stops ? [{ key: 'stop', label: 'Just stop it', why: 'it goes offline; nothing is deleted' }] : []),
    { key: 'later', label: 'Not now', why: 'nothing changes' },
  ];
  const pick = async (c: Choice) => {
    if (c.key === 'delete') setOpen(true);
    else if (c.key === 'archive') { if (await toggle(item, true)) send({ outcome: 'archived' }, 'Archived instead'); }
    else if (c.key === 'stop') {
      let ok = true;
      for (const s of impact?.can.stop ?? []) ok = !!(await act(s.tool, s.input, { success: s.label.replace(/^Stop /, 'Stopped ').replace(/^Pause /, 'Paused '), undo: false })) && ok;
      if (ok) send({ outcome: 'stopped' }, 'Stopped it');
    } else send({ cancelled: true }, 'Not now');
    return true;
  };
  const counts = impact && [
    { n: impact.breaks.length, label: 'stop working', icon: <TriangleAlert size={13} />, tone: impact.breaks.length ? 'text-bad' : 'text-muted' },
    { n: impact.deletes.length, label: 'deleted', icon: <Trash2 size={13} />, tone: 'text-ink-2' },
    { n: impact.stays.length, label: 'stay', icon: <ShieldCheck size={13} />, tone: 'text-ok' },
  ];
  return (
    <AskFrame icon={<Trash2 size={17} />} tone="bad" title={spec.title} titleId={`${askId}-t`}
      note={spec.note ?? (spec.live ? 'Production is live, so Unit7 stops it first, then deletes. You see exactly what goes before anything happens.' : 'You see exactly what goes and what stays before anything happens.')}>
      {counts ? (
        <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="What it affects">
          {counts.map((c) => <li key={c.label} className={cx('inline-flex h-7 items-center gap-1.5 rounded-full bg-raised px-2.5 text-[12px] font-medium', c.tone)}>{c.icon}<span className="tabular">{c.n}</span> {c.label}</li>)}
        </ul>
      ) : <span aria-hidden className="skeleton mb-3 block h-7 w-2/3" />}
      <Choices id={askId} label={`What to do with ${spec.name}`} choices={choices} onPick={pick} disabled={busy} />
      {error && <p role="alert" className="mt-2 text-[12.5px] text-bad">{error}</p>}
      <DeleteDialog item={item} open={open} onClose={() => setOpen(false)}
        onDeleted={() => send({ outcome: 'deleted' }, 'Deleted')} onArchived={() => send({ outcome: 'archived' }, 'Archived instead')} />
    </AskFrame>
  );
}
