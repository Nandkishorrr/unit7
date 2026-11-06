// Writing the build's toolchain into the repo: a pull request that adds "packageManager": "pnpm@10.x.y" (the newest 10.x
// from the registry: corepack wants an exact version), engines.node, .python-version, .ruby-version or
// rust-toolchain.toml, so every build and every computer uses the versions Unit7 builds with. The fix-PR pattern
// (src/tools/fixes.ts): a branch of its own (the main branch is only read), a plain description, a preview like any PR,
// and merged once its checks pass only where the app's autonomy is Fix itself or above; otherwise one tap merges it.
// pinChanges and pinPrBody are pure, so the pull request's content is tested.
import { z } from 'zod';
import { defineTool, type Ctx } from './runtime.ts';
import { get, json, now, run } from '../db.ts';
import { Unit7Error, forbidden } from '../errors.ts';
import { commitFiles, defaultBranch, githubToken, mergePull, openPull, parseRepo, pullCheck } from '../connectors/github.ts';
import { compare, repoFile, stable, versionsOf } from '../fresh/detect.ts';
import { NAMES, PIN_SPEC, movePnpmSettings, parsePin, pnpmMajor, slotOf, specOf, unpinned, type Pin, type Tool } from '../deploy/pins.ts';
import type { ServiceConfig } from '../deploy/deployer.ts';
import { fid, isAgent } from './helpers.ts';

type PinPr = { number: number; url: string; branch: string; at: string; auto: boolean; pins: string[] };
type Cfg = ServiceConfig & { pinPr?: PinPr };
const appOf = (ctx: Ctx, serviceId: string) => {
  const s = get<{ id: string; name: string; config: string; environment_id: string }>(ctx.db, 'SELECT id, name, config, environment_id FROM services WHERE id = ? AND org_id = ?', serviceId, ctx.orgId);
  if (!s) throw new Unit7Error('not_found', 'That app was not found.', 404);
  return { ...s, cfg: json<Cfg>(s.config, {}) };
};
const save = (ctx: Ctx, id: string, patch: Partial<Cfg>) => run(ctx.db, 'UPDATE services SET config = json_patch(config, ?) WHERE id = ?', JSON.stringify(patch), id);

// "pnpm@10" → "10.18.3", the newest stable release in that major (Yarn 2+ is published as @yarnpkg/cli-dist)
export async function exactVersion(spec: string): Promise<string> {
  const p = parsePin(spec);
  if (!p) throw new Unit7Error('bad_pin', `“${spec}” isn’t a version Unit7 can pin.`, 400);
  const pkg = p.tool === 'pnpm' ? 'pnpm' : p.tool === 'npm' ? 'npm' : p.tool === 'bun' ? 'bun' : p.tool === 'yarn' ? (parseInt(p.version, 10) >= 2 ? '@yarnpkg/cli-dist' : 'yarn') : undefined;
  if (!pkg || p.version.split('.').length === 3) return p.version;
  const best = (await versionsOf('npm', pkg))?.filter((v) => stable(v) && (v === p.version || v.startsWith(`${p.version}.`))).sort(compare).at(-1);
  if (!best) throw new Unit7Error('no_version', `Unit7 couldn’t look up the newest ${NAMES[p.tool]} ${p.version} just now. Try again in a minute.`, 502);
  return best;
}

export interface FileChange { path: string; content: string; line: string }
// the files to write for these pins (package managers at an exact version), keeping package.json's own indentation
export function pinChanges(files: Partial<Record<string, string>>, pins: { tool: Tool; version: string }[]): FileChange[] {
  const out: FileChange[] = [];
  const text = files['package.json'];
  let pkg: Record<string, unknown> | undefined;
  const lines: string[] = [];
  const needPkg = () => {
    if (pkg) return pkg;
    try { pkg = JSON.parse(text ?? ''); } catch { throw new Unit7Error('no_package_json', 'Unit7 couldn’t read package.json in the repo, so it can’t pin the version there.', 409); }
    return pkg!;
  };
  for (const p of pins) {
    const major = p.version.split('.')[0]!;
    if (slotOf(p.tool) === 'pm') {
      const v = `${p.tool}@${p.version}`;
      if (needPkg().packageManager === v) continue;
      needPkg().packageManager = v;
      lines.push(`package.json: "packageManager": "${v}"`);
    } else if (p.tool === 'node') {
      const engines = (needPkg().engines ?? {}) as Record<string, string>;
      if (engines.node !== `${major}.x`) { needPkg().engines = { ...engines, node: `${major}.x` }; lines.push(`package.json: "engines": { "node": "${major}.x" }`); }
      // a version file that says something else would contradict it on people's computers
      for (const rc of ['.nvmrc', '.node-version']) {
        const cur = files[rc];
        if (cur !== undefined && /\d+/.exec(cur)?.[0] !== major) out.push({ path: rc, content: `${major}\n`, line: `${rc}: ${major}` });
      }
    } else if (p.tool === 'python' || p.tool === 'ruby') {
      const path = p.tool === 'python' ? '.python-version' : '.ruby-version';
      if (files[path]?.trim() !== p.version) out.push({ path, content: `${p.version}\n`, line: `${path}: ${p.version}` });
    } else if (p.tool === 'rust') {
      out.push({ path: 'rust-toolchain.toml', content: `[toolchain]\nchannel = "${p.version}"\n`, line: `rust-toolchain.toml: channel = "${p.version}"` });
    } // Go: go.mod already says which Go
  }
  if (pkg && lines.length) {
    const indent = /^([ \t]+)"/m.exec(text!)?.[1] ?? '  ';
    out.unshift({ path: 'package.json', content: `${JSON.stringify(pkg, null, indent)}${text!.endsWith('\n') ? '\n' : ''}`, line: lines.join('\n') });
  }
  return out;
}

