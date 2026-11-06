// The 3D illustrations: every name the Illustration component knows has its file, with the width and height it claims
// (so nothing shifts while it loads), a transparent background, and a small download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../web/src/ui.tsx', import.meta.url), 'utf8');
const table = ui.match(/const ILLO = \{([\s\S]*?)\} as const;/)?.[1] ?? '';
const entries = [...table.matchAll(/'?([a-z-]+)'?: \[(\d+), (\d+)\]/g)].map((m) => ({ name: m[1]!, w: +m[2]!, h: +m[3]! }));

// a lossy webp with alpha starts RIFF....WEBPVP8X; flags at byte 20, canvas width-1 and height-1 as 24-bit little endian
function webp(name: string) {
  const b = readFileSync(new URL(`../web/public/illustrations/${name}.webp`, import.meta.url));
  assert.equal(b.toString('latin1', 0, 4), 'RIFF', name);
  assert.equal(b.toString('latin1', 8, 16), 'WEBPVP8X', `${name} has the extended header`);
  return { alpha: (b[20]! & 0x10) !== 0, w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1, bytes: b.length };
}

test('every illustration exists, matches its size, is see-through and small', () => {
  assert.ok(entries.length >= 17, 'the table was read');
  for (const e of entries) {
    const f = webp(e.name);
    assert.deepEqual([f.w, f.h], [e.w, e.h], `${e.name} width and height`);
    assert.ok(f.alpha, `${e.name} has a transparent background`);
    assert.ok(f.bytes < 20_000, `${e.name} is ${f.bytes} bytes`);
  }
});
