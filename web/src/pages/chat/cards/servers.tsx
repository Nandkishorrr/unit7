// Servers in the chat: the provider's logo, a status pill, and CPU, memory and disk as segmented bars that
// fill once. Plus live metrics, what a server is made of, its containers, and the VPS in a Hostinger account.
import { useEffect, useState } from 'react';
import { ArrowUpRight, Box, Cpu, Server } from 'lucide-react';
import { BrandLogo, providerName } from '../../../brand/BrandLogo';
import { Badge, Button, CopyButton, CountUp, Meter, cx, Skeleton, StatusMark } from '../../../ui';
import { navigate } from '../../../lib/router';
import { LogoTile } from '../../kit';
import { Fold, Frame, IconBtn, LiveDot, Outcome, Pill, call, refreshWorld, said, useWorld } from './kit';
import { bytes, diskPct, plural, usage, type Tone } from './shape';

const HEALTH: Record<string, [Tone | 'work', string]> = {
  ready: ['ok', 'Healthy'], unreachable: ['bad', 'Not answering'], error: ['bad', 'Needs a look'], bootstrapping: ['work', 'Setting up'],
  awaiting_key: ['warn', 'Needs Unit7’s key'], connected: ['idle', 'Connected'], new: ['idle', 'New'],
};
const providerOf = (ref?: string | null) => (ref ? String(ref).split(':')[0]! : undefined);
const osName = (os?: string) => (os ? os.replace(/ LTS$/, '').replace(/^(\w+ \d+\.\d+)\.\d+/, '$1') : undefined);

// three numbers as segmented bars; they fill once after the card arrives
export function Gauges({ cpu, mem, disk }: { cpu: number | null; mem: number | null; disk: number | null }) {
  const [on, setOn] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(r); }, []);
  if (cpu == null && mem == null && disk == null) return <p className="rounded-[14px] bg-raised px-3 py-2 text-[12.5px] text-muted">No numbers yet. They show up after the first check.</p>;
  return (
    <div className="grid grid-cols-3 gap-3">
      {([['CPU', cpu], ['Memory', mem], ['Disk', disk]] as const).map(([label, v]) => (
        <div key={label} className="min-w-0">
          <p className="mb-1.5 flex items-baseline justify-between gap-1 text-[12px]">
            <span className="text-muted">{label}</span>
            <span className={cx('font-semibold', v != null && v >= 90 ? 'text-bad' : v != null && v >= 70 ? 'text-warn' : 'text-ink')}>{v == null ? '–' : <CountUp value={Math.round(v)} format={(n) => `${Math.round(n)}%`} />}</span>
          </p>
          <Meter value={on ? v ?? 0 : 0} segments={12} label={label} />
        </div>
      ))}
    </div>
  );
}

function ServerRow({ s, apps }: { s: any; apps: number }) {
  const prov = providerOf(s.provider ?? s.provider_ref);
  const f = s.facts;
  const u = f ? usage(f) : { cpu: null, mem: null, disk: diskPct(s.disk) };
  const [tone, word] = HEALTH[s.status] ?? ['idle', s.status];
  const os = osName(f?.os ?? s.os);
  return (
    <li className="rounded-[18px] border border-line bg-surface px-3 py-3 transition hover:border-line-strong">
      <div className="flex items-center gap-3">
        <LogoTile id={prov} size={36}>{!prov && <Server size={17} className="text-muted" />}</LogoTile>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => navigate(`/servers/${s.id}`)} className="truncate text-left text-[14px] font-semibold hover:underline decoration-line-strong underline-offset-4">{s.name}</button>
          <p className="flex items-center text-[12px] text-muted"><span className="truncate font-mono">{s.host}</span><CopyButton text={s.host} className="size-6" /></p>
        </div>
        <Pill tone={tone} glow={tone === 'ok'}>{word}</Pill>
        <IconBtn label={`Open ${s.name}`} href={`/servers/${s.id}`}><ArrowUpRight size={15} /></IconBtn>
      </div>
      <div className="mt-3"><Gauges {...u} /></div>
      <p className="mt-2.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">
        <span>{plural(apps, 'app')} on it</span>
        {os && <span className="inline-flex items-center gap-1"><BrandLogo id={f?.os_id ?? 'ubuntu'} size={12} />{os}</span>}
        {(f?.cpus ?? s.cpus) && <span>{f?.cpus ?? s.cpus} CPUs</span>}
        {prov && <span>{providerName(prov)} VPS</span>}
      </p>
    </li>
  );
}

export function ServerList({ servers }: { servers: any[] }) {
  const w = useWorld();
  const rows = servers.map((s: any) => ({ ...s, facts: s.facts ?? w.server(s.id)?.facts }));
  const apps = (s: any) => w.svcs.filter((x) => x.server_id === s.id).length || (s.services?.length ?? 0);
  if (!rows.length) return <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">No servers yet. Connect Hostinger and pick a VPS, or add any Linux server.</p>;
  return <Fold items={rows} className="space-y-2">{(s) => <ServerRow key={s.id} s={s} apps={apps(s)} />}</Fold>;
}

// server.list, or the graph's servers when there's no list
export function ServersCard({ list }: { list?: any[] }) {
  const w = useWorld();
  const servers = list ?? w.graph?.servers;
  return (
    <Frame icon={<Server size={16} />} title="Your servers" count={servers?.length} href="/servers" hrefLabel="Open servers">
      {servers ? <ServerList servers={servers} /> : <Skeleton className="h-28" />}
    </Frame>
  );
}

