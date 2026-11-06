import { useEffect, useState } from 'react';
import { RotateCcw, RefreshCw, Rocket, Square, Trash2, Globe, ScrollText, BarChart3, History, Settings2, Bug, DatabaseBackup, Check, AlertTriangle, ArrowUpRight, Loader2, Clock, CircleDot, FolderOpen, ChevronDown, HardDrive } from 'lucide-react';
import { api, runTool, useApi, onLive } from '../lib/api';
import { navigate } from '../lib/router';
import { BrandLogo, providerName } from '../brand/BrandLogo';
import { A, act, AiButton, Badge, Button, Card, CardHeader, ChipSelect, CopyButton, Dialog, Empty, Field, IconCircle, Input, Skeleton, toast, cx, StatusMark } from '../ui';
import { BarChart, DarkCard, DarkChip, dnsOf, hourBars, isDb, kindWord, LogoTile, mainDomain, Menu, reach, since, stackLogo, svcState, Terminal, urlOf, type MenuItem, ago } from './kit';
import { AskButton } from './Help';
import { whoWords } from '../lib/words';
import { Timeline } from './story';
import { StagingButton } from './make/Staging';
import { FleetCard, StandbyPanel } from './fleet';
import { HowReleases, ProofChip, ReleaseTimeline, lastDeploysLine } from './release';
import { ReleaseChecks } from './safety';
import { UpdatesCard } from './fresh'; // keep it fresh: the app's Updates card
import { EnvSwitcher } from './envs/EnvSwitcher';
import { plainError } from '../lib/words';
import { showDetails } from '../ui';

export function ServiceDetail({ projectId, id }: { projectId: string; id: string }) {
  const [data, setData] = useState<any>(null);
  const graph = useApi<any>(`/api/graph?projectId=${projectId}`, { live: false });
  const load = async () => { const r = await api('/api/tools/service.get', { body: { input: { serviceId: id } } }); setData(r.status === 'ok' ? r.output : { error: r.status === 'error' ? r.error.message : 'Not found' }); };
  // (a release's live steps update its own timeline, not the whole page)
  useEffect(() => { void load(); const off = onLive((e) => { if (e.type !== 'deployment.step' && (e.data?.serviceId === id || e.type.startsWith('deployment.') || e.type.startsWith('service.'))) void load(); }); return off; }, [id]);
  // which log the dark panel shows: live output, or one deploy's build log
  const [logOf, setLogOf] = useState<{ id: string; number: number } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [offline, setOffline] = useState(false);
  useEffect(() => { if (data && !data.error && location.hash === '#logs') requestAnimationFrame(() => document.getElementById('logs')?.scrollIntoView({ behavior: 'smooth' })); }, [!!data]);
  if (!data) return <div className="space-y-4"><Skeleton className="h-[260px] rounded-[24px]" /><div className="grid grid-cols-1 gap-4 lg:grid-cols-12"><Skeleton className="h-[320px] rounded-[24px] lg:col-span-5" /><Skeleton className="h-[320px] rounded-[24px] lg:col-span-7" /></div></div>;
  if (data.error) return <Empty title="App not found" body={data.error} action={<A href={`/projects/${projectId}`} className="font-medium text-blue-text hover:underline">Back to the project</A>} />;

  const db = isDb(data.kind);
  const project = graph.data?.projects[0];
  const env = project?.environments.find((e: any) => e.services.some((s: any) => s.id === id));
  const me = env?.services.find((s: any) => s.id === id);
  const server = graph.data?.servers.find((s: any) => s.id === data.serverId);
  const showLog = (d: { id: string; number: number }) => { setLogOf(d); requestAnimationFrame(() => document.getElementById('logs')?.scrollIntoView({ behavior: 'smooth' })); };

  return (
    <>
      <Hero data={data} project={project} env={env} server={server} offline={offline} onRemove={() => setRemoving(true)} onChange={load} />
      {/* this app in Production · Staging · Development: a segment opens the same app there */}
      {project && me && (project.environments?.length ?? 0) > 0 && (
        <EnvSwitcher project={project} envId={env?.id} appSlug={me.slug} className="mb-4 animate-rise" onChanged={() => { graph.reload(); void load(); }}
          onSelect={(e) => { const twin = (e.services ?? []).find((x: any) => x.slug === me.slug); navigate(twin ? `/projects/${projectId}/services/${twin.id}?env=${e.id}` : `/projects/${projectId}?env=${e.id}`); }} />
      )}
      <div className="stagger grid grid-cols-1 gap-4 lg:grid-cols-12">
        {db ? <Backups data={data} onChange={load} className="self-start lg:col-span-5" /> : <Deployments data={data} onLog={showLog} className="lg:col-span-5" />}
        <Metrics server={server} serverId={data.serverId} onReach={(ok) => setOffline(!ok)} className="lg:col-span-7" />
        <Timeline serviceId={id} title={`What changed on ${data.name}`} className="lg:col-span-12" />
        {!db && data.current && <FleetCard serviceId={id} className="lg:col-span-12" />}
        {!db && data.current && data.kind !== 'worker' && <StandbyPanel serviceId={id} name={data.name} className="lg:col-span-12" />}
        {!db && <Errors serviceId={id} name={data.name} />}
        <Logs serviceId={id} data={data} server={server} logOf={logOf} setLogOf={setLogOf} />
        <Settings data={data} db={db} server={server} onChange={load} className={db ? 'lg:col-span-12' : 'lg:col-span-7'} />
        {!db && (
          <div className="space-y-4 self-start lg:col-span-5">
            {data.current && <UpdatesCard serviceId={id} />}
            <Domains serviceId={id} dns={dnsOf(env)} />
            {data.release && <HowReleases serviceId={id} worker={data.kind === 'worker'} cfg={data.release} onChange={load} />}
          </div>
        )}
      </div>
      <RemoveDialog open={removing} onClose={() => setRemoving(false)} data={data} db={db} projectId={projectId} />
    </>
  );
}

