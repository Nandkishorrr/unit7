import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Server, Plus, RefreshCw, Wrench, AlertTriangle, Check, BarChart3, ShieldCheck, Stethoscope, Container, Cpu, ScrollText, ArrowUpRight, Ban, Lightbulb, DatabaseBackup, MapPin } from 'lucide-react';
import { runTool, useApi } from '../lib/api';
import { navigate, useQuery } from '../lib/router';
import { openSignIn } from '../lib/actions';
import { tidy } from '../lib/words';
import { BrandLogo, providerName } from '../brand/BrandLogo';
import { A, act, AiSparkle, Badge, Button, Card, CardHeader, CopyButton, Dialog, Dot, Empty, Field, Input, PageHeader, Skeleton, StatusMark, Tabs, Textarea, toast, cx } from '../ui';
import { DarkCard, DarkChip, LogoTile, reach, stackLogo, Terminal, ago } from './kit';
import { FixButton, ServerSecurityCheck, useSecurity } from './security/SecurityCheck';
import { askOnHome } from './Help';
import { useServerXray, CoolifyChip } from './servers/Xray';
import { size as xsize, type Xray } from './servers/shape';
import { BackupsTab, Overview, useServerPage, type TabId } from './servers/Overview';
import { AppsTab, type AppsView } from './servers/Apps';
import { DataTab } from './servers/Data';
import { AttentionList, AttentionModal, countsLine, useServerWatch, type Item } from './servers/Attention';
import { FirstKeyButton, PrepStatus, RebootWindowCard } from './servers/Automation';
import { FirstKeyModal } from './servers/Automation';
import { Choices } from './choices';
import { pick, type Choice } from '../lib/choices';
import { AddToolButton, ServerRings } from './servers/Tiles';
import { ServerTrafficTab, ServerTrends } from './watch';
import { Timeline } from './story';
import { ClientFilter, useClientFilter } from './organize';
import { AddServerCard, AddServerWelcome } from './servers/AddServer';
import { ClosedPorts, CoolifyDashboardLine } from './servers/CoolifyDomain';
import { BuyServerDialog } from './servers/BuyServer';
import { ServerCare } from './servers/Care';

// --- what we know about a server without asking it ---
const providerOf = (s: any): string | null => (s.provider_ref ? String(s.provider_ref).split(':')[0]! : null);
function usage(s: any) {
  const f = s.facts ?? {};
  const load = Number(String(f.load ?? '').split(' ')[0]);
  return {
    cpu: f.cpus && f.load && Number.isFinite(load) ? Math.min(100, (load / f.cpus) * 100) : null,
    mem: f.mem_total && f.mem_available != null ? ((f.mem_total - f.mem_available) / f.mem_total) * 100 : null,
    disk: f.disk_total && f.disk_used != null ? (f.disk_used / f.disk_total) * 100 : null,
  };
}
const gb = (b?: number) => (b ? `${Math.round(b / 1e9)} GB` : null);
const osName = (os?: string) => (os ? os.replace(/ LTS$/, '').replace(/^(\w+ \d+\.\d+)\.\d+/, '$1') : null);
const HEALTH: Record<string, [tone: 'ok' | 'bad' | 'info' | 'warn' | 'neutral', word: string]> = {
  ready: ['ok', 'Healthy'], unreachable: ['bad', 'Not answering'], error: ['bad', 'Needs a look'], bootstrapping: ['info', 'Setting up…'],
  awaiting_key: ['warn', 'Needs Unit7’s key'], connected: ['neutral', 'Connected'], new: ['neutral', 'New'],
};
HEALTH.rebooting = ['info', 'Restarting…']; // inside its restart window (servers/Automation.tsx)
// its health: the status mark and its word in a quiet pill (healthy breathes softly: it's live)
const HEALTH_MARK = { ok: 'live', bad: 'bad', info: 'work', warn: 'warn', neutral: 'off' } as const;
const HealthMark = ({ status }: { status: string }) => {
  const [tone, word] = HEALTH[status] ?? ['neutral', status];
  return (
    <span className={cx('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface pl-1.5 pr-3 text-[12.5px] font-medium', tone === 'bad' ? 'text-bad' : 'text-ink-2')}>
      <StatusMark state={HEALTH_MARK[tone]} size={20} label={word} />{word}
    </span>
  );
};

// servers whose live look failed in this tab, so the list doesn't call one "Healthy" that just didn't answer
// ponytail: per-tab memory; a real "last answered" field on the server would make it survive reloads
const notAnswering = new Set<string>();

// which apps run on which server
function useApps(graph: any) {
  return useMemo(() => {
    const m = new Map<string, any[]>();
    for (const p of graph?.projects ?? []) for (const e of p.environments) for (const s of e.services) if (s.server_id) m.set(s.server_id, [...(m.get(s.server_id) ?? []), { ...s, project: p, env: e }]);
    return m;
  }, [graph]);
}

// what the server's X-ray found on each server (the map's last look), by server name: its projects that aren't Unit7's
function useFound() {
  const [m, setM] = useState<Map<string, number>>(new Map());
  useEffect(() => { void runTool('map.get').then((r) => { if (r.status === 'ok') setM(new Map((r.output as { assets: { kind: string; name: string; projects?: { system?: boolean }[] }[] }).assets
    .filter((a) => a.kind === 'server').map((a) => [a.name, (a.projects ?? []).filter((p) => !p.system).length]))); }, () => undefined); }, []);
  return m;
}

