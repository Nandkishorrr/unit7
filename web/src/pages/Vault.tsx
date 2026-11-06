// Stored secrets (advanced): every credential reference in the vault, with history, rotate and
// retire. Provider accounts themselves live on the Connections page.
import { useEffect, useState } from 'react';
import { Plus, RefreshCw, History, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { act, Badge, Button, Dialog, Empty, Field, Input, Rows, Skeleton, Textarea, timeAgo, Illustration } from '../ui';
import { BrandLogo } from '../brand/BrandLogo';
import { secretWords, whoWords } from '../lib/words';
import type { Me } from '../App';

const call = async (name: string, input: object) => { const r = await api(`/api/tools/${name}`, { body: { input } }); return r.status === 'ok' ? r.output : null; };

export function StoredSecrets({ me }: { me: Me }) {
  const [creds, setCreds] = useState<any[] | null>(null);
  const [addCred, setAddCred] = useState(false);
  const [history, setHistory] = useState<{ ref: string; rows: any[] } | null>(null);
  const load = async () => setCreds(await call('vault.list', {}) ?? []);
  useEffect(() => { void load(); }, []);
  const human = me.role !== 'agent';
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-[13px] text-muted">Your AI only ever sees a secret’s name, never its value. Values never leave this computer.</p>
        {human && <Button size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => setAddCred(true)}>Add a secret</Button>}
      </div>
      {!creds ? <Skeleton className="h-24" /> : creds.length === 0 ? (
        <Empty art={<Illustration name="connections" size={100} />} title="Nothing stored yet" body="Connected accounts, server keys and database passwords show up here." />
      ) : (
        <Rows>
          {creds.map((c) => { const w = secretWords(c.ref); return (
            <div key={c.ref} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised"><BrandLogo id={w.provider} size={18} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-ink" title={c.ref}>{w.text}</p>
                <p className="text-[12px] text-muted">Version {c.version} · ends in {String(c.hint).slice(-4)} · used {timeAgo(c.last_used_at)}</p>
              </div>
              <Button size="sm" variant="ghost" icon={<History size={12} />} onClick={async () => setHistory({ ref: c.ref, rows: await call('vault.history', { ref: c.ref }) ?? [] })}>History</Button>
              {human && <RotateButton cref={c.ref} onDone={load} />}
              {human && <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={async () => { if (confirm(`Retire ${w.text}? Anything using it stops working.`) && await act('vault.retire', { ref: c.ref }, { success: 'Retired' })) void load(); }}>Retire</Button>}
            </div>
          ); })}
        </Rows>
      )}
      <AddCredential open={addCred} onClose={() => setAddCred(false)} onDone={load} />
      <Dialog open={!!history} onClose={() => setHistory(null)} title="Earlier versions" wide>
        {history && (
          <div className="space-y-3">
            <p className="text-[14px] font-medium" title={history.ref}>{secretWords(history.ref).text}</p>
            <Rows>
              {history.rows.map((h) => (
                <div key={h.version} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <span className="w-20 font-medium">Version {h.version}</span><span className="flex-1 text-muted">ends in {String(h.hint).slice(-4)} · {whoWords(h.created_by ?? 'Unit7')} · {new Date(h.created_at).toLocaleString()}</span>
                  {h.retired_at ? <Button size="sm" variant="ghost" onClick={async () => { if (await act('vault.restore', { ref: history.ref, version: h.version }, { success: `v${h.version} is current again` })) { setHistory(null); void load(); } }}>Restore</Button> : <Badge tone="ok">In use</Badge>}
                </div>
              ))}
            </Rows>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function RotateButton({ cref, onDone }: { cref: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  return (
    <>
      <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => setOpen(true)}>Change</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Change this secret">
        <form onSubmit={async (e) => { e.preventDefault(); if (await act('vault.set', { ref: cref, value }, { success: 'Rotated. The old version stays restorable.' })) { setOpen(false); setValue(''); onDone(); } }} className="space-y-4">
          <p className="text-[14px] font-medium" title={cref}>{secretWords(cref).text}</p>
          <Field label="New value"><Input autoFocus required type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary">Save</Button></div>
        </form>
      </Dialog>
    </>
  );
}

function AddCredential({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', value: '' });
  return (
    <Dialog open={open} onClose={onClose} title="Add a secret">
      <form onSubmit={async (e) => { e.preventDefault(); if (await act('vault.set', { ref: `credential://${f.name.replace(/^credential:\/\//, '')}`, value: f.value }, { success: 'Stored' })) { setF({ name: '', value: '' }); onClose(); onDone(); } }} className="space-y-4">
        <Field label="Name" hint="Service, account, what it is. Lowercase, with slashes between."><Input required pattern="[a-z0-9-]+/[a-z0-9-]+/[a-z0-9-]+" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} className="font-mono" placeholder="stripe/client-a/secret-key" /></Field>
        <Field label="Value"><Textarea required rows={3} autoComplete="off" spellCheck={false} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} className="font-mono text-[12.5px]" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary">Store</Button></div>
      </form>
    </Dialog>
  );
}
