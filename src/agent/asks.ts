// Interactive asks in the Home chat. Instead of typing a question, the AI shows the person a picker (ui.choose), a
// preview to confirm (ui.confirm) or a small form (ui.form), and its run waits for the answer. The ask is a role 'ask'
// message in the conversation (the message id is the ask id), so the thread, history and reloads need nothing new.
//
// An ask belongs to one run answering one conversation: the built-in brain passes its conversation to the tools;
// a subscription run's token maps to its conversation. Anyone else calling ui.* (Claude Code in a terminal, CI, a
// person through /api/tools) is told it only works in the ask box. Only the conversation's own person can answer,
// from the web app. A pick from live data (domains, apps…) is checked against that data here, never taken from the
// AI or the browser; a secret typed into a form goes to the vault and the AI gets its credential:// reference.
import { z } from 'zod';
import type { App } from '../app.ts';
import type { Principal } from '../auth.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error, notFound } from '../errors.ts';
import { makeRef } from '../vault.ts';
import type { Ctx } from '../tools/runtime.ts';
import type { AgentMessage } from './brain.ts';
import { NEXT_RULE } from './next.ts';
import { snoozeKeyOf, snoozeState, type SnoozeFor } from '../snooze.ts';
import { dropOf } from '../live/upload.ts';

export const ASK_MS = 10 * 60_000;
export const askWindow = { ms: ASK_MS }; // how long an ask stays open (tests shorten it)
export const ONLY_HERE = 'This only works in Unit7’s ask box (the chat in Unit7’s web app). Ask the person in your own words instead.';

// one clock for a run's thread: a CLI prints several lines in the same millisecond and the thread is read back in
// created_at order, so each message gets a later stamp than the one before
let lastAt = 0;
export const stamp = () => new Date(lastAt = Math.max(Date.now(), lastAt + 1)).toISOString();

export type Source = 'domains' | 'apps' | 'servers' | 'projects' | 'databases' | 'accounts';
export const SOURCES = ['domains', 'apps', 'servers', 'projects', 'databases', 'accounts'] as const;
type Option = { id: string; label: string; detail?: string; logo?: string; recommended?: boolean; why?: string }; // recommended/why: the AI's pick, shown as the strong button
export type AskSpec =
  | { kind: 'choose'; title: string; note?: string; source?: Source; filter?: Record<string, string>; options?: Option[]; multiple?: boolean; allowNew?: { label: string; hint?: string }; preselect?: string }
  | { kind: 'confirm'; title: string; note?: string; changes: { label: string; before?: string; after: string }[]; undo?: string; danger?: boolean; confirmLabel?: string }
  | { kind: 'form'; title: string; note?: string; fields: { id: string; label: string; type: 'text' | 'secret' | 'select' | 'number'; placeholder?: string; options?: string[]; required?: boolean; initial?: string }[]; submitLabel?: string }
  // ui.folder: the person drops a ZIP or picks a folder; the AI hears what it is, never a path
  | { kind: 'folder'; title: string; note?: string }
  // ui.hide: what (Unit7's words for it, from its records), how serious, and the choice picked at first
  | { kind: 'hide'; title: string; note?: string; key: string; what: string; severity?: string; itemKind: string; for: SnoozeFor }
  // ui.delete: the guided delete card (from Unit7's records): live = production runs, so the delete stops it first;
  // recommend = the choice Unit7 recommends (archive when it looks used). The person's click does it, as them.
  | { kind: 'delete'; title: string; note?: string; key: string; name: string; itemKind: string; provider: string; live: boolean; can: boolean; recommend: 'archive' | 'delete'; stops: number };
type Answer = Record<string, unknown>;
type State = 'answered' | 'expired' | 'cancelled';

// --- which run answers which conversation ---------------------------------------------------------
type Emit = (m: AgentMessage) => void;
interface Run { orgId: string; userId: string; emit: Emit; hold?: (waiting: boolean) => void }
const runs = new Map<string, Run>();        // conversationId → the run answering it
const tokens = new Map<string, string>();   // a subscription run's token id → its conversation
interface Waiter { conversationId: string; msg: AgentMessage; emit: Emit; done: (r: Answer) => void }
const waiters = new Map<string, Waiter>(); // askId → the run waiting on it

