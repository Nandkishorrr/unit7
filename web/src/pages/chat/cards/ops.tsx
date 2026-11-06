// The rest of what Unit7 looks after, as chat cards: backups (with Restore, asked first), databases,
// errors (with "Ask Unit7 to fix"), approvals (Approve right here), recent activity, accounts, costs,
// a sync, and the whole map in tabs.
import { useState, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Bug, Check, Database, DatabaseBackup, Network, Plug, RefreshCw, ShieldCheck, Wallet, X } from 'lucide-react';
import { BrandLogo, providerName } from '../../../brand/BrandLogo';
import { api } from '../../../lib/api';
import { navigate } from '../../../lib/router';
import { approvalWords, eventWords, tidy } from '../../../lib/words';
import { AiButton, Badge, Button, CountUp, cx, Skeleton, Tabs, timeAgo, StatusMark } from '../../../ui';
import { LogoTile } from '../../kit';
import { acctLabel, liveOf, type Asset } from '../../map/data';
import { AppList, appOfAsset } from './apps';
import { DomainList } from './domains';
import { ServerList } from './servers';
import { Fold, Frame, IconBtn, LiveDot, Outcome, Pill, Sure, ask, call, openMap, refreshWorld, said, useLoad, useProgress, useWorld } from './kit';
import { bytes, domainGroups, groupBy, parseTable, pickTab, plural, when, type MapTab } from './shape';

const REASON: Record<string, string> = { manual: 'By hand', restore: 'Before a restore', deploy: 'Before a deploy', remove: 'Before removing' };
const reasonWord = (r: string) => (r.startsWith('scheduled') ? 'Daily' : REASON[r] ?? (r.startsWith('before') ? r.replace(/^before/, 'Before') : r.charAt(0).toUpperCase() + r.slice(1)));
const engineLogo = (k?: string) => (k === 'mariadb' ? 'mysql' : k === 'mongo' ? 'mongodb' : k ?? 'postgres');

// --- backups ---
function BackupRow({ b }: { b: any }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ReturnType<typeof said> | null>(null);
  const restore = async () => {
    setBusy(true);
    const r = await call('backup.restore', { backupId: b.id, confirm: true });
    setBusy(false); setAsking(false);
    setNote(said(r, `${b.service ?? 'The database'} is back to ${when(b.created_at).toLowerCase()}. Unit7 saved a safety backup first.`));
    refreshWorld();
  };
  const ok = b.status === 'done';
  return (
    <li className="py-2">
      <div className="flex items-center gap-3">
        <span className={cx('grid size-8 shrink-0 place-items-center rounded-full', ok ? 'bg-raised text-ink-2' : 'bg-bad/10 text-bad')}>{ok ? <DatabaseBackup size={14} /> : <X size={14} />}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{when(b.created_at)} <span className="font-normal text-muted">· {timeAgo(b.created_at)}</span></p>
          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
            <span>{reasonWord(b.reason ?? '')}</span>
            {b.verify_ok === 1 && <span className="inline-flex items-center gap-1 text-ok"><StatusMark state="ok" size={12} label="Tested" />Tested</span>}
            {b.offsite && !String(b.offsite).startsWith('failed') && <span>Also on {b.offsite}</span>}
            {!ok && <span className="text-bad">{b.status === 'running' ? 'Running' : 'Didn’t finish'}</span>}
          </p>
        </div>
        <span className="tabular shrink-0 text-[12.5px] font-medium text-ink-2">{bytes(b.size)}</span>
        {ok && !note && <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>Restore</Button>}
      </div>
      {asking && <Sure text={`${b.service ?? 'The database'} goes back to ${when(b.created_at).toLowerCase()}. Anything newer is lost (Unit7 saves a backup first).`} yes="Restore" busy={busy} onYes={restore} onNo={() => setAsking(false)} />}
      {note && <Outcome tone={note.tone} step={note.step}>{note.text}</Outcome>}
    </li>
  );
}

