// Install or sign in to Claude Code right from the ask box. On the Mac where Unit7 runs, Unit7 opens
// Terminal with the official command and the person finishes there (the sign-in is theirs, in their browser).
// The command is fixed text built here, never anything from the request. Elsewhere the web shows it to copy.
import { execFile } from 'node:child_process';
import { Unit7Error } from '../errors.ts';
import { cliBin, type CliId } from './subscription.ts';

export type SetupStep = 'install' | 'sign-in';

// what a person types themselves (the web shows these with a copy button)
export const SETUP_COMMANDS: Record<CliId, Record<SetupStep, string>> = {
  claude: { install: 'curl -fsSL https://claude.ai/install.sh | bash', 'sign-in': 'claude auth login --claudeai' },
};

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// What Unit7 types into Terminal: the same commands, pinned to this Mac. An install goes straight on to the sign-in.
export function terminalCommand(cli: CliId, step: SetupStep, bin = cliBin(cli)): string {
  const login = `${bin ? sh(bin) : '"$HOME/.local/bin/claude"'} auth login --claudeai`;
  return step === 'install' ? `${SETUP_COMMANDS.claude.install} && "$HOME/.local/bin/claude" auth login --claudeai` : login;
}

// an AppleScript string literal
export const appleString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// A new Terminal window running the command, brought to the front (Unit7 runs in the background).
export function openTerminal(command: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Unit7Error('no_terminal', 'Unit7 can open Terminal only on a Mac. Copy the command and run it yourself.', 501));
  return new Promise((done, fail) => execFile('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script ${appleString(command)}`, '-e', 'tell application "Terminal" to activate'], { timeout: 30_000 }, (e) => {
    if (!e) return done();
    fail(new Unit7Error('terminal_failed', /-1743|not allowed|not authori[sz]ed/i.test(e.message)
      ? 'Your Mac didn’t let Unit7 open Terminal. Copy the command and run it in Terminal yourself.'
      : 'Terminal didn’t open. Copy the command and run it in Terminal yourself.', 500));
  }));
}
