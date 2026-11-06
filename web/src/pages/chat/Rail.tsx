// Past conversations, newest first, grouped by when; New chat on top. A slim column on wide screens (it folds to
// icons), the same list in a sheet on phones.
import { useEffect, useState } from 'react';
import { ChevronDown, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Shield } from 'lucide-react';
import { useApi } from '../../lib/api';
import { Skeleton, cx, timeAgo } from '../../ui';

interface Conv { id: string; title: string; updated_at: string; warden?: number }

const day = (iso: string) => { const d = new Date(iso); d.setHours(0, 0, 0, 0); return d.getTime(); };
function when(iso: string) {
  const today = day(new Date().toISOString());
  const d = day(iso);
  return d === today ? 'Today' : d === today - 86400_000 ? 'Yesterday' : d > today - 7 * 86400_000 ? 'This week' : 'Earlier';
}

export function RailList({ current, onOpen }: { current: string | null; onOpen: (id: string) => void }) {
  const list = useApi<Conv[]>('/api/agent/conversations', { live: (e) => e.type === 'agent.done' });
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  useEffect(() => { if (current) list.reload(); }, [current]);
  if (!list.data) return list.error
    ? <p className="px-3 py-2 text-[12.5px] text-muted">Couldn’t load your conversations. <button onClick={() => list.reload()} className="font-medium text-blue-text hover:underline">Try again</button></p>
    : <div className="space-y-1.5 px-1 pt-1" aria-busy="true" aria-label="Loading your chats"><Skeleton className="mb-2.5 ml-2 h-2.5 w-12 rounded-full" />{['w-[82%]', 'w-[64%]', 'w-[90%]', 'w-[58%]', 'w-[74%]'].map((w) => <div key={w} className="px-2 py-2"><Skeleton className={cx('h-3 rounded-full', w)} /></div>)}</div>;
  if (!list.data.length) return (
    <div className="flex flex-col items-center px-3 pb-2 pt-6 text-center animate-rise">
      <img src="/illustrations/chat.webp" alt="" width={84} height={70} draggable={false} className="float-y h-[70px] w-auto drop-shadow-[0_10px_14px_rgb(40_30_90/0.16)]" />
      <p className="mt-3 text-[13px] font-medium text-ink">No chats yet</p>
      <p className="mt-0.5 text-[12px] leading-relaxed text-muted">Ask anything. Your chats show up here, newest first.</p>
    </div>
  );
  // the same question asked again the same day folds under the newest: "Connect my domain · 3"
  const rows: { head: string | null; c: Conv; more: Conv[] }[] = [];
  const seen = new Map<string, (typeof rows)[number]>();
  let group = '';
  for (const c of list.data) {
    const g = when(c.updated_at), key = `${g}|${c.title.trim().toLowerCase()}`;
    const hit = seen.get(key);
    if (hit) { hit.more.push(c); continue; }
    const row = { head: g !== group ? (group = g) : null, c, more: [] as Conv[] };
    seen.set(key, row); rows.push(row);
  }
  const item = (on: boolean) => cx('flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[13px] transition', on ? 'bg-surface font-medium text-ink shadow-soft ring-1 ring-line' : 'text-ink-2 hover:bg-surface/70 hover:text-ink');
  return (
    <nav aria-label="Past conversations" className="space-y-0.5">
      {rows.map(({ head, c, more }) => {
        const open = unfolded.has(c.id) || more.some((m) => m.id === current);
        return (
          <div key={c.id}>
            {head && <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-faint first:pt-1">{head}</p>}
            <div className="relative">
              <button type="button" onClick={() => onOpen(c.id)} aria-current={c.id === current ? 'page' : undefined} title={c.title} className={cx(item(c.id === current), more.length > 0 && 'pr-11')}>
                {c.warden ? <Shield size={13} aria-label="Opened by Warden" className="shrink-0 text-blue-text" /> : null}
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
              </button>
              {more.length > 0 && (
                <button type="button" onClick={() => setUnfolded((u) => { const n = new Set(u); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}
                  aria-expanded={open} aria-label={`${more.length + 1} chats called ${c.title}. ${open ? 'Hide' : 'Show'} the earlier ones`}
                  className="absolute right-1.5 top-1/2 inline-flex h-6 -translate-y-1/2 items-center gap-0.5 rounded-full bg-raised px-2 text-[11px] font-medium tabular text-muted transition hover:bg-sunken hover:text-ink">
                  {more.length + 1}<ChevronDown size={11} className={cx('transition-transform', open && 'rotate-180')} />
                </button>
              )}
            </div>
            {open && (
              <div className="ml-3 space-y-0.5 border-l border-line pl-1.5 animate-pop">
                {more.map((m) => (
                  <button key={m.id} type="button" onClick={() => onOpen(m.id)} aria-current={m.id === current ? 'page' : undefined} title={m.title} className={cx(item(m.id === current), 'py-1.5 text-[12.5px]')}>
                    <span className="min-w-0 flex-1 truncate">{m.title}</span><span className="shrink-0 text-[11px] text-faint">{timeAgo(m.updated_at)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function Rail({ current, onOpen, onNew, folded, onFold }: { current: string | null; onOpen: (id: string) => void; onNew: () => void; folded: boolean; onFold: (f: boolean) => void }) {
  const round = 'grid size-10 shrink-0 place-items-center rounded-full text-ink-2 transition hover:bg-surface hover:text-ink';
  if (folded) {
    return (
      <aside aria-label="Conversations" className="hidden w-12 shrink-0 flex-col items-center gap-1.5 pt-1 lg:flex">
        <button type="button" onClick={() => onFold(false)} className={round} aria-label="Show conversations" title="Show conversations"><PanelLeftOpen size={18} /></button>
        <button type="button" onClick={onNew} className="grid size-10 place-items-center rounded-full bg-ink text-bg transition hover:opacity-90" aria-label="New chat" title="New chat"><Plus size={18} /></button>
        <button type="button" onClick={() => onFold(false)} className={round} aria-label="Past conversations" title="Past conversations"><MessageSquare size={17} /></button>
      </aside>
    );
  }
  return (
    <aside aria-label="Conversations" className="hidden w-[220px] shrink-0 flex-col animate-[rail-in_.32s_var(--ease-out-soft)_both] lg:flex min-[90rem]:w-[244px] min-[105rem]:w-[268px]">
      <div className="flex items-center gap-1.5 pb-2 pt-1">
        <button type="button" onClick={onNew} className="flex h-10 flex-1 items-center gap-2 rounded-full bg-ink pl-3.5 pr-4 text-[13.5px] font-medium text-bg transition hover:opacity-90 active:scale-[0.98]"><Plus size={16} />New chat</button>
        <button type="button" onClick={() => onFold(true)} className={round} aria-label="Hide conversations" title="Hide conversations"><PanelLeftClose size={18} /></button>
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-4 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]">
        <RailList current={current} onOpen={onOpen} />
      </div>
    </aside>
  );
}