// --- the big state, how long it's been up, where it lives ---
function Hero({ data, project, env, server, offline, onRemove, onChange }: { data: any; project: any; env: any; server: any; offline: boolean; onRemove: () => void; onChange: () => void }) {
  const db = isDb(data.kind);
  const st = svcState(data);
  const logo = stackLogo(data);
  const domain = mainDomain([data]);
  const previous = data.deployments?.find((d: any) => d.id !== data.current?.id && d.status !== 'failed' && d.status !== 'building');
  const up = st.tone === 'ok' ? since(data.current?.finished_at ?? data.current?.started_at) : null;
  const menu: MenuItem[] = [
    ...(!db && previous ? [{ label: `Go back to v${previous.number}`, icon: <RotateCcw size={16} />, onSelect: () => void act('deployment.rollback', { serviceId: data.id, deploymentId: previous.id }, { success: `Back on v${previous.number}` }) }] : []),
    ...(project ? [{ label: `Open ${project.name}`, icon: <ArrowUpRight size={16} />, href: `/projects/${project.id}` }] : []),
    { section: 'Danger zone' },
    ...(!db ? [{ label: 'Stop it', hint: 'Takes it offline until you deploy again', icon: <Square size={16} />, onSelect: () => void act('service.stop', { serviceId: data.id }, { success: 'Stopped' }).then(onChange) }] : []),
    { label: `Remove ${data.name}`, icon: <Trash2 size={16} />, danger: true, onSelect: onRemove },
  ];
  const big = { ok: 'text-ink', bad: 'text-bad', work: 'text-blue-text', warn: 'text-warn', idle: 'text-ink-2' }[st.tone];
  return (
    <Card className="mb-4 animate-rise">
      <div className="flex flex-wrap items-start gap-4 p-5 md:p-7">
        <LogoTile id={logo} size={64} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] text-muted">
            {project ? <A href={`/projects/${project.id}`} className="hover:text-ink hover:underline">{project.name}</A> : 'Project'}{env && <> <span aria-hidden>/</span> {env.name}</>}
          </p>
          <h1 className="truncate text-[30px] font-semibold leading-tight tracking-[-0.04em] md:text-[36px]">{data.name}</h1>
          <p className="mt-0.5 text-[13.5px] text-muted">{kindWord(data.kind)} · {providerName(logo)}{server && <> · on <A href={`/servers/${server.id}`} className="text-ink-2 hover:underline">{server.name}</A></>}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {db ? <Button variant="primary" icon={<DatabaseBackup size={15} />} onClick={() => act('backup.create', { serviceId: data.id, reason: 'manual' }, { success: 'Backed up' })}>Back up now</Button> : (
            <>
              <Button variant="primary" icon={<Rocket size={15} />} onClick={() => act('deployment.create', { serviceId: data.id }, { success: 'Deploy started' })}>Deploy</Button>
              <Button variant="dark" icon={<RefreshCw size={15} />} disabled={!data.current} onClick={() => act('service.restart', { serviceId: data.id }, { success: 'Restarted' })}>Restart</Button>
              {project && env?.kind === 'production' && <StagingButton target={{ projectId: project.id, name: project.name }} />}
            </>
          )}
          <Menu label={`More for ${data.name}`} items={menu} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-b-[23px] border-t border-line bg-line lg:grid-cols-3">
        <div className="bg-surface px-5 py-5 md:px-7">
          <dt className="text-[12.5px] text-muted">Status</dt>
          <dd className={cx('mt-1 flex items-center gap-3 text-[34px] font-semibold leading-none tracking-[-0.045em] lg:text-[40px]', big)}>
            <StatusMark state={offline ? 'off' : st.tone === 'ok' ? 'live' : st.tone === 'bad' || st.tone === 'warn' || st.tone === 'work' ? st.tone : 'off'} size={30} label={st.word} />
            {st.word}
          </dd>
          {offline && <p className="mt-1.5 text-[12.5px] text-muted">At the last check, {ago(server?.facts?.checkedAt ?? server?.last_seen_at)}. {server?.name ?? 'Its server'} isn’t answering now.</p>}
          {/* a bad status always comes with the way out */}
          {st.tone === 'bad' && (
            <div className="mt-3 flex flex-wrap gap-2">
              {!db && previous && <Button size="sm" variant="dark" icon={<RotateCcw size={13} />} onClick={() => void act('deployment.rollback', { serviceId: data.id, deploymentId: previous.id }, { success: `Back on v${previous.number}` }).then(onChange)}>Go back to v{previous.number}</Button>}
              <AskButton variant="primary" about={{ kind: db ? 'database' : 'app', id: data.id, name: data.name }} prompt={`${data.name}${project ? ` in ${project.name}` : ''} is ${st.word.toLowerCase()}. Find out why and fix it, and tell me what changes first.`} />
            </div>
          )}
        </div>
        <div className="bg-surface px-5 py-5 md:px-7">
          <dt className="text-[12.5px] text-muted">{db ? 'Copies' : 'Up for'}</dt>
          <dd className="tabular mt-1 text-[34px] font-semibold leading-none tracking-[-0.045em] lg:text-[40px]">{db ? data.replicas ?? 1 : up ?? '—'}</dd>
          <p className="mt-1.5 text-[12.5px] text-muted">{db ? 'Backed up before risky changes' : data.current ? `since v${data.current.number} went live${offline ? ', at the last check' : ''}` : 'Not deployed yet'}</p>
        </div>
        <div className="col-span-2 min-w-0 bg-surface px-5 py-5 md:px-7 lg:col-span-1">
          <dt className="text-[12.5px] text-muted">Address</dt>
          {domain ? (
            <dd className="mt-1.5 flex min-w-0 items-center gap-1">
              <a href={urlOf(domain)} target="_blank" rel="noopener" className="truncate text-[18px] font-semibold tracking-[-0.02em] text-blue-text hover:underline">{domain.hostname}</a>
              <CopyButton text={urlOf(domain)} />
            </dd>
          ) : <dd className="mt-1.5 text-[15px] text-muted">{db ? 'Private to your apps' : 'None yet'}</dd>}
          {data.domains?.length > 1 && <p className="mt-1 text-[12.5px] text-muted">+{data.domains.length - 1} more</p>}
        </div>
      </dl>
    </Card>
  );
}

