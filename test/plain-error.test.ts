// A failed deploy's toast once carried the whole build log. Toasts and chat lines say one plain sentence; the log goes
// under "Show details" (web/src/lib/words.ts plainError, toastBody), and tools keep the log apart (error.logTail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainError, toastBody } from '../web/src/lib/words.ts';

const LOG = [
  'The build failed.',
  '#12 [build 4/7] RUN pnpm install --frozen-lockfile',
  ' WARN  deprecated inflight@1.0.6: This module is not supported',
  'npm ERR! code EACCES',
  'Error: EACCES: permission denied, mkdir \'/app/node_modules/.pnpm\'',
  '    at Object.mkdirSync (node:fs:1372:3)',
  '    at /usr/local/lib/node_modules/pnpm/dist/pnpm.cjs:98:20',
].join('\n').repeat(40);

test('a long many-line build log becomes one short sentence, with the rest under details', () => {
  const p = plainError(LOG);
  assert.equal(p.line, 'The build failed.');
  assert.ok(p.more && p.more.length > 1000 && p.more.includes('EACCES'), 'the whole log stays for Show details');
  const t = toastBody(LOG);
  assert.equal(t.line, 'The build failed.');
  assert.ok(!t.line!.includes('\n') && t.line!.length <= 160, 'never more than a line in the toast');
});

test('the plain words the build doctor writes come first, one sentence of them', () => {
  const said = 'Part of your app needs Node 20 or newer, but the build used Node 18. Your repo doesn’t say which Node to use.\nThe version that was live keeps serving.\nWhat you can do:\n• Build with Node 20 (recommended)\n\nThe build failed.';
  assert.deepEqual(plainError(said).line, 'Part of your app needs Node 20 or newer, but the build used Node 18.');
  // a log line first: the first line that reads like words wins; a raw error after a colon is cut
  assert.equal(plainError('#5 [2/4] RUN npm ci\nnpm ERR! code ERESOLVE\nThe install couldn’t resolve your packages.').line, 'The install couldn’t resolve your packages.');
  assert.equal(plainError('Deploy failed: Error: EACCES: permission denied, mkdir /app').line, 'Deploy failed.');
  // nothing readable at all: a calm line, and the details
  assert.deepEqual(plainError('npm ERR! code E401\nnpm ERR! 401 Unauthorized'), { line: 'Something went wrong.', more: 'npm ERR! code E401\nnpm ERR! 401 Unauthorized' });
  // one very long sentence is cut on a word
  const long = plainError(`Unit7 couldn’t reach ${'the server and '.repeat(30)}gave up.`);
  assert.ok(long.line.length <= 160 && long.line.endsWith('…'));
});

test('short bodies stay exactly as written; secret addresses never reach the details', () => {
  assert.deepEqual(toastBody('Nothing was changed.'), { line: 'Nothing was changed.' });
  assert.deepEqual(toastBody('Choose one in the box: your Claude subscription, your Google account, or an API key.'), { line: 'Choose one in the box: your Claude subscription, your Google account, or an API key.' });
  assert.deepEqual(toastBody(undefined), {});
  const p = plainError('The build failed.\nusing credential://github/sam/token from the vault');
  assert.ok(p.more && !p.more.includes('credential://'), 'the reference is masked');
});
