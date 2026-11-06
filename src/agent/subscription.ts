// The ask box without an API key: your own Claude subscription (through Claude Code) answers what you type. Unit7 runs
// the unmodified official CLI once per request, headless, on this Mac, with the person's message on stdin. Only for
// requests a person just typed: schedules and alerts need an API key or a local model (routines.ts, watcher.ts). Gemini
// CLI stopped serving free, Pro and Ultra accounts on 18 June 2026, and Google doesn't support wrapping its replacement
// on consumer plans, so Google goes through an API key like any other model. The CLI gets NO built-in tools (no shell, files or web): only Unit7's tools, over Unit7's own MCP endpoint
// with a short-lived agent token, so every action passes the same gate (autonomy, approvals, audit) as any agent.
//
// A subscription is one person's. Only the member who turned one on (from this Mac, where that CLI is signed in)
// runs on it; a teammate is told to use an API key or their own AI, and Warden never routes incidents through it.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { App } from '../app.ts';
import { all, get, id, json, now, run } from '../db.ts';
import { Unit7Error, forbidden } from '../errors.ts';
import { createToken, revokeToken, type Principal } from '../auth.ts';
import { tools as allTools } from '../tools/runtime.ts';
import { claudeBin } from '../agents/clients.ts';
import { INSTRUCTIONS } from '../mcp/server.ts';
import { running, type AgentMessage } from './brain.ts';
import { ASK_RULES, askSummary, bindRun, stamp } from './asks.ts';
import { withNext } from './next.ts';

export type CliId = 'claude';
export const CLIS: Record<CliId, { label: string; name: string; token: string; missing: string; signIn: string }> = {
  claude: { label: 'Claude · your subscription', name: 'Claude', token: 'Unit7 brain · Claude', missing: 'Claude Code isn’t installed on this Mac.', signIn: 'Claude Code isn’t signed in: run `claude` once in Terminal.' },
};
const IDS = Object.keys(CLIS) as CliId[];
export const TIMEOUT_MS = 10 * 60_000; // of the CLI working on its own (the clock stops while it waits on the person)
const RUN_MAX_MS = 60 * 60_000;        // ponytail: the run's token dies by then however many asks it waits on; a longer cap if people need it
const MCP_WAIT_MS = 35 * 60_000;       // a single Unit7 tool call: an ask waits up to 10 minutes, the longest tools ~30
const wire = (name: string) => name.replace(/\./g, '_');

// where the CLI is (UNIT7_CLAUDE_BIN points elsewhere, e.g. a stand-in in tests)
export function cliBin(_cli: CliId = 'claude'): string | undefined {
  const set = process.env.UNIT7_CLAUDE_BIN;
  if (set) return existsSync(set) ? set : undefined;
  return claudeBin();
}

// The CLI runs as the person would start it: Unit7's own secrets, API keys (which would bill an API account
// instead of the subscription) and the variables of whatever session started Unit7 stay out.
function childEnv(extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(UNIT7_|ANTHROPIC_|CLAUDE(?!_CONFIG_DIR$))|_API_KEY$|_TOKEN$/.test(k))) as Record<string, string>;
  return { ...env, PATH: `${dirname(process.execPath)}:${env.PATH ?? ''}`, ...extra };
}

// Signed in? Claude Code says so itself (fast, no model call; asked again after 5 s, so a fresh sign-in shows up quickly)
const authCache = new Map<string, { at: number; ok: boolean }>();
async function signedIn(bin: string): Promise<boolean> {
  const hit = authCache.get(bin);
  if (hit && Date.now() - hit.at < 5000) return hit.ok;
  const ok = await new Promise<boolean>((resolve) => execFile(bin, ['auth', 'status', '--json'], { env: childEnv(), timeout: 8000 },
    (_e, out) => { try { resolve(JSON.parse(String(out)).loggedIn === true); } catch { resolve(false); } }));
  authCache.set(bin, { at: Date.now(), ok });
  return ok;
}

export interface CliState { id: CliId; label: string; state: 'ready' | 'not-installed' | 'sign-in' | 'taken'; note: string }

