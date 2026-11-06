// The last traffic and log check of a server, as a card: requests, visitors, errors and calls without signing
// in against the usual for this time; the busiest paths and who's calling; what it found with the fix; and
// which logs it could read (or how to turn one on).
import { useEffect, useState } from 'react';
import { Bot, RefreshCw, ScrollText } from 'lucide-react';
import { runTool } from '../../lib/api';
import { Badge, Button, Skeleton, cx, timeAgo } from '../../ui';
import { tidy } from '../../lib/words';
import { Findings } from '../security/SecurityCheck';
import { asReport } from './Findings';
import { count, type Summary, type TrafficOut } from './shape';

const times = (now: number, usual?: number) => (usual && usual > 0 && now >= 2 * usual ? `${now / usual >= 10 ? Math.round(now / usual) : (now / usual).toFixed(1).replace(/\.0$/, '')}× usual` : undefined);
function Stat({ label, value, usual, bad }: { label: string; value: number; usual?: number; bad?: boolean }) {
  const t = times(value, usual);
  return (
    <div className="min-w-0 rounded-[16px] bg-raised/70 px-3 py-2.5">
      <p className="truncate text-[11.5px] text-muted">{label}</p>
      <p className="text-[19px] font-semibold tracking-[-0.02em] text-ink">{count(value)}</p>
      <p className={cx('truncate text-[11.5px]', t && bad ? 'font-medium text-bad' : 'text-muted')}>{t ?? (usual !== undefined ? `usually ${count(usual)}` : ' ')}</p>
    </div>
  );
}

// requests per check over the last day or two; the newest column in the accent
function Spark({ history }: { history: TrafficOut['history'] }) {
  const h = history.slice(-48);
  if (h.length < 2) return null;
  const max = Math.max(1, ...h.map((x) => x.requests));
  return (
    <svg viewBox={`0 0 ${h.length * 6} 32`} preserveAspectRatio="none" className="h-8 w-full" role="img" aria-label={`Requests per check, last ${h.length} checks: from ${count(h[0]!.requests)} to ${count(h.at(-1)!.requests)}`}>
      {h.map((x, i) => { const v = Math.max(1.5, (x.requests / max) * 30); return <rect key={x.at} x={i * 6} y={32 - v} width={4} height={v} rx={1.5} fill={i === h.length - 1 ? 'var(--blue)' : 'var(--line-strong)'}><title>{`${new Date(x.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}: ${x.requests} requests`}</title></rect>; })}
    </svg>
  );
}

// every request once, by who made it: real people are rarely the biggest part, and that's worth seeing
const WHO: { key: keyof NonNullable<Summary['who']>; label: string; color: string }[] = [
  { key: 'people', label: 'Real people', color: 'bg-blue' }, { key: 'own', label: 'Your own apps', color: 'bg-ink/45' }, { key: 'programs', label: 'Other programs', color: 'bg-warn' },
  { key: 'bots', label: 'Bots', color: 'bg-bad' }, { key: 'unit7', label: 'Unit7’s checks', color: 'bg-line-strong' },
];
function WhoBar({ who, total }: { who: NonNullable<Summary['who']>; total: number }) {
  const parts = WHO.filter((w) => who[w.key] > 0);
  return (
    <section aria-label="Who made these requests" className="mt-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-raised">{parts.map((w) => <span key={w.key} className={w.color} style={{ width: `${(100 * who[w.key]) / total}%` }} />)}</div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">{parts.map((w) => (
        <li key={w.key} className="inline-flex items-center gap-1.5"><span aria-hidden className={`size-2.5 rounded-[3px] ${w.color}`} />{w.label} <b className="tabular font-medium text-ink-2">{count(who[w.key])}</b></li>
      ))}</ul>
    </section>
  );
}

