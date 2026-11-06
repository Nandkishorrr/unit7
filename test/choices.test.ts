// Every decision as buttons (web/src/lib/choices.ts): two to four choices, exactly one recommended with its why, built
// only from actions Unit7 already has. Errors, findings, Map alerts, failed deploys and approvals; "Set it up" for
// what isn't set up yet and the Continue that follows; the recommended choice as the ask box's Tab suggestion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertActions } from '../web/src/lib/alertActions.ts';
import { approvalChoices, choicesFor, continueText, deployChoices, errorChoices, findingChoices, pick, recommendLine, setupHref, setupOf, stepChoices, type Choice } from '../web/src/lib/choices.ts';
import { nextStep } from '../web/src/lib/nextstep.ts';
import { nextReplies } from '../web/src/pages/chat/next.ts';
import type { ChatMsg } from '../web/src/pages/chat/types.ts';

// the shape every row must have: 1–4, labels unique, exactly one recommended (with a why), and every choice does something
function wellFormed(list: Choice[], what: string) {
  assert.ok(list.length >= 1 && list.length <= 4, `${what}: ${list.length} choices`);
  assert.equal(list.filter((c) => c.recommended).length, 1, `${what}: exactly one recommended`);
  assert.equal(new Set(list.map((c) => c.label.toLowerCase())).size, list.length, `${what}: no label twice`);
  for (const c of list) assert.ok(c.tool || c.ask || c.href || c.setup || c.steps || c.flow || c.key, `${what}: "${c.label}" does something`);
  assert.ok(list.find((c) => c.recommended)!.why, `${what}: the recommended one says why`);
}
const err = (code: string, message: string) => ({ status: 'error', error: { code, message } });

test('pick: at most four, one recommended (kept even when it came fifth), labels once', () => {
  const many = pick([{ label: 'A', key: 'a' }, { label: 'B', key: 'b' }, { label: 'a', key: 'dup' }, { label: 'C', key: 'c' }, { label: 'D', key: 'd' }, { label: 'E', key: 'e', recommended: true, why: 'it is best' }, false, null]);
  assert.deepEqual(many.map((c) => c.label), ['A', 'B', 'C', 'E']);
  assert.deepEqual(many.map((c) => !!c.recommended), [false, false, false, true]);
  assert.deepEqual(pick([{ label: 'One', key: '1', recommended: true }, { label: 'Two', key: '2', recommended: true }]).map((c) => !!c.recommended), [true, false]);
  assert.equal(pick([{ label: 'Only', key: 'x' }])[0]!.recommended, true, 'none marked: the first');
  assert.deepEqual(pick([]), []);
  assert.equal(recommendLine({ label: 'Set it up', why: 'this needs a server.' }), 'Recommended: Set it up because this needs a server.');
});

test('errors: the main kinds each get their row, the recommended one matching the one next step Unit7 already offers', () => {
  const at = { tool: 'deployment.create', input: { serviceId: 'svc_1', serverId: 'srv_1' } };
  const cases: [string, string, string][] = [
    ['network', 'socket hang up', 'Try again'],
    ['coolify_permission', 'The key can’t read values', 'Give permission'],
    ['account_paused', 'Vercel refused the token', 'Reconnect'],
    ['build_failed', 'npm run build exited 1', 'Ask Unit7 why'],
    ['unhealthy', 'It never answered its health check', 'Ask Unit7 why'],
  ];
  for (const [code, message, rec] of cases) {
    const list = errorChoices(err(code, message), at);
    wellFormed(list, code);
    assert.equal(list.find((c) => c.recommended)!.label, rec, code);
    const step = nextStep(err(code, message), at.input);
    if (step && step.kind !== 'ask' && step.kind !== 'retry') assert.equal(step.label, rec, `${code}: the same as the toast's next step`);
  }
  // Try again re-runs exactly what failed, as the person; never for Unit7's own answers
  assert.deepEqual(errorChoices(err('network', 'x'), at).find((c) => c.label === 'Try again'), { label: 'Try again', tool: 'deployment.create', input: { serviceId: 'svc_1', serverId: 'srv_1' }, why: 'it looks like a short hiccup, and nothing was changed', recommended: true });
  assert.ok(!errorChoices(err('build_failed', 'x'), {}).some((c) => c.tool), 'no tool known: nothing to re-run');
  // no page to open (no server known): Unit7's AI is recommended instead
  assert.equal(errorChoices(err('coolify_permission', 'x'), {}).find((c) => c.recommended)!.label, 'Ask Unit7 why');
  for (const code of ['invalid_input', 'forbidden', 'not_found', 'confirm_name']) assert.deepEqual(errorChoices(err(code, 'nope'), at), [], `${code}: no buttons`);
  // waiting for a person: the approvals, nothing else
  const wait = errorChoices({ status: 'approval_required', why: 'live' }, at);
  wellFormed(wait, 'approval');
  assert.deepEqual(wait.map((c) => c.href), ['/approvals']);
  assert.deepEqual(errorChoices({ status: 'ok' }), []);
  // one door: a result goes to the error rows
  assert.deepEqual(choicesFor(err('network', 'x'), at), errorChoices(err('network', 'x'), at));
});

