// The server page's shared state (the open project, the Coolify and Room pop-ups) and its calm parts, from the X-ray:
// the Overview (four tiles and nothing else at rest), the domains, databases and jobs lists the Apps tab switches to,
// and the backups list the Health tab shows. The expert view (containers, ports, logs) is in Servers.tsx.
import { useTool } from '../care/data';
import { shieldOf, type Guarded } from '../protect';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpRight, CalendarClock, Database, DatabaseBackup, History, RefreshCw } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { Badge, Button, Dot, Empty, HoldButton, Modal, Skeleton, cx, timeAgo, toast, StatusMark, Illustration, stepAction } from '../../ui';
import { useApi } from '../../lib/api';
import { tidy } from '../../lib/words';
import { OWNER_NAME, healthTone, healthWords, hoursAgo, partLogo, partWhat, projectCards, size, type Card, type XPart } from './shape';
import { AiButton, CardsSkeleton, TrustBadge, call, costOf, type CardCtx, type ServerXray } from './Xray';
import { CoolifyConnectModal } from './CoolifyTile';
import { ProjectDrawer } from './ProjectDrawer';
import { AppsTile, AttentionTile, RoomDetail, RoomTile, TrafficTile } from './Tiles';
import type { Item, ServerWatch } from './Attention';
import type { LifecycleItem } from '../lifecycle';

export type TabId = 'overview' | 'apps' | 'traffic' | 'health' | 'changes' | 'advanced';

// the page's shared state: the open project, the Coolify connect and Room pop-ups, and the cards' context
export function useServerPage(sx: ServerXray, serverName: string, human: boolean) {
  const graph = useApi<any>('/api/graph', { live: false });
  const guard = useTool<{ guarded: Guarded[] }>('safety.status', {});
  const [open, setOpen] = useState<{ id: string; section?: string } | null>(null);
  // Connections' Coolify tile links here with #coolify-connect: open the connect pop-up
  const [connect, setConnect] = useState(() => location.hash === '#coolify-connect');
  const [room, setRoom] = useState(false);
  const cards = useMemo(() => (sx.x ? projectCards(sx.x, sx.u) : []), [sx.x, sx.u]);
  const currency = sx.u?.price?.currency ?? sx.price?.currency ?? 'USD';
  const ctx: CardCtx | null = sx.x && {
    x: sx.x, serverName, human, currency, onConnect: () => setConnect(true),
    open: (c, section) => setOpen({ id: c.id, section }),
    projectHref: (name) => { const p = graph.data?.projects?.find((q: any) => q.name === name); return p && `/projects/${p.id}`; },
    cost: (c) => costOf(c, sx.u, sx.price),
    shield: (c) => (guard.data ? shieldOf(guard.data.guarded, c.parts.map((p) => p.id)) : undefined),
  };
  const card = cards.find((c) => c.id === open?.id) ?? null;
  // each database's own size, from the last disk measurement (cached; "Measure disk" takes a new one)
  const [sizes, setSizes] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!sx.x) return;
    void call('server.sizes', { serverId: sx.x.serverId }).then((r) => {
      if (r.status !== 'ok') return;
      const o = r.output as { databases: { part: string; bytes: number }[]; volumes: Record<string, number> };
      // volumes by their part id (v:<name>), and each database's own size
      const out: Record<string, number> = Object.fromEntries(Object.entries(o.volumes ?? {}).map(([k, b]) => [`v:${k}`, b]));
      for (const d of o.databases) out[d.part] = (out[d.part] ?? 0) + d.bytes;
      setSizes(out);
    });
  }, [sx.x?.serverId, sx.u?.disk?.measuredAt]);
  // archive and delete need each project's map id (an X-ray project) or its Unit7 project id
  const [mapIds, setMapIds] = useState<Map<string, string>>(new Map());
  const [mapNonce, setMapNonce] = useState(0);
  useEffect(() => {
    if (!sx.x) return;
    void call('map.get', { includeArchived: true }).then((r) => {
      if (r.status !== 'ok') return;
      const o = r.output as { assets: { kind: string; name: string; projects?: { id: string; name: string; owner: string }[] }[] };
      const srv = o.assets.find((a) => a.kind === 'server' && a.name === serverName);
      setMapIds(new Map((srv?.projects ?? []).map((p) => [`${p.owner}:${p.name}`, p.id])));
    });
  }, [sx.x?.serverId, serverName, mapNonce]);
  const lifeItem = (c: Card): LifecycleItem | null => {
    if (c.system) return null;
    if (c.owner === 'unit7') { const p = graph.data?.projects?.find((q: any) => q.name === c.name); return p ? { key: p.id, name: c.name, kind: 'project', provider: 'unit7', projectId: p.id } : null; }
    const id = mapIds.get(`${c.owner}:${c.name}`);
    return id ? { key: id, name: c.name, kind: 'project', provider: c.owner } : null;
  };
  // after an archive or delete: the X-ray, the map ids and the graph again
  const changed = () => { void sx.rescan(); setMapNonce((n) => n + 1); graph.reload(); };
  const closeConnect = () => { setConnect(false); if (location.hash === '#coolify-connect') history.replaceState(history.state, '', location.pathname + location.search); };
  const modals = sx.x && (
    <>
      <ProjectDrawer x={sx.x} card={card} section={open?.section} onClose={() => setOpen(null)} human={human} cost={card ? costOf(card, sx.u, sx.price) : undefined} currency={currency}
        onConnect={() => { setOpen(null); setTimeout(() => setConnect(true), 200); }} sizes={sizes} projectHref={card?.owner === 'unit7' ? ctx?.projectHref?.(card.name) : undefined}
        life={card ? lifeItem(card) : null} onLifeChanged={() => { setOpen(null); changed(); }} />
      {sx.x.coolify && <CoolifyConnectModal open={connect} onClose={closeConnect} serverId={sx.x.serverId} serverName={serverName} human={human} onConnected={() => void sx.rescan()} />}
      <Modal open={room} onClose={() => setRoom(false)} size="lg" title="Room on this server">
        <RoomDetail sx={sx} human={human} />
      </Modal>
    </>
  );
  return { cards, ctx, modals, sizes, openProject: (id: string) => setOpen({ id }), currency, connect: () => setConnect(true), openRoom: () => setRoom(true), lifeItem, changed };
}
export type ServerPage = ReturnType<typeof useServerPage>;

