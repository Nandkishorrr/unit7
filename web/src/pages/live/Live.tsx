// Put this live (/live): the whole way onto the internet with no terminal. Step one, your code: a GitHub repo, a folder or a ZIP.
// Step two, make it yours: where it goes, best first and why, then its name, settings, room and build. Step three, the price and
// Go. Then the steps as they happen and the live link. It all lives outside the page, so leaving to connect a host, or to look
// around during a build, loses nothing.
import { useEffect, useState, useSyncExternalStore, type ClipboardEvent, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, ExternalLink, Globe, Globe2, RefreshCw, Rocket, TriangleAlert, X } from 'lucide-react';
import { onLive, runTool, type ToolResult } from '../../lib/api';
import { navigate, useQuery } from '../../lib/router';
import { parseDotenv } from '../../lib/dotenv';
import { isPublicKey, nextStep } from '../../lib/nextstep';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { A, Badge, Button, Card, CopyButton, ErrorLine, Field, Input, PageHeader, Skeleton, StatusMark, Tabs, confirmDialog, cx } from '../../ui';
import { AskButton } from '../Help';
import { LogoTile, stackLogo } from '../kit';
import { FromGithub } from '../NewProject';
import { openDomainLaunch } from '../flow/DomainLaunch';
import { Note, host } from '../make/parts';
import { SiteDrop } from './drop';

interface Size { id: string; label: string; price: string; paid?: boolean }
interface Place { to: string; label: string; accountId?: string; serverId?: string; ok: boolean; why: string; recommended: boolean; costs?: string; price?: string; money?: Money; sizes?: Size[]; pushes?: boolean; tunes?: boolean }
type Money = 'free' | 'included' | 'paid';
interface Other { to: string; name: string; ok: boolean; why: string; price?: string; money?: Money }
interface Guide { what: string | null; advice: string | null; ai: boolean; connected: string[] }
interface Site { name: string; stack: string; runtime: string | null; files: number; mb: number; needs: string[]; settings: string[]; buildCommand?: string | null; startCommand?: string | null; output?: string | null; port?: number; home?: string; pages?: string[] }
interface Found { site: Site; places: Place[]; notConnected: Other[]; keysFound?: string; publishRefused?: boolean }
type Source = { name: string } & ({ uploadId: string } | { repo: string; branch?: string });
interface Put { url: string; name: string; verified: boolean; autoDeploy: boolean; notes: string[]; domain?: { error?: string; addThese?: { type: string; name: string; value: string }[]; at?: string; also?: string[] }; site: Site }
interface Plan { plan: number; websites: string[] }
interface Run { at: number; where: string; input: Record<string, unknown>; lines: string[]; out?: Put; failed?: Exclude<ToolResult, { status: 'ok' }>; plans?: Plan[]; proof?: string }
interface Tune { buildCommand?: string; startCommand?: string; output?: string; port?: string }
interface State { source?: Source; found?: Found; guide?: Guide; home?: string; looking?: boolean; error?: string; pick?: string; name: string; domain: string; env: Record<string, string>; size?: string; tune: Tune; run?: Run }

// a reload (signing in to a host can take the whole tab) keeps the site, so nobody drops it twice
const SAVED = 'unit7-live-site';
const saved = (): Source | undefined => { try { return JSON.parse(sessionStorage.getItem(SAVED) ?? 'null') ?? undefined; } catch { return undefined; } };
const keep = (s?: Source) => { try { if (s) sessionStorage.setItem(SAVED, JSON.stringify(s)); else sessionStorage.removeItem(SAVED); } catch { /* blocked storage: it just isn't kept */ } };

const fresh = (source?: Source): State => ({ source, name: source?.name ?? '', domain: '', env: {}, tune: {} });
let state: State = fresh(saved());
const subs = new Set<() => void>();
const patch = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
const useLive = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);

const choose = (source?: Source, error?: string) => { keep(source); state = { ...fresh(source), error }; subs.forEach((f) => f()); };
const inputOf = (s: Source) => ('uploadId' in s ? { uploadId: s.uploadId } : { repo: s.repo, branch: s.branch });
const placeId = (p: Place) => `${p.to}:${p.accountId ?? ''}:${p.serverId ?? ''}`;
const sizeOf = (p: Place, s: State) => p.sizes?.find((z) => z.id === s.size) ?? p.sizes?.[0];
const tuneOf = (t: Tune) => ({ ...(t.buildCommand?.trim() && { buildCommand: t.buildCommand.trim() }), ...(t.startCommand?.trim() && { startCommand: t.startCommand.trim() }), ...(t.output?.trim() && { output: t.output.trim() }), ...(Number(t.port) > 0 && { port: Number(t.port) }) });
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,200}$/;
const unreachable = () => ({ status: 'error', error: { code: 'network', message: 'Unit7 didn’t answer. Check it’s running, then try again.' } }) as const;
const said = (r: Exclude<ToolResult, { status: 'ok' }>) => (r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? `It’s waiting for your OK on Approvals. ${r.why}` : 'That didn’t go through.');