test('not set up yet: "Set it up" is recommended, for the right thing, with a page outside the chat', () => {
  const cases: [string, string, unknown, object, string | undefined][] = [
    ['no_account', 'No vercel account is connected. Connect one in Connections (one click).', {}, { kind: 'account', provider: 'vercel' }, '/connections?connect=vercel'],
    ['no_account', 'staging has no netlify account. Connect one in Connections (one click).', {}, { kind: 'account', provider: 'netlify' }, '/connections?connect=netlify'],
    ['no_account', 'Connect your Hostinger account first (Connections → Hostinger), so Unit7 can check names and prices there.', {}, { kind: 'account', provider: 'hostinger' }, '/connections?connect=hostinger'],
    ['no_account', 'Connect Cloudflare first (free): Connections → Cloudflare.', {}, { kind: 'account', provider: 'cloudflare' }, '/connections?connect=cloudflare'],
    ['no_account', 'Connect GitHub so Unit7 can merge the fix.', {}, { kind: 'account', provider: 'github' }, '/connections?connect=github'],
    ['no_account', 'example.com’s DNS is at GoDaddy. Connect that account first.', {}, { kind: 'account', provider: 'godaddy' }, '/connections?connect=godaddy'],
    ['no_account', 'Set up phone alerts first (Connections → Phone alerts).', {}, { kind: 'phone' }, '/connections?connect=ntfy'],
    ['no_server', 'No prepared server yet. Connect one and run server.bootstrap, then deploy.', {}, { kind: 'server' }, '/servers?new=1'],
    ['no_domain', 'Spreading visitors with DNS needs a domain of shop’s own. Connect one first.', {}, { kind: 'domain' }, undefined],
    ['coolify_not_connected', 'Coolify on box isn’t connected yet.', { serverId: 'srv_1' }, { kind: 'coolify', serverId: 'srv_1' }, '/servers/srv_1#coolify-connect'],
    ['not_connected', 'Connect the app first, then wire it.', { serverId: 'srv_1' }, { kind: 'serverapp', serverId: 'srv_1' }, '/servers/srv_1/apps'],
    ['no_brain', '', {}, { kind: 'brain' }, '/'],
  ];
  for (const [code, message, input, setup, href] of cases) {
    assert.deepEqual(setupOf({ code, message }, input), setup, message || code);
    assert.equal(setupHref(setup as never), href, code);
    const list = errorChoices(err(code, message), { tool: 'domain.check', input });
    wellFormed(list, `${code} ${message}`);
    const rec = list.find((c) => c.recommended)!;
    assert.equal(rec.label, 'Set it up');
    assert.deepEqual(rec.setup, setup);
    assert.match(rec.why!, /isn’t set up yet/);
    assert.ok(list.some((c) => c.label === 'Try again'), 'and the task again, once it’s set up');
  }
  // an app that's just not on a server isn't "no server at all"
  assert.equal(setupOf({ code: 'no_server', message: 'shop isn’t on a server.' }), undefined);
  assert.equal(setupOf({ code: 'build_failed', message: 'No vercel account' }), undefined);
  // Continue: the person's words that carry the task on (no AI picked yet: the request itself, again)
  assert.equal(continueText({ kind: 'account', provider: 'vercel' }), 'I’ve connected Vercel. Carry on where you left off.');
  assert.equal(continueText({ kind: 'server' }), 'I’ve connected a server. Carry on where you left off.');
  assert.equal(continueText({ kind: 'phone' }), 'Phone alerts are set up. Carry on where you left off.');
  assert.equal(continueText({ kind: 'brain' }, 'deploy my app'), 'deploy my app');
  // the chat thread's failed step, with the code the server kept
  const step = stepChoices({ tool: 'database.create', input: {}, status: 'error', error: 'No prepared server. Connect one and run server.bootstrap first.', code: 'no_server' });
  assert.equal(step.find((c) => c.recommended)!.setup?.kind, 'server');
  assert.deepEqual(stepChoices({ tool: 'x', status: 'ok' }), []);
});