// --- the stale line: calm, one line, with a way to look again ---
export function StaleLine({ since, why, onRetry, busy }: { since: string; why: string; onRetry: () => void; busy: boolean }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-[18px] bg-raised px-4 py-2.5">
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-[#f59e0b]" />
      <p className="min-w-[200px] flex-1 text-[13px] text-ink-2" title={tidy(why)}>Showing what Unit7 saw {hoursAgo(since)}. The server didn’t answer since.</p>
      <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={busy} onClick={onRetry}>Try again</Button>
    </div>
  );
}

// tiles animate once per server per visit: coming back to the tab, they're simply there
const counted = new Set<string>();
export function Overview({ sx, page, w, serverName, doctor, problem, onTab, onItem }: {
  sx: ServerXray; page: ServerPage; w: ServerWatch; serverName: string; doctor: ReactNode; problem: boolean; onTab: (t: TabId) => void; onItem: (it: Item) => void;
}) {
  const { x } = sx;
  // decided once, when the X-ray is first there (it may arrive after the tab does)
  const first = useRef<boolean | null>(null);
  if (x && first.current === null) first.current = !counted.has(x.serverId);
  const animate = !!first.current;
  useEffect(() => { if (x) counted.add(x.serverId); }, [x?.serverId]);
  if (!x && sx.xErr) return (
    <div className="space-y-4">
      <Empty art={<Illustration name="offline" size={96} />} title="Unit7 couldn’t look inside yet" body={<>{tidy(sx.xErr).replace(/credential:\/\/\S+/g, 'its key')} It shows everything here once the server answers.</>}
        action={<Button variant="dark" icon={<RefreshCw size={15} />} loading={sx.scanning} onClick={() => void sx.rescan()}>Try again</Button>} />
      {doctor}
    </div>
  );
  if (!x) return (
    <div className="space-y-4" aria-busy="true" aria-label="Looking inside the server">
      <p className="flex items-center gap-2 px-1 text-[13px] text-muted"><span className="size-2 animate-working rounded-full bg-blue" />Looking inside {serverName}: one quick read-only trip…</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[220px] rounded-[24px]" />)}</div>
    </div>
  );
  return (
    <div className="space-y-4">
      {x.stale && <StaleLine since={x.stale.since} why={x.stale.why} onRetry={() => void sx.rescan()} busy={sx.scanning} />}
      {problem && doctor}
      <div className={cx('grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4', animate && 'stagger')}>
        <AppsTile cards={page.cards} onOpen={() => onTab('apps')} animate={animate} />
        <TrafficTile serverId={x.serverId} onOpen={() => onTab('traffic')} animate={animate} />
        <AttentionTile w={w} onOpen={() => onTab('health')} onItem={onItem} animate={animate} />
        <RoomTile sx={sx} onOpen={page.openRoom} />
      </div>
    </div>
  );
}

