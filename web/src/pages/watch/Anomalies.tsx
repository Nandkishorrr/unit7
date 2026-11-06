// What's unusual right now: each open alert from the server watch (a jump in usage, odd traffic, a new risk)
// with why in plain words, since when, its fix when there is one, and "Ask Unit7 why" (or a link to what
// the AI found when it already looked). Cleared ones fold away under "Back to normal".
import { useEffect, useState } from 'react';
import { Activity, Check, ChevronRight, Globe, ShieldAlert, ArrowUpRight } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { A, AiButton, IconCircle, Skeleton, cx, timeAgo, StatusMark } from '../../ui';
import { tidy } from '../../lib/words';
import { askOnHome } from '../Help';
import { FixButton, SEV, type Severity } from '../security/SecurityCheck';
import type { WAlert } from './shape';
import { ReplayButton } from '../story';
import { ExplainBlock, SnoozeMenu } from '../explain';

const SOURCE = { usage: { icon: Activity, word: 'Usage' }, traffic: { icon: Globe, word: 'Traffic' }, finding: { icon: ShieldAlert, word: 'Risk' } } as const;
// the watch's own words for how bad: warnings sit between high and medium
const sevOf = (s: string): Severity => (s === 'warning' ? 'medium' : (s as Severity));
const isTool = (f: WAlert['fix']): f is Extract<NonNullable<WAlert['fix']>, { tool: string }> => !!f && 'tool' in f;

export const investigatePrompt = (a: WAlert) =>
  `Look into this on ${a.serverName ?? 'my server'} (read-only, change nothing): ${a.title} What changed recently, what do the logs say around ${new Date(a.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, and what would you do?`;

function Row({ a, showServer, onHide }: { a: WAlert; showServer?: boolean; onHide: () => void }) {
  const I = SOURCE[a.source].icon;
  const sev = sevOf(a.severity);
  return (
    <li className={cx('rounded-[20px] border p-4 animate-rise', SEV[sev]?.ring ?? 'border-line')}>
      <div className="flex items-start gap-3">
        <span className={cx('mt-[7px] size-2.5 shrink-0 rounded-full', SEV[sev]?.dot, (a.severity === 'critical') && 'animate-pulse')} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-[260px]">
              <p className="text-[14px] font-medium tracking-[-0.01em] text-ink">{tidy(a.title)}<span className="sr-only"> Severity: {SEV[sev]?.label}.</span></p>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                <span className="inline-flex items-center gap-1"><I size={12} />{SOURCE[a.source].word}</span>
                <span>started {timeAgo(a.started ?? a.since)}</span>
                {showServer && a.serverName && <A href={`/servers/${a.serverId}`} className="hover:text-ink">{a.serverName}</A>}
              </p>
            </div>
            {a.serverId && <ReplayButton serverId={a.serverId} at={a.started ?? a.since} className="shrink-0" />}
            {a.conversationId
              ? <A href={`/?c=${a.conversationId}`} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-blue-soft px-3 text-[12.5px] font-medium text-blue-text hover:underline">See what Unit7 found<ArrowUpRight size={12} /></A>
              : <AiButton size="sm" className="shrink-0" onClick={() => askOnHome(investigatePrompt(a), { send: true })}>Ask Unit7 why</AiButton>}
            {a.snoozeKey && <SnoozeMenu id={a.snoozeKey} title={a.title} kind="alert" small onDone={onHide} />}
          </div>
          {a.explain && <ExplainBlock e={a.explain} compact className="mt-2.5" />}
          {isTool(a.fix) && <FixButton fix={a.fix} strong={sev === 'critical' || sev === 'high'} />}
        </div>
      </div>
    </li>
  );
}

export function AnomalyList({ alerts: all, showServer, empty = 'Nothing unusual right now.' }: { alerts: WAlert[]; showServer?: boolean; empty?: string }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set()); // "This is fine": gone at once
  const alerts = all.filter((a) => !hidden.has(a.id));
  const rank = (a: WAlert) => ['critical', 'high', 'warning', 'medium', 'low', 'info'].indexOf(a.severity);
  const open = alerts.filter((a) => !a.cleared).sort((a, b) => rank(a) - rank(b) || Date.parse(b.since) - Date.parse(a.since)), cleared = alerts.filter((a) => a.cleared);
  return (
    <div>
      {!open.length ? (
        <div className="flex items-center gap-3 rounded-[18px] bg-ok/[0.07] px-4 py-3.5"><StatusMark state="ok" size={32} solid label="All good" /><p className="text-[13px] text-ink">{empty}</p></div>
      ) : <ul className="space-y-2.5" aria-label="Unusual right now">{open.map((a) => <Row key={a.id} a={a} showServer={showServer} onHide={() => setHidden((h) => new Set([...h, a.id]))} />)}</ul>}
      {cleared.length > 0 && (
        <details className="group mt-3 rounded-[18px] border border-line px-4 py-2.5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[12.5px] font-medium text-ink-2"><ChevronRight size={14} className="transition-transform group-open:rotate-90" />Back to normal · {cleared.length}</summary>
          <ul className="mt-2 space-y-1.5">{cleared.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-[12.5px] text-muted"><Check size={13} className="mt-0.5 shrink-0 text-ok" /><span className="min-w-0 flex-1">{tidy(a.title)} <span className="text-faint">· cleared {timeAgo(a.cleared)}</span></span></li>
          ))}</ul>
        </details>
      )}
    </div>
  );
}

// self-loading: one server's (or every server's) open alerts, refreshed when the watch says something
export function ServerAnomalies({ serverId }: { serverId?: string }) {
  const [data, setData] = useState<{ open: WAlert[]; cleared: WAlert[] } | null>(null);
  useEffect(() => {
    const load = () => runTool('watch.anomalies', serverId ? { serverId } : {}).then((r) => r.status === 'ok' && setData(r.output), () => undefined);
    void load();
    return onLive((e) => { if (e.type.startsWith('watch.')) void load(); });
  }, [serverId]);
  if (!data) return <Skeleton className="h-20" />;
  return <AnomalyList alerts={[...data.open, ...data.cleared]} showServer={!serverId} />;
}