export function pinPrBody(app: string, pins: { label: string; why: string }[], changes: FileChange[], auto: boolean): string {
  const what = pins.map((p) => `${p.label} (${p.why})`).join(' and ');
  return [
    `Unit7 builds ${app} with ${what}. Writing it into the repo means every build, and every computer, uses the same version, so a newer one that works differently can’t slip into a build.`,
    '',
    'What changes:',
    ...changes.flatMap((c) => c.line.split('\n')).map((l) => `- ${l}`),
    '',
    'Nothing else changes. On your own computer, `corepack enable` (or nvm) picks it up.',
    '',
    auto ? 'Unit7 merges this by itself once its checks pass.' : 'Merge it when you’re ready, or tap Merge in Unit7 once its checks pass.',
  ].join('\n');
}

// pnpm's settings out of package.json's "pnpm" field into pnpm-workspace.yaml (pnpm 11 reads them only there: src/deploy/pins.ts
// movePnpmSettings), on top of whatever the pins changed in package.json
export function settingsChanges(files: Partial<Record<string, string>>, major: number, after: FileChange[] = []): FileChange[] {
  const pkg = after.find((c) => c.path === 'package.json');
  const m = movePnpmSettings(pkg?.content ?? files['package.json'], files['pnpm-workspace.yaml'], major);
  if (!m) return [];
  const moved = `${m.keys.join(', ')} from package.json’s "pnpm" field`;
  return [
    { path: 'package.json', content: m.pkg, line: `${pkg ? `${pkg.line}\n` : ''}package.json: removed ${moved}` },
    { path: 'pnpm-workspace.yaml', content: m.yaml, line: `pnpm-workspace.yaml: ${major >= 11 && m.keys.some((k) => /BuiltDependencies$/.test(k)) ? 'allowBuilds (pnpm 11’s name for onlyBuiltDependencies) and ' : ''}${m.keys.filter((k) => !/BuiltDependencies$/.test(k)).join(', ') || 'the build settings'}` },
  ];
}
export function settingsPrBody(app: string, changes: FileChange[], auto: boolean): string {
  return [
    `pnpm 11 no longer reads the "pnpm" field in package.json, so ${app}’s settings there are ignored (pnpm.io/package_json: settings must be defined in pnpm-workspace.yaml instead). Unit7 has been putting them in pnpm-workspace.yaml for each build; this moves them there for good, so every build and every computer uses them.`,
    '',
    'What changes:',
    ...changes.flatMap((c) => c.line.split('\n')).map((l) => `- ${l}`),
    '',
    'Nothing else changes. pnpm 10.5 and newer read the same settings from pnpm-workspace.yaml.',
    '',
    auto ? 'Unit7 merges this by itself once its checks pass.' : 'Merge it when you’re ready, or tap Merge in Unit7 once its checks pass.',
  ].join('\n');
}

const reason = (p: Pin | undefined, tool: Tool) => (!p ? 'what Unit7 builds with' : p.source === 'lockfile' ? `your lockfile was made with it, but the repo doesn’t say which ${NAMES[tool]} to use`
  : p.source === 'unit7' ? 'it fixed a failed build' : p.source === 'you' ? 'you picked it' : `the repo doesn’t say which ${NAMES[tool]} to use`);

