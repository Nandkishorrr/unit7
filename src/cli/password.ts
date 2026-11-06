// `unit7 password`: set your own login password, on the computer where Unit7 runs. It needs the
// database file itself, so only the machine's owner can do it — the recovery path when you forget.
import { join } from 'node:path';
import { openDb, get, all, run, dbPath } from '../db.ts';
import { hashPassword, validPassword } from '../auth.ts';
import { unit7Home } from './client.ts';

// piped stdin (non-interactive): read it all once, hand out one line per question
let piped: string[] | undefined;
async function nextPipedLine(): Promise<string> {
  if (!piped) { let s = ''; process.stdin.setEncoding('utf8'); for await (const d of process.stdin) s += d; piped = s.split(/\r?\n/); }
  return piped.shift() ?? '';
}

// read a line without echoing it (shows • per character)
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return resolve(nextPipedLine()); // scripts: read the next line
    stdout.write(question);
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); return resolve(value); }
        if (c === '\u0003') { stdout.write('\n'); process.exit(130); } // Ctrl-C
        if (c === '\u007f' || c === '\b') { if (value) { value = value.slice(0, -1); stdout.write('\b \b'); } continue; }
        value += c; stdout.write('•');
      }
    };
    stdin.on('data', onData);
  });
}

export async function setPassword(email?: string) {
  const db = openDb(dbPath(unit7Home()));
  const user = email
    ? get<{ id: string; email: string }>(db, 'SELECT id, email FROM users WHERE email = ?', email)
    : get<{ id: string; email: string }>(db, `SELECT u.id, u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.role = 'owner' ORDER BY m.created_at LIMIT 1`);
  if (!user) { console.error(email ? `No account with the email ${email}.` : 'Unit7 has no account yet. Open the web app and create one.'); process.exit(1); }
  console.log(`Setting a new password for ${user.email}`);
  const a = await askHidden('New password (10+ characters): ');
  if (!validPassword(a)) { console.error('Use at least 10 characters.'); process.exit(1); }
  const b = await askHidden('Type it again: ');
  if (a !== b) { console.error('Those didn’t match. Nothing changed.'); process.exit(1); }
  run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(a), user.id);
  const ended = all(db, 'SELECT id FROM sessions WHERE user_id = ?', user.id).length;
  run(db, 'DELETE FROM sessions WHERE user_id = ?', user.id); // sign out everywhere
  db.close();
  console.log(`✓ Password changed. Signed out of ${ended} session(s). Log in at your Unit7 with ${user.email}.`);
}
