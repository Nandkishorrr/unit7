// What Warden's speech bubble says: one short line, each thing once a session, the first time all in one line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { didToday, nextSay, shortLine } from '../web/src/mascot/say.ts';

const items = [
  { id: 'incident:1', severity: 'alert' as const, text: 'Incident on the perimeter: api is down. I’m on it, but you’ll want to look.' },
  { id: 'harden:s1', severity: 'warn' as const, text: 'srv1’s doors aren’t checked yet: password logins and open ports.' },
  { id: 'tip:1', severity: 'info' as const, text: 'New: a guide to free plans.' },
];

test('a suggestion becomes one short line: its first clause, never longer than a line', () => {
  assert.equal(shortLine('db-staging is running without a safety net.'), 'db-staging is running without a safety net');
  assert.equal(shortLine('srv1’s doors aren’t checked yet: password logins and open ports.'), 'srv1’s doors aren’t checked yet');
  assert.equal(shortLine('web in Staging needs 1 setting: RESEND_API_KEY. Production has it.'), 'web in Staging needs 1 setting');
  const long = shortLine('a'.repeat(100));
  assert.equal(long.length, 64);
  assert.ok(long.endsWith('…'));
});

test('the first time in a session, two or more things are one line; red when one is an alert', () => {
  const s = nextSay(items, new Set());
  assert.deepEqual(s, { keys: ['incident:1', 'harden:s1', 'tip:1'], text: '2 things need a look', tone: 'bad' });
});

test('after that, each new thing on its own, most urgent first, and nothing is said twice', () => {
  const seen = new Set(['incident:1']);
  assert.deepEqual(nextSay(items, seen), { keys: ['harden:s1'], text: 'srv1’s doors aren’t checked yet', tone: 'warn' });
  seen.add('harden:s1');
  assert.equal(nextSay(items, seen)?.tone, 'info');
  seen.add('tip:1');
  assert.equal(nextSay(items, seen), null);
  assert.equal(nextSay([{ id: 'all-clear', severity: 'info', text: 'All clear.' }], new Set()), null);
});

test('a single thing to look at is said as itself, not as a count', () => {
  assert.equal(nextSay([items[1]!], new Set())?.text, 'srv1’s doors aren’t checked yet');
});

test('what Warden did today counts its own changes since midnight, not its reads or failures or anyone else', () => {
  const now = new Date(2026, 9, 7, 15, 0);
  const at = (h: number, d = 7) => new Date(2026, 9, d, h).toISOString();
  const rows = [
    { tool: 'backup.create', risk: 'write', result: 'success', created_at: at(9), agent: 'Warden' },
    { tool: 'service.restart', risk: 'write', result: 'success', created_at: at(13), agent: 'Warden' },
    { tool: 'server.metrics', risk: 'read', result: 'success', created_at: at(14), agent: 'Warden' },
    { tool: 'deployment.create', risk: 'write', result: 'error', created_at: at(14), agent: 'Warden' },
    { tool: 'deployment.create', risk: 'write', result: 'success', created_at: at(14), agent: 'Claude Code' },
    { tool: 'backup.create', risk: 'write', result: 'success', created_at: at(23, 6), agent: 'Warden' },
  ];
  assert.equal(didToday(rows, (t) => (t === 'service.restart' ? 'Restart an app' : t), now), 'Today I took care of 2 things. Last: restart an app.');
  assert.equal(didToday(rows.slice(2), (t) => t, now), 'A quiet day so far. I’m keeping watch.');
});
