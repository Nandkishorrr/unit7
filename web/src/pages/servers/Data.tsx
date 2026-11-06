// The server page's Data tab: every database the X-ray found, whoever runs it, and what people do with one: see its tables, ask it
// something, load a file into it, take a copy away. Everything goes through part.* (tools/data.ts), so the gate decides as it does anywhere.
import { useEffect, useState, type FormEvent } from 'react';
import { CircleArrowUp, Database, Download, Play, Upload } from 'lucide-react';
import { BrandLogo } from '../../brand/BrandLogo';
import { A, Button, Card, CardHeader, Empty, Field, Input, Select, Skeleton, Textarea, cx, nextAction, timeAgo, toast } from '../../ui';
import { onLive, upload } from '../../lib/api';
import { navigate } from '../../lib/router';
import { tidy } from '../../lib/words';
import { partLogo, partWhat, size, upgradeOffer, type UpgradePlan, type XPart } from './shape';
import { CardsSkeleton, call, type ServerXray } from './Xray';

const ENGINES = new Set(['postgres', 'mysql', 'mariadb', 'mongo', 'redis']);
interface Row { schema: string; name: string; rows: number; bytes: number }
interface Tables { database?: string; databases: string[]; tables: Row[]; note?: string; rowsAre?: string }
interface Result { columns: string[]; rows: string[][]; more: boolean; masked?: string[]; as: string }
type R = Awaited<ReturnType<typeof call>>;
const said = (r: R) => tidy(r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : '');
const waiting = () => toast('warn', 'Waiting for your OK', 'Approve it on the Approvals page and Unit7 does it.');
// the same check part.upgrade_plan makes, so a mistyped image never loses the card to an error
const IMAGE = /^[a-z0-9][a-z0-9._/-]{0,120}:[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const tableOf = (t: Row) => (t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name);
// a statement to start from, in the way each engine asks
const starter = (engine: string, t: Row) => (engine === 'mongo' ? `db.${t.name}.find().limit(50)` : engine === 'redis' ? 'DBSIZE' : engine === 'postgres' ? `SELECT * FROM "${t.schema}"."${t.name}" LIMIT 50` : `SELECT * FROM \`${t.schema}\`.\`${t.name}\` LIMIT 50`);

export function DataTab({ sx, serverId }: { sx: ServerXray; serverId: string }) {
  const [pick, setPick] = useState<string | null>(null);
  if (!sx.x) return <CardsSkeleton n={2} />;
  const system = new Set(sx.x.projects.filter((p) => p.system).map((p) => p.id));
  const dbs = sx.x.parts.filter((p) => ENGINES.has(p.engine ?? '') && !system.has(p.project ?? ''));
  if (!dbs.length) return <Empty icon={<Database size={24} />} title="No databases here yet" body="Postgres, MySQL, MariaDB, Redis, MongoDB and Supabase show up here once Unit7 finds them on this server." />;
  const part = dbs.find((p) => p.id === pick) ?? dbs[0]!;
  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-2" aria-label="Databases on this server">
        {dbs.map((p) => (
          <li key={p.id}>
            <button type="button" aria-pressed={p.id === part.id} onClick={() => setPick(p.id)}
              className={cx('inline-flex h-10 max-w-[280px] items-center gap-2 rounded-full border pl-2 pr-3.5 text-[13px] font-medium transition focus-visible:ring-2 focus-visible:ring-blue', p.id === part.id ? 'border-ink bg-raised text-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong')}>
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raised"><BrandLogo id={partLogo(p)} size={15} /></span>
              <span className="truncate">{p.name}</span><span className="shrink-0 font-normal text-muted">{partWhat(p)}</span>
            </button>
          </li>
        ))}
      </ul>
      <Picked key={part.id} part={part} serverId={serverId} />
    </div>
  );
}