export function BackupsCard({ list }: { list: any[] }) {
  const w = useWorld();
  const groups = groupBy(list, (b) => b.service_id ?? 'gone');
  const total = list.reduce((n, b) => n + (b.size ?? 0), 0);
  return (
    <Frame icon={<DatabaseBackup size={16} />} tone="soft" title="Backups" count={list.length || undefined} sub={list.length ? `${bytes(total)} in all · newest ${timeAgo(list[0].created_at)}` : undefined} href="/settings?tab=backups" hrefLabel="Backup settings">
      {!list.length ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">No backups yet. Unit7 backs up every database daily once one exists.</p> : (
        <div className="space-y-3">
          {groups.map(([id, rows]) => {
            const s = w.svc(id);
            return (
              <div key={id}>
                {groups.length > 1 || s ? (
                  <p className="mb-0.5 flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
                    <BrandLogo id={engineLogo(rows[0].kind)} size={14} />
                    {s ? <button type="button" onClick={() => navigate(s.href)} className="hover:underline">{w.svcLabel(s)}</button> : rows[0].service ?? 'A removed database'}
                    <span className="font-normal text-muted">· {plural(rows.length, 'backup')}</span>
                  </p>
                ) : null}
                <Fold items={rows} className="divide-y divide-line">{(b) => <BackupRow key={b.id} b={b} />}</Fold>
              </div>
            );
          })}
        </div>
      )}
    </Frame>
  );
}

export function BackupDoneCard({ input, output, restored }: { input: any; output: any; restored?: boolean }) {
  const w = useWorld();
  const s = w.svc(input?.serviceId ?? undefined);
  const name = restored ? output.restored : s?.name ?? 'Your database';
  return (
    <Frame icon={<DatabaseBackup size={16} />} tone={restored ? 'warn' : 'lime'} title={restored ? `${name} is restored` : `${name} is backed up`}
      sub={restored ? 'Unit7 saved a safety backup of what was there first.' : `${bytes(output.size)} · kept on the server`} href={s?.href ?? '/settings?tab=backups'} hrefLabel="Open backups"
      right={<Pill tone="ok" glow>{restored ? 'Restored' : 'Saved'}</Pill>}>
      <div className="flex flex-wrap gap-2">
        {s && <Button size="sm" variant="soft" onClick={() => navigate(s.href)}>See all backups</Button>}
        {!restored && <Button size="sm" variant="ghost" onClick={() => ask(`Check that the newest backup of ${name} restores cleanly`)}>Test it restores</Button>}
      </div>
    </Frame>
  );
}

// --- databases ---
export function DatabaseCreatedCard({ input, output }: { input: any; output: any }) {
  const w = useWorld();
  const s = w.svc(output.serviceId);
  const into = w.svc(input?.injectInto ?? undefined);
  const [bk, setBk] = useState<{ busy?: boolean; note?: ReturnType<typeof said> }>({});
  const backup = async () => { setBk({ busy: true }); const r = await call('backup.create', { serviceId: output.serviceId, reason: 'manual' }); setBk({ note: said(r, r.status === 'ok' ? `Backed up (${bytes((r.output as any).size)}).` : '') }); };
  return (
    <Frame icon={<Database size={16} />} tone="lime" title={`New ${providerName(engineLogo(output.engine))} database`} sub={s ? `${s.name} · ${s.project} · ${s.env}` : input?.name} href={s?.href} hrefLabel="Open the database"
      right={<Pill tone="ok" glow>Running</Pill>}>
      <ul className="space-y-1.5 text-[13px]">
        <li className="flex items-center gap-2"><StatusMark state="ok" size={15} label="Done" />Its password and address are saved in your vault, never in your code.</li>
        {output.injected && <li className="flex items-center gap-2"><StatusMark state="ok" size={15} label="Done" /><span>{into ? <>Added to <button type="button" onClick={() => navigate(into.href)} className="font-medium hover:underline">{into.name}</button>’s settings</> : 'Added to your app’s settings'}. Deploy the app to use it.</span></li>}
        <li className="flex items-center gap-2"><StatusMark state="ok" size={15} label="Done" />Backed up every day from now on.</li>
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="soft" loading={bk.busy} onClick={backup}>Back up now</Button>
        {s && <Button size="sm" variant="ghost" onClick={() => navigate(s.href)}>Open it<ArrowUpRight size={13} /></Button>}
      </div>
      {bk.note && <Outcome tone={bk.note.tone} step={bk.note.step}>{bk.note.text}</Outcome>}
    </Frame>
  );
}

