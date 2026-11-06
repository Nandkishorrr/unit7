// The ask box without an API key: your own Claude subscription (Claude Code)
// answers it. Unit7 runs the CLI once per request with only Unit7's tools. test/fake-cli.mjs plays both CLIs:
// it records how it was started and calls Unit7's real MCP endpoint with the token it was handed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { acceptInvite, createInvite, createToken } from '../src/auth.ts';
import { all, run } from '../src/db.ts';
import { escalate } from '../src/agent/escalate.ts';

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const tmp = mkdtempSync(join(tmpdir(), 'unit7-sub-'));
const RECORD = join(tmp, 'record.json');
const SIGNED_OUT = join(tmp, 'claude-signed-out.mjs'); // the same stand-in, saying it isn't signed in
copyFileSync(FAKE, SIGNED_OUT); chmodSync(SIGNED_OUT, 0o755);
Object.assign(process.env, {
  UNIT7_CLAUDE_BIN: FAKE, FAKE_CLI_RECORD: RECORD, FAKE_CLI_MODE: '',
  OLLAMA_URL: 'http://127.0.0.1:9/v1', // no local model "connected"
  UNIT7_TEST_SECRET: 'must-not-reach-the-cli',
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const BASE = 'http://localhost:4800';
async function setup() {
  resetRateLimits();
  rmSync(RECORD, { force: true });
  const app = testApp();
  const http = createHttp(app);
  // the CLI reaches Unit7's MCP endpoint over real HTTP, like on a person's Mac
  const server = await new Promise<ReturnType<typeof serve>>((r) => {
    const s = serve({ fetch: http.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { app.services.listen = { host: '127.0.0.1', port: info.port }; r(s); });
  });
  // a browser: its own session cookie plus the page's header
  const browser = () => {
    let cookie = '', bind = '';
    return async (method: string, path: string, body?: unknown, bearer?: string) => {
      const r = await http.fetch(new Request(`${BASE}${path}`, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : { origin: BASE, ...(cookie && { cookie, 'x-unit7-bind': bind }) }) } }));
      const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
      return { status: r.status, body: await r.json() as any };
    };
  };
  const sam = browser();
  await sam('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse battery' });
  const me = (await sam('GET', '/api/me')).body;
  return { app, sam, me, browser, close: () => server.close() };
}
type Web = Awaited<ReturnType<typeof setup>>['sam'];

