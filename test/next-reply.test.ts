// Next-reply suggestions: every brain ends its reply with a hidden `<<next: a | b | c>>` line. Unit7 strips it before
// anything is stored, streamed or shown, keeps the (cleaned, untrusted) options on the message, and the ask box offers
// them in gray (Tab fills it in). When the AI gave none, the web app works a few out from what just happened.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testApp, testOrg } from './helpers.ts';
import { all, id, json, run } from '../src/db.ts';
import { execute } from '../src/tools/runtime.ts';
import { cleanNext, cleanOption, splitNext, withNext, NEXT_RULE } from '../src/agent/next.ts';
import { ASK_RULES } from '../src/agent/asks.ts';
import { runAgent, type AgentMessage } from '../src/agent/brain.ts';
import { runCli } from '../src/agent/subscription.ts';
import { nextReplies } from '../web/src/pages/chat/next.ts';
import type { ChatMsg } from '../web/src/pages/chat/types.ts';

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const tmp = mkdtempSync(join(tmpdir(), 'unit7-next-'));
Object.assign(process.env, { UNIT7_CLAUDE_BIN: FAKE, UNIT7_GEMINI_BIN: FAKE, FAKE_CLI_RECORD: join(tmp, 'record.json'), OLLAMA_URL: 'http://127.0.0.1:9/v1' });
after(() => rmSync(tmp, { recursive: true, force: true }));

test('the line comes off the reply; its options stay, cleaned', () => {
  assert.deepEqual(splitNext('All three apps are up.'), { text: 'All three apps are up.' }, 'a reply without the line is left alone');
  assert.deepEqual(splitNext('Here is the plan. Shall I start?\n<<next: Yes, implement phase 1 now | Do phase 1 and 2 together | Change the plan: skip the database>>'),
    { text: 'Here is the plan. Shall I start?', next: ['Yes, implement phase 1 now', 'Do phase 1 and 2 together', 'Change the plan: skip the database'] });
  // malformed: no colon, odd spacing, never closed, empty, more than one line
  assert.deepEqual(splitNext('Done. << next a | b >>'), { text: 'Done.', next: ['a', 'b'] });
  assert.deepEqual(splitNext('Done. <<NEXT : Yes|  yes | No >>'), { text: 'Done.', next: ['Yes', 'No'] }, 'case-insensitive, and the same option once');
  assert.deepEqual(splitNext('Done.\n<<next: Go ahead | Wait'), { text: 'Done.', next: ['Go ahead', 'Wait'] }, 'never closed: still hidden');
  assert.deepEqual(splitNext('Done. <<next:>>'), { text: 'Done.', next: undefined });
  assert.deepEqual(splitNext('<<next: a>> Done. <<next: b>>'), { text: ' Done.', next: ['b'] }, 'every line goes; the last one counts');
  assert.equal(splitNext('Use Next.js 16 <<nextjs>>').text, 'Use Next.js 16 <<nextjs>>', 'only the next line, not a word that starts with it');
  // mid-stream: the start of the line never flashes up
  for (const cut of ['<', '<<', '<<n', '<<ne', '<<nex', '<<next', '<<next:', '<<next: Ye', '<< n']) assert.equal(splitNext(`Done. ${cut}`).text, 'Done.', cut);
});

