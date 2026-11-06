// Production · Staging · Development as one segmented switch at the top of a project (or an app): each with its
// status dot and the version it runs there. The pick lives in the URL (?env=), so everything below follows it and a
// link opens the same view. A missing one is "+ Add Staging" right in the switch. Beside it, the one-click moves between
// them, each confirmed in plain words first: Promote Staging to Production, Copy settings from Production.
import { useState } from 'react';
import { ArrowRight, Copy, Plus, Rocket } from 'lucide-react';
import { runTool } from '../../lib/api';
import { navigate } from '../../lib/router';
import { act, Button, confirmDialog, cx, Dot, toast } from '../../ui';
import { plainError } from '../../lib/words';
import { AskButton } from '../Help';
import { StagingPlanModal } from '../make/Staging';
import { envHealth, isDb, sortEnvs, svcState, type Tone } from '../kit';

const SLOTS = [{ kind: 'production', name: 'Production' }, { kind: 'staging', name: 'Staging' }, { kind: 'development', name: 'Development' }] as const;
const DOT: Record<Tone, 'ok' | 'bad' | 'work' | 'idle' | 'warn'> = { ok: 'ok', bad: 'bad', work: 'work', idle: 'idle', warn: 'warn' };
const mainApp = (env: any) => (env?.services ?? []).find((s: any) => !isDb(s.kind));
const twinOf = (env: any, slug?: string) => (slug ? (env?.services ?? []).find((s: any) => s.slug === slug) : mainApp(env));

// ?env= on the page, kept as the person switches (replace: switching isn't a new page in the back button)
export function setEnvInUrl(envId: string) {
  const q = new URLSearchParams(location.search);
  q.set('env', envId);
  navigate(`${location.pathname}?${q}${location.hash}`, { replace: true });
}

// the apps that can go from one environment to another: live in `from`, with the same app (slug) in `to`
export function promotable(from: any, to: any, slug?: string) {
  if (!from || !to) return [];
  return (from.services ?? []).filter((s: any) => !isDb(s.kind) && s.deployment?.status === 'live' && (!slug || s.slug === slug))
    .map((s: any) => ({ from: s, to: (to.services ?? []).find((t: any) => t.slug === s.slug) })).filter((p: any) => p.to);
}

