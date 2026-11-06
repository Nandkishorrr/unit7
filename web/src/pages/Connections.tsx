// Connections: every service Unit7 works with, as calm tiles in plain groups: a logo, a name, and a round count of
// the accounts connected there. A tile opens a centred pop-up with its accounts (check, remove, add another); its plus
// opens the connect flow right there: paste a token, one click with a sign-in this Mac already has (and which one),
// or the provider's own sign-in in a new tab while the pop-up waits for it live. Your AI (Claude Code, Cursor…) on top.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ExternalLink, Loader2, Lock, Plus, Plug, FolderSync, ClipboardPaste, Network, ChevronRight, ChevronLeft, ShieldCheck, Send, Terminal, Sparkles, CircleAlert, RefreshCw, FileUp, Wallet, BellRing, BellOff, Search, Trash2, ArrowUpRight, Unplug, Smartphone } from 'lucide-react';
import { api, runTool, useApi } from '../lib/api';
import { navigate, useQuery } from '../lib/router';
import { openSignIn } from '../lib/actions';
import { PROVIDER_ALIAS, tidy } from '../lib/words';
import { looksLikeToken } from '../lib/token';
import { qr } from '../lib/qr';
import { A, act, Badge, Button, Card, Chip, confirmDialog, CopyButton, HoverCard, IconCircle, Illustration, Modal, PageHeader, Skeleton, StatusMark, SwitchRow, cx, toast } from '../ui';
import { connectAgent, type AgentInfo } from './AgentConnect';
import { BrandLogo } from '../brand/BrandLogo';
import { LOGOS as BRAND_ICONS } from '../brand/logos.generated';
import { StoredSecrets } from './Vault';
import { call } from './servers/Xray';
import { CoolifyConnectModal } from './servers/CoolifyTile';
import type { Me } from '../App';
import { LifecycleMenu, useArchived } from './lifecycle';
import { logoOf, type Asset, type MapData } from './map/data';
import { GuideCard } from './guide/Guide';
import { BudgetAlertButton, ExportSteps, SpendByDay, SpikeBanner } from './clouds';
import { Choices } from './choices';
import { pick } from '../lib/choices';

interface Account { id: string; name: string; status: string; pending: string | null; finishUrl: string | null; phoneApprovals?: boolean
  alert?: { state: 'verified' | 'waiting' | 'failing'; at: string | null; why: string | null; proof?: string | null; testUntil?: string | null } } // alert channels: did a test get through
interface Conn {
  id: string; name: string; group: string; what: string;
  method: 'mcp' | 'github-app' | 'openrouter' | 'key' | 'local' | 'ntfy'; cli?: boolean; cliName?: string; file?: boolean; // cliName: whose sign-in on this Mac (gcloud, AWS CLI…)
  keyUrl?: string; hint?: string; pattern?: string;
  accounts: Account[];
}
type View = 'accounts' | 'connect';

// the server's groups, re-cut the way people think about them
const GROUPS: { key: string; title: string; sub?: string }[] = [
  { key: 'hosting', title: 'Hosting & apps', sub: 'Where your apps and servers live.' },
  { key: 'clouds', title: 'Big clouds', sub: 'Google Cloud, Firebase, AWS and Azure, without their consoles.' },
  { key: 'dns', title: 'Domains & DNS', sub: 'Where your domains are registered.' },
  { key: 'db', title: 'Databases' },
  { key: 'code', title: 'Code' },
  { key: 'ai', title: 'AI models', sub: 'Only for the ask box on an API key. Your Claude or Google sign-in needs none.' },
  { key: 'alerts', title: 'Alerts', sub: 'A buzz on your phone when something needs you.' },
  { key: 'backup', title: 'Backup storage', sub: 'An encrypted copy of every backup, away from its server.' },
  { key: 'more', title: 'More for your apps', sub: 'Your AI uses these through Unit7.' },
];
const MOVE: Record<string, string> = { gcp: 'clouds', firebase: 'clouds', aws: 'clouds', azure: 'clouds', cloudflare: 'dns', godaddy: 'dns', porkbun: 'dns', namecom: 'dns', namecheap: 'dns', squarespace: 'dns', planetscale: 'db', turso: 'db', upstash: 'db' };
const FROM_SERVER: Record<string, string> = { 'Servers & domains': 'hosting', Code: 'code', 'AI models': 'ai', Alerts: 'alerts', Databases: 'db', 'More services': 'more' };
const groupOf = (c: Conn) => MOVE[c.id] ?? FROM_SERVER[c.group] ?? 'more';
// a tile that stands for more than one service shows both logos
const LOGOS: Record<string, string[]> = { webhook: ['slack', 'discord'] };
// where a newbie should start: code, a home for the app, a domain's DNS, alerts on the phone
const RECOMMENDED = new Set(['github', 'hostinger', 'cloudflare', 'ntfy']);
// words people search with that a tile's own text doesn't say
const KEYWORDS: Record<string, string> = { aws: 'amazon s3 ec2 cloudfront', azure: 'microsoft', gcp: 'google gcloud', firebase: 'google', ntfy: 'phone push notifications', webhook: 'slack discord teams chat', github: 'git repo', anthropic: 'claude', google: 'ai studio', hetzner: 'vps server' };
// the big clouds: a sign-in this Mac has (gcloud, the AWS CLI…), picked from a list, or a key
const CLOUD = new Set(['gcp', 'firebase', 'aws', 'azure']);
// a quiet red text button for the one thing in a pop-up you can't take back
const DANGER = 'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-bad transition hover:bg-bad/10 disabled:opacity-50';
const GRID = 'stagger grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 min-[105rem]:grid-cols-6';
// the sign-in tab tells the Unit7 tab it started from how it went (that tab's pop-up is waiting for it)
const SIGNIN = 'unit7.signin';

const live = (c: Conn) => c.accounts.filter((a) => !a.pending);
// connected, for the counts: an alert channel only once a test got through
const counts = (c: Conn) => live(c).some((a) => !a.alert || a.alert.state === 'verified');
// "Vercel · sam" reads as "sam" where the provider is already named
const short = (name: string, provider: string) => (name.startsWith(`${provider} · `) ? name.slice(provider.length + 3) : name);

export function Connections({ me }: { me: Me }) {
  const q = useQuery();
  const list = useApi<Conn[]>('/api/connections', { live: (e) => e.type.startsWith('account.') });
  const [pop, setPop] = useState<{ id: string; view: View } | null>(null);
  const human = me.role !== 'agent';

  const [justConnected, setJustConnected] = useState<string | null>(null);
  useEffect(() => {
    // only right after a sign-in this browser started: a link from anywhere else can't put words on Unit7's page
    let started = 0; try { started = Number(localStorage.getItem('unit7.connecting') ?? 0); localStorage.removeItem('unit7.connecting'); } catch { /* none */ }
    const fresh = Date.now() - started < 30 * 60_000;
    const ok = fresh ? q.get('connected') : null, err = fresh ? q.get('oauth_error') : null;
    if (ok || err) { try { const ch = new BroadcastChannel(SIGNIN); ch.postMessage(ok ? { ok } : { err }); ch.close(); } catch { /* it still updates live */ } }
    if (ok) { toast('ok', `${ok} is connected`, 'Unit7 keeps it signed in for you.'); setJustConnected(ok); }
    if (err) toast('bad', 'That sign-in didn’t finish', tidy(err));
    if (q.get('connected') || q.get('oauth_error')) navigate('/connections', { replace: true });
    // this is the sign-in tab: the Unit7 tab you started from already updated live, so close this one
    if (ok) setTimeout(() => window.close(), 1800);
  }, []);

  // links like /connections#alerts land on their group once the tiles are there
  useEffect(() => { if (list.data && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' }); }, [!!list.data]);
  // /connections?connect=vercel (Connect on the Start free page) opens that provider's connect pop-up
  useEffect(() => {
    const id = q.get('connect');
    if (!id || !list.data) return;
    if (list.data.some((c) => c.id === id)) setPop({ id, view: 'connect' });
    navigate('/connections', { replace: true });
  }, [!!list.data]);

  // find a service by name, what it's for, or a word people use for it ("amazon", "phone")
  const [find, setFind] = useState('');
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === '/' && !(e.target as HTMLElement)?.closest('input, textarea, [contenteditable], dialog')) { e.preventDefault(); findRef.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const words = find.trim().toLowerCase();
  const shows = (c: Conn) => !words || [c.name, c.id, c.what, KEYWORDS[c.id] ?? '', GROUPS.find((g) => g.key === groupOf(c))?.title ?? ''].join(' ').toLowerCase().includes(words);

  const all = list.data ?? [];
  const count = all.filter(counts).length;
  const matches = all.filter(shows).length;
  return (
    <div className="space-y-10">
      <PageHeader title="Connections" subtitle="One click each. Keys stay locked on this Mac, and your AI never sees them."
        actions={list.data && <>
          <Chip className="tabular"><StatusMark state={count ? 'ok' : 'off'} size={16} label={count ? 'Connected' : 'Nothing connected yet'} />{count} connected</Chip>
          <Button variant="soft" size="sm" icon={<Network size={14} />} onClick={() => navigate('/map')}>How it’s wired</Button>
        </>} />
      {justConnected && (
        <div role="status" className="animate-rise -mt-6 flex items-center gap-3 rounded-[20px] bg-ok/10 px-4 py-3 text-[14px]">
          <StatusMark state="ok" size={28} solid />
          <span className="flex-1"><b>{justConnected}</b> is connected. You can close this tab.</span>
          <Button size="sm" variant="ghost" onClick={() => setJustConnected(null)}>Dismiss</Button>
        </div>
      )}

      <div className="-mt-4 space-y-5">
        <label className="flex h-12 items-center gap-2.5 rounded-full border border-line bg-surface px-4 shadow-soft transition focus-within:border-blue focus-within:ring-4 focus-within:ring-blue-soft">
          <Search size={17} className="shrink-0 text-muted" aria-hidden />
          <span className="sr-only">Find a service</span>
          <input ref={findRef} type="search" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setFind(''); }}
            placeholder="Find a service: Google, AWS, Stripe, Slack…" autoComplete="off" spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-muted focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden" />
          {find ? <button type="button" onClick={() => { setFind(''); findRef.current?.focus(); }} className="shrink-0 rounded-full px-2 text-[12.5px] font-medium text-ink-2 hover:text-ink">Clear</button>
            : <kbd aria-hidden className="hidden h-6 shrink-0 place-items-center rounded-[8px] border border-line px-2 font-mono text-[12px] text-muted sm:grid">/</kbd>}
        </label>
        {!words && list.data && !count && <NothingConnected />}
        {!words && <GuideCard onConnect={(id) => setPop({ id, view: 'connect' })} />}
        {!words && list.data && <FoundForYou conns={all} human={human} onConnect={(c) => setPop({ id: c.id, view: 'connect' })} />}
      </div>

      {words && list.data && !matches && (
        <div className="animate-rise flex flex-wrap items-center gap-4 rounded-[24px] border border-line bg-surface p-5 shadow-soft">
          <IconCircle><Search size={18} /></IconCircle>
          <p className="min-w-0 grow basis-[220px] text-[14px]">Nothing here matches “{find.trim()}”. <span className="text-muted">Ask on Home: Unit7 may still reach it through your AI or a server.</span></p>
          <Button variant="soft" onClick={() => setFind('')}>Show everything</Button>
        </div>
      )}

      {!words && <YourAI human={human} />}

      {!list.data ? <TilesSkeleton /> : list.error && !all.length ? <LoadError reload={list.reload} /> : GROUPS.map((g) => {
        const items = all.filter((c) => groupOf(c) === g.key && shows(c));
        if (g.key === 'backup') return !words || `${g.title} ${g.sub} drive dropbox icloud s3 r2`.toLowerCase().includes(words) ? <Group key={g.key} id={g.key} title={g.title} sub={g.sub}><BackupTiles human={human} /></Group> : null;
        if (!items.length) return null;
        return (
          <Group key={g.key} id={g.key} title={g.title} sub={g.sub} on={items.filter(counts).length} of={items.length}
            more={g.key === 'dns' ? <A href="/email" className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-blue-text hover:underline">Email for your domains: sending and forwards<ArrowUpRight size={13} /></A> : undefined}>
            {items.map((c) => (c.group === 'Alerts' ? <AlertTile key={c.id} c={c} human={human} quiet={!!pop} onOpen={(view) => setPop({ id: c.id, view })} />
              : <Tile key={c.id} c={c} human={human} quiet={!!pop} onOpen={(view) => setPop({ id: c.id, view })} />))}
            {g.key === 'hosting' && (!words || 'coolify'.includes(words)) && <CoolifyTiles human={human} />}
          </Group>
        );
      })}

      {!words && <details className="group rounded-[24px] border border-line bg-surface shadow-soft">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-[24px] p-5 text-[14px] font-medium text-ink-2 transition hover:text-ink [&::-webkit-details-marker]:hidden">
          <IconCircle size={36}><Lock size={16} /></IconCircle>
          <span className="flex-1">Stored secrets <span className="font-normal text-muted">· advanced</span></span>
          <ChevronRight size={16} className="text-muted transition-transform group-open:rotate-90" />
        </summary>
        <div className="border-t border-line p-5"><StoredSecrets me={me} /></div>
      </details>}

      <ProviderPop c={all.find((x) => x.id === pop?.id)} view={pop?.view ?? 'accounts'} human={human} reload={list.reload}
        setView={(view) => setPop((p) => p && { ...p, view })} onClose={() => setPop(null)} />
    </div>
  );
}

// a small ring for "2 of 9 connected"
function Ring({ value }: { value: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line-strong)" strokeWidth="2.5" />
      {value > 0 && <circle cx="8" cy="8" r="6" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinecap="round" pathLength={100} strokeDasharray={`${value * 100} 100`} />}
    </svg>
  );
}

function Group({ id, title, sub, on, of, more, children }: { id: string; title: string; sub?: string; on?: number; of?: number; more?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-6 space-y-3.5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-1">
        <div className="min-w-0">
          <h2 id={`${id}-h`} className="text-[17px] font-semibold tracking-[-0.025em]">{title}</h2>
          {sub && <p className="mt-0.5 text-[13px] text-muted">{sub}</p>}
          {more}
        </div>
        {of !== undefined && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted tabular" aria-label={`${on} of ${of} connected`}><Ring value={(on ?? 0) / of} />{on} of {of}</span>}
      </div>
      <div className={GRID}>{children}</div>
    </section>
  );
}

function TilesSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading connections">
      <Skeleton className="h-6 w-48" />
      <div className={GRID}>{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="h-[112px] rounded-[22px]" />)}</div>
    </div>
  );
}