test('findings: the fix, its other ways, check again and by hand; people-only marked; never more than four', () => {
  const tool = { id: 'xray:no-backup:shop-db', title: 'shop-db has no backups', severity: 'high', by: 'unit7', serverId: 'srv_1',
    fix: { tool: 'part.backup_schedule', input: { serverId: 'srv_1', part: 'shop-db' }, label: 'Back it up every day', change: 'Backs it up now and every day', safe: true,
      byHand: ['Open Coolify', 'Turn on backups'], alt: [{ tool: 'coolify.backup', input: { serverId: 'srv_1' }, label: 'Use Coolify’s backups', change: 'Coolify backs it up' }, { tool: 'x.y', input: {}, label: 'A third way', change: '' }] } };
  const list = findingChoices(tool);
  wellFormed(list, 'tool fix');
  assert.deepEqual(list.map((c) => c.label), ['Back it up every day', 'Use Coolify’s backups', 'A third way', 'Check again']);
  assert.equal(list[0]!.recommended, true);
  assert.equal(list[0]!.risk, 'safe');
  assert.deepEqual(list[3], { label: 'Check again', tool: 'alert.recheck', input: { key: 'xray:no-backup:shop-db', serverId: 'srv_1' }, look: true, key: 'check', why: 'it runs the check behind this again, read-only', recommended: false });
  // with room, by hand is offered too, and it's a person's
  const hand = findingChoices({ ...tool, fix: { ...tool.fix, alt: [] } });
  assert.deepEqual(hand.find((c) => c.label === 'Do it by hand'), { label: 'Do it by hand', steps: ['Open Coolify', 'Turn on backups'], peopleOnly: true, recommended: false });
  // hard to undo: the name gets typed first (not a hold), and the why says so
  const typed = findingChoices({ ...tool, fix: { tool: 'part.remove', input: {}, label: 'Remove it', change: 'Moves it to the trash', typeName: 'shop-db' } });
  assert.equal(typed[0]!.typeName, 'shop-db');
  assert.equal(typed[0]!.risk, 'danger');
  assert.match(typed[0]!.why!, /type the name/);
  // an AI's look, a person's steps, a guided pop-up, and nothing at all
  const ask = findingChoices({ id: 'f1', title: 'Odd logins', severity: 'medium', fix: { manual: ['Check the users'], ask: 'Look at who signed in', label: 'Ask Unit7' } });
  wellFormed(ask, 'ask fix');
  assert.equal(ask[0]!.ask, 'Look at who signed in');
  assert.equal(ask.find((c) => c.steps)?.peopleOnly, true);
  const manual = findingChoices({ id: 'f2', title: 'Renew the domain', severity: 'low', by: 'ai', fix: { manual: ['Open your registrar'], href: 'https://example.com/renew' } });
  wellFormed(manual, 'manual');
  assert.equal(manual[0]!.peopleOnly, true);
  assert.ok(!manual.some((c) => c.key === 'check'), 'an AI’s finding has no check behind it');
  const flow = findingChoices({ id: 'f3', title: 'Coolify’s dashboard is open', severity: 'high', fix: { manual: [], label: 'Give it a domain', flow: { kind: 'coolify-domain', serverId: 'srv_1' } } });
  assert.deepEqual(flow[0]!.flow, { kind: 'coolify-domain', serverId: 'srv_1' });
  const none = findingChoices({ id: 'f4', title: 'Something is slow', detail: 'Pages take 4 s.', severity: 'medium' });
  wellFormed(none, 'no fix');
  assert.match(none[0]!.ask!, /^Something is slow\. Pages take 4 s\. Fix it for me/);
  // no invented actions: every tool is the finding's own (or the read-only check)
  for (const c of list) assert.ok(!c.tool || ['part.backup_schedule', 'coolify.backup', 'x.y', 'alert.recheck'].includes(c.tool));
  assert.deepEqual(choicesFor(tool), list, 'one door');
});

