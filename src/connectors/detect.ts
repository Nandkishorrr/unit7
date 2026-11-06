// Work out how to build and run a repo from its files. Unit7 reads a shallow listing plus a few
// manifests, never executes the repo. A Dockerfile always wins: the author already said how.
import { z } from 'zod';
import { dataDirsOf } from '../deploy/volumes.ts';

export interface Detection {
  stack: string;               // "next", "vite", "node", "python-fastapi", "go", "docker", "static"…
  builder: 'dockerfile' | 'compose' | 'railpack' | 'static';
  runtime?: string;            // node, python, go…
  packageManager?: string;     // npm, pnpm, yarn, bun, pip, poetry…
  buildCommand?: string;
  startCommand?: string;
  port: number;                // the port Unit7 will route to
  staticDir?: string;          // for SPAs/static sites
  needs: string[];             // "postgres", "redis"… inferred from deps
  envKeys: string[];           // every env var the code reads
  healthPath: string;
  healthRoute?: boolean;       // the code defines /health, /healthz, /api/health or /up
  scaleRisks?: string[];       // what breaks with a second copy (sessions in memory, SQLite…)
  nodeVersion?: number;        // major Node version the project asks for (engines.node, .nvmrc)
  nodeOptions?: string;        // NODE_OPTIONS for the build (more heap, legacy OpenSSL), set by self-heal
  migrate?: string;            // the deploy-safe command that applies database migrations
  migrations?: string[];       // migration files in the repo (new ones since the last deploy are "pending")
  processes?: Record<string, string>; // from a Procfile: web, worker, release…
  dataDirs?: string[];         // folders (under the app's folder) the code keeps files in: each gets a volume (src/deploy/volumes.ts)
  pins?: import('../deploy/pins.ts').Pins; // the toolchain this build uses and why (src/deploy/pins.ts), set by the deployer
  dockerfile?: string;         // path within the repo, if present
  composeFile?: string;
  notes: string[];
}

export interface RepoFacts {
  files: string[];                         // paths (relative), shallow-ish
  manifests: Record<string, string>;       // path -> contents, for the few we parse
  envExample?: string;                     // .env.example / .env.sample contents
  sourceSample?: string;                   // concatenated source for env-key scanning
  traits?: string;                         // grep hits for things that matter at runtime (sessions, sockets, cron…)
  pinFiles?: Record<string, string>;       // the start of the lockfiles and toolchain files at the root (src/deploy/pins.ts)
}

const has = (files: string[], re: RegExp) => files.some((f) => re.test(f));
const PORT = (s: string, d: number) => { const m = s.match(/\b(?:PORT|port)\b\D{0,4}(\d{2,5})/); return m ? Number(m[1]) : d; };
// the port a Dockerfile declares (the last EXPOSE: the final stage is what runs)
const EXPOSE = (s: string) => { const m = [...s.matchAll(/^\s*EXPOSE\s+(\d{2,5})\b/gim)].pop(); return m ? Number(m[1]) : undefined; };
// The manifest that describes the app: the one nearest the root wins, and editor tooling
// (.devcontainer/Dockerfile, its package.json) is never the app.
export function pick(paths: string[], re: RegExp): string | undefined {
  return paths.filter((p) => re.test(p) && !/(^|\/)\.devcontainer\//.test(p)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
}
const PKG = /(^|\/)package\.json$/;

export function detect(facts: RepoFacts): Detection {
  const d = detectStack(facts);
  const node = d.runtime === 'node' || (d.builder === 'static' && !!d.buildCommand) ? nodeMajor(facts) : undefined;
  const m = migrationsOf(facts, d);
  const processes = procfile(facts);
  if (!m.migrate && processes?.release) m.migrate = processes.release; // Heroku-style release phase
  // files the app keeps (a data folder, uploads, a SQLite file), only where Unit7 writes the Dockerfile and knows the app's folder
  const data = d.builder === 'railpack' && (d.runtime === 'node' || d.runtime === 'python') ? dataDirsOf(facts.traits, facts.files) : undefined;
  return { ...d, healthRoute: healthRoute(facts), scaleRisks: scaleRisks(facts), ...(node && { nodeVersion: node }), ...m, ...(processes && { processes }),
    ...(data?.dirs.length && { dataDirs: data.dirs }), ...(data?.notes.length && { notes: [...d.notes, ...data.notes] }) };
}

// "name: command" lines from a Procfile at the repo root
export function procfile(facts: RepoFacts): Record<string, string> | undefined {
  const body = facts.manifests['Procfile'];
  if (!body) return undefined;
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) { const m = /^([a-z][\w-]*):\s*(.+)$/i.exec(line.trim()); if (m) out[m[1]!.toLowerCase()] = m[2]!.trim(); }
  return Object.keys(out).length ? out : undefined;
}