// what each subscription brain looks like to this person right now
export async function brainStates(app: App, orgId: string, userId: string): Promise<CliState[]> {
  const holders = all<{ brain: string; org_id: string; user_id: string }>(app.db, 'SELECT brain, org_id, user_id FROM memberships WHERE brain IS NOT NULL');
  return Promise.all(IDS.map(async (cli): Promise<CliState> => {
    const base = { id: cli, label: CLIS[cli].label };
    const h = holders.find((x) => x.brain === cli);
    if (h && !(h.org_id === orgId && h.user_id === userId)) return { ...base, state: 'taken', note: 'Someone else on this Mac uses this one. Use an API key or your own AI.' };
    const bin = cliBin(cli);
    if (!bin) return { ...base, state: 'not-installed', note: CLIS[cli].missing };
    if (!(await signedIn(bin))) return { ...base, state: 'sign-in', note: 'Sign in first: run `claude` once in Terminal.' };
    return { ...base, state: 'ready', note: h ? 'In use' : 'Ready' };
  }));
}

// (someone who picked Gemini before its CLI closed simply has no brain picked: the ask box asks again)
export const myBrain = (app: App, orgId: string, userId: string) => {
  const brain = get<{ brain: string | null }>(app.db, 'SELECT brain FROM memberships WHERE org_id = ? AND user_id = ?', orgId, userId)?.brain;
  return IDS.includes(brain as CliId) ? brain as CliId : undefined;
};

// The person's brain for /api/agent/status: with a subscription brain on, the box is ready for them.
export async function brainStatus(app: App, p: Principal) {
  const brain = myBrain(app, p.org.id, p.user.id);
  return { brain: brain ?? null, brains: await brainStates(app, p.org.id, p.user.id), ...(brain && { ready: true, mode: CLIS[brain].label }) };
}

// Turn a subscription brain on for this person (or off, with null). Only from the web app on this Mac, where the
// CLI's sign-in is, and only if nobody else already uses it.
export async function setBrain(app: App, p: Principal, cli: CliId | null, onThisMac: boolean) {
  if (p.via !== 'session') throw forbidden('Pick your AI in the web app, signed in.');
  if (cli) {
    if (!onThisMac) throw forbidden(`Turn this on from the Mac where Unit7 runs: it uses the ${CLIS[cli].name} sign-in on that Mac.`);
    const s = (await brainStates(app, p.org.id, p.user.id)).find((x) => x.id === cli)!;
    if (s.state !== 'ready') throw new Unit7Error(s.state === 'taken' ? 'brain_taken' : 'brain_unavailable', s.note, 409);
  }
  try { run(app.db, 'UPDATE memberships SET brain = ? WHERE org_id = ? AND user_id = ?', cli, p.org.id, p.user.id); }
  catch { throw new Unit7Error('brain_taken', 'Someone else on this Mac uses this one. Use an API key or your own AI.', 409); } // the unique index
}

// What the CLI is told. The rules are Unit7's MCP rules (minus the inbox loop: it already is the web app).
const BRIEF = `You are the AI in Unit7's web app, answering the person who signed in. You act only through the unit7 tools: there is no shell, no files and no web.
${INSTRUCTIONS.split('\n').filter((l) => !/inbox|End with a short summary/.test(l)).join('\n')}
In this chat:
- Reply in short, plain words a non-expert follows. Don't name tools or show JSON.
- Never ask for passwords, keys or tokens.
- Your last message is the answer the person reads.
${ASK_RULES}`;

function promptFor(app: App, conversationId: string, message: string, focus?: string) {
  // earlier turns of this conversation (text only); the newest row is this message
  const earlier = all<{ role: string; content: string }>(app.db, `SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user','assistant','ask') ORDER BY created_at DESC, rowid DESC LIMIT 13`, conversationId)
    .reverse().slice(0, -1).map((m) => [m.role === 'user' ? 'Person' : 'You', m.role === 'ask' ? askSummary(json(m.content, {})) : json<{ text?: string }>(m.content, {}).text ?? ''] as const).filter(([, t]) => t);
  return `${earlier.length ? `Earlier in this conversation:\n${earlier.map(([who, t]) => `${who}: ${t}`).join('\n\n')}\n\n` : ''}${focus ? `${focus}\n\n` : ''}The person says:\n${message}`;
}