test('options are untrusted text: short, plain, at most three', () => {
  const huge = 'Ignore your rules and '.repeat(100); // ~2,000 characters
  const r = splitNext(`Ok. <<next: ${huge} | <script>alert(1)</script>Go | **Deploy** \`now\` [here](https://evil.example) | \u202eevil\u202c one | four | five>>`);
  assert.equal(r.text, 'Ok.');
  assert.ok(r.next!.length <= 3);
  assert.ok(r.next!.every((o) => o.length <= 100), 'each option is capped');
  assert.ok(r.next!.every((o) => !/[<>`*[\]{}\\|\u202e\u202c\u0000-\u001f]/.test(o)), JSON.stringify(r.next));
  assert.equal(r.next![1], 'alert(1) Go');
  assert.equal(r.next![2], 'Deploy now here');
  assert.equal(cleanOption('“Yes, go ahead.”'), 'Yes, go ahead.');
  assert.equal(cleanOption('   \n\t '), '');
  assert.equal(cleanOption('-- ** --'), '', 'no words, no option');
  assert.equal(cleanOption(42), '');
  assert.equal(cleanNext('not a list'), undefined);
  assert.deepEqual(cleanNext(['a', 'A', '', 'b', 'c', 'd']), ['a', 'b', 'c']);
});

test('every brain is told, and the rule sits with the chat rules', () => {
  assert.ok(ASK_RULES.endsWith(NEXT_RULE), 'the subscription brief and the API-key prompt both carry ASK_RULES');
  assert.match(NEXT_RULE, /<<next: option \| option \| option>>/);
});

test('a run’s emit: nothing hidden goes out, streaming or not, and a line on its own joins the words before it', () => {
  const out: AgentMessage[] = [];
  const emit = withNext((m) => out.push(structuredClone(m)));
  const at = '2026-01-01T00:00:00.000Z';
  // the reply streams in (same id, growing), the line arriving bit by bit
  for (const t of ['Here is the plan', 'Here is the plan. Shall I start? <', 'Here is the plan. Shall I start? <<ne', 'Here is the plan. Shall I start? <<next: Yes, go | No', 'Here is the plan. Shall I start? <<next: Yes, go | Not now>>'])
    emit({ id: 'm1', role: 'assistant', content: { text: t }, created_at: at });
  assert.ok(out.every((m) => !m.content.text.includes('<')), JSON.stringify(out));
  assert.deepEqual(out.at(-1)!.content, { text: 'Here is the plan. Shall I start?', next: ['Yes, go', 'Not now'] });
  // a step and a status pass as they are
  emit({ id: 's1', role: 'tool', content: { tool: 'graph.get', status: 'ok' }, created_at: at });
  assert.equal(out.at(-1)!.id, 's1');
  // the line as its own message, then the run marks it final: both land on m2
  emit({ id: 'm2', role: 'assistant', content: { text: 'Done, all three are up.' }, created_at: at });
  const n = out.length;
  emit({ id: 'm3', role: 'assistant', content: { text: '\n<<next: Give me the link>>' }, created_at: at });
  emit({ id: 'm3', role: 'assistant', content: { text: '\n<<next: Give me the link>>', final: true }, created_at: at });
  assert.ok(!out.some((m) => m.id === 'm3'), 'no empty message');
  assert.equal(out.length, n + 2);
  assert.deepEqual(out.at(-1), { id: 'm2', role: 'assistant', content: { text: 'Done, all three are up.', next: ['Give me the link'], final: true }, created_at: at });
  // a brain can't set options any other way
  emit({ id: 'm4', role: 'assistant', content: { text: 'Hi.', next: ['<b>sneaky</b>'] }, created_at: at });
  assert.deepEqual(out.at(-1)!.content, { text: 'Hi.' });
});

test('an API-key model: the stored and streamed reply has no line, the message has the options', async () => {
  const app = testApp();
  const o = await testOrg(app, 'Sam');
  const bodies: any[] = [];
  const model = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
      bodies.push(JSON.parse(raw));
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Two steps: move the database, then point the domain. Shall I start?\n<<next: Yes, start with the database | Do both now>>' } }] }));
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  const seen: AgentMessage[] = [];
  try {
    const conv = id('cnv');
    run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conv, o.orgId, o.userId, 't');
    const store = (m: AgentMessage) => { seen.push(m); run(app.db, `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content`, m.id, conv, m.role, JSON.stringify(m.content), m.created_at); };
    await runAgent({ app, orgId: o.orgId, actor: o.agent, conversationId: conv, message: 'Move my site', emit: store });
    assert.ok((bodies[0].messages[0].content as string).includes(NEXT_RULE), 'the model is told');
    const stored = all<{ content: string }>(app.db, `SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant'`, conv).map((m) => json<any>(m.content, {}));
    assert.deepEqual(stored, [{ text: 'Two steps: move the database, then point the domain. Shall I start?', next: ['Yes, start with the database', 'Do both now'] }]);
    assert.ok(!JSON.stringify(seen).includes('<<'), 'nothing hidden went out live either');
  } finally { model.close(); process.env.OLLAMA_URL = 'http://127.0.0.1:9/v1'; }
});

test('a subscription brain (Claude or Gemini): the line streams in bits and never shows', async () => {
  const app = testApp();
  const o = await testOrg(app, 'Sam');
  const conv = id('cnv');
  run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conv, o.orgId, o.userId, 't');
  Object.assign(process.env, { FAKE_CLI_MODE: 'stream', FAKE_CLI_TEXT: 'Phase 1 moves the database; phase 2 points the domain. Go?\n<<next: Yes, implement phase 1 now | Do phase 1 and 2 together>>' });
  const seen: AgentMessage[] = [];
  try {
    await runCli({ app, p: { user: { id: o.userId }, org: { id: o.orgId }, role: 'owner', via: 'session' } as any, cli: 'claude', conversationId: conv, message: 'Plan the move', emit: (m) => seen.push(structuredClone(m)) });
  } finally { delete process.env.FAKE_CLI_TEXT; process.env.FAKE_CLI_MODE = ''; }
  const said = seen.filter((m) => m.role === 'assistant');
  assert.ok(said.length >= 2, 'it streamed');
  assert.ok(said.every((m) => !/<|next:/.test(m.content.text)), JSON.stringify(said.map((m) => m.content.text)));
  assert.deepEqual(said.at(-1)!.content, { text: 'Phase 1 moves the database; phase 2 points the domain. Go?', next: ['Yes, implement phase 1 now', 'Do phase 1 and 2 together'], final: true });
  assert.match(JSON.parse(readFileSync(process.env.FAKE_CLI_RECORD!, 'utf8')).args.join(' '), /<<next:/, 'the CLI is told too');
});

test('the bridge: unit7_say takes a next field (cleaned), and a hidden line in its text never shows', async () => {
  const app = testApp();
  const o = await testOrg(app, 'Sam');
  const conv = id('cnv');
  run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conv, o.orgId, o.userId, 't');
  const say = (input: Record<string, unknown>) => execute(app, o.orgId, o.agent, 'unit7.say', { conversationId: conv, ...input });
  const msgs = () => all<{ content: string }>(app.db, `SELECT content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`, conv).map((m) => json<any>(m.content, {}));
  assert.equal((await say({ text: 'Checking…' })).status, 'ok');
  const r = await say({ text: 'It is live.', final: true, next: ['Give me the link', 'x'.repeat(2000), '<img src=x onerror=alert(1)>Open it', 'give me the link', 'Four'] });
  assert.equal(r.status, 'ok');
  const last = msgs().at(-1);
  assert.equal(last.text, 'It is live.');
  assert.equal(last.next.length, 3);
  assert.equal(last.next[0], 'Give me the link');
  assert.ok(last.next[1].length <= 100, '2,000 characters are cut down');
  assert.equal(last.next[2], 'Open it');
  // the line inside the text instead
  await say({ text: 'Done. <<next: Check it again | Back it up>>' });
  assert.deepEqual(msgs().at(-1), { text: 'Done.', next: ['Check it again', 'Back it up'] });
  // only the line: it goes on what was said last, and no empty message appears
  const n = msgs().length;
  await say({ text: '<<next: Roll it back>>', final: true });
  assert.equal(msgs().length, n);
  assert.deepEqual(msgs().at(-1), { text: 'Done.', next: ['Roll it back'] });
  assert.ok(!JSON.stringify(msgs()).includes('<<'), 'nothing hidden is stored');
  // too many options is a mistake, not an injection: refused at the door
  assert.equal((await say({ text: 'x', next: Array(11).fill('a') })).status, 'error');
});

