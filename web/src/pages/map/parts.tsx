// The map's shared pieces: its context, logos, chips, the little menu, and a domain's actions.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, AppWindow, ArrowRight, Boxes, CalendarClock, Database, Globe, HardDrive, Layers, Lock, Mail, MoreHorizontal, Server, X } from 'lucide-react';
import { act, Badge, Button, Dot, confirmDialog, cx, toast, stepAction } from '../../ui';
import { runTool } from '../../lib/api';
import { tidy } from '../../lib/words';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { MOVABLE, acctLabel, issueLabel, logoOf, pointInput, pointable, targetsOf, type Asset, type Derived, type Group, type Issue, type Managed } from './data';

// what Unit7 itself knows about its own apps and servers (from the projects graph)
export interface SvcInfo { href: string; project: string; projectId: string; env: string; stack?: string; deploy?: { at: string | null; status: string; number: number } }
// label: an app as people tell it apart ("acme · web"), anything else by its name
export interface MapCtx {
  v: Derived; open: (id: string) => void; human: boolean; managed: Map<string, Managed>; reload: () => void; service: (a: Asset) => SvcInfo | undefined;
  serverHref: (a: Asset) => string | undefined; label: (a: Asset) => string;
  connect: (req: ConnectReq) => void; // the centred pop-ups that point unused subdomains at apps (or remove abandoned ones)
  product: (id: string) => string | undefined; // a product's name (map.get's groups)
}
export interface ConnectReq { root: string; subs: Asset[]; app?: string; all?: boolean; remove?: boolean }
export const Ctx = createContext<MapCtx>(null!);
export const useMap = () => useContext(Ctx);

export const KIND_ICON = { app: AppWindow, domain: Globe, server: Server, database: Database, project: Boxes, service: Layers, volume: HardDrive, job: CalendarClock } as const;
export const KIND_NAME = { app: 'App', domain: 'Domain', server: 'Server', database: 'Database', project: 'Project', service: 'Service', volume: 'Stored data', job: 'Scheduled job' } as const;
export const toneOf = (s: string) => (s === 'ok' ? 'ok' : s === 'misconfigured' ? 'bad' : 'idle') as 'ok' | 'bad' | 'idle';
export const short = (d: Asset, root: string) => (d.name.endsWith(`.${root}`) ? d.name.slice(0, -root.length - 1) : d.name);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// a logo on a soft rounded tile; a merged server shows its second logo as a badge. A domain leads with
// where its DNS lives (a small globe badge says it's a domain); DNS nobody here holds is a dashed globe.
export function LogoTile({ a, size = 44, round }: { a: Asset; size?: number; round?: boolean }) {
  const badge = Math.round(size * 0.46);
  const dom = a.kind === 'domain';
  const ids = dom ? (a.dns ? [a.dns] : []) : [logoOf(a), ...(a.also ?? []).map((x) => x.provider)].filter((x, i, l) => l.indexOf(x) === i).slice(0, 2);
  return (
    <span className={cx('relative grid shrink-0 place-items-center text-ink', round ? 'rounded-full' : 'rounded-[14px]', dom && !a.dns ? 'border border-dashed border-line-strong' : 'bg-raised')} style={{ width: size, height: size }}>
      {ids[0] ? <BrandLogo id={ids[0]} size={Math.round(size * 0.52)} /> : <Globe size={Math.round(size * 0.46)} className="text-muted" />}
      {(ids[1] || (dom && a.dns && size >= 36)) && (
        <span className="absolute grid place-items-center rounded-full bg-surface text-muted shadow-soft ring-2 ring-surface" style={{ width: badge, height: badge, right: -badge * 0.28, bottom: -badge * 0.28 }}>
          {ids[1] ? <BrandLogo id={ids[1]} size={Math.round(badge * 0.62)} /> : <Globe size={Math.round(badge * 0.62)} />}
        </span>
      )}
    </span>
  );
}

const ownerName = (a: Asset) => a.account ?? (a.provider === 'unit7' ? 'Unit7' : undefined);
export function AccountLine({ a }: { a: Asset }) {
  const name = ownerName(a);
  if (!name) return null;
  const pid = a.provider === 'domain' ? a.dns ?? 'domain' : a.provider;
  const label = acctLabel(name);
  return <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted"><BrandLogo id={pid} size={14} /><span className="truncate">{providerName(pid)}{label && <span className="text-faint"> · {label}</span>}</span></span>;
}

// a thing, as a small clickable chip with its logo
export function ThingChip({ a, tone, sub }: { a: Asset; tone?: 'ok' | 'bad' | 'warn' | 'idle'; sub?: string }) {
  const { open, label } = useMap();
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); open(a.id); }} title={sub}
      className="relative z-10 inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface pl-1 pr-2.5 text-[12.5px] font-medium text-ink-2 transition hover:border-line-strong hover:bg-raised hover:text-ink">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-raised">{a.kind === 'domain' ? <Globe size={11} className="text-muted" /> : <BrandLogo id={logoOf(a)} size={12} />}</span>
      <span className="truncate">{label(a)}</span>
      {tone && <Dot tone={tone} />}
    </button>
  );
}

