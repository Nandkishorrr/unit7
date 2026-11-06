// A project from the X-ray, opened in the centred pop-up: what it's made of, its domains, where its code comes from, its
// settings, its logs and its deploys, with Open / Restart / Deploy / Stop. Wide, it reads in two columns: what it is on
// the left, what you can change on the right. Coolify's things change through Coolify (coolify.*), so Coolify stays in charge.
import { useEffect, useState, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Box, CalendarClock, Database, Eye, GitBranch, Globe, HardDrive, Layers, Plus, RefreshCw, RotateCw, Rocket, ScrollText, SquareStop, Undo2 } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { A, Badge, Button, Dot, Input, Modal, cx, stepAction, timeAgo, toast } from '../../ui';
import { GivePermission, RevealRow, useReveal } from './Reveal';
import { Terminal } from '../kit';
import { Sure } from '../chat/cards/kit';
import { OWNER_NAME, canDeploy, canRead, coolifyKind, healthTone, healthWords, money, partLogo, partWhat, size, type Card, type XPart, type Xray } from './shape';
import { ActionOutcome, AiButton, OwnerTile, TrustBadge, call, useCoolify } from './Xray';
import { LifecycleMenu, KeepStar, UsedPulse, type LifecycleItem } from '../lifecycle';
import { AppAccess } from '../serverapps/AppAccess';
import { MoveToClientDialog, moveToClientItem } from '../organize';
import { StagingButton } from '../make/Staging';
import { Monitors, type Monitored } from '../make/AddPage';
import { runTool } from '../../lib/api';
import { CoolifyServers } from '../fleet'; // D6: a Coolify app on more servers, through Coolify

const KIND_ICON = { app: Box, database: Database, service: Layers, volume: HardDrive, job: CalendarClock, domain: Globe } as const;
const errOf = (r: { status: string; error?: { message: string }; why?: string }) => r.error?.message ?? r.why ?? 'Not allowed';

export function ProjectDrawer({ x, card, onClose, section, human, cost, currency, onConnect, sizes, projectHref, life, onLifeChanged }: {
  x: Xray; card: Card | null; onClose: () => void; section?: string; human: boolean; cost?: number; currency?: string; onConnect: () => void; sizes?: Record<string, number>; projectHref?: string;
  life?: LifecycleItem | null; onLifeChanged?: () => void;
}) {
  const t = card ? healthTone(card.health) : 'idle';
  const title = card && (
    <span className="flex min-w-0 items-center gap-3">
      <OwnerTile owner={card.owner} size={42} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2"><span className="truncate">{card.name}</span><Dot tone={t === 'idle' ? 'idle' : t} />{life && <KeepStar k={life.key} label />}</span>
        <span className="block truncate text-[12.5px] font-normal tracking-normal text-muted">{[card.what, `run by ${OWNER_NAME[card.owner] ?? card.owner}`, card.environment, cost != null ? `${money(cost, currency)}/mo` : ''].filter(Boolean).join(' · ')}</span>
      </span>
    </span>
  );
  return (
    <Modal open={!!card} onClose={onClose} size="xl" title={title}>
      {card && <Body key={card.id} x={x} c={card} onClose={onClose} human={human} onConnect={onConnect} sizes={sizes} section={section} projectHref={projectHref} life={life} onLifeChanged={onLifeChanged} />}
    </Modal>
  );
}

