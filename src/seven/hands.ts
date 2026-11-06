// What Seven may look with and what it may reach for. Two short lists, in one place, so what it can do fits on a page. While it
// thinks it holds a key limited to EYES, enforced where every tool runs (Actor.only), so nothing it reads can make it change
// anything. Only the fixed code in shift.ts turns a proposal into an action, and only for something in HANDS.
import { createHash } from 'node:crypto';

export const EYES = [
  'server.usage', 'server.traffic', 'logs.digest', 'inspect.list', 'cron.map', 'story.timeline', 'story.replay', 'coolify.deployments', 'deploys.explain', 'project.passport', 'finding.get',
  'lookup.software', 'lookup.outage', 'playbook.read', 'code.search', 'code.read', 'code.dependencies',
] as const;
export const SEVEN_TOOLS: readonly string[] = [...EYES, 'seven.finish'];

// safe: it may do this alone when Unit7 measured the reason and the gate agrees. That's only what creates or copies, the promise Unit7
// makes everywhere (TRUST.md). A change to something that's running is a question, unless the person taught Seven that fix.
// copyFirst: a fresh copy comes first. allow: only these uses of a broad tool.
export interface Hand { safe: boolean; copyFirst?: boolean; allow?: (i: Record<string, unknown>) => boolean; word: string }
export const HANDS: Record<string, Hand> = {
  // these only create or copy
  'safety.protect': { safe: true, word: 'protect a database' }, 'safety.copy': { safe: true, word: 'take a fresh copy' }, 'backup.create': { safe: true, word: 'back up' }, 'backup.verify': { safe: true, word: 'test a backup' },
  'part.backup': { safe: true, word: 'back up' }, 'part.backup_schedule': { safe: true, word: 'schedule backups for', allow: (i) => !i.off }, 'part.verify': { safe: true, word: 'test a backup of' }, 'part.copy_extras': { safe: true, word: 'copy files and settings of' }, 'part.scan_images': { safe: true, word: 'scan images of' },
  'server.swap': { safe: true, word: 'add swap' }, 'domain.renew_https': { safe: true, word: 'renew the certificate for' },
  // always a question: these change what's running. Old images and logs are gone for good, and a rollback may need them
  'server.time_sync': { safe: false, word: 'fix the clock' }, 'part.limits': { safe: false, word: 'cap the memory of' }, 'coolify.memory_cap': { safe: false, word: 'cap the memory of' },
  'part.restart': { safe: false, word: 'restart' }, 'service.restart': { safe: false, word: 'restart' }, 'coolify.control': { safe: false, word: 'restart', allow: (i) => i.action === 'restart' },
  'shield.block': { safe: false, word: 'block' }, 'server.close_port': { safe: false, word: 'close port', allow: (i) => !i.open },
  'docker.prune': { safe: false, word: 'clear old images' }, 'server.tidy_logs': { safe: false, word: 'tidy logs' },
  'deployment.rollback': { safe: false, copyFirst: true, word: 'roll back' }, 'domain.protect_email': { safe: false, word: 'protect email for' }, 'coolify.health_check': { safe: false, word: 'add a health check to' },
};
export const handOf = (tool: string, input: Record<string, unknown>): Hand | undefined => { const h = HANDS[tool]; return h && (!h.allow || h.allow(input)) ? h : undefined; };

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
// what the action is, not how it was put: a reason is words about it, so a new sentence doesn't make it a new action
export const hashOf = (tool: string, input: unknown) => { const { reason: _, ...what } = (input ?? {}) as Record<string, unknown>; return createHash('sha1').update(`${tool}:${stable(what)}`).digest('hex').slice(0, 16); };

export interface Plan { kind: 'do' | 'ask'; tool: string; input: Record<string, unknown>; why: string; because?: string; expect?: string; severity?: string; by: 'rule' | 'ai' }
export interface Scene { measured: ReadonlyMap<string, string>; learned: ReadonlySet<string>; toldNo: ReadonlySet<string>; done: ReadonlySet<string>; waiting: ReadonlySet<string>; green: (tool: string, input: Record<string, unknown>) => boolean; valid: (tool: string, input: Record<string, unknown>) => boolean; mayCopy: (input: Record<string, unknown>) => boolean; acts: number; asks: number; canAct: boolean; quiet: boolean }
export type Verdict = { go: 'run' | 'ask' } | { go: 'drop'; why: string };
export const LIMITS = { actsPerShift: 3, asksPerDay: 3 };

// (pure) Every proposal, from rules or from an AI, passes through here. Being sure isn't enough to act on: a line in a log could have
// talked the AI into anything. So alone, Seven only creates or copies, and beyond what's green only as the very fix Unit7 attached to
// something it measured itself. The AI's part is choosing which and when; it can't invent a target or a setting. The rest is a question.
export function judge(p: Plan, s: Scene): Verdict {
  const hand = handOf(p.tool, p.input), h = hashOf(p.tool, p.input);
  if (!hand) return { go: 'drop', why: 'outside what Seven may do' };
  if (!s.valid(p.tool, p.input)) return { go: 'drop', why: 'it didn’t make sense as an action' };
  if (s.toldNo.has(h)) return { go: 'drop', why: 'you said no to this' };
  if (s.done.has(h)) return { go: 'drop', why: 'done already' };
  if (s.waiting.has(h)) return { go: 'drop', why: 'already waiting for your answer' };
  if (!s.canAct) return { go: 'drop', why: 'it’s only looking right now' };
  if (hand.safe && !s.mayCopy(p.input)) return { go: 'drop', why: 'not now: a brake is on, or the server is busy' };
  const urgent = p.severity === 'critical' || p.severity === 'high';
  if (s.green(p.tool, p.input)) return s.acts > 0 ? { go: 'run' } : { go: 'drop', why: 'enough for one shift' };
  if (p.kind === 'do' && (hand.safe || s.learned.has(h)) && p.because && s.measured.get(p.because) === h && s.acts > 0) return { go: 'run' };
  if (s.quiet && !urgent) return { go: 'drop', why: 'it can wait until morning' };
  return s.asks > 0 || urgent ? { go: 'ask' } : { go: 'drop', why: 'enough questions for one day' };
}
