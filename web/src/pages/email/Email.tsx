// A domain's email on one page: can it send, what forwards where, add a forward, check it. /email picks a domain, /email/:domain
// shows it. Everything here reads email.check; each change is the same tool an AI uses, run as the person.
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Globe, Inbox, Mail, Plus, RefreshCw, Send } from 'lucide-react';
import { runTool } from '../../lib/api';
import { navigate } from '../../lib/router';
import { noFlag, pressAgain, tidy } from '../../lib/words';
import { BrandLogo } from '../../brand/BrandLogo';
import { A, Badge, Button, Card, CopyButton, ErrorLine, Field, Input, Mono, PageHeader, Skeleton, StatusMark, act, confirmDialog, cx, nextAction, toast, type MarkState } from '../../ui';
import { useTool } from '../care/data';
import { isFree } from '../chat/cards/shape';
import { derive, type MapData } from '../map/data';
import { moveDns } from '../map/parts';

interface Fix { tool: string; input: Record<string, unknown>; label: string; note?: string }
interface Part { state: string; note?: string; advice?: string; watching?: string; fix?: Fix }
interface Forward { from: string; to: string; working: boolean; why?: string }
interface Check {
  domain: string; verdict: string; receives: { mx: string[]; by?: string }; spf: Part; dkim: Part; dmarc: Part;
  sender: { from: string; via: string; host: string } | null;
  forwarding: { state: 'on' | 'waiting' | 'off' | 'elsewhere' | 'no_account' | 'cant_read'; why?: string; fix?: Fix; forwards?: Forward[] };
}
// what a run came back with that a person still has to read
interface Said { note?: string; why?: string; next?: string; addThese?: { type: string; name: string; value: string; priority?: number }[]; link?: { href: string; label: string } }

const PART: Record<string, { mark: MarkState; word: string }> = {
  ok: { mark: 'ok', word: 'Right' }, not_needed: { mark: 'ok', word: 'Not needed' }, watching: { mark: 'warn', word: 'Only watching' }, waiting: { mark: 'work', word: 'Still spreading' },
  incomplete: { mark: 'warn', word: 'Incomplete' }, missing: { mark: 'bad', word: 'Missing' }, broken: { mark: 'bad', word: 'Broken' },
};
const failed = (r: Awaited<ReturnType<typeof runTool>>) => (r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? `Waiting for approval: ${r.why}` : 'That didn’t work.');
const WRAP = '[overflow-wrap:anywhere]';

function Panel({ icon, title, sub, badge, children }: { icon: ReactNode; title: string; sub?: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card className="min-w-0 p-5 md:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-raised text-ink">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
          {sub && <p className="mt-0.5 break-words text-[13px] text-muted">{sub}</p>}
        </div>
        {badge}
      </div>
      {children}
    </Card>
  );
}

function SaidBox({ said }: { said: Said }) {
  return (
    <div role="status" className="mt-3 space-y-2 rounded-[16px] bg-raised/70 px-4 py-3 text-[13px] text-ink-2">
      {said.why && <p className={WRAP}>{tidy(said.why)}</p>}
      {!!said.addThese?.length && (
        <ul className="space-y-1.5">
          {said.addThese.map((r) => {
            const line = `${r.priority !== undefined ? `${r.priority} ` : ''}${r.value}`;
            return <li key={`${r.type}${r.name}${r.value}`} className="flex min-w-0 items-start gap-2 rounded-[12px] bg-surface px-3 py-2"><span className="min-w-0 flex-1 break-all"><span className="font-medium text-ink">{r.type} {r.name}</span><br /><Mono>{line}</Mono></span><CopyButton text={line} /></li>;
          })}
        </ul>
      )}
      {[said.note, said.next].filter(Boolean).map((t) => <p key={t} className={WRAP}>{tidy(t!)}</p>)}
      {said.link && <A href={said.link.href} className="inline-flex items-center gap-1 font-medium text-blue-text hover:underline">{said.link.label}<ArrowUpRight size={13} /></A>}
    </div>
  );
}