function LoadError({ reload }: { reload: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-[24px] border border-line bg-surface p-5 shadow-soft">
      <IconCircle tone="bad"><CircleAlert size={20} /></IconCircle>
      <p className="min-w-0 grow basis-[220px] text-[14px]">Couldn’t load your connections. <span className="text-muted">Is Unit7 still running?</span></p>
      <Button variant="soft" onClick={reload}>Try again</Button>
    </div>
  );
}

// --- one tile ---------------------------------------------------------------------------------------
function Logo({ id, name, small }: { id: string; name: string; small?: boolean }) {
  const ids = LOGOS[id] ?? [id];
  return (
    <span className={cx('relative grid shrink-0 place-items-center bg-raised', small ? 'size-9 rounded-full' : 'size-12 rounded-[16px]')}>
      {ids.length === 1 ? <BrandLogo id={id} size={small ? 18 : 24} title={name} />
        : <span className="flex -space-x-1.5" role="img" aria-label={name}>{ids.map((x) => <span key={x} className={cx('grid place-items-center rounded-full bg-surface ring-2 ring-raised', small ? 'size-[18px]' : 'size-[22px]')}><BrandLogo id={x} size={small ? 11 : 14} /></span>)}</span>}
    </span>
  );
}

// the provider's own colour, read from its logo, for a faint tint when you point at its tile (a black-and-white logo
// tints with ink; white and black themselves are skipped)
function brandTint(id: string): string | undefined {
  const icon = BRAND_ICONS[PROVIDER_ALIAS[id] ?? id];
  if (!icon) return undefined;
  if (icon.mono) return 'var(--ink)';
  return icon.body.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)?.find((h) => !/^#(?:f{3}|f{6}|0{3}|0{6})$/i.test(h));
}
// what a service unlocks, in its first sentence, for the faint line under a tile's name
const firstSentence = (what: string) => tidy(what).split(/(?<=\.)\s/)[0]!.replace(/\.$/, '');

// The face every tile shares: the logo (with a status mark on its corner once something's connected), the name, one
// quiet line (whose accounts, a state, or what it unlocks), and what sits top right (Connect, or a plus on hover).
// The name is the button that opens it (stretched over the whole tile); what's top right sits above it.
function Face({ logo, mark, name, sub, subTone, hint, label, onOpen, side, brand, pop }: {
  logo: ReactNode; mark?: ReactNode; name: string; sub?: ReactNode; subTone?: string; hint?: string; label?: string; onOpen?: () => void; side?: ReactNode; brand?: string; pop?: boolean;
}) {
  return (
    <div style={brand ? { ['--brand' as string]: brand } : undefined}
      className={cx('ctile relative flex min-h-[112px] flex-col justify-between gap-3 rounded-[22px] border border-line bg-surface p-4 shadow-soft', onOpen && 'lift', pop && 'ctile-pop')}>
      <div className="flex items-start justify-between gap-2">
        <span className="relative shrink-0">
          {logo}
          {mark && <span className="absolute -bottom-1.5 -right-1.5 grid place-items-center rounded-full bg-surface p-[2px] shadow-soft">{mark}</span>}
        </span>
        {side && <div className="relative z-10 flex items-center gap-1.5">{side}</div>}
      </div>
      <div className="min-w-0">
        {onOpen
          ? <button type="button" onClick={onOpen} aria-label={label} className="block max-w-full truncate text-left text-[14.5px] font-semibold tracking-[-0.01em] text-ink outline-none after:absolute after:inset-0 after:rounded-[22px] focus-visible:after:ring-2 focus-visible:after:ring-blue">{name}</button>
          : <p className="truncate text-[14.5px] font-semibold tracking-[-0.01em]">{name}</p>}
        {/* one line high, the same as the accounts' initials, so names line up across a row */}
        {sub && (typeof sub === 'string' ? <p className={cx('mt-0.5 truncate text-[12.5px] leading-[22px]', subTone ?? 'text-muted')}>{sub}</p> : sub)}
        {hint && !sub && <p className="mt-0.5 truncate text-[12px] leading-[22px] text-faint" title={hint}>{hint}</p>}
      </div>
    </div>
  );
}

// "Connect": a calm outlined pill with a plug that fills in when you point at its tile
const ConnectPill = ({ onClick, label, text = 'Connect', icon, busy }: { onClick: () => void; label: string; text?: string; icon?: ReactNode; busy?: boolean }) => (
  <button type="button" onClick={onClick} aria-label={label} title={label} disabled={busy}
    className="connect-pill inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full pl-2.5 pr-3 text-[12.5px] font-medium disabled:opacity-60 max-sm:w-8 max-sm:p-0">
    {busy ? <Loader2 size={13} className="animate-spin" /> : icon ?? <Plug size={13} />}<span className="max-sm:sr-only">{text}</span>
  </button>
);
// "Add another": a quiet plus on a connected tile, there when you point at the tile or tab to it
const AddAnother = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" onClick={onClick} aria-label={label} title={label}
    className="grid size-8 shrink-0 place-items-center rounded-full text-muted opacity-0 transition hover:bg-raised hover:text-ink focus-visible:opacity-100 [.ctile:hover_&]:opacity-100 [@media(hover:none)]:hidden">
    <Plus size={16} />
  </button>
);
const Done = ({ label = 'Connected', size = 22 }: { label?: string; size?: number }) => <StatusMark state="ok" size={size} label={label} />;

// One more account arrived (and no pop-up is covering the tile): the mark draws in again and the tile pulses once.
function useGrew(n: number, quiet: boolean) {
  const seen = useRef(n);
  const [beat, setBeat] = useState(0);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (quiet) return;
    if (n > seen.current) { setBeat((b) => b + 1); setOn(true); setTimeout(() => setOn(false), 900); }
    seen.current = n;
  }, [n, quiet]);
  return { beat, on };
}

function Tile({ c, human, quiet, onOpen }: { c: Conn; human: boolean; quiet: boolean; onOpen: (view: View) => void }) {
  const accounts = live(c);
  const n = accounts.length;
  const bad = accounts.some((a) => a.status === 'failing');
  const pending = c.accounts.some((a) => a.pending);
  const canAdd = human && c.method !== 'local' && !(c.method === 'ntfy' && n);
  const grew = useGrew(n, quiet);
  const sub = pending ? 'Pick repos to finish' : c.method === 'local' ? 'Not running' : c.cli ? 'Signed in on this Mac' : RECOMMENDED.has(c.id) ? 'Recommended' : undefined;
  return (
    <Face logo={<Logo id={c.id} name={c.name} />} brand={brandTint((LOGOS[c.id] ?? [c.id])[0]!)} pop={grew.on} name={c.name}
      mark={n > 0 ? <StatusMark key={grew.beat} state={bad ? 'bad' : 'ok'} size={18} label={bad ? 'Sign-in expired' : 'Connected'} /> : pending ? <StatusMark state="warn" size={18} label="Almost connected" /> : undefined}
      sub={n ? <Who c={c} accounts={accounts} bad={bad} onOpen={() => onOpen('accounts')} /> : sub}
      subTone={pending || c.cli ? 'text-blue-text' : RECOMMENDED.has(c.id) ? 'text-ink-2' : undefined}
      hint={n ? undefined : firstSentence(c.what)}
      label={[c.name, n ? `${n} account${n > 1 ? 's' : ''}` : 'not connected', bad ? 'Sign-in expired' : !n && sub].filter(Boolean).join(', ')}
      onOpen={() => onOpen(n ? 'accounts' : 'connect')}
      side={n > 0 ? canAdd && <AddAnother onClick={() => onOpen('connect')} label={`Add another ${c.name} account`} />
        : canAdd && <ConnectPill onClick={() => onOpen('connect')} label={`Connect ${c.name}`} text={pending ? 'Finish' : 'Connect'} />} />
  );
}