export function IssueBadge({ issues, className }: { issues: Issue[]; className?: string }) {
  if (!issues.length) return null;
  const tone = issues.some((i) => i.severity === 'critical') ? 'bad' : issues.some((i) => i.severity === 'warning') ? 'warn' : 'info';
  return (
    <span title={issues.map((i) => tidy(i.text)).join('\n')} className={className}>
      <Badge tone={tone}><AlertTriangle size={12} />{issues.length === 1 ? issueLabel(issues[0]!) : `${issues.length} things to fix`}</Badge>
    </span>
  );
}

// --- a little menu: a button, a list, Escape and clicking away close it ---------------------------
export function useAway<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [open, close]);
  return ref;
}

export type MenuItem = { label: string; icon?: ReactNode; danger?: boolean; run: () => void };
export function Menu({ label, items, className, extra }: { label: string; items: (MenuItem | false)[]; className?: string; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useAway<HTMLDivElement>(open, () => setOpen(false));
  const list = items.filter(Boolean) as MenuItem[];
  if (!list.length && !extra) return null;
  return (
    <div ref={ref} className={cx('relative z-20', className)}>
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><MoreHorizontal size={18} /></button>
      {open && (
        <div role="menu" onClick={(e) => e.stopPropagation()} className="animate-pop absolute right-0 top-full z-30 mt-1 w-60 rounded-[18px] border border-line bg-surface p-1.5 shadow-float">
          {list.map((i) => (
            <button key={i.label} role="menuitem" type="button" onClick={() => { setOpen(false); i.run(); }}
              className={cx('flex h-10 w-full items-center gap-2.5 rounded-[12px] px-3 text-left text-[13.5px] transition hover:bg-raised', i.danger ? 'text-bad' : 'text-ink-2 hover:text-ink')}>
              {i.icon}{i.label}
            </button>
          ))}
          {extra}
        </div>
      )}
    </div>
  );
}

// --- domains -------------------------------------------------------------------------------------
// preview, ask, then move: every record copied (email included) before the nameservers switch
async function moveDns(domain: string) {
  const plan = await runTool('domain.move_dns', { domain }, { dryRun: true }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'http', message: e.message } }));
  if (plan.status === 'error') { toast('bad', `Can’t move ${domain} yet`, plan.error.message, { action: stepAction(plan as never, { retry: () => moveDns(domain) }) }); return; }
  if (plan.status !== 'dry_run') return;
  const p = plan.plan as { zone: string; from: string; willCopy: Record<string, number>; emailRecords: number; copyByHand: string[]; nameservers: string };
  const counts = Object.entries(p.willCopy).map(([t, n]) => `${n} ${t}`).join(', ');
  const ok = await confirmDialog({ title: `Move ${p.zone}’s DNS to Cloudflare?`, body: `Copies ${counts} (${p.emailRecords} for email). ${p.nameservers}.`, items: p.copyByHand.length ? p.copyByHand.map((x) => `Copy by hand: ${x}`) : undefined,
    warning: 'The old records stay where they are, so switching back undoes it.', confirm: 'Move it' });
  if (!ok) return;
  const r = await act('domain.move_dns', { domain }, { success: `${p.zone} is moving to Cloudflare` });
  if (r) toast('info', 'Next step', (r.output as { next: string }).next);
}

export async function stopServing(host: string, m: Managed, done: () => void) {
  if (!(await confirmDialog({ title: `Stop serving ${host} here?`, body: 'Unit7 stops routing it to the app. Its DNS record stays where it is.', confirm: 'Stop serving it', danger: true }))) return;
  if (await act('domain.remove', { domainId: m.id }, { success: `${host} removed` })) done();
}

export function domainActions(g: Group, ctx: MapCtx): (MenuItem | false)[] {
  const root = g.asset?.name ?? g.root;
  const m = ctx.managed.get(root);
  return [
    !!g.dns && MOVABLE.has(g.dns) && { label: 'Move DNS to Cloudflare', icon: <BrandLogo id="cloudflare" size={16} />, run: () => void moveDns(root).then(ctx.reload) },
    { label: 'Protect email', icon: <Mail size={16} />, run: () => void act('domain.protect_email', { domain: root }, { success: `${root}: email protection added` }).then((r) => { if (r) ctx.reload(); }) },
    !!m && { label: 'Check it now', icon: <Lock size={16} />, run: () => void act('domain.check', { domainId: m.id }).then((r) => r && ctx.reload()) },
    !!m && { label: 'Stop serving it here', icon: <X size={16} />, danger: true, run: () => void stopServing(root, m, ctx.reload) },
  ];
}

