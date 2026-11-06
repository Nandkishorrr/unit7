// A server's projects as framed groups: each frame reads left to right, domains → apps → data, with the owner's
// logo and the trust badge on top. The same frames show on the server page (from its X-ray) and on the Map
// (from map.get's server frames). Supabase and other stacks are one thing. The layout never moves around:
// projects in a fixed order, things in a fixed order inside them.
import type { ReactNode } from 'react';
import { ArrowRight, Globe, HardDrive, CalendarClock } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { Dot, cx } from '../../ui';
import { OWNER_NAME, healthTone, healthWords, partLogo, partWhat, type Health, type Trust, type Xray } from './shape';
import { OwnerTile, TrustBadge } from './Xray';

export interface Thing { id: string; kind: string; name: string; logo?: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' | 'idle'; uses?: string[]; onClick?: () => void }
export interface FrameModel {
  id: string; name: string; owner: string; trust: Trust; health?: Health; environment?: string; system?: boolean; loose?: boolean;
  domains: Thing[]; apps: Thing[]; data: Thing[]; onOpen?: () => void;
}

// from a server's X-ray
export function framesOf(x: Xray, open?: (projectId: string) => void, openPart?: (partId: string) => void): FrameModel[] {
  const byId = new Map(x.parts.map((p) => [p.id, p]));
  const thing = (id: string): Thing | undefined => {
    const p = byId.get(id);
    if (!p) return undefined;
    const uses = (p.uses ?? []).map((u) => byId.get(u)?.name).filter(Boolean) as string[];
    return { id: p.id, kind: p.kind, name: p.name, logo: p.kind === 'domain' ? undefined : partLogo(p), sub: p.kind === 'job' ? p.when : partWhat(p), tone: p.kind === 'domain' || p.kind === 'volume' || p.kind === 'job' ? undefined : healthTone(p.health), uses, onClick: openPart && (() => openPart(p.id)) };
  };
  const split = (ids: string[]) => {
    const ts = ids.map(thing).filter(Boolean) as Thing[];
    return { domains: ts.filter((t) => t.kind === 'domain'), apps: ts.filter((t) => t.kind === 'app' || t.kind === 'service' || t.kind === 'job'), data: ts.filter((t) => t.kind === 'database' || t.kind === 'volume') };
  };
  const frames = x.projects.map((pr): FrameModel => ({ id: pr.id, name: pr.name, owner: pr.owner, trust: pr.trust, health: pr.health, environment: pr.environments?.join(', '), system: pr.system, ...split(pr.parts), onOpen: open && (() => open(pr.id)) }));
  if (x.loose.length) frames.push({ id: 'loose', name: 'Not part of a project', owner: 'unmanaged', trust: 'seen', loose: true, ...split(x.loose) });
  return frames;
}

function Item({ t }: { t: Thing }) {
  const icon = t.kind === 'domain' ? <Globe size={12} className="text-muted" /> : t.kind === 'volume' ? <HardDrive size={12} className="text-muted" /> : t.kind === 'job' ? <CalendarClock size={12} className="text-muted" /> : <BrandLogo id={t.logo ?? 'docker'} size={13} />;
  const body = (
    <>
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-raised">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-ink">{t.name}</span>
        {t.sub && <span className="block truncate text-[11px] text-muted">{t.sub}{t.uses?.length ? ` · uses ${t.uses.join(', ')}` : ''}</span>}
      </span>
      {t.tone && t.tone !== 'ok' && <Dot tone={t.tone} />}
    </>
  );
  const cls = 'flex h-11 w-full min-w-0 items-center gap-2 rounded-[12px] border border-line bg-surface px-2 text-left';
  return <li>{t.onClick ? <button type="button" onClick={t.onClick} title={t.name} className={cx(cls, 'transition hover:border-ink/30 hover:shadow-soft')}>{body}</button> : <div title={t.name} className={cls}>{body}</div>}</li>;
}
function Col({ title, items, empty }: { title: string; items: Thing[]; empty: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">{title}</p>
      {items.length ? <ul className="space-y-1.5">{items.map((t) => <Item key={t.id} t={t} />)}</ul> : <p className="flex h-11 items-center rounded-[12px] border border-dashed border-line-strong px-2.5 text-[11.5px] text-faint">{empty}</p>}
    </div>
  );
}

export function Frame({ f, className }: { f: FrameModel; className?: string }) {
  const t = healthTone(f.health);
  return (
    <section aria-label={f.name} className={cx('min-w-0 rounded-[22px] border p-3.5', f.loose ? 'border-dashed border-line-strong bg-surface/60' : f.system ? 'border-line bg-raised/50' : 'border-line bg-surface shadow-soft', className)}>
      <header className="mb-3 flex items-center gap-2.5">
        {!f.loose && <OwnerTile owner={f.owner} size={30} />}
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-center gap-1.5 text-[14px] font-semibold">
            {!f.loose && <Dot tone={t === 'idle' ? 'idle' : t} />}
            {f.onOpen ? <button type="button" onClick={f.onOpen} className="truncate text-left hover:underline decoration-line-strong underline-offset-4">{f.name}</button> : <span className="truncate">{f.name}</span>}
          </h3>
          {!f.loose && <p className="truncate text-[11.5px] text-muted" title={healthWords(f.health)}>{[OWNER_NAME[f.owner] && `Run by ${OWNER_NAME[f.owner]}`, f.environment, t !== 'ok' ? healthWords(f.health) : undefined].filter(Boolean).join(' · ')}</p>}
        </div>
        {!f.loose && !f.system && <TrustBadge trust={f.trust} owner={f.owner} />}
      </header>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-start">
        <Col title="Domains" items={f.domains} empty="No domain" />
        <Arrow />
        <Col title="Apps" items={f.apps} empty="Nothing running" />
        <Arrow />
        <Col title="Data" items={f.data} empty="No data kept" />
      </div>
    </section>
  );
}
const Arrow = () => <span aria-hidden className="mt-[22px] hidden h-11 items-center self-start text-faint sm:flex"><ArrowRight size={14} /></span>;

// projects first, the system's own after, then what isn't part of a project
export function Frames({ frames, empty, className }: { frames: FrameModel[]; empty?: ReactNode; className?: string }) {
  if (!frames.length) return <>{empty ?? null}</>;
  const order = [...frames].sort((a, b) => +!!a.loose - +!!b.loose || +!!a.system - +!!b.system);
  return <div className={cx('grid gap-3 xl:grid-cols-2', className)}>{order.map((f) => <Frame key={f.id} f={f} />)}</div>;
}
