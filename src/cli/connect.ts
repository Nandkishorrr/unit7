// `unit7 connect [agent…]`: you choose which AI agents use Unit7.
//   unit7 connect               → shows the agents on this computer and asks which to connect
//   unit7 connect claude        → connects just Claude Code
//   unit7 connect antigravity cursor
// It also makes sure Unit7 is running (installs the background service once) and sets up the
// terminal CLI. Runs on the computer where Unit7 lives: it mints keys from Unit7's database.
import { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { openDb, get, run, type DB, dbPath } from '../db.ts';
import { createToken, type Principal } from '../auth.ts';
import { installService, healthy, waitHealthy, serviceInstalled } from './service.ts';
import { saveConfig, unit7Home } from './client.ts';
import { agentList, connectAgent, disconnectAgent, BIN, TOKEN_PREFIX } from '../agents/connect.ts';
import type { Result } from '../agents/clients.ts';

export interface ConnectOptions { url?: string; port?: number; agents?: string[]; all?: boolean; service?: boolean; findingsOnly?: boolean; profile?: string }

export function owner(db: DB): Principal {
  const m = get<{ user_id: string; org_id: string }>(db, `SELECT user_id, org_id FROM memberships WHERE role = 'owner' ORDER BY created_at LIMIT 1`);
  if (!m) throw new Error('Unit7 has no account yet. Open the web app once and create yours, then run `unit7 connect` again.');
  const u = get<{ email: string; name: string }>(db, 'SELECT email, name FROM users WHERE id = ?', m.user_id)!;
  const o = get<{ name: string; slug: string }>(db, 'SELECT name, slug FROM orgs WHERE id = ?', m.org_id)!;
  return { user: { id: m.user_id, email: u.email, name: u.name }, org: { id: m.org_id, name: o.name, slug: o.slug }, role: 'owner', via: 'session' };
}

// put `unit7` on the PATH (in ~/.local/bin) so it works in any terminal and in Claude Code's shell
function installCommand() {
  const dir = join(homedir(), '.local', 'bin');
  if (!(process.env.PATH ?? '').split(':').includes(dir)) return;
  mkdirSync(dir, { recursive: true });
  // links we made earlier, including the old `forge` one, pointed at bin/forge.mjs (now bin/unit7.mjs)
  const ours = (l: string) => { try { return /bin\/(forge|unit7)\.mjs$/.test(readlinkSync(l)); } catch { return false; } };
  for (const name of ['forge', 'unit7']) if (ours(join(dir, name))) unlinkSync(join(dir, name));
  const link = join(dir, 'unit7');
  try { if (lstatSync(link)) return; } catch { /* not there yet */ }
  symlinkSync(BIN, link);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// "1 3" / "all" → agent ids from a numbered list
const pick = (answer: string, list: { id: string }[]) => answer.toLowerCase() === 'all'
  ? list.map((a) => a.id)
  : answer.split(/[\s,]+/).map((n) => list[Number(n) - 1]?.id).filter((x): x is string => !!x);

const line = (r: Result) => `${r.status === 'connected' || r.status === 'removed' ? '✓' : r.status === 'failed' ? '✗' : '·'} ${r.client.padEnd(15)} ${r.status === 'connected' ? `${r.where}${r.note ? `  (${r.note})` : ''}` : r.note ?? r.status}`;

async function ensureRunning(url: string, port: number, home: string, service: boolean) {
  if (await healthy(url)) return;
  if (!service) { console.log(`✗ Unit7 isn't running at ${url}. Start it with \`unit7 serve\`.`); process.exit(1); }
  console.log('… Starting Unit7 in the background (it will start at login and restart if it crashes)…');
  installService({ home, port });
  if (!(await waitHealthy(url))) { console.log(`✗ Unit7 didn't start. See ${join(home, 'unit7.log')}`); process.exit(1); }
  console.log(`✓ Unit7 is running at ${url}`);
}

export async function connect(o: ConnectOptions = {}) {
  const port = o.port ?? 4800;
  const url = (o.url ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const home = unit7Home();
  await ensureRunning(url, port, home, o.service !== false);

  const agents = agentList().filter((a) => a.installed);
  if (!agents.length) { console.log('No supported AI agents found on this computer (Claude Code, Antigravity, Cursor, Windsurf, Claude Desktop, Codex).'); return; }

  let chosen = o.all ? agents.map((a) => a.id) : (o.agents ?? []);
  if (!chosen.length) {
    console.log('\nWhich AI agent should use Unit7?\n');
    agents.forEach((a, i) => console.log(`  ${i + 1}. ${a.name.padEnd(15)} ${a.connected ? '✓ connected' : ''}`));
    if (!process.stdin.isTTY) { console.log('\nRun e.g. `unit7 connect claude` or `unit7 connect antigravity`.'); return; }
    chosen = pick(await ask('\nType a number (or several, like 1 3), or "all": '), agents);
    if (!chosen.length) { console.log('Nothing changed.'); return; }
  }

  const db = openDb(dbPath(home));
  const p = owner(db);
  console.log('');
  for (const id of chosen) {
    try { console.log(line(connectAgent(db, p, id, url, { findingsOnly: o.findingsOnly, profile: o.profile }))); } catch (e) { console.log(`✗ ${id}: ${(e as Error).message}`); }
  }
  // The terminal CLI (`unit7 status`, `unit7 deploy`) gets its own key. Any program on this computer can read that
  // file (AI agents with a shell included), so the key acts as an agent: autonomy and approvals apply to it.
  run(db, 'DELETE FROM api_tokens WHERE org_id = ? AND user_id = ? AND name = ?', p.org.id, p.user.id, TOKEN_PREFIX + 'CLI');
  saveConfig({ url, token: createToken(db, p, TOKEN_PREFIX + 'CLI', 'agent').token, home });
  installCommand();
  db.close();
  console.log('\nDone. In Claude Code type /unit7 and what you want. In other agents, just ask and mention Unit7.');
}

export async function disconnect(agents: string[] = []) {
  const home = unit7Home();
  const connected = agentList().filter((a) => a.connected);
  let chosen = agents;
  if (!chosen.length) {
    if (!connected.length) { console.log('No AI agents are connected to Unit7.'); return; }
    console.log('\nWhich agent should stop using Unit7?\n');
    connected.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}`));
    if (!process.stdin.isTTY) { console.log('\nRun e.g. `unit7 disconnect cursor`.'); return; }
    chosen = pick(await ask('\nType a number (or several), or "all": '), connected);
    if (!chosen.length) { console.log('Nothing changed.'); return; }
  }
  if (!existsSync(dbPath(home))) { console.log('No Unit7 database found here.'); return; }
  const db = openDb(dbPath(home));
  const p = owner(db);
  for (const id of chosen) {
    try { console.log(line(disconnectAgent(db, p, id))); } catch (e) { console.log(`✗ ${id}: ${(e as Error).message}`); }
  }
  db.close();
  if (serviceInstalled() && !agentList().some((a) => a.connected)) console.log('Unit7 is still running in the background. Stop it with `unit7 service stop`.');
}
