import { useEffect, useState } from 'react';
import { Rocket, RotateCcw, ScrollText, RefreshCw, DatabaseBackup, ArrowUpRight, Server, AlertTriangle } from 'lucide-react';
import { runTool } from '../lib/api';
import { navigate } from '../lib/router';
import { providerName } from '../brand/BrandLogo';
import { A, act, Button, CopyButton, Empty, Illustration, cx } from '../ui';
import { isDb, kindWord, LogoTile, mainDomain, stackLogo, StateBadge, svcState, urlOf, deployTime, ago } from './kit';
import { AskButton } from './Help';

export const statusTone = (s: string) => (s === 'healthy' || s === 'running' ? 'ok' : s === 'unhealthy' || s === 'failed' || s === 'down' ? 'bad' : s === 'deploying' || s === 'building' ? 'work' : 'idle') as 'ok' | 'bad' | 'work' | 'idle';

// apps first, then workers, then databases
const ORDER = (s: any) => (isDb(s.kind) ? 2 : s.kind === 'worker' ? 1 : 0);

export function ServiceList({ project, env, servers }: { project: any; env: any; servers: any[] }) {
  if (!env.services.length) {
    return (
      <Empty art={<Illustration name="apps" size={104} />} title={`Nothing runs in ${env.name} yet`}
        body={`Unit7 can build ${project.repo ?? 'your app'} and put it live here, with its own link.`}
        action={<div className="flex flex-col items-center gap-3">
          <AskButton size="md" variant="primary" label={`Deploy to ${env.name.toLowerCase()}`} prompt={`Deploy ${project.repo ?? 'my app'} to ${env.name.toLowerCase()} in ${project.name} and give me the link`} />
          <details className="group text-[12.5px] text-muted">
            <summary className="cursor-pointer list-none rounded-full px-2 py-1 font-medium hover:text-ink [&::-webkit-details-marker]:hidden">Or from your terminal</summary>
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-raised py-0.5 pl-3 pr-0.5"><code className="font-mono text-[12.5px] text-ink">unit7 deploy</code><CopyButton text="unit7 deploy" /></span>
            <span className="mt-1 block">Run it inside your project’s folder.</span>
          </details>
        </div>} />
    );
  }
  return (
    <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2">
      {[...env.services].sort((a, b) => ORDER(a) - ORDER(b)).map((s: any, i, all) => (
        <ServiceCard key={s.id} s={s} project={project} server={servers.find((x) => x.id === s.server_id)} wide={i === all.length - 1 && all.length % 2 === 1} />
      ))}
    </div>
  );
}