export function TablesCard({ input, output }: { input: any; output: any }) {
  const w = useWorld();
  const [all, setAll] = useState(false);
  const s = w.svc(input?.serviceId);
  const t = typeof output.result === 'string' ? parseTable(output.result) : null;
  const rows = t && (all ? t.rows : t.rows.slice(0, 6));
  return (
    <Frame icon={<Database size={16} />} title={s ? `Inside ${s.name}` : 'Inside the database'} count={t?.rows.length} sub={`${providerName(engineLogo(output.engine))} · ${output.database ?? 'app'}`} href={s?.href} hrefLabel="Open the database">
      {t && rows ? (
        <>
          <div className="overflow-x-auto rounded-[16px] border border-line">
            <table className="w-full text-[12.5px]">
              <thead className="bg-raised/70 text-muted"><tr>{t.head.map((h) => <th key={h} className="px-3 py-2 text-left font-medium capitalize">{h.replace(/_/g, ' ')}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-line">{r.map((c, j) => <td key={j} className={cx('px-3 py-1.5', j === 0 ? 'font-mono' : 'tabular text-ink-2')}>{/^\d{4,}$/.test(c) ? Number(c).toLocaleString() : c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {t.rows.length > 6 && <button type="button" onClick={() => setAll((a) => !a)} className="mt-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium text-blue-text hover:bg-blue-soft">{all ? 'Show fewer' : `Show all ${t.rows.length}`}</button>}
        </>
      ) : <pre className="max-h-[260px] overflow-auto rounded-[16px] bg-raised p-3 font-mono text-[12px] text-ink-2">{String(output.result ?? '').trim() || 'Empty.'}</pre>}
    </Frame>
  );
}

// --- errors your users hit ---
export function ErrorsCard({ list }: { list: any[] }) {
  const w = useWorld();
  const [fixed, setFixed] = useState<Set<string>>(new Set());
  const open = list.filter((e) => !fixed.has(e.id));
  const groups = groupBy(open, (e) => e.serviceId).sort((a, b) => b[1].reduce((n, e) => n + e.total, 0) - a[1].reduce((n, e) => n + e.total, 0));
  const hits = open.reduce((n, e) => n + (e.total ?? 0), 0);
  const resolve = async (id: string) => { const r = await call('errors.resolve', { groupId: id }); if (r.status === 'ok') setFixed((f) => new Set(f).add(id)); };
  return (
    <Frame icon={<Bug size={16} />} tone={open.length ? 'warn' : 'ok'} title={open.length ? 'Errors your visitors hit' : 'No errors'} count={open.length || undefined} sub={open.length ? `${hits} times in all` : 'Nothing is failing for your visitors right now.'}>
      {open.length > 0 && (
        <div className="space-y-3">
          {groups.map(([sid, errs]) => {
            const s = w.svc(sid);
            return (
              <div key={sid}>
                <p className="mb-1 text-[12.5px] font-medium text-ink-2">{s ? <button type="button" onClick={() => navigate(s.href)} className="hover:underline">{w.svcLabel(s)}</button> : errs[0].service}</p>
                <Fold items={errs} className="space-y-2">
                  {(e) => (
                    <li key={e.id} className="rounded-[18px] border border-line px-3 py-2.5">
                      <div className="flex items-start gap-3">
                        <span className="tabular grid h-9 min-w-9 shrink-0 place-items-center rounded-[12px] bg-bad/10 px-1.5 text-[13px] font-semibold text-bad"><CountUp value={e.total} format={(n) => `${Math.round(n)}×`} /></span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium [overflow-wrap:anywhere]"><span className="text-bad">{e.kind}</span> {e.message}</p>
                          <p className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-muted">
                            {e.frame && <span className="font-mono">{e.frame}</span>}
                            <span>last {timeAgo(e.lastSeen)}</span>
                            {e.firstDeploy && <span>since v{e.firstDeploy}</span>}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 @md:pl-12">
                        <AiButton size="sm" strong onClick={() => ask(`Fix this error in ${e.service}: ${e.kind}: ${e.message}${e.frame ? ` (at ${e.frame})` : ''}. It happened ${e.total} times.`)}>Ask Unit7 to fix</AiButton>
                        <Button size="sm" variant="ghost" onClick={() => resolve(e.id)}>Mark fixed</Button>
                      </div>
                    </li>
                  )}
                </Fold>
              </div>
            );
          })}
        </div>
      )}
    </Frame>
  );
}

// logs.digest and errors.hosts: each kind of error line with how often, in the app's own words (text from the app, shown as text)
export function ErrorLinesCard({ title, rows }: { title: string; rows: { app: string; text: string; n: number }[] }) {
  return (
    <Frame icon={<Bug size={16} />} tone="warn" title={title} count={rows.length}>
      <Fold items={rows} className="space-y-2">
        {(r, i) => (
          <li key={i} className="rounded-[18px] border border-line px-3 py-2.5">
            <p className="text-[12.5px] font-medium text-ink-2">{r.app} <span className="tabular font-normal text-muted">· {r.n}×</span></p>
            <code className="mt-0.5 block break-words font-mono text-[12px] text-ink-2">{r.text}</code>
          </li>
        )}
      </Fold>
    </Frame>
  );
}

// --- approvals: decide right here ---
export function ApprovalsCard({ list }: { list: any[] }) {
  const full = useLoad<any[]>('approvals', () => api('/api/approvals'));
  const [done, setDone] = useState<Record<string, ReturnType<typeof said>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, yes: boolean) => {
    setBusy(id);
    try {
      const r = await api(`/api/approvals/${id}/${yes ? 'approve' : 'reject'}`, { body: {} });
      setDone((d) => ({ ...d, [id]: r.status === 'ok' ? { tone: 'ok', text: 'Approved and done.' } : r.status === 'rejected' ? { tone: 'info', text: 'Okay, not now. Nothing changed.' }
        : r.status === 'denied' ? { tone: 'bad', text: `Your rules blocked it: ${tidy(r.why)}` } : r.status === 'error' ? { tone: 'bad', text: `Approved, but it didn’t work: ${tidy(r.error.message)}` } : { tone: 'info', text: 'Recorded.' } }));
    } catch (e) { setDone((d) => ({ ...d, [id]: { tone: 'bad', text: tidy((e as Error).message) } })); }
    setBusy(null);
  };
  return (
    <Frame icon={<ShieldCheck size={16} />} tone={list.length ? 'blue' : 'lime'} title={list.length ? 'Waiting for your OK' : 'Nothing needs you'} count={list.length || undefined} href="/approvals" hrefLabel="Open approvals">
      {list.length > 0 && (
        <Fold items={list} className="space-y-2">
          {(a) => {
            const x = { ...a, ...full.data?.find((f) => f.id === a.id) };
            const words = approvalWords(x);
            return (
              <li key={a.id} className="rounded-[18px] border border-blue/20 bg-blue-soft/40 px-3 py-2.5">
                <p className="text-[13.5px] font-semibold">{words.title}</p>
                <p className="mt-0.5 text-[12.5px] text-muted">{x.actor ? `${words.who} asked · ` : ''}{timeAgo(a.created_at)} · {words.why}</p>
                {done[a.id] ? <Outcome tone={done[a.id]!.tone} step={done[a.id]!.step}>{done[a.id]!.text}</Outcome> : (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="primary" icon={<Check size={13} />} loading={busy === a.id} disabled={!!busy} onClick={() => decide(a.id, true)}>Approve</Button>
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => decide(a.id, false)}>Not now</Button>
                  </div>
                )}
              </li>
            );
          }}
        </Fold>
      )}
    </Frame>
  );
}

