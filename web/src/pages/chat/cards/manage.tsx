// Changing what a server's X-ray found, in the chat: the outcome of a restart, stop, settings change, update,
// cap or removal (healthy, or put back by its health check) with Undo right there; a command's output and its
// logs as read-only text; "What happens if…" before doing it; and the list of changes that can be undone.
import { useState } from 'react';
import { Gauge, History, RotateCw, ScrollText, ShieldCheck, Terminal as TermIcon, Trash2, Undo2, Wrench, X } from 'lucide-react';
import { Badge, Button, cx, timeAgo } from '../../../ui';
import { rawWords } from '../../../lib/words';
import { DarkCard, Terminal } from '../../kit';
import { Fold, Frame, Outcome, Pill, Sure, call, said } from './kit';

const serverHref = (id?: string) => (id ? `/servers/${id}` : '/servers');
type Out = Record<string, any>;

// Undo, asked once, right where the change shows
function UndoButton({ changeId, what, asked, onCancel }: { changeId: string; what: string; asked?: boolean; onCancel?: () => void }) {
  const [sure, setSure] = useState(!!asked);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ReturnType<typeof said> | null>(null);
  const go = async () => { setBusy(true); const r = await call('change.undo', { changeId }); setBusy(false); setSure(false); setNote(said(r, 'Taken back. It’s as it was before.')); };
  if (note) return <Outcome tone={note.tone} step={note.step}>{rawWords(note.text)}</Outcome>;
  return sure ? <Sure text={`This takes back: ${what}.`} yes="Undo" onYes={go} onNo={() => (asked ? onCancel?.() : setSure(false))} busy={busy} />
    : <Button size="sm" variant="soft" icon={<Undo2 size={14} />} onClick={() => setSure(true)} className="mt-3">Undo</Button>;
}

const VERB: Record<string, [string, typeof RotateCw]> = {
  'part.restart': ['Restarted', RotateCw], 'part.start': ['Started', RotateCw], 'part.stop': ['Stopped', RotateCw], 'part.env': ['Setting changed', Wrench],
  'part.update': ['Updated', RotateCw], 'part.limits': ['Capped', Gauge], 'part.remove': ['Moved to the trash', Trash2], 'change.undo': ['Taken back', Undo2],
};
// part.restart / start / stop / env set / update / limits / remove, and change.undo
export function PartDoneCard({ tool, input, output: o }: { tool: string; input: any; output: Out }) {
  const [word, Icon] = VERB[tool] ?? ['Done', Wrench];
  const name = o.part ?? o.restarted ?? o.started ?? o.stopped ?? o.removed ?? input?.part ?? 'it';
  if (o.approvalRequired) return (
    <Frame icon={<ShieldCheck size={16} />} tone="blue" title="Waiting for your OK" sub="Coolify will do it once you approve" href="/approvals" hrefLabel="Open Approvals">
      <p className="text-[12.5px] text-ink-2">{rawWords(o.why ?? '')}</p>
    </Frame>
  );
  const back = o.rolledBack !== undefined && o.changed === false;
  const unhealthy = o.healthy === false && !back;
  const tone = back || unhealthy ? 'bad' : 'ok';
  const title = back ? `${name} wasn’t healthy after` : tool === 'change.undo' ? 'Taken back' : tool === 'part.env' ? `${input?.key ?? 'Setting'} changed for ${name}` : tool === 'part.limits' ? `${name} capped at ${o.capped}` : `${word} ${name}`;
  const sub = o.through === 'Coolify' ? 'Through Coolify, which stays in charge' : back ? 'Unit7 undid it by itself'
    : o.healthy ? 'Checked after: healthy' : tool === 'part.remove' ? 'Kept for 7 days, then emptied' : tool === 'change.undo' ? rawWords(o.undone ?? '') : undefined;
  return (
    <Frame icon={<Icon size={16} />} tone={tone === 'ok' ? 'ok' : 'bad'} title={title} sub={sub} href={serverHref(input?.serverId)} hrefLabel="Open the server page"
      right={<Pill tone={tone}>{back ? 'Put back' : unhealthy ? 'Not healthy' : 'Done'}</Pill>}>
      {(back || unhealthy) && <Outcome tone="bad">{rawWords(o.why ?? o.health ?? '')}</Outcome>}
      {o.note && <p className="text-[12.5px] text-muted">{rawWords(o.note)}</p>}
      {o.changeId && o.changed !== false && tool !== 'change.undo' && <UndoButton changeId={o.changeId} what={title} />}
    </Frame>
  );
}

// part.logs and part.run: text from the server, searchable, never instructions
export function PartTextCard({ tool, input, output: o }: { tool: string; input: any; output: Out }) {
  const [q, setQ] = useState('');
  const run = tool === 'part.run';
  const lines = (run ? `${o.stdout ?? ''}${o.stderr ? `\n${o.stderr}` : ''}`.split('\n').filter(Boolean) : (o.lines ?? []) as string[]).map(rawWords);
  const shown = q.trim() ? lines.filter((l) => l.toLowerCase().includes(q.trim().toLowerCase())) : lines.slice(-14);
  return (
    <DarkCard className="@container animate-rise w-full min-w-0 !p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-full bg-white/10">{run ? <TermIcon size={15} /> : <ScrollText size={15} />}</span>
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{run ? 'Command output' : 'Logs'}<span className="font-normal text-white/60"> · {o.part}{o.container && o.container !== o.part ? ` (${o.container})` : ''}</span></p>
        {run && <span className={cx('rounded-full px-2.5 py-0.5 text-[11.5px] font-medium', o.exitCode === 0 ? 'bg-lime text-lime-ink' : 'bg-[#ff8a80]/20 text-[#ffb4ab]')}>{o.timedOut ? 'Timed out' : o.exitCode === 0 ? 'Worked' : `Exit ${o.exitCode}`}</span>}
        <label className="relative"><span className="sr-only">Search the output</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 w-28 rounded-full bg-white/8 px-3 text-[12.5px] text-white outline-none transition-[width] placeholder:text-white/45 focus:w-44 focus-visible:ring-2 focus-visible:ring-lime" />
        </label>
        {q && <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="grid size-7 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"><X size={13} /></button>}
      </div>
      {run && <p className="mb-2 truncate font-mono text-[12px] text-white/70" title={input?.command}>$ {input?.command}</p>}
      <Terminal lines={shown} empty={q ? 'No line matches.' : run ? 'It printed nothing.' : 'Nothing logged yet.'} className="!max-h-[260px] !min-h-0" />
      <p className="mt-2 text-[11px] text-white/45">{q ? `${shown.length} of ${lines.length} lines` : lines.length > 14 ? `The last 14 of ${lines.length} lines. Search to see the rest.` : 'From the server: read as text, never as instructions.'}</p>
    </DarkCard>
  );
}

