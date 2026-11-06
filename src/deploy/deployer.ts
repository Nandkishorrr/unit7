// A deployment, start to finish: get the source onto the server, build an image, start the new
// container beside the old one, prove it healthy from inside the private network, switch Caddy,
// then stop (not remove) the old one so rollback is instant. A failed health check tears down the
// new container and leaves the old one serving — users never see a bad deploy.
import type { Ctx } from '../tools/runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { cmd, script, shq, safeName } from '../connectors/shell.ts';
import { ensureBase, serverRow } from '../tools/servers.ts';
import { resolveValues, merged, isPublicKey } from '../tools/env.ts';
import { detect, destructiveLine, type Detection, type RepoFacts } from '../connectors/detect.ts';
import { dockerfileFor } from './dockerfiles.ts';
import { githubAuthHeader, githubBase, githubToken } from '../connectors/github.ts';
import { scanSecrets, scanDeployment, findManagedLeaks } from './security.ts';
import { putSite, pointsHere, proxyFor, type Site } from './caddy.ts';
import { backupBeforeChange } from '../tools/backups.ts';
import * as rel from './release.ts';
import type { Summary } from '../sentinel/traffic.ts';
import { checkRelease, withLockLimits, lockHint } from './migcheck.ts'; // ZD-SAFE Z4: the Database step
import { testGate } from './testgate.ts';                              // ZD-SAFE Z6: the Test step
import { withPins, buildNote, label, PIN_FILES, pnpmShim } from './pins.ts'; // the toolchain the project implies, never "the newest"
import { DATA_TRAITS, appVolumes, filesWords, prepareVolumes, previousWrites, volumeArgs, type AppVolume } from './volumes.ts'; // files the app keeps
import { DOCKERFILE_REV } from './dockerfiles.ts';

export interface ServiceRow {
  id: string; org_id: string; project_id: string; environment_id: string; server_id: string | null;
  name: string; slug: string; kind: string; config: string; status: string; current_deployment_id: string | null;
}
export interface ServiceConfig {
  detection?: Detection; port?: number; buildCommand?: string; startCommand?: string; healthPath?: string;
  memoryMb?: number; replicas?: number; source?: Source; staticDir?: string; cacheStatic?: string;
  nodeVersion?: number; nodeOptions?: string; // overrides (set by you or by self-heal)
  pinned?: string[];                           // toolchain pins Unit7 remembered for this app ("pnpm@10"), src/deploy/pins.ts
  pinnedByYou?: string[];                      // ...and a person's, which win over the repo's own until the repo says the same
  autoDeploy?: boolean; previews?: boolean;    // GitHub sources: deploy each new commit / a URL per PR (both on by default)
  release?: rel.ReleaseSettings;               // how a new version takes over (drain, watch, rollback by itself): safe defaults
  runTests?: boolean; testTimeoutMin?: number; // the test gate: on when the code has tests (off only by a person), 10 min
  dataDirs?: string[];                         // folders self-heal found the app keeps files in (src/deploy/volumes.ts)
  volumes?: AppVolume[];                       // the app's saved files: named volumes kept between deploys, never dropped
}
export type Source =
  | { type: 'git'; repo: string; branch?: string; accountId?: string }
  | { type: 'upload'; uploadId: string }
  | { type: 'image'; image: string };

const containerName = (svc: ServiceRow, n: number | 'live') => `unit7-${svc.slug}-${svc.environment_id.slice(-6)}-${n}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
// how other apps on the same server reach this one, whatever the deploy number
export const internalHost = (svc: { slug: string; environment_id: string }) => `unit7-${svc.slug}-${svc.environment_id.slice(-6)}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');

// copy 1 is the deployment's own container; copies 2..n sit beside it as <name>-r2, <name>-r3…
export const MAX_REPLICAS = 4;
export const replicaNames = (primary: string, replicas = 1) => Array.from({ length: Math.min(MAX_REPLICAS, Math.max(1, replicas)) - 1 }, (_, k) => `${primary}-r${k + 2}`);
const allCopies = (primary: string) => [primary, ...replicaNames(primary, MAX_REPLICAS)];

// Point every domain of a service at its live copies (used after deploy, rollback, scale, new domain).
// `at` is the version's own port and health path (a rollback target may differ from today's config).
export async function routeService(ctx: Ctx, s: ServerRow, svc: ServiceRow, primary: string, replicas: string[], only?: { hostname: string; tls: Site['tls'] }, at?: { port: number; healthPath: string }) {
  const cfg = json<ServiceConfig>(svc.config, {});
  const port = at?.port ?? (cfg.detection?.builder === 'static' ? 80 : cfg.port ?? 3000);
  const healthPath = at?.healthPath ?? cfg.healthPath ?? cfg.detection?.healthPath ?? '/';
  const domains = only ? [{ hostname: only.hostname, tls_mode: only.tls }] : ctx.db.prepare('SELECT hostname, tls_mode FROM domains WHERE service_id = ? AND org_id = ?').all(svc.id, ctx.orgId) as { hostname: string; tls_mode: string }[];
  for (const d of domains) await putSite(ctx.app, s, { hostname: d.hostname, upstream: primary, replicas, port, healthPath, cacheStatic: cfg.cacheStatic, tls: d.tls_mode as Site['tls'] });
  return domains.length;
}
const APPS = '/var/lib/unit7/apps';

// --- getting the source onto the server -------------------------------------------------------

async function fetchSource(ctx: Ctx, s: ServerRow, svc: ServiceRow, src: Source, dir: string, log: (m: string) => void, commit?: string): Promise<string | undefined> {
  const pool = ssh(ctx.app);
  await pool.check(s, script('rm -rf "$1" && mkdir -p "$1"', dir), { what: 'Preparing the build directory' });
  if (src.type === 'git') {
    if (commit && !/^[0-9a-f]{40}$/.test(commit)) throw new Unit7Error('bad_commit', 'That commit is not a full git commit id.');
    log(`Cloning ${src.repo}${src.branch ? ` (${src.branch})` : ''}${commit ? ` at ${commit.slice(0, 7)}` : ''}…`);
    let url = src.repo;
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}.git`;
    // Private repos: the service's GitHub token as an auth header for GitHub only, read from stdin into
    // git's environment. Never in the URL: git saves that in .git/config, and `COPY . .` ships it in the image.
    const token = await githubToken(ctx, src.accountId);
    if (token) ctx.redactor.add(token, 'github token');
    // a pinned commit ($5) is fetched on its own after the shallow clone
    const r = await pool.exec(s, script('IFS= read -r H; [ -n "$H" ] && export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.$4.extraheader" GIT_CONFIG_VALUE_0="$H"; cd "$1" && git clone --depth 1 ${3:+--branch "$3"} "$2" . 2>&1 && { [ -z "$5" ] || { git fetch -q --depth 1 origin "$5" 2>&1 && git checkout -q "$5" 2>&1; }; } && echo "UNIT7_SHA=$(git rev-parse HEAD)"', dir, url, src.branch ?? '', `${githubBase()}/`, ...(commit ? [commit] : [])),
      { timeoutMs: 180_000, stdin: `${token ? githubAuthHeader(token) : ''}\n` });
    if (r.code !== 0) throw new Unit7Error('clone_failed', `Couldn't clone the repository: ${ctx.redactor.redact(r.stdout.trim().slice(-400))}`);
    const sha = /UNIT7_SHA=([0-9a-f]{40})/.exec(r.stdout)?.[1];
    if (sha) log(`Commit ${sha.slice(0, 7)}.`);
    return sha;
  } else if (src.type === 'upload') {
    const up = get<{ path: string }>(ctx.db, 'SELECT path FROM uploads WHERE id = ? AND org_id = ?', src.uploadId, ctx.orgId);
    if (!up) throw new Unit7Error('not_found', 'That upload was not found.', 404);
    const { createReadStream } = await import('node:fs');
    log('Uploading your code to the server…');
    await pool.check(s, script('tar -xz -C "$1"', dir), { what: 'Unpacking the upload', stdin: createReadStream(up.path), timeoutMs: 180_000 });
  } else {
    throw new Unit7Error('bad_source', 'Image sources skip the build; call startContainer directly.');
  }
}