// --- sending -----------------------------------------------------------------------------------------------------------
function Row({ name, part, human, done }: { name: string; part: Part; human: boolean; done: () => void }) {
  const look = PART[part.state] ?? { mark: 'off' as const, word: part.state };
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  // where Unit7 can't write the DNS, it hands back the records: that isn't done yet
  const fix = async () => {
    setBusy(true); setSaid(null);
    const r = await act(part.fix!.tool, part.fix!.input);
    setBusy(false);
    if (!r) return;
    const o = r.output as Said;
    if (o.addThese?.length) { setSaid(o); return; }
    toast('ok', `${name} is in`, undefined, { action: nextAction(r.output) });
    done();
  };
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-3">
      <StatusMark state={look.mark} size={20} label={look.word} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 basis-[200px]">
        <p className="text-[13.5px] font-medium text-ink">{name} <span className="font-normal text-muted">· {look.word}</span></p>
        {[part.note, part.fix && part.advice, part.watching].filter(Boolean).map((t) => <p key={t} className={cx(WRAP, 'text-[12.5px] text-muted')}>{t}</p>)}
      </div>
      {human && part.fix && <Button size="sm" variant="soft" loading={busy} onClick={() => void fix()}>{part.fix.label}</Button>}
      {said && <div className="w-full"><SaidBox said={said} /></div>}
    </li>
  );
}

