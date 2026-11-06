import { useId } from 'react';

// The Unit7 mark: one slanted "7" in two colours, a blue bar and a lime stroke that carries on from
// the bar's right edge, on an ink tile. Same drawing as public/favicon.svg.
// animate: the 7 assembles once (the bar slides in, the stroke draws down, a glint passes); still under reduced motion.
export function Mark({ size = 28, className, title, animate }: { size?: number; className?: string; title?: string; animate?: boolean }) {
  const clip = `mk${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={[className, animate && 'mark-anim'].filter(Boolean).join(' ') || undefined} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} style={{ flexShrink: 0 }}>
      <rect width="32" height="32" rx="9.5" fill="#0E0E12" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="none" stroke="#fff" strokeOpacity="0.1" />
      <path className="mark-stroke" d="M17.11 12.15h5.6L14.9 24.75H9.3z" fill="#C6F432" />
      <path className="mark-bar" d="M9.45 7.25h16.3l-3.22 5.2H6.23z" fill="#3D73FF" />
      {animate && (
        <>
          <clipPath id={clip}><rect width="32" height="32" rx="9.5" /></clipPath>
          <g clipPath={`url(#${clip})`}><rect className="mark-glint" x="0" y="-4" width="9" height="40" fill="#fff" fillOpacity="0.45" opacity="0" /></g>
        </>
      )}
    </svg>
  );
}

export function Logo({ size = 28, wordmark = true, className, animate }: { size?: number; wordmark?: boolean; className?: string; animate?: boolean }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.36 }}>
      <Mark size={size} title={wordmark ? undefined : 'Unit7'} animate={animate} />
      {wordmark && <span className="font-semibold tracking-[-0.035em] text-ink" style={{ fontSize: size * 0.68, lineHeight: 1 }}>Unit7</span>}
    </span>
  );
}
