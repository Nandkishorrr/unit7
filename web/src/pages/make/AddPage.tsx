// Add to my server (/add): the tools a growing app needs, one click each, on the person's own server, with search and shelves. Each card says
// what it is in a line and what memory it needs against the server's free room; Install opens a centred pop-up (its
// address, then the steps as they happen, then the moment it's live with what's left to do: the first sign-in, its keys
// shown only on request, a snippet or settings for an app, and for Uptime Kuma the sites to watch).
import { useEffect, useMemo, useState } from 'react';
import { Activity, ExternalLink, Eye, KeyRound, PackagePlus, SearchX, Server, Trash2 } from 'lucide-react';
import { runTool, useApi, type ToolResult } from '../../lib/api';
import { navigate, useQuery } from '../../lib/router';
import { tidy } from '../../lib/words';
import { Badge, Button, Card, ChipSelect, CopyButton, Empty, Field, HoldButton, HoverCard, Input, Modal, PageHeader, SearchInput, Select, Skeleton, Switch, cx, toast, Illustration } from '../../ui';
import { LogoTile, Menu } from '../kit';
import { BrandLogo } from '../../brand/BrandLogo';
import { LiveMoment, Note, RoomMeter, StepList, host, size, useSteps } from './parts';

export interface AddonItem {
  id: string; name: string; logo: string; category: string; line: string; memoryMb: number; how: 'coolify' | 'unit7' | 'needs_coolify' | 'off';
  group?: string; suggest?: string; fits?: boolean; off?: string; instead?: string; domainOnly?: string; warn?: string; unknown?: boolean; installed: { url?: string; healthy: boolean | null; at: string; keys: number; gated?: boolean } | null;
}
interface Catalog { servers: { id: string; name: string; coolify: boolean }[]; server?: { id: string; name: string; coolify: boolean }; freeMb?: number; root?: string; items: AddonItem[]; note?: string; anyTemplateWarn?: string }
export type Installed = {
  name: string; url?: string; healthy: boolean; status?: string; via: string; dns?: { written: boolean; at?: string; addThese?: { type: string; name: string; value: string }[] };
  credentials: { label: string; saved: boolean }[]; credentialsNote?: string; firstVisit?: string; next?: string; gated?: boolean; warning?: string;
  wire?: { note: string; snippet?: string; env?: { key: string; value: string }[] }; monitors?: Monitored;
};
// Uptime Kuma's monitors after an install (uptime.sync): what it watches now, or the sites to add by hand
export interface Monitored { sites: string[]; note: string; synced?: boolean; watching?: number; added?: string[]; missing?: { url: string; why: string }[]; stale?: string[]; staleNote?: string; needsLogin?: boolean }
const outOf = (r: ToolResult | undefined) => (r?.status === 'ok' ? { ok: r.output } : { why: tidy(!r ? 'That didn’t go through.' : r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? 'It waits for your OK on Approvals.' : 'Previewed only.'), approval: r?.status === 'approval_required' });

