// Move a WordPress site in: its export ZIP (with the database inside it, or as a file of its own), the address it had and the address
// it gets. The files reach Unit7 through the raw upload route with a progress bar, then wordpress.import makes a new site from them. It
// never goes over a site that exists. A file already sent isn't sent again after a failure.
import { useRef, useState, type ChangeEvent } from 'react';
import { FileArchive, Truck, X } from 'lucide-react';
import { runTool, upload, type ToolResult } from '../../lib/api';
import { navigate } from '../../lib/router';
import { tidy } from '../../lib/words';
import { Button, Field, Input, Modal, cx, toast } from '../../ui';
import { LiveMoment, Note, StepList, host, useSteps } from './parts';

const CAP = 100 * 1024 * 1024; // the most one upload takes (src/server/http.ts)
const OVER = 'That’s over 100 MB. Take big videos and old backups out of it, and try again.';
const megabytes = (n: number) => `${Math.max(0.1, n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const OLD = /^(https?:\/\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?(\/[\w.-]+)*\/?$/, NEW = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+){2,}$/;
interface Moved { url?: string; answers?: boolean; why?: string; dns?: { written: boolean; at?: string; addThese?: { type: string; name: string; value: string }[] } }
const said = (r: ToolResult) => tidy(r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? 'It waits for your OK on Approvals.' : 'That didn’t go through.');

function Pick({ label, hint, accept, file, wrong, onFile }: { label: string; hint: string; accept: string; file?: File; wrong?: string; onFile: (f?: File) => void }) {
  const box = useRef<HTMLInputElement>(null);
  const chosen = (e: ChangeEvent<HTMLInputElement>) => { onFile(e.target.files?.[0]); e.target.value = ''; };
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-medium text-ink-2">{label}</p>
      <div className={cx('flex min-w-0 items-center gap-2.5 rounded-[14px] border border-dashed px-3 py-2.5', wrong ? 'border-bad/50' : 'border-line-strong')}>
        <FileArchive size={17} aria-hidden className="shrink-0 text-muted" />
        <span className={cx('min-w-0 flex-1 truncate text-[13.5px]', file ? 'text-ink' : 'text-muted')}>{file ? `${file.name} · ${megabytes(file.size)}` : 'Nothing picked yet'}</span>
        {file && <button type="button" aria-label={`Take ${file.name} out`} onClick={() => onFile(undefined)} className="grid size-7 shrink-0 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><X size={14} /></button>}
        <Button type="button" size="sm" variant="secondary" className="shrink-0" onClick={() => box.current?.click()}>{file ? 'Change' : 'Choose…'}</Button>
      </div>
      <input ref={box} type="file" accept={accept} hidden aria-label={label} onChange={chosen} />
      {wrong ? <p role="alert" className="text-[12.5px] text-bad">{wrong}</p> : <p className="text-[12.5px] text-muted">{hint}</p>}
    </div>
  );
}

export function MoveInModal({ serverId, server, onClose }: { serverId: string; server: string; onClose: () => void }) {
  const [zip, setZip] = useState<File>();
  const [sql, setSql] = useState<File>();
  const [oldAddress, setOld] = useState('');
  const [domain, setDomain] = useState('');
  const [takeover, setTakeover] = useState('');
  const [inUse, setInUse] = useState(false);
  const [phase, setPhase] = useState<'ask' | 'sending' | 'running' | 'done'>('ask');
  const [sent, setSent] = useState(0);
  const [why, setWhy] = useState<{ text: string; approval?: boolean }>();
  const [out, setOut] = useState<Moved>();
  const ids = useRef(new Map<File, string>());
  const steps = useSteps('wordpress.import', phase === 'running');
  const name = domain.trim().toLowerCase(), was = oldAddress.trim().toLowerCase();
  const zipWrong = zip && (!/\.zip$/i.test(zip.name) ? 'Unit7 reads ZIP files here. Make a ZIP of the site’s wp-content folder.' : zip.size > CAP ? OVER : undefined);
  const sqlWrong = sql && (!/\.(sql|gz)$/i.test(sql.name) ? 'That should be an .sql file, or an .sql.gz.' : sql.size > CAP ? OVER : undefined);
  const ready = !!zip && !zipWrong && !sqlWrong && OLD.test(was) && NEW.test(name) && (!inUse || takeover.trim().toLowerCase() === name);
  const go = async () => {
    setWhy(undefined); setSent(0); setPhase('sending');
    const files = [zip!, ...(sql ? [sql] : [])], fresh = files.filter((f) => !ids.current.has(f)), total = fresh.reduce((n, f) => n + f.size, 0) || 1;
    try {
      let before = 0;
      for (const f of fresh) {
        ids.current.set(f, (await upload(f, (share) => setSent((before + share * f.size) / total))).uploadId);
        before += f.size;
      }
    } catch (e) { setWhy({ text: tidy((e as Error).message) }); setPhase('ask'); return; }
    setPhase('running');
    const r = await runTool('wordpress.import', { serverId, domain: name, filesUploadId: ids.current.get(zip!), ...(sql && { sqlUploadId: ids.current.get(sql) }), oldAddress: was, ...(inUse && { takeover: takeover.trim().toLowerCase() }) })
      .catch((e: Error) => ({ status: 'error', error: { code: 'network', message: e.message } }) as ToolResult);
    if (r.status === 'ok') { setOut(r.output as Moved); setPhase('done'); toast('ok', 'Your site moved in', name); return; }
    if (r.status === 'error' && r.error.code === 'domain_in_use') setInUse(true);
    setWhy({ text: said(r), approval: r.status === 'approval_required' }); setPhase('ask');
  };
  const pct = Math.round(sent * 100), titles = Array.from({ length: Math.max(steps.of, steps.titles.length) }, (_, i) => steps.titles[i] ?? '');
  return (
    <Modal open onClose={onClose} title={phase === 'done' ? 'Moved in' : `Move a WordPress site to ${server}`} size="md">
      {phase === 'ask' && (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) void go(); }}>
          <p className="text-[13.5px] text-ink-2">Unit7 makes a new WordPress site from your export and changes the old address to the new one. Nothing that’s already on {server} changes, and the old site isn’t touched.</p>
          <Pick label="The site’s export ZIP" hint="A ZIP of its wp-content folder, up to 100 MB. If the database is inside it, you’re done here." accept=".zip,application/zip" file={zip} wrong={zipWrong || undefined} onFile={setZip} />
          <Pick label="Its database, if it’s a separate file" hint="An .sql or .sql.gz export, up to 100 MB." accept=".sql,.gz" file={sql} wrong={sqlWrong || undefined} onFile={setSql} />
          <Field label="Its old address" hint="Where it lives now. Links to it change to the new address.">
            <Input value={oldAddress} placeholder="https://www.example.com" autoComplete="off" onChange={(e) => setOld(e.target.value)} aria-invalid={!!was && !OLD.test(was)} />
          </Field>
          <Field label="Its new address" hint="A subdomain nothing else uses. Unit7 writes its DNS record, and HTTPS follows.">
            <Input value={domain} placeholder="blog.example.com" autoComplete="off" onChange={(e) => setDomain(e.target.value)} aria-invalid={!!name && !NEW.test(name)} />
          </Field>
          {inUse && (
            <Field label={`Type ${name} to move it here`} hint="Whatever answers at that address now stops getting its visitors.">
              <Input value={takeover} autoComplete="off" onChange={(e) => setTakeover(e.target.value)} />
            </Field>
          )}
          {why && <Note tone={why.approval ? 'info' : 'bad'}>{why.text}</Note>}
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>Not now</Button>
            {why?.approval ? <Button type="button" variant="primary" onClick={() => navigate('/approvals')}>Open Approvals</Button>
              : <Button type="submit" variant="primary" icon={<Truck size={15} />} disabled={!ready}>{why ? 'Try again' : 'Move it in'}</Button>}
          </div>
        </form>
      )}
      {phase === 'sending' && (
        <div className="space-y-2.5">
          <p className="flex items-baseline justify-between gap-3 text-[13.5px] text-ink"><span>Sending your files to Unit7…</span><span className="tabular text-muted">{pct}%</span></p>
          <div role="progressbar" aria-label="Sending your files to Unit7" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-blue transition-[width] duration-300" style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <p className="text-[12.5px] text-muted">Keep this page open until they’re sent.</p>
        </div>
      )}
      {phase === 'running' && (
        <div className="space-y-4">
          {titles.length ? <StepList steps={titles} at={steps.at} note={steps.note} /> : <p className="text-[13.5px] text-ink" aria-live="polite">{steps.note ?? 'Starting…'}</p>}
          <p className="text-[12.5px] text-muted">This can take a few minutes for a big site. Keep this page open until it’s done.</p>
        </div>
      )}
      {phase === 'done' && out && (
        <LiveMoment title={`${host(out.url) || name} is in`} url={out.url}>
          <div className="space-y-3">
            {out.answers === false && <Note tone="warn">It doesn’t answer yet{out.why ? `: ${tidy(out.why)}` : ''}. Give it a few minutes, then open it.</Note>}
            {out.dns && !out.dns.written && out.dns.addThese && <Note tone="warn">Add this record where your domain’s DNS lives ({out.dns.at}): {out.dns.addThese.map((r) => `${r.type} ${r.name} → ${r.value}`).join(', ')}.</Note>}
            <Note>Sign in with the login you had on the old site.</Note>
          </div>
          <div className="mt-5 flex justify-end"><Button variant="dark" onClick={onClose}>Done</Button></div>
        </LiveMoment>
      )}
    </Modal>
  );
}
