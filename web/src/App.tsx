import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Command } from 'cmdk';
import {
  Bot, CalendarClock, ClipboardCheck, Fingerprint, ListChecks, Microscope, Radar, Satellite, ScanSearch, Sparkles, FolderKanban, Server, Plug, Activity, ShieldCheck, Settings, Search, Sun, Moon, Monitor, LogOut, Plus, Check, LifeBuoy, House, Gauge, Network, ChevronDown, SunMoon, ArrowRight, ShieldHalf, Stethoscope } from 'lucide-react';
import { api, onLive, startLive, stopLive, useApi, useConnected } from './lib/api';
import { match, navigate, usePath } from './lib/router';
import { A, Dialog, Kbd, Prompts, Toaster, cx, promptDialog, useSlidingPill, PILL } from './ui';
import { askWords, verbAsks } from './lib/words';
import { askOnHome } from './pages/Help';
import { isDb } from './pages/kit';
import { Logo, Mark } from './brand/Logo';
import { BrandLogo } from './brand/BrandLogo';
import { AuthScreen, InviteScreen } from './pages/Auth';
import { Home } from './pages/Home';
import { Projects, ProjectDetail } from './pages/Projects';
import { Servers, ServerDetail } from './pages/Servers';
import { ServiceDetail } from './pages/ServiceDetail';
import { Connections } from './pages/Connections';
import { ActivityPage, useNames } from './pages/Activity';
import { Approvals, ApprovalBell } from './pages/Approvals';
import { SettingsPage } from './pages/Settings';
import { HelpPage } from './pages/Help';
import { AutopilotPage } from './pages/Autopilot';
import { MapPage } from './pages/Map';
import { WardenMascot } from './mascot/WardenMascot';
import { Wallet, Coffee } from 'lucide-react';
import { CostsPage } from './pages/care';
import { CheckupPage } from './pages/checkup';
import { SevenPage } from './pages/seven';
import { ExpiryPage } from './pages/protect/Expiry';
import { CallsPage } from './pages/checkup/Calls';
import { AlwaysOnPage } from './pages/protect/AlwaysOn';
import { HelpNowPage } from './pages/protect/HelpNow';
import { FlightPage } from './pages/protect/Flight';
import { InvestigationsPage } from './pages/checkup/Investigations';
import { DeepPage } from './pages/protect/Deep';
import { ReportCardPage } from './pages/protect/ReportCard';
import { JobsPage } from './pages/checkup/Jobs';
import { ProtectPage } from './pages/protect';
import { ChangesPage } from './pages/story';
import { Globe2, Repeat } from 'lucide-react';
import { RoutinesPage } from './pages/flow/Routines';
import { DomainLaunchHost, openDomainLaunch } from './pages/flow/DomainLaunch';
import { CoolifyDomainHost } from './pages/servers/CoolifyDomain';
import { ChoicesHost } from './pages/choices';
import { Briefcase, Layers, History, PackagePlus } from 'lucide-react';
import { ClientsPage, ProductsPage } from './pages/organize';
import { ServerAppsPage } from './pages/serverapps/Page';
import { AddPage } from './pages/make/AddPage';
import { GuidePage } from './pages/guide/Guide';
import { FolderOpen, PiggyBank, Rocket } from 'lucide-react';
import { FilesPage } from './pages/files/Files';
import { LivePage } from './pages/live/Live';
import { Mail } from 'lucide-react';
import { EmailPage } from './pages/email/Email';

export { Logo };
export interface Me { user: { id: string; name: string; email: string }; org: { id: string; name: string; slug: string }; role: string; orgs: { id: string; name: string; role: string }[]; passkeys: any[] }

// where Unit7 lives, and how to support it
export const LINKS = { repo: 'https://github.com/Nandkishorrr/unit7', author: 'https://github.com/Nandkishorrr', support: 'https://buymeacoffee.com/nandkishorrr' };
export const SupportButton = ({ className }: { className?: string }) => (
  <a href={LINKS.support} target="_blank" rel="noopener noreferrer" title="Support Unit7 · Buy me a coffee"
    className={cx('h-10 shrink-0 items-center gap-2 rounded-full border border-black bg-[#FFDD00] px-4 text-[13.5px] font-medium text-black transition hover:brightness-95', className)}>
    <Coffee size={16} />Buy me a coffee
  </a>
);

