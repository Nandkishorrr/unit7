// The Call Inspector: wrong calls, repeated calls and waste, from the proxy's own log, with no code in your app. Pure: a window of
// hits goes in, what's worth saying comes out. Every number is a starting point to tune on real traffic. Only Sentry publishes rules
// for these, and they assume traces, so what comes out is worded as likely unless the log proves it.
import { classify } from '../netguard.ts';
import { SCANNER, LOGIN, agentOf, isBot, normPath, type Hit } from '../sentinel/traffic.ts';
import { safeRoute, type Evidence } from '../handoff/record.ts';

export interface Detection {
  key: string; detector: string; title: string; plain: string; confidence: 'high' | 'medium' | 'low'; host?: string;
  route?: { method: string; path: string; queryShape?: string }; numbers: Record<string, number>; hypotheses: string[]; search: string[]; evidence: Evidence; local?: string; who: 'your-ai' | 'you' | 'unit7'; severity: 'medium' | 'low';
}
const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|mp4|webm|mp3|pdf|zip|gz|wasm)$/i;
const NOT_API = /^\/(_next\/(static|data|image)|_nuxt\/|assets\/|static\/|favicon)/;
const MEDIA = /^\/(storage\/v1\/object|uploads?|media|files?|export|download)s?(\/|$)/i;
const BEACON = /\/(analytics|collect|beacon|vitals|telemetry|events?|ingest|track)(\/|$)/i;
const SERVER_UA = /^(node|undici|axios|node-fetch|wordpress|guzzlehttp|python-|go-http|okhttp|curl)|\b(node|wordpress|guzzlehttp)\b/i;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : 0; };
const num = (n: number) => Math.round(n).toLocaleString('en-US');
const kb = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const secs = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
const inside = (ip: string, self: string[] = []) => self.includes(ip) || ['private', 'loopback'].includes(classify(ip));
export const clientKey = (h: Pick<Hit, 'ip' | 'ua'>) => `${h.ip}|${agentOf(h.ua)}`;
export const routeKey = (h: Pick<Hit, 'method' | 'path' | 'qs'>) => `${h.method} ${normPath(h.path)}${h.qs ? `?${h.qs}` : ''}`;
const display = (h: Pick<Hit, 'method' | 'path' | 'qs'>) => ({ method: h.method, path: safeRoute(normPath(h.path)), ...(h.qs && { queryShape: safeRoute(h.qs) }) });
const shown = (h: Pick<Hit, 'method' | 'path' | 'qs'>) => { const d = display(h); return `${d.method} ${d.path}${d.queryShape ? `?${d.queryShape}` : ''}`; };
const perDay = (n: number, minutes: number) => (n / Math.max(1, minutes)) * 1440;
const sample = (hits: Hit[], label: Map<string, string>, n = 3) => hits.slice(0, n).map((h) => `${new Date(h.at).toISOString().slice(11, 23)} ${label.get(clientKey(h)) ?? 'client'} ${shown(h)} ${h.status}${h.bytes !== undefined ? ` ${kb(h.bytes)}` : ''}${h.ms !== undefined ? ` ${Math.round(h.ms)}ms` : ''}${h.ref ? ` page=${safeRoute(h.ref)}` : ''}`);
const labels = (hits: Hit[]) => { const m = new Map<string, string>(); for (const h of hits) { const k = clientKey(h); if (!m.has(k)) m.set(k, `client-${m.size + 1}`); } return m; };
const grouped = <T>(items: T[], key: (x: T) => string) => { const m = new Map<string, T[]>(); for (const x of items) { const k = key(x), a = m.get(k); if (a) a.push(x); else m.set(k, [x]); } return m; };

// (pure) how much a list of gaps looks like a timer: RITA's score, on a 0 to 1 scale
export function regularity(gaps: number[]) {
  if (gaps.length < 3) return 0;
  const s = [...gaps].sort((a, b) => a - b), at = (f: number) => s[Math.floor((s.length - 1) * f)]!, q1 = at(0.25), q2 = at(0.5), q3 = at(0.75), spread = q3 - q1;
  const skew = spread < q2 * 0.1 || q2 === q1 || q2 === q3 ? 0 : (q1 + q3 - 2 * q2) / spread;
  const mad = median(gaps.map((g) => Math.abs(g - q2)));
  return ((1 - Math.abs(skew)) + (q2 ? Math.max(0, (q2 - mad) / q2) : 0)) / 2;
}
// (pure) the two commonest gaps, rounded to a second, cover most of them: a hidden tab that slows down still counts
export function topTwoShare(gaps: number[]) {
  const c = grouped(gaps, (g) => String(Math.round(g / 1000))), sizes = [...c.values()].map((v) => v.length).sort((a, b) => b - a);
  return gaps.length ? ((sizes[0] ?? 0) + (sizes[1] ?? 0)) / gaps.length : 0;
}

