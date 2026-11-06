// Connect or disconnect ONE AI agent. Shared by `unit7 connect <agent>` and the web app's
// "Connect Claude Code" buttons, so both behave exactly the same: the agent gets its own key (the
// audit trail then says which AI acted), its MCP config gets a `unit7` entry, and disconnecting
// removes the entry and revokes the key.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DB, run } from '../db.ts';
import { createToken, type Principal } from '../auth.ts';
import { CLIENTS, CLAUDE_COMMAND, CLAUDE_COMMAND_FILE, refreshClaudeCommand, type Client, type Result } from './clients.ts';
import { Unit7Error } from '../errors.ts';

export const BIN = fileURLToPath(new URL('../../bin/unit7.mjs', import.meta.url));
export const TOKEN_PREFIX = 'Unit7 connect · ';

export interface AgentInfo { id: string; name: string; installed: boolean; connected: boolean }

export const agentList = (): AgentInfo[] => CLIENTS.map((c) => ({ id: c.id, name: c.name, installed: c.installed(), connected: c.installed() && c.connected() }));

function find(id: string): Client {
  const c = CLIENTS.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase() || x.id.startsWith(id.toLowerCase()));
  if (!c) throw new Unit7Error('unknown_agent', `Unit7 doesn't know an agent called "${id}". Try: ${CLIENTS.map((x) => x.id).join(', ')}.`, 404);
  return c;
}

export function connectAgent(db: DB, p: Principal, id: string, url: string, o: { findingsOnly?: boolean; profile?: string } = {}): Result {
  const c = find(id);
  if (!c.installed()) return { client: c.name, status: 'skipped', note: `${c.name} isn't installed on this computer` };
  // one key per agent: replace the old one instead of piling up
  run(db, 'DELETE FROM api_tokens WHERE org_id = ? AND user_id = ? AND name = ?', p.org.id, p.user.id, TOKEN_PREFIX + c.name);
  // findings only: it can ask what's wrong in production, and it holds no server, deploy or settings tools
  const scope = o.findingsOnly ? 'findings' : o.profile, token = createToken(db, p, TOKEN_PREFIX + c.name, scope === 'findings' || scope === 'read' ? 'readonly' : 'agent', undefined, scope).token;
  const r = c.connect({ url, token, stdio: { command: process.execPath, args: [BIN, 'mcp'], env: { UNIT7_URL: url, UNIT7_TOKEN: token } } });
  if (r.status !== 'connected') run(db, 'DELETE FROM api_tokens WHERE org_id = ? AND name = ?', p.org.id, TOKEN_PREFIX + c.name);
  else if (c.id === 'claude-code') { mkdirSync(dirname(CLAUDE_COMMAND_FILE), { recursive: true }); writeFileSync(CLAUDE_COMMAND_FILE, CLAUDE_COMMAND); refreshClaudeCommand(); }
  return r;
}

export function disconnectAgent(db: DB, p: Principal, id: string): Result {
  const c = find(id);
  const r = c.installed() ? c.disconnect() : { client: c.name, status: 'skipped' as const };
  run(db, 'DELETE FROM api_tokens WHERE org_id = ? AND name = ?', p.org.id, TOKEN_PREFIX + c.name);
  if (c.id === 'claude-code') { refreshClaudeCommand(); if (existsSync(CLAUDE_COMMAND_FILE)) unlinkSync(CLAUDE_COMMAND_FILE); }
  return r;
}
