// Dev-only harness: every chat card, side by side, at chat width. Not in the app's routes or build; open
// /src/pages/chat/cards/preview.html on the Vite dev server while signed in. ?theme=dark, ?w=375, ?only=<label>.
// Read tools run for real against this Unit7. Tools that need a reachable server or change things are
// shaped exactly like their output (example names), tied to real apps and servers from the graph.
import '../../../styles.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, runTool, startLive } from '../../../lib/api';
import { toolCard } from '../cards';
import { DeployCard } from './apps';
import type { ToolStep } from '../types';

const q = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', q.get('theme') === 'dark');
const width = Number(q.get('w') ?? 720);
const only = q.get('only');

type Shown = { label: string; step: ToolStep; question?: string };
const ok = (tool: string, input: any, output: any): ToolStep => ({ tool, input, status: 'ok', output });

async function load(): Promise<{ cards: Shown[]; log: string[] }> {
  const g = await api<any>('/api/graph');
  const svcs = g.projects.flatMap((p: any) => p.environments.flatMap((e: any) => e.services.map((s: any) => ({ ...s, env: e }))));
  const app = svcs.find((s: any) => s.kind === 'app' && s.domains?.some((d: any) => !/sslip/.test(d.hostname))) ?? svcs[0];
  const all = (await runTool('backup.list', {})) as any;
  const db = svcs.find((s: any) => s.id === all.output?.[0]?.service_id) ?? svcs.find((s: any) => s.kind === 'postgres');
  const srv = g.servers[0];
  const real = async (label: string, tool: string, input: any = {}, question?: string): Promise<Shown> => {
    if (only && only !== label) return { label, step: { tool, status: 'running' } }; // filtered out below; don't ask
    const r = await runTool(tool, input);
    return { label, question, step: r.status === 'ok' ? ok(tool, input, r.output) : { tool, input, status: 'error', error: r.status === 'error' ? r.error.message : r.status } };
  };
  const svc = (await runTool('service.get', { serviceId: app.id })) as any;
  const cur = svc.output?.current;
  const prev = svc.output?.deployments?.find((d: any) => d.status === 'stopped');
  // the failed deploy card is about an app whose last failure has a stored build log
  let broken = { id: app.id, error: undefined as string | undefined };
  if (!only || only === 'deployment.create · failed') for (const s of svcs.filter((x: any) => x.kind === 'app')) {
    const d = ((await runTool('service.get', { serviceId: s.id })) as any).output?.deployments?.find((x: any) => x.status === 'failed');
    if (d) { broken = { id: s.id, error: d.error }; break; }
  }
  const errProject = (await Promise.all(g.projects.map((p: any) => runTool('errors.list', { projectId: p.id }).then((r: any) => [p.id, r.output?.length ?? 0])))).find(([, n]) => n)?.[0];
  const domains = (await runTool('domain.list', {})) as any;
  const backups = all;
  const liveLog = ((await runTool('deployment.logs', { deploymentId: cur?.id })) as any).output?.lines ?? [];
  const f = srv?.facts ?? {};
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

  const cards: Shown[] = [
    await real('map.get · domains', 'map.get', {}, 'show me my domains'),
    await real('map.get · apps', 'map.get', {}, 'what apps do I have'),
    await real('map.get · servers', 'map.get', {}, 'how is my server'),
    await real('domain.list', 'domain.list'),
    await real('domain.check', 'domain.check', { domainId: domains.output?.[0]?.id }),
    { label: 'domain.point · done', step: ok('domain.point', { hostname: 'app.example.com', serviceId: app.id }, { hostname: 'app.example.com', dns: 'Cloudflare: A app.example.com → 203.0.113.10', url: 'https://app.example.com', note: 'DNS usually updates within minutes.' }) },
    { label: 'domain.point · needs you', step: ok('domain.point', { hostname: 'shop.example.com', serviceId: app.id }, { hostname: 'shop.example.com', dns: 'needs you', addThese: [{ type: 'A', name: 'shop', value: '203.0.113.10' }], at: 'GoDaddy', note: '' }) },
    await real('server.list', 'server.list'),
    { label: 'server.metrics', step: ok('server.metrics', { serverId: srv?.id }, { now: { at: new Date().toISOString(), cpu: 23.4, memUsed: 5.6e9, memTotal: 8.3e9, diskUsed: 5.0e10, diskTotal: 1.04e11, load1: 0.68, memPct: 67, diskPct: 48, containers: [{ name: 'unit7-web-42', cpu: 12.1, memPct: 8.2, mem: '412MiB' }, { name: 'unit7-api-23', cpu: 6.4, memPct: 5.1, mem: '256MiB' }, { name: 'unit7-db', cpu: 2.2, memPct: 9.9, mem: '498MiB' }, { name: 'unit7-caddy', cpu: 0.3, memPct: 0.6, mem: '31MiB' }] }, history: [] }) },
    { label: 'server.inspect', step: ok('server.inspect', { serverId: srv?.id }, { name: srv?.name, host: srv?.host, ...f, memory: `${gb(f.mem_total - f.mem_available)} used of ${gb(f.mem_total)}`, disk: `${gb(f.disk_used)} used of ${gb(f.disk_total)}` }) },
    { label: 'docker.list', step: ok('docker.list', { serverId: srv?.id }, [
      { ID: 'a1', Names: 'unit7-web-42', Image: 'unit7/web:42', State: 'running', Status: 'Up 2 days (healthy)' }, { ID: 'a2', Names: 'unit7-api-23', Image: 'unit7/api:23', State: 'running', Status: 'Up 5 days' },
      { ID: 'a3', Names: 'unit7-db', Image: 'postgres:16', State: 'running', Status: 'Up 19 days' }, { ID: 'a4', Names: 'unit7-web-41', Image: 'unit7/web:41', State: 'exited', Status: 'Exited (0) 2 days ago' },
      { ID: 'a5', Names: 'unit7-caddy', Image: 'caddy:2', State: 'running', Status: 'Up 19 days' }, { ID: 'a6', Names: 'unit7-worker-8', Image: 'unit7/worker:8', State: 'restarting', Status: 'Restarting (1) 4 seconds ago' }, { ID: 'a7', Names: 'unit7-cache', Image: 'redis:7', State: 'running', Status: 'Up 3 days' }]) },
    { label: 'hostinger.vps_list', step: ok('hostinger.vps_list', {}, { vps: [{ id: 1187420, hostname: srv?.name ?? 'srv1', state: 'running', ip: srv?.host, plan: 'KVM 2', os: 'Ubuntu 24.04' }, { id: 1190311, hostname: 'srv2.example.com', state: 'running', ip: '203.0.113.24', plan: 'KVM 1', os: 'Ubuntu 24.04' }] }) },
    await real('project.list', 'project.list'),
    await real('graph.get', 'graph.get'),
    await real('service.get · app', 'service.get', { serviceId: app.id }),
    ...(db ? [await real('service.get · database', 'service.get', { serviceId: db.id })] : []),
    { label: 'service.create', step: ok('service.create', { name: 'shop', environmentId: app.env.id, source: { type: 'git', repo: 'sam/shop', branch: 'main' } }, { serviceId: app.id, slug: 'shop', next: 'Deploy it with deployment.create.' }) },
    { label: 'deployment.create · running', step: { tool: 'deployment.create', input: { serviceId: app.id }, status: 'running' } },
    { label: 'deployment.create · live', step: ok('deployment.create', { serviceId: app.id }, { deploymentId: cur?.id, number: cur?.number, status: 'live', url: `https://${app.domains[0].hostname}`, previousDeploymentId: prev?.id, undo: prev && { tool: 'deployment.rollback', input: { serviceId: app.id, deploymentId: prev.id } } }) },
    { label: 'deployment.create · failed', step: { tool: 'deployment.create', input: { serviceId: broken.id }, status: 'error', error: broken.error ?? 'The build failed.' } },
    await real('deployment.logs', 'deployment.logs', { deploymentId: cur?.id, serviceId: app.id }),
    { label: 'deployment.rollback', step: ok('deployment.rollback', { serviceId: app.id }, { deploymentId: prev?.id, number: prev?.number ?? 41 }) },
    ...(db ? [
      { label: 'database.create', step: ok('database.create', { environmentId: app.env.id, engine: 'postgres', injectInto: app.id }, { serviceId: db.id, engine: 'postgres', injected: true }) },
      { label: 'database.inspect', step: ok('database.inspect', { serviceId: db.id }, { engine: 'postgres', database: 'app', result: '    table    |  rows  |  size\n-------------+--------+---------\n shipments   | 182044 | 61 MB\n orders      |  40211 | 12 MB\n customers   |   9120 | 3112 kB\n rates       |   2210 | 480 kB\n couriers    |     14 | 48 kB\n pickups     |   5502 | 1208 kB\n webhooks    |    612 | 160 kB\n audit_log   |  70110 | 22 MB\n(8 rows)' }) },
      { label: 'backup.create', step: ok('backup.create', { serviceId: db.id }, { backupId: backups.output?.[0]?.id, size: backups.output?.[0]?.size ?? 15e6, location: '' }) },
      { label: 'backup.restore', step: ok('backup.restore', { backupId: backups.output?.[1]?.id, confirm: true }, { restored: db.name, from: backups.output?.[1]?.id }) },
    ] : []),
    await real('backup.list', 'backup.list'),
    ...(errProject ? [await real('errors.list', 'errors.list', { projectId: errProject })] : []),
    await real('approval.list', 'approval.list'),
    await real('events.recent', 'events.recent', { limit: 20 }),
    await real('account.list', 'account.list'),
    await real('budget.check', 'budget.check'),
    { label: 'budget.check · with costs', step: ok('budget.check', {}, { currency: 'USD', budget: 60, soFar: 31.4, forecast: 52.8, level: 'warning', acted: [], costs: [{ provider: 'hostinger', account: 'Hostinger', label: 'Hostinger · KVM 2', amount: 8.99, currency: 'USD', kind: 'monthly' }, { provider: 'vercel', account: 'Vercel', label: 'Vercel · Pro', amount: 20, currency: 'USD', kind: 'spent' }, { provider: 'cloudflare', account: 'Cloudflare', label: 'Cloudflare · example.com', amount: 2.41, currency: 'USD', kind: 'period' }], problems: [] }) },
    // a server's X-ray and Coolify (real on a Unit7 whose server answers and whose Coolify is connected)
    ...(srv ? await (async (): Promise<Shown[]> => {
      const sid = srv.id;
      const xr = (only && !/^(server\.|coolify\.)/.test(only)) ? null : ((await runTool('server.xray', { serverId: sid })) as any).output;
      const uuid = xr?.parts?.find((p: any) => p.kind === 'app' && p.coolify)?.coolify?.uuid ?? 'shopapp01';
      const c = { serverId: sid, uuid, kind: 'application' };
      return [
        await real('server.xray', 'server.xray', { serverId: sid }),
        await real('server.usage', 'server.usage', { serverId: sid }),
        await real('coolify.projects', 'coolify.projects', { serverId: sid }),
        await real('coolify.deployments', 'coolify.deployments', { ...c, take: 6 }),
        await real('coolify.logs', 'coolify.logs', { ...c, lines: 80 }),
        await real('coolify.envs', 'coolify.envs', { ...c, op: 'list' }),
        { label: 'coolify.control · running', step: { tool: 'coolify.control', input: { ...c, action: 'deploy' }, status: 'running' } },
        { label: 'coolify.control · done', step: ok('coolify.control', { ...c, action: 'restart' }, { action: 'restart', uuid, kind: 'application', status: 'finished', message: 'Restart request queued.' }) },
        { label: 'coolify.build · done', step: ok('coolify.build', { serverId: sid, goal: 'Make me a Next.js app with Supabase from sam/shop' }, { built: true, url: 'https://shop.example.com', done: [{ step: 'Make the project shop' }, { step: 'Add the app shop-web from sam/shop' }, { step: 'Add Supabase', wired: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] }, { step: 'Deploy shop-web', status: 'finished' }], undo: [] }) },
        { label: 'coolify.build · failed', step: ok('coolify.build', { serverId: sid, goal: 'Make me a Next.js app with Postgres' }, { built: false, done: [{ step: 'Make the project crm', reused: true }, { step: 'Add the app crm-web from sam/crm' }, { step: 'Add a Postgres database', wired: ['DATABASE_URL'] }], failed: { step: 'Deploy crm-web', why: 'The deploy ended as failed.', logTail: ['npm install', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'] }, next: 'The build log’s end is above (coolify.logs with the deployment has all of it). Fix the cause, then ask me to build again: what’s done is reused.' }) },
        { label: 'coolify.create_database', step: ok('coolify.create_database', { serverId: sid, engine: 'postgresql', injectInto: uuid }, { uuid: 'pgnew01', name: 'postgresql', engine: 'postgresql', public: false, status: 'running:healthy', reused: false, wired: ['DATABASE_URL'], undo: 'x' }) },
        { label: 'coolify.control · failed', step: ok('coolify.control', { ...c, action: 'deploy' }, { action: 'deploy', uuid, kind: 'application', status: 'failed', logTail: ['Cloning sam/shop at main', 'Installing packages', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'Build failed: out of memory while installing packages'] }) },
      ];
    })() : []),
    { label: 'sync.run · running', step: { tool: 'sync.run', input: {}, status: 'running' } }, // shown alone, it runs a real sync (see below)
    // a real sync's output, taken from the map's last run
    { label: 'sync.run · done', step: ok('sync.run', {}, { ms: 4200, counts: { apps: 11, databases: 3, servers: 1, domains: 23 }, accounts: only && only !== 'sync.run · done' ? [] : (await runTool('map.get') as any).output?.accounts ?? [], issues: [1, 2, 3], suggestions: 1 }) },
  ];
  return { cards, log: liveLog };
}

function Preview() {
  const [shown, setShown] = useState<{ cards: Shown[]; log: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(3);
  useEffect(() => { startLive(); load().then(setShown, (e) => setErr(e.message)); }, []);
  // the running sync, shown alone, is a real one: its live lines come from Unit7 as it reads each account
  useEffect(() => { if (shown && only === 'sync.run · running') void runTool('sync.run', {}); }, [!!shown]);
  // the running deploy walks through a real log, a line every 1.5s
  useEffect(() => { const i = setInterval(() => setTick((t) => (t >= 9 ? 3 : t + 1)), 1500); return () => clearInterval(i); }, []);
  if (err) return <p className="p-8">Sign in on this Unit7 first ({err}).</p>;
  if (!shown) return <p className="p-8 text-muted">Loading real outputs…</p>;
  const { log } = shown;
  const list = shown.cards.filter((s) => !only || s.label === only);
  return (
    <main className="mx-auto space-y-8 px-4 py-8" style={{ maxWidth: width }}>
      {list.map(({ label, step, question }) => {
        const card = label === 'deployment.create · running'
          ? <DeployCard input={step.input} state="running" lines={log.slice(0, Math.min(tick, log.length - 1))} />
          : toolCard(step, { conversationId: 'preview', question });
        return (
          <section key={label} data-card={label}>
            <p className="mb-2 font-mono text-[11px] text-faint">{label}</p>
            {card ?? <p className="text-[12.5px] text-muted">(no card: {step.status} {step.error ?? ''})</p>}
          </section>
        );
      })}
    </main>
  );
}

// one root, even when this file hot-reloads
const w = window as { cardsRoot?: ReturnType<typeof createRoot> };
(w.cardsRoot ??= createRoot(document.getElementById('root')!)).render(<StrictMode><Preview /></StrictMode>);
