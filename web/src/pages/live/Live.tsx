// Put this live (/live): the whole way onto the internet with no terminal. Step one, hand Unit7 the site: drop a folder or a
// ZIP, pick a folder, or pick a GitHub repo. Step two, what it found and where it can go, best first and why. Step three, a name,
// maybe a domain, and Go. Then the steps as they happen and the live link. It all lives outside the page, so leaving to connect
// a host, or to look around during a build, loses nothing.
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, ExternalLink, Globe, Globe2, RefreshCw, Rocket, TriangleAlert } from 'lucide-react';
import { onLive, runTool, type ToolResult } from '../../lib/api';
import { navigate, useQuery } from '../../lib/router';
import { isPublicKey, nextStep } from '../../lib/nextstep';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { A, Badge, Button, Card, CopyButton, ErrorLine, Field, Input, PageHeader, Skeleton, StatusMark, Tabs, confirmDialog, cx } from '../../ui';
import { AskButton } from '../Help';
import { LogoTile, stackLogo } from '../kit';
import { FromGithub } from '../NewProject';
import { openDomainLaunch } from '../flow/DomainLaunch';
import { Note, host } from '../make/parts';
import { SiteDrop } from './drop';

interface Place { to: string; label: string; accountId?: string; serverId?: string; ok: boolean; why: string; recommended: boolean }
interface Other { to: string; name: string; ok: boolean; why: string }
interface Site { name: string; stack: string; runtime: string | null; files: number; mb: number; needs: string[]; settings: string[] }
interface Found { site: Site; places: Place[]; notConnected: Other[]; keysFound?: string; publishRefused?: boolean }
type Source = { name: string } & ({ uploadId: string } | { repo: string; branch?: string });
interface Put { url: string; name: string; verified: boolean; autoDeploy: boolean; notes: string[]; domain?: { error?: string }; site: Site }
interface Run { at: number; where: string; input: Record<string, unknown>; lines: string[]; out?: Put; failed?: Exclude<ToolResult, { status: 'ok' }> }
interface State { source?: Source; found?: Found; looking?: boolean; error?: string; pick?: string; name: string; domain: string; env: Record<string, string>; run?: Run }

// a reload (signing in to a host can take the whole tab) keeps the site, so nobody drops it twice
const SAVED = 'unit7-live-site';
const saved = (): Source | undefined => { try { return JSON.parse(sessionStorage.getItem(SAVED) ?? 'null') ?? undefined; } catch { return undefined; } };
const keep = (s?: Source) => { try { if (s) sessionStorage.setItem(SAVED, JSON.stringify(s)); else sessionStorage.removeItem(SAVED); } catch { /* blocked storage: it just isn't kept */ } };

const fresh = (source?: Source): State => ({ source, name: source?.name ?? '', domain: '', env: {} });
let state: State = fresh(saved());
const subs = new Set<() => void>();
const patch = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
const useLive = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);

const choose = (source?: Source, error?: string) => { keep(source); state = { ...fresh(source), error }; subs.forEach((f) => f()); };
const inputOf = (s: Source) => ('uploadId' in s ? { uploadId: s.uploadId } : { repo: s.repo, branch: s.branch });
const placeId = (p: Place) => `${p.to}:${p.accountId ?? ''}:${p.serverId ?? ''}`;
const unreachable = (e: Error) => ({ status: 'error', error: { code: 'network', message: `Unit7 didn’t answer: ${e.message}. Check it’s running, then try again.` } }) as const;
const said = (r: Exclude<ToolResult, { status: 'ok' }>) => (r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? `It’s waiting for your OK on Approvals. ${r.why}` : 'That didn’t go through.');

let asked = 0; // only the latest look counts
async function look() {
  const source = state.source, me = ++asked;
  if (!source) return;
  patch({ looking: true, error: undefined });
  const r = await runTool('live.options', inputOf(source)).catch(unreachable);
  if (me !== asked) return;
  if (r.status === 'ok') patch({ found: r.output, looking: false });
  else if (r.status === 'error' && r.error.code === 'not_found') choose(undefined, 'That upload isn’t here anymore. Drop it again.');
  else patch({ looking: false, error: said(r) });
}

