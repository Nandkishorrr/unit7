// D5 light, on the app page of an app on several servers: a small strip of regions (each with its servers, its share of
// visitors and how fast it answers) and where visitors come from (top countries, when Cloudflare is in front). Database
// read copies are guidance only, behind a hover card with the providers' own pages.
import { Globe2, MapPin } from 'lucide-react';
import { HoverCard, Skeleton, cx } from '../../ui';
import { useTool } from '../care/data';

interface Region { region: string; share: number; p95: number | null; servers: { serverId: string; name: string; share: number; p95: number | null; role: string }[] }
interface Regions { regions: Region[]; countries: { code: string; name: string; pct: number }[]; otherPct: number; source: string; words: string; readCopies: { id: string; name: string; words: string; url: string }[]; readCopyNote: string }
const ms = (n: number | null) => (n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
// a flag from the two letters (the browser draws it), with the code itself for screen readers
const flag = (code: string) => (/^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

export function RegionStrip({ serviceId, className }: { serviceId: string; className?: string }) {
  const { data } = useTool<Regions>('fleet.regions', { serviceId });
  if (!data) return <Skeleton className={cx('h-[92px] rounded-[20px]', className)} />;
  return (
    <section aria-label="Regions" className={cx('rounded-[20px] border border-line p-4', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Globe2 size={16} className="text-ink-2" aria-hidden />
        <h3 className="text-[14px] font-semibold text-ink">Where visitors come from</h3>
        <span className="min-w-0 flex-1 text-[12.5px] text-muted">{data.words}</span>
        <HoverCard content={
          <div className="w-[280px] text-[12.5px] text-ink-2">
            <p className="font-medium text-ink">A database copy near your visitors</p>
            <p className="mt-1">{data.readCopyNote}</p>
            <ul className="mt-2 space-y-1.5">{data.readCopies.map((r) => <li key={r.id}><a href={r.url} target="_blank" rel="noopener" className="font-medium text-blue-text hover:underline">{r.name}</a>: {r.words}</li>)}</ul>
          </div>}>
          <span tabIndex={0} className="cursor-help text-[12px] font-medium text-blue-text underline decoration-dotted underline-offset-4">Read copies</span>
        </HoverCard>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {data.regions.map((r) => (
          <li key={r.region} className="min-w-0 rounded-[16px] bg-raised/70 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink"><MapPin size={13} className="shrink-0 text-muted" aria-hidden /><span className="truncate">{r.region === 'Not set' ? 'Region not set' : r.region}</span><span className="tabular ml-auto text-[12px] text-ink-2">{r.share}%</span></p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line" role="img" aria-label={`${r.share}% of visitors`}><div className="h-full rounded-full bg-blue motion-safe:transition-[width] motion-safe:duration-700" style={{ width: `${r.share}%` }} /></div>
            <p className="mt-1.5 truncate text-[11.5px] text-muted">{r.servers.map((s) => (s.role === 'standby' ? `${s.name} (standby)` : s.name)).join(', ')} · answers in {ms(r.p95)}</p>
          </li>
        ))}
      </ul>
      {data.countries.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Top countries">
          {data.countries.map((c) => <li key={c.code} className="tabular inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2"><span aria-hidden>{flag(c.code)}</span><span>{c.name}</span><span className="font-semibold text-ink">{c.pct}%</span></li>)}
          {data.otherPct > 0 && <li className="tabular rounded-full px-2 py-1 text-[12px] text-muted">others {data.otherPct}%</li>}
        </ul>
      )}
    </section>
  );
}
