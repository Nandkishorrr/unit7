// What runs out: everything with a date on it, soonest first, and one button to put it all in your calendar.
import { CalendarPlus } from 'lucide-react';
import { useTool } from '../care/data';
import { Badge, Button, Card, PageHeader, Skeleton } from '../../ui';

interface Expiry { id: string; kind: string; name: string; at: string; days: number; renews?: boolean; note?: string }
const KIND: Record<string, string> = { domain: 'Domain', certificate: 'Certificate', server: 'Server plan', key: 'App key' };
export const whenWords = (days: number) => (days < 0 ? `${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'today' : days < 60 ? `in ${days} day${days === 1 ? '' : 's'}` : `in about ${Math.round(days / 30)} months`);

function download(ics: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'unit7-expiry.ics';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function ExpiryPage() {
  const { data } = useTool<{ list: Expiry[]; ics: string }>('expiry.list', {});
  return (
    <div>
      <PageHeader title="What runs out" subtitle="Domains, certificates, server plans and keys, soonest first."
        actions={data?.list.length ? <Button variant="secondary" icon={<CalendarPlus size={15} />} onClick={() => download(data.ics)}>Add to my calendar</Button> : undefined} />
      {!data && <Skeleton className="mt-6 h-48 w-full" />}
      {data && !data.list.length && <Card className="mt-6 p-8 text-center text-[13.5px] text-muted">Nothing with a date yet. Unit7 reads these as it checks your domains each day.</Card>}
      {data && data.list.length > 0 && (
        <Card className="mt-5 px-5"><ul className="divide-y divide-line">{data.list.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
            <div className="min-w-0 flex-1 basis-[240px]"><p className="truncate text-[14px] font-medium text-ink">{e.name}</p><p className="text-[12.5px] text-muted">{KIND[e.kind] ?? e.kind}{e.note ? ` · ${e.note}` : ''}</p></div>
            <Badge tone={e.days < 0 ? 'bad' : e.days <= 14 && !e.renews ? 'warn' : 'neutral'}>{whenWords(e.days)}</Badge>
          </li>
        ))}</ul></Card>
      )}
    </div>
  );
}