const CONNECT: Record<string, string> = { coolify: '/servers' }; // a host's own connect page; the rest are tiles on Connections
const connectHref = (to: string) => CONNECT[to] ?? `/connections?connect=${encodeURIComponent(to)}`;
const STACK: Record<string, string> = { static: 'A plain website', unknown: 'Unit7 works out how to build it', nest: 'NestJS', compose: 'Docker Compose', 'python-django': 'Django', 'python-fastapi': 'FastAPI', 'python-flask': 'Flask' };
const stackWords = (s: string) => STACK[s] ?? providerName(stackLogo({ kind: 'app', stack: s }));
const DATA: Record<string, string> = { postgres: 'a Postgres database', mysql: 'a MySQL database', redis: 'Redis', mongo: 'a MongoDB database' };
const NAME = /^[a-z0-9][a-z0-9-]{0,51}$/, DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function go(place: Place, update = false) {
  const { source, name, domain, env } = state;
  const filled = Object.fromEntries(Object.entries(env).filter(([, v]) => v.trim()));
  const input = { ...inputOf(source!), to: place.to, accountId: place.accountId, serverId: place.serverId, name, ...(domain && { domain }), ...(Object.keys(filled).length && { env: filled }), update };
  void putLive(input, place.label);
}
async function putLive(input: Record<string, unknown>, where: string) {
  const run: Run = { at: Date.now(), where, input, lines: [] };
  patch({ run });
  const add = (l: string) => { const now = state.run!; if (now.lines.at(-1) !== l) patch({ run: { ...now, lines: [...now.lines.slice(-29), l] } }); };
  // a host's steps are tools of their own, so theirs are said here too
  const off = onLive((e) => { if (e.type === 'tool.progress' && /^(live\.put|coolify\.|domain\.)/.test(e.data?.tool ?? '')) add(e.message); });
  const r = await runTool('live.put', input).catch(unreachable);
  off();
  const now = state.run!;
  patch({ run: r.status === 'ok' ? { ...now, out: r.output } : { ...now, failed: r } });
}

export function LivePage() {
  const s = useLive();
  const wanted = useQuery().get('to') ?? undefined;
  const key = s.source && JSON.stringify(inputOf(s.source));
  useEffect(() => { void look(); }, [key]);
  useEffect(() => onLive((e) => { if (e.type.startsWith('account.')) void look(); }), []); // a host connected in another tab
  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader title="Put this live" subtitle="Your site on the internet, no terminal needed. Hand it over, check where it goes, press Go." />
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
  const [how, setHow] = useState<'files' | 'github'>('files');
  const found = s.found, usable = found?.places.filter((p) => p.ok) ?? [];
  const place = usable.find((p) => placeId(p) === s.pick) ?? usable.find((p) => p.to === wanted) ?? usable[0];
  return (
    <div className="space-y-4">
      {!s.source ? (
        <Step n={1} title="Your site">
          {s.error && <div className="mb-3"><Note tone="bad">{s.error}</Note></div>}
          <Tabs value={how} onChange={setHow} tabs={[{ value: 'files', label: 'A folder or ZIP' }, { value: 'github', label: 'From GitHub' }]} />
          <div className="mt-4">
            {how === 'files' ? <SiteDrop onReady={(u) => choose({ uploadId: u.uploadId, name: u.name })} />
              : <FromGithub onRepo={(r) => choose({ repo: r.fullName, branch: r.defaultBranch, name: r.fullName.split('/')[1]! })} />}
          </div>
        </Step>
      ) : <SiteRow s={s} />}
      {s.source ? (
        <Step n={2} title="Where it goes">
          {s.error && <Note tone="bad">{s.error}</Note>}
          {s.error && !found && <Button className="mt-3" size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={() => void look()}>Try again</Button>}
          {!found && !s.error && <Looking repo={!!s.source && 'repo' in s.source} />}
          {found && <Where found={found} place={place} wanted={wanted} />}
        </Step>
      ) : <Step n={2} title="Where it goes" muted />}
      {found && place && !found.publishRefused ? <Launch s={s} place={place} /> : <Step n={3} title="Name it and go" muted />}
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

function Where({ found, place, wanted }: { found: Found; place?: Place; wanted?: string }) {
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
                    {p === best && <Badge tone="lime" className="h-5 px-2 text-[11px]">Best fit</Badge>}
                  </span>
                  <span className="block text-[12.5px] leading-snug text-muted">{p.why}</span>
                </span>
                {p.ok && <span aria-hidden className={cx('grid size-5 shrink-0 place-items-center rounded-full border', on ? 'border-blue bg-blue text-white' : 'border-line-strong')}>{on && <Check size={12} strokeWidth={3} />}</span>}
              </button>
            );
          })}
        </div>
      )}
      {!best && <p className="text-[14px] font-medium text-ink">{found.places.length ? 'Nothing you’ve connected can host this.' : 'Nothing is connected yet.'} Connect one of these and it shows up here.</p>}
      {!!can.length && (
        <ul className="space-y-2" aria-label="Hosts you could connect">
          {can.map((h) => (
            <li key={h.to} className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[18px] border border-dashed border-line-strong p-3', h.to === wanted && !best && 'border-blue')}>
              <LogoTile id={h.to} size={42} />
              <span className="min-w-0 flex-1 basis-[200px]">
                <span className="block text-[14px] font-medium text-ink">{h.name}</span>
                <span className="block text-[12.5px] leading-snug text-muted">{h.why}</span>
              </span>
              <Button size="sm" variant={best ? 'secondary' : 'primary'} onClick={() => navigate(connectHref(h.to))}>Connect {h.to === 'coolify' ? 'a server' : h.name}<ArrowRight size={13} /></Button>
            </li>
          ))}
        </ul>
      )}
      {!best && !can.length && <p className="text-[13px] text-muted">Go to <A href="/connections" className="font-medium text-blue-text hover:underline">Connections</A> to add a host.</p>}
      </>}
    </div>
  );
}

