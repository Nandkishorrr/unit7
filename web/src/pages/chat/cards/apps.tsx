// Apps in the chat: a row per app with its logo, a live status pill, its address and quick actions (open
// the site, deploy, roll back, logs). A deploy shows its steps live while it runs, then its version and
// "Live at"; rolling back asks first, right there.
import { useState } from 'react';
import { AlertTriangle, ArrowUpRight, Box, Database, GitBranch, Loader2, Rocket, RotateCcw, ScrollText } from 'lucide-react';
import { BrandLogo, providerName } from '../../../brand/BrandLogo';
import { AiButton, Button, cx, Skeleton, timeAgo, StatusMark } from '../../../ui';
import { changeWords, rawWords } from '../../../lib/words';
import { navigate } from '../../../lib/router';
import { DarkCard, LogoTile, Terminal, isDb, mainDomain, stackLogo, svcState, urlOf } from '../../kit';
import { liveOf, type Asset } from '../../map/data';
import { Fold, Frame, IconBtn, LiveDot, Outcome, Pill, Sure, ask, call, openMap, refreshWorld, said, useElapsed, useLoad, useProgress, useWorld, type Svc, type World } from './kit';
import { bytes, deploySteps, host, secsWords, type Tone } from './shape';
import { ReleaseTimeline } from '../../release';
import { StepChoices } from '../StepChoices';

// --- one app, whatever told us about it ---
export interface AppItem { key: string; name: string; logo: string; url?: string | null; tone: Tone | 'work'; word: string; svc?: Svc; assetId?: string; where?: string }
const TONE = { ok: 'ok', bad: 'bad', work: 'work', warn: 'warn', idle: 'idle' } as const;
export function appOfSvc(s: Svc, w: World): AppItem {
  const st = svcState(s);
  const d = mainDomain([s]);
  return { key: s.id, name: w.svcLabel(s)!, logo: stackLogo(s), url: d ? urlOf(d) : null, tone: TONE[st.tone], word: st.word, svc: s, assetId: w.assetOf(s.id)?.id };
}
export function appOfAsset(a: Asset, w: World): AppItem {
  const s = a.end?.kind === 'unit7' ? w.svc(a.end.serviceId) : undefined;
  const live = liveOf(a);
  if (s) {
    const it = appOfSvc(s, w);
    // the outside check knows more than the app's own state: down from outside wins; up shows how fast
    return { ...it, url: a.url ?? it.url, assetId: a.id, ...(live?.tone === 'bad' ? { tone: 'bad' as const, word: live.text } : it.tone === 'ok' && a.site?.ms != null ? { word: `${it.word} · ${a.site.ms} ms` } : {}) };
  }
  return { key: a.id, name: w.label(a), logo: a.provider, url: a.url, tone: live?.tone ?? 'idle', word: live?.text ?? 'Not checked yet', assetId: a.id, where: providerName(a.provider) };
}

// deploy from a card: the run, its live steps, then the outcome
function useDeployRun(serviceId?: string) {
  const [run, setRun] = useState<{ state: 'running' | 'ok' | 'failed'; output?: any; error?: string } | null>(null);
  const [note, setNote] = useState<ReturnType<typeof said> | null>(null);
  const start = async () => {
    if (!serviceId) return;
    setNote(null); setRun({ state: 'running' });
    const r = await call('deployment.create', { serviceId });
    if (r.status === 'ok') setRun({ state: 'ok', output: r.output });
    else if (r.status === 'error') setRun({ state: 'failed', error: r.error.message });
    else { setRun(null); setNote(said(r, '')); }
    refreshWorld();
  };
  return { run, note, start };
}

function useRollback(serviceId?: string) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ReturnType<typeof said> | null>(null);
  const go = async (deploymentId?: string) => {
    setBusy(true);
    const r = await call('deployment.rollback', deploymentId ? { serviceId, deploymentId } : { serviceId });
    setBusy(false); setAsking(false);
    setNote(said(r, r.status === 'ok' ? `Back on v${(r.output as any).number}.${(r.output as any).warning ? ` ${(r.output as any).warning}` : ''}` : ''));
    refreshWorld();
  };
  return { asking, setAsking, busy, note, go };
}

