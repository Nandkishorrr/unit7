// Server apps in the Home chat: the apps on a server with Connect right there, a connection that just happened (its
// keys by name, with Undo), the settings an app was wired with, and a disconnect. Names only: never a value.
import { useState } from 'react';
import { ArrowUpRight, HeartPulse, KeyRound, Link2, Plug, Undo2, Unplug } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { rawWords } from '../../lib/words';
import { Badge, Button, Dot } from '../../ui';
import { Fold, Frame, Outcome, Pill, call, said } from '../chat/cards/kit';
import type { ServerApp } from './AppAccess';

type Out = Record<string, any>;
const serverHref = (id?: string) => (id ? `/servers/${id}/apps` : "/servers");
const tone = (h?: { status: string }) => (!h ? 'idle' : h.status === 'ok' ? 'ok' : h.status === 'warn' ? 'warn' : h.status === 'bad' ? 'bad' : 'idle');

function ConnectButton({ serverId, a }: { serverId: string; a: ServerApp }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ReturnType<typeof said> | null>(null);
  if (note) return <Outcome tone={note.tone} step={note.step}>{rawWords(note.text)}</Outcome>;
  return <Button size="sm" variant="primary" loading={busy} icon={<Plug size={13} />} onClick={async () => {
    setBusy(true);
    const r = await call('serverapp.connect', { serverId, part: a.part });
    setBusy(false);
    setNote(r.status === 'ok' && (r.output as Out).needsPaste ? { tone: 'info', text: `${a.name} makes its keys in its own settings: open the server page to add one.` } : said(r, `${a.name} is connected. Its keys are in the vault.`));
  }}>Connect</Button>;
}