// server.metrics: right now, and the busiest containers
export function MetricsCard({ input, output: o }: { input: any; output: any }) {
  const w = useWorld();
  const s = w.server(input?.serverId);
  const n = o.now ?? {};
  const top = [...(n.containers ?? [])].sort((a: any, b: any) => b.cpu - a.cpu).slice(0, 5);
  return (
    <Frame icon={<Cpu size={16} />} tone="soft" title={s?.name ?? 'Server'} sub={`Live · load ${n.load1 ?? '–'}`} href={s && `/servers/${s.id}`} hrefLabel="Open the server">
      <Gauges cpu={n.cpu ?? null} mem={n.memPct ?? null} disk={n.diskPct ?? null} />
      <p className="mt-2 text-[12px] text-muted">{bytes(n.memUsed)} of {bytes(n.memTotal)} memory · {bytes(n.diskUsed)} of {bytes(n.diskTotal)} disk</p>
      {top.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {top.map((c: any) => (
            <li key={c.name} className="flex items-center gap-2 py-1.5 text-[12.5px]">
              <Box size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{c.name}</span>
              <span className="tabular w-20 whitespace-nowrap text-right text-ink-2">{c.cpu.toFixed(1)}% CPU</span>
              <span className="tabular w-16 whitespace-nowrap text-right text-muted">{c.mem}</span>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

// server.inspect: what the machine is
export function FactsCard({ input, output: f }: { input: any; output: any }) {
  const up = f.uptime ? `${Math.floor(f.uptime / 86400)} days` : undefined;
  const facts: [string, string | undefined][] = [['System', osName(f.os)], ['CPUs', f.cpus && String(f.cpus)], ['Memory', f.memory], ['Disk', f.disk], ['Up for', up], ['Docker', f.docker], ['Firewall', f.ufw ? (f.ufw === 'active' ? 'On' : 'Off') : undefined]];
  return (
    <Frame icon={<Server size={16} />} title={f.name ?? 'Server'} sub={f.host} href={input?.serverId && `/servers/${input.serverId}`} hrefLabel="Open the server">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 @lg:grid-cols-3">
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="min-w-0 rounded-[14px] bg-raised/70 px-3 py-2">
            <dt className="text-[11.5px] text-muted">{k}</dt>
            <dd className="truncate text-[13px] font-medium" title={v}>{v}</dd>
          </div>
        ))}
      </dl>
      {f.ports?.length > 0 && <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">Open to the internet:{f.ports.map((p: number) => <Badge key={p}>{p}</Badge>)}</p>}
    </Frame>
  );
}

// docker.list: containers with a live dot
export function DockerCard({ input, output }: { input: any; output: any[] }) {
  const w = useWorld();
  const s = w.server(input?.serverId);
  const rows = Array.isArray(output) ? output : [];
  const up = rows.filter((c) => c.State === 'running').length;
  return (
    <Frame icon={<Box size={16} />} title={`Containers${s ? ` on ${s.name}` : ''}`} count={rows.length} sub={`${up} running`} href={s && `/servers/${s.id}`} hrefLabel="Open the server">
      <Fold items={rows} className="divide-y divide-line">
        {(c) => (
          <li key={c.ID ?? c.Names} className="flex items-center gap-2.5 py-2">
            <LiveDot tone={c.State === 'running' ? (/unhealthy/.test(c.Status ?? '') ? 'warn' : 'ok') : c.State === 'restarting' ? 'warn' : 'idle'} glow={c.State === 'running'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{c.Names}</span>
              <span className="block truncate font-mono text-[11.5px] text-muted">{c.Image}</span>
            </span>
            <span className="shrink-0 text-[12px] text-muted">{c.Status}</span>
          </li>
        )}
      </Fold>
    </Frame>
  );
}

// hostinger.vps_list: each VPS one click from a ready Unit7 server
export function VpsCard({ output }: { output: any }) {
  const w = useWorld();
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<Record<number, ReturnType<typeof said>>>({});
  const vps: any[] = output?.vps ?? [];
  const use = async (v: any) => {
    setBusy(v.id);
    const r = await call('hostinger.vps_use', { vmId: v.id });
    setBusy(null);
    setDone((d) => ({ ...d, [v.id]: said(r, (r as any).output?.status === 'awaiting_key' ? `${v.hostname} is almost there: add Unit7’s key on the server page.` : `${v.hostname} is connected. Unit7 is setting it up now.`) }));
    refreshWorld();
  };
  return (
    <Frame icon={<BrandLogo id="hostinger" size={18} />} title="Your Hostinger servers" count={vps.length} href="/servers" hrefLabel="Open servers">
      {!vps.length ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">No VPS in this Hostinger account yet.</p> : (
        <Fold items={vps} className="divide-y divide-line">
          {(v) => {
            const used = (w.graph?.servers ?? []).find((s: any) => s.host === v.ip);
            return (
              <li key={v.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <LogoTile id="hostinger" size={34} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium">{v.hostname}</p>
                    <p className="truncate text-[12px] text-muted"><span className="font-mono">{v.ip ?? 'no IP yet'}</span>{v.plan && ` · ${v.plan}`} · {v.state}</p>
                  </div>
                  {used ? <button type="button" onClick={() => navigate(`/servers/${used.id}`)} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ok hover:underline"><StatusMark state="ok" size={14} label="Managed" />Managed by Unit7</button>
                    : !done[v.id] && <Button size="sm" variant="primary" loading={busy === v.id} disabled={!v.ip || busy !== null} onClick={() => use(v)}>Use this server</Button>}
                </div>
                {done[v.id] && <Outcome tone={done[v.id]!.tone} step={done[v.id]!.step}>{done[v.id]!.text}</Outcome>}
              </li>
            );
          }}
        </Fold>
      )}
    </Frame>
  );
}