function Sending({ c, human, reload }: { c: Check; human: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const setup = async (replaceMail = false): Promise<void> => {
    setBusy(true); setSaid(null);
    const r = await runTool('email.setup', { domain: c.domain, wait: false, ...(replaceMail && { replaceMail }) }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setBusy(false);
    if (r.status === 'error' && r.error.code === 'confirm_email') {
      if (await confirmDialog({ title: 'Change a mail record?', body: noFlag(r.error.message), confirm: 'Yes, change it', danger: true })) return setup(true);
      return;
    }
    if (r.status !== 'ok') { setSaid({ why: failed(r) }); return; }
    const o = r.output as Said & { connected?: boolean; ready?: boolean; connect?: { how: string }; waiting?: string[] };
    if (o.connected === false) setSaid({ why: o.why, note: pressAgain(o.connect?.how, 'Set up sending'), link: { href: '/connections?connect=resend', label: 'Connect Resend' } });
    else if (o.ready) { toast('ok', `${c.domain} can send email`); setSaid(null); }
    else setSaid({ ...o, note: pressAgain(o.note, 'Set up sending'), next: pressAgain(o.next, 'Set up sending') });
    reload();
  };
  return (
    <Panel icon={<Send size={18} />} title="Sending" sub={c.sender ? <>Mail goes out as <span className={cx(WRAP, 'font-medium text-ink-2')}>{c.sender.from}</span>, through {c.sender.via}.</> : 'Nothing can send from this domain through Unit7 yet.'}
      badge={<Badge tone={c.sender ? 'ok' : 'neutral'}>{c.sender ? 'Set up' : 'Not set up'}</Badge>}>
      {human && !c.sender && <Button variant="primary" icon={<Send size={15} />} loading={busy} onClick={() => void setup()}>Set up sending</Button>}
      {said && <SaidBox said={said} />}
      <ul className={cx('divide-y divide-line', !c.sender && human && 'mt-3')}>
        <Row name="SPF" part={c.spf} human={human} done={reload} />
        <Row name="DKIM" part={c.dkim} human={human} done={reload} />
        <Row name="DMARC" part={c.dmarc} human={human} done={reload} />
      </ul>
    </Panel>
  );
}

// --- forwarding --------------------------------------------------------------------------------------------------------
function Blocked({ f, human, reload }: { f: Check['forwarding']; human: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  if (f.state === 'elsewhere') return (
    <div className="space-y-3">
      <p className="break-words text-[13.5px] text-ink-2">{f.why}</p>
      {human && f.fix && <Button variant="primary" icon={<BrandLogo id="cloudflare" size={15} />} loading={busy} onClick={() => { setBusy(true); void moveDns(String(f.fix!.input.domain)).finally(() => { setBusy(false); reload(); }); }}>{f.fix.label}</Button>}
      {f.fix?.note && <p className="text-[12.5px] text-muted">{f.fix.note}</p>}
    </div>
  );
  return (
    <div className="space-y-2">
      <ErrorLine text={pressAgain(f.why ?? 'Unit7 couldn’t read this domain’s forwards.', 'Check it')} title="Forwarding" />
      <A href={f.state === 'no_account' ? '/connections?connect=cloudflare' : '/connections#dns'} className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-text hover:underline">Open Connections<ArrowUpRight size={13} /></A>
    </div>
  );
}

function AddForward({ domain, reload }: { domain: string; reload: () => void }) {
  const [name, setName] = useState('hello');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const local = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/i.test(name.trim());
  const inbox = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());
  const add = async (replaceMail = false): Promise<void> => {
    setBusy(true); setSaid(null);
    const r = await runTool('email.forward', { from: `${name.trim().toLowerCase()}@${domain}`, to: to.trim(), ...(replaceMail && { replaceMail }) }).catch((e: Error) => ({ status: 'error' as const, error: { code: 'network', message: e.message } }));
    setBusy(false);
    if (r.status === 'error' && r.error.code === 'confirm_email') {
      if (await confirmDialog({ title: 'Move this mail?', body: noFlag(r.error.message), confirm: 'Yes, move it', danger: true })) return add(true);
      return;
    }
    if (r.status !== 'ok') { setSaid({ why: failed(r) }); reload(); return; } // a run can stop part way, with its rule already there
    const o = r.output as Said & { forwarded?: boolean };
    if (o.forwarded) { toast('ok', 'The forward is on', o.note); setName('hello'); setTo(''); } else setSaid({ ...o, note: pressAgain(o.note, 'Add the forward') });
    reload();
  };
  const go = (e: FormEvent) => { e.preventDefault(); if (local && inbox && !busy) void add(); };
  return (
    <form onSubmit={go} className="mt-4 space-y-3 border-t border-line pt-4">
      <p className="text-[13.5px] font-medium text-ink">Add a forward</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Address">
          <div className="flex min-w-0 items-center gap-2"><Input value={name} onChange={(e) => setName(e.target.value)} aria-label={`The part before @${domain}`} autoComplete="off" spellCheck={false} className="min-w-0 flex-1" /><span className="min-w-0 max-w-[60%] shrink truncate text-[13px] text-muted" title={`@${domain}`}>@{domain}</span></div>
        </Field>
        <Field label="Goes to"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@gmail.com" autoComplete="email" spellCheck={false} /></Field>
      </div>
      <Button type="submit" variant="secondary" icon={<Plus size={15} />} loading={busy} disabled={!local || !inbox}>Add the forward</Button>
      {said && <SaidBox said={said} />}
    </form>
  );
}

function Forwarding({ c, human, reload }: { c: Check; human: boolean; reload: () => void }) {
  const f = c.forwarding, list = f.forwards ?? [], open = ['on', 'waiting', 'off'].includes(f.state);
  const badge = f.state === 'on' ? <Badge tone="ok">On</Badge> : f.state === 'waiting' ? <Badge tone="warn">Waiting</Badge> : f.state === 'off' ? <Badge>Not set up</Badge> : f.state === 'elsewhere' ? <Badge tone="warn">Needs Cloudflare</Badge> : <Badge tone="warn">Can’t tell</Badge>;
  return (
    <Panel icon={<Inbox size={18} />} title="Forwarding" badge={badge} sub={open ? 'hello@ goes to the inbox you already read, through Cloudflare, free. It isn’t a mailbox of its own.' : undefined}>
      {!open && <Blocked f={f} human={human} reload={reload} />}
      {open && (list.length ? (
        <ul className="divide-y divide-line">{list.map((x) => (
          <li key={x.from} className="flex items-start gap-3 py-3">
            <StatusMark state={x.working ? 'ok' : 'work'} size={20} label={x.working ? 'Working' : 'Waiting'} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-1.5 text-[13.5px] font-medium text-ink"><span className={WRAP}>{x.from}</span><ArrowRight size={13} aria-hidden className="shrink-0 text-faint" /><span className={cx(WRAP, 'font-normal text-ink-2')}>{x.to}</span></p>
              {x.why && <p className={cx(WRAP, 'text-[12.5px] text-muted')}>{x.why}</p>}
            </div>
          </li>
        ))}</ul>
      ) : <p className="text-[13.5px] text-muted">Nothing forwards on this domain yet.</p>)}
      {open && human && <AddForward domain={c.domain} reload={reload} />}
    </Panel>
  );
}

// --- one domain ----------------------------------------------------------------------------------------------------------
function OneDomain({ domain, human }: { domain: string; human: boolean }) {
  const { data, error, reload } = useTool<Check>('email.check', { domain });
  const [checking, setChecking] = useState(false);
  const [at, setAt] = useState<string>();
  const check = async () => { setChecking(true); await reload(); setAt(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })); setChecking(false); };
  return (
    <div className="w-full max-w-[880px] space-y-5 pb-16">
      <A href="/email" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition hover:text-ink"><ArrowLeft size={14} />All domains</A>
      <PageHeader title={<span className={WRAP}>{domain}</span>} subtitle={data?.verdict ?? 'Reading its DNS and your connected accounts…'}
        actions={<Button variant="secondary" icon={<RefreshCw size={15} />} loading={checking} onClick={() => void check()}>Check it</Button>} />
      {at && <p className="-mt-5 text-[12.5px] text-muted" role="status">Checked at {at}.</p>}
      {!data && !error && <div className="space-y-5"><Skeleton className="h-64 rounded-[24px]" /><Skeleton className="h-48 rounded-[24px]" /></div>}
      {!data && error && <Card className="p-5"><ErrorLine text={error} title="Email" /><Button className="mt-3" variant="secondary" onClick={() => void reload()}>Try again</Button></Card>}
      {data && <><Sending c={data} human={human} reload={() => void reload()} /><Forwarding c={data} human={human} reload={() => void reload()} /></>}
      {data?.forwarding.state === 'on' && <p className="px-1 text-[12.5px] text-muted">To test a forward, send from another address: mail you send yourself can look lost, because some inboxes hide their own.</p>}
    </div>
  );
}