export interface Context { minutes: number; requests: number; self?: string[]; quiet?: [number, number][]; fine: boolean }
const worth = (n: number, c: Context) => perDay(n, c.minutes) >= 1000 || n >= 0.05 * Math.max(1, c.requests);

// W1. Can it tell visitors apart? Everything per-visitor stands on this.
export function clientQuality(hits: Hit[], self?: string[]) {
  const people = hits.filter((h) => !isBot(h.ua)), masked = people.filter((h) => inside(h.ip, self)), own = hits.filter((h) => isBot(h.ua) && inside(h.ip, self));
  return { people: people.length, masked: masked.length, maskedShare: people.length ? masked.length / people.length : 0, internal: own.length, internalShare: hits.length ? own.length / hits.length : 0 };
}

function baseFilter(hits: Hit[], c: Context) {
  const ok = hits.filter((h) => h.method !== 'OPTIONS' && h.method !== 'HEAD' && (!SCANNER.test(h.path) || /admin-ajax\.php/.test(h.path)) && !/unit7/i.test(h.ua ?? '') && !c.quiet?.some(([a, b]) => h.at >= a && h.at <= b));
  return { all: ok, browsers: ok.filter((h) => !isBot(h.ua) && !inside(h.ip, c.self)) };
}
const heart = (p: string) => (/admin-ajax\.php/.test(p) ? 'WordPress’s Heartbeat' : /\/livewire\/update/.test(p) ? 'Laravel Livewire’s poll' : undefined);

// W2. "Your site asks the same question every 5 seconds"
export function polling(hits: Hit[], c: Context): Detection[] {
  const { browsers } = baseFilter(hits, c), out: Detection[] = [], mark = labels(browsers);
  const byRoute = grouped(browsers.filter((h) => h.status < 400 && !STATIC.test(h.path) && !NOT_API.test(h.path)), routeKey);
  for (const [route, list] of byRoute) {
    const cl: { gap: number; n: number; hits: Hit[] }[] = [];
    for (const [, l] of grouped(list, clientKey)) {
      const s = [...l].sort((a, b) => a.at - b.at), gaps = s.slice(1).map((h, i) => h.at - s[i]!.at).filter((g) => g > 0), span = s.at(-1)!.at - s[0]!.at, gap = median(gaps);
      if (s.length < 12 || span < 10 * 60_000 || gap < 1000 || gap > 15 * 60_000) continue;
      if (regularity(gaps) < 0.9 && topTwoShare(gaps) < 0.8) continue;
      const ms = s.map((h) => h.ms).filter((x): x is number => x !== undefined);
      if (ms.length && ms.reduce((a, b) => a + b, 0) / ms.length >= gap / 2) continue; // long-polling: it waits on purpose
      cl.push({ gap, n: s.length, hits: s });
    }
    if (!cl.length || (cl.length < 2 && cl[0]!.hits.at(-1)!.at - cl[0]!.hits[0]!.at < 20 * 60_000)) continue;
    const calls = cl.reduce((a, x) => a + x.n, 0), gap = median(cl.map((x) => x.gap)), first = cl[0]!.hits[0]!, known = heart(first.path);
    if (!worth(calls, c) && !known) continue;
    const size = median(cl.flatMap((x) => x.hits.map((h) => h.bytes ?? 0)));
    out.push({ key: `poll:${first.host ?? ''}:${route}`, detector: 'polling', host: first.host, route: display(first), confidence: 'high', severity: known ? 'low' : 'medium', who: 'your-ai',
      title: known ? `${known} calls ${safeRoute(normPath(first.path))} every ${secs(gap)}` : `Your site asks the same question every ${secs(gap)}`, plain: `${num(calls)} calls in ${c.minutes} minutes from ${cl.length} open page${cl.length === 1 ? '' : 's'}, even when nothing changed. That’s about ${num(86400_000 / gap)} calls a day from each open tab.`,
      numbers: { calls, clients: cl.length, medianGapS: Math.round(gap / 100) / 10, ...(size && { avgBytes: size }) }, hypotheses: [known ? `${known} is doing this by default.` : 'A timer, a setInterval or a refetchInterval calls this while the page is open.'], search: [safeRoute(normPath(first.path)), 'setInterval', 'refetchInterval', 'useSWR(', 'useQuery('],
      evidence: { source: 'the proxy access log', columns: ['route', 'calls', 'clients', 'median gap'], rows: [[shown(first), num(calls), String(cl.length), secs(gap)]], samples: sample(cl[0]!.hits, mark) }, local: `With one tab open for 2 minutes, ${safeRoute(normPath(first.path))} is called at most 2 times, or only when something changes.` });
  }
  return out;
}

