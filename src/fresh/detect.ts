// Keep it fresh · find. What an app runs and what's newer: the libraries in its lockfiles (npm, pnpm, yarn, pip,
// poetry, uv first; Go, Cargo, Bundler and Composer as best effort), their newest versions from each registry, known
// security problems from OSV.dev (plus npm's own advisory list, the one `npm audit` reads) and a newer build of the
// base image. The repo is read the way the deployer reads it: from its GitHub source (raw files, no clone). Parsers and
// version maths are pure functions (tested on fixtures); the fetches use overridable base URLs so tests use fakes.
import type { Ctx } from '../tools/runtime.ts';
import { get, json } from '../db.ts';
import { githubToken, parseRepo, type Repo } from '../connectors/github.ts';
import { dockerfileFor } from '../deploy/dockerfiles.ts';
import type { ServiceConfig } from '../deploy/deployer.ts';

// --- versions -------------------------------------------------------------------------------------------------------
export type Bump = 'patch' | 'minor' | 'major';
const clean = (v: string) => v.trim().replace(/^[v=]+/i, '');
// a release people should get: no -beta, rc, dev, canary… (Python's .post fixes count as releases)
export const stable = (v: string) => /^\d+(\.\d+)*(\.post\d+)?$/.test(clean(v).replace(/\+.*$/, ''));
const nums = (v: string) => clean(v).replace(/\+.*$/, '').split(/[.-]/).map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
export function compare(a: string, b: string): number {
  const x = nums(a), y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}
// 0.x versions: a minor step is a breaking one (semver, and what ^0.2 allows), so it counts as major
export function bump(from: string, to: string): Bump | null {
  if (compare(to, from) <= 0) return null;
  const [a0 = 0, a1 = 0] = nums(from), [b0 = 0, b1 = 0] = nums(to);
  if (b0 !== a0) return 'major';
  if (b1 !== a1) return a0 === 0 ? 'major' : 'minor';
  return 'patch';
}
// the newest release within the same major, and the newest release overall when it's a new major
export function targets(current: string, versions: string[]): { inMajor?: string; major?: string } {
  const newer = versions.filter((v) => stable(v) && compare(v, current) > 0).sort(compare);
  const inMajor = newer.filter((v) => bump(current, v) !== 'major').at(-1);
  const top = newer.at(-1);
  return { ...(inMajor && { inMajor: clean(inMajor) }), ...(top && bump(current, top) === 'major' && { major: clean(top) }) };
}

// --- what's installed ------------------------------------------------------------------------------------------------
export type Eco = 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'RubyGems' | 'Packagist';
export type Manager = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'poetry' | 'uv' | 'go' | 'cargo' | 'bundler' | 'composer';
export interface Dep { eco: Eco; name: string; version: string; direct: boolean; dev?: boolean; manager: Manager }
export const FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'pyproject.toml', 'poetry.lock', 'uv.lock',
  'go.mod', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock', 'Dockerfile'] as const;
export type Files = Partial<Record<string, string>>;

const safeJson = <T>(s?: string): T | undefined => { try { return s ? JSON.parse(s) as T : undefined; } catch { return undefined; } };
const pyName = (n: string) => n.trim().toLowerCase().replace(/[_.]+/g, '-');
const uniq = (deps: Dep[]) => [...new Map(deps.map((d) => [`${d.eco}:${d.name}@${d.version}`, d])).values()];
const minOf = (range: string) => /\d+(\.\d+){0,2}/.exec(range)?.[0];