function Picked({ part, serverId }: { part: XPart; serverId: string }) {
  const base = { serverId, part: part.id }, engine = part.engine ?? '';
  const [t, setT] = useState<Tables | null>(null);
  const [err, setErr] = useState('');
  const [db, setDb] = useState('');
  const [picked, setPicked] = useState<Row | null>(null);
  const [sql, setSql] = useState('');
  // MongoDB's rows name their database as schema: a collection is only its own name, and it goes with that database
  const mongo = engine === 'mongo' && picked;
  const database = mongo ? { database: picked.schema } : db ? { database: db } : {};
  const table = mongo ? picked.name : picked && tableOf(picked);
  const load = async () => {
    setErr('');
    const r = await call('part.tables', { ...base, ...(db && { database: db }) });
    if (r.status === 'ok') setT(r.output as Tables); else { setT(null); setErr(said(r)); }
  };
  useEffect(() => { void load(); }, [db]);
  const open = (x: Row) => { setPicked(x); setSql(starter(engine, x)); };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <Card className="min-w-0 p-5 md:p-6 lg:col-span-5">
        <CardHeader icon={<Database size={19} />} title="Tables" sub={t?.note ?? (t ? `${t.tables.length} here. Row counts are estimates.` : 'What’s inside')} />
        {(t?.databases.length ?? 0) > 1 && <div className="mt-3"><Field label="Database"><Select value={db || t?.database || t?.databases[0] || ''} onChange={setDb} options={t!.databases.map((d) => ({ value: d, label: d }))} /></Field></div>}
        {err ? <p role="alert" className="mt-4 rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink">{err}</p> : !t ? <Skeleton className="mt-4 h-40 rounded-[18px]" /> : !t.tables.length ? <p className="mt-4 text-[13px] text-muted">No tables yet.</p> : (
          <ul className="mt-3 max-h-[420px] divide-y divide-line overflow-y-auto">
            {t.tables.map((x) => (
              <li key={`${x.schema}.${x.name}`}>
                <button type="button" aria-pressed={picked === x} onClick={() => open(x)} className={cx('flex w-full min-w-0 items-center gap-3 rounded-[12px] px-2 py-2 text-left text-[13px] transition hover:bg-raised focus-visible:ring-2 focus-visible:ring-blue', picked === x && 'bg-raised')}>
                  <span className="min-w-0 flex-1 truncate font-medium">{tableOf(x)}</span>
                  <span className="tabular shrink-0 text-[12px] text-muted">{x.rows.toLocaleString()} rows{x.bytes ? ` · ${size(x.bytes)}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="min-w-0 space-y-4 lg:col-span-7">
        <QueryBox part={part} input={{ ...base, ...database }} sql={sql} onSql={setSql} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ImportCard input={{ ...base, ...database }} table={table || null} engine={engine} onDone={load} />
          <ExportCard input={{ ...base, ...database }} table={table || null} engine={engine} />
        </div>
      </div>
      <div className="min-w-0 lg:col-span-12"><UpgradeCard part={part} serverId={serverId} /></div>
    </div>
  );
}

function QueryBox({ part, input, sql, onSql }: { part: XPart; input: Record<string, unknown>; sql: string; onSql: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [write, setWrite] = useState(false);
  const [typed, setTyped] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState('');
  const go = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(''); setRes(null);
    const r = await call('part.query', { ...input, sql, write, ...(write && { confirm: typed.trim() }) });
    setBusy(false);
    if (r.status === 'approval_required') return waiting();
    if (r.status !== 'ok') return setErr(said(r));
    const o = r.output as Result & { done?: string; undo?: string };
    if (o.done !== undefined) { toast('ok', o.done || 'Done', tidy(o.undo ?? '')); setWrite(false); setTyped(''); } else setRes(o);
  };
  return (
    <Card className="min-w-0 p-5 md:p-6">
      <CardHeader icon={<Play size={19} />} title="Ask the database" sub="Read-only unless you say otherwise" />
      <form className="mt-4 space-y-3" onSubmit={go}>
        <Textarea aria-label={`A query for ${part.name}`} value={sql} onChange={(e) => onSql(e.target.value)} rows={4} spellCheck={false} placeholder={part.engine === 'mongo' ? 'db.users.find({ plan: "pro" })' : part.engine === 'redis' ? 'GET some-key' : 'SELECT count(*) FROM users'} className="font-mono text-[12.5px]" />
        <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
          <input type="checkbox" className="mt-0.5 accent-[var(--ink)]" checked={write} onChange={(e) => setWrite(e.target.checked)} />
          <span>This changes data. One statement only, and Unit7 takes a fresh backup first.</span>
        </label>
        {write && <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Type <b className="font-semibold">{part.name}</b> to run it</span><Input value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} /></label>}
        <div className="flex justify-end"><Button type="submit" variant={write ? 'danger' : 'primary'} icon={<Play size={14} />} loading={busy} disabled={!sql.trim() || (write && typed.trim().toLowerCase() !== part.name.toLowerCase())}>{write ? 'Change the data' : 'Run'}</Button></div>
      </form>
      {err && <p role="alert" className="mt-3 rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink">{err}</p>}
      {res && <Answer r={res} />}
    </Card>
  );
}

// A major version: part.upgrade_plan says what can work here, a test runs next to the live one, and the switch is a person's, typed out.
// Closing the tab stops a run: the tool goes with its request, so the page says to keep it open.
function UpgradeCard({ part, serverId }: { part: XPart; serverId: string }) {
  const base = { serverId, part: part.id };
  const [image, setImage] = useState('');
  const [other, setOther] = useState('');
  const [plan, setPlan] = useState<UpgradePlan | null>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState<'test' | 'switch' | null>(null);
  const [line, setLine] = useState('');
  const [err, setErr] = useState('');
  const [typed, setTyped] = useState('');
  const load = async () => {
    const r = await call('part.upgrade_plan', { ...base, ...(image && { image }) });
    if (r.status === 'ok') { setPlan(r.output as UpgradePlan); setWhy(''); } else { setPlan(null); setWhy(said(r)); }
  };
  useEffect(() => { void load(); }, [image]);
  useEffect(() => onLive((e) => { if (e.type === 'tool.progress' && e.data?.tool === 'part.upgrade_run') setLine(e.message); }), []);
  const test = async () => {
    setBusy('test'); setErr(''); setLine('');
    const r = await call('part.upgrade_run', { ...base, ...(image && { image }) });
    setBusy(null);
    if (r.status === 'approval_required') return waiting();
    if (r.status !== 'ok') return setErr(said(r));
    toast('ok', 'The test passed', `The live ${part.name} wasn’t touched.`);
    await load();
  };
  const move = async () => {
    setBusy('switch'); setErr('');
    const r = await call('part.upgrade_switch', { ...base, confirmName: typed.trim() });
    setBusy(null);
    if (r.status === 'approval_required') { toast('info', 'One last yes', 'Confirm it on Approvals, then Unit7 moves it.'); return navigate('/approvals'); }
    if (r.status !== 'ok') return setErr(said(r));
    setTyped('');
    toast('ok', `${part.name} moved to its new version`, 'Your apps reconnect by themselves.', { action: nextAction(r.output) });
    await load();
  };
  const offer = plan && upgradeOffer(plan);
  return (
    <Card className="min-w-0 p-5 md:p-6">
      <CardHeader icon={<CircleArrowUp size={19} />} title="Move to a new version" sub={plan ? `Postgres ${plan.major} now. Nothing changes until you say so.` : 'A newer major version, tested first'} />
      {why ? <p className="mt-3 text-[13px] text-ink-2">{why}</p> : !plan || !offer ? <Skeleton className="mt-4 h-24 rounded-[18px]" /> : (
        <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-muted">Now</dt><dd className="break-all font-mono text-[12.5px]">{plan.from}</dd>
              {plan.to && <><dt className="text-muted">New version</dt><dd className="break-all font-mono text-[12.5px]">{plan.to}</dd></>}
              <dt className="text-muted">Size</dt><dd>{size(plan.size)}</dd>
              {plan.extensions.length > 0 && <><dt className="text-muted">Extensions</dt><dd className="break-words">{plan.extensions.join(', ')}</dd></>}
            </dl>
            {plan.problem && <p className="rounded-[16px] bg-warn/10 px-4 py-3 text-[13px] text-ink">{plan.problem}</p>}
            {plan.watch && <p className="text-[12.5px] text-muted">{plan.watch}</p>}
            <ol className="list-decimal space-y-1 pl-4 text-[12.5px] text-ink-2">{plan.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setImage(other.trim()); }}>
              <div className="min-w-0 flex-1"><Field label="Another version"><Input className="font-mono text-[12.5px]" value={other} placeholder={plan.to ?? 'postgres:17-alpine'} autoComplete="off" spellCheck={false} onChange={(e) => setOther(e.target.value)} /></Field></div>
              <Button type="submit" variant="secondary" disabled={!IMAGE.test(other.trim())}>Check it</Button>
            </form>
          </div>
          <div className="min-w-0 space-y-3">
            {plan.tested && (
              <div className="rounded-[16px] bg-ok/8 px-4 py-3 text-[13px]">
                <p className="font-medium text-ink">The test passed, {timeAgo(plan.tested.at)}</p>
                <p className="mt-0.5 break-words text-ink-2">{plan.tested.found} Try your app against it for as long as you like. The live one wasn’t touched.</p>
              </div>
            )}
            {plan.switchNote && <p className="rounded-[16px] bg-raised px-4 py-3 text-[13px] text-ink-2">{plan.switchNote}</p>}
            {err && <p role="alert" className="break-words rounded-[16px] bg-bad/8 px-4 py-3 text-[13px] text-ink">{err}</p>}
            {offer.test && <Button variant={plan.tested ? 'secondary' : 'primary'} icon={<Play size={14} />} loading={busy === 'test'} disabled={!!busy} onClick={test}>{plan.tested ? 'Test it again' : 'Test on the new version'}</Button>}
            {busy === 'test' && <p role="status" className="text-[12.5px] text-muted">{line || 'Starting…'} This takes a while on a big database, and the live one keeps running. Keep this tab open until it’s done.</p>}
            {offer.move && (
              <div className="space-y-3 rounded-[18px] border border-line-strong p-4">
                <p className="break-all text-[13.5px] font-medium">Switch to {plan.tested!.image}</p>
                <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-ink-2">
                  <li>Apps can’t reach {part.name} during the switch. It holds {size(plan.size)}, so pick a quiet moment.</li>
                  <li>One last backup comes first, and the old files stay on the server. If the data doesn’t match, it goes back by itself.</li>
                  <li>Afterwards, Undo in <A href="/activity" className="underline">Activity</A> goes back to {plan.from}, and you lose what changed since the switch.</li>
                </ul>
                <label className="block"><span className="mb-1.5 block text-[13px] font-medium">Type <b className="font-semibold">{part.name}</b> to switch</span><Input value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} /></label>
                <div className="flex justify-end"><Button variant="danger" icon={<CircleArrowUp size={14} />} loading={busy === 'switch'} disabled={!!busy || typed.trim() !== part.name} onClick={move}>Switch to the new version</Button></div>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Answer({ r }: { r: Result }) {
  if (!r.columns.length) return <p className="mt-3 text-[13px] text-muted">No rows.</p>;
  return (
    <div className="mt-3">
      <div className="max-h-[420px] overflow-auto rounded-[16px] border border-line">
        <table className="w-full min-w-max border-collapse text-left text-[12.5px]">
          <thead className="sticky top-0 bg-raised"><tr>{r.columns.map((c, i) => <th key={i} scope="col" className="px-3 py-2 font-medium text-ink-2">{c}</th>)}</tr></thead>
          <tbody>{r.rows.map((row, i) => <tr key={i} className="border-t border-line">{row.map((c, k) => <td key={k} className="max-w-[320px] truncate px-3 py-1.5 font-mono text-[12px]" title={c}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-muted">{r.rows.length} row{r.rows.length === 1 ? '' : 's'}{r.more ? ', and more that aren’t shown' : ''}. Read as {r.as}.{r.masked?.length ? ` Hidden: ${r.masked.join(', ')}.` : ''}</p>
    </div>
  );
}

function ImportCard({ input, table, engine, onDone }: { input: Record<string, unknown>; table: string | null; engine: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [into, setInto] = useState('copy');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const csv = !!file && /\.csv(\.gz)?$/i.test(file.name), target = name.trim() || table || '';
  useEffect(() => { setName(''); }, [table]);
  if (engine === 'redis') return <Card className="min-w-0 p-5"><CardHeader icon={<Upload size={19} />} title="Load a file" sub="Redis has no tables. Bring a backup back from Health." /></Card>;
  const go = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) return;
    const form = e.currentTarget;
    setBusy(true);
    try {
      const { uploadId } = await upload(file);
      const r = await call('part.import', { ...input, uploadId, into, ...(csv && { table: target }) });
      if (r.status === 'approval_required') { waiting(); return; }
      if (r.status !== 'ok') { toast('bad', 'That didn’t load', said(r)); return; }
      const o = r.output as { next?: string; undo?: string; rows?: number };
      toast('ok', o.rows !== undefined ? `Loaded ${o.rows.toLocaleString()} rows` : 'Loaded', tidy(o.next ?? o.undo ?? ''));
      form.reset(); setFile(null); onDone();
    } catch (x) { toast('bad', 'That didn’t upload', (x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card className="min-w-0 p-5">
      <CardHeader icon={<Upload size={19} />} title="Load a file" sub="A SQL dump or a CSV, up to 100 MB" />
      <form className="mt-3 space-y-3" onSubmit={go}>
        <input type="file" aria-label="The file to load" accept=".sql,.gz,.csv,.dump,.backup" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full min-w-0 text-[12.5px] text-ink-2 file:mr-3 file:h-8 file:rounded-full file:border-0 file:bg-raised file:px-3.5 file:text-[12.5px] file:font-medium file:text-ink" />
        {csv && <Field label="Into which table"><Input value={target} onChange={(e) => setName(e.target.value)} autoComplete="off" /></Field>}
        <Field label="Where to"><Select value={into} onChange={setInto} options={[{ value: 'copy', label: 'A side copy (safest)' }, { value: 'live', label: 'The live database' }]} /></Field>
        <p className="text-[12px] text-muted">{into === 'copy' ? 'The live one doesn’t change.' : 'A backup comes first, and it waits for your OK on Approvals.'}</p>
        <Button type="submit" variant="secondary" size="sm" icon={<Upload size={13} />} loading={busy} disabled={!file || (csv && !target)}>Load it</Button>
      </form>
    </Card>
  );
}

function ExportCard({ input, table, engine }: { input: Record<string, unknown>; table: string | null; engine: string }) {
  const [busy, setBusy] = useState<'dump' | 'table' | null>(null);
  const go = async (what: 'dump' | 'table') => {
    setBusy(what);
    const r = await call('part.export', { ...input, ...(what === 'table' && { table }) });
    setBusy(null);
    if (r.status !== 'ok') { toast('bad', 'That didn’t export', said(r)); return; }
    const o = r.output as { url: string; filename: string };
    const a = document.createElement('a');
    a.href = o.url; a.download = o.filename;
    document.body.append(a); a.click(); a.remove();
    toast('ok', 'Your download started', 'It holds real data. Keep it somewhere safe.');
  };
  return (
    <Card className="min-w-0 p-5">
      <CardHeader icon={<Download size={19} />} title="Take a copy away" sub="Plain files, for you alone" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Download size={13} />} loading={busy === 'dump'} disabled={!!busy} onClick={() => go('dump')}>Whole database</Button>
        {engine !== 'redis' && <Button size="sm" variant="secondary" icon={<Download size={13} />} loading={busy === 'table'} disabled={!!busy || !table} onClick={() => go('table')}>{table ? `${table} as ${engine === 'mongo' ? 'JSON' : 'CSV'}` : 'Pick a table first'}</Button>}
      </div>
      <p className="mt-3 text-[12px] text-muted">Each link works once. An AI can’t do this.</p>
    </Card>
  );
}
