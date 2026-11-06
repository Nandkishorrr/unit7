// The inside view of one thing, in the centred pop-up (a sheet on a phone): how it connects, drawn left to right;
// what needs fixing, with the fix one click away; what it's linked to.
import { useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpRight, ChevronRight, Eye, EyeOff, Globe, Inbox, Link2, Plus, Rocket, Sparkles } from 'lucide-react';
import { navigate } from '../../lib/router';
import { A, act, Badge, Button, Dot, Modal, cx } from '../../ui';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { isUnused, issueKind, issueLabel, liveOf, logoOf, pointInput, pointable, targetsOf, type Asset, type Derived, type Edge, type Issue } from './data';
import { AccountLine, AddSub, DomainFacts, IssueBadge, KIND_NAME, LogoTile, SubRow, domainActions, stopServing, useMap, type MapCtx } from './parts';
import { TrustBadge } from '../servers/Xray';
import { OWNER_NAME, healthWords, ownerLogo, type Health, type Trust } from '../servers/shape';
import { tidy } from '../../lib/words';
import { AskButton } from '../Help';
import { LifecycleMenu, KeepStar, UsedPulse } from '../lifecycle';
import { CloudAppActions } from '../clouds';
import { openDomainLaunch } from '../flow/DomainLaunch';
import { MoveToClientDialog, moveToClientItem } from '../organize';
import { Fold, Resolve } from '../alerts/Resolve';
import { alertActions, type AlertFix } from '../../lib/alertActions';
import { BackBadge, SnoozeMenu, bringBack } from '../explain';

export function Inside({ id, onClose }: { id: string | null; onClose: () => void }) {
  const ctx = useMap();
  const a = id ? ctx.v.byId.get(id) : undefined;
  const g = a?.kind === 'domain' ? ctx.v.groupOf.get(a.id) : undefined;
  const title = a && (
    <span className="flex min-w-0 items-center gap-3.5">
      <LogoTile a={a} size={44} />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-muted">{KIND_NAME[a.kind]}{g && g.asset?.id !== a.id ? <> in <button type="button" disabled={!g.asset} onClick={() => g.asset && ctx.open(g.asset.id)} className="font-medium text-ink-2 enabled:hover:underline">{g.root}</button></> : null}</span>
        <span className="block break-words text-[21px] font-semibold leading-tight tracking-[-0.03em]">{ctx.label(a)}</span>
      </span>
    </span>
  );
  return <Modal open={!!a} onClose={onClose} title={title} size="lg">{a && <Body key={a.id} a={a} onClose={onClose} />}</Modal>;
}

const linkText = (e: Edge) => (e.kind === 'runs_on' ? 'runs on' : e.kind === 'env' ? 'uses' : e.via.replace(/ \(public DNS\)$/, '').replace(/\bForge\b/g, 'Unit7'));

// the path people (and apps) take to reach it, then where it runs and what it uses
function chainOf(v: Derived, a: Asset) {
  const src = (e: Edge) => v.byId.get(e.source)!, dst = (e: Edge) => v.byId.get(e.target)!;
  const inc = (x: Asset) => [...v.inc(x.id, 'domain'), ...v.inc(x.id, 'dns')].sort((p, q) => src(p).name.length - src(q).name.length)[0] ?? (x.kind === 'database' ? v.inc(x.id, 'env')[0] : undefined);
  const out = (x: Asset) => (x.kind === 'domain' ? targetsOf(v, x)[0]?.edge : x.kind === 'app' ? v.out(x.id, 'runs_on')[0] ?? v.out(x.id, 'env').find((e) => dst(e).kind === 'database') : undefined);
  const nodes = [a], links: Edge[] = [];
  for (let e: Edge | undefined = inc(a); e && nodes.length < 3 && !nodes.includes(src(e)); e = src(e).kind === 'domain' ? undefined : inc(src(e))) { nodes.unshift(src(e)); links.unshift(e); }
  for (let e: Edge | undefined = out(a); e && nodes.length < 5 && !nodes.includes(dst(e)); e = out(dst(e))) { nodes.push(dst(e)); links.push(e); }
  return { nodes, links };
}