// Whose accounts these are, quietly under the name: a little stack of initials and "2 accounts" (or the one account's
// name). Hover (or focus, or a tap) shows them all; clicking opens the tile's accounts.
const INITIAL = ['#E8EEFF:#1F4FD8', '#EEF9D6:#3F5A00', '#EFE9FF:#5B3CC4', '#FFF0DE:#9A4A00', '#E6F6F3:#0F6E5C'];
function Who({ c, accounts, bad, onOpen }: { c: Conn; accounts: Account[]; bad: boolean; onOpen: () => void }) {
  const n = accounts.length;
  const one = short(accounts[0]!.name, c.name);
  return (
    <HoverCard content={(
      <div className="min-w-[180px] space-y-1.5">
        <p className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">{c.name}</p>
        {accounts.map((a) => (
          <p key={a.id} className="flex items-center gap-2 text-[13px]">
            <StatusMark state={a.status === 'failing' ? 'bad' : 'ok'} size={14} label={a.status === 'failing' ? 'Sign-in expired' : 'Connected'} />
            <span className="min-w-0 flex-1 truncate">{short(a.name, c.name)}</span>
            {a.status === 'failing' && <span className="shrink-0 text-[12px] text-bad">expired</span>}
          </p>
        ))}
      </div>
    )}>
      <button type="button" onClick={onOpen} aria-label={`${n} ${c.name} account${n > 1 ? 's' : ''}${bad ? ', one needs signing in again' : ''}`}
        className="relative z-10 -ml-1 mt-0.5 inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2 text-[12.5px] text-muted transition hover:bg-raised hover:text-ink">
        <span aria-hidden className="flex shrink-0 -space-x-1.5">
          {accounts.slice(0, 3).map((a, i) => {
            const [bg, fg] = INITIAL[i % INITIAL.length]!.split(':');
            return <span key={a.id} className="grid size-[18px] place-items-center rounded-full text-[10px] font-semibold uppercase ring-2 ring-surface" style={{ background: bg, color: fg }}>{short(a.name, c.name).replace(/[^a-z0-9]/gi, '').charAt(0) || '·'}</span>;
          })}
        </span>
        <span className={cx('truncate', bad && 'font-medium text-bad')}>{bad ? 'Sign-in expired' : n > 1 ? `${n} accounts` : one === c.name ? 'Connected' : one}</span>
      </button>
    </HoverCard>
  );
}

// --- the pop-up for a tile: its accounts, or how to connect one --------------------------------------------
function ProviderPop({ c, view, human, reload, setView, onClose }: { c?: Conn; view: View; human: boolean; reload: () => void; setView: (v: View) => void; onClose: () => void }) {
  const has = !!c && live(c).length > 0;
  return (
    <Modal open={!!c} onClose={onClose} title={c && <span className="flex items-center gap-3"><Logo id={c.id} name={c.name} />{c.name}</span>}>
      {c && (c.id === 'ntfy' ? <PhoneAlerts key={c.id} c={c} human={human} reload={reload} onClose={onClose} /> : view === 'accounts' && has
        ? <Accounts key={c.id} c={c} human={human} reload={reload} onAdd={() => setView('connect')} onClose={onClose} />
        : <Connect key={c.id} c={c} human={human} onBack={has ? () => setView('accounts') : undefined} onDone={onClose} />)}
    </Modal>
  );
}