// --- theme: one shared value, so every switch stays in step ---
type Theme = 'system' | 'light' | 'dark';
let theme: Theme = (() => { try { return (localStorage.getItem('unit7-theme') as Theme) || 'system'; } catch { return 'system'; } })();
const themeSubs = new Set<() => void>();
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && systemDark.matches));
systemDark.addEventListener('change', applyTheme);
applyTheme();
function setTheme(t: Theme) {
  theme = t;
  try { localStorage.setItem('unit7-theme', t); } catch { /* private mode */ }
  applyTheme();
  themeSubs.forEach((s) => s());
}
export function useTheme() {
  const t = useSyncExternalStore((cb) => { themeSubs.add(cb); return () => themeSubs.delete(cb); }, () => theme);
  return [t, setTheme] as const;
}

// seven places to go; the rest live in the menu under your name; approvals ring the bell
const NAV = [
  { href: '/', label: 'Home', icon: House, key: 'h' },
  { href: '/live', label: 'Put this live', short: 'Go live', icon: Rocket, key: 'v' },
  { href: '/projects', label: 'Projects', icon: FolderKanban, key: 'p' },
  { href: '/servers', label: 'Servers', icon: Server, key: 's' },
  { href: '/map', label: 'Map', icon: Network, key: 'm' },
  { href: '/connections', label: 'Connections', short: 'Connect', icon: Plug, key: 'c' },
  { href: '/activity', label: 'Activity', icon: Activity, key: 'a' },
];
// in the menu under your name, in three small groups
const MORE = [
  { href: '/seven', label: 'Seven', icon: Bot, key: 'e', group: 'Looking after things' },
  { href: '/checkup', label: 'Check-up', icon: Stethoscope, key: 'k', group: 'Looking after things' },
  { href: '/jobs', label: 'Jobs', icon: ListChecks, key: 'z', group: 'Looking after things' },
  { href: '/files', label: 'Files', icon: FolderOpen, key: 'i', group: 'Looking after things' },
  { href: '/protect', label: 'Safety Net', icon: ShieldHalf, key: 'f', group: 'Looking after things' },
  { href: '/calls', label: 'Call Inspector', icon: Radar, key: 'w', group: 'Looking after things' },
  { href: '/always-on', label: 'Always on', icon: Satellite, key: 'j', group: 'Looking after things' },
  { href: '/ai-log', label: 'What did my AI do?', icon: ScanSearch, key: 'y', group: 'Looking after things' },
  { href: '/investigations', label: 'Investigations', icon: Microscope, key: 'q', group: 'Looking after things' },
  { href: '/deep', label: 'Deep security', icon: Fingerprint, key: 'e', group: 'Looking after things' },
  { href: '/report-card', label: 'Weekly report', icon: ClipboardCheck, key: 'g', group: 'Looking after things' },
  { href: '/expiry', label: 'What runs out', icon: CalendarClock, key: 'x', group: 'Looking after things' },
  { href: '/autopilot', label: 'Autopilot', icon: Gauge, key: 'o', group: 'Looking after things' },
  { href: '/routines', label: 'Routines', icon: Repeat, key: 'u', group: 'Looking after things' },
  { href: '/changes', label: 'Changes', icon: History, key: 'n', group: 'Looking after things' },
  { href: '/add', label: 'Add to my server', icon: PackagePlus, key: 't', group: 'Looking after things' },
  { href: '/clients', label: 'Clients', icon: Briefcase, key: 'l', group: 'Organizing' },
  { href: '/products', label: 'Products', icon: Layers, key: 'd', group: 'Organizing' },
  { href: '/costs', label: 'Costs', icon: Wallet, key: 'b', group: 'Organizing' },
  { href: '/settings', label: 'Settings', icon: Settings, key: ',', group: '' },
  { href: '/help', label: 'Help', icon: LifeBuoy, key: '?', group: '' },
];
const ALL_NAV = [...NAV, { href: '/approvals', label: 'Approvals', icon: ShieldCheck, key: 'r' }, ...MORE];
const isActive = (href: string, path: string) => (href === '/' ? path === '/' : path.startsWith(href) || (href === '/connections' && path === '/vault'));

export function App() {
  const path = usePath();
  const me = useApi<Me>('/api/me', { live: false });
  const setup = useApi<{ needsSetup: boolean }>(me.error ? '/api/setup' : null, { live: false });

  useEffect(() => {
    if (me.data) startLive();
    return () => stopLive();
  }, [me.data]);

  const invite = match('/invite/:token', path);
  if (invite) return <><InviteScreen token={invite.token} signedIn={!!me.data} onDone={() => { me.reload(); navigate('/'); }} /><Toaster /></>;
  const splash = <div className="grid h-full place-items-center"><Mark size={44} animate title="Unit7 is loading" /></div>;
  if (me.loading && !me.data) return splash;
  if (!me.data) {
    if (!setup.data) return splash;
    return <><AuthScreen firstRun={setup.data.needsSetup} onDone={() => { signedInNow = true; me.reload(); }} /><Toaster /></>;
  }
  return <Shell me={me.data} reloadMe={me.reload} path={path} />;
}

