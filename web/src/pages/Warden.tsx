// Warden, Unit7's always-on guard — with a face. The character's state reflects what Warden is
// actually doing: calm when all is well, alert on an open incident, working when it's acting.
import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Activity, Zap } from 'lucide-react';
import { useApi, onLive, type LiveEvent } from '../lib/api';
import { A, Badge, Card, Dot, timeAgo, cx } from '../ui';

type Mood = 'calm' | 'working' | 'alert';

export function WardenBadge() {
  const incidents = useApi<any[]>('/api/incidents', { live: (e) => e.type.startsWith('incident.') });
  const [mood, setMood] = useState<Mood>('calm');
  const [saying, setSaying] = useState('On patrol. All systems normal.');
  const open = incidents.data?.filter((i) => i.status === 'open' || i.status === 'investigated').length ?? 0;

  useEffect(() => {
    const off = onLive((e: LiveEvent) => {
      if (!/^(server\.|service\.|deployment\.|incident\.|backup\.|action\.)/.test(e.type)) return;
      if (e.type.startsWith('incident.')) { setMood('alert'); setSaying(e.message); return; }
      if (e.severity === 'critical' || e.severity === 'warning') { setMood('alert'); setSaying(e.message); }
      else { setMood('working'); setSaying(e.message); }
      const t = setTimeout(() => { setMood(open > 0 ? 'alert' : 'calm'); setSaying(open > 0 ? `${open} incident${open > 1 ? 's' : ''} need a look.` : 'On patrol. All systems normal.'); }, 6000);
      return () => clearTimeout(t);
    });
    return off;
  }, [open]);

  useEffect(() => { if (open > 0 && mood === 'calm') { setMood('alert'); setSaying(`${open} incident${open > 1 ? 's' : ''} need a look.`); } }, [open, mood]);

  return (
    <Card className={cx('flex items-center gap-4 p-4 transition-colors', mood === 'alert' && 'border-warn/40')}>
      <Guard mood={mood} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Warden</span>
          <Badge tone={mood === 'alert' ? 'warn' : mood === 'working' ? 'ember' : 'ok'}>{mood === 'alert' ? 'needs a look' : mood === 'working' ? 'working' : 'on patrol'}</Badge>
        </div>
        <p className="mt-0.5 truncate text-[12.5px] text-muted">{saying}</p>
      </div>
      {open > 0 && <A href="/activity" className="text-[12.5px] font-medium text-ember">View →</A>}
    </Card>
  );
}

// A small guard character in SVG. Eyes scan while on patrol; the shield pulses amber on alert.
export function Guard({ mood = 'calm', size = 48 }: { mood?: Mood; size?: number }) {
  const eyeShift = mood === 'alert' ? 0 : undefined; // CSS animation handles patrol scanning
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id="g-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ember)" stopOpacity="0.95" />
          <stop offset="1" stopColor="var(--ember)" stopOpacity="0.7" />
        </linearGradient>
      </defs>
      {/* shield / body */}
      <path d="M24 4l16 5v11c0 9.5-6.5 16.5-16 19-9.5-2.5-16-9.5-16-19V9z" fill="url(#g-body)" className={mood === 'alert' ? 'animate-working' : ''} />
      {/* cap brim */}
      <rect x="13" y="13" width="22" height="4" rx="2" fill="#fff" opacity="0.9" />
      <rect x="16" y="9" width="16" height="6" rx="3" fill="#fff" opacity="0.85" />
      <circle cx="24" cy="12" r="1.4" fill="var(--ember)" />
      {/* visor */}
      <rect x="15" y="20" width="18" height="8" rx="4" fill="#0b0b12" opacity="0.85" />
      {/* eyes */}
      <g fill="#fff">
        <circle cx={21} cy={24} r="1.8"><animate attributeName="cx" values="20;22;20" dur="3s" repeatCount="indefinite" begin="0s" /></circle>
        <circle cx={27} cy={24} r="1.8"><animate attributeName="cx" values="26;28;26" dur="3s" repeatCount="indefinite" begin="0s" /></circle>
      </g>
      {/* check mark when calm */}
      {mood === 'calm' && <path d="M19 33l3.5 3.5L30 29" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />}
      {mood === 'working' && <circle cx="24" cy="33" r="2.4" fill="#fff" className="animate-working" />}
      {mood === 'alert' && <text x="24" y="36" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">!</text>}
      {void eyeShift}
    </svg>
  );
}