function AppChips({ apps, max = 6, found = 0, href }: { apps: any[]; max?: number; found?: number; href?: string }) {
  if (!apps.length) return found && href
    ? <p className="text-[12.5px] text-muted">{found} project{found === 1 ? '' : 's'} found on it. <A href={href} className="relative z-10 font-medium text-blue-text hover:underline">See them</A></p>
    : <p className="text-[12.5px] text-muted">Nothing yet. Deploy an app and it lands here.</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {apps.slice(0, max).map((s) => (
        <li key={s.id} className="relative z-10">
          <A href={`/projects/${s.project.id}/services/${s.id}`} title={`${s.name} · ${s.project.name} · ${s.env.name}`}
            className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-line bg-surface pl-1 pr-3 text-[12.5px] font-medium transition hover:border-line-strong hover:bg-raised">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={stackLogo(s)} size={14} /></span>
            <span className="truncate">{s.name}</span><span className="truncate font-normal text-muted">· {s.project.name}</span>
          </A>
        </li>
      ))}
      {apps.length > max && <li className="inline-flex h-8 items-center px-2 text-[12.5px] text-muted">+{apps.length - max} more</li>}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
export function Servers() {
  const graph = useApi<any>('/api/graph');
  const conns = useApi<{ id: string; accounts: unknown[] }[]>('/api/connections', { live: (e) => e.type.startsWith('account.') });
  const q = useQuery();
  const [open, setOpen] = useState(q.get('new') === '1');
  const hostinger = !!conns.data?.find((c) => c.id === 'hostinger')?.accounts.length;
  const clients = useClientFilter();
  const all: any[] = graph.data?.servers ?? [];
  const servers = all.filter((s) => clients.has(s.id));
  const apps = useApps(graph.data);
  const found = useFound();
  return (
    <>
      <PageHeader title="Servers" subtitle="The computers your apps run on. Unit7 sets each one up with Docker, automatic HTTPS, a firewall and security updates."
        actions={<><ClientFilter />{(all.length > 0 || hostinger) && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setOpen(true)}>Add a server</Button>}</>} />
      {!graph.data || !conns.data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading servers"><Skeleton className="h-[330px] rounded-[24px]" /><Skeleton className="h-[330px] rounded-[24px]" /></div>
      ) : all.length === 0 ? (
        <AddServerWelcome hostinger={hostinger} onAdd={() => setOpen(true)} />
      ) : (
        <div className="stagger grid grid-cols-1 gap-4 lg:grid-cols-2">
          {servers.map((s) => <ServerCard key={s.id} s={s} apps={apps.get(s.id) ?? []} found={found.get(s.name)} />)}
          <AddServerCard hostinger={hostinger} onAdd={() => setOpen(true)} />
        </div>
      )}
      {hostinger && <HostingerVps servers={all} onUsed={() => graph.reload()} />}
      <ConnectServer open={open} onClose={() => { setOpen(false); if (q.get('new')) navigate('/servers', { replace: true }); }} />
    </>
  );
}

