// The ask box with nothing connected to answer it. The commonest requests need no AI: a fixed rule opens the right page or runs the
// read-only tools, in the same thread, and its words say so (rule: true), so it never reads as an AI's. Anything else is told at once
// that it hasn't started, what can be asked instead (ASKS, as buttons) and how to connect an AI; nothing is left waiting in an inbox.
// Rules only look at short requests said straight out, so "don't put this live" or a question that happens to mention a server gets
// the plain answer instead. What a server or an app says stays in the tools' own cards: words said here reach an AI's history later.
import type { App } from '../app.ts';
import { actorOf, type Principal } from '../auth.ts';
import { all, get, id, now, run } from '../db.ts';
import { archivedAssets } from '../archive.ts';
import { ago } from '../tools/manage.ts';
import { execute, getTool } from '../tools/runtime.ts';
import { running, type AgentMessage } from './brain.ts';
import type { ContextItem } from './conversations.ts';

// the buttons when it can't answer something: each one is a rule (test/gap-pages.test.ts)
export const ASKS = ['What’s running?', 'Is my site down?', 'What’s using my server?', 'What does it cost?', 'When was the last backup?', 'Is my domain OK?', 'Show me errors'];
export const NOTHING_ANSWERS = 'No AI is connected, so Unit7 can’t work this one out, and nothing has started. It can answer the questions below from your own data without one. For anything else, connect an AI with one click below, or add an API key or Ollama in [Connections](/connections#ai), then ask again.';

export const INBOX_WAITS = 'No AI is connected yet, so this waits in your AI’s inbox for a day. It starts once your Claude Code is watching, or connect an AI with one click below and ask again.';

