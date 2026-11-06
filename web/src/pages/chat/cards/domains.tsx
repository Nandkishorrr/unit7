// Domains in the chat: each root domain with where its DNS lives, its subdomains and what each one opens,
// a live status dot, and the way into the Map drawer. Plus the result of checking or pointing one.
import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Globe, Lock, Mail, Plus, RefreshCw } from 'lucide-react';
import { BrandLogo, providerName } from '../../../brand/BrandLogo';
import { Badge, Button, CopyButton, cx, Skeleton, StatusMark } from '../../../ui';
import { derive } from '../../map/data';
import { Fold, Frame, IconBtn, LiveDot, Outcome, Pill, ask, call, openMap, said, useWorld } from './kit';
import { domainGroups, host, plural, type DomGroup, type DomLine, type Target } from './shape';

const EMPTY = derive({ running: false, accounts: [], issues: [], suggestions: [], assets: [], edges: [] });

function TargetChip({ t }: { t: Target }) {
  return (
    <button type="button" onClick={() => openMap(t.id)} title={`Open ${t.name} in the map`}
      className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface pl-1 pr-2.5 text-[12.5px] font-medium text-ink-2 transition hover:border-line-strong hover:bg-raised hover:text-ink">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-raised">{t.logo === 'domain' ? <Globe size={11} className="text-muted" /> : <BrandLogo id={t.logo} size={12} />}</span>
      <span className="truncate">{t.name}</span>
      {!t.ok && <LiveDot tone="bad" />}
    </button>
  );
}

function Sub({ d }: { d: DomLine }) {
  const name = d.id ? (
    <button type="button" onClick={() => openMap(d.id!)} title={d.name} className="min-w-0 max-w-[42%] shrink-0 truncate text-left text-[13px] font-medium text-ink hover:underline decoration-line-strong underline-offset-4">{d.label}</button>
  ) : <span title={d.name} className="min-w-0 max-w-[42%] shrink-0 truncate text-[13px] font-medium text-ink">{d.label}</span>;
  return (
    <li className="flex min-h-9 items-center gap-2 py-0.5">
      <LiveDot tone={d.tone} glow={d.tone === 'ok'} />
      {name}
      <ArrowRight size={12} aria-hidden className="shrink-0 text-faint" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {d.target ? <TargetChip t={d.target} /> : d.managed?.service ? <span className="truncate text-[12.5px] text-ink-2">{d.managed.service}</span> : <span className="truncate text-[12.5px] text-faint">Not linked to an app</span>}
        {(d.managed?.status === 'broken' || d.managed?.status === 'pending') && (
          <span className="hidden shrink-0 @md:inline-flex">{d.managed.status === 'broken' ? <Badge tone="bad">DNS points elsewhere</Badge> : <Badge tone="warn">Waiting for DNS</Badge>}</span>
        )}
      </span>
    </li>
  );
}

