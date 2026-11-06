#!/usr/bin/env node
// Unit7 runs its TypeScript source directly, which needs Node 24.15+. If this shell's `node` is
// older, find a newer one (UNIT7_NODE, nvm, Homebrew) and hand over to it, so `unit7` (and the old `unit7`) just works.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ok = (v) => { const [a, b] = v.replace(/^v/, '').split('.').map(Number); return a > 24 || (a === 24 && b >= 15); };

// October's Node security release: a warning, not a stop, so an older machine still starts
const [maj, min] = process.versions.node.split('.').map(Number);
if (ok(process.versions.node) && maj === 24 && min < 22) console.error(`Unit7: Node ${process.versions.node} works, but 24.22.1 has security fixes. Update when you can.`);
if (!ok(process.versions.node)) {
  const nvm = join(homedir(), '.nvm', 'versions', 'node');
  const candidates = [
    process.env.UNIT7_NODE,
    ...(existsSync(nvm) ? readdirSync(nvm).filter(ok).sort((x, y) => y.localeCompare(x, undefined, { numeric: true })).map((v) => join(nvm, v, 'bin', 'node')) : []),
    '/opt/homebrew/bin/node', '/usr/local/bin/node',
  ].filter(Boolean);
  const node = candidates.find((c) => existsSync(c) && ok(spawnSync(c, ['-v'], { encoding: 'utf8' }).stdout?.trim() ?? '0'));
  if (!node) {
    console.error(`Unit7 needs Node 24.15 or newer (this shell has ${process.versions.node}). Install it, e.g. \`nvm install 24\`.`);
    process.exit(1);
  }
  const self = realpathSync(fileURLToPath(import.meta.url));
  const r = spawnSync(node, [self, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

await import('../src/main.ts');
