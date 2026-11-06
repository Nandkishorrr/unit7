// Dockerfiles Unit7 writes when a repo has none. Plain, readable, and shown in the deployment so
// nobody has to guess what was built. Public build-time variables (NEXT_PUBLIC_*, VITE_*…) become
// build args; secrets never enter an image.
import type { Detection } from '../connectors/detect.ts';
import { isPublicKey } from '../tools/env.ts';
import { DEFAULT, type Pin } from './pins.ts';

const node = (d: Detection) => `node:${d.nodeVersion ?? 22}-alpine`;
const nodeOpts = (d: Detection) => (d.nodeOptions ? `ENV NODE_OPTIONS=${JSON.stringify(d.nodeOptions)}\n` : '');
// the language versions the project asks for (src/deploy/pins.ts), else Unit7's known-good ones
const VERSION = /^\d+(\.\d+){0,2}(-[\w.]+)?$/;
const ver = (p: Pin | undefined, fallback: string) => (p && VERSION.test(p.version) ? p.version : fallback);
const PY = (d: Detection) => `python:${ver(d.pins?.python, DEFAULT.python)}-slim`;
const GO = (d: Detection) => `golang:${ver(d.pins?.go, DEFAULT.go)}-alpine`;
const RUST = (d: Detection) => `rust:${ver(d.pins?.rust, DEFAULT.rust)}-slim`;
const CADDY = 'caddy:2.11.7-alpine';

