// Client spaces: the Clients page (a card per client: its products, health and this month's cost), the client's pop-up
// (what's theirs, the month's costs with a CSV to copy, the status page), the switcher that filters pages to one
// client, and "Move to client…" for any project or thing.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Briefcase, Check, ChevronDown, ExternalLink, FileSpreadsheet, Globe, ImagePlus, Link2, Pencil, Plus, Power, RefreshCw, Trash2, Users, X } from 'lucide-react';
import { runTool, useApi } from '../../lib/api';
import { BrandLogo } from '../../brand/BrandLogo';
import { A, act, Badge, Button, Card, confirmDialog, CopyButton, cx, Dot, Empty, Field, Illustration, Input, Modal, PageHeader, Skeleton, timeAgo } from '../../ui';
import { Menu, type MenuItem } from '../kit';
import { HEALTH_DOT, HEALTH_WORDS, initials, money, reloadClients, useClientFilter, useClients, type Client, type ClientMember } from './data';

const SWATCHES = ['#2f5bea', '#7a9a01', '#c2410c', '#0f766e', '#9333ea', '#be123c', '#0369a1', '#a16207'];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ClientAvatar({ c, size = 44 }: { c: Pick<Client, 'name' | 'color' | 'logo'>; size?: number }) {
  return c.logo
    ? <img src={c.logo} alt="" width={size} height={size} className="shrink-0 rounded-[30%] bg-raised object-cover" style={{ width: size, height: size }} />
    : <span aria-hidden className="grid shrink-0 place-items-center rounded-[30%] font-semibold text-white" style={{ width: size, height: size, background: c.color, fontSize: size * 0.36 }}>{initials(c.name)}</span>;
}
const Logos = ({ ids, size = 16 }: { ids: string[]; size?: number }) => (
  <span className="flex -space-x-1.5">{ids.slice(0, 4).map((l) => <span key={l} className="grid place-items-center rounded-full bg-surface ring-2 ring-surface" style={{ width: size + 6, height: size + 6 }}>{l === 'domain' ? <Globe size={size - 3} className="text-muted" aria-hidden /> : <BrandLogo id={l} size={size} />}</span>)}</span>
);

// --- the page ---------------------------------------------------------------------------------------------------------------
export function ClientsPage() {
  const list = useClients();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const client = list?.clients.find((c) => c.id === open);
  return (
    <div>
      <PageHeader title="Clients" subtitle="Who you build for. Each client’s products, how they’re doing, and what they cost this month."
        actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>Add a client</Button>} />
      {!list ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading clients">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[188px] rounded-[24px]" />)}</div>
      ) : !list.clients.length ? (
        <Empty art={<Illustration name="clients" size={108} />} title="No clients yet"
          body="Add the businesses you build for. Give each one its products and projects, and you can see what it costs, filter every page to it, and share a status page with it."
          action={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>Add your first client</Button>} />
      ) : (
        <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 min-[105rem]:grid-cols-4">
          {list.clients.map((c) => <ClientCard key={c.id} c={c} onOpen={() => setOpen(c.id)} />)}
          <Card className="flex flex-col justify-between gap-4 border-dashed bg-surface/60 p-5">
            <div className="flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-[30%] bg-raised text-muted"><Users size={19} aria-hidden /></span>
              <div><p className="text-[15px] font-semibold tracking-[-0.015em]">Your own</p><p className="text-[12.5px] text-muted">Everything no client has</p></div>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-[12.5px]">
              <Stat k="Products and projects" v={String(list.mine.products + list.mine.projects)} />
              <Stat k="Not assigned this month" v={money(list.mine.cost)} />
            </dl>
          </Card>
        </div>
      )}
      <ClientModal client={client} month={list?.month} onClose={() => setOpen(null)} />
      <ClientForm open={adding} onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); setOpen(id); }} />
    </div>
  );
}

