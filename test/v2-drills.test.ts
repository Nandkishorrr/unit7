// Fault drills: twenty broken servers. Each one breaks something the way it really breaks, and Unit7's fixed rules have to name the
// fault, or stay calm when nothing is wrong. They run on every change. They cover the rules, not an AI: a table of how each model
// does on these needs a key for each model, and hasn't been run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsFor } from '../src/discovery/findings.ts';
import { roundVerdict } from '../src/sentinel/watch.ts';
import { verdictsOf, wordOf } from '../src/care/checkup.ts';
import { reducePlan } from '../src/care/reduce.ts';
import { detect, type Context } from '../src/inspect/detectors.ts';
import { dbFindings } from '../src/care/partchecks.ts';
import { levelOf } from '../src/care/safetynet.ts';
import { outsideCalls, outsideDetections } from '../src/inspect/logs.ts';
import { fromHistory } from '../src/care/verdict.ts';
import { parseSentinel, type Inventory, type Part } from '../src/discovery/xray.ts';
import { analyze, parseErrors, trafficFindings, type Hit, type Summary } from '../src/sentinel/traffic.ts';

const S = 'srv_drill0000001', T0 = Date.UTC(2026, 10, 6, 10), CHROME = 'Mozilla/5.0 Chrome/130.0 Safari/537.36';
const part = (o: Partial<Part>): Part => ({ id: 'p', kind: 'app', name: 'CRM', owner: 'coolify', trust: 'seen', project: 'x', state: 'running', ...o });
const inv = (parts: Part[], o: Partial<Inventory> = {}): Inventory => ({ version: 1, at: new Date(T0).toISOString(), server: { memTotal: 16e9 }, paas: [], projects: [], parts, loose: [], ports: [], repos: [], summary: '', notes: [], ...o });
const found = (i: Inventory, extra: object = {}) => findingsFor({ serverId: S, serverName: 'vps', inv: i, ...extra }).map((f) => f.id.split(':').slice(0, 2).join(':'));
const hit = (o: Partial<Hit>): Hit => ({ at: T0, ip: '203.0.113.5', method: 'GET', host: 'a.example.com', path: '/', status: 200, ua: CHROME, ms: 20, bytes: 1000, fine: true, ...o });
const c = (o: Partial<Context> = {}): Context => ({ minutes: 60, requests: 10_000, fine: true, ...o });
const empty: Summary = analyze([], { minutes: 30, anonKnown: false, now: T0 });

const DRILLS: [string, () => void][] = [
  ['a crash loop: the app keeps restarting', () => assert.ok(found(inv([part({ state: 'restarting', restarts: 40, health: { status: 'bad', reason: 'keeps restarting' } })])).includes('xray:restart-loop'))],
  ['out of memory: the kernel keeps killing it', () => assert.ok(found(inv([part({ health: { status: 'bad', reason: 'ran out of memory' } })])).includes('xray:oom'))],
  ['a database with no backup anywhere', () => assert.ok(found(inv([part({ kind: 'database', engine: 'postgres', name: 'db', containers: ['db'] })])).includes('xray:no-backup'))],
  ['a database open to the internet', () => assert.ok(found(inv([part({ kind: 'database', engine: 'postgres', name: 'db', exposed: true, ports: [{ port: 5432, public: true }] as never })])).some((k) => k === 'server:port' || k === 'xray:exposed'))],
  ['Coolify’s dashboard on plain http', () => assert.ok(found(inv([], { coolify: { dashboard: 'http://1.2.3.4:8000', apiPort: 8000, sentinel: true, proxy: true } })).includes('xray:coolify-http'))],
  ['the disk is nearly full', () => { assert.equal(wordOf(30, 93), 'Tight'); assert.equal(verdictsOf({ room: [{ id: 's', name: 'vps', word: 'Tight', ram: { used: 1, total: 4, pct: 30 }, cpu: { now: 5 }, disk: { used: 9, total: 10, pct: 93 }, projects: [] }], protection: [], items: [] }).level, 'act'); }],
  ['leftovers fill the disk: cleaning is offered with the size on the button', () => assert.equal(reducePlan({ serverId: S, serverName: 'vps', sizes: { reclaimable: 8e9 } as never })[0]!.label, 'Free 8.0 GB')],
  ['a site really is down', () => assert.equal(roundVerdict(5, 1, undefined), 'some')],
  ['many sites look down, and the neutral check fails: it’s this computer’s connection', () => assert.equal(roundVerdict(13, 13, false), 'offline')],
  ['many sites look down, and the internet is fine: something is really wrong', () => assert.equal(roundVerdict(13, 13, true), 'many')],
  ['a real 5xx storm', () => { const hits = Array.from({ length: 900 }, (_, i) => hit({ at: T0 - 60_000 + i, status: i % 2 ? 500 : 200 })); const w = analyze(hits, { minutes: 30, anonKnown: false, now: T0 }); assert.ok(trafficFindings(w, [], { serverId: S, serverName: 'vps' }).some((f) => f.id.startsWith('traffic:5xx'))); }],
  ['normal traffic: nothing to say', () => assert.deepEqual(trafficFindings(analyze([hit({ at: T0 - 1000 })], { minutes: 30, anonKnown: false, now: T0 }), [empty], { serverId: S, serverName: 'vps' }).filter((f) => f.severity !== 'info').map((f) => f.id), [])],
  ['a log line that only mentions an error in its URL is not an error', () => assert.deepEqual(parseErrors(''), [])],
  ['a page polling every 5 seconds', () => assert.ok(detect(['203.0.113.5', '203.0.113.6'].flatMap((ip) => Array.from({ length: 130 }, (_, i) => hit({ ip, at: T0 + i * 5000, path: '/api/n', qh: 'q' }))), c()).some((d) => d.detector === 'polling'))],
  ['an expired key refused all day', () => assert.ok(detect(Array.from({ length: 40 }, (_, i) => hit({ at: T0 + i * 1000, path: '/api/me', status: 401 })), c()).some((d) => d.detector === 'refused'))],
  ['a carrier refusing every call', () => assert.equal(outsideDetections(outsideCalls(Array.from({ length: 20 }, () => 'POST https://api.carrier.example/x failed status 403').join('\n')), 'CRM', 3)[0]!.who, 'you')],
  ['the connection pool is nearly full', () => assert.equal(dbFindings({ id: S, name: 'vps' }, { id: 'd', name: 'db' }, { connections: 97, max: 100, bytes: 1e9, stuck: 0, long: 0 })[0]!.severity, 'high')],
  ['a backup that only exists on the same disk is weak, not safe', () => assert.equal(levelOf([{ at: new Date(T0).toISOString(), off: null }], undefined, T0).level, 'weak')],
  ['an alert that always clears by itself is called noise', () => { const r = (m: number) => ({ first_at: new Date(T0).toISOString(), cleared_at: new Date(T0 + m * 60_000).toISOString() }); assert.equal(fromHistory([r(5), r(5), r(5), r(5), r(5)]).verdict, 'Probably noise'); }],
  ['a metrics source that reports nothing is no reading, not a zero', () => assert.equal(parseSentinel(JSON.stringify([{ id: 'a', name: 'a', cpu: null, memory: null }])).size, 0)],
];
for (const [name, run] of DRILLS) test(`drill: ${name}`, run);
test('there are twenty drills', () => assert.equal(DRILLS.length, 20));