function Section({ id, title, icon, right, children }: { id: string; title: string; icon: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section id={`pd-${id}`} aria-labelledby={`pd-${id}-h`} className="min-w-0 scroll-mt-4">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-full bg-raised text-ink-2">{icon}</span>
        <h3 id={`pd-${id}-h`} className="flex-1 text-[14px] font-semibold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

// the one page to hand a new developer or an AI: what runs where, by name, with no secrets in it
function Passport({ serverId, project, name }: { serverId: string; project: string; name: string }) {
  const [text, setText] = useState<string>();
  const open = async () => { const r = await runTool('project.passport', { serverId, project }); if (r.status === 'ok') setText((r.output as { markdown: string }).markdown); else toast('bad', 'Unit7 couldn’t write the passport', r.status === 'error' ? r.error.message : undefined); };
  return (
    <>
      <Button size="sm" variant="secondary" icon={<ScrollText size={13} />} onClick={open}>Passport</Button>
      {text !== undefined && <Modal open onClose={() => setText(undefined)} title={`${name}’s passport`} size="lg">
        <p className="text-[13px] text-muted">One page for a new developer or your AI. It holds no secrets: settings appear by name only.</p>
        <pre className="mt-3 max-h-[440px] overflow-auto whitespace-pre-wrap rounded-[14px] bg-sunken px-3.5 py-3 text-[12.5px] leading-[1.55] text-ink-2">{text}</pre>
        <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => { void navigator.clipboard.writeText(text); toast('ok', 'Copied'); }}>Copy</Button></div>
      </Modal>}
    </>
  );
}

function Body({ x, c, onClose, human, onConnect, sizes, section, projectHref, life, onLifeChanged }: { x: Xray; c: Card; onClose: () => void; human: boolean; onConnect: () => void; sizes?: Record<string, number>; section?: string; projectHref?: string; life?: LifecycleItem | null; onLifeChanged?: () => void }) {
  const cool = useCoolify(x.serverId);
  const [sure, setSure] = useState(false);
  const [moving, setMoving] = useState(false);
  const resources = c.parts.filter((p) => p.coolify && (p.kind === 'app' || p.kind === 'database' || p.kind === 'service'));
  const [pick, setPick] = useState<string | undefined>(c.main?.coolify ? c.main.id : resources[0]?.id);
  const res = resources.find((p) => p.id === pick);
  const connected = !!x.coolify?.connected;
  const deploy = canDeploy(x) && !!c.main?.coolify;
  const t = healthTone(c.health);
  const things = c.parts.filter((p) => p.kind !== 'domain');
  const src = c.parts.find((p) => p.coolify?.repo || p.git) ?? c.main;
  const git = src?.coolify?.repo ? { repo: src.coolify.repo, branch: src.coolify.branch, last: src.coolify.lastDeploy } : undefined;
  const folder = c.parts.find((p) => p.git)?.git;
  const k = 'drawer';
  // a card's "Logs" lands on the logs
  useEffect(() => { if (section) requestAnimationFrame(() => document.getElementById(`pd-${section}`)?.scrollIntoView({ block: 'start' })); }, [section]);
  const right = res && (
    <div className="min-w-0 space-y-7">
      {resources.length > 1 && (connected || c.parts.some((p) => p.envKeys?.length)) && (
        <div role="radiogroup" aria-label="Show settings, logs and deploys of" className="flex flex-wrap gap-1.5">
          {resources.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={pick === p.id} onClick={() => setPick(p.id)}
              className={cx('inline-flex h-8 items-center gap-1.5 rounded-full border pl-1.5 pr-3 text-[12.5px] font-medium transition', pick === p.id ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2 hover:border-ink/40')}>
              <BrandLogo id={partLogo(p)} size={14} />{p.name}
            </button>
          ))}
        </div>
      )}
      <Settings key={`s${res.id}`} x={x} p={res} human={human} connected={connected} onConnect={() => { onClose(); onConnect(); }} />
      {connected ? <Logs key={`l${res.id}`} x={x} p={res} human={human} /> : (
        <Section id="logs" title="Logs" icon={<ScrollText size={14} />}>
          <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">Connect Coolify and its logs show here, with search. <button type="button" onClick={() => { onClose(); onConnect(); }} className="font-medium text-blue-text hover:underline">Connect Coolify</button></p>
        </Section>
      )}
      {connected && coolifyKind(res) === 'application' && <Deploys key={`d${res.id}`} x={x} p={res} human={human} />}
      {connected && coolifyKind(res) === 'application' && res.coolify?.uuid && <CoolifyServers key={`f${res.id}`} serverId={x.serverId} uuid={res.coolify.uuid} human={human} />}
    </div>
  );
  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className={cx('mr-auto flex min-w-0 flex-wrap items-center gap-2 text-[13px]', t === 'bad' ? 'text-bad' : t === 'warn' ? 'text-warn' : 'text-ink-2')}>
            <span className="min-w-0">{healthWords(c.health)}</span><TrustBadge trust={c.trust} owner={c.owner} />
            {life && <UsedPulse k={life.key} />}
          </p>
          {/* the actions wrap as one group, so "…" never sits alone on a line */}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {c.domains[0] && <a href={`https://${c.domains[0]}`} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-bg transition hover:opacity-90">Open<ArrowUpRight size={13} /></a>}
            {projectHref && <A href={projectHref} className="inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium transition hover:bg-raised">Manage<ArrowUpRight size={12} /></A>}
            {deploy && <>
              <Button size="sm" variant="secondary" icon={<RotateCw size={13} />} loading={cool.busy === k + 'restart'} disabled={!human || !!cool.busy} onClick={() => void cool.run(k + 'restart', c.main!, 'restart')}>Restart</Button>
              <Button size="sm" variant="secondary" icon={<Rocket size={13} />} loading={cool.busy === k + 'deploy'} disabled={!human || !!cool.busy} onClick={() => void cool.run(k + 'deploy', c.main!, 'deploy')}>Deploy</Button>
              <Button size="sm" variant="ghost" className="text-bad hover:bg-bad/8 hover:text-bad" icon={<SquareStop size={13} />} disabled={!human || !!cool.busy} onClick={() => setSure(true)}>Stop</Button>
              {human && c.main?.coolify?.uuid && <StagingButton size="sm" target={{ serverId: x.serverId, app: c.main.coolify.uuid, name: c.name }} />}
            </>}
            {(t === 'bad' || t === 'warn') && <AiButton strong prompt={`On ${x.serverName}, ${c.name} has a problem: ${healthWords(c.health).toLowerCase()}. Find out why and fix it.`}>Fix it with Unit7</AiButton>}
            {!deploy && c.owner === 'coolify' && !c.system && <Button size="sm" variant="soft" onClick={() => { onClose(); onConnect(); }}>{connected ? 'Needs a token that can deploy' : 'Connect Coolify to manage it'}</Button>}
            {!c.system && <Passport serverId={x.serverId} project={c.id} name={c.name} />}
            {human && life && <LifecycleMenu item={life} items={[moveToClientItem(() => setMoving(true))]} onChanged={onLifeChanged} label={`More for ${c.name}`} className="grid size-8 place-items-center rounded-full border border-line-strong bg-surface text-ink transition hover:bg-raised" />}
          </div>
        </div>
        {life && <MoveToClientDialog item={life} open={moving} onClose={() => setMoving(false)} onMoved={onLifeChanged} />}
        {sure && <Sure text={`${c.name} goes offline until you start it again.`} yes="Stop it" onNo={() => setSure(false)} onYes={() => { setSure(false); void cool.run(k + 'stop', c.main!, 'stop'); }} />}
        {['restart', 'deploy', 'stop'].map((a) => <ActionOutcome key={a} c={cool} k={k + a} />)}
      </div>

      <div className={cx('grid gap-7', right && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-8')}>
        <div className="min-w-0 space-y-7">
          <Section id="parts" title="What’s in it" icon={<Layers size={14} />}>
            <ul className="divide-y divide-line rounded-[18px] border border-line">
              {things.map((p) => <PartRow key={p.id} p={p} size={sizes?.[p.id]} x={x} />)}
            </ul>
          </Section>
          <AppAccess serverId={x.serverId} parts={c.parts.map((p) => p.id)} human={human} />
          {human && c.parts.filter((p) => p.product?.id === 'uptimekuma').map((p) => <KumaLogin key={p.id} serverId={x.serverId} part={p.id} />)}

          {c.domains.length > 0 && (
            <Section id="domains" title="Domains" icon={<Globe size={14} />}>
              <ul className="flex flex-wrap gap-1.5">
                {c.parts.filter((p) => p.kind === 'domain').map((d) => (
                  <li key={d.id} className="max-w-full"><a href={`https://${d.name}`} target="_blank" rel="noopener" title={d.via} className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] font-medium transition hover:bg-raised"><Globe size={12} className="shrink-0 text-muted" /><span className="truncate">{d.name}</span><ArrowUpRight size={12} className="shrink-0 text-faint" /></a></li>
                ))}
              </ul>
            </Section>
          )}

          {(git || folder) && (
            <Section id="source" title="Where the code comes from" icon={<GitBranch size={14} />}>
              <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 rounded-[18px] bg-raised px-4 py-3 text-[13px]">
                {git && <><dt className="text-muted">Repository</dt><dd className="flex min-w-0 items-center gap-1.5"><BrandLogo id={/gitlab/.test(git.repo) ? 'gitlab' : 'github'} size={14} /><span className="truncate font-medium">{git.repo}</span></dd></>}
                {git?.branch && <><dt className="text-muted">Branch</dt><dd className="font-mono text-[12.5px]">{git.branch}</dd></>}
                {git?.last && <><dt className="text-muted">Last deploy</dt><dd>{git.last.at ? timeAgo(git.last.at) : '–'}{git.last.status && <span className="text-muted"> · {git.last.status.replace(/_/g, ' ')}</span>}{git.last.commit && <span className="font-mono text-[12px] text-muted"> · {git.last.commit.slice(0, 7)}</span>}</dd></>}
                {folder && <><dt className="text-muted">Folder</dt><dd className="min-w-0 truncate font-mono text-[12.5px]">{folder.dir}</dd>
                  {folder.remote && <><dt className="text-muted">From</dt><dd className="min-w-0 truncate">{folder.remote}</dd></>}
                  {folder.last && <><dt className="text-muted">Last change</dt><dd>{folder.last}{folder.dirty ? <span className="text-warn"> · {folder.dirty} unsaved change{folder.dirty === 1 ? '' : 's'}</span> : null}</dd></>}</>}
              </dl>
            </Section>
          )}
        </div>
        {right}
      </div>
    </div>
  );
}

// an Uptime Kuma Unit7 only found: the sites it would watch, and the login once (a person), so Unit7 can add them
function KumaLogin({ serverId, part }: { serverId: string; part: string }) {
  const [m, setM] = useState<Monitored | null>(null);
  useEffect(() => {
    void runTool('uptime.sync', { serverId, part }, { dryRun: true }).catch(() => undefined).then((r) => {
      const plan = r?.status === 'dry_run' ? (r.plan as { found: boolean; hasLogin: boolean; sites: string[] }) : undefined;
      if (plan?.found && !plan.hasLogin && plan.sites.length) setM({ sites: plan.sites, needsLogin: true, note: `Uptime Kuma can watch the ${plan.sites.length} site${plan.sites.length === 1 ? '' : 's'} Unit7 knows.` });
    });
  }, [serverId, part]);
  return m && <Section id={`uptime-${part}`} title="Checks that your sites are up" icon={<Activity size={14} />}><Monitors m={m} serverId={serverId} part={part} /></Section>;
}

function PartRow({ p, size: bytes, x }: { p: XPart; size?: number; x: Xray }) {
  const Icon = KIND_ICON[p.kind] ?? Box;
  const t = healthTone(p.health);
  const facts = [
    partWhat(p), p.internals?.length ? `${p.internals.length} containers, shown as one` : undefined, p.when, p.state && p.state !== 'running' ? p.state : undefined,
    p.restarts ? `restarted ${p.restarts}×` : undefined, bytes ? size(bytes) : undefined,
  ].filter(Boolean).join(' · ');
  const uses = (p.uses ?? []).map((id) => x.parts.find((q) => q.id === id)?.name).filter(Boolean);
  return (
    <li className="flex items-start gap-3 px-3.5 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised">{p.kind === 'volume' || p.kind === 'job' ? <Icon size={15} className="text-muted" /> : <BrandLogo id={partLogo(p)} size={18} />}</span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-[13.5px] font-medium"><span className="truncate">{p.name}</span>{p.kind !== 'volume' && p.kind !== 'job' && <Dot tone={t === 'idle' ? 'idle' : t} />}</p>
        <p className="truncate text-[12px] text-muted" title={facts}>{facts}</p>
        {p.health && p.health.status !== 'ok' && p.health.reason && <p className={cx('mt-0.5 text-[12px]', t === 'bad' ? 'text-bad' : 'text-warn')}>{healthWords(p.health)}</p>}
        {p.exposed && <p className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-bad/8 px-2 py-0.5 text-[11.5px] font-medium text-bad">Open to the internet</p>}
        {uses.length > 0 && <p className="mt-0.5 text-[12px] text-ink-2">Talks to {uses.join(', ')}</p>}
        {p.kind === 'job' && p.command && <code className="mt-1 block truncate font-mono text-[11.5px] text-ink-2" title={p.command}>{p.command}</code>}
      </div>
    </li>
  );
}

// --- settings: names always; a value only when a person asks; set one, then redeploy to apply ---
function Settings({ x, p, human, connected, onConnect }: { x: Xray; p: XPart; human: boolean; connected: boolean; onConnect: () => void }) {
  const [list, setList] = useState<{ key: string; preview: boolean }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ key: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const cool = useCoolify(x.serverId);
  const input = { serverId: x.serverId, uuid: p.coolify!.uuid, kind: coolifyKind(p) };
  const load = () => {
    if (!connected) { setList((p.envKeys ?? []).map((key) => ({ key, preview: false }))); return; }
    void call('coolify.envs', { ...input, op: 'list' }).then((r) => (r.status === 'ok' ? setList((r.output as { key: string; preview: boolean }[]).filter((e) => !e.preview)) : (setErr(errOf(r as never)), setList((p.envKeys ?? []).map((key) => ({ key, preview: false }))))));
  };
  useEffect(load, [p.id, connected]);
  // Show: from Coolify when it's connected (with the two ways round it when Coolify leaves the value out), else
  // straight from the running app over the server connection
  const rv = useReveal({ serverId: x.serverId, serverName: x.serverName, uuid: p.coolify!.uuid, kind: coolifyKind(p) }, connected);
  const save = async () => {
    if (!adding) return;
    setBusy(true);
    const r = await call('coolify.envs', { ...input, op: 'set', key: adding.key.trim(), value: adding.value });
    setBusy(false);
    if (r.status !== 'ok') { toast('bad', 'Couldn’t save that setting', errOf(r as never), { action: stepAction(r, { input, retry: save }) }); return; }
    setAdding(null); setChanged(true); load();
  };
  return (
    <Section id="settings" title="Settings" icon={<Eye size={14} />}
      right={connected && human && !adding && <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setAdding({ key: '', value: '' })}>Add or change</Button>}>
      {!list ? <div className="skeleton h-20 rounded-[16px]" /> : !list.length ? <p className="text-[13px] text-muted">No settings.</p> : (
        <ul className="divide-y divide-line rounded-[18px] border border-line">
          {list.map((e) => <RevealRow key={e.key} k={e.key} r={rv} human={human} canShow={connected || /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key)} />)}
        </ul>
      )}
      {err && <p className="mt-2 text-[12px] text-muted">{err}</p>}
      {!connected && <p className="mt-2 text-[12.5px] text-muted">Names from the server{human ? '; Show reads a value from the running app' : ''}. <button type="button" onClick={onConnect} className="font-medium text-blue-text hover:underline">Connect Coolify</button> to change them.</p>}
      {adding && (
        <form className="mt-2 grid gap-2 rounded-[18px] bg-raised p-3 sm:grid-cols-[1fr_1.4fr_auto]" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label><span className="sr-only">Name</span><Input autoFocus required pattern="[A-Za-z_][A-Za-z0-9_.\-]*" value={adding.key} onChange={(e) => setAdding({ ...adding, key: e.target.value })} placeholder="NAME" className="h-9 font-mono text-[12.5px]" /></label>
          <label><span className="sr-only">Value</span><Input required type="password" autoComplete="off" value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} placeholder="value" className="h-9 font-mono text-[12.5px]" /></label>
          <div className="flex gap-1.5"><Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button><Button type="submit" size="sm" variant="primary" loading={busy}>Save</Button></div>
        </form>
      )}
      {changed && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[16px] bg-blue-soft px-3 py-2 text-[12.5px] text-blue-text">
          <span className="flex-1">Saved. Coolify uses it from the next deploy.</span>
          {canDeploy(x) && <Button size="sm" variant="primary" icon={<Rocket size={13} />} loading={cool.busy === 'apply'} onClick={() => void cool.run('apply', p, 'deploy').then(() => setChanged(false))}>Redeploy to apply</Button>}
        </div>
      )}
      <ActionOutcome c={cool} k="apply" />
    </Section>
  );
}

