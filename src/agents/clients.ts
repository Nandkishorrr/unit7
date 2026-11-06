// Every AI agent `unit7 connect` knows how to wire up, and where each keeps its MCP config. Paths
// come from what these apps actually write on disk. A client is only touched if it's installed
// (its config folder exists), every file is backed up once before the first change, and only the
// `unit7` entry (and the old `forge` one it replaces) is ever added or removed — nothing else changes.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

export interface StdioEntry { command: string; args: string[]; env: Record<string, string> }
export interface Target { url: string; token: string; stdio: StdioEntry }
export type Result = { client: string; status: 'connected' | 'skipped' | 'failed' | 'removed'; where?: string; note?: string };

const H = homedir();
// the name each app lists us under; LEGACY is the old name, removed whenever we write the new one
export const SERVER = 'unit7';
const LEGACY = 'forge';
const mac = platform() === 'darwin';

// These files end up holding a Unit7 token, so only their owner may read them (an existing file keeps its
// mode on write, hence the chmod).
function writePrivate(file: string, text: string) { writeFileSync(file, text, { mode: 0o600 }); chmodSync(file, 0o600); }

function backupOnce(file: string) {
  const bak = `${file}.bak-unit7`;
  if (existsSync(file) && !existsSync(bak)) { copyFileSync(file, bak); chmodSync(bak, 0o600); }
}

// read a JSON config; refuse to touch a file we can't parse (never clobber someone's settings)
function readJson(file: string): Record<string, any> | 'unparseable' {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return 'unparseable'; }
}

function setJsonServer(file: string, entry: unknown | undefined): 'ok' | 'unparseable' {
  const cfg = readJson(file);
  if (cfg === 'unparseable') return 'unparseable';
  backupOnce(file);
  cfg.mcpServers ??= {};
  delete cfg.mcpServers[LEGACY];
  if (entry === undefined) delete cfg.mcpServers[SERVER]; else cfg.mcpServers[SERVER] = entry;
  mkdirSync(dirname(file), { recursive: true });
  writePrivate(file, JSON.stringify(cfg, null, 2) + '\n');
  return 'ok';
}

export interface Client {
  id: string;            // stable slug: claude-code, antigravity, cursor…
  name: string;
  installed(): boolean;
  connected(): boolean;  // does its config already point at Unit7 (under either name)?
  connect(t: Target): Result;
  disconnect(): Result;
}

const listed = (c: Record<string, any> | 'unparseable') => c !== 'unparseable' && !!(c.mcpServers?.[SERVER] ?? c.mcpServers?.[LEGACY]);
const hasUnit7 = (file: string) => listed(readJson(file));

// JSON-file clients that take the standard { command, args, env } stdio entry
function jsonClient(id: string, name: string, files: string[], note?: string): Client {
  const present = () => files.filter((f) => existsSync(dirname(f)));
  return {
    id, name,
    installed: () => present().length > 0,
    connected: () => present().some(hasUnit7),
    connect(t) {
      const done: string[] = [];
      const bad: string[] = [];
      for (const f of present()) (setJsonServer(f, t.stdio) === 'ok' ? done : bad).push(f.replace(H, '~'));
      if (!done.length) return { client: name, status: 'failed', note: `couldn't read ${bad.join(', ')} (left untouched)` };
      return { client: name, status: 'connected', where: done.join(', '), note: bad.length ? `skipped unreadable ${bad.join(', ')}` : note };
    },
    disconnect() {
      const done = present().filter((f) => setJsonServer(f, undefined) === 'ok');
      return { client: name, status: done.length ? 'removed' : 'skipped' };
    },
  };
}