// --- what happened lately ---
export function EventsCard({ list }: { list: any[] }) {
  // the same line several times in a row reads once, with how many times
  const rows: (any & { said: ReturnType<typeof eventWords>; times: number })[] = [];
  for (const e of list.filter((x) => x.type !== 'tool.progress')) {
    const said = eventWords(e), last = rows.at(-1);
    if (last && last.said.text === said.text) last.times++; else rows.push({ ...e, said, times: 1 });
  }
  return (
    <Frame icon={<Activity size={16} />} title="What happened" count={rows.length} href="/activity" hrefLabel="Open activity">
      {!rows.length ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">All quiet.</p> : (
        <Fold items={rows} className="divide-y divide-line">
          {(e, i) => {
            const w = e.said;
            return (
              <li key={i} className="flex items-center gap-2.5 py-2">
                <LiveDot tone={w.tone === 'neutral' ? 'idle' : w.tone} />
                <span className="min-w-0 flex-1 truncate text-[13px]" title={e.message}>{w.text}</span>
                {e.times > 1 && <span className="tabular shrink-0 rounded-full bg-raised px-1.5 text-[11.5px] font-medium text-muted">×{e.times}</span>}
                <span className="shrink-0 text-[12px] text-muted">{timeAgo(e.created_at)}</span>
              </li>
            );
          }}
        </Fold>
      )}
    </Frame>
  );
}

