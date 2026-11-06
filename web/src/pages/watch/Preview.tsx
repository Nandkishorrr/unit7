// Dev-only harness: the server watch pieces for the first server, as the server page and the chat would mount
// them. Not in the app's routes or build; open /src/pages/watch/preview.html on the Vite dev server while
// signed in. ?theme=dark, ?w=375.
import '../../styles.css';
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, runTool, startLive } from '../../lib/api';
import { Card, CardHeader } from '../../ui';
import { toolCard } from '../chat/cards';
import { ServerAnomalies, ServerFindings, ServerTraffic, ServerTrends } from '.';
import { Activity, Globe, ShieldAlert, Siren } from 'lucide-react';

const q = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', q.get('theme') === 'dark');
const width = Number(q.get('w') ?? 1100);

function Box({ icon, title, sub, children }: { icon: ReactNode; title: string; sub?: string; children: ReactNode }) {
  return <Card className="p-5 md:p-6"><CardHeader icon={icon} title={title} sub={sub} /><div className="mt-4">{children}</div></Card>;
}
function App() {
  const [srv, setSrv] = useState<string | null>(null);
  const [steps, setSteps] = useState<{ tool: string; output: unknown }[]>([]);
  useEffect(() => {
    void api<any>('/api/graph').then(async (g) => {
      const id = g.servers[0]?.id;
      setSrv(id);
      const out = [];
      for (const [tool, input] of [['server.trends', { serverId: id, range: '24h' }], ['server.findings', { serverId: id }], ['server.traffic', { serverId: id }], ['watch.anomalies', {}]] as const) {
        const r = await runTool(tool, input);
        if (r.status === 'ok') out.push({ tool, output: r.output });
      }
      setSteps(out);
    });
  }, []);
  if (!srv) return <p className="p-6">Loading…</p>;
  const page = q.get('only') !== 'chat';
  return (
    <div className="mx-auto space-y-4 p-4" style={{ maxWidth: width }}>
      {page && <>
        <Box icon={<Siren size={20} />} title="Unusual right now"><ServerAnomalies serverId={srv} /></Box>
        <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
          <Box icon={<Activity size={20} />} title="Usage over time" sub="Normal for this time, and what happened when"><ServerTrends serverId={srv} /></Box>
          <Box icon={<Globe size={20} />} title="Traffic and logs"><ServerTraffic serverId={srv} /></Box>
        </div>
        <Box icon={<ShieldAlert size={20} />} title="Risks, waste and tips"><ServerFindings serverId={srv} noTraffic /></Box>
      </>}
      {q.get('only') !== 'page' && (
        <div className="mx-auto max-w-[720px] space-y-4 pt-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">Chat cards</p>
          {steps.map((s) => <div key={s.tool}>{toolCard({ tool: s.tool, status: 'ok', output: s.output } as never, { conversationId: 'preview' })}</div>)}
        </div>
      )}
    </div>
  );
}
startLive();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
