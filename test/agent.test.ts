// Unit7's own agent on a model source: a fake Ollama asks for one tool, Unit7 runs it through the
// gate, the model answers. Covers model discovery, the tools API shape and the loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testApp, testOrg } from './helpers.ts';
import { agentStatus, runAgent, toolSpecs, type AgentMessage } from '../src/agent/brain.ts';
import { id, run } from '../src/db.ts';

const app = testApp();
const bodies: any[] = [];
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-model' }] }));
    const b = JSON.parse(raw); bodies.push(b);
    const asked = b.messages.some((m: any) => m.role === 'tool');
    res.end(JSON.stringify({ choices: [{ message: asked
      ? { role: 'assistant', content: 'You have no projects yet.' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'project_list', arguments: '{}' } }] } }] }));
  });
});

test('agent: off with no model, then runs a tool on a connected model', async () => {
  process.env.OLLAMA_URL = 'http://127.0.0.1:9/v1'; // nothing listens there
  const org = await testOrg(app, 'Brain');
  assert.equal((await agentStatus(app, org.orgId)).ready, false);

  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  const st = await agentStatus(app, org.orgId);
  assert.equal(st.ready, true);
  assert.equal(st.model, 'ollama:mock-model');

  const conv = id('cnv');
  run(app.db, 'INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)', conv, org.orgId, org.userId, 't');
  const seen: AgentMessage[] = [];
  await runAgent({ app, orgId: org.orgId, actor: org.agent, conversationId: conv, message: 'what do I have?', emit: (m) => seen.push(m) });
  model.close();

  assert.ok(seen.some((m) => m.role === 'tool' && m.content.tool === 'project.list' && m.content.status === 'ok'));
  assert.equal(seen.at(-1)?.content.text, 'You have no projects yet.');
  assert.equal(bodies[0].model, 'mock-model');
  assert.ok(bodies[0].tools.every((t: any) => /^[A-Za-z0-9_-]{1,64}$/.test(t.function.name)));
});

test('tool schemas use only the JSON Schema subset every provider accepts', () => {
  const bad = JSON.stringify(toolSpecs()).match(/"(\$schema|additionalProperties|propertyNames|pattern|format|default|const)":/g);
  assert.equal(bad, null);
});
