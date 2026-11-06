// `unit7 agent "..."`: start an agent conversation and stream its narration to the terminal.
import { requireConfig } from './client.ts';

export async function askAgent(message: string) {
  const c = requireConfig();
  const status = await (await fetch(`${c.url}/api/agent/status`, { headers: { authorization: `Bearer ${c.token}` } })).json() as any;
  if (!status.ready) { console.error(`The agent isn't available: ${status.reason}`); process.exit(1); }
  const start = await fetch(`${c.url}/api/agent/conversations`, { method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
  const { conversationId } = await start.json() as any;
  if (!conversationId) { console.error('Could not start the agent.'); process.exit(1); }
  // poll the conversation until it stops running
  const seen = new Set<string>();
  for (;;) {
    const conv = await (await fetch(`${c.url}/api/agent/conversations/${conversationId}`, { headers: { authorization: `Bearer ${c.token}` } })).json() as any;
    for (const m of conv.messages) {
      if (seen.has(m.id) || m.role === 'user') continue;
      seen.add(m.id);
      if (m.role === 'assistant') console.log('\n' + m.content.text);
      else if (m.role === 'tool' && m.content.status !== 'running') console.log(`  • ${m.content.title} — ${m.content.status}`);
      else if (m.role === 'status') console.log(`\n(${m.content.text})`);
    }
    if (!conv.running) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