function AppRow({ it }: { it: AppItem }) {
  const s = it.svc;
  const dep = useDeployRun(s?.id);
  const back = useRollback(s?.id);
  const deployable = !!s && !isDb(s.kind);
  return (
    <li className="rounded-[18px] border border-line bg-surface px-3 py-2.5 transition hover:border-line-strong">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 @md:flex-nowrap">
        <LogoTile id={it.logo} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold tracking-[-0.01em]">
            {s ? <button type="button" onClick={() => navigate(s.href)} className="truncate text-left hover:underline decoration-line-strong underline-offset-4">{it.name}</button>
              : it.assetId ? <button type="button" onClick={() => openMap(it.assetId!)} className="truncate text-left hover:underline decoration-line-strong underline-offset-4">{it.name}</button> : it.name}
          </p>
          <p className="truncate text-[12px] text-muted">
            {it.url ? <a href={it.url} target="_blank" rel="noopener" className="hover:text-ink hover:underline">{host(it.url)}</a> : s?.kind === 'worker' ? 'Works in the background' : 'No address yet'}
            {it.where && ` · ${it.where}`}
          </p>
        </div>
        <Pill tone={dep.run?.state === 'running' ? 'work' : it.tone} glow={it.tone === 'ok'}>{dep.run?.state === 'running' ? 'Deploying' : it.word}</Pill>
        <div className="flex shrink-0 items-center gap-1.5 @max-md:w-full @max-md:justify-end">
          {it.url && <IconBtn label={`Open ${host(it.url)}`} href={it.url} external><ArrowUpRight size={15} /></IconBtn>}
          {deployable && <IconBtn label={`Deploy ${s!.name}`} busy={dep.run?.state === 'running'} onClick={dep.start}><Rocket size={14} /></IconBtn>}
          {deployable && s!.current_deployment_id && <IconBtn label={`Roll back ${s!.name}`} danger onClick={() => back.setAsking(true)}><RotateCcw size={14} /></IconBtn>}
          {s && <IconBtn label={`Logs of ${s.name}`} href={`${s.href}#logs`}><ScrollText size={14} /></IconBtn>}
          {!s && it.assetId && <IconBtn label="Open in the map" onClick={() => openMap(it.assetId!)}><Box size={14} /></IconBtn>}
        </div>
      </div>
      {back.asking && <Sure text={changeWords('deployment.rollback', { serviceId: s?.id }, () => s?.name)} yes="Roll back" busy={back.busy} onYes={() => back.go()} onNo={() => back.setAsking(false)} />}
      {back.note && <Outcome tone={back.note.tone} step={back.note.step}>{back.note.text}</Outcome>}
      {dep.note && <Outcome tone={dep.note.tone} step={dep.note.step}>{dep.note.text}</Outcome>}
      {dep.run && <div className="mt-2.5"><DeployView serviceId={s!.id} {...dep.run} /></div>}
    </li>
  );
}

export function AppList({ items }: { items: AppItem[] }) {
  if (!items.length) return <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">No apps yet. Ask Unit7 to deploy one and it shows up here.</p>;
  return <Fold items={items} className="space-y-2">{(it) => <AppRow key={it.key} it={it} />}</Fold>;
}

