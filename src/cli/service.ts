// Keep Unit7 running in the background so connected AI agents always reach it: a LaunchAgent on
// macOS, a systemd user unit on Linux. Both restart Unit7 if it crashes and start it at login.
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform, userInfo } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'dev.unit7.server';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const UNIT = join(homedir(), '.config', 'systemd', 'user', 'unit7.service');
// the service as it was named before the rename
const OLD_LABEL = 'dev.forge.server';
const OLD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${OLD_LABEL}.plist`);
const OLD_UNIT = join(homedir(), '.config', 'systemd', 'user', 'forge.service');
function dropOld() {
  if (platform() === 'darwin' && existsSync(OLD_PLIST)) {
    try { execFileSync('launchctl', ['bootout', `gui/${userInfo().uid}/${OLD_LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    unlinkSync(OLD_PLIST);
  }
  if (platform() === 'linux' && existsSync(OLD_UNIT)) {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'forge'], { stdio: 'ignore' }); } catch { /* not running */ }
    unlinkSync(OLD_UNIT);
  }
}

export interface ServiceOptions { home: string; port: number }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function installService(o: ServiceOptions): string {
  dropOld();
  const node = process.execPath; // bin/unit7.mjs guarantees this is Node 24.15+
  const main = join(ROOT, 'src', 'main.ts');
  // background services get a bare PATH; Unit7 needs node, ssh-keygen, docker, git
  // system folders first, so nothing installed later (an npm package's bin) can stand in for `security` or `ssh-keygen`
  const path = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(node), '/opt/homebrew/bin', '/usr/local/bin'].join(':');
  mkdirSync(o.home, { recursive: true, mode: 0o700 });
  if (platform() === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(main)}</string><string>serve</string><string>--port</string><string>${o.port}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>UNIT7_HOME</key><string>${xml(o.home)}</string>
    <key>PATH</key><string>${xml(path)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(o.home, 'unit7.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(o.home, 'unit7.log'))}</string>
</dict></plist>
`;
    mkdirSync(dirname(PLIST), { recursive: true });
    writeFileSync(PLIST, plist);
    const domain = `gui/${userInfo().uid}`;
    try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    // launchd unloads asynchronously; loading again too soon fails with "Input/output error"
    for (let i = 0; ; i++) {
      try { execFileSync('launchctl', ['bootstrap', domain, PLIST], { stdio: 'ignore' }); break; }
      catch (e) { if (i >= 10) throw e; execFileSync('sleep', ['0.5']); }
    }
    return PLIST;
  }
  if (platform() === 'linux') {
    mkdirSync(dirname(UNIT), { recursive: true });
    writeFileSync(UNIT, `[Unit]\nDescription=Unit7 control plane\nAfter=network-online.target\n\n[Service]\nExecStart=${node} ${main} serve --port ${o.port}\nEnvironment=UNIT7_HOME=${o.home}\nEnvironment=PATH=${path}\nWorkingDirectory=${ROOT}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`);
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'unit7'], { stdio: 'ignore' });
    } catch {
      unlinkSync(UNIT);
      console.log('✗ Unit7 can\'t run in the background here: this machine has no systemd user service, which is common in containers. Start it with `node src/main.ts serve`, under a process manager if it should stay up.');
      process.exit(1);
    }
    // a user service stops at logout unless the user lingers, and on a VPS that's the moment you close SSH
    try { execFileSync('loginctl', ['enable-linger', userInfo().username], { stdio: 'ignore' }); }
    catch { console.log(`! Unit7 will stop when you log out. To keep it running, run: sudo loginctl enable-linger ${userInfo().username}`); }
    return UNIT;
  }
  throw new Error('Background service is supported on macOS and Linux. Run `unit7 serve` yourself.');
}

export function uninstallService(): boolean {
  dropOld();
  if (platform() === 'darwin' && existsSync(PLIST)) {
    try { execFileSync('launchctl', ['bootout', `gui/${userInfo().uid}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    unlinkSync(PLIST);
    return true;
  }
  if (platform() === 'linux' && existsSync(UNIT)) {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'unit7'], { stdio: 'ignore' }); } catch { /* not running */ }
    unlinkSync(UNIT);
    return true;
  }
  return false;
}

export const serviceInstalled = () => (platform() === 'darwin' ? existsSync(PLIST) : existsSync(UNIT));

export async function healthy(url: string): Promise<boolean> {
  try { const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}

export async function waitHealthy(url: string, ms = 25_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await healthy(url)) return true; await new Promise((r) => setTimeout(r, 700)); }
  return false;
}
