// The watch's chat cards: server.trends (the chart with what's unusual), server.findings (risks, waste,
// tips with fixes), server.traffic and watch.anomalies, in the chat's card frame.
import { Activity, Globe, ShieldAlert, Siren } from 'lucide-react';
import { Frame } from '../chat/cards/kit';
import { TrendsView } from './TrendChart';
import { AnomalyList } from './Anomalies';
import { FindingsPanel } from './Findings';
import { TrafficCard } from './Traffic';
import { count, type FindingsOut, type TrafficOut, type Trends, type WAlert } from './shape';

const open = (a: WAlert[]) => a.filter((x) => !x.cleared);
export function TrendsCard({ output: o }: { output: Trends }) {
  const unusual = open(o.anomalies);
  return (
    <Frame icon={<Activity size={16} />} tone={unusual.length ? 'warn' : 'soft'} title={o.serverName} sub={`Usage, last ${o.range}${unusual.length ? ` · ${unusual.length} unusual` : ''}`} href={`/servers/${o.serverId}`} hrefLabel="Open the server">
      <TrendsView data={o} compact />
      {unusual.length > 0 && <div className="mt-3"><AnomalyList alerts={unusual} /></div>}
    </Frame>
  );
}
export function FindingsCard({ output: o }: { output: FindingsOut }) {
  const n = o.counts.risks + o.counts.waste + o.counts.tips;
  return (
    <Frame icon={<ShieldAlert size={16} />} tone={o.counts.risks ? 'warn' : 'ok'} title={o.serverName} count={n} sub={`${o.counts.risks} risk${o.counts.risks === 1 ? '' : 's'} · ${o.counts.waste} waste · ${o.counts.tips} tip${o.counts.tips === 1 ? '' : 's'}`} href={`/servers/${o.serverId}`} hrefLabel="Open the server">
      <FindingsPanel data={o} compact />
    </Frame>
  );
}
export function TrafficChatCard({ output: o }: { output: TrafficOut }) {
  return (
    <Frame icon={<Globe size={16} />} tone="soft" title={o.serverName} sub={`${count(o.summary.requests)} requests in ${o.minutes} minutes`} href={`/servers/${o.serverId}`} hrefLabel="Open the server">
      <TrafficCard data={o} compact />
    </Frame>
  );
}
export function AnomaliesCard({ output: o }: { output: { open: WAlert[]; cleared: WAlert[] } }) {
  return (
    <Frame icon={<Siren size={16} />} tone={o.open.length ? 'warn' : 'ok'} title="Unusual right now" count={o.open.length}>
      <AnomalyList alerts={[...o.open, ...o.cleared]} showServer />
    </Frame>
  );
}