export function claudeBin(): string | undefined {
  for (const c of [join(H, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(H, '.claude', 'local', 'claude')]) if (existsSync(c)) return c;
  try { return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; }
}
const claudeCode: Client = {
  id: 'claude-code',
  name: 'Claude Code',
  installed: () => !!claudeBin(),
  connected: () => listed(readJson(join(H, '.claude.json'))),
  connect(t) {
    for (const n of [LEGACY, SERVER]) try { execFileSync(claudeBin() ?? 'claude', ['mcp', 'remove', n, '-s', 'user'], { stdio: 'ignore' }); } catch { /* wasn't there */ }
    try {
      execFileSync(claudeBin() ?? 'claude', ['mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER, `${t.url}/mcp`, '--header', `Authorization: Bearer ${t.token}`], { stdio: 'ignore' });
      return { client: 'Claude Code', status: 'connected', where: 'user MCP config + /unit7 command', note: 'open a new session to load it' };
    } catch (e) {
      return { client: 'Claude Code', status: 'failed', note: (e as Error).message.split('\n')[0] };
    }
  },
  disconnect() {
    let removed = false;
    for (const n of [LEGACY, SERVER]) try { execFileSync(claudeBin() ?? 'claude', ['mcp', 'remove', n, '-s', 'user'], { stdio: 'ignore' }); removed = true; } catch { /* wasn't there */ }
    return { client: 'Claude Code', status: removed ? 'removed' : 'skipped' };
  },
};

// Codex keeps MCP servers in TOML: [mcp_servers.unit7] + [mcp_servers.unit7.env]
const codexFile = join(H, '.codex', 'config.toml');
function stripTomlUnit7(text: string) {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (header) skipping = [SERVER, LEGACY].some((n) => header === `mcp_servers.${n}` || header.startsWith(`mcp_servers.${n}.`));
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
const codex: Client = {
  id: 'codex',
  name: 'Codex',
  installed: () => existsSync(dirname(codexFile)),
  connected: () => existsSync(codexFile) && /^\s*\[mcp_servers\.(unit7|forge)\]/m.test(readFileSync(codexFile, 'utf8')),
  connect(t) {
    backupOnce(codexFile);
    const base = existsSync(codexFile) ? stripTomlUnit7(readFileSync(codexFile, 'utf8')) : '';
    const q = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string
    const block = `\n[mcp_servers.${SERVER}]\ncommand = ${q(t.stdio.command)}\nargs = [${t.stdio.args.map(q).join(', ')}]\n\n[mcp_servers.${SERVER}.env]\n${Object.entries(t.stdio.env).map(([k, v]) => `${k} = ${q(v)}`).join('\n')}\n`;
    writePrivate(codexFile, base + block);
    return { client: 'Codex', status: 'connected', where: '~/.codex/config.toml' };
  },
  disconnect() {
    if (!existsSync(codexFile)) return { client: 'Codex', status: 'skipped' };
    writePrivate(codexFile, stripTomlUnit7(readFileSync(codexFile, 'utf8')));
    return { client: 'Codex', status: 'removed' };
  },
};

export const CLIENTS: Client[] = [
  claudeCode,
  jsonClient('antigravity', 'Antigravity', [
    join(H, '.gemini', 'antigravity', 'mcp_config.json'),
    join(H, '.gemini', 'antigravity-ide', 'mcp', 'mcp_config.json'),
    join(H, '.gemini', 'config', 'mcp_config.json'),
  ], 'reload MCP servers in Antigravity (or restart it)'),
  jsonClient('cursor', 'Cursor', [join(H, '.cursor', 'mcp.json')], 'restart Cursor'),
  jsonClient('windsurf', 'Windsurf', [join(H, '.codeium', 'windsurf', 'mcp_config.json')], 'restart Windsurf'),
  jsonClient('claude-desktop', 'Claude Desktop', [mac ? join(H, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : join(H, '.config', 'Claude', 'claude_desktop_config.json')], 'quit and reopen Claude Desktop (if it was open, it can overwrite the change: connect again after it restarts)'),
  jsonClient('gemini-cli', 'Gemini CLI', existsSync(join(H, '.gemini', 'settings.json')) ? [join(H, '.gemini', 'settings.json')] : []),
  codex,
];

// The /unit7 slash command for Claude Code: type `/unit7 <anything>` and it works through Unit7.
export const CLAUDE_COMMAND_FILE = join(H, '.claude', 'commands', 'unit7.md');
// the old /forge command, replaced by /unit7 when it's one we wrote
export const LEGACY_COMMAND_FILE = join(H, '.claude', 'commands', 'forge.md');
const ours = (text: string) => /forge|unit7/.test(text) && /graph_get/.test(text);
export const CLAUDE_COMMAND = `---
description: Ask Unit7 to run your infrastructure, or "watch" to answer what you type in Unit7's web app
argument-hint: what you want ("deploy this folder", "why is my site slow?"), or "watch"
---
Request: $ARGUMENTS

## If the request is exactly "watch"
You are now Unit7's brain: you answer what I type in Unit7's web app, using my own Claude Code (no API key needed). Loop:
1. Call \`unit7_inbox_next\`. If it returns {empty:true}, call it again right away (it waits about 25 seconds each time).
2. When it returns {conversationId, message}: do what the message asks with the unit7 tools (rules below). While you work, post short plain-English updates with \`unit7_say\` (conversationId, text). When you're done, post the answer with \`unit7_say\` and final=true.
3. Go back to step 1. Keep looping until I stop you. Don't stop after one request.

## Otherwise, do the request now
0. Call \`unit7_thread\` with my request so this conversation also shows in Unit7's web app. Post updates and the final answer to it with \`unit7_say\` (final=true at the end).

## Rules (Unit7 does the heavy lifting, so keep it simple)
1. Call \`graph_get\` first to see the servers, projects, apps, databases and domains that already exist. Reuse them.
2. Pick the one tool that does the job (deployment_create, database_create, domain_point, server_connect, server_bootstrap, deployment_rollback, server_harden, backup_create, server_diagnose, server_repair...). Prefer specific tools over \`server_exec\`.
3. If a server isn't answering, call \`server_diagnose\`, tell me the cause in one sentence, and apply its fix with \`server_repair\` when the fix is safe.
4. To deploy the folder I'm in: create a project + service if needed, then upload with the terminal command \`unit7 deploy --service <serviceId>\` (it packs and uploads this folder).
5. If a result says \`approvalRequired\`, tell me what is waiting and that I can approve it in Unit7 (Approvals page). Don't retry it.
6. Never ask me to paste a secret. Credentials are references like credential://provider/account/name.
7. Finish with a short summary: what you found, what you did, the result (with the URL if there is one).
`;

// Keep an installed /unit7 command current: rewritten when Unit7 starts, only if Unit7 wrote it. An old
// /forge command we wrote becomes /unit7.
export function refreshClaudeCommand() {
  try {
    if (existsSync(LEGACY_COMMAND_FILE) && ours(readFileSync(LEGACY_COMMAND_FILE, 'utf8'))) {
      writePrivate(CLAUDE_COMMAND_FILE, CLAUDE_COMMAND);
      unlinkSync(LEGACY_COMMAND_FILE);
      return;
    }
    if (!existsSync(CLAUDE_COMMAND_FILE)) return;
    const cur = readFileSync(CLAUDE_COMMAND_FILE, 'utf8');
    if (cur !== CLAUDE_COMMAND && ours(cur)) writePrivate(CLAUDE_COMMAND_FILE, CLAUDE_COMMAND);
  } catch { /* not ours to fix */ }
}