function ServerCard({ s, apps, found }: { s: any; apps: any[]; found?: number }) {
  const f = s.facts ?? {};
  const prov = providerOf(s);
  const u = usage(s);
  // one truth with the server's page: did it answer the last time Unit7 looked (graph reach), or in this tab
  const down = notAnswering.has(s.id) || s.reach?.ok === false;
  const checked = s.reach?.lastGood ?? f.checkedAt ?? s.last_seen_at;
  return (
    <article className="lift relative flex min-w-0 flex-col rounded-[24px] border border-line bg-surface p-5 shadow-soft md:p-6">
      <div className="flex items-start gap-3.5">
        <span aria-hidden className="icon-grad grid size-[52px] shrink-0 place-items-center rounded-[17px]">{prov ? <BrandLogo id={prov} size={27} /> : <Server size={22} className="text-muted" />}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[19px] font-semibold tracking-[-0.025em]">
            <A href={`/servers/${s.id}`} className="outline-none after:absolute after:inset-0 after:rounded-[24px] focus-visible:after:ring-2 focus-visible:after:ring-blue">{s.name}</A>
          </h2>
          <p className="relative z-10 flex items-center gap-0.5 font-mono text-[12.5px] text-muted">{s.host}<CopyButton text={s.host} /></p>
        </div>
        <HealthMark status={down ? 'unreachable' : s.status} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5 text-[12.5px] font-medium text-ink-2">
        {f.os && <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-raised pl-1.5 pr-3"><span className="grid size-5 place-items-center rounded-full bg-surface"><BrandLogo id={f.os_id ?? 'linux'} size={13} /></span>{osName(f.os)}</span>}
        {prov && <span className="inline-flex h-8 items-center rounded-full bg-raised px-3">{providerName(prov)} VPS</span>}
      </div>
      <div className="mt-4 rounded-[20px] bg-raised/60 px-2 py-2.5">
        <ServerRings serverId={s.id} px={60} sizes className="justify-around" cpu={u.cpu} mem={u.mem} disk={u.disk} cpus={f.cpus} live={false}
          memTotal={f.mem_total} memUsed={f.mem_total && f.mem_available != null ? f.mem_total - f.mem_available : undefined} diskTotal={f.disk_total} diskUsed={f.disk_used} />
      </div>
      <div className="mt-5">
        <p className="mb-2 text-[12px] font-medium text-muted">What runs on it</p>
        <AppChips apps={apps} found={found} href={`/servers/${s.id}?tab=apps`} />
      </div>
      <p className={cx('mt-auto pt-5 text-[12px]', down ? 'text-bad' : 'text-muted')}>{down ? (checked ? `Not answering · last good ${ago(checked)}` : 'Not answering yet') : checked ? `Numbers from the last check, ${ago(checked)}` : 'Not checked yet'}</p>
    </article>
  );
}

// The VPS in your Hostinger account, each one click from being a ready Unit7 server.
function HostingerVps({ servers, onUsed }: { servers: any[]; onUsed: () => void }) {
  const [vps, setVps] = useState<{ id: number; hostname: string; state: string; ip?: string; plan?: string; os?: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [buying, setBuying] = useState(false);
  const load = () => { setErr(null); setVps(null); runTool('hostinger.vps_list', {}).then((r) => (r.status === 'ok' ? setVps((r.output as any).vps) : setErr(r.status === 'error' ? r.error.message : 'Not allowed'))).catch((e) => setErr(e.message)); };
  useEffect(load, []);
  const use = async (id: number, name: string) => {
    setBusy(id);
    const r = await act('hostinger.vps_use', { vmId: id });
    setBusy(null);
    if (r) {
      const o = r.output as { serverId: string; status: string; note?: string };
      if (o.status === 'awaiting_key') toast('warn', `${name} is almost there`, o.note);
      else toast('ok', `${name} is connected`, 'Unit7 is setting it up now: Docker, HTTPS, firewall. Takes a few minutes.');
      onUsed();
      navigate(`/servers/${o.serverId}`);
    }
  };
  return (
    <Card className="mt-6 p-5 md:p-6 animate-rise">
      <CardHeader icon={<BrandLogo id="hostinger" size={20} />} title="Your Hostinger servers" sub="One click from ready" />
      <BuyServerDialog open={buying} onClose={() => setBuying(false)} />
      {err ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[16px] bg-raised px-4 py-3">
          <p className="min-w-[200px] flex-1 text-[13px] text-ink-2" title={err}>Couldn’t load them from Hostinger right now. If it keeps happening, sign in to Hostinger again.</p>
          <Button size="sm" variant="ghost" onClick={() => openSignIn('hostinger', 'Hostinger')}>Sign in again</Button>
          <Button size="sm" variant="soft" icon={<RefreshCw size={13} />} onClick={load}>Try again</Button>
        </div>
      ) : !vps ? <Skeleton className="mt-4 h-16" /> : vps.length === 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[16px] bg-raised px-4 py-3">
          <p className="flex-1 text-[13px] text-muted">No VPS in this Hostinger account yet. Buy one here and Unit7 sets it up.</p>
          <Button size="sm" variant="primary" onClick={() => setBuying(true)}>Buy a server</Button>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {vps.map((v) => {
            const used = servers.find((s) => s.host === v.ip);
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-3 py-3">
                <LogoTile id="hostinger" size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{v.hostname}</p>
                  <p className="truncate text-[12px] text-muted"><span className="font-mono">{v.ip ?? 'no IP yet'}</span>{v.plan && ` · ${v.plan}`}{v.os && ` · ${v.os}`} · {v.state}</p>
                </div>
                {used ? <A href={`/servers/${used.id}`} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ok hover:underline"><Check size={13} strokeWidth={3} />Managed by Unit7</A>
                  : <Button size="sm" variant="primary" loading={busy === v.id} disabled={!v.ip || busy !== null} onClick={() => use(v.id, v.hostname)}>Use this server</Button>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// stay: the chat's "Set it up" keeps you in the chat afterwards (the server's page is a link away)
export function ConnectServer({ open, onClose, stay, onConnected }: { open: boolean; onClose: () => void; stay?: boolean; onConnected?: () => void }) {
  const [f, setF] = useState({ name: '', host: '', port: '22', username: 'root', privateKey: '' });
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<{ serverId: string; publicKey: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await act('server.connect', { name: f.name, host: f.host, port: Number(f.port), username: f.username, privateKey: f.privateKey || undefined });
    setBusy(false);
    if (r) {
      if (r.output.status === 'awaiting_key') setGenerated({ serverId: r.output.serverId, publicKey: r.output.publicKey });
      else { toast('ok', `Connected ${f.name}`); onConnected?.(); onClose(); if (!stay) navigate(`/servers/${r.output.serverId}`); }
    }
  };
  if (generated) {
    const cmd = `mkdir -p ~/.ssh && echo "${generated.publicKey}" >> ~/.ssh/authorized_keys`;
    return (
      <Dialog open={open} onClose={onClose} title="Add this key to your server" wide>
        <div className="space-y-4">
          <p className="text-[13px] text-muted">Unit7 made a login key. Add it to your server, then Unit7 can connect. Most VPS providers let you paste it when you create the server, or run this on the box:</p>
          <div className="relative"><pre className="overflow-auto rounded-[16px] bg-[#111115] p-4 pr-12 font-mono text-[11.5px] text-white/85">{cmd}</pre><CopyButton text={cmd} className="absolute right-2 top-2 text-white/70 hover:bg-white/10 hover:text-white" /></div>
          <div className="flex flex-wrap items-center gap-3 rounded-[16px] bg-raised px-4 py-3"><p className="min-w-0 flex-1 basis-[220px] text-[13px] text-ink-2">A new server with only a root password? Type it once: Unit7 adds the key itself and forgets the password.</p><FirstKeyButton serverId={generated.serverId} name={f.name || 'the server'} onDone={() => { onConnected?.(); onClose(); if (!stay) navigate(`/servers/${generated.serverId}`); }} /></div>
          <div className="flex justify-end"><Button variant="primary" onClick={async () => { const r = await act('server.repair', { serverId: generated.serverId, fix: 'check-key' }); if (r) { toast('ok', 'Connected'); onConnected?.(); onClose(); if (!stay) navigate(`/servers/${generated.serverId}`); } }}>I’ve added it, connect</Button></div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open={open} onClose={onClose} title="Add a server you already have">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="production-1" /></Field>
        <div className="grid grid-cols-[1fr_90px] gap-3">
          <Field label="Address (IP)"><Input required value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="203.0.113.5" /></Field>
          <Field label="SSH port"><Input value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field>
        </div>
        <Field label="User"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Private key" hint="Leave it empty and Unit7 makes a key for you to add to the server.">
          <Textarea rows={3} value={f.privateKey} onChange={(e) => setF({ ...f, privateKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" className="font-mono text-[11.5px]" spellCheck={false} />
        </Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy}>Connect</Button></div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// One server, calm: a header with its health in one word and three small rings, then seven tabs. Overview is four
// tiles; Apps the projects; Data its databases; Traffic the graph; Health what needs a look, usage over time, security and backups;
// Changes what changed and who did it; Advanced the raw things. Each fact sits in one place.
const TABS: { value: TabId; label: string }[] = [
  { value: 'overview', label: 'Overview' }, { value: 'apps', label: 'Apps' }, { value: 'data', label: 'Data' }, { value: 'traffic', label: 'Traffic' }, { value: 'health', label: 'Health' }, { value: 'changes', label: 'Changes' }, { value: 'advanced', label: 'Advanced' },
];
// the old tabs' links still land in the right place
const LEGACY: Record<string, [TabId, AppsView?]> = { map: ['apps'], domains: ['apps', 'domains'], databases: ['apps', 'databases'], jobs: ['apps', 'jobs'], backups: ['health'] };
const VIEWS: AppsView[] = ['projects', 'domains', 'databases', 'jobs'];

function HealthWord({ status, checking }: { status: string; checking: boolean }) {
  const [tone, word] = checking ? (['info', 'Checking'] as const) : HEALTH[status] ?? ['neutral', status];
  return <span className={cx('inline-flex items-center gap-1.5 font-medium', tone === 'bad' ? 'text-bad' : 'text-ink')}><span aria-hidden className="contents"><StatusMark state={HEALTH_MARK[tone]} size={18} /></span>{word}</span>;
}
// one fact on the header's line, after a small dot (lead: the first one, which starts its own line on phones)
const Fact = ({ children, lead }: { children: ReactNode; lead?: boolean }) => (
  <span className="inline-flex items-center gap-1.5 text-ink-2"><span aria-hidden className={cx('mr-0.5 size-[3px] rounded-full bg-faint', lead && 'max-sm:hidden')} />{children}</span>
);

export function ServerDetail({ id }: { id: string }) {
  // what Unit7 already knows shows at once; the X-ray and the live look at the machine fill in behind it
  const graph = useApi<any>('/api/graph');
  const q = useQuery();
  const raw = q.get('tab') ?? '';
  const legacy = LEGACY[raw];
  const tab: TabId = legacy?.[0] ?? (TABS.some((t) => t.value === raw) ? (raw as TabId) : 'overview');
  const view: AppsView = legacy?.[1] ?? (VIEWS.includes(q.get('view') as AppsView) ? (q.get('view') as AppsView) : 'projects');
  const go = (t: TabId, v?: AppsView) => navigate(`/servers/${id}${t === 'overview' ? '' : `?tab=${t}${t === 'apps' && v && v !== 'projects' ? `&view=${v}` : ''}`}`, { replace: true });
  const [live, setLive] = useState<any>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [metrics, setMetrics] = useState<any>(null);
  const [att, setAtt] = useState<Item | 'all' | null>(null);
  const base = graph.data?.servers.find((s: any) => s.id === id);
  const name = base?.name ?? 'this server';
  const sx = useServerXray(id);
  const page = useServerPage(sx, name, true);
  const w = useServerWatch(id);
  const loadMetrics = async () => { const r = await runTool('server.metrics', { serverId: id }); if (r.status === 'ok') setMetrics(r.output); };
  const inflight = useRef(false);
  const load = async () => {
    if (inflight.current) return; // one look at a time (and once, when React runs the effect twice)
    inflight.current = true;
    setChecking(true);
    const r = await runTool('server.inspect', { serverId: id }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    inflight.current = false;
    setChecking(false);
    if (r.status === 'ok') { notAnswering.delete(id); setLive(r.output); setProblem(null); void loadMetrics(); }
    else if (r.status === 'error') { notAnswering.add(id); setProblem(r.error.message); }
    else setProblem('Unit7 isn’t allowed to look at this server.');
  };
  useEffect(() => { void load(); }, [id]);
  // fresh numbers every 15s, only while the server answers and this page is on screen
  useEffect(() => {
    if (!live || problem) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void loadMetrics(); }, 15000);
    return () => clearInterval(t);
  }, [id, live, problem]);
  if (!graph.data) return <div className="space-y-4" aria-busy="true" aria-label="Loading the server"><Skeleton className="h-[508px] rounded-[24px] sm:h-[385px] lg:h-[237px] xl:h-[205px]" /><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[220px] rounded-[24px]" />)}</div></div>;
  if (!base) return <Empty title="Server not found" body="It may have been removed." action={<A href="/servers" className="font-medium text-blue-text hover:underline">Back to servers</A>} />;

  const x = sx.x;
  const f = { ...(base.facts ?? {}), ...(live ?? {}) };
  const prov = providerOf(base);
  const reachable = !!live && !problem;
  // the page's own fresh look wins; before it's back, the last answer Unit7 has (the same one the list shows)
  const down = !!problem || (x ? !!x.stale : base.reach?.ok === false);
  const lastGood = x?.stale ? x.stale.since : base.reach?.lastGood;
  const status = down ? 'unreachable' : base.status;
  const why = problem ? reach(problem, name) : null;
  const hw = x?.server ?? {};
  const m = metrics?.now;
  const u = m ? { cpu: m.cpu, mem: m.memPct, disk: m.diskPct } : usage({ facts: { ...f, mem_total: f.mem_total ?? hw.memTotal, mem_available: f.mem_available ?? hw.memAvailable, disk_total: f.disk_total ?? hw.diskTotal, disk_used: f.disk_used ?? hw.diskUsed, cpus: f.cpus ?? hw.cpus, load: f.load ?? hw.load } });
  const checkedAt = f.checkedAt ?? base.last_seen_at;
  const age = down ? (lastGood ? `last good ${ago(lastGood)}` : 'not answering yet') : checking && !live && !x ? 'looking…' : checkedAt ? `checked ${ago(checkedAt)}` : 'not checked yet';
  const lookAgain = () => { void load(); void sx.rescan(); w.reload(); };
  const doctor = <Doctor serverId={id} name={name} auto={!!problem} onFixed={load} className="self-start lg:col-span-7" />;
  const security = <Security server={base} facts={{ ...f, ...(x?.coolify && !f.web ? { web: 'coolify-proxy|traefik' } : {}) }} reachable={reachable} onDone={() => graph.reload()} className="self-start lg:col-span-5" />;
  // the card's tint follows its health: green when fine, amber when something needs a look (or a ring is in the red)
  const htone = HEALTH[status]?.[0] ?? 'neutral';
  const headTone = htone === 'ok' && [u.cpu, u.mem, u.disk].some((v) => v != null && v >= 90) ? 'warn' : htone;
  const os = osName(hw.os ?? f.os);

  return (
    <>
      <section aria-label={`${base.name} at a glance`} data-tone={headTone} className="srv-head mb-4 rounded-[24px] border border-line bg-surface shadow-soft animate-rise">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5 md:p-6">
          {/* on phones the line of facts runs the full width under the name; from sm it sits under the name, by the logo */}
          <div className="grid min-w-0 flex-1 basis-[300px] grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 sm:gap-y-1">
            <span aria-hidden className="icon-grad grid size-12 shrink-0 place-items-center rounded-[16px] sm:row-span-2 sm:size-14 sm:rounded-[18px] md:size-[60px] md:rounded-[20px]">{prov ? <BrandLogo id={prov} size={28} /> : <Server size={24} className="text-muted" />}</span>
            <div className="min-w-0">
              <p className="text-[12.5px] text-muted"><A href="/servers" className="hover:text-ink hover:underline">Servers</A> <span aria-hidden>/</span></p>
              <h1 className="truncate text-[26px] font-semibold leading-tight tracking-[-0.04em] md:text-[30px]">{base.name}</h1>
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] sm:col-span-1 sm:col-start-2">
              <HealthWord status={status} checking={checking && !live && !x && !down} />
              <span className="text-muted">{age}</span>
              <button type="button" onClick={lookAgain} disabled={sx.scanning} aria-label="Look again" title="Look again: one quick read-only trip to the server"
                className="-ml-1 grid size-7 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink disabled:opacity-60"><RefreshCw size={13} className={cx(sx.scanning && 'animate-spin')} /></button>
              <span aria-hidden className="basis-full sm:hidden" />
              {os && <Fact lead><BrandLogo id={f.os_id ?? 'linux'} size={14} />{os}</Fact>}
              {f.region && <Fact lead={!os}><MapPin size={13} aria-hidden className="text-muted" />{f.region}</Fact>}
              <Fact lead={!os && !f.region}><span className="font-mono text-[12px] text-muted">{base.host}</span><CopyButton text={base.host} className="-ml-1" /></Fact>
              {x?.coolify ? <CoolifyChip x={x} /> : sharedWith(f) === 'Coolify' && (
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line-strong bg-surface pl-1.5 pr-2.5 text-[12.5px] font-medium text-ink-2"><BrandLogo id="coolify" size={14} />Shared with Coolify</span>
              )}
              {x?.coolify && <CoolifyDashboardLine serverId={id} />}
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:flex-nowrap">
            <ServerRings serverId={id} className="flex-1 justify-around sm:flex-none" cpu={u.cpu} mem={u.mem} disk={u.disk} cpus={f.cpus ?? hw.cpus} live={!!m}
              memTotal={m?.memTotal ?? f.mem_total ?? hw.memTotal} memUsed={m?.memUsed ?? (f.mem_total ? f.mem_total - f.mem_available : hw.memTotal && hw.memAvailable != null ? hw.memTotal - hw.memAvailable : undefined)}
              diskTotal={m?.diskTotal ?? f.disk_total ?? hw.diskTotal} diskUsed={m?.diskUsed ?? f.disk_used ?? hw.diskUsed} />
            <AddToolButton serverId={id} className="w-full justify-center sm:w-auto" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-b-[24px] border-t border-line bg-raised/40 px-3 py-2.5 md:px-5">
          <Tabs value={tab} onChange={(t) => go(t)} tabs={TABS} />
          <button type="button" onClick={() => askOnHome(`On my server ${base.name}, `)} title="Opens Home with this server in the ask box"
            className="group flex h-11 w-full items-center gap-2.5 rounded-full border border-line-strong bg-surface pl-4 pr-1.5 text-left text-[13.5px] text-muted shadow-soft transition hover:border-blue/45 hover:text-ink focus-visible:ring-4 focus-visible:ring-blue-soft sm:ml-auto sm:w-[340px]">
            <AiSparkle size={18} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Ask or do something on this server…</span>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-bg transition group-hover:bg-blue group-hover:text-white"><ArrowUpRight size={15} /></span>
          </button>
        </div>
      </section>

      <div key={tab} className="animate-[fade_0.25s_ease-out]">
        {tab === 'overview' && <PrepStatus serverId={id} status={base.status} facts={f} onChanged={() => { graph.reload(); void load(); }} />}
        {tab === 'overview' && <Overview sx={sx} page={page} w={w} serverName={name} doctor={doctor} problem={!!problem} onTab={go} onItem={setAtt} />}
        {tab === 'apps' && <AppsTab sx={sx} page={page} serverName={name} view={view} onView={(v) => go('apps', v)} />}
        {tab === 'data' && <DataTab sx={sx} serverId={id} />}
        {tab === 'traffic' && <ServerTrafficTab serverId={id} />}
        {tab === 'health' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {problem && <div className="lg:col-span-12">{doctor}</div>}
            <div className="min-w-0 space-y-4 lg:col-span-7">
              <Card className="min-w-0 p-5 md:p-6">
                <CardHeader icon={<Lightbulb size={19} />} title="Risks, waste and tips" sub={w.items.length ? countsLine(w.counts) : 'What Unit7 found, each with its fix'}
                  actions={<Button size="sm" variant="ghost" loading={w.busy} icon={<RefreshCw size={13} />} onClick={() => w.reload(true)}>Check again</Button>} />
                <div className="mt-4"><AttentionList w={w} onOpen={setAtt} /></div>
              </Card>
              <Card className="min-w-0 p-5 md:p-6"><CardHeader icon={<BarChart3 size={19} />} title="Usage over time" sub="Normal for this server, and what changed" /><div className="mt-4"><ServerTrends serverId={id} /></div></Card>
              <RebootWindowCard serverId={id} name={name} />
            </div>
            {security}
            <section aria-labelledby="backups-h" className="min-w-0 lg:col-span-12">
              <h2 id="backups-h" className="mb-3 flex items-center gap-2 px-1 text-[16px] font-semibold tracking-[-0.015em]"><DatabaseBackup size={17} className="text-muted" />Backups</h2>
              <BackupsTab serverId={id} serverName={name} sx={sx} />
            </section>
          </div>
        )}
        {tab === 'changes' && <Timeline serverId={id} title={`What changed on ${name}`} />}
        {tab === 'advanced' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {reachable && !f.caddy && !x?.coolify && (
              <Card className="flex flex-wrap items-center gap-3 p-5 lg:col-span-12">
                <p className="min-w-[200px] flex-1 text-[13.5px] text-ink-2">Prepare this server: Docker, automatic HTTPS, a firewall and security updates.</p>
                <Button variant="primary" icon={<Wrench size={15} />} onClick={() => act('server.bootstrap', { serverId: id }, { success: 'Server prepared' }).then(load)}>Prepare it</Button>
              </Card>
            )}
            <About base={base} f={f} x={x} prov={prov} className="self-start lg:col-span-5" />
            <Containers serverId={id} reachable={reachable} why={why} metrics={metrics} className="self-start lg:col-span-7" />
            <Processes serverId={id} reachable={reachable} why={why} className="self-start lg:col-span-5" />
            {x && <Ports x={x} className="self-start lg:col-span-7" />}
            {x?.disk && <DiskParts x={x} className="self-start lg:col-span-5" />}
            {!problem && <Doctor serverId={id} name={name} auto={false} onFixed={load} className="self-start lg:col-span-7" />}
            <ServerLogs serverId={id} reachable={reachable} why={why} />
            <ServerCare serverId={id} name={name} provider={prov} coolify={!!x?.coolify} others={(graph.data.servers as { id: string; name: string }[]).filter((o) => o.id !== id)} />
          </div>
        )}
      </div>
      {page.modals}
      <AttentionModal w={w} open={att} onClose={() => setAtt(null)} />
    </>
  );
}

// the plain facts about the machine, once
function About({ base, f, x, prov, className }: { base: any; f: any; x: Xray | null; prov: string | null; className?: string }) {
  const hw = x?.server ?? {};
  const others = (x?.paas ?? []).filter((p) => p.id !== 'coolify');
  const rows: [string, ReactNode][] = [
    ...(prov ? [['Provider', <span key="p" className="inline-flex items-center gap-1.5"><BrandLogo id={prov} size={14} />{providerName(prov)} VPS</span>] as [string, ReactNode]] : []),
    ...((hw.os ?? f.os) ? [['System', <span key="o" className="inline-flex items-center gap-1.5"><BrandLogo id={f.os_id ?? 'linux'} size={14} />{osName(hw.os ?? f.os)}</span>] as [string, ReactNode]] : []),
    ['Size', [f.cpus ?? hw.cpus ? `${f.cpus ?? hw.cpus} CPUs` : '', gb(hw.memTotal ?? f.mem_total) && `${gb(hw.memTotal ?? f.mem_total)} memory`, gb(hw.diskTotal ?? f.disk_total) && `${gb(hw.diskTotal ?? f.disk_total)} disk`].filter(Boolean).join(' · ') || 'Not measured yet'],
    ['Address', <span key="a" className="inline-flex items-center font-mono text-[12.5px]">{base.host}<CopyButton text={base.host} /></span>],
    ...((hw.docker ?? f.docker) ? [['Docker', String(hw.docker ?? f.docker)] as [string, ReactNode]] : []),
    ...(x?.coolify ? [['Coolify', x ? <CoolifyChip key="c" x={x} /> : null] as [string, ReactNode]] : []),
    ...(others.length ? [['Also runs', others.map((p) => p.name).join(', ')] as [string, ReactNode]] : []),
  ];
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<Server size={19} />} title="About this server" sub={x ? `Unit7 looked inside ${ago(x.at)}` : 'What Unit7 knows about the machine'} />
      <dl className="mt-4 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
        {rows.map(([k, v]) => <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="min-w-0 text-ink-2">{v}</dd></Fragment>)}
      </dl>
      {x && x.notes.length > 0 && <ul className="mt-4 space-y-1 border-t border-line pt-3 text-[12.5px] text-muted">{x.notes.map((n) => <li key={n}>{tidy(n)}</li>)}</ul>}
    </Card>
  );
}

// the open doors, from the X-ray: which program answers, and whether the internet can reach it
function Ports({ x, className }: { x: Xray; className?: string }) {
  const byId = new Map(x.parts.map((p) => [p.id, p]));
  const rows = [...x.ports].sort((a, b) => +b.public - +a.public || a.port - b.port);
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<ShieldCheck size={19} />} title="Open ports" sub={`${rows.filter((r) => r.public).length} reachable from the internet`} />
      <ul className="mt-4 divide-y divide-line">
        {rows.map((r) => (
          <li key={`${r.proto}${r.port}${r.ip}`} className="flex items-center gap-3 py-2 text-[13px]">
            <span className="tabular w-14 shrink-0 font-mono font-medium">{r.port}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{(r.part && byId.get(r.part)?.name) ?? r.process ?? 'Unknown program'}</span>
            {r.public ? <Badge tone="warn">Internet</Badge> : r.blockedBy === 'unit7' ? <Badge tone="ok">Closed by Unit7</Badge> : <Badge>Only this server</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
function DiskParts({ x, className }: { x: Xray; className?: string }) {
  const d = x.disk!;
  const rows = [['Images', d.images], ['Images nothing uses', d.imagesUnused], ['Build cache', d.buildCache], ['Can be cleaned up', d.reclaimable]] as const;
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<Container size={19} />} title="Docker’s disk" sub="Images and build cache" />
      <dl className="mt-4 divide-y divide-line">{rows.filter(([, v]) => v != null).map(([k, v]) => <div key={k} className="flex justify-between py-2 text-[13px]"><dt className="text-ink-2">{k}</dt><dd className="tabular font-medium">{xsize(v)}</dd></div>)}</dl>
    </Card>
  );
}

// --- the safety basics, in plain words, each with its fix ---
// who else answers on the web ports (the same reading as the server's proxyOf): a server shared with Coolify keeps
// its own ports, so Unit7 never turns a firewall on there and closes single ports instead
function sharedWith(f: any): string | null {
  const [name = '', image = ''] = String(f.web ?? '').split('|');
  if (!name || name === 'unit7-caddy') return f.web || !(f.ports ?? []).some((p: number) => p === 80 || p === 443) ? null : 'another program';
  return name === 'coolify-proxy' && image.startsWith('traefik') ? 'Coolify' : name;
}
const COOLIFY_PORTS = [8000, 6001, 6002];

function Security({ server, facts: f, reachable, onDone, className }: { server: any; facts: any; reachable: boolean; onDone: () => void; className?: string }) {
  const [blocks, setBlocks] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sec = useSecurity(server.id);
  const load = () => void runTool('shield.list', { serverId: server.id }).then((r) => setBlocks(r.status === 'ok' ? r.output : []));
  useEffect(load, [server.id]);
  const shared = sharedWith(f);
  const ports: number[] = f.ports ?? [];
  const extra = ports.filter((p) => ![22, server.port, 80, 443].includes(p) && !(shared === 'Coolify' && COOLIFY_PORTS.includes(p)));
  const checkPorts = !sec.running && reachable && <Button size="sm" variant="dark" icon={<ShieldCheck size={13} />} onClick={sec.check}>Find the open ones</Button>;
  const rows: { ok: boolean | null; title: string; hint: string; action?: ReactNode }[] = [
    f.ufw === 'active' ? { ok: true, title: 'The firewall is on', hint: 'It blocks everything except what your apps need.' }
      : shared ? { ok: true, title: 'No firewall, on purpose', hint: `This server is shared with ${shared}, which needs its own ports. Unit7 closes single ports instead of turning a firewall on.` }
      : !f.checkedAt ? { ok: null, title: 'Firewall not checked yet', hint: 'Unit7 looks the next time it checks in.' }
      : { ok: false, title: 'The firewall is off', hint: 'A firewall keeps every door shut except the ones your apps need.',
        action: reachable && <FixButton strong onDone={onDone} fix={{ tool: 'server.bootstrap', input: { serverId: server.id, swap: false, securityUpdates: false }, label: 'Turn it on', change: 'Only sign-in (SSH) and web (80, 443) stay open. Everything else stays as it is.' }} /> },
    { ok: ports.length ? !extra.length : null, title: !ports.length ? 'Open doors not checked yet' : extra.length ? `${extra.length} more port${extra.length === 1 ? ' is' : 's are'} listening` : 'Only web and sign-in doors are open',
      hint: !ports.length ? 'Unit7 looks the next time it checks in.' : extra.length ? `Listening: ${extra.join(', ')}. Not all of them reach the internet; the check below finds the ones that do and closes them one by one.` : `Open: ${ports.join(', ')}`,
      action: extra.length > 0 && checkPorts },
    {
      ok: !!f.hardenedAt, title: f.hardenedAt ? 'Logins need a key, not a password' : 'Logins aren’t locked down yet',
      hint: f.hardenedAt ? `Locked down ${ago(f.hardenedAt)}. Security updates install themselves.` : 'Passwords can be guessed; keys can’t. This also turns on automatic security updates.',
      action: !f.hardenedAt && (reachable ? <FixButton strong onDone={onDone} fix={{ tool: 'server.harden', input: { serverId: server.id }, label: 'Lock it down', change: 'Turns off password logins (keys still work) and turns on automatic security updates.' }} />
        : <Button size="sm" variant="primary" disabled title="Unit7 needs to reach the server first">Lock it down</Button>),
    },
    f.caddy ? { ok: true, title: 'HTTPS is automatic', hint: 'Every domain gets a certificate and renews it.' }
      : shared === 'Coolify' ? { ok: true, title: 'HTTPS by Coolify’s proxy', hint: 'Coolify’s proxy gets and renews the certificates for every domain here.' }
      : { ok: shared ? null : false, title: 'HTTPS isn’t set up yet', hint: shared ? `${shared} answers on the web ports, so Unit7 can’t add HTTPS here.` : 'Prepare the server and every domain gets a certificate.',
        action: !shared && reachable && <FixButton onDone={onDone} fix={{ tool: 'server.bootstrap', input: { serverId: server.id }, label: 'Prepare it', change: 'Installs Docker and the web proxy with automatic HTTPS, turns on the firewall and security updates.' }} /> },
  ];
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<ShieldCheck size={19} />} title="Security" sub="The basics, in plain words" />
      <ul className="mt-4 space-y-1">
        {rows.map((r) => (
          <li key={r.title} className="flex items-start gap-3 rounded-[16px] px-1 py-2">
            <StatusMark state={r.ok ? 'ok' : r.ok === false ? 'warn' : 'off'} size={30} label={r.ok ? 'Fine' : r.ok === false ? 'Needs a look' : 'Not checked yet'} className="shrink-0" />
            <div className="min-w-0 flex-1"><p className="text-[13.5px] font-medium">{r.title}</p><p className="text-[12.5px] text-muted">{r.hint}</p>{r.action && <div className="mt-1">{r.action}</div>}</div>
          </li>
        ))}
      </ul>
      <div className="mt-4 rounded-[18px] bg-raised p-4">
        <p className="flex items-center gap-2 text-[13.5px] font-medium"><Ban size={15} className="text-bad" />Shield {blocks?.length ? `blocked ${blocks.length} address${blocks.length === 1 ? '' : 'es'}` : 'hasn’t had to block anyone'}</p>
        {!blocks ? <Skeleton className="mt-3 h-8" /> : blocks.length > 0 && (
          <ul className="mt-2 divide-y divide-line">
            {blocks.map((b) => (
              <li key={b.ip} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
                <span className="font-mono text-ink">{b.ip}</span><span className="text-muted">{b.reason}{b.expiresIn ? ` · ${b.expiresIn} more` : ''}</span>
                <Button size="sm" variant="ghost" className="ml-auto" loading={busy === b.ip} onClick={async () => { setBusy(b.ip); await act('shield.unblock', { serverId: server.id, ip: b.ip }, { success: `Unblocked ${b.ip}` }); setBusy(null); load(); }}>Unblock</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ClosedPorts serverId={server.id} className="mt-3" />
      <ServerSecurityCheck sec={sec} name={server.name} />
    </Card>
  );
}

// "Something wrong? Run a check": Unit7 finds out why a server can't be reached, says it plainly,
// and offers the fix. Runs by itself when the server isn't answering.
function Doctor({ serverId, name, auto, onFixed, className }: { serverId: string; name: string; auto: boolean; onFixed: () => void; className?: string }) {
  const [d, setD] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rootPw, setRootPw] = useState(false); // "Use the root password once": its own pop-up
  const asking = useRef(false);
  const check = async () => {
    if (asking.current) return; // one check at a time: the page asks once, however often it renders
    asking.current = true;
    setRunning(true);
    const r = await runTool('server.diagnose', { serverId }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    asking.current = false;
    setRunning(false);
    // the checks are written server-side under the product's old name
    setD(r.status === 'ok' ? JSON.parse(JSON.stringify(r.output).replace(/\bForge\b/g, 'Unit7')) : { error: r.status === 'error' ? r.error.message : 'Unit7 couldn’t run the check.' });
  };
  useEffect(() => { if (auto && !d && !running) void check(); }, [auto]);
  const repair = async (fix: string) => {
    setBusy(fix);
    const r = await act('server.repair', { serverId, fix });
    setBusy(null);
    if (r) { toast('ok', r.output.done); if (r.output.thenCheck) setTimeout(() => { void check(); onFixed(); }, fix === 'restart' || fix === 'start' ? 45000 : 4000); else onFixed(); }
  };
  const fine = d?.cause === 'ok';
  return (
    <Card className={cx('flex flex-col p-5 md:p-6', className)}>
      <CardHeader icon={<Stethoscope size={19} />} tone={d && !d.error && !fine ? 'bad' : fine ? 'ok' : 'neutral'} title={d ? 'Health check' : 'Something wrong?'}
        sub={d && !d.error ? `Checked ${ago(d.at)}` : 'Run a check'} actions={(d || running) && <Button size="sm" variant="soft" icon={<RefreshCw size={13} />} loading={running} onClick={check}>Check again</Button>} />
      {!d ? (
        <div className="mt-5 flex flex-1 flex-col items-start justify-between gap-4 rounded-[18px] bg-raised p-4 sm:flex-row sm:items-center">
          <p className="text-[13.5px] text-ink-2">If {name} acts up, Unit7 checks the connection, the login and the provider, then offers a fix.</p>
          <Button variant="dark" loading={running} icon={<Stethoscope size={15} />} onClick={check}>{running ? 'Checking…' : 'Run a check'}</Button>
        </div>
      ) : d.error ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-[18px] bg-bad/8 px-4 py-3 text-[13px]"><AlertTriangle size={16} className="text-bad" /><span className="min-w-0 flex-1">{d.error}</span></div>
      ) : (
        <div className="mt-4 space-y-4">
          <div><p className={cx('text-[15px] font-semibold tracking-[-0.01em]', !fine && 'text-bad')}>{d.title}</p>{d.explain && <p className="mt-0.5 text-[13.5px] text-ink-2">{d.explain}</p>}</div>
          {d.checks?.length > 0 && (
            <ul className="space-y-1 rounded-[18px] bg-raised p-3">
              {d.checks.map((c: any, i: number) => (
                <li key={c.name} className="flex items-start gap-2.5 text-[12.5px]" style={{ animation: `pop-in .3s var(--ease-out-soft) ${i * 70}ms both` }}>
                  <StatusMark state={c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'off'} size={17} label={c.ok === true ? 'Fine' : c.ok === false ? 'Problem' : 'Not checked'} className="mt-px" />
                  <span className="min-w-0"><span className="font-medium text-ink">{c.name}</span> <span className="text-muted">· {c.detail}</span></span>
                </li>
              ))}
            </ul>
          )}
          {d.fixes?.length > 0 && (
            <div>
              <p className="mb-2 text-[13px] font-medium">Can Unit7 fix it for you?</p>
              {/* the repairs as one choice row: the check's first fix recommended; the root password is a person's, in its own pop-up */}
              <Choices label="Ways to fix it" disabled={!!busy} onPick={(c) => { if (c.key === 'rootpw') setRootPw(true); else void repair(c.key!.slice(4)); return true; }}
                choices={pick([...d.fixes.map((x: any, i: number): Choice => ({ key: `fix:${x.id}`, label: x.label, tool: 'server.repair', change: x.explain, recommended: i === 0,
                  why: `it fixes what the check found${x.explain ? `: ${String(x.explain).charAt(0).toLowerCase()}${String(x.explain).slice(1)}` : ''}` })),
                  (d.cause === 'key' || d.cause === 'no-key') && { key: 'rootpw', label: 'Use the root password once', peopleOnly: true, change: 'No SSH access from this Mac? Type the server’s root password once: Unit7 adds its key and forgets the password.' }])} />
              {busy && <p role="status" className="mt-2 text-[12.5px] text-muted">Working on it…</p>}
              <FirstKeyModal open={rootPw} serverId={serverId} name={name} onClose={() => setRootPw(false)} onDone={() => { void check(); onFixed(); }} />
            </div>
          )}
          {d.manual && (
            <details className="rounded-[18px] border border-line px-4 py-3 text-[12.5px]" open={!d.fixes?.length}>
              <summary className="cursor-pointer font-medium text-ink-2">Or do it yourself</summary>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink-2">
                {d.manual.steps.map((stp: string, i: number) => <li key={i}>{d.manual.link && stp.includes('provider') ? <>{stp} <a href={d.manual.link} target="_blank" rel="noopener" className="font-medium text-blue-text hover:underline">Open Hostinger</a></> : stp}</li>)}
              </ol>
              {d.manual.command && <div className="mt-2 flex items-center gap-2 rounded-[12px] bg-raised px-3 py-2"><code className="flex-1 break-all font-mono text-[12px] text-ink">{d.manual.command}</code><CopyButton text={d.manual.command} /></div>}
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

const Unreachable = ({ why, what }: { why: string | null; what: string }) => (
  <p className="mt-4 rounded-[16px] bg-raised px-4 py-6 text-center text-[13px] text-muted">{why ? <>{why} {what} show up once it answers.</> : 'Looking…'}</p>
);

function Containers({ serverId, reachable, why, metrics, className }: { serverId: string; reachable: boolean; why: string | null; metrics: any; className?: string }) {
  const [list, setList] = useState<any[] | null>(null);
  const [all, setAll] = useState(false);
  const load = async () => { const r = await runTool('docker.list', { serverId }); setList(r.status === 'ok' ? r.output : []); };
  useEffect(() => { if (reachable) void load(); }, [serverId, reachable]);
  const stat = (n: string) => metrics?.now?.containers?.find((c: any) => c.name === n);
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<Container size={19} />} title="Containers" sub={list ? `${list.length} running boxes for your apps` : 'The boxes your apps run in'}
        actions={reachable && <Button size="sm" variant="soft" icon={<RefreshCw size={13} />} onClick={load}>Refresh</Button>} />
      {!reachable ? <Unreachable why={why} what="Its containers" /> : !list ? <Skeleton className="mt-4 h-[420px]" /> : !list.length ? <p className="mt-4 text-[13px] text-muted">None yet.</p> : (
        <ul className="mt-4 divide-y divide-line">
          {(all ? list : list.slice(0, 10)).map((c) => {
            const s = stat(c.Names);
            const up = /Up/.test(c.Status);
            return (
              <li key={`${c.ID}:${c.Names}`} className="flex items-center gap-3 py-2.5 text-[13px]">
                <Dot tone={up ? 'ok' : 'bad'} />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{c.Names}</span><span className="block truncate font-mono text-[11.5px] text-muted">{c.Image}</span></span>
                {s && <span className="tabular hidden text-[12px] text-ink-2 sm:block">{Math.round(Number(s.cpu) * 10) / 10}% CPU · {s.mem}</span>}
                <span className="shrink-0 text-[12px] text-muted">{c.Status}</span>
              </li>
            );
          })}
          {list.length > 10 && !all && <li className="pt-2"><button type="button" onClick={() => setAll(true)} className="inline-flex h-8 items-center rounded-full px-2.5 text-[12.5px] font-medium text-blue-text hover:bg-blue-soft">Show all {list.length}</button></li>}
        </ul>
      )}
    </Card>
  );
}

function Processes({ serverId, reachable, why, className }: { serverId: string; reachable: boolean; why: string | null; className?: string }) {
  const [list, setList] = useState<any[] | null>(null);
  const load = async () => { const r = await runTool('server.processes', { serverId, limit: 8 }); setList(r.status === 'ok' ? r.output : []); };
  useEffect(() => { if (reachable) void load(); }, [serverId, reachable]);
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      <CardHeader icon={<Cpu size={19} />} title="Busiest programs" sub="Right now, by CPU" actions={reachable && <Button size="sm" variant="soft" icon={<RefreshCw size={13} />} onClick={load}>Refresh</Button>} />
      {!reachable ? <Unreachable why={why} what="Its programs" /> : !list ? <Skeleton className="mt-4 h-32" /> : (
        <table className="mt-3 w-full text-left text-[13px]">
          <thead><tr className="text-[11.5px] uppercase tracking-[0.06em] text-faint"><th scope="col" className="py-2 font-medium">Program</th><th scope="col" className="py-2 text-right font-medium">CPU</th><th scope="col" className="py-2 text-right font-medium">Memory</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.pid} className="border-t border-line">
                <td className="max-w-[180px] truncate py-2 font-medium" title={`${p.command} · pid ${p.pid} · ${p.user} · running ${p.elapsed}`}>{p.command}</td>
                <td className="tabular py-2 text-right">{p.cpu}%</td>
                <td className="tabular py-2 text-right text-ink-2">{p.rssMb} MB</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

const LOGS = [['journal', 'System'], ['kernel', 'Kernel'], ['auth', 'Logins']] as const;
function ServerLogs({ serverId, reachable, why }: { serverId: string; reachable: boolean; why: string | null }) {
  const [src, setSrc] = useState<(typeof LOGS)[number][0]>('journal');
  const [lines, setLines] = useState<string[] | null>(null);
  const load = async () => {
    if (!reachable) { setLines([`# ${why ?? 'Looking at the machine…'}`]); return; }
    setLines(null);
    const r = await runTool('server.logs', { serverId, source: src, lines: 300 });
    setLines(r.status === 'ok' ? r.output.lines : [`# ${r.status === 'error' ? reach(r.error.message) : 'Not allowed to read these logs.'}`]);
  };
  useEffect(() => { void load(); }, [serverId, src, reachable, why]);
  return (
    <DarkCard className="lg:col-span-12">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="grid size-11 place-items-center rounded-full bg-white/10"><ScrollText size={19} /></span>
        <div className="min-w-0 flex-1"><h2 className="text-[16.5px] font-medium tracking-[-0.015em]">System logs</h2><p className="text-[12.5px] text-white/60">What the machine itself has been saying</p></div>
        <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">{LOGS.map(([k, label]) => <DarkChip key={k} on={src === k} onClick={() => setSrc(k)}>{label}</DarkChip>)}</div>
      </div>
      <Terminal lines={lines} />
    </DarkCard>
  );
}
