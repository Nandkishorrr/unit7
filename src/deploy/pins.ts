// Toolchain pins: the Node, package manager, Python, Go, Rust and Ruby a build uses, read from the project's own files and
// never "the newest major". The repo's own words win (packageManager, engines, .nvmrc, .python-version, go.mod…), then
// what wrote its lockfile, then a known-good major Unit7 picks. Every pin says why, in words for the deploy's Build step
// ("Used pnpm 10 because your lockfile says so"), and where it came from: when the repo doesn't state it, Unit7 offers a
// pull request that writes it down (src/tools/pins.ts). Pure: the tests feed it files.
//
// pnpm's lockfileVersion → the pnpm that writes it, from pnpm's own release notes: v7.0.0 "Lockfile version bumped to
// v5.4", v8.0.0 "Lockfile v6 is adopted", v9.0.0 "Lockfile v9 is adopted", and pnpm 10 kept lockfileVersion '9.0'
// (github.com/pnpm/pnpm/releases/tag/v9.0.0; vercel.com/changelog/automatic-pnpm-v10-support). So '9.0' is pnpm 10
// (or 9, tried second), '6.x' pnpm 8, '5.x' pnpm 7.
import { pick, nodeSource, pmField, type Detection, type RepoFacts } from '../connectors/detect.ts';

export type Tool = 'node' | 'npm' | 'pnpm' | 'yarn' | 'bun' | 'python' | 'go' | 'rust' | 'ruby';
// repo: the project says it · lockfile: what wrote its lockfile · default: Unit7's known-good pick · unit7: remembered
// after a build failed with another one · you: a person picked it for this build
export type Source = 'repo' | 'lockfile' | 'default' | 'unit7' | 'you';
// alts: the next majors to try when this one fails · lock: the majors that write the project's lockfile (package managers)
export interface Pin { tool: Tool; version: string; source: Source; why: string; alts?: string[]; lock?: string[] }
export interface Pins { node?: Pin; pm?: Pin; python?: Pin; go?: Pin; rust?: Pin; ruby?: Pin }