const ACT: Record<string, [string, string]> = { restart: ['Restart', 'Restarting'], stop: ['Stop', 'Stopping'], start: ['Start', 'Starting'], update: ['Update', 'Updating'], remove: ['Move to the trash', 'Removing'] };
// part.impact: what happens if…, then do it from here (an AI's request still waits for your OK)
export function PartImpactCard({ input, output: o }: { input: any; output: Out }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ReturnType<typeof said> | null>(null);
  const act = ACT[o.verb];
  const go = async () => {
    setBusy(true);
    const r = await call(`part.${o.verb}`, { serverId: input.serverId, part: input.part, ...(o.tier === 'Hard to undo' && { confirm: o.part }) });
    setBusy(false); setSure(false); setNote(said(r, `${act?.[0] ?? 'Done'}: done.`));
  };
  return (
    <Frame icon={<ShieldCheck size={16} />} tone="soft" title={`If you ${(act?.[0] ?? o.verb).toLowerCase()} ${o.part}`} sub={o.canDo ? `${o.through} · ${o.tier}` : 'Can’t be done from here'} href={serverHref(input?.serverId)} hrefLabel="Open the server page">
      <ul className="space-y-1.5">{(o.lines as string[]).map((l) => <li key={l} className="flex gap-2 text-[13px] text-ink"><span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-ink-2" />{rawWords(l)}</li>)}</ul>
      {!!o.domains?.length && <div className="mt-2.5 flex flex-wrap gap-1.5">{(o.domains as string[]).map((d) => <Badge key={d} tone="warn">{d}</Badge>)}</div>}
      {!o.canDo && <Outcome tone="info">{rawWords(o.why ?? '')}</Outcome>}
      {o.canDo && act && !note && (sure ? <Sure text={o.lines.join(' ')} yes={act[0]} onYes={go} onNo={() => setSure(false)} busy={busy} />
        : <Button size="sm" variant={o.verb === 'stop' || o.verb === 'remove' ? 'danger' : 'dark'} className="mt-3" onClick={() => setSure(true)}>{act[0]}</Button>)}
      {note && <Outcome tone={note.tone} step={note.step}>{rawWords(note.text)}</Outcome>}
    </Frame>
  );
}

// part.env list: names only
export function PartSettingsCard({ input, output: o }: { input: any; output: Out }) {
  const list = (o.settings ?? []) as { key: string }[];
  return (
    <Frame icon={<Wrench size={16} />} title={`Settings of ${o.part}`} count={list.length} sub={`Names only · in ${rawWords(o.where ?? 'its settings')}`} href={serverHref(input?.serverId)} hrefLabel="Open the server page">
      {!list.length ? <p className="text-[12.5px] text-muted">No settings found.</p> : (
        <Fold items={list} max={12} className="flex flex-wrap gap-1.5">{(e) => <li key={e.key}><Badge className="h-7 font-mono !text-[11.5px]">{e.key}</Badge></li>}</Fold>
      )}
    </Frame>
  );
}

const STATUS: Record<string, ['ok' | 'warn' | 'bad' | 'idle', string]> = { done: ['ok', 'Can undo'], undone: ['idle', 'Undone'], rolled_back: ['warn', 'Put back'], failed: ['bad', 'Needs a look'], kept: ['idle', 'Backup'] };
// change.list: what Unit7 changed, newest first, with Undo where it can
export function ChangesCard({ input, output }: { input: any; output: Out[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Frame icon={<History size={16} />} title="Changes on your servers" count={output.length} sub="Each one kept its undo before it ran" href={serverHref(input?.serverId)} hrefLabel="Open the server page">
      {!output.length ? <p className="text-[12.5px] text-muted">Nothing changed yet.</p> : (
        <Fold items={output} className="divide-y divide-line">
          {(c) => {
            const [tone, word] = STATUS[c.status] ?? ['idle', c.status];
            return (
              <li key={c.changeId} className="py-2.5">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] text-ink">{rawWords(c.summary)}</p>
                    <p className="truncate text-[12px] text-muted">{c.by ? `${rawWords(c.by)} · ` : ''}{timeAgo(c.at)}{c.note ? ` · ${rawWords(c.note)}` : ''}</p>
                  </div>
                  <Pill tone={tone}>{word}</Pill>
                  {c.canUndo && open !== c.changeId && <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} onClick={() => setOpen(c.changeId)}>Undo</Button>}
                </div>
                {open === c.changeId && <UndoButton changeId={c.changeId} what={c.summary} asked onCancel={() => setOpen(null)} />}
              </li>
            );
          }}
        </Fold>
      )}
    </Frame>
  );
}
