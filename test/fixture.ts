// A disposable SSH + Docker "VPS" (test/server/Dockerfile) for tests that need a real server.
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const dockerAvailable = () => { try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; } };

const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-fixture-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'k')]);
  try { execSync('docker image inspect unit7-test-server', { stdio: 'ignore' }); } catch {
    execFileSync('docker', ['build', '-q', '-t', 'unit7-test-server', fileURLToPath(new URL('./server', import.meta.url))], { stdio: 'ignore' }); // a real path, not %20-encoded
  }
  const [sshPort, httpPort] = [await freePort(), await freePort()];
  const name = `unit7-test-${process.pid}-${sshPort}`;
  execFileSync('docker', ['run', '-d', '--privileged', '--name', name, '-p', `${sshPort}:22`, '-p', `${httpPort}:80`, '-e', `AUTHORIZED_KEY=${readFileSync(join(dir, 'k.pub'), 'utf8').trim()}`, 'unit7-test-server'], { stdio: 'ignore' });
  // wait for sshd and the inner dockerd
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync('docker', ['exec', name, 'docker', 'info'], { stdio: 'ignore' });
      break;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  preloadImages(name);
  return {
    name, sshPort, httpPort, privateKey: readFileSync(join(dir, 'k'), 'utf8'),
    stop: () => { try { execFileSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' }); } catch { /* already gone */ } },
  };
}

// Every test server is a fresh Docker, so without this it pulls Caddy, Postgres, Node… from Docker Hub
// on every run and soon hits the anonymous rate limit (429). Images already on this machine are copied
// in instead; anything missing is still pulled by the server itself as usual.
const IMAGES = ['alpine:3.21', 'caddy:2.11.7-alpine', 'curlimages/curl:latest', 'postgres:17-alpine', 'redis:7-alpine', 'node:22-alpine', 'zricethezav/gitleaks:v8.30.1', 'aquasec/trivy:latest'];
function preloadImages(container: string) {
  const have = IMAGES.filter((img) => { try { execFileSync('docker', ['image', 'inspect', img], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!have.length) return;
  try { execSync(`docker save ${have.join(' ')} | docker exec -i ${container} docker load -q`, { stdio: 'ignore', maxBuffer: 1 << 30 }); } catch { /* the server pulls them instead */ }
}