// --- connected accounts ---
export function AccountsCard({ list }: { list: any[] }) {
  return (
    <Frame icon={<Plug size={16} />} title="Connected accounts" count={list.length} href="/connections" hrefLabel="Open connections">
      <Fold items={list} className="divide-y divide-line">
        {(a) => {
          const ok = a.status === 'verified' || a.ok;
          return (
            <li key={a.id} className="flex items-center gap-3 py-2">
              <LogoTile id={a.provider} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{providerName(a.provider)}{acctLabel(a.name) && <span className="font-normal text-muted"> · {acctLabel(a.name)}</span>}</span>
                <span className="block truncate text-[12px] text-muted">{a.environments?.length ? `Used by ${plural(a.environments.length, 'environment')}` : a.found != null ? `${a.found} things found` : 'Not used by a project yet'}</span>
              </span>
              <Pill tone={ok ? 'ok' : 'warn'}>{ok ? 'Connected' : a.note ? 'Couldn’t read' : 'Needs sign-in'}</Pill>
            </li>
          );
        }}
      </Fold>
    </Frame>
  );
}

// --- costs ---
export function BudgetCard({ output: b }: { output: any }) {
  const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: b.currency ?? 'USD', maximumFractionDigits: n < 100 ? 2 : 0, currencyDisplay: 'narrowSymbol' }).format(n);
  const pct = b.budget ? Math.min(100, (b.forecast / b.budget) * 100) : null;
  const [why, setWhy] = useState(false);
  return (
    <Frame icon={<Wallet size={16} />} tone={b.level === 'over' ? 'bad' : b.level === 'warning' ? 'warn' : 'soft'} title="This month’s costs" href="/autopilot" hrefLabel="Budget settings"
      right={b.budget ? <Pill tone={b.level === 'over' ? 'bad' : b.level === 'warning' ? 'warn' : 'ok'}>{b.level === 'over' ? 'Over budget' : b.level === 'warning' ? 'Close to budget' : 'Within budget'}</Pill> : undefined}>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <p><span className="block text-[12px] text-muted">So far</span><span className="text-[28px] font-semibold leading-none tracking-[-0.03em]"><CountUp value={b.soFar} format={money} /></span></p>
        <p><span className="block text-[12px] text-muted">By month end</span><span className="text-[17px] font-semibold text-ink-2"><CountUp value={b.forecast} format={money} /></span></p>
        {b.budget && <p><span className="block text-[12px] text-muted">Budget</span><span className="text-[17px] font-semibold text-ink-2">{money(b.budget)}</span></p>}
      </div>
      {pct != null && <div className="mt-3 h-2 overflow-hidden rounded-full bg-sunken"><span className={cx('block h-full rounded-full transition-[width] duration-700', b.level === 'over' ? 'bg-bad-solid' : b.level === 'warning' ? 'bg-[#f59e0b]' : 'bg-blue')} style={{ width: `${pct}%` }} /></div>}
      {b.costs?.length > 0 && (
        <Fold items={[...b.costs].sort((x: any, y: any) => y.amount - x.amount)} className="mt-3 divide-y divide-line">
          {(c, i) => (
            <li key={i} className="flex items-center gap-2.5 py-1.5 text-[13px]">
              <BrandLogo id={c.provider === 'manual' ? 'unit7' : c.provider} size={16} />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              <span className="tabular font-medium">{money(c.amount)}</span>
            </li>
          )}
        </Fold>
      )}
      {b.unknown?.length > 0 && (
        <p className="mt-2 text-[12.5px] text-muted">Not in these totals, amount unknown: {b.unknown.map((u: { label: string; why?: string }) => `${u.label}${u.why ? ` (${u.why})` : ''}`).join('; ')}.</p>
      )}
      {!b.costs?.length && !b.unknown?.length && <p className="mt-2 text-[12.5px] text-muted">No costs found yet.</p>}
      {b.problems?.length > 0 && (
        <p className="mt-2 text-[12.5px] text-muted">
          <button type="button" onClick={() => setWhy((x) => !x)} aria-expanded={why} className="underline decoration-dotted underline-offset-4 hover:text-ink">Couldn’t read {plural(b.problems.length, 'account')}</button>
          {why && <span className="mt-1 block space-y-0.5">{b.problems.map((p: string, i: number) => <span key={i} className="block">{tidy(p)}</span>)}</span>}
        </p>
      )}
    </Frame>
  );
}

