// Investigations you can read: each idea with what supports it, and "not sure" as a fair ending.
import { useTool } from '../care/data';
import { Badge, Card, PageHeader, Skeleton, timeAgo } from '../../ui';

interface Idea { idea: string; state: 'supported' | 'ruled-out' | 'unknown'; evidence: string[] }
interface Inv { id: string; title: string; status: string; ideas: Idea[]; conclusion: string | null; sure?: boolean; opinion: { holds: boolean; why: string } | null; by: string; at: string }
const WORD = { supported: ['Supported', 'ok'], 'ruled-out': ['Ruled out', 'neutral'], unknown: ['Unknown', 'warn'] } as const;

export function InvestigationsPage() {
  const { data } = useTool<{ list: Inv[] }>('investigation.list', {});
  return (
    <div>
      <PageHeader title="Investigations" subtitle="What was looked at, what it showed, and how sure anyone is." />
      {!data && <Skeleton className="mt-6 h-40 w-full" />}
      {data && !data.list.length && <Card className="mt-6 p-8 text-center text-[13.5px] text-muted">Nothing here yet. When an AI digs into a problem, its working shows up here.</Card>}
      <div className="mt-5 space-y-3">{data?.list.map((i) => (
        <Card key={i.id} className="p-5">
          <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-ink">{i.title}{i.status === 'open' ? <Badge tone="info">Open</Badge> : <Badge tone={i.sure ? 'ok' : 'neutral'}>{i.sure ? 'Sure' : 'Not sure'}</Badge>}</p>
          <p className="text-[12.5px] text-muted">{i.by}, {timeAgo(i.at)}</p>
          {i.conclusion && <p className="mt-2 text-[14px] text-ink">{i.conclusion}</p>}
          {i.opinion && <p className="mt-1 text-[13px] text-ink-2">{i.opinion.holds ? 'A second pass tried to disprove this and couldn’t' : 'A second pass doubts this'}: {i.opinion.why}</p>}
          <ul className="mt-2 divide-y divide-line">{i.ideas.map((x) => <li key={x.idea} className="py-2"><p className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink">{x.idea}<Badge tone={WORD[x.state][1]}>{WORD[x.state][0]}</Badge></p>{x.evidence.map((e) => <p key={e} className="text-[12.5px] text-muted">{e}</p>)}</li>)}</ul>
        </Card>
      ))}</div>
    </div>
  );
}