// How this project applies database migrations, using only deploy-safe commands (Prisma `migrate
// deploy`, never `migrate dev`; Drizzle `migrate`, never `push`). The author's own script wins.
const MIGRATION_FILE = /(^|\/)(prisma\/migrations\/[^/]+\/migration\.sql|(?:drizzle|migrations|db\/migrate|database\/migrations|alembic\/versions|[^/]+\/migrations)\/(?!__init__|\.)[^/]+\.(?:sql|js|ts|cjs|mjs|py|php|rb))$/;
export function migrationsOf(facts: RepoFacts, d: Detection): { migrate?: string; migrations?: string[] } {
  const { files, manifests } = facts;
  const pkgPath = pick(Object.keys(manifests), PKG);
  const pkg = pkgPath ? safeJson(manifests[pkgPath]!) : undefined;
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const pm = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : files.includes('bun.lockb') ? 'bun' : 'npm';
  const migrations = files.filter((f) => MIGRATION_FILE.test(f)).sort();
  const own = ['migrate:deploy', 'db:migrate:deploy', 'db:migrate', 'migrate'].find((k) => scripts[k] && !/\bdev\b|push/.test(scripts[k]!));
  const migrate = own ? `${pm} run ${own}`
    : ('prisma' in deps || '@prisma/client' in deps) && files.some((f) => f.startsWith('prisma/migrations/')) ? 'npx prisma migrate deploy'
    : 'drizzle-kit' in deps && migrations.some((f) => /\.sql$/.test(f)) ? 'npx drizzle-kit migrate'
    : files.some((f) => /(^|\/)knexfile\.(js|ts|cjs|mjs)$/.test(f)) ? 'npx knex migrate:latest'
    : 'sequelize-cli' in deps ? 'npx sequelize-cli db:migrate'
    : d.stack === 'python-django' ? 'python manage.py migrate --noinput'
    : files.some((f) => /(^|\/)alembic\.ini$/.test(f)) ? 'alembic upgrade head'
    : d.stack === 'laravel' ? 'php artisan migrate --force'
    : undefined;
  return migrate ? { migrate, migrations } : {};
}