// The release notes: commit messages since the commit that's live (one line each, at most 10), or this commit's own.
// A shallow clone has no history, so it's deepened first (with the same GitHub header as the clone, read from stdin).
async function commitNotes(ctx: Ctx, s: ServerRow, src: Source, dir: string, since?: string): Promise<string[]> {
  if (src.type !== 'git') return [];
  const token = await githubToken(ctx, src.accountId).catch(() => undefined);
  const r = await ssh(ctx.app).exec(s, script('IFS= read -r H; [ -n "$H" ] && export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.$3.extraheader" GIT_CONFIG_VALUE_0="$H"; cd "$1" || exit 0; if [ -n "$2" ]; then git fetch -q --deepen 50 >/dev/null 2>&1; if git cat-file -e "$2^{commit}" 2>/dev/null; then git log --format=%s -n 10 "$2..HEAD"; exit 0; fi; fi; git log -1 --format=%s',
    dir, since && /^[0-9a-f]{40}$/.test(since) ? since : '', `${githubBase()}/`), { timeoutMs: 60_000, stdin: `${token ? githubAuthHeader(token) : ''}\n` }).catch(() => null);
  return (r?.stdout ?? '').split('\n').map((l) => ctx.redactor.redact(l.trim()).slice(0, 140)).filter(Boolean).slice(0, 10);
}

// The busiest pages the server's traffic checks saw, when every site in that check is this app's (otherwise they may
// be another app's pages)
function usualPaths(ctx: Ctx, serverId: string, hosts: string[]): string[] {
  if (!hosts.length) return [];
  const w = json<Partial<Summary>>(get<{ summary: string }>(ctx.db, 'SELECT summary FROM traffic_windows WHERE server_id = ? ORDER BY at DESC LIMIT 1', serverId)?.summary, {});
  if (!w.hosts?.length || !w.hosts.every((h) => hosts.includes(h.host))) return [];
  return (w.topPaths ?? []).filter((p) => !p.s5xx).map((p) => p.path);
}

// what to look for in the code (passed to grep as an argument, so no shell quoting is involved)
const TRAITS = String.raw`(express-session|cookie-session|connect-redis|RedisStore|connect-pg-simple|connect-mongo|socket\.io|from ['"]ws['"]|require\(['"]ws['"]\)|node-cron|@nestjs/schedule|APScheduler|diskStorage|multer\(\{ *dest|MEDIA_ROOT|better-sqlite3|file:\./|sqlite://|express-rate-limit|rate-limit-redis|['"${'`'}]/(health|healthz|api/health|up|status)['"${'`'}]|${DATA_TRAITS})`;

// read a shallow view of the repo so detect() can work, without running anything
async function readRepo(ctx: Ctx, s: ServerRow, dir: string): Promise<RepoFacts> {
  const pool = ssh(ctx.app);
  const listed = (await pool.exec(s, script('cd "$1" && find . -maxdepth 3 -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/.next/*" | head -400 | sed "s|^\\./||"', dir))).stdout.split('\n').filter(Boolean);
  // migration files sit deeper than the shallow listing (prisma/migrations/<ts>/migration.sql), and the
  // destructive-migration guard has to see every one of them
  const migrations = (await pool.exec(s, script('cd "$1" && find . -type d \\( -name node_modules -o -name .git \\) -prune -o -type f \\( -path "*/migrations/*" -o -path "*/db/migrate/*" -o -path "*/alembic/versions/*" -o -path "./drizzle/*" \\) -print | head -2000 | sed "s|^\\./||"', dir))).stdout.split('\n').filter(Boolean);
  const files = [...new Set([...listed, ...migrations])];
  const manifests: Record<string, string> = {};
  // root manifests first, so a monorepo's nested ones never crowd out the app's own
  const wanted = files.filter((f) => /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|composer\.json|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|\.nvmrc|\.node-version|Procfile|pnpm-workspace\.yaml)$/.test(f));
  for (const f of wanted.sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 20)) {
    manifests[f] = (await pool.exec(s, script('head -c 32768 "$1/$2"', dir, f))).stdout;
  }
  const envExample = (await pool.exec(s, script('cat "$1"/.env.example "$1"/.env.sample 2>/dev/null | head -c 8192', dir))).stdout || undefined;
  const sourceSample = (await pool.exec(s, script(`cd "$1" && grep -rhoE "(process\\.env\\.[A-Z0-9_]+|import\\.meta\\.env\\.[A-Z0-9_]+|os\\.environ[.[][^)]*|getenv\\([^)]*|env\\([^)]*)" --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx" --include="*.py" --include="*.php" --include="*.go" --include="*.env" -r . 2>/dev/null | head -400`, dir))).stdout || undefined;
  // runtime traits: health routes, sessions, sockets, cron, uploads, SQLite (decides if scaling is safe)
  const traits = (await pool.exec(s, script('cd "$1" && grep -rhoE -e "$2" --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx" --include="*.mjs" --include="*.py" --include="*.php" --include="*.go" -r . 2>/dev/null | sort -u | head -200', dir, TRAITS))).stdout || undefined;
  // the start of the lockfiles and toolchain files at the root: which versions the project implies (src/deploy/pins.ts)
  const heads = (await pool.exec(s, script('cd "$1" || exit 0; shift; for n in "$@"; do [ -f "$n" ] && { printf "@@unit7-file %s\\n" "$n"; head -c 2048 "$n"; printf "\\n"; }; done; true', dir, ...PIN_FILES))).stdout;
  const pinFiles: Record<string, string> = {};
  for (const b of heads.split(/^@@unit7-file /m).slice(1)) { const nl = b.indexOf('\n'); if (nl > 0 && PIN_FILES.includes(b.slice(0, nl))) pinFiles[b.slice(0, nl)] = b.slice(nl + 1); }
  return { files, manifests, envExample, sourceSample, traits, pinFiles };
}

// --- build -------------------------------------------------------------------------------------

// what docker says when --pull can't fetch a base image that exists only on the server
export const LOCAL_ONLY = /pull access denied|repository does not exist|not found: manifest unknown|manifest for \S+ not found|failed to resolve source metadata[^\n]*(not found|denied|unauthorized)/i;
async function buildImage(ctx: Ctx, s: ServerRow, svc: ServiceRow, d: Detection, dir: string, tag: string, envKeys: string[], buildArgs: Record<string, string>, log: (m: string) => void) {
  const pool = ssh(ctx.app);
  if (d.builder === 'dockerfile' && d.dockerfile) {
    log('Building from the repository’s Dockerfile…');
  } else {
    const df = dockerfileFor(d, envKeys);
    if (!df) throw new Unit7Error('no_builder', `Unit7 doesn't know how to build a ${d.stack} app yet. Add a Dockerfile to the repo.`);
    log(`Writing a Dockerfile for your ${d.stack} app…`);
    // on stdin, not in the script: a build command is the user's text and must never end up as shell
    await pool.check(s, script('cat > "$1/Dockerfile.unit7"', dir), { what: 'Writing the Dockerfile', stdin: df });
  }
  const dfName = d.builder === 'dockerfile' && d.dockerfile ? d.dockerfile.split('/').pop()! : 'Dockerfile.unit7';
  const dfDir = d.builder === 'dockerfile' && d.dockerfile && d.dockerfile.includes('/') ? `${dir}/${d.dockerfile.slice(0, d.dockerfile.lastIndexOf('/'))}` : dir;
  const args = Object.entries(buildArgs).filter(([k]) => envKeys.includes(k) && isPublicKey(k)).map(([k, v]) => `--build-arg ${shq(`${k}=${v}`)}`).join(' ');
  log('Building the image (this can take a few minutes)…');
  const build = (pull: boolean) => pool.exec(s, script(`cd "$1" && DOCKER_BUILDKIT=1 docker build ${pull ? '--pull ' : ''}-f "$2" -t "$3" --label unit7.service="$4" --label unit7.build=1 ${args} "$5" 2>&1`, dir, `${dfDir}/${dfName}`.replace(`${dir}/`, ''), tag, svc.id, '.'),
    { timeoutMs: 20 * 60_000, signal: ctx.signal, onData: (chunk) => { for (const line of chunk.split('\n')) if (line.trim()) log(ctx.redactor.redact(line.trim().slice(0, 200))); } });
  let r = await build(true);
  // a base image that only exists on this server (built or loaded here) can't be pulled: once more from the local copy
  if (r.code !== 0 && LOCAL_ONLY.test(r.stdout || r.stderr)) {
    log('The base image isn’t on any registry, only on this server, so Unit7 builds from the copy here (it can’t check for a newer one).');
    r = await build(false);
  }
  // the plain sentence is the message; the build's own output rides apart (detail.logTail: Show details on the web)
  if (r.code !== 0) throw new Unit7Error('build_failed', 'The build failed.', 400, { logTail: ctx.redactor.redact((r.stdout || r.stderr).trim().slice(-1500)) });
}

// --- run + health ------------------------------------------------------------------------------

