#!/usr/bin/env node
// A stand-in for docker on a fake server: volumes are folders under $FAKE_ROOT/docker/volumes, containers a JSON file, and
// `docker run … alpine …` runs its command for real against the volume's folder, so tar, find and du do real work.
// A test seeds containers.json ({ name: { image, mounts: [...] } }) and dump-<container>.sql; a file called lose-rows makes
// loading lose a row, the way a bad restore would.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.env.FAKE_ROOT, 'docker'), vols = join(root, 'volumes'), file = join(root, 'containers.json');
mkdirSync(vols, { recursive: true });
const ctrs = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
const save = (c) => writeFileSync(file, JSON.stringify(c));
const volume = (name) => { const d = join(vols, name); mkdirSync(d, { recursive: true }); return d; };
const out = (s) => process.stdout.write(s);
const stdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
const [cmd, ...a] = process.argv.slice(2);
const flag = (name) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined; };

function run() {
  const spec = flag('-v'), name = flag('--name');
  if (a.includes('-d')) { // a long-running database: its data place is what matters
    const image = a.at(-1), [src, dst] = spec.split(':');
    const c = ctrs(); c[name] = { image, mounts: [{ Type: src.startsWith('/') ? 'bind' : 'volume', Name: src, Source: src, Destination: dst }], running: true }; save(c);
    if (!src.startsWith('/')) volume(src);
    return out(`${name}\n`);
  }
  const src = spec.split(':')[0], at = src.startsWith('/') ? src : volume(src), i = a.indexOf('alpine:3'), rest = a.slice(i + 1).map((x) => x.replaceAll('/v', at));
  const r = spawnSync(rest[0], rest.slice(1), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
function exec() {
  const name = a.find((x) => !x.startsWith('-')), rest = a.slice(a.indexOf(name) + 1).join(' ');
  if (/pg_dumpall|mysqldump|mongodump/.test(rest)) return out(readFileSync(join(root, `dump-${name}.sql`), 'utf8'));
  if (/curl/.test(rest)) return out('OK');
  if (/pg_isready/.test(rest)) return;
  if (/psql/.test(rest)) {
    const c = ctrs()[name], data = c.mounts[0].Source.startsWith('/') ? c.mounts[0].Source : volume(c.mounts[0].Source), loaded = join(data, 'loaded.sql');
    if (!a.includes('-i')) return out('1\n');
    let sql = stdin();
    if (/count\(\*\)/.test(sql)) {
      const text = existsSync(loaded) ? readFileSync(loaded, 'utf8') : '';
      for (const [, t] of sql.matchAll(/select '([^']+)', count\(\*\)/g)) out(`${t}|${(new RegExp(`^COPY ${t.replace('.', '\\.')}[^\\n]*\\n([\\s\\S]*?)^\\\\\\.$`, 'm').exec(text)?.[1] ?? '').split('\n').filter(Boolean).length}\n`);
      return;
    }
    if (existsSync(join(root, 'lose-rows'))) sql = sql.replace(/\n[^\n]*\n\\\.\n/, '\n\\.\n');
    return appendFileSync(loaded, sql);
  }
}
const volumeCmd = () => {
  if (a[0] === 'create') { const n = a.at(-1), d = volume(n); const l = flag('--label')?.split('=')[1]; if (l) writeFileSync(join(root, `label-${n}`), l); return out(`${d}\n`); }
  if (a[0] === 'ls') for (const n of readdirSync(vols)) out(`${n}|${existsSync(join(root, `label-${n}`)) ? readFileSync(join(root, `label-${n}`), 'utf8') : ''}\n`);
};
const ps = () => {
  const names = Object.keys(ctrs());
  if (a.some((x) => /^-[a-z]*q/.test(x))) return out(names.filter((n) => /^unit7-proof-/.test(n)).map((n) => `${n}\n`).join(''));
  out(names.map((n) => `${n}\n`).join(''));
};
const inspect = () => {
  const c = ctrs()[a.at(-1)];
  if (!c) process.exit(1);
  out(a.join(' ').includes('json .Mounts') ? `${JSON.stringify(c.mounts)}\n` : c.mounts.map((m) => m.Source).join(' ') + '\n');
};
const rm = () => { const c = ctrs(); delete c[a.at(-1)]; save(c); };
const handlers = { run, exec, volume: volumeCmd, ps, inspect, rm, stop: () => undefined, version: () => out(process.env.FAKE_NO_DOCKER ? '' : '27.3.1\n'), network: () => out('ok\n'), compose: () => { appendFileSync(join(root, 'compose.log'), `${process.env.LATEST_IMAGE} ${a.join(' ')}\n`); } };
if (!handlers[cmd]) { console.error(`fake docker: no ${cmd}`); process.exit(2); }
handlers[cmd]();
