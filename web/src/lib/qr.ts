// A small QR code encoder, all in the browser (nothing leaves the page): byte mode, error correction level M,
// versions 1–10 (up to 213 bytes, plenty for a link). Follows ISO/IEC 18004 the way Nayuki's reference does.
// qr(text) returns the dark modules as rows of booleans, without the quiet zone.
// ponytail: versions 1–10 only; add the rest of the block table if a link ever needs more than 213 bytes.
const ECC = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // error correction codewords per block, level M, versions 1–10
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

const rawModules = (v: number) => {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) { const a = Math.floor(v / 7) + 2; n -= (25 * a - 10) * a - 55; if (v >= 7) n -= 36; }
  return n;
};
const dataCodewords = (v: number) => Math.floor(rawModules(v) / 8) - ECC[v - 1]! * BLOCKS[v - 1]!;

// GF(256) with the 0x11D polynomial
const mul = (x: number, y: number) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
function divisor(degree: number) {
  const r = Array<number>(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = mul(r[j]!, root); if (j + 1 < r.length) r[j]! ^= r[j + 1]!; }
    root = mul(root, 2);
  }
  return r;
}
function remainder(data: number[], div: number[]) {
  const r = div.map(() => 0);
  for (const b of data) { const f = b ^ r.shift()!; r.push(0); div.forEach((c, i) => { r[i]! ^= mul(c, f); }); }
  return r;
}

export function qr(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1;
  for (; v <= 10; v++) if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8) break;
  if (v > 10) throw new Error('Too long for a QR code here');

  // the bit stream: byte mode, length, data, terminator, then pad bytes
  const bits: number[] = [];
  const put = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  const cap = dataCodewords(v) * 8;
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // split into blocks, add error correction, interleave
  const nBlocks = BLOCKS[v - 1]!, eccLen = ECC[v - 1]!, raw = Math.floor(rawModules(v) / 8);
  const short = nBlocks - (raw % nBlocks), shortLen = Math.floor(raw / nBlocks), div = divisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const d = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += d.length;
    const e = remainder(d, div);
    if (i < short) d.push(0);
    blocks.push([...d, ...e]);
  }
  const words: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= short) words.push(b[i]!); });

  // the fixed patterns
  const size = v * 4 + 17;
  const dark = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean) => { dark[y]![x] = on; fixed[y]![x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align: number[] = [];
  if (v > 1) {
    const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
    align.push(6);
    for (let p = size - 7; align.length < n; p -= step) align.splice(1, 0, p);
  }
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = (mask: number) => {
    const d = (0 << 3) | mask; // level M is 00
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = (i: number) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0); // reserve the area; the real bits go in once the mask is chosen
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (v << 12) | r;
    for (let i = 0; i < 18; i++) { const on = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, on); set(c, a, on); }
  }

  // the codewords, in the zigzag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fixed[y]![x] && i < words.length * 8) { dark[y]![x] = ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }

  // try the 8 masks, keep the one scanners like best
  const flip = (m: number, x: number, y: number) => [(x + y) % 2, y % 2, x % 3, (x + y) % 3, (Math.floor(x / 3) + Math.floor(y / 2)) % 2, ((x * y) % 2) + ((x * y) % 3), (((x * y) % 2) + ((x * y) % 3)) % 2, (((x + y) % 2) + ((x * y) % 3)) % 2][m] === 0;
  const apply = (m: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y]![x] && flip(m, x, y)) dark[y]![x] = !dark[y]![x]; };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    apply(m); format(m);
    const s = penalty(dark);
    if (s < bestScore) { best = m; bestScore = s; }
    apply(m); // undo (masking twice is a no-op)
  }
  apply(best); format(best);
  return dark;
}

// the standard's four penalty rules: long runs, 2×2 blocks, finder-like patterns, and the dark/light balance
function penalty(m: boolean[][]) {
  const n = m.length;
  let score = 0, darkCount = 0;
  const lines = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b <= n; b++) {
        if (b < n && get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      const at = (b: number) => (b >= 0 && b < n ? get(a, b) : false);
      for (let b = -4; b < n; b++) {
        const p = [1, 0, 1, 1, 1, 0, 1].every((d, k) => at(b + k) === (d === 1));
        if (p && ([-1, -2, -3, -4].every((k) => !at(b + k)) || [7, 8, 9, 10].every((k) => !at(b + k)))) score += 40;
      }
    }
  };
  lines((y, x) => m[y]![x]!);
  lines((x, y) => m[y]![x]!);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y]![x]) darkCount++;
    if (y + 1 < n && x + 1 < n && m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) score += 3;
  }
  return score + Math.max(0, Math.ceil(Math.abs(darkCount * 20 - n * n * 10) / (n * n)) - 1) * 10;
}