// A run answering a conversation. Stop (the signal) and the run's end close whatever it still asks.
export function bindRun(conversationId: string, r: Run & { signal: AbortSignal; tokenId?: string }) {
  runs.set(conversationId, r);
  if (r.tokenId) tokens.set(r.tokenId, conversationId);
  const stop = () => closeAll(conversationId);
  r.signal.addEventListener('abort', stop, { once: true });
  return () => {
    r.signal.removeEventListener('abort', stop);
    closeAll(conversationId);
    if (runs.get(conversationId) === r) runs.delete(conversationId);
    if (r.tokenId) tokens.delete(r.tokenId);
  };
}
export const conversationOfToken = (tokenId?: string) => (tokenId ? tokens.get(tokenId) : undefined);
// The thread a tool runs for, to show its own steps there (coolify.build runs several); undefined outside the ask box.
export function threadFor(ctx: Pick<Ctx, 'conversationId' | 'orgId' | 'actor'>): Emit | undefined {
  const r = ctx.conversationId ? runs.get(ctx.conversationId) : undefined;
  return r && r.orgId === ctx.orgId && r.userId === ctx.actor.userId ? r.emit : undefined;
}
const closeAll = (conversationId: string) => { for (const [askId, w] of waiters) if (w.conversationId === conversationId) close(askId, 'cancelled'); };
const waiting = (conversationId: string) => [...waiters.values()].some((w) => w.conversationId === conversationId);

function close(askId: string, state: State, answer?: Answer) {
  const w = waiters.get(askId);
  if (!w) return;
  waiters.delete(askId);
  w.emit({ ...w.msg, content: { ...w.msg.content, state, ...(answer && { answer }) } });
  w.done(state === 'answered' ? answer! : state === 'expired'
    ? { expired: true, note: 'The person didn’t answer in 10 minutes. Stop here and say in one line that you’ll carry on when they reply.' }
    : { cancelled: true, note: 'The person stopped this. Don’t ask again.' });
}

// The ui.* tools: show the ask, wait for the person (or expiry, or stop), give the AI the answer.
export async function ask(ctx: Ctx, spec: AskSpec): Promise<Answer> {
  const conversationId = ctx.conversationId;
  const r = conversationId ? runs.get(conversationId) : undefined;
  if (!r || r.orgId !== ctx.orgId || r.userId !== ctx.actor.userId) throw new Unit7Error('not_here', ONLY_HERE, 400);
  if (spec.kind === 'choose' && spec.source && !sourceOptions(ctx.app, ctx.orgId, spec.source, spec.filter).length && !spec.allowNew) {
    return { empty: true, note: `There are no ${spec.source} to pick from. Say so in one line, or ask again with allowNew.` };
  }
  const askId = id('ask');
  const msg: AgentMessage = { id: askId, role: 'ask', content: { askId, spec, state: 'waiting', expiresAt: new Date(Date.now() + askWindow.ms).toISOString() }, created_at: stamp() };
  r.emit(msg);
  r.hold?.(true);
  return new Promise<Answer>((resolve) => {
    const timer = setTimeout(() => close(askId, 'expired'), askWindow.ms);
    const stop = () => close(askId, 'cancelled');
    ctx.signal.addEventListener('abort', stop, { once: true });
    waiters.set(askId, { conversationId: conversationId!, msg, emit: r.emit, done: (a) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', stop);
      r.hold?.(waiting(conversationId!));
      resolve(a);
    } });
  });
}

// The ask message, if it's this person's (in their own conversation).
function askRow(app: App, p: Principal, askId: string) {
  const row = get<{ content: string; conversation_id: string; created_at: string }>(app.db, `SELECT m.content, m.conversation_id, m.created_at FROM messages m
    JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND m.role = 'ask' AND c.org_id = ? AND c.user_id = ?`, askId, p.org.id, p.user.id);
  if (!row) throw notFound('That question');
  return { ...row, ask: JSON.parse(row.content) as { askId: string; spec: AskSpec; state: string } };
}

