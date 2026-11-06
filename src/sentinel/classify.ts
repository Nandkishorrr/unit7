// The one model-swappable seam: "is this log
// line / metric normal?" Default is a cheap rule-based scorer; a local/open model can replace this
// behind the same signature without touching Warden or the agent.
export interface Anomaly { score: number; reason?: string } // score 0 (normal) .. 1 (very abnormal)

const MINER = /xmrig|kdevtmpfsi|kinsing|stratum\+tcp|cryptonight|minerd/i;
const FATAL = /\b(out of memory|oomkill|segfault|panic|fatal|cannot allocate|EADDRINUSE|ECONNREFUSED|unhandledrejection|traceback \(most recent call last\))\b/i;

export function classifyLogLine(line: string): Anomaly {
  if (MINER.test(line)) return { score: 1, reason: 'possible crypto-miner' };
  if (FATAL.test(line)) return { score: 0.8, reason: 'fatal error' };
  if (/\b5\d\d\b/.test(line) && /error|exception/i.test(line)) return { score: 0.5, reason: 'server error' };
  return { score: 0 };
}

export function classifyMetric(name: string, value: number, baseline?: number): Anomaly {
  if (baseline && baseline > 0 && value > baseline * 5) return { score: Math.min(1, value / (baseline * 10)), reason: `${name} ${Math.round(value / baseline)}× its baseline` };
  return { score: 0 };
}

// A real integration point: set UNIT7_CLASSIFIER_URL to a local model endpoint and this calls it.
// Kept behind the same return type so swapping it is a one-line change.
export async function classifyWithModel(text: string): Promise<Anomaly> {
  const url = process.env.UNIT7_CLASSIFIER_URL;
  if (!url) return classifyLogLine(text);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(2000) });
    const r = await res.json() as Anomaly;
    return typeof r.score === 'number' ? r : classifyLogLine(text);
  } catch {
    return classifyLogLine(text); // the rule-based scorer is always the floor
  }
}
