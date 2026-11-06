// The QR codes on the phone alerts pop-up are made in the browser. These outputs were decoded back with the system's
// own QR reader (CoreImage) when written; a change to the encoder that alters them has to be checked the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { qr } from '../web/src/lib/qr.ts';

const hash = (m: boolean[][]) => createHash('sha256').update(m.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);

test('QR codes: known-good output, the smallest version that fits, too long refused', () => {
  assert.equal(hash(qr('https://example.com')), '93b806b398e97871');
  assert.equal(hash(qr('ntfy://ntfy.sh/unit7-abcdefghijklmnopqrstuvwx?display=Unit7')), '2df29bcf74b58dc4');
  assert.equal(qr('hi').length, 21, 'version 1');
  assert.equal(qr('y'.repeat(213)).length, 57, 'version 10 holds 213 bytes');
  assert.throws(() => qr('y'.repeat(214)));
});
