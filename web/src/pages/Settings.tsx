// Settings: one pill tab per topic, each a few clean cards.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, Plus, Trash2, UserPlus, Users, User, Palette, Building2, LogOut, Lock, DatabaseBackup, FolderSync, Archive, Bell, Pause, Play, TriangleAlert, Sparkles, Terminal, Sun, Moon, Monitor, Check, Siren, Rocket, ShieldCheck, Wallet, Shield, Activity, Heart, Star, Bug } from 'lucide-react';
import { api, useApi, runTool } from '../lib/api';
import { navigate, useQuery } from '../lib/router';
import { act, Badge, Button, Card, CardHeader, CopyButton, Dialog, Field, HoldButton, IconCircle, Input, Mono, PageHeader, Select, Skeleton, StatusMark, SwitchRow, Tabs, Textarea, cx, promptDialog, timeAgo, toast } from '../ui';
import { tidy } from '../lib/words';
import { Avatar, LINKS, SupportButton, useTheme, type Me } from '../App';
import { BrandLogo } from '../brand/BrandLogo';
import { AlertChannels } from './Connections';
import { SecurityTab } from './security/SecurityCheck';
import { WatchTab } from './watch/WatchSettings';
import { passkeyHere } from './Auth';
import { AutofixCard } from './servers/Automation';
import { FreshSettings } from './fresh';

const ROLES: Record<string, [string, string]> = {
  owner: ['Owner', 'Everything, including other owners.'],
  admin: ['Admin', 'Everything except managing owners. Approves risky changes on live apps.'],
  developer: ['Developer', 'Builds and deploys. Deleting things on live apps needs an admin.'],
  agent: ['AI app', 'For AI apps and scripts. Works within each environment’s Autopilot level.'],
  readonly: ['View only', 'Sees everything, changes nothing.'],
  auditor: ['Auditor', 'Reads the full record and settings, changes nothing.'],
};
const role = (r: string) => ROLES[r]?.[0] ?? r;

type Tab = 'profile' | 'team' | 'signin' | 'ai' | 'security' | 'backups' | 'alerts' | 'watch' | 'updates' | 'danger';
const TABS: { value: Tab; label: string }[] = [
  { value: 'profile', label: 'Profile' }, { value: 'team', label: 'Team' }, { value: 'signin', label: 'Sign-in & passkeys' },
  { value: 'ai', label: 'Connected AI apps' }, { value: 'security', label: 'Security' }, { value: 'backups', label: 'Backups' }, { value: 'alerts', label: 'Alerts' }, { value: 'watch', label: 'Watch' }, { value: 'updates', label: 'Updates' }, { value: 'danger', label: 'Danger zone' },
];

export function SettingsPage({ me, reloadMe }: { me: Me; reloadMe: () => void }) {
  const q = useQuery().get('tab');
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.value === q) ? q as Tab : 'profile'));
  const go = (t: Tab) => { setTab(t); navigate(t === 'profile' ? '/settings' : `/settings?tab=${t}`, { replace: true }); };
  return (
    <>
      <PageHeader title="Settings" subtitle={`${me.org.name} · signed in as ${me.user.email}`} />
      <div className="[&>div]:[scrollbar-width:none]"><Tabs value={tab} onChange={go} tabs={TABS} /></div>
      <div key={tab} className="stagger mt-8 grid items-start gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        {tab === 'profile' && <ProfileTab me={me} />}
        {tab === 'team' && <TeamTab me={me} />}
        {tab === 'signin' && <SignInTab me={me} reloadMe={reloadMe} />}
        {tab === 'ai' && <AiAppsTab />}
        {tab === 'security' && <SecurityTab canChange={!['readonly', 'auditor', 'agent'].includes(me.role)} />}
        {tab === 'security' && <AutofixCard canChange={!['readonly', 'auditor', 'agent'].includes(me.role)} />}
        {tab === 'backups' && <BackupsTab me={me} />}
        {tab === 'alerts' && <AlertsTab />}
        {tab === 'watch' && <WatchTab canChange={!['readonly', 'auditor', 'agent'].includes(me.role)} />}
        {tab === 'updates' && <FreshSettings canChange={!['readonly', 'auditor', 'agent'].includes(me.role)} />}
        {tab === 'danger' && <DangerTab me={me} />}
      </div>
    </>
  );
}

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 py-3"><dt className="w-36 text-[13px] text-muted">{k}</dt><dd className="min-w-0 flex-1 text-[14px] text-ink">{children}</dd></div>
);