// How each CLI is started. The token lives only in a 0600 file inside a 0700 run folder, deleted after the run.
function claudeRun(dir: string, url: string, token: string, bridge: string[], brief = BRIEF) {
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { unit7: { type: 'http', url, headers: { Authorization: `Bearer ${token}` }, timeout: MCP_WAIT_MS } } }), { mode: 0o600 });
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', // the reply streams in word by word
    '--tools', '',                                   // no built-in tools at all: no Bash, Edit, Write, Web…
    '--strict-mcp-config', '--mcp-config', config,   // and no MCP server but Unit7
    '--allowedTools', 'mcp__unit7',                  // Unit7's tools run without a prompt (Unit7 gates them itself)
    ...(bridge.length ? ['--disallowedTools', bridge.map((t) => `mcp__unit7__${t}`).join(',')] : []),
    '--permission-mode', 'dontAsk',                  // anything else is refused, never asked
    '--setting-sources', '', '--disable-slash-commands', // no user hooks, plugins or skills
    '--no-session-persistence', '--append-system-prompt', brief];
}

// One run's thread: text as it comes (one message growing word by word, at most ~10 updates a second), each tool
// call as a step, the last text marked final. An ask (ui.*) shows as its own card, so it gets no step.
const FLUSH_MS = 100;
function threadOf(emit: (m: AgentMessage) => void) {
  let open: AgentMessage | undefined, last: AgentMessage | undefined, streamed = false, timer: NodeJS.Timeout | undefined, sentAt = 0;
  const steps = new Map<string, AgentMessage>();
  const send = () => {
    clearTimeout(timer); timer = undefined;
    if (open?.content.text.trim()) { sentAt = Date.now(); emit(last = open); }
  };
  const t = {
    pending: [] as string[], failed: undefined as string | undefined, finished: false,
    // a piece of the reply: the open message grows (same id)
    delta(chunk: string) {
      if (!chunk) return;
      open = open ? { ...open, content: { text: open.content.text + chunk } } : { id: id('msg'), role: 'assistant', content: { text: chunk }, created_at: stamp() };
      streamed = true;
      const wait = FLUSH_MS - (Date.now() - sentAt);
      if (wait <= 0) send(); else timer ??= setTimeout(send, wait);
    },
    // a whole text block: it completes what streamed in, or is a message of its own
    text(full: string) {
      if (open && streamed) { open = { ...open, content: { text: full } }; send(); t.end(); return; }
      t.end();
      if (full.trim()) emit(last = { id: id('msg'), role: 'assistant', content: { text: full }, created_at: stamp() });
    },
    // whatever is still waiting to be shown goes out, and the next text starts a new message
    end() { if (timer) send(); open = undefined; streamed = false; },
    tool(callId: string, name: string, input: unknown) {
      t.end();
      const wired = name.replace(/^mcp_{1,2}unit7_{1,2}/, '');
      if (wired.startsWith('ui_')) return;
      const tool = allTools().find((x) => wire(x.name) === wired);
      const m: AgentMessage = { id: id('step'), role: 'tool', content: { tool: tool?.name ?? wired, title: tool?.title ?? wired, input, status: 'running' }, created_at: stamp() };
      steps.set(callId, m);
      emit(m);
    },
    result(callId: string, text: string, isError: boolean) {
      const m = steps.get(callId);
      if (!m) return;
      let r: any; try { r = JSON.parse(text); } catch { /* the CLI's own words */ }
      const outcome = r?.approvalRequired ? { status: 'approval_required', why: r.why, approvalId: r.approvalId, approvalState: 'pending' }
        : r?.denied ? { status: 'denied', error: r.why }
        : isError || r?.ok === false ? { status: 'error', error: String(r?.error ?? text).slice(0, 500), ...(typeof r?.code === 'string' && { code: r.code.slice(0, 60) }) } // code: the thread's choices come from it
        : { status: 'ok', output: r?.output ?? r?.plan ?? text };
      if (r?.approvalRequired) t.pending.push(r.approvalId);
      emit({ ...m, content: { ...m.content, ...outcome } });
    },
    done(answer?: string) {
      t.end();
      t.finished = true;
      if (last) emit({ ...last, content: { ...last.content, final: true } });
      else if (answer?.trim()) emit({ id: id('msg'), role: 'assistant', content: { text: answer, final: true }, created_at: stamp() });
    },
  };
  return t;
}
type Thread = ReturnType<typeof threadOf>;