// known-good majors, never "latest": Node's current LTS, pnpm 10, Yarn 1 (classic) when the lockfile can't tell
export const DEFAULT = { node: '22', pnpm: '10', yarn: '1', bun: '1', python: '3.13', go: '1.25', rust: '1' } as const;
// the start of these is read at the repo root (the deployer's readRepo); lockfiles stay out of `manifests`, whose text other
// checks search for package names
export const PIN_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', '.python-version', 'runtime.txt', 'rust-toolchain', 'rust-toolchain.toml', '.ruby-version'];
export const NAMES: Record<Tool, string> = { node: 'Node', npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun', python: 'Python', go: 'Go', rust: 'Rust', ruby: 'Ruby' };
export const PIN_SPEC = /^(node|npm|pnpm|yarn|bun|python|go|rust|ruby)@(\d+(?:\.\d+){0,2})$/;
const PMS = new Set<Tool>(['npm', 'pnpm', 'yarn', 'bun']);

// --- lockfiles ---------------------------------------------------------------------------------------------------------
export function pnpmMajors(lock: string): string[] | undefined {
  const v = /^lockfileVersion:\s*['"]?(\d+)/m.exec(lock);
  const n = v ? Number(v[1]) : NaN;
  // ponytail: a lockfile newer than '9.x' is a pnpm Unit7 doesn't know yet; the known-good pick and self-heal take over
  return n === 9 ? ['10', '9'] : n === 6 ? ['8'] : n === 5 ? ['7'] : undefined;
}
// Yarn 1 says so in its header; Berry's __metadata version: 4 (Yarn 2), 5–6 (Yarn 3), 8+ (Yarn 4)
export function yarnMajors(lock: string): string[] | undefined {
  if (/^# yarn lockfile v1/m.test(lock)) return ['1'];
  const v = /^__metadata:\s*\n\s+version:\s*(\d+)/m.exec(lock);
  if (!v) return undefined;
  const n = Number(v[1]);
  return [n >= 8 ? '4' : n >= 5 ? '3' : '2'];
}
// package-lock.json's lockfileVersion: 1 is npm 5–6, 2 is npm 7–8, 3 is npm 9 and newer (the npm that comes with Node reads all three)
export function npmMajors(lock: string): string[] | undefined {
  const v = /"lockfileVersion":\s*(\d+)/.exec(lock);
  return v ? [({ 1: '6', 2: '8' } as Record<string, string>)[v[1]!] ?? '10'] : undefined;
}

// --- languages ---------------------------------------------------------------------------------------------------------
const PY_MIN = 9, PY_MAX = 14, PY_DEFAULT = 13;
// "3.11", "==3.11.*", ">=3.10,<3.12", "^3.11" (Poetry), "~=3.11": the 3.x minor to build with. A lower bound the default
// meets keeps the default; an upper bound below it takes the highest one allowed.
export function pythonFromSpec(spec: string): string | undefined {
  let lo: number | undefined, hi: number | undefined, exact: number | undefined;
  for (const part of spec.split(',')) {
    const m = /^\s*(>=|>|==|~=|\^|<=|<|!=)?\s*3\.(\d+)/.exec(part);
    if (!m) continue;
    const n = Number(m[2]), op = m[1] ?? '==';
    if (op === '==') exact = n;
    else if (op === '>=' || op === '~=' || op === '^') lo = Math.max(lo ?? 0, n);
    else if (op === '>') lo = Math.max(lo ?? 0, n + 1);
    else if (op === '<') hi = Math.min(hi ?? 99, n - 1);
    else if (op === '<=') hi = Math.min(hi ?? 99, n);
  }
  const pick3 = exact ?? Math.min(hi ?? 99, Math.max(lo ?? PY_DEFAULT, PY_DEFAULT));
  if (exact === undefined && lo === undefined && hi === undefined) return undefined;
  return `3.${Math.min(PY_MAX, Math.max(PY_MIN, pick3))}`;
}

const at = (files: Record<string, string>, re: RegExp) => { const p = pick(Object.keys(files), re); return p ? files[p] : undefined; };
const safeJson = (s?: string) => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };

// --- the pins for one build ----------------------------------------------------------------------------------------------
export function pinsOf(facts: RepoFacts, d: Pick<Detection, 'runtime' | 'packageManager' | 'builder' | 'buildCommand'>): Pins {
  if (d.builder === 'dockerfile' || d.builder === 'compose') return {}; // the repo's own Dockerfile picks its tools
  const f: Record<string, string> = { ...facts.manifests, ...(facts.pinFiles ?? {}) };
  const pins: Pins = {};
  if (d.runtime === 'node' || (d.builder === 'static' && !!d.buildCommand)) {
    const n = nodeSource(facts);
    pins.node = n ? { tool: 'node', version: String(n.major), source: 'repo', why: n.from === 'engines' ? 'package.json asks for it' : n.from === 'nvmrc' ? `your ${n.file} says so` : 'your Volta settings say so' }
      : { tool: 'node', version: DEFAULT.node, source: 'default', why: 'your repo doesn’t say which' };
    const pm = d.packageManager as Tool | undefined;
    if (pm && PMS.has(pm)) {
      const pin = pmPin(pm, safeJson(at(f, /(^|\/)package\.json$/)), f);
      if (pin) pins.pm = pin;
    }
  }
  if (d.runtime === 'python') {
    const file = /^\s*(?:python-?)?(3\.\d+)/m.exec(at(f, /(^|\/)\.python-version$/) ?? '')?.[1];
    const pyproject = at(f, /(^|\/)pyproject\.toml$/) ?? '';
    const req = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ?? /^\s*python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
    const fromReq = req ? pythonFromSpec(req) : undefined;
    const runtime = /python-(3\.\d+)/.exec(at(f, /(^|\/)runtime\.txt$/) ?? '')?.[1];
    pins.python = file ? { tool: 'python', version: file, source: 'repo', why: 'your .python-version says so' }
      : fromReq ? { tool: 'python', version: fromReq, source: 'repo', why: 'your pyproject.toml asks for it' }
      : runtime ? { tool: 'python', version: runtime, source: 'repo', why: 'your runtime.txt says so' }
      : { tool: 'python', version: DEFAULT.python, source: 'default', why: 'your repo doesn’t say which' };
  }
  if (d.runtime === 'go') {
    const mod = at(f, /(^|\/)go\.mod$/) ?? '';
    const tc = /^toolchain\s+go(1\.\d+)/m.exec(mod)?.[1], dir = /^go\s+(1\.\d+)/m.exec(mod)?.[1];
    const v = tc ?? dir;
    // a go line below 1.21 is only the oldest Go the code allows; 1.21 is the oldest that still reads toolchain lines
    pins.go = v ? { tool: 'go', version: Number(v.split('.')[1]) < 21 ? '1.21' : v, source: 'repo', why: tc ? 'your go.mod’s toolchain line says so' : 'your go.mod says so' }
      : { tool: 'go', version: DEFAULT.go, source: 'default', why: 'your repo doesn’t say which' };
  }
  if (d.runtime === 'rust') {
    const tc = at(f, /(^|\/)rust-toolchain(\.toml)?$/);
    const ch = tc && (/channel\s*=\s*["']([^"']+)["']/.exec(tc)?.[1] ?? tc.trim().split('\n')[0]!.trim());
    const v = ch && /^(\d+\.\d+)/.exec(ch)?.[1];
    // "stable" or a nightly: rustup in the image follows the file by itself
    pins.rust = v ? { tool: 'rust', version: v, source: 'repo', why: 'your rust-toolchain file says so' }
      : { tool: 'rust', version: DEFAULT.rust, source: ch ? 'repo' : 'default', why: ch ? 'your rust-toolchain file picks the channel, and the build follows it' : 'your repo doesn’t say which' };
  }
  const ruby = /^\s*(?:ruby-)?(\d+\.\d+)/m.exec(at(f, /(^|\/)\.ruby-version$/) ?? '')?.[1];
  if (ruby) pins.ruby = { tool: 'ruby', version: ruby, source: 'repo', why: 'your .ruby-version says so' };
  return pins;
}

function pmPin(pm: Tool, pkg: Parameters<typeof pmField>[0], f: Record<string, string>): Pin | undefined {
  const lock = pm === 'pnpm' ? at(f, /(^|\/)pnpm-lock\.yaml$/) : pm === 'yarn' ? at(f, /(^|\/)yarn\.lock$/) : pm === 'npm' ? at(f, /(^|\/)package-lock\.json$/) : undefined;
  const majors = lock ? (pm === 'pnpm' ? pnpmMajors(lock) : pm === 'yarn' ? yarnMajors(lock) : npmMajors(lock)) : undefined;
  const field = pmField(pkg, pm);
  if (field?.name === pm) return { tool: pm, version: field.version, source: 'repo', why: field.from === 'volta' ? 'your Volta settings say so' : 'package.json says so', ...(majors && { lock: majors }) };
  if (majors) return { tool: pm, version: majors[0]!, source: 'lockfile', why: 'your lockfile says so', lock: majors, ...(majors.length > 1 && { alts: majors.slice(1) }) };
  if (pm === 'npm') return undefined; // the npm that comes with Node: it's pinned by the Node version
  const known = DEFAULT[pm as 'pnpm' | 'yarn' | 'bun'];
  return { tool: pm, version: known, source: 'default', why: 'your repo doesn’t say which', ...(pm === 'pnpm' && { alts: ['9'] }) };
}

// --- overrides: remembered after a failed build, or picked by a person for one build ----------------------------------------
export function parsePin(spec: string): { tool: Tool; version: string } | undefined {
  const m = PIN_SPEC.exec(spec);
  return m ? { tool: m[1] as Tool, version: m[2]! } : undefined;
}
export const slotOf = (t: Tool): keyof Pins => (PMS.has(t) ? 'pm' : t as keyof Pins);
export function applyPin(pins: Pins, spec: string | undefined, source: 'unit7' | 'you'): Pins {
  const p = spec ? parsePin(spec) : undefined;
  if (!p) return pins;
  const slot = slotOf(p.tool), cur = pins[slot];
  if (slot === 'pm' && cur && cur.tool !== p.tool) return pins;   // the project changed package manager since
  if (source === 'unit7' && cur?.source === 'repo') return pins;   // what the repo says now wins over a remembered pin
  return { ...pins, [slot]: { tool: p.tool, version: p.version, source, why: source === 'you' ? 'you picked it' : 'it fixed this app’s last failed build', ...(cur?.lock && { lock: cur.lock }) } };
}
export const specOf = (p: Pin) => `${p.tool}@${p.version}`;
// A detection with the pins this build uses: the project's, then the app's remembered ones (and self-heal's Node switch),
// then a person's pick for this one build. Node's image follows the Node pin.
// pinnedByYou: a person's "build with pnpm 10 and pin it for me" over what the repo says, kept until the repo says the same
export function withPins<D extends Detection>(d: D, facts: RepoFacts, cfg: { pinned?: string[]; pinnedByYou?: string[]; nodeVersion?: number }, chosen?: string): D {
  let pins = pinsOf(facts, d);
  if (cfg.nodeVersion && pins.node) pins.node = { tool: 'node', version: String(cfg.nodeVersion), source: 'unit7', why: 'it fixed this app’s last failed build' };
  for (const spec of cfg.pinned ?? []) pins = applyPin(pins, spec, 'unit7');
  for (const spec of cfg.pinnedByYou ?? []) {
    const p = parsePin(spec), cur = p && pins[slotOf(p.tool)];
    if (p && !(cur?.source === 'repo' && cur.version.split('.')[0] === p.version.split('.')[0])) pins = applyPin(pins, spec, 'you');
  }
  pins = applyPin(pins, chosen, 'you');
  const node = pins.node ? Number(pins.node.version) : undefined;
  return { ...d, pins, ...(node && { nodeVersion: node }) };
}

// --- words -------------------------------------------------------------------------------------------------------------
export const label = (p: Pin) => `${NAMES[p.tool]} ${p.version}`;
const phrase = (p: Pin) => (p.source === 'default' ? `${label(p)} (your repo doesn’t say which)` : `${label(p)} because ${p.why}`);
// "Used pnpm 10 because your lockfile says so, and Node 22"
export function buildNote(pins: Pins | undefined): string | undefined {
  if (!pins) return undefined;
  const main = pins.pm ?? pins.python ?? pins.go ?? pins.rust;
  const node = pins.node;
  if (!main && !node) return undefined;
  if (!main) return `Used ${phrase(node!)}`;
  return `Used ${phrase(main)}${node ? `, and ${node.source === 'default' ? label(node) : phrase(node)}` : ''}`;
}
// the pins worth writing into the repo: everything the repo doesn't say itself (the Node default only once it was changed)
export const unpinned = (pins: Pins | undefined): Pin[] => Object.values(pins ?? {}).filter((p): p is Pin => !!p && p.source !== 'repo' && !(p.source === 'default' && !PMS.has(p.tool)));

// --- pnpm's settings moved -----------------------------------------------------------------------------------------------
// pnpm 11 no longer reads the "pnpm" field of package.json: "Since v11, pnpm no longer reads settings from the pnpm field
// of package.json. Settings must be defined in pnpm-workspace.yaml instead" (pnpm.io/package_json). It also replaced
// onlyBuiltDependencies, neverBuiltDependencies and ignoredBuiltDependencies with one allowBuilds map (pnpm.io/blog/releases/
// 11.0: "Use allowBuilds instead"). pnpm 10.5+ already reads the same settings from pnpm-workspace.yaml. So for a pnpm 11
// build, Unit7 writes them there (in the build only: the person's intent holds now), and offers a pull request that moves
// them for good (src/tools/pins.ts). The values go in as JSON, which is valid YAML.
const BUILDS: Record<string, boolean> = { onlyBuiltDependencies: true, neverBuiltDependencies: false, ignoredBuiltDependencies: false };
export const pnpmMajor = (p?: Pin) => (p?.tool === 'pnpm' ? parseInt(p.version, 10) : NaN);
export function movePnpmSettings(pkgText: string | undefined, workspace: string | undefined, major: number): { keys: string[]; yaml: string; pkg: string } | undefined {
  const pkg = safeJson(pkgText);
  const field = pkg?.pnpm;
  if (!field || typeof field !== 'object' || Array.isArray(field) || !Object.keys(field).length) return undefined;
  const has = new Set([...(workspace ?? '').matchAll(/^([A-Za-z][\w-]*)\s*:/gm)].map((m) => m[1]!));
  const lines: string[] = [], keys: string[] = [];
  const allow: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(field as Record<string, unknown>)) {
    if (major >= 11 && k in BUILDS) {
      if (Array.isArray(v) && !has.has('allowBuilds')) { for (const name of v) if (typeof name === 'string') allow[name] ??= BUILDS[k]!; keys.push(k); }
      continue;
    }
    if (k === 'onlyBuiltDependenciesFile' || has.has(k)) continue;
    lines.push(`${k}: ${JSON.stringify(v)}`); keys.push(k);
  }
  if (Object.keys(allow).length) lines.unshift(`allowBuilds: ${JSON.stringify(allow)}`);
  if (!lines.length) return undefined;
  const base = (workspace ?? '').trimEnd();
  const rest = { ...pkg };
  const left = Object.fromEntries(Object.entries(field as Record<string, unknown>).filter(([k]) => !keys.includes(k)));
  if (Object.keys(left).length) rest.pnpm = left; else delete rest.pnpm;
  const indent = /^([ \t]+)"/m.exec(pkgText!)?.[1] ?? '  ';
  return { keys, yaml: `${base ? `${base}\n` : ''}${lines.join('\n')}\n`, pkg: `${JSON.stringify(rest, null, indent)}${pkgText!.endsWith('\n') ? '\n' : ''}` };
}
// the build's own copy: only where pnpm 11 (or newer) builds and the repo still has them in package.json
export function pnpmShim(facts: RepoFacts, pins?: Pins): { keys: string[]; yaml: string } | undefined {
  const major = pnpmMajor(pins?.pm);
  if (!(major >= 11)) return undefined;
  const pkgPath = pick(Object.keys(facts.manifests), /(^|\/)package\.json$/);
  if (!pkgPath || pkgPath.includes('/')) return undefined; // the app's own package.json, at the root of the build
  const m = movePnpmSettings(facts.manifests[pkgPath], facts.manifests['pnpm-workspace.yaml'], major);
  return m && { keys: m.keys, yaml: m.yaml };
}