test('Map alerts: the fixes, the page, Check again and Ask, with the first real fix recommended', () => {
  const a = { text: 'shop.example.com doesn’t answer', fix: { tool: 'server.routes', input: { host: 'shop.example.com' }, label: 'Find the old route', look: true } };
  const list = choicesFor(a);
  wellFormed(list, 'alert');
  assert.deepEqual(list.map((c) => [c.key, c.label, !!c.recommended]), [['fix:0', 'Find the old route', true], ['check', 'Check again', false], ['ask', 'Ask Unit7 to fix it', false]]);
  assert.match(list[0]!.why!, /only looks/);
  const plain = choicesFor({ text: 'example.com has no email protection' });
  assert.deepEqual(plain.map((c) => [c.key, !!c.recommended]), [['check', false], ['ask', true]]);
  assert.equal(list.length, alertActions(a).length, 'one button per action Unit7 already offers, nothing added');
});

test('a failed deploy and an approval', () => {
  const d = deployChoices({ serviceId: 'svc_1', error: 'tests failed: 2 of 40', step: 'test', service: 'shop', number: 7, href: '/services/svc_1' });
  wellFormed(d, 'deploy');
  assert.deepEqual(d.map((c) => c.label), ['Ask Unit7 to fix it', 'Deploy again', 'Deploy anyway', 'See the log']);
  assert.match(d[0]!.ask!, /^The test step of deploy v7 of shop failed: tests failed/);
  const anyway = d.find((c) => c.label === 'Deploy anyway')!;
  assert.deepEqual([anyway.risk, anyway.peopleOnly, anyway.input], ['danger', true, { serviceId: 'svc_1', skipTests: true }]);
  assert.ok(!deployChoices({ serviceId: 'svc_1', step: 'build' }).some((c) => c.label === 'Deploy anyway'), 'skipping tests only when the tests stopped it');
  wellFormed(deployChoices({}), 'deploy with nothing known');

  const safe = approvalChoices({ tier: 2, why: 'This changes something live, so a person approves it first' });
  wellFormed(safe, 'safe approval');
  assert.deepEqual(safe.map((c) => [c.key, !!c.recommended]), [['approve', true], ['reject', false]]);
  const hard = approvalChoices({ why: 'This is hard to undo, so a person approves it first (Unit7 takes a fresh backup before it runs).' });
  wellFormed(hard, 'hard approval');
  assert.deepEqual(hard.map((c) => [c.key, !!c.recommended]), [['review', true], ['approve', false], ['reject', false]]);
  assert.equal(hard.find((c) => c.key === 'approve')!.risk, 'danger');
  assert.equal(approvalChoices({ tier: 3 })[0]!.key, 'review');
});

test('the recommended choice is the ask box’s Tab suggestion: a failed step’s, or a pick the AI marked', () => {
  const at = '2026-10-08T10:00:00.000Z';
  const turn = (...m: ChatMsg[]): ChatMsg[] => [{ id: 'u1', role: 'user', content: { text: 'add a database' }, created_at: at }, ...m];
  const failed: ChatMsg = { id: 'step_1', role: 'tool', content: { tool: 'database.create', status: 'error', error: 'No prepared server. Connect one and run server.bootstrap first.', code: 'no_server' }, created_at: at };
  const first = nextReplies(turn(failed))[0]!;
  assert.deepEqual(first, { text: 'Set it up', choiceOf: 'step_1' });
  const ask: ChatMsg = { id: 'ask_1', role: 'ask', created_at: at, content: { askId: 'ask_1', state: 'waiting', spec: { kind: 'choose', title: 'Which engine?', options: [
    { id: 'pg', label: 'Postgres', recommended: true, why: 'it fits most apps' }, { id: 'my', label: 'MySQL' }] } } };
  assert.deepEqual(nextReplies(turn(ask))[0], { text: 'Postgres', choiceOf: 'ask_1' });
  // answered, or nothing marked: no suggestion from it
  assert.ok(!nextReplies(turn({ ...ask, content: { ...ask.content, state: 'answered' } } as ChatMsg)).some((n) => n.choiceOf));
  // the AI's own next replies still come after it
  const said: ChatMsg = { id: 'm1', role: 'assistant', content: { text: 'It needs a server first.', next: ['Connect my server'] }, created_at: at };
  assert.deepEqual(nextReplies(turn(failed, said)).map((n) => n.text), ['Set it up', 'Connect my server']);
});

