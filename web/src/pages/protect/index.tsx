// What's protected: every database with its level, why it counts as important (with a one-tap "it isn't"), where its copies
// are, and the Safety Net's promise in plain sight: a green list of what it does by itself and a red list of what it never
// will. "Protect it now" and "Copy now" only create or copy.
import { useState } from 'react';
import { Copy, Shield, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { useTool } from '../care/data';
import { askOnHome } from '../Help';
import { act, Badge, Button, Card, PageHeader, Skeleton, SwitchRow, cx, timeAgo } from '../../ui';

export type Level = 'unprotected' | 'weak' | 'protected' | 'proven';
export interface Guarded { key: string; service?: string; failed?: string; serverId: string; serverName: string; part: string; name: string; engine: string; project?: string; projectName?: string; important: boolean; why: string[]; by: 'you' | 'unit7'; level: Level; copies: { here: number; off: number }; lastCopy: string | null; provenAt: string | null; where: string[]; next: string; system?: boolean }
interface Status { on: boolean; paused: boolean; observe: boolean; settings: { busy?: { from: string; to: string; tz?: string } | null; checkup?: string }; counts: Record<Level, number>; words: Record<Level, string>; guarded: Guarded[]; quiet: Record<string, { hour: number; known: boolean }>; copiesGo: { offServer: boolean; folder: string | null; blocked: string[] } }

export const LEVEL: Record<Level, { word: string; tone: 'bad' | 'warn' | 'info' | 'ok'; icon: typeof Shield }> = {
  unprotected: { word: 'Unprotected', tone: 'bad', icon: ShieldX }, weak: { word: 'Weak', tone: 'warn', icon: ShieldAlert }, protected: { word: 'Protected', tone: 'info', icon: Shield }, proven: { word: 'Proven', tone: 'ok', icon: ShieldCheck },
};
export function ProtectionBadge({ level }: { level: Level }) {
  const l = LEVEL[level], I = l.icon;
  return <Badge tone={l.tone}><I size={13} aria-hidden />{l.word}</Badge>;
}
// a project's shield is its weakest important database
const WEAKEST: Level[] = ['unprotected', 'weak', 'protected', 'proven'];
export const shieldOf = (guarded: Guarded[], partIds: string[]): Level | undefined => WEAKEST.find((l) => guarded.some((g) => g.important && partIds.includes(g.part) && g.level === l));
// the risk, plainly
export const riskWords = (g: Pick<Guarded, 'level' | 'lastCopy'>) => (g.level === 'unprotected' ? 'If this server dies today, this data is gone.' : g.level === 'weak' ? 'If this server dies today, its copies go with it.' : g.level === 'protected' ? 'A copy is safe, but nobody has tried restoring it yet.' : 'A copy is safe, and it restored in a test.');

function Row({ g, reload }: { g: Guarded; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); await act('safety.protect', { key: g.key }, { success: `${g.name} is protected` }); setBusy(false); reload(); };
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3.5">
      <div className="min-w-0 flex-1 basis-[300px]">
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">{g.name}{g.projectName && g.projectName !== g.name && <span className="text-[12.5px] font-normal text-muted">{g.projectName}</span>}<ProtectionBadge level={g.level} /></p>
        <p className="mt-0.5 text-[13px] text-ink-2">{riskWords(g)}</p>
        {g.failed && <p className="mt-0.5 text-[12.5px] text-warn">{g.failed}</p>}
        <p className="mt-0.5 text-[12.5px] text-muted">{g.lastCopy ? `Last copy ${timeAgo(g.lastCopy)}` : 'No copy yet'}{g.where.length ? ` · ${g.where.join(', ')}` : ''}{g.provenAt ? ` · restored in a test ${timeAgo(g.provenAt)}` : ''}</p>
        {g.important && g.why.length > 0 && <p className="mt-0.5 text-[12.5px] text-muted">Important because: {g.why.join(', ').toLowerCase()}</p>}
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        {g.level !== 'proven' && <Button size="sm" loading={busy} onClick={run}>Protect it now</Button>}
        {g.lastCopy && !g.service && <Button size="sm" variant="ghost" onClick={async () => { const r = await act('part.restore', { serverId: g.serverId, part: g.part, into: 'copy' }, { success: 'A past copy is open. It has no public port and removes itself in two days.' }); if (r) reload(); }}>Open a past copy</Button>}
        <Button size="sm" variant="ghost" onClick={async () => { await act('safety.mark', { key: g.key, important: !g.important }, { success: g.important ? 'It won’t count as important' : 'It counts as important now', undo: false }); reload(); }}>{g.important ? 'It isn’t important' : 'It’s important'}</Button>
      </span>
    </li>
  );
}

