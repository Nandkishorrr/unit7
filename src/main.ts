// The `unit7` command (`unit7` still works). `unit7 serve` runs the control plane; the rest are a thin client over its
// HTTP API (same tools as the web UI), plus `unit7 mcp` to expose Unit7 to an AI coding agent.
import { Command } from 'commander';

// settings named before the rename (FORGE_HOME, FORGE_URL…) still work: each moves to its UNIT7_ name
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('FORGE_')) { process.env[`UNIT7_${k.slice(6)}`] ??= v; delete process.env[k]; }

const { helpText } = await import('./help.ts');
const program = new Command('unit7')
  .description('Unit7 — the operating system for AI-built software')
  .version('0.1.0')
  .addHelpText('beforeAll', helpText() + '\n\nAll commands:\n');

// --- one command to connect every AI agent on this computer ---
program.command('connect [agents...]')
  .description('Connect an AI agent to Unit7 — you choose: claude, antigravity, cursor, windsurf, claude-desktop, codex')
  .option('--all', 'connect every agent found on this computer')
  .option('--url <url>', 'Unit7 URL', process.env.UNIT7_URL)
  .option('--no-service', 'don’t install the background service')
  .option('--findings-only', 'it can read what’s wrong in production, and nothing else: no server, deploy or settings tools')
  .option('--profile <name>', 'a small set of tools instead of all of them: read, deploy or ops')
  .action(async (agents, o) => { const { connect } = await import('./cli/connect.ts'); await connect({ url: o.url, agents, all: o.all, service: o.service, findingsOnly: o.findingsOnly, profile: o.profile }); });
program.command('disconnect [agents...]').description('Stop an AI agent using Unit7 (you choose which)').action(async (agents) => { const { disconnect } = await import('./cli/connect.ts'); await disconnect(agents); });
program.command('agents').description('Which AI agents are on this computer and which use Unit7').action(async () => { const { agentList } = await import('./agents/connect.ts'); for (const a of agentList()) console.log(`${a.connected ? '✓' : a.installed ? '·' : ' '} ${a.name.padEnd(15)} ${a.connected ? 'connected' : a.installed ? `installed — unit7 connect ${a.id}` : 'not installed'}`); });
program.command('password').description('Set your own login password (run on the computer where Unit7 runs)').option('--email <email>', 'which account (default: the owner)').action(async (o) => { const { setPassword } = await import('./cli/password.ts'); await setPassword(o.email); });
program.command('guide').description('The short guide: what to type').action(() => console.log(helpText()));

const svc = program.command('service').description('Unit7’s background service');
svc.command('start').description('Install and start Unit7 in the background').option('--port <port>', 'port', (v) => Number(v), 4800).action(async (o) => { const { installService, waitHealthy } = await import('./cli/service.ts'); const { unit7Home } = await import('./cli/client.ts'); const where = installService({ home: unit7Home(), port: o.port }); console.log((await waitHealthy(`http://127.0.0.1:${o.port}`)) ? `✓ Unit7 is running (${where})` : `✗ Started, but not answering yet — check the log in UNIT7_HOME/unit7.log`); });
svc.command('stop').description('Stop and remove the background service').action(async () => { const { uninstallService } = await import('./cli/service.ts'); console.log(uninstallService() ? '✓ Stopped.' : 'No background service was installed.'); });
svc.command('status').action(async () => { const { serviceInstalled, healthy } = await import('./cli/service.ts'); console.log(`service installed: ${serviceInstalled()}  ·  answering: ${await healthy(process.env.UNIT7_URL ?? 'http://127.0.0.1:4800')}`); });

// --- the control plane ---
program.command('serve')
  .description('Run the Unit7 control plane (web app, API, MCP endpoint)')
  .option('-p, --port <port>', 'port', (v) => Number(v), Number(process.env.PORT ?? 4800))
  .option('--host <host>', 'interface to listen on', process.env.UNIT7_HOST ?? '127.0.0.1')
  .option('--tls-cert <file>', 'serve HTTPS with this certificate')
  .option('--tls-key <file>', 'private key for --tls-cert')
  .action(async (o) => { const { serve } = await import('./server/serve.ts'); await serve(o); });