const Stat = ({ k, v, children }: { k: string; v?: string; children?: ReactNode }) => (
  <div className="min-w-0 rounded-[14px] bg-raised/70 px-3 py-2"><dt className="truncate text-[11.5px] text-muted">{k}</dt><dd className="tabular mt-0.5 truncate text-[14px] font-semibold text-ink">{children ?? v}</dd></div>
);

function ClientCard({ c, onOpen }: { c: Client; onOpen: () => void }) {
  const logos = [...new Set(c.members.flatMap((m) => m.logos))];
  return (
    <button type="button" onClick={onOpen} className="lift group flex flex-col gap-4 rounded-[24px] border border-line bg-surface p-5 text-left shadow-soft transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-soft">
      <div className="flex items-center gap-3">
        <ClientAvatar c={c} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15.5px] font-semibold tracking-[-0.015em] text-ink">{c.name}</p>
          <p className="truncate text-[12.5px] text-muted">{c.contact ? c.contact : plural(c.products + c.projects, 'product')}</p>
        </div>
        {c.statusPage.on && <Badge tone="ok" className="hidden sm:inline-flex"><Link2 size={12} aria-hidden />Status page</Badge>}
      </div>
      <dl className="grid grid-cols-3 gap-2">
        <Stat k="Products" v={String(c.products + c.projects)} />
        <Stat k="Health">{c.members.length ? <span className="inline-flex items-center gap-1.5" title={HEALTH_WORDS[c.health]}><Dot tone={HEALTH_DOT[c.health]} /><span className="truncate text-[13px]">{c.health === 'ok' ? 'Good' : c.health === 'warn' ? 'Look' : 'Down'}</span></span> : '—'}</Stat>
        <Stat k="This month" v={money(c.cost)} />
      </dl>
      <div className="flex min-h-6 items-center justify-between gap-2 text-[12.5px] text-muted">
        {logos.length ? <Logos ids={logos} /> : <span>Nothing given to {c.name} yet</span>}
        <span aria-hidden className="text-faint transition group-hover:translate-x-0.5 group-hover:text-ink">Open →</span>
      </div>
    </button>
  );
}

// --- add or change a client ---------------------------------------------------------------------------------------------------------
export function ClientForm({ open, onClose, onSaved, client }: { open: boolean; onClose: () => void; onSaved?: (id: string) => void; client?: Client }) {
  const [name, setName] = useState(''), [contact, setContact] = useState(''), [color, setColor] = useState(SWATCHES[0]!), [logo, setLogo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState<string>();
  useEffect(() => { if (open) { setName(client?.name ?? ''); setContact(client?.contact ?? ''); setColor(client?.color ?? SWATCHES[0]!); setLogo(client?.logo ?? null); setProblem(undefined); } }, [open, client]);
  const pickLogo = (f?: File) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return setProblem('Pick a PNG, JPEG, WebP or GIF picture.');
    if (f.size > 85_000) return setProblem('That picture is too big. Pick one under 80 KB (a small square logo is plenty).');
    const r = new FileReader();
    r.onload = () => { setLogo(String(r.result)); setProblem(undefined); };
    r.readAsDataURL(f);
  };
  const save = async () => {
    setBusy(true);
    const input = { name: name.trim(), color, logo, contact: contact.trim() || null };
    const r = await act(client ? 'client.update' : 'client.create', client ? { clientId: client.id, ...input } : input, { success: client ? 'Saved' : `Added ${input.name}`, undo: false });
    setBusy(false);
    if (r) { await reloadClients(); onSaved?.((r.output as { clientId: string }).clientId); }
  };
  return (
    <Modal open={open} onClose={onClose} title={client ? `Change ${client.name}` : 'Add a client'} size="sm">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }}>
        <div className="flex items-center gap-3">
          <ClientAvatar c={{ name: name || '?', color, logo }} size={52} />
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line-strong px-3.5 py-2 text-[12.5px] font-medium text-ink transition hover:bg-raised focus-within:ring-4 focus-within:ring-blue-soft">
            <ImagePlus size={15} aria-hidden />{logo ? 'Change logo' : 'Add a logo'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={(e) => pickLogo(e.target.files?.[0])} />
          </label>
          {logo && <Button type="button" size="sm" variant="ghost" onClick={() => setLogo(null)}>Remove</Button>}
        </div>
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Bakery" maxLength={60} /></Field>
        <Field label="Contact" hint="Optional: who you talk to there."><Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Sam" maxLength={120} /></Field>
        {!logo && (
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Colour</legend>
            <div className="flex flex-wrap gap-2">{SWATCHES.map((s) => (
              <button key={s} type="button" aria-label={`Colour ${s}`} aria-pressed={color === s} onClick={() => setColor(s)}
                className={cx('grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-surface transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-soft', color === s && 'ring-2 ring-ink')} style={{ background: s }}>
                {color === s && <Check size={14} className="text-white" aria-hidden />}
              </button>
            ))}</div>
          </fieldset>
        )}
        {problem && <p role="alert" className="rounded-[14px] bg-warn/10 px-3.5 py-2.5 text-[13px] text-ink-2">{problem}</p>}
        <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()}>{client ? 'Save' : 'Add client'}</Button></div>
      </form>
    </Modal>
  );
}