// --- the person answers -----------------------------------------------------------------------------
const pick = z.union([z.object({ choice: z.array(z.string().min(1).max(300)).min(1).max(50) }), z.object({ new: z.literal(true) }), z.object({ cancelled: z.literal(true) })]);
const yes = z.union([z.object({ ok: z.boolean() }), z.object({ cancelled: z.literal(true) })]);
const filled = z.union([z.object({ values: z.record(z.string(), z.string().max(4000)) }), z.object({ cancelled: z.literal(true) })]);
const parse = <T extends z.ZodType>(schema: T, body: unknown): z.infer<T> => {
  const r = schema.safeParse(body);
  if (!r.success) throw new Unit7Error('invalid_input', 'That answer doesn’t fit this question.');
  return r.data;
};

export function answerAsk(app: App, p: Principal, askId: string, body: unknown) {
  const { ask: a, conversation_id, created_at } = askRow(app, p, askId);
  const w = waiters.get(askId);
  if (!w) {
    // still shown as open, but no run waits on it (Unit7 restarted, or the run ended): close it so the card stops asking
    if (a.state === 'waiting') {
      const message = { id: askId, role: 'ask', content: { ...a, state: 'expired' }, created_at };
      run(app.db, 'UPDATE messages SET content = ? WHERE id = ?', JSON.stringify(message.content), askId);
      app.events.emit(p.org.id, 'agent.message', '', { live: true, data: { conversationId: conversation_id, message } });
    }
    throw new Unit7Error('ask_closed', 'This question isn’t open anymore. Ask again in the box.', 409);
  }
  const spec = a.spec;
  let answer: Answer;
  if (spec.kind === 'choose') {
    const b = parse(pick, body);
    if ('cancelled' in b) answer = { cancelled: true };
    else if ('new' in b) {
      if (!spec.allowNew) throw new Unit7Error('invalid_input', 'This question has no “add new” option.');
      answer = { new: true };
    } else {
      const ids = [...new Set(b.choice)];
      if (!spec.multiple && ids.length > 1) throw new Unit7Error('invalid_input', 'Pick one.');
      // live data is looked up again here: what the AI offered or the browser sent doesn't count
      const opts: (Option & { use?: Record<string, unknown>; full?: string })[] = spec.source ? sourceOptions(app, p.org.id, spec.source, spec.filter) : spec.options ?? [];
      const picked = ids.map((x) => opts.find((o) => o.id === x));
      if (picked.some((o) => !o)) throw new Unit7Error('invalid_input', 'That choice isn’t one of the options anymore. Pick again.');
      const label = (o: Option & { full?: string }) => o.full ?? o.label;
      answer = { choice: ids, labels: picked.map((o) => label(o!)), ...(spec.source && { items: picked.map((o) => ({ id: o!.id, label: label(o!), ...o!.use })) }) };
    }
  } else if (spec.kind === 'confirm') {
    const b = parse(yes, body);
    answer = { ok: 'ok' in b ? b.ok : false };
  } else if (spec.kind === 'folder') {
    // only an upload Unit7 unpacked itself, for this org: the browser names it, Unit7 says what it is
    const b = parse(z.union([z.object({ uploadId: z.string().regex(/^upl_[\w-]{10,24}$/) }), z.object({ cancelled: z.literal(true) })]), body);
    if ('cancelled' in b) answer = { cancelled: true };
    else {
      const drop = dropOf(b.uploadId, p.org.id);
      if (!drop) throw new Unit7Error('invalid_input', 'That upload isn’t there anymore. Drop it again.');
      answer = drop;
    }
  } else if (spec.kind === 'hide') {
    // the person hid it themselves (their own snooze.set, from the card); what the AI hears comes from the store
    const b = parse(z.union([z.object({ done: z.literal(true) }), z.object({ cancelled: z.literal(true) })]), body);
    if ('cancelled' in b) answer = { hidden: false, note: 'They kept it showing. Don’t ask again.' };
    else {
      const r = snoozeState(app.db, p.org.id).hidden.get(snoozeKeyOf(spec.key));
      if (!r) throw new Unit7Error('invalid_input', 'It isn’t hidden yet. Press Hide it again.');
      answer = { hidden: true, until: r.until, forGood: r.until === null };
    }
  } else if (spec.kind === 'delete') {
    // what the person did from the card, checked against the store: an AI never deletes, archives or stops it here
    const b = parse(z.union([z.object({ outcome: z.enum(['deleted', 'archived', 'stopped']) }), z.object({ cancelled: z.literal(true) })]), body);
    if ('cancelled' in b) answer = { cancelled: true, note: 'They chose not now. Nothing changed; don’t ask again.' };
    else {
      const org = p.org.id, k = spec.key;
      const gone = k.startsWith('prj_') ? !get(app.db, 'SELECT 1 FROM projects WHERE id = ? AND org_id = ?', k, org) : !get(app.db, 'SELECT 1 FROM assets WHERE id = ? AND org_id = ?', k, org);
      const archived = !!get(app.db, 'SELECT 1 FROM archived WHERE org_id = ? AND key = ?', org, k);
      if (b.outcome === 'deleted' && !gone) throw new Unit7Error('invalid_input', `${spec.name} isn’t deleted yet. Finish the steps in the pop-up.`);
      if (b.outcome === 'archived' && !archived) throw new Unit7Error('invalid_input', `${spec.name} isn’t archived yet.`);
      answer = { outcome: b.outcome, note: b.outcome === 'deleted' ? `${spec.name} is deleted. Say so in one line.` : b.outcome === 'archived' ? `${spec.name} is archived: it keeps running, Unit7 stops watching it.` : `${spec.name} is stopped. Nothing was deleted.` };
    }
  } else {
    const b = parse(filled, body);
    if ('cancelled' in b) answer = { cancelled: true };
    else {
      const values: Record<string, string> = {};
      for (const f of spec.fields) {
        const v = f.type === 'secret' ? b.values[f.id] ?? '' : (b.values[f.id] ?? '').trim();
        if (!v) { if (f.required) throw new Unit7Error('invalid_input', `${f.label} is needed.`); continue; }
        if (f.type === 'number' && !Number.isFinite(Number(v))) throw new Unit7Error('invalid_input', `${f.label} must be a number.`);
        if (f.type === 'select' && !(f.options ?? []).includes(v)) throw new Unit7Error('invalid_input', `Pick one of the choices for ${f.label}.`);
        if (f.type === 'secret') {
          // the value goes to the vault; the AI (and the stored thread) only ever see where it is
          const ref = makeRef('chat', askId.slice(4), f.id);
          app.vault.put(p.org.id, ref, v, { kind: 'secret', by: p.user.id, meta: { from: 'chat', label: f.label } });
          values[f.id] = ref;
        } else values[f.id] = v;
      }
      answer = { values };
    }
  }
  close(askId, 'answered', answer);
  return { ok: true, answer };
}

