// SSH: Unit7's hands on a server. One connection per server, many channels over it, opened on
// demand and closed when idle. The host key is pinned the first time (trust on first use) and a
// different key afterwards is refused — that's either a rebuilt server or someone in the middle,
// and a person has to say which.
//
// Failed sign-ins are what fail2ban and providers' network protection ban addresses for, so a
// failure is never simply retried:
//   key refused       -> no more attempts at all until a person adds the key (kept across restarts)
//   host key changed  -> no more attempts until a person trusts the new identity (kept across restarts)
//   no answer / timed out / dropped -> wait 20s, then 1, 5 and 15 minutes between attempts
// Everything asking at the same moment shares one attempt and its result.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from 'ssh2';
import { createHash } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { App } from '../app.ts';
import { get, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { script } from './shell.ts';

// the commands the current action sends, for the audit's expert view
export const commandLog = new AsyncLocalStorage<string[]>();

export interface ServerRow {
  id: string; org_id: string; name: string; host: string; port: number; username: string; key_ref: string;
  host_key: string | null; status: string; facts: string; account_id: string | null; provider_ref: string | null; last_seen_at: string | null;
  ssh_block?: string | null;
}
export interface ExecResult { code: number; stdout: string; stderr: string; truncated: boolean }
export interface ExecOptions {
  stdin?: string | Buffer | NodeJS.ReadableStream; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number;
  onData?: (chunk: string, stream: 'out' | 'err') => void;
}

// Is anything accepting TCP connections there? (true/false within `ms`, never throws)
export const listening = (host: string, port: number, ms: number) => new Promise<boolean>((resolve) => {
  const sock = tcpConnect({ host, port });
  const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
  sock.setTimeout(ms, () => done(false));
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
});

// Unit7's public key for a server (not a secret: it's what goes into authorized_keys), and the one
// line that installs it from a computer that can already sign in
export function publicKeyOf(app: App, s: ServerRow): string | undefined {
  const meta = app.vault.list(s.org_id, s.key_ref)[0]?.meta;
  return (meta && json<{ publicKey?: string }>(meta, {}).publicKey?.trim()) || undefined;
}
export function keyCommand(app: App, s: ServerRow): string | undefined {
  const key = publicKeyOf(app, s);
  return key && `ssh ${s.port === 22 ? '' : `-p ${s.port} `}${s.username}@${s.host} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${key}' >> ~/.ssh/authorized_keys"`;
}
const WAITS = [20_000, 60_000, 5 * 60_000, 15 * 60_000];
const inWords = (ms: number) => ms < 60_000 ? `${Math.ceil(ms / 1000)} seconds` : `${Math.ceil(ms / 60_000)} minute${ms > 60_000 ? 's' : ''}`;

export const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

interface Conn { client: Client; ready: Promise<Client>; lastUsed: number; channels: number; waiters: (() => void)[] }
const MAX_CHANNELS = 8; // OpenSSH allows 10 sessions per connection by default

export class SshPool {
  private conns = new Map<string, Conn>();
  private reaper: NodeJS.Timeout;
  private app: App;

  constructor(app: App) {
    this.app = app;
    this.reaper = setInterval(() => {
      for (const [id, c] of this.conns) if (c.channels === 0 && Date.now() - c.lastUsed > 5 * 60_000) this.close(id);
    }, 60_000);
    this.reaper.unref();
  }

  // servers that didn't answer: when the next attempt is allowed, how many failed in a row, and why
  private down = new Map<string, { until: number; fails: number; why: string }>();

  // Why Unit7 won't sign in to this server right now (an error to throw), or undefined if it may try
  private blocked(s: ServerRow): Unit7Error | undefined {
    const block = get<{ ssh_block: string | null }>(this.app.db, 'SELECT ssh_block FROM servers WHERE id = ?', s.id)?.ssh_block;
    if (block === 'key') return keyError(this.app, s);
    if (block === 'host_key') return new Unit7Error('host_key_changed', `${s.name}'s SSH host key changed, so Unit7 stopped connecting to it. If you rebuilt the server, trust the new identity in Servers → ${s.name}. If you didn't, something may be intercepting the connection.`, 409);
    const d = this.down.get(s.id);
    if (d && d.until > Date.now()) return new Unit7Error('unreachable', `${d.why} Unit7 tries again in ${inWords(d.until - Date.now())}.`, 502, { retryable: false });
  }
  keyRefused(serverId: string) { return get<{ ssh_block: string | null }>(this.app.db, 'SELECT ssh_block FROM servers WHERE id = ?', serverId)?.ssh_block === 'key'; }
  // A person says something changed (the key is in place, a new network): the next call may try once.
  unblock(serverId: string) { this.down.delete(serverId); run(this.app.db, `UPDATE servers SET ssh_block = NULL WHERE id = ? AND ssh_block = 'key'`, serverId); }
  // Something just answered on the server's SSH port (a person's check): stop waiting out the backoff.
  answered(serverId: string) { this.down.delete(serverId); }

  private connect(s: ServerRow): Conn {
    const client = new Client();
    const conn: Conn = { client, lastUsed: Date.now(), channels: 0, waiters: [], ready: undefined as never };
    // only ever forget this connection: a late close of an old one must not drop its replacement from the pool
    const forget = () => { if (this.conns.get(s.id) === conn) this.conns.delete(s.id); };
    const stop = this.blocked(s);
    conn.ready = stop ? Promise.reject(stop) : new Promise<Client>((resolve, reject) => {
      let hostKeyProblem: Unit7Error | undefined, answered = false, failed = false;
      client
        .on('connect', () => { answered = true; })
        .on('ready', () => { this.down.delete(s.id); resolve(client); })
        .on('error', (e: Error & { level?: string; code?: string }) => {
          if (failed) return; // one failed connection counts once, however many errors it reports
          failed = true;
          forget();
          if (hostKeyProblem) {
            run(this.app.db, `UPDATE servers SET ssh_block = 'host_key' WHERE id = ?`, s.id);
            return reject(hostKeyProblem);
          }
          if (e.level === 'client-authentication' || /authentication/i.test(e.message)) {
            run(this.app.db, `UPDATE servers SET ssh_block = 'key', status = CASE WHEN status IN ('ready','connected','unreachable','new','error') THEN 'awaiting_key' ELSE status END WHERE id = ?`, s.id);
            this.app.events.emit(s.org_id, 'server.key_refused', `${s.name} refused Unit7’s SSH key. Unit7 stopped signing in until the key is added.`, { severity: 'warning', resource: s.id });
            return reject(keyError(this.app, s));
          }
          // no answer, turned away, or dropped mid-way: wait longer after each failure in a row
          const fails = (this.down.get(s.id)?.fails ?? 0) + 1, wait = WAITS[Math.min(fails, WAITS.length) - 1]!;
          const why = e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? `${s.host} doesn’t resolve to an address.`
            : e.code === 'ECONNREFUSED' ? `${s.name} turned the connection away on port ${s.port}: SSH isn’t running there, or a firewall rejects it.`
            : !answered ? `${s.name} (${s.host}) didn’t answer on port ${s.port}. If it’s switched on, it’s most likely blocking this computer’s internet address (fail2ban or a firewall): try from a phone hotspot or over Tailscale.`
            : `${s.name} answered, but the SSH sign-in didn’t finish (${/timed out/i.test(e.message) ? 'timed out' : e.message}).`;
          this.down.set(s.id, { until: Date.now() + wait, fails, why });
          reject(new Unit7Error('unreachable', `${why} Unit7 tries again in ${inWords(wait)}.`, 502, { retryable: false }));
        })
        .on('close', forget);
      const start = (hop?: NodeJS.ReadableStream) => client.connect({
          ...(hop && { sock: hop as never }), host: s.host, port: s.port, username: s.username,
          privateKey: this.app.vault.resolve(s.org_id, s.key_ref),
          readyTimeout: 15_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            const fp = fingerprint(key);
            const pinned = get<{ host_key: string | null }>(this.app.db, 'SELECT host_key FROM servers WHERE id = ?', s.id)?.host_key;
            if (!pinned) {
              run(this.app.db, 'UPDATE servers SET host_key = ? WHERE id = ?', fp, s.id);
              return true;
            }
            if (pinned === fp) return true;
            hostKeyProblem = new Unit7Error('host_key_changed',
              `${s.name}'s SSH host key changed (expected ${pinned}, got ${fp}). Either the server was rebuilt or someone is intercepting the connection. Unit7 stopped connecting to it. If you rebuilt it, trust the new key in Servers → ${s.name}.`, 409);
            this.app.events.emit(s.org_id, 'server.host_key_changed', `${s.name}'s SSH host key changed; Unit7 refused to connect.`, { severity: 'critical', resource: s.id });
            return false;
          },
        });
      const facts = json<{ jump?: { host: string; port: number; username: string; hostKey?: string } }>(s.facts, {}), jump = facts.jump;
      if (!jump) { start(); return; }
      // one hop through a jump host (ProxyJump in ~/.ssh/config), signed in with the same key, its identity pinned the same way
      const hop = new Client();
      hop.on('ready', () => hop.forwardOut('127.0.0.1', 0, s.host, s.port, (err, stream) => { if (err) { hop.end(); client.emit('error', err); return; } stream.on('close', () => hop.end()); start(stream); }))
        .on('error', (e) => client.emit('error', e))
        .connect({ host: jump.host, port: jump.port, username: jump.username, privateKey: this.app.vault.resolve(s.org_id, s.key_ref), readyTimeout: 15_000,
          hostVerifier: (key: Buffer) => { const fp = fingerprint(key); if (!jump.hostKey) { run(this.app.db, 'UPDATE servers SET facts = ? WHERE id = ?', JSON.stringify({ ...facts, jump: { ...jump, hostKey: fp } }), s.id); return true; } return jump.hostKey === fp; } });
    });
    conn.ready.catch(forget); // surfaced to whoever awaits it
    return conn;
  }

  private async acquire(s: ServerRow) {
    let c = this.conns.get(s.id);
    if (!c) this.conns.set(s.id, (c = this.connect(s)));
    const client = await c.ready;
    while (c.channels >= MAX_CHANNELS) await new Promise<void>((r) => c!.waiters.push(r));
    c.channels++;
    c.lastUsed = Date.now();
    return { client, release: () => { c!.channels--; c!.lastUsed = Date.now(); c!.waiters.shift()?.(); } };
  }

  async exec(s: ServerRow, command: string, o: ExecOptions = {}): Promise<ExecResult> {
    commandLog.getStore()?.push(command.slice(0, 600));
    const { client, release } = await this.acquire(s);
    const max = o.maxBytes ?? 4 * 1024 * 1024;
    try {
      return await new Promise<ExecResult>((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) return reject(new Unit7Error('connection', `Couldn't start a command on ${s.name}: ${err.message}`, 502, { retryable: true }));
          let stdout = '', stderr = '', size = 0, truncated = false, done = false;
          const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); fn(); } };
          const timer = setTimeout(() => {
            stream.close();
            finish(() => reject(new Unit7Error('timeout', `A command on ${s.name} took longer than ${Math.round((o.timeoutMs ?? 120_000) / 1000)}s and was stopped.`, 504)));
          }, o.timeoutMs ?? 120_000);
          const onAbort = () => { stream.close(); finish(() => reject(o.signal!.reason ?? new Unit7Error('aborted', 'Stopped.', 499))); };
          o.signal?.addEventListener('abort', onAbort, { once: true });
          const take = (which: 'out' | 'err') => (d: Buffer) => {
            const chunk = d.toString('utf8');
            o.onData?.(chunk, which);
            if (size + d.length > max) { truncated = true; return; }
            size += d.length;
            if (which === 'out') stdout += chunk; else stderr += chunk;
          };
          stream.on('data', take('out'));
          stream.stderr.on('data', take('err'));
          stream.on('close', (code: number | null) => finish(() => resolve({ code: code ?? -1, stdout, stderr, truncated })));
          if (o.stdin === undefined) stream.end();
          else if (typeof (o.stdin as NodeJS.ReadableStream).pipe === 'function') {
            // pipe() doesn't pass on a read error (an upload deleted mid-way): unhandled, it would crash Unit7
            const src = o.stdin as NodeJS.ReadableStream;
            src.once('error', (e: Error) => { finish(() => reject(new Unit7Error('stdin_failed', `Couldn't read what was being sent to ${s.name}: ${e.message}`, 502))); stream.close(); });
            src.pipe(stream);
          } else stream.end(o.stdin as string | Buffer);
        });
      });
    } finally {
      release();
      run(this.app.db, 'UPDATE servers SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), s.id);
    }
  }

  // exec that throws when the command fails, with its stderr as the reason
  async check(s: ServerRow, command: string, o: ExecOptions & { what?: string } = {}) {
    const r = await this.exec(s, command, o);
    if (r.code !== 0) throw new Unit7Error('command_failed', `${o.what ?? 'A command'} failed on ${s.name} (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-800) || 'no output'}`, 502);
    return r.stdout;
  }

  // A long-running command whose output arrives line by line (log tails, docker events).
  async stream(s: ServerRow, command: string, onLine: (line: string, which: 'out' | 'err') => void, onEnd?: (err?: Error) => void) {
    const { client, release } = await this.acquire(s);
    let closed = false;
    return await new Promise<{ stop: () => void }>((resolve, reject) => {
      client.exec(command, (err, ch) => {
        if (err) { release(); return reject(new Unit7Error('connection', `Couldn't start a stream on ${s.name}: ${err.message}`, 502)); }
        const buf = { out: '', err: '' };
        const feed = (which: 'out' | 'err') => (d: Buffer) => {
          buf[which] += d.toString('utf8');
          let i: number;
          while ((i = buf[which].indexOf('\n')) !== -1) { onLine(buf[which].slice(0, i), which); buf[which] = buf[which].slice(i + 1); }
          if (buf[which].length > 64 * 1024) { onLine(buf[which], which); buf[which] = ''; }
        };
        ch.on('data', feed('out'));
        ch.stderr.on('data', feed('err'));
        ch.on('close', () => { if (!closed) { closed = true; release(); onEnd?.(); } });
        ch.end();
        resolve({ stop: () => { if (!closed) { closed = true; ch.close(); release(); } } });
      });
    });
  }

  // A file, byte for byte, off the server (backups going somewhere safe) or onto it (coming back).
  // Over a plain exec channel, so it works on any server with sh and cat; nothing is buffered in memory.
  async getFile(s: ServerRow, remote: string, local: string, o: { timeoutMs?: number } = {}) {
    await this.transfer(s, script('cat -- "$1"', remote), (ch) => { ch.end(); return pipeline(ch, createWriteStream(local)); }, o.timeoutMs);
  }
  async putFile(s: ServerRow, local: string, remote: string, o: { timeoutMs?: number } = {}) {
    // written next to the target, then renamed: a cut connection never leaves half a file under the real name.
    // (the channel's output is drained, or pipeline() waits forever for it to end)
    await this.transfer(s, script('umask 077; cat > "$1.part" && mv "$1.part" "$1"', remote), (ch) => { ch.resume(); return pipeline(createReadStream(local), ch); }, o.timeoutMs);
  }
  // One command's output poured into another command on a second server, through Unit7 (a fleet's image: docker save on
  // the server that built it, docker load on the next). Streamed: nothing is buffered in memory or written to disk here.
  async relay(from: ServerRow, fromCommand: string, to: ServerRow, toCommand: string, o: { timeoutMs?: number } = {}) {
    const { PassThrough } = await import('node:stream');
    const pass = new PassThrough();
    await Promise.all([
      this.transfer(from, fromCommand, (ch) => { ch.end(); return pipeline(ch, pass); }, o.timeoutMs),
      this.transfer(to, toCommand, (ch) => { ch.resume(); return pipeline(pass, ch); }, o.timeoutMs),
    ]);
  }
  private async transfer(s: ServerRow, command: string, pump: (ch: import('ssh2').ClientChannel) => Promise<void>, timeoutMs = 60 * 60_000) {
    const { client, release } = await this.acquire(s);
    try {
      await new Promise<void>((resolve, reject) => {
        client.exec(command, (err, ch) => {
          if (err) return reject(new Unit7Error('connection', `Couldn't start a transfer on ${s.name}: ${err.message}`, 502));
          let stderr = '';
          ch.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8').slice(0, 500); });
          const timer = setTimeout(() => { ch.close(); reject(new Unit7Error('timeout', `The transfer from ${s.name} took longer than ${Math.round(timeoutMs / 60_000)} minutes.`, 504)); }, timeoutMs);
          const closed = new Promise<number>((r) => ch.on('close', (code: number | null) => r(code ?? -1)));
          Promise.all([pump(ch), closed]).then(([, code]) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Unit7Error('transfer_failed', `Copying a file on ${s.name} failed: ${stderr.trim() || `exit ${code}`}`, 502));
          }, (e) => { clearTimeout(timer); ch.close(); reject(new Unit7Error('transfer_failed', `Copying a file on ${s.name} failed: ${(e as Error).message}`, 502)); });
        });
      });
    } finally { release(); }
  }

  close(serverId: string) {
    const c = this.conns.get(serverId);
    this.conns.delete(serverId);
    c?.client.end();
  }

  closeAll() {
    clearInterval(this.reaper);
    for (const id of [...this.conns.keys()]) this.close(id);
  }
}

function keyError(app: App, s: ServerRow) {
  const cmd = keyCommand(app, s);
  return new Unit7Error('key_refused', `${s.name} doesn’t have Unit7’s SSH key, so Unit7 isn’t signing in to it (signing in with a key the server refuses only gets your address banned). ${cmd ? `Run this once from a computer that can sign in: ${cmd}` : 'Add Unit7’s public key to the server’s ~/.ssh/authorized_keys.'} Then press “I’ve added it — check again” on the server’s page.`, 409, { retryable: false, command: cmd });
}

export function ssh(app: App): SshPool {
  return ((app.services.ssh as SshPool | undefined) ??= new SshPool(app));
}