export async function openPinPr(ctx: Ctx, serviceId: string, specs?: string[], moveSettings?: boolean) {
  const a = appOf(ctx, serviceId);
  const src = a.cfg.source;
  const repo = src?.type === 'git' ? parseRepo(src.repo) : undefined;
  if (!repo || src?.type !== 'git') throw new Unit7Error('unsupported', `${a.name} isn’t deployed from GitHub, so there’s no repo to pin the versions in.`, 400);
  const token = await githubToken(ctx, src.accountId);
  if (!token) throw new Unit7Error('no_account', 'Connect GitHub (with write access to this repo) so Unit7 can open the pull request.', 409);
  ctx.redactor.add(token, 'GitHub token');
  if (a.cfg.pinPr && (await pullCheck(repo, a.cfg.pinPr.number, token).then((p) => p.open, () => false))) return { already: a.cfg.pinPr.url };
  const pins = a.cfg.detection?.pins;
  const wanted = (specs?.length || moveSettings ? specs ?? [] : unpinned(pins).map(specOf)).filter((s) => PIN_SPEC.test(s));
  if (moveSettings) return openSettingsPr(ctx, a, repo, src, token, wanted);
  if (!wanted.length) return { nothingToDo: `${a.name}’s repo already says which versions to build with.` };
  const base = src.branch || await defaultBranch(repo, token);
  ctx.progress('Looking up the exact versions…');
  const exact = await Promise.all(wanted.map(async (s) => { const p = parsePin(s)!; return { tool: p.tool, version: await exactVersion(s), spec: s }; }));
  const files: Record<string, string | undefined> = {};
  for (const f of ['package.json', '.nvmrc', '.node-version', '.python-version', '.ruby-version']) files[f] = await repoFile(repo, f, base, token);
  const changes = pinChanges(files, exact);
  if (!changes.length) return { nothingToDo: `${a.name}’s repo already says ${exact.map((p) => `${NAMES[p.tool]} ${p.version}`).join(' and ')}.` };
  const labels = exact.map((p) => `${NAMES[p.tool]} ${p.version}`);
  const branch = `unit7/pin-${exact.map((p) => `${p.tool}-${p.version.split('.')[0]}`).join('-')}-${now().slice(0, 10)}`;
  const autonomy = get<{ autonomy: number }>(ctx.db, 'SELECT autonomy FROM environments WHERE id = ?', a.environment_id)?.autonomy ?? 2;
  const auto = autonomy >= 3; // Fix itself and Autopilot merge it once green; below that a person taps Merge
  ctx.progress(`Opening a pull request that pins ${labels.join(' and ')}…`);
  await commitFiles(repo, { base, branch, message: `Pin ${labels.join(' and ')}`, files: changes.map(({ path, content }) => ({ path, content })) }, token);
  const body = pinPrBody(a.name, exact.map((p) => ({ label: `${NAMES[p.tool]} ${p.version}`, why: reason(pins?.[slotOf(p.tool)], p.tool) })), changes, auto);
  const pr = await openPull(repo, { title: `Pin ${labels.join(' and ')}`, head: branch, base, body }, token);
  // until it's merged, Unit7 keeps building with them
  const pinned = [...(a.cfg.pinned ?? []).filter((s) => { const q = parsePin(s); return !q || !wanted.some((w) => slotOf(parsePin(w)!.tool) === slotOf(q.tool)); }), ...wanted];
  save(ctx, a.id, { pinned, pinPr: { number: pr.number, url: pr.html_url, branch, at: now(), auto, pins: wanted } });
  ctx.emit('deployment.pin_pr', `${a.name}: opened a pull request pinning ${labels.join(' and ')} (${pr.html_url})`, { severity: 'success', resource: a.id });
  return { pr: pr.html_url, branch, changes: changes.flatMap((c) => c.line.split('\n')), merge: auto ? 'Unit7 merges it by itself once its checks pass.' : 'One tap merges it once its checks pass.' };
}