// --- which domain --------------------------------------------------------------------------------------------------------
function Pick() {
  const { data, error } = useTool<MapData>('map.get', {});
  const groups = useMemo(() => (data ? derive(data).groups.filter((g) => !isFree(g.root)) : []), [data]);
  const [typed, setTyped] = useState('');
  const name = typed.trim().toLowerCase();
  const ok = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name);
  return (
    <div className="w-full max-w-[880px] space-y-5 pb-16">
      <PageHeader title="Email" subtitle="Can a domain send email, and where does its hello@ go? Pick one to check it or add a forward." />
      <Card className="p-2">
        {!data && !error && <Skeleton className="m-2 h-24 rounded-[18px]" />}
        {error && <div className="p-3"><ErrorLine text={error} title="Domains" /></div>}
        {data && !groups.length && <p className="px-3 py-6 text-center text-[13.5px] text-muted">No domains yet. Connect the account that holds them in Connections, or type one below.</p>}
        {groups.length > 0 && (
          <ul>{groups.map((g) => (
            <li key={g.root}>
              <A href={`/email/${g.root}`} className="flex min-h-12 items-center gap-3 rounded-[16px] px-3 py-2 transition hover:bg-raised">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-raised">{g.dns ? <BrandLogo id={g.dns} size={17} /> : <Globe size={16} className="text-muted" />}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{g.root}</span>
                <ArrowRight size={15} aria-hidden className="shrink-0 text-faint" />
              </A>
            </li>
          ))}</ul>
        )}
      </Card>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (ok) navigate(`/email/${name}`); }}>
        <div className="min-w-0 flex-1 basis-[220px]"><Field label="Another domain, or a subdomain"><Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="mail.example.com" autoComplete="off" spellCheck={false} /></Field></div>
        <Button type="submit" variant="secondary" icon={<Mail size={15} />} disabled={!ok}>Open</Button>
      </form>
    </div>
  );
}

export const EmailPage = ({ domain, human = true }: { domain?: string; human?: boolean }) => (domain ? <OneDomain key={domain} domain={domain.toLowerCase()} human={human} /> : <Pick />);
