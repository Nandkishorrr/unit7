// Three steps, one click each, side by side. Each checks itself off as the real state changes, and
// the whole block disappears once your app is live.
import { useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { useApi } from '../lib/api';
import { openSignIn } from '../lib/actions';
import { navigate } from '../lib/router';
import { Button, Card, CopyButton, IconCircle, cx } from '../ui';
import { BrandLogo } from '../brand/BrandLogo';
import { AgentConnect, type AgentInfo } from './AgentConnect';
import { AskButton } from './Help';

export function useSetup() {
  const agents = useApi<{ local: boolean; agents: AgentInfo[] }>('/api/agents', { live: (e) => e.type.startsWith('agent.') });
  const graph = useApi<any>('/api/graph');
  const conns = useApi<{ id: string; accounts: unknown[] }[]>('/api/connections', { live: (e) => e.type.startsWith('account.') });
  if (!graph.data || !agents.data || !conns.data) return null;
  return {
    ai: !agents.data.local || agents.data.agents.some((a) => a.connected),
    hostinger: !!conns.data.find((c) => c.id === 'hostinger')?.accounts.length,
    server: graph.data.servers.some((s: any) => s.status === 'ready'),
    live: graph.data.projects.some((p: any) => p.environments.some((e: any) => e.services.some((s: any) => s.deployment?.status === 'live'))),
  };
}

export function GetStarted({ s }: { s: NonNullable<ReturnType<typeof useSetup>> }) {
  const [busy, setBusy] = useState(false);
  const connectHostinger = async () => { setBusy(true); await openSignIn('hostinger', 'Hostinger'); setBusy(false); };
  const steps = [
    { n: 1, done: s.ai, title: 'Connect your AI', body: 'The AI you already use will drive Unit7.', action: <AgentConnect compact /> },
    {
      n: 2, done: s.server, title: 'Get a server',
      body: s.hostinger ? 'Pick a Hostinger VPS. Unit7 sets it up for you: Docker, HTTPS, firewall.' : 'Sign in to Hostinger. Unit7 sets up your VPS for you.',
      action: <>
        {s.hostinger
          ? <Button variant="primary" className="w-full" icon={<BrandLogo id="hostinger" size={16} className="rounded bg-white p-px" />} onClick={() => navigate('/servers?from=hostinger')}>Use my Hostinger VPS</Button>
          : <Button variant="primary" className="w-full" loading={busy} onClick={connectHostinger}>Connect Hostinger <ExternalLink size={14} /></Button>}
        <button onClick={() => navigate('/servers?new=1')} className="mt-2 block w-full rounded-full py-1.5 text-center text-[12.5px] text-muted transition hover:text-ink">I have another server</button>
      </>,
    },
    {
      n: 3, done: s.live, title: 'Put your app live', body: 'Tell Unit7 which app. It builds it, puts it live and gives you the link.',
      action: <>
        <AskButton size="md" variant="primary" className="w-full" label="Deploy my app" prompt="Deploy my app and give me the link" />
        <p className="mb-1.5 mt-3 text-[12.5px] text-muted">Or in Claude Code, inside your project folder:</p>
        <div className="flex items-center gap-2 rounded-[14px] bg-raised py-2 pl-3.5 pr-1.5">
          <code className="flex-1 font-mono text-[13px] text-ink">/unit7 deploy this folder</code><CopyButton text="/unit7 deploy this folder" />
        </div>
      </>,
    },
  ];
  const done = steps.filter((x) => x.done).length;
  const left = steps.filter((x) => !x.done);
  const next = left[0]!;

  // part way there: one slim card with the next step; finished ones shrink to ticks
  if (done > 0) {
    return (
      <Card className="animate-rise p-5 md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:gap-8">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <IconCircle tone="dark" size={44}><span className="text-[15px] font-semibold">{next.n}</span></IconCircle>
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium text-muted">{left.length === 1 ? 'One thing left' : `${left.length} things left`} to finish setting up</p>
              <h2 className="mt-0.5 text-[17px] font-medium tracking-[-0.015em]">{next.title}</h2>
              <p className="mt-0.5 text-[13.5px] text-muted">{next.body}</p>
              <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted" aria-label="Done">
                {steps.filter((x) => x.done).map((x) => (
                  <li key={x.n} className="flex items-center gap-1.5"><span className="grid size-4 place-items-center rounded-full bg-lime text-lime-ink"><Check size={10} strokeWidth={3.5} /></span>{x.title}</li>
                ))}
                {left.slice(1).map((x) => <li key={x.n} className="flex items-center gap-1.5"><span className="size-4 rounded-full border border-line-strong" />Then: {x.title.toLowerCase()}</li>)}
              </ul>
            </div>
          </div>
          <div className="w-full lg:w-[380px] lg:shrink-0">{next.action}</div>
        </div>
      </Card>
    );
  }

  return (
    <section aria-labelledby="get-started" className="space-y-4 pt-2">
      <div className="px-1">
        <h2 id="get-started" className="text-[20px] font-semibold tracking-[-0.025em]">Let’s get your app live</h2>
        <p className="mt-0.5 text-[14px] text-muted">Three steps. Each one ticks itself off when it’s done.</p>
      </div>
      <div className="stagger grid gap-4 lg:grid-cols-3">
        {steps.map((x) => <Step key={x.n} n={x.n} done={x.done} current={x === next} title={x.title} body={x.body}>{x.action}</Step>)}
      </div>
    </section>
  );
}

function Step({ n, done, current, title, body, children }: { n: number; done: boolean; current: boolean; title: string; body: string; children: React.ReactNode }) {
  return (
    <div className={cx('flex flex-col rounded-[24px] border bg-surface p-6 shadow-soft transition', current ? 'border-ink/25 ring-4 ring-ink/[0.04]' : 'border-line')}>
      <div className="flex items-center gap-3">
        <IconCircle size={36} tone={done ? 'lime' : current ? 'dark' : 'neutral'}>{done ? <Check size={17} strokeWidth={3} /> : <span className="text-[14px] font-semibold">{n}</span>}</IconCircle>
        <h3 className="text-[16.5px] font-medium tracking-[-0.015em]">{title}</h3>
      </div>
      <p className="mt-3 text-[13.5px] text-muted">{done ? 'Done.' : body}</p>
      {!done && <div className="mt-auto pt-5">{children}</div>}
    </div>
  );
}
