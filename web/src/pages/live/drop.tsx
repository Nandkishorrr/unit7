// Hand Unit7 a site: drop a folder or a ZIP, or pick one. The Put this live page and the AI's folder card both use this.
// Either way it ends as an upload, and all that comes back is what the site is, never where it was.
import { useEffect, useRef, useState } from 'react';
import { FileArchive, FolderOpen, Upload } from 'lucide-react';
import { api, useApi } from '../../lib/api';
import { Button, cx } from '../../ui';

export interface Uploaded { uploadId: string; name: string; stack: string; runtime?: string | null; size: number; files?: number; cancelled?: undefined }

// what Unit7 leaves out anyway. Not sending it makes a project with node_modules quick, and a .env never leaves the browser
const HEAVY = /(^|\/)(node_modules|\.git|\.next|\.vercel|\.netlify|\.turbo|\.cache|\.svelte-kit|\.nuxt|\.output|\.wrangler|__pycache__|\.venv|venv|coverage)(\/|$)/;
const SECRET = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]+)?|\.DS_Store)$/;
const CAP = 100 * 1024 * 1024; // the most one upload takes (src/server/http.ts)
const OVER = 'That’s over 100 MB. Take out big files like videos, or put the site on GitHub and pick the repo.';

interface Picked { path: string; file: File }

function send(picked: Picked[]): Promise<Uploaded> {
  const files = picked.filter((p) => !HEAVY.test(p.path) && !SECRET.test(p.path));
  if (picked.length === 1 && /\.(tgz|tar|gz|rar|7z)$/i.test(picked[0]!.file.name)) throw new Error('Unit7 reads ZIP files. Make a ZIP, or drop the folder itself.');
  if (files.reduce((n, p) => n + p.file.size, 0) > CAP) throw new Error(OVER);
  const form = new FormData();
  if (files.length === 1 && /\.zip$/i.test(files[0]!.file.name)) form.append('zip', files[0]!.file);
  else for (const p of files) { form.append('path', p.path); form.append('file', p.file); }
  return api<Uploaded>('/api/live/upload', { body: form });
}

// a dropped folder, walked here so node_modules is never even read. readEntries gives a batch at a time, until an empty one
async function walk(e: FileSystemEntry, path: string, out: Picked[]) {
  if (e.isFile) out.push({ path, file: await new Promise<File>((ok, no) => (e as FileSystemFileEntry).file(ok, no)) });
  else if (!HEAVY.test(path)) {
    const reader = (e as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) return out;
      for (const c of batch) await walk(c, `${path}/${c.name}`, out);
    }
  }
  return out;
}

export function SiteDrop({ onReady, compact, disabled }: { onReady: (u: Uploaded) => void; compact?: boolean; disabled?: boolean }) {
  // the Mac's own folder window, when Unit7 and this browser are on the same Mac; otherwise the browser's
  const mac = useApi<{ canOpen: boolean }>('/api/agent/setup', { live: false }).data?.canOpen;
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const zip = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const off = !!busy || disabled;

  const run = async (say: string, work: () => Promise<Uploaded | { cancelled: true }>) => {
    setBusy(say); setError(undefined);
    try { const u = await work(); if (!u.cancelled) onReady(u as Uploaded); } catch (e) { setError((e as Error).message); }
    setBusy(undefined);
  };
  const chosen = (list: FileList | null) => { const files = [...(list ?? [])]; if (files.length) void run('Sending it to Unit7…', async () => send(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })))); };
  const pickFolder = () => (mac ? void run('A Finder window is open. Pick the folder there (it may be behind this one).', () => api('/api/live/folder', { body: {} })) : folder.current?.click());

  // anywhere on the page counts: a near miss would otherwise open the file and lose the page
  useEffect(() => {
    if (off) return;
    const drag = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setOver(true); } };
    const away = (e: DragEvent) => { if (!e.relatedTarget) setOver(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault(); setOver(false);
      // the list empties when this event ends, so the entries are taken first
      const items = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x);
      if (items.length) void run('Sending it to Unit7…', async () => send((await Promise.all(items.map((i) => walk(i, i.name, [])))).flat()));
      else chosen(e.dataTransfer?.files ?? null);
    };
    window.addEventListener('dragover', drag); window.addEventListener('dragleave', away); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', drag); window.removeEventListener('dragleave', away); window.removeEventListener('drop', drop); };
  }, [off]);

  return (
    <div className={cx('rounded-[22px] border-2 border-dashed px-4 text-center transition-colors duration-200', compact ? 'py-6' : 'py-10 sm:py-14', over ? 'border-blue bg-blue-soft' : 'border-line-strong')}>
      <span aria-hidden className={cx('mx-auto grid place-items-center rounded-2xl bg-blue-soft text-blue-text', compact ? 'size-11' : 'size-14')}><Upload size={compact ? 21 : 26} /></span>
      <p className="mt-3.5 text-[15px] font-medium text-ink">{over ? 'Let go to use it' : 'Drop a folder or a ZIP here'}</p>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted" aria-live="polite">{busy ?? 'node_modules and .env files stay on this computer.'}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={<FolderOpen size={15} />} loading={!!busy} disabled={off} onClick={pickFolder}>Pick a folder…</Button>
        <Button variant="secondary" icon={<FileArchive size={15} />} disabled={off} onClick={() => zip.current?.click()}>Choose a ZIP…</Button>
      </div>
      {error && <p role="alert" className="mx-auto mt-3 max-w-md text-[13px] text-bad">{error}</p>}
      <input ref={zip} type="file" accept=".zip,application/zip" hidden aria-label="Choose a ZIP" onChange={(e) => { chosen(e.target.files); e.target.value = ''; }} />
      <input ref={folder} type="file" hidden aria-label="Pick a folder" {...{ webkitdirectory: '' }} onChange={(e) => { chosen(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