// every container Unit7 starts keeps at most 3 × 10 MB of logs, set per container so Docker itself never restarts
export const LOG_OPTS = ['--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3'];
async function startContainer(ctx: Ctx, s: ServerRow, name: string, image: string, cfg: ServiceConfig, env: Record<string, string>, svc: ServiceRow) {
  const pool = ssh(ctx.app);
  safeName(name, 'container name');
  // env to a file on the server (0600), passed with --env-file, so values never sit in `docker inspect` args or the process list
  const envFile = `${APPS}/${name}.env`;
  await writeEnvFile(ctx, s, envFile, env);
  const mem = `${cfg.memoryMb ? `--memory ${cfg.memoryMb}m --memory-swap ${cfg.memoryMb}m` : ''} ${volumeArgs(cfg.volumes)}`.trim();
  // a stable private address for other apps on this server (container names change every deploy;
  // with several copies, Docker spreads requests across them)
  await pool.check(s, script(`docker rm -f "$1" >/dev/null 2>&1; docker run -d --name "$1" --restart unless-stopped --network unit7 --network-alias "$5" --env-file "$2" --label unit7.service="$4" ${LOG_OPTS.join(' ')} ${mem} "$3" >/dev/null`, name, envFile, image, svc.id, internalHost(svc)),
    { what: 'Starting the container', timeoutMs: 60_000 });
}

// env to a file on the server (0600), passed with --env-file, so values never sit in `docker inspect`
// args or the process list
export async function writeEnvFile(ctx: Ctx, s: ServerRow, file: string, env: Record<string, string>) {
  // docker's --env-file is one KEY=value per line: a line break would cut the value short and start
  // a bogus variable, and the container fails to start with nothing to show why
  const multiline = Object.keys(env).filter((k) => /[\r\n]/.test(env[k]!));
  if (multiline.length) throw new Unit7Error('multiline_env', `${multiline.join(', ')} ${multiline.length > 1 ? 'contain' : 'contains'} a line break, which an app's environment can't hold. Store ${multiline.length > 1 ? 'them' : 'it'} base64-encoded (e.g. ${multiline[0]}_B64) and decode in the app, or replace the line breaks with \\n.`, 400);
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
  await ssh(ctx.app).check(s, script(`umask 077 && cat > "$1"`, file), { what: 'Writing environment', stdin: body + '\n' });
}

// Every copy of a deployment and their env files, gone (an old version, a failed deploy, a removed app)
export async function removeCopies(ctx: Ctx, s: ServerRow, primary: string) {
  await ssh(ctx.app).exec(s, script(`docker rm -f "$@" >/dev/null 2>&1; for n in "$@"; do rm -f "${APPS}/$n.env"; done; true`, ...allCopies(safeName(primary, 'container name'))));
}

// Keep the newest few versions ready for rollback. Older ones lose their containers, image and env files
// (the disk fills up otherwise) and forget their container, so a rollback never picks one.
const KEEP_VERSIONS = 3;
async function pruneOld(ctx: Ctx, s: ServerRow, serviceId: string, log: (m: string) => void) {
  const old = all<{ id: string; container: string; image: string | null }>(ctx.db, 'SELECT id, container, image FROM deployments WHERE service_id = ? AND container IS NOT NULL ORDER BY number DESC LIMIT -1 OFFSET ?', serviceId, KEEP_VERSIONS);
  for (const d of old) {
    await removeCopies(ctx, s, d.container).catch(() => undefined);
    // only images Unit7 built; a pulled image (nginx:1.27) may be used by anything else on the server
    if (d.image?.startsWith('unit7/')) await ssh(ctx.app).exec(s, cmd('docker', 'rmi', d.image)).catch(() => undefined);
    run(ctx.db, 'UPDATE deployments SET container = NULL WHERE id = ?', d.id);
  }
  if (old.length) log(`Cleaned up ${old.length} old version${old.length > 1 ? 's' : ''}.`);
}

export interface HealthResult { healthy: boolean; detail: string }

