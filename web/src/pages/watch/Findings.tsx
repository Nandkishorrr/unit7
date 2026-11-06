// Risks, waste and tips for one server, from the findings engine. Each list is the security check's own
// finding list (the fix one click away, "Show me how" when a person has to do it, "Fix all safe ones").
import { useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert, Trash2, Lightbulb } from 'lucide-react';
import { runTool } from '../../lib/api';
import { Button, Skeleton, cx, timeAgo } from '../../ui';
import { tidy } from '../../lib/words';
import { Findings, type Report, type Severity } from '../security/SecurityCheck';
import type { FindingsOut, WFinding } from './shape';

export const asReport = (id: string, findings: WFinding[]): Report => ({
  id, at: '', serverId: null, by: 'unit7', score: 0, findings, notes: [], fresh: [], ms: 0,
  counts: Object.fromEntries((['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>,
});

const TABS = [
  { key: 'risks', label: 'Risks', icon: ShieldAlert, empty: 'No risks found: nothing open that shouldn’t be.' },
  { key: 'waste', label: 'Waste', icon: Trash2, empty: 'Nothing wasted that Unit7 can see.' },
  { key: 'tips', label: 'Tips', icon: Lightbulb, empty: 'No tips right now.' },
] as const;

// noTraffic: leave out what the traffic check found (where its own card sits next to this panel)
export function FindingsPanel({ data: all, compact, noTraffic, initial }: { data: FindingsOut; compact?: boolean; noTraffic?: boolean; initial?: 'risks' | 'waste' | 'tips' }) {
  const keep = (f: WFinding) => !noTraffic || !/^(traffic|logs):/.test(f.id);
  const data = { ...all, risks: all.risks.filter(keep), waste: all.waste.filter(keep), tips: all.tips.filter(keep) };
  const first = initial ?? TABS.find((t) => data[t.key].length)?.key ?? 'risks';
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>(first);
  const [more, setMore] = useState(false);
  // in a chat card: the first four, then "Show all"
  const items = compact && !more ? data[tab].slice(0, 4) : data[tab];
  const hidden = data[tab].length - items.length;
  return (
    <div className="min-w-0">
      <div role="tablist" aria-label="Findings" className="flex flex-wrap gap-1 rounded-full bg-raised p-1">
        {TABS.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setMore(false); }}
            className={cx('inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition', tab === t.key ? 'bg-ink text-bg' : 'text-ink-2 hover:text-ink')}>
            <t.icon size={13} />{t.label}<span className={cx('tabular rounded-full px-1.5 text-[11px]', tab === t.key ? 'bg-bg/20' : 'bg-surface')}>{data[t.key].length}</span>
          </button>
        ))}
      </div>
      <div className="mt-3">
        {items.length ? <Findings report={asReport(`${data.serverId}:${tab}`, items)} firstRun compact={compact} />
          : <p className="rounded-[18px] bg-ok/[0.07] px-4 py-3.5 text-[13px] text-ink">{TABS.find((t) => t.key === tab)!.empty}</p>}
        {hidden > 0 && <button type="button" onClick={() => setMore(true)} className="mt-2 inline-flex h-8 items-center rounded-full px-2.5 text-[12.5px] font-medium text-blue-text transition hover:bg-blue-soft">Show all {data[tab].length}</button>}
      </div>
      {!compact && data.notes.length > 0 && <ul className="mt-3 space-y-1 text-[12px] text-muted">{data.notes.map((n) => <li key={n}>{tidy(n)}</li>)}</ul>}
    </div>
  );
}

export function ServerFindings({ serverId, noTraffic }: { serverId: string; noTraffic?: boolean }) {
  const [data, setData] = useState<FindingsOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async (fresh = false) => {
    setBusy(true);
    try { const r = await runTool('server.findings', { serverId, fresh }); if (r.status === 'ok') { setData(r.output); setErr(null); } else setErr(r.status === 'error' ? r.error.message : 'Not allowed'); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  useEffect(() => { setData(null); void load(); }, [serverId]);
  if (err && !data) return <p className="text-[13px] text-bad">{tidy(err)}</p>;
  if (!data) return <Skeleton className="h-40" />;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-[12px] text-muted">
        <span className="min-w-0 flex-1 truncate">{data.at.xray ? `From Unit7’s look inside ${timeAgo(data.at.xray)}` : 'From what Unit7 last saw'}</span>
        <Button size="sm" variant="ghost" loading={busy} icon={<RefreshCw size={13} />} onClick={() => load(true)}>Check again</Button>
      </div>
      <FindingsPanel data={data} noTraffic={noTraffic} />
    </div>
  );
}
