// What the ask box offers once the AI has answered (gray in the empty box, Tab fills it in, ↑↓ switch): the AI's own
// next replies (its hidden `<<next: …>>` line, which the server strips and keeps on the message), or, when it gave none,
// a few from what just happened in the turn. Pure, so it's tested (test/next-reply.test.ts). They only ever fill the
// box; nothing sends by itself.
import type { ChatMsg } from './types.ts'; // .ts: the root typecheck resolves it the way Node does
import { recommendedOf, stepChoices } from '../../lib/choices.ts';

// approvalId: "Approve it" opens that approval (the step's own Approve button) instead of filling the box
// choiceOf: the message whose choice row holds it (Tab focuses that row's recommended button; nothing runs by itself)
export interface NextReply { text: string; approvalId?: string; choiceOf?: string }

const MAX = 3, LEN = 100;
// untrusted words: no control or invisible characters, no markup, one short line
export const tidyReply = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
  .replace(/<[^>]*>?/g, ' ').replace(/[<>`*|[\]{}\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, LEN).trim();

const LIST = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/gm;
const DEPLOYS = /^(deployment\.(create|rollback)|coolify\.build|staging\.create)$/;
const cap = (s: string) => (s.includes(' ') ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// the last question the reply asked ("…, or …?" / "Which one: a, b or c?")
function lastQuestion(text: string): string {
  const qs = text.replace(/\s*\n+\s*/g, '. ').match(/[^.!?]*\?/g) ?? []; // a line break ends a sentence too
  return (qs.at(-1) ?? '').trim();
}
// the choices a question spells out inline: "Should I deploy to staging or production?" → staging, production
function inlineChoices(q: string): string[] {
  const colon = q.lastIndexOf(':');
  const body = (colon > -1 ? q.slice(colon + 1) : q).replace(/\?+$/, '').trim();
  const parts = body.split(/,\s*(?:or\s+)?|\s+or\s+/i).map((p) => p.replace(/^(?:and|or)\s+/i, '').trim()).filter(Boolean);
  if (colon === -1) { // no list after a colon: the first choice follows its verb ("…deploy to staging")
    const lead = /^.*\b(?:to|on|with|use|using|for|want|prefer|keep|pick|choose|add|try|deploy|point|move)\s+/i;
    if (!/\s+or\s+/i.test(body) || !lead.test(parts[0] ?? '')) return [];
    parts[0] = parts[0]!.replace(lead, '');
  }
  return parts.length >= 2 && parts.length <= 4 && parts.every((p) => p && p.split(/\s+/).length <= 6) ? parts.map(cap) : [];
}
// a list's items as choices: "1. **Staging** — a test copy" → Staging
const listItems = (text: string) => [...text.matchAll(LIST)].map((m) => m[1]!.replace(/\*\*/g, '').split(/\s[—–-]\s|:\s/)[0]!.replace(/[.;,]$/, '').trim()).filter(Boolean);

export function nextReplies(messages: ChatMsg[], approvals: Map<string, string> = new Map()): NextReply[] {
  const from = messages.findLastIndex((m) => m.role === 'user');
  const turn = messages.slice(from + 1);
  if (!turn.length) return [];
  const out: NextReply[] = [];
  const add = (t: string, approvalId?: string, choiceOf?: string) => {
    const c = tidyReply(t);
    if (c && out.length < MAX && !out.some((o) => o.text.toLowerCase() === c.toLowerCase())) out.push({ text: c, ...(approvalId && { approvalId }), ...(choiceOf && { choiceOf }) });
  };

  // the newest decision in the turn offers its recommended choice first: a pick the AI marked, or the row of a step
  // that failed last (one the AI got past doesn't count)
  const lastTool = turn.findLast((m) => m.role === 'tool');
  const decision = turn.findLast((m) => (m.role === 'ask' && m.content.state === 'waiting') || (m === lastTool && m.content.status === 'error'));
  if (decision?.role === 'ask' && decision.content.spec.kind === 'choose') {
    const rec = decision.content.spec.options?.find((o) => o.recommended);
    if (rec) add(rec.label, undefined, decision.id);
  } else if (decision?.role === 'tool') {
    const rec = recommendedOf(stepChoices(decision.content));
    if (rec) add(rec.label, undefined, decision.id);
  }

  // a step that waits for your OK: open it
  for (const m of turn) {
    if (m.role === 'tool' && m.content.status === 'approval_required' && m.content.approvalId
      && (approvals.get(m.content.approvalId) ?? m.content.approvalState ?? 'pending') === 'pending') { add('Approve it', m.content.approvalId); break; }
  }
  const said = turn.findLast((m) => m.role === 'assistant');
  const text = said?.role === 'assistant' ? said.content.text : '';
  // the AI's own suggestions come first, and then that's it
  if (said?.role === 'assistant' && said.content.next?.length) { said.content.next.forEach((t) => add(t)); return out; }

  // otherwise, from what happened: a failure, a question with choices, a plan, a yes/no, a deploy
  const lastStep = turn.findLast((m) => m.role === 'tool');
  const tail = turn.at(-1);
  if ((lastStep?.role === 'tool' && lastStep.content.status === 'error') || (tail?.role === 'status' && tail.content.tone === 'bad')) {
    add('Try again'); add('Why did it fail?');
    return out;
  }
  const q = lastQuestion(text);
  const items = listItems(text);
  const yesNo = !!q && /^(shall|should|can|could|may|do|does|would|will|want|is|are|ready|ok|okay|go|good to go|sound)/i.test(q) && !/\bor\b/i.test(q);
  const inline = q && !yesNo ? inlineChoices(q) : [];
  const picks = /\b(which|pick|choose|prefer|one of)\b/i.test(q) && items.length >= 2 && items.length <= 6 && items.every((i) => i.length <= 60);
  const choices = inline.length ? inline : picks ? items : [];
  if (choices.length) { choices.slice(0, MAX).forEach((c) => add(c)); return out; }
  const phase = /\bphase\s*(\d+)/i.exec(text)?.[1];
  if ((items.length >= 2 || /\b(plan|phases?|steps?)\b/i.test(text)) && (yesNo || /\b(I can|I['’]ll|I will|I['’]d|here['’]s|here is)\b/i.test(text))) {
    add(phase ? `Yes, implement phase ${phase} now` : 'Yes, go ahead');
    add('Change the plan:');
    return out;
  }
  if (yesNo) { add('Yes, go ahead'); add('No, not now'); return out; }
  if (turn.some((m) => m.role === 'tool' && m.content.status === 'ok' && DEPLOYS.test(m.content.tool)) && !/https?:\/\//.test(text)) add('Give me the link');
  return out;
}