// --- a deploy: its steps live while it runs; afterwards the version, where it's live, and a way back ---
// lines: progress lines when the caller already has them (otherwise they come live from tool.progress)
export function DeployView({ serviceId, state, output, error, lines, code }: { serviceId?: string; state: 'running' | 'ok' | 'failed'; output?: any; error?: string; lines?: string[]; code?: string }) {
  const w = useWorld();
  const s = w.svc(serviceId);
  const heard = useProgress(['deployment.create'], state === 'running' && !lines);
  const live = lines ?? heard;
  // finished: its own build log. Failed: the newest failed deploy's log, so the step it stopped at shows
  const logOf = async (): Promise<{ lines: string[] }> => {
    const id = state === 'ok' ? output?.deploymentId : await call('service.get', { serviceId }).then((r) => (r.status === 'ok' ? (r.output as any).deployments?.find((d: any) => d.status === 'failed')?.id : undefined));
    const r = id ? await call('deployment.logs', { deploymentId: id, lines: 400 }) : undefined;
    return r?.status === 'ok' ? r.output : { lines: [] };
  };
  const log = useLoad<{ lines: string[] }>(state === 'ok' && output?.deploymentId ? `log:${output.deploymentId}` : state === 'failed' && serviceId && !lines ? `failed:${serviceId}` : null, logOf);
  const secs = useElapsed(state === 'running');
  const logLines = (state === 'running' ? live : log.data?.lines ?? live).map(rawWords);
  // a failure with no log to show: just say what went wrong
  const steps = state === 'failed' && !logLines.length ? [] : deploySteps(logLines, state);
  const total = steps.reduce((n, x) => n + (x.secs ?? 0), 0);
  const back = useRollback(serviceId);
  const prev = output?.undo?.input?.deploymentId ?? output?.previousDeploymentId;
  return (
    <div className="rounded-[18px] bg-raised/70 p-3 @md:p-3.5">
      {/* the release timeline (Build → … → Done) when the deploy recorded it; the steps read from its log otherwise */}
      <ReleaseTimeline serviceId={serviceId} deploymentId={output?.deploymentId} running={state === 'running'} compact
        fallback={steps.length > 0 && <ol className="grid gap-1.5 @lg:grid-cols-[repeat(auto-fit,minmax(0,1fr))] @lg:gap-2">
        {steps.map((st, i) => (
          <li key={st.key} className={cx('flex min-w-0 items-start gap-2 @lg:flex-col @lg:items-stretch @lg:gap-1.5', st.state === 'todo' && 'opacity-55')}>
            <span className="flex items-center gap-2 @lg:w-full">
              {st.state === 'done' || st.state === 'failed' ? <StatusMark state={st.state === 'done' ? 'ok' : 'bad'} size={20} solid label={st.state === 'done' ? 'Done' : 'Failed'} /> : (
                <span className={cx('grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-300', st.state === 'active' ? 'bg-blue text-white' : 'border border-line-strong bg-surface')}>
                  {st.state === 'active' ? <Loader2 size={11} className="animate-spin" /> : null}
                </span>
              )}
              {i < steps.length - 1 && <span aria-hidden className={cx('hidden h-0.5 flex-1 rounded-full @lg:block', st.state === 'done' ? 'bg-ok/50' : 'bg-line-strong')} />}
            </span>
            <span className="min-w-0">
              <span className={cx('block text-[12.5px] font-medium leading-tight', st.state === 'active' ? 'text-ink' : 'text-ink-2')}>{st.label}</span>
              {st.secs != null && st.state === 'done' && <span className="tabular block text-[11.5px] text-muted">{secsWords(st.secs)}</span>}
              {st.detail && <span className="block truncate font-mono text-[11px] text-muted" title={st.detail}>{st.detail}</span>}
            </span>
          </li>
        ))}
      </ol>} />
      <div className={cx('flex flex-wrap items-center gap-2', steps.length > 0 && 'mt-3 border-t border-line pt-3')}>
        {state === 'running' && <p className="tabular flex-1 text-[12.5px] text-muted">Working for {secsWords(secs)}. The old version keeps serving until the new one is healthy.</p>}
        {state === 'ok' && (
          <>
            <p className="min-w-0 flex-1 text-[13px]">
              <span className="font-semibold">v{output?.number}</span> is live{output?.url && <> at <a href={output.url} target="_blank" rel="noopener" className="font-medium text-blue-text hover:underline">{host(output.url)}</a></>}
              {total > 0 && <span className="text-muted"> · took {secsWords(total)}</span>}
            </p>
            {output?.url && <Button size="sm" variant="primary" icon={<ArrowUpRight size={13} />} onClick={() => window.open(output.url, '_blank', 'noopener')}>Open site</Button>}
            {prev && <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => back.setAsking(true)}>Roll back</Button>}
          </>
        )}
        {state === 'failed' && <p className="min-w-0 flex-1 basis-full text-[12.5px] text-bad [overflow-wrap:anywhere]">{(error ?? 'The deploy didn’t go live.').split('\n')[0]} <span className="text-muted">Your site kept running the old version.</span></p>}
        {state !== 'failed' && s && <Button size="sm" variant="ghost" icon={<ScrollText size={13} />} onClick={() => navigate(`${s.href}#logs`)}>Logs</Button>}
      </div>
      {/* what to do now, as buttons: Ask Unit7 to fix it, Deploy again, the log; "Set it up" when something's missing */}
      {state === 'failed' && <StepChoices id={`deploy:${serviceId ?? ''}`} className="mt-2.5"
        step={{ tool: 'deployment.create', input: { serviceId }, status: 'error', error: error ?? 'The deploy didn’t go live.', ...(code && { code }) }} href={s?.href} />}
      {back.asking && <Sure text={`${s?.name ?? 'The app'} goes back to the version before v${output?.number}.`} yes="Roll back" busy={back.busy} onYes={() => back.go(prev)} onNo={() => back.setAsking(false)} />}
      {back.note && <Outcome tone={back.note.tone} step={back.note.step}>{back.note.text}</Outcome>}
    </div>
  );
}

