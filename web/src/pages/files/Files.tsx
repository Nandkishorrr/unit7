// /files: a file manager for a connected server, or one of its apps. Everything goes through the file.* tools, so a person
// gets the same undo and rules as an AI, and may also open secret files. The place you're in lives in the address, so Back
// goes up a folder and a link can open a place.
import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react';
import { ChevronRight, Download, File as FileIcon, FilePlus2, Folder, FolderInput, HardDrive, Link2, Lock, RefreshCw, Save, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { onLive, runTool, saveDownload, sendFile, useApi, type ToolResult } from '../../lib/api';
import { navigate, useQuery } from '../../lib/router';
import { A, Badge, Button, Empty, ErrorLine, PageHeader, Select, Skeleton, Textarea, act, confirmDialog, cx, nextAction, promptDialog, stepAction, timeAgo, toast } from '../../ui';
import type { Me } from '../../App';
import { Menu } from '../kit';
import { size, type XPart } from '../servers/shape';

interface Entry { name: string; type: 'folder' | 'file' | 'link' | 'other'; size?: number; modified: string; secret?: boolean }
interface Listing { path: string; entries: Entry[]; truncated?: boolean; places?: string[] }
interface Opened { path: string; size: number; modified: string; sha256?: string; binary?: boolean; truncated?: boolean; secret?: boolean; content?: string }

const MAX_TRANSFER = 100 * 1024 * 1024; // POST /api/uploads
const call = (name: string, input: unknown) => runTool(name, input).catch((e: Error): ToolResult => ({ status: 'error', error: { code: 'network', message: e.message } }));
const problem = (r: ToolResult) => (r.status === 'error' ? r.error.message : r.status === 'denied' || r.status === 'approval_required' ? r.why : 'That didn’t work. Try again.');
const baseName = (p: string) => p.split('/').pop() || p;
const inFolder = (dir: string, name: string) => `${dir.replace(/\/$/, '')}/${name}`;

export function FilesPage({ me }: { me: Me }) {
  const q = useQuery();
  const graph = useApi<{ servers: { id: string; name: string }[] }>('/api/graph', { live: false });
  const servers = graph.data?.servers ?? [];
  const serverId = q.get('server') ?? (servers.length === 1 ? servers[0]!.id : '');
  const part = q.get('part') ?? '', container = q.get('container') ?? '', path = q.get('path') ?? '';
  const at = { serverId, ...(part && { part }), ...(container && { container }) };
  const canChange = !['readonly', 'auditor'].includes(me.role);
  const go = (o: { server?: string; part?: string; container?: string; path?: string }) => {
    const next = new URLSearchParams(Object.entries({ server: serverId, part, container, path, ...o }).filter(([, v]) => v) as [string, string][]);
    navigate(`/files?${next}`);
  };

  const [parts, setParts] = useState<XPart[]>([]);
  useEffect(() => {
    setParts([]);
    if (serverId) void call('server.xray', { serverId }).then((r) => { if (r.status === 'ok') setParts((r.output as { parts: XPart[] }).parts.filter((p) => p.containers?.length || p.kind === 'volume')); });
  }, [serverId]);
  const apps = [{ value: '', label: 'The server itself' }, ...parts.flatMap((p) => ((p.containers?.length ?? 0) > 1
    ? p.containers!.map((c) => ({ value: `${p.id}|${c}`, label: `${p.name}: ${c}` }))
    : [{ value: p.id, label: p.kind === 'volume' ? `${p.name} (stored data)` : p.name }]))];

  const [list, setList] = useState<Listing | null>(null);
  const [error, setError] = useState<{ text: string; r: ToolResult } | null>(null);
  const [file, setFile] = useState<Opened | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const turn = useRef(0); // only the newest answer counts when folders are clicked quickly

  const view = async (full: string) => {
    if (dirty && !await confirmDialog({ title: 'Leave without saving?', body: 'Your edits to this file aren’t saved.', confirm: 'Leave it', danger: true })) return;
    setBusy(`Opening ${baseName(full)}…`);
    const r = await call('file.read', { ...at, path: full });
    setBusy('');
    if (r.status === 'ok') { setFile(r.output as Opened); setDirty(false); }
    else if (r.status === 'error' && r.error.code === 'is_folder') go({ path: full }); // a link to a folder
    else toast('bad', 'Couldn’t open that', problem(r), { action: stepAction(r, { input: { ...at, path: full }, retry: () => view(full) }) });
  };
  const load = async () => {
    if (!serverId) return;
    const n = ++turn.current;
    const r = await call('file.list', { ...at, ...(path && { path }) });
    if (n !== turn.current) return;
    if (r.status === 'ok') { setList(r.output as Listing); setError(null); return; }
    setList(null);
    if (r.status === 'error' && r.error.code === 'not_folder' && path) { setError(null); void view(path); } // a place that's one file
    else setError({ text: problem(r), r });
  };
  useEffect(() => { setList(null); setError(null); setFile(null); setDirty(false); void load(); }, [serverId, part, container, path]);
  // Undo from a toast: what's on screen follows it
  useEffect(() => onLive((e) => {
    if (e.type !== 'change.undone') return;
    void load();
    if (file && !dirty) void call('file.read', { ...at, path: file.path }).then((r) => setFile(r.status === 'ok' ? r.output as Opened : null));
  }), [serverId, part, container, path, file?.path, dirty]);

  const openEntry = (e: Entry) => (e.type === 'folder' ? go({ path: inFolder(list!.path, e.name) }) : void view(inFolder(list!.path, e.name)));
  const download = async (full: string, bytes?: number) => {
    if ((bytes ?? 0) > MAX_TRANSFER) { toast('bad', 'Too big to download here', `This file is ${size(bytes)}. Unit7 downloads up to 100 MB at a time.`); return; }
    setBusy(`Downloading ${baseName(full)}…`);
    try { await saveDownload(`/api/files/download?${new URLSearchParams({ ...at, path: full })}`, baseName(full)); }
    catch (e) { toast('bad', 'Couldn’t download that', (e as Error).message); }
    setBusy('');
  };
  const upload = async (files: File[]) => {
    if (!list) return;
    for (const f of files) {
      if (f.size > MAX_TRANSFER) { toast('bad', `${f.name} is too big`, `It’s ${size(f.size)}. Unit7 uploads up to 100 MB at a time.`); continue; }
      if (list.entries.some((e) => e.name === f.name) && !await confirmDialog({ title: `Replace ${f.name}?`, body: 'The old copy is kept, so Undo can bring it back.', confirm: 'Replace it' })) continue;
      setBusy(`Uploading ${f.name}…`);
      try { await act('file.upload', { ...at, path: inFolder(list.path, f.name), uploadId: await sendFile(f) }, { success: `Uploaded ${f.name}` }); }
      catch (e) { toast('bad', `Couldn’t upload ${f.name}`, (e as Error).message); }
    }
    setBusy('');
    void load();
  };
  const dropped = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!canChange) return;
    const items = [...e.dataTransfer.items];
    if (items.some((x) => x.webkitGetAsEntry()?.isDirectory)) toast('info', 'Folders stay behind', 'Unit7 uploads files one at a time. Zip a folder to bring it along.');
    void upload([...e.dataTransfer.files].filter((_, i) => !items[i]?.webkitGetAsEntry()?.isDirectory));
  };
  const newFile = async () => {
    if (!list) return;
    const name = await promptDialog({ title: 'New file', label: 'Name', placeholder: 'notes.txt', confirm: 'Create it', hint: `In ${list.path}` });
    if (!name) return;
    if (await act('file.write', { ...at, path: inFolder(list.path, name), content: '' }, { success: `Created ${name}` })) { await load(); void view(inFolder(list.path, name)); }
  };
  const move = async (full: string) => {
    const to = await promptDialog({ title: 'Move or rename', label: 'New full path', value: full, confirm: 'Move it', hint: 'Unit7 never overwrites what’s already there.' });
    if (to && to !== full && await act('file.move', { ...at, path: full, to }, { success: 'Moved' })) void load();
  };
  const remove = async (full: string, folder?: boolean) => {
    if (!await confirmDialog({ title: `Move ${baseName(full)} to the trash?`, body: `${folder ? 'The folder and everything in it stay' : 'It stays'} in a 7-day trash on the server, and Undo brings it back.`, confirm: 'Move to trash', danger: true })) return;
    if (await act('file.remove', { ...at, path: full }, { success: 'Moved to the trash' })) { if (file?.path === full) setFile(null); void load(); }
  };

  const close = async () => {
    if (dirty && !await confirmDialog({ title: 'Close without saving?', body: 'Your edits to this file aren’t saved.', confirm: 'Close it', danger: true })) return;
    setFile(null); setDirty(false);
    if (!list) void load();
  };
  const here = list?.path ?? path, picked = container ? `${part}|${container}` : part;
  return (
    <div className="w-full pb-16">
      <PageHeader title="Files" subtitle="Browse, edit, upload and download files on a server or inside an app. Every change keeps a copy, so Undo can put it back." />
      {!graph.data ? <Skeleton className="h-[320px] rounded-[24px]" /> : !servers.length ? (
        <Empty title="No servers yet" body="Connect a server and its files show up here." action={<A href="/servers" className="font-medium text-blue-text hover:underline">Go to Servers</A>} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="w-full sm:w-auto">
              <span className="sr-only">Server</span>
              <Select className="w-full sm:w-[220px]" value={serverId} onChange={(v) => go({ server: v, part: '', container: '', path: '' })} options={[...(serverId ? [] : [{ value: '', label: 'Pick a server' }]), ...servers.map((s) => ({ value: s.id, label: s.name }))]} />
            </label>
            {serverId && (
              <label className="w-full sm:w-auto">
                <span className="sr-only">Server or app</span>
                <Select className="w-full sm:w-[280px]" value={picked} onChange={(v) => { const [p = '', c = ''] = v.split('|'); go({ part: p, container: c, path: '' }); }} options={apps.some((a) => a.value === picked) ? apps : [...apps, { value: picked, label: container || part }]} />
              </label>
            )}
            {list?.places?.map((p) => <button key={p} type="button" onClick={() => go({ path: p })} className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-ink-2 transition hover:border-line-strong hover:text-ink" title="Where this app keeps stored data"><HardDrive size={14} className="shrink-0" /><span className="truncate">{p}</span></button>)}
          </div>
          {!serverId ? <p className="px-1 py-8 text-center text-[13.5px] text-muted">Pick a server to see its files.</p> : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Crumbs path={here} onGo={(p) => go({ path: p })} />
                <div className="flex flex-wrap items-center gap-2">
                  {busy && <span role="status" className="max-w-[240px] truncate text-[12.5px] text-muted">{busy}</span>}
                  <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Refresh</Button>
                  {canChange && list && <><Button variant="ghost" size="sm" icon={<FilePlus2 size={14} />} onClick={() => void newFile()}>New file</Button><Button variant="soft" size="sm" icon={<Upload size={14} />} onClick={() => picker.current?.click()}>Upload</Button></>}
                  <input ref={picker} type="file" multiple hidden aria-label="Choose files to upload" onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
                </div>
              </div>
              {error && (
                <div role="alert" className="rounded-[20px] border border-bad/25 bg-bad/5 px-4 py-3">
                  <ErrorLine text={error.text} className="text-[13.5px]" title="Why Unit7 couldn’t open it" />
                  <div className="mt-2 flex gap-2"><Button variant="ghost" size="sm" onClick={() => void load()}>Try again</Button>{path && <Button variant="ghost" size="sm" onClick={() => go({ path: '' })}>Go back to the start</Button>}</div>
                </div>
              )}
              <div className={cx('grid grid-cols-1 items-start gap-4', file && 'xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]')}>
                {!file || list ? (
                  <div onDragOver={(e) => { e.preventDefault(); if (canChange && list) setOver(true); }} onDragLeave={() => setOver(false)} onDrop={dropped}
                    className={cx('overflow-hidden rounded-[24px] border bg-surface shadow-soft transition', over ? 'border-blue ring-4 ring-blue-soft' : 'border-line', file && 'hidden xl:block')}>
                    {!list ? (error ? null : <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading files"><Skeleton className="h-9 rounded-[12px]" /><Skeleton className="h-9 rounded-[12px]" /><Skeleton className="h-9 rounded-[12px]" /></div>)
                      : !list.entries.length ? <p className="px-4 py-12 text-center text-[13.5px] text-muted">This folder is empty.{canChange && ' Drop files here to upload them.'}</p> : (
                        <ul className="divide-y divide-line p-1.5">
                          {list.entries.map((e) => {
                            const full = inFolder(list.path, e.name);
                            return (
                              <li key={e.name} className="flex items-center gap-1">
                                <button type="button" onClick={() => openEntry(e)} aria-current={file?.path === full ? 'true' : undefined}
                                  className={cx('flex min-w-0 flex-1 items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition hover:bg-raised', file?.path === full && 'bg-raised')}>
                                  <EntryIcon e={e} />
                                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{e.name}</span>
                                  {e.secret && <Lock size={13} className="shrink-0 text-warn" aria-label="Secret file" />}
                                  <span className="hidden shrink-0 text-[12px] tabular-nums text-muted sm:block">{e.type === 'folder' ? '' : size(e.size)}</span>
                                  <span className="hidden w-[64px] shrink-0 text-right text-[12px] text-muted md:block">{timeAgo(e.modified)}</span>
                                </button>
                                <Menu label={`More for ${e.name}`} items={[
                                  ...(e.type === 'folder' ? [] : [{ label: 'Download', icon: <Download size={14} />, onSelect: () => void download(full, e.size) }]),
                                  ...(canChange ? [{ label: 'Move or rename', icon: <FolderInput size={14} />, onSelect: () => void move(full) }, { label: 'Move to trash', icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove(full, e.type === 'folder') }] : []),
                                ]} />
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    {list?.truncated && <p className="border-t border-line px-4 py-2.5 text-[12.5px] text-muted">Only the first {list.entries.length} are shown.</p>}
                    {canChange && !!list?.entries.length && <p className="hidden border-t border-line px-4 py-2 text-[12px] text-muted lg:block">Drop files here to upload them to this folder.</p>}
                  </div>
                ) : null}
                {file && <FilePanel key={file.path} file={file} at={at} canChange={canChange} onDirty={setDirty} onClose={() => void close()} onDownload={() => void download(file.path, file.size)} onSaved={(f) => { setFile(f); setDirty(false); void load(); }} />}
              </div>
              <p className="flex items-start gap-2 px-1 text-[12.5px] text-muted"><ShieldCheck size={14} className="mt-0.5 shrink-0" />An AI can’t open secret files like .env. Changes to system files, like those in /etc, wait on Approvals.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EntryIcon({ e }: { e: Entry }) {
  const Icon = e.type === 'folder' ? Folder : e.type === 'link' ? Link2 : FileIcon;
  return <Icon size={16} aria-hidden className={cx('shrink-0', e.type === 'folder' ? 'text-blue-text' : 'text-muted')} />;
}

function Crumbs({ path, onGo }: { path: string; onGo: (p: string) => void }) {
  const bits = path.split('/').filter(Boolean);
  const crumb = 'max-w-[220px] truncate rounded-[8px] px-1.5 py-1 text-[13px] transition hover:bg-raised hover:text-ink';
  return (
    <nav aria-label="Where you are" className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-ink-2">
      <button type="button" onClick={() => onGo('/')} aria-label="The top folder" className={crumb}>/</button>
      {bits.map((b, i) => (
        <Fragment key={`${i}${b}`}>
          {i > 0 && <ChevronRight size={13} aria-hidden className="text-faint" />}
          <button type="button" onClick={() => onGo(`/${bits.slice(0, i + 1).join('/')}`)} aria-current={i === bits.length - 1 ? 'location' : undefined} className={cx(crumb, i === bits.length - 1 && 'font-medium text-ink')}>{b}</button>
        </Fragment>
      ))}
    </nav>
  );
}

// The file you picked: read it, or edit it in a text box and save. A file with Windows line ends keeps them (a text box
// only speaks \n), and a file that changed since you opened it isn't overwritten.
function FilePanel({ file, at, canChange, onDirty, onClose, onDownload, onSaved }: { file: Opened; at: object; canChange: boolean; onDirty: (d: boolean) => void; onClose: () => void; onDownload: () => void; onSaved: (f: Opened) => void }) {
  const text = file.content ?? '', windows = text.includes('\r\n'), plain = windows ? text.replace(/\r\n/g, '\n') : text;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problemText, setProblem] = useState('');
  const editable = canChange && file.content !== undefined && !file.truncated;
  const edit = (v: string | null) => { setDraft(v); onDirty(v !== null && v !== plain); setProblem(''); };
  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    const content = windows ? draft.replace(/\n/g, '\r\n') : draft;
    const r = await call('file.write', { ...at, path: file.path, content, ...(file.sha256 && { expectSha256: file.sha256 }) });
    setSaving(false);
    if (r.status === 'ok') {
      toast('ok', `Saved ${baseName(file.path)}`, undefined, { action: nextAction(r.output) });
      setDraft(null);
      onSaved({ ...file, content, size: (r.output as { size: number }).size, sha256: (r.output as { sha256: string }).sha256, modified: new Date().toISOString() });
    } else if (r.status === 'approval_required') toast('warn', 'Waiting for approval', r.why, { action: stepAction(r) });
    else setProblem(problem(r));
  };
  return (
    <section aria-label={baseName(file.path)} className="min-w-0 overflow-hidden rounded-[24px] border border-line bg-surface shadow-soft">
      <div className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-mono text-[14px] font-medium text-ink" title={file.path}>{baseName(file.path)}</h2>
            <p className="text-[12px] text-muted">{size(file.size)} · changed {timeAgo(file.modified)}</p>
          </div>
          <button type="button" aria-label="Close this file" onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {file.secret && <Badge tone="warn"><Lock size={12} />Secret file</Badge>}
          {draft !== null ? <><Button variant="ghost" size="sm" onClick={() => edit(null)}>Cancel</Button><Button variant="primary" size="sm" loading={saving} disabled={draft === plain} icon={<Save size={14} />} onClick={() => void save()}>Save</Button></>
            : <>{editable && <Button variant="soft" size="sm" onClick={() => edit(plain)}>Edit</Button>}<Button variant="ghost" size="sm" icon={<Download size={14} />} onClick={onDownload}>Download</Button></>}
        </div>
      </div>
      {file.content === undefined ? <p className="px-4 py-10 text-center text-[13.5px] text-muted">This is a binary file, so it can’t be shown here. Download it to open it.</p> : draft === null ? (
        <>
          {file.truncated && <p className="border-b border-line bg-raised px-4 py-2 text-[12.5px] text-muted">This shows the first 1 MB. It’s too big to edit here: download it instead.</p>}
          <pre tabIndex={0} aria-label={`Text of ${baseName(file.path)}`} className="max-h-[66dvh] overflow-auto whitespace-pre p-4 font-mono text-[12.5px] leading-[1.6] text-ink">{plain || <span className="text-muted">This file is empty.</span>}</pre>
        </>
      ) : (
        <div className="space-y-3 p-3">
          {problemText && <div role="alert"><ErrorLine text={problemText} className="text-[13px]" title="Why it wasn’t saved" /></div>}
          <Textarea aria-label={`Edit ${baseName(file.path)}`} value={draft} onChange={(e) => edit(e.target.value)} spellCheck={false} wrap="off" autoFocus className="h-[60dvh] w-full resize-y whitespace-pre font-mono text-[12.5px] leading-[1.6]" />
        </div>
      )}
    </section>
  );
}
