// Chat cards for test copies (staging.plan / create / remove) and added tools (addon.catalog / install / remove), drawn
// by toolCard in chat/cards.tsx. A plan opens the full pop-up; a result says where it lives now and what's left to do.
import { useState } from 'react';
import { FlaskConical, KeyRound, PackagePlus, X } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { Button, CopyButton, StatusMark } from '../../ui';
import { Frame, Pill } from '../chat/cards/kit';
import { StagingPlanModal } from './Staging';
import { host, size } from './parts';

const LOGO: Record<string, string> = { 'uptime-kuma': 'uptimekuma', cloudbeaver: 'dbeaver' };
const logoOf = (id?: string) => (id ? LOGO[id] ?? id : 'unit7');
const plain = (s: string) => s.replace(/^\d+\.\s*/, '');
// tool names and credential:// references never reach the screen
const words = (t?: string) => (t ?? '').replace(/\bcredential:\/\/\S+/g, 'a key in your vault').replace(/\b(staging|addon|coolify|env|backup|service|deployment|database|domain)\.[a-z_]+\b/g, 'Unit7');

function Done({ steps, failed }: { steps: { step: string }[]; failed?: { step: string; why: string } }) {
  return (
    <ol className="space-y-1.5">
      {steps.length > 8 && <li className="text-[12.5px] text-muted">{steps.length - 8} earlier steps done</li>}
      {steps.slice(-8).map((d, n) => (
        <li key={n} className="flex items-start gap-2.5 text-[13px]"><StatusMark state="ok" size={20} solid label="Done" className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1">{d.step}</span></li>
      ))}
      {failed && (
        <li className="flex items-start gap-2.5 text-[13px]"><span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-bad-solid text-white"><X size={11} strokeWidth={3.5} /></span>
          <span className="min-w-0 flex-1"><span className="font-medium text-ink">{failed.step}</span><span className="block text-[12.5px] text-bad">{words(failed.why)}</span></span></li>
      )}
    </ol>
  );
}

export function StagingChatCard({ tool, input, output: o }: { tool: string; input: any; output: any }) {
  const [open, setOpen] = useState(false);
  const target = { ...(input?.projectId ? { projectId: input.projectId } : { serverId: input?.serverId, app: input?.app }), name: o.name ?? 'your app' };
  if (tool === 'staging.plan' && o.kind === 'host') {
    return <Frame icon={<BrandLogo id={input?.host ?? 'unit7'} size={17} />} title={`Test copies on ${o.name}`} sub="What it offers"><ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-2">{(o.possible ?? []).map((p: string) => <li key={p}>{p}</li>)}</ul></Frame>;
  }
  if (tool === 'staging.plan') {
    return (
      <Frame icon={<FlaskConical size={17} />} tone="soft" title={`A test copy of ${o.name}`} sub={`${o.from} → ${o.to} · ${o.steps?.length ?? 0} steps`} right={o.existing ? <Pill tone="ok">Up already</Pill> : undefined}>
        {o.liveKeys?.length ? <p className="text-[13px] text-ink-2"><KeyRound size={13} className="mr-1 inline align-[-2px] text-muted" aria-hidden />{o.liveKeys.length} live-looking key{o.liveKeys.length === 1 ? '' : 's'} stay out: {o.liveKeys.slice(0, 4).map((l: any) => l.key).join(', ')}{o.liveKeys.length > 4 ? '…' : ''}</p> : null}
        {o.room?.needMb ? <p className="mt-1 text-[12.5px] text-muted">Needs about {size(o.room.needMb)}{o.room.freeMb !== undefined ? `, ${size(o.room.freeMb)} free` : ''}.</p> : null}
        <Button size="sm" variant="primary" className="mt-3" icon={<FlaskConical size={14} />} onClick={() => setOpen(true)}>See the plan</Button>
        <StagingPlanModal target={target} open={open} onClose={() => setOpen(false)} />
      </Frame>
    );
  }
  if (tool === 'staging.remove') {
    return <Frame icon={<FlaskConical size={17} />} tone={o.removed ? 'ok' : 'warn'} title={o.removed ? 'Test copy taken down' : 'The copy isn’t down yet'} sub={o.removed ? 'Production wasn’t touched' : words(o.next)}><Done steps={o.done ?? []} failed={o.failed} /></Frame>;
  }
  const url: string | undefined = o.url;
  const title = o.created ? 'Test copy is live' : o.failed ? 'The copy stopped' : o.declined ? 'Not made' : o.needsConfirm ? 'Ready to make the copy' : 'Test copy';
  return (
    <Frame icon={<FlaskConical size={17} />} tone={o.created ? 'ok' : o.failed ? 'bad' : 'soft'} title={title}
      sub={url ? <a href={url} target="_blank" rel="noopener" className="font-medium text-blue-text hover:underline">{host(url)}</a> : o.name}
      right={<Pill tone={o.created ? 'ok' : o.failed ? 'bad' : 'idle'}>{o.created ? 'Live' : o.failed ? 'Stopped' : o.declined ? 'Not now' : 'Waiting'}</Pill>}>
      {o.done?.length || o.failed ? <Done steps={o.done ?? []} failed={o.failed} /> : <ol className="space-y-1 text-[13px] text-ink-2">{(o.steps ?? []).slice(0, 8).map((s: string) => <li key={s}>{plain(s)}</li>)}</ol>}
      {o.leftOut?.length ? <p className="mt-3 rounded-[14px] bg-raised px-3 py-2 text-[12.5px] text-ink-2">Left out because they look live: {o.leftOut.join(', ')}.</p> : null}
      {o.next && !o.created && <p className="mt-3 rounded-[14px] bg-raised px-3 py-2 text-[12.5px] text-ink-2">{words(o.next)}</p>}
    </Frame>
  );
}

