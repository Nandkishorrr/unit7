// Who does Seven's thinking. Claude through the official SDK, so the long part of every request is cached and costs a tenth, or any
// other connected model through its OpenAI-style API. Either way one small interface, and every step is priced, because a hard daily
// cap only means something if each call knows what it cost.
import Anthropic from '@anthropic-ai/sdk';
import type { App } from '../app.ts';
import { get } from '../db.ts';
import { chat, modelFor, sourceKey, type Model, type SourceId } from '../agent/brain.ts';

export type Effort = 'low' | 'medium' | 'high';
export interface Call { id: string; name: string; input: unknown }
export interface Usage { input: number; output: number; cached: number; written: number; cost: number }
export interface Step { text: string; calls: Call[]; stop: 'tools' | 'done' | 'pause' | 'refused' | 'limit'; usage: Usage }
export interface Spec { name: string; description: string; schema: Record<string, unknown> }
export interface Answer { id: string; text: string; error?: boolean }
export interface Talk { say(text: string): void; answer(results: Answer[]): void; next(o: { effort: Effort; signal: AbortSignal }): Promise<Step> }
export interface Mind { label: string; model: string; start(system: string, tools: Spec[], web?: boolean): Talk }

// dollars per million tokens: input, output, cache read. Unknown models are priced high, so the cap errs towards stopping.
const PRICES: [RegExp, number, number, number][] = [[/fable|mythos/, 10, 50, 1], [/opus-?5[.-]5/, 4, 20, 0.2], [/opus/, 5, 25, 0.5], [/sonnet-?5/, 2, 10, 0.2], [/sonnet/, 3, 15, 0.3], [/haiku-?5/, 0.1, 0.5, 0.01], [/haiku/, 1, 5, 0.1]];
export function priceOf(model: string, u: Omit<Usage, 'cost'>) {
  if (/^ollama:/.test(model)) return 0;
  const [, i, o, c] = PRICES.find(([re]) => re.test(model)) ?? [/./, 5, 15, 0.5];
  return (u.input * i + u.written * i * 1.25 + u.cached * c + u.output * o) / 1e6;
}

// (pure) adaptive models take an effort and can pass a refused request to another model; older ones reject both
const EFFORT = /(opus|sonnet|haiku|fable)-5|opus-4-[678]|sonnet-4-6/, FALLBACK = /(opus|fable)-5|sonnet-5-5/, WEB = /opus-(5|4-[678])|sonnet-(5|4-6)/;
export const claudeFeatures = (model: string) => ({ effort: EFFORT.test(model), fallback: FALLBACK.test(model), web: WEB.test(model) });

function claudeTalk(key: string, model: string, system: string, tools: Spec[], web: boolean): Talk {
  const client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 170_000 });
  const can = claudeFeatures(model);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const specs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema }));
  // not every account has every extra: a request refused for one goes again without them, rather than losing the shift
  let plain = false;
  const send = (effort: Effort, signal: AbortSignal) => client.beta.messages.create({ model, max_tokens: 8000, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], tools: [...specs, ...(!plain && web && can.web ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] : [])], messages, cache_control: { type: 'ephemeral' },
    ...(can.effort && { output_config: { effort } }), ...(!plain && can.fallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }) } as never, { signal }) as unknown as Promise<Anthropic.Beta.BetaMessage>;
  return {
    say(text) { messages.push({ role: 'user', content: text }); },
    answer(results) { messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.text, ...(r.error && { is_error: true }) })) }); },
    async next({ effort, signal }) {
      const r = await send(effort, signal).catch((e) => { if (plain || !(e instanceof Anthropic.BadRequestError)) throw e; plain = true; return send(effort, signal); });
      messages.push({ role: 'assistant', content: r.content as never }); // the whole reply, unchanged: thinking blocks must come back as they were
      const u = { input: r.usage.input_tokens, output: r.usage.output_tokens, cached: r.usage.cache_read_input_tokens ?? 0, written: r.usage.cache_creation_input_tokens ?? 0 };
      return { text: r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim(), calls: r.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : [])), usage: { ...u, cost: priceOf(r.model, u) + (r.usage.server_tool_use?.web_search_requests ?? 0) * 0.01 }, // web search is $10 per 1,000
        stop: r.stop_reason === 'tool_use' ? 'tools' : r.stop_reason === 'pause_turn' ? 'pause' : r.stop_reason === 'refusal' ? 'refused' : r.stop_reason === 'max_tokens' ? 'limit' : 'done' };
    },
  };
}

function compatibleTalk(source: SourceId, key: string, model: string, system: string, tools: Spec[]): Talk {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: system }];
  const specs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  return {
    say(text) { messages.push({ role: 'user', content: text }); },
    answer(results) { for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.text }); },
    async next({ signal }) {
      const r = await chat(source, key, { model, messages, tools: specs }, signal);
      messages.push({ role: 'assistant', content: r.content ?? '', ...(r.tool_calls?.length && { tool_calls: r.tool_calls }) });
      const u = { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0, cached: 0, written: 0 };
      const calls = (r.tool_calls ?? []).map((c) => { let input: unknown = {}; try { input = JSON.parse(c.function.arguments || '{}'); } catch { /* bad JSON: finish or the tool's own check says so */ } return { id: c.id, name: c.function.name, input }; });
      return { text: (r.content ?? '').trim(), calls, stop: calls.length ? 'tools' : 'done', usage: { ...u, cost: r.usage?.cost ?? priceOf(`${source}:${model}`, u) } };
    },
  };
}

const BEST = [/claude-opus-5[.-]5/, /claude-opus/, /claude-sonnet/, /claude-fable/, /gpt-[\d.]+(?!.*mini)/, /gemini/, /claude-haiku/, /./];
const asRef = (m: Model) => `${m.source}:${m.id}`;
// The person's pick, else the strongest model that's connected. Undefined: no key and no local model, so fixed rules do the shift.
export async function mindFor(app: App, orgId: string): Promise<Mind | undefined> {
  const injected = app.services.sevenMind as Mind | undefined; // drills and tests
  if (injected) return injected;
  const { ref, models } = await modelFor(app, orgId);
  const picked = get<{ a: string | null }>(app.db, 'SELECT agent_model a FROM orgs WHERE id = ?', orgId)?.a;
  let model = (picked ? models.find((m) => asRef(m) === ref) : undefined) ?? BEST.map((re) => models.find((m) => re.test(m.id))).find(Boolean);
  if (!model && sourceKey(app, orgId, 'anthropic')) model = { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', source: 'anthropic' };
  if (!model) return undefined;
  const m = model, key = sourceKey(app, orgId, m.source)!;
  return { label: m.label, model: asRef(m), start: (system, tools, web = true) => (m.source === 'anthropic' ? claudeTalk(key, m.id, system, tools, web && !!(app.services.sevenWeb ?? true)) : compatibleTalk(m.source, key, m.id, system, tools)) };
}
