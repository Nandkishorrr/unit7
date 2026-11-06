// The ask box with nothing connected to answer it. The commonest requests need no AI: a fixed rule opens the right page or runs the
// read-only tool, in the same thread. Anything else gets one plain line saying what to connect. Rules only look at short requests
// said straight out, so "don't put this live" or a question that happens to mention a server waits for an AI instead.
import type { App } from '../app.ts';
import { actorOf, type Principal } from '../auth.ts';
import { all, id, now, run } from '../db.ts';
import { execute, getTool } from '../tools/runtime.ts';
import { running, type AgentMessage } from './brain.ts';
import type { ContextItem } from './conversations.ts';

export const NOTHING_ANSWERS = 'Nothing is connected to answer this yet, so it hasn’t started. Connect one and ask again: your Claude Code (Install or Sign in here in the box, or run /unit7 watch in it and it picks this up by itself), an API key, or Ollama for a free model on this Mac. [Open Connections](/connections#ai)';

export type RuleId = 'live' | 'server' | 'disk' | 'backups';
const THING = String.raw`(?:this|it|my\s+(?:\w+\s+)?(?:site|app|website|project|folder))`;
const RULES: [RuleId, RegExp][] = [
  ['live', new RegExp(String.raw`^(?:(?:put|get|make)\s+${THING}\s+(?:live|online)|(?:deploy|publish|launch)\s+${THING}(?:\s+and\s+give\s+me\s+the\s+link)?|go\s+live)$`)],
  ['disk', /^(?:what(?:'s|\s+is)\s+(?:using|eating|filling|taking(?:\s+up)?)\s+(?:all\s+)?(?:(?:my|the)\s+)?(?:disk(?:\s+space)?|space|storage)(?:\s+on\s+my\s+(?:server|vps))?|(?:my\s+|server\s+)?disk(?:\s+space|\s+usage)|why\s+is\s+my\s+disk\s+full|my\s+disk\s+is\s+full)$/],
  ['server', /^(?:check\s+(?:on\s+)?(?:my|the)\s+(?:servers?|vps)(?:\s+and\s+tell\s+me\s+if\s+anything\s+needs\s+attention)?|(?:how(?:'s|\s+is)|is)\s+my\s+(?:server|vps)(?:\s+(?:doing|ok|okay|fine|healthy|up))?|(?:server|vps)\s+(?:status|health))$/],
  ['backups', /^(?:(?:show|list|see|check)\s+(?:me\s+)?(?:my|the|all\s+my)\s+backups|(?:my\s+)?backups|(?:do\s+i\s+have|have\s+i\s+got)\s+(?:any\s+)?backups|where\s+are\s+my\s+backups)$/],
];
export function ruleFor(message: string): RuleId | undefined {
  const said = message.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/^(?:(?:hey|hi|hello|ok|okay|please|pls|can you|could you|would you|will you|unit ?7)[,\s]+)+/, '').replace(/[\s,]*(?:please|pls|thanks|thank you)?[\s.!?]*$/, '');
  return RULES.find(([, re]) => re.test(said))?.[0];
}

// A person's own read-only tools, shown like an AI's steps, so a card lands in the thread the same way.
export async function answerByRule(o: { app: App; p: Principal; rule: RuleId; conversationId: string; context: ContextItem[]; emit: (m: AgentMessage) => void }) {
  const { app, p, rule, conversationId, emit } = o, controller = new AbortController();
  running.set(conversationId, controller); // so the box shows it working, and Stop works
  const say = (text: string) => emit({ id: id('msg'), role: 'assistant', content: { text }, created_at: now() });
  const step = async (tool: string, input: Record<string, unknown>) => {
    const stepId = id('step'), base = { tool, title: getTool(tool)!.title, input };
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
  try {
    if (rule === 'live') say('Putting something live for you takes an AI, and none is connected yet. You can do it yourself: [Put this live](/live) takes a folder, a ZIP or a GitHub repo. In Terminal, `unit7 live` does it from the folder you’re in.');
    if (rule === 'server') await eachServer('server.metrics', (names) => `That’s how ${names} looks right now. For the whole picture (room, data, security), [run a Check-up](/checkup?run=1).`);
    if (rule === 'disk') await eachServer('server.usage', (names) => `That’s what each project uses on ${names}. A [Check-up](/checkup?run=1) also says what can be cleared.`);
    if (rule === 'backups') {
      const list = await step('backup.list', {}) as unknown[] | undefined;
      say(list?.length ? 'Those are your newest backups. Schedules and restores are in [Safety Net](/protect).' : list ? 'There are no backups yet. [Safety Net](/protect) shows what needs one.' : 'Unit7 couldn’t read your backups just now. [Safety Net](/protect) has them too.');
    }
  } finally {
    running.delete(conversationId);
    run(app.db, 'UPDATE conversations SET updated_at = ? WHERE id = ?', now(), conversationId);
    app.events.emit(p.org.id, 'agent.done', 'Answered without an AI', { live: true, data: { conversationId } });
  }
}