// W3. "Your page asks for the same thing twice in a row"
export function duplicates(hits: Hit[], c: Context): Detection[] {
  if (!c.fine) return []; // a one-second clock can't see this
  const { browsers } = baseFilter(hits, c), out: Detection[] = [], mark = labels(browsers);
  for (const [route, list] of grouped(browsers.filter((h) => h.status !== 206 && h.status !== 304 && !STATIC.test(h.path) && !NOT_API.test(h.path)), routeKey)) {
    let pairs = 0; const seen: Hit[] = [];
    for (const [, l] of grouped(list, (h) => `${clientKey(h)}|${h.qh ?? ''}`)) {
      const s = [...l].sort((a, b) => a.at - b.at);
      for (let i = 1; i < s.length; i++) if (s[i]!.at - s[i - 1]!.at <= 2000 && s[i - 1]!.status < 400) { pairs++; if (seen.length < 3) seen.push(s[i - 1]!, s[i]!); }
    }
    const first = list[0]!, post = first.method !== 'GET';
    if (post ? pairs < 3 : pairs < 20 || pairs < 0.05 * list.length) continue;
    out.push({ key: `dupe:${first.host ?? ''}:${route}`, detector: 'duplicates', host: first.host, route: display(first), confidence: post ? 'low' : 'high', severity: post ? 'medium' : 'low', who: 'your-ai',
      title: post ? `The same ${first.method} arrives twice: a possible double submit` : 'Your page asks for the same thing twice in a row', plain: post ? `${num(pairs)} times in ${c.minutes} minutes, within 2 seconds. Unit7 can’t see the body, so this may be two different things.` : `${num(pairs)} times in ${c.minutes} minutes, within 2 seconds. The second answer is thrown away.`,
      numbers: { calls: list.length, pairs }, hypotheses: [post ? 'A button can be pressed twice, or a form submits twice.' : 'Two parts of the page fetch the same data, or an effect runs twice.'], search: [safeRoute(normPath(first.path))],
      evidence: { source: 'the proxy access log', columns: ['route', 'calls', 'repeats within 2 s'], rows: [[shown(first), num(list.length), num(pairs)]], samples: sample(seen, mark, 4) }, local: 'Open the page once with the network tab open: this call appears once.' });
  }
  return out;
}