// One app: logo, state, address, version, the last few deploys, and the four things you'd do.
function ServiceCard({ s, project, server, wide }: { s: any; project: any; server?: any; wide?: boolean }) {
  const href = `/projects/${project.id}/services/${s.id}`;
  const db = isDb(s.kind);
  const logo = stackLogo(s);
  const domain = mainDomain([s]);
  const [deps, setDeps] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (db) return;
    void runTool('service.get', { serviceId: s.id }).then((r) => setDeps(r.status === 'ok' ? r.output.deployments : []));
  }, [s.id, s.deployment?.id, s.status, db]);
  const previous = deps?.find((d) => d.id !== s.deployment?.id && d.status !== 'failed' && d.status !== 'building' && d.status !== 'deploying');
  const run = async (what: string, tool: string, input: object, success: string) => { setBusy(what); await act(tool, input, { success }); setBusy(null); };
  return (
    <article id={`svc-${s.id}`} className={cx('relative flex min-w-0 scroll-mt-24 flex-col rounded-[24px] border border-line bg-surface p-5 shadow-soft transition-shadow hover:shadow-lift', wide && 'md:col-span-2')}>
      <div className="flex items-start gap-3">
        <LogoTile id={logo} size={46} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[16px] font-semibold tracking-[-0.015em]">
            <A href={href} className="outline-none after:absolute after:inset-0 after:rounded-[24px] focus-visible:after:ring-2 focus-visible:after:ring-blue">{s.name}</A>
          </h3>
          <p className="truncate text-[12.5px] text-muted">{kindWord(s.kind)} · {providerName(logo)}</p>
        </div>
        <StateBadge s={s} />
      </div>

      {domain ? (
        <a href={urlOf(domain)} target="_blank" rel="noopener" className="relative z-10 mt-3 inline-flex max-w-full items-center gap-1 self-start truncate text-[13px] font-medium text-blue-text hover:underline">
          <span className="truncate">{domain.hostname}</span><ArrowUpRight size={13} className="shrink-0" />
        </a>
      ) : <p className="mt-3 text-[13px] text-muted">{db ? 'Private: only your apps can reach it' : 'No address yet'}</p>}

      <div className="mt-4 grid grid-cols-[auto_1fr] items-end gap-4 rounded-[18px] bg-raised px-4 py-3">
        {db ? (
          <>
            <div><p className="text-[11.5px] text-muted">Engine</p><p className="text-[15px] font-semibold tracking-[-0.01em]">{providerName(logo)}</p></div>
            <p className="flex items-center justify-end gap-1.5 truncate text-right text-[12.5px] text-muted"><Server size={13} className="shrink-0" />{server ? `on ${server.name}` : 'no server yet'}</p>
          </>
        ) : (
          <>
            <div>
              <p className="text-[11.5px] text-muted">Version</p>
              <p className="tabular text-[15px] font-semibold tracking-[-0.01em]">{s.deployment ? `v${s.deployment.number}` : '—'}</p>
              <p className="text-[11.5px] text-muted">{s.deployment ? ago(s.deployment.finished_at ?? s.deployment.started_at) : 'never deployed'}</p>
            </div>
            <DeployTrail deps={deps} current={s.deployment?.id} />
          </>
        )}
      </div>

      {svcState(s).tone === 'bad' && (
        <div role="status" className="relative z-10 mt-3 flex flex-wrap items-center gap-2 rounded-[16px] bg-bad/8 px-3 py-2 text-[12.5px] text-ink-2">
          <AlertTriangle size={14} className="shrink-0 text-bad" />
          <span className="min-w-0 flex-1">{db ? 'The database isn’t answering.' : previous ? `It isn’t working. Going back to v${previous.number} is one click.` : 'It isn’t working right now.'}</span>
          <AskButton variant="primary" about={{ kind: db ? 'database' : 'app', id: s.id, name: s.name }} prompt={`${s.name} in ${project.name} is ${svcState(s).word.toLowerCase()}. Find out why and fix it, and tell me what changes first.`} />
        </div>
      )}
      <div className="relative z-10 mt-4 flex flex-wrap gap-1 [&>button]:px-2.5">
        {db ? (
          <>
            <Button size="sm" variant="primary" icon={<DatabaseBackup size={13} />} loading={busy === 'backup'} onClick={() => run('backup', 'backup.create', { serviceId: s.id, reason: 'manual' }, 'Backed up')}>Back up</Button>
            <Button size="sm" variant="soft" icon={<ScrollText size={13} />} onClick={() => navigate(`${href}#logs`)}>Logs</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" icon={<Rocket size={13} />} loading={busy === 'deploy'} onClick={() => run('deploy', 'deployment.create', { serviceId: s.id }, 'Deploy started')}>Deploy</Button>
            <Button size="sm" variant="soft" icon={<RotateCcw size={13} />} loading={busy === 'rollback'} disabled={!previous}
              title={previous ? `Go back to v${previous.number}` : 'No earlier version to go back to'}
              onClick={() => previous && run('rollback', 'deployment.rollback', { serviceId: s.id, deploymentId: previous.id }, `Back on v${previous.number}`)}>Roll back</Button>
            <Button size="sm" variant="soft" icon={<ScrollText size={13} />} onClick={() => navigate(`${href}#logs`)}>Logs</Button>
            <Button size="sm" variant="soft" icon={<RefreshCw size={13} />} loading={busy === 'restart'} disabled={!s.deployment} onClick={() => run('restart', 'service.restart', { serviceId: s.id }, 'Restarted')}>Restart</Button>
          </>
        )}
      </div>
    </article>
  );
}

// the last deploys, oldest on the left: blue = live now, red = didn't work, grey = earlier good ones
const TRAIL = { live: 'size-3.5 bg-blue ring-4 ring-blue-soft', failed: 'size-2.5 bg-bad-solid', building: 'size-2.5 bg-lime animate-working', other: 'size-2.5 bg-ink/30' };
export function DeployTrail({ deps, current }: { deps: any[] | null; current?: string }) {
  if (!deps) return <div className="skeleton h-8" />;
  const list = [...deps].sort((a, b) => deployTime(a) - deployTime(b)).slice(-8);
  const failed = list.filter((d) => d.status === 'failed').length;
  if (!list.length) return <p className="text-right text-[12px] text-muted">No deploys yet</p>;
  return (
    <div className="min-w-0">
      <div className="relative flex h-5 items-center justify-between" role="img" aria-label={`Last ${list.length} deploys, ${failed} didn’t work`}>
        <span aria-hidden className="absolute inset-x-1 top-1/2 h-px bg-line-strong" />
        {list.map((d, i) => {
          const k = d.id === current ? 'live' : d.status === 'failed' ? 'failed' : d.status === 'building' || d.status === 'deploying' ? 'building' : 'other';
          return <span key={d.id} title={`v${d.number} · ${d.id === current ? 'live now' : d.status === 'failed' ? 'didn’t work' : d.status} · ${ago(d.finished_at ?? d.started_at)}`}
            className={cx('relative rounded-full', TRAIL[k])} style={{ animation: `pop-in .35s var(--ease-out-soft) ${150 + i * 45}ms both` }} />;
        })}
      </div>
      <p className="mt-1.5 truncate text-right text-[11.5px] text-muted">{list.length} deploy{list.length === 1 ? '' : 's'}{failed ? ` · ${failed} didn’t work` : ''}</p>
    </div>
  );
}