// the brand moment: right after you sign in, the 7 in the header assembles once
let signedInNow = false;

function Shell({ me, reloadMe, path }: { me: Me; reloadMe: () => void; path: string }) {
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const [hello] = useState(() => { const h = signedInNow; signedInNow = false; return h; });
  const approvals = useApi<any[]>('/api/approvals', { live: (e) => e.type.startsWith('approval.') });
  const pending = approvals.data?.filter((a) => a.status === 'pending').length ?? 0;
  useTabTitle(path, pending);
  const connected = useConnected();
  const active = NAV.find((n) => isActive(n.href, path))?.href ?? null;
  const [navRef, pill] = useSlidingPill<HTMLDivElement>(active);

  // keyboard: ⌘K palette, "g" then a letter to jump, "/" to ask on Home
  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable=true]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?' && Date.now() - g >= 1200) { e.preventDefault(); setKeys((k) => !k); return; }
      if (e.key === 'g') { g = Date.now(); return; }
      if (Date.now() - g < 1200) {
        const n = ALL_NAV.find((x) => x.key === e.key);
        if (n) { e.preventDefault(); navigate(n.href); }
        g = 0;
      }
      if (e.key === '/' && path === '/') { e.preventDefault(); document.getElementById('unit7-command')?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path]);

  let page: ReactNode;
  let m: Record<string, string> | null;
  if (path === '/') page = <Home me={me} />;
  else if (path === '/projects') page = <Projects />;
  else if ((m = match('/projects/:id/services/:sid', path))) page = <ServiceDetail projectId={m.id!} id={m.sid!} />;
  else if ((m = match('/projects/:id', path))) page = <ProjectDetail id={m.id!} />;
  else if (path === '/servers') page = <Servers />;
  else if ((m = match('/servers/:id', path))) page = <ServerDetail id={m.id!} />;
  else if ((m = match('/servers/:id/apps', path))) page = <ServerAppsPage id={m.id!} human={me.role !== 'agent' && me.role !== 'readonly' && me.role !== 'auditor'} />;
  else if (path === '/connections' || path === '/vault') page = <Connections me={me} />;
  else if (path === '/map' || match('/map/account/:id', path)) page = <MapPage me={me} />;
  else if (path === '/activity') page = <ActivityPage />;
  else if (path === '/approvals') page = <Approvals me={me} />;
  else if (path === '/settings') page = <SettingsPage me={me} reloadMe={reloadMe} />;
  else if (path === '/help') page = <HelpPage />;
  else if (path === '/autopilot') page = <AutopilotPage me={me} />;
  else if (path === '/costs') page = <CostsPage />;
  else if (path === '/seven') page = <SevenPage />;
  else if (path === '/checkup') page = <CheckupPage />;
  else if (path === '/protect') page = <ProtectPage />;
  else if (path === '/expiry') page = <ExpiryPage />;
  else if (path === '/calls') page = <CallsPage />;
  else if (path === '/always-on') page = <AlwaysOnPage />;
  else if (path === '/help-now') page = <HelpNowPage />;
  else if (path === '/ai-log') page = <FlightPage />;
  else if (path === '/investigations') page = <InvestigationsPage />;
  else if (path === '/deep') page = <DeepPage />;
  else if (path === '/report-card') page = <ReportCardPage />;
  else if (path === '/jobs') page = <JobsPage />;
  else if (path === '/files') page = <FilesPage me={me} />;
  else if (path === '/changes') page = <ChangesPage />;
  else if (path === '/routines') page = <RoutinesPage />;
  else if (path === '/clients') page = <ClientsPage />;
  else if (path === '/products') page = <ProductsPage />;
  else if (path === '/add') page = <AddPage />;
  else if (path === '/guide') page = <GuidePage />;
  else if (path === '/live') page = <LivePage />;
  else if (path === '/email') page = <EmailPage />;
  else if ((m = match('/email/:domain', path))) page = <EmailPage domain={m.domain!} human={me.role !== 'agent' && me.role !== 'readonly' && me.role !== 'auditor'} />;
  else page = <div className="py-24 text-center text-muted">Nothing lives at {path}. <A href="/" className="font-medium text-blue-text hover:underline">Go home</A></div>;

  const round = 'relative grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink transition hover:bg-raised';
  const full = path === '/' || path === '/map' || path.startsWith('/map/'); // Home is a full-screen chat: the page itself never scrolls, only the thread does (the Map canvas too)
  return (
    <div className="min-h-full lg:bg-canvas lg:p-3">
      <div className={cx('flex flex-col bg-bg lg:rounded-[32px]', full ? 'h-dvh lg:h-[calc(100dvh-24px)]' : 'min-h-dvh lg:min-h-[calc(100dvh-24px)]')}>
        {/* one width for the header and every page, so nothing jumps as you move around; it grows on big screens */}
        <header className="mx-auto flex h-[72px] w-full max-w-[1720px] items-center gap-3 px-4 md:px-8">
          <A href="/" aria-label="Unit7, home" className="shrink-0 rounded-xl xl:w-[200px]"><Logo size={30} animate={hello} /></A>
          <nav aria-label="Main" className="hidden flex-1 justify-center lg:flex">
            <div ref={navRef} className="relative flex rounded-full border border-line bg-surface p-1 shadow-soft">
              <span aria-hidden className={PILL} style={pill} />
              {NAV.map((n) => {
                const on = active === n.href;
                return (
                  <A key={n.href} href={n.href} data-pill={n.href} aria-current={on ? 'page' : undefined} title={`${n.label} · g then ${n.key}`}
                    className={cx('relative z-10 flex h-10 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[14px] font-medium transition-colors duration-300 min-[1500px]:px-4', on ? 'text-bg' : 'text-ink-2 hover:text-ink')}>
                    <n.icon size={16} strokeWidth={on ? 2.2 : 1.9} className="hidden min-[1500px]:block" />{n.label}
                  </A>
                );
              })}
            </div>
          </nav>
          <div className="ml-auto flex items-center justify-end gap-2 lg:ml-0 xl:min-w-[200px]">
            <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" aria-label="Unit7 on GitHub" title="Unit7 on GitHub" className={cx(round, 'hidden md:grid')}><BrandLogo id="github" size={18} title="GitHub" /></a>
            <button onClick={() => setPalette(true)} aria-label="Search or jump to (⌘K)" title="Search · ⌘K" className={round}><Search size={17} /></button>
            <ApprovalBell me={me} list={approvals.data} reload={approvals.reload} className={round} />
            <ThemeButton className={cx(round, 'hidden lg:grid')} />
            <UserMenu me={me} connected={connected} />
          </div>
        </header>

        {/* bottom padding keeps the last content clear of the tab bar and Warden in the corner */}
        <main className={cx('mx-auto w-full max-w-[1720px] flex-1', full ? 'flex min-h-0 flex-col px-2.5 pb-[calc(70px+env(safe-area-inset-bottom))] sm:px-4 md:px-8 lg:pb-3' : 'px-4 pb-36 pt-2 md:px-8 lg:pb-24 lg:pt-4')}>{page}</main>
      </div>

      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
        <div className="mx-auto flex max-w-[560px] justify-around px-2">
          {NAV.slice(0, 6).map((n) => {
            const on = isActive(n.href, path);
            return (
              <A key={n.href} href={n.href} aria-label={n.label} aria-current={on ? 'page' : undefined} className={cx('flex min-w-0 flex-1 flex-col items-center gap-0.5 pb-2 pt-1.5 text-[11px]', on ? 'font-medium text-ink' : 'text-muted')}>
                <span className={cx('grid h-8 w-12 place-items-center rounded-full transition-colors duration-300', on ? 'bg-ink text-bg' : '')}><n.icon size={18} /></span>
                <span className="max-w-full truncate">{n.short ?? n.label}</span>
              </A>
            );
          })}
        </div>
      </nav>
      <Palette open={palette} onClose={() => setPalette(false)} me={me} />
      <DomainLaunchHost />
      <CoolifyDomainHost />
      <Shortcuts open={keys} onClose={() => setKeys(false)} />
      <WardenMascot />
      <Toaster />
      <Prompts />
      <ChoicesHost />
    </div>
  );
}