export function DeployCard({ input, state, output, error, lines, code }: { input: any; state: 'running' | 'ok' | 'failed'; output?: any; error?: string; lines?: string[]; code?: string }) {
  const w = useWorld();
  const s = w.svc(input?.serviceId);
  return (
    <Frame icon={<Rocket size={16} />} tone={state === 'failed' ? 'bad' : state === 'ok' ? 'lime' : 'blue'} title={state === 'running' ? `Deploying ${s?.name ?? 'your app'}` : state === 'ok' ? `${s?.name ?? 'Your app'} is live` : `${s?.name ?? 'The app'} didn’t go live`}
      sub={s && `${s.project} · ${s.env}`} href={s?.href} hrefLabel="Open the app"
      right={<Pill tone={state === 'running' ? 'work' : state === 'ok' ? 'ok' : 'bad'} glow={state === 'ok'}>{state === 'running' ? 'Deploying' : state === 'ok' ? `v${output?.number ?? ''} live` : 'Failed'}</Pill>}>
      <DeployView serviceId={input?.serviceId} state={state} output={output} error={error} lines={lines} code={code} />
    </Frame>
  );
}

export function RollbackCard({ input, output }: { input: any; output: any }) {
  const w = useWorld();
  const s = w.svc(input?.serviceId);
  const it = s && appOfSvc(s, w);
  return (
    <Frame icon={<RotateCcw size={16} />} tone="warn" title={`${s?.name ?? 'The app'} is back on v${output.number}`} sub={s && `${s.project} · ${s.env}`} href={s?.href} hrefLabel="Open the app"
      right={<Pill tone="ok" glow>Live</Pill>}>
      {output.warning && <p className="mb-3 flex gap-2 rounded-[14px] bg-warn/10 px-3 py-2 text-[12.5px] text-warn"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{output.warning}</p>}
      <div className="flex flex-wrap gap-2">
        {it?.url && <Button size="sm" variant="primary" icon={<ArrowUpRight size={13} />} onClick={() => window.open(it.url!, '_blank', 'noopener')}>Open {host(it.url)}</Button>}
        {s && <Button size="sm" variant="ghost" icon={<ScrollText size={13} />} onClick={() => navigate(`${s.href}#logs`)}>Logs</Button>}
      </div>
    </Frame>
  );
}

// deployment.logs: the last lines in the dark panel, all of them a click away
export function LogsCard({ input, output }: { input: any; output: any }) {
  const w = useWorld();
  const [all, setAll] = useState(false);
  const s = w.svc(input?.serviceId);
  const lines: string[] = (output.lines ?? []).filter((l: string) => l.trim()).map(rawWords);
  return (
    <DarkCard className="@container animate-rise w-full min-w-0 !p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-full bg-white/10"><ScrollText size={15} /></span>
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{output.kind === 'build' ? 'Build log' : 'Live logs'}{s && <span className="font-normal text-white/60"> · {s.name}</span>}</p>
        {output.status && <span className={cx('inline-flex h-6 items-center rounded-full px-2.5 text-[12px] font-medium', output.status === 'failed' ? 'bg-[#ff8a80]/15 text-[#ff8a80]' : output.status === 'live' ? 'bg-lime/15 text-lime' : 'bg-white/10 text-white/75')}>{output.status === 'live' ? 'Live' : output.status === 'failed' ? 'Failed' : output.status === 'stopped' ? 'Older version' : output.status}</span>}
        {s && <a href={`${s.href}#logs`} onClick={(e) => { e.preventDefault(); navigate(`${s.href}#logs`); }} aria-label="Open the full logs" className="grid size-8 place-items-center rounded-full border border-white/20 transition hover:bg-white hover:text-[#111115]"><ArrowUpRight size={15} /></a>}
      </div>
      <Terminal lines={all ? lines : lines.slice(-14)} empty={output.note ?? 'Nothing logged yet.'} className={cx('!min-h-0', all ? '!max-h-[420px]' : '!max-h-[260px]')} />
      {lines.length > 14 && <button type="button" onClick={() => setAll((a) => !a)} className="mt-2 rounded-full px-2 text-[12.5px] font-medium text-lime hover:underline">{all ? 'Show the last lines' : `Show all ${lines.length} lines`}</button>}
    </DarkCard>
  );
}