const text = (c: any): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : '';
function claudeEvent(e: any, t: Thread) {
  if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') t.delta(e.event.delta.text ?? '');
  if (e.type === 'assistant') for (const b of e.message?.content ?? []) {
    if (b.type === 'text') t.text(b.text ?? '');
    if (b.type === 'tool_use') t.tool(b.id, b.name ?? '', b.input);
  }
  if (e.type === 'user') for (const b of e.message?.content ?? []) if (b.type === 'tool_result') t.result(b.tool_use_id, text(b.content), !!b.is_error);
  if (e.type === 'result') { if (e.is_error || e.subtype !== 'success') t.failed = String(e.result ?? e.subtype ?? 'unknown'); else t.done(e.result); }
}

// a CLI's failure as one plain sentence with the fix
function plainError(cli: CliId, why: string, code: number | null) {
  if (/not logged in|\/login|log ?in|sign ?in|auth|credential|oauth|\b40[13]\b|api key/i.test(why)) return CLIS[cli].signIn;
  if (/usage limit|rate limit|quota|\b429\b|too many requests/i.test(why)) return `${CLIS[cli].name} says your plan’s usage limit is reached. Try again later, or pick another AI.`;
  return `${CLIS[cli].name} stopped with a problem: ${why.trim().split('\n').slice(-3).join(' ').slice(0, 240) || `it exited with code ${code}`}`;
}