// What a choose with a source shows (the web) and accepts (answerAsk), for this person's org.
export function optionsFor(app: App, p: Principal, askId: string) {
  const { ask: a } = askRow(app, p, askId);
  if (a.spec.kind !== 'choose' || !a.spec.source) return { options: [] };
  return { options: sourceOptions(app, p.org.id, a.spec.source, a.spec.filter) };
}

// --- live data for pickers ----------------------------------------------------------------------------
// Everything an option card shows, plus `use`: what the AI gets back for its next tool call (ids, hostnames, the
// domain.point target). `full` is the label the AI and the thread read when a name alone is ambiguous ("web" in
// three projects); the web composes the rest of a card with its plain-words helpers.
export interface SourceOption {
  id: string; label: string; full?: string; logo?: string; provider?: string; sub?: string; url?: string; count?: number;
  state?: { tone: 'ok' | 'warn' | 'bad' | 'idle'; text: string }; use: Record<string, unknown>;
}
const DB_KINDS = new Set(['postgres', 'mysql', 'mariadb', 'redis', 'mongo']);
const POINTABLE = new Set(['unit7', 'vercel', 'netlify', 'render', 'railway', 'heroku', 'fly', 'supabase']);
// a Coolify application from a server's X-ray ("<server>/coolify:<uuid>"), or a Hostinger website: their domain.point target
const coolifyPart = /^(srv_[\w-]+)\/coolify:([\w-]{3,64})$/;
const pointFound = (a: { provider: string; ext_id: string; name: string; account_id: string | null; m: Found }) => {
  const c = a.provider === 'coolify' ? coolifyPart.exec(a.ext_id) : undefined;
  if (c) return { coolify: { serverId: c[1], uuid: c[2] } };
  return a.provider === 'hostinger' && a.m.platform === 'hostinger-web' && a.account_id ? { hostinger: { accountId: a.account_id, website: a.name } } : undefined;
};
const INSTANT = /\.(sslip|nip)\.io$/; // Unit7's own stand-in addresses, not a domain anyone connects
const svcState = (s: string): SourceOption['state'] => /healthy|running|active/.test(s) ? { tone: 'ok', text: 'Running' }
  : /deploy|build|start/.test(s) ? { tone: 'warn', text: 'Deploying' } : /fail|crash|error|unhealthy/.test(s) ? { tone: 'bad', text: 'Not working' }
  : /stop/.test(s) ? { tone: 'idle', text: 'Stopped' } : { tone: 'idle', text: 'Not deployed yet' };