function OpenCopies({ serverIds }: { serverIds: string[] }) {
  const first = serverIds[0];
  const { data, reload } = useTool<{ copies: { name: string; of: string; at: string }[] }>('part.copies', first ? { serverId: first } : null);
  if (!first || !data?.copies.length) return null;
  return (
    <Card className="mt-4 px-5"><h2 className="pt-4 text-[15px] font-semibold tracking-[-0.015em]">Past copies open now</h2>
      <p className="text-[12.5px] text-muted">Side copies with no public port. Nothing here touches live data. Unit7 reminds you after two days and never removes one by itself.</p>
      <ul className="divide-y divide-line">{data.copies.map((c) => (
        <li key={c.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
          <div className="min-w-0 flex-1 basis-[240px]"><p className="truncate text-[14px] font-medium text-ink">{c.name}</p><p className="text-[12.5px] text-muted">Opened {timeAgo(c.at)}</p></div>
          <Button size="sm" variant="secondary" onClick={() => askOnHome(`In the past copy ${c.name} on my server, find `)}>Look inside</Button>
          <Button size="sm" variant="ghost" onClick={async () => { await act('part.copy_remove', { serverId: first, copy: c.name }, { success: 'Removed', undo: false }); reload(); }}>Remove</Button>
        </li>
      ))}</ul>
    </Card>
  );
}

function BusyHours({ value, quiet, onSaved }: { value?: { from: string; to: string; tz?: string } | null; quiet?: { hour: number; known: boolean }; onSaved: () => void }) {
  const [from, setFrom] = useState(value?.from ?? '09:00'), [to, setTo] = useState(value?.to ?? '18:00');
  const save = async (on: boolean) => { await act('safety.settings', { busy: on ? { from, to, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } : null }, { success: on ? 'Nothing heavy runs in those hours' : 'Busy hours removed', undo: false }); onSaved(); };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
      <div className="min-w-0 flex-1 basis-[260px]"><p className="text-[14px] font-medium text-ink">Busy hours</p><p className="text-[13px] text-muted">Nothing heavy runs in these hours.{quiet?.known ? ` Your quietest hour is around ${String(quiet.hour).padStart(2, '0')}:00 UTC.` : ''}</p></div>
      <label className="text-[13px] text-ink-2">From <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-1 rounded-[10px] border border-line bg-surface px-2 py-1 text-[13px]" /></label>
      <label className="text-[13px] text-ink-2">to <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className="ml-1 rounded-[10px] border border-line bg-surface px-2 py-1 text-[13px]" /></label>
      <Button size="sm" variant="secondary" onClick={() => save(true)}>Save</Button>
      {value && <Button size="sm" variant="ghost" onClick={() => save(false)}>Remove</Button>}
    </div>
  );
}

const GREEN = ['Copies your databases', 'Sends encrypted copies off the server', 'Copies uploaded files and settings', 'Test-restores into a throwaway copy', 'Picks up new databases by itself'];
const RED = ['Deletes or overwrites anything of yours', 'Restores over live data', 'Restarts or changes a running app', 'Changes DNS or settings', 'Spends money'];