// W4. "One page makes 40 calls to fetch 40 items"
export function manyCalls(hits: Hit[], c: Context): Detection[] {
  const { browsers } = baseFilter(hits, c), out: Detection[] = [], mark = labels(browsers);
  const eligible = browsers.filter((h) => h.method === 'GET' && h.status < 400 && !STATIC.test(h.path) && !NOT_API.test(h.path) && !/graphql/i.test(h.path) && !MEDIA.test(h.path) && !BEACON.test(h.path) && !/(^|&)(page|offset|cursor|limit)\b/.test(h.qs ?? ''));
  for (const [route, list] of grouped(eligible, (h) => `${h.host ?? ''}|${routeKey(h)}`)) {
    const bursts: Hit[][] = [];
    for (const [, l] of grouped(list, clientKey)) {
      const s = [...l].sort((a, b) => a.at - b.at);
      let run: Hit[] = [];
      const close = () => { if (run.length >= 5 && new Set(run.map((h) => `${h.path}|${h.qh ?? ''}`)).size >= Math.ceil(run.length * 0.8) && (run[0]!.ms === undefined || run.reduce((a, h) => a + (h.ms ?? 0), 0) >= 300)) bursts.push(run); run = []; };
      for (const h of s) { if (run.length && h.at - run.at(-1)!.at > 2000) close(); run.push(h); }
      close();
    }
    if (bursts.length < 3) continue;
    const size = Math.round(median(bursts.map((b) => b.length))), first = bursts[0]![0]!, calls = bursts.reduce((a, b) => a + b.length, 0), page = first.ref;
    if (!worth(calls, c)) continue;
    out.push({ key: `many:${route}`, detector: 'many-calls', host: first.host, route: display(first), confidence: page ? 'high' : 'medium', severity: 'medium', who: 'your-ai',
      title: `One page makes about ${size} calls to fetch ${size} items`, plain: `${bursts.length} times in ${c.minutes} minutes${page ? ` from ${safeRoute(page)}` : ''}. A single request could fetch them all at once.`, numbers: { calls, bursts: bursts.length, perPage: size },
      hypotheses: ['A list renders, and each row fetches its own data.'], search: [safeRoute(normPath(first.path)), '.map(', 'Promise.all', '.in('], evidence: { source: 'the proxy access log', columns: ['route', 'bursts', 'calls per burst'], rows: [[shown(first), String(bursts.length), String(size)]], samples: sample(bursts[0]!, mark) }, local: `Loading ${page ? safeRoute(page) : 'the page'} makes one call to ${safeRoute(normPath(first.path))}, not ${size}.` });
  }
  return out;
}

// W5. "Part of your app keeps asking for something it can't have"
const REFUSED = new Set([401, 403, 404, 410, 429]);
export function refused(hits: Hit[], c: Context): Detection[] {
  const { all } = baseFilter(hits, c), out: Detection[] = [], mark = labels(all);
  const pool = all.filter((h) => !isBot(h.ua) || h.ua?.length);
  for (const [route, list] of grouped(pool.filter((h) => !LOGIN.test(h.path) || /\/auth\/v1\/token/.test(h.path)), routeKey)) {
    const bad = list.filter((h) => REFUSED.has(h.status)), token = /\/auth\/v1\/token/.test(list[0]!.path) && bad.some((h) => h.status === 429);
    if (bad.length < 20 && !token) continue;
    if (STATIC.test(list[0]!.path) && c.quiet?.length) continue; // old tabs after a deploy ask for old files
    const clients = new Set(bad.map(clientKey)), okClients = new Set(list.filter((h) => h.status < 400).map(clientKey)), good = list.length - bad.length, first = bad[0]!, stale = [...clients].some((k) => !okClients.has(k)) && okClients.size > 0;
    const code = median(bad.map((h) => h.status));
    if (good && bad.length < 0.3 * list.length && !token) continue;
    out.push({ key: `refused:${first.host ?? ''}:${route}`, detector: 'refused', host: first.host, route: display(first), confidence: 'high', severity: token ? 'medium' : 'low', who: 'your-ai',
      title: token ? 'Sign-in refreshes are hitting Supabase’s rate limit' : 'Part of your app keeps asking for something it can’t have', plain: `${num(bad.length)} refused calls (${code}) in ${c.minutes} minutes from ${clients.size} client${clients.size === 1 ? '' : 's'}${stale ? ', while it works for others, so those are likely old tabs or an expired sign-in' : ', and it works for nobody'}.`, numbers: { calls: list.length, refused: bad.length, clients: clients.size, status: code },
      hypotheses: [code === 404 ? 'The code calls a route that was renamed or removed.' : code === 429 ? 'Something refreshes or retries far too often.' : stale ? 'An expired token, or an old version of the app still open.' : 'A rule or a key refuses this for everyone.'], search: [safeRoute(normPath(first.path))],
      evidence: { source: 'the proxy access log', columns: ['route', 'refused', 'worked', 'clients'], rows: [[shown(first), num(bad.length), num(good), String(clients.size)]], samples: sample(bad, mark) } });
  }
  return out;
}