const assetState = (s?: string): SourceOption['state'] => !s ? undefined : /healthy|active|ready|running/i.test(s) ? { tone: 'ok', text: 'Running' }
  : /paus|inactive|disabled|suspend/i.test(s) ? { tone: 'warn', text: 'Paused' } : /crash|fail|error/i.test(s) ? { tone: 'bad', text: 'Not working' } : undefined;
const SERVER_STATE: Record<string, SourceOption['state']> = {
  ready: { tone: 'ok', text: 'Healthy' }, bootstrapping: { tone: 'warn', text: 'Setting up' }, new: { tone: 'idle', text: 'Not set up yet' },
  awaiting_key: { tone: 'warn', text: 'Needs its key' }, unreachable: { tone: 'bad', text: 'Not answering' }, error: { tone: 'bad', text: 'Setup failed' },
};
// a name's registrable domain when no scan said its zone (three labels for co.uk-style endings)
function rootOf(name: string, known: Set<string>) {
  const labels = name.split('.');
  for (let i = labels.length - 2; i >= 1; i--) { const up = labels.slice(i).join('.'); if (known.has(up)) return up; }
  return labels.slice(labels.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(labels.at(-2)!) && labels.at(-1)!.length === 2 ? -3 : -2).join('.');
}

type Svc = { id: string; name: string; kind: string; status: string; project: string; env: string; env_kind: string; host: string | null; server_id: string | null; stack: string | null };
const services = (app: App, orgId: string) => all<Svc>(app.db, `SELECT s.id, s.name, s.kind, s.status, s.server_id, p.name project, e.name env, e.kind env_kind,
  json_extract(s.config, '$.detection.stack') stack,
  (SELECT hostname FROM domains d WHERE d.service_id = s.id ORDER BY (hostname LIKE '%.sslip.io' OR hostname LIKE '%.nip.io'), d.created_at LIMIT 1) host
  FROM services s JOIN projects p ON p.id = s.project_id JOIN environments e ON e.id = s.environment_id WHERE s.org_id = ? ORDER BY p.name, e.name, s.name`, orgId);
type Found = { platform?: string; status?: string; dns?: string; zone?: string; ips?: string[]; end?: { kind: string } & Record<string, string> };
const assets = (app: App, orgId: string, kind: string) => all<{ id: string; provider: string; name: string; url: string | null; meta: string; ext_id: string; account_id: string | null }>(app.db,
  `SELECT id, provider, name, url, meta, ext_id, account_id FROM assets WHERE org_id = ? AND kind = ? AND provider <> 'unit7' ORDER BY provider, name`, orgId, kind)
  .map((a) => ({ ...a, m: json<Found>(a.meta, {}) }));
const pointWith = (end?: Found['end']) => {
  if (!end || !POINTABLE.has(end.kind)) return undefined;
  const { kind, ...rest } = end;
  return kind === 'unit7' ? { serviceId: rest.serviceId } : { [kind]: rest };
};

export function sourceOptions(app: App, orgId: string, source: Source, filter?: Record<string, string>): SourceOption[] {
  const list = build(app, orgId, source);
  const val = (o: SourceOption, k: string) => String((k in o.use ? o.use[k] : (o as unknown as Record<string, unknown>)[k]) ?? '');
  return filter ? list.filter((o) => Object.entries(filter).every(([k, v]) => val(o, k).toLowerCase() === v.toLowerCase())) : list;
}