export function AddPage() {
  const q = useQuery();
  const [serverId, setServerId] = useState<string | undefined>(q.get('server') ?? undefined);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string>();
  const [installing, setInstalling] = useState<AddonItem | null>(null);
  const [removing, setRemoving] = useState<AddonItem | null>(null);
  const [keys, setKeys] = useState<AddonItem | null>(null);
  const [term, setTerm] = useState('');
  const [shelf, setShelf] = useState('All');
  const load = () => runTool('addon.catalog', serverId ? { serverId } : {}).then((r) => { const o = outOf(r); if (o.ok) { setCat(o.ok); setErr(undefined); } else setErr(o.why); }, (e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, [serverId]);
  const sid = cat?.server?.id;
  const ready = cat?.items ?? [];
  const installedCount = ready.filter((x) => x.installed).length;
  const shelfOf = (a: AddonItem) => a.group ?? a.category;
  const word = term.trim().toLowerCase();
  // what can be added comes first; a search looks through every shelf
  const rank = (a: AddonItem) => (a.how === 'off' ? 2 : a.how === 'needs_coolify' ? 1 : 0);
  const shown = ready.filter((a) => (word ? `${a.name} ${a.category} ${shelfOf(a)} ${a.line}`.toLowerCase().includes(word) : shelf === 'All' || shelfOf(a) === shelf)).sort((x, y) => rank(x) - rank(y));
  // no match, but it could be a key of Coolify's template list
  const template = cat?.server?.coolify && /^[a-z0-9][a-z0-9-]{1,60}$/.test(word) ? word : undefined;

  return (
    <div>
      <PageHeader title="Add to my server" subtitle="The tools a growing app needs, one click each. They run on your own server, so their data stays yours."
        actions={cat?.server && (
          <>
            {cat.servers.length > 1 && <ChipSelect label="Server" value={cat.server.id} onChange={(v) => { setServerId(v); navigate(`/add?server=${v}`, { replace: true }); }} options={cat.servers.map((s) => ({ value: s.id, label: s.name }))} />}
            <Badge tone="neutral" className="h-8 gap-1.5 px-3"><Server size={13} aria-hidden />{cat.servers.length > 1 ? null : cat.server.name}{cat.freeMb !== undefined && <span className="text-muted">{cat.servers.length > 1 ? '' : '· '}{size(cat.freeMb)} free</span>}</Badge>
          </>
        )} />
      {err && <Note tone="bad">{err}</Note>}
      {!cat && !err && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 min-[105rem]:grid-cols-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[188px] rounded-[24px]" />)}</div>}
      {cat && !cat.server && <Empty art={<Illustration name="add-server" size={104} />} title="Connect a server first" body="The tools run on your server. Connect one and they’re a click away." action={<Button variant="primary" onClick={() => navigate('/servers')}>Go to Servers</Button>} />}
      {cat?.server && (
        <>
          <div className="mb-5 space-y-3">
            <SearchInput value={term} onChange={setTerm} placeholder="Search tools" label="Search tools" className="md:w-[320px]" />
            {!word && (
              <div role="group" aria-label="Kinds of tool" className="flex flex-wrap gap-1.5">
                {['All', ...new Set(ready.map(shelfOf))].map((s) => <button key={s} type="button" aria-pressed={shelf === s} onClick={() => setShelf(s)} className={cx('h-8 rounded-full px-3.5 text-[13px] font-medium transition', shelf === s ? 'bg-ink text-bg' : 'bg-raised text-ink-2 hover:text-ink')}>{s}</button>)}
              </div>
            )}
          </div>
          {installedCount > 0 && <p className="mb-3 text-[13px] text-muted">{installedCount} on {cat.server.name} already.</p>}
          {shown.length ? (
            <ul className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3 min-[105rem]:grid-cols-4">
              {shown.map((a) => (
                <li key={a.id} className="min-w-0">
                  <AddonCard a={a} free={cat.freeMb} onInstall={() => setInstalling(a)} onRemove={() => setRemoving(a)} onKeys={() => setKeys(a)} instead={ready.find((x) => x.id === a.instead)} onInstead={(x) => setInstalling(x)} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon={<SearchX size={22} />} title={`Nothing called “${term.trim()}”`}
              body={template ? 'It isn’t one of Unit7’s tools. If that’s the name of a Coolify template, Unit7 can still add it, with a warning.' : 'Try another word.'}
              action={template && <Button variant="secondary" icon={<PackagePlus size={15} />} onClick={() => setInstalling({ id: template, name: template, logo: template, category: 'Coolify template', line: 'A Coolify template Unit7 doesn’t know', memoryMb: 0, how: 'coolify', unknown: true, warn: cat.anyTemplateWarn, installed: null })}>Add {template} from Coolify</Button>} />
          )}
          {cat.server.coolify ? !!shown.length && <p className="mt-5 text-[12.5px] text-muted">Looking for something else? Search for any Coolify template by its name.</p>
            : <p className="mt-5 text-[12.5px] text-muted">{cat.server.name} has no Coolify connected, so Unit7 adds the one-container tools itself; the rest need Coolify.</p>}
        </>
      )}
      {sid && installing && <InstallModal serverId={sid} server={cat!.server!.name} item={installing} freeMb={cat!.freeMb} open onClose={() => { setInstalling(null); void load(); }} />}
      {sid && removing && <RemoveModal serverId={sid} item={removing} open onClose={(gone) => { setRemoving(null); if (gone) void load(); }} />}
      {sid && keys && <KeysModal serverId={sid} item={keys} open onClose={() => setKeys(null)} />}
    </div>
  );
}

function AddonCard({ a, free, onInstall, onRemove, onKeys, instead, onInstead }: { a: AddonItem; free?: number; onInstall: () => void; onRemove: () => void; onKeys: () => void; instead?: AddonItem; onInstead: (x: AddonItem) => void }) {
  const off = a.how === 'off' || a.how === 'needs_coolify';
  return (
    <Card lift={!off} className={cx('flex h-full flex-col p-5', off && 'bg-surface/70')}>
      <div className="flex items-start gap-3">
        <LogoTile size={44} className={cx(off && 'opacity-60 grayscale')}><BrandLogo id={a.logo} size={23} title={a.name} /></LogoTile>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15.5px] font-semibold tracking-[-0.015em] text-ink">{a.name}</h2>
          <p className="truncate text-[12.5px] text-muted">{a.category}</p>
        </div>
        {a.installed && <Badge tone={a.installed.healthy === false ? 'warn' : 'ok'} className="shrink-0">{a.installed.healthy === false ? 'Starting' : 'On'}</Badge>}
      </div>
      <p className="mt-3 flex-1 text-[13.5px] leading-snug text-ink-2">{a.line}</p>
      <div className="mt-4 flex items-center gap-2">
        {a.memoryMb > 0 && <HoverCard content={<div className="w-[220px]"><RoomMeter needMb={a.memoryMb} freeMb={free} fits={a.fits} label="Uses about" /><p className="mt-2 text-[12px] text-muted">{a.how === 'coolify' ? 'Added as Coolify’s own one-click service.' : a.how === 'unit7' ? 'Unit7 runs it, with its own database.' : a.off}</p></div>}>
          <button type="button" className={cx('inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium tabular', a.fits === false ? 'bg-warn/12 text-warn' : 'bg-raised text-ink-2')}>
            <span aria-hidden className={cx('size-1.5 rounded-full', a.fits === false ? 'bg-[#f59e0b]' : 'bg-ok')} />{size(a.memoryMb)}{a.fits === false && <span className="sr-only">, more than the free room</span>}
          </button>
        </HoverCard>}
        <span className="ml-auto flex items-center gap-1.5">
          {a.installed ? (
            <>
              {a.installed.url && <Button size="sm" variant="secondary" icon={<ExternalLink size={13} />} onClick={() => window.open(a.installed!.url, '_blank', 'noopener')}>Open</Button>}
              <Menu label={`More for ${a.name}`} className="grid size-8 place-items-center rounded-full border border-line-strong bg-surface text-ink transition hover:bg-raised"
                items={[...(a.installed.keys ? [{ label: 'Show its keys', icon: <KeyRound size={16} />, hint: 'Only you see them', onSelect: onKeys }] : []), { section: 'Danger zone' }, { label: 'Take it off…', icon: <Trash2 size={16} />, danger: true, hint: 'Its data stays unless you say so', onSelect: onRemove }]} />
            </>
          ) : off ? (
            a.instead && instead ? <Button size="sm" variant="soft" onClick={() => onInstead(instead)}>Add {instead.name} instead</Button>
              : <HoverCard content={<p className="max-w-[240px] text-[12.5px]">{a.off}</p>}><span tabIndex={0} className="inline-flex h-8 items-center rounded-full px-3 text-[12.5px] font-medium text-muted">Not here yet</span></HoverCard>
          ) : <Button size="sm" variant="primary" icon={<PackagePlus size={14} />} onClick={onInstall}>Install</Button>}
        </span>
      </div>
      {a.how === 'off' && a.off && <p className="mt-2.5 text-[12px] text-muted">{a.off}</p>}
    </Card>
  );
}

function InstallModal({ serverId, server, item: a, freeMb, open, onClose }: { serverId: string; server: string; item: AddonItem; freeMb?: number; open: boolean; onClose: () => void }) {
  const [domain, setDomain] = useState(a.suggest ?? '');
  const [free, setFree] = useState(!a.suggest && !a.domainOnly);
  const [phase, setPhase] = useState<'ask' | 'running' | 'done' | 'failed'>('ask');
  const [out, setOut] = useState<Installed>();
  const [why, setWhy] = useState<{ why: string; approval?: boolean }>();
  const steps = useSteps('addon.install', phase === 'running');
  const titles = useMemo(() => Array.from({ length: Math.max(steps.of, steps.titles.length, 1) }, (_, i) => steps.titles[i] ?? ''), [steps]);
  const okName = free || /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+){2,}$/.test(domain.trim().toLowerCase());
  const go = async () => {
    setPhase('running');
    const r = outOf(await runTool('addon.install', { serverId, addon: a.id, ...(!free && domain.trim() && { domain: domain.trim().toLowerCase() }) }).catch(() => undefined));
    if (r.ok) { setOut(r.ok); setPhase('done'); toast('ok', `${a.name} is live`, r.ok.url ? host(r.ok.url) : undefined); } else { setWhy({ why: r.why!, approval: r.approval }); setPhase('failed'); }
  };
  return (
    <Modal open={open} onClose={onClose} title={phase === 'done' ? `${a.name} on ${server}` : `Add ${a.name} to ${server}`} size="md">
      {phase === 'ask' && (
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <LogoTile size={48}><BrandLogo id={a.logo} size={25} title={a.name} /></LogoTile>
            <div className="min-w-0"><p className="text-[14px] font-medium text-ink">{a.category}</p><p className="text-[13px] text-muted">{a.line}</p></div>
          </div>
          {!a.unknown && (
            <Field label="Its address" hint={free ? 'A free test address now; add your own domain any time.' : a.domainOnly ?? 'A subdomain of yours. Unit7 writes its DNS record where your domain lives, and HTTPS follows.'}>
              <Input value={free ? '' : domain} disabled={free} placeholder={`${a.id === 'umami' ? 'analytics' : 'tools'}.example.com`} onChange={(e) => setDomain(e.target.value)} aria-invalid={!okName} />
            </Field>
          )}
          {!a.domainOnly && !a.unknown && <label className="flex items-center justify-between gap-4 text-[13.5px] text-ink-2">Use a free test address instead<Switch checked={free} onChange={setFree} label="Use a free test address instead" /></label>}
          {a.memoryMb > 0 && <RoomMeter needMb={a.memoryMb} freeMb={freeMb} fits={a.fits} label="Uses about" />}
          {a.fits === false && <Note tone="warn">{server} looks short on free memory for this. Unit7 checks again when you install, and won’t add it if it still doesn’t fit. A bigger server or one tool fewer helps.</Note>}
          {a.warn && <Note tone="warn">{a.warn}</Note>}
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="ghost" onClick={onClose}>Not now</Button>
            <Button variant="primary" icon={<PackagePlus size={15} />} disabled={!okName} onClick={go}>Install {a.name}</Button>
          </div>
        </div>
      )}
      {phase === 'running' && <div className="space-y-4"><StepList steps={titles} at={steps.at} note={steps.note} /><p className="text-[12.5px] text-muted">This takes a minute or two. It carries on if you close this.</p></div>}
      {phase === 'failed' && (
        <div className="space-y-4">
          <Note tone={why?.approval ? 'info' : 'bad'}>{why?.why}</Note>
          <div className="flex justify-end gap-2">{why?.approval ? <Button variant="primary" onClick={() => navigate('/approvals')}>Open Approvals</Button> : <Button variant="primary" onClick={() => setPhase('ask')}>Try again</Button>}</div>
        </div>
      )}
      {phase === 'done' && out && <InstalledView a={a} out={out} serverId={serverId} onClose={onClose} />}
    </Modal>
  );
}

// the moment it's live, and what's left to do: the first sign-in, its keys (on request), wiring, sites to watch
export function InstalledView({ a, out, serverId, onClose }: { a: Pick<AddonItem, 'id' | 'name'>; out: Installed; serverId: string; onClose: () => void }) {
  return (
    <LiveMoment title={out.healthy ? `${a.name} is live` : `${a.name} is starting`} url={out.url}>
      <div className="space-y-3">
        {out.next && <Note tone="warn">{out.next}</Note>}
        {out.warning && <Note tone="warn">{out.warning}</Note>}
        {out.dns && !out.dns.written && out.dns.addThese && <Note tone="warn">Add this record where your domain’s DNS lives ({out.dns.at}): {out.dns.addThese.map((r) => `${r.type} ${r.name} → ${r.value}`).join(', ')}. Unit7 finishes by itself once it’s live.</Note>}
        {out.firstVisit && <Note tone={/first person/.test(out.firstVisit) ? 'warn' : 'neutral'}>{out.firstVisit}</Note>}
        {out.credentials.some((c) => c.saved) && <KeysInline serverId={serverId} addon={a.id} labels={out.credentials.filter((c) => c.saved).map((c) => c.label)} />}
        {out.gated && <Unlock serverId={serverId} addon={a.id} name={a.name} />}
        {out.credentialsNote && <Note>{out.credentialsNote}</Note>}
        {out.wire && (!out.monitors || out.wire.snippet || !!out.wire.env?.length) && <Wire wire={out.wire} name={a.name} />}
        {out.monitors && <Monitors m={out.monitors} serverId={a.id === 'uptime-kuma' ? serverId : undefined} />}
      </div>
      <div className="mt-5 flex justify-end"><Button variant="dark" onClick={onClose}>Done</Button></div>
    </LiveMoment>
  );
}

// its keys, only when the person asks (the server checks it's a person, an owner or admin)
function KeysInline({ serverId, addon, labels }: { serverId: string; addon: string; labels?: string[] }) {
  const [shown, setShown] = useState<{ label: string; value: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setBusy(true);
    const r = outOf(await runTool('addon.credentials', { serverId, addon }).catch(() => undefined));
    setBusy(false);
    if (r.ok) setShown(r.ok.items); else toast('bad', 'Couldn’t show its keys', r.why);
  };
  return (
    <div className="rounded-[16px] border border-line px-3.5 py-3">
      <div className="flex items-center gap-3">
        <KeyRound size={16} aria-hidden className="shrink-0 text-muted" />
        <p className="min-w-0 flex-1 text-[13px] text-ink-2">{labels?.length ? `${labels.join(', ')} ${labels.length === 1 ? 'is' : 'are'} in your vault.` : 'Its keys are in your vault.'} Only you can see them.</p>
        {!shown && <Button size="sm" variant="soft" icon={<Eye size={14} />} loading={busy} onClick={show}>Show</Button>}
      </div>
      {shown && (
        <ul className="mt-2.5 space-y-1.5">
          {shown.map((k) => <li key={k.label} className="flex items-center gap-2 text-[12.5px]"><span className="w-32 shrink-0 text-muted">{k.label}</span><code className="min-w-0 flex-1 truncate rounded-lg bg-raised px-2 py-1 font-mono text-ink">{k.value}</code><CopyButton text={k.value} /></li>)}
        </ul>
      )}
    </div>
  );
}
// the extra password in front of a tool that makes its admin from its first visitor: gone once the person says setup is done
function Unlock({ serverId, addon, name }: { serverId: string; addon: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = outOf(await runTool('addon.unlock', { serverId, addon }).catch(() => undefined));
    setBusy(false);
    if (r.ok) { setDone(true); toast('ok', `${name} is open`, 'Its own sign-in protects it now.'); } else toast('bad', 'Couldn’t take the extra password away', r.why);
  };
  if (done) return <Note>{name}’s extra password is gone. Its own sign-in protects it now.</Note>;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[16px] border border-line px-3.5 py-3">
      <p className="min-w-0 flex-1 text-[13px] text-ink-2">Made your own admin login in {name}? Then the extra password can go.</p>
      <Button size="sm" variant="soft" loading={busy} onClick={go}>I’ve finished setup</Button>
    </div>
  );
}
function KeysModal({ serverId, item, open, onClose }: { serverId: string; item: AddonItem; open: boolean; onClose: () => void }) {
  return <Modal open={open} onClose={onClose} title={`${item.name}’s keys`} size="sm"><div className="space-y-3"><KeysInline serverId={serverId} addon={item.id} />{item.installed?.gated && <Unlock serverId={serverId} addon={item.id} name={item.name} />}</div></Modal>;
}

// a tracking snippet to copy, and settings to put on one of your apps (addresses and vault references, never values)
function Wire({ wire, name }: { wire: NonNullable<Installed['wire']>; name: string }) {
  const graph = useApi<any>('/api/graph');
  const apps = useMemo(() => (graph.data?.projects ?? []).flatMap((p: any) => (p.environments ?? []).flatMap((e: any) => (e.services ?? []).filter((s: any) => s.kind === 'app').map((s: any) => ({ value: s.id, label: `${p.name} · ${s.name}${/^prod/i.test(e.name) ? '' : ` (${e.name.toLowerCase()})`}` })))), [graph.data]);
  const [app, setApp] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    for (const e of wire.env ?? []) {
      const r = outOf(await runTool('env.set', { serviceId: app, key: e.key, value: e.value }).catch(() => undefined));
      if (!r.ok) { setBusy(false); toast('bad', `Couldn’t add ${e.key}`, r.why); return; }
    }
    setBusy(false);
    toast('ok', `${name} is wired in`, 'Your app gets it on its next deploy.');
  };
  return (
    <div className="space-y-2.5 rounded-[16px] border border-line px-3.5 py-3">
      <p className="text-[13px] text-ink-2">{wire.note}</p>
      {wire.snippet && <div className="flex items-start gap-2 rounded-[12px] bg-[#111115] px-3 py-2.5"><code className="min-w-0 flex-1 break-all font-mono text-[12px] text-white/90">{wire.snippet}</code><CopyButton text={wire.snippet} className="text-white/60 hover:bg-white/10 hover:text-white" /></div>}
      {!!wire.env?.length && apps.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select className="min-w-0 flex-1" value={app} onChange={setApp} options={[{ value: '', label: 'Add it to my app…' }, ...apps]} />
          <Button size="sm" variant="dark" disabled={!app} loading={busy} onClick={add}>Add {wire.env.map((e) => e.key).join(' and ')}</Button>
        </div>
      )}
    </div>
  );
}
// "Uptime Kuma now watches 6 sites", or the sites to add by hand with a way to let Unit7 do it (the person's own login,
// kept in the vault; only a person can give it). Exported for the server page's Uptime Kuma card.
export function Monitors({ m: first, serverId, part }: { m: Monitored; serverId?: string; part?: string }) {
  const [m, setM] = useState(first);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const fresh = new Set(m.added ?? []);
  const give = async () => {
    if (!serverId) return;
    setBusy(true);
    const r = outOf(await runTool('uptime.sync', { serverId, part, username: user.trim(), password: pass }).catch(() => undefined));
    setBusy(false);
    setPass('');
    if (r.ok?.synced) { setM(r.ok); toast('ok', r.ok.note); } else toast('bad', 'Unit7 couldn’t add them', r.ok?.note ?? r.why);
  };
  return (
    <div className="rounded-[16px] border border-line px-3.5 py-3">
      {m.synced ? (
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-ok/12 text-ok"><Activity size={16} /></span>
          <p className="min-w-0 flex-1 text-[14px] font-medium text-ink">{m.note}</p>
        </div>
      ) : <div className="flex items-center gap-2"><p className="min-w-0 flex-1 text-[13px] text-ink-2">{m.note}</p><CopyButton text={m.sites.join('\n')} /></div>}
      <ul className="mt-2 flex flex-wrap gap-1.5">{m.sites.slice(0, 12).map((s) => <li key={s}><Badge tone={fresh.has(s) ? 'ok' : 'neutral'}>{host(s)}{fresh.has(s) && <span className="sr-only"> (new)</span>}</Badge></li>)}{m.sites.length > 12 && <li className="text-[12px] text-muted">and {m.sites.length - 12} more</li>}</ul>
      {!!m.missing?.length && <p className="mt-2 text-[12px] text-warn">Not added: {m.missing.map((x) => `${host(x.url)} (${x.why})`).join(', ')}</p>}
      {!!m.stale?.length && <p className="mt-2 text-[12px] text-muted">{m.staleNote} {m.stale.map(host).join(', ')}</p>}
      {!m.synced && serverId && !asking && <Button className="mt-3" size="sm" variant="soft" icon={<Activity size={14} />} onClick={() => setAsking(true)}>Let Unit7 add them</Button>}
      {!m.synced && serverId && asking && (
        <form className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 animate-rise" onSubmit={(e) => { e.preventDefault(); void give(); }}>
          <p className="w-full text-[12.5px] text-muted">Your Uptime Kuma login, once. It’s kept in your vault, and only you can see it.</p>
          <Input className="min-w-0 flex-1 basis-32" value={user} onChange={(e) => setUser(e.target.value)} placeholder="User" aria-label="Uptime Kuma user" autoComplete="off" autoFocus />
          <Input className="min-w-0 flex-1 basis-32" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Password" aria-label="Uptime Kuma password" autoComplete="off" />
          <Button variant="dark" type="submit" loading={busy} disabled={!user.trim() || !pass}>Add my sites</Button>
        </form>
      )}
    </div>
  );
}

