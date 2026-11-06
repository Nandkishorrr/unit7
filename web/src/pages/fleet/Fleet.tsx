// The app page's servers. On one server: a quiet line, "Run on more servers", with how ready it is. On several: a tile
// per server (its version, a health ring, its share of visitors, Take out / Put back), an amber note when they don't all
// run the same version, the release lanes, and "Add a server". Every number is what Unit7 recorded (fleet.get).
import { useState } from 'react';
import { ArrowRight, Check, Layers, MoreHorizontal, Plus, Rocket, Server, Shuffle } from 'lucide-react';
import { act, Badge, Button, Card, CardHeader, cx, HoldButton, HoverCard, Illustration, Modal, Skeleton, StatusMark } from '../../ui';
import { Menu } from '../kit';
import { navigate } from '../../lib/router';
import { tidy } from '../../lib/words';
import { ReadinessRing, Row } from '../care/Readiness';
import { useTool } from '../care/data';
import { Lanes } from './Lanes';
import { canaryLive, firstTime, running, useFleet, type Fleet, type FleetReadiness, type FleetServer } from './data';
import { CanaryPanel, StartCanary } from './Canary';
import { BuyServer, CareNotes } from './Care';
import { RegionStrip } from './Regions';

// a word with its one-line meaning on hover
function Term({ children, tip }: { children: string; tip: string }) {
  return <HoverCard content={<p className="max-w-[260px] text-[12.5px] text-ink-2">{tip}</p>}><span tabIndex={0} className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4">{children}</span></HoverCard>;
}

// the first time someone sees these words: one line each, then only the hover cards
function NewWords({ words }: { words: Fleet['words'] }) {
  const [show, setShow] = useState(() => firstTime('fleet'));
  if (!show) return null;
  return (
    <div className="mt-4 rounded-[18px] bg-blue-soft px-4 py-3 text-[12.5px] text-ink-2">
      <p className="mb-1 font-medium text-ink">Three words you’ll see here</p>
      <ul className="space-y-0.5">{[words.rolling, words.rotation, words.front].map((w) => <li key={w}><span className="font-medium text-ink">{w.split(':')[0]}:</span>{w.slice(w.indexOf(':') + 1)}</li>)}</ul>
      <button type="button" onClick={() => setShow(false)} className="mt-1.5 text-[12px] font-medium text-blue-text hover:underline">Got it</button>
    </div>
  );
}

// health as a ring around the server: lime when it answers, red when it doesn't, grey before the first look
function HealthRing({ s }: { s: FleetServer }) {
  const tone = s.state === 'sick' || s.health === 'bad' ? 'var(--bad)' : s.state === 'out' ? 'var(--line-strong)' : s.health === 'ok' ? 'var(--ok)' : 'var(--faint)';
  const word = s.state === 'sick' ? 'Not answering, taken out' : s.health === 'bad' ? 'Not answering' : s.state === 'out' ? 'Out for maintenance' : s.health === 'ok' ? 'Answering' : 'Not checked yet';
  return (
    <span role="img" aria-label={word} title={word} className="relative grid size-11 shrink-0 place-items-center">
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="absolute inset-0">
        <circle cx="22" cy="22" r="19" fill="none" stroke="var(--line)" strokeWidth="3.5" />
        <circle cx="22" cy="22" r="19" fill="none" stroke={tone} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={s.health || s.state !== 'in' ? '120 0' : '6 6'} className="motion-safe:transition-[stroke] motion-safe:duration-500" />
      </svg>
      <Server size={17} className="text-ink-2" aria-hidden />
    </span>
  );
}