let asked = 0; // only the latest look counts
async function look() {
  const source = state.source, me = ++asked;
  if (!source || state.run) return; // once it's going, what it found stays as it was
  patch({ looking: true, error: undefined });
  const r = await runTool('live.options', inputOf(source)).catch(unreachable);
  if (me !== asked) return;
  if (r.status === 'ok') {
    patch({ found: r.output, looking: false });
    const g = await runTool('live.guide', inputOf(source)).catch(unreachable);
    if (me === asked && g.status === 'ok') patch({ guide: g.output });
  }
  else if (r.status === 'error' && r.error.code === 'not_found') choose(undefined, 'That upload isn’t here anymore. Drop it again.');
  else patch({ looking: false, error: said(r) });
}

const CONNECT: Record<string, string> = { coolify: '/servers' }; // a host's own connect page; the rest are tiles on Connections
const connectHref = (to: string) => CONNECT[to] ?? `/connections?connect=${encodeURIComponent(to)}`;
const STACK: Record<string, string> = { static: 'A plain website', unknown: 'Unit7 can’t tell what this is yet', nest: 'NestJS', compose: 'Docker Compose', 'python-django': 'Django', 'python-fastapi': 'FastAPI', 'python-flask': 'Flask' };
const stackWords = (s: string) => STACK[s] ?? providerName(stackLogo({ kind: 'app', stack: s }));
const DATA: Record<string, string> = { postgres: 'a Postgres database', mysql: 'a MySQL database', redis: 'Redis', mongo: 'a MongoDB database' };
const NAME = /^[a-z0-9][a-z0-9-]{0,51}$/, DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function go(place: Place, update = false) {
  const { source, name, domain, env, tune, home } = state, size = sizeOf(place, state);
  const filled = Object.fromEntries(Object.entries(env).filter(([, v]) => v.trim()));
  const input = { ...inputOf(source!), ...(home && { home }), to: place.to, accountId: place.accountId, serverId: place.serverId, name, ...(domain && { domain }), ...(Object.keys(filled).length && { env: filled }), ...(size && { size: size.id }), ...(place.tunes && tuneOf(tune)), update };
  void putLive(input, place.label);
}
// a host's steps are tools of their own, so theirs are said here too
function sayProgress() {
  const add = (l: string) => { const now = state.run!; if (now.lines.at(-1) !== l) patch({ run: { ...now, lines: [...now.lines.slice(-29), l] } }); };
  return onLive((e) => { if (e.type === 'tool.progress' && /^(live\.put|coolify\.|domain\.|hostinger\.)/.test(e.data?.tool ?? '')) add(e.message); });
}
async function putLive(input: Record<string, unknown>, where: string) {
  patch({ run: { at: Date.now(), where, input, lines: [] } });
  const off = sayProgress();
  const r = await runTool('live.put', input).catch(unreachable);
  off();
  const now = state.run!;
  patch({ run: r.status === 'ok' ? { ...now, out: r.output } : { ...now, failed: r } });
}
// the website isn't on Hostinger yet: a person says make it, on a plan they already pay for, and it goes live there
async function newWebsite(run: Run, plan?: number) {
  patch({ run: { ...run, at: Date.now(), lines: [], failed: undefined, plans: undefined, proof: undefined } });
  const off = sayProgress();
  const r = await runTool('hostinger.website_create', { domain: run.input.domain, accountId: run.input.accountId, plan }).catch(unreachable);
  off();
  if (r.status === 'ok' && r.output.status === 'ready') return putLive(run.input, run.where);
  if (r.status !== 'ok') return patch({ run: { ...state.run!, failed: r } });
  // not made: it needs an answer first
  const o = r.output, domain = String(run.input.domain), message = o.plans ? `Pick the Hostinger plan ${domain} goes on. Nothing was created yet.`
    : `Hostinger wants proof that ${domain} is yours. Where your domain’s DNS is managed, add a TXT record at ${o.addThis?.name} saying the text below, next to the ones there. Wait up to 10 minutes, then press the button again. Nothing was created yet.`;
  patch({ run: { ...state.run!, failed: { status: 'error', error: { code: o.status, message } }, plans: o.plans, proof: o.addThis?.value } });
}

export function LivePage() {
  const s = useLive();
  const wanted = useQuery().get('to') ?? undefined;
  const key = s.source && JSON.stringify(inputOf(s.source));
  useEffect(() => { void look(); }, [key]);
  useEffect(() => onLive((e) => { if (e.type.startsWith('account.')) void look(); }), []); // a host connected in another tab
  useEffect(() => { if (wanted && (s.run?.out || s.run?.failed)) choose(); }, [wanted]); // Start free sent them here for a new site, not the last one
  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader title="Put this live" subtitle="Pick your code, set it up your way, and see the price before you go live. No terminal needed." />
      {s.run ? <RunView s={s} run={s.run} /> : <Steps s={s} wanted={wanted} />}
    </div>
  );
}

function Step({ n, title, children, muted }: { n: number; title: string; children?: ReactNode; muted?: boolean }) {
  return (
    <Card className={cx('animate-rise p-4 sm:p-6', muted && 'opacity-60')}>
      <h2 className="flex items-center gap-2.5 text-[16px] font-semibold tracking-[-0.02em] text-ink">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-[13px] font-semibold text-bg">{n}</span>{title}
      </h2>
      {children && <div className="mt-4">{children}</div>}
    </Card>
  );
}