function GroupRow({ g }: { g: DomGroup }) {
  const [more, setMore] = useState(false);
  const subs = more ? g.subs : g.subs.slice(0, 4);
  const where = g.dns ? `DNS at ${providerName(g.dns)}` : g.free ? 'Free test address' : 'DNS elsewhere';
  return (
    <li className="rounded-[18px] border border-line bg-surface px-3 py-2.5 transition hover:border-line-strong">
      <div className="flex items-center gap-3">
        <span className={cx('grid size-9 shrink-0 place-items-center rounded-[12px]', g.dns ? 'bg-raised' : 'border border-dashed border-line-strong')}>
          {g.dns ? <BrandLogo id={g.dns} size={18} /> : <Globe size={16} className="text-muted" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2">
            {g.id ? <button type="button" onClick={() => openMap(g.id!)} className="truncate text-left text-[14px] font-semibold tracking-[-0.01em] text-ink hover:underline decoration-line-strong underline-offset-4">{g.root}</button>
              : <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">{g.root}</span>}
            <LiveDot tone={g.tone} glow={g.tone === 'ok'} />
          </p>
          <p className="truncate text-[12px] text-muted">{where}{g.subs.length > 0 && ` · ${plural(g.subs.length, 'subdomain')}`}</p>
        </div>
        <span className="hidden items-center gap-1.5 @lg:flex">
          {g.https !== undefined && <Badge tone={g.https ? 'ok' : 'warn'}><Lock size={11} />{g.https ? 'HTTPS' : 'HTTPS off'}</Badge>}
          {g.email === false && <Badge tone="warn"><Mail size={11} />Email can be faked</Badge>}
        </span>
        {!g.free && <IconBtn label={`Add a subdomain to ${g.root}`} onClick={() => ask(`Add a subdomain to ${g.root} and point it at one of my apps`)}><Plus size={15} /></IconBtn>}
        {g.id && <IconBtn label={`Open ${g.root} in the map`} onClick={() => openMap(g.id!)}><ArrowUpRight size={15} /></IconBtn>}
      </div>
      {(g.target || subs.length > 0) && (
        <ul className="mt-1.5 border-t border-line pl-1 pt-1 @md:ml-12 @md:pl-0">
          {g.target && <Sub d={{ name: g.root, label: g.root, tone: g.tone, target: g.target, id: g.id }} />}
          {subs.map((d) => <Sub key={d.name} d={d} />)}
        </ul>
      )}
      {g.subs.length > 4 && (
        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className="mt-0.5 rounded-full px-1 text-[12px] font-medium text-blue-text hover:underline @md:ml-12">
          {more ? 'Show fewer' : `+${g.subs.length - 4} more`}
        </button>
      )}
    </li>
  );
}

export function DomainList({ groups }: { groups: DomGroup[] }) {
  if (!groups.length) return <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">No domains yet. Connect where your domain lives (Cloudflare, GoDaddy…) and they show up here.</p>;
  return <Fold items={groups} className="space-y-2">{(g) => <GroupRow key={g.root} g={g} />}</Fold>;
}

// every domain (map.get), or only the ones Unit7 serves (domain.list: pass their hostnames)
export function DomainsCard({ only }: { only?: string[] }) {
  const w = useWorld({ map: true });
  const set = only ? new Set(only) : undefined;
  const groups = w.ready ? domainGroups(w.v ?? EMPTY, w.label, w.managed, set) : null;
  const n = only ? only.length : groups?.length;
  const bad = groups?.filter((g) => g.tone === 'bad').length ?? 0;
  return (
    <Frame icon={<Globe size={17} />} tone="soft" title={only ? 'Domains Unit7 serves' : 'Your domains'} count={n} href="/map?type=domain" hrefLabel="Open domains in the map"
      sub={groups && (bad ? `${plural(bad, 'domain')} need${bad === 1 ? 's' : ''} a look` : 'All pointing where they should')}>
      {groups ? <DomainList groups={groups} /> : <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>}
    </Frame>
  );
}

// domain.check: does DNS say what it should, and does HTTPS work. "Check again" re-runs it here.
export function DomainCheckCard({ input, output }: { input: { domainId: string }; output: any }) {
  const [o, setO] = useState(output);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const w = useWorld({ map: true });
  const asset = w.assetByName(o.hostname);
  const again = async () => {
    setBusy(true); setErr(null);
    const r = await call('domain.check', input);
    setBusy(false);
    if (r.status === 'ok') setO(r.output); else setErr(said(r, '').text);
  };
  const dnsOk = (o.records ?? []).every((r: any) => r.ok);
  const [tone, word] = o.status === 'active' && o.httpsWorking ? ['ok', 'Working'] as const : o.status === 'broken' ? ['bad', 'Points elsewhere'] as const
    : dnsOk ? ['work', 'Turning on HTTPS'] as const : ['warn', 'Waiting for DNS'] as const;
  return (
    <Frame icon={<Globe size={17} />} tone="soft" title={o.hostname} sub={o.note} right={<Pill tone={tone} glow={tone === 'ok'}>{word}</Pill>}>
      <ul className="divide-y divide-line rounded-[16px] bg-raised/60 px-3">
        <li className="flex items-center gap-2 py-2 text-[13px]">
          <StatusMark state={o.httpsWorking ? 'ok' : 'bad'} size={16} label={o.httpsWorking ? 'Working' : 'Not working'} />
          <span className="flex-1">HTTPS {o.httpsWorking ? 'works' : 'isn’t working yet'}</span>
        </li>
        {(o.records ?? []).map((r: any, i: number) => (
          <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-[13px]">
            <StatusMark state={r.ok ? 'ok' : 'bad'} size={16} label={r.ok ? 'Fine' : 'Problem'} />
            <span className="font-medium">{r.type}</span>
            <span className="min-w-0 truncate font-mono text-[12px] text-ink-2">{r.name}</span>
            <span className="text-muted">should be</span><span className="font-mono text-[12px]">{r.want}</span>
            {!r.ok && <span className="text-muted">· now {r.got?.length ? <span className="font-mono text-[12px] text-bad">{r.got.join(', ')}</span> : 'nothing'}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="soft" icon={<RefreshCw size={13} />} loading={busy} onClick={again}>Check again</Button>
        {asset && <Button size="sm" variant="ghost" onClick={() => openMap(asset.id)}>Open in Map<ArrowUpRight size={13} /></Button>}
        {(tone === 'bad' || !dnsOk) && <Button size="sm" variant="ghost" onClick={() => ask(`Fix ${o.hostname}: ${o.note}`)}>Ask Unit7 to fix</Button>}
      </div>
      {err && <Outcome tone="bad">{err}</Outcome>}
    </Frame>
  );
}

// domain.point: either it's done (DNS written, HTTPS follows) or here are the records to add yourself
export function DomainPointCard({ input, output: o }: { input: any; output: any }) {
  const w = useWorld();
  const app = w.svcLabel(w.svc(input?.serviceId)) ?? (input?.vercel ? 'your Vercel project' : 'your app');
  const needs = o.dns === 'needs you';
  return (
    <Frame icon={<Globe size={17} />} tone={needs ? 'warn' : 'ok'} title={o.hostname} sub={needs ? `Almost there: add ${plural(o.addThese?.length ?? 1, 'record')} at ${o.at}` : `Now opens ${app}`}
      right={<Pill tone={needs ? 'warn' : 'ok'} glow={!needs}>{needs ? 'Needs you' : 'Connected'}</Pill>}>
      {needs ? (
        <>
          <ul className="divide-y divide-line rounded-[16px] bg-raised/60 px-3">
            <li aria-hidden className="hidden grid-cols-[64px_120px_1fr_auto] gap-x-3 py-1.5 text-[11.5px] text-muted @md:grid"><span>Type</span><span>Name</span><span>Value</span><span className="w-7" /></li>
            {(o.addThese ?? []).map((r: any, i: number) => (
              <li key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 py-2 text-[13px] @md:grid-cols-[64px_120px_1fr_auto]">
                <span className="font-medium">{r.type}</span>
                <span className="font-mono text-[12px] text-ink-2 @max-md:col-span-2">{r.name}</span>
                <span className="min-w-0 truncate font-mono text-[12px] @max-md:col-span-2">{r.value}</span>
                <CopyButton text={r.value} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12.5px] text-muted">Unit7 keeps checking and finishes by itself once they’re live.</p>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {o.url && <Button size="sm" variant="primary" icon={<ArrowUpRight size={13} />} onClick={() => window.open(o.url, '_blank', 'noopener')}>Open {host(o.url)}</Button>}
          <span className="text-[12.5px] text-muted">{typeof o.dns === 'string' ? 'DNS is set. HTTPS turns on by itself within minutes.' : 'DNS is set. HTTPS follows once it’s live.'}</span>
        </div>
      )}
    </Frame>
  );
}