function ThemeButton({ className }: { className?: string }) {
  const [t, set] = useTheme();
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = t === 'light' ? Sun : t === 'dark' ? Moon : SunMoon;
  const say: Record<Theme, string> = { system: 'match my computer', light: 'light', dark: 'dark' };
  return <button aria-label={`Theme: ${say[t]}. Switch to ${say[next[t]]}`} title={`Theme: ${say[t]} · click for ${say[next[t]]}`} onClick={() => set(next[t])} className={className}><Icon size={17} /></button>;
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-lime font-semibold text-lime-ink" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials}</span>;
}

// avatar + name: org switcher, the pages that don't need a tab, theme, sign out
function UserMenu({ me, connected }: { me: Me; connected: boolean }) {
  const [open, setOpen] = useState(false);
  const [t, set] = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const path = usePath();
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const switchTo = async (orgId: string) => { if (orgId === me.org.id) return; await api('/api/auth/switch-org', { body: { orgId } }); location.assign('/'); };
  const newOrg = async () => {
    setOpen(false);
    const taken = new Set(me.orgs.map((o) => o.name.toLowerCase()));
    const name = await promptDialog({ title: 'New organization', label: 'Name', placeholder: 'Acme', hint: 'Its own projects, servers and team. You can switch between them from this menu.', confirm: 'Create it',
      warn: (v) => (taken.has(v.toLowerCase()) ? `You already have an organization called “${v}”. Two with the same name are easy to mix up.` : undefined) });
    if (name) { await api('/api/orgs', { body: { name } }); location.assign('/'); }
  };
  const logout = async () => { await api('/api/auth/logout', { body: {} }); location.assign('/'); };
  const row = 'flex h-10 w-full items-center gap-3 rounded-[14px] px-3 text-left text-[13.5px] text-ink-2 transition hover:bg-raised hover:text-ink';
  return (
    <div ref={box} className="relative">
      <button ref={btn} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
        aria-label={`Account menu for ${me.user.name}. ${connected ? 'Live updates on' : 'Reconnecting'}`}
        className="flex h-11 items-center gap-2.5 rounded-full p-1 transition hover:bg-surface xl:pr-3">
        <span className="relative">
          <Avatar name={me.user.name} />
          <span title={connected ? 'Live' : 'Reconnecting…'} className={cx('absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-bg', connected ? 'bg-ok' : 'bg-[#f59e0b] animate-working')} />
        </span>
        <span className="hidden max-w-[140px] truncate text-[14px] font-medium xl:block">{me.user.name}</span>
        <ChevronDown size={15} className={cx('hidden text-muted transition-transform xl:block', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="menu" className="animate-pop absolute right-0 top-full z-40 mt-2 max-h-[calc(100dvh-96px)] w-[290px] origin-top-right overflow-y-auto overscroll-contain rounded-[24px] border border-line bg-surface p-2 shadow-float">
          <div className="flex items-center gap-3 px-3 pb-3 pt-2">
            <Avatar name={me.user.name} size={40} />
            <div className="min-w-0">
              <p className="truncate text-[14px] font-medium">{me.user.name}</p>
              <p className="truncate text-[12.5px] text-muted">{me.user.email}</p>
            </div>
          </div>
          <p className="flex items-center gap-2 px-3 pb-2 text-[12px] text-muted"><span className={cx('size-1.5 rounded-full', connected ? 'bg-ok' : 'bg-[#f59e0b]')} />{connected ? 'Live updates on' : 'Reconnecting…'}</p>
          <div className="border-t border-line py-1.5">
            <p className="px-3 pb-1 pt-1.5 text-[11.5px] font-medium text-faint">Organization</p>
            {me.orgs.map((o) => (
              <button key={o.id} role="menuitemradio" aria-checked={o.id === me.org.id} onClick={() => switchTo(o.id)} className={row}>
                <span className="grid size-6 place-items-center rounded-lg bg-raised text-[11px] font-semibold text-ink-2">{o.name.slice(0, 1).toUpperCase()}</span>
                <span className="flex-1 truncate">{o.name}</span>{o.id === me.org.id && <Check size={15} className="text-blue-text" />}
              </button>
            ))}
            <button role="menuitem" onClick={newOrg} className={cx(row, 'text-muted')}><Plus size={16} /> New organization</button>
          </div>
          <div className="border-t border-line py-1.5">
            <A href="/activity" role="menuitem" className={cx(row, 'lg:hidden')}><Activity size={16} /> Activity</A>
            {MORE.map((n, i) => (
              <Fragment key={n.href}>
                {n.group !== MORE[i - 1]?.group && (n.group ? <p className="px-3 pb-1 pt-2 text-[11.5px] font-medium text-faint">{n.group}</p> : <div className="mx-3 my-1.5 border-t border-line" />)}
                <A href={n.href} role="menuitem" className={row}><n.icon size={16} /> {n.label}</A>
              </Fragment>
            ))}
          </div>
          <div className="border-t border-line px-1 py-2">
            <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-full bg-raised p-1">
              {([['system', Monitor], ['light', Sun], ['dark', Moon]] as const).map(([v, I]) => (
                <button key={v} role="radio" aria-checked={t === v} onClick={() => set(v)}
                  className={cx('flex h-8 items-center justify-center gap-1.5 rounded-full text-[12.5px] capitalize transition', t === v ? 'bg-surface font-medium text-ink shadow-soft' : 'text-muted hover:text-ink')}>
                  <I size={14} />{v}
                </button>
              ))}
            </div>
          </div>
          <div className="border-t border-line pt-1.5">
            <button role="menuitem" onClick={logout} className={row}><LogOut size={16} /> Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ⌘K: jump anywhere, or ask. Whatever you type can always be asked ("Ask Unit7: …"), said with where you are, and
// the six things people ask most (deploy, domain, backup, restart, logs, roll back) come as whole sentences.
function Palette({ open, onClose, me }: { open: boolean; onClose: () => void; me: Me }) {
  const projects = useApi<any[]>(open ? '/api/graph' : null, { live: false });
  const [, set] = useTheme();
  const [q, setQ] = useState('');
  const path = usePath();
  const go = (href: string) => { onClose(); navigate(href); };
  useEffect(() => { if (open) setQ(''); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const graph = projects.data as any;
  const { where, subject } = pageContext(path, graph);
  const sentence = askWords(q, where);
  const about = pageItem(path, graph); // the page's server, app or project rides along as a chip
  const ask = (text: string, send = false) => {
    onClose();
    if (text || about) askOnHome(text, { send: send && !!text, context: about && [about] });
    else { navigate('/'); setTimeout(() => document.getElementById('unit7-command')?.focus(), 50); }
  };
  const verbs = verbAsks(q, subject);
  const item = 'flex h-11 cursor-pointer items-center gap-3 rounded-[14px] px-3 text-[14px] text-ink-2 data-[selected=true]:bg-raised data-[selected=true]:text-ink';
  const group = 'text-[11.5px] font-medium text-faint [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(10_10_14/0.35)] px-4 pt-[12vh] backdrop-blur-[3px]" onClick={onClose}>
      <Command label="Search and jump" className="animate-pop w-full max-w-[600px] overflow-hidden rounded-[28px] border border-line bg-surface shadow-float" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(sentence, !!sentence); } }}>
        <div className="flex items-center gap-3 border-b border-line px-5">
          <Search size={18} className="text-muted" />
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder={where ? `Search, or ask about ${where.name}…` : 'Search, or type what you want to do…'} className="h-14 w-full bg-transparent focus-visible:outline-none text-[15px] text-ink outline-none placeholder:text-faint" />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[380px] overflow-y-auto p-2">
          {/* never a dead end: this row is always there, and says what it will ask */}
          <Command.Group heading="Ask Unit7" className={group} forceMount>
            <Command.Item forceMount value={`ask unit7 ${q}`} className={cx(item, 'h-auto min-h-11 py-2')} onSelect={() => ask(sentence)}>
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue text-white"><Sparkles size={14} /></span>
              <span className="line-clamp-2 min-w-0 flex-1">{q.trim() ? <>Ask Unit7: <span className="font-medium text-ink">“{sentence}”</span></> : where ? `Ask Unit7 about ${where.name}` : 'Ask Unit7 to do something'}</span>
            </Command.Item>
            {verbs.map((v) => (
              <Command.Item key={v.id} forceMount value={`verb ${v.id} ${q}`} className={cx(item, 'h-auto min-h-11 py-2')} onSelect={() => ask(v.text)}>
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-soft text-blue-text"><ArrowRight size={14} /></span>
                <span className="line-clamp-2 min-w-0 flex-1">{v.text}</span>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Go to" className={group}>
            {ALL_NAV.map((n) => <Command.Item key={n.href} className={item} onSelect={() => go(n.href)}><n.icon size={16} /> {n.label}<span className="ml-auto flex gap-1"><Kbd>g</Kbd><Kbd>{n.key}</Kbd></span></Command.Item>)}
          </Command.Group>
          {graph?.projects?.length > 0 && (
            <Command.Group heading="Projects" className={group}>
              {graph.projects.map((p: any) => <Command.Item key={p.id} value={`project ${p.name}`} className={item} onSelect={() => go(`/projects/${p.id}`)}><FolderKanban size={16} /> {p.name}</Command.Item>)}
            </Command.Group>
          )}
          {graph?.servers?.length > 0 && (
            <Command.Group heading="Servers" className={group}>
              {graph.servers.map((s: any) => <Command.Item key={s.id} value={`server ${s.name} ${s.host}`} className={item} onSelect={() => go(`/servers/${s.id}`)}><Server size={16} /> {s.name} <span className="text-faint">{s.host}</span></Command.Item>)}
            </Command.Group>
          )}
          <Command.Group heading="Actions" className={group}>
            <Command.Item value="help something is wrong emergency panic down broken" className={item} onSelect={() => go('/help-now')}><LifeBuoy size={16} /> Help, something’s wrong</Command.Item>
            <Command.Item value="check my servers is everything ok check-up" className={item} onSelect={() => go('/checkup?run=1')}><Stethoscope size={16} /> Run a Check-up</Command.Item>
            <Command.Item value="protect everything now safety net copy backup" className={item} onSelect={() => go('/protect')}><ShieldHalf size={16} /> Protect everything now</Command.Item>
            <Command.Item className={item} onSelect={() => go('/projects?new=1')}><Plus size={16} /> New project</Command.Item>
            <Command.Item className={item} onSelect={() => go('/servers?new=1')}><Plus size={16} /> Connect a server</Command.Item>
            <Command.Item className={item} onSelect={() => go('/connections')}><Plug size={16} /> Connect Hostinger, GitHub, an AI model…</Command.Item>
            <Command.Item value="get a domain buy connect a domain" className={item} onSelect={() => { onClose(); openDomainLaunch(); }}><Globe2 size={16} /> Get a domain, or connect one you have</Command.Item>
            <Command.Item value="email inbox hello forward send spf dkim dmarc domain" className={item} onSelect={() => go('/email')}><Mail size={16} /> Email for a domain: sending and forwards</Command.Item>
            <Command.Item value="routines schedule every week" className={item} onSelect={() => go('/routines')}><Repeat size={16} /> Routines: things Unit7 does on a schedule</Command.Item>
            <Command.Item value="start free plans free tier cheapest vercel supabase firebase domain email database" className={item} onSelect={() => go('/guide')}><PiggyBank size={16} /> Start free: what each service gives you for $0</Command.Item>
            <Command.Item className={item} onSelect={() => { set('light'); onClose(); }}><Sun size={16} /> Light theme</Command.Item>
            <Command.Item className={item} onSelect={() => { set('dark'); onClose(); }}><Moon size={16} /> Dark theme</Command.Item>
            <Command.Item className={item} onSelect={() => { set('system'); onClose(); }}><Monitor size={16} /> System theme</Command.Item>
            <Command.Item className={item} onSelect={async () => { await api('/api/auth/logout', { body: {} }); location.assign('/'); }}><LogOut size={16} /> Sign out ({me.user.email})</Command.Item>
          </Command.Group>
        </Command.List>
        <div className="hidden items-center gap-4 border-t border-line px-5 py-2.5 text-[12px] text-muted sm:flex">
          <span className="inline-flex items-center gap-1.5"><Kbd>↵</Kbd>open</span>
          <span className="inline-flex items-center gap-1.5"><Kbd>⌘</Kbd><Kbd>↵</Kbd>ask now</span>
          <span className="ml-auto inline-flex items-center gap-1.5"><Kbd>?</Kbd>all shortcuts</span>
        </div>
      </Command>
    </div>
  );
}

// where you are, for the palette: "On srv-1", "For shop, Staging", "For web in shop"
function pageContext(path: string, graph: any): { where?: { prefix: string; name: string }; subject?: string } {
  if (!graph) return {};
  let m: Record<string, string> | null;
  const project = (id?: string) => graph.projects?.find((p: any) => p.id === id);
  if ((m = match('/servers/:id', path))) { const s = graph.servers?.find((x: any) => x.id === m!.id); return s ? { where: { prefix: `On ${s.name}`, name: s.name }, subject: s.name } : {}; }
  if ((m = match('/projects/:id/services/:sid', path))) {
    const p = project(m.id), svc = p?.environments?.flatMap((e: any) => e.services ?? []).find((x: any) => x.id === m!.sid);
    return svc ? { where: { prefix: `For ${svc.name} in ${p.name}`, name: svc.name }, subject: `${svc.name} in ${p.name}` } : {};
  }
  if ((m = match('/projects/:id', path))) {
    const p = project(m.id);
    if (!p) return {};
    const envs = p.environments ?? [];
    const env = envs.find((e: any) => e.id === new URLSearchParams(location.search).get('env')) ?? envs.find((e: any) => e.kind === 'production');
    return { where: { prefix: `For ${p.name}${env ? `, ${env.name}` : ''}`, name: p.name }, subject: env ? `${p.name} in ${env.name}` : p.name };
  }
  return {};
}

// what the page is about, as a context chip for the ask: its server, app (or database) or project
function pageItem(path: string, graph: any): { kind: 'server' | 'project' | 'app' | 'database'; id: string; name: string } | undefined {
  if (!graph) return undefined;
  let m: Record<string, string> | null;
  if ((m = match('/servers/:id', path))) { const s = graph.servers?.find((x: any) => x.id === m!.id); return s && { kind: 'server', id: s.id, name: s.name }; }
  if ((m = match('/projects/:id/services/:sid', path))) {
    const svc = graph.projects?.flatMap((p: any) => p.environments ?? []).flatMap((e: any) => e.services ?? []).find((x: any) => x.id === m!.sid);
    return svc && { kind: isDb(svc.kind) ? 'database' : 'app', id: svc.id, name: svc.name };
  }
  if ((m = match('/projects/:id', path))) { const p = graph.projects?.find((x: any) => x.id === m!.id); return p && { kind: 'project', id: p.id, name: p.name }; }
  return undefined;
}

// "?" shows every shortcut
function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const row = (keys: ReactNode, what: string) => <li key={what} className="flex items-center justify-between gap-4 py-2 text-[13.5px]"><span className="text-ink-2">{what}</span><span className="flex shrink-0 gap-1">{keys}</span></li>;
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <ul className="divide-y divide-line">
        {row(<><Kbd>⌘</Kbd><Kbd>K</Kbd></>, 'Search, jump, or ask anything')}
        {row(<><Kbd>⌘</Kbd><Kbd>↵</Kbd></>, 'Ask straight away (in ⌘K)')}
        {row(<Kbd>/</Kbd>, 'Ask Unit7 (on Home)')}
        {row(<Kbd>esc</Kbd>, 'Close, or stop Unit7 on Home')}
        {row(<Kbd>?</Kbd>, 'This list')}
      </ul>
      <p className="mb-1 mt-4 text-[12px] font-medium text-faint">Go to: press <Kbd>g</Kbd> then</p>
      <ul className="grid grid-cols-2 gap-x-6">
        {ALL_NAV.map((n) => <li key={n.href} className="flex items-center justify-between py-1.5 text-[13.5px] text-ink-2">{n.label}<Kbd>{n.key}</Kbd></li>)}
      </ul>
    </Dialog>
  );
}

// The tab says where you are, "(1)" while something waits for your OK, and its icon gets a red dot when something
// needs you (lime while your AI works on something), for when Unit7 sits in a background tab.
function useTabTitle(path: string, pending: number) {
  const names = useNames();
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => {
      if (e.type === 'agent.done') { clearTimeout(t); setWorking(false); }
      else if (/^agent\.(message|claimed|queued)$/.test(e.type)) { setWorking(true); clearTimeout(t); t = setTimeout(() => setWorking(false), 120_000); }
    });
    return () => { off(); clearTimeout(t); };
  }, []);
  useEffect(() => {
    let m: Record<string, string> | null;
    const label = path === '/' ? 'Home'
      : (m = match('/projects/:id/services/:sid', path)) ? [names.name(m.sid), names.name(m.id)].filter(Boolean).join(' · ') || 'App'
      : (m = match('/projects/:id', path)) ? names.name(m.id) ?? 'Project'
      : (m = match('/servers/:id', path)) ? names.name(m.id) ?? 'Server'
      : (m = match('/servers/:id/apps', path)) ? `Apps on ${names.name(m.id) ?? 'a server'}`
      : path === '/guide' ? 'Start free'
      : path === '/vault' ? 'Connections'
      : ALL_NAV.find((n) => n.href !== '/' && path.startsWith(n.href))?.label;
    document.title = `${pending ? `(${pending}) ` : ''}${label ? `${label} · ` : ''}Unit7`;
  }, [path, pending, names]);
  useEffect(() => {
    const want = pending ? '/favicon-alert.svg' : working ? '/favicon-busy.svg' : null;
    let link = document.getElementById('unit7-live-icon') as HTMLLinkElement | null;
    if (!want) { link?.remove(); return; }
    if (!link) { link = Object.assign(document.createElement('link'), { id: 'unit7-live-icon', rel: 'icon', type: 'image/svg+xml' }); document.head.append(link); }
    link.href = want;
  }, [pending, working]);
}