// --- the server side: ui.choose's recommended/why survive the round trip; a failed step keeps its code; the brief says it
import { after } from 'node:test';
import { createServer } from 'node:http';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { ASK_RULES } from '../src/agent/asks.ts';
import { INSTRUCTIONS } from '../src/mcp/server.ts';

let call: { name: string; arguments: object } = { name: 'ui_choose', arguments: {} };
const bodies: any[] = [];
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
    const b = JSON.parse(raw); bodies.push(b);
    const tool = b.messages.findLast((m: any) => m.role === 'tool');
    res.end(JSON.stringify({ choices: [{ message: tool ? { role: 'assistant', content: 'Done.' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
process.env.OLLAMA_URL = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
after(() => model.close());

async function chat() {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  let cookie = '', bind = '';
  const web = async (method: string, path: string, body?: unknown) => {
    const r = await http.fetch(new Request(`http://localhost:4800${path}`, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', origin: 'http://localhost:4800', ...(cookie && { cookie, 'x-unit7-bind': bind }) } }));
    const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
    return { status: r.status, body: await r.json() as any };
  };
  await web('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse battery' });
  const wait = async <T>(f: () => Promise<T | undefined>): Promise<T> => { for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('never'); };
  const thread = async (c: string) => (await web('GET', `/api/agent/conversations/${c}`)).body as { running: boolean; messages: { id: string; role: string; content: any }[] };
  return { web, wait, thread };
}

test('ui.choose: the recommended option and its why reach the card, and the pick goes back to the AI', async () => {
  const { web, wait, thread } = await chat();
  const options = [{ id: 'cache', label: 'Cache the static files', recommended: true, why: 'it’s the biggest win' }, { id: 'scale', label: 'Run a second copy' }, { id: 'later', label: 'Not now' }];
  call = { name: 'ui_choose', arguments: { title: 'How should I speed it up?', options } };
  const c = (await web('POST', '/api/agent/conversations', { message: 'speed up example.com' })).body.conversationId;
  const ask = await wait(async () => (await thread(c)).messages.find((m) => m.role === 'ask' && m.content.state === 'waiting'));
  assert.deepEqual(ask.content.spec.options, options, 'stored as the AI sent it');
  // the Tab suggestion is the recommended one
  assert.deepEqual(nextReplies((await thread(c)).messages as ChatMsg[])[0], { text: 'Cache the static files', choiceOf: ask.id });
  assert.equal((await web('POST', `/api/agent/asks/${ask.id}`, { choice: ['cache'] })).status, 200);
  await wait(async () => ((await thread(c)).running ? undefined : true));
  assert.deepEqual(JSON.parse(bodies.at(-1).messages.findLast((m: any) => m.role === 'tool').content), { choice: ['cache'], labels: ['Cache the static files'] });
  // the AI is told about recommended and why (the tool's schema and description)
  const tools = bodies.at(-1).tools.map((t: any) => t.function);
  const choose = tools.find((t: any) => t.name === 'ui_choose');
  assert.ok(choose.parameters.properties.options.items.properties.recommended && choose.parameters.properties.options.items.properties.why);
  assert.match(choose.description, /exactly one recommended/);
});

test('a failed step keeps its code, so the thread shows "Set it up" by itself; the brief says to offer choices', async () => {
  const { web, wait, thread } = await chat();
  call = { name: 'domain_ideas', arguments: { name: 'shop' } };
  const c = (await web('POST', '/api/agent/conversations', { message: 'find me a domain for my shop' })).body.conversationId;
  const msgs = await wait(async () => { const t = await thread(c); return t.running ? undefined : t.messages; });
  const step = msgs.find((m) => m.role === 'tool')!;
  assert.equal(step.content.status, 'error');
  assert.equal(step.content.code, 'no_account');
  const rec = stepChoices(step.content).find((x) => x.recommended)!;
  assert.deepEqual([rec.label, rec.setup], ['Set it up', { kind: 'account', provider: 'hostinger' }]);
  assert.equal(nextReplies(msgs as ChatMsg[])[0]!.text, 'Set it up');
  // the rule every brain gets (the API-key prompt and the subscription brief share ASK_RULES; MCP clients get INSTRUCTIONS)
  for (const brief of [ASK_RULES, INSTRUCTIONS]) {
    assert.match(brief, /offer 2–4 choices with ui_choose[^,]{0,30}, mark exactly one recommended with a short why/);
    assert.match(brief, /Never ask them to type a command Unit7 can run/);
  }
});