// npm, pnpm and yarn: package.json says which are direct (and dev); the lockfile says what's installed
export function npmDeps(f: Files): Dep[] {
  const pkg = safeJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(f['package.json']);
  if (!pkg) return [];
  const direct = new Map<string, { range: string; dev: boolean }>([
    ...Object.entries(pkg.devDependencies ?? {}).map(([n, r]) => [n, { range: r, dev: true }] as const),
    ...Object.entries(pkg.dependencies ?? {}).map(([n, r]) => [n, { range: r, dev: false }] as const),
  ]);
  const manager: Manager = f['pnpm-lock.yaml'] ? 'pnpm' : f['yarn.lock'] ? 'yarn' : 'npm';
  const locked: { name: string; version: string }[] = manager === 'pnpm' ? pnpmLocked(f['pnpm-lock.yaml']!) : manager === 'yarn' ? yarnLocked(f['yarn.lock']!) : npmLocked(f['package-lock.json']);
  const directVersion = (name: string, range: string) => {
    if (manager === 'pnpm') return pnpmDirect(f['pnpm-lock.yaml']!).get(name);
    if (manager === 'yarn') return yarnDirect(f['yarn.lock']!, name, range);
    const lock = safeJson<{ packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> }>(f['package-lock.json']);
    return lock?.packages?.[`node_modules/${name}`]?.version ?? lock?.dependencies?.[name]?.version;
  };
  const out: Dep[] = [];
  for (const [name, { range, dev }] of direct) {
    if (/^(file|link|workspace|git|github|https?):|\//.test(range)) continue; // not from the registry
    const version = directVersion(name, range) ?? minOf(range);
    if (version) out.push({ eco: 'npm', name, version: clean(version), direct: true, dev, manager });
  }
  for (const l of locked) if (!direct.has(l.name)) out.push({ eco: 'npm', name: l.name, version: clean(l.version), direct: false, manager });
  return uniq(out);
}
function npmLocked(text?: string): { name: string; version: string }[] {
  const lock = safeJson<{ packages?: Record<string, { version?: string; link?: boolean }>; dependencies?: Record<string, { version?: string }> }>(text);
  if (!lock) return [];
  if (lock.packages) return Object.entries(lock.packages).filter(([k, v]) => k.includes('node_modules/') && v.version && !v.link).map(([k, v]) => ({ name: k.slice(k.lastIndexOf('node_modules/') + 13), version: v.version! }));
  return Object.entries(lock.dependencies ?? {}).filter(([, v]) => v.version).map(([name, v]) => ({ name, version: v.version! }));
}
// pnpm-lock.yaml, read by its indentation (v5 to v9), no YAML library needed
function pnpmDirect(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let importers = false, root = false, section = false, keyAt = 2, name: string | undefined;
  for (const l of text.split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = l.length - l.trimStart().length;
    // v5/v6: dependencies at the top · v9: importers → "." → dependencies
    if (ind === 0) { importers = t === 'importers:'; root = false; section = !importers && /^(dependencies|devDependencies|optionalDependencies):$/.test(t); keyAt = 2; name = undefined; continue; }
    if (importers && ind === 2) { root = /^['"]?\.['"]?:$/.test(t); section = false; continue; }
    if (importers && root && ind === 4) { section = /^(dependencies|devDependencies|optionalDependencies):$/.test(t); keyAt = 6; name = undefined; continue; }
    if (!section || (importers && !root)) continue;
    if (ind === keyAt) {
      const m = /^(['"]?)(@?[^\s'":]+)\1:\s*(.*)$/.exec(t);
      const inline = m && /^['"]?(\d[^\s'"(_]*)/.exec(m[3]!); // v5 "next: 14.1.0_react@18"
      if (m && inline) { out.set(m[2]!, inline[1]!); name = undefined; } else name = m?.[2];
      continue;
    }
    const v = name && ind === keyAt + 2 && /^version:\s+['"]?(\d[^\s'"(_]*)/.exec(t);
    if (v) { out.set(name!, v[1]!); name = undefined; }
  }
  return out;
}
function pnpmLocked(text: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  let inPkgs = false;
  for (const l of text.split('\n')) {
    if (/^\S/.test(l)) { inPkgs = /^(packages|snapshots):\s*$/.test(l); continue; }
    if (!inPkgs) continue;
    // "  /next@14.1.0:" (v6), "  next@14.1.0:" (v9), "  /next/14.1.0:" (v5), quoted when scoped
    const m = /^ {2}['"]?\/?(@?[^@\s/'"]+(?:\/[^@\s/'"]+)?)[@/](\d[^\s'"(_:]*)/.exec(l);
    if (m) out.push({ name: m[1]!, version: m[2]! });
  }
  return out;
}
// yarn.lock v1 (`version "1.2.3"`) and Berry (`version: 1.2.3`)
function yarnEntries(text: string): { specs: string[]; version: string }[] {
  const out: { specs: string[]; version: string }[] = [];
  let specs: string[] | undefined;
  for (const l of text.split('\n')) {
    if (/^\S.*:\s*$/.test(l) && !l.startsWith('#') && !l.startsWith('__metadata')) { specs = l.replace(/:\s*$/, '').split(/,\s*/).map((s) => s.trim().replace(/^"|"$/g, '')); continue; }
    const v = /^ {2}version:? "?([^"\s]+)"?/.exec(l);
    if (specs && v) { out.push({ specs, version: v[1]! }); specs = undefined; }
  }
  return out;
}
const yarnName = (spec: string) => spec.slice(0, spec.indexOf('@', 1));
const yarnLocked = (text: string) => yarnEntries(text).filter((e) => e.specs[0] && !e.specs[0].includes('@workspace:')).map((e) => ({ name: yarnName(e.specs[0]!), version: e.version }));
function yarnDirect(text: string, name: string, range: string): string | undefined {
  const mine = yarnEntries(text).filter((e) => e.specs.some((s) => yarnName(s) === name));
  return (mine.find((e) => e.specs.some((s) => s === `${name}@${range}` || s === `${name}@npm:${range}`)) ?? mine[0])?.version;
}

// pip (requirements.txt pinned with ==), poetry.lock and uv.lock ([[package]] blocks); pyproject says what's direct
export function pythonDeps(f: Files): Dep[] {
  const lock = f['poetry.lock'] ?? f['uv.lock'];
  const manager: Manager = f['poetry.lock'] ? 'poetry' : f['uv.lock'] ? 'uv' : 'pip';
  const req = new Map<string, string | undefined>();
  for (const raw of (f['requirements.txt'] ?? '').split('\n')) {
    const l = raw.replace(/\s+#.*$/, '').trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(?:==\s*([\w.+-]+))?/.exec(l);
    if (!l || l.startsWith('#') || l.startsWith('-') || /:\/\//.test(l) || !m) continue;
    req.set(pyName(m[1]!), m[3]);
  }
  const direct = new Set([...req.keys(), ...pyprojectNames(f['pyproject.toml'] ?? '')]);
  const out: Dep[] = [];
  if (lock) {
    for (const b of tomlPackages(lock)) out.push({ eco: 'PyPI', name: pyName(b.name), version: b.version, direct: direct.has(pyName(b.name)), manager });
  } else {
    for (const [name, version] of req) if (version) out.push({ eco: 'PyPI', name, version, direct: true, manager });
  }
  return uniq(out);
}
function pyprojectNames(text: string): string[] {
  const out: string[] = [];
  // [project] dependencies = ["fastapi>=0.110", "uvicorn[standard]"]
  for (const arr of text.matchAll(/^\s*(?:dependencies|dev-dependencies)\s*=\s*\[([\s\S]*?)\]/gm)) for (const s of arr[1]!.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) out.push(pyName(s[1]!));
  // [tool.poetry.dependencies] / [tool.poetry.group.dev.dependencies]: one key per line
  let on = false;
  for (const l of text.split('\n')) {
    if (/^\s*\[/.test(l)) { on = /^\s*\[tool\.poetry\.(group\.[\w-]+\.)?(dev-)?dependencies\]/.test(l); continue; }
    const k = on && /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(l);
    if (k && k[1] !== 'python') out.push(pyName(k[1]!));
  }
  return out;
}
// [[package]] name = "x" version = "y" (poetry.lock, uv.lock, Cargo.lock)
export function tomlPackages(text: string): { name: string; version: string }[] {
  return text.split(/^\[\[package\]\]\s*$/m).slice(1).map((b) => ({ name: /^name\s*=\s*"([^"]+)"/m.exec(b)?.[1], version: /^version\s*=\s*"([^"]+)"/m.exec(b)?.[1] }))
    .filter((p): p is { name: string; version: string } => !!p.name && !!p.version);
}

export function goDeps(f: Files): Dep[] {
  const text = f['go.mod'];
  if (!text) return [];
  const out: Dep[] = [];
  const add = (l: string) => { const m = /^\s*([\w.~/-]+\.[\w.~/-]+)\s+(v\d[\w.+-]*)(\s*\/\/\s*indirect)?/.exec(l); if (m) out.push({ eco: 'Go', name: m[1]!, version: m[2]!.slice(1), direct: !m[3], manager: 'go' }); };
  let block = false;
  for (const l of text.split('\n')) {
    if (/^require\s*\(/.test(l)) { block = true; continue; }
    if (block && /^\s*\)/.test(l)) { block = false; continue; }
    if (block) add(l); else if (/^require\s+/.test(l)) add(l.replace(/^require\s+/, ''));
  }
  return out;
}
export function cargoDeps(f: Files): Dep[] {
  if (!f['Cargo.lock']) return [];
  const direct = new Set<string>();
  let on = false;
  for (const l of (f['Cargo.toml'] ?? '').split('\n')) {
    if (/^\s*\[/.test(l)) { on = /^\s*\[(dev-|build-)?dependencies\]/.test(l); continue; }
    const k = on && /^\s*([A-Za-z0-9_-]+)\s*=/.exec(l);
    if (k) direct.add(k[1]!);
  }
  return tomlPackages(f['Cargo.lock']).map((p) => ({ eco: 'crates.io' as const, name: p.name, version: p.version, direct: direct.has(p.name), manager: 'cargo' as const }));
}
export function rubyDeps(f: Files): Dep[] {
  const text = f['Gemfile.lock'];
  if (!text) return [];
  const direct = new Set([...(text.split(/^DEPENDENCIES\s*$/m)[1] ?? '').split(/^\S/m)[0]!.matchAll(/^ {2}([\w.-]+)/gm)].map((m) => m[1]!));
  return [...text.matchAll(/^ {4}([\w.-]+) \(([\d.]+)\)\s*$/gm)].map((m) => ({ eco: 'RubyGems' as const, name: m[1]!, version: m[2]!, direct: direct.has(m[1]!), manager: 'bundler' as const }));
}
export function phpDeps(f: Files): Dep[] {
  const lock = safeJson<{ packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] }>(f['composer.lock']);
  if (!lock) return [];
  const j = safeJson<{ require?: Record<string, string>; 'require-dev'?: Record<string, string> }>(f['composer.json']) ?? {};
  const direct = new Set([...Object.keys(j.require ?? {}), ...Object.keys(j['require-dev'] ?? {})]);
  return [...(lock.packages ?? []), ...(lock['packages-dev'] ?? []).map((p) => ({ ...p, dev: true }))].map((p) => ({ eco: 'Packagist' as const, name: p.name, version: clean(p.version), direct: direct.has(p.name), manager: 'composer' as const, ...('dev' in p && { dev: true }) }));
}
export const depsOf = (f: Files): Dep[] => [...npmDeps(f), ...pythonDeps(f), ...goDeps(f), ...cargoDeps(f), ...rubyDeps(f), ...phpDeps(f)];

// --- registries ------------------------------------------------------------------------------------------------------
export const URLS = {
  npm: () => process.env.UNIT7_NPM_REGISTRY ?? 'https://registry.npmjs.org',
  pypi: () => process.env.UNIT7_PYPI_URL ?? 'https://pypi.org',
  go: () => process.env.UNIT7_GOPROXY ?? 'https://proxy.golang.org',
  crates: () => process.env.UNIT7_CRATES_URL ?? 'https://crates.io',
  gems: () => process.env.UNIT7_RUBYGEMS_URL ?? 'https://rubygems.org',
  packagist: () => process.env.UNIT7_PACKAGIST_URL ?? 'https://repo.packagist.org',
  osv: () => process.env.UNIT7_OSV_URL ?? 'https://api.osv.dev',
  hub: () => process.env.UNIT7_DOCKERHUB_API ?? 'https://hub.docker.com',
  github: () => process.env.UNIT7_GITHUB_API ?? 'https://api.github.com',
};
async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T | undefined> {
  try {
    const r = await fetch(url, { ...init, headers: { 'user-agent': 'Unit7 (keep it fresh)', accept: 'application/json', ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(15_000) });
    return r.ok ? await r.json() as T : undefined;
  } catch { return undefined; }
}
const goPath = (m: string) => m.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
// every published version of a package (undefined: the registry didn't answer)
export async function versionsOf(eco: Eco, name: string): Promise<string[] | undefined> {
  switch (eco) {
    case 'npm': { const d = await fetchJson<{ versions?: Record<string, unknown> }>(`${URLS.npm()}/${name.replace('/', '%2F')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } }); return d?.versions && Object.keys(d.versions); }
    case 'PyPI': { const d = await fetchJson<{ releases?: Record<string, unknown[]> }>(`${URLS.pypi()}/pypi/${encodeURIComponent(name)}/json`); return d?.releases && Object.entries(d.releases).filter(([, files]) => files.length).map(([v]) => v); }
    case 'Go': { try { const r = await fetch(`${URLS.go()}/${goPath(name)}/@v/list`, { signal: AbortSignal.timeout(15_000) }); return r.ok ? (await r.text()).split('\n').filter(Boolean).map((v) => v.replace(/^v/, '')) : undefined; } catch { return undefined; } }
    case 'crates.io': { const d = await fetchJson<{ versions?: { num: string; yanked: boolean }[] }>(`${URLS.crates()}/api/v1/crates/${encodeURIComponent(name)}`); return d?.versions?.filter((v) => !v.yanked).map((v) => v.num); }
    case 'RubyGems': { const d = await fetchJson<{ number: string; prerelease: boolean }[]>(`${URLS.gems()}/api/v1/versions/${encodeURIComponent(name)}.json`); return d?.filter((v) => !v.prerelease).map((v) => v.number); }
    case 'Packagist': { const d = await fetchJson<{ packages?: Record<string, { version: string }[]> }>(`${URLS.packagist()}/p2/${name}.json`); return d?.packages?.[name]?.map((v) => clean(v.version)); }
  }
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}

// --- security problems: OSV.dev, plus npm's advisory list --------------------------------------------------------------
export type Severity = 'critical' | 'high' | 'moderate' | 'low';
export interface Advisory { id: string; aliases: string[]; eco: Eco; pkg: string; version: string; severity: Severity; summary: string; url: string; fixed?: string; source: 'osv' | 'npm' | 'image' }
const SEV: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'moderate', MEDIUM: 'moderate', LOW: 'low' };
export const SEV_RANK: Record<Severity, number> = { critical: 3, high: 2, moderate: 1, low: 0 };
interface OsvVuln {
  id: string; aliases?: string[]; summary?: string; details?: string; database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { introduced?: string; fixed?: string }[] }[]; database_specific?: { severity?: string } }[];
  references?: { type?: string; url?: string }[];
}
const sameName = (eco: Eco, a = '', b = '') => (eco === 'PyPI' ? pyName(a) === pyName(b) : a === b);
// one OSV record about one installed package, in Unit7's words (pure: tested on OSV's own JSON)
export function fromOsv(v: OsvVuln, dep: Pick<Dep, 'eco' | 'name' | 'version'>): Advisory {
  const mine = (v.affected ?? []).filter((a) => a.package?.ecosystem === dep.eco && sameName(dep.eco, a.package?.name, dep.name));
  const fixes = mine.flatMap((a) => (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed))).filter((x): x is string => !!x && compare(x, dep.version) > 0).sort(compare);
  const sev = v.database_specific?.severity ?? mine.find((a) => a.database_specific?.severity)?.database_specific?.severity;
  const ghsa = [v.id, ...(v.aliases ?? [])].find((x) => x.startsWith('GHSA-'));
  const url = v.references?.find((r) => r.type === 'ADVISORY' && r.url)?.url ?? (ghsa ? `https://github.com/advisories/${ghsa}` : `https://osv.dev/vulnerability/${v.id}`);
  return { id: v.id, aliases: v.aliases ?? [], eco: dep.eco, pkg: dep.name, version: dep.version, severity: SEV[(sev ?? '').toUpperCase()] ?? 'moderate',
    summary: (v.summary ?? v.details ?? '').split('\n')[0]!.trim().slice(0, 200) || `A known security problem in ${dep.name}`, url, ...(fixes[0] && { fixed: fixes[0] }), source: 'osv' };
}
// the same problem under two names (a GHSA and a PYSEC/CVE id) counts once, the worse reading kept
export function mergeAdvisories(list: Advisory[]): Advisory[] {
  const out: Advisory[] = [];
  for (const a of list) {
    const names = new Set([a.id, ...a.aliases]);
    const same = out.find((b) => b.pkg === a.pkg && b.eco === a.eco && [b.id, ...b.aliases].some((n) => names.has(n)));
    if (!same) { out.push(a); continue; }
    if (SEV_RANK[a.severity] > SEV_RANK[same.severity]) same.severity = a.severity;
    same.aliases = [...new Set([...same.aliases, a.id, ...a.aliases])].filter((n) => n !== same.id);
    same.fixed ??= a.fixed;
    if (same.id.startsWith('PYSEC') && a.id.startsWith('GHSA')) { same.id = a.id; same.url = a.url; same.summary = a.summary; }
  }
  return out.sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity]);
}

export async function osvAdvisories(deps: Dep[], problems: string[]): Promise<Advisory[]> {
  const list = deps.slice(0, 3000);
  const ids = new Map<string, Dep[]>();
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const r = await fetchJson<{ results?: { vulns?: { id: string }[] }[] }>(`${URLS.osv()}/v1/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.eco }, version: d.version })) }) });
    if (!r?.results) { problems.push('OSV.dev didn’t answer, so security problems weren’t checked this time.'); return []; }
    r.results.forEach((res, k) => { for (const v of res.vulns ?? []) ids.set(v.id, [...(ids.get(v.id) ?? []), chunk[k]!]); });
  }
  // ponytail: the first 80 records in detail; a big old lockfile can have more, the next scan picks them up
  const details = await pool([...ids.keys()].slice(0, 80), 8, (vid) => fetchJson<OsvVuln>(`${URLS.osv()}/v1/vulns/${encodeURIComponent(vid)}`));
  return details.flatMap((v, k) => (v ? ids.get([...ids.keys()][k]!)!.map((d) => fromOsv(v, d)) : []));
}
// the list `npm audit` reads (bulk endpoint): adds what OSV doesn't have yet; npm audit fix finds the fix
export async function npmAdvisories(deps: Dep[]): Promise<Advisory[]> {
  const npm = deps.filter((d) => d.eco === 'npm');
  if (!npm.length) return [];
  const body: Record<string, string[]> = {};
  for (const d of npm) (body[d.name] ??= []).push(d.version);
  const r = await fetchJson<Record<string, { id: number; url: string; title: string; severity: string; vulnerable_versions?: string }[]>>(`${URLS.npm()}/-/npm/v1/security/advisories/bulk`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return Object.entries(r ?? {}).flatMap(([pkg, list]) => list.map((a) => {
    const ghsa = /GHSA-[\w-]+/.exec(a.url ?? '')?.[0];
    return { id: ghsa ?? `NPM-${a.id}`, aliases: [], eco: 'npm' as const, pkg, version: body[pkg]![0]!, severity: SEV[(a.severity ?? '').toUpperCase()] ?? 'moderate', summary: a.title?.slice(0, 200) ?? `A known security problem in ${pkg}`, url: a.url, source: 'npm' as const };
  }));
}

// --- the base image -------------------------------------------------------------------------------------------------
export interface BaseImage { image: string; updatedAt?: string; newer: boolean; checked: boolean; note?: string }
// the images a Dockerfile builds FROM (stages it names itself and scratch left out)
export function fromImages(dockerfile: string): string[] {
  const stages = new Set<string>(), out: string[] = [];
  for (const m of dockerfile.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
    const img = m[1]!;
    if (img !== 'scratch' && !stages.has(img.toLowerCase()) && !img.includes('$')) out.push(img);
    if (m[2]) stages.add(m[2].toLowerCase());
  }
  return [...new Set(out)];
}
// Docker Hub's own record of a tag: when it was last pushed. Newer than the app's last build = a fresh base to build on.
export async function baseImage(image: string, builtAt: string | undefined): Promise<BaseImage> {
  if (image.includes('@sha256:')) return { image, newer: false, checked: false, note: 'pinned to an exact build, so it never moves by itself' };
  const [path, tag = 'latest'] = image.split(/:(?=[^/]*$)/) as [string, string?];
  const parts = path.split('/');
  if (parts.length > 2 || (parts.length === 2 && /[.:]/.test(parts[0]!)) || parts[0] === 'localhost') return { image, newer: false, checked: false, note: 'not on Docker Hub, so Unit7 can’t check it yet' };
  const [ns, repo] = parts.length === 1 ? ['library', parts[0]!] : [parts[0]!, parts[1]!];
  const t = await fetchJson<{ last_updated?: string; tag_last_pushed?: string }>(`${URLS.hub()}/v2/namespaces/${ns}/repositories/${repo}/tags/${encodeURIComponent(tag)}`);
  const at = t?.tag_last_pushed ?? t?.last_updated;
  if (!at) return { image, newer: false, checked: false, note: 'Docker Hub didn’t answer' };
  return { image, updatedAt: at, newer: !!builtAt && Date.parse(at) > Date.parse(builtAt), checked: true };
}

// --- reading the repo (its GitHub source, as the deployer does) -------------------------------------------------------
export async function repoFile(repo: Repo, path: string, ref: string | undefined, token: string | undefined): Promise<string | undefined> {
  try {
    const r = await fetch(`${URLS.github()}/repos/${repo.owner}/${repo.name}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, {
      headers: { accept: 'application/vnd.github.raw', 'user-agent': 'Unit7', 'x-github-api-version': '2022-11-28', ...(token && { authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(20_000),
    });
    return r.ok ? (await r.text()).slice(0, 20_000_000) : undefined;
  } catch { return undefined; }
}

// --- one app's scan -------------------------------------------------------------------------------------------------
export interface Update { eco: Eco; name: string; from: string; to: string; bump: Bump; direct: boolean; dev?: boolean; manager: Manager; security?: Advisory[] }
export interface Scan {
  at: string; source: 'git' | 'image' | 'none'; repo?: string; managers: Manager[]; deps: number;
  updates: Update[]; advisories: Advisory[]; base: BaseImage[]; problems: string[];
}
type Svc = { id: string; name: string; config: string; current_deployment_id: string | null };

// The newest within the major and the next major, for each direct library; security problems on every installed one.
export async function scanFiles(files: Files, o: { builtAt?: string; detection?: ServiceConfig['detection']; image?: string; imageReport?: { top?: { id: string; pkg: string; installed: string; fixed: string; severity: string; title?: string }[] } } = {}): Promise<Omit<Scan, 'at' | 'source' | 'repo'>> {
  const problems: string[] = [];
  const deps = depsOf(files);
  const direct = deps.filter((d) => d.direct).slice(0, 150);
  const found = await pool(direct, 8, async (d) => ({ d, versions: await versionsOf(d.eco, d.name) }));
  const missed = found.filter((x) => !x.versions).length;
  if (missed) problems.push(`${missed} librar${missed === 1 ? 'y' : 'ies'} couldn’t be looked up this time.`);
  const advisories = mergeAdvisories([...await osvAdvisories(deps, problems), ...await npmAdvisories(deps)]);
  // the image scan's findings in the base image (OS packages): fixed by a rebuild on a fresh base
  for (const v of o.imageReport?.top ?? []) if (!deps.some((d) => d.name === v.pkg)) advisories.push({ id: v.id, aliases: [], eco: 'npm', pkg: v.pkg, version: v.installed, severity: v.severity.toLowerCase() === 'critical' ? 'critical' : 'high', summary: v.title ?? `A known problem in ${v.pkg}`, url: `https://osv.dev/vulnerability/${v.id}`, fixed: v.fixed, source: 'image' });
  const updates: Update[] = [];
  for (const { d, versions } of found) {
    if (!versions) continue;
    const t = targets(d.version, versions);
    const sec = advisories.filter((a) => a.source !== 'image' && a.eco === d.eco && sameName(d.eco, a.pkg, d.name));
    for (const to of [t.inMajor, t.major]) if (to) updates.push({ eco: d.eco, name: d.name, from: d.version, to, bump: bump(d.version, to)!, direct: true, ...(d.dev && { dev: true }), manager: d.manager, ...(sec.length && { security: sec.filter((a) => !a.fixed || compare(to, a.fixed) >= 0) }) });
  }
  // a problem in a library the app doesn't list itself (or with no newer version found): the package manager's fix
  for (const a of advisories) {
    if (a.source === 'image' || updates.some((u) => u.eco === a.eco && sameName(a.eco, u.name, a.pkg) && u.security?.includes(a))) continue;
    const d = deps.find((x) => x.eco === a.eco && sameName(a.eco, x.name, a.pkg));
    if (d && a.fixed && !updates.some((u) => u.name === d.name && u.to === a.fixed)) updates.push({ eco: d.eco, name: d.name, from: d.version, to: a.fixed, bump: bump(d.version, a.fixed) ?? 'patch', direct: d.direct, manager: d.manager, security: [a] });
  }
  const images = o.image ? [o.image] : files.Dockerfile ? fromImages(files.Dockerfile) : o.detection ? fromImages(dockerfileFor(o.detection, []) ?? '') : [];
  const base = await Promise.all(images.slice(0, 3).map((i) => baseImage(i, o.builtAt)));
  return { managers: [...new Set(deps.map((d) => d.manager))], deps: deps.length, updates, advisories, base, problems };
}

export async function scanApp(ctx: Ctx, svc: Svc): Promise<Scan> {
  const cfg = json<ServiceConfig>(svc.config, {});
  const dep = get<{ started_at: string; plan: string }>(ctx.db, 'SELECT started_at, plan FROM deployments WHERE id = ?', svc.current_deployment_id ?? '');
  const imageReport = json<{ security?: { top?: never[] } }>(dep?.plan, {}).security;
  const at = new Date().toISOString();
  if (cfg.source?.type === 'image') return { at, source: 'image', ...await scanFiles({}, { builtAt: dep?.started_at, image: cfg.source.image, imageReport }) };
  const repo = cfg.source?.type === 'git' ? parseRepo(cfg.source.repo) : undefined;
  if (!repo || cfg.source?.type !== 'git') return { at, source: 'none', managers: [], deps: 0, updates: [], advisories: [], base: [], problems: [`${svc.name} isn’t deployed from GitHub or an image, so Unit7 can’t read what it uses.`] };
  const token = await githubToken(ctx, cfg.source.accountId).catch(() => undefined);
  const files: Files = {};
  await pool([...FILES, ...(cfg.detection?.dockerfile && cfg.detection.dockerfile !== 'Dockerfile' ? [cfg.detection.dockerfile] : [])], 6, async (p) => {
    const text = await repoFile(repo, p, cfg.source?.type === 'git' ? cfg.source.branch : undefined, token);
    if (text !== undefined) files[p === cfg.detection?.dockerfile ? 'Dockerfile' : p] = text;
  });
  const s = await scanFiles(files, { builtAt: dep?.started_at, detection: cfg.detection, imageReport });
  if (!Object.keys(files).length) s.problems.unshift(`Unit7 couldn’t read ${repo.owner}/${repo.name} on GitHub. Connect GitHub with access to it.`);
  return { at, source: 'git', repo: `${repo.owner}/${repo.name}`, ...s };
}

// --- release notes for a major version (npm and PyPI packages that live on GitHub) ------------------------------------
// The notes of the GitHub release for that version, when the package says where its code lives. Optional: the major
// card falls back to plain bullets without them.
export async function releaseNotes(eco: Eco, name: string, version: string, token?: string): Promise<string | undefined> {
  let where: string | undefined;
  if (eco === 'npm') where = (await fetchJson<{ repository?: string | { url?: string } }>(`${URLS.npm()}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`))?.repository as string | undefined;
  else if (eco === 'PyPI') where = Object.values((await fetchJson<{ info?: { project_urls?: Record<string, string> } }>(`${URLS.pypi()}/pypi/${encodeURIComponent(name)}/json`))?.info?.project_urls ?? {}).find((u) => /github\.com\/[^/]+\/[^/]+/.test(u));
  const url = typeof where === 'object' ? (where as { url?: string })?.url : where;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(url ?? '');
  if (!m) return undefined;
  const list = await fetchJson<{ tag_name: string; body?: string }[]>(`${URLS.github()}/repos/${m[1]}/${m[2]}/releases?per_page=40`, { headers: { accept: 'application/vnd.github+json', ...(token && { authorization: `Bearer ${token}` }) } });
  const want = [version, `v${version}`, `${name}@${version}`];
  return list?.find((r) => want.includes(r.tag_name) || r.tag_name.endsWith(`@${version}`))?.body?.slice(0, 20_000);
}