function Tile({ s, f, onChange }: { s: FleetServer; f: Fleet; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const behind = f.drift.behind.includes(s.serverId) && !canaryLive(f.canary); // during a canary the versions differ on purpose
  const standby = s.role === 'standby';
  const canOut = !standby && s.state === 'in' && (!s.primary || f.mode === 'dns');
  const go = async (out: boolean) => { setBusy(true); await act('fleet.rotate', { serviceId: f.serviceId, serverId: s.serverId, out }, { success: out ? `${s.name} is out: the others carry on` : `${s.name} is back` }); setBusy(false); onChange(); };
  const where = standby ? (s.state === 'in' ? 'Standby · taking every visitor' : 'Warm standby · no visitors') : s.state === 'out' ? 'Out for maintenance' : s.state === 'sick' ? 'Taken out: not answering' : s.primary && f.mode === 'front' ? 'Main server · takes every visitor first' : s.primary ? 'Main server' : 'In rotation';
  return (
    <li className={cx('flex min-w-0 flex-col gap-3 rounded-[20px] border p-4 transition-colors', s.state === 'in' ? 'border-line bg-surface' : 'border-dashed border-line-strong bg-raised/50')}>
      <div className="flex items-center gap-3">
        <HealthRing s={s} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-ink">{s.name}</p>
          <p className="truncate text-[12px] text-muted">{s.state === 'in' && !s.primary ? <Term tip={f.words.rotation}>{where}</Term> : where}</p>
        </div>
        <Badge tone={behind ? 'warn' : 'neutral'} className="tabular shrink-0">{s.version ? `v${s.version}` : 'nothing yet'}</Badge>
      </div>
      <div>
        <div className="flex items-baseline justify-between text-[12px]"><span className="text-muted">Share of visitors</span><span className="tabular font-semibold text-ink">{s.share}%</span></div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line" role="img" aria-label={`${s.share}% of visitors`}>
          <div className="h-full rounded-full bg-blue motion-safe:transition-[width] motion-safe:duration-700" style={{ width: `${s.share}%` }} />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {canOut && <Button size="sm" variant="soft" loading={busy} onClick={() => go(true)}>Take out</Button>}
        {s.state !== 'in' && !standby && <Button size="sm" variant="secondary" loading={busy} onClick={() => go(false)}>Put back</Button>}
        {!s.primary && !standby && (
          <Menu label={`More for ${s.name}`} className="ml-auto" items={[{ label: `Stop running ${f.name} here`, danger: true, onSelect: () => void act('fleet.remove_server', { serviceId: f.serviceId, serverId: s.serverId }, { success: `${f.name} no longer runs on ${s.name}` }).then(onChange) }]}>
            <MoreHorizontal size={16} />
          </Menu>
        )}
      </div>
    </li>
  );
}

// the checklist and the server picker, in the centred pop-up
function AddServer({ open, onClose, f, onStarted }: { open: boolean; onClose: () => void; f: Fleet; onStarted: () => void }) {
  const r = useTool<FleetReadiness>('fleet.readiness', open ? { serviceId: f.serviceId } : null);
  const [pick, setPick] = useState<string | null>(null);
  const chosen = f.candidates.find((c) => c.serverId === pick) ?? f.candidates[0];
  const start = (skipChecks: boolean) => {
    if (!chosen) return;
    onClose();
    void act('fleet.add_server', { serviceId: f.serviceId, serverId: chosen.serverId, ...(skipChecks && { skipChecks }) }, { success: `${f.name} now runs on ${chosen.name} too` }).then(onStarted);
    setTimeout(onStarted, 1500);
  };
  const ready = r.data?.ready ?? false;
  return (
    <Modal open={open} onClose={onClose} title={`Run ${f.name} on more servers`} size="lg">
      <p className="text-[13.5px] text-ink-2">Visitors are spread across the servers, so one going down doesn’t take {f.name} down. First, what would break with a second server:</p>
      {!r.data ? <Skeleton className="mt-4 h-[180px] rounded-[18px]" /> : (
        <section aria-label="Ready for many servers" className="mt-4 rounded-[20px] border border-line p-4">
          <div className="flex items-center gap-3">
            <ReadinessRing done={r.data.done} total={r.data.total} size={56} />
            <div>
              <h3 className="text-[15px] font-semibold text-ink">Ready for many servers · {r.data.done} of {r.data.total}</h3>
              <p className="text-[12.5px] text-muted">{r.data.ready ? 'Nothing found that breaks with a second server.' : 'Each open item has its fix right here.'}</p>
            </div>
          </div>
          <ul className="mt-2 divide-y divide-line">{r.data.checks.filter((c) => !c.ok).concat(r.data.checks.filter((c) => c.ok)).map((c) => <Row key={c.key} c={c} onDone={() => void r.reload()} />)}</ul>
        </section>
      )}
      <h3 className="mt-5 text-[14px] font-semibold text-ink">Which server</h3>
      {f.candidates.length ? (
        <div role="radiogroup" aria-label="Server" className="mt-2 grid gap-2 sm:grid-cols-2">
          {f.candidates.map((c) => {
            const on = (chosen?.serverId ?? null) === c.serverId;
            return (
              <button key={c.serverId} type="button" role="radio" aria-checked={on} onClick={() => setPick(c.serverId)}
                className={cx('flex items-center gap-3 rounded-[18px] border p-3 text-left transition', on ? 'border-blue bg-blue-soft' : 'border-line hover:border-line-strong')}>
                <Server size={17} className="shrink-0 text-ink-2" aria-hidden />
                <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium text-ink">{c.name}</span><span className="block text-[12px] text-muted">{c.ready ? 'Prepared' : 'Unit7 prepares it first'}</span></span>
                {on && <Check size={16} className="text-blue-text" aria-hidden />}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-4 rounded-[18px] bg-raised p-4">
          <Illustration name="add-server" size={64} />
          <div className="min-w-0 flex-1 text-[13px] text-ink-2">
            <p className="font-medium text-ink">No other server yet</p>
            <p>Connect one on Servers, or buy one below. Buying is your call: you approve the price, Unit7 never buys by itself.</p>
          </div>
          <Button size="sm" variant="soft" icon={<ArrowRight size={13} />} onClick={() => navigate('/servers')}>Servers</Button>
        </div>
      )}
      <h3 className="mt-5 text-[14px] font-semibold text-ink">Or buy one</h3>
      {open && <BuyServer serviceId={f.serviceId} name={f.name} onBought={onStarted} />}
      {f.mode === 'single' && <p className="mt-4 text-[12.5px] text-muted"><Term tip={f.words.front}>A front proxy</Term> on {f.servers[0]?.name ?? 'the main server'} takes every visitor and passes each one to a healthy server, over a private network only your servers can use. Your domain and HTTPS stay as they are.</p>}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {!ready && r.data && chosen && <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">Only a person can do this: the items above may break things on the second server.</p>}><HoldButton size="md" className="border border-line-strong bg-surface text-ink hover:bg-raised" fillClassName="bg-warn/25" onConfirm={() => start(true)}>Add it anyway</HoldButton></HoverCard>}
        <Button variant="primary" icon={<Plus size={15} />} disabled={!chosen || !ready} onClick={() => start(false)}>{chosen ? `Add ${chosen.name}` : 'Add a server'}</Button>
      </div>
    </Modal>
  );
}

export function FleetCard({ serviceId, className }: { serviceId: string; className?: string }) {
  const { data: f, reload } = useFleet(serviceId);
  const [adding, setAdding] = useState(false);
  const [bringing, setBringing] = useState(false);
  if (!f) return <Skeleton className={cx('h-[96px] rounded-[24px]', className)} />;
  if (!f.deployed || ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'].includes(f.kind)) return null;
  const live = running(f.run);
  // a warm standby (src/fleet/dr.ts) doesn't serve visitors: it has its own panel, and doesn't make this "many servers"
  if (f.servers.filter((s) => s.role !== 'standby').length < 2) {
    return (
      <Card className={cx('illo-host p-5 md:p-6', className)}>
        <div className="flex flex-wrap items-center gap-4">
          <Illustration name="servers" size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium tracking-[-0.015em] text-ink">Runs on one server</h2>
            <p className="text-[12.5px] text-muted">On more servers, one going down doesn’t take {f.name} down.</p>
          </div>
          <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">Ready for many servers: {f.readiness.done} of {f.readiness.total}. Open it to see what’s left.</p>}>
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2"><ReadinessRing done={f.readiness.done} total={f.readiness.total} size={26} label={false} /><span className="tabular">{f.readiness.done}/{f.readiness.total} ready</span></span>
          </HoverCard>
          <StartCanary f={f} onStarted={() => void reload()} />
          <Button variant="dark" icon={<Layers size={15} />} onClick={() => setAdding(true)}>Run on more servers</Button>
        </div>
        <CanaryPanel f={f} onChange={() => void reload()} className="mt-4" />
        {live && f.run && <Lanes run={f.run} serviceId={serviceId} className="mt-4" />}
        <AddServer open={adding} onClose={() => setAdding(false)} f={f} onStarted={() => void reload()} />
      </Card>
    );
  }
  const bring = async () => { setBringing(true); await act('fleet.deploy', { serviceId, servers: f.drift.behind }, { success: 'They all run the same version again' }); setBringing(false); void reload(); };
  const actions = (
    <>
      <HoverCard content={<p className="max-w-[240px] text-[12.5px] text-ink-2">{f.words.rolling}</p>}>
        <Button size="sm" variant="soft" icon={<Rocket size={13} />} disabled={live} onClick={() => void act('fleet.deploy', { serviceId }, { success: 'Released on every server' }).then(() => reload())}>Roll out</Button>
      </HoverCard>
      <StartCanary f={f} onStarted={() => void reload()} />
      <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setAdding(true)} disabled={live}>Add a server</Button>
    </>
  );
  return (
    <Card className={cx('p-5 md:p-6', className)}>
      {/* the buttons sit beside the title on wide screens, under it on phones */}
      <CardHeader icon={<Layers size={19} />} title={`On ${f.servers.filter((s) => s.role !== 'standby').length} servers`}
        sub={<>Visitors go through {f.mode === 'dns' ? <Term tip={f.why ?? ''}>DNS, with a health check</Term> : <Term tip={`${f.words.front} ${f.why ?? ''}`}>a front proxy</Term>}</>}
        actions={<div className="hidden gap-1.5 sm:flex">{actions}</div>} />
      <div className="mt-3 flex gap-1.5 sm:hidden">{actions}</div>
      <NewWords words={f.words} />
      <CanaryPanel f={f} onChange={() => void reload()} className="mt-4" />
      {!f.drift.same && !live && !canaryLive(f.canary) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[18px] bg-warn/10 px-4 py-3">
          <StatusMark state="warn" size={18} label="Needs a look" />
          <p className="min-w-0 flex-1 text-[13px] text-ink"><span className="font-medium">Not all on the same version.</span> <span className="text-ink-2">{f.drift.words}.</span></p>
          <Button size="sm" variant="dark" icon={<Shuffle size={13} />} loading={bringing} onClick={bring}>Bring them together</Button>
        </div>
      )}
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {f.servers.map((s) => <Tile key={s.serverId} s={s} f={f} onChange={() => void reload()} />)}
      </ul>
      {f.run && <Lanes run={f.run} serviceId={serviceId} className="mt-4" />}
      <CareNotes serviceId={serviceId} className="mt-4" />
      <RegionStrip serviceId={serviceId} className="mt-4" />
      <AddServer open={adding} onClose={() => setAdding(false)} f={f} onStarted={() => void reload()} />
    </Card>
  );
}