// --- client config ---
program.command('login')
  .description('Save the Unit7 server URL and an API token')
  .requiredOption('--url <url>', 'your Unit7 URL, e.g. https://unit7.example.com')
  // the token is asked for (hidden) or piped in, never typed as an argument: those show in `ps` and shell history
  .action(async (o) => { const { saveConfig } = await import('./cli/client.ts'); const { apiGet } = await import('./cli/client.ts'); const { askHidden } = await import('./cli/password.ts'); o.token = (process.env.UNIT7_TOKEN ?? await askHidden('API token (from Settings → API tokens): ')).trim(); try { const me = await apiGet('/api/me', { url: o.url.replace(/\/$/, ''), token: o.token }); saveConfig({ url: o.url.replace(/\/$/, ''), token: o.token }); console.log(`Logged in to ${me.org.name} as ${me.user.email}.`); } catch (e) { console.error(`Couldn't log in: ${(e as Error).message}`); process.exit(1); } });

// --- reads ---
const t = async (name: string, input?: unknown, o?: object) => { const { tool } = await import('./cli/client.ts'); return tool(name, input, o); };
program.command('projects').description('List projects').action(() => t('project.list'));
program.command('servers').description('List servers').action(() => t('server.list'));
program.command('status').alias('ps').description('Show the whole infrastructure graph').action(async () => { const { apiGet } = await import('./cli/client.ts'); console.log(JSON.stringify(await apiGet('/api/graph'), null, 2)); });

const srv = program.command('server').description('Manage servers');
srv.command('list').action(() => t('server.list'));
srv.command('inspect <serverId>').action((id) => t('server.inspect', { serverId: id }));
srv.command('metrics <serverId>').action((id) => t('server.metrics', { serverId: id }));
srv.command('run <serverId> <cmd...>').description('Run a command on a server').action((id, cmd) => t('server.exec', { serverId: id, command: cmd.join(' ') }));

// --- deploy the current folder ---
program.command('deploy')
  .description('Deploy the current folder to a Unit7 service')
  .requiredOption('--service <id>', 'the service id (unit7 projects to find it)')
  .option('--dir <dir>', 'folder to deploy', '.')
  .action(async (o) => { const { deployFolder } = await import('./cli/deploy.ts'); await deployFolder(o.service, o.dir); });

program.command('live [dir]').description('Put this folder on the internet: it picks the best connected host')
  .option('--to <host>', 'where: vercel, coolify…').option('--name <name>', 'the project name').option('--domain <domain>', 'your domain').option('--update', 'replace what is live')
  .action(async (dir, o) => { const { live } = await import('./cli/live.ts'); await live(dir ?? '.', o); });

program.command('autosync [every]').description('How often the map syncs by itself: 15m, 1h, 6h, 1d or off (no value: show it)').action((every) => t('sync.schedule', every ? { every } : {}));
program.command('blocked').description('What Unit7 blocked lately (denied, rejected, expired)').option('-d, --days <n>', 'days', '7').action((o) => t('audit.blocked', { days: Number(o.days) }));
program.command('logs <serviceId>').description('Tail a service’s logs').option('-n, --lines <n>', 'lines', '200').action((id, o) => t('deployment.logs', { serviceId: id, lines: Number(o.lines) }));
program.command('rollback <serviceId>').description('Roll a service back to its previous version').action((id) => t('deployment.rollback', { serviceId: id }));
program.command('restart <serviceId>').action((id) => t('service.restart', { serviceId: id }));

const env = program.command('env').description('Environment variables');
env.command('list').requiredOption('--service <id>').action((o) => t('env.list', { serviceId: o.service }));
// `unit7 env set KEY --service id` asks for the value (hidden) or reads it piped in: a value on the command line
// shows in `ps` and stays in shell history. `unit7 env set KEY value` still works for values that aren't secret.
env.command('set <KEY> [value]').requiredOption('--service <id>').action(async (k, v, o) => {
  const { askHidden } = await import('./cli/password.ts');
  const value = v === undefined || v === '-' ? await askHidden(`Value for ${k}: `) : v;
  return t('env.set', { serviceId: o.service, key: k, value });
});