// --- profile ----------------------------------------------------------------------------------------------
function ProfileTab({ me }: { me: Me }) {
  const [t, setT] = useTheme();
  return (
    <>
      <Card className="p-5 md:p-6 lg:col-span-2">
        <div className="flex items-center gap-4">
          <Avatar name={me.user.name} size={56} />
          <div className="min-w-0">
            <h2 className="truncate text-[20px] font-semibold tracking-[-0.025em]">{me.user.name}</h2>
            <p className="truncate text-[13.5px] text-muted">{me.user.email}</p>
          </div>
          <Badge tone="ember" className="ml-auto">{role(me.role)}</Badge>
        </div>
        <dl className="mt-5 divide-y divide-line border-t border-line">
          <Row k="What you can do">{ROLES[me.role]?.[1]}</Row>
          <Row k="Password">To change it, run <Mono className="rounded-md bg-raised px-1.5 py-0.5 text-ink">unit7 password</Mono> on the computer Unit7 runs on.</Row>
        </dl>
      </Card>
      <Card className="p-5 md:p-6">
        <CardHeader tone="grad" icon={<Building2 size={20} />} title="Organization" sub="Switch or add one from the menu under your name." />
        <dl className="mt-4 divide-y divide-line border-t border-line">
          <Row k="Name">{me.org.name}</Row>
          <Row k="Your role">{role(me.role)}</Row>
          {me.orgs.length > 1 && <Row k="Also in">{me.orgs.filter((o) => o.id !== me.org.id).map((o) => o.name).join(', ')}</Row>}
        </dl>
      </Card>
      <Card className="p-5 md:p-6">
        <CardHeader tone="grad" icon={<Palette size={20} />} title="Appearance" sub="Saved on this browser." />
        <div role="radiogroup" aria-label="Theme" className="mt-5 grid grid-cols-3 gap-2">
          {([['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'Match my computer', Monitor]] as const).map(([v, label, I]) => (
            <button key={v} type="button" role="radio" aria-checked={t === v} onClick={() => setT(v)}
              className={cx('flex h-12 items-center justify-center gap-2 rounded-[16px] border text-[13.5px] font-medium transition',
                t === v ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2 hover:bg-raised')}>
              <I size={16} /><span className="truncate">{label}</span>
            </button>
          ))}
        </div>
      </Card>
      <Card className="p-5 md:p-6 lg:col-span-2">
        <CardHeader tone="grad" icon={<Heart size={20} />} title="About Unit7" sub="Free and open source, under the Apache 2.0 license." />
        <dl className="mt-4 divide-y divide-line border-t border-line">
          <Row k="Source code"><a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 font-medium text-blue-text hover:underline"><BrandLogo id="github" size={15} title="GitHub" />github.com/Nandkishorrr/unit7</a></Row>
          <Row k="Made by"><a href={LINKS.author} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-text hover:underline">@Nandkishorrr</a></Row>
          <Row k="Found a bug?"><a href={`${LINKS.repo}/issues/new`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-blue-text hover:underline"><Bug size={14} />Open an issue</a></Row>
        </dl>
        <div className="mt-5 flex flex-wrap gap-2">
          <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[13.5px] font-medium text-ink transition hover:bg-raised"><Star size={15} />Star on GitHub</a>
          <SupportButton className="inline-flex" />
        </div>
      </Card>
    </>
  );
}

// --- team -------------------------------------------------------------------------------------------------
function TeamTab({ me }: { me: Me }) {
  const data = useApi<{ members: any[]; invites: any[] }>('/api/members', { live: false });
  const [inviting, setInviting] = useState(false);
  const [f, setF] = useState({ email: '', role: 'developer' });
  const [link, setLink] = useState<string | null>(null);
  const [access, setAccess] = useState({ key: '', servers: [] as string[], sudo: false, send: false, from: '' });
  const [said, setSaid] = useState<string[]>([]);
  const admin = ['owner', 'admin'].includes(me.role);
  const graph = useApi<{ servers: { id: string; name: string }[] }>(inviting ? '/api/graph' : null, { live: false });
  const conns = useApi<{ id: string; accounts: unknown[] }[]>(inviting ? '/api/connections' : null, { live: false });
  const sender = !!conns.data?.find((c) => c.id === 'resend')?.accounts.length; // an emailed invite needs something to send it with
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/api/invites', { body: f });
      setLink(r.link); data.reload();
      const notes: string[] = [];
      if (access.key.trim() && access.servers.length) {
        const a = await runTool('team.give_access', { email: f.email, publicKey: access.key.trim(), servers: access.servers, sudo: access.sudo });
        if (a.status === 'ok') notes.push(...(a.output as { user: string; servers: { server: string; ok: boolean; note?: string }[] }).servers.map((s) => (s.ok ? `${s.server}: they can sign in as ${(a.output as { user: string }).user}.` : `${s.server}: ${tidy(s.note ?? 'that didn’t work')}`)));
        else notes.push(tidy(a.status === 'error' ? a.error.message : a.status === 'denied' ? a.why : 'Server access is waiting for approval.'));
      }
      if (access.send) {
        const m = await runTool('team.email_invite', { email: f.email, link: r.link, ...(access.from && { from: access.from }) });
        notes.push(m.status === 'ok' ? `Emailed to ${f.email}.` : `Not emailed: ${tidy(m.status === 'error' ? m.error.message : 'not allowed')} Send the link yourself.`);
      }
      setSaid(notes);
    } catch (err) { toast('bad', 'Couldn’t make the invite', tidy((err as Error).message)); }
  };
  return (
    <>
      <Card className="p-5 md:p-6">
        <CardHeader tone="grad" icon={<Users size={20} />} title="People" sub={data.data ? `${data.data.members.length} in ${me.org.name}` : undefined}
          actions={admin && <Button size="sm" variant="primary" icon={<UserPlus size={14} />} onClick={() => { setLink(null); setSaid([]); setAccess({ key: '', servers: [], sudo: false, send: false, from: '' }); setInviting(true); }}>Invite</Button>} />
        {!data.data ? <Skeleton className="mt-5 h-20" /> : (
          <ul className="mt-4 divide-y divide-line">
            {data.data.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
                <Avatar name={m.name} size={36} />
                <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-medium">{m.name}{m.id === me.user.id && <span className="font-normal text-muted"> (you)</span>}</p><p className="truncate text-[12.5px] text-muted">{m.email}</p></div>
                {admin && m.id !== me.user.id ? (
                  <Select value={m.role} onChange={async (r) => { try { await api(`/api/members/${m.id}`, { method: 'PATCH', body: { role: r } }); toast('ok', `${m.name} is now ${role(r).toLowerCase()}`); data.reload(); } catch (e) { toast('bad', 'Couldn’t change that', tidy((e as Error).message)); } }}
                    options={['owner', 'admin', 'developer', 'readonly', 'auditor'].map((r) => ({ value: r, label: role(r) }))} />
                ) : <Badge>{role(m.role)}</Badge>}
                {admin && m.id !== me.user.id && <button type="button" aria-label={`Remove ${m.name}`} onClick={async () => { if (confirm(`Remove ${m.name}? They’re signed out of ${me.org.name} right away.`)) { try { const r = await api(`/api/members/${m.id}`, { method: 'DELETE' }); data.reload(); if (r.stillOn?.length) toast('warn', `${m.name} can still sign in to ${r.stillOn.map((x: { server: string }) => x.server).join(', ')}`, 'Take them off on each server’s Advanced tab. Unit7 doesn’t remove that by itself.'); } catch (e) { toast('bad', 'Couldn’t remove them', tidy((e as Error).message)); } } }} className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-bad"><Trash2 size={15} /></button>}
              </li>
            ))}
          </ul>
        )}
        {admin && !!data.data?.invites.length && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="mb-2 text-[12px] font-medium uppercase tracking-[0.06em] text-faint">Invited</p>
            <ul className="space-y-2">{data.data.invites.map((i) => <li key={i.id} className="flex items-center gap-3 text-[13.5px]"><span className="min-w-0 flex-1 truncate">{i.email}</span><Badge>{role(i.role)}</Badge><span className="text-[12px] text-muted">until {new Date(i.expires_at).toLocaleDateString()}</span></li>)}</ul>
          </div>
        )}
      </Card>
      <Card className="p-5 md:p-6">
        <CardHeader tone="grad" icon={<User size={20} />} title="What each role can do" />
        <dl className="mt-4 divide-y divide-line border-t border-line">{Object.entries(ROLES).map(([r, [name, what]]) => <Row key={r} k={name}><span className="text-ink-2">{what}</span></Row>)}</dl>
      </Card>
      <Dialog open={inviting} onClose={() => setInviting(false)} title="Invite someone">
        {link ? (
          <div className="space-y-4">
            <p className="text-[13.5px] text-muted">Send this link to {f.email}. It works once, for 7 days.</p>
            <div className="flex items-center gap-2 rounded-[14px] bg-raised p-3"><Mono className="flex-1 break-all">{link}</Mono><CopyButton text={link} /></div>
            {said.length > 0 && <ul className="space-y-1 text-[13px] text-ink-2">{said.map((l) => <li key={l}>{l}</li>)}</ul>}
            <div className="flex justify-end"><Button variant="primary" onClick={() => setInviting(false)}>Done</Button></div>
          </div>
        ) : (
          <form onSubmit={invite} className="space-y-4">
            <Field label="Email"><Input autoFocus required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Role" hint={ROLES[f.role]?.[1]}><Select className="w-full" value={f.role} onChange={(r) => setF({ ...f, role: r })} options={['developer', 'admin', 'readonly', 'auditor', 'owner'].map((r) => ({ value: r, label: role(r) }))} /></Field>
            {!!graph.data?.servers.length && (
              <Field label="Server access (optional)" hint="Their own user on the servers you tick, signing in with this key. Paste the one line from their .pub file.">
                <Textarea rows={2} className="font-mono text-[12.5px]" value={access.key} onChange={(e) => setAccess({ ...access, key: e.target.value })} />
                {access.key.trim() && (
                  <div className="mt-2 space-y-1.5">
                    {graph.data.servers.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" className="size-4" checked={access.servers.includes(s.id)} onChange={(e) => setAccess({ ...access, servers: e.target.checked ? [...access.servers, s.id] : access.servers.filter((x) => x !== s.id) })} />{s.name}</label>
                    ))}
                    <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" className="size-4" checked={access.sudo} onChange={(e) => setAccess({ ...access, sudo: e.target.checked })} />Let them do anything on those servers (sudo)</label>
                  </div>
                )}
              </Field>
            )}
            {sender && (
              <Field label="Email it" hint="Sent through Resend. Leave the address empty to use its default.">
                <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" className="size-4" checked={access.send} onChange={(e) => setAccess({ ...access, send: e.target.checked })} />Email the invite to them</label>
                {access.send && <Input className="mt-2" type="email" placeholder="Send from, on a domain you verified" value={access.from} onChange={(e) => setAccess({ ...access, from: e.target.value })} />}
              </Field>
            )}
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setInviting(false)}>Cancel</Button><Button variant="primary" icon={<UserPlus size={14} />}>Make an invite link</Button></div>
          </form>
        )}
      </Dialog>
    </>
  );
}

