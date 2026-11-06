// A server's X-ray in the chat: the summary, the storage bar and its projects in a compact form; usage on its
// own; and Coolify's projects, an action followed live to its end, deploys, logs and settings names. The
// pieces are the server page's (pages/servers/*).
import { useState } from 'react';
import { AlertTriangle, Eye, Layers, Rocket, RotateCw, ScrollText, Undo2, X } from 'lucide-react';
import { BrandLogo } from '../../../brand/BrandLogo';
import { Badge, Skeleton, cx, timeAgo, StatusMark } from '../../../ui';
import { navigate } from '../../../lib/router';
import { rawWords } from '../../../lib/words';
import { DarkCard, Terminal } from '../../kit';
import { colorSlots, fullIn, hoursAgo, projectCards, size, storageBar, type Usage, type Xray } from '../../servers/shape';
import { Legend, ProjectCard, StorageBar, costOf, progressWords, type CardCtx } from '../../servers/Xray';
import { RevealRow, useReveal } from '../../servers/Reveal';
import { Fold, Frame, IconBtn, LiveDot, Outcome, Pill, Sure, call, said, useElapsed, useLoad, useProgress } from './kit';

const serverHref = (id?: string) => (id ? `/servers/${id}` : '/servers');
const toolOut = (name: string, input: object) => call(name, input).then((r) => (r.status === 'ok' ? r.output : Promise.reject(new Error(r.status === 'error' ? r.error.message : r.status))));

function Bars({ x, u }: { x: Xray | null; u: Usage }) {
  const slots = x ? colorSlots(x) : new Map<string, number>();
  const mem = storageBar(u, 'mem', slots), disk = storageBar(u, 'disk', slots);
  const full = fullIn(x?.trend, u.server.diskTotal);
  return (
    <div className="space-y-3">
      <StorageBar compact label={`Memory · ${size(mem.total)}`} bar={mem} note={`free ${size(mem.free)}`} />
      <StorageBar compact label={`Disk · ${size(disk.total)}`} bar={disk} note={[`free ${size(disk.free)}`, full].filter(Boolean).join(' · ')} />
      <Legend bars={[mem, disk]} className="!text-[11.5px]" />
    </div>
  );
}
const Stale = ({ since }: { since: string }) => <p className="mb-3 flex items-center gap-2 rounded-[14px] bg-warn/8 px-3 py-2 text-[12.5px] text-ink-2"><AlertTriangle size={14} className="shrink-0 text-warn" />Showing what Unit7 saw {hoursAgo(since)}: the server didn’t answer.</p>;

// server.xray: the summary, memory and disk by project, and the projects themselves
export function XrayCard({ output: x }: { output: Xray }) {
  const u = useLoad<Usage>(`usage:${x.serverId}`, () => toolOut('server.usage', { serverId: x.serverId }) as Promise<Usage>);
  const own = projectCards(x, u.data).filter((c) => !c.system);
  const ctx: CardCtx = { x, serverName: x.serverName, human: true, open: () => navigate(serverHref(x.serverId)), cost: (c) => costOf(c, u.data ?? null, null), currency: u.data?.price?.currency };
  return (
    <Frame icon={<BrandLogo id={x.coolify ? 'coolify' : 'linux'} size={17} />} title={x.serverName} sub={`${own.length} project${own.length === 1 ? '' : 's'}${x.coolify ? ' · shared with Coolify' : ''}`} href={serverHref(x.serverId)} hrefLabel="Open the server page">
      {x.stale && <Stale since={x.stale.since} />}
      <p className="text-[13.5px] leading-relaxed text-ink">{x.summary}</p>
      <div className="mt-3.5">{u.data ? <Bars x={x} u={u.data} /> : u.error ? null : <div className="space-y-3" aria-hidden><Skeleton className="h-2.5 rounded-full" /><Skeleton className="h-2.5 rounded-full" /></div>}</div>
      {own.length > 0 && <Fold items={own} max={4} as="div" className="mt-3.5 grid gap-2 @md:grid-cols-2">{(c) => <ProjectCard key={c.id} c={c} ctx={ctx} compact />}</Fold>}
      {x.coolify && !x.coolify.connected && (
        <button type="button" onClick={() => navigate(serverHref(x.serverId))} className="mt-3 flex w-full items-center gap-2.5 rounded-[16px] border border-dashed border-line-strong px-3 py-2.5 text-left text-[12.5px] transition hover:border-ink/30">
          <BrandLogo id="coolify" size={16} /><span className="flex-1 text-ink-2">Connect Coolify in three steps to restart, deploy and read logs from here.</span><span className="font-medium text-blue-text">Connect</span>
        </button>
      )}
    </Frame>
  );
}