// --- one client --------------------------------------------------------------------------------------------------------------
interface Costs { month: string; lines: { product: string; item: string; source: string; amount: number; currency: string }[]; total: { currency: string; amount: number }[]; csv: string; basis: string }
export function ClientModal({ client, month, onClose }: { client?: Client; month?: string; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const c = client;
  const remove = async () => {
    if (!c) return;
    const yes = await confirmDialog({ title: `Remove ${c.name}?`, body: `Its ${plural(c.products + c.projects + c.things, 'thing')} become your own again. Nothing at any provider changes.${c.statusPage.on ? ' Its status page is taken down.' : ''}`, confirm: 'Remove client', danger: true });
    if (yes && await act('client.remove', { clientId: c.id }, { success: `Removed ${c.name}` })) { onClose(); void reloadClients(); }
  };
  return (
    <>
      <Modal open={!!c} onClose={onClose} size="lg" title={c ? (
        <span className="flex items-center gap-3"><ClientAvatar c={c} size={40} /><span className="min-w-0"><span className="block truncate">{c.name}</span>{c.contact && <span className="block truncate text-[12.5px] font-normal text-muted">{c.contact}</span>}</span></span>
      ) : ''}>
        {c && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={c.health === 'ok' ? 'ok' : c.health === 'warn' ? 'warn' : 'bad'}><Dot tone={HEALTH_DOT[c.health]} />{HEALTH_WORDS[c.health]}</Badge>
              <Badge>{money(c.cost)} this month</Badge>
              <span className="ml-auto flex gap-1.5">
                <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>Change</Button>
              </span>
            </div>
            <section>
              <div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-[14px] font-semibold">What’s theirs</h3><Button size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add</Button></div>
              {c.members.length ? (
                <ul className="divide-y divide-line rounded-[20px] border border-line">{c.members.map((m) => <MemberRow key={m.key} m={m} client={c} />)}</ul>
              ) : <p className="rounded-[20px] border border-dashed border-line-strong px-4 py-5 text-center text-[13px] text-muted">Nothing yet. Add a product or project, or use “Move to client…” on the Map or a project.</p>}
            </section>
            <ClientCosts client={c} month={month} />
            <StatusPageSection client={c} />
            <div className="border-t border-line pt-4"><Button size="sm" variant="ghost" className="text-bad" icon={<Trash2 size={14} />} onClick={remove}>Remove client…</Button></div>
          </div>
        )}
      </Modal>
      <ClientForm open={editing} client={c} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />
      {c && <AddToClient open={adding} client={c} onClose={() => setAdding(false)} />}
    </>
  );
}