// Health from INSIDE the unit7 network, the way Caddy will reach it. Two good answers in a row.
// A worker is healthy when it starts and stays up for a few seconds without a restart.
export async function stayUp(ctx: Ctx, s: ServerRow, name: string, log: (m: string) => void, seconds = 10): Promise<HealthResult> {
  log(`Checking ${name} keeps running…`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const [status, exitCode, restarts] = (await ssh(ctx.app).exec(s, cmd('docker', 'inspect', '-f', '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}', name))).stdout.trim().split(' ');
  if (status === 'running' && Number(restarts) === 0) { log('Worker is up.'); return { healthy: true, detail: 'running' }; }
  const logs = (await ssh(ctx.app).exec(s, script('docker logs --tail 60 "$1" 2>&1', name))).stdout;
  return { healthy: false, detail: `The worker ${Number(restarts) ? `keeps crashing (restarted ${restarts} times, exit ${exitCode})` : `stopped (exit ${exitCode})`}.\n${ctx.redactor.redact(logs.trim().slice(-2000))}` };
}

// o.timeoutMs: how long to wait (learned from the app's past starts); o.contains: text the page must contain
export async function healthCheck(ctx: Ctx, s: ServerRow, name: string, port: number, path: string, log: (m: string) => void, o: { timeoutMs?: number; contains?: string } = {}): Promise<HealthResult> {
  const pool = ssh(ctx.app);
  const url = `http://${name}:${port}${path}`;
  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  let streak = 0, last = '';
  log(`Checking ${name} is healthy at ${path}…`);
  // the app's own output, errors included (crash reasons go to stderr), with npm's banner collapsed
  const tail = async () => {
    const out = (await pool.exec(s, script('docker logs --tail 120 "$1" 2>&1', name))).stdout;
    return ctx.redactor.redact(out.split('\n').filter((l, i, a) => l.trim() && (i === 0 || l !== a[i - 1]) && !/^> (?:[\w@./-]+@[\w.-]+ start|node |npm )/.test(l.trim())).join('\n').slice(-2500));
  };
  while (Date.now() < deadline) {
    // is it even still running? An exit, or a crash loop under the restart policy, shows here
    const [status, exitCode, oom, restarts] = (await pool.exec(s, cmd('docker', 'inspect', '-f', '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.RestartCount}}', name))).stdout.trim().split(' ');
    if (status === 'exited' || status === 'dead' || Number(restarts) >= 3) {
      const why = oom === 'true' ? 'The container ran out of memory and was killed.' : Number(restarts) >= 3 ? `The app keeps crashing on start (restarted ${restarts} times, exit code ${exitCode}).` : `The container exited (exit code ${exitCode}).`;
      return { healthy: false, detail: `${why}\n${await tail()}` };
    }
    // curl from a throwaway container on the same network (the app image may not have curl)
    const probe = o.contains
      ? await pool.exec(s, script(`docker run --rm --network unit7 --entrypoint sh curlimages/curl:latest -c 'c=$(curl -s -o /tmp/b -w "%{http_code}" --max-time 5 "$1" 2>/dev/null) || c=000; if grep -qF -- "$2" /tmp/b 2>/dev/null; then echo "$c found"; else echo "$c missing"; fi' x "$1" "$2" 2>/dev/null || echo 000`, url, o.contains), { timeoutMs: 20_000 })
      : await pool.exec(s, script(`docker run --rm --network unit7 curlimages/curl:latest -s -o /dev/null -w "%{http_code}" --max-time 5 "$1" 2>/dev/null || echo 000`, url), { timeoutMs: 20_000 });
    const code = Number(o.contains ? /(\d{3})/.exec(probe.stdout)?.[1] : probe.stdout.trim().slice(-3)) || 0;
    const missing = !!o.contains && !/\d{3} found/.test(probe.stdout);
    const ok = rel.okCode(path, code) && !missing;
    if (ok) { if (++streak >= 2) { log(`Healthy (HTTP ${code}${o.contains ? ', and the page has the text it must contain' : ''}).`); return { healthy: true, detail: `HTTP ${code}` }; } }
    else { streak = 0; last = !code ? 'no response' : missing && rel.okCode(path, code) ? `HTTP ${code}, but the page doesn’t contain “${o.contains}”` : `HTTP ${code}`; }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { healthy: false, detail: `Never became healthy (last: ${last}).\n${await tail()}` };
}

// --- the deployment ----------------------------------------------------------------------------

// One deploy or rollback per app at a time (a push-to-deploy, a person and Warden can all start one). The next
// waits, then reads the app afresh: the one before it changed which version is live.
const running = new Map<string, Promise<unknown>>();
export function oneAtATime<T>(ctx: Ctx, svc: ServiceRow, work: (svc: ServiceRow) => Promise<T>): Promise<T> {
  const before = running.get(svc.id) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(() => work(get<ServiceRow>(ctx.db, 'SELECT * FROM services WHERE id = ?', svc.id) ?? svc));
  running.set(svc.id, mine);
  const done = () => { if (running.get(svc.id) === mine) running.delete(svc.id); };
  mine.then(done, done);
  return mine;
}

// commit: build exactly this commit of a git source instead of the branch head
type DeployOptions = { source?: Source; triggeredBy?: string; rollbackOf?: string; allowDestructiveMigration?: boolean; commit?: string;
  allowRiskyMigration?: boolean; skipTests?: boolean; // ZD-SAFE: a person's "Go ahead anyway" / "Deploy anyway"
  pin?: string };                                      // a toolchain picked for this build only ("pnpm@10"), src/deploy/pins.ts
type DeployResult = { deploymentId: string; number: number; status: string; url?: string; migrated?: string[]; previousDeploymentId?: string; watching?: string; proof?: rel.Proof };
export const deploy = (ctx: Ctx, svc: ServiceRow, o: DeployOptions = {}): Promise<DeployResult> => oneAtATime(ctx, svc, (fresh) => deployNow(ctx, fresh, o));

async function deployNow(ctx: Ctx, svc: ServiceRow, o: DeployOptions): Promise<DeployResult> {
  const s = svc.server_id ? serverRow(ctx, svc.server_id) : undefined;
  if (!s) throw new Unit7Error('no_server', `${svc.name} isn't assigned to a server yet.`);
  if (s.status !== 'ready') throw new Unit7Error('server_not_ready', `${s.name} isn't prepared yet. Run server.bootstrap first.`);
  await ensureBase(ctx, s);
  const cfg = json<ServiceConfig>(svc.config, {});
  const src = o.source ?? cfg.source;
  if (!src) throw new Unit7Error('no_source', `${svc.name} has no source. Give a git repo, an uploaded folder, or an image.`);
  // FLEET D3: a canary (src/fleet/canary.ts) starts this deploy ('starting'): the old version keeps the rest of the visitors
  // by weight (putSite reads the split), so it isn't drained or stopped, and the canary compares the two instead of the
  // watch. A canary already going: promote or roll it back first.
  const canary = get<{ status: string; share: number }>(ctx.db, `SELECT status, share FROM canaries WHERE service_id = ? AND status IN ('starting', 'running', 'held') ORDER BY created_at DESC LIMIT 1`, svc.id);
  if (canary && canary.status !== 'starting') throw new Unit7Error('canary_running', `${svc.name} is trying a new version on some of its visitors. Promote it or roll it back first.`, 409);

  const number = (get<{ n: number | null }>(ctx.db, 'SELECT max(number) n FROM deployments WHERE service_id = ?', svc.id)?.n ?? 0) + 1;
  const deploymentId = id('dep');
  const logLines: string[] = [];
  const log = (m: string) => { logLines.push(`${new Date().toISOString().slice(11, 19)} ${m}`); ctx.progress(m); run(ctx.db, 'UPDATE deployments SET log = ? WHERE id = ?', logLines.join('\n'), deploymentId); };
  run(ctx.db, `INSERT INTO deployments (id, org_id, service_id, number, status, source, triggered_by, rollback_of) VALUES (?, ?, ?, ?, 'building', ?, ?, ?)`,
    deploymentId, ctx.orgId, svc.id, number, JSON.stringify(redactSource(src)), o.triggeredBy ?? ctx.actor.name, o.rollbackOf ?? null);
  run(ctx.db, `UPDATE services SET status = 'deploying' WHERE id = ?`, svc.id);
  ctx.resources.push(deploymentId);
  ctx.emit('deployment.started', `Deploy #${number} of ${svc.name} started`, { resource: svc.id, data: { deploymentId, number } });
  // the release timeline (Build → … → Done), in the plan and live to the UI
  const steps = rel.stepper((list) => {
    run(ctx.db, `UPDATE deployments SET plan = json_set(plan, '$.steps', json(?)) WHERE id = ?`, JSON.stringify(list), deploymentId);
    ctx.app.events.emit(ctx.orgId, 'deployment.step', list.at(-1)?.note ?? list.at(-1)?.key ?? '', { live: true, projectId: svc.project_id, resource: svc.id, data: { deploymentId, serviceId: svc.id, number, steps: list } });
  }, () => logLines.length);
  // a newer deploy ends the watch on the one before
  rel.stopWatch(ctx.app, svc.id, 'a newer deploy started');
  steps.go('build');

  const pool = ssh(ctx.app);
  const dir = `${APPS}/${svc.slug}-build-${deploymentId.slice(-6)}`;
  const newName = containerName(svc, number);
  // whatever is serving now, built or pulled (an image source has no detection, but still a live container)
  const previousLive = get<{ container: string | null }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.container ?? undefined;
  // what the catch below has to undo: a started container, and domains already pointed at it
  let started = false, live = false;
  const switched: { hostname: string; tls: Site['tls'] }[] = [];
  let switchCheck: { name: string; t0?: number } | undefined; // Unit7's own requests through the proxy while traffic moves
  let vols: AppVolume[] = cfg.volumes ?? []; // the app's saved files (src/deploy/volumes.ts): every volume it had, plus new ones

  // logTail: the log behind it (build or container output), kept apart from the plain message; the deployment's record keeps both
  const fail = (code: string, message: string, logTail?: string) => {
    run(ctx.db, `UPDATE deployments SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, logTail ? `${message}\n${logTail}` : message, new Date().toISOString(), deploymentId);
    run(ctx.db, `UPDATE services SET status = ? WHERE id = ?`, previousLive ? 'healthy' : 'failed', svc.id);
    ctx.emit('deployment.failed', `Deploy #${number} of ${svc.name} failed: ${message.split('\n')[0]}`, { severity: 'warning', resource: svc.id, data: { deploymentId, number } });
    return new Unit7Error(code, message, 502, logTail ? { logTail } : undefined);
  };

  try {
    let image: string;
    let detection = cfg.detection;
    let port = cfg.port ?? 3000;
    if (src.type === 'image') {
      image = src.image;
      safeName(image.split(':')[0]!.split('/').pop()!, 'image');
      log(`Using image ${image}.`);
      await pool.check(s, cmd('docker', 'pull', image), { what: 'Pulling the image', timeoutMs: 300_000 });
    } else {
      const commit = await fetchSource(ctx, s, svc, src, dir, log, o.commit);
      if (commit) run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ commit }), deploymentId);
      // release notes: the commit messages since the version that's live (or this commit's own)
      const notes = await commitNotes(ctx, s, src, dir, json<{ commit?: string }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.plan, {}).commit);
      if (notes.length) run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ commits: notes }), deploymentId);
      // a real credential in the code would ship with the image: stop here
      const leaks = await scanSecrets(ctx, s, dir, log);
      if (leaks?.block.length) {
        throw fail('secrets_in_code', `Unit7 stopped this deploy: real credentials are written in the code, and they would ship with it.\n${leaks.block.slice(0, 6).map((l) => `${l.file}:${l.line} (${l.rule})`).join('\n')}\nMove them into this project's variables in Unit7 (encrypted), remove them from the code, and rotate them: anything committed should be treated as exposed. A false alarm? Add its fingerprint to .gitleaksignore.`);
      }
      // a value Unit7 manages for this app, copied into the code: stop, and have it changed (it should be treated as exposed)
      const secretVars = merged(ctx.db, ctx.orgId, { type: 'service', id: svc.id, label: '' }).filter((r) => r.secret);
      if (secretVars.length) {
        const values = resolveValues(ctx, svc.id);
        const hits = await findManagedLeaks(ctx, s, dir, secretVars.map((r) => values[r.key] ?? ''));
        if (hits.length) {
          const keys = hits.map((i) => secretVars[i]!.key);
          ctx.emit('secret.leaked', `${svc.name}'s code contains ${keys.join(', ')}. Unit7 stopped the deploy and is changing ${keys.length > 1 ? 'them' : 'it'}.`, { severity: 'critical', resource: svc.id, data: { keys, serviceId: svc.id } });
          throw fail('secrets_in_code', `Unit7 stopped this deploy: the code contains ${keys.join(', ')}, which Unit7 keeps for this app. Anything committed should be treated as exposed, so Unit7 is changing ${keys.length > 1 ? 'them' : 'it'} now. Remove ${keys.length > 1 ? 'them' : 'it'} from the code (read process.env instead), then deploy again.`);
        }
      }
      const repo = await readRepo(ctx, s, dir);
      // read the code fresh every time (new deps, a new database), keeping only real overrides
      detection = withPins(withOverrides(detect(repo), cfg), repo, cfg, o.pin);
      // the folders it keeps files in, each in a volume: from the code, what the version before wrote inside its container,
      // self-heal, and every volume it had (only where Unit7 writes the Dockerfile, so the app's folder is known: /app)
      if (detection.builder === 'railpack' && (detection.runtime === 'node' || detection.runtime === 'python')) {
        const dirs = [...(detection.dataDirs ?? []), ...(cfg.dataDirs ?? []), ...vols.map((v) => v.path.replace(/^\/app\//, '')), ...(await previousWrites(ctx, s, previousLive))];
        detection = { ...detection, dataDirs: [...new Set(dirs)].sort() };
        vols = [...vols, ...appVolumes(internalHost(svc), detection.dataDirs!).filter((v) => !vols.some((x) => x.name === v.name))];
      }
      // pnpm 11 no longer reads package.json's "pnpm" settings: the build gets them in pnpm-workspace.yaml (src/deploy/pins.ts)
      const shim = detection.builder !== 'dockerfile' ? pnpmShim(repo, detection.pins) : undefined;
      if (shim) {
        await pool.check(s, script('cat > "$1/pnpm-workspace.yaml"', dir), { what: 'Writing pnpm’s settings', stdin: shim.yaml });
        log(`pnpm ${detection.pins!.pm!.version} no longer reads ${shim.keys.join(', ')} from package.json, so Unit7 put ${shim.keys.length > 1 ? 'them' : 'it'} in pnpm-workspace.yaml for this build.`);
      }
      run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ dockerfileRev: detection.builder === 'dockerfile' ? null : DOCKERFILE_REV, ...(shim && { pnpmSettings: shim.keys }) }), deploymentId);
      // kept on the deployment even if the build fails, so self-heal knows what the code needs
      run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ stack: detection.stack, builder: detection.builder, port: cfg.port ?? detection.port, needs: detection.needs, envKeys: detection.envKeys, nodeVersion: detection.nodeVersion, pins: detection.pins }), deploymentId);
      // which toolchain, and why, on the Build step ("Used pnpm 10 because your lockfile says so")
      const pinNote = buildNote(detection.pins);
      if (pinNote) { steps.note(pinNote); log(`${pinNote}.`); }
      port = cfg.port ?? detection.port;
      if (detection.startCommand) log(`Detected ${detection.stack}. Port ${port}.`);
      rememberProfile(ctx, svc, detection);
      // build-time public env (NEXT_PUBLIC_*, VITE_*) baked in; secrets never go in as build args (`ps`, image history)
      const allEnv = resolveValues(ctx, svc.id);
      image = `unit7/${svc.slug}:${number}`.toLowerCase();
      await buildImage(ctx, s, svc, detection, dir, image, detection.envKeys, allEnv, log);
      run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ port, migrations: detection.migrations ?? [] }), deploymentId);
      steps.go('test', 'Running the app’s own tests'); // ZD-CORE: the timeline's Test step (its result below, from plan.tests)
      // ZD-SAFE (Z6) the Test step: the app's own tests, from this image, before anything changes (plan.tests)
      const tests = await testGate(ctx, s, { serviceId: svc.id, cfg, repo, detection, dir, image, deploymentId, skip: o.skipTests, log });
      if (tests.stop) throw fail('tests_failed', tests.stop);
    }
    run(ctx.db, `UPDATE deployments SET status = 'deploying', image = ? WHERE id = ?`, image, deploymentId);
    // the app's saved files: each volume made (from what the version before had written there) and owned by the app's user
    if (vols.length && src.type !== 'image') {
      const seeded = await prepareVolumes(ctx, s, { image, service: svc.id, previous: previousLive, vols });
      log(`${filesWords(vols, 'daily')}.${seeded.length ? ` Copied what the previous version had in ${seeded.join(', ')}.` : ''}`);
    }
    // the Test step's result, from the test gate's record (plan.tests); an image has no code to test
    const tested = json<{ tests?: { status: string; label?: string; ms?: number } }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', deploymentId)?.plan, {}).tests;
    if (steps.current() === 'test') {
      if (tested?.status === 'passed') steps.done(`${tested.label ?? 'The tests'} passed`);
      else steps.done(tested?.status === 'off' ? 'Tests are turned off for this app' : tested?.status === 'skipped' ? 'A person chose to deploy without the tests' : 'No tests found in the code', 'skipped');
    } else if (!steps.steps.some((x) => x.key === 'test')) steps.skip('test', 'An image has no code to test');

    // static sites serve on 80 inside the caddy image we build for them
    if (detection?.builder === 'static') port = 80;
    const runtimeEnv = resolveValues(ctx, svc.id);
    runtimeEnv.PORT ??= String(port);

    // release step: database migrations run once, from the new image, before any traffic moves
    let migrated: string[] | undefined;
    if (detection?.migrate) steps.go('database', 'Checking and making the database changes'); else steps.skip('database', 'No database changes');
    if (detection?.migrate) {
      const before = previousLive ? json<{ migrations?: string[] }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.plan ?? '{}', {}).migrations ?? [] : [];
      const pending = (detection.migrations ?? []).filter((m) => !before.includes(m));
      // ZD-SAFE (Z4) the Database step: each pending change checked against the version still serving (plan.dbCheck).
      // A migration that loses data waits for a person, every time; one that breaks the old version waits for a person's choice.
      const dbStep = await checkRelease(ctx, s, { dir, pending, previousLive, deploymentId, log, allowRisky: o.allowRiskyMigration, allowDestructive: o.allowDestructiveMigration });
      if (dbStep.destructive) {
        const { file: f, line: bad } = dbStep.destructive;
        throw fail('migration_needs_ok', `The new version's migration removes data, so Unit7 stopped before running it. The old version is still serving.\n${f}: ${bad}\nTo go ahead, deploy again with "allow destructive migration" (Unit7 backs up the database first).`);
      }
      if (dbStep.paused) throw fail('migration_risky', dbStep.paused);
      if (pending.length || !(detection.migrations ?? []).length) {
        for (const d of all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM services WHERE environment_id = ? AND kind IN ('postgres','mysql','mariadb','mongo')`, svc.environment_id)) {
          log(`Backing up ${d.name} before migrating…`);
          await backupBeforeChange(ctx, d.id, `migrating ${svc.name} (deploy #${number})`);
        }
      }
      log(`Running database migrations${pending.length ? ` (${pending.length} new)` : ''}: ${detection.migrate}`);
      const envFile = `${APPS}/${newName}-migrate.env`;
      const migrator = `${newName}-migrate`;
      // migrations take locks a connection pooler can't hold: they use the direct line when there is one
      // ZD-SAFE: Postgres waits at most 5 s for a lock (PGOPTIONS), so a busy table can't freeze the site behind it
      await writeEnvFile(ctx, s, envFile, withLockLimits(runtimeEnv.DIRECT_URL ? { ...runtimeEnv, DATABASE_URL: runtimeEnv.DIRECT_URL } : runtimeEnv, log));
      // named, so a timed-out or stopped deploy really stops the migration instead of leaving it running
      // on the server while the next deploy starts another
      let mr: Awaited<ReturnType<typeof pool.exec>> | undefined;
      try {
        mr = await pool.exec(s, script(`docker run --rm --name "$4" --network unit7 --env-file "$1" ${vols.length ? `${volumeArgs(vols)} ` : ''}"$2" sh -c "$3" 2>&1; rc=$?; rm -f "$1"; exit $rc`, envFile, image, detection.migrate, migrator), { timeoutMs: 15 * 60_000, signal: ctx.signal, onData: (chunk) => { for (const line of chunk.split('\n')) if (line.trim()) log(ctx.redactor.redact(line.trim().slice(0, 200))); } });
      } finally {
        if (!mr) await pool.exec(s, script('docker rm -f "$1" >/dev/null 2>&1; rm -f "$2"', migrator, envFile)).catch(() => undefined);
      }
      if (mr.code !== 0) throw fail('migration_failed', `The database migration failed, so the new version wasn't started. The old version is still serving.${lockHint(mr.stdout)}`, ctx.redactor.redact(mr.stdout.trim().slice(-2000)));
      migrated = pending;
      run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ migrated }), deploymentId);
      log(pending.length ? `Migrated: ${pending.length} new migration${pending.length > 1 ? 's' : ''}.` : 'Database is up to date.');
    }

    const healthPath = cfg.healthPath ?? detection?.healthPath ?? '/';
    // what this version answers on, so a rollback to it later checks and routes the right port
    run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ port, healthPath }), deploymentId);
    if (migrated) steps.note(migrated.length ? `${migrated.length} database change${migrated.length > 1 ? 's' : ''} made` : 'The database was already up to date');

    steps.go('start', `Starting v${number} beside the live version`);
    log(`Starting ${newName}…`);
    started = true;
    await startContainer(ctx, s, newName, image, { ...cfg, port, volumes: vols }, runtimeEnv, svc);

    // a worker has no web port: healthy means it starts and keeps running
    const isWorker = svc.kind === 'worker';
    steps.go('check', isWorker ? 'Checking it keeps running' : 'Waiting for it to answer');
    // how long to wait comes from this app's own past starts; a person can add text the page must contain
    const pastStarts = all<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE service_id = ? AND id != ? ORDER BY number DESC LIMIT 10', svc.id, deploymentId)
      .map((d) => json<{ startMs?: number }>(d.plan, {}).startMs).filter((n): n is number => typeof n === 'number');
    const ready = { timeoutMs: rel.healthWaitMs(pastStarts), contains: cfg.release?.mustContain };
    const t0 = Date.now();
    const health = isWorker ? await stayUp(ctx, s, newName, log) : await healthCheck(ctx, s, newName, port, healthPath, log, ready);
    if (!health.healthy) {
      await pool.exec(s, cmd('docker', 'rm', '-f', newName)).catch(() => undefined); // burn it down; the old one keeps serving
      throw fail('unhealthy', `The new version didn't pass its health check, so Unit7 kept the previous one live.\n${firstLine(health.detail)}`, restOf(health.detail));
    }
    run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ startMs: Date.now() - t0 }), deploymentId);
    // no health page set or known: look for the app's own, for Unit7's checks from here on (copies, the switch, the watch).
    // Caddy keeps its own checks as they were: a health page it never watched before could take a working site down.
    let readyPath = healthPath;
    if (!isWorker && healthPath === '/' && !cfg.healthPath && detection?.builder !== 'static') {
      const found = (await rel.requestPaths(ctx.app, s, `http://${newName}:${port}`, rel.HEALTH_PATHS).catch(() => [])).find((r) => r.code >= 200 && r.code < 300);
      if (found) {
        readyPath = found.path;
        log(`Found its own health page: ${found.path}.`);
        run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ readyPath }), deploymentId);
      }
    }
    // more copies behind the load balancer, each proven healthy before any traffic moves (never for workers)
    const replicas = isWorker ? [] : replicaNames(newName, cfg.replicas);
    for (const r of replicas) {
      log(`Starting copy ${r}…`);
      await startContainer(ctx, s, r, image, { ...cfg, port, volumes: vols }, runtimeEnv, svc);
      const h = await healthCheck(ctx, s, r, port, readyPath, log, ready);
      if (!h.healthy) {
        await pool.exec(s, cmd('docker', 'rm', '-f', newName, ...replicas)).catch(() => undefined);
        throw fail('unhealthy', `A copy of the new version didn't pass its health check, so Unit7 kept the previous one live.\n${firstLine(h.detail)}`, restOf(h.detail));
      }
    }

    const domains = ctx.db.prepare('SELECT hostname, tls_mode, target FROM domains WHERE service_id = ? AND org_id = ?').all(svc.id, ctx.orgId) as { hostname: string; tls_mode: string; target: string | null }[];
    const hosts = domains.map((d) => d.hostname);
    // the last 30 minutes of the live version, from the proxy's log: the pages to warm, its usual errors and speed (the
    // watch compares against them), and whether it holds live connections (websockets wait longer to drain)
    const pre = !isWorker && previousLive && hosts.length ? await rel.readSiteLog(ctx.app, s, hosts, '30m') : null;
    if (!isWorker) {
      // warm-up: the busiest pages, opened on the new version before visitors arrive. A page that works on the live
      // version but fails on the new one stops the deploy here.
      const paths = rel.warmPaths(pre?.hits ?? [], usualPaths(ctx, s.id, hosts));
      let warm = await rel.requestPaths(ctx.app, s, `http://${newName}:${port}`, paths).catch(() => []);
      if (warm.some((w) => w.code >= 500)) {
        await new Promise((r) => setTimeout(r, 2000));
        const again = await rel.requestPaths(ctx.app, s, `http://${newName}:${port}`, warm.filter((w) => w.code >= 500).map((w) => w.path)).catch(() => []);
        warm = warm.map((w) => again.find((a) => a.path === w.path) ?? w);
      }
      const broken = warm.find((w) => w.code >= 500);
      if (broken) {
        await pool.exec(s, cmd('docker', 'rm', '-f', newName, ...replicas)).catch(() => undefined);
        throw fail('unhealthy', `The new version answered ${broken.code} on ${broken.path}, a page that works on the live version, so Unit7 kept the previous one live.`);
      }
      if (warm.length) {
        const slowest = Math.max(...warm.map((w) => w.ms));
        run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ warm: { pages: warm, slowestMs: slowest } }), deploymentId);
        steps.note(`Checked ${warm.length} page${warm.length > 1 ? 's' : ''} · slowest ${slowest < 1000 ? `${slowest} ms` : `${(slowest / 1000).toFixed(1)} s`}`);
        log(`Opened ${warm.length} busy page${warm.length > 1 ? 's' : ''} on the new version; the slowest took ${slowest} ms.`);
      }
    }

    // switch traffic: point every domain of this service at the new container
    steps.go('switch', isWorker ? 'A worker has no visitors to move' : 'Moving visitors to the new version');
    // the proof: Unit7's own steady requests through the proxy while traffic moves, counted from its log afterwards
    const checkHost = domains.find((d) => !json<{ redirectTo?: string }>(d.target, {}).redirectTo);
    if (!isWorker && previousLive && checkHost && proxyFor(s).kind === 'caddy') {
      const name = `unit7-switchcheck-${deploymentId.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      switchCheck = { name, t0: await rel.startSwitchCheck(ctx.app, s, name, checkHost.hostname, checkHost.tls_mode, readyPath) };
    }
    let url: string | undefined;
    if (isWorker) {
      log('Worker is running (no web address: it works in the background).');
    } else if (domains.length) {
      for (const d of domains) {
        await putSite(ctx.app, s, { hostname: d.hostname, upstream: newName, replicas, port, healthPath, cacheStatic: cfg.cacheStatic, tls: d.tls_mode as Site['tls'] });
        switched.push({ hostname: d.hostname, tls: d.tls_mode as Site['tls'] });
        url ??= `${d.tls_mode === 'off' ? 'http' : 'https'}://${d.hostname}`;
      }
      log(`Traffic now goes to deploy #${number}.`);
      await confirmRouting(ctx, s, newName, port).catch(() => undefined);
    } else {
      // no domain yet: give an instant URL via sslip.io (IP-based DNS) so the app is reachable now
      const ip = await serverIp(ctx, s);
      const host = `${svc.slug}-${svc.environment_id.slice(-6)}.${ip.replace(/\./g, '-')}.sslip.io`.toLowerCase();
      // Real HTTPS only when the server is reachable at a public address; a loopback/private box
      // (and every local test) gets plain HTTP, since Let's Encrypt could never reach it anyway.
      const { classify } = await import('../netguard.ts');
      const publicly = classify(ip) === 'public' && classify(s.host) !== 'loopback' && classify(s.host) !== 'private';
      const tls: Site['tls'] = publicly ? 'auto' : 'off';
      await putSite(ctx.app, s, { hostname: host, upstream: newName, replicas, port, healthPath, cacheStatic: cfg.cacheStatic, tls });
      run(ctx.db, `INSERT INTO domains (id, org_id, hostname, service_id, status, tls, tls_mode, auto) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)
        ON CONFLICT(hostname) DO UPDATE SET service_id = excluded.service_id, status = 'active'`, id('dom'), ctx.orgId, host, svc.id, tls === 'off' ? 'off' : 'issuing', tls);
      url = `${tls === 'off' ? 'http' : 'https'}://${host}`;
      hosts.push(host);
      log(`No domain set, so Unit7 gave you an instant URL: ${url}`);
    }
    if (!isWorker) steps.note(`Visitors now go to v${number}`);

    // the old version: given time to finish what it's doing, then stopped (not removed) → instant rollback
    let proof: rel.Proof | undefined, watchFrom: number | undefined;
    if (!previousLive || previousLive === newName) steps.skip('drain', 'First version: nothing to hand over');
    else if (canary && !isWorker) { // FLEET D3: the old version keeps serving the rest of the visitors during the canary
      steps.skip('drain', `The old version keeps ${100 - canary.share}% of visitors while the new one is tried`);
      proof = { measured: false, why: 'A canary: the old version kept serving, so nothing switched all at once.' };
    } else if (isWorker) {
      // a worker is told to stop (SIGTERM) and gets its grace time to finish the job it's on
      const grace = cfg.release?.workerGraceSeconds ?? rel.DEFAULTS.workerGraceSeconds;
      steps.go('drain', `Asking the old worker to finish its job (up to ${grace} s)`);
      const t = Date.now();
      await pool.exec(s, script('g=$1; shift; docker stop -t "$g" "$@" >/dev/null 2>&1; true', grace, ...allCopies(previousLive)), { timeoutMs: (grace + 60) * 1000 }).catch(() => undefined);
      const took = Math.round((Date.now() - t) / 1000);
      const said = took < grace - 1 ? `Old worker finished its job (${took} s), then stopped` : `Old worker had ${grace} s to finish its job, then was stopped`;
      steps.done(said); log(`${said}.`);
    } else {
      // drain: wait until the old version has no open connections (or the limit), counted inside it
      const oldPort = json<{ port?: number }>(get<{ plan: string }>(ctx.db, 'SELECT plan FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.plan, {}).port ?? port;
      const ws = (!!pre && rel.rates(pre.hits).websockets) || !!(detection ?? cfg.detection)?.scaleRisks?.some((r) => /websocket/i.test(r));
      const limit = rel.drainLimit(cfg.release, ws);
      steps.go('drain', 'Letting the old version finish');
      const d = await rel.drainWait(() => rel.countOpen(ctx.app, s, allCopies(previousLive), oldPort), { limitMs: limit * 1000,
        onCount: (n, ms) => steps.note(`Letting the old version finish · ${n} open connection${n === 1 ? '' : 's'} · ${Math.round(ms / 1000)} s`) });
      // then SIGTERM, and Docker's own grace on top for it to close cleanly
      await pool.exec(s, script('g=$1; shift; docker stop -t "$g" "$@" >/dev/null 2>&1; true', rel.DEFAULTS.stopGraceSeconds, ...allCopies(previousLive)), { timeoutMs: 120_000 }).catch(() => undefined);
      const secs = Math.round(d.ms / 1000);
      const said = d.why === 'empty' ? (secs ? `The old version finished its last request after ${secs} s` : 'The old version had nothing left to finish')
        : d.why === 'limit' ? `Waited the ${limit} s limit; ${d.open} connection${d.open === 1 ? ' was' : 's were'} still open and got ${rel.DEFAULTS.stopGraceSeconds} s more to close`
        : `Couldn’t count the old version’s open connections, so it had ${secs} s to finish`;
      steps.done(said); log(`${said}.`);
      // the proof, from the proxy's own log: requests that failed while traffic moved. Unreadable = not measured, never 0.
      if (switchCheck) {
        await rel.stopSwitchCheck(ctx.app, s, switchCheck.name);
        const after = switchCheck.t0 ? await rel.readSiteLog(ctx.app, s, hosts, String(Math.floor(switchCheck.t0 / 1000) - 1)) : null;
        proof = switchCheck.t0 ? rel.proofOf(after?.hits ?? null, switchCheck.t0, after?.now ?? Date.now()) : { measured: false, why: 'Unit7 couldn’t start its check through the proxy, so this switch wasn’t measured.' };
        watchFrom = after?.now;
        switchCheck = undefined;
      } else proof = { measured: false, why: proxyFor(s).kind === 'caddy' ? 'There was no address to check through the proxy.' : 'This server’s web traffic goes through a proxy Unit7 can’t read, so this switch wasn’t measured.' };
      run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ proof }), deploymentId);
      if (proof.measured) {
        run(ctx.db, 'UPDATE deployments SET downtime_seconds = ?, failed_requests = ? WHERE id = ?', proof.downtimeSeconds!, proof.failed!, deploymentId);
        log(`While traffic moved: ${proof.downtimeSeconds} s down, ${proof.failed} failed of ${proof.requests} requests.`);
      }
    }
    run(ctx.db, `UPDATE deployments SET status = 'stopped' WHERE id = ? AND status = 'live'`, svc.current_deployment_id ?? '');
    run(ctx.db, `UPDATE deployments SET status = 'live', container = ?, finished_at = ? WHERE id = ?`, newName, new Date().toISOString(), deploymentId);
    run(ctx.db, `UPDATE services SET status = 'healthy', current_deployment_id = ?, server_id = ?, config = ? WHERE id = ?`,
      deploymentId, s.id, JSON.stringify({ ...cfg, detection: detection ?? cfg.detection, port, source: src, ...(vols.length && { volumes: vols }) }), svc.id);
    live = true;
    // saved files are backed up daily from the first deploy that keeps them (a person can change or stop it)
    if (vols.length) run(ctx.db, `INSERT INTO backup_schedules (id, org_id, service_id, frequency, keep) SELECT ?, ?, ?, 'daily', 7 WHERE NOT EXISTS (SELECT 1 FROM backup_schedules WHERE service_id = ?)`, id('sch'), ctx.orgId, svc.id, svc.id);
    await pool.exec(s, script('rm -rf "$1"', dir)).catch(() => undefined);
    await pruneOld(ctx, s, svc.id, log);
    // the watch window: the new version's errors and speed against the old one's usual, for a few minutes, in the background
    const minutes = rel.watchMinutes(cfg.release);
    const watchOn = !canary && !isWorker && !!previousLive && !!svc.current_deployment_id && minutes > 0; // FLEET D3: a canary compares the two itself
    if (watchOn) steps.go('watch', `Watching the new version for ${minutes} min`);
    else { steps.skip('watch', isWorker ? 'A worker has no visitors to watch' : !previousLive ? 'First version: nothing to compare with' : canary ? `Tried on ${canary.share}% of visitors first (a canary), compared with the old version` : 'Watching is off for this app'); steps.go('done'); steps.done(); }
    ctx.emit('deployment.succeeded', `${svc.name} deploy #${number} is live${url ? ` at ${url}` : ''}`, { severity: 'success', resource: svc.id, data: { deploymentId, number, url } });
    if (watchOn) {
      rel.startWatch(ctx.app, { orgId: ctx.orgId, projectId: svc.project_id, serviceId: svc.id, name: svc.name, deploymentId, number, previousId: svc.current_deployment_id!, serverId: s.id, hosts, container: newName, port, healthPath: readyPath,
        base: pre ? rel.rates(pre.hits) : undefined, since: watchFrom ?? Date.now(), until: Date.now() + minutes * 60_000, autoRollback: cfg.release?.autoRollback !== false, migrated: !!migrated?.length });
    }
    // vulnerabilities in the built image, scanned after go-live so the deploy never waits on it
    void scanDeployment(ctx, s, deploymentId, image, svc.name).catch(() => undefined);
    return { deploymentId, number, status: 'live', url, ...(migrated?.length && { migrated }), ...(svc.current_deployment_id && { previousDeploymentId: svc.current_deployment_id }),
      ...(watchOn && { watching: `Watching for ${minutes} min: Unit7 rolls back by itself if errors jump` }), ...(proof && { proof }) };
  } catch (e) {
    if (switchCheck) await rel.stopSwitchCheck(ctx.app, s, switchCheck.name);
    steps.fail(String(e instanceof Error ? e.message : e).split('\n')[0]!.slice(0, 300));
    await pool.exec(s, script('rm -rf "$1"', dir)).catch(() => undefined);
    if (started && !live) {
      // the new copies share the app's private address: left running, they'd answer for it half the time
      await removeCopies(ctx, s, newName).catch(() => undefined);
      // domains already switched go back to what was serving (best effort: the error below says what failed)
      if (previousLive) {
        for (const d of switched) await routeService(ctx, s, svc, previousLive, replicaNames(previousLive, cfg.replicas), d).catch(() => undefined);
      }
    }
    if (e instanceof Unit7Error && ['unhealthy', 'build_failed', 'clone_failed', 'no_builder', 'migration_needs_ok', 'migration_failed', 'backup_failed', 'secrets_in_code', 'tests_failed', 'migration_risky'].includes(e.code)) {
      // a failed build or clone is thrown as it is: recorded here, or the deployment would read "building" forever
      if (get<{ status: string }>(ctx.db, 'SELECT status FROM deployments WHERE id = ?', deploymentId)?.status !== 'failed') fail(e.code, e.message, (e.detail as { logTail?: string } | undefined)?.logTail);
      throw e;
    }
    const said = e instanceof Unit7Error ? e.message : `Deploy failed: ${(e as Error).message}`;
    throw fail('deploy_failed', firstLine(said), restOf(said) ?? (e instanceof Unit7Error ? (e.detail as { logTail?: string } | undefined)?.logTail : undefined));
  }
}

