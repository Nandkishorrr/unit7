// The seat belt: an opt-in hook for your coding AI. Before it runs a schema push, a migration or a bulk delete, Unit7 takes a fresh
// copy, then lets the command go ahead. It never blocks anything, and if Unit7 can't be reached the command runs anyway.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RISKY = /\b(prisma\s+(db\s+push|migrate\s+(deploy|reset|dev))|drizzle-kit\s+(push|migrate)|supabase\s+db\s+(push|reset)|knex\s+migrate|sequelize\s+db:migrate|alembic\s+upgrade|rails\s+db:(migrate|drop|reset)|django.*migrate|manage\.py\s+migrate|typeorm\s+migration:run|psql\b.*\b(drop|truncate|delete|alter)\b|(drop|truncate)\s+(table|database|schema)\b)/i;
export const isRisky = (command: string) => RISKY.test(command);
// the Claude Code hook: what it adds to a project's settings, leaving everything else as it was
export function withHook(settings: Record<string, any>, command = 'unit7 seatbelt') {
  const pre: any[] = settings.hooks?.PreToolUse ?? [];
  if (pre.some((h) => h.hooks?.some((x: any) => x.command === command))) return settings;
  return { ...settings, hooks: { ...settings.hooks, PreToolUse: [...pre, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } };
}
export function installSeatbelt(cwd = process.cwd()) {
  const file = join(cwd, '.claude', 'settings.json');
  const was = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {};
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(withHook(was), null, 2)}\n`);
  return file;
}
// the hook itself: reads what the AI is about to run, takes a copy when it's risky, and always lets it continue
export async function seatbelt(stdin: string, copy: (reason: string) => Promise<unknown>) {
  let command = '';
  try { command = String((JSON.parse(stdin) as { tool_input?: { command?: string } }).tool_input?.command ?? ''); } catch { return false; }
  if (!isRisky(command)) return false;
  await copy(`before: ${command.slice(0, 80)}`).catch(() => undefined);
  return true;
}
