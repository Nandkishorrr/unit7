// Your own ~/.ssh/config: a Host alias, its real address, user, port and one jump host. Tailscale needs nothing here: its names resolve
// like any other. Unit7 still uses its own key, so nothing else on this computer gets read.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HostConfig { hostName?: string; user?: string; port?: number; proxyJump?: string }
const glob = (p: string, s: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(s);
export function hostConfig(text: string, alias: string): HostConfig {
  const out: HostConfig = {};
  let on = true; // lines before the first Host apply to all
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(l);
    if (!m) continue;
    const k = m[1]!.toLowerCase(), v = m[2]!.trim().replace(/^"|"$/g, '');
    if (k === 'host') { const pats = v.split(/\s+/); on = pats.some((p) => !p.startsWith('!') && glob(p, alias)) && !pats.some((p) => p.startsWith('!') && glob(p.slice(1), alias)); continue; }
    if (k === 'match') { on = false; continue; }
    if (!on) continue;
    if (k === 'hostname' && !out.hostName) out.hostName = v.replace(/%h/g, alias);
    if (k === 'user' && !out.user) out.user = v;
    if (k === 'port' && !out.port) out.port = Number(v);
    if (k === 'proxyjump' && !out.proxyJump && v.toLowerCase() !== 'none') out.proxyJump = v.split(',')[0]!.trim();
  }
  return out;
}
export const parseJump = (s: string) => { const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(s); return m ? { user: m[1], host: m[2]!, port: m[3] ? Number(m[3]) : 22 } : undefined; };
export function fromSshConfig(alias: string, file = join(homedir(), '.ssh', 'config')): HostConfig & { jump?: { host: string; port: number; username: string } } {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8'), c = hostConfig(text, alias), jump = c.proxyJump ? parseJump(c.proxyJump) : undefined;
  if (!jump) return c;
  const j = hostConfig(text, jump.host);
  return { ...c, jump: { host: j.hostName ?? jump.host, port: j.port ?? jump.port, username: jump.user ?? j.user ?? 'root' } };
}
