// A third-party service's own logo, or a soft letter tile when we don't have one.
import { LOGOS } from './logos.generated';
import { Mark } from './Logo';
import { PROVIDER_ALIAS, providerName } from '../lib/words';

// names live with the plain-words helpers so tests can load them under plain Node
export { providerName };
const ALIAS = PROVIDER_ALIAS;

// fallback tiles: a stable soft color per name
const TILE = ['#E8EEFF:#1F4FD8', '#EEF9D6:#3F5A00', '#FDE8EF:#B4234F', '#FFF0DE:#9A4A00', '#E6F6F3:#0F6E5C', '#EFE9FF:#5B3CC4'];

export function BrandLogo({ id, size = 20, className, title }: { id: string; size?: number; className?: string; title?: string }) {
  const key = ALIAS[id] ?? id;
  const label = title ?? providerName(id);
  if (key === 'forge' || key === 'unit7') return <Mark size={size} className={className} title={label} />;
  const icon = LOGOS[key];
  if (!icon) {
    const [bg, fg] = TILE[[...key].reduce((n, c) => n + c.charCodeAt(0), 0) % TILE.length]!.split(':');
    return (
      <span role="img" aria-label={label} title={label} className={className}
        style={{ display: 'inline-block', flexShrink: 0, width: size, height: size, background: bg, color: fg, borderRadius: size * 0.3, fontSize: size * 0.5 }}>
        <span className="grid h-full w-full place-items-center font-semibold leading-none">{label.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase()}</span>
      </span>
    );
  }
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${icon.w} ${icon.h}`} preserveAspectRatio="xMidYMid meet"
      className={className} fill="currentColor" style={{ flexShrink: 0, display: 'inline-block' }}
      dangerouslySetInnerHTML={{ __html: `<title>${label}</title>${icon.body}` }} />
  );
}
