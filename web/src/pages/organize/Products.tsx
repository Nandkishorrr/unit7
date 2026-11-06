// Group what belongs together: the Products page (what Unit7 thinks is one product, and the products you have), the
// review pop-up (untick, rename, or add to a product or a Unit7 project you already have), and one product's pop-up.
import { useEffect, useState } from 'react';
import { Briefcase, Check, Globe, Layers, Pencil, Sparkles, Unlink, X } from 'lucide-react';
import { runTool } from '../../lib/api';
import { navigate, useQuery } from '../../lib/router';
import { BrandLogo, providerName } from '../../brand/BrandLogo';
import { act, Badge, Button, confirmDialog, cx, Dot, Empty, Field, Input, Modal, PageHeader, Skeleton, Illustration } from '../../ui';
import { HEALTH_DOT, HEALTH_WORDS, reloadClients, useClientFilter, type GroupSuggestion, type Product, type Suggested } from './data';
import { ClientFilter, MoveToClientDialog } from './Clients';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SURE: Record<GroupSuggestion['confidence'], { word: string; tone: 'ok' | 'info' | 'neutral' }> = { strong: { word: 'Sure', tone: 'ok' }, good: { word: 'Likely', tone: 'info' }, maybe: { word: 'Maybe', tone: 'neutral' } };
const KIND: Record<string, string> = { app: 'App', database: 'Database', domain: 'Domain', project: 'Project', service: 'Service', gone: 'Gone from the map' };
// a domain says who serves its DNS (its logo), anything else its provider
const where = (kind: string, provider: string, logo?: string) => `${KIND[kind] ?? kind} · ${provider === 'domain' ? (logo && logo !== 'domain' ? providerName(logo) : 'DNS') : providerName(provider)}`;

const Logo = ({ id, size = 20 }: { id: string; size?: number }) => (id === 'domain' || !id ? <Globe size={size - 3} className="text-muted" aria-hidden /> : <BrandLogo id={id} size={size} />);
const Stack = ({ ids, size = 18 }: { ids: string[]; size?: number }) => (
  <span className="flex -space-x-1.5">{[...new Set(ids)].slice(0, 5).map((l) => <span key={l} className="grid place-items-center rounded-full bg-surface ring-2 ring-surface" style={{ width: size + 8, height: size + 8 }}><Logo id={l} size={size} /></span>)}</span>
);

// why each one belongs, kept with the product so its pop-up can say it
const reasonsOf = (items: { key: string; reason: string }[]) => Object.fromEntries(items.map((i) => [i.key, i.reason.slice(0, 200)]));

function useSuggested() {
  const [s, setS] = useState<Suggested | null>(null);
  const load = () => runTool('group.suggest').then((r) => { if (r.status === 'ok') setS(r.output as Suggested); }).catch(() => {});
  useEffect(() => { void load(); }, []);
  return { data: s, reload: load };
}

