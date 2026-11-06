// The map as a calm list: a section per project (or per account when there's no project), each row one thing with
// its kind, how it's doing and where it points. A row opens in place for more; its … menu has the rest. Domains sit
// with the project they open; the ones that open nothing yet are together at the end.
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink, Info, Plus, Sparkles } from 'lucide-react';
import { Button, cx, timeAgo } from '../../ui';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { ownerLogo, size as bytes } from '../servers/shape';
import { engineOf, isUnused, liveOf, logoOf, pointable, targetsOf, type Asset, type Derived, type Group } from './data';
import { ownersOf } from './layout';
import { KIND_ICON, KIND_NAME, domainActions, plural, short, useMap, type MapCtx, type MenuItem } from './parts';
import { LifecycleMenu } from '../lifecycle';
import { Menu as KitMenu } from '../kit';
import { IssueItem } from './Inside';

type Row = { kind: 'thing'; a: Asset } | { kind: 'domain'; g: Group };
interface Section { id: string; title: string; sub?: string; logo: string; rows: Row[] }

function sectionsOf(v: Derived, show: Set<string>, ctx: MapCtx, q: string): Section[] {
  const owners = ownersOf(v, show, { title: providerName, owner: ownerLogo, product: ctx.product, projectOf: (a) => { const s = ctx.service(a); return s ? { id: s.projectId, name: s.project } : undefined; } });
  const out: Section[] = [];
  const home = new Map<string, string>(); // asset id → its section
  const put = (id: string, title: string, sub: string | undefined, logo: string, things: Asset[]) => {
    if (!things.length) return;
    out.push({ id, title, sub, logo, rows: things.map((a) => ({ kind: 'thing' as const, a })) });
    for (const a of things) home.set(a.id, id);
  };
  for (const o of owners) {
    const where = o.asset ? `on ${o.title}` : o.sub ? `${o.title} · ${o.sub}` : o.title;
    for (const b of o.bands) put(b.id, b.name, where, b.logo, [...b.apps, ...b.dbs]);
    put(o.id, o.title, o.asset ? 'Not part of a project' : o.sub, o.logo, [...o.apps, ...o.dbs]);
  }
  // each root domain joins the section of the first thing it opens
  const loose: Row[] = [];
  for (const g of v.groups) {
    const members = [g.asset, ...g.subs].filter((d): d is Asset => !!d && show.has(d.id));
    if (!members.length) continue;
    const t = members.flatMap((d) => targetsOf(v, d)).map((x) => home.get(x.asset.id)).find(Boolean);
    const s = t && out.find((x) => x.id === t);
    (s ? s.rows : loose).push({ kind: 'domain', g });
  }
  if (loose.length) out.push({ id: 'domains', title: 'Domains not linked yet', logo: 'domain', rows: loose });
  const needle = q.trim().toLowerCase();
  const name = (r: Row) => (r.kind === 'domain' ? [r.g.root, ...r.g.subs.map((d) => d.name)].join(' ') : `${ctx.label(r.a)} ${r.a.url ?? ''}`);
  return needle ? out.map((s) => ({ ...s, rows: s.rows.filter((r) => name(r).toLowerCase().includes(needle) || s.title.toLowerCase().includes(needle)) })).filter((s) => s.rows.length) : out;
}