// SSL and email, in two words each, when known
export function DomainFacts({ g }: { g: Group }) {
  const { v, managed } = useMap();
  const a = g.asset;
  const tls = a?.checks?.tls?.status ?? (managed.get(g.root)?.tls === 'active' ? 'ok' : undefined);
  const mail = a?.checks?.email?.status ?? (a && v.issuesOf(a.id).some((i) => i.key.startsWith('email:')) ? 'unprotected' : undefined);
  return (
    <>
      {tls && <Badge tone={tls === 'ok' ? 'ok' : 'warn'}><Lock size={11} />{tls === 'ok' ? 'HTTPS on' : 'HTTPS needs a look'}</Badge>}
      {mail && <Badge tone={mail === 'ok' ? 'ok' : 'warn'}><Mail size={11} />{mail === 'ok' ? 'Email protected' : 'Email can be faked'}</Badge>}
    </>
  );
}

// one subdomain and what it points at; an unused one offers to connect it
export function SubRow({ d, root }: { d: Asset; root: string }) {
  const ctx = useMap();
  const t = targetsOf(ctx.v, d);
  const issues = ctx.v.issuesOf(d.id);
  const m = ctx.managed.get(d.name);
  return (
    <li className="group/row flex min-h-11 items-center gap-2 py-1.5">
      <button type="button" onClick={() => ctx.open(d.id)} title={d.name}
        className="max-w-[40%] min-w-0 shrink truncate rounded-md text-left text-[13.5px] font-medium text-ink decoration-line-strong underline-offset-4 hover:underline">{short(d, root)}</button>
      <ArrowRight size={13} aria-hidden className="shrink-0 text-faint" />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {t.length ? t.slice(0, 2).map(({ edge, asset }) => <ThingChip key={asset.id + edge.kind} a={asset} tone={toneOf(edge.status)} sub={edge.detail ?? edge.via} />)
          : ctx.human ? <Button size="sm" variant="soft" onClick={() => ctx.connect({ root, subs: [d] })}>Connect</Button> : <span className="truncate text-[12.5px] text-faint">Not linked to anything here</span>}
        <IssueBadge issues={issues} className="hidden sm:inline-flex" />
      </span>
      {ctx.human && m && (
        <button type="button" aria-label={`Stop serving ${d.name}`} title="Stop serving it here" onClick={() => void stopServing(d.name, m, ctx.reload)}
          className="grid size-7 shrink-0 place-items-center rounded-full text-faint opacity-0 transition hover:bg-raised hover:text-bad focus-visible:opacity-100 group-hover/row:opacity-100"><X size={14} /></button>
      )}
    </li>
  );
}

// name + pick an app (with its logo) → domain.point
export function AddSub({ root, onDone }: { root: string; onDone: () => void }) {
  const { v, reload, label } = useMap();
  const [name, setName] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = v.assets.filter((a) => pointable(a) && !a.archived).sort((a, b) => +(b.provider === 'unit7') - +(a.provider === 'unit7') || label(a).localeCompare(label(b)));
  const host = `${name.trim().toLowerCase().replace(/\.$/, '')}.${root}`;
  const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(name.trim().toLowerCase()) && !!pick;
  const submit = async () => {
    const t = v.byId.get(pick!)!;
    setBusy(true);
    const r = await act('domain.point', pointInput(host, t));
    setBusy(false);
    if (!r) return;
    const o = r.output as { dns?: string; at?: string; addThese?: { type: string; name: string; value: string }[] };
    if (o.dns === 'needs you') toast('info', `Almost there: add ${o.addThese?.length ?? 1} record${o.addThese?.length === 1 ? '' : 's'} at ${o.at}`, o.addThese?.map((x) => `${x.type} ${x.name} → ${x.value}`).join('\n'));
    else toast('ok', `${host} now points at ${label(t)}`, 'It shows up here after the next sync.');
    reload();
    onDone();
  };
  return (
    <form className="mt-2 space-y-3 rounded-[18px] bg-raised p-3" onSubmit={(e) => { e.preventDefault(); if (valid) void submit(); }}>
      <label className="flex h-10 items-center rounded-[12px] border border-line-strong bg-surface pl-3 text-[13.5px] focus-within:border-blue focus-within:ring-4 focus-within:ring-blue-soft">
        <span className="sr-only">Subdomain name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="app" className="min-w-0 flex-1 bg-transparent font-medium text-ink outline-none placeholder:text-faint focus-visible:outline-none" />
        <span className="max-w-[55%] truncate pr-3 text-muted">.{root}</span>
      </label>
      <fieldset>
        <legend className="mb-1.5 text-[12px] font-medium text-muted">Points to</legend>
        {targets.length ? (
          <div role="radiogroup" className="flex max-h-[132px] flex-wrap gap-1.5 overflow-y-auto">
            {targets.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={pick === t.id} onClick={() => setPick(t.id)} title={t.url ?? undefined}
                className={cx('inline-flex h-8 items-center gap-1.5 rounded-full border pl-1.5 pr-3 text-[12.5px] font-medium transition',
                  pick === t.id ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2 hover:border-ink/40')}>
                <BrandLogo id={logoOf(t)} size={15} />{label(t)}
              </button>
            ))}
          </div>
        ) : <p className="text-[12.5px] text-muted">No apps that a domain can point at yet.</p>}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" size="sm" variant="primary" disabled={!valid} loading={busy}>Add {name.trim() ? host : 'subdomain'}</Button>
      </div>
    </form>
  );
}
