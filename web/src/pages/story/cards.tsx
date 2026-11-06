// The story's results as Home chat cards: what changed (the newest lines, Undo inline, the culprit on top when the AI
// asked "since it last worked"), a failure's replay (the cause over the strip), and the morning brief.
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Clapperboard, History, Sunrise } from 'lucide-react';
import { rawWords } from '../../lib/words';
import { Frame, Fold } from '../chat/cards/kit';
import { hhmm, type BriefOut, type Item, type StoryOut, type TimelineOut } from './shape';
import { ItemModal, Line, undoItem } from './Timeline';
import { ReplayBody } from './ReplayCard';
import { MorningBrief } from './MorningBrief';

const hrefOf = (input: any) => (input?.serverId ? `/changes?server=${input.serverId}` : input?.serviceId ? `/changes?service=${input.serviceId}` : input?.projectId ? `/changes?project=${input.projectId}` : '/changes');

export function TimelineChatCard({ input, output: o }: { input: any; output: TimelineOut }) {
  const [open, setOpen] = useState<Item | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const culprit = o.items.find((x) => x.id === o.culpritId);
  const rest = o.items.filter((x) => x.id !== o.culpritId);
  const h = o.health;
  const undo = (it: Item) => void undoItem(it, () => { setOpen(null); setGone((g) => new Set(g).add(it.id)); });
  const strip = (it: Item): Item => (gone.has(it.id) ? { ...it, undo: undefined, status: 'undone' } : it);
  return (
    <Frame icon={<History size={16} />} tone={h?.state === 'failing' ? 'bad' : 'soft'} title={o.mode === 'since-healthy' ? 'Since it last worked' : 'What changed'} count={o.items.length}
      sub={`${o.scope.label}${o.mode === 'since-healthy' && h?.healthyAt ? ` · after ${hhmm(h.healthyAt)}` : ''}`} href={hrefOf(input)} hrefLabel="Open the whole timeline">
      {h?.state === 'failing' && h.failingSince && (
        <p className="mb-2.5 flex items-start gap-2 rounded-[14px] bg-bad/[0.07] px-3 py-2 text-[12.5px]"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-bad" />Not working since {hhmm(h.failingSince)}{h.what ? `: ${rawWords(h.what)}` : ''}.</p>
      )}
      {h?.state === 'ok' && !h.failingSince && <p className="mb-2.5 flex items-center gap-2 text-[12.5px] text-muted"><CheckCircle2 size={14} className="text-ok" />Everything works; nothing failed lately.</p>}
      {culprit && <ul className="mb-1.5"><Line it={strip(culprit)} compact onOpen={setOpen} onUndo={undo} /></ul>}
      {rest.length ? (
        <Fold items={rest} max={5} className="space-y-0.5">{(it) => <Line key={it.id} it={strip(it)} compact onOpen={setOpen} onUndo={undo} />}</Fold>
      ) : !culprit && <p className="text-[13px] text-muted">Nothing changed in that time.</p>}
      <ItemModal it={open} onClose={() => setOpen(null)} onUndo={undo} />
    </Frame>
  );
}

export function ReplayChatCard({ output: s }: { output: StoryOut }) {
  return (
    <Frame icon={<Clapperboard size={16} />} tone="dark" title={rawWords(s.title)} sub={`${s.scope.label} · ${hhmm(s.from)} to ${hhmm(s.to)}`}>
      <ReplayBody s={s} compact />
    </Frame>
  );
}

export function BriefChatCard({ output }: { output: BriefOut }) {
  return output.lines.length ? <MorningBrief brief={output} className="w-full animate-rise" /> : (
    <Frame icon={<Sunrise size={16} />} tone="lime" title="Morning brief"><p className="text-[13px] text-muted">Nothing to brief about yet.</p></Frame>
  );
}