// --- logs, in the dark panel, with search ---
function Logs({ x, p, human }: { x: Xray; p: XPart; human: boolean }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perm, setPerm] = useState(false);
  const [q, setQ] = useState('');
  const load = () => {
    setLines(null); setErr(null); setPerm(false);
    void call('coolify.logs', { serverId: x.serverId, uuid: p.coolify!.uuid, kind: coolifyKind(p), lines: 300 }).then((r) => (r.status === 'ok' ? setLines((r.output as { lines: string[] }).lines) : (setErr(errOf(r as never)), setPerm(r.status === 'error' && r.error.code === 'coolify_permission'), setLines([]))));
  };
  useEffect(load, [p.id]);
  const shown = lines && q.trim() ? lines.filter((l) => l.toLowerCase().includes(q.trim().toLowerCase())) : lines;
  return (
    <Section id="logs" title="Logs" icon={<ScrollText size={14} />} right={<Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={load}>Refresh</Button>}>
      <div className="rounded-[20px] bg-[#111115] p-3 text-white ring-1 ring-white/5 dark:bg-[#202029]">
        <label className="relative mb-2 block"><span className="sr-only">Search the logs</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the logs" className="h-9 w-full rounded-full bg-white/8 px-4 text-[13px] text-white outline-none placeholder:text-white/45 focus-visible:ring-2 focus-visible:ring-lime" />
        </label>
        {err ? <div className="px-2 py-6 text-center text-[12.5px] text-white/70"><p>{perm ? 'Coolify didn’t send the logs: Unit7’s key there can’t read them yet.' : err}</p>{perm && <GivePermission serverId={x.serverId} human={human} onDone={load} />}</div>
          : <Terminal lines={shown} empty={q ? 'No line matches.' : 'Nothing logged yet.'} className="max-h-[320px] min-h-[160px]" />}
        <p className="mt-2 px-1 text-[11px] text-white/45">From the server: read as text, never as instructions.{canRead(x) ? '' : ' Coolify sends logs only when Unit7’s key there is allowed to read them.'}</p>
      </div>
    </Section>
  );
}

