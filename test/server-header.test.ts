// The server header's rings: the colour step for each load, the usual for this time from the watch's baselines (memory
// as a share of the total, the disk as how it moved over the range), and the words that compare the ring with the usual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOf, ringUsual, vsUsual } from '../web/src/pages/servers/shape.ts';

const GB = 1e9;
const at = (h: number) => new Date(Date.UTC(2026, 9, 8, 0, 0) + h * 3_600_000).toISOString();

test('rings: calm under 70%, amber from 70, red from 90, none when not measured', () => {
  assert.deepEqual([0, 69.9, 70, 89.9, 90, 100].map(loadOf), ['calm', 'calm', 'warm', 'warm', 'hot', 'hot']);
  assert.equal(loadOf(null), 'none');
  assert.equal(loadOf(Number.NaN), 'none');
});

test('rings: the usual comes from the band at the last reading; memory as a share of the total', () => {
  const s = {
    points: [{ at: at(0), cpu: 10, mem: 8 * GB, disk: 200 * GB }, { at: at(12), cpu: 30, mem: 16 * GB, disk: 201 * GB }, { at: at(24), cpu: null, mem: null, disk: 203.5 * GB }],
    band: { cpu: [null, { mid: 18 }, null], mem: [null, { mid: 12.8 * GB }, null] },
  };
  const u = ringUsual(s, 32 * GB);
  assert.equal(u.cpu, 18);
  assert.equal(u.mem, 40);
  assert.deepEqual(u.disk, { dir: 'up', text: 'Grew 3.5 GB over the last day' });
  assert.equal(ringUsual(s).mem, undefined, 'no total, no share');
  assert.deepEqual(ringUsual(undefined), { cpu: undefined, disk: undefined });
});

test('rings: no band yet means still learning; a short or flat disk line says so', () => {
  const s = { points: [{ at: at(0), cpu: 5, mem: GB, disk: 50 * GB }, { at: at(6), cpu: 6, mem: GB, disk: 50.1 * GB }], band: { cpu: [null, null], mem: [null, null] } };
  const u = ringUsual(s, 4 * GB);
  assert.equal(u.cpu, 'learning');
  assert.deepEqual(vsUsual(40, u.cpu), { dir: 'learning', text: 'Still learning what’s normal here' });
  assert.deepEqual(u.disk, { dir: 'flat', text: 'Steady over the last 6 hours' });
  const freed = ringUsual({ ...s, points: [s.points[0]!, { ...s.points[1]!, disk: 47 * GB }] });
  assert.deepEqual(freed.disk, { dir: 'down', text: '3 GB freed over the last 6 hours' });
  assert.equal(ringUsual({ ...s, points: [s.points[0]!] }).disk, undefined, 'one reading has no direction');
});

test('rings: the reading now against the usual, in plain words', () => {
  assert.deepEqual(vsUsual(59, 63), { dir: 'down', text: 'Lower than usual: usually about 63% at this time' });
  assert.deepEqual(vsUsual(81, 52.4), { dir: 'up', text: 'Higher than usual: usually about 52% at this time' });
  assert.deepEqual(vsUsual(20, 18), { dir: 'flat', text: 'About usual: usually about 18% at this time' });
  assert.equal(vsUsual(null, 18), null);
  assert.equal(vsUsual(20, undefined), null);
});