const db = program.command('db').description('Databases');
db.command('create <engine>').requiredOption('--env <id>', 'environment id').option('--inject <serviceId>').action((engine, o) => t('database.create', { environmentId: o.env, engine, injectInto: o.inject }));
db.command('query <serviceId> <sql>').option('--write').action((id, sql, o) => t('database.query', { serviceId: id, sql, write: !!o.write }));

program.command('vault').description('The vault').command('rekey').description('Seal every secret under a new master key (stop Unit7 first)')
  .action(async () => { const { rekey } = await import('./cli/rekey.ts'); try { await rekey(); } catch (e) { console.error((e as Error).message); process.exit(1); } });

const backup = program.command('backup').description('Backups');
backup.command('create <serviceId>').action((id) => t('backup.create', { serviceId: id }));
backup.command('list').option('--service <id>').action((o) => t('backup.list', { serviceId: o.service }));
// works with nothing but the file and the recovery key (no Unit7, no database): the "this computer is gone" path
backup.command('decrypt <file> <out>').description('Decrypt an off-server backup copy with your recovery key').action(async (file, out) => {
  const { askHidden } = await import('./cli/password.ts');
  const { decryptFile } = await import('./tools/offsite.ts');
  const key = Buffer.from((process.env.UNIT7_BACKUP_KEY ?? await askHidden('Recovery key: ')).trim(), 'base64');
  if (key.length !== 32) { console.error('That isn\u2019t a Unit7 recovery key (it should be 44 characters).'); process.exit(1); }
  await decryptFile(key, file, out);
  console.log(`✓ Decrypted to ${out} (gzipped: restore it with gunzip -c ${out} | psql …, or unit7 backup restore).`);
});

program.command('domain <hostname>').description('Point a domain at a service').requiredOption('--service <id>').action((host, o) => t('domain.point', { hostname: host, serviceId: o.service }));

// --- ask the agent from the terminal ---
program.command('agent <message...>')
  .description('Ask Unit7’s agent to do something')
  .action(async (msg) => { const { askAgent } = await import('./cli/agent.ts'); await askAgent(msg.join(' ')); });

// --- any tool, for scripts: a plan first, JSON out, and exit codes that mean something ---
program.command('run <tool>')
  .description('Run any Unit7 tool. --dry-run shows the plan and changes nothing. Exit codes: 0 done, 1 failed, 2 waiting for approval, 3 not allowed')
  .option('--input <json>', 'its input as JSON', '{}')
  .option('--dry-run', 'show the plan, change nothing')
  .action(async (name, o) => { const { tool } = await import('./cli/client.ts'); await tool(name, JSON.parse(o.input), { dryRun: !!o.dryRun }); });

// --- unit7.yaml ---
const cfg = program.command('config').description('unit7.yaml: rules and settings you can keep in a repo. It never holds a secret');
cfg.command('export').action(async () => { const { tool } = await import('./cli/client.ts'); console.log(((await tool('config.export', {}, { quiet: true })) as { yaml: string }).yaml); });
cfg.command('plan [file]').action(async (f = 'unit7.yaml') => { const { readFileSync } = await import('node:fs'); const { tool } = await import('./cli/client.ts'); const r = await tool('config.plan', { yaml: readFileSync(f, 'utf8') }, { quiet: true }) as { changes: { kind: string; what: string }[] }; console.log(r.changes.length ? r.changes.map((c) => `${c.kind.padEnd(7)} ${c.what}`).join('\n') : 'Nothing to change.'); });
cfg.command('apply [file]').action(async (f = 'unit7.yaml') => { const { readFileSync } = await import('node:fs'); await t('config.apply', { yaml: readFileSync(f, 'utf8') }); });

