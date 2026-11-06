// Dev-only harness: the story pieces as the server page, the app page, an incident, Home and the chat would mount
// them. Not in the app's routes or build; open /src/pages/story/preview.html on the Vite dev server while signed in.
// ?theme=dark, ?w=375, ?only=page|chat.
import '../../styles.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, runTool, startLive } from '../../lib/api';
import { Prompts, Toaster } from '../../ui';
import { toolCard } from '../chat/cards';
import { MorningBrief, ReplayButton, ReplayCard, Timeline } from '.';

const q = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', q.get('theme') === 'dark');
const width = Number(q.get('w') ?? 1100);

function App() {
  const [ids, setIds] = useState<{ srv: string; svc: string; inc?: string } | null>(null);
  const [steps, setSteps] = useState<{ tool: string; input: unknown; output: unknown }[]>([]);
  useEffect(() => {
    void api<any>('/api/graph').then(async (g) => {
      const srv = g.servers[0]?.id;
      const svc = q.get('svc') ?? g.projects.flatMap((p: any) => p.environments.flatMap((e: any) => e.services)).find((s: any) => s.kind === 'app' && s.domains?.length)?.id;
      const inc = (await api<any[]>('/api/incidents'))[0]?.id;
      setIds({ srv, svc, inc });
      const out = [];
      for (const [tool, input] of [['story.timeline', { serviceId: svc, untilHealthy: true }], ['story.replay', inc ? { incidentId: inc } : { serviceId: svc }], ['story.brief', {}]] as const) {
        const r = await runTool(tool, input);
        if (r.status === 'ok') out.push({ tool, input, output: r.output });
      }
      setSteps(out);
    });
  }, []);
  if (!ids) return <p className="p-6">Loading…</p>;
  return (
    <div className="mx-auto space-y-4 p-4" style={{ maxWidth: width }}>
      {q.get('only') !== 'chat' && <>
        <div className="grid gap-4 lg:grid-cols-[1fr_320px] [&>*]:min-w-0">
          <ReplayCard incidentId={ids.inc} serviceId={ids.inc ? undefined : ids.svc} />
          <div className="space-y-3"><MorningBrief /><div className="rounded-[24px] border border-line bg-surface p-4 shadow-soft"><p className="mb-2 text-[13px] text-muted">An alert row</p><ReplayButton serviceId={ids.svc} at={new Date(Date.now() - 35 * 60_000).toISOString()} /></div></div>
        </div>
        <Timeline serviceId={ids.svc} startHealthy title="What changed on this app" />
        <Timeline serverId={ids.srv} />
      </>}
      {q.get('only') !== 'page' && (
        <div className="mx-auto max-w-[720px] space-y-4 pt-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted">Chat cards</p>
          {steps.map((s) => <div key={s.tool}>{toolCard({ tool: s.tool, status: 'ok', input: s.input, output: s.output } as never, { conversationId: 'preview' })}</div>)}
        </div>
      )}
      <Toaster /><Prompts />
    </div>
  );
}
startLive();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