// --- deploys, newest first, each one a step back away ---
function Deployments({ data, onLog, className }: { data: any; onLog: (d: { id: string; number: number }) => void; className?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const deps: any[] = data.deployments ?? [];
  const back = async (d: any) => { setBusy(d.id); await act('deployment.rollback', { serviceId: data.id, deploymentId: d.id }, { success: `Back on v${d.number}` }); setBusy(null); };
  // the release timeline of one deploy opens under it; the newest opens by itself while it runs, is watched, or just finished
  const fresh = deps[0] && (deps[0].status === 'building' || deps[0].status === 'deploying' || data.release?.watching || Date.now() - Date.parse(deps[0].finished_at ?? deps[0].started_at) < 15 * 60_000);
  const [open, setOpen] = useState<string | null>(fresh ? deps[0].id : null);
  useEffect(() => { if (fresh) setOpen(deps[0].id); }, [deps[0]?.id]); // a deploy that starts while the page is open
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<History size={19} />} title="Deployments" sub={lastDeploysLine(data.release?.proof) ?? (deps.length ? `The last ${deps.length}` : 'None yet')} />
      {data.safety && <ReleaseChecks serviceId={data.id} safety={data.safety} className="mt-4" />}
      {!deps.length ? <p className="mt-5 rounded-[16px] bg-raised px-4 py-6 text-center text-[13.5px] text-muted">Nothing deployed yet. Press Deploy and it shows up here.</p> : (
        <ol className="relative mt-5 space-y-1 before:absolute before:bottom-5 before:left-[23px] before:top-5 before:w-px before:bg-line-strong">
          {deps.map((d) => {
            const current = d.id === data.current?.id;
            const failed = d.status === 'failed';
            const working = d.status === 'building' || d.status === 'deploying';
            const proof = d.downtime_seconds != null ? { measured: true, downtimeSeconds: d.downtime_seconds, failed: d.failed_requests, requests: d.proof_requests ?? undefined } : d.proof_measured === 0 ? { measured: false, why: d.proof_why ?? undefined } : null;
            return (
              <li key={d.id} className="relative">
              <div className={cx('relative flex items-start gap-3 rounded-[18px] p-2.5 transition-colors', current ? 'bg-blue-soft' : 'hover:bg-raised')}>
                <span className={cx('relative z-10 grid size-7 shrink-0 place-items-center rounded-full ring-4', current ? 'bg-blue text-white ring-[color-mix(in_srgb,var(--blue)_10%,var(--surface))]' : failed ? 'bg-bad-solid text-white ring-surface' : working ? 'bg-lime text-lime-ink ring-surface' : 'bg-raised text-muted ring-surface')}>
                  {current ? <Check size={14} strokeWidth={3} /> : failed ? <AlertTriangle size={13} /> : working ? <Loader2 size={13} className="animate-spin" /> : <CircleDot size={13} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="tabular text-[14px] font-semibold">v{d.number}</span>
                    {current ? <Badge tone="info" solid>Live now</Badge> : failed ? <Badge tone="bad">Didn’t work</Badge> : working ? <Badge tone="lime">Deploying</Badge> : null}
                    <span className="text-[12.5px] text-muted">{ago(d.finished_at ?? d.started_at)}</span>
                  </p>
                  <p className="truncate text-[12.5px] text-muted">by {d.triggered_by ? whoWords(d.triggered_by) : 'someone'}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    {proof && <ProofChip proof={proof} />}
                    {(d.first_step || working) && <button type="button" onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id}
                      className="inline-flex h-6 items-center gap-0.5 rounded-full px-2 text-[11.5px] font-medium text-muted transition hover:bg-surface hover:text-ink">
                      {open === d.id ? 'Hide steps' : 'Steps'}<ChevronDown size={12} className={cx('transition-transform', open === d.id && 'rotate-180')} />
                    </button>}
                  </p>
                  {d.error && <p className="mt-1 text-[12.5px] text-bad"><span className="line-clamp-2">{plainError(d.error).line}</span>{plainError(d.error).more && <button type="button" onClick={() => showDetails(`Deploy v${d.number} of ${data.name}`, d.error)} className="font-medium text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">Show details</button>}</p>}
                  {failed && <AskButton className="mt-2" label="Ask why" prompt={`Deploy v${d.number} of ${data.name} didn’t work${d.error ? `: ${plainError(d.error).line}` : ''}. Read its build log, tell me why in plain words, and fix it.`} />}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!current && !failed && !working && <Button size="sm" variant="soft" icon={<RotateCcw size={13} />} loading={busy === d.id} disabled={!!busy} onClick={() => back(d)}>Roll back to this</Button>}
                  <button type="button" aria-label={`Build log of v${d.number}`} title="Build log" onClick={() => onLog({ id: d.id, number: d.number })}
                    className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-ink"><ScrollText size={15} /></button>
                </div>
              </div>
              {open === d.id && <div className="animate-rise relative z-10 mb-1 ml-[46px] mr-1 mt-1 rounded-[16px] border border-line bg-surface p-3"><ReleaseTimeline deploymentId={d.id} /></div>}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

// --- CPU & memory, from the server it runs on ---
function Metrics({ server, serverId, onReach, className }: { server?: any; serverId?: string; onReach: (ok: boolean) => void; className?: string }) {
  const [metric, setMetric] = useState<'cpu' | 'mem'>('cpu');
  const [res, setRes] = useState<{ history: any[] | null; err?: string } | null>(null);
  useEffect(() => {
    if (!serverId) { setRes({ history: null, err: 'It isn’t on a server yet.' }); return; }
    void runTool('server.metrics', { serverId }).then((r) => (onReach(r.status !== 'error'), setRes(r.status === 'ok' ? { history: r.output.history } : { history: null, err: r.status === 'error' ? reach(r.error.message, server?.name) : 'Not allowed to read this server.' })));
  }, [serverId]);
  return (
    <Card className={cx('flex flex-col p-5 md:p-6', className)}>
      <CardHeader icon={<BarChart3 size={19} />} title="CPU & memory" sub={server ? `Last hour on ${server.name}` : 'Last hour'}
        actions={<ChipSelect label="Show" value={metric} onChange={(v) => setMetric(v as 'cpu' | 'mem')} options={[{ value: 'cpu', label: 'CPU' }, { value: 'mem', label: 'Memory' }]} />} />
      <div className="mt-7 flex-1">
        {!res ? <Skeleton className="h-[230px]" /> : (
          <BarChart name={metric === 'cpu' ? 'CPU' : 'Memory'} points={hourBars(res.history, metric)} height={210}
            empty={<><span className="font-medium text-ink">No numbers yet.</span> {res.err ?? 'They show up within a few minutes.'}</>} />
        )}
      </div>
    </Card>
  );
}

// errors from the logs, grouped, each with a fix one click away. Hidden when there are none.
function Errors({ serviceId, name }: { serviceId: string; name: string }) {
  const [groups, setGroups] = useState<any[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = async () => { const r = await runTool('errors.list', { serviceId }); setGroups(r.status === 'ok' ? (r.output as any[]) : []); };
  useEffect(() => { void load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [serviceId]);
  if (!groups?.length) return null;
  const ask = async (g: any) => {
    const prompt = `/unit7 fix this error in ${name}: ${g.kind}: ${g.message}${g.frame ? ` (at ${g.frame})` : ''}. Find the cause in the code, fix it, and redeploy.\n\nStack trace:\n${String(g.sample).slice(0, 1500)}`;
    try { await navigator.clipboard.writeText(prompt); toast('ok', 'Copied. Paste it into Claude Code', 'Or into whichever AI you connected.'); } catch { toast('info', 'Paste this into your AI', prompt); }
  };
  return (
    <Card className="p-5 md:p-6 lg:col-span-12">
      <CardHeader icon={<Bug size={19} />} tone="bad" title="Errors" sub={`${groups.length} kind${groups.length === 1 ? '' : 's'} of error in the logs`} />
      <ul className="mt-4 divide-y divide-line">
        {groups.map((g) => (
          <li key={g.id} className="py-3">
            <div className="flex flex-wrap items-start gap-3">
              {/* how often in all, first; the last hour only when it's still happening */}
              <span className={cx('tabular mt-0.5 rounded-full px-2 py-0.5 text-[12px] font-semibold', g.lastHour >= 20 ? 'bg-bad-solid text-white' : g.lastHour > 0 ? 'bg-warn/15 text-warn' : 'bg-raised text-muted')}>{g.total} in total</span>
              <button onClick={() => setOpen(open === g.id ? null : g.id)} aria-expanded={open === g.id} className="min-w-0 flex-1 text-left">
                <p className="text-[13.5px] font-medium text-ink">{g.message}</p>
                <p className="truncate text-[12.5px] text-muted">last {ago(g.lastSeen)}{g.lastHour > 0 ? ` · ${g.lastHour} in the last hour` : ''} · <span className="font-mono">{g.kind}</span>{g.frame && <> in {g.frame}</>}{g.firstDeploy ? ` · since v${g.firstDeploy}` : ''}</p>
              </button>
              <div className="flex shrink-0 gap-1.5">
                <AiButton size="sm" strong onClick={() => ask(g)}>Fix it with my AI</AiButton>
                <Button size="sm" variant="soft" onClick={async () => { if (await act('errors.resolve', { groupId: g.id }, { success: 'Marked fixed' })) void load(); }}>Mark fixed</Button>
              </div>
            </div>
            {open === g.id && <pre className="mt-3 max-h-72 overflow-auto rounded-[16px] bg-[#111115] p-4 font-mono text-[11.5px] leading-relaxed text-white/80">{g.sample}</pre>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- the dark log panel: live output, or a deploy's build log ---
function Logs({ serviceId, data, server, logOf, setLogOf }: { serviceId: string; data: any; server?: any; logOf: { id: string; number: number } | null; setLogOf: (d: { id: string; number: number } | null) => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    const r = await runTool('deployment.logs', logOf ? { deploymentId: logOf.id } : { serviceId, lines: 300 }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setLoading(false);
    setFailed(r.status !== 'ok');
    if (r.status === 'ok') setLines(r.output.lines.length ? [...r.output.lines, ...(r.output.error ? [r.output.error] : [])] : [isDb(data.kind) ? 'Nothing to show yet.' : r.output.note ?? 'No output yet.']);
    else setLines([`# ${r.status === 'error' ? reach(r.error.message, server?.name) : 'Not allowed to read these logs.'}`, ...(data.current ? [`# The build log of v${data.current.number} is one click away, top right.`] : [])]);
  };
  useEffect(() => { setLines(null); void load(); }, [serviceId, logOf?.id]);
  // live output refreshes every 5s while it works and the page is on screen; after an error only Refresh asks again
  useEffect(() => {
    if (failed || logOf) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000);
    return () => clearInterval(t);
  }, [serviceId, failed, logOf?.id]);
  const build = logOf ?? (data.current ? { id: data.current.id, number: data.current.number } : null);
  return (
    <DarkCard id="logs" className="scroll-mt-24 lg:col-span-12">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="grid size-11 place-items-center rounded-full bg-white/10"><ScrollText size={19} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16.5px] font-medium tracking-[-0.015em]">Logs</h2>
          <p className="text-[12.5px] text-white/60">{logOf ? `What happened while v${logOf.number} was built` : isDb(data.kind) ? 'What the database is printing' : 'What your app is printing right now'}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
          <DarkChip on={!logOf} onClick={() => setLogOf(null)}><span className={cx('size-1.5 rounded-full', failed ? 'bg-current opacity-40' : 'animate-working bg-ok')} />Live</DarkChip>
          {build && <DarkChip on={!!logOf} onClick={() => setLogOf(build)}>Build v{build.number}</DarkChip>}
          <button type="button" aria-label="Refresh logs" onClick={load} className="grid size-8 place-items-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white focus-visible:outline-lime">
            <RefreshCw size={14} className={cx(loading && 'animate-spin')} />
          </button>
        </div>
      </div>
      <Terminal lines={lines} loading={loading && !!lines} />
    </DarkCard>
  );
}

function Switch({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 py-3">
      <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium text-ink">{label}</span><span className="block text-[12.5px] text-muted">{hint}</span></span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-blue' : 'bg-line-strong')}>
        <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </div>
  );
}

// --- settings: what it is, how it updates, how many copies run ---
function Settings({ data, db, server, onChange, className }: { data: any; db: boolean; server?: any; onChange: () => void; className?: string }) {
  const set = async (tool: string, input: object, success: string) => { if (await act(tool, { serviceId: data.id, ...input }, { success })) onChange(); };
  const src = data.source;
  const rows: [string, React.ReactNode][] = [
    ['Kind', kindWord(data.kind)],
    ['Built with', <span className="inline-flex items-center gap-1.5"><BrandLogo id={stackLogo(data)} size={15} />{providerName(stackLogo(data))}</span>],
    ['Code', src?.type === 'git' ? <span className="inline-flex min-w-0 items-center gap-1.5"><BrandLogo id="github" size={15} /><span className="truncate">{src.repo}{src.branch ? ` · ${src.branch}` : ''}</span></span> : src?.image ? <span className="inline-flex min-w-0 items-center gap-1.5"><BrandLogo id="docker" size={15} /><span className="truncate font-mono text-[12.5px]">{src.image}</span></span> : data.folder ? <span className="inline-flex min-w-0 items-center gap-1.5" title={data.folder}><FolderOpen size={15} aria-label="Folder on this computer" /><span className="truncate font-mono text-[12.5px]">{data.folder}</span></span> : '—'],
    ['Port', data.port ?? '—'],
    ['Server', server ? <A href={`/servers/${server.id}`} className="hover:underline">{server.name}</A> : '—'],
  ];
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<Settings2 size={19} />} title="Settings" />
      <dl className="mt-4 grid gap-x-6 gap-y-3 rounded-[18px] bg-raised p-4 text-[13.5px] sm:grid-cols-2">
        {rows.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-[12px] text-muted">{k}</dt><dd className="truncate font-medium">{v}</dd></div>)}
      </dl>
      {/* the files it keeps between deploys, in volumes Unit7 backs up (src/deploy/volumes.ts) */}
      {data.savedFiles?.words && <p className="mt-3 flex items-start gap-2 rounded-[14px] bg-raised px-4 py-2.5 text-[12.5px] text-muted"><HardDrive size={15} className="mt-px shrink-0 text-ink" aria-hidden="true" /><span className="min-w-0 break-words">{data.savedFiles.words}</span></p>}
      <div className="mt-2 divide-y divide-line">
        {src?.type === 'git' && <>
          <Switch label="Deploy every new commit" hint={`Unit7 checks ${src.branch ?? 'the main branch'} every minute.`} on={data.autoDeploy} onChange={(v) => set('service.settings', { autoDeploy: v }, v ? 'Push to deploy is on' : 'Push to deploy is off')} />
          <Switch label="A preview link for each pull request" hint="Same-repo PRs only. The link goes away when the PR closes." on={data.previews} onChange={(v) => set('service.settings', { previews: v }, v ? 'Previews are on' : 'Previews are off')} />
          <Switch label="Open a PR to fix risky packages" hint={data.fixPr ? `Open now: ${data.fixPr.url}` : 'When a scan finds a fixable problem, Unit7 updates the packages in a pull request.'} on={data.fixPrs} onChange={(v) => act('security.fix_settings', { serviceId: data.id, openPrs: v }, { success: v ? 'Fix PRs are on' : 'Fix PRs are off' }).then((r) => r && onChange())} />
          <Switch label="Merge that PR when its preview works" hint="Then push to deploy ships it. Off: you merge it yourself." on={data.mergeFixes} onChange={(v) => act('security.fix_settings', { serviceId: data.id, autoMerge: v }, { success: v ? 'Fixes merge themselves when green' : 'You merge fixes yourself' }).then((r) => r && onChange())} />
        </>}
        {/* ZD-SAFE: the test gate, shown once the code is known to have tests (turning it off is a person's choice) */}
        {!db && (data.safety?.hasTests || data.safety?.runTests === false) && (
          <Switch label="Run tests before deploying" hint="A failing test stops the deploy before anything changes. The tests never get this app’s secrets." on={data.safety.runTests}
            onChange={(v) => set('service.settings', { runTests: v }, v ? 'Tests run before each deploy' : 'Tests are off for this app')} />
        )}
        {!db && data.current && (data.scaleRisks?.length ? (
          <p className="py-3 text-[12.5px] text-muted">Runs as one copy: {data.scaleRisks.join('; ')}. Fix that (your AI can) and more copies become possible.</p>
        ) : (
          <>
            <Switch label={`Add copies when it’s busy (now ${data.replicas})`} hint={data.autoscale?.lastWhy ? `Last change: ${data.autoscale.lastWhy}` : 'Slow answers or a busy server add a copy; 30 calm minutes remove one.'} on={!!data.autoscale?.on}
              onChange={(v) => set('service.autoscale', { on: v, min: data.autoscale?.min ?? 1, max: data.autoscale?.max ?? 3 }, v ? 'Autoscaling is on' : 'Autoscaling is off')} />
            {data.autoscale?.on && (
              <div className="flex flex-wrap items-center gap-2 py-3 text-[13px] text-muted">
                Between
                <ChipSelect label="Fewest copies" value={String(data.autoscale.min)} onChange={(v) => set('service.autoscale', { on: true, min: Number(v), max: Math.max(Number(v), data.autoscale.max) }, 'Saved')} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))} />
                and
                <ChipSelect label="Most copies" value={String(data.autoscale.max)} onChange={(v) => set('service.autoscale', { on: true, min: Math.min(data.autoscale.min, Number(v)), max: Number(v) }, 'Saved')} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))} />
                copies
              </div>
            )}
          </>
        ))}
        {db && data.kind === 'postgres' && (
          <Switch label="Share connections (PgBouncer)" hint="For several app copies or workers. Apps using this database redeploy." on={!!data.pooled}
            onChange={(v) => act('database.pool', { serviceId: data.id, on: v }, { success: v ? 'Sharing on' : 'Sharing off' }).then((r) => r && onChange())} />
        )}
      </div>
    </Card>
  );
}

// --- custom domains ---
function Domains({ serviceId, dns, className }: { serviceId: string; dns?: string; className?: string }) {
  const [domains, setDomains] = useState<any[] | null>(null);
  const load = async () => { const r = await runTool('domain.list', { serviceId }); setDomains(r.status === 'ok' ? r.output : []); };
  useEffect(() => { void load(); }, [serviceId]);
  const [host, setHost] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<Globe size={19} />} title="Domains" sub="Where people find it" actions={<Button size="sm" variant="primary" icon={<Globe size={13} />} onClick={() => setOpen(true)}>Add</Button>} />
      {!domains ? <Skeleton className="mt-4 h-24" /> : !domains.length ? (
        <p className="mt-4 rounded-[16px] bg-raised px-4 py-5 text-[13px] text-muted">No custom domain yet. Add one and Unit7 sets up DNS and HTTPS.</p>
      ) : (
        <ul className="mt-4 space-y-1">
          {domains.map((d) => (
            <li key={d.id} className="-mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] px-2 py-2 hover:bg-raised">
              <LogoTile id={d.auto ? 'unit7' : dns} size={32}>{!d.auto && !dns && <Globe size={15} className="text-muted" />}</LogoTile>
              <div className="min-w-[150px] flex-1">
                <a href={urlOf(d)} target="_blank" rel="noopener" className="block truncate text-[13.5px] font-medium hover:underline">{d.hostname}</a>
                <p className="text-[12px] text-muted">{d.auto ? 'Instant link' : dns && d.status !== 'broken' ? `DNS at ${providerName(dns)} · ${d.tls === 'active' ? 'HTTPS on' : 'HTTPS on the way'}` : d.status === 'broken' ? 'Not pointing here' : d.tls === 'active' ? 'HTTPS on' : 'HTTPS on the way'}</p>
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {d.status === 'broken' ? <Badge tone="bad" solid>Broken</Badge> : d.tls === 'active' ? <Badge tone="ok">Working</Badge> : <Badge tone="warn">Setting up</Badge>}
                {d.status === 'broken' && <AskButton label="Fix" variant="primary" prompt={`${d.hostname} isn’t reaching this app. Find out why and fix it, and tell me what changes first.`} />}
                <Button size="sm" variant="ghost" title="Look at it again now" onClick={() => act('domain.check', { domainId: d.id }).then((r) => r && toast('info', r.output.note))}>Check</Button>
                {!d.auto && <button aria-label={`Remove ${d.hostname}`} title="Stop serving it here" onClick={() => { if (confirm(`Stop serving ${d.hostname} from Unit7? Its DNS record stays where it is, so adding it again undoes this.`)) void act('domain.remove', { domainId: d.id }, { success: `${d.hostname} removed` }).then(load); }} className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-bad"><Trash2 size={14} /></button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Add a domain">
        <form onSubmit={async (e) => { e.preventDefault(); const r = await act('domain.point', { hostname: host, serviceId }, { success: 'Domain added', open: { label: 'Open ↗', href: `https://${host}` } }); if (r) { toast('info', r.output.note); setOpen(false); setHost(''); void load(); } }} className="space-y-4">
          <Field label="Domain" hint="If your DNS is at Cloudflare or Hostinger and connected, Unit7 points it for you, then turns on HTTPS."><Input autoFocus required value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.example.com" /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary">Add it</Button></div>
        </form>
      </Dialog>
    </Card>
  );
}

// --- a database's backups: taken on its server, copied off it, proven to restore ---
function Backups({ data, onChange, className }: { data: any; onChange: () => void; className?: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => { const r = await runTool('backup.list', { serviceId: data.id }); setRows(r.status === 'ok' ? r.output : []); };
  useEffect(() => { void load(); return onLive((e) => { if (e.type.startsWith('backup.')) void load(); }); }, [data.id]);
  const doing = async (what: string, fn: () => Promise<unknown>) => { setBusy(what); try { await fn(); } finally { setBusy(null); void load(); onChange(); } };
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<DatabaseBackup size={19} />} title="Backups" sub="Copied off the server, checked weekly"
        actions={<Button size="sm" variant="soft" loading={busy === 'verify'} disabled={!rows?.length} onClick={() => doing('verify', async () => { const r = await act('backup.verify', { serviceId: data.id, offsite: !!rows?.[0]?.offsite && !String(rows[0].offsite).startsWith('failed') }); if (r) toast(r.output.ok ? 'ok' : 'bad', r.output.ok ? 'The backup restores' : 'The backup does NOT restore', r.output.note); })}>Test the latest</Button>} />
      {!rows ? <Skeleton className="mt-4 h-24" /> : !rows.length ? <p className="mt-4 rounded-[16px] bg-raised px-4 py-6 text-center text-[13px] text-muted">No backups yet. Unit7 also takes one before anything that could lose data.</p> : (
        <ul className="mt-4 space-y-1">
          {rows.map((b) => {
            const off = String(b.offsite ?? '');
            return (
              <li key={b.id} className="-mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] px-2 py-2.5 text-[13px] hover:bg-raised">
                <IconCircle size={30} tone={b.status === 'done' ? 'ok' : b.status === 'failed' ? 'bad' : 'soft'}>{b.status === 'done' ? <Check size={14} strokeWidth={3} /> : b.status === 'failed' ? <AlertTriangle size={13} /> : <Clock size={13} />}</IconCircle>
                <span className="font-medium">{ago(b.created_at)}</span>
                <span className="text-muted">{b.reason}</span>
                {b.size != null && <span className="text-faint">{(b.size / 1048576).toFixed(1)} MB</span>}
                {b.verified_at && <Badge tone={b.verify_ok ? 'ok' : 'bad'}>{b.verify_ok ? 'restores' : 'won’t restore'}</Badge>}
                <Badge tone={!b.offsite ? 'neutral' : off.startsWith('failed') ? 'bad' : 'ok'}>{!b.offsite ? 'on the server only' : off.startsWith('failed') ? 'copy failed' : `also on ${b.offsite}`}</Badge>
                {b.status === 'done' && (
                  <span className="ml-auto flex gap-1">
                    {off.startsWith('failed') && <Button size="sm" variant="ghost" onClick={() => doing(b.id, () => act('backup.offsite_copy', { backupId: b.id }, { success: 'Copied off the server' }))}>Retry copy</Button>}
                    <Button size="sm" variant="ghost" onClick={() => { if (confirm('Restore this backup? The database goes back to this point. Unit7 backs up what’s there now first.')) void doing(b.id, () => act('backup.restore', { backupId: b.id, confirm: true }, { success: 'Restored' })); }}>Restore</Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function RemoveDialog({ open, onClose, data, db, projectId }: { open: boolean; onClose: () => void; data: any; db: boolean; projectId: string }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await act('service.remove', { serviceId: data.id }, { success: `Removed ${data.name}` });
    setBusy(false);
    if (r) { onClose(); navigate(`/projects/${projectId}`); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Remove ${data.name}?`}>
      <p className="text-[13.5px] text-ink-2">{db ? 'Unit7 takes a final backup and keeps the data on the server, so you can bring it back.' : 'It goes offline and its address stops working. The variables in this environment stay.'}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={busy} icon={<Trash2 size={14} />} onClick={go}>Remove</Button>
      </div>
    </Dialog>
  );
}

