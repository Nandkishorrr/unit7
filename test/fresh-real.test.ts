// Keep it fresh, for real: the Apply step's script in a real container against a local bare git repo. A pinned
// requirements.txt gets its new versions on a new branch, committed and pushed, with the diff shown; a second run with
// nothing to change says so; a revert takes the change back out. Skips without Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerAvailable } from './fixture.ts';
import { APPLY } from '../src/fresh/pipeline.ts';

const skip = !dockerAvailable() && 'Docker is not available';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'unit7-fresh-')), bare = join(root, 'shop.git'), work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, work]);
  writeFileSync(join(work, 'requirements.txt'), 'Django==4.2.7  # web\nrequests[security]==2.31.0\nflask>=2\n');
  git(work, 'add', '-A'); git(work, '-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-qm', 'first'); git(work, 'push', '-q', 'origin', 'main');
  return { bare, work };
}
function apply(bare: string, env: Record<string, string>) {
  const file = join(mkdtempSync(join(tmpdir(), 'unit7-env-')), 'e.env');
  writeFileSync(file, Object.entries({ GIT_TOKEN: 'x', REPO: 'sam/shop', BASE: 'main', GIT_URL: '/repo', MANAGER: 'pip', UP_PROD: '', UP_DEV: '', AUDIT: '0', MSG: 'Update 2 libraries', REVERT: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', ...env }).map(([k, v]) => `${k}=${v}`).join('\n'));
  return execFileSync('docker', ['run', '--rm', '--env-file', file, '-v', `${bare}:/repo`, 'python:3.13-alpine', 'sh', '-c', APPLY], { encoding: 'utf8' });
}

test('Apply: the new versions on their own branch, pushed, with the diff; nothing to change says so; a revert takes it back', { skip }, () => {
  const { bare, work } = repo();
  const out = apply(bare, { BRANCH: 'unit7/updates-test', UP_PROD: 'django==4.2.8 Requests==2.32.3' });
  assert.match(out, /@@base [0-9a-f]{40}/);
  assert.match(out, /PUSHED/);
  assert.match(out, /\+Django==4\.2\.8 {2}# web/);
  git(work, 'fetch', '-q', 'origin');
  assert.equal(git(work, 'show', 'origin/unit7/updates-test:requirements.txt'), 'Django==4.2.8  # web\nrequests[security]==2.32.3\nflask>=2');
  assert.equal(git(work, 'show', 'origin/main:requirements.txt').split('\n')[0], 'Django==4.2.7  # web', 'the main branch is never pushed to');
  assert.match(apply(bare, { BRANCH: 'unit7/updates-test', UP_PROD: 'django==4.2.8' }), /NOCHANGE/, 'run again: the same branch, nothing new');
  const sha = git(work, 'rev-parse', 'origin/unit7/updates-test');
  const undo = apply(bare, { BRANCH: 'unit7/updates-test', REVERT: sha });
  assert.match(undo, /PUSHED/);
  git(work, 'fetch', '-q', 'origin');
  assert.equal(git(work, 'show', 'origin/unit7/updates-test:requirements.txt').split('\n')[0], 'Django==4.2.7  # web');
});
