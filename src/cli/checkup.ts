// `unit7 checkup`: the same record the web app shows, for a terminal or a CI job. Exit codes: 1 it failed, 2 waiting for an
// approval, 3 not allowed, 4 it found something at or above --fail-on.
import { tool } from './client.ts';
import type { Checkup } from '../care/checkup.ts';

const RANK = ['critical', 'high', 'medium', 'low'];
const rankOf = (s: string) => { const i = RANK.indexOf(s === 'warning' ? 'medium' : s); return i < 0 ? 9 : i; };
export const breaches = (c: Pick<Checkup, 'items'>, failOn: string) => c.items.filter((i) => rankOf(i.severity) <= rankOf(failOn));
const WORDS = { room: 'Room', protection: 'Protection', safety: 'Safety', app: 'App behaviour' } as const;

export function render(c: Checkup) {
  const ok = c.checked.filter((x) => x.ok).length, skipped = c.checked.filter((x) => !x.ok), lines = [c.line, ''];
  if (c.since) lines.push(`Since last time: ${c.since.fixed.length} fixed · ${c.since.fresh.length} new · ${c.since.same} the same`, '');
  for (const [k, w] of Object.entries(WORDS)) { const v = c.verdicts[k as keyof typeof WORDS]; lines.push(`${w.padEnd(14)} ${v.word}: ${v.line}`); }
  lines.push('', `Checked ${ok} of ${c.checked.length}${skipped.length ? ` · ${skipped.length} skipped` : ''}`);
  for (const x of skipped.slice(0, 6)) lines.push(`  - ${x.label}${x.why ? `: ${x.why}` : ''}`);
  if (c.done.length) lines.push('', 'Done for you', ...c.done.map((d) => `  ${d}`));
  const first = c.items.filter((i) => rankOf(i.severity) <= 2).slice(0, 5);
  if (first.length) lines.push('', 'Do these first', ...first.map((i, n) => `  ${n + 1}. ${i.title} (${i.who === 'unit7' ? 'Unit7 can do this' : i.who === 'your-ai' ? 'your AI' : 'only you'})`));
  if (c.reduce.length) lines.push('', 'Reduce', ...c.reduce.slice(0, 5).map((r) => `  ${r.title}: ${r.saves}`));
  return lines.join('\n');
}

export async function checkupCli(o: { quick?: boolean; server?: string; json?: boolean; failOn?: string }) {
  if (o.failOn && !RANK.includes(o.failOn)) { console.error(`--fail-on takes ${RANK.join(', ')}.`); process.exit(1); }
  if (!o.json) console.error('Checking… about a minute.');
  const c = await tool('checkup.run', { quick: !!o.quick, ...(o.server && { serverId: o.server }) }, { quiet: true }) as Checkup;
  console.log(o.json ? JSON.stringify(c, null, 2) : render(c));
  if (o.failOn && breaches(c, o.failOn).length) process.exit(4);
}