export const rollback = (ctx: Ctx, svc: ServiceRow, toDeploymentId?: string) => oneAtATime(ctx, svc, (fresh) => rollbackNow(ctx, fresh, toDeploymentId));

async function rollbackNow(ctx: Ctx, svc: ServiceRow, toDeploymentId?: string): Promise<{ deploymentId: string; number: number }> {
  const s = serverRow(ctx, svc.server_id!);
  type Target = { id: string; number: number; container: string | null; status: string; plan: string };
  // by default the version just before the live one (not simply the newest other one: after an earlier
  // rollback, that would roll *forward*)
  const currentNumber = get<{ number: number }>(ctx.db, 'SELECT number FROM deployments WHERE id = ?', svc.current_deployment_id ?? '')?.number ?? Number.MAX_SAFE_INTEGER;
  const target = toDeploymentId
    ? get<Target>(ctx.db, `SELECT id, number, container, status, plan FROM deployments WHERE id = ? AND service_id = ?`, toDeploymentId, svc.id)
    : get<Target>(ctx.db,
        `SELECT id, number, container, status, plan FROM deployments WHERE service_id = ? AND number < ? AND status IN ('stopped','live') AND container IS NOT NULL ORDER BY number DESC LIMIT 1`, svc.id, currentNumber);
  if (!target?.container) throw new Unit7Error('no_rollback_target', 'There is no earlier healthy deployment to roll back to.');
  const pool = ssh(ctx.app);
  const cfg = json<ServiceConfig>(svc.config, {});
  // the port and health path that version was deployed with, not today's
  const plan = json<{ port?: number; healthPath?: string }>(target.plan, {});
  const port = plan.port ?? (cfg.detection?.builder === 'static' ? 80 : cfg.port ?? 3000);
  const healthPath = plan.healthPath ?? cfg.healthPath ?? cfg.detection?.healthPath ?? '/';
  ctx.progress(`Rolling back ${svc.name} to deploy #${target.number}…`);
  rel.stopWatch(ctx.app, svc.id, 'rolled back'); // the version being watched is the one being left
  // the old container is only stopped, so start it and swing traffic back
  await pool.check(s, cmd('docker', 'start', target.container), { what: 'Starting the previous version', timeoutMs: 60_000 });
  const health = await healthCheck(ctx, s, target.container, port, healthPath, (m) => ctx.progress(m));
  if (!health.healthy) {
    // don't leave it running beside the live version under the same private address
    await pool.exec(s, script('docker stop "$@" >/dev/null 2>&1; true', ...allCopies(target.container))).catch(() => undefined);
    throw new Unit7Error('rollback_unhealthy', `Deploy #${target.number} didn't come back healthy: ${health.detail}`);
  }
  const replicas: string[] = [];
  for (const r of replicaNames(target.container, cfg.replicas)) {
    if ((await pool.exec(s, cmd('docker', 'start', r))).code === 0 && (await healthCheck(ctx, s, r, port, healthPath, () => undefined)).healthy) replicas.push(r);
  }
  const live = svc.current_deployment_id ? get<{ container: string }>(ctx.db, 'SELECT container FROM deployments WHERE id = ?', svc.current_deployment_id)?.container : undefined;
  await routeService(ctx, s, svc, target.container, replicas, undefined, { port, healthPath });
  if (live && live !== target.container) await pool.exec(s, script('docker stop "$@" >/dev/null 2>&1; true', ...allCopies(live))).catch(() => undefined);
  run(ctx.db, `UPDATE deployments SET status = 'stopped' WHERE id = ? AND status = 'live'`, svc.current_deployment_id ?? '');
  run(ctx.db, `UPDATE deployments SET status = 'live' WHERE id = ?`, target.id);
  // the service now runs that version: later scaling and new domains use its port
  run(ctx.db, `UPDATE services SET status = 'healthy', current_deployment_id = ?, config = json_set(config, '$.port', ?) WHERE id = ?`, target.id, port, svc.id);
  ctx.emit('deployment.rolledback', `${svc.name} rolled back to deploy #${target.number}`, { severity: 'warning', resource: svc.id, data: { deploymentId: target.id, number: target.number } });
  return { deploymentId: target.id, number: target.number };
}