// --- lists: domains, databases, jobs (the Apps tab switches to them) ---
function List({ empty, children }: { empty: ReactNode; children: ReactNode[] }) {
  return children.length ? <ul className="divide-y divide-line overflow-hidden rounded-[24px] border border-line bg-surface shadow-soft">{children}</ul> : <>{empty}</>;
}
const projectName = (sx: ServerXray, p: XPart) => sx.x?.projects.find((q) => q.id === p.project)?.name;
function ProjectChip({ sx, page, p }: { sx: ServerXray; page: ServerPage; p: XPart }) {
  const name = projectName(sx, p);
  if (!name) return <span className="text-[12px] text-faint">Not part of a project</span>;
  return <button type="button" onClick={() => page.openProject(p.project!)} className="inline-flex h-7 max-w-[180px] items-center rounded-full border border-line px-2.5 text-[12px] font-medium text-ink-2 transition hover:border-line-strong hover:text-ink"><span className="truncate">{name}</span></button>;
}

export function DomainsTab({ sx, page }: { sx: ServerXray; page: ServerPage }) {
  if (!sx.x) return <CardsSkeleton n={2} />;
  const byId = new Map(sx.x.parts.map((p) => [p.id, p]));
  const ds = sx.x.parts.filter((p) => p.kind === 'domain').sort((a, b) => a.name.split('.').reverse().join('.').localeCompare(b.name.split('.').reverse().join('.')));
  return (
    <div className="space-y-3">
      <List empty={<Empty art={<Illustration name="domain" size={100} />} title="No domains point here yet" body="When a domain reaches an app on this server, it shows here with the app it opens." />}>
        {ds.map((d) => {
          const t = d.target ? byId.get(d.target) : undefined;
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3">
              <div className="min-w-[180px] flex-1">
                <a href={`https://${d.name}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[14px] font-medium hover:underline">{d.name}<ArrowUpRight size={13} className="text-faint" /></a>
              </div>
              {t && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">opens <BrandLogo id={partLogo(t)} size={14} /><b className="font-medium">{t.name}</b></span>}
              <ProjectChip sx={sx} page={page} p={d} />
            </li>
          );
        })}
      </List>
      <p className="px-1 text-[12.5px] text-muted">Where each domain’s DNS lives, HTTPS and email protection are on the Map.</p>
    </div>
  );
}

export function DatabasesTab({ sx, page, serverName }: { sx: ServerXray; page: ServerPage; serverName: string }) {
  const sizes = page.sizes;
  if (!sx.x) return <CardsSkeleton n={2} />;
  const dbs = sx.x.parts.filter((p) => p.kind === 'database');
  return (
    <List empty={<Empty icon={<Database size={24} />} title="No databases on this server" body="Ask Unit7 to add one to an app; it wires the address into the app for you." action={<AiButton size="md" prompt={`Add a database to an app on ${serverName}`}>Add a database</AiButton>} />}>
      {dbs.map((d) => {
        const t = healthTone(d.health);
        return (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <span className="grid size-10 place-items-center rounded-[14px] bg-raised"><BrandLogo id={partLogo(d)} size={20} /></span>
            <div className="min-w-[180px] flex-1">
              <p className="flex items-center gap-2 text-[14px] font-medium"><Dot tone={t === 'idle' ? 'idle' : t} />{d.name}</p>
              <p className="text-[12px] text-muted">{[partWhat(d), d.internals?.length ? `${d.internals.length} containers, shown as one` : '', sizes[d.id] ? size(sizes[d.id]) : '', t !== 'ok' ? healthWords(d.health) : ''].filter(Boolean).join(' · ')}</p>
            </div>
            {d.exposed && <Badge tone="bad"><AlertTriangle size={12} />Open to the internet</Badge>}
            <TrustBadge trust={d.trust} owner={d.owner} />
            <ProjectChip sx={sx} page={page} p={d} />
            <AiButton prompt={`Back up the ${d.name} database on ${serverName}${d.exposed ? ', and close it to the internet' : ''}`}>{d.exposed ? 'Back up and close it' : 'Back it up'}</AiButton>
          </li>
        );
      })}
    </List>
  );
}

export function JobsTab({ sx, page, serverName }: { sx: ServerXray; page: ServerPage; serverName: string }) {
  if (!sx.x) return <CardsSkeleton n={2} />;
  const jobs = sx.x.parts.filter((p) => p.kind === 'job');
  return (
    <List empty={<Empty art={<Illustration name="routines" size={96} />} title="No scheduled jobs" body="Jobs that run on a timer (cron) show here in plain words, like “every day at 03:00”." action={<AiButton size="md" prompt={`Schedule a job on ${serverName}`}>Schedule a job</AiButton>} />}>
      {jobs.map((j) => (
        <li key={j.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <span className="grid size-10 place-items-center rounded-[14px] bg-raised"><CalendarClock size={17} className="text-muted" /></span>
          <div className="min-w-[200px] flex-1">
            <p className="text-[14px] font-medium">{j.when ? j.when.charAt(0).toUpperCase() + j.when.slice(1) : j.schedule}</p>
            <code className="block truncate font-mono text-[12px] text-ink-2" title={j.command}>{j.command}</code>
            {j.user && <p className="text-[11.5px] text-muted">as {j.user}</p>}
          </div>
          <ProjectChip sx={sx} page={page} p={j} />
        </li>
      ))}
    </List>
  );
}

// --- bringing one of them back: a test copy by default; over the live one only for a person, its name typed ---
interface PartBackups { part: string; name: string; engine?: string; canRestoreOverLive: boolean; schedule: { frequency: string; keep: number } | null; backups: { id: string; at: string; size: number | null; reason: string; offServer: boolean }[] }
function RestoreModal({ serverId, b, onClose, onDone }: { serverId: string; b: PartBackups | null; onClose: () => void; onDone: () => void }) {
  const [pick, setPick] = useState<string>('');
  const [into, setInto] = useState<'copy' | 'live'>('copy');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { if (b) { setPick(b.backups[0]?.id ?? ''); setInto('copy'); setTyped(''); setDone(null); } }, [b]);
  if (!b) return null;
  const go = async () => {
    setBusy(true);
    const r = await call('part.restore', { serverId, part: b.part, backupId: pick, into, ...(into === 'live' && { confirmName: typed.trim() }) });
    setBusy(false);
    if (r.status === 'ok') { setDone(tidy((r.output as { next?: string; undo?: string }).next ?? `${b.name} is back to that backup. ${(r.output as { undo?: string }).undo ?? ''}`)); onDone(); }
    else if (r.status === 'approval_required') { toast('warn', 'Waiting for your OK', 'Approve it on the Approvals page and Unit7 does it.'); onClose(); }
    else toast('bad', 'Couldn’t bring it back', tidy(r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : ''), { action: stepAction(r, { input: { serverId }, retry: go }) });
  };
  const opt = (v: 'copy' | 'live', title: string, body: string, off?: string) => (
    <label className={cx('flex cursor-pointer items-start gap-3 rounded-[16px] border p-3.5 transition', into === v ? 'border-ink bg-raised/50' : 'border-line hover:bg-raised/40', off && 'cursor-not-allowed opacity-55')}>
      <input type="radio" name="restore-into" className="mt-1 accent-[var(--ink)]" checked={into === v} disabled={!!off} onChange={() => setInto(v)} />
      <span className="min-w-0"><span className="block text-[13.5px] font-medium text-ink">{title}</span><span className="mt-0.5 block text-[12.5px] text-muted">{off ?? body}</span></span>
    </label>
  );
  return (
    <Modal open onClose={onClose} title={`Bring back ${b.name}`} size="md">
      {done ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3"><StatusMark state="ok" size={36} solid label="Done" className="shrink-0" /><p className="text-[13.5px] text-ink">{done}</p></div>
          <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (into === 'copy') void go(); }}>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium">Which backup</legend>
            <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-10 w-full rounded-[14px] border border-line-strong bg-surface px-3 text-[13.5px]">
              {b.backups.map((x) => <option key={x.id} value={x.id}>{timeAgo(x.at)} · {new Date(x.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{x.size ? ` · ${size(x.size)}` : ''}</option>)}
            </select>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-[13px] font-medium">Where to</legend>
            {opt('copy', 'Into a test copy (safest)', 'A new copy starts next to it from this backup. The live one doesn’t change, and Undo in Activity removes the copy.')}
            {opt('live', 'Over the live one', 'It goes back to this backup and newer changes are lost. Unit7 backs it up as it is now first, so you can go back.', b.canRestoreOverLive ? undefined : 'Postgres backups come back as a test copy: check it, then point your app at it.')}
          </fieldset>
          {into === 'live' && (
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium">Type <b className="font-semibold">{b.name}</b> to restore over it</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="h-10 w-full rounded-[14px] border border-line-strong bg-surface px-3 text-[13.5px]" />
            </label>
          )}
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            {into === 'copy' ? <Button type="submit" variant="primary" loading={busy} disabled={!pick}>Make the test copy</Button>
              : <HoldButton loading={busy} disabled={typed.trim() !== b.name || !pick} onConfirm={() => void go()}>Restore over it</HoldButton>}
          </div>
        </form>
      )}
    </Modal>
  );
}

// --- backups of this server's databases (the Health tab) ---
export function BackupsTab({ serverId, serverName, sx }: { serverId: string; serverName: string; sx: ServerXray }) {
  const graph = useApi<any>('/api/graph', { live: false });
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { void call('backup.list', {}).then((r) => setRows(r.status === 'ok' ? (r.output as any[]) : [])); }, []);
  const here = new Set<string>();
  for (const p of graph.data?.projects ?? []) for (const e of p.environments) for (const s of e.services) if (s.server_id === serverId) here.add(s.id);
  const mine = (rows ?? []).filter((b) => here.has(b.service_id));
  const [parts, setParts] = useState<PartBackups[] | null>(null);
  const loadParts = () => void call('part.backups', { serverId }).then((r) => setParts(r.status === 'ok' ? (r.output as PartBackups[]) : []));
  useEffect(loadParts, [serverId]);
  const foreign = (sx.x?.parts ?? []).filter((p) => p.kind === 'database' && p.owner !== 'unit7' && !parts?.some((b) => b.part === p.id && b.schedule));
  const [all, setAll] = useState(false);
  // at rest, the newest backup of each database; every one on "Show all"
  const kept = (sid: string) => mine.filter((x) => x.service_id === sid).length;
  const latest = mine.filter((b, i) => mine.findIndex((x) => x.service_id === b.service_id) === i).slice(0, 8);
  const [restore, setRestore] = useState<PartBackups | null>(null);
  return (
    <div className="space-y-3">
      {!!parts?.length && (
        <List empty={null}>
          {parts.map((b) => (
            <li key={b.part} className="flex flex-wrap items-center gap-3 px-5 py-3">
              {b.backups.length ? <StatusMark state="ok" size={36} label="Backed up" /> : <span className="grid size-9 place-items-center rounded-full bg-raised text-muted"><DatabaseBackup size={15} /></span>}
              <div className="min-w-[180px] flex-1">
                <p className="text-[14px] font-medium">{b.name}</p>
                <p className="text-[12px] text-muted">{[b.schedule && `Every ${b.schedule.frequency === 'daily' ? 'day' : b.schedule.frequency === 'hourly' ? 'hour' : 'week'}, the last ${b.schedule.keep} kept`, b.backups[0] && `newest ${timeAgo(b.backups[0].at)}`, b.backups[0]?.offServer && 'a copy off the server'].filter(Boolean).join(' · ') || 'No backup yet'}</p>
              </div>
              {b.backups.length > 0 && <Button size="sm" variant="secondary" icon={<History size={13} />} onClick={() => setRestore(b)}>Bring it back…</Button>}
            </li>
          ))}
        </List>
      )}
      <RestoreModal serverId={serverId} b={restore} onClose={() => setRestore(null)} onDone={loadParts} />
      {!rows ? <Skeleton className="h-28 rounded-[24px]" /> : (
        <List empty={parts?.length ? null : <p className="rounded-[20px] bg-raised px-4 py-4 text-[13px] text-muted">No backups of this server’s databases yet. Unit7 backs up the databases it runs, keeps a copy off the server and checks it can be restored.</p>}>
          {(all ? mine.slice(0, 30) : latest).map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              {b.status === 'done' || b.status === 'ok' ? <StatusMark state="ok" size={36} label="Backed up" /> : <span className="grid size-9 place-items-center rounded-full bg-raised text-muted"><DatabaseBackup size={15} /></span>}
              <div className="min-w-[180px] flex-1">
                <p className="text-[14px] font-medium">{b.service}</p>
                <p className="text-[12px] text-muted">{timeAgo(b.created_at)}{b.size ? ` · ${size(b.size)}` : ''}{b.offsite ? ` · copy on ${b.offsite}` : ''}{b.verify_ok ? ' · restore checked' : ''}{!all && kept(b.service_id) > 1 ? ` · ${kept(b.service_id)} kept` : ''}</p>
              </div>
              <Badge tone={b.status === 'failed' ? 'bad' : 'neutral'}>{b.reason ?? b.kind}</Badge>
            </li>
          ))}
        </List>
      )}
      {mine.length > latest.length && !all && <button type="button" onClick={() => setAll(true)} className="inline-flex h-8 items-center rounded-full px-2.5 text-[12.5px] font-medium text-blue-text hover:bg-blue-soft">Show all {Math.min(30, mine.length)}</button>}
      {foreign.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[20px] border border-line bg-surface p-4">
          <p className="min-w-[220px] flex-1 text-[13px] text-ink-2">{foreign.length} database{foreign.length === 1 ? '' : 's'} here {foreign.length === 1 ? 'is' : 'are'} run by {[...new Set(foreign.map((p) => OWNER_NAME[p.owner] ?? p.owner))].join(' and ')}, so Unit7 doesn’t back {foreign.length === 1 ? 'it' : 'them'} up yet.</p>
          <AiButton prompt={`Set up daily backups for the databases on ${serverName} that Unit7 doesn't back up yet`}>Back them up too</AiButton>
        </div>
      )}
    </div>
  );
}