function build(app: App, orgId: string, source: Source): SourceOption[] {
  const { db } = app;
  if (source === 'domains') {
    // every domain the map found plus the ones Unit7 manages, one card per root with its subdomains
    const found = all<{ name: string; meta: string }>(db, `SELECT name, meta FROM assets WHERE org_id = ? AND kind = 'domain'`, orgId).map((a) => ({ name: a.name.toLowerCase(), ...json<Found>(a.meta, {}) }));
    const managed = all<{ hostname: string; zone: string | null }>(db, 'SELECT hostname, zone FROM domains WHERE org_id = ?', orgId);
    const names = [...found, ...managed.map((d) => ({ name: d.hostname.toLowerCase(), zone: d.zone ?? undefined, dns: undefined }))].filter((d) => !INSTANT.test(d.name));
    const known = new Set(names.filter((d) => !d.zone || d.zone === d.name).map((d) => d.name));
    const roots = new Map<string, { dns?: string; subs: Set<string> }>();
    for (const d of names) {
      const root = d.zone ?? rootOf(d.name, known);
      const g = roots.get(root) ?? { subs: new Set<string>() };
      g.dns ??= d.dns;
      if (d.name !== root) g.subs.add(d.name);
      roots.set(root, g);
    }
    return [...roots].sort(([a], [b]) => a.localeCompare(b)).map(([root, g]) => ({
      id: root, label: root, logo: g.dns, provider: g.dns, count: g.subs.size,
      use: { hostname: root, ...(g.dns && { dns: g.dns }), subdomains: [...g.subs].sort() },
    }));
  }
  if (source === 'apps') {
    const own: SourceOption[] = services(app, orgId).filter((s) => s.kind === 'app').map((s) => ({
      id: s.id, label: s.name, full: `${s.name} (${s.project}, ${s.env})`, logo: s.stack ?? 'unit7', provider: 'unit7', sub: `${s.project} · ${s.env}`, url: s.host ? `https://${s.host}` : undefined, state: svcState(s.status),
      use: { serviceId: s.id, provider: 'unit7', project: s.project, environment: s.env, pointWith: { serviceId: s.id } },
    }));
    const elsewhere: SourceOption[] = assets(app, orgId, 'app').map((a) => {
      const point = pointWith(a.m.end) ?? pointFound(a);
      return {
        id: a.id, label: a.name, logo: a.provider, provider: a.provider, sub: a.m.platform && a.m.platform !== a.provider ? a.m.platform : undefined, url: a.url ?? undefined, state: assetState(a.m.status),
        use: { provider: a.provider, name: a.name, ...(a.url && { url: a.url }), ...(point && { pointWith: point }) },
      };
    });
    return [...own, ...elsewhere];
  }
  if (source === 'databases') {
    const own: SourceOption[] = services(app, orgId).filter((s) => DB_KINDS.has(s.kind)).map((s) => ({
      id: s.id, label: s.name, full: `${s.name} (${s.project}, ${s.env})`, logo: s.kind, provider: 'unit7', sub: `${s.project} · ${s.env}`, state: svcState(s.status),
      use: { serviceId: s.id, engine: s.kind, provider: 'unit7', project: s.project, environment: s.env },
    }));
    const elsewhere: SourceOption[] = assets(app, orgId, 'database').map((a) => ({
      id: a.id, label: a.name, logo: a.provider, provider: a.provider, url: a.url ?? undefined, state: assetState(a.m.status), use: { provider: a.provider, name: a.name },
    }));
    return [...own, ...elsewhere];
  }
  if (source === 'servers') {
    const own: SourceOption[] = all<{ id: string; name: string; host: string; status: string; provider: string | null }>(db,
      'SELECT s.id, s.name, s.host, s.status, a.provider FROM servers s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.org_id = ? ORDER BY s.name', orgId).map((s) => ({
      id: s.id, label: s.name, logo: s.provider ?? 'ubuntu', provider: s.provider ?? 'unit7', sub: s.host, state: SERVER_STATE[s.status] ?? { tone: 'idle', text: s.status },
      use: { serverId: s.id, host: s.host, provider: s.provider ?? 'unit7' },
    }));
    const elsewhere: SourceOption[] = assets(app, orgId, 'server').map((a) => ({
      id: a.id, label: a.name, logo: a.provider, provider: a.provider, sub: a.m.ips?.[0], state: assetState(a.m.status), use: { provider: a.provider, name: a.name, ...(a.m.ips?.[0] && { host: a.m.ips[0] }) },
    }));
    return [...own, ...elsewhere];
  }
  if (source === 'projects') {
    return all<{ id: string; name: string; repo: string | null }>(db, 'SELECT id, name, repo FROM projects WHERE org_id = ? ORDER BY name', orgId).map((p) => {
      const envs = all<{ id: string; name: string; kind: string; autonomy: number }>(db, 'SELECT id, name, kind, autonomy FROM environments WHERE project_id = ? ORDER BY created_at', p.id);
      const apps = get<{ n: number }>(db, `SELECT count(*) n FROM services WHERE project_id = ? AND kind = 'app'`, p.id)!.n;
      return { id: p.id, label: p.name, logo: p.repo ? 'github' : 'unit7', provider: 'unit7', count: apps, sub: envs.map((e) => e.name).join(' · '), use: { projectId: p.id, environments: envs } };
    });
  }
  return all<{ id: string; provider: string; name: string; status: string }>(db, 'SELECT id, provider, name, status FROM accounts WHERE org_id = ? ORDER BY provider, name', orgId).map((a) => ({
    id: a.id, label: a.name, logo: a.provider, provider: a.provider,
    state: a.status === 'failing' ? { tone: 'bad', text: 'Needs reconnecting' } : a.status === 'ok' || a.status === 'verified' ? { tone: 'ok', text: 'Connected' } : undefined,
    use: { accountId: a.id, provider: a.provider },
  }));
}

