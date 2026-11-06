// BLAKE3 for Cloudflare Pages, which names each file with it. Node has none, and wrangler's blake3-wasm would be a new
// dependency for one function, so this is the spec's algorithm (github.com/BLAKE3-team/BLAKE3-specs), hash mode, 32 bytes
// out, checked against the official test vectors in test/gap-hosts.test.ts.
import { extname } from 'node:path';

const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const CHUNK_START = 1, CHUNK_END = 2, PARENT = 4, ROOT = 8, BLOCK = 64, CHUNK = 1024;
const PERMUTE = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
// the message words of each of the 7 rounds: each round is the one before, permuted
const ROUNDS = [[...PERMUTE.keys()]];
while (ROUNDS.length < 7) ROUNDS.push(PERMUTE.map((i) => ROUNDS.at(-1)![i]!));

const v = new Uint32Array(16);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
function g(a: number, b: number, c: number, d: number, x: number, y: number) {
  v[a] = v[a]! + v[b]! + x; v[d] = rotr(v[d]! ^ v[a]!, 16); v[c] = v[c]! + v[d]!; v[b] = rotr(v[b]! ^ v[c]!, 12);
  v[a] = v[a]! + v[b]! + y; v[d] = rotr(v[d]! ^ v[a]!, 8); v[c] = v[c]! + v[d]!; v[b] = rotr(v[b]! ^ v[c]!, 7);
}
function compress(cv: Uint32Array, m: Uint32Array, counter: number, len: number, flags: number) {
  v.set(cv); v.set(IV.slice(0, 4), 8);
  v[12] = counter; v[13] = counter / 2 ** 32; v[14] = len; v[15] = flags;
  for (const s of ROUNDS) {
    g(0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!); g(1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!); g(2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!); g(3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
    g(0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!); g(1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!); g(2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!); g(3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
  }
  return cv.map((_, i) => v[i]! ^ v[i + 8]!);
}

function chunk(input: Uint8Array, start: number, end: number, counter: number, root: number) {
  const m = new Uint32Array(16);
  let cv = Uint32Array.from(IV);
  for (let at = start; ; at += BLOCK) {
    const len = Math.min(BLOCK, end - at), last = at + BLOCK >= end;
    m.fill(0);
    for (let i = 0; i < len; i++) m[i >> 2] = m[i >> 2]! | (input[at + i]! << ((i & 3) * 8));
    cv = compress(cv, m, counter, len, (at === start ? CHUNK_START : 0) | (last ? CHUNK_END | root : 0));
    if (last) return cv;
  }
}

// the left side of every parent holds the largest power of two of chunks that leaves something for the right
function tree(input: Uint8Array, start: number, len: number, counter: number, root: number): Uint32Array {
  if (len <= CHUNK) return chunk(input, start, start + len, counter, root);
  const left = CHUNK * 2 ** (31 - Math.clz32(Math.ceil(len / CHUNK) - 1));
  const m = new Uint32Array(16);
  m.set(tree(input, start, left, counter, 0));
  m.set(tree(input, start + left, len - left, counter + left / CHUNK, 0), 8);
  return compress(Uint32Array.from(IV), m, 0, BLOCK, PARENT | root);
}

export const blake3 = (input: Uint8Array) => Buffer.from(tree(input, 0, input.length, 0, ROOT).buffer).toString('hex');

// what Pages calls a file: wrangler's hashFile (workers-sdk, packages/deploy-helpers/src/deploy/helpers/hash.ts) hashes the
// file's base64 plus its extension, and keeps 32 hex characters
export const pagesHash = (bytes: Buffer, path: string) => blake3(Buffer.from(bytes.toString('base64') + extname(path).slice(1))).slice(0, 32);