function RemoveModal({ serverId, item: a, open, onClose }: { serverId: string; item: AddonItem; open: boolean; onClose: (gone: boolean) => void }) {
  const [deleteData, setDeleteData] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<{ why: string; approval?: boolean }>();
  const go = async () => {
    setBusy(true);
    const r = outOf(await runTool('addon.remove', { serverId, addon: a.id, deleteData, ...(deleteData && { confirmName: typed.trim() }) }).catch(() => undefined));
    setBusy(false);
    if (r.ok) { toast('ok', `${a.name} is off`, deleteData ? 'Its data went too.' : 'Its data is kept.'); onClose(true); } else setWhy({ why: r.why!, approval: r.approval });
  };
  return (
    <Modal open={open} onClose={() => onClose(false)} title={`Take ${a.name} off`} size="sm">
      <div className="space-y-4">
        <p className="text-[13.5px] text-ink-2">It stops and its address stops answering. Its keys leave your vault (you can bring them back for 30 days).</p>
        <label className="flex items-center justify-between gap-4 text-[13.5px] text-ink">Delete its data too<Switch checked={deleteData} onChange={setDeleteData} label="Delete its data too" /></label>
        {deleteData && <Field label={`Type ${a.id} to delete its data`}><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>}
        {why && <Note tone={why.approval ? 'info' : 'bad'}>{why.why}</Note>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={() => onClose(false)}>Keep it</Button>
          <HoldButton icon={<Trash2 size={15} />} loading={busy} disabled={deleteData && typed.trim() !== a.id} onConfirm={go}>Take it off</HoldButton>
        </div>
      </div>
    </Modal>
  );
}
