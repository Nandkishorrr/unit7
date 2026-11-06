// Picking what a chat is about: the @ picker (servers, projects, apps, domains, databases, accounts, with logos, fuzzy
// search, arrow keys and groups, on cmdk) that opens above the ask box from @ or "+ Add context", and the chip a
// picked thing becomes: in the box (with ×), in your sent message and in the conversation's header.
import { useEffect, useRef } from 'react';
import { Command, defaultFilter } from 'cmdk';
import { AppWindow, AtSign, Check, Database, FolderKanban, Globe, Layers, Server, UserRound, X } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { Kbd, cx } from '../../ui';
import { GROUPS, type AboutKind, type ContextItem, type PickItem } from './about';

export const KIND_ICON: Record<AboutKind, typeof Server> = { server: Server, project: FolderKanban, app: AppWindow, domain: Globe, database: Database, account: UserRound, environment: Layers };
const PLAIN = new Set(['server', 'domain']);

// a brand logo when there is one, else the kind's own icon
export function AboutLogo({ kind, logo, size = 15, className }: { kind: AboutKind; logo?: string; size?: number; className?: string }) {
  if (logo && !PLAIN.has(logo)) return <BrandLogo id={logo} size={size} className={className} />;
  const I = KIND_ICON[kind];
  return <I size={size} aria-hidden className={cx('shrink-0', className)} />;
}

// a picked thing, as a small pill: light in the ask box and the header, on dark in your message bubble
export function AboutChip({ item, logo, onRemove, dark, className }: { item: ContextItem; logo?: string; onRemove?: () => void; dark?: boolean; className?: string }) {
  const one = GROUPS.find((g) => g.kind === item.kind)?.one ?? item.kind;
  return (
    <span title={`${one}: ${item.name}`} className={cx('inline-flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full pl-2 text-[12.5px] font-medium',
      dark ? 'bg-bg/15 pr-2.5 text-bg' : 'border border-line bg-raised text-ink', onRemove ? 'pr-0.5' : 'pr-2.5', className)}>
      <AboutLogo kind={item.kind} logo={logo} size={13} className={dark ? 'opacity-90' : 'text-ink-2'} />
      <span className="truncate">{item.name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Stop focusing on ${item.name}`}
          className="grid size-6 shrink-0 place-items-center rounded-full text-muted transition hover:bg-sunken hover:text-ink"><X size={12} strokeWidth={2.4} /></button>
      )}
    </span>
  );
}

const group = 'text-[11.5px] font-medium text-faint [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5';
// an item's value starts with its id (cmdk needs each one unique: two apps can share a name); the search only sees the rest
const SEP = '\u0001';
const match = (value: string, search: string, keywords?: string[]) => defaultFilter(value.slice(value.indexOf(SEP) + 1), search, keywords);
const row = 'flex h-10 cursor-pointer items-center gap-2.5 rounded-[12px] px-2.5 text-[13.5px] text-ink-2 data-[selected=true]:bg-raised data-[selected=true]:text-ink';

// Above the ask box; the search sits at its bottom, right over where you were typing. Enter adds (or removes what's
// already picked), Esc or a click elsewhere closes it.
export function ContextPicker({ items, picked, onPick, onClose }: { items: PickItem[]; picked: ContextItem[]; onPick: (i: PickItem) => void; onClose: (how: 'esc' | 'away') => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close.current('away'); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);
  const on = new Set(picked.map((p) => p.id));
  return (
    <div ref={ref} className="animate-pop absolute inset-x-0 bottom-full z-30 mb-2 origin-bottom-left overflow-hidden rounded-[22px] border border-line bg-surface shadow-float sm:right-auto sm:w-[440px]">
      <Command label="Pick what this chat is about" loop filter={match}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current('esc'); } }}>
        <p className="border-b border-line px-3.5 py-2.5 text-[12px] leading-snug text-muted">Pick what this chat is about. Unit7 looks only at what you pick.</p>
        <Command.List className="max-h-[min(320px,46dvh)] overflow-y-auto overscroll-contain p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">{items.length ? 'Nothing by that name.' : 'Nothing to pick yet. Connect a server or an account first.'}</Command.Empty>
          {GROUPS.map((g) => {
            const list = items.filter((i) => i.kind === g.kind);
            return list.length ? (
              <Command.Group key={g.kind} heading={g.label} className={group}>
                {list.map((i) => (
                  <Command.Item key={i.id} value={`${i.id}${SEP}${i.name} ${i.sub ?? ''}`} keywords={[g.one, g.label]} onSelect={() => onPick(i)} className={row}>
                    <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-raised text-ink-2"><AboutLogo kind={i.kind} logo={i.logo} size={15} /></span>
                    <span className="min-w-0 flex-1 truncate">{i.name}</span>
                    {i.sub && <span className="max-w-[42%] truncate text-[12px] text-faint">{i.sub}</span>}
                    {on.has(i.id) && <Check size={14} strokeWidth={2.6} aria-label="Picked" className="shrink-0 text-blue-text" />}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null;
          })}
        </Command.List>
        <div className="flex items-center gap-2 border-t border-line px-3.5">
          <AtSign size={15} aria-hidden className="shrink-0 text-blue-text" />
          <Command.Input autoFocus placeholder="Find a server, app, domain…" aria-label="Find what this chat is about"
            className="h-11 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-faint focus-visible:outline-none sm:text-[14px]" />
          <span className="hidden shrink-0 items-center gap-1 text-[11.5px] text-faint sm:flex"><Kbd>↑</Kbd><Kbd>↓</Kbd><Kbd>↵</Kbd><Kbd>esc</Kbd></span>
        </div>
      </Command>
    </div>
  );
}