const KIND_WORD: Record<string, string> = { product: 'Product', project: 'Unit7 project', app: 'App', database: 'Database', domain: 'Domain', gone: 'Gone from the map' };
function MemberRow({ m, client }: { m: ClientMember; client: Client }) {
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Logos ids={m.logos.length ? m.logos : ['unit7']} size={18} />
      <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{m.name}</span><span className="block text-[12px] text-muted">{KIND_WORD[m.kind] ?? m.kind.charAt(0).toUpperCase() + m.kind.slice(1)}{m.count ? ` · ${plural(m.count, 'thing')}` : ''}</span></span>
      <Button size="sm" variant="ghost" loading={busy} aria-label={`Make ${m.name} your own again`} title="Make it your own again" icon={<X size={14} />}
        onClick={async () => { setBusy(true); await act('client.assign', { clientId: null, key: m.key }, { success: `${m.name} is your own again` }); setBusy(false); void reloadClients(); }}>
        <span className="hidden sm:inline">Take back</span>
      </Button>
      <span className="sr-only">from {client.name}</span>
    </li>
  );
}

function ClientCosts({ client, month }: { client: Client; month?: string }) {
  const [c, setC] = useState<Costs | null>(null);
  useEffect(() => { let on = true; setC(null); runTool('client.costs', { clientId: client.id }).then((r) => { if (on && r.status === 'ok') setC(r.output as Costs); }).catch(() => {}); return () => { on = false; }; }, [client.id, client.cost.map((x) => x.amount).join()]);
  const label = month ? new Date(`${month}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'This month';
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold">{label}</h3>
        {c && c.lines.length > 0 && <CopyCsv csv={c.csv} />}
      </div>
      {!c ? <Skeleton className="h-20 rounded-[20px]" /> : !c.lines.length ? (
        <p className="rounded-[20px] bg-raised/70 px-4 py-4 text-[13px] text-muted">No costs tied to {client.name} yet. Set a server’s monthly price and its share shows here; provider costs show after the next budget check.</p>
      ) : (
        <div className="overflow-hidden rounded-[20px] border border-line">
          <ul className="divide-y divide-line">{c.lines.map((l, i) => (
            <li key={i} className="flex items-baseline gap-3 px-4 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1"><span className="font-medium text-ink">{l.product}</span>{l.item !== l.product && <span className="text-muted"> · {l.item}</span>}<span className="block text-[12px] text-muted">{l.source}</span></span>
              <span className="tabular shrink-0 font-medium">{money([{ amount: l.amount, currency: l.currency }])}</span>
            </li>
          ))}</ul>
          <p className="flex items-baseline justify-between gap-3 bg-raised/70 px-4 py-2.5 text-[13.5px] font-semibold"><span>Total</span><span className="tabular">{money(c.total)}</span></p>
        </div>
      )}
      {c && c.lines.some((l) => l.source === 'Server share') && <p className="mt-2 text-[12px] text-muted">{c.basis}</p>}
    </section>
  );
}
function CopyCsv({ csv }: { csv: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="secondary" icon={done ? <Check size={13} className="text-ok" /> : <FileSpreadsheet size={13} />}
      onClick={() => { void navigator.clipboard.writeText(csv); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? 'Copied' : 'Copy for invoicing'}</Button>
  );
}

// --- the status page ------------------------------------------------------------------------------------------------------------
interface StatusView { on: boolean; domain?: string; server?: string; updatedAt?: string; url?: string; problem?: string; leftover?: boolean; shows?: string[]; next?: string }
function StatusPageSection({ client }: { client: Client }) {
  const [v, setV] = useState<StatusView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [serverId, setServerId] = useState(''), [domain, setDomain] = useState('');
  const graph = useApi<{ servers?: { id: string; name: string; status: string }[] }>('/api/graph', { live: false });
  const servers = (graph.data?.servers ?? []).filter((s) => s.status === 'ready');
  const read = () => runTool('client.status_link', { clientId: client.id }).then((r) => { if (r.status === 'ok') setV(r.output as StatusView); }).catch(() => {});
  useEffect(() => { setV(null); void read(); }, [client.id]);
  useEffect(() => { if (!serverId && servers[0]) setServerId(servers[0].id); }, [servers.length]);
  const run = async (what: string, input: object, success: string) => {
    setBusy(what);
    const r = await act('client.status_link', { clientId: client.id, ...input }, { success, undo: false });
    setBusy(null);
    if (r) { setV(r.output as StatusView); void reloadClients(); } else void read(); // a failure is kept with the page: show it here
  };
  const valid = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain.trim());
  return (
    <section className="rounded-[20px] border border-line p-4">
      <div className="mb-1 flex items-center gap-2"><Link2 size={16} className="text-blue-text" aria-hidden /><h3 className="text-[14px] font-semibold">Status page</h3>{v?.on && <Badge tone="ok" className="ml-auto">On</Badge>}</div>
      <p className="mb-3 text-[12.5px] text-muted">A page you can send {client.name}: each app’s name, up or down, uptime over 30 days and its last problem. Never addresses, servers, settings or logs.</p>
      {!v ? <Skeleton className="h-16 rounded-[16px]" /> : v.on ? (
        <div className="space-y-3">
          {v.url && (
            <div className="flex items-center gap-1 rounded-[14px] bg-raised px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={v.url}>{v.url}</span>
              <CopyButton text={v.url} />
              <a href={v.url} target="_blank" rel="noopener noreferrer" aria-label="Open the status page" className="grid size-7 place-items-center rounded-full text-muted transition hover:bg-surface hover:text-ink"><ExternalLink size={13} /></a>
            </div>
          )}
          <p className="text-[12.5px] text-muted">On {v.server ?? 'your server'} at {v.domain}{v.updatedAt ? ` · updated ${timeAgo(v.updatedAt)}` : ''}{v.shows ? ` · shows ${v.shows.length ? v.shows.join(', ') : 'nothing yet'}` : ''}</p>
          {v.next && <p className="rounded-[14px] bg-blue-soft px-3.5 py-2.5 text-[12.5px] text-ink-2">{v.next}</p>}
          {v.problem && <p role="alert" className="rounded-[14px] bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-ink-2">{v.problem}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} loading={busy === 'rotate'}
              onClick={async () => { if (await confirmDialog({ title: 'Make a new link?', body: `The link ${client.name} has now stops working at once. Send them the new one.`, confirm: 'Make a new link' })) void run('rotate', { rotate: true }, 'New link made. The old one no longer works.'); }}>New link</Button>
            <Button size="sm" variant="ghost" className="text-bad" icon={<Power size={13} />} loading={busy === 'off'}
              onClick={async () => { if (await confirmDialog({ title: `Turn off ${client.name}’s status page?`, body: 'The page and its files are removed from your server. You can turn it on again later with a new link.', confirm: 'Turn it off', danger: true })) void run('off', { enabled: false }, 'Status page turned off'); }}>Turn off</Button>
          </div>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid && serverId) void run('on', { enabled: true, serverId, domain: domain.trim().toLowerCase() }, `${client.name}’s status page is on`); }}>
          {v.problem && <p role="alert" className="rounded-[14px] bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-ink-2">{v.problem}</p>}
          {servers.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="On which server">
                <span className="relative block">
                  <select value={serverId} onChange={(e) => setServerId(e.target.value)} className="h-10 w-full appearance-none rounded-[14px] border border-line-strong bg-surface pl-3.5 pr-9 text-[14px] text-ink outline-none focus:border-blue focus:ring-4 focus:ring-blue-soft">
                    {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <ChevronDown size={15} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
                </span>
              </Field>
              <Field label="Its address" hint="A name of its own, pointed at that server."><Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="status.example.com" autoComplete="off" spellCheck={false} /></Field>
            </div>
          ) : <p className="text-[13px] text-muted">It needs one of your servers to live on. <A href="/servers" className="font-medium text-blue-text hover:underline">Connect a server</A> first.</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-muted">A long random link, rate-limited where the server allows. Refreshed every 5 minutes.</p>
            <Button variant="primary" size="sm" icon={<Power size={13} />} loading={busy === 'on'} disabled={!valid || !serverId}>Turn on</Button>
          </div>
        </form>
      )}
    </section>
  );
}

// --- giving things to a client --------------------------------------------------------------------------------------------------------------
function AddToClient({ open, client, onClose }: { open: boolean; client: Client; onClose: () => void }) {
  const [data, setData] = useState<{ groups: { id: string; name: string; members: { logo: string }[]; client?: { id: string; name: string } }[]; projects: { id: string; name: string; groupId?: string }[] } | null>(null);
  useEffect(() => { if (open) runTool('group.suggest').then((r) => { if (r.status === 'ok') setData(r.output as never); }).catch(() => {}); }, [open]);
  const own = new Set(client.members.map((m) => m.key));
  const options = data ? [
    ...data.groups.filter((g) => !own.has(g.id)).map((g) => ({ key: g.id, name: g.name, logos: [...new Set(g.members.map((m) => m.logo))], from: g.client?.id !== client.id ? g.client?.name : undefined, kind: 'Product' })),
    ...data.projects.filter((p) => !p.groupId && !own.has(p.id)).map((p) => ({ key: p.id, name: p.name, logos: ['unit7'], from: undefined as string | undefined, kind: 'Unit7 project' })),
  ] : [];
  return (
    <Modal open={open} onClose={onClose} title={`Add to ${client.name}`} size="sm">
      {!data ? <Skeleton className="h-24 rounded-[16px]" /> : !options.length ? (
        <p className="text-[13px] text-muted">Everything is already {client.name}’s, or there’s nothing to give yet. Things on the Map have “Move to client…” in their menu.</p>
      ) : (
        <ul className="-mx-2 space-y-0.5">{options.map((o) => (
          <li key={o.key}>
            <button type="button" className="flex w-full items-center gap-3 rounded-[16px] px-3 py-2.5 text-left transition hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
              onClick={async () => { if (await act('client.assign', { clientId: client.id, key: o.key }, { success: `${o.name} is ${client.name}’s now` })) { void reloadClients(); onClose(); } }}>
              <Logos ids={o.logos} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{o.name}</span><span className="block text-[12px] text-muted">{o.kind}{o.from ? ` · now ${o.from}’s` : ''}</span></span>
              <Plus size={15} className="text-muted" aria-hidden />
            </button>
          </li>
        ))}</ul>
      )}
    </Modal>
  );
}

// "Move to client…" for any project, product or thing: a menu item to add to a "…" menu, and the pop-up it opens.
// Use: const [move, setMove] = useState(false); items={[moveToClientItem(() => setMove(true))]}; <MoveToClientDialog item={…} open={move} onClose={…} />
export const moveToClientItem = (onSelect: () => void): MenuItem => ({ label: 'Move to client…', icon: <Briefcase size={16} />, hint: 'Whose it is, for filters and costs', onSelect });
export function MoveToClientDialog({ item, open, onClose, onMoved }: { item: { key: string; name: string }; open: boolean; onClose: () => void; onMoved?: () => void }) {
  const list = useClients();
  const [adding, setAdding] = useState(false);
  const current = list?.clients.find((c) => c.ids.includes(item.key));
  const move = async (clientId: string | null, name: string) => {
    if (await act('client.assign', { clientId, key: item.key }, { success: clientId ? `${item.name} is ${name}’s now` : `${item.name} is your own again` })) { void reloadClients(); onMoved?.(); onClose(); }
  };
  return (
    <>
      <Modal open={open && !adding} onClose={onClose} title={`Whose is ${item.name}?`} size="sm">
        <p className="mb-3 text-[13px] text-muted">A thing belongs to one client at most. Something in a product moves with its whole product.</p>
        <ul className="-mx-2 space-y-0.5">
          {(list?.clients ?? []).map((c) => (
            <li key={c.id}><button type="button" onClick={() => move(c.id, c.name)} aria-current={current?.id === c.id || undefined}
              className="flex w-full items-center gap-3 rounded-[16px] px-3 py-2.5 text-left transition hover:bg-raised focus-visible:bg-raised focus-visible:outline-none">
              <ClientAvatar c={c} size={32} /><span className="min-w-0 flex-1 truncate text-[14px] font-medium">{c.name}</span>{current?.id === c.id && <Check size={16} className="text-blue-text" aria-label="Now" />}
            </button></li>
          ))}
          <li><button type="button" onClick={() => move(null, '')} className="flex w-full items-center gap-3 rounded-[16px] px-3 py-2.5 text-left transition hover:bg-raised focus-visible:bg-raised focus-visible:outline-none">
            <span className="grid size-8 place-items-center rounded-[30%] bg-raised text-muted"><Users size={15} aria-hidden /></span><span className="flex-1 text-[14px] font-medium">Your own</span>{!current && <Check size={16} className="text-blue-text" aria-label="Now" />}
          </button></li>
          <li><button type="button" onClick={() => setAdding(true)} className="flex w-full items-center gap-3 rounded-[16px] px-3 py-2.5 text-left text-muted transition hover:bg-raised hover:text-ink focus-visible:bg-raised focus-visible:outline-none">
            <span className="grid size-8 place-items-center rounded-[30%] border border-dashed border-line-strong"><Plus size={15} aria-hidden /></span><span className="text-[14px] font-medium">New client…</span>
          </button></li>
        </ul>
      </Modal>
      <ClientForm open={adding} onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); void move(id, 'the new client'); }} />
    </>
  );
}

// --- the switcher: All clients, one client, or your own. Mount it in a page's header; filter lists with has(id) ---------
// align: which edge the menu opens from (right when it sits at the right of a header). Inside a header that animates in,
// put the header in a `relative z-20` box so the menu opens over the cards below it.
export function ClientFilter({ className, align = 'right' }: { className?: string; align?: 'left' | 'right' }) {
  const f = useClientFilter();
  const items: MenuItem[] = useMemo(() => [
    { label: 'All clients', icon: f.picked === null ? <Check size={16} /> : <span className="size-4" />, onSelect: () => f.pick(null) },
    ...f.clients.map((c) => ({ label: c.name, icon: f.picked === c.id ? <Check size={16} /> : <span aria-hidden className="mt-0.5 block size-3.5 rounded-full" style={{ background: c.color }} />, onSelect: () => f.pick(c.id) })),
    { label: 'Your own', hint: 'What no client has', icon: f.picked === 'mine' ? <Check size={16} /> : <Users size={16} />, onSelect: () => f.pick('mine') },
    { section: 'Clients' },
    { label: 'See all clients', icon: <Briefcase size={16} />, href: '/clients' },
  ], [f.picked, f.clients]);
  if (!f.clients.length) return null; // nothing to filter by yet
  const label = f.client?.name ?? (f.picked === 'mine' ? 'Your own' : 'All clients');
  return (
    <Menu label={`Showing: ${label}. Change client`} items={items} align={align}
      className={cx('inline-flex h-10 items-center gap-2 rounded-full border px-3.5 text-[13.5px] font-medium transition hover:bg-raised', f.active ? 'border-ink bg-surface text-ink' : 'border-line-strong bg-surface text-ink-2', className)}>
      {f.client ? <ClientAvatar c={f.client} size={20} /> : <Briefcase size={15} aria-hidden />}
      <span className="max-w-[160px] truncate">{label}</span>
      <ChevronDown size={14} aria-hidden className="text-muted" />
    </Menu>
  );
}