// W6. "When your server struggled, your app called it over and over"
export function retryStorm(hits: Hit[], c: Context): Detection[] {
  const { all } = baseFilter(hits, c), out: Detection[] = [], mark = labels(all);
  for (const [route, list] of grouped(all.filter((h) => !STATIC.test(h.path)), routeKey)) {
    const runs: Hit[][] = [];
    for (const [, l] of grouped(list, clientKey)) {
      const s = [...l].sort((a, b) => a.at - b.at);
      let run: Hit[] = [];
      const close = () => { if (run.length >= 4) { const g = run.slice(1).map((h, i) => h.at - run[i]!.at); if (g.at(-1)! <= (g[0]! || 1) * 1.5 + 500) runs.push(run); } run = []; }; // gaps that grow are a healthy back-off
      for (const h of s) { const bad = h.status >= 500 || h.status === 429; if (!bad) { close(); continue; } if (run.length && h.at - run.at(-1)!.at > 10_000) close(); run.push(h); }
      close();
    }
    if (runs.length < 3 && new Set(runs.map((r) => clientKey(r[0]!))).size < 2) continue;
    const calls = runs.reduce((a, r) => a + r.length, 0), first = runs[0]![0]!, each = Math.round(calls / runs.length);
    out.push({ key: `retry:${first.host ?? ''}:${route}`, detector: 'retry-storm', host: first.host, route: display(first), confidence: 'medium', severity: 'medium', who: 'your-ai', title: 'When your server struggled, your app called it over and over', plain: `${runs.length} bursts of about ${each} failed calls in a row, with no waiting between them. That makes the problem worse.`,
      numbers: { calls, bursts: runs.length, perBurst: each }, hypotheses: ['A retry loop with no back-off, or no limit on attempts.'], search: [safeRoute(normPath(first.path)), 'retry', 'catch'], evidence: { source: 'the proxy access log', columns: ['route', 'bursts', 'calls per burst'], rows: [[shown(first), String(runs.length), String(each)]], samples: sample(runs[0]!, mark) } });
  }
  return out;
}

// W7. "This page downloads 2 MB every visit"
export function oversized(hits: Hit[], c: Context): Detection[] {
  const { all } = baseFilter(hits, c), out: Detection[] = [], mark = labels(all);
  for (const [route, list] of grouped(all.filter((h) => h.status === 200 && h.bytes !== undefined && !NOT_API.test(h.path) && !MEDIA.test(h.path) && (!STATIC.test(h.path) || /\.json$/.test(h.path)) && !/\.[a-z0-9]{2,5}$/i.test(h.path.replace(/\.json$/, ''))), routeKey)) {
    const size = median(list.map((h) => h.bytes!)), ms = list.filter((h) => h.ms !== undefined);
    if (size < 300_000 || list.length < 5 || (ms.length && median(ms.map((h) => h.ms!)) < 100)) continue;
    const first = list[0]!, day = perDay(list.length, c.minutes) * size, capped = /^\/rest\/v1\//.test(first.path);
    out.push({ key: `big:${first.host ?? ''}:${route}`, detector: 'oversized', host: first.host, route: display(first), confidence: 'high', severity: 'low', who: 'your-ai', title: `This call downloads ${kb(size)} every time`, plain: `${num(list.length)} times in ${c.minutes} minutes, about ${kb(day)} a day. Smaller answers mean a faster site.`,
      numbers: { calls: list.length, medianBytes: size, bytesPerDay: Math.round(day) }, hypotheses: [capped ? 'A query with no filter or limit, likely reaching Supabase’s 1,000-row cap.' : 'It sends everything it read, and the page uses a few fields.'], search: [safeRoute(normPath(first.path)), 'select('], evidence: { source: 'the proxy access log', columns: ['route', 'calls', 'median size'], rows: [[shown(first), num(list.length), kb(size)]], samples: sample(list, mark) }, local: `The response is under ${kb(size / 4)}.` });
  }
  return out;
}