export function AddonChatCard({ tool, input, output: o }: { tool: string; input: any; output: any }) {
  const href = `/add${o.server?.id || input?.serverId ? `?server=${o.server?.id ?? input.serverId}` : ''}`;
  if (tool === 'addon.catalog') {
    const items: any[] = o.items ?? [];
    return (
      <Frame icon={<PackagePlus size={17} />} tone="soft" title="Tools you can add" count={items.filter((x) => x.how !== 'off' && x.how !== 'needs_coolify').length} sub={o.server ? `${o.server.name}${o.freeMb !== undefined ? ` · ${size(o.freeMb)} free` : ''}` : o.note} href={href} hrefLabel="Open Add to my server">
        <ul className="grid grid-cols-2 gap-2 @md:grid-cols-3">
          {items.slice(0, 9).map((x) => (
            <li key={x.id} className="flex min-w-0 items-center gap-2 rounded-[14px] bg-raised/60 px-2.5 py-2">
              <BrandLogo id={x.logo} size={18} title={x.name} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-ink">{x.name}</span><span className="block truncate text-[11.5px] text-muted">{x.installed ? 'On already' : x.how === 'off' || x.how === 'needs_coolify' ? 'Not here yet' : size(x.memoryMb)}</span></span>
            </li>
          ))}
        </ul>
      </Frame>
    );
  }
  if (tool === 'addon.remove') return <Frame icon={<BrandLogo id={logoOf(o.addon)} size={17} title={o.name} />} title={`${o.name} is off`} sub={o.dataKept ? 'Its data is kept' : 'Its data went too'} href={href} />;
  return (
    <Frame icon={<BrandLogo id={logoOf(o.addon)} size={17} title={o.name} />} tone={o.healthy ? 'ok' : 'warn'} title={o.already ? `${o.name} is already there` : o.healthy ? `${o.name} is live` : `${o.name} is starting`}
      sub={o.url ? <a href={o.url} target="_blank" rel="noopener" className="font-medium text-blue-text hover:underline">{host(o.url)}</a> : o.server} href={href} hrefLabel="Open Add to my server"
      right={<Pill tone={o.healthy || o.already ? 'ok' : 'warn'}>{o.healthy || o.already ? 'Live' : 'Starting'}</Pill>}>
      <div className="space-y-2 text-[12.5px] text-ink-2">
        {o.firstVisit && <p className="rounded-[14px] bg-warn/10 px-3 py-2">{o.firstVisit}</p>}
        {o.credentials?.some((c: any) => c.saved) && <p><KeyRound size={13} className="mr-1 inline align-[-2px] text-muted" aria-hidden />{o.credentials.filter((c: any) => c.saved).map((c: any) => c.label).join(', ')} kept in your vault. Show them on Add to my server.</p>}
        {o.wire?.snippet && <div className="flex items-start gap-2 rounded-[12px] bg-[#111115] px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-white/90">{o.wire.snippet}</code><CopyButton text={o.wire.snippet} className="text-white/60 hover:bg-white/10 hover:text-white" /></div>}
        {o.monitors?.synced ? <p>{o.monitors.note}</p> : o.monitors?.sites?.length ? <p>Sites to watch: {o.monitors.sites.slice(0, 5).map(host).join(', ')}{o.monitors.sites.length > 5 ? '…' : ''}</p> : null}
        {o.next && <p>{words(o.next)}</p>}
      </div>
    </Frame>
  );
}