export function ProtectPage() {
  const s = useTool<Status>('safety.status', {});
  const d = s.data;
  const important = d?.guarded.filter((g) => g.important) ?? [], rest = d?.guarded.filter((g) => !g.important) ?? [];
  const toggle = async (on: boolean) => { await act('safety.settings', { on }, { success: on ? 'The Safety Net is on' : 'The Safety Net is off', undo: false }); s.reload(); };
  return (
    <div>
      <PageHeader title="Safety Net" subtitle="If something important has no safe copy, Unit7 makes one by itself and proves it works." actions={<Button variant="secondary" icon={<Copy size={15} />} onClick={async () => { await act('safety.copy', {}, { success: 'Fresh copies are done' }); s.reload(); }}>Copy now</Button>} />
      {!d && <Skeleton className="mt-6 h-48 w-full" />}
      {d && (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-4">{(['proven', 'protected', 'weak', 'unprotected'] as Level[]).map((l) => (
            <Card key={l} className="p-4"><p className="tabular text-[26px] font-semibold tracking-[-0.03em] text-ink">{d.counts[l]}</p><p className="mt-0.5"><ProtectionBadge level={l} /></p><p className="mt-1.5 text-[12.5px] text-muted">{d.words[l]}</p></Card>
          ))}</div>
          {(d.paused || d.observe) && <p className="mt-3 rounded-[12px] bg-raised px-3 py-2 text-[13px] text-ink-2">{d.paused ? 'Autopilot is paused, so the Safety Net is resting.' : 'Autonomy is set to Observe, so the Safety Net only watches.'}</p>}
          {!d.copiesGo.folder && <p className="mt-3 rounded-[12px] bg-raised px-3 py-2 text-[13px] text-ink-2">Copies go to this computer for now.{d.copiesGo.blocked.length ? ` ${d.copiesGo.blocked[0]} was found but Unit7 can’t reach it yet.` : ''} Add a safer place in Settings → Backups.</p>}
          <Card className="mt-5 px-5"><h2 className="pt-4 text-[15px] font-semibold tracking-[-0.015em]">Important</h2>
            {important.length ? <ul className="divide-y divide-line">{important.map((g) => <Row key={g.key} g={g} reload={s.reload} />)}</ul> : <p className="pb-4 pt-1 text-[13.5px] text-muted">Nothing important found yet. Connect a server and Unit7 works this out by itself.</p>}
          </Card>
          {rest.length > 0 && <Card className="mt-4 px-5"><h2 className="pt-4 text-[15px] font-semibold tracking-[-0.015em]">Not important</h2><p className="text-[12.5px] text-muted">Unit7 suggests a backup for these, but doesn’t act by itself.</p><ul className="divide-y divide-line">{rest.map((g) => <Row key={g.key} g={g} reload={s.reload} />)}</ul></Card>}
          <OpenCopies serverIds={[...new Set(d.guarded.map((g) => g.serverId).filter(Boolean))]} />
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <Card className="p-5"><h2 className="text-[15px] font-semibold tracking-[-0.015em]">It does this by itself</h2><ul className="mt-2 space-y-1 text-[13px] text-ink-2">{GREEN.map((x) => <li key={x} className="flex gap-2"><span aria-hidden className={cx('mt-1.5 size-1.5 shrink-0 rounded-full bg-ok')} />{x}</li>)}</ul></Card>
            <Card className="p-5"><h2 className="text-[15px] font-semibold tracking-[-0.015em]">It never does this</h2><ul className="mt-2 space-y-1 text-[13px] text-ink-2">{RED.map((x) => <li key={x} className="flex gap-2"><span aria-hidden className={cx('mt-1.5 size-1.5 shrink-0 rounded-full bg-bad')} />{x}</li>)}</ul></Card>
          </div>
          <Card className="mt-4 divide-y divide-line px-5">
            <SwitchRow title="Safety Net" body="Runs when the server is calm, one thing at a time. Only a person can turn this off." checked={d.on} onChange={toggle} />
            <SwitchRow title="Check-ups by themselves" body="A short look every day and a full one every week, plus one after each deploy and each serious alert. Free, and they only read." checked={d.settings.checkup !== 'off'} onChange={async (on) => { await act('safety.settings', { checkup: on ? 'on' : 'off' }, { success: on ? 'Check-ups run by themselves' : 'Check-ups only run when you ask', undo: false }); s.reload(); }} />
            <BusyHours value={d.settings.busy} quiet={Object.values(d.quiet ?? {})[0]} onSaved={s.reload} />
          </Card>
        </>
      )}
    </div>
  );
}