// A pending migration that loses data (drops or renames a table or column, rewrites a column's type,
// deletes rows). Returns the line that does it. Dropping an index or a constraint is not data loss.
const DESTRUCTIVE = [
  /\bDROP\s+(?:TABLE|SCHEMA|DATABASE)\b[^;\n]*/i, /\bALTER\s+TABLE\b[^;]*?\bDROP\s+(?:COLUMN\s+)?(?!CONSTRAINT|INDEX|DEFAULT|NOT\s+NULL)\S+[^;\n]*/i,
  /\bTRUNCATE\b[^;\n]*/i, /\bRENAME\s+(?:COLUMN|TO)\b[^;\n]*/i, /\bALTER\s+COLUMN\b[^;]*?\bTYPE\b[^;\n]*/i, /\bDELETE\s+FROM\b[^;\n]*/i,
  /\b(?:RemoveField|DeleteModel|RenameField|RenameModel)\b[^\n]*/,                       // Django
  /(?:->dropColumn|Schema::drop(?:IfExists)?|->renameColumn|dropTable|dropColumn|removeColumn|renameColumn)\b[^\n]*/, // Laravel, Knex, Sequelize
  /\bop\.(?:drop_table|drop_column|rename_table)\b[^\n]*/,                                // Alembic
];
export function destructiveLine(content: string): string | undefined {
  const code = content.replace(/^\s*(--|#|\/\/).*$/gm, ''); // ignore comments ("-- DropTable" headers)
  for (const re of DESTRUCTIVE) { const m = re.exec(code); if (m) return m[0].trim().slice(0, 160); }
  return undefined;
}

// The Node major a project asks for, mapped onto the images Unit7 builds with (18–24; 22 by default).
export const nodeMajor = (facts: RepoFacts): number | undefined => nodeSource(facts)?.major;
// ...and where it says so: engines.node first, then .nvmrc / .node-version, then Volta's pin (src/deploy/pins.ts words it)
export function nodeSource(facts: RepoFacts): { major: number; from: 'engines' | 'nvmrc' | 'volta'; file: string } | undefined {
  const rcPath = pick(Object.keys(facts.manifests), /(^|\/)\.(nvmrc|node-version)$/);
  const pkgPath = pick(Object.keys(facts.manifests), PKG);
  const pkg = pkgPath ? safeJson(facts.manifests[pkgPath]!) : undefined;
  const tries: [unknown, 'engines' | 'nvmrc' | 'volta', string][] = [[pkg?.engines?.node, 'engines', 'package.json'], [rcPath && facts.manifests[rcPath], 'nvmrc', rcPath?.split('/').pop() ?? '.nvmrc'], [pkg?.volta?.node, 'volta', 'package.json']];
  for (const [spec, from, file] of tries) { const major = majorFromSpec(String(spec ?? '')); if (major) return { major, from, file }; }
  return undefined;
}
// The package manager package.json names (packageManager, then devEngines, then Volta's pin for `tool`: Volta pins npm
// beside Node in any project, so it never decides which tool), checked so it can go into a build line: a name Unit7 knows
// and a plain version, nothing else
export function pmField(pkg: { packageManager?: unknown; devEngines?: { packageManager?: unknown }; volta?: Record<string, unknown> } | undefined, tool?: string): { name: 'npm' | 'pnpm' | 'yarn' | 'bun'; version: string; from: 'packageManager' | 'devEngines' | 'volta' } | undefined {
  const exact = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+[\w.-]+)?$/.exec(String(pkg?.packageManager ?? ''));
  if (exact) return { name: exact[1] as 'pnpm', version: exact[2]!, from: 'packageManager' };
  const dev = [pkg?.devEngines?.packageManager].flat()[0] as { name?: string; version?: string } | undefined;
  const range = dev && /^(npm|pnpm|yarn|bun)$/.test(String(dev.name)) ? /(\d+)(\.\d+){0,2}/.exec(String(dev.version ?? '')) : null;
  if (dev && range) return { name: dev.name as 'pnpm', version: range[1]!, from: 'devEngines' }; // a range: its major
  const v = tool && /^(npm|pnpm|yarn|bun)$/.test(tool) ? /^\d+(\.\d+){0,2}$/.exec(String(pkg?.volta?.[tool] ?? '')) : null;
  if (v) return { name: tool as 'pnpm', version: v[0], from: 'volta' };
  return undefined;
}
export function majorFromSpec(spec: string): number | undefined {
  const s = spec.trim().replace(/^v/, '');
  if (!s || /^(lts|node|latest|stable|\*)/i.test(s)) return undefined;
  const clamp = (n: number) => Math.min(24, Math.max(18, n));
  const atLeast = /^>=?\s*(\d+)/.exec(s);
  if (atLeast) return clamp(Math.max(Number(atLeast[1]), 22)); // ">=18" is happy on the default
  const n = /(\d+)/.exec(s);
  return n ? clamp(Number(n[1])) : undefined;
}
function detectStack(facts: RepoFacts): Detection {
  const { files, manifests } = facts;
  const notes: string[] = [];
  const pkgPath = pick(Object.keys(manifests), PKG);
  const pkg = pkgPath ? safeJson(manifests[pkgPath]!) : undefined;
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const dep = (name: string) => name in deps;
  const scripts: Record<string, string> = pkg?.scripts ?? {};

  const envKeys = scanEnvKeys(facts);
  const needs = inferNeeds(facts, deps);
  const base: Detection = { stack: 'unknown', builder: 'railpack', port: 3000, needs, envKeys, healthPath: '/', notes };

  // 1. Dockerfile — the author already said how to build and run.
  const dockerfile = pick(files, /(^|\/)Dockerfile$/);
  if (dockerfile) {
    const body = manifests[dockerfile] ?? '';
    return { ...base, stack: 'docker', builder: 'dockerfile', dockerfile, port: EXPOSE(body) ?? PORT(body, 8080), notes: [...notes, 'Using the repository’s Dockerfile.'] };
  }
  // 2. Compose — a multi-service repo describes itself.
  const compose = pick(files, /(^|\/)(docker-)?compose\.ya?ml$/);
  if (compose && !pkg) return { ...base, stack: 'compose', builder: 'compose', composeFile: compose, notes: [...notes, 'Using the repository’s compose file.'] };

  const pm = dep('') ? undefined : pmField(pkg)?.name ?? (files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : files.includes('bun.lockb') ? 'bun' : files.some((f) => /(^|\/)package-lock\.json$/.test(f)) ? 'npm' : 'npm');

  // 3. Node frameworks
  if (pkg) {
    const build = scripts.build ? `${pm} run build` : undefined;
    const start = scripts.start ? `${pm} run start` : scripts.serve ? `${pm} run serve` : undefined;
    if (dep('next')) return { ...base, stack: 'next', runtime: 'node', packageManager: pm, buildCommand: build, startCommand: start ?? 'next start -p $PORT', port: 3000, healthPath: '/', notes: [...notes, 'Next.js app.'] };
    if (dep('nuxt')) return { ...base, stack: 'nuxt', runtime: 'node', packageManager: pm, buildCommand: build, startCommand: start ?? 'node .output/server/index.mjs', port: 3000 };
    if (dep('@remix-run/serve') || dep('@react-router/serve')) return { ...base, stack: 'remix', runtime: 'node', packageManager: pm, buildCommand: build, startCommand: start, port: 3000 };
    if (dep('@nestjs/core')) return { ...base, stack: 'nest', runtime: 'node', packageManager: pm, buildCommand: build ?? `${pm} run build`, startCommand: start ?? 'node dist/main', port: PORT(allManifestText(manifests), 3000), healthPath: '/health' };
    if (dep('astro')) { const spa = !dep('@astrojs/node'); return { ...base, stack: 'astro', runtime: 'node', packageManager: pm, buildCommand: build ?? `${pm} run build`, builder: spa ? 'static' : 'railpack', staticDir: spa ? 'dist' : undefined, startCommand: spa ? undefined : 'node ./dist/server/entry.mjs', port: 4321 }; }
    // SPA builders: build, then serve the output as static files behind Caddy
    const spaOut = dep('vite') ? 'dist' : (dep('react-scripts') || dep('@craco/craco')) ? 'build' : dep('@angular/core') ? 'dist' : undefined;
    const spaFramework = dep('vite') ? 'vite' : dep('react-scripts') ? 'react' : dep('@angular/core') ? 'angular' : undefined;
    if (spaOut && build && !start && !dep('express') && !dep('fastify') && !dep('h3')) {
      return { ...base, stack: spaFramework!, builder: 'static', runtime: 'node', packageManager: pm, buildCommand: build, staticDir: spaOut, port: 80, healthPath: '/', notes: [...notes, 'Static site: built, then served by Caddy. No server process.'] };
    }
    // plain Node server
    const entry = pkg.main ?? (files.includes('server.js') ? 'server.js' : files.includes('index.js') ? 'index.js' : files.includes('src/index.ts') ? 'src/index.ts' : undefined);
    return { ...base, stack: dep('express') ? 'express' : dep('fastify') ? 'fastify' : dep('hono') ? 'hono' : 'node', runtime: 'node', packageManager: pm, buildCommand: build, startCommand: start ?? (entry ? `node ${entry}` : undefined), port: 3000, notes: start || entry ? notes : [...notes, 'No start script or entry file found; set a start command.'] };
  }

  // 4. Python
  if (has(files, /requirements\.txt$|pyproject\.toml$|Pipfile$/)) {
    const reqs = allManifestText(manifests).toLowerCase();
    const pmgr = files.some((f) => /pyproject\.toml$/.test(f)) && reqs.includes('poetry') ? 'poetry' : files.some((f) => /pyproject\.toml$/.test(f)) ? 'pip' : 'pip';
    if (reqs.includes('fastapi')) { const mod = files.includes('main.py') ? 'main' : files.includes('app/main.py') ? 'app.main' : files.includes('app.py') ? 'app' : 'main'; return { ...base, stack: 'python-fastapi', runtime: 'python', packageManager: pmgr, startCommand: `uvicorn ${mod}:app --host 0.0.0.0 --port $PORT`, port: 8000, healthPath: '/' }; }
    if (reqs.includes('django')) return { ...base, stack: 'python-django', runtime: 'python', packageManager: pmgr, buildCommand: 'python manage.py collectstatic --noinput', startCommand: 'gunicorn $(ls */wsgi.py | head -1 | sed s,/wsgi.py,.wsgi,) --bind 0.0.0.0:$PORT', port: 8000 };
    if (reqs.includes('flask')) return { ...base, stack: 'python-flask', runtime: 'python', packageManager: pmgr, startCommand: 'gunicorn app:app --bind 0.0.0.0:$PORT', port: 8000 };
    return { ...base, stack: 'python', runtime: 'python', packageManager: pmgr, port: 8000, notes: [...notes, 'Python app; set a start command if detection is wrong.'] };
  }

  // 5. Go, Rust, PHP, static
  if (files.some((f) => /go\.mod$/.test(f))) return { ...base, stack: 'go', runtime: 'go', buildCommand: 'go build -o app .', startCommand: './app', port: PORT(allManifestText(manifests), 8080) };
  if (files.some((f) => /Cargo\.toml$/.test(f))) return { ...base, stack: 'rust', runtime: 'rust', port: 8080 };
  if (files.some((f) => /composer\.json$/.test(f))) return { ...base, stack: has(files, /artisan$/) ? 'laravel' : 'php', runtime: 'php', port: 80, healthPath: '/' };
  if (has(files, /(^|\/)index\.html$/)) return { ...base, stack: 'static', builder: 'static', staticDir: files.some((f) => /^(public|dist|site|_site)\/index\.html$/.test(f)) ? files.find((f) => /index\.html$/.test(f))!.replace(/\/index\.html$/, '') : '.', port: 80, notes: [...notes, 'Static HTML, served by Caddy.'] };

  return { ...base, notes: [...notes, 'Could not detect the stack. Add a Dockerfile, or set the build and start commands.'] };
}

// Every env var the code reads, so Sentinel can tell which are missing.
const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.environ(?:\.get)?\(?\[?['"]([A-Z][A-Z0-9_]+)['"]/g,
  /getenv\(['"]([A-Z][A-Z0-9_]+)['"]/g,
  /env\(['"]([A-Z][A-Z0-9_]+)['"]/g,            // Laravel, some Node config libs
  /ENV\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,          // Ruby
  /Deno\.env\.get\(['"]([A-Z][A-Z0-9_]+)['"]/g,
];
const ENV_IGNORE = /^(NODE_ENV|PORT|HOST|HOSTNAME|PWD|HOME|PATH|CI|TZ|LANG|USER|TERM|SHELL|npm_|VITE_USER_)/;

// What breaks when the app runs as two copies behind a load balancer (Warden won't scale it until fixed).
export function scaleRisks(facts: RepoFacts): string[] {
  const t = (facts.traits ?? '') + '\n' + allManifestText(facts.manifests);
  const risks: string[] = [];
  if (/express-session|cookie-session|SESSION_DRIVER=file/.test(t) && !/connect-redis|RedisStore|connect-pg-simple|connect-mongo|SESSION_DRIVER=(redis|database)/.test(t)) risks.push('logins are kept in memory (sessions)');
  if (/socket\.io|"ws":|from ['"]ws['"]|require\(['"]ws['"]\)|channels|laravel\/reverb/.test(t)) risks.push('live connections (websockets) need sticky routing and Redis');
  if (/node-cron|@nestjs\/schedule|"cron":|APScheduler|celery.*beat|schedule:run/.test(t)) risks.push('scheduled jobs would run once per copy');
  if (/diskStorage|multer\(\s*\{\s*dest|MEDIA_ROOT|FILESYSTEM_DISK=local/.test(t)) risks.push('uploads are saved to the container’s own disk');
  if (/better-sqlite3|"sqlite3":|file:\.\/|\.sqlite['"]|sqlite:\/\//.test(t)) risks.push('the database is a SQLite file');
  if (/express-rate-limit/.test(t) && !/rate-limit-redis|RedisStore/.test(t)) risks.push('the rate limit lives in memory');
  return risks;
}
const healthRoute = (facts: RepoFacts) => /['"`]\/(health|healthz|api\/health|up|status)['"`]/.test(facts.traits ?? '');
const DEV_SERVER = /\b(next dev|vite(?!\s+(build|preview))\b|nodemon|ts-node-dev|runserver|flask run|--reload)\b/;
export const runsDevServer = (startCommand?: string) => !!startCommand && DEV_SERVER.test(startCommand);

export function scanEnvKeys(facts: RepoFacts): string[] {
  const found = new Set<string>();
  const text = (facts.sourceSample ?? '') + '\n' + Object.values(facts.manifests).join('\n');
  for (const re of ENV_PATTERNS) for (const m of text.matchAll(re)) if (!ENV_IGNORE.test(m[1]!)) found.add(m[1]!);
  if (facts.envExample) for (const line of facts.envExample.split('\n')) { const m = /^\s*([A-Z][A-Z0-9_]+)\s*=/.exec(line); if (m && !ENV_IGNORE.test(m[1]!)) found.add(m[1]!); }
  return [...found].sort();
}

function inferNeeds(facts: RepoFacts, deps: Record<string, string>): string[] {
  const needs = new Set<string>();
  const text = (facts.envExample ?? '') + allManifestText(facts.manifests) + (facts.sourceSample ?? '');
  const dep = (n: string) => n in deps;
  if (dep('pg') || dep('postgres') || dep('@prisma/client') || dep('drizzle-orm') || /postgres(ql)?:\/\//i.test(text) || /DATABASE_URL/.test(text) && /psycopg|asyncpg|sqlalchemy|django/i.test(text)) needs.add('postgres');
  if (dep('mysql') || dep('mysql2') || /mysql:\/\//i.test(text)) needs.add('mysql');
  if (dep('redis') || dep('ioredis') || /redis:\/\//i.test(text) || /REDIS_URL/.test(text)) needs.add('redis');
  if (dep('mongodb') || dep('mongoose') || /mongodb(\+srv)?:\/\//i.test(text)) needs.add('mongo');
  // a plain DATABASE_URL with no clearer hint defaults to postgres (the common case)
  if (!needs.size && /DATABASE_URL/.test(text)) needs.add('postgres');
  return [...needs];
}

const allManifestText = (m: Record<string, string>) => Object.values(m).join('\n');
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };

export const detectionSchema = z.object({
  stack: z.string(), builder: z.string(), port: z.number(), needs: z.array(z.string()), envKeys: z.array(z.string()),
  buildCommand: z.string().optional(), startCommand: z.string().optional(), staticDir: z.string().optional(),
});