// --- sign-in & passkeys -----------------------------------------------------------------------------------
function SignInTab({ me, reloadMe }: { me: Me; reloadMe: () => void }) {
  const [busy, setBusy] = useState(false);
  const addPasskey = async () => {
    if (!passkeyHere()) return;
    setBusy(true);
    try {
      const options = await api('/api/auth/passkey/register/options', { body: {} });
      const response = await startRegistration({ optionsJSON: options });
      const taken = new Set(me.passkeys.map((k) => String(k.name).toLowerCase()));
      const name = await promptDialog({ title: 'Name this passkey', label: 'Name', value: navigator.platform.includes('Mac') ? 'MacBook' : 'This device', hint: 'So you know which device it is.', confirm: 'Save passkey',
        warn: (v) => (taken.has(v.toLowerCase()) ? `You already have a passkey called “${v}”. A different name makes them easier to tell apart.` : undefined) }) ?? 'Passkey';
      await api('/api/auth/passkey/register/verify', { body: { response, name } });
      toast('ok', 'Passkey added', 'Next time, sign in with it. No password needed.');
      reloadMe();
    } catch (e) {
      toast('bad', 'Couldn’t add the passkey', tidy((e as Error).message));
    }
    setBusy(false);
  };
  return (
    <>
      <Card className="p-5 md:p-6 lg:col-span-2">
        <CardHeader tone="grad" icon={<Fingerprint size={20} />} title="Passkeys" sub="Touch ID, Face ID or a security key." />
        {me.passkeys.length === 0 ? (
          <p className="mt-5 rounded-[18px] bg-raised px-4 py-5 text-[13.5px] text-muted">No passkeys yet. A passkey can’t be phished, and it’s faster than a password.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {me.passkeys.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-3">
                <IconCircle size={36}><Fingerprint size={16} /></IconCircle>
                <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-medium">{p.name}</p><p className="text-[12.5px] text-muted">Added {timeAgo(p.created_at)} · last used {timeAgo(p.last_used_at)}</p></div>
                <button type="button" aria-label={`Remove ${p.name}`} onClick={async () => { if (confirm(`Remove ${p.name}?`)) { await api(`/api/auth/passkey/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); reloadMe(); } }} className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-bad"><Trash2 size={15} /></button>
              </li>
            ))}
          </ul>
        )}
        <Button className="mt-4" size="sm" variant="primary" icon={<Plus size={14} />} loading={busy} onClick={addPasskey}>Add a passkey</Button>
      </Card>
      <Card className="p-5 md:p-6">
        <CardHeader tone="grad" icon={<Lock size={20} />} title="Password" />
        <p className="mt-4 text-[13.5px] text-muted">To set a new password, run this on the computer Unit7 runs on:</p>
        <span className="mt-2 inline-flex items-center gap-0.5 rounded-full bg-raised py-1 pl-3.5 pr-1 font-mono text-[12.5px] text-ink">unit7 password<CopyButton text="unit7 password" /></span>
      </Card>
      <Card className="flex flex-wrap items-center gap-4 p-5 md:p-6">
        <IconCircle><LogOut size={19} /></IconCircle>
        <div className="min-w-0 grow basis-[220px]"><h2 className="text-[16.5px] font-medium tracking-[-0.015em]">This browser</h2><p className="text-[13px] text-muted">You stay signed in for 14 days after you last use Unit7.</p></div>
        <Button variant="soft" onClick={async () => { await api('/api/auth/logout', { body: {} }); location.assign('/'); }}>Sign out</Button>
      </Card>
    </>
  );
}

// --- connected AI apps (keys for AI apps, scripts and CI) --------------------------------------------------------
function AiAppsTab() {
  const tokens = useApi<any[]>('/api/tokens', { live: false });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [f, setF] = useState({ name: 'Claude Code', role: 'agent', expiresDays: '' });
  const origin = location.origin;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/api/tokens', { body: { name: f.name, role: f.role, expiresDays: f.expiresDays ? Number(f.expiresDays) : undefined } });
      setCreated(r.token);
      tokens.reload();
    } catch (err) {
      toast('bad', 'Couldn’t make the key', tidy((err as Error).message));
    }
  };
  const mcp = JSON.stringify({ mcpServers: { unit7: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: 'Bearer <your key>' } } } }, null, 2);
  return (
    <>
      <Card className="flex flex-wrap items-center gap-4 bg-blue-soft p-5 shadow-none md:p-6 lg:col-span-2">
        <IconCircle tone="blue"><Sparkles size={19} /></IconCircle>
        <p className="min-w-0 grow basis-[220px] text-[14px] text-ink">The easy way: connect Claude Code, Cursor or Antigravity with one click on <b>Connections</b>. Keys here are for scripts and anything you set up by hand.</p>
        <Button variant="primary" onClick={() => navigate('/connections')}>Open Connections</Button>
      </Card>
      <Card className="p-5 md:p-6">
        <CardHeader tone="grad" icon={<KeyRound size={20} />} title="App keys" sub="Never more than your own role." />
        {!tokens.data ? <Skeleton className="mt-5 h-16" /> : !tokens.data.length ? (
          <p className="mt-5 rounded-[18px] bg-raised px-4 py-5 text-[13.5px] text-muted">No keys yet. Every action an app takes with a key is recorded under the key’s name.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {tokens.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-3">
                <IconCircle size={36}><KeyRound size={16} /></IconCircle>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[14px] font-medium"><span className="truncate">{tidy(t.name)}</span><Badge>{role(t.role)}</Badge></p>
                  <p className="text-[12.5px] text-muted">{/^forge_/.test(t.prefix ?? '') ? <>Made before the rename · <button type="button" onClick={() => { setF({ ...f, name: tidy(t.name) }); setCreated(null); setCreating(true); }} className="font-medium text-blue-text hover:underline">Replace it</button></> : <>Starts with <Mono className="text-[12px]">{t.prefix}</Mono></>} · used {timeAgo(t.last_used_at)}{t.expires_at ? ` · ends ${new Date(t.expires_at).toLocaleDateString()}` : ''}</p>
                </div>
                <button type="button" aria-label={`Turn off ${t.name}`} onClick={async () => { if (confirm(`Turn off ${t.name}? Anything using it stops working right away.`)) { await api(`/api/tokens/${t.id}`, { method: 'DELETE' }); tokens.reload(); } }} className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-bad"><Trash2 size={15} /></button>
              </li>
            ))}
          </ul>
        )}
        <Button className="mt-4" size="sm" variant="soft" icon={<Plus size={14} />} onClick={() => { setCreated(null); setCreating(true); }}>New key</Button>
      </Card>
      <Card className="min-w-0 p-5 md:p-6">
        <CardHeader tone="grad" icon={<Terminal size={20} />} title="Connect an AI app by hand" sub="For any app that speaks MCP." />
        <p className="mt-4 text-[13.5px] text-muted">Make a key with the <b>AI app</b> role, then add this to the app’s settings:</p>
        <div className="relative mt-2"><pre className="overflow-auto rounded-[16px] bg-raised p-4 font-mono text-[12px] text-ink-2">{mcp}</pre><CopyButton text={mcp} className="absolute right-2 top-2" /></div>
        <p className="mt-3 text-[13px] text-muted">In Claude Code, one line does it:</p>
        <div className="mt-1.5 flex items-start gap-1 rounded-[16px] bg-raised py-2 pl-4 pr-1.5"><Mono className="min-w-0 flex-1 break-all py-1 text-ink">{`claude mcp add --transport http unit7 ${origin}/mcp --header "Authorization: Bearer <your key>"`}</Mono><CopyButton text={`claude mcp add --transport http unit7 ${origin}/mcp --header "Authorization: Bearer <your key>"`} /></div>
      </Card>
      <Dialog open={creating} onClose={() => setCreating(false)} title={created ? 'Copy your key now' : 'New app key'}>
        {created ? (
          <div className="space-y-4">
            <p className="text-[13.5px] text-muted">This is the only time it’s shown. Unit7 keeps only a fingerprint of it.</p>
            <div className="flex items-center gap-2 rounded-[14px] bg-raised p-3"><Mono className="flex-1 break-all text-ink">{created}</Mono><CopyButton text={created} /></div>
            <div className="flex justify-end"><Button variant="primary" icon={<Check size={15} />} onClick={() => setCreating(false)}>I’ve saved it</Button></div>
          </div>
        ) : (
          <form onSubmit={create} className="space-y-4">
            <Field label="Name" hint="So you know which app is which."><Input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Role" hint={ROLES[f.role]?.[1]}><Select className="w-full" value={f.role} onChange={(r) => setF({ ...f, role: r })} options={['agent', 'developer', 'readonly', 'auditor', 'admin', 'owner'].map((r) => ({ value: r, label: role(r) }))} /></Field>
            <Field label="Stops working after (days)" hint="Leave empty to keep it until you turn it off."><Input type="number" min={1} value={f.expiresDays} onChange={(e) => setF({ ...f, expiresDays: e.target.value })} /></Field>
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary">Make the key</Button></div>
          </form>
        )}
      </Dialog>
    </>
  );
}

// --- backups: off-server copies to this computer, a synced folder and a bucket ------------------------------------
const STORES: Record<string, { endpoint: string; region: string; how: string }> = {
  r2: { endpoint: '', region: 'auto', how: 'Cloudflare → R2 → Manage API tokens → Create (Object Read & Write).' },
  b2: { endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', how: 'Backblaze → Application Keys → Add (use the bucket’s endpoint).' },
  s3: { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', how: 'AWS → IAM → an access key limited to this bucket.' },
  spaces: { endpoint: 'https://nyc3.digitaloceanspaces.com', region: 'nyc3', how: 'DigitalOcean → Spaces → Access Keys.' },
  wasabi: { endpoint: 'https://s3.us-east-1.wasabisys.com', region: 'us-east-1', how: 'Wasabi → Access Keys.' },
  other: { endpoint: '', region: 'auto', how: 'Any S3-compatible storage, like MinIO.' },
};
function BackupsTab({ me }: { me: Me }) {
  const [st, setSt] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState('r2');
  const [f, setF] = useState({ endpoint: STORES.r2!.endpoint, region: 'auto', bucket: '', accessKey: '', secretKey: '' });
  const [key, setKey] = useState<string | null>(null);
  const load = async () => { try { const r = await runTool('backup.storage'); if (r.status === 'ok') { setSt(r.output); setFailed(false); } else setFailed(true); } catch { setFailed(true); } };
  useEffect(() => { void load(); }, []);
  const owner = me.role === 'owner' || me.role === 'admin';
  if (!st) return failed
    ? <Card className="flex flex-wrap items-center gap-4 p-5 lg:col-span-2"><p className="min-w-0 grow basis-[220px] text-[14px]">Couldn’t read where backups go.</p><Button variant="soft" onClick={load}>Try again</Button></Card>
    : <><Skeleton className="h-48 rounded-[24px]" /><Skeleton className="h-40 rounded-[24px]" /></>;
  return (
    <>
      <Card className="p-5 md:p-6 lg:col-span-2">
        <CardHeader tone="grad" icon={<DatabaseBackup size={20} />} title="Copies off the server" sub="Locked before they leave Unit7, so a lost server never loses its data." />
        <div className="mt-5 grid grid-cols-3 gap-3">
          {([['This computer', `${st.thisComputer.copies}`, `${st.thisComputer.megabytes} MB`], ['Synced folder', st.syncedFolder ? '1' : '0', st.syncedFolder?.name ?? 'None yet'], ['Bucket', st.bucket ? '1' : '0', st.bucket?.name ?? 'None yet']] as const).map(([k, n, sub]) => (
            <div key={k} className="rounded-[18px] bg-raised p-4">
              <p className="text-[12.5px] text-muted">{k}</p>
              <p className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.04em] tabular">{k === 'This computer' ? n : sub === 'None yet' ? '–' : <StatusMark state="ok" size={26} label="In use" />}</p>
              <p className="mt-1.5 truncate text-[12px] text-muted" title={k === 'This computer' ? st.thisComputer.folder : sub}>{k === 'This computer' ? `copies · ${sub}` : sub}</p>
            </div>
          ))}
        </div>
        {st.failedThisWeek > 0 && <p className="mt-3 text-[13px] text-bad">{st.failedThisWeek} copies didn’t go out this week. Open the database’s Backups tab to try again.</p>}
        {st.syncedFolder && !st.syncedFolder.there && <p className="mt-3 text-[13px] text-warn">{st.syncedFolder.name} isn’t there right now. Is its app running?</p>}
        <div className="mt-2 border-t border-line">
          <SwitchRow title="Copy every backup off its server" body="Turn this off only if you copy backups some other way." checked={st.on} disabled={!owner}
            onChange={async (on) => { if (await act('backup.offsite_set', { on })) void load(); }} />
        </div>
      </Card>

      {owner && (
        <Card className="p-5 md:p-6">
          <CardHeader tone="grad" icon={<FolderSync size={20} />} title="Synced folder" sub="Google Drive, iCloud, Dropbox or OneDrive." />
          <div className="mt-4">
            {st.foundFolders.length ? (
              <ul className="divide-y divide-line">
                {st.foundFolders.map((x: any) => (
                  <li key={x.path} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1"><p className="text-[14px] font-medium">{x.name}</p><p className="truncate text-[12px] text-muted" title={x.path}>{x.path}</p></div>
                    {x.blocked ? <span className="max-w-[300px] text-[12.5px] text-warn">macOS hasn’t let Unit7 open it. Allow it under System Settings → Privacy & Security → Full Disk Access, then restart Unit7.</span>
                      : st.syncedFolder?.path === x.path ? <Badge tone="ok" solid>In use</Badge>
                      : <Button size="sm" variant="soft" onClick={async () => { if (await act('backup.folder_set', { path: x.path }, { success: `Backups also go to ${x.name}` })) void load(); }}>Use it</Button>}
                  </li>
                ))}
              </ul>
            ) : <p className="rounded-[18px] bg-raised px-4 py-5 text-[13.5px] text-muted">None found. Install Google Drive for desktop, iCloud Drive, Dropbox or OneDrive, then come back.</p>}
            {st.syncedFolder && <Button size="sm" variant="ghost" className="mt-2" onClick={async () => { if (await act('backup.folder_set', {}, { success: 'Stopped copying to the synced folder' })) void load(); }}>Stop using {st.syncedFolder.name}</Button>}
          </div>
        </Card>
      )}

      {owner && (
        <Card className="p-5 md:p-6 lg:order-last lg:col-span-2">
          <CardHeader tone="grad" icon={<Archive size={20} />} title={st.bucket ? 'Change the bucket' : 'Add a bucket'} sub="A copy outside this computer too." />
          <form className="mt-5 space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await act('backup.storage_connect', f, { success: 'Bucket connected. A test copy worked.' })) { setF({ ...f, secretKey: '' }); void load(); } }}>
            <Field label="Storage" hint={STORES[kind]!.how}>
              <div><Select className="w-full" value={kind} onChange={(v) => { setKind(v); setF((x) => ({ ...x, endpoint: STORES[v]!.endpoint, region: STORES[v]!.region })); }}
                options={[{ value: 'r2', label: 'Cloudflare R2 (no download fees)' }, { value: 'b2', label: 'Backblaze B2' }, { value: 's3', label: 'AWS S3' }, { value: 'spaces', label: 'DigitalOcean Spaces' }, { value: 'wasabi', label: 'Wasabi' }, { value: 'other', label: 'Other S3-compatible' }]} /></div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Address" hint={kind === 'r2' ? 'Your account ID is on the R2 overview page.' : undefined}><Input required type="url" value={f.endpoint} onChange={(e) => setF({ ...f, endpoint: e.target.value })} placeholder={kind === 'r2' ? 'https://<account-id>.r2.cloudflarestorage.com' : 'https://s3.example.com'} /></Field>
              <Field label="Region"><Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /></Field>
              <Field label="Bucket name"><Input required value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value })} placeholder="my-backups" /></Field>
              <Field label="Access key"><Input required value={f.accessKey} onChange={(e) => setF({ ...f, accessKey: e.target.value })} autoComplete="off" /></Field>
              <Field label="Secret key" hint="Type it here, never into a chat."><Input required type="password" value={f.secretKey} onChange={(e) => setF({ ...f, secretKey: e.target.value })} autoComplete="off" /></Field>
            </div>
            <Button variant="primary" disabled={!f.bucket || !f.accessKey || !f.secretKey}>Test and connect</Button>
          </form>
        </Card>
      )}

      {owner && (
        <Card className="p-5 md:p-6">
          <CardHeader tone="grad" icon={<KeyRound size={20} />} title="Recovery key" sub="Opens your copies if this computer is lost." />
          <p className="mt-4 text-[13.5px] text-muted">Save it in your password manager. With it, <Mono className="rounded-md bg-raised px-1.5 py-0.5 text-ink">unit7 backup decrypt</Mono> opens any copy.</p>
          {key ? <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-raised p-3"><Mono className="flex-1 break-all text-ink">{key}</Mono><CopyButton text={key} /></div>
            : <Button className="mt-4" variant="dark" onClick={async () => { const r = await act('backup.recovery_key', {}); if (r) setKey(r.output.recoveryKey); }}>Show the recovery key</Button>}
        </Card>
      )}
    </>
  );
}

// --- alerts ---------------------------------------------------------------------------------------------------
function AlertsTab() {
  return (
    <>
      <Card className="p-5 md:p-6">
        <CardHeader tone="grad" icon={<Bell size={20} />} title="Alerts" sub="Where Unit7 tells you things." />
        <div className="mt-3"><AlertChannels /></div>
        <Button className="mt-4" size="sm" variant="soft" onClick={() => navigate('/connections#alerts')}>Set up channels on Connections</Button>
      </Card>
      <Card className="p-5 md:p-6">
        <CardHeader tone="grad" icon={<Siren size={20} />} title="What you hear about" sub="Only things that need you." />
        <ul className="mt-4 space-y-3 text-[14px]">
          {([[Siren, 'An app or site is down, slow or showing errors'], [Rocket, 'A deploy failed or a domain stopped working'], [ShieldCheck, 'Something is waiting for your OK'],
            [DatabaseBackup, 'A backup didn’t copy off the server or won’t restore'], [Wallet, 'Your budget is nearly spent'], [Lock, 'The weekly security check finds something new and serious'], [Activity, 'Something unusual on a server: a jump in usage, odd traffic, a new risk'], [Shield, 'Once a week: what Unit7 stopped']] as const).map(([I, text]) => (
            <li key={text} className="flex items-center gap-3"><IconCircle size={32}><I size={15} /></IconCircle>{text}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}

// --- danger zone ------------------------------------------------------------------------------------------------
function DangerTab({ me }: { me: Me }) {
  const ap = useApi<{ paused: boolean }>('/api/autopilot', { live: (e) => e.type.startsWith('autopilot.') });
  const tokens = useApi<any[]>('/api/tokens', { live: false });
  const [busy, setBusy] = useState<string | null>(null);
  const admin = ['owner', 'admin'].includes(me.role);
  const offAll = async () => {
    const list = tokens.data ?? [];
    setBusy('keys');
    try { for (const t of list) await api(`/api/tokens/${t.id}`, { method: 'DELETE' }); toast('ok', 'Every app key is off'); }
    catch (e) { toast('bad', 'Some keys are still on', tidy((e as Error).message)); }
    setBusy(null);
    tokens.reload();
  };
  const danger = 'rounded-[24px] border border-bad/25 bg-surface p-5 shadow-soft md:p-6';
  const SOFT_BAD = '!bg-bad/10 !text-bad';
  return (
    <>
      <section className={cx(danger, 'lg:col-span-2')}>
        <div className="flex flex-wrap items-center gap-4">
          <IconCircle className={ap.data?.paused ? 'bg-warn/12 text-warn' : SOFT_BAD}>{ap.data?.paused ? <Pause size={19} /> : <TriangleAlert size={19} />}</IconCircle>
          <div className="min-w-0 grow basis-[220px]">
            <h2 className="text-[16.5px] font-medium tracking-[-0.015em]">{ap.data?.paused ? 'Everything is paused' : 'Pause everything'}</h2>
            <p className="text-[13px] text-muted">{ap.data?.paused ? 'Unit7 and your AI can look, but not change anything.' : 'Stop Unit7, Warden and your AI from changing anything until you turn it back on.'}</p>
          </div>
          {ap.data && (ap.data.paused
            ? <Button variant="primary" icon={<Play size={15} />} loading={busy === 'ap'} onClick={async () => { setBusy('ap'); if (await act('autopilot.set', { paused: false }, { success: 'Autopilot is back on' })) ap.reload(); setBusy(null); }}>Turn back on</Button>
            : <HoldButton icon={<Pause size={15} />} loading={busy === 'ap'} onConfirm={async () => { setBusy('ap'); if (await act('autopilot.set', { paused: true }, { success: 'Paused. Nothing changes without you.' })) ap.reload(); setBusy(null); }}>Pause everything</HoldButton>)}
        </div>
      </section>
      {admin && (
        <section className={danger}>
          <div className="flex flex-wrap items-center gap-4">
            <IconCircle className={SOFT_BAD}><KeyRound size={19} /></IconCircle>
            <div className="min-w-0 grow basis-[220px]">
              <h2 className="text-[16.5px] font-medium tracking-[-0.015em]">Turn off every app key</h2>
              <p className="text-[13px] text-muted">{tokens.data?.length ? `${tokens.data.length} key${tokens.data.length === 1 ? '' : 's'} on. Use this if one might have leaked. Every script and AI app using one stops right away; AI apps connected on Connections keep working.` : 'No app keys are on right now.'}</p>
            </div>
            <HoldButton disabled={!tokens.data?.length} loading={busy === 'keys'} onConfirm={offAll}>Turn them all off</HoldButton>
          </div>
        </section>
      )}
      <section className={danger}>
        <div className="flex flex-wrap items-center gap-4">
          <IconCircle><LogOut size={19} /></IconCircle>
          <div className="min-w-0 grow basis-[220px]">
            <h2 className="text-[16.5px] font-medium tracking-[-0.015em]">Sign out here</h2>
            <p className="text-[13px] text-muted">Ends this browser’s session. Unit7 keeps running.</p>
          </div>
          <Button variant="secondary" onClick={async () => { await api('/api/auth/logout', { body: {} }); location.assign('/'); }}>Sign out</Button>
        </div>
      </section>
    </>
  );
}
