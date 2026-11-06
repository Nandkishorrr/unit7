// The calm server page's one list of what needs a look: findings and usage jumps together, most serious first,
// an alert that repeats a finding said once, cleared ones gone; and the Room tile's words for the disk forecast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionItems, roomLeft, type AAlert, type AFinding } from '../web/src/pages/servers/shape.ts';

const f = (id: string, bucket: AFinding['bucket'], severity: AFinding['severity']) =>
  ({ id, bucket, severity, title: id, fix: { tool: 'server.close_port', input: {}, label: 'Close it', change: 'Closes it.' } });
const alert = (id: string, key: string, severity: string, cleared: string | null = null): AAlert => ({ id, key, severity, title: `alert ${id}`, cleared });

test('attention: one list, most serious first, risks before waste before tips, each said once', () => {
  const out = {
    risks: [f('port', 'risk', 'high'), f('traffic:anon', 'risk', 'medium')], waste: [f('images', 'waste', 'medium')], tips: [f('scan', 'tip', 'low')] };
  const items = attentionItems(out, [alert('a1', 'usage:leak', 'warning'), alert('a2', 'traffic:anon', 'high'), alert('a3', 'usage:old', 'critical', '2026-10-07T11:00:00Z'), alert('a4', 'usage:loop', 'critical')]);
  assert.deepEqual(items.map((i) => i.id), ['alert:a4', 'port', 'alert:a1', 'traffic:anon', 'images', 'scan']);
  assert.equal(items.find((i) => i.id === 'alert:a1')!.severity, 'medium', 'the watch’s "warning" sits with medium');
  assert.ok(!items.some((i) => i.id === 'alert:a2'), 'the traffic alert is the traffic finding, said once');
  assert.ok(!items.some((i) => i.id === 'alert:a3'), 'cleared jumps are gone');
  assert.deepEqual(items.find((i) => i.id === 'port')!.fix, out.risks[0]!.fix, 'its one-click fix comes along');
  assert.deepEqual(attentionItems(null, []), []);
});

test('room: the disk forecast in the Room tile’s words', () => {
  assert.equal(roomLeft('full in about 5 months'), 'About 5 months left on the disk');
  assert.equal(roomLeft('full in about 3 days'), 'About 3 days left on the disk');
  assert.equal(roomLeft(null), null);
});