function Steps({ s, wanted }: { s: State; wanted?: string }) {
  const [how, setHow] = useState<'files' | 'github'>('github');
  const found = s.found, usable = found?.places.filter((p) => p.ok) ?? [];
  const place = usable.find((p) => placeId(p) === s.pick) ?? usable.find((p) => p.to === wanted) ?? usable[0];
  return (
    <div className="space-y-4">
      {!s.source ? (
        <Step n={1} title="Your code">
          {s.error && <div className="mb-3"><Note tone="bad">{s.error}</Note></div>}
          <Tabs value={how} onChange={setHow} tabs={[{ value: 'github', label: 'From GitHub' }, { value: 'files', label: 'A folder or ZIP' }]} />
          <div className="mt-4">
            {how === 'files' ? <SiteDrop onReady={(u) => choose({ uploadId: u.uploadId, name: u.name })} />
              : <FromGithub onRepo={(r) => choose({ repo: r.fullName, branch: r.defaultBranch, name: r.fullName.split('/')[1]! })} />}
          </div>
        </Step>
      ) : <SiteRow s={s} />}
      {s.source ? (
        <Step n={2} title="Make it yours">
          {s.error && <Note tone="bad">{s.error}</Note>}
          {s.error && !found && <Button className="mt-3" size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={() => void look()}>Try again</Button>}
          {!found && !s.error && <Looking repo={!!s.source && 'repo' in s.source} />}
          {found && <Where s={s} found={found} place={place} wanted={wanted} />}
          {found && place && !found.publishRefused && <Yours s={s} place={place} />}
        </Step>
      ) : <Step n={2} title="Make it yours" muted />}
      {found && place && !found.publishRefused ? <Launch s={s} place={place} /> : <Step n={3} title="Go live" muted />}
    </div>
  );
}

function Looking({ repo }: { repo: boolean }) {
  return (
    <div aria-busy="true" className="space-y-2.5">
      <p className="text-[13px] text-muted" aria-live="polite">{repo ? 'Reading your repo…' : 'Reading your site…'}</p>
      <Skeleton className="h-[74px] rounded-[18px]" /><Skeleton className="h-[74px] rounded-[18px]" />
    </div>
  );
}

// step one, done: what it is, and a way to start over
function SiteRow({ s }: { s: State }) {
  const site = s.found?.site, known = site && !['static', 'unknown'].includes(site.stack);
  return (
    <Card className="animate-rise flex items-center gap-3 p-4">
      <LogoTile id={known ? stackLogo({ kind: 'app', stack: site.stack.replace(/^python-.*/, 'python') }) : undefined} size={46}>{!known && <Globe size={21} className="text-muted" aria-hidden />}</LogoTile>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold tracking-[-0.015em] text-ink">{s.source!.name}</p>
        <p className="truncate text-[12.5px] text-muted">{site ? `${stackWords(site.stack)} · ${site.files} file${site.files === 1 ? '' : 's'}${site.mb ? ` · ${site.mb} MB` : ''}` : 'repo' in s.source! ? s.source!.repo : 'Your upload'}</p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => choose()}>Change</Button>
    </Card>
  );
}

const MONEY: Record<Money, { label: string; tone: 'ok' | 'neutral' | 'warn' } | undefined> = { free: { label: 'Free', tone: 'ok' }, included: { label: 'No extra cost', tone: 'neutral' }, paid: { label: 'Paid', tone: 'warn' } };
function MoneyBadge({ m }: { m?: Money }) {
  const b = m && MONEY[m];
  return b ? <Badge tone={b.tone} className="h-5 px-2 text-[11px]">{b.label}</Badge> : null;
}

// what the project is, read from its README and description, never its code, then one question away from the AI
function GuideCard({ s, found }: { s: State; found: Found }) {
  const name = s.source!.name, g = s.guide, unknown = found.site.stack === 'unknown';
  return (
    <div className="rounded-[18px] bg-raised/60 p-3.5" aria-live="polite">
      <p className="text-[13px] font-semibold text-ink">{g?.ai ? 'What AI read in your project' : 'Your project'}</p>
      <p className="mt-1 text-[13px] leading-snug text-ink-2">{g ? g.what ?? `${stackWords(found.site.stack)}, with ${found.site.files} files.` : 'Reading its description…'}</p>
      {g?.advice && <p className="mt-1 text-[13px] leading-snug text-ink-2">{g.advice}</p>}
      {g && !g.ai && <p className="mt-1 text-[12.5px] leading-snug text-muted">It only reads the README and description, never your code.</p>}
      <div className="mt-2.5">
        <AskButton size="md" label={unknown ? 'Ask Unit7 how to put this live' : 'Ask Unit7 for a full plan'} prompt={`I want to put ${name} live${s.source && 'repo' in s.source ? ` from the repo ${s.source.repo}` : ''}. Unit7 sees: ${stackWords(found.site.stack)}. Use live.options, then tell me what it is, the best place for it, which choices are free and which are paid, and what else it needs. Read only its README and description, not all its code.`} />
      </div>
    </div>
  );
}