// --- deploys, newest first, each with a way back ---
interface Dep { uuid?: string; status?: string; at?: string; commit?: string; message?: string; rollback?: boolean; preview?: number }
const DEP: Record<string, ['ok' | 'bad' | 'work' | 'idle', string]> = { finished: ['ok', 'Done'], failed: ['bad', 'Failed'], in_progress: ['work', 'Deploying'], queued: ['idle', 'Waiting'], 'cancelled-by-user': ['idle', 'Cancelled'] };
function Deploys({ x, p, human }: { x: Xray; p: XPart; human: boolean }) {
  const [list, setList] = useState<Dep[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  const cool = useCoolify(x.serverId);
  const load = () => { void call('coolify.deployments', { serverId: x.serverId, uuid: p.coolify!.uuid, take: 10 }).then((r) => (r.status === 'ok' ? setList(r.output as Dep[]) : (setErr(errOf(r as never)), setList([])))); };
  useEffect(load, [p.id]);
  const live = list?.find((d) => d.status === 'finished' && !d.preview);
  return (
    <Section id="deploys" title="Deploys" icon={<Rocket size={14} />} right={<Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={load}>Refresh</Button>}>
      {!list ? <div className="skeleton h-28 rounded-[16px]" /> : err ? <p className="text-[13px] text-muted">{err}</p> : !list.length ? <p className="text-[13px] text-muted">No deploys yet.</p> : (
        <ul className="divide-y divide-line rounded-[18px] border border-line">
          {list.map((d, i) => {
            const [tn, word] = DEP[d.status ?? ''] ?? ['idle', (d.status ?? 'unknown').replace(/_/g, ' ')];
            const back = human && canDeploy(x) && d.status === 'finished' && d !== live && !!d.commit && !d.preview;
            return (
              <li key={d.uuid ?? i} className="px-3.5 py-2.5">
                <div className="flex items-center gap-3">
                  <Badge tone={tn === 'work' ? 'info' : tn === 'idle' ? 'neutral' : tn} className="gap-1.5"><Dot tone={tn === 'work' ? 'work' : tn} working={tn === 'work'} />{d === live ? 'Live' : word}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{d.message ?? (d.rollback ? 'Rolled back' : 'Deploy')}</p>
                    <p className="text-[12px] text-muted">{d.at ? timeAgo(d.at) : '–'}{d.commit && <span className="font-mono"> · {d.commit.slice(0, 7)}</span>}{d.preview ? ` · preview #${d.preview}` : ''}</p>
                  </div>
                  {back && <Button size="sm" variant="secondary" icon={<Undo2 size={13} />} disabled={!!cool.busy} loading={cool.busy === `rb${d.uuid}`} onClick={() => setSure(d.uuid ?? null)}>Roll back</Button>}
                </div>
                {sure === d.uuid && <Sure text={`Visitors get the version from ${d.at ? timeAgo(d.at) : 'then'} again. You can deploy the latest one any time.`} yes="Roll back" onNo={() => setSure(null)} onYes={() => { setSure(null); void cool.run(`rb${d.uuid}`, p, 'rollback', { to: d.commit }).then(load); }} />}
                <ActionOutcome c={cool} k={`rb${d.uuid}`} />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
