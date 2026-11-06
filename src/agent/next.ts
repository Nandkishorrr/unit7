// Next-reply suggestions: every brain ends its reply with a hidden line, `<<next: Yes, go ahead | Do phase 1 first>>`,
// the replies the person would most likely type next. Unit7 strips that line before anything is stored, streamed or
// shown, and keeps the options on the message (`next`). They're the AI's words, so untrusted: short, plain text only.
// The web app shows them as gray text in the ask box (Tab fills it in); they never send by themselves.
import type { AgentMessage } from './brain.ts';

export const NEXT_RULE = `- End every reply with one hidden line, \`<<next: option | option | option>>\`: up to 3 short, specific replies the person would likely type next, in their voice (e.g. "Yes, implement phase 1 now" | "Do phase 1 and 2 together" | "Change the plan: skip the database"). Unit7 hides the line and offers them as suggestions. It doesn't count toward the reply's length.`;

const MAX_OPTIONS = 3, MAX_LEN = 100;
// the whole line (closed, or still streaming in to the end), and a start of it cut off mid-stream ("<", "<<ne")
const LINE = /<<\s*next\b\s*:?([\s\S]*?)(?:>>|$)/gi;
const PARTIAL = /<(?:<\s*(?:n(?:e(?:x)?)?)?)?$/i;

// one option as plain text: no control or invisible characters, no markup, one short line
export function cleanOption(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let t = raw.slice(0, 2000).normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/<[^>]*>?/g, ' ')                  // tags
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // [text](link) → text
    .replace(/[<>`*|[\]{}\\]/g, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN).replace(/\s+\S*$/, '').trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

// up to three distinct, clean options (or none)
export function cleanNext(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: string[] = [];
  for (const o of list.slice(0, 10)) {
    const t = cleanOption(o);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length === MAX_OPTIONS) break;
  }
  return out.length ? out : undefined;
}

// the reply without its next line(s), and the options from the last one
export function splitNext(text: string): { text: string; next?: string[] } {
  let body: string | undefined;
  const rest = text.replace(LINE, (_m, b: string) => { body = b; return ''; }).replace(PARTIAL, '').trimEnd();
  return { text: rest, ...(body !== undefined && { next: cleanNext(body.split('|')) }) };
}

// Wrap a run's emit: every assistant message goes out without the line, with its options. A line that came as its own
// message (nothing else in it) belongs to the words before it.
export function withNext(emit: (m: AgentMessage) => void): (m: AgentMessage) => void {
  let last: AgentMessage | undefined;
  return (m) => {
    if (m.role !== 'assistant' || typeof m.content?.text !== 'string') return emit(m);
    const { next: _drop, ...content } = m.content; // only the line sets options
    const s = splitNext(content.text);
    if (!s.text.trim()) {
      if (last && (s.next || content.final)) emit(last = { ...last, content: { ...last.content, ...(s.next && { next: s.next }), ...(content.final && { final: true }) } });
      return;
    }
    emit(last = { ...m, content: { ...content, text: s.text, ...(s.next && { next: s.next }) } });
  };
}