// W8. "Every visitor downloads this again"
export function uncached(hits: Hit[], c: Context): Detection[] {
  const { browsers } = baseFilter(hits, c), out: Detection[] = [], mark = labels(browsers);
  for (const [route, list] of grouped(browsers.filter((h) => STATIC.test(h.path) && !/\/_next\/static\//.test(h.path) && h.bytes !== undefined), routeKey)) {
    const fresh = list.filter((h) => h.status === 200), revalidated = list.filter((h) => h.status === 304).length, size = median(fresh.map((h) => h.bytes ?? 0)), clients = new Set(list.map(clientKey)).size;
    if (fresh.length < 100 || clients < 5 || size < 10_000 || revalidated >= 0.05 * list.length) continue;
    if (fresh.some((h) => Math.abs((h.bytes ?? 0) - size) > size * 0.01)) continue;
    const first = fresh[0]!;
    out.push({ key: `nocache:${first.host ?? ''}:${route}`, detector: 'uncached', host: first.host, route: display(first), confidence: 'medium', severity: 'low', who: 'your-ai', title: 'Every visitor downloads this same file again', plain: `${num(fresh.length)} downloads of ${kb(size)} from ${clients} clients in ${c.minutes} minutes. Their browser could keep a copy.`,
      numbers: { calls: fresh.length, clients, medianBytes: size }, hypotheses: ['It’s served with no Cache-Control header.'], search: ['Cache-Control', safeRoute(normPath(first.path))], evidence: { source: 'the proxy access log', columns: ['file', 'downloads', 'clients', 'size'], rows: [[shown(first), num(fresh.length), String(clients), kb(size)]], samples: sample(fresh, mark) } });
  }
  return out;
}

// W9. "Your app calls itself through the internet". Only what goes through the proxy shows here: direct calls inside the server don't.
export function longWay(hits: Hit[], c: Context): Detection[] {
  const { all } = baseFilter(hits, c), out: Detection[] = [], mine = all.filter((h) => inside(h.ip, c.self) && (!h.ua || SERVER_UA.test(h.ua))), mark = labels(mine);
  for (const [route, list] of grouped(mine.filter((h) => !/\/(webhooks?|cron|api\/cron)(\/|$)/.test(h.path)), routeKey)) {
    if (perDay(list.length, c.minutes) < 1000) continue;
    const first = list[0]!;
    out.push({ key: `longway:${first.host ?? ''}:${route}`, detector: 'long-way', host: first.host, route: display(first), confidence: 'medium', severity: 'low', who: 'your-ai', title: 'Your app calls itself through the proxy', plain: `${num(list.length)} calls in ${c.minutes} minutes come from inside the server and go out and back through the front door. It could take the short way.`, numbers: { calls: list.length, perDay: Math.round(perDay(list.length, c.minutes)) },
      hypotheses: ['Server code calls its own public address instead of the internal one.'], search: [first.host ?? '', 'NEXT_PUBLIC_SITE_URL', 'SUPABASE_URL'].filter(Boolean), evidence: { source: 'the proxy access log', columns: ['route', 'calls', 'caller'], rows: [[shown(first), num(list.length), agentOf(first.ua)]], samples: sample(list, mark) } });
  }
  return out;
}

// W12 (from the log). Everything piling up in one minute of the hour: a schedule fanning out.
export function fanOut(hits: Hit[], c: Context): Detection[] {
  if (c.minutes < 30) return [];
  const { all } = baseFilter(hits, c), m = grouped(all, (h) => String(Math.floor(h.at / 60_000)));
  const sizes = [...m.values()].map((v) => v.length), mid = median(sizes);
  const peak = [...m.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!peak || sizes.length < 10 || peak[1].length < 50 || peak[1].length < mid * 5) return [];
  const minute = new Date(Number(peak[0]) * 60_000).getUTCMinutes(), routes = [...grouped(peak[1], routeKey).entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  return [{ key: `fanout:${minute}`, detector: 'cron-fanout', title: `Calls pile up at :${String(minute).padStart(2, '0')}`, plain: `${num(peak[1].length)} calls land in one minute, against about ${num(mid)} in a normal minute. That looks like a scheduled job fanning out.`, confidence: 'medium', severity: 'low', who: 'your-ai', numbers: { calls: peak[1].length, usual: mid, minute },
    hypotheses: ['A cron job calls many things one at a time.'], search: ['cron', 'schedule'], evidence: { source: 'the proxy access log', columns: ['route', 'calls in that minute'], rows: routes.map(([, l]) => [shown(l[0]!), num(l.length)]) } }];
}

export const DETECTORS = [polling, duplicates, manyCalls, refused, retryStorm, oversized, uncached, longWay, fanOut];
export function detect(hits: Hit[], c: Context) { return DETECTORS.flatMap((d) => d(hits, c)); }