function Step({ logo, icon, title, sub, mono, onClick, here, dashed }: { logo?: string; icon?: ReactNode; title: string; sub: string; mono?: boolean; onClick?: () => void; here?: boolean; dashed?: boolean }) {
  const body = (
    <>
      <span className="grid size-9 place-items-center rounded-full bg-raised">{icon ?? <BrandLogo id={logo!} size={18} />}</span>
      <span className="mt-1.5 line-clamp-2 max-w-full text-[12.5px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">{title}</span>
      <span className={cx('max-w-full truncate text-muted', mono ? 'font-mono text-[10.5px]' : 'text-[11px]')} title={sub}>{sub}</span>
    </>
  );
  const cls = cx('flex min-w-[100px] max-w-[156px] flex-1 flex-col items-center rounded-[18px] border px-1.5 py-3 text-center', here ? 'border-ink/25 bg-surface shadow-soft' : dashed ? 'border-dashed border-line-strong' : 'border-line bg-surface');
  return onClick ? <button type="button" onClick={onClick} title={title} className={cx(cls, 'transition hover:border-ink/30 hover:shadow-lift')}>{body}</button> : <div title={title} className={cls}>{body}</div>;
}
// a short arrow; a word on it only when it says something ("runs on", "uses"). faint: not checked (or a problem on it
// the person hid), so it's neither red nor a green "works"
function Arrow({ label, title, bad, faint }: { label?: string; title?: string; bad?: boolean; faint?: boolean }) {
  const w = label ? 52 : 34;
  return (
    <div title={title ?? label} className="flex shrink-0 flex-col items-center justify-center self-center" style={{ width: w }}>
      {label && <span className={cx('mb-0.5 whitespace-nowrap text-[10.5px]', bad ? 'text-bad' : 'text-muted')}>{label}</span>}
      <svg width={w - 4} height="10" viewBox={`0 0 ${w - 4} 10`} aria-hidden className={bad ? 'text-bad' : faint ? 'text-faint' : 'text-ok'}>
        <path d={`M2 5h${w - 12}`} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray={bad || faint ? '4 4' : undefined} />
        <path d={`M${w - 14} 1.5 ${w - 9} 5l-5 3.5`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Chain({ a }: { a: Asset }) {
  const { v, open, label } = useMap();
  const { nodes, links } = chainOf(v, a);
  const parts: ReactNode[] = [];
  nodes.forEach((n, i) => {
    const kindSub = n.kind === 'domain' ? 'Domain' : n.kind === 'server' && n.also?.length ? `Server · ${n.also.map((x) => providerName(x.provider)).join(', ')}` : KIND_NAME[n.kind];
    parts.push(<Step key={n.id} logo={logoOf(n)} icon={n.kind === 'domain' ? <Globe size={17} className="text-muted" /> : undefined} title={label(n)} sub={kindSub} here={n.id === a.id} onClick={n.id === a.id ? undefined : () => open(n.id)} />);
    const e = links[i];
    if (!e) return;
    // a domain reaches its target through whoever serves its DNS
    // (its DNS record rides on that step: "A 203.0.113.10")
    if (n.kind === 'domain') {
      const rec = e.kind === 'dns' ? linkText(e) : 'DNS';
      parts.push(<Arrow key={`${n.id}-a`} />, <Step key={`${n.id}-dns`} logo={n.dns ?? 'domain'} icon={n.dns ? undefined : <Globe size={17} className="text-faint" />} title={n.dns ? `${providerName(n.dns)}` : 'DNS elsewhere'} sub={rec} mono={e.kind === 'dns'} />,
        <Arrow key={`${n.id}-b`} title={linkText(e)} bad={e.status === 'misconfigured'} faint={e.status === 'unknown'} />);
      return;
    }
    parts.push(<Arrow key={`${n.id}-b`} label={linkText(e)} bad={e.status === 'misconfigured'} faint={e.status === 'unknown'} />);
  });
  // a domain that leads nowhere Unit7 knows
  if (a.kind === 'domain' && !links.some((e) => e.source === a.id)) {
    parts.push(<Arrow key="x" />, <Step key="dns" logo={a.dns ?? 'domain'} icon={a.dns ? undefined : <Globe size={17} className="text-faint" />} title={a.dns ? providerName(a.dns) : 'Elsewhere'} sub="DNS" />,
      <Arrow key="y" />, <Step key="none" dashed icon={<span className="text-[15px] text-faint">?</span>} title="Not linked" sub="nothing Unit7 knows" />);
  }
  const bad = links.find((e) => e.status === 'misconfigured');
  return (
    <section aria-label="How it connects">
      <h3 className="mb-2.5 text-[13px] font-semibold">How it connects</h3>
      <div className="-mx-6 overflow-x-auto px-6 pb-1"><div className="flex min-w-max items-stretch">{parts}</div></div>
      {bad?.detail && <p className="mt-2 text-[12.5px] text-bad">{bad.detail.replace(/^DNS says/, 'DNS actually says')}</p>}
      {nodes.length === 1 && (a.kind === 'app' || a.kind === 'database' || a.kind === 'server') && <p className="mt-2 text-[12.5px] text-muted">Nothing points here, and it doesn’t use anything Unit7 can see.</p>}
    </section>
  );
}

// what can be fixed in one click, in plain words: every fix Unit7 has for this kind of problem. Each runs through the
// approval rules, comes back checked (verified) and offers its undo; "Check again" and "Ask Unit7" come with every one.
const REC = /\b(AAAA|A|CNAME|ALIAS)\s+([^\s,()]+)/;
function fixesFor(i: Issue, a: Asset, ctx: MapCtx): AlertFix[] {
  const k = issueKind(i), host = i.key.slice(k.length + 1).replace(/^domain:/, '').split(':')[0]!;
  if (k === 'email') return [{ tool: 'domain.protect_email', input: { domain: host }, label: 'Protect it', change: 'Adds a DMARC record where the domain’s DNS lives, so nobody can send email as it. Never touches other records.' }];
  // a certificate on a name Unit7 serves itself: its proxy renews it now (elsewhere the host renews its own)
  const served = k === 'tls' ? ctx.managed.get(host) : undefined;
  if (served) return [{ tool: 'domain.renew_https', input: { domainId: served.id }, label: 'Renew it now', change: `Unit7’s proxy renews ${host}’s certificate now, then checks it from outside. Nobody visiting is cut off.` }];
  const out: AlertFix[] = [];
  const dnsKnown = a.kind === 'domain' && !!a.dns; // its DNS is in an account Unit7 can change
  if (k === 'takeover' && dnsKnown) {
    const rec = REC.exec(ctx.v.out(a.id, 'dns')[0]?.via ?? i.text);
    out.push({ tool: 'domain.remove_record', input: { name: host, type: rec?.[1] ?? 'CNAME' }, label: 'Remove the DNS record', typeName: host, change: `Deletes the record that sends ${host} to something that’s gone, so nobody can take it over. Activity’s Undo puts it back.` });
  }
  if (k === 'dns' || k === 'dup') {
    const edges = targetsOf(ctx.v, a);
    const app = edges.find((t) => t.edge.status === 'misconfigured')?.asset ?? edges[0]?.asset;
    if (k === 'dns' && app && pointable(app)) out.push({ tool: 'domain.point', input: pointInput(host, app), label: `Point it at ${ctx.label(app)}`, change: `Sets ${host}’s DNS to reach ${ctx.label(app)}. HTTPS follows by itself.` });
    // an old route on a server still claims the name: find it (read-only), then remove it from there
    for (const t of edges) {
      const srv = t.asset.server ? ctx.v.byId.get(t.asset.server) : undefined;
      const serverId = srv && ctx.serverHref(srv)?.split('/').pop();
      if (serverId?.startsWith('srv_') && !out.some((f) => f.tool === 'server.routes' && f.input.serverId === serverId)) {
        out.push({ tool: 'server.routes', input: { serverId, host }, label: 'Find the old route', look: true, change: `Looks at ${ctx.label(srv!)}’s proxy (read-only) for what still answers ${host}, and offers to remove it.` });
      }
    }
    const rec = REC.exec(edges.find((t) => t.edge.status === 'misconfigured')?.edge.detail ?? i.text);
    if (dnsKnown && rec) out.push({ tool: 'domain.remove_record', input: { name: host, type: rec[1], value: rec[2] }, label: 'Remove the DNS record', typeName: host, change: `Deletes ${rec[1]} ${host} → ${rec[2]} where the domain’s DNS lives. Activity’s Undo puts it back.` });
  }
  return out;
}
const openFor = (i: Issue) => (issueKind(i) === 'scan' ? { label: 'Reconnect', href: '/connections' } : undefined);

// every problem gets a next step: the sentence Unit7's ask box needs to fix it
function askFor(i: Issue, a: Asset, ctx: MapCtx) {
  const k = issueKind(i), name = ctx.label(a), text = tidy(i.text).replace(/\.$/, '');
  const app = targetsOf(ctx.v, a)[0]?.asset;
  if (k === 'dns' && app) return `${a.name} should open ${ctx.label(app)}, but its DNS points elsewhere. Point it at ${ctx.label(app)} for me, and tell me what changes first.`;
  if (k === 'takeover') return `${a.name} points at something that’s gone, so anyone could take it over. Remove or repoint that record for me.`;
  return `${name}: ${text}. Fix it for me, and tell me what changes first.`;
}

// One issue, the same everywhere on the Map (this pop-up, the List, the Overview): what it is, then one calm row: its
// fix, "Check again", Ask Unit7 when no fix really fixes it, and "This is fine" (hide it for a while, or for good).
// Fixed and checked, or hidden, it folds away. One shown with Hidden on says until when, with Bring back.
export function IssueItem({ i, a, compact }: { i: Issue; a?: Asset; compact?: boolean }) {
  const ctx = useMap();
  const [gone, setGone] = useState(false);
  const done = () => { setGone(true); ctx.reload(); };
  const tone = i.hidden ? 'bg-raised' : i.severity === 'critical' ? 'bg-bad/8' : i.severity === 'warning' ? 'bg-warn/8' : 'bg-raised';
  return (
    <Fold gone={gone}>
      <div className={cx('flex gap-3 rounded-[18px]', compact ? 'p-3' : 'p-4', tone)}>
        {i.hidden ? <EyeOff size={17} className="mt-0.5 shrink-0 text-muted" /> : <AlertTriangle size={17} className={cx('mt-0.5 shrink-0', i.severity === 'critical' ? 'text-bad' : i.severity === 'warning' ? 'text-warn' : 'text-muted')} />}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-medium">{issueLabel(i)}<BackBadge back={i.back} />
            {i.hidden && <span className="text-[12px] font-normal text-muted">{i.until ? `Hidden until ${new Date(i.until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : 'You said it’s fine'}</span>}</p>
          <p className="mt-0.5 text-[13px] text-ink-2">{tidy(i.text)}</p>
          {ctx.human && (i.hidden
            ? <Button className="mt-3" size="sm" variant="ghost" icon={<Eye size={13} />} onClick={() => void bringBack(i.key).then(ctx.reload)}>Bring back</Button>
            : <Resolve className="mt-3" k={i.key} about={i.about} onResolved={done}
                actions={alertActions({ text: i.text, fix: a ? fixesFor(i, a, ctx) : [], ask: a ? askFor(i, a, ctx) : undefined, open: openFor(i) })}
                extra={<SnoozeMenu id={i.key} title={i.text} kind="alert" severity={i.severity} small onDone={done} />} />)}
        </div>
      </div>
    </Fold>
  );
}

function Issues({ a }: { a: Asset }) {
  const ctx = useMap();
  const issues = ctx.v.issuesOf(a.id);
  const sugg = ctx.v.suggestions.filter((s) => s.fromName === a.name || s.toName === a.name);
  if (!issues.length && !sugg.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold">{issues.length ? 'Needs attention' : 'Suggested'}</h3>
      {issues.map((i) => <IssueItem key={i.key} i={i} a={a} />)}
      {sugg.map((s) => (
        <div key={s.fromName + s.toName} className="flex gap-3 rounded-[18px] bg-blue-soft p-4">
          <Link2 size={17} className="mt-0.5 shrink-0 text-blue-text" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium">Connect {s.fromName} to {s.toName}</p>
            <p className="mt-0.5 text-[13px] text-ink-2">{s.why}</p>
            {ctx.human && <Button className="mt-3" size="sm" variant="primary" onClick={() => void act('link.create', { from: s.from, to: s.to }, { success: `${s.fromName} → ${s.toName} connected` }).then((r) => r && ctx.reload())}>Connect them</Button>}
          </div>
        </div>
      ))}
    </section>
  );
}

function Related({ a }: { a: Asset }) {
  const { v, open, label } = useMap();
  const uniq = (l: { e: Edge; x: Asset }[]) => l.filter((r, i) => l.findIndex((y) => y.x.id === r.x.id) === i);
  const groups: [string, { e: Edge; x: Asset }[]][] = ([
    ['Reached at', [...v.inc(a.id, 'domain'), ...v.inc(a.id, 'dns')].map((e) => ({ e, x: v.byId.get(e.source)! }))],
    ['Points to', a.kind === 'domain' ? targetsOf(v, a).map((t) => ({ e: t.edge, x: t.asset })) : []],
    ['Runs on', v.out(a.id, 'runs_on').map((e) => ({ e, x: v.byId.get(e.target)! }))],
    ['Runs here', v.inc(a.id, 'runs_on').map((e) => ({ e, x: v.byId.get(e.source)! }))],
    ['Uses', v.out(a.id, 'env').map((e) => ({ e, x: v.byId.get(e.target)! }))],
    ['Used by', v.inc(a.id, 'env').map((e) => ({ e, x: v.byId.get(e.source)! }))],
  ] as [string, { e: Edge; x: Asset }[]][]).map(([t, l]) => [t, uniq(l)] as [string, { e: Edge; x: Asset }[]]).filter(([, l]) => l.length);
  if (!groups.length) return null;
  return (
    <section className="space-y-4">
      {groups.map(([title, list]) => (
        <div key={title}>
          <h3 className="mb-1.5 text-[13px] font-semibold">{title} <span className="font-normal text-muted">{list.length}</span></h3>
          <ul className="divide-y divide-line rounded-[18px] border border-line">
            {list.map(({ e, x }) => {
              const live = liveOf(x);
              return (
                <li key={x.id}>
                  <button type="button" onClick={() => open(x.id)} className="flex min-h-12 w-full items-center gap-3 px-3.5 py-2 text-left transition first:rounded-t-[18px] last:rounded-b-[18px] hover:bg-raised">
                    <LogoTile a={x} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{label(x)}</span>
                      <span className={cx('block truncate text-muted', e.kind === 'runs_on' ? 'text-[12px]' : 'font-mono text-[11px]')}>{e.kind === 'env' ? e.via : e.kind === 'runs_on' ? x.url?.replace(/^https?:\/\//, '') ?? KIND_NAME[x.kind] : linkText(e)}</span>
                    </span>
                    {e.status === 'misconfigured' ? <Badge tone="bad">Points elsewhere</Badge> : live ? <Dot tone={live.tone} /> : null}
                    <ChevronRight size={15} className="shrink-0 text-faint" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Facts({ a }: { a: Asset }) {
  const ctx = useMap();
  const acc = ctx.v.accounts.find((x) => (a.provider === 'unit7' ? x.provider === 'unit7' : x.name === a.account));
  const svc = ctx.service(a);
  const rows: [string, ReactNode][] = [];
  if (a.account || a.provider === 'unit7') rows.push(['Account', <span className="flex flex-wrap items-center gap-2"><AccountLine a={a} />{acc && <A href={`/map/account/${encodeURIComponent(acc.id)}`} className="text-[12.5px] font-medium text-blue-text hover:underline">See everything there</A>}</span>]);
  for (const x of a.also ?? []) rows.push(['Also in', <span className="inline-flex items-center gap-1.5 text-[13px]"><BrandLogo id={x.provider} size={14} />{providerName(x.provider)}{x.account && x.account !== providerName(x.provider) ? ` · ${x.account}` : ''} <span className="text-muted">as {x.name}</span></span>]);
  if (svc) rows.push(['Project', <span className="text-[13px]">{svc.project} <span className="text-muted">· {svc.env}</span></span>]);
  if (a.platform && !['unit7', 'vps', a.provider].includes(a.platform)) rows.push(['Hosted on', <span className="inline-flex items-center gap-1.5 text-[13px]"><BrandLogo id={a.platform} size={14} />{providerName(a.platform)}</span>]);
  if (a.ips?.length) rows.push(['Address', <code className="font-mono text-[12.5px]">{a.ips.join(', ')}</code>]);
  if (a.kind === 'domain') rows.push(['DNS', a.dns ? <span className="inline-flex items-center gap-1.5 text-[13px]"><BrandLogo id={a.dns} size={14} />{providerName(a.dns)}</span> : <span className="text-[13px] text-muted">Somewhere Unit7 can’t see. Connect that account to manage it here.</span>]);
  if (a.registrar) rows.push(['Registered', <span className="inline-flex items-center gap-1.5 text-[13px]"><BrandLogo id={a.registrar} size={14} />{providerName(a.registrar)}{a.expires && <span className="text-muted">until {new Date(a.expires).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>}</span>]);
  if (a.site) rows.push(['Site check', <span className="text-[13px]">{liveOf(a)?.text} <span className="text-muted">· {a.site.host}, checked from outside every 5 minutes</span></span>]);
  if (a.errors) rows.push(['Errors today', <span className="text-[13px]"><b className="font-semibold text-bad">{a.errors.hits}</b> <span className="text-muted">({a.errors.kinds} kind{a.errors.kinds === 1 ? '' : 's'})</span><code className="mt-1 block break-words rounded-[10px] bg-raised px-2.5 py-1.5 font-mono text-[11.5px] text-ink-2">{a.errors.top}</code>
    {/* its way forward, like any problem: Unit7 finds the cause, or "This is fine" (Home's task for them hides with it) */}
    {ctx.human && (a.errors.hidden
      ? <Button className="mt-2" size="sm" variant="ghost" icon={<Eye size={13} />} onClick={() => void bringBack(`remote:${a.id}`).then(ctx.reload)}>Bring back</Button>
      : <span className="mt-2 flex flex-wrap items-center gap-2"><AskButton prompt={`Fix the errors on ${ctx.label(a)}: ${a.errors.hits} today. Find the cause in its logs and fix it, if it’s safe.`} />
          <SnoozeMenu id={`remote:${a.id}`} title={`Errors on ${ctx.label(a)}`} kind="task" small onDone={ctx.reload} /></span>)}</span>]);
  if (a.settings) rows.push(['Settings', <span className="text-[13px]">{a.settings} saved</span>]);
  // found inside a server by its X-ray
  if (a.owner) {
    const srv = a.server ? ctx.v.byId.get(a.server) : undefined;
    rows.push(['Run by', <span className="inline-flex items-center gap-1.5 text-[13px]">{ownerLogo(a.owner) && <BrandLogo id={ownerLogo(a.owner)!} size={14} />}{OWNER_NAME[a.owner] ?? a.owner}</span>]);
    if (a.trust) rows.push(['Unit7', <TrustBadge trust={a.trust as Trust} owner={a.owner} />]);
    if (a.health && a.kind !== 'volume' && a.kind !== 'job') rows.push(['Health', <span className="text-[13px]">{healthWords(a.health as Health)}</span>]);
    if (a.product || a.engine) rows.push(['Is', <span className="inline-flex items-center gap-1.5 text-[13px]"><BrandLogo id={logoOf(a)} size={14} />{a.product?.name ?? a.engine}{a.version ? ` ${a.version}` : ''}</span>]);
    if (a.exposed) rows.push(['Internet', <span className="text-[13px] font-medium text-bad">Open to the internet: Docker’s published port skips the firewall</span>]);
    if (a.environment) rows.push(['Environment', <span className="text-[13px]">{a.environment}</span>]);
    if (srv) rows.push(['On', <span className="flex flex-wrap items-center gap-2 text-[13px]"><button type="button" onClick={() => ctx.open(srv.id)} className="font-medium hover:underline">{srv.name}</button>{ctx.serverHref(srv) && <A href={ctx.serverHref(srv)!} className="text-[12.5px] font-medium text-blue-text hover:underline">Open the server page</A>}</span>]);
  }
  if (a.region) rows.push(['Region', <span className="text-[13px]">{a.region}</span>]);
  if (a.status && !liveOf(a)) rows.push(['State', <span className="text-[13px]">{a.status.toLowerCase().replace(/_/g, ' ')}</span>]);
  return (
    <section>
      <h3 className="mb-1.5 text-[13px] font-semibold">Details</h3>
      <dl className="divide-y divide-line rounded-[18px] border border-line">
        {rows.map(([k, val]) => <div key={k} className="flex gap-4 px-3.5 py-2.5"><dt className="w-[92px] shrink-0 pt-px text-[12.5px] text-muted">{k}</dt><dd className="min-w-0 flex-1">{val}</dd></div>)}
      </dl>
    </section>
  );
}

// a project found inside a server: its apps, databases, services, data and jobs
function Parts({ a }: { a: Asset }) {
  const { v, open } = useMap();
  const parts = (a.parts ?? []).map((id) => v.byId.get(id)).filter(Boolean) as Asset[];
  if (!parts.length) return null;
  return (
    <section>
      <h3 className="mb-1.5 text-[13px] font-semibold">What’s in it <span className="font-normal text-muted">{parts.length}</span></h3>
      <ul className="divide-y divide-line rounded-[18px] border border-line">
        {parts.map((x) => {
          const live = liveOf(x);
          return (
            <li key={x.id}>
              <button type="button" onClick={() => open(x.id)} className="flex min-h-12 w-full items-center gap-3 px-3.5 py-2 text-left transition first:rounded-t-[18px] last:rounded-b-[18px] hover:bg-raised">
                <LogoTile a={x} size={30} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium">{x.name}</span><span className="block truncate text-[12px] text-muted">{x.product?.name ?? KIND_NAME[x.kind]}</span></span>
                {live && <Dot tone={live.tone} />}
                <ChevronRight size={15} className="shrink-0 text-faint" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// a full hostname straight at this app
function AddDomain({ a, onDone }: { a: Asset; onDone: () => void }) {
  const { reload, label } = useMap();
  const [host, setHost] = useState('');
  const ok = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host.trim().toLowerCase());
  const [busy, setBusy] = useState(false);
  return (
    <form className="flex flex-wrap gap-2 rounded-[18px] bg-raised p-3" onSubmit={async (e) => {
      e.preventDefault(); if (!ok) return;
      setBusy(true);
      const r = await act('domain.point', pointInput(host.trim().toLowerCase(), a), { success: `${host.trim()} now points at ${label(a)}` });
      setBusy(false);
      if (r) { reload(); onDone(); }
    }}>
      <label className="min-w-[200px] flex-1"><span className="sr-only">Domain</span>
        <input autoFocus value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.yourdomain.com" className="h-9 w-full rounded-full border border-line-strong bg-surface px-3.5 text-[13.5px] outline-none focus:border-blue focus:ring-4 focus:ring-blue-soft focus-visible:outline-none" /></label>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      <Button type="submit" size="sm" variant="primary" disabled={!ok} loading={busy}>Point it here</Button>
    </form>
  );
}

function Body({ a, onClose }: { a: Asset; onClose: () => void }) {
  const ctx = useMap();
  const { v } = ctx;
  const g = a.kind === 'domain' ? v.groupOf.get(a.id) : undefined;
  const isRoot = !!g && g.asset?.id === a.id;
  const live = liveOf(a);
  const issues = v.issuesOf(a.id);
  const href = a.url ?? (a.kind === 'domain' ? `https://${a.name}` : undefined);
  const manage = ctx.service(a)?.href ?? ctx.serverHref(a);
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(false);
  const menu = g && isRoot ? domainActions(g, ctx).filter((m): m is Exclude<typeof m, false> => !!m) : [];
  const managed = a.kind === 'domain' && !isRoot ? ctx.managed.get(a.name) : undefined;
  const unusedSub = a.kind === 'domain' && !isRoot && g && isUnused(v, a);
  const subs = isRoot && g ? g.subs : [];
  const unused = subs.filter((d) => isUnused(v, d));
  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center gap-2">
        {live && <Badge tone={live.tone} solid={live.tone !== 'warn'}>{live.text}</Badge>}
        {/* a root's email state is in its facts already */}
        <IssueBadge issues={isRoot ? issues.filter((i) => !i.key.startsWith('email:')) : issues} />
        {g && isRoot && <DomainFacts g={g} />}
        {/* marked important, and when it was last used (how Unit7 knows on hover) */}
        <KeepStar k={a.id} label />
        <UsedPulse k={a.id} />
        <span className="ml-auto flex flex-wrap justify-end gap-2">
          {/* an app on a big cloud (Cloud Run, Amplify, App Service…): redeploy, restart, roll back; nothing for the rest */}
          {ctx.human && a.kind === 'app' && <CloudAppActions asset={{ id: a.id, provider: a.provider, name: ctx.label(a) }} onDone={ctx.reload} />}
          {manage && <A href={manage} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3.5 text-[13px] font-medium hover:bg-raised">Manage</A>}
          {href && <a href={href} target="_blank" rel="noopener" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90">Open <ArrowUpRight size={15} /></a>}
          {ctx.human && a.kind !== 'volume' && a.kind !== 'job' && <LifecycleMenu item={{ key: a.id, name: ctx.label(a), kind: a.kind, provider: a.provider, projectId: ctx.service(a)?.projectId }} onChanged={() => { ctx.reload(); onClose(); }}
            items={a.kind === 'domain' || a.kind === 'server' ? [] : [moveToClientItem(() => setMoving(true))]} />}
        </span>
      </div>
      <MoveToClientDialog item={{ key: a.id, name: ctx.label(a) }} open={moving} onClose={() => setMoving(false)} onMoved={ctx.reload} />
      {a.kind !== 'project' && a.kind !== 'volume' && a.kind !== 'job' && <Chain a={a} />}
      {unusedSub && ctx.human && (
        <section className="flex flex-wrap items-center gap-3 rounded-[20px] bg-blue-soft px-4 py-3.5">
          <Sparkles size={17} className="shrink-0 text-blue-text" />
          <p className="min-w-0 flex-1 text-[13.5px] text-ink-2">Nothing uses this one yet. Point it at an app, and Unit7 sets up its DNS and HTTPS.</p>
          <Button size="sm" variant="primary" onClick={() => ctx.connect({ root: g!.root, subs: [a] })}>Connect it</Button>
        </section>
      )}
      <Issues a={a} />

      {isRoot && g && (
        <section>
          <h3 className="mb-1 flex items-center gap-2 text-[13px] font-semibold">Subdomains <span className="font-normal text-muted">{g.subs.length}</span>
            {ctx.human && unused.length > 1 && <Button className="ml-auto" size="sm" variant="soft" icon={<Sparkles size={14} />} onClick={() => ctx.connect({ root: g.root, subs: unused, all: true })}>Connect {unused.length} unused…</Button>}
          </h3>
          {g.subs.length ? <ul className="divide-y divide-line">{[...subs.filter((d) => !isUnused(v, d)), ...unused].map((d) => <SubRow key={d.id} d={d} root={g.root} />)}</ul> : <p className="text-[13px] text-muted">None yet.</p>}
          {ctx.human && (adding ? <AddSub root={g.root} onDone={() => setAdding(false)} /> : <Button className="mt-2" size="sm" variant="soft" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add subdomain</Button>)}
        </section>
      )}

      {a.kind === 'project' && <Parts a={a} />}
      <Facts a={a} />
      <Related a={a} />

      {ctx.human && (menu.length > 0 || pointable(a) || a.kind === 'domain') && (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold">Actions</h3>
          <div className="flex flex-wrap gap-2">
            {pointable(a) && !adding && <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add a domain</Button>}
            {a.kind === 'domain' && !isRoot && <Button size="sm" variant="soft" icon={<Inbox size={15} />} onClick={() => navigate(`/email/${a.name}`)}>Email</Button>}
            {isRoot && g && <Button size="sm" variant="soft" icon={<Rocket size={15} />} onClick={() => { onClose(); openDomainLaunch({ domain: g.root, own: true }); }}>Set it up</Button>}
            {menu.map((m) => <Button key={m.label} size="sm" variant={m.danger ? 'secondary' : 'soft'} className={m.danger ? 'text-bad' : undefined} icon={m.icon} onClick={m.run}>{m.label}</Button>)}
            {managed && <Button size="sm" variant="soft" onClick={() => void act('domain.check', { domainId: managed.id }).then((r) => r && ctx.reload())}>Check it now</Button>}
            {managed && <Button size="sm" variant="secondary" className="text-bad" onClick={() => void stopServing(a.name, managed, () => { ctx.reload(); onClose(); })}>Stop serving it here</Button>}
          </div>
          {pointable(a) && adding && <div className="mt-2"><AddDomain a={a} onDone={() => setAdding(false)} /></div>}
        </section>
      )}
    </div>
  );
}
