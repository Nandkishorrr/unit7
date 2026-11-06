// A stand-in Uptime Kuma for tests: a socket.io-client module that answers like Uptime Kuma's server.js (setup, login
// with the monitorList push, getTags, addTag, add, addMonitorTag), its state in a file so each `node -` run sees what
// the last one did, and the program run the way `docker exec -i <container> node -` would run it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_CLIENT = String.raw`
const fs = require('fs'), path = require('path');
const STATE = path.join(__dirname, '..', '..', 'kuma.json');
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s));
const listOf = (st) => Object.fromEntries(st.monitors.map((m) => [m.id, { id: m.id, name: m.name, url: m.url, type: m.type, tags: m.tags }]));
exports.io = (url, opts) => {
  const on = {}, mgr = {};
  const st0 = load(); st0.events.push(['connect', url, opts.transports]); save(st0);
  const sock = {
    io: { on: (ev, fn) => { mgr[ev] = fn; } },
    on: (ev, fn) => { on[ev] = fn; },
    close() {},
    emit(ev, ...args) {
      const cb = args.pop(), st = load();
      st.events.push([ev, ...args]);
      let r;
      if (ev === 'setup') { if (st.users.length) r = { ok: false, msg: 'Uptime Kuma has been initialized. If you want to run setup again, please delete the database.' }; else { st.users.push({ username: args[0], password: args[1] }); r = { ok: true, msg: 'successAdded' }; } }
      else if (ev === 'login') { const good = st.users.some((u) => u.username === args[0].username && u.password === args[0].password); r = !good ? { ok: false, msg: 'authIncorrectCreds' } : st.twofa ? { tokenRequired: true } : { ok: true, token: 'jwt' }; if (good && !st.twofa) setTimeout(() => on.monitorList && on.monitorList(listOf(load())), 5); }
      else if (ev === 'getTags') r = { ok: true, tags: st.tags };
      else if (ev === 'addTag') { const t = { id: st.tags.length + 1, name: args[0].name, color: args[0].color }; st.tags.push(t); r = { ok: true, tag: t }; }
      else if (ev === 'add') { const m = args[0]; if (!m.accepted_statuscodes.every((c) => typeof c === 'string')) r = { ok: false, msg: 'Accepted status codes are not all strings' }; else { const i = st.monitors.length + 1; st.monitors.push(Object.assign({}, m, { id: i, tags: [] })); r = { ok: true, msg: 'successAdded', monitorID: i }; } }
      else if (ev === 'addMonitorTag') { const t = st.tags.find((x) => x.id === args[0]); st.monitors.find((m) => m.id === args[1]).tags.push({ tag_id: t.id, monitor_id: args[1], value: args[2], name: t.name, color: t.color }); r = { ok: true, msg: 'successAdded' }; }
      else r = { ok: false, msg: 'unknown event' };
      save(st);
      setTimeout(() => cb(r), 1);
    },
  };
  setTimeout(() => (load().down ? mgr.reconnect_failed && mgr.reconnect_failed() : on.connect && on.connect()), 5);
  return sock;
};`;
export interface Kuma { users: { username: string; password: string }[]; monitors: any[]; tags: any[]; events: any[][]; twofa?: boolean; down?: boolean }
export function fakeKuma(state: Partial<Kuma>, version = '2.0.2') {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-kuma-'));
  mkdirSync(join(dir, 'node_modules', 'socket.io-client'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'socket.io-client', 'index.js'), FAKE_CLIENT);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'uptime-kuma', version }));
  writeFileSync(join(dir, 'kuma.json'), JSON.stringify({ users: [], monitors: [], tags: [], events: [], ...state }));
  return { dir, state: () => JSON.parse(readFileSync(join(dir, 'kuma.json'), 'utf8')) as Kuma };
}
// the program on stdin, in the stand-in's folder (its node_modules and package.json stand in for /app)
export function runInKuma(dir: string, stdin: string) {
  const r = spawnSync(process.execPath, ['-'], { cwd: dir, input: stdin, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, truncated: false };
}
export const isKumaTrip = (command: string) => /docker exec -i "\$1" node -/.test(command);
