// The first SSH key, from the root password. A new VPS usually comes with a root password and nothing else, and Unit7
// has no way in yet. A person types the password once in the web app: Unit7 shows the server's fingerprint first, then
// signs in once with the password (only to a server presenting exactly that fingerprint), adds its own public key (and
// this Mac's, so the person can never be locked out later) to the login's authorized_keys, signs in again with its key to
// prove it works, and forgets the password. The password is a sensitive input: never in audit, events, logs, results or
// an AI's context, never written anywhere, and never accepted from an AI or a token (people only, at the gate and here).
// Three wrong passwords in 10 minutes for one server and Unit7 stops trying: wrong tries are what get addresses banned.
import { z } from 'zod';
import { Client } from 'ssh2';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool, execute } from './runtime.ts';
import { all, get, run, type DB } from '../db.ts';
import { Unit7Error, forbidden } from '../errors.ts';
import { fingerprint, publicKeyOf, ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { fid } from './helpers.ts';
import { afterKeyWorks, generateKeyPair, serverRow } from './servers.ts';

const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,3}( [^\n\r]{0,200})?$/;
const FP = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'a SHA256 fingerprint');

// --- wrong passwords, per address (host and port): 3 in 10 minutes, then wait -----------------------------------------
// Counted from the audit, so restarting Unit7 or removing and re-adding the server gives no extra tries (fail2ban counts
// per address too). Each try records its address in the audit row's resources.
const WINDOW = 10 * 60_000, MAX_FAILS = 3;
const addressOf = (s: ServerRow) => `ssh:${s.host.toLowerCase()}:${s.port}`;
const recentFails = (db: DB, s: ServerRow, now = Date.now()) => all<{ at: string }>(db, `SELECT a.created_at at FROM audit a, json_each(a.resources) r
  WHERE a.tool = 'server.install_key_with_password' AND substr(a.error, 1, 15) = 'wrong_password:' AND r.value = ? AND a.created_at > ? ORDER BY a.created_at`,
addressOf(s), new Date(now - WINDOW).toISOString()).map((r) => Date.parse(r.at));
const busy = new Set<string>(); // one try at a time per server: two clicks never become two sign-ins

// --- this Mac's own public keys (public halves, not secrets): added too, so turning passwords off can't lock anyone out --
export function macKeys(home = homedir()): string[] {
  return ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub'].map((f) => join(home, '.ssh', f)).filter((f) => existsSync(f))
    .map((f) => { try { return readFileSync(f, 'utf8').trim().split('\n')[0]!.trim(); } catch { return ''; } }).filter((k) => PUBLIC_KEY.test(k));
}

// Appends each key read on stdin (one per line) to the login's authorized_keys unless its key body is already there,
// with the permissions sshd insists on; says "added" or "present" per key, in order. Keys come on stdin, never on a
// command line. A file without a final newline gets one first, so a key is never glued onto the last line.
export const ADD_KEYS = `umask 077
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || exit 3
f="$HOME/.ssh/authorized_keys"
touch "$f" && chmod 600 "$f" || exit 3
if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi
while IFS= read -r k || [ -n "$k" ]; do
  [ -n "$k" ] || continue
  b=$(printf '%s\\n' "$k" | awk '{print $2}')
  if [ -n "$b" ] && grep -qF -- "$b" "$f"; then echo present; else printf '%s\\n' "$k" >> "$f" && echo added; fi
done
command -v restorecon >/dev/null 2>&1 && restorecon -R "$HOME/.ssh" >/dev/null 2>&1
exit 0`;

