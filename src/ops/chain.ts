// The audit chain, on its own so a saved log can be checked with nothing else running.
import { createHash } from 'node:crypto';

export const chainOf = (prev: string, row: { id: string; actor: string; tool: string; input: string | null; result: string }) => createHash('sha256').update(`${prev}\n${row.id}\n${row.actor}\n${row.tool}\n${row.input ?? ''}\n${row.result}`).digest('hex');
export function verifyLines(lines: string[]) {
  let prev: string | undefined;
  for (const [i, l] of lines.entries()) {
    const r = JSON.parse(l) as { id: string; actor: string; tool: string; input: string | null; result: string; chain: string; prev: string };
    if (prev !== undefined && r.prev !== prev) return { ok: false, at: i + 1, why: `Line ${i + 1} doesn’t follow the one before it.` };
    if (chainOf(r.prev, r) !== r.chain) return { ok: false, at: i + 1, why: `Line ${i + 1} was changed.` };
    prev = r.chain;
  }
  return { ok: true, lines: lines.length, head: prev };
}