// --- the audit log, to take away ---
program.command('audit-export').description('Every change as hash-linked JSON lines').option('--since <date>').action(async (o) => { const { tool } = await import('./cli/client.ts'); console.log(((await tool('audit.export', { ...(o.since && { since: o.since }) }, { quiet: true })) as { jsonl: string }).jsonl); });
program.command('audit-verify <file>').description('Check a saved audit log still links up').action(async (f) => { const { readFileSync } = await import('node:fs'); const { verifyLines } = await import('./ops/chain.ts'); const r = verifyLines(readFileSync(f, 'utf8').split('\n').filter(Boolean)); console.log(r.ok ? `Intact: ${r.lines} lines.` : r.why); if (!r.ok) process.exit(1); });

// --- is everything OK? ---
program.command('checkup')
  .description('Is everything OK? Room, protection, security and app behaviour, no AI needed')
  .option('--quick', 'use what Unit7 already has')
  .option('--server <id>', 'one server')
  .option('--json', 'the whole report as JSON')
  .option('--fail-on <severity>', 'exit 4 if anything this serious is found: critical, high, medium or low')
  .action(async (o) => { const { checkupCli } = await import('./cli/checkup.ts'); await checkupCli(o); });

// --- Seven, the agent on shift ---
const seven = program.command('seven').description('What Seven, the agent on shift, did and what it’s waiting on');
seven.option('--json', 'as JSON').action(async (o) => {
  const { tool } = await import('./cli/client.ts');
  const s = await tool('seven.status', {}, { quiet: true }) as { line?: string; asks: { question: string; why: string }[]; done: { why: string }[]; spent: number; mind: { label: string } | null };
  if (o.json) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log([s.line ?? 'No shift yet.', ...(s.asks.length ? ['', 'Should I?', ...s.asks.map((a) => `  ${a.question} ${a.why}`)] : []), ...(s.done.length ? ['', 'Done for you', ...s.done.slice(0, 5).map((d) => `  ${d.why}`)] : []), '', s.mind ? `Thinking with ${s.mind.label}.` : 'Working from fixed rules. Connect a model for logs and code.'].join('\n'));
});
seven.command('look').description('Ask Seven to look now').action(() => t('seven.look', {}));

// --- one finding, for a person or a script ---
program.command('finding <id>')
  .description('One finding: its prompt for your AI, or its whole record with --json')
  .option('--json', 'the whole record')
  .option('--explain', 'a prompt that asks for an explanation, not a change')
  .option('--check', 'look now: is it fixed?')
  .action(async (ref, o) => {
    const { tool } = await import('./cli/client.ts');
    if (o.check) { const r = await tool('finding.check', { ref }, { quiet: true }) as { statusWords: string; win?: string }; console.log(r.win ?? r.statusWords); return; }
    if (o.json) { await tool('finding.get', { ref }); return; }
    const r = await tool('finding.prompt', { ref, what: o.explain ? 'explain' : 'fix', full: true }, { quiet: true }) as { text: string };
    console.log(r.text);
  });

// --- a seat belt for your coding AI ---
program.command('seatbelt [what]')
  .description('`unit7 seatbelt install` makes Claude Code take a fresh copy before risky database commands, in this project. It never blocks anything.')
  .action(async (what) => {
    const s = await import('./cli/seatbelt.ts');
    if (what === 'install') { console.log(`Added to ${s.installSeatbelt()}. Before a schema push or migration, Unit7 takes a fresh copy first.`); return; }
    let input = ''; for await (const c of process.stdin) input += c;
    const { tool } = await import('./cli/client.ts');
    await s.seatbelt(input, (reason) => tool('safety.copy', { reason }, { quiet: true }));
  });

// --- health check ---
program.command('doctor').description('Check the connection to your Unit7 and what’s configured').action(async () => { const { doctor } = await import('./cli/doctor.ts'); await doctor(); });

// --- expose Unit7 to an AI coding agent (Claude Code, Cursor) over stdio ---
program.command('mcp')
  .description('Run Unit7 as an MCP server over stdio for an AI coding agent')
  .action(async () => {
    const { loadConfig } = await import('./cli/client.ts');
    const c = loadConfig();
    if (!c) { console.error('Run `unit7 login` first, or set UNIT7_URL and UNIT7_TOKEN.'); process.exit(1); }
    const { proxyStdioMcp } = await import('./cli/mcp-proxy.ts');
    await proxyStdioMcp(c);
  });

await program.parseAsync();