// After a reload, make one request through Caddy so we don't report success a beat before routing
// is live. Best-effort: routing is already applied synchronously by `caddy reload`.
async function confirmRouting(ctx: Ctx, s: ServerRow, container: string, port: number) {
  for (let i = 0; i < 5; i++) {
    const r = await ssh(ctx.app).exec(s, script(`docker run --rm --network unit7 curlimages/curl:latest -s -o /dev/null -w "%{http_code}" --max-time 5 "http://unit7-caddy:80/" -H "Host: $1" 2>/dev/null || echo 000`, `${container}.probe`), { timeoutMs: 15_000 });
    void r; // the probe host won't match; we only need Caddy to be answering again
    return;
  }
}

async function serverIp(ctx: Ctx, s: ServerRow): Promise<string> {
  const facts = json<{ publicIp?: string }>(s.facts, {});
  if (facts.publicIp) return facts.publicIp;
  // the address Unit7 connects to is usually the public one; confirm with the server's view
  const out = (await ssh(ctx.app).exec(s, script(`curl -s --max-time 4 https://api.ipify.org || curl -s --max-time 4 https://ifconfig.me || hostname -I | awk '{print $1}'`))).stdout.trim().split(/\s+/)[0];
  const ip = out && /^\d+\.\d+\.\d+\.\d+$/.test(out) ? out : s.host;
  run(ctx.db, `UPDATE servers SET facts = json_set(facts, '$.publicIp', ?) WHERE id = ?`, ip, s.id);
  return ip;
}