function UndoButton({ changeId }: { changeId: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ReturnType<typeof said> | null>(null);
  if (note) return <Outcome tone={note.tone} step={note.step}>{rawWords(note.text)}</Outcome>;
  return <Button size="sm" variant="soft" className="mt-3" loading={busy} icon={<Undo2 size={13} />} onClick={async () => { setBusy(true); const r = await call('change.undo', { changeId }); setBusy(false); setNote(said(r, 'Taken back: what Unit7 made is gone and its keys left the vault.')); }}>Undo</Button>;
}

const KeyNames = ({ keys }: { keys: { name: string; label: string; scope: string; madeByUnit7: boolean }[] }) => (
  <Fold items={keys} className="space-y-1.5">
    {(k) => (
      <li key={k.name} className="flex items-start gap-2.5 rounded-[14px] bg-raised px-3 py-2">
        <KeyRound size={13} className="mt-0.5 shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">{k.label}{k.madeByUnit7 && <Badge tone="info" className="h-5 px-2 text-[11px]">Made by Unit7</Badge>}</span>
          <span className="block text-[12px] text-muted">{rawWords(k.scope)}</span>
        </span>
      </li>
    )}
  </Fold>
);

export function ServerAppCard({ tool, input, output: o }: { tool: string; input: any; output: Out }) {
  const href = serverHref(input?.serverId);
  if (tool === 'serverapp.list') {
    const apps = (o.apps ?? []) as ServerApp[];
    const on = apps.filter((a) => a.access === 'connected').length;
    return (
      <Frame icon={<KeyRound size={16} />} tone="blue" title={`Apps on ${o.server}`} count={apps.length} sub={`${on} connected${o.root ? '' : ' · Unit7 isn’t root there'}`} href={href} hrefLabel="Open the server page">
        <Fold items={apps} className="divide-y divide-line">
          {(a) => (
            <li key={a.part} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
              <BrandLogo id={a.app} size={20} />
              <span className="min-w-0 flex-1 basis-[150px]">
                <span className="flex items-center gap-2 text-[13.5px] font-medium">{a.name}<Dot tone={tone(a.health)} />{!a.production && <Badge tone="lime" className="h-5 px-2 text-[11px]">Test copy</Badge>}</span>
                <span className="block truncate text-[12px] text-muted">{[a.label !== a.name && a.label, a.version && `v${a.version}`].filter(Boolean).join(' · ') || ' '}</span>
              </span>
              {a.access === 'connected' ? <Pill tone="ok">{a.keys} key{a.keys === 1 ? '' : 's'}</Pill>
                : a.access === 'ready' && o.root ? <ConnectButton serverId={o.serverId} a={a} />
                : <Badge>{a.access === 'paste' ? 'Needs a key from you' : 'Not connected'}</Badge>}
              {a.url && <a href={a.url} target="_blank" rel="noopener" aria-label={`Open ${a.name}`} className="grid size-8 place-items-center rounded-full border border-line-strong text-ink-2 transition hover:border-ink/40 hover:text-ink"><ArrowUpRight size={14} /></a>}
            </li>
          )}
        </Fold>
      </Frame>
    );
  }
  if (tool === 'serverapp.connect') {
    if (o.needsPaste) return (
      <Frame icon={<BrandLogo id={o.app} size={18} />} title={`${o.name} needs a key from you`} sub="It makes keys only in its own settings" href={href} hrefLabel="Add it on the server page">
        <ol className="list-decimal space-y-1 pl-5 text-[12.5px] text-ink-2">{(o.steps ?? []).map((s: string) => <li key={s}>{s}</li>)}</ol>
        <p className="mt-2 text-[12px] text-muted">Paste it on the server page, never in a chat: it goes straight to the vault.</p>
      </Frame>
    );
    return (
      <Frame icon={<BrandLogo id={o.app} size={18} />} tone="soft" title={`${o.name} is connected`} sub={o.madeByUnit7?.length ? `Unit7 made: ${o.madeByUnit7.join(', ').toLowerCase()}` : 'Its own keys, kept in the vault'} href={href} hrefLabel="Open the server page"
        right={<Pill tone="ok">In the vault</Pill>}>
        <KeyNames keys={o.keys ?? []} />
        {o.note && <p className="mt-2 text-[12.5px] text-muted">{rawWords(o.note)}</p>}
        {o.changeId && <UndoButton changeId={o.changeId} />}
      </Frame>
    );
  }
  if (tool === 'serverapp.keys') return (
    <Frame icon={<KeyRound size={16} />} title={`Keys for ${o.app ?? 'this app'}`} count={(o.keys ?? []).length} sub={o.wired ? `Wired into ${o.wired} app${o.wired === 1 ? '' : 's'}` : 'Values stay in the vault'} href={href}>
      <KeyNames keys={o.keys ?? []} />
    </Frame>
  );
  if (tool === 'serverapp.wire') return (
    <Frame icon={<Link2 size={16} />} tone="ok" title={`${o.to} has ${o.from}’s settings`} sub="Kept in sync by Unit7" href="/connections" hrefLabel="See connections">
      <ul className="flex flex-wrap gap-1.5">{[...(o.set ?? []), ...(o.unchanged ?? [])].map((k: string) => <li key={k}><Badge>{k}</Badge></li>)}</ul>
      {(o.applied ?? []).map((m: string) => <p key={m} className="mt-2 text-[12.5px] text-ink-2">{rawWords(m)}</p>)}
      {o.note && <p className="mt-2 text-[12.5px] text-muted">{rawWords(o.note)}</p>}
    </Frame>
  );
  if (tool === 'serverapp.disconnect') return (
    <Frame icon={<Unplug size={16} />} title={o.disconnected ? `${o.app} disconnected` : 'Nothing to disconnect'} sub={o.disconnected ? (o.removedInApp ? 'What Unit7 made there is gone' : 'Its keys left the vault') : undefined} href={href}>
      {o.warning && <Outcome tone="bad">{rawWords(o.warning)}</Outcome>}
      {o.note && <p className="text-[12.5px] text-muted">{rawWords(o.note)}</p>}
    </Frame>
  );
  if (tool === 'serverapp.action') return (
    <Frame icon={<HeartPulse size={16} />} tone={o.healthy === false ? 'bad' : 'ok'} title={o.healthy !== undefined ? `${o.app} is ${o.healthy ? 'answering' : 'not answering'}` : o.url ? `Open ${o.app}` : o.kept ? `${o.app} backed up` : `${o.app}`} href={href}
      right={o.url ? <a href={o.url} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3 text-[12.5px] font-medium text-bg">Open<ArrowUpRight size={12} /></a> : undefined}>
      {o.kept && <p className="text-[12.5px] text-ink-2">Kept on the server: <code className="font-mono text-[11.5px]">{o.kept}</code></p>}
      {o.note && <p className="text-[12.5px] text-muted">{rawWords(o.note)}</p>}
    </Frame>
  );
  return null;
}