export function ProductsPage() {
  const { data, reload } = useSuggested();
  const q = useQuery();
  const [review, setReview] = useState<GroupSuggestion | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const id = q.get('review'); if (id && data) setReview(data.suggestions.find((s) => s.id === id) ?? null); }, [data, q.get('review')]);
  const closeReview = () => { setReview(null); if (q.get('review')) navigate('/products', { replace: true }); };
  const done = () => { closeReview(); void reload(); void reloadClients(); };
  const product = data?.groups.find((g) => g.id === open);
  const filter = useClientFilter();
  const groups = (data?.groups ?? []).filter((g) => filter.has(g.id));
  return (
    <div>
      <div className="relative z-20">
        <PageHeader title="Products" subtitle="A site, its database, its domain and its repo are often one product across several accounts. Grouped, they share one name and one health everywhere."
          actions={<ClientFilter />} />
      </div>
      {!data ? <Skeleton className="h-[180px] rounded-[24px]" /> : (
        <div className="space-y-8">
          {data.suggestions.length > 0 && <GroupSuggestions list={data.suggestions} onReview={setReview} onDone={done} />}
          <section className="space-y-3.5">
            <h2 className="text-[15.5px] font-semibold tracking-[-0.015em]">Your products</h2>
            {!groups.length ? (
              filter.active && data.groups.length ? <p className="rounded-[20px] border border-dashed border-line-strong px-4 py-6 text-center text-[13.5px] text-muted">None of your products are {filter.client ? `${filter.client.name}’s` : 'your own'}. <button type="button" className="font-medium text-blue-text hover:underline" onClick={() => filter.pick(null)}>Show every client’s</button></p> :
              <Empty art={<Illustration name="apps" size={100} />} title="No products yet" body={data.suggestions.length ? 'Look at what Unit7 found above, and group what belongs together.' : 'When Unit7 sees things across your accounts that belong together (a setting pointing at a database, a domain pointing at a site), it suggests them here.'} />
            ) : (
              <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 min-[105rem]:grid-cols-4">
                {groups.map((g) => (
                  <button key={g.id} type="button" onClick={() => setOpen(g.id)} className="lift flex flex-col gap-4 rounded-[24px] border border-line bg-surface p-5 text-left shadow-soft transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-soft">
                    <div className="flex items-start gap-3">
                      <span className="grid size-11 shrink-0 place-items-center rounded-[30%] bg-blue-soft text-blue-text"><Layers size={20} aria-hidden /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-[15.5px] font-semibold tracking-[-0.015em]">{g.name}</span><span className="block text-[12.5px] text-muted">{plural(g.members.length, 'thing')}{g.auto ? ' · grouped by Unit7' : ''}</span></span>
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2"><Dot tone={HEALTH_DOT[g.health]} />{HEALTH_WORDS[g.health]}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Stack ids={g.members.map((m) => m.logo)} />
                      {g.client && <Badge><span aria-hidden className="size-2 rounded-full" style={{ background: g.client.color ?? 'var(--blue)' }} />{g.client.name}</Badge>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      <GroupReview suggestion={review} data={data} onClose={closeReview} onDone={done} />
      <ProductModal product={product} onClose={() => setOpen(null)} onChanged={() => { void reload(); void reloadClients(); }} />
    </div>
  );
}

// What Unit7 found, a card each. Mountable anywhere (Home's side panel): onReview opens GroupReview.
export function GroupSuggestions({ list, onReview, onDone, max = 6 }: { list: GroupSuggestion[]; onReview: (s: GroupSuggestion) => void; onDone?: () => void; max?: number }) {
  return (
    <section className="space-y-3.5" aria-labelledby="found-together">
      <h2 id="found-together" className="flex items-center gap-2 text-[15.5px] font-semibold tracking-[-0.015em]"><Sparkles size={16} className="text-blue-text" aria-hidden />Found together</h2>
      <div className="stagger grid grid-cols-1 gap-4 lg:grid-cols-2">
        {list.slice(0, max).map((s) => <SuggestionCard key={s.id} s={s} onReview={() => onReview(s)} onDone={onDone} />)}
      </div>
    </section>
  );
}
function SuggestionCard({ s, onReview, onDone }: { s: GroupSuggestion; onReview: () => void; onDone?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const sure = SURE[s.confidence];
  const accept = async () => {
    setBusy('yes');
    const r = await act('group.accept', { keys: s.items.map((i) => i.key), reasons: reasonsOf(s.items), ...(s.into ? { groupId: s.into.id } : { name: s.name }) }, { success: s.into ? `Added to ${s.into.name}` : `Grouped as ${s.name}` });
    setBusy(null);
    if (r) onDone?.();
  };
  const no = async () => { setBusy('no'); if (await act('group.dismiss', { id: s.id }, { success: 'Unit7 won’t suggest that again', undo: false })) onDone?.(); setBusy(null); };
  return (
    <article className="flex flex-col gap-4 rounded-[24px] border border-line bg-surface p-5 shadow-soft">
      <div className="flex items-start gap-3">
        <Stack ids={s.items.map((i) => i.logo)} size={20} />
        <Badge tone={sure.tone} className="ml-auto">{sure.word}</Badge>
      </div>
      <p className="text-[15px] font-semibold leading-snug tracking-[-0.015em]">
        {s.into ? <>{s.items.length > 1 ? `${s.items.length} things look` : `${s.items[0]!.name} looks`} like part of <span className="text-blue-text">{s.into.name}</span></> : <>These {s.items.length} look like one product: <span className="text-blue-text">{s.name}</span></>}
      </p>
      <ul className="space-y-1.5">{s.items.slice(0, 4).map((i) => (
        <li key={i.key} className="flex items-start gap-2 text-[13px]"><span className="mt-0.5"><Logo id={i.logo} size={16} /></span><span className="min-w-0"><span className="font-medium text-ink">{i.name}</span> <span className="text-muted">{i.reason}</span></span></li>
      ))}{s.items.length > 4 && <li className="pl-6 text-[12.5px] text-muted">and {s.items.length - 4} more</li>}</ul>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Check size={14} />} loading={busy === 'yes'} onClick={accept}>{s.into ? 'Add them' : 'Group them'}</Button>
        <Button size="sm" variant="secondary" onClick={onReview}>Look first</Button>
        <Button size="sm" variant="ghost" loading={busy === 'no'} onClick={no}>Not one product</Button>
      </div>
    </article>
  );
}

// Untick what doesn't belong, rename it, or put it into a product or a Unit7 project you already have
export function GroupReview({ suggestion: s, data, onClose, onDone }: { suggestion: GroupSuggestion | null; data: Suggested | null; onClose: () => void; onDone: () => void }) {
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [into, setInto] = useState('new');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s) { setKeep(new Set(s.items.map((i) => i.key))); setName(s.into?.name ?? s.name); setInto(s.into ? `grp:${s.into.id}` : 'new'); } }, [s?.id]);
  if (!s) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  const keys = s.items.filter((i) => keep.has(i.key)).map((i) => i.key);
  const target = into.startsWith('grp:') ? { groupId: into.slice(4) } : into.startsWith('prj:') ? { projectId: into.slice(4) } : { name: name.trim() };
  const save = async () => {
    setBusy(true);
    const left = s.items.filter((i) => !keep.has(i.key)).map((i) => i.key); // unticked: not suggested for it again
    const r = await act('group.accept', { keys, reasons: reasonsOf(s.items.filter((i) => keep.has(i.key))), ...target, ...(left.length && { left }) }, { success: 'Grouped' });
    setBusy(false);
    if (r) onDone();
  };
  const toggle = (k: string) => setKeep((x) => { const n = new Set(x); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <Modal open={!!s} onClose={onClose} size="md" title={s.into ? `Add to ${s.into.name}?` : 'One product?'}>
      <div className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-ink-2">What belongs (untick what doesn’t)</legend>
          <ul className="divide-y divide-line rounded-[20px] border border-line">{s.items.map((i) => (
            <li key={i.key}>
              <label className="flex cursor-pointer items-start gap-3 px-4 py-3 transition hover:bg-raised/60">
                <input type="checkbox" aria-label={i.name} checked={keep.has(i.key)} onChange={() => toggle(i.key)} className="mt-1 size-4 shrink-0 accent-[var(--blue)]" />
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-raised"><Logo id={i.logo} size={17} /></span>
                <span className="min-w-0 flex-1"><span className={cx('block truncate text-[14px] font-medium', !keep.has(i.key) && 'text-muted line-through')}>{i.name}</span>
                  <span className="block text-[12px] text-muted">{where(i.kind, i.provider, i.logo)}</span><span className="mt-0.5 block text-[12.5px] text-ink-2">{i.reason}</span></span>
              </label>
            </li>
          ))}</ul>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Put them in">
            <select value={into} onChange={(e) => setInto(e.target.value)} className="h-10 w-full rounded-[14px] border border-line-strong bg-surface px-3 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue-soft">
              <option value="new">A new product</option>
              {!!data?.groups.length && <optgroup label="A product you have">{data.groups.map((g) => <option key={g.id} value={`grp:${g.id}`}>{g.name}</option>)}</optgroup>}
              {!!data?.projects.length && <optgroup label="With a Unit7 project">{data.projects.map((p) => <option key={p.id} value={`prj:${p.id}`}>{p.name}</option>)}</optgroup>}
            </select>
          </Field>
          {into === 'new' && <Field label="Its name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button variant="primary" icon={<Check size={15} />} loading={busy} disabled={!keys.length || (into === 'new' && !name.trim())} onClick={save}>{keys.length > 1 ? `Group ${keys.length} things` : 'Add it'}</Button>
        </div>
      </div>
    </Modal>
  );
}

// One product: what's in it and why, rename, take something out, give it to a client, ungroup
export function ProductModal({ product: p, onClose, onChanged }: { product?: Product; onClose: () => void; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [moving, setMoving] = useState(false);
  useEffect(() => { setRenaming(false); setName(p?.name ?? ''); }, [p?.id]);
  const rename = async () => { if (p && name.trim() && await act('group.rename', { groupId: p.id, name: name.trim() }, { success: 'Renamed' })) { setRenaming(false); onChanged(); } };
  const out = async (key: string, n: string) => { if (p && await act('group.remove_member', { groupId: p.id, keys: [key] }, { success: `Took ${n} out` })) onChanged(); };
  const ungroup = async () => {
    if (!p || !await confirmDialog({ title: `Ungroup ${p.name}?`, body: 'Its things stay exactly where they run; they just stop sharing a name and health. Unit7 won’t suggest this group again.', confirm: 'Ungroup' })) return;
    if (await act('group.dissolve', { groupId: p.id }, { success: `Ungrouped ${p.name}` })) { onClose(); onChanged(); }
  };
  return (
    <>
      <Modal open={!!p && !moving} onClose={onClose} size="md" title={p ? (renaming ? 'Rename' : p.name) : ''}>
        {p && (
          <div className="space-y-5">
            {renaming ? (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="New name" />
                <Button variant="primary" disabled={!name.trim()}>Save</Button><Button type="button" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={p.health === 'ok' ? 'ok' : p.health === 'warn' ? 'warn' : 'bad'}><Dot tone={HEALTH_DOT[p.health]} />{HEALTH_WORDS[p.health]}</Badge>
                {p.client && <Badge>{p.client.name}’s</Badge>}
                {p.auto && <Badge tone="info">Grouped by Unit7</Badge>}
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => setRenaming(true)}>Rename</Button>
                  <Button size="sm" variant="secondary" icon={<Briefcase size={13} />} onClick={() => setMoving(true)}>Move to client…</Button>
                </span>
              </div>
            )}
            <ul className="divide-y divide-line rounded-[20px] border border-line">{p.members.map((m) => (
              <li key={m.key} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-raised"><Logo id={m.logo} size={17} /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{m.name}</span><span className="block text-[12px] text-muted">{where(m.kind, m.provider, m.logo)}</span>{m.reason && <span className="mt-0.5 block text-[12.5px] text-ink-2">{m.reason}</span>}</span>
                {p.members.length > 1 && <Button size="sm" variant="ghost" aria-label={`Take ${m.name} out of ${p.name}`} title="Take it out" icon={<X size={14} />} onClick={() => out(m.key, m.name)} />}
              </li>
            ))}</ul>
            <div className="border-t border-line pt-4"><Button size="sm" variant="ghost" icon={<Unlink size={14} />} onClick={ungroup}>Ungroup…</Button></div>
          </div>
        )}
      </Modal>
      {p && <MoveToClientDialog item={{ key: p.id, name: p.name }} open={moving} onClose={() => setMoving(false)} onMoved={onChanged} />}
    </>
  );
}
