// "Click to connect Claude Code": one button per AI agent installed on this computer. You choose
// which AI works with Unit7; nothing is connected behind your back.
import { useState } from 'react';
import { Plug, Unplug, Terminal } from 'lucide-react';
import { api, useApi } from '../lib/api';
import { Button, CopyButton, Mono, Skeleton, cx, toast } from '../ui';
import { BrandLogo } from '../brand/BrandLogo';

export interface AgentInfo { id: string; name: string; installed: boolean; connected: boolean }
const RESTART: Record<string, string> = {
  'claude-code': 'Open a new Claude Code session, then type /unit7 and what you want.',
  antigravity: 'Restart Antigravity (or reload its MCP servers), then ask it to use Unit7.',
  cursor: 'Restart Cursor, then ask it to use Unit7.',
  windsurf: 'Restart Windsurf, then ask it to use Unit7.',
  'claude-desktop': 'Quit and reopen Claude Desktop, then ask it to use Unit7.',
  codex: 'Restart Codex, then ask it to use Unit7.',
  'gemini-cli': 'Restart Gemini CLI, then ask it to use Unit7.',
};

export async function connectAgent(id: string, connect = true): Promise<AgentInfo[] | undefined> {
  try {
    const r = await api<{ client: string; status: string; note?: string; agents: AgentInfo[] }>(`/api/agents/${id}/${connect ? 'connect' : 'disconnect'}`, { body: {} });
    if (connect && r.status === 'connected') toast('ok', `${r.client} is connected`, RESTART[id]);
    else if (!connect) toast('info', `${r.client} no longer uses Unit7`);
    else toast('warn', r.client, r.note);
    return r.agents;
  } catch (e) {
    toast('bad', 'Couldn’t do that', (e as Error).message);
    return undefined;
  }
}

export function AgentConnect({ compact }: { compact?: boolean }) {
  const res = useApi<{ local: boolean; agents: AgentInfo[]; hint?: string }>('/api/agents', { live: (e) => e.type.startsWith('agent.connect') || e.type.startsWith('agent.disconnect') });
  const [busy, setBusy] = useState<string | null>(null);
  if (!res.data) return <Skeleton className="h-24" />;
  if (!res.data.local) {
    return (
      <div className="space-y-2 text-[13px] text-muted">
        <p>{res.data.hint}</p>
        <div className="flex items-center gap-2 rounded-[14px] bg-raised px-3 py-2"><Terminal size={13} /><Mono className="flex-1 text-ink">unit7 connect</Mono><CopyButton text="unit7 connect" /></div>
      </div>
    );
  }
  const installed = res.data.agents.filter((a) => a.installed);
  if (!installed.length) return <p className="text-[13px] text-muted">No AI agents found on this computer. Install Claude Code or Antigravity, then come back.</p>;
  const toggle = async (a: AgentInfo) => { setBusy(a.id); await connectAgent(a.id, !a.connected); setBusy(null); res.reload(); };
  return (
    <div className={cx('grid gap-2', !compact && 'sm:grid-cols-2 xl:grid-cols-3')}>
      {installed.map((a) => (
        <div key={a.id} className={cx('flex items-center gap-3 rounded-[18px] border px-3 py-2.5 transition', a.connected ? 'border-ok/30 bg-ok/5' : 'border-line bg-surface')}>
          <AgentLogo id={a.id} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium">{a.name}</p>
            <p className={cx('truncate text-[12px]', a.connected ? 'text-ok' : 'text-muted')}>{a.connected ? '✓ Connected' : 'Not connected'}</p>
          </div>
          {a.connected
            ? <button disabled={busy === a.id} onClick={() => toggle(a)} title={`Disconnect ${a.name}`} aria-label={`Disconnect ${a.name}`} className="grid size-8 place-items-center rounded-full text-faint transition hover:bg-raised hover:text-bad"><Unplug size={14} /></button>
            : <Button size="sm" variant="primary" className="shrink-0" icon={<Plug size={12} />} loading={busy === a.id} onClick={() => toggle(a)}>Connect</Button>}
        </div>
      ))}
    </div>
  );
}

// each agent's own logo, on a soft tile
function AgentLogo({ id }: { id: string }) {
  return <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-raised"><BrandLogo id={id} size={20} /></span>;
}