export function TrafficCard({ data, compact }: { data: TrafficOut; compact?: boolean }) {
  const s = data.summary;
  const anonWord = s.anon.how === 'headers' ? 'Without signing in' : 'Refused, not signed in';
  const read = s.sources.filter((x) => x.lines > 0);
  const issues = data.findings.filter((f) => f.severity !== 'info' || f.id.includes(':no-log:'));
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-muted">Last {data.minutes} minutes · checked {timeAgo(data.at)}{data.stale ? ' (the server didn’t answer just now)' : ''}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 @lg:grid-cols-4">
        <Stat label="Requests" value={s.requests} usual={data.usual.requests} bad />
        <Stat label={s.who ? 'Real visitors' : 'Addresses'} value={s.who?.visitors ?? s.ips} usual={s.who ? undefined : data.usual.ips} />
        <Stat label="Server errors" value={s.status.s5xx} usual={data.usual.s5xx} bad />
        <Stat label={anonWord} value={s.anon.n} usual={data.usual.anon} bad />
      </div>
      <div className="mt-3"><Spark history={data.history} /></div>
      {!compact && s.who && s.requests > 0 && <WhoBar who={s.who} total={s.requests} />}
      {!compact && s.requests > 0 && (
        <div className="mt-3 grid gap-3 @xl:grid-cols-2">
          <section aria-label="Busiest paths">
            <h4 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted">Busiest paths</h4>
            <ul className="divide-y divide-line">{s.topPaths.slice(0, 5).map((p) => (
              <li key={p.path} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2" title={p.path}>{p.path}</span>
                {p.s5xx > 0 && <Badge tone="bad">{p.s5xx} error{p.s5xx === 1 ? '' : 's'}</Badge>}
                <span className="tabular w-12 text-right text-ink">{count(p.n)}</span>
              </li>
            ))}</ul>
          </section>
          <section aria-label="Who's calling">
            <h4 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted">Who’s calling</h4>
            <ul className="divide-y divide-line">{s.topAgents.slice(0, 5).map((a) => (
              <li key={a.agent} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                {a.bot && <Bot size={13} className="shrink-0 text-muted" aria-label="A bot or script" />}
                <span className="min-w-0 flex-1 truncate text-ink-2">{a.agent}</span>
                <span className="tabular w-12 text-right text-ink">{count(a.n)}</span>
              </li>
            ))}</ul>
            {s.bots > 0 && <p className="mt-1 text-[11.5px] text-muted">{Math.round((100 * s.bots) / Math.max(1, s.requests))}% from bots and scripts{s.scanners.n ? `, ${count(s.scanners.n)} probing for weak spots` : ''}</p>}
          </section>
        </div>
      )}
      {issues.length > 0 && <div className="mt-4"><Findings report={asReport(`${data.serverId}:traffic:${data.at}`, issues)} firstRun compact /></div>}
      {!compact && s.errors.length > 0 && (
        <section aria-label="Errors in app logs" className="mt-3">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted"><ScrollText size={12} />Error lines in app logs</h4>
          <ul className="flex flex-wrap gap-1.5">{s.errors.slice(0, 8).map((e) => <li key={e.container}><Badge tone={e.n >= 20 ? 'warn' : 'neutral'}>{e.container} · {count(e.n)}</Badge></li>)}</ul>
        </section>
      )}
      <p className="mt-3 text-[11.5px] text-muted">
        {read.length ? `Read from ${read.map((x) => `${x.name} (${count(x.lines)} lines)`).join(', ')}.` : 'No access log could be read on this server.'}
        {s.sources.filter((x) => x.note).map((x) => ` ${x.name}: ${tidy(x.note!)}.`).join('')}
      </p>
    </div>
  );
}

export function ServerTraffic({ serverId }: { serverId: string }) {
  const [data, setData] = useState<TrafficOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async (fresh = false) => {
    setBusy(true);
    try { const r = await runTool('server.traffic', { serverId, fresh }); if (r.status === 'ok') { setData(r.output); setErr(null); } else setErr(r.status === 'error' ? r.error.message : 'Not allowed'); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  useEffect(() => { setData(null); void load(); }, [serverId]);
  if (err && !data) return <p className="text-[13px] text-bad">{tidy(err)}</p>;
  if (!data) return <Skeleton className="h-48" />;
  return (
    <div className="@container">
      <div className="-mt-1 mb-1 flex justify-end"><Button size="sm" variant="ghost" loading={busy} icon={<RefreshCw size={13} />} onClick={() => load(true)}>Check now</Button></div>
      <TrafficCard data={data} />
    </div>
  );
}