export type RuleId = 'live' | 'server' | 'disk' | 'backups' | 'running' | 'down' | 'usage' | 'cost' | 'lastBackup' | 'domain' | 'errors';
const THING = String.raw`(?:this|it|my\s+(?:\w+\s+)?(?:site|app|website|project|folder))`;
const RULES: [RuleId, RegExp][] = [
  ['live', new RegExp(String.raw`^(?:(?:put|get|make)\s+${THING}\s+(?:live|online)|(?:deploy|publish|launch)\s+${THING}(?:\s+and\s+give\s+me\s+the\s+link)?|go\s+live)$`)],
  ['disk', /^(?:what(?:'s|\s+is)\s+(?:using|eating|filling|taking(?:\s+up)?)\s+(?:all\s+)?(?:(?:my|the)\s+)?(?:disk(?:\s+space)?|space|storage)(?:\s+on\s+my\s+(?:server|vps))?|(?:my\s+|server\s+)?disk(?:\s+space|\s+usage)|why\s+is\s+my\s+disk\s+full|my\s+disk\s+is\s+full)$/],
  ['server', /^(?:check\s+(?:on\s+)?(?:my|the)\s+(?:servers?|vps)(?:\s+and\s+tell\s+me\s+if\s+anything\s+needs\s+attention)?|(?:how(?:'s|\s+is)|is)\s+my\s+(?:server|vps)(?:\s+(?:doing|ok|okay|fine|healthy|up))?|(?:server|vps)\s+(?:status|health))$/],
  ['backups', /^(?:(?:show|list|see|check)\s+(?:me\s+)?(?:my|the|all\s+my)\s+backups|(?:my\s+)?backups|(?:do\s+i\s+have|have\s+i\s+got)\s+(?:any\s+)?backups|where\s+are\s+my\s+backups)$/],
  ['running', /^(?:(?:show\s+me\s+|tell\s+me\s+)?what(?:'s|\s+is)\s+(?:running|live)(?:\s+(?:right\s+)?now)?(?:\s+on\s+(?:my|the)\s+(?:servers?|vps))?|what\s+do\s+i\s+have\s+running|what\s+(?:apps|projects|sites)\s+do\s+i\s+have|(?:show|list|see)\s+(?:me\s+)?(?:my|all\s+my)\s+(?:apps|projects|sites|websites))$/],
  ['down', /^(?:(?:is|are)\s+(?:(?:(?:my|the|our)\s+(?:sites?|websites?|apps?))|anything|everything|it)\s+(?:down|up|online|offline|working|broken)(?:\s+(?:right\s+)?now)?|(?:is|are)\s+(?:my|the|our)\s+(?:sites?|websites?|apps?)\s+(?:ok|okay)|(?:my\s+)?(?:site|website|app)\s+(?:is\s+)?down)$/],
  ['usage', /^(?:what(?:'s|\s+is)\s+(?:using|eating|hogging|taking(?:\s+up)?)\s+(?:all\s+)?(?:(?:of\s+)?(?:my|the)\s+)?(?:server|vps|memory|ram|cpu)|(?:my\s+|server\s+)?(?:memory|ram|cpu)\s+usage|server\s+usage)$/],
  ['cost', /^(?:(?:what|how\s+much)\s+does\s+(?:it|this|that|everything|all\s+this|it\s+all)(?:\s+all)?\s+cost(?:\s+me)?(?:\s+a\s+month)?|(?:what|how\s+much)\s+(?:am\s+i\s+(?:paying|spending)|do\s+i\s+(?:pay|spend))(?:\s+for\s+(?:all\s+)?(?:this|it))?(?:\s+a\s+month)?|what(?:'s|\s+is)\s+(?:it\s+costing(?:\s+me)?|my\s+bill)|(?:what\s+are\s+|show\s+(?:me\s+)?)?my\s+(?:costs|bills?)|costs)$/],
  ['lastBackup', /^(?:when\s+(?:was|is)\s+(?:the|my|our)\s+(?:last|latest|most\s+recent)\s+backup|when\s+did\s+(?:i|we|it|unit7|you)\s+last\s+back\s*up|(?:my\s+|the\s+)?(?:last|latest)\s+backup)$/],
  ['domain', /^(?:(?:is|are)\s+(?:my|the|our)\s+domains?\s+(?:ok|okay|fine|good|healthy|working|all\s+right|alright)|(?:check|how(?:'s|\s+is|\s+are))\s+(?:on\s+)?(?:my|the|our)\s+domains?|domains?\s+(?:status|health)|when\s+(?:does|do)\s+my\s+domains?\s+(?:expire|run\s+out))$/],
  ['errors', /^(?:(?:show|list|see|give)\s+(?:me\s+)?(?:(?:the|my|any|all)\s+)?(?:recent\s+|latest\s+)?errors|(?:are\s+there|do\s+i\s+have|have\s+i\s+got|got)\s+any\s+errors|any\s+errors|what\s+errors\s+(?:are\s+there|do\s+i\s+have)|what(?:'s|\s+is)\s+failing|errors)$/],
];
export function ruleFor(message: string): RuleId | undefined {
  const said = message.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/^(?:(?:hey|hi|hello|ok|okay|please|pls|can you|could you|would you|will you|unit ?7)[,\s]+)+/, '').replace(/[\s,]*(?:please|pls|thanks|thank you)?[\s.!?]*$/, '');
  return RULES.find(([, re]) => re.test(said))?.[0];
}

const SITE_DOWN = new Set(['down', 'flaky']);
interface Watched { checked: number; issues: { key: string; text: string }[]; rows: { host: string; kind: string; status: string; detail: string | null; ms: number | null }[] }
const some = (items: string[], max = 5) => [...items.slice(0, max), ...(items.length > max ? [`And ${items.length - max} more.`] : [])].join(' ');
// a database's name comes from the server, and these words reach an AI later: plain letters only
const plain = (s: string) => s.replace(/[^\w .-]/g, '').trim().slice(0, 60) || 'one database';

// (pure) a fresh look at every site, in words
export function sitesWord(w: Watched) {
  if (!w.checked) return 'Unit7 has no site to check yet. Connect a server or a host, and what it runs shows up on [the map](/map).';
  const sites = w.rows.filter((r) => r.kind === 'site'), ban = w.issues.find((i) => i.key === 'blocked')?.text;
  if (sites.some((r) => r.detail?.startsWith('Not checked'))) return 'Unit7 lost its own connection, so it couldn’t check your sites. This says nothing about them. Try again in a minute.';
  const out = sites.filter((r) => SITE_DOWN.has(r.status)), slow = sites.filter((r) => r.status === 'slow');
  if (!out.length && !slow.length) return [ban, sites.length === 1 ? `${sites[0]!.host} answered just now.` : `All ${sites.length} sites answered just now.`].filter(Boolean).join(' ');
  return [ban, some([...out.map((r) => `${r.host} ${r.status === 'down' ? 'is down' : 'didn’t answer just now'}${r.detail ? ` (${r.detail})` : ''}.`), ...slow.map((r) => `${r.host} is slow${r.ms ? ` (${r.ms} ms)` : ''}.`)]),
    `${sites.length - out.length - slow.length} of ${sites.length} are fine. [See what needs a look](/map?status=attention).`].filter(Boolean).join(' ');
}
// (pure) the same check of every domain: HTTPS, renewal dates and email protection
export function domainsWord(w: Watched) {
  const rows = w.rows.filter((r) => r.kind !== 'site'), n = new Set(rows.map((r) => r.host)).size, bad = w.issues.filter((i) => /^(tls|reg|email):/.test(i.key)).map((i) => i.text);
  if (!n) return 'Unit7 has no domain to check yet. Connect the account that holds them, and they show up on [the map](/map?type=domain).';
  const unread = new Set(rows.filter((r) => r.status === 'unknown').map((r) => r.host)).size;
  return [bad.length ? some(bad) : `${n === 1 ? 'Your domain looks' : `Your ${n} domains look`} fine: nothing wrong with HTTPS, renewal dates or email protection.`, unread > 0 && `${unread} couldn’t be read just now.`, '[See your domains](/map?type=domain).'].filter(Boolean).join(' ');
}

// A person's own read-only tools, shown like an AI's steps, so a card lands in the thread the same way.
export async function answerByRule(o: { app: App; p: Principal; rule: RuleId; conversationId: string; context: ContextItem[]; emit: (m: AgentMessage) => void }) {
  const { app, p, rule, conversationId, emit } = o, controller = new AbortController();
  running.set(conversationId, controller); // so the box shows it working, and Stop works
  const say = (text: string) => emit({ id: id('msg'), role: 'assistant', content: { text, rule: true }, created_at: now() });
  const step = async (tool: string, input: Record<string, unknown>) => {
    const stepId = id('step'), base = { tool, title: getTool(tool)!.title, input, rule: true };
    emit({ id: stepId, role: 'tool', content: { ...base, status: 'running' }, created_at: now() });
    const r = await execute(app, p.org.id, actorOf(p), tool, input, { reason: 'ask box, no AI connected', conversationId, signal: controller.signal });
    emit({ id: stepId, role: 'tool', content: r.status === 'ok' ? { ...base, status: 'ok', output: r.output, durationMs: r.durationMs } : { ...base, status: 'error', error: r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : 'It didn’t run.' }, created_at: now() });
    return r.status === 'ok' ? r.output : undefined;
  };
  // the servers it's about: the ones picked, else every one Unit7 can sign in to
  const picked = o.context.filter((c) => c.kind === 'server').map((c) => c.id);
  const servers = () => all<{ id: string; name: string; status: string }>(app.db, 'SELECT id, name, status FROM servers WHERE org_id = ? ORDER BY name', p.org.id).filter((s) => !['awaiting_key', 'new'].includes(s.status) && (!picked.length || picked.includes(s.id)));
  const NO_SERVER = 'No server is connected yet. [Add one](/servers?new=1) and ask again.';
  const eachServer = async (tool: string, done: (names: string) => string) => {
    const list = servers();
    if (!list.length) return say(NO_SERVER);
    const shown = list.slice(0, 3), results: unknown[] = [];
    for (const s of shown) results.push(await step(tool, { serverId: s.id }));
    const failed = shown.filter((_, n) => !results[n]);
    say([failed.length < shown.length && done(shown.filter((_, n) => results[n]).map((s) => s.name).join(', ')),
      ...failed.map((s) => `${s.name} didn’t answer. [Open it](/servers/${s.id}) to see why.`),
      list.length > shown.length && `That’s the first ${shown.length} of ${list.length}. The rest are in [Servers](/servers).`].filter(Boolean).join(' '));
  };
  // one domain the person picked for this: what public DNS says and whether it answers
  const pickedDomains = async () => {
    const hosts = o.context.filter((c) => c.kind === 'domain').map((c) => c.name).slice(0, 3);
    if (!hosts.length) return false;
    const lines: string[] = [];
    for (const host of hosts) {
      const r = await step('domain.check', { host }) as { answers: string; issues: { text: string }[] } | undefined;
      lines.push(r ? [`${host}: ${r.answers}`, ...r.issues.map((i) => i.text)].join(' ') : `Unit7 couldn’t check ${host} just now.`);
    }
    say(lines.join(' '));
    return true;
  };
  const watched = async (daily: boolean, word: (w: Watched) => string) => {
    const w = await step('watch.check', { daily }) as Watched | undefined;
    say(w ? word(w) : 'Unit7 couldn’t run the check just now. [The map](/map) has the last one.');
  };
  try {
    if (rule === 'live') say('Putting something live for you takes an AI, and none is connected yet. You can do it yourself: [Put this live](/live) takes a folder, a ZIP or a GitHub repo. In Terminal, `unit7 live` does it from the folder you’re in.');
    if (rule === 'server') await eachServer('server.metrics', (names) => `That’s how ${names} looks right now. For the whole picture (room, data, security), [run a Check-up](/checkup?run=1).`);
    if (rule === 'disk') await eachServer('server.usage', (names) => `That’s what each project uses on ${names}. A [Check-up](/checkup?run=1) also says what can be cleared.`);
    if (rule === 'usage') await eachServer('server.usage', (names) => `That’s what each project uses on ${names} right now.`);
    if (rule === 'backups') {
      const list = await step('backup.list', {}) as unknown[] | undefined;
      say(list?.length ? 'Those are your newest backups. Schedules and restores are in [Safety Net](/protect).' : list ? 'There are no backups yet. [Safety Net](/protect) shows what needs one.' : 'Unit7 couldn’t read your backups just now. [Safety Net](/protect) has them too.');
    }
    if (rule === 'running') {
      const off = archivedAssets(app.db, p.org.id);
      const hosted = all<{ id: string }>(app.db, `SELECT id FROM assets WHERE org_id = ? AND kind = 'app' AND json_extract(meta, '$.owner') IS NULL`, p.org.id).filter((a) => !off.has(a.id)).length;
      const also = hosted ? `${hosted} more ${hosted === 1 ? 'app runs' : 'apps run'} on your hosting accounts: [see them on the map](/map?type=app).` : '';
      if (servers().length) await eachServer('server.xray', (names) => `That’s what runs on ${names} right now. ${also}`.trim());
      else say(also || NO_SERVER);
    }
    if (rule === 'down' && !await pickedDomains()) await watched(false, sitesWord);
    if (rule === 'domain' && !await pickedDomains()) await watched(true, domainsWord);
    if (rule === 'cost') {
      const r = await step('cost.radar', {}) as { total: number; currency: string; estimate: boolean } | undefined;
      say(!r ? 'Unit7 couldn’t read your costs just now. [Costs](/costs) has the last ones.'
        : r.total ? `About ${new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency }).format(r.total)} a month${r.estimate ? ', part of it an estimate' : ''}, from what Unit7 last read. [See where it goes](/costs).`
        : 'Unit7 doesn’t know any prices yet. Add what your server costs in [Costs](/costs), and connect the accounts that bill you.');
    }
    if (rule === 'lastBackup') {
      const s = await step('safety.status', {}) as { guarded: { name: string; serverName: string; lastCopy: string | null; system?: boolean }[] } | undefined;
      const dbs = (s?.guarded ?? []).filter((g) => !g.system), newest = dbs.filter((g) => g.lastCopy).sort((a, b) => b.lastCopy!.localeCompare(a.lastCopy!))[0], bare = dbs.filter((g) => !g.lastCopy).length;
      say(!s ? 'Unit7 couldn’t read your backups just now. [Safety Net](/protect) has them too.'
        : !dbs.length ? 'Unit7 doesn’t see a database yet, so there’s nothing to back up.'
        : !newest ? `${dbs.length === 1 ? 'Your database has' : `None of your ${dbs.length} databases has`} ${dbs.length === 1 ? 'no backup' : 'a backup'} yet. [Safety Net](/protect) can start them.`
        : `The last backup was ${ago(newest.lastCopy!)}: ${plain(newest.name)} on ${plain(newest.serverName)}.${bare ? ` ${bare} of your ${dbs.length} databases ${bare === 1 ? 'has' : 'have'} no backup yet.` : ''} [Safety Net](/protect) has the rest.`);
    }
    if (rule === 'errors') {
      const mine = get(app.db, 'SELECT 1 FROM services WHERE org_id = ? LIMIT 1', p.org.id) ? await step('errors.list', {}) as unknown[] | undefined : [];
      const hosted = await step('errors.hosts', {}) as unknown[] | undefined;
      const list = servers(), shown = list.slice(0, 3), logs: ({ apps: { patterns: { errors: boolean }[] }[] } | undefined)[] = [];
      for (const s of shown) logs.push(await step('logs.digest', { serverId: s.id }) as typeof logs[number]);
      const kinds = (mine?.length ?? 0) + (hosted?.length ?? 0) + logs.reduce((n, l) => n + (l?.apps ?? []).reduce((m, a) => m + a.patterns.filter((x) => x.errors).length, 0), 0);
      const lost = shown.filter((_, n) => !logs[n]);
      say([kinds ? `Unit7 found ${kinds} kind${kinds === 1 ? '' : 's'} of error, shown above.` : lost.length === shown.length && shown.length ? '' : 'No errors: nothing in your apps’ error lists, and nothing in the last 12 hours of their logs on your servers.',
        ...lost.map((s) => `${s.name} didn’t answer. [Open it](/servers/${s.id}) to see why.`), list.length > shown.length && `Those are the first ${shown.length} of ${list.length} servers.`].filter(Boolean).join(' '));
    }
  } catch (e) {
    console.error('ask box rule failed', e);
    say('Unit7 couldn’t read that just now. Try again in a moment.');
  } finally {
    running.delete(conversationId);
    run(app.db, 'UPDATE conversations SET updated_at = ? WHERE id = ?', now(), conversationId);
    app.events.emit(p.org.id, 'agent.done', 'Answered without an AI', { live: true, data: { conversationId } });
  }
}