// wait for the run to end, then return the thread
async function settle(web: Web, conversationId: string) {
  for (let i = 0; i < 200; i++) {
    const c = (await web('GET', `/api/agent/conversations/${conversationId}`)).body;
    if (!c.running) return c.messages as { role: string; content: any }[];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the run never finished');
}
const record = () => JSON.parse(readFileSync(RECORD, 'utf8'));
const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const rows = (app: any, sql: string) => all<Record<string, unknown>>(app.db, sql).map((r) => ({ ...r }));

test('your Claude subscription answers the box: request on stdin, only Unit7’s tools, no token in argv, config gone after', async () => {
  const { app, sam, close } = await setup();
  try {
    const st0 = (await sam('GET', '/api/agent/status')).body;
    assert.equal(st0.brain, null);
    assert.equal(st0.ready, false, 'no API model: without a brain the box would wait for your AI');
    assert.deepEqual(st0.brains.map((b: any) => [b.id, b.label, b.state]), [['claude', 'Claude · your subscription', 'ready']]);

    assert.equal((await sam('POST', '/api/agent/brain', { brain: 'claude' })).status, 200);
    const st = (await sam('GET', '/api/agent/status')).body;
    assert.equal(st.brain, 'claude');
    assert.equal(st.ready, true);
    assert.equal(st.mode, 'Claude · your subscription');

    const sent = (await sam('POST', '/api/agent/conversations', { message: 'What servers do I have?' })).body;
    assert.equal(sent.via, 'subscription');
    const thread = await settle(sam, sent.conversationId);
    const rec = record();

    // the request goes in on stdin; argv carries neither it nor a token
    assert.match(rec.stdin, /The person says:\nWhat servers do I have\?/);
    assert.ok(!rec.args.join(' ').includes('What servers'));
    assert.ok(!rec.args.join(' ').includes('unit7_pat_'));
    // no built-in tools, no MCP server but Unit7, nothing that could ask, none of the person's hooks or plugins
    assert.equal(arg(rec.args, '--tools'), '');
    assert.ok(rec.args.includes('--strict-mcp-config'));
    assert.equal(arg(rec.args, '--allowedTools'), 'mcp__unit7');
    assert.equal(arg(rec.args, '--permission-mode'), 'dontAsk');
    assert.equal(arg(rec.args, '--setting-sources'), '');
    assert.equal(arg(rec.args, '--output-format'), 'stream-json');
    assert.match(arg(rec.args, '--disallowedTools'), /mcp__unit7__unit7_inbox_next/);
    assert.match(arg(rec.args, '--append-system-prompt'), /Never ask for passwords, keys or tokens/);
    assert.deepEqual(Object.keys(rec.config.mcpServers), ['unit7']);
    assert.match(rec.config.mcpServers.unit7.headers.Authorization, /^Bearer unit7_pat_/);
    // afterwards: the token's file is gone, the token revoked; Unit7's own secrets never reached the CLI
    assert.equal(existsSync(rec.file), false);
    assert.deepEqual(rows(app, `SELECT name FROM api_tokens WHERE name LIKE 'Unit7 brain%'`), []);
    assert.ok(!rec.env.includes('UNIT7_TEST_SECRET'));

    // the same thread the web shows: narration, the step, the final answer marked final
    const said = thread.filter((m) => m.role !== 'user').map((m) => m.role === 'tool' ? `tool:${m.content.tool}:${m.content.status}` : `${m.role}:${m.content.text}${m.content.final ? ' (final)' : ''}`);
    assert.deepEqual(said, ['assistant:Checking your servers…', 'tool:graph.get:ok', 'assistant:You have no servers yet. (final)']);
    assert.deepEqual(thread.find((m) => m.role === 'tool')!.content.output, { servers: [], projects: [], foundProjects: [], accounts: [] });
    // the tool ran through Unit7's gate as an agent acting for Sam
    assert.deepEqual(rows(app, `SELECT tool, agent, user_id IS NOT NULL AS person FROM audit WHERE tool = 'graph.get'`), [{ tool: 'graph.get', agent: 'Unit7 brain · Claude', person: 1 }]);
  } finally { close(); }
});

test('Stop ends the CLI; a CLI that isn’t signed in becomes one plain sentence', async () => {
  const { app, sam, me, close } = await setup();
  try {
    await sam('POST', '/api/agent/brain', { brain: 'claude' });
    process.env.FAKE_CLI_MODE = 'hang';
    const sent = (await sam('POST', '/api/agent/conversations', { message: 'Deploy everything' })).body;
    for (let i = 0; i < 100 && !existsSync(RECORD); i++) await new Promise((r) => setTimeout(r, 50));
    const { pid } = record();
    assert.equal((await sam('GET', `/api/agent/conversations/${sent.conversationId}`)).body.running, true);
    await sam('POST', `/api/agent/conversations/${sent.conversationId}/stop`, {});
    const thread = await settle(sam, sent.conversationId);
    assert.equal(thread.at(-1)!.content.text, 'Stopped.');
    await new Promise((r) => setTimeout(r, 100));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the CLI process is gone');
    assert.deepEqual(rows(app, `SELECT name FROM api_tokens WHERE name LIKE 'Unit7 brain%'`), []);

    process.env.FAKE_CLI_MODE = 'signed-out';
    const again = (await sam('POST', '/api/agent/conversations', { message: 'hello', conversationId: sent.conversationId })).body;
    const t2 = await settle(sam, again.conversationId);
    assert.deepEqual(t2.at(-1)!.content, { tone: 'bad', text: 'Claude Code isn’t signed in: run `claude` once in Terminal.' });
    // the earlier turns go along with the next request
    assert.match(record().stdin, /Earlier in this conversation:\nPerson: Deploy everything/);

    // a signed-out Claude Code can't be turned on
    run(app.db, 'UPDATE memberships SET brain = NULL WHERE user_id = ?', me.user.id);
    process.env.UNIT7_CLAUDE_BIN = SIGNED_OUT;
    const st = (await sam('GET', '/api/agent/status')).body;
    assert.deepEqual(st.brains.find((b: any) => b.id === 'claude'), { id: 'claude', label: 'Claude · your subscription', state: 'sign-in', note: 'Sign in first: run `claude` once in Terminal.' });
    assert.equal((await sam('POST', '/api/agent/brain', { brain: 'claude' })).status, 409);
    process.env.UNIT7_CLAUDE_BIN = join(tmp, 'nowhere');
    assert.equal((await sam('GET', '/api/agent/status')).body.brains[0].state, 'not-installed');
  } finally { process.env.FAKE_CLI_MODE = ''; process.env.UNIT7_CLAUDE_BIN = FAKE; close(); }
});

test('a subscription is one person’s: not a teammate’s, not a token’s, not Warden’s', async () => {
  const { app, sam, me, browser, close } = await setup();
  try {
    assert.equal((await sam('POST', '/api/agent/brain', { brain: 'claude' })).status, 200);

    // a teammate on the same Unit7 can't use Sam's Claude
    const owner = { user: me.user, org: me.org, role: 'owner', via: 'session' } as any;
    await acceptInvite(app.db, createInvite(app.db, owner, 'teammate@example.com', 'developer'), { name: 'Teammate', password: 'correct horse battery' });
    const mate = browser();
    assert.equal((await mate('POST', '/api/auth/login', { email: 'teammate@example.com', password: 'correct horse battery' })).status, 200);
    const st = (await mate('GET', '/api/agent/status')).body;
    assert.equal(st.brain, null);
    assert.equal(st.brains.find((b: any) => b.id === 'claude').state, 'taken');
    const no = await mate('POST', '/api/agent/brain', { brain: 'claude' });
    assert.equal(no.status, 409);
    assert.match(no.body.error.message, /Use an API key or your own AI/);
    const sent = (await mate('POST', '/api/agent/conversations', { message: 'What servers do I have?' })).body;
    assert.equal(sent.via, 'rules', 'with no AI of their own they get the plain answer, not Sam’s');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(existsSync(RECORD), false, 'Sam’s CLI never ran for the teammate');

    // an API token (an AI) can't switch someone's subscription on
    const token = createToken(app.db, owner, 'some agent', 'agent').token;
    assert.equal((await sam('POST', '/api/agent/brain', { brain: 'claude' }, token)).status, 403);

    // Warden's incidents never go through a person's subscription
    assert.equal((await escalate(app, me.org.id, 'New error in web', 'Find the cause.')).via, 'your-ai');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(existsSync(RECORD), false);
    // and the brain's own token can't pull them from the inbox
    const brainToken = createToken(app.db, owner, 'Unit7 brain · Claude', 'agent').token;
    const r = await (await fetch(`http://127.0.0.1:${(app.services.listen as any).port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${brainToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unit7_inbox_next', arguments: { wait: false } } }) })).json() as any;
    assert.match(r.result.content[0].text, /answers its own thread only/);

    // Sam switches back to the org's model: Claude is free for whoever turns it on next
    assert.equal((await sam('POST', '/api/agent/brain', { brain: null })).status, 200);
    assert.equal((await mate('GET', '/api/agent/status')).body.brains[0].state, 'ready');
  } finally { close(); }
});

test('sign-in shows up by itself: Claude is asked again within seconds', async () => {
  const { sam, close } = await setup();
  const later = join(tmp, 'claude-later.mjs'); // its own stand-in, so nothing cached from other tests
  copyFileSync(FAKE, later); chmodSync(later, 0o755);
  const state = async (id: string) => (await sam('GET', '/api/agent/status')).body.brains.find((b: any) => b.id === id).state;
  try {
    process.env.UNIT7_CLAUDE_BIN = later;
    process.env.FAKE_CLI_SIGNED_OUT = '1';
    assert.equal(await state('claude'), 'sign-in');
    delete process.env.FAKE_CLI_SIGNED_OUT; // the person signs in from Terminal
    const t0 = Date.now();
    while (await state('claude') !== 'ready') { assert.ok(Date.now() - t0 < 6500, 'ready within a few seconds'); await new Promise((r) => setTimeout(r, 250)); }
  } finally {
    delete process.env.FAKE_CLI_SIGNED_OUT; process.env.UNIT7_CLAUDE_BIN = FAKE;
    close();
  }
});