export function ListView({ show, q, focus }: { show: Set<string>; q: string; focus?: string | null }) {
  const ctx = useMap();
  const sections = useMemo(() => sectionsOf(ctx.v, show, ctx, q), [ctx, show, q]);
  const [shut, setShut] = useState<Set<string>>(new Set());
  if (!sections.length) return <p className="px-6 py-16 text-center text-[14px] text-muted">Nothing here matches. Try another filter.</p>;
  return (
    <div className="space-y-4 px-3 pb-6 pt-3 sm:px-5">
      {sections.map((s, i) => {
        const open = !shut.has(s.id);
        const apps = s.rows.filter((r) => r.kind === 'thing' && r.a.kind !== 'database').length, dbs = s.rows.filter((r) => r.kind === 'thing' && r.a.kind === 'database').length, doms = s.rows.filter((r) => r.kind === 'domain').length;
        return (
          <section key={s.id} className="rounded-[22px] border border-line bg-surface shadow-soft" style={{ animation: `rise .45s var(--ease-out-soft) ${Math.min(i, 8) * 40}ms backwards` }}>
            <button type="button" aria-expanded={open} onClick={() => setShut((x) => { const n = new Set(x); if (open) n.add(s.id); else n.delete(s.id); return n; })}
              className={cx('flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-raised/50', open ? 'rounded-t-[22px]' : 'rounded-[22px]')}>
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={s.logo} size={17} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold tracking-[-0.015em]">{s.title}</span>
                {s.sub && <span className="block truncate text-[12.5px] text-muted">{s.sub}</span>}
              </span>
              <span className="hidden shrink-0 text-[12.5px] text-muted sm:inline">{[apps && plural(apps, 'app'), dbs && `${dbs} db`, doms && plural(doms, 'domain')].filter(Boolean).join(' · ')}</span>
              <ChevronDown size={17} className={cx('shrink-0 text-muted transition-transform duration-300', !open && '-rotate-90')} />
            </button>
            {open && (
              <ul className="divide-y divide-line border-t border-line">
                {s.rows.map((r) => <RowView key={r.kind === 'domain' ? `d:${r.g.root}` : r.a.id} r={r} focus={focus} />)}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

const TONE = { ok: 'bg-ok', warn: 'bg-[#f59e0b]', bad: 'bg-bad', idle: 'bg-line-strong' } as const;
function Status({ tone, text }: { tone: keyof typeof TONE; text: string }) {
  return <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-2"><span className={cx('size-2 shrink-0 rounded-full', TONE[tone])} /><span className="truncate">{text}</span></span>;
}

function RowView({ r, focus }: { r: Row; focus?: string | null }) {
  const ctx = useMap();
  const { v, label, open: openIt } = ctx;
  const [open, setOpen] = useState(false);
  const a = r.kind === 'thing' ? r.a : r.g.asset;
  const g = r.kind === 'domain' ? r.g : undefined;
  const hit = !!focus && (focus === a?.id || (!!g && [g.asset, ...g.subs].some((d) => d?.id === focus)));
  const live = a && liveOf(a);
  const issues = g ? [g.asset, ...g.subs].flatMap((d) => (d ? v.issuesOf(d.id) : [])) : a ? v.issuesOf(a.id) : [];
  const unused = g ? g.subs.filter((d) => isUnused(v, d)) : [];
  const tone: keyof typeof TONE = issues.some((i) => i.severity === 'critical') || live?.tone === 'bad' ? 'bad' : issues.length || (a && v.attention(a)) || live?.tone === 'warn' ? 'warn' : live || (g && targets(v, g).length) ? 'ok' : 'idle';
  const dep = a && ctx.service(a)?.deploy;
  const status = tone === 'bad' ? 'Needs fixing' : tone === 'warn' ? (issues[0] ? 'Needs a look' : live?.text ?? 'Needs a look') : live?.text ?? (g ? (targets(v, g).length ? 'Works' : 'Not linked') : dep?.status === 'live' ? `Deployed ${timeAgo(dep.at)}` : 'No checks yet');
  const name = g ? g.root : label(a!);
  const logo = g ? g.dns ?? 'domain' : r.kind === 'thing' && r.a.kind === 'database' ? engineOf(r.a, ctx.service(r.a)?.stack) : logoOf(a!);
  const Kind = KIND_ICON[g ? 'domain' : a!.kind];
  const where: ReactNode = g ? (() => { const t = targets(v, g); return t.length ? <Chips xs={t} /> : <span className="text-faint">Nothing yet</span>; })()
    : a!.kind === 'database' ? (() => { const u = [...new Set([...v.inc(a!.id, 'env'), ...v.inc(a!.id, 'uses')].map((e) => e.source))].map((id) => v.byId.get(id)!).filter(Boolean); return u.length ? <span className="text-muted">used by <Chips xs={u} /></span> : <span className="text-faint">Nothing uses it</span>; })()
      : (() => { const d = [...v.inc(a!.id, 'domain'), ...v.inc(a!.id, 'dns')].map((e) => v.byId.get(e.source)!).filter(Boolean); return d.length ? <span className="truncate text-ink-2">{d[0]!.name}{d.length > 1 && <span className="text-muted"> +{d.length - 1}</span>}</span> : <span className="text-faint">No domain yet</span>; })();
  const items = [
    !!a && { label: 'Show me', icon: <Info size={16} />, run: () => openIt(a.id) },
    !!a?.url && { label: 'Open the site', icon: <ExternalLink size={16} />, run: () => window.open(a.url!, '_blank', 'noopener') },
    ctx.human && !!g && unused.length > 0 && { label: `Connect ${plural(unused.length, 'unused subdomain')}…`, icon: <Sparkles size={16} />, run: () => ctx.connect({ root: g.root, subs: unused, all: unused.length > 1 }) },
    ...(ctx.human && g ? domainActions(g, ctx) : []),
    ctx.human && !!a && pointable(a) && { label: 'Add a domain', icon: <Plus size={16} />, run: () => openIt(a.id) },
  ];
  return (
    <li id={a ? `row-${a.id}` : undefined} className={cx('last:rounded-b-[22px] [&:last-child>div:last-child]:rounded-b-[22px]', hit && 'bg-blue-soft/60')}>
      <div className="flex min-h-[52px] items-center gap-3 px-3 py-1.5 sm:px-4">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronRight size={15} className={cx('shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')} />
          <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-raised"><BrandLogo id={logo} size={16} /></span>
          <span className="min-w-0 flex-1 sm:flex-[1.3]">
            <span className="block truncate text-[13.5px] font-medium">{name}{g && g.subs.length > 0 && <span className="ml-1.5 text-[12px] font-normal text-muted">+{g.subs.length}</span>}</span>
            <span className="block truncate text-[12px] text-muted sm:hidden">{status}</span>
          </span>
          <span className="hidden w-[110px] shrink-0 items-center gap-1.5 text-[12.5px] text-muted md:flex"><Kind size={14} />{g ? 'Domain' : KIND_NAME[a!.kind]}</span>
          <span className="hidden w-[150px] shrink-0 sm:block"><Status tone={tone} text={status} /></span>
          <span className="hidden min-w-0 flex-1 items-center gap-1.5 text-[12.5px] lg:flex"><ArrowRight size={13} className="shrink-0 text-faint" />{where}</span>
        </button>
        {a ? <LifecycleMenu item={{ key: a.id, name, kind: a.kind, provider: a.provider, projectId: ctx.service(a)?.projectId }} onChanged={ctx.reload} label={`More for ${name}`}
          items={(items.filter(Boolean) as MenuItem[]).map((m) => ({ label: m.label, icon: m.icon, danger: m.danger, onSelect: m.run }))} />
          : <KitMenu label={`More for ${name}`} items={(items.filter(Boolean) as MenuItem[]).map((m) => ({ label: m.label, icon: m.icon, danger: m.danger, onSelect: m.run }))} />}
      </div>
      {open && (
        <div className="animate-[fade_0.25s_ease-out] border-t border-line bg-raised/40 px-4 py-3 pl-[60px] text-[13px]">
          {g ? <DomainMore g={g} /> : <ThingMore a={a!} />}
          {a && <Button className="mt-3" size="sm" variant="soft" onClick={() => openIt(a.id)}>All details</Button>}
        </div>
      )}
    </li>
  );
}

const targets = (v: Derived, g: Group) => [...new Map([g.asset, ...g.subs].flatMap((d) => (d ? targetsOf(v, d) : [])).map((t) => [t.asset.id, t.asset])).values()];
function Chips({ xs }: { xs: Asset[] }) {
  const { label } = useMap();
  return <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-ink-2"><BrandLogo id={logoOf(xs[0]!)} size={13} /><span className="truncate">{label(xs[0]!)}</span>{xs.length > 1 && <span className="shrink-0 text-muted">+{xs.length - 1}</span>}</span>;
}

function DomainMore({ g }: { g: Group }) {
  const ctx = useMap();
  const subs = [...(g.asset ? [g.asset] : []), ...g.subs];
  const issues = subs.flatMap((d) => ctx.v.issuesOf(d.id).map((i) => ({ i, d })));
  return (
    <>
      <ul className="space-y-1.5">
        {subs.map((d) => {
          const t = targetsOf(ctx.v, d);
          return (
            <li key={d.id} className="flex min-w-0 flex-wrap items-center gap-2">
              <button type="button" onClick={() => ctx.open(d.id)} className="min-w-0 truncate font-medium hover:underline">{d.id === g.asset?.id ? g.root : short(d, g.root)}</button>
              <ArrowRight size={12} className="shrink-0 text-faint" />
              {t.length ? <span className="text-ink-2">{t.map((x) => ctx.label(x.asset)).join(', ')}</span>
                : ctx.human ? <button type="button" onClick={() => ctx.connect({ root: g.root, subs: [d] })} className="font-medium text-blue-text hover:underline">Connect it</button> : <span className="text-faint">nothing here</span>}
            </li>
          );
        })}
      </ul>
      {issues.length > 0 && <div className="mt-3 space-y-2">{issues.map(({ i, d }) => <IssueItem key={i.key} i={i} a={d} compact />)}</div>}
    </>
  );
}

function ThingMore({ a }: { a: Asset }) {
  const { v, label, service } = useMap();
  const svc = service(a);
  const rows: [string, ReactNode][] = [];
  if (a.url) rows.push(['Address', <a href={a.url} target="_blank" rel="noopener" className="text-blue-text hover:underline">{a.url.replace(/^https?:\/\//, '')}</a>]);
  const doms = [...v.inc(a.id, 'domain'), ...v.inc(a.id, 'dns')].map((e) => v.byId.get(e.source)?.name).filter(Boolean);
  if (doms.length) rows.push(['Domains', doms.join(', ')]);
  const uses = [...v.out(a.id, 'env'), ...v.out(a.id, 'uses')].map((e) => v.byId.get(e.target)).filter((x): x is Asset => !!x);
  if (uses.length) rows.push(['Uses', [...new Set(uses.map(label))].join(', ')]);
  const on = v.out(a.id, 'runs_on').map((e) => v.byId.get(e.target)?.name).filter(Boolean);
  if (on.length) rows.push(['Runs on', on.join(', ')]);
  if (svc?.deploy) rows.push(['Last deploy', `${svc.deploy.at ? timeAgo(svc.deploy.at) : 'not yet'} · ${svc.deploy.status}`]);
  if (a.kind === 'database') {
    if (a.size ?? a.backups?.size) rows.push(['Size', bytes(a.size ?? a.backups?.size)]);
    if (a.backups) rows.push(['Backups', `${plural(a.backups.count, 'backup')}${a.backups.last ? `, last ${timeAgo(a.backups.last)}` : ''}`]);
    if (a.exposed) rows.push(['Internet', <span className="font-medium text-bad">Open to anyone</span>]);
  }
  if (a.account) rows.push(['Account', a.account]);
  const issues = v.issuesOf(a.id);
  return (
    <>
      <dl className="grid gap-1.5">
        {rows.map(([k, x]) => <div key={k + String(x)} className="flex gap-3"><dt className="w-[90px] shrink-0 text-muted">{k}</dt><dd className="min-w-0 flex-1 break-words text-ink-2">{x}</dd></div>)}
        {!rows.length && !issues.length && <p className="text-muted">Nothing more to show.</p>}
      </dl>
      {/* each problem with its fix, Check again, Ask Unit7 and This is fine, as in the pop-up */}
      {issues.length > 0 && <div className="mt-3 space-y-2">{issues.map((i) => <IssueItem key={i.key} i={i} a={a} compact />)}</div>}
    </>
  );
}