// --- a sync: live while it reads every account, then what it found ---
export function SyncCard({ state, output }: { state: 'running' | 'ok'; output?: any }) {
  const lines = useProgress(['sync.run'], state === 'running').map(tidy);
  const c = output?.counts ?? {};
  const issues = Array.isArray(output?.issues) ? output.issues.length : 0;
  return (
    <Frame icon={<RefreshCw size={16} className={state === 'running' ? 'animate-spin [animation-duration:2s]' : undefined} />} tone={state === 'running' ? 'blue' : 'soft'} title={state === 'running' ? 'Reading every account…' : 'Map refreshed'}
      sub={state === 'ok' ? `${issues ? `${plural(issues, 'thing')} to look at · ` : ''}took ${Math.max(1, Math.round((output?.ms ?? 0) / 1000))}s` : lines.at(-1)} href="/map" hrefLabel="Open the map">
      {state === 'ok' && (
        <>
          <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
            {([['Apps', c.apps], ['Domains', c.domains], ['Servers', c.servers], ['Databases', c.databases]] as const).map(([k, n]) => (
              <div key={k} className="rounded-[16px] bg-raised/70 px-3 py-2.5">
                <p className="text-[22px] font-semibold leading-none tracking-[-0.03em]"><CountUp value={n ?? 0} /></p>
                <p className="mt-1 text-[12px] text-muted">{k}</p>
              </div>
            ))}
          </div>
          {output?.accounts?.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {output.accounts.map((a: any) => (
                <li key={a.id} title={a.ok ? `${a.found} found` : tidy(a.note ?? '')} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line pl-1.5 pr-2.5 text-[12px] text-ink-2">
                  <BrandLogo id={a.provider === 'forge' ? 'unit7' : a.provider} size={13} />{a.provider === 'forge' ? 'Unit7' : providerName(a.provider)}<LiveDot tone={a.ok ? 'ok' : 'warn'} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {state === 'running' && <ul className="space-y-1 font-mono text-[12px] text-muted">{lines.slice(-4).map((l, i) => <li key={i} className="animate-pop truncate">{l}</li>)}{!lines.length && <li>Starting…</li>}</ul>}
    </Frame>
  );
}

// --- the whole map, one tab per kind; the tab the question was about comes first ---
function ThingRow({ a, w, children }: { a: Asset; w: ReturnType<typeof useWorld>; children?: ReactNode }) {
  const live = liveOf(a);
  const s = a.end?.kind === 'unit7' ? w.svc(a.end.serviceId) : undefined;
  const used = w.v ? new Set(w.v.inc(a.id, 'env').map((e) => e.source)).size : 0;
  return (
    <li className="flex items-center gap-3 py-2">
      <LogoTile id={a.kind === 'database' ? (s ? engineLogo(s.kind) : a.provider) : a.provider} size={32} />
      <span className="min-w-0 flex-1">
        <button type="button" onClick={() => (s ? navigate(s.href) : openMap(a.id))} className="block max-w-full truncate text-left text-[13px] font-medium hover:underline">{w.label(a)}</button>
        <span className="block truncate text-[12px] text-muted">{children ?? (a.kind === 'database' ? (used ? `Used by ${plural(used, 'app')}` : 'Nothing uses it yet') : providerName(a.provider))}</span>
      </span>
      {live && <Pill tone={live.tone}>{live.text}</Pill>}
      <IconBtn label="Open in the map" onClick={() => openMap(a.id)}><ArrowUpRight size={15} /></IconBtn>
    </li>
  );
}

export function MapCard({ input, question }: { input: any; question?: string }) {
  const w = useWorld({ map: true });
  const v = w.v;
  const of = (k: string) => (v?.assets ?? []).filter((a) => a.kind === k);
  const groups = v ? domainGroups(v, w.label, w.managed) : [];
  const counts: Record<MapTab, number> = { domain: groups.length, app: of('app').length, server: (w.graph?.servers.length ?? 0) + of('server').filter((a) => a.provider !== 'unit7').length, database: of('database').length, account: v?.accounts.length ?? 0 };
  const [tab, setTab] = useState<MapTab | null>(null);
  const at = tab ?? pickTab(question ?? input?.q, counts);
  const issues = v?.issues.length ?? 0;
  const TAB: [MapTab, string][] = [['domain', 'Domains'], ['app', 'Apps'], ['server', 'Servers'], ['database', 'Databases'], ['account', 'Accounts']];
  return (
    <Frame icon={<Network size={16} />} tone="soft" title="Your setup" href={issues ? '/map?status=attention' : '/map'} hrefLabel="Open the map"
      sub={w.map ? `${issues ? `${plural(issues, 'thing')} to look at · ` : ''}synced ${timeAgo(w.map.syncedAt)}` : undefined}>
      {!w.ready ? <Skeleton className="h-40" /> : w.error && !v ? <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-muted">{tidy(w.error)}</p> : (
        <>
          <Tabs value={at} onChange={setTab} tabs={TAB.filter(([k]) => counts[k] > 0 || k === at).map(([k, label]) => ({ value: k, label: <>{label}<span className={cx('tabular text-[12px]', at === k ? 'text-bg/70' : 'text-faint')}>{counts[k]}</span></> }))} />
          <div key={at} className="mt-3 animate-rise">
            {at === 'domain' && <DomainList groups={groups} />}
            {at === 'app' && <AppList items={of('app').map((a) => appOfAsset(a, w))} />}
            {at === 'server' && <ServerTab w={w} others={of('server').filter((a) => a.provider !== 'unit7')} />}
            {at === 'database' && <Fold items={of('database')} className="divide-y divide-line">{(a) => <ThingRow key={a.id} a={a} w={w} />}</Fold>}
            {at === 'account' && <AccountsList w={w} />}
          </div>
        </>
      )}
    </Frame>
  );
}
function ServerTab({ w, others }: { w: ReturnType<typeof useWorld>; others: Asset[] }) {
  return (
    <div className="space-y-2">
      <ServerList servers={w.graph?.servers ?? []} />
      {others.length > 0 && <Fold items={others} className="divide-y divide-line">{(a) => <ThingRow key={a.id} a={a} w={w}>{a.ips?.join(', ') ?? providerName(a.provider)} · not managed by Unit7 yet</ThingRow>}</Fold>}
    </div>
  );
}
function AccountsList({ w }: { w: ReturnType<typeof useWorld> }) {
  return (
    <Fold items={w.v?.accounts ?? []} className="divide-y divide-line">
      {(a) => (
        <li key={a.id} className="flex items-center gap-3 py-2">
          <LogoTile id={a.provider === 'forge' ? 'unit7' : a.provider} size={32} />
          <span className="min-w-0 flex-1">
            <button type="button" onClick={() => navigate(a.provider === 'forge' ? '/map' : `/map/account/${a.id}`)} className="block max-w-full truncate text-left text-[13px] font-medium hover:underline">{a.provider === 'forge' ? 'Unit7' : providerName(a.provider)}{acctLabel(a.name) && <span className="font-normal text-muted"> · {acctLabel(a.name)}</span>}</button>
            <span className="block truncate text-[12px] text-muted" title={a.note && tidy(a.note)}>{a.ok ? `${a.found} things found` : a.note ? tidy(a.note) : 'Couldn’t read it'}</span>
          </span>
          <Pill tone={a.ok ? 'ok' : 'warn'}>{a.ok ? 'Read' : 'Needs sign-in'}</Pill>
        </li>
      )}
    </Fold>
  );
}