// --- the server's identity, read before any password leaves this computer --------------------------------------------
// The key exchange only: Unit7 reads the host key and hangs up before signing in, so this is no sign-in attempt at all.
export function readHostKey(s: Pick<ServerRow, 'host' | 'port' | 'username'>, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let fp: string | undefined;
    const done = (e?: Error) => { c.removeAllListeners(); c.on('error', () => undefined); c.end(); if (fp) resolve(fp); else reject(e ?? new Unit7Error('unreachable', `${s.host}:${s.port} didn’t show its SSH identity.`, 502)); };
    c.on('error', (e) => done(e)).on('ready', () => done()).on('close', () => done());
    c.connect({ host: s.host, port: s.port, username: s.username, readyTimeout: timeoutMs, authHandler: () => false,
      hostVerifier: (key: Buffer) => { fp = fingerprint(key); return false; } });
  }).catch((e: Error) => {
    if (e instanceof Unit7Error) throw e;
    throw new Unit7Error('unreachable', `Unit7 couldn’t reach ${s.host}:${s.port} to read its identity (${e.message.slice(0, 120)}).`, 502);
  }) as Promise<string>;
}

// --- one sign-in with the password, then commands over that one connection ---------------------------------------------
type Outcome = { code: number; stdout: string; stderr: string };
interface Identity { expect: string; pinned: () => string | null | undefined; pin: (fp: string) => void }
export function withPassword(s: Pick<ServerRow, 'name' | 'host' | 'port' | 'username'>, password: string, id: Identity, command: string, stdin: string, timeoutMs = 30_000): Promise<Outcome> {
  return new Promise<Outcome>((resolve, reject) => {
    const c = new Client();
    let settled = false, tried = false, noPassword = false, wrongHost: string | undefined;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); c.end(); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Unit7Error('timeout', `${s.name} took too long to answer.`, 504))), timeoutMs + 20_000);
    c.on('change password', () => finish(() => reject(new Unit7Error('password_expired', `${s.name} wants a new password for ${s.username} before anyone signs in. Sign in once yourself (or in your provider’s browser terminal) to set one, then try again.`, 409))));
    c.on('error', (e: Error & { level?: string }) => finish(() => {
      if (wrongHost) return reject(new Unit7Error('host_key_changed', `${s.name} showed a different identity (${wrongHost}) from the one you saw. Unit7 didn’t send the password.`, 409));
      if (noPassword) return reject(new Unit7Error('no_password_login', `${s.name} doesn’t accept passwords for ${s.username}, so this route can’t work. Add the key with your own SSH access, or the command on this page.`, 409));
      if (e.level === 'client-authentication') return reject(new Unit7Error('wrong_password', `${s.name} didn’t accept that password for ${s.username}.`, 401));
      reject(new Unit7Error('unreachable', `Couldn’t sign in to ${s.name}: ${e.message.slice(0, 160)}`, 502));
    }));
    c.on('ready', () => {
      c.exec(command, (err, stream) => {
        if (err) return finish(() => reject(new Unit7Error('connection', `Couldn’t run a command on ${s.name}: ${err.message}`, 502)));
        let stdout = '', stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8').slice(0, 20_000); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8').slice(0, 4000); });
        stream.on('close', (code: number | null) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
        stream.end(stdin);
      });
    });
    c.connect({
      host: s.host, port: s.port, username: s.username, readyTimeout: timeoutMs,
      // the identity the person was shown, and the one Unit7 pinned if it has one; otherwise no password is sent
      hostVerifier: (key: Buffer) => {
        const fp = fingerprint(key), pinned = id.pinned();
        if (fp !== id.expect || (pinned && pinned !== fp)) { wrongHost = fp; return false; }
        if (!pinned) id.pin(fp);
        return true;
      },
      // "none" first (no secret, not a failed sign-in) only to learn which methods are on; then one try with the password
      authHandler: (methods: string[] | null, _partial: boolean | null, next: (a: unknown) => void) => {
        if (methods === null) return next({ type: 'none', username: s.username });
        if (tried) return next(false);
        tried = true;
        if (methods.includes('password')) return next({ type: 'password', username: s.username, password });
        if (methods.includes('keyboard-interactive')) {
          return next({ type: 'keyboard-interactive', username: s.username,
            // only a single hidden prompt gets the password (a one-time code prompt never does)
            prompt: (_n: string, _i: string, _l: string, prompts: { prompt: string; echo?: boolean }[], answer: (a: string[]) => void) =>
              answer(prompts.length === 1 && !prompts[0]!.echo && /pass/i.test(prompts[0]!.prompt) ? [password] : prompts.map(() => '')) });
        }
        noPassword = true;
        return next(false);
      },
    } as never);
  });
}
// --- tools --------------------------------------------------------------------------------------------------------------

