// Asked to delete in the chat, the AI shows the Delete card (ui.delete) instead of "people only": Unit7's own facts
// (production runs, archive recommended or not), and the person's click does it. The AI only hears what they did, and
// "deleted" counts only once the project is really gone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { get, id, run } from '../src/db.ts';

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
const tmp = mkdtempSync(join(tmpdir(), 'unit7-delete-card-'));
Object.assign(process.env, { UNIT7_CLAUDE_BIN: FAKE, UNIT7_GEMINI_BIN: FAKE, FAKE_CLI_RECORD: join(tmp, 'record.json'), FAKE_CLI_MODE: '', GEMINI_CLI_HOME: tmp });
// a stand-in model: calls the tool it's told to, then answers with what the tool returned
let call: { name: string; arguments: object } = { name: 'ui_delete', arguments: {} };
const bodies: any[] = [];
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
    const b = JSON.parse(raw); bodies.push(b);
    const tool = b.messages.findLast((m: any) => m.role === 'tool');
    res.end(JSON.stringify({ choices: [{ message: tool ? { role: 'assistant', content: `Done: ${tool.content}` }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
process.env.OLLAMA_URL = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
after(() => { model.close(); rmSync(tmp, { recursive: true, force: true }); });

const BASE = 'http://localhost:4800';
const wait = async <T>(what: string, f: () => Promise<T | undefined>): Promise<T> => {
  for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`never: ${what}`);
};

test('the AI shows the Delete card; the person’s guided delete runs as them; the AI hears it’s gone', async () => {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  let cookie = '', bind = '';
  const sam = async (method: string, path: string, body?: unknown) => {
    const r = await http.fetch(new Request(`${BASE}${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', origin: BASE, ...(cookie && { cookie, 'x-unit7-bind': bind }) } }));
    const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
    return { status: r.status, body: await r.json() as any };
  };
  const tool = async (name: string, input: object = {}) => (await sam('POST', '/api/tools/' + name, { input })).body;
  await sam('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse battery' });
  const me = (await sam('GET', '/api/me')).body;
  const { projectId, environments } = (await tool('project.create', { name: 'harbor' })).output;
  const prodEnv = environments.find((e: any) => e.kind === 'production').id;
  const web = id('svc');
  run(app.db, `INSERT INTO services (id, org_id, project_id, environment_id, name, slug, kind, status) VALUES (?, ?, ?, ?, 'web', 'web', 'app', 'healthy')`, web, me.org.id, projectId, prodEnv);

  call = { name: 'ui_delete', arguments: { key: projectId } };
  const { conversationId } = (await sam('POST', '/api/agent/conversations', { message: 'delete harbor' })).body;
  const thread = async () => (await sam('GET', `/api/agent/conversations/${conversationId}`)).body as { running: boolean; messages: { id: string; role: string; content: any }[] };
  const ask = await wait('the Delete card', async () => (await thread()).messages.find((m) => m.role === 'ask' && m.content.state === 'waiting'));
  assert.deepEqual({ ...ask.content.spec }, { kind: 'delete', title: 'Delete harbor?', key: projectId, name: 'harbor', itemKind: 'project', provider: 'unit7', live: true, can: true, recommend: 'delete', stops: 1 },
    'Unit7’s own facts: production runs, so the delete stops it first');

  // saying "deleted" before it is doesn't count
  assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { outcome: 'deleted' })).status, 400);
  // the card's guided pop-up, as the person: stop production, then delete
  assert.equal((await tool('service.stop', { serviceId: web })).status, 'ok');
  assert.equal((await tool('asset.delete', { key: projectId, confirmName: 'harbor' })).status, 'ok');
  assert.equal((await sam('POST', `/api/agent/asks/${ask.id}`, { outcome: 'deleted' })).status, 200);
  await wait('the run to end', async () => { const t = await thread(); return t.running ? undefined : t; });
  const said = JSON.parse(bodies.at(-1).messages.findLast((m: any) => m.role === 'tool').content);
  assert.equal(said.outcome, 'deleted');
  assert.equal(get(app.db, 'SELECT 1 FROM projects WHERE id = ?', projectId), undefined);
});