// The package manager at the version the project implies (src/deploy/pins.ts), never whatever is newest: corepack activates
// pnpm and Yarn at that major (inside corepack a project's own packageManager field wins anyway); npm is the one that comes
// with Node unless the project names one.
// ponytail: corepack ships with the Node images Unit7 builds on (18–24); Node 25+ would need `npm i -g corepack` first
const overrides = (pin?: Pin) => pin?.source === 'you' || pin?.source === 'unit7';
const pmEnv = (d: Detection) => (overrides(d.pins?.pm) ? 'ENV COREPACK_ENABLE_PROJECT_SPEC=0\n' : '');
export function install(pm?: string, pin?: Pin) {
  const v = pin && pin.tool === pm && VERSION.test(pin.version) ? pin.version : undefined;
  // a version picked over the repo's own packageManager field (a person's pick): corepack is told to use it anyway
  const prep = (name: string, version: string) => `${overrides(pin) ? 'export COREPACK_ENABLE_PROJECT_SPEC=0 && ' : ''}corepack enable${name === 'npm' ? ' npm' : ''} && corepack prepare ${name}@${version} --activate`;
  switch (pm) {
    case 'pnpm': return `${prep('pnpm', v ?? DEFAULT.pnpm)} && pnpm install --frozen-lockfile`;
    case 'yarn': return `${prep('yarn', v ?? DEFAULT.yarn)} && ${!v ? '(yarn install --frozen-lockfile || yarn install --immutable)' : parseInt(v, 10) >= 2 ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'}`;
    case 'bun': return `npm install -g bun@${v ?? DEFAULT.bun} && bun install --frozen-lockfile`;
    default: return `${v && pin!.source !== 'lockfile' ? `${prep('npm', v)} && (` : ''}([ -f package-lock.json ] && npm ci) || npm install${v && pin!.source !== 'lockfile' ? ')' : ''}`;
  }
}

const buildArgs = (keys: string[]) => keys.filter(isPublicKey).map((k) => `ARG ${k}\nENV ${k}=$${k}`).join('\n');
const sh = (c: string) => `["sh", "-c", ${JSON.stringify(c)}]`;

// Bumped whenever the generated Dockerfiles change how an app runs, so self-heal knows a failure came from an older one.
// 2: the app's folder belongs to its own user, data folders are made for it, and pnpm/Yarn never run at start.
export const DOCKERFILE_REV = 2;
// corepack's downloads where the app's user can read them too (root's home otherwise): a script that calls pnpm finds the
// same pnpm that installed the packages, instead of fetching another one that wants to reinstall them
const COREPACK_HOME = '/usr/local/share/corepack';
const dataDirs = (d: Detection) => (d.dataDirs ?? []).filter((x) => /^[a-z0-9][a-z0-9_.-]{0,40}$/i.test(x)).map((x) => `/app/${x}`);
const ownFolders = (d: Detection, user: string) => {
  const dirs = dataDirs(d);
  return `${dirs.length ? `mkdir -p ${dirs.join(' ')} && chown ${user} ${dirs.join(' ')} && ` : ''}chown ${user} /app && (chown -R ${user} /app/.next /app/dist /app/build 2>/dev/null; true)`;
};
// The start command, without pnpm or Yarn in front: run as the app's user they may fetch another version of themselves,
// find node_modules made by a different one and try to reinstall it (ERR_PNPM_..._REMOVE_MODULES_DIR). Node 22+ runs a
// package.json script itself (node --run); older Node uses npm, which comes with the image and never reinstalls.
export function startFor(d: Detection): string {
  const cmd = d.startCommand ?? 'npm start';
  const m = /^(?:pnpm|yarn)(?: run)? ([\w:.-]+)$/.exec(cmd.trim());
  if (!m || /^(install|add|i|dlx|exec|x)$/.test(m[1]!)) return cmd;
  return (d.nodeVersion ?? 22) >= 22 ? `node --run ${m[1]}` : `npm run ${m[1]}`;
}

const STATIC_CADDYFILE = String.raw`:80 {\n\troot * /srv\n\tencode zstd gzip\n\theader /assets/* Cache-Control "public, max-age=31536000, immutable"\n\ttry_files {path} {path}/ /index.html\n\tfile_server\n}\n`;

export function dockerfileFor(d: Detection, envKeys: string[]): string | undefined {
  const args = buildArgs(envKeys);
  if (d.builder === 'static') {
    const out = (d.staticDir ?? 'dist').replace(/^\.\/?/, '') || '.';
    if (!d.buildCommand) {
      // the files are copied into a first stage and pruned there, so .git, .env and Unit7's own
      // Dockerfile never reach a layer of the served image (.well-known is kept: it's meant to be public)
      return `FROM ${CADDY} AS files\nCOPY ${out === '.' ? '.' : out} /srv\nRUN find /srv -mindepth 1 -name '.*' ! -name .well-known -prune -exec rm -rf {} + && rm -f /srv/Dockerfile.unit7\n\nFROM ${CADDY}\nCOPY --from=files /srv /srv\nRUN printf '${STATIC_CADDYFILE}' > /etc/caddy/Caddyfile\nEXPOSE 80\n`;
    }
    return `FROM ${node(d)} AS build
WORKDIR /app
COPY package*.json pnpm-lock.yaml* pnpm-workspace.yaml* yarn.lock* bun.lockb* ./
${pmEnv(d)}RUN ${install(d.packageManager, d.pins?.pm)}
COPY . .
${args}
${nodeOpts(d)}RUN ${d.buildCommand}

FROM ${CADDY}
COPY --from=build /app/${out} /srv
RUN printf '${STATIC_CADDYFILE}' > /etc/caddy/Caddyfile
EXPOSE 80
`;
  }
  switch (d.runtime) {
    case 'node': {
      // the app's folder, its packages and the folders it keeps files in belong to the unprivileged user, so the app can
      // create its own folders (mkdir /app/data) and nothing at start needs root. The install's chown runs in the install's
      // own layer, so node_modules isn't stored twice.
      const corepack = d.packageManager === 'pnpm' || d.packageManager === 'yarn';
      return `FROM ${node(d)}
WORKDIR /app
ENV PORT=${d.port}
${corepack ? `ENV COREPACK_HOME=${COREPACK_HOME}\n` : ''}COPY --chown=node:node package*.json pnpm-lock.yaml* pnpm-workspace.yaml* yarn.lock* bun.lockb* ./
${pmEnv(d)}RUN ${install(d.packageManager, d.pins?.pm)} && chown -R node:node /app${corepack ? ` ${COREPACK_HOME}` : ''}
COPY --chown=node:node . .
${args}
${nodeOpts(d)}${d.buildCommand ? `RUN ${d.buildCommand}` : ''}
ENV NODE_ENV=production
# runtime caches (e.g. .next/cache) and the folders the app keeps files in must be writable by the unprivileged user
RUN ${ownFolders(d, 'node:node')}
USER node
EXPOSE ${d.port}
CMD ${sh(startFor(d))}
`;
    }
    case 'python': {
      const deps = d.packageManager === 'poetry'
        ? 'pip install --no-cache-dir poetry && poetry config virtualenvs.create false && poetry install --only main --no-root'
        : '([ -f requirements.txt ] && pip install --no-cache-dir -r requirements.txt) || ([ -f pyproject.toml ] && pip install --no-cache-dir .) || true';
      const server = d.stack === 'python-fastapi' ? 'uvicorn' : 'gunicorn';
      return `FROM ${PY(d)}
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=${d.port}
COPY . .
RUN ${deps} && (python -c "import ${server}" 2>/dev/null || pip install --no-cache-dir ${server})
${d.stack === 'python-django' ? 'RUN python manage.py collectstatic --noinput || true' : ''}
RUN useradd -m app && ${dataDirs(d).length ? `mkdir -p ${dataDirs(d).join(' ')} && ` : ''}chown -R app /app
USER app
EXPOSE ${d.port}
CMD ${sh(d.startCommand ?? `${server} main:app --bind 0.0.0.0:$PORT`)}
`;
    }
    case 'go':
      return `FROM ${GO(d)} AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app .

FROM alpine:3.22
RUN adduser -D app
COPY --from=build /app /app
USER app
ENV PORT=${d.port}
EXPOSE ${d.port}
CMD ["/app"]
`;
    case 'rust':
      return `FROM ${RUST(d)} AS build
WORKDIR /src
COPY . .
RUN cargo build --release && cp "target/release/$(grep -m1 '^name' Cargo.toml | sed 's/.*= *\\"\\(.*\\)\\"/\\1/')" /app

FROM debian:bookworm-slim
RUN useradd -m app
COPY --from=build /app /app
USER app
ENV PORT=${d.port}
EXPOSE ${d.port}
CMD ["/app"]
`;
    case 'php':
      return d.stack === 'laravel'
        ? `FROM composer:2 AS vendor
WORKDIR /app
COPY . .
RUN composer install --no-dev --optimize-autoloader --no-interaction --ignore-platform-reqs

FROM dunglas/frankenphp:1-php8.4
WORKDIR /app
COPY --from=vendor /app /app
ENV SERVER_NAME=:80
RUN chown -R www-data:www-data storage bootstrap/cache
EXPOSE 80
`
        : `FROM php:8.4-apache
COPY . /var/www/html/
EXPOSE 80
`;
  }
  return undefined;
}