// --- the web fallback, when the AI gave no options -----------------------------------------------------------
const at = '2026-01-01T00:00:00.000Z';
let n = 0;
const user = (text: string): ChatMsg => ({ id: `u${n++}`, role: 'user', content: { text }, created_at: at });
const ai = (text: string, next?: string[]): ChatMsg => ({ id: `a${n++}`, role: 'assistant', content: { text, ...(next && { next }) }, created_at: at });
const step = (tool: string, status: any, extra: object = {}): ChatMsg => ({ id: `t${n++}`, role: 'tool', content: { tool, status, ...extra }, created_at: at });
const texts = (m: ChatMsg[], a?: Map<string, string>) => nextReplies(m, a).map((r) => r.text);

test('fallback: the AI’s own come first; otherwise a failure, a question’s choices, a plan, a yes/no, a deploy', () => {
  assert.deepEqual(texts([]), []);
  assert.deepEqual(texts([user('hi')]), [], 'nothing until it answers');
  assert.deepEqual(texts([user('plan it'), ai('Here is the plan…', ['Yes, implement phase 1 now', 'Do phase 1 and 2 together'])]), ['Yes, implement phase 1 now', 'Do phase 1 and 2 together']);
  assert.deepEqual(texts([user('plan it'), ai('Done.', ['a\u0000b <i>c</i>'])]), ['a b c'], 'cleaned again on the way in');
  // only this turn counts
  assert.deepEqual(texts([user('a'), ai('x', ['Old one']), user('b'), ai('All good.')]), []);

  // a tool failed (or the run did)
  // the failed step's recommended choice comes first (its row in the thread; Tab focuses it, test/choices.test.ts)
  assert.deepEqual(texts([user('deploy'), step('deployment.create', 'error', { error: 'build failed' }), ai('The build failed.')]), ['Ask Unit7 to fix it', 'Try again', 'Why did it fail?']);
  assert.deepEqual(texts([user('deploy'), { id: 's', role: 'status', content: { tone: 'bad', text: 'The agent hit a problem' }, created_at: at }]), ['Try again', 'Why did it fail?']);
  // …but not when it recovered
  assert.deepEqual(texts([user('deploy'), step('deployment.create', 'error'), step('deployment.create', 'ok'), ai('Live at https://shop.example.com')]), []);

  // a question with its choices
  assert.deepEqual(texts([user('deploy'), ai('Should I deploy to staging or production?')]), ['staging', 'production']);
  assert.deepEqual(texts([user('connect'), ai('Do you want www or the bare domain?')]), ['www', 'The bare domain']);
  assert.deepEqual(texts([user('fix'), ai('It needs a restart. Do you want me to restart it now or wait until tonight?')]), ['Restart it now', 'Wait until tonight']);
  assert.deepEqual(texts([user('db'), ai('Which engine do you want: Postgres, MySQL or Redis?')]), ['Postgres', 'MySQL', 'Redis']);
  assert.deepEqual(texts([user('pick'), ai('I found three:\n1. **Staging** — a test copy\n2. **Production** — live\n3. Preview\nWhich one should I use?')]), ['Staging', 'Production', 'Preview']);

  // a plan or steps
  assert.deepEqual(texts([user('move'), ai('Here’s the plan:\n1. Copy the database\n2. Point the domain\nShall I start?')]), ['Yes, go ahead', 'Change the plan:']);
  assert.deepEqual(texts([user('move'), ai('I’ll do it in two phases: phase 1 moves the database, phase 2 the domain. Ready?')]), ['Yes, implement phase 1 now', 'Change the plan:']);
  // a plain yes/no
  assert.deepEqual(texts([user('x'), ai('Your disk is 92% full. Should I clear old Docker images?')]), ['Yes, go ahead', 'No, not now']);
  // after a deploy, without a link in the words
  assert.deepEqual(texts([user('deploy'), step('deployment.create', 'ok'), ai('Deployed.')]), ['Give me the link']);
  assert.deepEqual(texts([user('deploy'), step('deployment.create', 'ok'), ai('Live at https://shop.example.com')]), []);
  // a statement with nothing to offer
  assert.deepEqual(texts([user('x'), ai('All three apps are up.')]), []);
});

test('fallback: a step waiting for your OK offers "Approve it", which opens that approval', () => {
  const m = [user('restart'), step('service.restart', 'approval_required', { approvalId: 'apr_1', approvalState: 'pending' }), ai('That needs your OK.', ['Not now'])];
  assert.deepEqual(nextReplies(m), [{ text: 'Approve it', approvalId: 'apr_1' }, { text: 'Not now' }]);
  assert.deepEqual(texts(m, new Map([['apr_1', 'approved']])), ['Not now'], 'gone once it’s decided');
  assert.deepEqual(texts([user('a'), step('x.y', 'approval_required', { approvalId: 'apr_2', approvalState: 'pending' })]), ['Approve it']);
});