export function EnvSwitcher({ project, envId, onSelect, appSlug, onChanged, className }: {
  project: any; envId?: string | null; onSelect: (env: any) => void;
  appSlug?: string;          // an app's page: each segment is this app in that environment
  onChanged?: () => void; className?: string;
}) {
  const envs = sortEnvs<any>(project.environments ?? []);
  const prod = envs.find((e) => e.kind === 'production'), staging = envs.find((e) => e.kind === 'staging');
  const current = envs.find((e) => e.id === envId) ?? prod ?? envs[0];
  const [adding, setAdding] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const slots: ({ env: any; kind: string; name: string } | { env?: undefined; kind: string; name: string })[] = [
    ...SLOTS.map((s) => ({ ...s, env: envs.find((e) => e.kind === s.kind) })),
    ...envs.filter((e) => !SLOTS.some((s) => s.kind === e.kind)).map((e) => ({ kind: e.kind, name: e.name, env: e })),
  ];
  const add = async (kind: string, name: string) => {
    // a test copy of what runs in Production is the useful Staging; an empty one otherwise
    if (kind === 'staging' && (prod?.services ?? []).some((s: any) => !isDb(s.kind))) { setAdding('staging'); return; }
    const r = await act('environment.create', { projectId: project.id, name, kind }, { success: `Added ${name}`, undo: false });
    if (r) { onChanged?.(); if ((r.output as any)?.id) setEnvInUrl((r.output as any).id); }
  };
  const pairs = promotable(staging, prod, appSlug);
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3', className)}>
      <div role="tablist" aria-label="Environment" className="flex max-w-full gap-1 overflow-x-auto rounded-full bg-raised p-1 [scrollbar-width:none]">
        {slots.map((s) => {
          if (!s.env) return (
            <button key={s.kind} type="button" onClick={() => void add(s.kind, s.name)}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-line-strong px-3.5 text-[13px] font-medium text-muted transition hover:border-blue/40 hover:bg-surface hover:text-blue-text">
              <Plus size={14} aria-hidden />Add {s.name}
            </button>
          );
          const e = s.env, on = e.id === current?.id, app = twinOf(e, appSlug);
          const tone: Tone = appSlug ? (app ? svcState(app).tone : 'idle') : envHealth(e);
          const v = app?.deployment?.number;
          return (
            <button key={e.id} type="button" role="tab" aria-selected={on} onClick={() => onSelect(e)}
              title={appSlug && !app ? `This app isn’t in ${e.name} yet` : undefined}
              className={cx('inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-[13.5px] font-medium transition duration-200 ease-out-soft',
                on ? 'bg-ink text-bg shadow-soft' : 'text-ink-2 hover:bg-surface hover:text-ink', appSlug && !app && 'opacity-60')}>
              <Dot tone={DOT[tone]} working={tone === 'work'} />
              {e.name}
              <span className={cx('tabular font-mono text-[11.5px]', on ? 'text-bg/70' : 'text-faint')}>{v ? `v${v}` : appSlug && !app ? 'none' : '—'}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pairs.length > 0 && (current?.kind === 'staging' || current?.kind === 'production') && (
          <Button size="sm" variant="primary" icon={<Rocket size={14} />} onClick={() => void promote(pairs, onChanged)}>
            Promote Staging<ArrowRight size={13} aria-hidden className="-mx-0.5" />Production
          </Button>
        )}
        {current && current.kind !== 'production' && prod && (prod.services ?? []).some((s: any) => !isDb(s.kind)) && (
          <Button size="sm" variant="secondary" icon={<Copy size={14} />} loading={copying} onClick={async () => { setCopying(true); try { await copySettings(prod, current, appSlug); } finally { setCopying(false); } }}>Copy settings from Production</Button>
        )}
        {current && <AskButton label={`Ask about ${current.name}`} prompt={`In ${project.name}, ${current.name}: `}
          about={{ kind: 'environment', id: current.id, name: `${project.name} · ${current.name}` }} />}
      </div>
      {prod && <StagingPlanModal target={{ projectId: project.id, name: project.name }} open={adding === 'staging'} onClose={() => { setAdding(null); onChanged?.(); }} />}
    </div>
  );
}

// Promote: what each app gets, said by the server's own dry run, one confirm for all, then each through the normal deploy
export async function promote(pairs: { from: any; to: any }[], onDone?: () => void) {
  const plans: any[] = [];
  for (const p of pairs) {
    const r = await runTool('deployment.promote', { fromServiceId: p.from.id, serviceId: p.to.id }, { dryRun: true }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    if (r.status === 'dry_run') plans.push(r.plan);
    else { toast('bad', `Can’t promote ${p.from.name}`, r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : undefined); return false; }
  }
  const ok = await confirmDialog({
    title: plans.length === 1 ? `Promote ${plans[0].to.name} to Production?` : `Promote ${plans.length} apps to Production?`,
    body: plans.length === 1 ? plans[0].says : 'Each one gets the version Staging runs, built from the same code, through the normal zero-downtime deploy: health-checked beside the live version, then visitors switch over. The version before stays ready to roll back to.',
    items: plans.map((p) => `${p.to.name}: v${p.from.version} from Staging${p.to.version ? ` (Production has v${p.to.version} now)` : ''}`),
    confirm: plans.length === 1 ? 'Promote it' : 'Promote them',
  });
  if (!ok) return false;
  let all = true;
  for (const p of plans) all = !!(await act('deployment.promote', { fromServiceId: p.from.serviceId, serviceId: p.to.serviceId }, { success: `${p.to.name} is live in Production with Staging’s version` })) && all;
  onDone?.();
  return all;
}

// Copy settings from Production: the keys Production's apps have that this environment doesn't, with live-key warnings
export async function copySettings(prod: any, to: any, slug?: string) {
  const apps = (prod.services ?? []).filter((s: any) => !isDb(s.kind) && (!slug || s.slug === slug));
  const plans: { fromServiceId: string; keys: { key: string; secret: boolean; live: boolean }[] }[] = [];
  for (const a of apps) {
    const l = await runTool('env.list', { serviceId: a.id });
    const keys = l.status === 'ok' ? (l.output.variables as { key: string; from: string }[]).filter((v) => v.from === 'service' || v.from === 'environment').map((v) => v.key).slice(0, 50) : [];
    if (!keys.length) continue;
    const r = await runTool('env.copy', { fromServiceId: a.id, environmentId: to.id, keys }, { dryRun: true });
    if (r.status === 'dry_run' && r.plan.keys.length) plans.push({ fromServiceId: a.id, keys: r.plan.keys });
    else if (r.status === 'error') { toast('bad', 'Couldn’t read Production’s settings', plainError(r.error.message).line); return false; }
  }
  const keys = plans.flatMap((p) => p.keys);
  if (!keys.length) { toast('info', 'Nothing to copy', `${to.name} already has every setting Production has.`); return false; }
  const live = [...new Set(keys.filter((k) => k.live).map((k) => k.key))];
  const ok = await confirmDialog({
    title: `Copy ${keys.length} setting${keys.length > 1 ? 's' : ''} to ${to.name}?`,
    body: `From Production. Only settings ${to.name} doesn’t have yet; nothing it has is changed. The values stay on Unit7’s side, and ${to.name}’s apps get them on their next deploy. Undo removes them again.`,
    items: keys.map((k) => `${k.key}${k.live ? '  · looks like a live key' : k.secret ? '  · secret' : ''}`),
    warning: live.length ? `${live.join(', ')} ${live.length > 1 ? 'look' : 'looks'} like a live key. In ${to.name}, a test key is usually safer, so test payments don’t use real money.` : undefined,
    confirm: live.length ? 'Copy anyway' : 'Copy them',
  });
  if (!ok) return false;
  for (const p of plans) await act('env.copy', { fromServiceId: p.fromServiceId, environmentId: to.id, keys: p.keys.map((k) => k.key) }, { success: `Copied ${p.keys.length} setting${p.keys.length > 1 ? 's' : ''} to ${to.name}` });
  return true;
}
