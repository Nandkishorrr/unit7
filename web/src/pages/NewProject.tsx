// New project, three ways in: a repo from GitHub (live on every push), a folder on this computer (picked in the
// Mac's own folder window, sent up on each Deploy), or an empty project to fill later.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, FolderOpen, Globe, Lock, Plus, RefreshCw, Rocket } from 'lucide-react';
import { api, runTool, useApi, type ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { openSignIn } from '../lib/actions';
import { BrandLogo, providerName } from '../brand/BrandLogo';
import { A, act, AiButton, Badge, Button, Dialog, Field, Input, SearchInput, Skeleton, cx, timeAgo, toast, StatusMark } from '../ui';
import { LogoTile, stackLogo } from './kit';
import { askOnHome } from './Help';

type Step = 'pick' | 'github' | 'folder' | 'empty';
interface Made { projectId: string; serviceId: string; name: string; repo?: string; branch?: string; folder?: string }
interface Repo { fullName: string; private: boolean; updatedAt: string; defaultBranch: string; description: string | null; accountId: string; account: string }
interface Folder { path: string; name: string; stack: string }

// the browser runs on the same computer as Unit7 here (the folder routes insist), so its OS is Unit7's
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const HERE = MAC ? 'this Mac' : 'this computer';

export function NewProject({ open, onClose, canDeploy }: { open: boolean; onClose: () => void; canDeploy: boolean }) {
  const [step, setStep] = useState<Step>('pick');
  const [made, setMade] = useState<Made | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) { setStep('pick'); setMade(null); } }, [open]);
  // keyboard focus follows the step (the button that was clicked is gone)
  useEffect(() => { if (open) requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[data-first]')?.focus()); }, [step, !!made]);
  const back = () => setStep('pick');
  const title = made ? `${made.name} is ready` : step === 'github' ? 'From GitHub' : step === 'folder' ? `From a folder on ${HERE}` : step === 'empty' ? 'Empty project' : 'New project';
  return (
    <Dialog open={open} onClose={onClose} title={title} wide>
      <div ref={box}>
        {made ? <Ready made={made} canDeploy={canDeploy} onClose={onClose} />
          : step === 'pick' ? <Choices onPick={setStep} onClose={onClose} />
          : (
            <div key={step} className="animate-rise">
              <button type="button" onClick={back} className="-mt-2 mb-4 inline-flex h-8 items-center gap-1.5 rounded-full pr-2 text-[13px] font-medium text-muted transition hover:text-ink">
                <ArrowLeft size={14} />All ways to start
              </button>
              {step === 'github' ? <FromGithub onMade={setMade} /> : step === 'folder' ? <FromFolder onMade={setMade} /> : <EmptyProject onClose={onClose} />}
            </div>
          )}
      </div>
    </Dialog>
  );
}

const CHOICES: { step: Step; icon: ReactNode; title: string; body: string; best?: boolean }[] = [
  { step: 'github', icon: <BrandLogo id="github" size={24} />, title: 'From GitHub', body: 'Pick one of your repos. Every push goes live by itself.', best: true },
  { step: 'folder', icon: <FolderOpen size={22} />, title: `From a folder on ${HERE}`, body: 'Pick your project’s folder. Deploy sends it up and puts it live.' },
  { step: 'empty', icon: <Plus size={22} />, title: 'Empty project', body: 'Start blank and add apps when you’re ready.' },
];

function Choices({ onPick, onClose }: { onPick: (s: Step) => void; onClose: () => void }) {
  return (
    <>
    <div className="stagger grid gap-3 sm:grid-cols-3">
      {CHOICES.map((c, i) => (
        <button type="button" key={c.step} onClick={() => onPick(c.step)} data-first={i === 0 ? '' : undefined}
          className="lift group flex flex-col sm:min-h-[200px] items-start gap-4 rounded-[22px] border border-line bg-surface p-5 text-left transition-colors hover:border-blue focus-visible:border-blue">
          <span className="flex w-full items-start justify-between gap-2">
            <span className="grid size-12 place-items-center rounded-2xl bg-raised text-ink transition-colors group-hover:bg-blue-soft group-hover:text-blue-text">{c.icon}</span>
            {c.best && <Badge tone="lime">Recommended</Badge>}
          </span>
          <span className="block">
            <span className="block text-[15.5px] font-semibold tracking-[-0.015em] text-ink">{c.title}</span>
            <span className="mt-1 block text-[13px] text-muted">{c.body}</span>
          </span>
          <span className="mt-auto inline-flex items-center gap-1 text-[13px] font-medium text-blue-text">Start<ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" /></span>
        </button>
      ))}
    </div>
    <A href="/live" onClick={onClose} className="group mt-3 flex items-center gap-3 rounded-[18px] bg-raised p-3.5 text-left transition-colors hover:bg-blue-soft">
      <span className="grid size-10 shrink-0 place-items-center rounded-[13px] bg-surface text-ink transition-colors group-hover:text-blue-text"><Rocket size={18} aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold tracking-[-0.01em] text-ink">Just want it on the internet? Put this live</span>
        <span className="block text-[12.5px] text-muted">Drop a folder or a ZIP, or pick a repo. It goes on Vercel or your server, no terminal.</span>
      </span>
      <ArrowRight size={16} aria-hidden className="shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-blue-text" />
    </A>
    </>
  );
}

// The project with its three environments, and one app in production. If the app can't be made, the project
// still opens (act already said what went wrong).
async function createWithApp(name: string, repo: string | undefined, source?: object): Promise<{ projectId: string; serviceId: string } | null> {
  const p = await act('project.create', { name, repo });
  if (!p) return null;
  const prod = p.output.environments.find((e: { kind: string }) => e.kind === 'production');
  const s = await act('service.create', { environmentId: prod.id, name, source });
  if (!s) { navigate(`/projects/${p.output.projectId}`); return null; }
  return { projectId: p.output.projectId, serviceId: s.output.serviceId };
}

// --- from GitHub ---------------------------------------------------------------------------------------
// onRepo: just pick a repo (the Put this live page), no project made
export function FromGithub({ onMade, onRepo }: { onMade?: (m: Made) => void; onRepo?: (r: Repo) => void }) {
  const conns = useApi<any[]>('/api/connections', { live: (e) => e.type.startsWith('account.') });
  const gh = conns.data?.find((c) => c.id === 'github');
  const linked = (gh?.accounts ?? []).filter((a: any) => !a.pending).length;
  const pending = gh?.accounts.find((a: any) => a.finishUrl);
  const [list, setList] = useState<{ repos: Repo[]; problems: { account: string; message: string }[] } | null>(null);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<Repo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setList(null);
    const r = await runTool('github.repos').catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setList(r.status === 'ok' ? r.output : { repos: [], problems: [{ account: 'GitHub', message: r.status === 'error' ? r.error.message : 'Couldn’t reach GitHub.' }] });
  };
  useEffect(() => { if (linked) void load(); }, [linked]);
  const shown = useMemo(() => (list?.repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q.trim().toLowerCase())), [list, q]);

  const connect = async () => {
    setBusy(true);
    if (gh?.cli) { // the GitHub CLI is signed in on this Mac: no browser at all
      try { await api('/api/connect/github/cli', { body: {} }); conns.reload(); } catch (e) { toast('bad', 'Couldn’t connect GitHub', (e as Error).message); }
    } else await openSignIn('github', 'GitHub'); // a new tab; this one updates by itself when it's done
    setBusy(false);
  };
  const create = async () => {
    if (!pick) return;
    if (onRepo) return onRepo(pick);
    setBusy(true);
    const name = pick.fullName.split('/')[1]!;
    const r = await createWithApp(name, pick.fullName, { type: 'git', repo: pick.fullName, branch: pick.defaultBranch, accountId: pick.accountId });
    setBusy(false);
    if (r) onMade?.({ ...r, name, repo: pick.fullName, branch: pick.defaultBranch });
  };

  if (!conns.data) return <Skeleton className="h-48 rounded-[20px]" />;
  if (!linked) return (
    <div className="flex flex-col items-center rounded-[22px] bg-raised px-6 py-10 text-center">
      <LogoTile id="github" size={56} className="bg-surface" />
      {pending ? <>
        <p className="mt-4 text-[15px] font-medium">One more step on GitHub</p>
        <p className="mt-1 max-w-sm text-[13.5px] text-muted">Pick which repos Unit7 may use. Then come back here.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <a data-first href={pending.finishUrl} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-2 rounded-full bg-blue px-4.5 text-[13.5px] font-medium text-white transition hover:brightness-110">Finish on GitHub<ExternalLink size={14} /></a>
          <Button variant="soft" icon={<RefreshCw size={14} />} onClick={() => conns.reload()}>I’ve done it</Button>
        </div>
      </> : <>
        <p className="mt-4 text-[15px] font-medium">Connect GitHub to see your repos</p>
        <p className="mt-1 max-w-sm text-[13.5px] text-muted">{gh?.cli ? 'Uses the GitHub sign-in already on this Mac. One click.' : 'GitHub opens in a new tab. When you’re done, your repos show up here.'}</p>
        <Button data-first className="mt-5" variant="primary" loading={busy} icon={<BrandLogo id="github" size={15} />} onClick={connect}>Connect GitHub</Button>
      </>}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SearchInput className="flex-1" value={q} onChange={setQ} placeholder="Search your repos" label="Search your repos" />
        <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={load} aria-label="Load the list again" title="Load the list again" />
      </div>
      {!list ? <Skeleton className="h-[300px] rounded-[20px]" /> : (
        <>
          {list.problems.map((p) => <p key={p.account} role="alert" className="rounded-[14px] bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-ink-2">{p.account}: {p.message}</p>)}
          {shown.length === 0 ? (
            <p className="rounded-[18px] bg-raised px-4 py-10 text-center text-[13.5px] text-muted">{q ? `No repo called “${q}”.` : 'No repos here yet.'}</p>
          ) : (
            <ul className="max-h-[340px] space-y-1 overflow-y-auto pr-1" aria-label="Your repos">
              {shown.map((r, i) => {
                const on = pick?.fullName === r.fullName;
                const [owner, repo] = r.fullName.split('/');
                return (
                  <li key={r.fullName}>
                    <button type="button" aria-pressed={on} onClick={() => setPick(r)} data-first={i === 0 && !q ? '' : undefined}
                      className={cx('flex w-full items-center gap-3 rounded-[16px] border px-3 py-2.5 text-left transition-colors', on ? 'border-blue bg-blue-soft' : 'border-transparent hover:bg-raised')}>
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-raised text-ink-2">{r.private ? <Lock size={15} aria-hidden /> : <Globe size={15} aria-hidden />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px]"><span className="text-muted">{owner}/</span><span className="font-semibold text-ink">{repo}</span></span>
                        <span className="block truncate text-[12px] text-muted">{r.private ? 'Private' : 'Public'} · updated {timeAgo(r.updatedAt)}{r.description ? ` · ${r.description}` : ''}</span>
                      </span>
                      <span className={cx('grid size-5 shrink-0 place-items-center rounded-full', on ? 'bg-blue text-white' : 'border border-line-strong')}>{on && <Check size={11} strokeWidth={3} />}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
        <p className="mr-auto min-w-0 text-[12.5px] text-muted" aria-live="polite">{pick ? <>Goes live from <b className="font-medium text-ink-2">{pick.defaultBranch}</b>{onRepo ? '' : ' on every push'}</> : 'Pick a repo'}</p>
        <Button variant="primary" loading={busy} disabled={!pick} onClick={create}>{onRepo ? 'Use this repo' : 'Create project'}</Button>
      </div>
    </div>
  );
}

// --- from a folder on this computer -------------------------------------------------------------------------
function FromFolder({ onMade }: { onMade: (m: Made) => void }) {
  const [folder, setFolder] = useState<Folder | null>(null);
  const [typing, setTyping] = useState(!MAC);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [waiting, setWaiting] = useState<'finder' | 'path' | null>(null);
  const [busy, setBusy] = useState(false);

  // no path: the Mac's folder window; a path: just check it
  const look = async (p?: string) => {
    setWaiting(p ? 'path' : 'finder');
    try {
      const r = await api<Folder & { cancelled?: boolean }>('/api/local/choose-folder', { body: p ? { path: p } : {} });
      if (!r.cancelled) { setFolder(r); setName(r.name); }
    } catch (e) {
      if ((e as ApiError).code === 'no_picker') setTyping(true);
      toast('bad', 'Couldn’t use that folder', (e as Error).message);
    }
    setWaiting(null);
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!folder) return;
    setBusy(true);
    const r = await createWithApp(name.trim() || folder.name, undefined);
    if (r) {
      try { await api('/api/local/link-folder', { body: { serviceId: r.serviceId, path: folder.path } }); onMade({ ...r, name: name.trim() || folder.name, folder: folder.path }); }
      catch (err) { toast('bad', 'Made the project, but couldn’t link the folder', (err as Error).message); navigate(`/projects/${r.projectId}`); }
    }
    setBusy(false);
  };

  if (folder) {
    const known = folder.stack !== 'unknown';
    return (
      <form onSubmit={create} className="space-y-5">
        <div className="flex items-center gap-3.5 rounded-[20px] bg-raised p-4 animate-pop">
          <LogoTile id={known ? stackLogo({ kind: 'app', stack: folder.stack }) : undefined} size={52} className="bg-surface">{!known && <FolderOpen size={22} className="text-muted" />}</LogoTile>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold">{folder.name}</p>
            <p className="truncate font-mono text-[12px] text-muted" title={folder.path}>{folder.path}</p>
            <p className="mt-0.5 text-[12.5px] text-ink-2">{known ? `Looks like ${providerName(stackLogo({ kind: 'app', stack: folder.stack }))}` : 'Unit7 works out how to build it when you deploy.'}</p>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setFolder(null)}>Pick another</Button>
        </div>
        <Field label="Project name"><Input data-first required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="flex justify-end"><Button variant="primary" loading={busy}>Create project</Button></div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      {MAC && (
        <div className="flex flex-col items-center rounded-[22px] border-2 border-dashed border-line-strong px-6 py-10 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-blue-soft text-blue-text"><FolderOpen size={26} /></span>
          <p className="mt-4 text-[15px] font-medium">Pick your project’s folder</p>
          <p className="mt-1 max-w-sm text-[13.5px] text-muted" aria-live="polite">{waiting === 'finder' ? 'A Finder window is open. Pick the folder there (it may be behind this one).' : 'Unit7 opens a Finder window on this Mac.'}</p>
          <Button data-first className="mt-5" variant="primary" loading={waiting === 'finder'} disabled={!!waiting} icon={<FolderOpen size={15} />} onClick={() => look()}>{waiting === 'finder' ? 'Waiting for Finder…' : 'Choose folder…'}</Button>
          {!typing && <button type="button" onClick={() => setTyping(true)} className="mt-3 rounded-full px-2 text-[12.5px] text-muted transition hover:text-ink">or type its path</button>}
        </div>
      )}
      {!MAC && <p className="text-[13.5px] text-muted">Type the full path of your project’s folder on this computer.</p>}
      {typing && (
        <form onSubmit={(e) => { e.preventDefault(); if (path.trim()) void look(path.trim()); }} className="flex items-end gap-2 animate-rise">
          <div className="min-w-0 flex-1"><Field label="Folder path"><Input data-first={MAC ? undefined : ''} autoFocus={MAC} value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/my-app" className="font-mono" spellCheck={false} autoComplete="off" /></Field></div>
          <Button variant={MAC ? 'secondary' : 'primary'} loading={waiting === 'path'} disabled={!path.trim() || !!waiting}>Use this folder</Button>
        </form>
      )}
    </div>
  );
}

// --- empty: name it, pick its environments ---------------------------------------------------------------------
function EmptyProject({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', repo: '', envs: ['development', 'staging', 'production'] });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await act('project.create', { name: f.name, repo: f.repo || undefined, environments: f.envs }, { success: `Created ${f.name}` });
    setBusy(false);
    if (r) { onClose(); navigate(`/projects/${r.output.projectId}`); }
  };
  const toggle = (k: string) => setF({ ...f, envs: f.envs.includes(k) ? f.envs.filter((x) => x !== k) : [...f.envs, k] });
  const ENVS: [string, string, string][] = [['production', 'Production', 'The live site'], ['staging', 'Staging', 'A copy to check things'], ['development', 'Dev', 'A place to try things']];
  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Name"><Input data-first required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Client portal" /></Field>
      <Field label="Code on GitHub" hint="Optional. Like acme/client-portal, or any git link."><Input value={f.repo} onChange={(e) => setF({ ...f, repo: e.target.value })} placeholder="acme/client-portal" /></Field>
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-ink-2">Environments</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {ENVS.map(([k, label, hint]) => {
            const on = f.envs.includes(k);
            return (
              <button type="button" key={k} aria-pressed={on} onClick={() => toggle(k)}
                className={cx('rounded-[16px] border px-3 py-2.5 text-left transition', on ? 'border-blue bg-blue-soft' : 'border-line-strong hover:bg-raised')}>
                <span className="flex items-center justify-between text-[13.5px] font-medium">{label}<span className={cx('grid size-4 place-items-center rounded-full', on ? 'bg-blue text-white' : 'border border-line-strong')}>{on && <Check size={10} strokeWidth={3} />}</span></span>
                <span className="block text-[11.5px] text-muted">{hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f.envs.length}>Create project</Button></div>
    </form>
  );
}

// --- made: deploy it now, open it, or ask Unit7 about it ------------------------------------------------
function Ready({ made, canDeploy, onClose }: { made: Made; canDeploy: boolean; onClose: () => void }) {
  const open = () => { onClose(); navigate(`/projects/${made.projectId}`); };
  // a deploy takes minutes: start it, and watch it on the project page
  const deploy = () => {
    toast('info', `Deploying ${made.name}`, 'Follow along on the project page.');
    void act('deployment.create', { serviceId: made.serviceId }, { success: `${made.name} is live` });
    open();
  };
  return (
    <div className="space-y-5 animate-rise">
      <div className="flex items-start gap-3.5 rounded-[20px] bg-raised p-4">
        <StatusMark state="ok" size={40} solid label="Linked" />
        <div className="min-w-0">
          <p className="text-[14.5px] font-medium">{made.folder ? 'Linked to your folder' : <>Linked to <span className="font-semibold">{made.repo}</span></>}</p>
          <p className="mt-0.5 text-[13px] text-muted">{made.folder ? 'Each Deploy sends this folder up and puts it live.' : `After the first deploy, every push to ${made.branch} goes live by itself.`}</p>
          {made.folder && <p className="mt-1 truncate font-mono text-[12px] text-muted" title={made.folder}>{made.folder}</p>}
        </div>
      </div>
      {!canDeploy && (
        <p className="rounded-[16px] bg-warn/10 px-4 py-3 text-[13px] text-ink-2">
          There’s no server to put it on yet. <A href="/servers?new=1" onClick={onClose} className="font-medium text-blue-text hover:underline">Add a server</A>, then deploy from the project page.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {made.folder && <AiButton onClick={() => { onClose(); askOnHome(`What does the project in ${made.folder} need to go live?`); }}>Ask Unit7 about it</AiButton>}
        <Button data-first={canDeploy ? undefined : ''} variant={canDeploy ? 'secondary' : 'primary'} onClick={open}>Open project</Button>
        {canDeploy && <Button data-first variant="primary" icon={<Rocket size={15} />} onClick={deploy}>Deploy now</Button>}
      </div>
    </div>
  );
}
