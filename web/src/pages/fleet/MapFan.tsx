// On the Map: an app on several servers gets one node for the way its visitors are spread (the front proxy, or DNS),
// fanning out to each of its servers, with each server's share of visitors on its line. Drawn in the canvas's own
// coordinates (it pans and zooms with it), between the domains and the servers they reach.
import { useEffect, useState } from 'react';
import { Globe, Shuffle } from 'lucide-react';
import { onLive, runTool } from '../../lib/api';
import { HoverCard, cx } from '../../ui';
import { S, type MapLayout } from '../map/layout';

interface FanServer { serverId: string; assetId: string; name: string; primary: boolean; state: 'in' | 'out' | 'sick'; health: string | null; share: number }
interface Fan { serviceId: string; name: string; mode: 'front' | 'dns'; why: string | null; assetId: string; servers: FanServer[] }

function useFans() {
  const [fans, setFans] = useState<Fan[]>([]);
  useEffect(() => {
    const load = () => void runTool('fleet.traffic', {}).then((r) => { if (r.status === 'ok') setFans((r.output as { fleets: Fan[] }).fleets); }).catch(() => undefined);
    load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => { if (/^fleet\./.test(e.type)) { clearTimeout(t); t = setTimeout(load, 1500); } });
    return () => { off(); clearTimeout(t); };
  }, []);
  return fans;
}

const NODE = 46;
export function MapFan({ L, intro }: { L: MapLayout; intro?: boolean }) {
  const fans = useFans();
  // a server shows on the canvas as its frame's header (its box is keyed by its map id)
  const boxOf = (assetId: string) => L.box.get(L.rep(L.nodeOf.get(assetId) ?? assetId)) ?? L.box.get(assetId);
  const placed = fans.map((f) => ({ f, ends: f.servers.map((s) => ({ s, b: boxOf(s.assetId) })).filter((x): x is { s: FanServer; b: NonNullable<ReturnType<typeof boxOf>> } => !!x.b && x.b.w > 0) }))
    .filter((p) => p.ends.length > 1);
  if (!placed.length) return null;
  const x = S.DW + 22;
  let lastY = -Infinity; // fans never sit on top of each other
  return (
    <>
      {placed.map(({ f, ends }, k) => {
        const ys = ends.map((e) => e.b.y + Math.min(e.b.h, 50) / 2);
        const y = Math.max(lastY + NODE + 34, ys.reduce((a, b) => a + b, 0) / ys.length - NODE / 2);
        lastY = y;
        const cx0 = x + NODE, cy0 = y + NODE / 2;
        const Icon = f.mode === 'dns' ? Globe : Shuffle;
        const word = f.mode === 'dns' ? 'DNS' : 'Front proxy';
        return (
          <div key={f.serviceId} aria-hidden={false} className="pointer-events-none absolute left-0 top-0 z-[2]" style={{ animation: intro ? `fade .5s ease-out ${300 + k * 120}ms both` : undefined }}>
            <svg aria-hidden className="absolute left-0 top-0 overflow-visible" width={1} height={1}>
              {ends.map(({ s, b }) => {
                const tx = b.x, ty = b.y + Math.min(b.h, 50) / 2, dx = Math.max(24, (tx - cx0) * 0.55);
                const off = s.state !== 'in';
                const color = s.state === 'sick' || s.health === 'bad' ? 'var(--bad)' : off ? 'var(--faint)' : 'var(--blue)';
                return (
                  <g key={s.serverId}>
                    <path d={`M${cx0} ${cy0}C${cx0 + dx} ${cy0} ${tx - dx} ${ty} ${tx} ${ty}`} fill="none" stroke={color} strokeWidth={1.5 + (s.share / 100) * 3} strokeLinecap="round" strokeDasharray={off ? '5 5' : undefined} opacity={0.9} />
                    <circle cx={tx} cy={ty} r={3.2} fill={color} />
                  </g>
                );
              })}
            </svg>
            {/* each line's share, near the server it reaches */}
            {ends.map(({ s, b }) => (
              <span key={s.serverId} className={cx('tabular absolute -translate-y-1/2 whitespace-nowrap rounded-full border px-1.5 py-px text-[10.5px] font-semibold shadow-soft',
                s.state === 'in' ? 'border-blue/30 bg-surface text-blue-text' : 'border-line bg-raised text-muted')}
                style={{ left: b.x - 40, top: b.y + Math.min(b.h, 50) / 2 - 12 }}>{s.state === 'in' ? `${s.share}%` : s.state === 'sick' ? 'out' : 'off'}</span>
            ))}
            <div className="pointer-events-auto absolute" style={{ left: x, top: y, width: NODE }}>
              <HoverCard content={
                <div className="w-[260px] text-[12.5px] text-ink-2">
                  <p className="font-semibold text-ink">{f.name}: {f.mode === 'dns' ? 'spread with DNS' : 'a front proxy'}</p>
                  <p className="mt-1">{f.why}</p>
                  <ul className="mt-2 space-y-0.5">{f.servers.map((s) => <li key={s.serverId} className="flex justify-between gap-3"><span className="truncate">{s.name}{s.primary ? ' (main)' : ''}</span><span className="tabular">{s.state === 'in' ? `${s.share}%` : s.state === 'sick' ? 'taken out' : 'out'}</span></li>)}</ul>
                </div>}>
                <span tabIndex={0} aria-label={`${word} for ${f.name}`} className="grid place-items-center rounded-full bg-ink text-bg shadow-float ring-4 ring-surface" style={{ width: NODE, height: NODE }}>
                  <Icon size={19} aria-hidden />
                </span>
              </HoverCard>
              <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-full bg-surface/90 px-1.5 text-[10.5px] font-medium text-ink-2">{word}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
