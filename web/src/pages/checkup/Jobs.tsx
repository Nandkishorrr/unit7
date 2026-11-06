// Ready-made jobs: the things people keep asking for, each one tap away. A job is a saved way of asking, so there's no new engine.
import { useState } from 'react';
import { runTool, api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, Modal, PageHeader, toast } from '../../ui';
import { askOnHome } from '../Help';
import { JOBS, type Job } from './jobList';

const servers = async () => ((await api<{ servers?: { id: string; name: string }[] }>('/api/graph')).servers ?? []);
function Row({ j, show }: { j: Job; show: (title: string, text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if ('href' in j) { navigate(j.href); return; }
    if ('ask' in j) { askOnHome(j.ask); return; }
    setBusy(true);
    try {
      const list = j.forEachServer ? await servers() : [undefined];
      const out = await Promise.all(list.map((s) => runTool(j.tool, { ...j.input, ...(s && { serverId: s.id }) })));
      const bad = out.find((r) => r.status !== 'ok');
      if (bad) toast('bad', 'That didn’t finish', bad.status === 'error' ? bad.error.message : bad.status === 'denied' ? bad.why : undefined);
      else show(j.title, JSON.stringify(out.length === 1 ? (out[0] as { output: unknown }).output : out.map((r) => (r as { output: unknown }).output), null, 2));
    } finally { setBusy(false); }
  };
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1 basis-[260px]"><p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">{j.title}{j.ai && <Badge tone="neutral">Uses your AI</Badge>}</p><p className="text-[12.5px] text-muted">{j.what} · {j.when}</p></div>
      <Button size="sm" variant="secondary" loading={busy} onClick={go}>{'ask' in j ? 'Ask' : 'Run'}</Button>
    </li>
  );
}
export function JobsPage() {
  const [out, setOut] = useState<{ title: string; text: string }>();
  return (
    <div>
      <PageHeader title="Jobs" subtitle="The things people ask for most. Most need no AI." />
      <div className="mt-5 space-y-4">{JOBS.map((g) => <Card key={g.group} className="px-5 py-2"><h2 className="pt-2 text-[15px] font-semibold tracking-[-0.015em]">{g.group}</h2><ul className="divide-y divide-line">{g.jobs.map((j) => <Row key={j.id} j={j} show={(title, text) => setOut({ title, text })} />)}</ul></Card>)}</div>
      {out && <Modal open onClose={() => setOut(undefined)} title={out.title} size="lg"><pre className="max-h-[440px] overflow-auto whitespace-pre-wrap rounded-[14px] bg-sunken px-3.5 py-3 text-[12px] leading-[1.5] text-ink-2">{out.text}</pre></Modal>}
    </div>
  );
}