function Accounts({ c, human, reload, onAdd, onClose }: { c: Conn; human: boolean; reload: () => void; onAdd: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const accounts = live(c);
  const things = useAccountThings();
  const verify = async (a: Account) => {
    setBusy(`v${a.id}`);
    const r = await act('account.verify', { accountId: a.id });
    if (r) r.output?.status === 'verified' ? toast('ok', `${short(a.name, c.name)} works`) : toast('bad', `${short(a.name, c.name)} isn’t working`, r.output?.problem && tidy(r.output.problem), { action: c.method !== 'ntfy' && c.method !== 'local' ? { label: 'Reconnect', onClick: onAdd } : undefined });
    setBusy(null);
    reload();
  };
  const remove = async (a: Account) => {
    if (!(await confirmDialog({ title: `Remove ${a.name}?`, body: 'Unit7 forgets this sign-in. Anything that uses it loses access until you connect it again.', confirm: 'Remove', danger: true }))) return;
    setBusy(`d${a.id}`);
    if (await act('account.disconnect', { accountId: a.id }, { success: `${a.name} removed` })) { reload(); if (accounts.length === 1) onClose(); }
    setBusy(null);
  };
  return (
    <div className="space-y-5">
      <p className="text-[14px] text-muted">{tidy(c.what)}</p>
      <ul className="space-y-2" aria-label="Accounts">
        {accounts.map((a) => {
          const bad = a.status === 'failing';
          return (
            <li key={a.id} className="animate-rise flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[18px] bg-raised p-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface"><BrandLogo id={(LOGOS[c.id] ?? [c.id])[0]!} size={18} /></span>
              <span className="min-w-0 flex-1 basis-[150px]">
                <span className="block truncate text-[14px] font-medium" title={a.name}>{short(a.name, c.name)}</span>
                {a.alert ? <AlertLine c={c} al={a.alert} /> : <span className={cx('flex items-center gap-1.5 text-[12.5px]', bad ? 'text-bad' : 'text-ok')}><StatusMark state={bad ? 'bad' : 'ok'} size={14} label={bad ? 'Sign-in expired' : 'Connected'} />{bad ? 'Sign-in expired' : 'Connected'}</span>}
              </span>
              {/* a sign-in that stopped working is a decision: the choice row, Reconnect recommended */}
              {human && bad && c.method !== 'local' && c.method !== 'ntfy' && (
                <Choices className="basis-full pl-12" label={`${short(a.name, c.name)} stopped working`} disabled={!!busy}
                  choices={pick([{ key: 'reconnect', label: 'Reconnect', recommended: true, why: `${c.name} stopped accepting this sign-in, and a fresh one fixes it` },
                    { key: 'check', label: 'Check again', look: true }, { key: 'remove', label: 'Remove it' }])}
                  onPick={(ch) => { if (ch.key === 'reconnect') onAdd(); else if (ch.key === 'check') void verify(a); else void remove(a); return true; }} />
              )}
              {human && c.method !== 'local' && !(bad && c.method !== 'ntfy') && (
                <span className="flex shrink-0 items-center gap-1">
                  {bad && c.method !== 'ntfy'
                    ? <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} onClick={onAdd}>Reconnect</Button>
                    : <Button size="sm" variant="secondary" icon={a.alert ? <Send size={13} /> : <ShieldCheck size={13} />} loading={busy === `v${a.id}`} disabled={!!busy} onClick={() => verify(a)}>{a.alert ? 'Send a test' : 'Check'}</Button>}
                  <button type="button" className={DANGER} disabled={!!busy} onClick={() => remove(a)}>{busy === `d${a.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}Remove</button>
                </span>
              )}
              <AccountThings a={a} human={human} things={things} />
            </li>
          );
        })}
      </ul>
      {c.method === 'local' && <p className="text-[13px] text-muted">Found on this Mac. Its models show up in the ask box on Home.</p>}
      {BILLED.has(c.id) && accounts.filter((a) => a.status !== 'failing').map((a) => <CloudBill key={a.id} a={a} many={accounts.length > 1} provider={c.id} />)}
      {human && c.method !== 'local' && c.method !== 'ntfy' && <Button variant="soft" icon={<Plus size={15} />} onClick={onAdd}>Add another account</Button>}
    </div>
  );
}

// What an account holds (its apps, sites and databases, from the map's last sync), folded under its row. Each has the
// "…" menu, so a project made just to try something can be archived or deleted right here, after seeing what it affects.
const PROJECT_KINDS = new Set(['app', 'database', 'project', 'service']);
function useAccountThings() {
  const [m, setM] = useState<MapData | null>(null);
  const load = () => { void runTool('map.get', { includeArchived: true }).then((r) => setM(r.status === 'ok' ? r.output as MapData : null), () => setM(null)); };
  useEffect(load, []);
  return { m, reload: load };
}
function AccountThings({ a, human, things }: { a: Account; human: boolean; things: ReturnType<typeof useAccountThings> }) {
  const [open, setOpen] = useState(false);
  const { has } = useArchived();
  const mine = (things.m?.assets ?? []).filter((x: Asset) => PROJECT_KINDS.has(x.kind) && (x.account === a.name || x.also?.some((y) => y.accountId === a.id)));
  if (!mine.length) return null;
  return (
    <div className="basis-full pl-12">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-full px-1.5 text-[12.5px] font-medium text-ink-2 transition hover:text-ink">
        <ChevronRight size={14} className={cx('transition-transform', open && 'rotate-90')} />{mine.length} project{mine.length === 1 ? '' : 's'} in it
      </button>
      {open && (
        <ul className="animate-rise mt-1 divide-y divide-line rounded-[14px] bg-surface">
          {mine.map((x) => (
            <li key={x.id} className="flex items-center gap-2.5 py-1.5 pl-3 pr-1.5">
              <BrandLogo id={logoOf(x)} size={15} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{x.name}</span>
                {x.url && <span className="block truncate text-[11.5px] text-muted">{x.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>}
              </span>
              {has(x.id) && <Badge>Archived</Badge>}
              {human && <LifecycleMenu item={{ key: x.id, name: x.name, kind: x.kind, provider: x.provider }} onChanged={things.reload} label={`Archive or delete ${x.name}`}
                className="grid size-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// How to connect one, in place: a token to paste, a sign-in this Mac has, or the provider's own sign-in in a new tab.
// Any new working account for this provider while it's open (it arrives live) is the success moment.
function Connect({ c, human, onBack, onDone }: { c: Conn; human: boolean; onBack?: () => void; onDone: () => void }) {
  const working = live(c).filter((a) => a.status !== 'failing');
  const known = useRef<Set<string> | null>(null);
  if (!known.current) known.current = new Set(working.map((a) => a.id));
  const [done, setDone] = useState<string | null>(null);
  const fresh = working.find((a) => !known.current!.has(a.id))?.id;
  useEffect(() => { if (fresh && !done) setDone(fresh); }, [fresh]);
  const [mode, setMode] = useState<'cli' | 'key' | 'signin'>(c.cli ? 'cli' : c.method === 'key' ? 'key' : 'signin');
  const pending = c.accounts.find((a) => a.pending);
  const connected = (id: string) => setDone(id || 'yes');
  if (done) return <Connected name={c.accounts.find((a) => a.id === done)?.name ?? c.name} onDone={onDone} {...(c.group === 'Alerts' && { note: 'Unit7 sent a test message there. Check it arrived.', done: 'It arrived' })} />;

  const link = (label: string, to: typeof mode) => <button type="button" onClick={() => setMode(to)} className="rounded-full text-[13px] font-medium text-blue-text hover:underline">{label}</button>;
  let body: ReactNode;
  if (!human) body = <p className="text-[13.5px] text-muted">An owner or admin can connect this.</p>;
  else if (c.method === 'local') body = (
    <div className="space-y-3">
      <p className="text-[13.5px] text-ink-2">Unit7 finds it by itself while Ollama is open on this Mac.</p>
      <a href="https://ollama.com/download" target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-1.5 rounded-full bg-raised px-4 text-[13.5px] font-medium text-ink transition hover:bg-sunken">Get Ollama <ExternalLink size={13} /></a>
    </div>
  );
  else if (pending?.finishUrl) body = (
    <div className="space-y-3 rounded-[20px] bg-raised p-4">
      <p className="text-[14px] font-medium">One step left: pick which repos Unit7 may deploy.</p>
      <a href={pending.finishUrl} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-1.5 rounded-full bg-blue px-4.5 text-[13.5px] font-medium text-white transition hover:brightness-110">Finish on GitHub <ExternalLink size={13} /></a>
      <Waiting what="GitHub" />
    </div>
  );
  else if (mode === 'cli' && CLOUD.has(c.id)) body = <SignInPicker c={c} onConnected={connected} onKey={() => setMode('key')} />;
  else if (mode === 'cli') body = <CliOneClick c={c} onConnected={connected} other={c.method !== 'key' && link(`Sign in on ${c.name} instead`, 'signin')} />;
  else if (mode === 'key' && c.keyUrl) body = <TokenPaste c={c} onConnected={connected}
    other={CLOUD.has(c.id) ? link('Use a sign-in on this Mac instead', 'cli') : c.method !== 'key' ? link(`Sign in with ${c.name} instead`, 'signin') : null} />;
  else body = <SignIn c={c} other={c.keyUrl && link('Use a token instead', 'key')} />;

  return (
    <div className="space-y-5">
      {onBack && <button type="button" onClick={onBack} className="-ml-1 -mt-2 inline-flex h-8 items-center gap-1 rounded-full pl-1 pr-3 text-[12.5px] font-medium text-muted transition hover:bg-raised hover:text-ink"><ChevronLeft size={15} />Accounts</button>}
      <p className="text-[14px] text-muted">{tidy(c.what)}</p>
      {body}
    </div>
  );
}

const BURST = ['#c6f432', '#1f5bff', '#8b5cf6', '#c6f432', '#26b5f0', '#1f5bff', '#d16bf5', '#c6f432'];
function Connected({ name, onDone, title = 'Connected', note, done = 'Done' }: { name: string; onDone: () => void; title?: string; note?: string; done?: string }) {
  return (
    <div role="status" className="flex flex-col items-center px-2 pb-2 pt-3 text-center">
      <span className="relative grid size-24 place-items-center">
        <span aria-hidden className="burst absolute inset-0">{BURST.map((col, i) => <i key={i} style={{ background: col, ['--a' as string]: `${i * 45 + 20}deg`, animationDelay: `${140 + (i % 3) * 40}ms` }} />)}</span>
        <StatusMark state="ok" size={64} solid />
      </span>
      <p className="mt-3 text-[18px] font-semibold tracking-[-0.02em]">{title}</p>
      <p className="mt-0.5 max-w-full truncate text-[14px] text-muted">{name}</p>
      {note && <p className="mt-2 max-w-[340px] text-[13px] text-ink-2">{note}</p>}
      <Button variant="primary" className="mt-6 min-w-32" onClick={onDone} autoFocus>{done}</Button>
    </div>
  );
}

const Waiting = ({ what }: { what: string }) => (
  <p role="status" className="flex items-center gap-2 text-[12.5px] text-muted"><Loader2 size={13} className="animate-spin text-blue-text" />Waiting for {what}. This updates by itself.</p>
);

// Paste a token: one sentence on where to get it, the provider's page in a new tab, and a big field with a Paste
// button. A paste that looks like a token is checked and connected straight away; a key that doesn't work isn't kept.
function TokenPaste({ c, onConnected, other }: { c: Conn; onConnected: (accountId: string) => void; other?: ReactNode }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ bad?: boolean; text: string; anyway?: boolean } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const noun = c.file ? 'key file' : c.id === 'webhook' ? 'webhook link' : 'token';
  const keys = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘V' : 'Ctrl+V';
  // back from the provider's tab: the cursor is waiting in the field
  useEffect(() => { const f = () => field.current?.focus(); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, []);
  const submit = async (t: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await api<{ status: string; problem?: string; accountId?: string }>(`/api/connect/${c.id}/key`, { body: { token: t } });
      if (r.status !== 'failing') return onConnected(r.accountId ?? '');
      if (r.accountId) void runTool('account.disconnect', { accountId: r.accountId }).catch(() => undefined); // nothing half-connected stays behind
      // "Render: unauthorized, invalid API key" reads as "invalid API key" here, where Render is already named
      const why = r.problem && tidy(r.problem).replace(`${c.name}: `, '').replace(/^unauthorized,?\s*/i, '').replace(/[.\s]*$/, '');
      setNote({ bad: true, text: `${c.name} didn’t accept it${why ? `: ${why}` : ''}. Nothing was saved.` });
    } catch (e) { setNote({ bad: true, text: tidy((e as Error).message) }); }
    setBusy(false);
  };
  const take = (text: string, anyway = false) => {
    const t = text.trim();
    setValue(t);
    if (!t || busy) return;
    if (!anyway && !looksLikeToken(t, { pattern: c.pattern, file: c.file })) { setNote({ text: `That doesn’t look like a ${c.name} ${noun}.`, anyway: true }); return; }
    void submit(t);
  };
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (!t.trim()) throw new Error('empty'); take(t); }
    catch { field.current?.focus(); setNote({ text: `Press ${keys} to paste it here.` }); }
  };
  const pick = (f?: File) => { if (f) void f.text().then((t) => take(t)); };
  return (
    <div className="space-y-4" onPaste={(e) => { if ((e.target as HTMLElement).closest('input, textarea')) return; const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); take(t); } }}
      onDragOver={c.file ? (e) => e.preventDefault() : undefined} onDrop={c.file ? (e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); } : undefined}>
      <ol className="space-y-5">
        <li className="flex gap-3">
          <Step n={1} />
          <div className="min-w-0 flex-1 space-y-2.5">
            <p className="text-[14px] font-medium">Get a {noun}</p>
            {c.hint && <p className="text-[13px] text-muted">{tidy(c.hint)}</p>}
            <a href={c.keyUrl} target="_blank" rel="noopener" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-raised px-4 text-[13px] font-medium text-ink transition hover:bg-sunken">Open {c.name} <ExternalLink size={13} /></a>
          </div>
        </li>
        <li className="flex gap-3">
          <Step n={2} />
          <div className="min-w-0 flex-1 space-y-2.5">
            <p className="text-[14px] font-medium">Paste it here</p>
            <div className={cx('flex items-center gap-2 rounded-[18px] border-2 bg-surface p-1.5 pl-3.5 transition focus-within:border-solid focus-within:border-blue focus-within:ring-4 focus-within:ring-blue-soft',
              note?.bad ? 'border-solid border-bad/60' : 'border-dashed border-line-strong')}>
              {busy ? <Loader2 size={16} className="shrink-0 animate-spin text-blue-text" /> : <Lock size={16} className="shrink-0 text-muted" aria-hidden />}
              <label className="min-w-0 flex-1">
                <span className="sr-only">Your {c.name} {noun}</span>
                <input ref={field} type="password" autoComplete="off" spellCheck={false} value={value} readOnly={busy}
                  placeholder={busy ? `Checking it with ${c.name}…` : `Your ${c.name} ${noun}`}
                  onChange={(e) => { setValue(e.target.value); setNote(null); }}
                  onPaste={(e) => { e.preventDefault(); take(e.clipboardData.getData('text')); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') take(value); }}
                  className="h-11 w-full bg-transparent font-mono text-[14px] text-ink outline-none placeholder:font-sans placeholder:text-muted focus-visible:outline-none" />
              </label>
              <Button variant="primary" icon={<ClipboardPaste size={15} />} disabled={busy} onClick={paste}>Paste</Button>
            </div>
            {c.file && (
              <label className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-dashed border-line-strong text-[12.5px] font-medium text-ink-2 transition hover:border-blue hover:text-blue-text focus-within:ring-4 focus-within:ring-blue-soft">
                <FileUp size={13} aria-hidden />Or pick the .json file
                <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
              </label>
            )}
            {note && (
              <p role={note.bad ? 'alert' : 'status'} className={cx('flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[14px] px-3.5 py-2.5 text-[13px]', note.bad ? 'bg-bad/10 text-ink' : 'bg-raised text-ink-2')}>
                {note.bad && <CircleAlert size={15} className="shrink-0 text-bad" aria-hidden />}<span className="min-w-0 flex-1">{note.text}</span>
                {note.anyway && <button type="button" onClick={() => take(value, true)} className="shrink-0 rounded-full font-medium text-blue-text hover:underline">Use it anyway</button>}
              </p>
            )}
            <p className="text-[12px] text-faint">Unit7 checks it with {c.name}, then locks it away. Your AI never sees it.</p>
          </div>
        </li>
      </ol>
      {other && <div className="border-t border-line pt-4">{other}</div>}
    </div>
  );
}
const Step = ({ n }: { n: number }) => <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-[12.5px] font-semibold text-bg">{n}</span>;

// The provider's own sign-in in a new tab; this pop-up waits for it (the new account arrives live, a failure is
// passed back from that tab), so this page never navigates away.
function SignIn({ c, other }: { c: Conn; other?: ReactNode }) {
  const [state, setState] = useState<'idle' | 'waiting' | { err: string }>('idle');
  useEffect(() => {
    if (state !== 'waiting') return;
    let ch: BroadcastChannel | undefined;
    try { ch = new BroadcastChannel(SIGNIN); ch.onmessage = (e) => { if (e.data?.err) setState({ err: tidy(String(e.data.err)) }); }; } catch { /* the account still arrives live */ }
    return () => ch?.close();
  }, [state]);
  const go = () => { setState('waiting'); void openSignIn(c.id, c.name); };
  const how = c.method === 'github-app' ? 'GitHub opens in a new tab. Create the Unit7 app there and pick your repos.'
    : c.method === 'openrouter' ? 'OpenRouter opens in a new tab. Sign in, and Unit7 gets one key for every model.'
    : `${c.name} opens in a new tab. Sign in and allow Unit7.`;
  return (
    <div className="space-y-4">
      {state === 'waiting' ? (
        <div role="status" className="animate-pop flex items-center gap-3.5 rounded-[20px] bg-blue-soft p-4">
          <span className="relative grid size-11 shrink-0 place-items-center rounded-full bg-surface"><Loader2 size={20} className="animate-spin text-blue-text" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium">Waiting for {c.name}…</span>
            <span className="block text-[12.5px] text-muted">Finish in the new tab. This updates by itself.</span>
          </span>
          <span className="flex shrink-0 flex-col gap-1 sm:flex-row">
            <Button size="sm" variant="ghost" onClick={go}>Open again</Button>
            <Button size="sm" variant="ghost" onClick={() => setState('idle')}>Cancel</Button>
          </span>
        </div>
      ) : (
        <>
          {typeof state === 'object' && <p role="alert" className="flex items-start gap-2 rounded-[14px] bg-bad/10 px-3.5 py-2.5 text-[13px]"><CircleAlert size={15} className="mt-0.5 shrink-0 text-bad" />That sign-in didn’t finish: {state.err}</p>}
          <p className="text-[13.5px] text-ink-2">{how} This window updates by itself.</p>
          <Button variant="primary" size="lg" icon={<ArrowUpRight size={17} />} onClick={go}>{typeof state === 'object' ? 'Try again' : c.method === 'github-app' ? 'Continue on GitHub' : `Sign in with ${c.name}`}</Button>
        </>
      )}
      {other && <div className="border-t border-line pt-4">{other}</div>}
    </div>
  );
}

// GitHub with the GitHub CLI already signed in here: one click, no browser
function CliOneClick({ c, onConnected, other }: { c: Conn; onConnected: (accountId: string) => void; other?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { onConnected((await api<{ accountId: string }>(`/api/connect/${c.id}/cli`, { body: {} })).accountId); }
    catch (e) { toast('bad', `Couldn’t connect ${c.name}`, tidy((e as Error).message), { action: { label: 'Try again', onClick: go } }); setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-[20px] bg-raised p-4">
        <IconCircle size={40}><Terminal size={18} /></IconCircle>
        <p className="min-w-0 flex-1 basis-[180px] text-[13.5px]"><b className="font-medium">Signed in on this Mac.</b> <span className="text-muted">Unit7 uses your {c.cliName ?? 'CLI'} sign-in. No browser needed.</span></p>
        <Button variant="primary" loading={busy} onClick={go}>Connect</Button>
      </div>
      {other && <div className="border-t border-line pt-4">{other}</div>}
    </div>
  );
}

// The big clouds: every sign-in this Mac has (two Google accounts in gcloud, several AWS profiles…), each one connected
// on its own and kept to its own account. "Sign in with another Google account" runs gcloud's sign-in in the browser and
// waits for it; the others say what to run in Terminal. A key stays the fallback.
interface SignIns { signIns: { who: string; tool: string; active: boolean; connected: boolean }[]; login?: string }
function SignInPicker({ c, onConnected, onKey }: { c: Conn; onConnected: (accountId: string) => void; onKey: () => void }) {
  const [data, setData] = useState<SignIns | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // whose, or 'login'
  const [note, setNote] = useState<string | null>(null);
  const load = () => api<SignIns>(`/api/connect/${c.id}/signins`).then((d) => { setData(d); setFailed(false); }, () => setFailed(true));
  useEffect(() => { void load(); }, [c.id]);
  const google = c.id === 'gcp' || c.id === 'firebase';
  const kind = google ? 'Google account' : c.id === 'aws' ? 'AWS profile' : 'Azure account';
  const use = async (who: string) => {
    setBusy(who); setNote(null);
    try { return onConnected((await api<{ accountId: string }>(`/api/connect/${c.id}/signin`, { body: { account: who } })).accountId); }
    catch (e) { setNote(tidy((e as Error).message)); void load(); }
    setBusy(null);
  };
  const login = async () => {
    setBusy('login'); setNote(null);
    try {
      const r = await api<SignIns & { added: { accountId: string } | null }>(`/api/connect/${c.id}/login`, { body: {} });
      if (r.added) return onConnected(r.added.accountId);
      setData(r);
      setNote('That Google account was already on this Mac. Pick it below.');
    } catch (e) { setNote(tidy((e as Error).message)); }
    setBusy(null);
  };
  const keyLink = <button type="button" onClick={onKey} className="rounded-full text-[13px] font-medium text-blue-text hover:underline">{google ? 'Use a service-account key instead' : 'Use a key instead'}</button>;
  if (failed) return <div className="space-y-3"><p className="text-[13.5px] text-muted">Couldn’t read the sign-ins on this Mac.</p><div className="flex flex-wrap items-center gap-3"><Button size="sm" variant="soft" onClick={() => void load()}>Try again</Button>{keyLink}</div></div>;
  if (!data) return <div className="space-y-2" aria-busy="true"><Skeleton className="h-[60px] rounded-[18px]" /><Skeleton className="h-[60px] rounded-[18px]" /></div>;
  return (
    <div className="space-y-4">
      {data.signIns.length ? (
        <div className="space-y-2">
          <p className="text-[12px] font-medium uppercase tracking-[0.06em] text-faint">Signed in on this Mac</p>
          <ul className="space-y-2">
            {data.signIns.map((s) => (
              <li key={s.who} className="flex items-center gap-3 rounded-[18px] bg-raised p-3">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-surface text-[14px] font-semibold uppercase text-ink-2">{s.who[0]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium" title={s.who}>{s.who}</span>
                  <span className="block text-[12px] text-muted">{s.connected ? 'Already connected' : `In ${s.tool}${s.active ? ' · active' : ''}`}</span>
                </span>
                {s.connected ? <Done label="Already connected" />
                  : <Button size="sm" variant="primary" loading={busy === s.who} disabled={!!busy} onClick={() => use(s.who)}>Connect</Button>}
              </li>
            ))}
          </ul>
        </div>
      ) : <p className="text-[13.5px] text-ink-2">Nothing is signed in to {c.name} on this Mac yet.</p>}
      {note && <p role="alert" className="flex items-start gap-2 rounded-[14px] bg-raised px-3.5 py-2.5 text-[13px] text-ink-2"><CircleAlert size={15} className="mt-0.5 shrink-0 text-warn" />{note}</p>}
      {data.login === 'browser' ? (
        busy === 'login'
          ? <div role="status" className="animate-pop flex items-center gap-3 rounded-[18px] bg-blue-soft p-3.5 text-[13.5px]"><Loader2 size={17} className="shrink-0 animate-spin text-blue-text" /><span><b className="font-medium">Finish signing in in your browser.</b> <span className="text-muted">This updates by itself.</span></span></div>
          : <Button variant="soft" icon={<Plus size={15} />} disabled={!!busy} onClick={login}>Sign in with {data.signIns.length ? 'another' : 'a'} {kind}</Button>
      ) : data.login && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted">
          To add {data.signIns.length ? 'another' : 'one'}, run
          <span className="inline-flex items-center gap-0.5 rounded-full bg-raised py-0.5 pl-2.5 pr-0.5 font-mono text-[12px] text-ink">{data.login}<CopyButton text={data.login} /></span>
          in Terminal, then <button type="button" onClick={() => void load()} className="rounded-full font-medium text-blue-text hover:underline">check again</button>.
        </p>
      )}
      <div className="border-t border-line pt-4">{keyLink}</div>
    </div>
  );
}

// --- alerts that prove they work --------------------------------------------------------------------------------------
// An alert channel is "connected" only once a test got through: on a phone, the phone tapped "It worked" on a test
// (or the person saw it arrive and said so); in a team chat, the chat took the test message. Until then it's waiting;
// an alert refused later shows it isn't reaching you, with Fix it.
type AlertInfo = NonNullable<Account['alert']>;
const isPhone = (c: Conn) => c.id === 'ntfy';
const onDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
// the state a tile shows: the worst of its accounts
const alertOf = (c: Conn) => {
  const xs = live(c).flatMap((a) => (a.alert ? [a.alert] : []));
  return xs.find((x) => x.state === 'failing') ?? xs.find((x) => x.state === 'waiting') ?? xs[0];
};
function alertWords(c: Conn, al: AlertInfo) {
  if (al.state === 'verified') return { mark: 'ok' as const, text: `Connected · ${isPhone(c) ? 'verified' : 'tested'} on ${onDay(al.at)}`, tone: 'text-ok' };
  if (al.state === 'failing') return { mark: 'bad' as const, text: `Not reaching ${isPhone(c) ? 'your phone' : 'your channel'}`, tone: 'text-bad' };
  return { mark: 'warn' as const, text: isPhone(c) ? 'Waiting for your phone' : 'Not tested yet', tone: 'text-warn' };
}
const AlertLine = ({ c, al }: { c: Conn; al: AlertInfo }) => {
  const w = alertWords(c, al);
  return <span className={cx('flex min-w-0 items-center gap-1.5 text-[12.5px]', w.tone)}><StatusMark state={w.mark} size={14} label={w.text} /><span className="truncate">{w.text}{al.why && `: ${al.why}`}</span></span>;
};

function AlertTile({ c, human, quiet, onOpen }: { c: Conn; human: boolean; quiet: boolean; onOpen: (view: View) => void }) {
  const al = alertOf(c);
  if (!al) return <Tile c={c} human={human} quiet={quiet} onOpen={onOpen} />;
  const w = alertWords(c, al), n = live(c).length;
  return (
    <Face logo={<Logo id={c.id} name={c.name} />} brand={brandTint((LOGOS[c.id] ?? [c.id])[0]!)} name={c.name}
      mark={<StatusMark key={al.state} state={w.mark} size={18} label={w.text} />}
      sub={<p className={cx('line-clamp-2 text-[12.5px] leading-[1.35]', w.tone)} title={w.text}>{n > 1 && al.state === 'verified' ? `${n} channels, all tested` : w.text}</p>}
      label={`${c.name}, ${w.text}`} onOpen={() => onOpen('accounts')}
      side={human && (al.state !== 'verified'
        ? <ConnectPill onClick={() => onOpen('accounts')} label={`${al.state === 'failing' ? 'Fix' : 'Finish setting up'} ${c.name}`} text={al.state === 'failing' ? 'Fix it' : 'Finish'} icon={al.state === 'failing' ? <RefreshCw size={13} /> : undefined} />
        : !isPhone(c) && <AddAnother onClick={() => onOpen('connect')} label={`Add another ${c.name}`} />)} />
  );
}

// A QR code drawn right here (web/src/lib/qr.ts; nothing is sent anywhere to make it). Always dark on white with its
// quiet border, in dark mode too, so any phone camera reads it.
function QrCode({ value, label, size = 152, className }: { value: string; label: string; size?: number; className?: string }) {
  const m = useMemo(() => qr(value), [value]);
  const n = m.length + 8;
  const d = m.flatMap((row, y) => row.map((on, x) => (on ? `M${x + 4} ${y + 4}h1v1h-1z` : ''))).join('');
  return <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className={cx('shrink-0 rounded-[14px] bg-white ring-1 ring-line', className)}><path d={d} fill="#0b0d12" /></svg>;
}

// Phone alerts, in the pop-up: 1 get the ntfy app, 2 subscribe to your private topic, 3 a test that has to arrive.
// The topic is a long random secret: it's shown only here. Connected only after the phone taps "It worked" (Android)
// or you say "I got it" (iPhones show no buttons on alerts). Once connected: its state, a test, approvals, remove.
const STORES = {
  iphone: { label: 'iPhone', store: 'the App Store', url: 'https://apps.apple.com/us/app/ntfy/id1625396347' },
  android: { label: 'Android', store: 'Google Play', url: 'https://play.google.com/store/apps/details?id=io.heckel.ntfy' },
} as const;
type Os = keyof typeof STORES;
const STEPS = ['Get the app', 'Subscribe', 'Test it'];

function PhoneAlerts({ c, human, reload, onClose }: { c: Conn; human: boolean; reload: () => void; onClose: () => void }) {
  const a = live(c)[0];
  const al = a?.alert;
  const pendingTest = !!al?.testUntil && Date.parse(al.testUntil) > Date.now();
  const [step, setStep] = useState<0 | 1 | 2 | 3>(() => (!a || (al?.state === 'waiting' && !pendingTest) ? 1 : al?.state === 'waiting' ? 3 : 0));
  const [os, setOs] = useState<Os>(() => (/Android/i.test(navigator.userAgent) ? 'android' : /iPhone|iPad|Macintosh/i.test(navigator.userAgent) ? 'iphone' : 'android'));
  const [topic, setTopic] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent' | 'error'>(pendingTest ? 'sent' : 'idle');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // the moment the phone answers while this is open: a new proof date arrives live (a test ntfy merely accepted isn't one)
  const seen = useRef(al?.proof ?? null);
  const [cheer, setCheer] = useState(false);
  useEffect(() => { if (al?.state === 'verified' && al.proof && al.proof !== seen.current) setCheer(true); }, [al?.state, al?.proof]);
  // the private topic, made the first time it's needed (asking again gives the same one)
  useEffect(() => {
    if (step < 2 || topic || !human) return;
    api<{ subscribeUrl: string }>('/api/connect/ntfy/setup', { body: {} }).then((r) => { setTopic(r.subscribeUrl); reload(); }, (e) => { toast('bad', 'Couldn’t set up phone alerts', tidy((e as Error).message)); setStep(1); });
  }, [step >= 2]);
  const send = async () => {
    setPhase('sending'); setErr('');
    const r = await runTool('alerts.phone_test', {}).catch((e) => ({ status: 'error' as const, error: { message: (e as Error).message } }));
    if (r.status === 'ok') setPhase('sent'); else { setPhase('error'); setErr(tidy(r.status === 'error' ? r.error.message : 'Unit7 couldn’t send it.')); }
    reload();
  };
  useEffect(() => { if (step === 3 && phase === 'idle' && topic !== null) void send(); }, [step, topic]);
  const gotIt = async () => { setBusy(true); if (await act('alerts.phone_confirm', {})) reload(); setBusy(false); };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Remove phone alerts?', body: 'Unit7 stops sending alerts to your phone and forgets its private topic. You can set it up again any time.', confirm: 'Remove', danger: true }))) return;
    if (a && await act('account.disconnect', { accountId: a.id }, { success: 'Phone alerts removed' })) { reload(); onClose(); }
  };

  if (!human) return <p className="text-[13.5px] text-muted">An owner or admin can set up phone alerts.</p>;
  if (cheer && al) return <Connected title="Your phone gets alerts" name={`Verified on ${onDay(al.at)}`} onDone={onClose} />;
  const name = topic?.split('/').pop() ?? '';
  const deep = `ntfy://ntfy.sh/${name}?display=Unit7`;
  const back = (to: 0 | 1 | 2) => <button type="button" onClick={() => setStep(to)} className="inline-flex h-9 items-center gap-1 rounded-full pl-1.5 pr-3 text-[13px] font-medium text-muted transition hover:bg-raised hover:text-ink"><ChevronLeft size={15} />Back</button>;
  const pickOs = (
    <div role="radiogroup" aria-label="Your phone" className="inline-flex shrink-0 rounded-full bg-raised p-1">
      {(Object.keys(STORES) as Os[]).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={os === k} onClick={() => setOs(k)}
          className={cx('h-8 rounded-full px-3.5 text-[13px] font-medium transition', os === k ? 'bg-surface text-ink shadow-soft' : 'text-muted hover:text-ink')}>{STORES[k].label}</button>
      ))}
    </div>
  );

  // connected (or no longer reaching the phone): where it stands, and what to do
  if (step === 0 && al) {
    const failing = al.state === 'failing';
    return (
      <div className="space-y-4">
        <div className={cx('animate-rise flex flex-wrap items-center gap-3 rounded-[20px] p-4', failing ? 'bg-bad/10' : 'bg-raised')}>
          <StatusMark state={failing ? 'bad' : 'ok'} size={36} label={failing ? 'Not reaching your phone' : 'Connected'} />
          <div className="min-w-0 flex-1 basis-[180px]">
            <p className="text-[15px] font-semibold">{failing ? 'Not reaching your phone' : 'Your phone gets alerts'}</p>
            <p className="text-[13px] text-muted">{failing ? `${al.why ?? 'The last alert was refused'}. Everything still shows in Activity.` : `Connected · verified on ${onDay(al.at)}`}</p>
          </div>
          {failing && <Button variant="primary" icon={<RefreshCw size={14} />} onClick={() => { setPhase('idle'); setStep(3); }}>Fix it</Button>}
        </div>
        {!failing && <Button variant="secondary" icon={<Send size={14} />} onClick={() => { setPhase('idle'); setStep(3); }}>Send a test</Button>}
        <div className="rounded-[20px] border border-line px-4">
          <SwitchRow title="Approve from your phone" body={!al.proof ? 'Turns on once your phone answers a test.' : al.state === 'failing' ? 'Alerts aren’t reaching your phone right now, so these buttons aren’t either.' : '“Waiting for your OK” alerts get Approve and Not now buttons (Android). Nothing on this computer is opened to the internet.'}
            checked={!!a?.phoneApprovals} disabled={!al.proof}
            onChange={async (on) => { if (await act('alerts.phone_approvals', { on }, { success: on ? 'You can approve from your phone now' : 'Phone approvals are off' })) reload(); }} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <button type="button" onClick={() => setStep(1)} className="rounded-full text-[13px] font-medium text-blue-text hover:underline">Set it up on another phone</button>
          <button type="button" className={DANGER} onClick={remove}><Trash2 size={13} />Remove</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ol className="flex items-center gap-2" aria-label="Steps">
        {STEPS.map((s, i) => {
          const n = i + 1, on = n === step, done = n < step;
          return (
            <li key={s} aria-current={on ? 'step' : undefined} className={cx('flex min-w-0 items-center gap-2', n < 3 && 'flex-1')}>
              {done ? <StatusMark state="ok" size={24} solid label="Done" /> : <span className={cx('grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold transition-colors', on ? 'bg-ink text-bg' : 'bg-raised text-muted')}>{n}</span>}
              <span className={cx('truncate text-[12.5px] font-medium', on ? 'text-ink' : 'text-muted max-sm:sr-only')}>{s}</span>
              {n < 3 && <span aria-hidden className="h-px min-w-3 flex-1 bg-line" />}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div key="s1" className="animate-rise space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[16px] font-semibold tracking-[-0.01em]">Get the free ntfy app</p>
              <p className="text-[13px] text-muted">It shows Unit7’s alerts. No account, no ads.</p>
            </div>
            {pickOs}
          </div>
          <div className="flex items-center gap-5 rounded-[20px] bg-raised p-4">
            <QrCode value={STORES[os].url} label={`QR code: ntfy on ${STORES[os].store}`} className="max-sm:hidden" />
            <div className="min-w-0 space-y-3">
              <p className="text-[13.5px] text-ink-2"><span className="max-sm:hidden">Point your phone’s camera at the code, or open the store on your phone.</span><span className="sm:hidden">Install it from {STORES[os].store}.</span></p>
              <a href={STORES[os].url} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink px-4.5 text-[13.5px] font-medium text-bg transition hover:opacity-90">Get it on {STORES[os].store} <ExternalLink size={13} /></a>
            </div>
          </div>
          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" onClick={() => setStep(2)}>I have it: next <ChevronRight size={15} /></Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div key="s2" className="animate-rise space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[16px] font-semibold tracking-[-0.01em]">Subscribe to your private alerts</p>
              <p className="text-[13px] text-muted">Only your phone should have this. Anyone with it could read your alerts.</p>
            </div>
            {pickOs}
          </div>
          {!topic ? <Skeleton className="h-[184px] rounded-[20px]" /> : (
            <div className="flex items-center gap-5 rounded-[20px] bg-raised p-4">
              <QrCode value={os === 'android' ? deep : topic} label={os === 'android' ? 'QR code: subscribe in ntfy' : 'QR code: your private topic'} className="max-sm:hidden" />
              {os === 'android' ? (
                <div className="min-w-0 space-y-3">
                  <p className="text-[13.5px] text-ink-2"><span className="max-sm:hidden">Point your phone’s camera at the code, then tap Subscribe in ntfy. On the phone already? Use the button.</span><span className="sm:hidden">Tap Open in ntfy, then Subscribe.</span></p>
                  <a href={deep} className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[14px] font-semibold text-bg transition hover:opacity-90"><Smartphone size={16} />Open in ntfy</a>
                  <a href={topic} target="_blank" rel="noopener" className="block text-[12.5px] font-medium text-blue-text hover:underline">Or open it in the browser</a>
                </div>
              ) : (
                <div className="min-w-0 flex-1 space-y-2.5">
                  <p className="text-[13.5px] text-ink-2">In ntfy, tap <b>+</b>, paste this name, then tap <b>Subscribe</b>:</p>
                  <div className="flex items-center gap-1 rounded-[14px] bg-surface py-1 pl-3 pr-1 ring-1 ring-line"><code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">{name}</code><CopyButton text={name} /></div>
                  <p className="text-[12px] text-faint"><span className="max-sm:hidden">Copied on a Mac, it pastes on your iPhone too. </span><a href={topic} target="_blank" rel="noopener" className="font-medium text-blue-text hover:underline">Open it in the browser</a></p>
                </div>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            {back(1)}
            <Button variant="primary" disabled={!topic} onClick={() => { setPhase('idle'); setStep(3); }}>Subscribed: send a test <ChevronRight size={15} /></Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div key="s3" className="animate-rise space-y-4">
          <div role="status" className={cx('flex flex-col items-center gap-2.5 rounded-[20px] px-4 py-6 text-center', phase === 'error' ? 'bg-bad/10' : 'bg-raised')}>
            {phase === 'error' ? <StatusMark state="bad" size={44} label="The test didn’t go out" />
              : <span className="relative grid size-16 place-items-center">
                  {phase === 'sent' && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-blue/15 [animation-duration:2.2s] motion-reduce:hidden" />}
                  <IconCircle tone="grad" size={56}>{phase === 'sending' ? <Loader2 size={22} className="animate-spin" /> : <Smartphone size={24} />}</IconCircle>
                </span>}
            <p className="text-[16px] font-semibold tracking-[-0.01em]">{phase === 'error' ? 'The test didn’t go out' : phase === 'sent' ? 'Waiting for your phone' : 'Sending a test…'}</p>
            <p className="max-w-[380px] text-[13px] text-muted">{phase === 'error' ? err
              : os === 'android' ? 'Tap “It worked” on the Unit7 test alert. This updates by itself.'
              : 'iPhones show no buttons on alerts. When the Unit7 test arrives, tap “I got it” here.'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Check size={15} />} loading={busy} disabled={phase !== 'sent'} onClick={gotIt}>I got it</Button>
            <Button variant="secondary" icon={<Send size={14} />} loading={phase === 'sending'} onClick={send}>Send again</Button>
          </div>
          <details className="group rounded-[18px] border border-line">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13.5px] font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
              <ChevronRight size={15} className="text-muted transition-transform group-open:rotate-90" />Didn’t arrive? Here’s what to check
            </summary>
            <ul className="space-y-2 px-4 pb-4 pl-10 text-[13px] text-ink-2 [&>li]:list-disc">
              <li>Notifications are allowed for ntfy (your phone’s Settings → Notifications → ntfy).</li>
              <li>ntfy is subscribed to your private name{name && <>, ending in <code className="font-mono">…{name.slice(-4)}</code></>}. <button type="button" onClick={() => setStep(2)} className="rounded-full font-medium text-blue-text hover:underline">Show it again</button></li>
              <li>Battery saver is off, or ntfy may run in the background (Android: Settings → Apps → ntfy → Battery → Unrestricted).</li>
              <li>Still nothing after a minute? Send again.</li>
            </ul>
          </details>
          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            {back(al?.state === 'waiting' || !al ? 2 : 0)}
            {al?.state !== 'verified' && al?.state !== 'failing' && <span className="text-[12.5px] text-faint">Connected once your phone answers.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// Alerts in one compact card, for Autopilot and Settings: each channel's state (verified, waiting, not reaching you),
// a test, and phone approvals (once the phone is verified).
export function AlertChannels() {
  const list = useApi<Conn[]>('/api/connections', { live: (e) => e.type.startsWith('account.') });
  const [busy, setBusy] = useState<string | null>(null);
  if (!list.data) return list.error
    ? <p className="py-3 text-[13px] text-muted">Couldn’t load your alert channels. <button type="button" className="rounded-full font-medium text-blue-text hover:underline" onClick={list.reload}>Try again</button></p>
    : <Skeleton className="h-28" />;
  const alerts = list.data.filter((c) => groupOf(c) === 'alerts');
  const ntfy = alerts.find(isPhone)?.accounts.find((x) => !x.pending);
  const rows = alerts.flatMap((c) => { const xs = live(c); return xs.length ? xs.map((a) => ({ c, a: a as Account | undefined })) : [{ c, a: undefined }]; });
  const test = async (c: Conn, a: Account) => {
    setBusy(a.id);
    if (isPhone(c)) await act('alerts.phone_test', {}, { success: 'Test sent: your phone should buzz in a few seconds' });
    else { const r = await act('account.verify', { accountId: a.id }); if (r) r.output?.status === 'verified' ? toast('ok', 'Test sent to your channel') : toast('bad', 'The test didn’t go through', r.output?.problem && tidy(r.output.problem)); }
    setBusy(null); list.reload();
  };
  const open = (c: Conn) => navigate(`/connections?connect=${c.id}`);
  return (
    <div>
      <ul className="divide-y divide-line">
        {rows.map(({ c, a }) => {
          const st = a?.alert?.state;
          return (
            <li key={a?.id ?? c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <Logo id={c.id} name={c.name} />
              <div className="min-w-0 flex-1 basis-[160px]">
                <p className="truncate text-[14px] font-medium">{a && !isPhone(c) ? short(a.name, c.name) : c.name}</p>
                {a?.alert ? <AlertLine c={c} al={a.alert} /> : <p className="text-[12.5px] text-muted">Off</p>}
              </div>
              {!a ? <Button size="sm" variant="soft" onClick={() => open(c)}>Set up</Button>
                : st === 'failing' ? <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} onClick={() => open(c)}>Fix it</Button>
                : st === 'waiting' && isPhone(c) ? <Button size="sm" variant="soft" onClick={() => open(c)}>Finish</Button>
                : <Button size="sm" variant="secondary" icon={<Send size={13} />} loading={busy === a.id} disabled={!!busy} onClick={() => test(c, a)}>Send a test</Button>}
            </li>
          );
        })}
      </ul>
      {ntfy && <div className="border-t border-line"><SwitchRow title="Approve from your phone" body={ntfy.alert?.proof ? 'Say yes or not now right from the alert.' : 'Turns on once your phone answers a test.'}
        checked={!!ntfy.phoneApprovals} disabled={!ntfy.alert?.proof}
        onChange={async (on) => { if (await act('alerts.phone_approvals', { on }, { success: on ? 'You can approve from your phone now' : 'Phone approvals are off' })) list.reload(); }} /></div>}
    </div>
  );
}

// --- Your AI ------------------------------------------------------------------------------------------
function YourAI({ human }: { human: boolean }) {
  const res = useApi<{ local: boolean; agents: AgentInfo[]; hint?: string }>('/api/agents', { live: (e) => e.type.startsWith('agent.connect') || e.type.startsWith('agent.disconnect') });
  const status = useApi<{ bridge?: { watching: boolean } }>('/api/agent/status', { live: (e) => e.type === 'agent.claimed' || e.type === 'agent.done' });
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<AgentInfo | null>(null);
  const watching = !!status.data?.bridge?.watching;
  const toggle = async (a: AgentInfo) => { setBusy(a.id); await connectAgent(a.id, !a.connected); setBusy(null); setOpen(null); res.reload(); };
  const installed = res.data?.agents.filter((a) => a.installed) ?? [];
  const others = res.data?.agents.filter((a) => !a.installed) ?? [];

  return (
    <section aria-labelledby="ai-h" className="space-y-3.5">
      <div className="px-1">
        <h2 id="ai-h" className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.025em]"><Sparkles size={16} className="text-blue" />Your AI</h2>
        <p className="mt-0.5 text-[13px] text-muted">The AI you already use drives Unit7: deploys, fixes, watches.</p>
      </div>
      {!res.data ? <div className={GRID}><Skeleton className="h-[112px] rounded-[22px]" /><Skeleton className="h-[112px] rounded-[22px]" /></div>
        : !res.data.local ? (
          <div className="flex flex-wrap items-center gap-4 rounded-[24px] border border-line bg-surface p-5 shadow-soft">
            <IconCircle><Terminal size={19} /></IconCircle>
            <p className="min-w-0 flex-1 text-[13.5px] text-muted">{tidy(res.data.hint ?? '').replace(/`/g, '')}</p>
            <span className="flex items-center gap-1 rounded-full bg-raised py-1 pl-3.5 pr-1 font-mono text-[12.5px]">unit7 connect<CopyButton text="unit7 connect" /></span>
          </div>
        ) : (
          <div className={GRID}>
            {installed.map((a) => {
              const listening = a.id === 'claude-code' && a.connected && watching;
              return a.connected
                ? <Face key={a.id} logo={<Logo id={a.id} name={a.name} />} brand={brandTint(a.id)} name={a.name} sub={listening ? 'Listening to the ask box' : 'Can use Unit7'} subTone="text-ok"
                    mark={<StatusMark state={listening ? 'live' : 'ok'} size={18} label={listening ? 'Listening' : 'Connected'} />}
                    label={`${a.name}, can use Unit7`} onOpen={() => setOpen(a)} />
                : <Face key={a.id} logo={<Logo id={a.id} name={a.name} />} brand={brandTint(a.id)} name={a.name} sub="On this computer" hint="Let it drive Unit7" label={`Connect ${a.name}`}
                    onOpen={human ? () => toggle(a) : undefined} side={human && <ConnectPill busy={busy === a.id} onClick={() => toggle(a)} label={`Connect ${a.name}`} />} />;
            })}
            {!installed.length && <p className="col-span-2 text-[13.5px] text-muted">No AI apps found on this computer. Install Claude Code or Antigravity, then come back.</p>}
          </div>
        )}
      {others.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-1 text-[12.5px] text-muted">
          Also works with
          {others.map((a) => <span key={a.id} className="inline-flex items-center gap-1.5 text-ink-2"><BrandLogo id={a.id} size={14} />{a.name}</span>)}
        </p>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} size="sm" title={open && <span className="flex items-center gap-3"><Logo id={open.id} name={open.name} />{open.name}</span>}>
        {open && (
          <div className="space-y-5">
            <div className="rounded-[20px] bg-raised p-4 text-[14px]">
              <p className="flex items-center gap-2 font-medium"><StatusMark state="ok" size={18} />{open.name} can use Unit7</p>
              <p className="mt-1 text-[13px] text-muted">{open.id === 'claude-code' ? 'In Claude Code, type /unit7 and what you want. Or just ask and mention Unit7.' : `Just ask ${open.name} and mention Unit7.`}</p>
            </div>
            {open.id === 'claude-code' && (watching ? (
              <div className="rounded-[20px] border border-line p-4 text-[13px]">
                <p className="font-medium text-ink">Listening for the ask box</p>
                <p className="mt-1 text-muted">What you type on Home goes to Claude Code. Stop it in Claude Code any time.</p>
              </div>
            ) : <p className="text-[13px] text-muted">Want Claude to answer the ask box on Home too? Pick “Claude · your subscription” in the box. No API key needed.</p>)}
            {human && <button type="button" className={DANGER} disabled={!!busy} onClick={() => toggle(open)}>{busy === open.id ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}Disconnect {open.name}</button>}
          </div>
        )}
      </Modal>
    </section>
  );
}

// --- backup storage: synced folders this Mac already has, or a bucket --------------------------------------
const FOLDERS = [
  { id: 'gdrive', name: 'Google Drive', match: /google/i, get: 'https://www.google.com/drive/download/' },
  { id: 'icloud', name: 'iCloud Drive', match: /icloud/i, get: '' }, // built into the Mac: turned on in System Settings
  { id: 'dropbox', name: 'Dropbox', match: /dropbox/i, get: 'https://www.dropbox.com/install' },
  { id: 'onedrive', name: 'OneDrive', match: /onedrive/i, get: 'https://www.microsoft.com/microsoft-365/onedrive/download' },
];
interface Storage { on: boolean; syncedFolder: { name: string; path: string; there: boolean } | null; foundFolders: { name: string; path: string; blocked?: boolean }[]; bucket: { name: string } | null; thisComputer: { copies: number } }

function BackupTiles({ human }: { human: boolean }) {
  const [st, setSt] = useState<Storage | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null); // the folder whose pop-up is open
  const load = async () => { try { const r = await runTool('backup.storage'); if (r.status === 'ok') setSt(r.output); else setFailed(true); } catch { setFailed(true); } };
  useEffect(() => { void load(); }, []);
  if (failed && !st) return <p className="col-span-2 text-[13px] text-muted">Couldn’t read where backups go. <button type="button" className="font-medium text-blue-text hover:underline" onClick={() => { setFailed(false); void load(); }}>Try again</button></p>;
  if (!st) return <>{FOLDERS.map((f) => <Skeleton key={f.id} className="h-[112px] rounded-[22px]" />)}</>;
  const use = async (path?: string, name?: string) => {
    setBusy(path ?? 'stop');
    if (await act('backup.folder_set', path ? { path } : {}, { success: path ? `Backups also go to ${name}` : 'Stopped copying to the synced folder' })) await load();
    setBusy(null);
  };
  // each folder in a word on its tile; the whole story, and what to do, in its pop-up
  const states = FOLDERS.map((f) => {
    const found = st.foundFolders.find((x) => f.match.test(x.name));
    const inUse = !!st.syncedFolder && f.match.test(st.syncedFolder.name);
    const action = inUse ? (human && <Button variant="ghost" size="sm" loading={busy === 'stop'} onClick={() => use()}>Stop copying here</Button>)
      : found && !found.blocked && human ? <Button variant="primary" icon={<Plus size={15} />} loading={busy === found.path} onClick={() => use(found.path, f.name)}>Use it</Button>
      : f.get && !found ? <a href={f.get} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-1.5 rounded-full bg-raised px-4 text-[13.5px] font-medium text-ink transition hover:bg-sunken">Get the app <ExternalLink size={13} /></a> : null;
    return {
      f, found, inUse, action,
      sub: inUse ? (st.syncedFolder!.there ? 'Backups go here' : 'Not there right now') : found?.blocked ? 'Needs permission' : found ? 'Found on this Mac' : f.get ? 'Not on this Mac' : 'Off on this Mac',
      what: inUse ? (st.syncedFolder!.there ? 'Every encrypted copy lands in a folder here, and the app uploads it.' : 'Not there right now. Is its app running?')
        : found?.blocked ? 'macOS hasn’t let Unit7 open it yet. Allow it under Privacy & Security → Full Disk Access.'
        : found ? 'Found on this Mac. No sign-in needed: Unit7 drops each encrypted copy in a folder and the app uploads it.'
        : f.get ? 'Not on this Mac. Install its desktop app and it shows up here.' : 'It’s off on this Mac. Turn it on in System Settings → your name → iCloud, and it shows up here.',
    };
  });
  const shown = states.find((s) => s.f.id === info);
  return (
    <>
      {states.map(({ f, found, inUse, sub }) => (
        <Face key={f.id} logo={<Logo id={f.id} name={f.name} />} brand={brandTint(f.id)} name={f.name} sub={sub} subTone={inUse ? 'text-ok' : found?.blocked ? 'text-warn' : undefined}
          mark={inUse ? <StatusMark state={st.syncedFolder!.there ? 'ok' : 'warn'} size={18} label={st.syncedFolder!.there ? 'Backups go here' : 'Not there right now'} /> : found?.blocked ? <StatusMark state="warn" size={18} label="Needs permission" /> : undefined}
          label={`${f.name}, ${sub}`} onOpen={() => setInfo(f.id)}
          side={inUse ? null : found && !found.blocked && human ? <ConnectPill busy={busy === found.path} onClick={() => use(found.path, f.name)} label={`Use ${f.name} for backups`} text="Use it" icon={<FolderSync size={13} />} />
            : f.get && !found ? <a href={f.get} target="_blank" rel="noopener" aria-label={`Get ${f.name}`} title={`Get ${f.name}`} className="connect-pill inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full pl-3 pr-2.5 text-[12.5px] font-medium max-sm:w-8 max-sm:p-0"><span className="max-sm:sr-only">Get it</span><ArrowUpRight size={13} /></a> : null} />
      ))}
      <Face logo={<Logo id="s3" name="Storage bucket" />} brand={brandTint('s3')} name="Storage bucket" sub={st.bucket ? st.bucket.name : 'R2, Backblaze, S3…'} subTone={st.bucket ? 'text-ok' : undefined}
        mark={st.bucket ? <Done size={18} /> : undefined}
        label={st.bucket ? `Storage bucket, ${st.bucket.name}` : 'Add a storage bucket'} onOpen={() => navigate('/settings?tab=backups')}
        side={!st.bucket && human && <ConnectPill onClick={() => navigate('/settings?tab=backups')} label="Add a bucket" text="Add" icon={<Plus size={13} />} />} />
      <Modal open={!!shown} onClose={() => setInfo(null)} size="sm" title={shown && <span className="flex items-center gap-3"><Logo id={shown.f.id} name={shown.f.name} />{shown.f.name}</span>}>
        {shown && <div className="space-y-5"><p className="text-[14px] text-ink-2">{shown.what}</p>{shown.action}</div>}
      </Modal>
    </>
  );
}

// --- Coolify, where a server's X-ray found it: it's connected on that server's page, so the tile goes there -----------
interface CoolifyFound { serverId?: string; server: string; on: boolean }
function CoolifyTiles({ human }: { human: boolean }) {
  const [found, setFound] = useState<CoolifyFound[]>([]);
  const [open, setOpen] = useState<CoolifyFound | null>(null); // the pop-up: "Connect automatically", or paste a token
  const load = () => {
    void Promise.all([call('map.get', {}), call('account.list', { provider: 'coolify' }), api<{ servers: { id: string; name: string }[] }>('/api/graph').catch(() => ({ servers: [] }))]).then(([m, a, g]) => {
      if (m.status !== 'ok') return;
      const accounts = a.status === 'ok' ? (a.output as { serverId?: string; status: string }[]) : [];
      setFound((m.output as { assets: { kind: string; name: string; projects?: { owner: string }[] }[] }).assets
        .filter((x) => x.kind === 'server' && x.projects?.some((p) => p.owner === 'coolify'))
        .map((x) => {
          const serverId = g.servers.find((s) => s.name === x.name)?.id;
          const acc = accounts.find((y) => y.serverId && y.serverId === serverId);
          return { serverId, server: x.name, on: acc?.status === 'verified' || acc?.status === 'ok' };
        }));
    });
  };
  useEffect(load, []);
  return <>{found.map((f) => {
    const go = () => (f.serverId ? setOpen(f) : navigate('/servers'));
    return <Face key={f.server} logo={<Logo id="coolify" name="Coolify" />} brand={brandTint('coolify')} name="Coolify" sub={`On ${f.server}`} label={`Coolify on ${f.server}${f.on ? ', connected' : ', connect it automatically'}`}
      mark={f.on ? <Done size={18} /> : undefined} onOpen={go} side={!f.on && human && <ConnectPill onClick={go} label={`Connect Coolify on ${f.server}`} />} />;
  })}
  <CoolifyConnectModal open={!!open} onClose={() => { setOpen(null); load(); }} serverId={open?.serverId} serverName={open?.server ?? ''} human={human} />
  </>;
}

// --- the bill, for the big clouds: spent this month where the provider says, and whether a spending alert is set ----
const BILLED = new Set(['gcp', 'firebase', 'aws', 'azure']);
interface Bill { spend: { amount: number; currency: string } | null; budgets: { name: string; amount: number; currency: string; spent?: number; alertsAt?: number[] }[] | null; payers?: { name: string; projects: string[] }[]; free?: string[]; note?: string; manageUrl: string;
  export?: { found: true; table: string; from?: string; problem?: string } | { found: false; steps: string[]; link: string; pinned?: string } }
const money = (n: number, currency: string) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n); } catch { return `${n.toFixed(2)} ${currency}`; } };
function CloudBill({ a, many, provider = '' }: { a: Account; many: boolean; provider?: string }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, reload] = useState(0); // after a spending alert is set, or the billing export is found
  useEffect(() => {
    let live = true;
    runTool('cloud.billing', { accountId: a.id }).then((r) => { if (!live) return; if (r.status === 'ok') setBill(r.output as Bill); else setErr(r.status === 'error' ? r.error.message : 'Couldn’t read the bill.'); }, (e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [a.id, n]);
  if (err) return <p className="text-[13px] text-muted">{many ? `${a.name}: the` : 'The'} bill couldn’t be read: {tidy(err)}</p>;
  if (!bill) return <Skeleton className="h-[132px] rounded-[20px]" />;
  const none = bill.budgets && !bill.budgets.length;
  return (
    <section aria-label={`What ${a.name} costs`} className="animate-rise space-y-3 rounded-[20px] border border-line p-4">
      <SpikeBanner accountId={a.id} />
      <div className="flex flex-wrap items-center gap-3">
        <IconCircle size={36} tone="soft"><Wallet size={17} /></IconCircle>
        <div className="min-w-0 flex-1 basis-[150px]">
          <p className="text-[12px] font-medium uppercase tracking-[0.06em] text-faint">{many ? `${a.name} · ` : ''}This month so far</p>
          {bill.spend ? <p className="text-[24px] font-semibold tracking-[-0.03em] tabular">{money(bill.spend.amount, bill.spend.currency)}</p>
            : <p className="text-[13.5px] text-ink-2">Only in the provider’s console</p>}
        </div>
        <a href={bill.manageUrl} target="_blank" rel="noopener" className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-raised px-3 text-[12.5px] font-medium text-ink transition hover:bg-sunken">Open billing <ExternalLink size={12} /></a>
      </div>
      {none ? (
        <div className="flex flex-wrap items-start gap-2 rounded-[14px] bg-warn/12 px-3 py-2.5 text-[13px] text-ink"><BellOff size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          <span className="min-w-0 flex-1 basis-[200px]"><b className="font-semibold">No spending alert yet.</b> Nothing warns you before a bill runs away. Add a budget with an alert at 50%, 90% and 100%.</span>
          <span className="shrink-0 self-center"><BudgetAlertButton account={{ id: a.id, name: a.name, provider }} currency={bill.spend?.currency} spent={bill.spend?.amount} onDone={() => reload((x) => x + 1)} /></span></div>
      ) : bill.budgets ? (
        <ul className="space-y-2.5">{bill.budgets.map((b, i) => {
          const used = b.spent !== undefined && b.amount ? Math.min(1, b.spent / b.amount) : undefined;
          return (
            <li key={i} className="text-[13px]">
              <span className="flex items-center gap-2"><BellRing size={14} className="shrink-0 text-ok" aria-hidden /><span className="min-w-0 flex-1 truncate">{b.name}</span>
                <span className="tabular text-ink-2">{b.spent !== undefined ? `${money(b.spent, b.currency)} of ` : ''}{money(b.amount, b.currency)}{b.alertsAt?.length ? ` · alerts at ${b.alertsAt.join(', ')}%` : ''}</span></span>
              {used !== undefined && <span role="meter" aria-label={`${b.name}: ${Math.round(used * 100)}% used`} aria-valuenow={Math.round(used * 100)} aria-valuemin={0} aria-valuemax={100} className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-raised">
                <span className={cx('block h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none', used >= 0.9 ? 'bg-bad' : used >= 0.5 ? 'bg-warn' : 'bg-ok')} style={{ width: `${Math.max(3, used * 100)}%` }} /></span>}
            </li>
          );
        })}</ul>
      ) : <p className="text-[12.5px] text-muted">Spending alerts couldn’t be read with this sign-in (it needs billing access).</p>}
      {!!bill.payers?.length && <p className="text-[12.5px] text-muted">{bill.payers.map((p) => `${p.name} pays for ${p.projects.length ? p.projects.join(', ') : 'nothing yet'}`).join('. ')}.{bill.free?.length ? ` Free tier only (billing off): ${bill.free.join(', ')}.` : ''}</p>}
      {bill.note && !bill.spend && <p className="text-[12px] text-faint">{bill.note}</p>}
      {bill.export?.found === false && <ExportSteps accountId={a.id} steps={bill.export.steps} link={bill.export.link} onFound={() => reload((x) => x + 1)} />}
      {bill.export?.found && bill.export.from && <p className="text-[12px] text-faint">Reading costs from {bill.export.from}</p>}
      {bill.export?.found && bill.export.problem && <p className="text-[12px] text-muted">The billing export couldn’t be read: {tidy(bill.export.problem)}</p>}
      {(provider === 'aws' || provider === 'azure' || (bill.export?.found && !bill.export.problem)) && <SpendByDay accountId={a.id} />}
    </section>
  );
}

// the big clouds' bills on the Costs page: one per connected account, under its logo
export function CloudBills() {
  const list = useApi<Conn[]>('/api/connections', { live: (e) => e.type.startsWith('account.') });
  const rows = (list.data ?? []).filter((c) => BILLED.has(c.id)).flatMap((c) => live(c).filter((a) => a.status !== 'failing').map((a) => ({ c, a })));
  if (!rows.length) return null;
  return (
    <Card className="mt-4 min-w-0 p-5 md:p-6">
      <h3 className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Big clouds</h3>
      <p className="mt-0.5 text-[12.5px] text-muted">What each account spent this month, its spending alerts, and a way to stop a runaway bill.</p>
      <ul className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {rows.map(({ c, a }) => (
          <li key={a.id} className="min-w-0 space-y-2">
            <p className="flex min-w-0 items-center gap-2 text-[13.5px] font-medium"><BrandLogo id={c.id} size={18} /><span className="truncate">{short(a.name, c.name)}</span></p>
            <CloudBill a={a} many={false} provider={c.id} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- found for you: what the map saw that one more connection would unlock ----------------------------
interface Suggestion { provider: string; name: string; why: string; examples?: string[]; href?: string }
function FoundForYou({ conns, human, onConnect }: { conns: Conn[]; human: boolean; onConnect: (c: Conn) => void }) {
  const [list, setList] = useState<Suggestion[]>([]);
  useEffect(() => {
    let live = true;
    runTool('connection.suggestions', {}).then((r) => { if (live && r.status === 'ok') setList(r.output as Suggestion[]); }, () => undefined);
    return () => { live = false; };
  }, [conns.filter((c) => c.accounts.length).length]);
  // Coolify on a server has its own tile below (one per server), so it isn't said twice
  const shown = list.filter((s) => s.provider !== 'coolify' && (s.href || conns.some((c) => c.id === s.provider && !c.accounts.length)));
  if (!shown.length) return null;
  return (
    <section aria-labelledby="found-h" className="animate-rise space-y-2.5">
      <h2 id="found-h" className="flex items-center gap-2 px-1 text-[13.5px] font-semibold tracking-[-0.01em]"><Sparkles size={14} className="text-blue-text" aria-hidden />Found for you</h2>
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((s) => {
          const c = conns.find((x) => x.id === s.provider);
          return (
            <div key={`${s.provider}${s.href ?? ''}`} className="flex items-center gap-3 rounded-[20px] border border-line bg-surface p-3 pr-3 shadow-soft">
              <span className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-raised"><BrandLogo id={s.provider} size={20} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-ink">{s.why}</span>
                {s.examples?.length ? <span className="block truncate text-[12px] text-muted">{s.examples.join(', ')}</span> : null}
              </span>
              {s.href ? <Button size="sm" variant="soft" onClick={() => navigate(s.href!)}>Open</Button>
                : human && c ? <ConnectPill onClick={() => onConnect(c)} label={`Connect ${c.name}`} /> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// nothing connected yet: the 3D puzzle and one line on what connecting does; the tiles below are the way in
function NothingConnected() {
  return (
    <section aria-label="Nothing connected yet" className="illo-host animate-rise flex flex-col items-center gap-4 rounded-[24px] border border-dashed border-line-strong bg-surface/60 p-5 text-center sm:flex-row sm:text-left">
      <Illustration name="connections" size={92} />
      <div className="min-w-0">
        <p className="text-[16px] font-semibold tracking-[-0.015em]">Nothing connected yet</p>
        <p className="mt-1 max-w-xl text-[13.5px] text-muted">Connect the services you already use, one click each. Unit7 finds every app, domain and database in them, draws how they fit together, and keeps watch.</p>
      </div>
    </section>
  );
}

// One provider's connect steps right where you are (the chat's "Set it up"): the same steps as its pop-up here, and
// onDone once it's connected. No such provider: the way to Connections.
export function ConnectInline({ provider, onDone }: { provider?: string; onDone: () => void }) {
  const list = useApi<Conn[]>('/api/connections', { live: (e) => e.type.startsWith('account.') });
  const me = useApi<Me>('/api/me', { live: false });
  const c = list.data?.find((x) => x.id === provider);
  if (!list.data || !me.data) return <Skeleton className="h-28 rounded-[18px]" />;
  const human = me.data.role !== 'agent';
  if (!c) return (
    <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">Pick the service in Connections.
      <Button size="sm" variant="secondary" icon={<ArrowUpRight size={13} />} onClick={() => navigate('/connections')}>Open Connections</Button></p>
  );
  return c.id === 'ntfy' ? <PhoneAlerts c={c} human={human} reload={list.reload} onClose={onDone} /> : <Connect c={c} human={human} onDone={onDone} />;
}