// What you (or self-heal) set on the service wins over what detection guessed.
function withOverrides(d: Detection, cfg: ServiceConfig): Detection {
  return {
    ...d,
    ...(cfg.startCommand && { startCommand: cfg.startCommand }),
    ...(cfg.buildCommand && { buildCommand: cfg.buildCommand }),
    ...(cfg.nodeVersion && { nodeVersion: cfg.nodeVersion }),
    ...(cfg.nodeOptions && { nodeOptions: cfg.nodeOptions }),
  };
}

// Project memory: what this app is made of, written when it's first seen or when it changes, so
// Warden's suggestions and the AI know the project without re-reading the code.
function rememberProfile(ctx: Ctx, svc: ServiceRow, d: Detection) {
  const parts = [`${svc.name}: ${d.stack}${d.pins?.pm ? ` (${label(d.pins.pm)})` : d.packageManager ? ` (${d.packageManager})` : ''}${d.pins?.node ? `, ${label(d.pins.node)}` : ''}, port ${d.port}`,
    d.needs.length ? `uses ${d.needs.join(', ')}` : '', d.envKeys.length ? `reads ${d.envKeys.length} settings (${d.envKeys.slice(0, 8).join(', ')}${d.envKeys.length > 8 ? '…' : ''})` : '',
    d.healthRoute ? 'has a health route' : 'no health route', d.scaleRisks?.length ? `before scaling: ${d.scaleRisks.join('; ')}` : 'safe to run as several copies'].filter(Boolean);
  const content = `Profile · ${parts.join(' · ')}`;
  const prefix = `Profile · ${svc.name}:`;
  const last = get<{ content: string }>(ctx.db, 'SELECT content FROM memories WHERE org_id = ? AND project_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT 1', ctx.orgId, svc.project_id, `${prefix}%`);
  if (last?.content === content) return;
  run(ctx.db, 'DELETE FROM memories WHERE org_id = ? AND project_id = ? AND content LIKE ?', ctx.orgId, svc.project_id, `${prefix}%`);
  run(ctx.db, 'INSERT INTO memories (id, org_id, project_id, content, source) VALUES (?, ?, ?, ?, ?)', id('mem'), ctx.orgId, svc.project_id, content, 'Unit7 (from the code)');
}

// an error's plain first line, and the rest (a log) to keep apart from it
const firstLine = (t: string) => t.split('\n')[0]!;
const restOf = (t: string) => { const i = t.indexOf('\n'); return i < 0 || !t.slice(i + 1).trim() ? undefined : t.slice(i + 1); };
const redactSource = (src: Source): Source => (src.type === 'git' ? { ...src, repo: src.repo.replace(/\/\/[^@]+@/, '//') } : src);
export { containerName, pointsHere, backupBeforeChange, startContainer, buildImage, readRepo, APPS };