// server.usage: the storage bar, and who uses the most
export function UsageCard({ output: u }: { output: Usage & { serverId: string; serverName: string } }) {
  const x = useLoad<Xray>(`xray:${u.serverId}`, () => toolOut('server.xray', { serverId: u.serverId }) as Promise<Xray>);
  const top = [...u.projects].filter((s) => !s.system && s.mem > 0).sort((a, b) => b.mem - a.mem).slice(0, 4);
  return (
    <Frame icon={<Layers size={16} />} title={`What’s using ${u.serverName}`} sub={u.stale ? `From ${hoursAgo(u.stale.since)}` : `Right now · ${u.source === 'sentinel' ? 'from Coolify’s monitor' : 'from Docker'}`} href={serverHref(u.serverId)} hrefLabel="Open the server page">
      {u.stale && <Stale since={u.stale.since} />}
      <Bars x={x.data ?? null} u={u} />
      {top.length > 0 && (
        <ul className="mt-3.5 divide-y divide-line rounded-[16px] border border-line">
          {top.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{s.name}</span>
              <span className="tabular text-ink-2">{size(s.mem)} memory</span>
              {s.disk ? <span className="tabular hidden text-muted @sm:inline">{size(s.disk)} disk</span> : null}
              {s.cost != null && <span className="tabular font-medium">{u.price?.currency === 'USD' || !u.price ? '$' : `${u.price.currency} `}{s.cost.toFixed(2)}/mo</span>}
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

// --- Coolify ---
const STATUS = (s?: string): [ 'ok' | 'warn' | 'bad' | 'idle' | 'work', string] => {
  const v = (s ?? '').toLowerCase();
  if (/^running/.test(v)) return [/unhealthy|degraded/.test(v) ? 'warn' : 'ok', /unhealthy|degraded/.test(v) ? 'Needs a look' : 'Running'];
  if (/exited|stopped/.test(v)) return ['idle', 'Stopped'];
  if (/restarting|starting|in_progress|queued/.test(v)) return ['work', 'Starting'];
  if (/fail/.test(v)) return ['bad', 'Failed'];
  return ['idle', v ? v.replace(/[:_]/g, ' ') : 'Unknown'];
};
const KIND_LOGO = (r: { kind: string; type?: string }) => (r.kind === 'service' ? (/supabase/.test(r.type ?? '') ? 'supabase' : 'docker') : r.kind === 'database' ? (/postgres/.test(r.type ?? '') ? 'postgres' : /redis|keydb|dragonfly/.test(r.type ?? '') ? 'redis' : /mysql|mariadb/.test(r.type ?? '') ? 'mysql' : /mongo/.test(r.type ?? '') ? 'mongodb' : 'postgres') : 'coolify');

interface Res { uuid: string; name: string; kind: string; type?: string; status?: string; fqdn: string[]; repo?: string; branch?: string; lastDeploy?: { status?: string; at?: string } }
// coolify.projects: every project, its environments and what's in them
export function CoolifyProjectsCard({ input, output: o }: { input: any; output: { server: string; version?: string; projects: { uuid: string; name: string; environments: { name: string; resources: Res[] }[] }[] } }) {
  return (
    <Frame icon={<BrandLogo id="coolify" size={17} />} title="Coolify projects" count={o.projects.length} sub={`On ${o.server}${o.version ? ` · Coolify ${o.version}` : ''}`} href={serverHref(input?.serverId)} hrefLabel="Open the server page">
      <Fold items={o.projects} max={4} className="space-y-2">
        {(p) => (
          <li key={p.uuid} className="rounded-[18px] border border-line px-3 py-2.5">
            <p className="text-[14px] font-semibold">{p.name}</p>
            {p.environments.map((e) => (
              <div key={e.name} className="mt-1.5">
                {p.environments.length > 1 && <p className="text-[11.5px] text-muted">{e.name}</p>}
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {e.resources.map((r) => {
                    const [tone, word] = STATUS(r.status);
                    return (
                      <li key={r.uuid} title={`${word}${r.fqdn[0] ? ` · ${r.fqdn[0]}` : ''}${r.repo ? ` · ${r.repo}` : ''}`} className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface pl-1 pr-2.5 text-[12.5px] font-medium text-ink-2">
                        <span className="grid size-6 place-items-center rounded-full bg-raised"><BrandLogo id={KIND_LOGO(r)} size={13} /></span><span className="truncate">{r.name}</span><LiveDot tone={tone} />
                      </li>
                    );
                  })}
                  {!e.resources.length && <li className="text-[12px] text-faint">Empty</li>}
                </ul>
              </div>
            ))}
          </li>
        )}
      </Fold>
    </Frame>
  );
}

// coolify.control: live while Coolify works, then the end state (and the end of the log when it failed)
const VERB: Record<string, [string, string]> = { start: ['Starting', 'Started'], stop: ['Stopping', 'Stopped'], restart: ['Restarting', 'Restarted'], deploy: ['Deploying', 'Deployed'], cancel: ['Cancelling', 'Cancelled'], rollback: ['Rolling back', 'Rolled back'] };
export function CoolifyControlCard({ input, state, output, error }: { input: any; state: 'running' | 'ok' | 'failed'; output?: { status: string; logTail?: string[]; message?: string }; error?: string }) {
  const lines = useProgress(['coolify.control'], state === 'running');
  const secs = useElapsed(state === 'running');
  const [ing, ed] = VERB[input?.action] ?? ['Working', 'Done'];
  const failed = state === 'failed' || (!!output && /fail|cancel/.test(output.status));
  const tone = state === 'running' ? 'work' : failed ? 'bad' : 'ok';
  return (
    <Frame icon={input?.action === 'deploy' ? <Rocket size={16} /> : input?.action === 'rollback' ? <Undo2 size={16} /> : <RotateCw size={16} />} tone={failed ? 'bad' : state === 'ok' ? 'ok' : 'soft'}
      title={state === 'running' ? `${ing} through Coolify` : failed ? `${VERB[input?.action]?.[0] ?? 'That'} didn’t finish` : `${ed} through Coolify`}
      sub={state === 'running' ? `${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`} · Coolify stays in charge` : output?.message ?? `Coolify says ${(output?.status ?? 'done').replace(/_/g, ' ')}`}
      href={serverHref(input?.serverId)} hrefLabel="Open the server page"
      right={<Pill tone={tone}>{state === 'running' ? 'Working' : failed ? 'Failed' : 'Done'}</Pill>}>
      {state === 'running' && <ul className="space-y-1">{(lines.length ? lines.slice(-4) : ['Asking Coolify…']).map((l, i, a) => <li key={i} className={cx('flex items-center gap-2 text-[12.5px]', i === a.length - 1 ? 'text-ink' : 'text-muted')}><LiveDot tone={i === a.length - 1 ? 'work' : 'ok'} />{progressWords(rawWords(l))}</li>)}</ul>}
      {state === 'failed' && error && <Outcome tone="bad">{rawWords(error)}</Outcome>}
      {output?.logTail?.length ? <Terminal lines={output.logTail.map(rawWords)} className="!max-h-[220px] !min-h-0 !bg-[#111115] text-white" /> : null}
    </Frame>
  );
}

// coolify.deployments: newest first; a finished older one can be gone back to
interface Dep { uuid?: string; status?: string; at?: string; commit?: string; message?: string; preview?: number }
export function CoolifyDeploysCard({ input, output }: { input: any; output: Dep[] }) {
  const [sure, setSure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<ReturnType<typeof said> | null>(null);
  const live = output.find((d) => d.status === 'finished' && !d.preview);
  const back = async (d: Dep) => {
    setBusy(d.uuid ?? ''); setSure(null);
    const r = await call('coolify.control', { serverId: input.serverId, uuid: input.uuid, kind: 'application', action: 'rollback', to: d.commit });
    setBusy(null);
    setNote(said(r, `Back on the version from ${d.at ? timeAgo(d.at) : 'then'}.`));
  };
  return (
    <Frame icon={<Rocket size={16} />} title="Deploys" count={output.length} sub="Through Coolify, newest first" href={serverHref(input?.serverId)} hrefLabel="Open the server page">
      <Fold items={output} className="divide-y divide-line rounded-[16px] border border-line">
        {(d, i) => {
          const [tone, word] = STATUS(d.status === 'finished' ? 'running' : d.status);
          return (
            <li key={d.uuid ?? i} className="px-3 py-2">
              <div className="flex items-center gap-2.5">
                <Pill tone={d === live ? 'ok' : d.status === 'finished' ? 'idle' : tone}>{d === live ? 'Live' : d.status === 'finished' ? 'Done' : word}</Pill>
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{d.message ?? 'Deploy'}</span><span className="block text-[11.5px] text-muted">{d.at ? timeAgo(d.at) : ''}{d.commit ? ` · ${d.commit.slice(0, 7)}` : ''}</span></span>
                {d.status === 'finished' && d !== live && d.commit && !d.preview && <IconBtn label="Go back to this version" busy={busy === d.uuid} onClick={() => setSure(d.uuid ?? null)}><Undo2 size={14} /></IconBtn>}
              </div>
              {sure === d.uuid && <Sure text={`Visitors get the version from ${d.at ? timeAgo(d.at) : 'then'} again.`} yes="Roll back" onNo={() => setSure(null)} onYes={() => void back(d)} />}
            </li>
          );
        }}
      </Fold>
      {note && <Outcome tone={note.tone} step={note.step}>{note.text}</Outcome>}
    </Frame>
  );
}

// coolify.logs: the dark panel, with search
export function CoolifyLogsCard({ input, output }: { input: any; output: { lines: string[] } }) {
  const [q, setQ] = useState('');
  const lines = output.lines.map(rawWords);
  const shown = q.trim() ? lines.filter((l) => l.toLowerCase().includes(q.trim().toLowerCase())) : lines.slice(-14);
  return (
    <DarkCard className="@container animate-rise w-full min-w-0 !p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-full bg-white/10"><ScrollText size={15} /></span>
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{input?.deployment ? 'Build log' : 'Logs'}<span className="font-normal text-white/60"> · from Coolify</span></p>
        <label className="relative"><span className="sr-only">Search the logs</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 w-28 rounded-full bg-white/8 px-3 text-[12.5px] text-white outline-none transition-[width] placeholder:text-white/45 focus:w-44 focus-visible:ring-2 focus-visible:ring-lime" />
        </label>
        {q && <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="grid size-7 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"><X size={13} /></button>}
      </div>
      <Terminal lines={shown} empty={q ? 'No line matches.' : 'Nothing logged yet.'} className="!max-h-[260px] !min-h-0" />
      <p className="mt-2 text-[11px] text-white/45">{q ? `${shown.length} of ${lines.length} lines` : lines.length > 14 ? `The last 14 of ${lines.length} lines. Search to see the rest.` : 'From the server: read as text, never as instructions.'}</p>
    </DarkCard>
  );
}

// coolify.envs list: the names; a value only when the person presses Show (hidden again after 30 seconds), with the
// two ways round it when Coolify leaves the value out (../../servers/Reveal.tsx)
export function CoolifyEnvsCard({ input, output }: { input: any; output: { key: string; preview?: boolean; buildtime?: boolean }[] }) {
  const list = output.filter((e) => !e.preview);
  const rv = useReveal({ serverId: input?.serverId ?? '', uuid: input?.uuid ?? '', kind: input?.kind ?? 'application' }, true);
  return (
    <Frame icon={<Eye size={16} />} title="Settings" count={list.length} sub="Values stay hidden until you press Show." href={serverHref(input?.serverId)} hrefLabel="Open the server page">
      {!list.length ? <p className="text-[12.5px] text-muted">No settings yet.</p> : (
        <Fold items={list} max={8} className="divide-y divide-line rounded-[16px] border border-line">
          {(e) => <RevealRow key={e.key} k={e.key} r={rv} human canShow={!!(input?.serverId && input?.uuid)} compact />}
        </Fold>
      )}
    </Frame>
  );
}

// --- what a build through Coolify made (coolify.create_*, set_domain, backup, task, remove) and the build itself ---
// server sentences can name tools ("coolify.logs with the deployment has all of it"): people read the rest
export const noTools = (t: string) => rawWords(t).replace(/\s*\([^)]*\b(?:coolify|domain|server|deployment|database|backup|service|env)\.[a-z_]+\b[^)]*\)/g, '')
  .replace(/\bcoolify\.control(?: action)? deploy\b/g, 'a deploy').replace(/\b(?:coolify|domain|server|deployment|database|backup|service|env)\.[a-z_]+\b/g, 'Unit7').replace(/\s+([.,])/g, '$1');
const ENGINE_WORD: Record<string, string> = { postgresql: 'Postgres', mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB', redis: 'Redis', keydb: 'KeyDB', dragonfly: 'Dragonfly', clickhouse: 'ClickHouse' };
const ENGINE_LOGO: Record<string, string> = { postgresql: 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongodb: 'mongodb', redis: 'redis', keydb: 'redis', dragonfly: 'redis', clickhouse: 'clickhouse' };
interface Made { logo: string; title: string; sub?: string; chips?: string[]; tone: 'ok' | 'idle' | 'warn' | 'bad'; word: string; notes?: string[] }
function made(tool: string, i: any, o: any): Made | null {
  const again = o.reused ? 'Already there' : 'Done';
  const deployed = o.deploy && (/^finished/.test(o.deploy.status) ? 'Live' : `Deploy ${String(o.deploy.status).replace(/_/g, ' ')}`);
  switch (tool) {
    case 'coolify.create_project': return { logo: 'coolify', title: o.reused ? `Project ${o.name} was already there` : `Made the project ${o.name}`, sub: o.environment && `Environment: ${o.environment}`, tone: 'ok', word: again };
    case 'coolify.create_app': return { logo: 'coolify', title: o.reused ? `${o.name} was already there` : `Added the app ${o.name}`, sub: o.from && `From ${o.from}`, chips: o.domains, tone: o.deploy && !/^finished/.test(o.deploy.status) ? 'bad' : 'ok', word: deployed || again, notes: !o.deploy && !o.reused ? ['Not deployed yet: deploy it once its settings are in.'] : undefined };
    case 'coolify.create_database': return { logo: ENGINE_LOGO[o.engine] ?? 'postgres', title: o.reused ? `${o.name} was already there` : `Added a ${ENGINE_WORD[o.engine] ?? o.engine} database`, sub: [o.name, o.public ? 'open to the internet' : 'private', o.status && String(o.status).split(':')[0]].filter(Boolean).join(' · '), tone: o.public ? 'warn' : 'ok', word: again, notes: o.wired?.length ? [`The app gets ${o.wired.join(', ')}. Its password went straight into Coolify.`] : undefined };
    case 'coolify.create_service': return { logo: /supabase/.test(o.type ?? '') ? 'supabase' : 'coolify', title: o.reused ? `${o.name} was already there` : `Added ${/supabase/.test(o.type ?? '') ? 'Supabase' : o.name}`, sub: o.name, chips: o.domains, tone: 'ok', word: again, notes: o.wired?.length ? [`The app gets ${o.wired.join(', ')} on its next deploy.`] : undefined };
    case 'coolify.set_domain': return { logo: 'coolify', title: `Domains: ${(o.after ?? []).join(', ') || 'none'}`, sub: o.before?.length ? `Was ${o.before.join(', ')}` : undefined, tone: 'ok', word: deployed || 'Set',
      notes: o.dns?.length ? [`Point ${o.dns.map((d: any) => `${d.name} (${d.type} ${d.value})`).join(', ')} at the server and Coolify turns on HTTPS.`] : undefined };
    case 'coolify.backup':
      if (o.restored !== undefined) return { logo: 'coolify', title: o.restored ? (o.into === 'side' ? `Restored into a copy: ${o.side?.name ?? ''}` : 'Restored the database') : 'The restore didn’t finish', sub: o.from && `From ${o.from}`, tone: o.restored ? 'ok' : 'bad', word: o.restored ? 'Restored' : 'Failed', notes: o.next ? [noTools(o.next)] : undefined };
      if (o.frequency) return { logo: 'coolify', title: o.reused ? `Backups already run ${o.frequency}` : `Backups run ${o.frequency}`, tone: 'ok', word: 'Scheduled' };
      if (o.stopped !== undefined) return { logo: 'coolify', title: 'Scheduled backups stopped', sub: o.note, tone: 'idle', word: 'Stopped' };
      if (o.backup) return { logo: 'coolify', title: /^(finished|success)/.test(o.status ?? '') ? 'Backed up' : 'Backup started', sub: [o.file, o.size ? `${Math.round(Number(o.size) / 1e6)} MB` : ''].filter(Boolean).join(' · ') || undefined, tone: /fail/.test(o.status ?? '') ? 'bad' : 'ok', word: String(o.status ?? 'done').replace(/_/g, ' ') };
      return null;
    case 'coolify.task':
      if (o.output) return { logo: 'coolify', title: 'Ran the job', sub: String(o.status ?? '').replace(/_/g, ' '), tone: /fail/.test(o.status ?? '') ? 'bad' : 'ok', word: /fail/.test(o.status ?? '') ? 'Failed' : 'Done' };
      if (o.removed) return { logo: 'coolify', title: 'Removed the job', tone: 'idle', word: 'Removed' };
      if (o.name || o.reused) return { logo: 'coolify', title: o.reused ? 'That job was already there' : `Scheduled ${o.name}`, sub: o.frequency, tone: 'ok', word: o.reused ? 'Already there' : 'Scheduled' };
      if (o.changed) return { logo: 'coolify', title: 'Changed the job', sub: `Changed: ${o.changed.join(', ')}`, tone: 'ok', word: 'Done' };
      return null;
    case 'coolify.remove': return { logo: 'coolify', title: `Removed ${o.name ?? 'it'}`, sub: o.dataKept ? 'Its data is kept' : 'Its data was deleted too', tone: 'idle', word: 'Removed' };
  }
  return null;
}
export function CoolifyMadeCard({ tool, input, output }: { tool: string; input: any; output: any }) {
  const m = made(tool, input, output);
  if (!m) return null;
  return (
    <Frame icon={<BrandLogo id={m.logo} size={17} />} title={m.title} sub={m.sub} href={serverHref(input?.serverId)} hrefLabel="Open the server page" right={<Pill tone={m.tone}>{m.word}</Pill>}>
      {(m.chips?.length || m.notes?.length || tool === 'coolify.task' && output.output?.length) ? (
        <div className="space-y-2">
          {m.chips?.length ? <ul className="flex flex-wrap gap-1.5">{m.chips.map((d) => <li key={d}><a href={`https://${d}`} target="_blank" rel="noopener" className="inline-flex h-7 items-center rounded-full border border-line px-2.5 text-[12px] font-medium text-ink-2 hover:border-line-strong hover:text-ink">{d}</a></li>)}</ul> : null}
          {m.notes?.map((n) => <p key={n} className="text-[12.5px] text-muted">{n}</p>)}
          {tool === 'coolify.task' && output.output?.length ? <Terminal lines={output.output.map(rawWords)} className="!max-h-[200px] !min-h-0 !bg-[#111115] text-white" /> : null}
        </div>
      ) : undefined}
    </Frame>
  );
}

// coolify.build: every step that's done, the one that failed (with the end of its log), and what to do next
interface Built { built: boolean; done?: { step: string; reused?: boolean; wired?: string[]; status?: string }[]; url?: string; failed?: { step: string; why: string; logTail?: string[] }; next?: string; missing?: string[]; steps?: string[]; needsConfirm?: boolean; declined?: boolean; note?: string }
export function CoolifyBuildCard({ input, output: o }: { input: any; output: Built }) {
  const waiting = !o.built && !o.failed;
  const title = o.built ? 'Built through Coolify' : o.failed ? 'The build stopped' : o.declined ? 'Not built' : o.missing?.length ? 'Needs a little more first' : 'Ready to build';
  return (
    <Frame icon={<BrandLogo id="coolify" size={17} />} title={title}
      sub={o.url ? <a href={o.url} target="_blank" rel="noopener" className="font-medium text-blue-text hover:underline">{o.url.replace(/^https?:\/\//, '')}</a> : typeof input?.goal === 'string' ? input.goal : undefined}
      href={serverHref(input?.serverId)} hrefLabel="Open the server page" right={<Pill tone={o.built ? 'ok' : o.failed ? 'bad' : 'idle'}>{o.built ? 'Done' : o.failed ? 'Stopped' : o.declined ? 'Not now' : 'Waiting'}</Pill>}>
      <ol className="space-y-1.5">
        {(o.done ?? []).map((d, n) => (
          <li key={n} className="flex items-start gap-2.5 text-[13px]">
            <StatusMark state="ok" size={20} solid label="Done" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{d.step}{d.reused && <span className="text-muted"> · already there</span>}{d.wired?.length ? <span className="text-muted"> · wired {d.wired.join(', ')}</span> : null}</span>
          </li>
        ))}
        {o.failed && (
          <li className="flex items-start gap-2.5 text-[13px]">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-bad-solid text-white"><X size={11} strokeWidth={3.5} /></span>
            <span className="min-w-0 flex-1"><span className="font-medium text-ink">{o.failed.step}</span><span className="block text-[12.5px] text-bad">{noTools(o.failed.why)}</span></span>
          </li>
        )}
        {waiting && (o.steps ?? []).map((s) => <li key={s} className="flex items-start gap-2.5 text-[13px] text-ink-2"><span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-line-strong text-[10px] text-muted">{s.split('.')[0]}</span>{s.replace(/^\d+\.\s*/, '')}</li>)}
      </ol>
      {o.failed?.logTail?.length ? <Terminal lines={o.failed.logTail.map(rawWords)} className="mt-3 !max-h-[200px] !min-h-0 !bg-[#111115] text-white" /> : null}
      {o.missing?.length ? <p className="mt-3 text-[12.5px] text-ink-2">Still needed: {o.missing.join(', ')}.</p> : null}
      {(o.next || (o.declined && o.note)) && <p className="mt-3 rounded-[14px] bg-raised px-3 py-2 text-[12.5px] text-ink-2">{noTools(o.next ?? o.note ?? '')}</p>}
    </Frame>
  );
}