// --- what every brain is told about asking -------------------------------------------------------------
export const ASK_RULES = `This chat shows live cards and pickers, so:
- Every reply, the last one too, is one or two short sentences (under 40 words) of plain text: no headings, lists or bold. The cards show the data and failed steps show their errors: don't repeat lists, ids or JSON. When something fails, say what failed and the one next step.
- When the person must pick a domain, website/app, server, project, database or account, call ui_choose with that source (the picker shows their live data) and an allowNew where adding one makes sense ("Add a new domain", "New website"). Use options only for small fixed choices (www or the bare domain, an engine, an environment). Never type a list and ask them to reply.
- Don't ask when there's only one sensible choice: use it and say so.
- When the person must decide, offer 2–4 choices with ui_choose, mark exactly one recommended with a short why ("Fix it now" recommended because it can be undone, "Show me first", "Not now"). Never ask them to type a command Unit7 can run: run it, or offer it as a choice. If something isn't set up yet (no account for that provider, no server, no domain, no phone alerts), say so in one line: the failed step already shows "Set it up", and you carry on once they reply.
- Need a few values (a name, a repo URL)? ui_form. A secret field comes back as a credential:// reference: pass it on as is.
- Before a change, look at the environment's autonomy (graph_get shows it per environment, 0-4; domains and other org-wide things count as production):
  4 (Full autopilot): act, then report in one line. Confirm first only if it deletes data or costs money.
  3 (Fix itself, ask for risky): routine changes that can be undone (deploy, roll back, restart, back up, add a database, point a new domain): act and report. Call ui_confirm first if it deletes or overwrites data, replaces what a live domain or app serves, or costs money.
  2 (Ask first): call ui_confirm before every change.
  1 (Suggest) or 0 (Watch only): don't confirm. At 1 Unit7 holds the change for the person's approval; at 0 nothing can change: say what you'd do.
  ui_confirm lists each change as before → after and says how to undo it; set danger for deletes and restores.
- If a tool answers approvalRequired, the approval card is already the question: don't ask again.
- To hide an alert, ask the person with a Hide card (ui_hide with its key); to clear a fixed one, re-check it (alert_recheck).
- To delete (remove, get rid of) a project or app, show the Delete card (ui_delete with its key: the project's prj_ id or the map id) and wait. Deleting is the person's click, never yours, so never just say you can't: the card shows what goes and what stays and offers stop production then delete, archive instead, just stop it, or not now.
- If an ask comes back expired or cancelled, stop and say in one line you'll carry on when they're ready.
- After a fix, re-check with the matching read tool before saying it's fixed. If the check still shows the problem, say so plainly and offer the next fix. Never say 'fixed' on a guess. A fix's result says verified (fixed, or still with why); otherwise alert_recheck with the alert's key. Look with reads (server_routes, domain_check with host, server_xray), never server_exec: reads need no approval.
Guided flows:
- Connect a domain: ui_choose source domains (allowNew "Add a new domain") → ui_choose source apps (allowNew "New website") → if subdomains matter, ui_choose options (the bare domain, www…) → preview the DNS change (confirm per autonomy) → domain_point with the app's pointWith plus the hostname → domain_check, then one line about HTTPS. A Coolify app works the same: its pointWith is enough, and domain_point sets the name in Coolify, writes DNS, restarts the app and checks HTTPS in one call. For a whole new domain (www, HTTPS, email protection too), domain_launch with the same pointWith as target.
- A DNS record ("add an MX", "a TXT for Google", "an SRV"): dns_list first → dns_set as a dry run to show what changes → dns_set. A record for mail asks a person first and says what stops working; never work around that.
- Send a domain or a page somewhere else: domain_redirect (from, to). Give a client their own address: client_subdomain (name, domain and, if they have several apps, the app's pointWith as target). A wildcard (*.example.com): domain_point on a server or Coolify app, then tell them what its certificate result says: never say HTTPS works until domain_check says so.
- Deploy: ui_choose source apps or projects (allowNew "New project") → environment as options when there's more than one → deployment_create → one line with the URL.
- Add a database: ui_choose source apps (what it's for) → engine as options (Postgres unless they say) → database_create with injectInto → redeploy if needed.
- Back up / restore: ui_choose source databases → backup_create; to restore, backup_list, ui_choose options of backups, ui_confirm with danger → backup_restore.
- Fix my site: ui_choose source apps if it's unclear which → status, logs, metrics → the cause in one line → the fix (confirm per autonomy).
- Make me an app ("…with Supabase", "…with a database", "…on my domain"): when a server's Coolify is connected (a coolify account), build there: coolify_plan with their exact words (serverId only if Coolify is on more than one server: ui_choose source servers). If it lists missing (the repo): coolify_repos and github_repos → ui_choose options of repos (allowNew "Paste a repo URL" → ui_form) → coolify_build with the same words plus the answers. coolify_build shows the one plan card itself and runs every step: don't ui_confirm it again. Then one line: the URL, or the failed step and its next step. Without Coolify: project_create → service_create → database_create with injectInto → deployment_create.
- What's outdated / update everything ("keep my apps up to date", "any security fixes?"): fresh_plan (no serviceId for every app) and show it; for "update everything" fresh_run per app, one after the other. Each shows its own steps; then one line per app: live, waiting for their OK, or held back and why. Don't skip a failing test or release a major yourself below Autopilot.
- Make a test copy ("staging", "a copy to try things on"): ui_choose source projects if it's unclear which → staging_create with that projectId (or serverId and app for a Coolify app). It shows the one plan card itself (live keys left out, the data copy, the room) and runs every step: don't ui_confirm it again. Then one line: the test address, or the failed step and its next step.
- Put this live: ui_folder, or ui_choose a repo (github_repos lists them), then live_options, recommend the first place, live_put, one line with the link.
- Add a tool to my server (analytics, uptime monitor, automation, search…): addon_catalog → ui_choose options of its tools if they didn't name one → ui_choose options of subdomains (its suggest, allowNew) → addon_install. Then one line: where it's live and what to do first (its firstVisit).
${NEXT_RULE}`;

// an answered ask, as one line of an earlier turn for the next request
export function askSummary(c: { spec?: AskSpec; state?: string; answer?: Record<string, any> }) {
  const a = c.answer ?? {};
  const said = c.state !== 'answered' ? (c.state === 'waiting' ? 'not answered' : c.state)
    : a.cancelled ? 'skipped' : a.new ? 'they chose to add a new one' : a.labels ? `they picked ${a.labels.join(', ')}`
    : a.uploadId ? `they gave their site ${a.name}, uploadId ${a.uploadId}`
    : 'hidden' in a ? (a.hidden ? 'they hid it' : 'they kept it showing')
    : 'ok' in a ? (a.ok ? 'they confirmed' : 'they said not now') : a.values ? 'they filled it in' : '';
  return c.spec ? `(I asked: ${c.spec.title} → ${said})` : '';
}
