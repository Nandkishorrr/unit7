// `unit7 connect` writes other apps' config files, so it must never damage them: existing entries
// survive, a backup is made, unreadable files are left alone, and disconnect removes only Unit7.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'unit7-home-'));
let CLIENTS: typeof import('../src/agents/clients.ts').CLIENTS;
const target = { url: 'http://localhost:4800', token: 'unit7_pat_test', stdio: { command: '/node24', args: ['/unit7.mjs', 'mcp'], env: { UNIT7_URL: 'http://localhost:4800', UNIT7_TOKEN: 'unit7_pat_test' } } };

before(async () => {
  process.env.HOME = HOME; // clients.ts resolves every path from the home folder
  mkdirSync(join(HOME, '.gemini', 'antigravity'), { recursive: true });
  writeFileSync(join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), JSON.stringify({ mcpServers: { gemini: { serverUrl: 'http://x' }, forge: { command: 'old' } } }));
  mkdirSync(join(HOME, '.cursor'), { recursive: true });
  writeFileSync(join(HOME, '.cursor', 'mcp.json'), '{ this is not json');
  mkdirSync(join(HOME, '.codeium', 'windsurf'), { recursive: true }); // folder only, no file yet
  mkdirSync(join(HOME, '.codex'), { recursive: true });
  writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.gemini]\ncommand = "g"\n\n[mcp_servers.forge]\ncommand = "old"\n\n[mcp_servers.forge.env]\nFORGE_TOKEN = "old"\n');
  ({ CLIENTS } = await import('../src/agents/clients.ts'));
});

const client = (name: string) => CLIENTS.find((c) => c.name === name)!;

test('Antigravity: unit7 replaces the old forge entry, other servers kept, backup made', () => {
  const r = client('Antigravity').connect(target);
  assert.equal(r.status, 'connected');
  const f = join(HOME, '.gemini', 'antigravity', 'mcp_config.json');
  const cfg = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(cfg.mcpServers.gemini.serverUrl, 'http://x');
  assert.equal(cfg.mcpServers.unit7.command, '/node24');
  assert.equal(cfg.mcpServers.unit7.env.UNIT7_TOKEN, 'unit7_pat_test');
  assert.equal(cfg.mcpServers.forge, undefined);
  assert.ok(existsSync(`${f}.bak-unit7`));
});

test('Cursor: an unreadable config is left untouched', () => {
  const r = client('Cursor').connect(target);
  assert.equal(r.status, 'failed');
  assert.equal(readFileSync(join(HOME, '.cursor', 'mcp.json'), 'utf8'), '{ this is not json');
});

test('Windsurf: creates the config when only the folder exists', () => {
  assert.equal(client('Windsurf').connect(target).status, 'connected');
  assert.ok(JSON.parse(readFileSync(join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8')).mcpServers.unit7);
});

test('Codex TOML: old forge block replaced by unit7, others kept', () => {
  client('Codex').connect(target);
  const toml = readFileSync(join(HOME, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.gemini\]/);
  assert.equal(toml.match(/\[mcp_servers\.unit7\]/g)?.length, 1);
  assert.doesNotMatch(toml, /mcp_servers\.forge/);
  assert.match(toml, /UNIT7_TOKEN = "unit7_pat_test"/);
  assert.doesNotMatch(toml, /"old"/);
});

test('not installed apps are skipped', () => {
  assert.equal(client('Claude Desktop').installed(), false);
});

test('disconnect removes only unit7', () => {
  client('Antigravity').disconnect();
  client('Codex').disconnect();
  const cfg = JSON.parse(readFileSync(join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), 'utf8'));
  assert.equal(cfg.mcpServers.unit7, undefined);
  assert.ok(cfg.mcpServers.gemini);
  const toml = readFileSync(join(HOME, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(toml, /mcp_servers\.(unit7|forge)/);
  assert.match(toml, /mcp_servers\.gemini/);
});

test('an old /forge command we wrote becomes /unit7; someone else’s is left alone', async () => {
  const { refreshClaudeCommand, CLAUDE_COMMAND, CLAUDE_COMMAND_FILE, LEGACY_COMMAND_FILE } = await import('../src/agents/clients.ts');
  mkdirSync(join(HOME, '.claude', 'commands'), { recursive: true });
  writeFileSync(LEGACY_COMMAND_FILE, 'old forge command: call graph_get first');
  refreshClaudeCommand();
  assert.equal(existsSync(LEGACY_COMMAND_FILE), false);
  assert.equal(readFileSync(CLAUDE_COMMAND_FILE, 'utf8'), CLAUDE_COMMAND);
  assert.match(CLAUDE_COMMAND_FILE, /unit7\.md$/);

  writeFileSync(LEGACY_COMMAND_FILE, 'my own forge notes');
  refreshClaudeCommand();
  assert.equal(readFileSync(LEGACY_COMMAND_FILE, 'utf8'), 'my own forge notes');
});