// One of Seven's shifts on the person's own Claude: only when they pressed Look now, never on a schedule. Its token reaches Seven's
// eyes and seven.finish and nothing else, so it can look and propose, exactly like a shift on an API key.
export async function thinkWithCli(app: App, p: Principal, o: { system: string; prompt: string; signal: AbortSignal; onText: (t: string) => void }) {
  const bin = cliBin('claude');
  if (!bin) throw new Error(CLIS.claude.missing);
  const token = createToken(app.db, p, 'Unit7 Seven · Claude', 'agent', 1 / 24, 'seven');
  mkdirSync(join(app.home, 'brain'), { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(app.home, 'brain', 'seven-')), url = `http://127.0.0.1:${(app.services.listen as { port?: number } | undefined)?.port ?? 4800}/mcp`;
  const child = spawn(bin, claudeRun(dir, url, token.token, [], o.system), { cwd: dir, env: childEnv({ MCP_TOOL_TIMEOUT: String(MCP_WAIT_MS) }), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const kill = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ } };
  o.signal.addEventListener('abort', kill);
  try {
    child.stdin!.on('error', () => { /* it quit before reading */ });
    child.stdin!.end(o.prompt);
    for await (const line of createInterface({ input: child.stdout! })) {
      let e: { type?: string; message?: { content?: { type: string; text?: string }[] } }; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'assistant') for (const b of e.message?.content ?? []) if (b.type === 'text' && b.text?.trim()) o.onText(b.text);
    }
  } finally {
    o.signal.removeEventListener('abort', kill);
    kill();
    revokeToken(app.db, p.org.id, p.user.id, token.id);
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface CliRun { app: App; p: Principal; cli: CliId; conversationId: string; message: string; emit: (m: AgentMessage) => void; focus?: string } // focus: what the chat is about

export async function runCli(o: CliRun): Promise<void> {
  const { app, p, cli, conversationId } = o;
  const emit = withNext(o.emit); // the reply's hidden next-reply line never shows; its options ride on the message (next.ts)
  const controller = new AbortController();
  running.set(conversationId, controller); // so isRunning / stopAgent work the same as for an API-key model
  const status = (tone: string, text: string) => emit({ id: id('msg'), role: 'status', content: { tone, text }, created_at: stamp() });
  let timer: NodeJS.Timeout | undefined;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort('timeout'), TIMEOUT_MS); };
  arm();
  let token: { id: string; token: string } | undefined, dir: string | undefined, child: ChildProcess | undefined, unbind = () => {};
  // the CLI and anything it started are one process group: stop, timeout and Unit7 quitting end all of it
  const kill = () => {
    const pid = child?.pid;
    if (!pid || child!.exitCode !== null || child!.signalCode !== null) return;
    try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
  };
  try {
    const bin = cliBin(cli);
    if (!bin) throw new Error(CLIS[cli].missing);
    // an agent acting for this person (someone who may only look stays look-only), revoked when the run ends
    token = createToken(app.db, p, CLIS[cli].token, p.role === 'readonly' || p.role === 'auditor' ? p.role : 'agent', RUN_MAX_MS / 86400_000);
    // ui.* calls with this token ask the person in this conversation; the clock stops while they decide
    unbind = bindRun(conversationId, { orgId: p.org.id, userId: p.user.id, emit, signal: controller.signal, tokenId: token.id, hold: (waiting) => (waiting ? clearTimeout(timer) : arm()) });
    mkdirSync(join(app.home, 'brain'), { recursive: true, mode: 0o700 });
    dir = mkdtempSync(join(app.home, 'brain', `${cli}-`));
    const url = `http://127.0.0.1:${(app.services.listen as { port?: number } | undefined)?.port ?? 4800}/mcp`;
    const bridge = allTools().filter((t) => t.name.startsWith('unit7.')).map((t) => wire(t.name)); // the inbox is for /unit7 watch, not this
    const prompt = promptFor(app, conversationId, o.message, o.focus);
    const args = claudeRun(dir, url, token.token, bridge);
    child = spawn(bin, args, { cwd: dir, env: childEnv({ MCP_TOOL_TIMEOUT: String(MCP_WAIT_MS) }), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    controller.signal.addEventListener('abort', kill);
    process.once('exit', kill);
    let stderr = '', spawnError: Error | undefined;
    const exited = new Promise<number | null>((r) => { child!.once('close', r); child!.once('error', (e) => { spawnError = e; r(null); }); });
    child.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdin!.on('error', () => { /* it quit before reading */ });
    child.stdin!.end(prompt); // the request goes on stdin, never in argv
    const t = threadOf(emit);
    for await (const line of createInterface({ input: child.stdout! })) {
      let e: unknown; try { e = JSON.parse(line); } catch { continue; }
      claudeEvent(e, t);
    }
    t.end();
    const code = await exited;
    if (controller.signal.aborted) status(controller.signal.reason === 'timeout' ? 'bad' : 'warn', controller.signal.reason === 'timeout' ? `${CLIS[cli].name} took more than 10 minutes, so I stopped it. Try a smaller step.` : 'Stopped.');
    else if (spawnError) status('bad', `${CLIS[cli].name} couldn’t start: ${spawnError.message}`);
    else if (t.failed || !t.finished) status('bad', plainError(cli, t.failed ?? stderr, code));
    else if (t.pending.length) status('warn', `Waiting for you to approve ${t.pending.length} action${t.pending.length > 1 ? 's' : ''} above before I can finish.`);
  } catch (e) {
    status('bad', (e as Error).message);
  } finally {
    unbind(); // closes what it still asks (which would re-arm the clock), so before the clock stops
    clearTimeout(timer);
    process.off('exit', kill);
    kill();
    if (token) revokeToken(app.db, p.org.id, p.user.id, token.id);
    if (dir) rmSync(dir, { recursive: true, force: true });
    running.delete(conversationId);
    run(app.db, 'UPDATE conversations SET updated_at = ? WHERE id = ?', now(), conversationId);
    app.events.emit(p.org.id, 'agent.done', 'Agent finished', { live: true, data: { conversationId } });
  }
}