// service.create: the app exists; deploying it is one click, and the steps show here
export function ServiceCreatedCard({ input, output }: { input: any; output: any }) {
  const w = useWorld();
  const s = w.svc(output.serviceId);
  const dep = useDeployRun(output.serviceId);
  const repo = input?.source?.repo;
  return (
    <Frame icon={<Box size={16} />} tone="lime" title={`Added ${input?.name ?? 'your app'}`} sub={s ? `${s.project} · ${s.env}` : 'Not live yet'} href={s?.href} hrefLabel="Open the app"
      right={<Pill tone={dep.run?.state === 'running' ? 'work' : dep.run?.state === 'ok' ? 'ok' : 'idle'}>{dep.run?.state === 'running' ? 'Deploying' : dep.run?.state === 'ok' ? 'Live' : 'Not live yet'}</Pill>}>
      {repo && <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-raised py-1 pl-1.5 pr-3 text-[12.5px] text-ink-2"><BrandLogo id="github" size={14} />{repo}{input.source.branch && <><GitBranch size={12} className="text-muted" />{input.source.branch}</>}</p>}
      {!dep.run && <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" icon={<Rocket size={13} />} onClick={dep.start}>Deploy it now</Button>{s && <Button size="sm" variant="ghost" onClick={() => navigate(s.href)}>Open the app</Button>}</div>}
      {dep.note && <Outcome tone={dep.note.tone} step={dep.note.step}>{dep.note.text}</Outcome>}
      {dep.run && <DeployView serviceId={output.serviceId} {...dep.run} />}
    </Frame>
  );
}

// service.get: one app up close (or a database: its engine and a backup button)
export function AppCard({ output: a }: { output: any }) {
  const w = useWorld();
  const s = w.svc(a.id);
  const db = isDb(a.kind);
  const dep = useDeployRun(a.id);
  const back = useRollback(a.id);
  const [bk, setBk] = useState<{ busy?: boolean; note?: ReturnType<typeof said> }>({});
  const st = svcState(a);
  const d = mainDomain([a]);
  const url = d ? urlOf(d) : null;
  const logo = stackLogo({ kind: a.kind, stack: a.stack });
  const backup = async () => { setBk({ busy: true }); const r = await call('backup.create', { serviceId: a.id, reason: 'manual' }); setBk({ note: said(r, r.status === 'ok' ? `Backed up (${bytes((r.output as any).size)}).` : '') }); };
  return (
    <Frame icon={db ? <Database size={16} /> : <Box size={16} />} title={w.svcLabel(s) ?? a.name} sub={url ? host(url) : db ? `${providerName(logo)} database` : 'No address yet'} href={s?.href} hrefLabel="Open the app"
      right={<Pill tone={dep.run?.state === 'running' ? 'work' : TONE[st.tone]} glow={st.tone === 'ok'}>{dep.run?.state === 'running' ? 'Deploying' : st.word}</Pill>}>
      <div className="flex flex-wrap gap-1.5 text-[12.5px] font-medium text-ink-2">
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-raised pl-1 pr-3"><span className="grid size-5 place-items-center rounded-full bg-surface"><BrandLogo id={logo} size={12} /></span>{providerName(logo)}</span>
        {a.source?.repo && <span className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-raised pl-1.5 pr-3"><BrandLogo id="github" size={13} /><span className="truncate">{a.source.repo}{a.source.branch ? ` · ${a.source.branch}` : ''}</span></span>}
        {a.autoDeploy && <span className="inline-flex h-7 items-center rounded-full bg-raised px-3">Deploys on every push</span>}
        {a.replicas > 1 && <span className="inline-flex h-7 items-center rounded-full bg-raised px-3">{a.replicas} copies</span>}
      </div>
      {!db && a.deployments?.length > 0 && (
        <ol className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Recent versions">
          {a.deployments.slice(0, 6).map((x: any) => (
            <li key={x.id} title={x.error ?? `${x.triggered_by ? `By ${x.triggered_by.replace(/\s*\(.*\)$/, '')} · ` : ''}${timeAgo(x.finished_at ?? x.started_at)}`}
              className={cx('flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]', x.status === 'live' ? 'border-ok/30 bg-ok/8 font-medium text-ink' : 'border-line text-ink-2')}>
              <LiveDot tone={x.status === 'live' ? 'ok' : x.status === 'failed' ? 'bad' : x.status === 'building' || x.status === 'deploying' ? 'work' : 'idle'} glow={x.status === 'live'} />
              v{x.number}<span className="text-muted">{timeAgo(x.finished_at ?? x.started_at)}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {url && <Button size="sm" variant="primary" icon={<ArrowUpRight size={13} />} onClick={() => window.open(url, '_blank', 'noopener')}>Open site</Button>}
        {!db && <Button size="sm" variant="secondary" icon={<Rocket size={13} />} loading={dep.run?.state === 'running'} onClick={dep.start}>Deploy</Button>}
        {!db && a.current && <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => back.setAsking(true)}>Roll back</Button>}
        {db && <Button size="sm" variant="secondary" loading={bk.busy} onClick={backup}>Back up now</Button>}
        {s && <Button size="sm" variant="ghost" icon={<ScrollText size={13} />} onClick={() => navigate(`${s.href}#logs`)}>Logs</Button>}
      </div>
      {back.asking && <Sure text={changeWords('deployment.rollback', {}, () => a.name)} yes="Roll back" busy={back.busy} onYes={() => back.go()} onNo={() => back.setAsking(false)} />}
      {back.note && <Outcome tone={back.note.tone} step={back.note.step}>{back.note.text}</Outcome>}
      {bk.note && <Outcome tone={bk.note.tone} step={bk.note.step}>{bk.note.text}</Outcome>}
      {dep.note && <Outcome tone={dep.note.tone} step={dep.note.step}>{dep.note.text}</Outcome>}
      {dep.run && <div className="mt-3"><DeployView serviceId={a.id} {...dep.run} /></div>}
    </Frame>
  );
}

// graph.get / project.list: each project with its environments and what runs in them
export function ProjectsCard({ projects }: { projects?: any[] }) {
  const w = useWorld();
  const list: any[] = [...(w.graph?.projects ?? []), ...(w.graph?.foundProjects ?? [])].filter((p: any) => !projects || projects.some((x) => x.id === p.id));
  return (
    <Frame icon={<Box size={16} />} title="Your projects" count={w.graph ? list.length : undefined} href="/projects" hrefLabel="Open projects">
      {!w.graph ? <Skeleton className="h-24" /> : !list.length ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">No projects yet.</p> : (
        <Fold items={list} className="space-y-2">
          {(p) => {
            if (p.serverId) return (
              <li key={p.id} className="rounded-[18px] border border-line px-3 py-2.5 transition hover:border-line-strong">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised text-[14px] font-semibold text-ink-2">{p.name.charAt(0).toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <button type="button" onClick={() => navigate(`/projects/${p.id}`)} className="block max-w-full truncate text-left text-[14px] font-semibold hover:underline decoration-line-strong underline-offset-4">{p.name}</button>
                    <p className="truncate text-[12px] text-muted">Found on {p.server}{p.domains?.[0] ? ` · ${p.domains[0]}` : ''}</p>
                  </div>
                  <IconBtn label={`Open ${p.name}`} href={`/projects/${p.id}`}><ArrowUpRight size={15} /></IconBtn>
                </div>
              </li>
            );
            const apps = w.svcs.filter((s) => s.projectId === p.id);
            return (
              <li key={p.id} className="rounded-[18px] border border-line px-3 py-2.5 transition hover:border-line-strong">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-lime text-[14px] font-semibold text-lime-ink">{p.name.charAt(0).toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <button type="button" onClick={() => navigate(`/projects/${p.id}`)} className="truncate text-left text-[14px] font-semibold hover:underline decoration-line-strong underline-offset-4">{p.name}</button>
                    <p className="truncate text-[12px] text-muted">{(p.environments ?? []).map((e: any) => e.name).join(' · ') || 'No environments yet'}</p>
                  </div>
                  <IconBtn label={`Open ${p.name}`} href={`/projects/${p.id}`}><ArrowUpRight size={15} /></IconBtn>
                </div>
                {apps.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5 @md:pl-12">
                    {apps.slice(0, 8).map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => navigate(s.href)} title={`${s.name} · ${s.env}`}
                          className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-line bg-surface pl-1 pr-2.5 text-[12.5px] font-medium text-ink-2 transition hover:border-line-strong hover:bg-raised hover:text-ink">
                          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={stackLogo(s)} size={12} /></span>
                          <span className="truncate">{s.name}</span><span className="truncate font-normal text-faint">{s.env.toLowerCase()}</span>
                          <LiveDot tone={TONE[svcState(s).tone]} />
                        </button>
                      </li>
                    ))}
                    {apps.length > 8 && <li className="inline-flex h-7 items-center px-1 text-[12px] text-muted">+{apps.length - 8} more</li>}
                  </ul>
                )}
              </li>
            );
          }}
        </Fold>
      )}
    </Frame>
  );
}