// after the hosts: the other things a new site usually wants, free ones named first, with a way to connect what isn't yet
interface Extra { name: string; price: string; to?: string; href?: string }
const EMAIL: Extra[] = [{ name: 'Resend', price: 'Free for 3,000 emails a month', to: 'resend' }, { name: 'Brevo', price: 'Has a free plan', href: 'https://www.brevo.com/pricing/' }];
const LIST: Extra[] = [{ name: 'Kit', price: 'Has a free plan', href: 'https://kit.com/pricing' }, { name: 'Brevo', price: 'Has a free plan', href: 'https://www.brevo.com/pricing/' }];
const DATABASE: Extra[] = [{ name: 'Supabase', price: 'Has a free plan', to: 'supabase' }, { name: 'Neon', price: 'Has a free plan', to: 'neon' }];
function Extras({ s, found }: { s: State; found: Found }) {
  const connected = s.guide?.connected ?? [];
  const row = (title: string, items: Extra[]) => (
    <div key={title}>
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <ul className="mt-1 space-y-1">
        {items.map((x) => (
          <li key={x.name} className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-2">
            <span className="font-medium">{x.name}</span><span className="text-muted">{x.price}</span>
            {x.to && connected.includes(x.to) ? <Badge tone="lime" className="h-5 px-2 text-[11px]">Connected</Badge>
              : x.to ? <A href={connectHref(x.to)} className="font-medium text-blue-text hover:underline">Connect</A>
              : <a href={x.href} target="_blank" rel="noreferrer" className="font-medium text-blue-text hover:underline">See plans</a>}
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <details className="rounded-[18px] border border-line p-3.5">
      <summary className="cursor-pointer text-[13.5px] font-medium text-ink">What else your site may want</summary>
      <div className="mt-3 space-y-3">
        {row('Send email from your site', EMAIL)}
        {row('Build an email list', LIST)}
        {!!found.site.needs.length && row('A database', DATABASE)}
        <p className="text-[12.5px] text-muted">Plans change, so check each one’s own page.</p>
      </div>
    </details>
  );
}

function Where({ s, found, place, wanted }: { s: State; found: Found; place?: Place; wanted?: string }) {
  const can = found.notConnected.filter((h) => h.ok).sort((a, b) => Number(b.to === wanted) - Number(a.to === wanted));
  const missing = wanted && !found.places.some((p) => p.to === wanted) ? found.notConnected.find((h) => h.to === wanted) : undefined;
  const best = found.places.find((p) => p.ok);
  return (
    <div className="space-y-3">
      {found.keysFound && (
        <div className={cx('flex items-start gap-2.5 rounded-[16px] p-3.5 text-[13px]', found.publishRefused ? 'bg-bad/8 text-bad' : 'bg-[#f59e0b]/12 text-ink-2')} role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <p className="min-w-0 [overflow-wrap:anywhere]">{found.publishRefused
            ? <><b className="font-semibold">Stopped: these files would put secret keys on the internet.</b> {found.keysFound}. Take the keys out, then bring the site back here.</>
            : <><b className="font-semibold">These files hold keys, so they shouldn’t be in the code.</b> {found.keysFound}. It can still go live, but a key in code can end up where people can read it. Move them to settings first if you can.</>}</p>
        </div>
      )}
      <GuideCard s={s} found={found} />
      {found.publishRefused ? null : <>
      {!!found.site.needs.length && <p className="text-[13px] text-ink-2">It uses {found.site.needs.map((n) => DATA[n] ?? n).join(' and ')}. Unit7 can add {found.site.needs.length > 1 ? 'them' : 'one'} once it’s live.</p>}
      {missing && !missing.ok && <Note tone="warn">{missing.name} can’t take this one: {missing.why}</Note>}
      {!!found.places.length && (
        <div role="radiogroup" aria-label="Where it goes" className="space-y-2">
          {found.places.map((p) => {
            const on = !!place && placeId(p) === placeId(place);
            return (
              <button key={placeId(p)} type="button" role="radio" aria-checked={on} disabled={!p.ok} onClick={() => patch({ pick: placeId(p) })}
                className={cx('flex min-h-[74px] w-full items-center gap-3 rounded-[18px] border p-3 text-left outline-none transition-[border,background] duration-200 focus-visible:ring-4 focus-visible:ring-blue-soft',
                  on ? 'border-blue bg-blue-soft/70 shadow-[inset_0_0_0_1px_var(--blue)]' : p.ok ? 'border-line bg-surface hover:border-line-strong hover:bg-raised/70' : 'cursor-not-allowed border-line bg-raised/50')}>
                <LogoTile id={p.to} size={42} className={cx(!p.ok && 'opacity-50 grayscale')} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={cx('text-[14px] font-medium [overflow-wrap:anywhere]', p.ok ? 'text-ink' : 'text-muted')}>{p.label}</span>
                    {p === best && found.site.stack !== 'unknown' && <Badge tone="lime" className="h-5 px-2 text-[11px]">Best fit</Badge>}
                    {p.ok && <MoneyBadge m={p.money} />}
                  </span>
                  <span className="block text-[12.5px] leading-snug text-muted">{p.why}</span>
                  {p.ok && p.price && <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-2">{p.price}</span>}
                </span>
                {p.ok && <span aria-hidden className={cx('grid size-5 shrink-0 place-items-center rounded-full border', on ? 'border-blue bg-blue text-white' : 'border-line-strong')}>{on && <Check size={12} strokeWidth={3} />}</span>}
              </button>
            );
          })}
        </div>
      )}
      {!best && <p className="text-[14px] font-medium text-ink">{found.places.length ? 'Nothing you’ve connected can host this.' : 'Nothing is connected yet.'} Connect one of these and it shows up here.</p>}
      {!!can.length && (
        <>
        <p className="text-[13px] font-medium text-ink">You could also connect</p>
        <ul className="space-y-2" aria-label="Hosts you could connect">
          {can.map((h) => (
            <li key={h.to} className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[18px] border border-dashed border-line-strong p-3', h.to === wanted && !best && 'border-blue')}>
              <LogoTile id={h.to} size={42} />
              <span className="min-w-0 flex-1 basis-[200px]">
                <span className="flex flex-wrap items-center gap-x-2 text-[14px] font-medium text-ink">{h.name}<MoneyBadge m={h.money} /></span>
                <span className="block text-[12.5px] leading-snug text-muted">{h.why}</span>
                {h.price && <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-2">{h.price}</span>}
              </span>
              <Button size="sm" variant={best ? 'secondary' : 'primary'} onClick={() => navigate(connectHref(h.to))}>Connect {h.to === 'coolify' ? 'a server' : h.name}<ArrowRight size={13} /></Button>
            </li>
          ))}
        </ul>
        </>
      )}
      <Extras s={s} found={found} />
      {!best && !can.length && <p className="text-[13px] text-muted">Go to <A href="/connections" className="font-medium text-blue-text hover:underline">Connections</A> to add a host.</p>}
      </>}
    </div>
  );
}

// step two, under where it goes: everything a person may want to change, with what Unit7 found already in place
function Yours({ s, place }: { s: State; place: Place }) {
  const site = s.found!.site, repo = s.source && 'repo' in s.source ? s.source : undefined;
  const nameOk = NAME.test(s.name), domainOk = !s.domain || DOMAIN.test(s.domain);
  return (
    <div className="mt-5 space-y-5 border-t border-line pt-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" hint={nameOk ? 'It’s part of the free address.' : <span className="text-bad">Lowercase letters, digits and dashes, starting with a letter or digit.</span>}>
          <Input required maxLength={52} value={s.name} spellCheck={false} autoCapitalize="none" aria-invalid={!nameOk} onChange={(e) => patch({ name: e.target.value.trim().toLowerCase() })} />
        </Field>
        <Field label="Your domain (optional)" hint={domainOk ? 'Leave it empty for a free address.' : <span className="text-bad">It should look like shop.example.com.</span>}>
          <Input value={s.domain} placeholder="shop.example.com" spellCheck={false} autoCapitalize="none" inputMode="url" aria-invalid={!domainOk} onChange={(e) => patch({ domain: e.target.value.trim().toLowerCase() })} />
        </Field>
        {site.home && (
          <Field label="Home page" hint="There’s no index.html, so this page opens first. Your code isn’t changed.">
            <select className="h-10 w-full rounded-[12px] border border-line bg-surface px-3 text-[14px] text-ink" value={s.home ?? site.home} onChange={(e) => patch({ home: e.target.value })}>
              {site.pages?.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
        )}
        {repo && <Branch key={repo.branch} now={repo.branch ?? ''} onChange={(branch) => { const source = { ...repo, branch }; keep(source); patch({ source, found: undefined }); }} />}
      </div>
      <Variables s={s} keys={site.settings} />
      {!!place.sizes?.length && <Sizes s={s} place={place} sizes={place.sizes} />}
      {place.tunes && <Build s={s} site={site} />}
    </div>
  );
}

// a new branch is read again once they've finished typing it
function Branch({ now, onChange }: { now: string; onChange: (b: string) => void }) {
  const [v, setV] = useState(now);
  const ok = /^[\w./-]{1,100}$/.test(v);
  return (
    <Field label="Branch" hint={ok ? 'What goes live, and what a push updates.' : <span className="text-bad">That doesn’t look like a branch.</span>}>
      <Input value={v} spellCheck={false} autoCapitalize="none" aria-invalid={!ok} onChange={(e) => setV(e.target.value.trim())} onBlur={() => { if (ok && v !== now) onChange(v); }} />
    </Field>
  );
}

function Variables({ s, keys }: { s: State; keys: string[] }) {
  const [name, setName] = useState('');
  const shown = [...new Set([...keys, ...Object.keys(s.env)])], ok = KEY.test(name.trim());
  const add = () => { if (ok) { patch({ env: { ...s.env, [name.trim()]: s.env[name.trim()] ?? '' } }); setName(''); } };
  const paste = (e: ClipboardEvent<HTMLInputElement>) => { const got = parseDotenv(e.clipboardData.getData('text')); if (Object.keys(got).length) { e.preventDefault(); patch({ env: { ...s.env, ...got } }); setName(''); } };
  const drop = (k: string) => { const { [k]: _, ...env } = s.env; patch({ env }); };
  return (
    <section className="space-y-3" aria-label="Settings">
      <div>
        <h3 className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">Settings</h3>
        <p className="mt-0.5 text-[13px] text-muted">{keys.length ? 'Your code reads these. Leave one empty to set it later.' : 'Unit7 found none in your code. Add any it needs.'} They’re kept on the host, not in your code.</p>
      </div>
      {!!shown.length && (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((k) => (
            <Field key={k} label={k} hint={isPublicKey(k) ? 'Anyone can read this one: it goes in the page.' : undefined}>
              <div className="flex items-center gap-1.5">
                <Input type={isPublicKey(k) ? 'text' : 'password'} autoComplete="off" spellCheck={false} className="font-mono" value={s.env[k] ?? ''} onChange={(e) => patch({ env: { ...s.env, [k]: e.target.value } })} />
                {!keys.includes(k) && <button type="button" aria-label={`Remove ${k}`} className="grid size-9 shrink-0 place-items-center rounded-full text-muted outline-none transition hover:bg-raised hover:text-ink focus-visible:ring-4 focus-visible:ring-blue-soft" onClick={() => drop(k)}><X size={15} aria-hidden /></button>}
              </div>
            </Field>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-[220px]">
          <Field label="Add a setting" hint="Or paste a whole .env file here.">
            <Input value={name} placeholder="API_URL" spellCheck={false} autoCapitalize="none" autoComplete="off" className="font-mono" onChange={(e) => setName(e.target.value)} onPaste={paste} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          </Field>
        </div>
        <Button type="button" variant="secondary" disabled={!ok} className="mb-[22px]" onClick={add}>Add</Button>
      </div>
    </section>
  );
}

function Sizes({ s, place, sizes }: { s: State; place: Place; sizes: Size[] }) {
  const on = sizeOf(place, s), oneprice = new Set(sizes.map((z) => z.price)).size === 1;
  return (
    <section aria-label="How much room it gets">
      <h3 className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">How much room it gets</h3>
      <div role="radiogroup" aria-label="How much room it gets" className="mt-2 grid gap-2 sm:grid-cols-2">
        {sizes.map((z) => {
          const here = z.id === on?.id;
          return (
            <button key={z.id} type="button" role="radio" aria-checked={here} onClick={() => patch({ size: z.id })}
              className={cx('flex w-full items-center gap-2.5 rounded-[16px] border p-3 text-left outline-none transition-[border,background] duration-200 focus-visible:ring-4 focus-visible:ring-blue-soft', here ? 'border-blue bg-blue-soft/70 shadow-[inset_0_0_0_1px_var(--blue)]' : 'border-line bg-surface hover:border-line-strong hover:bg-raised/70')}>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium text-ink">{z.label}</span>
                {!oneprice && <span className="block text-[12.5px] text-muted">{z.price}</span>}
              </span>
              <span aria-hidden className={cx('grid size-5 shrink-0 place-items-center rounded-full border', here ? 'border-blue bg-blue text-white' : 'border-line-strong')}>{here && <Check size={12} strokeWidth={3} />}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Build({ s, site }: { s: State; site: Site }) {
  const set = (k: keyof Tune, v: string) => patch({ tune: { ...s.tune, [k]: v } });
  return (
    <details className="rounded-[16px] border border-line p-3.5">
      <summary className="cursor-pointer text-[13.5px] font-medium text-ink-2 outline-none focus-visible:underline">How it builds</summary>
      <p className="mt-2 text-[13px] text-muted">Unit7 worked this out from your code. Change a line only if the build needs it.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Build command"><Input className="font-mono" spellCheck={false} autoCapitalize="none" maxLength={500} placeholder={site.buildCommand ?? 'None found'} value={s.tune.buildCommand ?? ''} onChange={(e) => set('buildCommand', e.target.value)} /></Field>
        <Field label="Start command"><Input className="font-mono" spellCheck={false} autoCapitalize="none" maxLength={500} placeholder={site.startCommand ?? 'None found'} value={s.tune.startCommand ?? ''} onChange={(e) => set('startCommand', e.target.value)} /></Field>
        <Field label="Output folder"><Input className="font-mono" spellCheck={false} autoCapitalize="none" maxLength={200} placeholder={site.output ?? 'None found'} value={s.tune.output ?? ''} onChange={(e) => set('output', e.target.value)} /></Field>
        <Field label="Port"><Input className="font-mono" inputMode="numeric" maxLength={5} placeholder={site.port ? String(site.port) : 'None found'} value={s.tune.port ?? ''} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
    </details>
  );
}

function Launch({ s, place }: { s: State; place: Place }) {
  const nameOk = NAME.test(s.name), domainOk = !s.domain || DOMAIN.test(s.domain);
  const size = sizeOf(place, s), price = size?.price ?? place.price ?? place.costs, paid = !!place.costs || !!size?.paid;
  const branch = s.source && 'repo' in s.source ? s.source.branch : undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameOk || !domainOk) return;
    if (paid && !(await confirmDialog({ title: 'This costs money', body: `${place.label}. ${price ?? ''} The host bills you for it, not Unit7.`, confirm: 'Go live' }))) return;
    go(place);
  };
  const rows: [string, ReactNode][] = [
    ['Goes to', place.label],
    ['Price', price ?? 'See the host’s own price page.'],
    ['Address', s.domain || 'A free address, made for you. You can add your domain later.'],
    ['After this', place.pushes ? `Every push${branch ? ` to ${branch}` : ''} goes live by itself.` : 'Bring a new version here to update it.'],
  ];
  return (
    <Step n={3} title="Go live">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <dl className="grid gap-x-4 gap-y-1.5 text-[13.5px] sm:grid-cols-[96px_1fr]">
          {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="mb-1 min-w-0 text-ink [overflow-wrap:anywhere] sm:mb-0">{v}</dd></div>)}
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="min-w-0 flex-1 basis-[220px] text-[12.5px] text-muted">Prices are from each host’s own page in November 2026. Its bill is what counts.</p>
          <Button size="lg" variant="primary" icon={<Rocket size={16} />} disabled={!nameOk || !domainOk} className="max-sm:w-full">{paid ? 'Go live and pay' : 'Go'}</Button>
        </div>
      </form>
    </Step>
  );
}

// --- it's running, it's live, or it stopped ------------------------------------------------------------------------------
function RunView({ s, run }: { s: State; run: Run }) {
  if (run.out) return <Done s={s} run={run} out={run.out} />;
  if (run.failed) return <Stopped s={s} run={run} failed={run.failed} />;
  return <Running run={run} />;
}

function Running({ run }: { run: Run }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  const secs = Math.round((Date.now() - run.at) / 1000);
  return (
    <Card className="animate-rise p-5 sm:p-7">
      <div className="flex items-start gap-3.5">
        <StatusMark state="work" size={40} label="Working" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">Putting {String(run.input.name)} live on {run.where}</h2>
          <p className="mt-0.5 text-[13px] text-muted">Usually a minute or two. You can look around Unit7 while it works, but keep this tab open.</p>
        </div>
        <span className="tabular shrink-0 pt-1 text-[12.5px] text-muted">{secs >= 60 ? `${Math.floor(secs / 60)}m ` : ''}{secs % 60}s</span>
      </div>
      <ol aria-live="polite" className="mt-5 space-y-2 border-t border-line pt-4">
        {(run.lines.length ? run.lines : ['Getting ready…']).map((l, i, all) => (
          <li key={i} className={cx('flex items-start gap-2.5 text-[13.5px]', i === all.length - 1 ? 'font-medium text-ink' : 'text-muted')}>
            {i === all.length - 1 ? <span aria-hidden className="mt-[7px] size-2 shrink-0 rounded-full bg-blue animate-working" /> : <Check size={14} aria-hidden className="mt-[3px] shrink-0 text-ok" />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{l}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// the settings the code reads: filling them in and saving builds it again with them
function Settings({ s, keys, title, note, saveLabel, onSave }: { s: State; keys: string[]; title: string; note: string; saveLabel: string; onSave: () => void }) {
  const set = (k: string, v: string) => patch({ env: { ...s.env, [k]: v } });
  const any = keys.some((k) => s.env[k]?.trim());
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (any) onSave(); }} className="space-y-3">
      <div>
        <h3 className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">{title}</h3>
        <p className="mt-0.5 text-[13px] text-muted">{note}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {keys.map((k) => (
          <Field key={k} label={k} hint={isPublicKey(k) ? 'Anyone can read this one: it goes in the page.' : undefined}>
            <Input type={isPublicKey(k) ? 'text' : 'password'} autoComplete="off" spellCheck={false} className="font-mono" value={s.env[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
          </Field>
        ))}
      </div>
      <Button variant="secondary" disabled={!any} icon={<RefreshCw size={14} />}>{saveLabel}</Button>
    </form>
  );
}

const again = (s: State, run: Run, update: boolean) => {
  const env = Object.fromEntries(Object.entries(s.env).filter(([, v]) => v.trim()));
  const { env: _, ...input } = run.input;
  void putLive({ ...input, ...(Object.keys(env).length && { env }), update }, run.where);
};

function Done({ s, run, out }: { s: State; run: Run; out: Put }) {
  const given = Object.keys(run.input.env ?? {});
  const missing = out.site.settings.filter((k) => !given.includes(k));
  const next: ReactNode[] = [
    ...(out.url && !out.verified ? ['It says it’s live but didn’t answer yet. Try the link again in a minute.'] : []),
    ...out.notes.filter((n) => !n.startsWith('The code reads')), // the form below says that
    ...(out.domain ? [out.domain.error ? `Your domain isn’t pointed yet: ${out.domain.error}` : out.domain.addThese ? `Your domain isn’t pointed yet. Add these at ${out.domain.at ?? 'your DNS provider'}: ${out.domain.addThese.map((r) => `${r.type} ${r.name} ${r.value}`).join('; ')}. Unit7 keeps checking.` : 'Your domain is set. It can take a few minutes to reach everyone.', ...(out.domain.also ?? [])] : []),
    out.autoDeploy ? 'Every push to GitHub goes live by itself.' : 'To change the site, bring the new version here and use the same name.',
    ...(out.site.needs.length ? [`It uses ${out.site.needs.map((n) => DATA[n] ?? n).join(' and ')}, so it needs ${out.site.needs.length > 1 ? 'them' : 'one'} to work properly.`] : []),
  ];
  return (
    <div className="space-y-4">
      <Card className="animate-pop p-6 text-center sm:p-9">
        <StatusMark state="ok" size={56} solid className="mx-auto" label="Live" />
        <p className="mt-4 text-[15px] text-ink-2 [overflow-wrap:anywhere]">{out.url ? <>{out.name} is live</> : <>{out.name} is on your server, with no address yet</>}</p>
        {out.url && (
          <>
            <a href={out.url} target="_blank" rel="noopener" className="mt-1.5 block text-[26px] font-semibold leading-tight tracking-[-0.03em] text-blue-text [overflow-wrap:anywhere] hover:underline sm:text-[34px]">{host(out.url)}</a>
            <div className="mt-5 flex items-center justify-center gap-2">
              <a href={out.url} target="_blank" rel="noopener" className="inline-flex h-12 items-center gap-2 rounded-full bg-blue px-6 text-[14.5px] font-medium text-white transition hover:brightness-110">Open it<ExternalLink size={15} aria-hidden /></a>
              <CopyButton text={out.url} className="size-12 border border-line-strong bg-surface text-ink" />
            </div>
          </>
        )}
      </Card>
      <Card className="animate-rise space-y-3 p-5 sm:p-6">
        <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-ink">What to do next</h2>
        <ul className="space-y-2">{next.map((n, i) => <li key={i} className="flex gap-2.5 text-[13.5px] text-ink-2"><span aria-hidden className="mt-[8px] size-1.5 shrink-0 rounded-full bg-faint" /><span className="min-w-0 [overflow-wrap:anywhere]">{n}</span></li>)}</ul>
        <div className="flex flex-wrap gap-2 pt-1">
          {!out.domain && <Button variant="secondary" icon={<Globe2 size={15} />} onClick={() => openDomainLaunch()}>Get or connect a domain</Button>}
          {!!out.site.needs.length && <AskButton size="md" label="Ask Unit7 to add it" prompt={`${out.name} is live and it uses ${out.site.needs.map((n) => DATA[n] ?? n).join(' and ')}. Add what it needs.`} />}
          <Button variant="ghost" onClick={() => choose()}>Put another site live</Button>
        </div>
      </Card>
      {!!missing.length && (
        <Card className="animate-rise p-5 sm:p-6">
          <Settings s={s} keys={missing} title="Settings your code needs" note="The site may not work until these are set. They’re saved on the host, and Unit7 builds it again with them." saveLabel="Save and build again" onSave={() => again(s, run, true)} />
        </Card>
      )}
    </div>
  );
}

function Stopped({ s, run, failed }: { s: State; run: Run; failed: Exclude<ToolResult, { status: 'ok' }> }) {
  const code = failed.status === 'error' ? failed.error.code : failed.status;
  const step = nextStep(failed, run.input);
  const taken = code === 'already_exists', built = code === 'build_failed'; // a failed build left the project there: the next try updates it
  const noWebsite = code === 'no_website' || code === 'needs_proof'; // proof added, the same button tries again
  const asking = !!run.plans || !!run.proof; // nothing went wrong: it needs an answer
  const settings = built ? s.found?.site.settings ?? [] : [];
  const back = () => patch({ run: undefined });
  const update = async () => { if (await confirmDialog({ title: `Replace what’s live on ${String(run.input.name)}?`, body: 'The new version takes its place. Earlier versions stay on the host.', confirm: 'Update it' })) again(s, run, true); };
  return (
    <Card className="animate-rise space-y-4 p-5 sm:p-7">
      <div className="flex items-start gap-3.5">
        <StatusMark state={failed.status === 'approval_required' || asking ? 'warn' : 'bad'} size={40} solid label={asking ? 'One thing first' : 'Stopped'} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">{failed.status === 'approval_required' ? 'Waiting for your OK' : run.plans ? 'Which plan?' : run.proof ? 'Show it’s your domain' : taken ? 'That name is taken' : `${String(run.input.name)} didn’t go live`}</h2>
          {asking ? <p className="mt-1 text-[13.5px] text-ink-2 [overflow-wrap:anywhere]">{said(failed)}</p>
            : <ErrorLine text={said(failed)} detail={failed.status === 'error' ? failed.error.logTail : undefined} title="What the host said" className="mt-1 text-[13.5px]" />}
          {run.proof && <p className="mt-2 flex items-center gap-1.5 rounded-[14px] bg-raised px-3 py-1.5"><code className="min-w-0 flex-1 text-[12.5px] text-ink [overflow-wrap:anywhere]">{run.proof}</code><CopyButton text={run.proof} /></p>}
        </div>
      </div>
      {!!run.lines.length && <ul className="space-y-1 border-t border-line pt-3 text-[12.5px] text-muted">{run.lines.slice(-4).map((l, i) => <li key={i} className="[overflow-wrap:anywhere]">{l}</li>)}</ul>}
      {!!settings.length && <Settings s={s} keys={settings} title="Settings your code reads" note="A missing setting is a common reason a build stops. Fill in what you have, then build again." saveLabel="Save and build again" onSave={() => again(s, run, true)} />}
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {taken && <Button variant="primary" onClick={() => void update()}>Update what’s live</Button>}
        {noWebsite && <Button variant="primary" className="max-w-full" onClick={() => void newWebsite(run)}><span className="truncate">Create {String(run.input.domain)} on your plan</span></Button>}
        {run.plans?.map((p) => <Button key={p.plan} variant="primary" className="max-w-full" onClick={() => void newWebsite(run, p.plan)}><span className="truncate">{p.websites.length ? `On the plan with ${p.websites.slice(0, 2).join(', ')}` : `On plan ${p.plan}`}</span></Button>)}
        {step?.href && <Button variant="primary" onClick={() => navigate(step.href!)}>{step.label}</Button>}
        {(built || step?.kind === 'retry') && <Button variant={step?.kind === 'retry' || built ? 'primary' : 'secondary'} icon={<RefreshCw size={14} />} onClick={() => again(s, run, built)}>Try again</Button>}
        {step?.kind === 'ask' && <AskButton size="md" label="Ask Unit7 why" prompt={`Putting ${String(run.input.name)} live on ${run.where} failed: “${said(failed)}”. Why, and how do I fix it?`} />}
        <Button variant={taken || step || built || noWebsite || run.plans ? 'ghost' : 'primary'} onClick={back}>{taken ? 'Pick another name' : 'Back'}</Button>
      </div>
    </Card>
  );
}