defineTool({
  name: 'server.fingerprint', title: 'Read a server’s SSH identity', risk: 'read', action: 'read', timeoutMs: 30_000,
  description: 'The SSH fingerprint a server shows right now, and whether it’s the one Unit7 pinned. Reads the identity only; never signs in.',
  input: z.object({ serverId: fid('srv') }),
  async run(ctx, i) {
    const s = serverRow(ctx, i.serverId);
    const fp = await readHostKey(s);
    return { fingerprint: fp, known: !s.host_key ? 'new' : s.host_key === fp ? 'pinned' : 'changed', host: s.host, port: s.port, user: s.username };
  },
});

defineTool({
  name: 'server.install_key_with_password', title: 'Add Unit7’s key with the root password', risk: 'write', action: 'server_write', timeoutMs: 3 * 60_000,
  sensitive: ['password'], peopleOnly: true,
  description: 'People only: a person types the server’s root (login) password once on the server’s page in Unit7’s web app. Unit7 signs in once with it, adds its own key (and this Mac’s), checks its key works, and forgets the password. An AI can’t call this and must never ask anyone for a password: tell the person to use “Use the root password once” on the server’s page.',
  input: z.object({ serverId: fid('srv'), password: z.string().min(1).max(512), fingerprint: FP }),
  async run(ctx, i) {
    // the gate already turns away AIs and tokens; this is the same rule, kept where the password is used
    if (ctx.actor.kind !== 'user' || ctx.actor.role === 'agent') throw forbidden('Only a person in Unit7’s web app can use a password. An AI or a token never can.');
    ctx.redactor.add(i.password, 'password'); // whatever a server or an error says back, the password never shows
    const s = serverRow(ctx, i.serverId);
    if (busy.has(s.id)) throw new Unit7Error('busy', `Unit7 is already signing in to ${s.name}. Wait for that try to finish.`, 409);
    ctx.resources.push(addressOf(s)); // where this try went, for the count above
    const fails = recentFails(ctx.db, s);
    if (fails.length >= MAX_FAILS) {
      const wait = Math.ceil((WINDOW - (Date.now() - fails[0]!)) / 60_000);
      throw new Unit7Error('too_many_tries', `${MAX_FAILS} wrong passwords for ${s.name} in 10 minutes, so Unit7 stopped trying (more wrong tries get your address banned). Try again in ${wait} minute${wait === 1 ? '' : 's'}.`, 429);
    }
    if (s.ssh_block === 'host_key') throw new Unit7Error('host_key_changed', `${s.name}’s identity changed since Unit7 first saw it. Unit7 won’t send a password to it until you trust the new identity.`, 409);
    busy.add(s.id);
    try {
      // Unit7's key already works: nothing to do, and no password is sent. (A key the server refused isn't tried again.)
      if (ctx.app.vault.list(s.org_id, s.key_ref).length && s.ssh_block !== 'key') {
        const works = await ssh(ctx.app).exec(s, 'true', { timeoutMs: 20_000 }).then(() => true, (e: Unit7Error) => { if (e.code === 'key_refused') return false; throw e; });
        if (works) throw new Unit7Error('already_works', `Unit7’s key already works on ${s.name}, so it doesn’t need the password. Nothing changed.`, 409);
      }
      // the key to add: Unit7's, or a new one when this computer has none for the server
      let key = publicKeyOf(ctx.app, s);
      if (!key && !ctx.app.vault.list(s.org_id, s.key_ref).length) {
        const k = await generateKeyPair(`unit7@${s.name}`);
        ctx.app.vault.put(s.org_id, s.key_ref, k.privateKey, { kind: 'ssh_key', meta: { publicKey: k.publicKey }, by: ctx.actor.name });
        key = k.publicKey;
      }
      if (!key || !PUBLIC_KEY.test(key)) throw new Unit7Error('no_key', 'Unit7 doesn’t have a public key on file for this server. Reconnect it from the Servers page.', 409);
      const mine = macKeys().filter((k) => k.split(' ')[1] !== key!.split(' ')[1]);

      ctx.progress(`Signing in to ${s.name} once with the password…`);
      let out: Outcome;
      try {
        out = await withPassword(s, i.password, {
          expect: i.fingerprint,
          pinned: () => get<{ host_key: string | null }>(ctx.db, 'SELECT host_key FROM servers WHERE id = ?', s.id)?.host_key,
          pin: (fp) => run(ctx.db, 'UPDATE servers SET host_key = ? WHERE id = ? AND host_key IS NULL', fp, s.id), // trust on first use, like server.connect
        }, script(ADD_KEYS), [key, ...mine].join('\n') + '\n');
      } catch (e) {
        if ((e as Unit7Error).code === 'wrong_password') {
          const left = MAX_FAILS - (recentFails(ctx.db, s).length + 1); // this one is audited as it's thrown
          throw new Unit7Error('wrong_password', `${(e as Error).message} ${left > 0 ? `Check it and try again (${left} more ${left === 1 ? 'try' : 'tries'} in the next 10 minutes).` : 'That was the third wrong try: Unit7 waits 10 minutes before it tries again.'}`, 401);
        }
        throw e;
      } finally {
        // forget it: the only copy left is the one the gate validated, cleared here too (strings can't be wiped in JS; no reference stays)
        (i as { password?: string }).password = '';
      }
      if (out.code !== 0) throw new Unit7Error('add_failed', `Signed in, but couldn’t add the key to ${s.username}’s authorized keys on ${s.name} (${(out.stderr || out.stdout).trim().slice(-160) || `exit ${out.code}`}).`, 502);
      const said = out.stdout.split('\n').map((l) => l.trim()).filter((l) => l === 'added' || l === 'present');
      const unit7 = said[0] ?? 'added', macKey = mine.length ? (said.slice(1).includes('added') ? 'added' : 'present') : 'none';

      // prove it: one sign-in with Unit7's key (the pool), as the person
      ssh(ctx.app).unblock(s.id);
      ctx.progress('Checking Unit7’s key works…');
      const check = await execute(ctx.app, ctx.orgId, ctx.actor, 'server.inspect', { serverId: s.id }, { reason: 'checking the key added with a password' });
      if (check.status !== 'ok') {
        const why = check.status === 'error' ? check.error.message : 'Unit7 wasn’t allowed to check.';
        throw new Unit7Error('key_not_working', `Unit7 added its key to ${s.username}@${s.host}, but signing in with it still doesn’t work: ${why} The password is forgotten either way.`, 502);
      }
      ctx.emit('server.key_added', `Unit7’s key is on ${s.name}: added with the password you typed once, which Unit7 has forgotten.${macKey !== 'none' ? ' This Mac’s own key is there too.' : ''}`, { severity: 'success', resource: s.id });
      const prepare = afterKeyWorks(ctx.app, ctx.orgId, ctx.actor, s.id);
      return {
        server: s.name, key: unit7, signedIn: true, passwordForgotten: true, macKey, prepare,
        // turning passwords off is offered only once the person's own key is on the server too
        ...(macKey !== 'none'
          ? { suggest: { tool: 'server.harden', input: { serverId: s.id }, label: 'Turn password sign-in off', why: 'This Mac’s own key is on the server too, so you can always get in without a password.' } }
          : { note: 'Keep password sign-in on for now: this Mac has no SSH key of its own to add, so turning passwords off could lock you out.' }),
      };
    } finally {
      busy.delete(s.id);
    }
  },
});