// the "Move them for me" pull request: pnpm's settings into pnpm-workspace.yaml (with any pins asked for alongside)
async function openSettingsPr(ctx: Ctx, a: ReturnType<typeof appOf>, repo: NonNullable<ReturnType<typeof parseRepo>>, src: { branch?: string }, token: string, wanted: string[]) {
  const major = pnpmMajor(a.cfg.detection?.pins?.pm);
  const base = src.branch || await defaultBranch(repo, token);
  const exact = await Promise.all(wanted.map(async (s) => { const p = parsePin(s)!; return { tool: p.tool, version: await exactVersion(s) }; }));
  const files: Record<string, string | undefined> = {};
  for (const f of ['package.json', 'pnpm-workspace.yaml', '.nvmrc', '.node-version', '.python-version', '.ruby-version']) files[f] = await repoFile(repo, f, base, token);
  const pinned = pinChanges(files, exact);
  const moved = settingsChanges(files, Number.isNaN(major) ? 11 : major, pinned);
  if (!moved.length) return { nothingToDo: `${a.name}’s package.json has no pnpm settings left to move.` };
  const changes = [...pinned.filter((c) => c.path !== 'package.json'), ...moved];
  const autonomy = get<{ autonomy: number }>(ctx.db, 'SELECT autonomy FROM environments WHERE id = ?', a.environment_id)?.autonomy ?? 2;
  const auto = autonomy >= 3;
  const title = 'Move pnpm settings into pnpm-workspace.yaml';
  const branch = `unit7/pnpm-settings-${now().slice(0, 10)}`;
  ctx.progress('Opening a pull request that moves pnpm’s settings…');
  await commitFiles(repo, { base, branch, message: title, files: changes.map(({ path, content }) => ({ path, content })) }, token);
  const pr = await openPull(repo, { title, head: branch, base, body: settingsPrBody(a.name, changes, auto) }, token);
  save(ctx, a.id, { pinPr: { number: pr.number, url: pr.html_url, branch, at: now(), auto, pins: wanted } });
  ctx.emit('deployment.pin_pr', `${a.name}: opened a pull request moving its pnpm settings into pnpm-workspace.yaml (${pr.html_url})`, { severity: 'success', resource: a.id });
  return { pr: pr.html_url, branch, changes: changes.flatMap((c) => c.line.split('\n')), merge: auto ? 'Unit7 merges it by itself once its checks pass.' : 'One tap merges it once its checks pass.' };
}

// merged once its checks (Unit7's preview among them) are green
export async function mergePinPr(ctx: Ctx, serviceId: string) {
  const a = appOf(ctx, serviceId);
  const src = a.cfg.source, repo = src?.type === 'git' ? parseRepo(src.repo) : undefined;
  if (!repo || !a.cfg.pinPr) return { nothing: 'No pin pull request is open.' };
  const token = await githubToken(ctx, src!.type === 'git' ? src!.accountId : undefined);
  if (!token) throw new Unit7Error('no_account', 'Connect GitHub so Unit7 can merge it.', 409);
  const p = await pullCheck(repo, a.cfg.pinPr.number, token);
  if (!p.open) { run(ctx.db, `UPDATE services SET config = json_remove(config, '$.pinPr') WHERE id = ?`, a.id); return { closed: true, merged: p.merged }; }
  if (p.status !== 'success') return { waiting: `checks are ${p.status}` };
  await mergePull(repo, a.cfg.pinPr.number, token);
  ctx.emit('deployment.pin_merged', `${a.name}: merged the pull request pinning its build tools (${a.cfg.pinPr.url})`, { severity: 'success', resource: a.id });
  run(ctx.db, `UPDATE services SET config = json_remove(config, '$.pinPr') WHERE id = ?`, a.id);
  return { merged: a.cfg.pinPr.url };
}

defineTool({
  name: 'deployment.pin_pr', title: 'Pin the build tools in the repo', risk: 'write', action: 'deploy', timeoutMs: 90_000,
  description: 'Open a pull request that writes the versions Unit7 builds an app with into its GitHub repo ("packageManager": "pnpm@10.x.y" at the newest 10.x, engines.node, .python-version, .ruby-version, rust-toolchain.toml), so every build and every computer uses them. pins: like ["pnpm@10", "node@20"]; by default the ones the repo doesn’t say itself. Never pushes to the main branch. Unit7 merges it once its checks pass when the app’s autonomy is Fix itself or above; otherwise a person taps Merge.',
  input: z.object({ serviceId: fid('svc'), pins: z.array(z.string().regex(PIN_SPEC, 'like pnpm@10 or node@20')).min(1).max(4).optional(),
    moveSettings: z.boolean().optional().describe('Move pnpm’s settings out of package.json’s "pnpm" field into pnpm-workspace.yaml (pnpm 11 reads them only there)') }),
  run: (ctx, i) => openPinPr(ctx, i.serviceId, i.pins, i.moveSettings),
});

defineTool({
  name: 'deployment.merge_pin', title: 'Merge the pin pull request', risk: 'write', action: 'deploy', timeoutMs: 60_000,
  description: 'Merge the open pull request that pins an app’s build tools, once its checks are green; push-to-deploy then ships it. Warden does this by itself where the app’s autonomy allowed it when the pull request was opened.',
  input: z.object({ serviceId: fid('svc') }),
  run(ctx, i) {
    if (isAgent(ctx) && !appOf(ctx, i.serviceId).cfg.pinPr?.auto) throw forbidden('This app’s autonomy is below Fix itself, so a person merges this one.');
    return mergePinPr(ctx, i.serviceId);
  },
});