function Launch({ s, place }: { s: State; place: Place }) {
  const nameOk = NAME.test(s.name), domainOk = !s.domain || DOMAIN.test(s.domain);
  const submit = (e: FormEvent) => { e.preventDefault(); if (nameOk && domainOk) go(place); };
  return (
    <Step n={3} title="Name it and go">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint={nameOk ? 'It’s part of the free address.' : <span className="text-bad">Lowercase letters, digits and dashes, starting with a letter or digit.</span>}>
            <Input required maxLength={52} value={s.name} spellCheck={false} autoCapitalize="none" aria-invalid={!nameOk} onChange={(e) => patch({ name: e.target.value.trim().toLowerCase() })} />
          </Field>
          <Field label="Your domain (optional)" hint={domainOk ? 'Leave it empty for a free address.' : <span className="text-bad">It should look like shop.example.com.</span>}>
            <Input value={s.domain} placeholder="shop.example.com" spellCheck={false} autoCapitalize="none" inputMode="url" aria-invalid={!domainOk} onChange={(e) => patch({ domain: e.target.value.trim().toLowerCase() })} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="min-w-0 text-[13px] text-muted" aria-live="polite">Goes to <b className="font-medium text-ink-2">{place.label}</b></p>
          <Button size="lg" variant="primary" icon={<Rocket size={16} />} disabled={!nameOk || !domainOk} className="max-sm:w-full">Go</Button>
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
        {keys.slice(0, 24).map((k) => (
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
    ...(out.domain ? [out.domain.error ? `Your domain isn’t pointed yet: ${out.domain.error}` : 'Your domain is set. It can take a few minutes to reach everyone.'] : []),
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
  const settings = built ? s.found?.site.settings ?? [] : [];
  const back = () => patch({ run: undefined });
  const update = async () => { if (await confirmDialog({ title: `Replace what’s live on ${String(run.input.name)}?`, body: 'The new version takes its place. Earlier versions stay on the host.', confirm: 'Update it' })) again(s, run, true); };
  return (
    <Card className="animate-rise space-y-4 p-5 sm:p-7">
      <div className="flex items-start gap-3.5">
        <StatusMark state={failed.status === 'approval_required' ? 'warn' : 'bad'} size={40} solid label="Stopped" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">{failed.status === 'approval_required' ? 'Waiting for your OK' : taken ? 'That name is taken' : `${String(run.input.name)} didn’t go live`}</h2>
          <ErrorLine text={said(failed)} detail={failed.status === 'error' ? failed.error.logTail : undefined} title="What the host said" className="mt-1 text-[13.5px]" />
        </div>
      </div>
      {!!run.lines.length && <ul className="space-y-1 border-t border-line pt-3 text-[12.5px] text-muted">{run.lines.slice(-4).map((l, i) => <li key={i} className="[overflow-wrap:anywhere]">{l}</li>)}</ul>}
      {!!settings.length && <Settings s={s} keys={settings} title="Settings your code reads" note="A missing setting is a common reason a build stops. Fill in what you have, then build again." saveLabel="Save and build again" onSave={() => again(s, run, true)} />}
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {taken && <Button variant="primary" onClick={() => void update()}>Update what’s live</Button>}
        {step?.href && <Button variant="primary" onClick={() => navigate(step.href!)}>{step.label}</Button>}
        {(built || step?.kind === 'retry') && <Button variant={step?.kind === 'retry' || built ? 'primary' : 'secondary'} icon={<RefreshCw size={14} />} onClick={() => again(s, run, built)}>Try again</Button>}
        {step?.kind === 'ask' && <AskButton size="md" label="Ask Unit7 why" prompt={`Putting ${String(run.input.name)} live on ${run.where} failed: “${said(failed)}”. Why, and how do I fix it?`} />}
        <Button variant={taken || step || built ? 'ghost' : 'primary'} onClick={back}>{taken ? 'Pick another name' : 'Back'}</Button>
      </div>
    </Card>
  );
}
