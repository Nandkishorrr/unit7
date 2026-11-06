// The server X-ray: one read-only SSH trip that lists everything on a machine (containers, compose
// projects, open ports, system services, PM2 apps, websites, cron jobs, PaaS folders, git checkouts),
// and the pure code that turns it into projects → parts, each with who runs it (its owner) and how much
// Unit7 understands it (trust). Nothing in the probes writes to disk or starts anything. Environment
// values are read only to find which host each app talks to; they're never stored or returned.
import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { cmd } from '../connectors/shell.ts';
import { Unit7Error } from '../errors.ts';
import { Redactor } from '../redact.ts';
import { envRefs, type Found, type Ref } from './model.ts';

export type Owner = 'coolify' | 'dokploy' | 'caprover' | 'dokku' | 'easypanel' | 'kamal' | 'portainer' | 'compose' | 'pm2' | 'systemd' | 'unit7' | 'unmanaged';
export type Trust = 'seen' | 'understood' | 'managed' | 'owned';
export type PartKind = 'app' | 'database' | 'service' | 'volume' | 'job' | 'domain';
export interface Health { status: 'ok' | 'warn' | 'bad' | 'off'; reason?: string }
export interface Port { port: number; proto: string; ip: string; public: boolean; blockedBy?: 'unit7' } // blockedBy: published, but Unit7's firewall rule keeps the internet out
export interface EnvHost { via: string; host?: string; ip?: string; supabase?: string }
export interface Repo { dir: string; remote?: string; last?: string; dirty: number }
export interface Part {
  id: string; kind: PartKind; name: string; owner: Owner; trust: Trust; project?: string;
  product?: { id: string; name: string };   // a known app (logo id + plain name)
  image?: string; state?: string; health?: Health; restarts?: number; startedAt?: string;
  containers?: string[];                    // its containers (several for a stack shown as one)
  match?: string[];                         // every name its containers answer to (names, coolify.name, short ids)
  internals?: { name: string; image: string; state: string }[];
  ports?: Port[]; networks?: string[]; envKeys?: string[]; env?: EnvHost[]; hosts?: string[];
  engine?: string; version?: string; exposed?: boolean; memLimit?: number;
  dir?: string; git?: Repo; uses?: string[]; volumes?: string[]; binds?: string[];
  schedule?: string; when?: string; command?: string; user?: string; file?: string;
  via?: string; target?: string;            // domains: how it's routed, and the part it reaches
  coolify?: { uuid: string; type: string; labels: 'uuid' | 'legacy'; preview?: number; environment?: string; repo?: string; branch?: string; buildPack?: string; status?: string; lastDeploy?: { uuid?: string; status?: string; at?: string; commit?: string }; health?: { enabled: boolean; path?: string; port?: string; custom?: boolean } };
  compose?: { project: string; service?: string; workingDir?: string; files?: string };
  pm2?: { mode?: string; instances?: number; home?: string };
  unit?: string;
}
export interface Project {
  id: string; name: string; owner: Owner; trust: Trust; how: string; confidence: number; system?: boolean;
  environments?: string[]; parts: string[]; health: Health; domains: string[]; dir?: string; git?: Repo; coolify?: { uuid?: string };
}
export interface Listener { proto: string; ip: string; port: number; public: boolean; process?: string; pid?: number; part?: string; blockedBy?: 'unit7' }
export interface DiskSummary { method: 'docker-api' | 'docker-cli'; images?: number; imagesUnused?: number; buildCache?: number; reclaimable?: number }
export interface Inventory {
  version: 1; at: string; ms?: number;
  server: { os?: string; cpus?: number; memTotal?: number; memAvailable?: number; diskTotal?: number; diskUsed?: number; load?: string; docker?: string; user?: string };
  paas: { id: string; name: string }[];
  coolify?: { version?: string; dashboard?: string; apiPort: number; running?: boolean; sentinel: boolean; proxy: boolean; connected?: string; abilities?: string[] };
  projects: Project[]; parts: Part[]; loose: string[]; ports: Listener[]; repos: Repo[];
  disk?: DiskSummary; summary: string; notes: string[];
  blocked?: { port: number; chains: string[] }[]; // ports Unit7 closed at the firewall (server.close_port's tagged rules)
}

// --- the probes ------------------------------------------------------------------------------------
// Sent over stdin (`sh -s`), so nothing of it is on a command line. Every command has its own time limit
// and swallows errors, so a missing tool is just an empty section.
const PRELUDE = `export LC_ALL=C PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin"
if command -v timeout >/dev/null 2>&1; then t() { n=$1; shift; timeout "$n" "$@" 2>/dev/null; }; else t() { shift; "$@" 2>/dev/null; }; fi
s() { printf '\\n@@unit7:%s\\n' "$1"; }
`;
export const XRAY_PROBE = PRELUDE + `s host
[ -f /etc/os-release ] && . /etc/os-release; echo "os=$PRETTY_NAME"; echo "cpus=$(nproc 2>/dev/null)"
awk '/^MemTotal/{print "mem_total=" $2*1024} /^MemAvailable/{print "mem_available=" $2*1024}' /proc/meminfo 2>/dev/null
df -P -B1 / 2>/dev/null | awk 'NR==2{print "disk_total=" $2; print "disk_used=" $3}'
echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"; echo "docker=$(t 5 docker version --format '{{.Server.Version}}')"; echo "user=$(id -un)"
command -v docker >/dev/null 2>&1 && echo "has_docker=1"
s ctrs
ids=$(t 5 docker ps -aq --no-trunc); [ -n "$ids" ] && t 20 docker inspect $ids
s volumes
t 5 docker volume ls -q
s dangling
t 5 docker volume ls -q -f dangling=true
s df
if command -v curl >/dev/null 2>&1 && [ -S /var/run/docker.sock ]; then t 8 curl -s --max-time 7 --unix-socket /var/run/docker.sock 'http://localhost/system/df?type=image&type=build-cache'; else t 8 docker system df --format '{{json .}}'; fi
s compose
t 5 docker compose ls -a --format json
s ports
t 5 ss -tulpnH
s pids
for p in $(t 5 ss -tlnpH | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -un); do echo "$p|$(readlink /proc/$p/cwd 2>/dev/null)|$(cat /proc/$p/comm 2>/dev/null)"; done
s units
u=$(t 5 systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}')
[ -n "$u" ] && t 5 systemctl show -p Id,MainPID,ActiveState,WorkingDirectory,ExecStart,FragmentPath,MemoryCurrent,User $u
s pm2
ps -eo pid=,args= 2>/dev/null | grep '[G]od Daemon'
for h in /root/.pm2 /home/*/.pm2; do [ -f "$h/dump.pm2" ] && { echo "##$h"; head -c 1000000 "$h/dump.pm2"; echo; }; done
s nginx
t 5 nginx -T | head -c 2000000
s caddy
[ -f /etc/caddy/Caddyfile ] && head -c 300000 /etc/caddy/Caddyfile
s traefik
for f in /data/coolify/proxy/dynamic/*.yaml /data/coolify/proxy/dynamic/*.yml /etc/dokploy/traefik/dynamic/*.yml; do [ -f "$f" ] && { echo "##$f"; head -c 100000 "$f"; echo; }; done
s cron
for f in /etc/crontab /etc/cron.d/* /var/spool/cron/crontabs/* /var/spool/cron/*; do [ -f "$f" ] && { echo "##$f"; grep -v '^[[:space:]]*#' "$f" | grep -v '^[[:space:]]*$' | head -200; }; done
s markers
for d in /data/coolify /etc/dokploy /captain /var/lib/dokku /home/dokku /etc/easypanel /home/clp /RunCloud /home/forge /home/ploi /opt/1panel /www/server/panel /usr/local/hestia /home/yellowtent; do [ -e "$d" ] && echo "$d"; done
for b in dokku kamal-proxy pm2; do command -v $b >/dev/null 2>&1 && echo "bin:$b"; done
[ -f /data/coolify/source/.env ] && grep -E '^APP_PORT=' /data/coolify/source/.env
s fw
SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"; for c in INPUT DOCKER-USER; do t 5 $SU iptables -S "$c" | grep -- 'unit7-close-'; done
s git
t 10 find /root /home /srv /opt /var/www -maxdepth 4 -name .git -type d -prune | head -100 | while IFS= read -r d; do r=\${d%/.git}; o=$(t 3 git -c safe.directory='*' -C "$r" remote get-url origin | sed 's#//[^/@]*@#//#'); l=$(t 3 git -c safe.directory='*' -C "$r" log -1 --format='%h %cI'); c=$(t 3 git -c safe.directory='*' -C "$r" status --porcelain | wc -l); echo "$r|$o|$l|$c"; done
`;

// Sizes: slow (seconds to minutes on a big disk), so a separate trip. Arguments name what to measure:
// bind:<path>, pg:<container>, my:<container>, redis:<container>. Database clients run inside their own
// container with its own settings, so no password crosses the wire or lands on a command line.
export const SIZES_PROBE = PRELUDE + `s df
d=''; if command -v curl >/dev/null 2>&1 && [ -S /var/run/docker.sock ]; then d=$(t 240 curl -s --max-time 230 --unix-socket /var/run/docker.sock http://localhost/system/df); fi
echo "$d"
s vols
[ -z "$d" ] && t 10 docker volume ls -q | while IFS= read -r v; do m=$(t 5 docker volume inspect -f '{{.Mountpoint}}' "$v"); echo "$v $(t 120 nice -n 19 du -sxb "$m" | cut -f1)"; done
s logs
t 10 docker ps -aq | while IFS= read -r c; do t 5 docker inspect -f '{{.Name}} {{.LogPath}}' "$c"; done | while read -r n p; do [ -n "$p" ] && echo "$n $(du -cb "$p"* 2>/dev/null | tail -1 | cut -f1)"; done
s items
for a in "$@"; do v=\${a#*:}; case "$a" in
  bind:*) echo "bind $(t 120 nice -n 19 du -sxb "$v" | cut -f1) $v" ;;
  pg:*) t 20 docker exec "$v" sh -c 'psql -U "\${POSTGRES_USER:-postgres}" -Atc "select datname, pg_database_size(datname) from pg_database where not datistemplate"' | while IFS='|' read -r n b; do echo "db $v $b $n"; done ;;
  my:*) t 20 docker exec "$v" sh -c 'export MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; q="select table_schema, sum(data_length+index_length) from information_schema.tables group by 1"; mysql -uroot -Nse "$q" 2>/dev/null || mariadb -uroot -Nse "$q"' | while read -r n b; do echo "db $v $b $n"; done ;;
  redis:*) t 10 docker exec "$v" sh -c 'REDISCLI_AUTH="\${REDIS_PASSWORD:-}" redis-cli INFO memory' | tr -d '\\r' | awk -F: -v c="$v" '/^used_memory:/{print "db " c " " $2 " memory"}' ;;
esac; done
`;

// Live usage: host totals, then Coolify's own monitor (Sentinel) when it runs, else docker stats. Sentinel's
// token stays inside its container: the shell there reads its own TOKEN and hands curl the header on stdin.
export const USAGE_PROBE = PRELUDE + `s host
head -1 /proc/stat; sleep 0.5; head -1 /proc/stat
echo "cpus=$(nproc 2>/dev/null)"
awk '/^MemTotal/{print "mem_total=" $2*1024} /^MemAvailable/{print "mem_available=" $2*1024}' /proc/meminfo
df -P -B1 / | awk 'NR==2{print "disk_total=" $2; print "disk_used=" $3}'
o=''
if t 5 docker ps --format '{{.Names}}' | grep -qx coolify-sentinel; then
  o=$(t 8 docker exec coolify-sentinel sh -c 'printf "Authorization: Bearer %s\\n" "$TOKEN" | curl -s -m 6 -H @- http://localhost:8888/api/containers/current')
fi
# with Coolify's metrics off the list is empty, or (Sentinel 1.1+) has a row per container with no numbers: docker stats then
case "$o" in
  '['*'"percent"'*) s sentinel; echo "$o" ;;
  *) s stats; t 20 docker stats --no-stream --format '{{json .}}' ;;
esac
`;

export function sections(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  const bits = `\n${out}`.split(/\n@@unit7:([a-z0-9_]+)\n/);
  for (let i = 1; i < bits.length; i += 2) r[bits[i]!] = (r[bits[i]!] ?? '') + (bits[i + 1] ?? '');
  return r;
}
const kv = (text = '') => Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const num = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
const lines = (t = '') => t.split('\n').map((l) => l.trim()).filter(Boolean);
const tryJson = <T>(t: string | undefined, fb: T): T => { try { return t?.trim() ? JSON.parse(t) as T : fb; } catch { return fb; } };
const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

// --- containers ------------------------------------------------------------------------------------
export interface Ctr {
  id: string; name: string; image: string; imageId?: string; state: string; health?: string; oom: boolean; exitCode?: number; restarts: number; startedAt?: string;
  labels: Record<string, string>; env: Record<string, string>; ports: Port[]; networks: { name: string; aliases: string[] }[];
  mounts: { type: string; name?: string; source?: string; dest: string }[]; restartPolicy?: string; pid?: number; memLimit?: number; logPath?: string;
}
const PUBLIC_IP = (ip: string) => !ip || ip === '0.0.0.0' || ip === '::' || ip === '*' || ip === '[::]';
export function parseInspect(text?: string): Ctr[] {
  const arr = tryJson<any[]>(text, []);
  return (Array.isArray(arr) ? arr : []).map((c): Ctr => {
    const env: Record<string, string> = {};
    for (const e of c.Config?.Env ?? []) { const i = String(e).indexOf('='); if (i > 0) env[String(e).slice(0, i)] = String(e).slice(i + 1); }
    const ports: Port[] = [];
    for (const [k, binds] of Object.entries<any>(c.NetworkSettings?.Ports ?? {})) {
      const [p, proto = 'tcp'] = k.split('/');
      for (const b of binds ?? []) ports.push({ port: Number(b.HostPort), proto, ip: b.HostIp ?? '', public: PUBLIC_IP(b.HostIp ?? '') });
      void p;
    }
    return {
      id: String(c.Id ?? '').slice(0, 12), name: String(c.Name ?? '').replace(/^\//, ''), image: c.Config?.Image ?? '', imageId: c.Image, state: c.State?.Status ?? 'unknown',
      health: c.State?.Health?.Status, oom: !!c.State?.OOMKilled, exitCode: c.State?.ExitCode, restarts: Number(c.RestartCount ?? 0), startedAt: c.State?.StartedAt,
      labels: c.Config?.Labels ?? {}, env, ports: ports.filter((x) => x.port > 0),
      networks: Object.entries<any>(c.NetworkSettings?.Networks ?? {}).map(([name, n]) => ({ name, aliases: [...new Set<string>([...(n?.Aliases ?? []), ...(n?.DNSNames ?? [])])] })),
      mounts: (c.Mounts ?? []).map((m: any) => ({ type: m.Type, name: m.Name, source: m.Source, dest: m.Destination })),
      restartPolicy: c.HostConfig?.RestartPolicy?.Name, pid: c.State?.Pid || undefined, memLimit: c.HostConfig?.Memory || undefined, logPath: c.LogPath,
    };
  });
}

// --- known apps, by image ----------------------------------------------------------------------------
export interface Print { id: string; name: string; kind: PartKind; engine?: string; stack?: boolean }
const PRINTS: [RegExp, Print][] = [
  [/(^|\/)supabase\/|^(kong\/)?kong:|^timberio\/vector|^darthsim\/imgproxy|envoyproxy\/envoy|postgrest\/postgrest/, { id: 'supabase', name: 'Supabase', kind: 'database', stack: true }],
  [/(^|\/)appwrite\//, { id: 'appwrite', name: 'Appwrite', kind: 'app', stack: true }],
  [/(^|\/)plausible\//, { id: 'plausible', name: 'Plausible', kind: 'app', stack: true }],
  [/(^|\/)(postgres|postgis\/postgis|pgvector\/pgvector|bitnami\/postgresql|timescale\/timescaledb[\w-]*)(:|$)/, { id: 'postgresql', name: 'PostgreSQL', kind: 'database', engine: 'postgres' }],
  [/(^|\/)(mysql|bitnami\/mysql)(:|$)/, { id: 'mysql', name: 'MySQL', kind: 'database', engine: 'mysql' }],
  [/(^|\/)(mariadb|bitnami\/mariadb)(:|$)/, { id: 'mariadb', name: 'MariaDB', kind: 'database', engine: 'mariadb' }],
  [/(^|\/)(mongo|bitnami\/mongodb)(:|$)/, { id: 'mongodb', name: 'MongoDB', kind: 'database', engine: 'mongo' }],
  [/(^|\/)(redis|bitnami\/redis|valkey\/valkey|eqalpha\/keydb|dragonflydb\/dragonfly)(:|$)/, { id: 'redis', name: 'Redis', kind: 'database', engine: 'redis' }],
  [/clickhouse\/clickhouse-server/, { id: 'clickhouse', name: 'ClickHouse', kind: 'database', engine: 'clickhouse' }],
  [/n8nio\/n8n/, { id: 'n8n', name: 'n8n', kind: 'app' }],
  [/pocketbase/, { id: 'pocketbase', name: 'PocketBase', kind: 'database' }],
  [/(^|\/)wordpress(:|$)/, { id: 'wordpress', name: 'WordPress', kind: 'app' }],
  [/(^|\/)ghost(:|$)/, { id: 'ghost', name: 'Ghost', kind: 'app' }],
  [/directus\/directus/, { id: 'directus', name: 'Directus', kind: 'app' }],
  [/strapi/, { id: 'strapi', name: 'Strapi', kind: 'app' }],
  [/louislam\/uptime-kuma/, { id: 'uptimekuma', name: 'Uptime Kuma', kind: 'app' }],
  [/umami/, { id: 'umami', name: 'Umami', kind: 'app' }],
  [/metabase\/metabase/, { id: 'metabase', name: 'Metabase', kind: 'app' }],
  [/minio\/minio/, { id: 'minio', name: 'MinIO', kind: 'service' }],
  [/ollama\/ollama/, { id: 'ollama', name: 'Ollama', kind: 'service' }],
  [/open-webui/, { id: 'openwebui', name: 'Open WebUI', kind: 'app' }],
  [/flowise/, { id: 'flowise', name: 'Flowise', kind: 'app' }],
  [/langgenius\/dify/, { id: 'dify', name: 'Dify', kind: 'app', stack: true }],
  [/gitea\/gitea/, { id: 'gitea', name: 'Gitea', kind: 'app' }],
  [/(^|\/)nextcloud(:|$)/, { id: 'nextcloud', name: 'Nextcloud', kind: 'app' }],
  [/vaultwarden\/server/, { id: 'vaultwarden', name: 'Vaultwarden', kind: 'app' }],
  [/portainer\/portainer/, { id: 'portainer', name: 'Portainer', kind: 'service' }],
  [/(^|\/)traefik(:|$)/, { id: 'traefik', name: 'Traefik', kind: 'service' }],
  [/(^|\/)(nginx|nginxproxy\/nginx-proxy|jc21\/nginx-proxy-manager)(:|$)/, { id: 'nginx', name: 'nginx', kind: 'service' }],
  [/(^|\/)caddy(:|$)/, { id: 'caddy', name: 'Caddy', kind: 'service' }],
  // more self-hosted apps people run from Coolify / Dokploy / CapRover templates (serverapps/adapters.ts connects some)
  [/(^|\/)grafana\/grafana(-oss|-enterprise)?(:|$)/, { id: 'grafana', name: 'Grafana', kind: 'app' }],
  [/getmeili\/meilisearch/, { id: 'meilisearch', name: 'Meilisearch', kind: 'service' }],
  [/typesense\/typesense/, { id: 'typesense', name: 'Typesense', kind: 'service' }],
  [/listmonk\/listmonk/, { id: 'listmonk', name: 'Listmonk', kind: 'app' }],
  [/nocodb\/nocodb/, { id: 'nocodb', name: 'NocoDB', kind: 'app' }],
  [/forgejo\/forgejo/, { id: 'forgejo', name: 'Forgejo', kind: 'app' }],
];
const ENGINES: [RegExp, string][] = [
  [/(^|\/)(postgres|postgis\/postgis|pgvector\/pgvector|bitnami\/postgresql|timescale\/timescaledb[\w-]*|supabase\/postgres)(:|$)/, 'postgres'], [/(^|\/)(mysql|bitnami\/mysql)(:|$)/, 'mysql'],
  [/(^|\/)(mariadb|bitnami\/mariadb)(:|$)/, 'mariadb'], [/(^|\/)(mongo|bitnami\/mongodb)(:|$)/, 'mongo'], [/(^|\/)(redis|bitnami\/redis|valkey\/valkey|eqalpha\/keydb|dragonflydb\/dragonfly)(:|$)/, 'redis'],
  [/clickhouse\/clickhouse-server/, 'clickhouse'],
];
export const engineOf = (image: string) => ENGINES.find(([re]) => re.test(image.toLowerCase()))?.[1];
export const fingerprint = (image: string, name = ''): Print | undefined =>
  PRINTS.find(([re]) => re.test(image.toLowerCase()))?.[1] ?? (/^supabase-|supabase-realtime|^realtime-dev\.supabase/.test(name) ? PRINTS[0]![1] : undefined);
const versionOf = (image: string) => /:v?(\d+(?:\.\d+)?)/.exec(image)?.[1];

// --- who runs a container ----------------------------------------------------------------------------
export interface Owned {
  owner: Owner; part: string; group?: string; groupName?: string; how?: string; system?: boolean; name?: string;
  coolify?: Part['coolify']; environment?: string; kind?: PartKind;
}
const COOLIFY_SYSTEM = /^coolify(-(db|redis|realtime|proxy|sentinel|testing-host))?$/;
// The PaaS that owns a container decides how Unit7 may change it. Coolify writes both label generations:
// numeric coolify.{type}Id up to 4.3 (those containers keep them until their next deploy) and coolify.{type}Uuid
// from 4.4; with the old ones, com.docker.compose.project is the resource UUID (what Coolify itself uses).
export function ownerOf(c: Pick<Ctr, 'name' | 'image' | 'labels'>, markers: Set<string> = new Set()): Owned {
  const l = c.labels ?? {}, name = c.name;
  const swarm = l['com.docker.swarm.service.name'], compose = l['com.docker.compose.project'], workdir = l['com.docker.compose.project.working_dir'] ?? '';
  if (l['unit7.service']) return { owner: 'unit7', part: `unit7:${l['unit7.service']}`, group: 'unit7:apps', groupName: 'Unit7', how: 'Unit7 labels' };
  if (name === 'unit7-caddy' || /^unit7-/.test(name)) return { owner: 'unit7', part: `c:${name}`, group: 'unit7:system', groupName: 'Unit7 itself', how: 'Unit7 labels', system: true, kind: 'service' };
  if (COOLIFY_SYSTEM.test(name) || (l['coolify.managed'] === 'true' && !l['coolify.type'])) return { owner: 'coolify', part: `c:${name}`, group: 'coolify:system', groupName: 'Coolify itself', how: 'Coolify labels', system: true, kind: 'service' };
  if (l['coolify.managed'] === 'true' || l['coolify.type']) {
    const type = l['coolify.type'] ?? 'application';
    const fresh = l[`coolify.${type}Uuid`];
    const uuid = fresh ?? ((l[`coolify.${type}Id`] ? compose ?? l['com.docker.stack.namespace'] : undefined) ?? compose ?? name);
    const project = l['coolify.projectName'] || 'coolify';
    return {
      owner: 'coolify', part: `coolify:${uuid}`, group: `coolify:${project}`, groupName: project, how: 'Coolify labels', environment: l['coolify.environmentName'],
      name: l['coolify.resourceName'] || (type === 'service' ? l['coolify.serviceName'] : undefined) || l['coolify.name'] || name, kind: type === 'database' ? 'database' : undefined,
      coolify: { uuid, type, labels: fresh ? 'uuid' : 'legacy', ...(Number(l['coolify.pullRequestId'] ?? 0) > 0 && { preview: Number(l['coolify.pullRequestId']) }), ...(l['coolify.environmentName'] && { environment: l['coolify.environmentName'] }) },
    };
  }
  if (l['com.dokku.app-name']) return { owner: 'dokku', part: `dokku:${l['com.dokku.app-name']}:${l['com.dokku.process-type'] ?? 'web'}`, group: `dokku:${l['com.dokku.app-name']}`, groupName: l['com.dokku.app-name'], how: 'Dokku labels' };
  if (swarm?.startsWith('srv-captain--')) return { owner: 'caprover', part: `caprover:${swarm.slice(13)}`, group: `caprover:${swarm.slice(13)}`, groupName: swarm.slice(13), how: 'CapRover names' };
  if (swarm?.startsWith('captain-') || /^captain-/.test(name)) return { owner: 'caprover', part: `c:${swarm ?? name}`, group: 'caprover:system', groupName: 'CapRover itself', how: 'CapRover names', system: true, kind: 'service' };
  if (/^dokploy(-postgres|-redis|-traefik)?$/.test(swarm ?? name)) return { owner: 'dokploy', part: `c:${swarm ?? name}`, group: 'dokploy:system', groupName: 'Dokploy itself', how: 'Dokploy names', system: true, kind: 'service' };
  if (markers.has('/etc/dokploy') && (workdir.startsWith('/etc/dokploy/') || swarm)) {
    const app = compose ?? swarm!;
    return { owner: 'dokploy', part: swarm ? `dokploy:${swarm}` : `c:${name}`, group: `dokploy:${app}`, groupName: app, how: 'Dokploy folders' };
  }
  if (swarm === 'easypanel' || /^easypanel/.test(name)) return { owner: 'easypanel', part: `c:${name}`, group: 'easypanel:system', groupName: 'Easypanel itself', how: 'Easypanel names', system: true, kind: 'service' };
  if (markers.has('/etc/easypanel') && swarm?.includes('_')) { const p = swarm.split('_')[0]!; return { owner: 'easypanel', part: `easypanel:${swarm}`, group: `easypanel:${p}`, groupName: p, how: 'Easypanel names' }; }
  if (name === 'kamal-proxy') return { owner: 'kamal', part: 'c:kamal-proxy', group: 'kamal:system', groupName: 'Kamal proxy', how: 'Kamal names', system: true, kind: 'service' };
  if (l.service && l.role && (markers.has('bin:kamal-proxy') || markers.has('kamal'))) {
    const key = `${l.service}${l.destination ? `-${l.destination}` : ''}`;
    return { owner: 'kamal', part: `kamal:${key}:${l.role}`, group: `kamal:${key}`, groupName: key, how: 'Kamal labels', name: `${l.service} ${l.role}` };
  }
  if (/portainer\/portainer/.test(c.image)) return { owner: 'portainer', part: `c:${name}`, group: 'portainer:system', groupName: 'Portainer itself', how: 'its image', system: true, kind: 'service' };
  if (compose) return { owner: workdir.startsWith('/data/compose/') && markers.has('portainer') ? 'portainer' : 'compose', part: `c:${name}`, group: `compose:${compose}`, groupName: compose, how: 'Docker Compose labels', name: l['com.docker.compose.service'] };
  if (l['com.docker.stack.namespace']) return { owner: 'compose', part: `c:${name}`, group: `stack:${l['com.docker.stack.namespace']}`, groupName: l['com.docker.stack.namespace'], how: 'Swarm stack labels' };
  return { owner: 'unmanaged', part: `c:${name}` };
}

export const OWNER_NAME: Record<Owner, string> = {
  coolify: 'Coolify', dokploy: 'Dokploy', caprover: 'CapRover', dokku: 'Dokku', easypanel: 'Easypanel', kamal: 'Kamal', portainer: 'Portainer',
  compose: 'Docker Compose', pm2: 'PM2', systemd: 'systemd', unit7: 'Unit7', unmanaged: 'nothing',
};
// PaaSes whose next deploy would undo a change made behind their back: Unit7 changes their things through them.
export const PAAS_OWNERS = new Set<Owner>(['coolify', 'dokploy', 'caprover']);

// Refuse to change a container that a PaaS runs (it would undo the change on its next deploy). For Coolify
// the error names the coolify.* call that does the same thing properly.
export async function guardContainer(app: App, s: ServerRow, container: string) {
  const r = await ssh(app).exec(s, cmd('docker', 'inspect', '-f', '{{json .Config.Labels}}', container), { timeoutMs: 20_000 });
  if (r.code !== 0) return; // no such container: the action itself says so
  const labels = tryJson<Record<string, string>>(r.stdout, {}) ?? {};
  const o = ownerOf({ name: container, image: '', labels });
  if (!PAAS_OWNERS.has(o.owner)) return;
  const who = OWNER_NAME[o.owner];
  if (o.owner === 'coolify' && o.coolify) {
    const kind = o.coolify.type === 'database' ? 'database' : o.coolify.type === 'service' ? 'service' : 'application';
    throw new Unit7Error('owned_by_paas', `${container} is run by Coolify, so Unit7 doesn't change it directly (Coolify would undo it on its next deploy). Change this through Coolify: use coolify.control with action "restart".`, 409,
      { owner: 'coolify', next: { tool: 'coolify.control', input: { serverId: s.id, uuid: o.coolify.uuid, kind, action: 'restart' } } });
  }
  throw new Unit7Error('owned_by_paas', `${container} is run by ${who}, so Unit7 doesn't change it directly (${who} would undo it). Change this through ${who}.`, 409, { owner: o.owner });
}

// --- the rest of the machine ---------------------------------------------------------------------------
export function parseListeners(text?: string): Listener[] {
  const out: Listener[] = [];
  for (const l of lines(text)) {
    const f = l.split(/\s+/);
    if (f.length < 5) continue;
    const local = f[4]!, i = local.lastIndexOf(':');
    const ip = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, ''), port = Number(local.slice(i + 1));
    if (!port) continue;
    const proc = /users:\(\("([^"]+)",pid=(\d+)/.exec(l);
    out.push({ proto: f[0]!, ip, port, public: PUBLIC_IP(ip), process: proc?.[1], pid: proc ? Number(proc[2]) : undefined });
  }
  return out.filter((x, n, a) => a.findIndex((y) => y.proto === x.proto && y.port === x.port && y.public === x.public) === n);
}

interface Unit { id: string; pid: number; dir?: string; exec?: string; file?: string; mem?: number; user?: string }
export function parseUnits(text?: string): Unit[] {
  return (text ?? '').split(/\n\s*\n/).map((b) => kv(b)).filter((u) => u.Id).map((u) => ({
    id: u.Id!, pid: Number(u.MainPID ?? 0), dir: u.WorkingDirectory || undefined, exec: /path=([^ ;]+)[^;]*argv\[\]=([^;]*)/.exec(u.ExecStart ?? '')?.[2]?.trim() || undefined,
    file: u.FragmentPath || undefined, mem: num(u.MemoryCurrent), user: u.User || undefined,
  }));
}
// Distribution units nobody deployed (left out), and host programs that are databases or web servers
const SYSTEM_UNIT = /^(ssh|sshd|cron|crond|atd|anacron|dbus|polkit|rsyslog|syslog|getty@.*|serial-getty@.*|user@.*|systemd-.*|snapd|snap\..*|docker|containerd|ufw|unattended-upgrades|networkd-dispatcher|multipathd|udisks2|ModemManager|packagekit|qemu-guest-agent|irqbalance|fwupd|thermald|chrony|chronyd|ntp|ntpsec|fail2ban|apparmor|accounts-daemon|cloud-.*|google-.*|walinuxagent|hv-kvp-daemon|haveged|lvm2-.*|mdmonitor|rpcbind|postfix(@.*)?|exim4|uuidd|upower|wpa_supplicant|NetworkManager|firewalld|tuned|auditd|kdump|monarx-agent|hostinger.*|tailscaled|rngd|smartd|lxcfs|iscsid|open-vm-tools|vgauth|serial-.*|console-.*|plymouth.*|blk-availability|setvtrgb|keyboard-setup|kmod.*|apport|rc-local|sysstat|zabbix-agent2?|node_exporter|netdata|cockpit|snmpd|named|unbound|dnsmasq|avahi-daemon|cups|smbd|nmbd|php[\d.]*-fpm)\.service$/;
const HOST_DB: [RegExp, string][] = [[/^postgresql(@.*)?\.service$/, 'postgres'], [/^(mysql|mysqld)\.service$/, 'mysql'], [/^mariadb\.service$/, 'mariadb'], [/^(redis|redis-server)(@.*)?\.service$/, 'redis'], [/^mongod\.service$/, 'mongo']];
const HOST_WEB = /^(nginx|apache2|httpd|caddy|openresty|lsws)\.service$/;
const SYSTEM_PROC = /^(sshd|systemd.*|chronyd|ntpd|dhclient|dnsmasq|rpcbind|rpc\.statd|containerd|dockerd|docker-proxy|master|exim4|sendmail|cupsd|avahi-daemon|snmpd|named|unbound|smbd|nmbd|monarx-agent|zabbix_agent.*|tailscaled|cloudflared|nginx|caddy|apache2|httpd|traefik|postgres|mysqld|mariadbd|redis-server|mongod|php-fpm.*|exim|dovecot|pure-ftpd|vsftpd|proftpd|lsof)$/;

interface Pm2 { name: string; cwd?: string; mode?: string; instances?: number; status?: string; env: Record<string, string>; home: string }
export function parsePm2(text?: string): { daemon: boolean; apps: Pm2[] } {
  const t = text ?? '';
  const apps: Pm2[] = [];
  for (const chunk of t.split(/^##/m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const home = chunk.slice(0, nl).trim();
    for (const p of tryJson<any[]>(chunk.slice(nl + 1), [])) {
      if (!p?.name) continue;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(typeof p.env === 'object' && p.env ? p.env : {})) if (typeof v === 'string') env[k] = v;
      apps.push({ name: String(p.name), cwd: p.pm_cwd, mode: p.exec_mode, instances: Number(p.instances) || undefined, status: p.status, env, home });
    }
  }
  return { daemon: /God Daemon/.test(t.split(/^##/m)[0] ?? ''), apps };
}

export function parseRepos(text?: string): Repo[] {
  return lines(text).map((l) => { const [dir = '', remote = '', last = '', dirty = '0'] = l.split('|'); return { dir, remote: remote.replace(/\/\/[^/@]*@/, '//') || undefined, last: last || undefined, dirty: Number(dirty.trim()) || 0 }; }).filter((r) => r.dir.startsWith('/'));
}

// Websites: which hostname reaches which upstream (a port on this machine or a container name).
export interface Route { host: string; upstream?: string; port?: number; via: string }
export function parseNginx(text?: string): Route[] {
  const out: Route[] = [], upstreams = new Map<string, string>();
  const body = (text ?? '').replace(/#.*$/gm, '');
  for (const m of body.matchAll(/upstream\s+([\w.-]+)\s*\{([^}]*)\}/g)) { const s = /server\s+([^\s;]+)/.exec(m[2]!)?.[1]; if (s) upstreams.set(m[1]!, s); }
  for (const block of serverBlocks(body)) {
    const names = [...block.matchAll(/server_name\s+([^;]+);/g)].flatMap((m) => m[1]!.split(/\s+/)).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h));
    const pass = /proxy_pass\s+https?:\/\/([^;/\s]+)/.exec(block)?.[1];
    const target = pass && (upstreams.get(pass) ?? pass);
    const port = target ? Number(/:(\d+)$/.exec(target)?.[1]) || undefined : undefined;
    for (const h of names) out.push({ host: h.toLowerCase(), upstream: target, port, via: 'nginx on the server' });
  }
  return out;
}
function serverBlocks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bserver\s*\{/g)) {
    let depth = 1, i = m.index! + m[0].length;
    for (; i < text.length && depth; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
    out.push(text.slice(m.index!, i));
  }
  return out;
}
export function parseCaddyfile(text?: string): Route[] {
  const out: Route[] = [];
  let depth = 0, hosts: string[] = [];
  for (const raw of (text ?? '').split('\n')) {
    const l = raw.replace(/#.*$/, '').trim();
    if (!l) continue;
    if (depth === 0 && l.endsWith('{') && !l.startsWith('(') && l !== '{') hosts = l.slice(0, -1).split(/[\s,]+/).map((h) => h.replace(/^https?:\/\//, '').replace(/:\d+$/, '')).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h));
    const rp = depth >= 1 ? /^reverse_proxy\s+(\S+)/.exec(l)?.[1] : undefined;
    if (rp && hosts.length) for (const h of hosts) out.push({ host: h.toLowerCase(), upstream: rp.replace(/^https?:\/\//, ''), port: Number(/:(\d+)$/.exec(rp)?.[1]) || undefined, via: 'Caddy on the server' });
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
    if (depth <= 0) { depth = 0; if (l === '}') hosts = []; }
  }
  return out.filter((r, i, a) => a.findIndex((x) => x.host === r.host) === i);
}
const hostsOfRule = (rule: string) => [...rule.matchAll(/Host\(([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/[`"']([^`"']+)[`"']/g)].map((x) => x[1]!.toLowerCase()));
export function parseTraefikFiles(text?: string): { routes: Route[]; dashboard?: string } {
  const routes: Route[] = [];
  let dashboard: string | undefined;
  for (const chunk of (text ?? '').split(/^##/m).slice(1)) {
    const file = chunk.slice(0, chunk.indexOf('\n')).trim();
    if (/\/unit7-[^/]*$/.test(file)) continue; // Unit7's own routes: Unit7 knows them
    const hosts = [...chunk.matchAll(/rule:\s*['"]?(.*Host\(.*)$/gm)].flatMap((m) => hostsOfRule(m[1]!));
    const url = /url:\s*['"]?https?:\/\/([^'"\s/]+)/.exec(chunk)?.[1];
    if (/\/coolify\.ya?ml$/.test(file) || /coolify:8080/.test(url ?? '')) { dashboard ??= hosts[0]; continue; }
    for (const h of hosts) routes.push({ host: h, upstream: url, port: Number(/:(\d+)$/.exec(url ?? '')?.[1]) || undefined, via: 'Traefik on the server' });
  }
  return { routes, dashboard };
}
// hostnames a container is reachable at, from its own proxy labels (Traefik for Coolify, Dokploy and hand-rolled;
// Caddy labels when Coolify runs Caddy)
export function labelHosts(labels: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(labels)) {
    if (/^traefik\.https?\.routers\.[^.]+\.rule$/.test(k)) hostsOfRule(v).forEach((h) => out.add(h));
    if (/^caddy(_\d+)?$/.test(k)) for (const u of v.split(/[\s,]+/)) { const h = u.replace(/^https?:\/\//, '').replace(/[:/].*$/, '').toLowerCase(); if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) out.add(h); }
  }
  return [...out].filter((h) => !h.includes('*') && !/^\d+\.\d+\.\d+\.\d+$/.test(h));
}

interface Cron { schedule: string; user: string; command: string; file: string }
const DISTRO_CRON = /\/(e2scrub_all|popularity-contest|sysstat|php|anacron|certbot|mdadm|john|apt-compat|\.placeholder|zfsutils-linux|ntp|logrotate|man-db|dpkg|bsdmainutils|cron-apt|mlocate|plocate|sendmail|raid-check|0hourly|chkrootkit|needrestart|sa-update|update-notifier-common|sysstat|monarx.*|hostinger.*)$/;
export function parseCron(text?: string): Cron[] {
  const out: Cron[] = [];
  for (const chunk of (text ?? '').split(/^##/m).slice(1)) {
    const file = chunk.slice(0, chunk.indexOf('\n')).trim();
    if (DISTRO_CRON.test(file)) continue;
    const system = !/\/spool\/cron\//.test(file);
    for (const l of lines(chunk.slice(chunk.indexOf('\n') + 1))) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(l) || /run-parts|^#/.test(l)) continue;
      const f = l.split(/\s+/);
      const at = f[0]!.startsWith('@') ? 1 : 5;
      if (f.length < at + (system ? 2 : 1)) continue;
      out.push({ schedule: f.slice(0, at).join(' '), user: system ? f[at]! : base(file), command: f.slice(at + (system ? 1 : 0)).join(' '), file });
    }
  }
  return out;
}
// "every day at 03:00", "every 5 minutes"; anything else stays as written
export function scheduleInWords(s: string): string {
  const named: Record<string, string> = { '@reboot': 'when the server starts', '@hourly': 'every hour', '@daily': 'every day at midnight', '@midnight': 'every day at midnight', '@weekly': 'every week', '@monthly': 'every month', '@yearly': 'every year', '@annually': 'every year' };
  if (named[s]) return named[s]!;
  const [m, h, dom, mon, dow] = s.split(' ');
  const at = (hh: string, mm: string) => `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'every minute';
  if (/^\*\/\d+$/.test(m!) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${m!.slice(2)} minutes`;
  if (/^\d+$/.test(m!) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `every hour at :${m!.padStart(2, '0')}`;
  if (/^\d+$/.test(m!) && /^\d+$/.test(h!) && dom === '*' && mon === '*' && dow === '*') return `every day at ${at(h!, m!)}`;
  if (/^\d+$/.test(m!) && /^\d+$/.test(h!) && dom === '*' && mon === '*' && /^\d$/.test(dow!)) return `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][Number(dow)]} at ${at(h!, m!)}`;
  return s;
}

export function parseDisk(text?: string): DiskSummary | undefined {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  const j = tryJson<any>(t, undefined);
  if (j && (j.Images || j.LayersSize !== undefined)) {
    const images = (j.Images ?? []) as { Size?: number; SharedSize?: number; Containers?: number }[];
    const cache = (j.BuildCache ?? []) as { Size?: number; InUse?: boolean; Shared?: boolean }[];
    const unused = images.filter((i) => !i.Containers).reduce((s, i) => s + Math.max(0, (i.Size ?? 0) - Math.max(0, i.SharedSize ?? 0)), 0);
    const bc = cache.reduce((s, c) => s + (c.Size ?? 0), 0), bcFree = cache.filter((c) => !c.InUse).reduce((s, c) => s + (c.Size ?? 0), 0);
    return { method: 'docker-api', images: Number(j.LayersSize ?? images.reduce((s, i) => s + (i.Size ?? 0), 0)), imagesUnused: unused, buildCache: bc, reclaimable: unused + bcFree };
  }
  const rows = lines(t).map((l) => tryJson<Record<string, string>>(l, {}));
  const row = (type: string) => rows.find((r) => r.Type === type);
  const lead = (s?: string) => bytes(s?.split(' ')[0]);
  return { method: 'docker-cli', images: bytes(row('Images')?.Size), imagesUnused: lead(row('Images')?.Reclaimable), buildCache: bytes(row('Build Cache')?.Size), reclaimable: lead(row('Images')?.Reclaimable) + lead(row('Build Cache')?.Reclaimable) };
}
// "12.3MiB", "1.2GB", "512kB" → bytes
export function bytes(s?: string): number {
  const m = /([\d.]+)\s*([kKMGTP]?i?B)?/.exec(s ?? '');
  if (!m) return 0;
  const unit = (m[2] ?? 'B').replace('i', '').toUpperCase();
  const pow = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 }[unit] ?? 0;
  return Math.round(Number(m[1]) * (m[2]?.includes('i') ? 1024 : 1000) ** pow);
}

// --- building the inventory -------------------------------------------------------------------------
export interface Known {
  unit7?: Record<string, { name: string; project?: string }>; // Unit7's own services by id
  serverHost?: string; coolify?: { accountId?: string; managed?: boolean; abilities?: string[] };
}
const NOISE_ENV = /^(PATH|HOME|HOSTNAME|TERM|LANG|LC_ALL|LANGUAGE|PWD|OLDPWD|SHLVL|SHELL|USER|LOGNAME|_|NODE_VERSION|YARN_VERSION|NPM_VERSION|PYTHON_VERSION|PYTHON_SHA256|PYTHON_PIP_VERSION|PIP_[A-Z_]+|GPG_KEY|GOSU_VERSION|PG_MAJOR|PG_VERSION|PGDATA|JAVA_HOME|JAVA_VERSION|GOLANG_VERSION|GOPATH|RUBY_[A-Z_]+|BUNDLE_[A-Z_]+|GEM_HOME|PHP_[A-Z_]+|NGINX_VERSION|NJS_[A-Z_]+|PKG_RELEASE|DYNPKG_RELEASE|REDIS_VERSION|REDIS_DOWNLOAD_[A-Z_]+|MONGO_[A-Z_]*VERSION|MYSQL_MAJOR|MYSQL_VERSION|MARIADB_VERSION|DEBIAN_FRONTEND|TZ|COOLIFY_[A-Z_]+|SOURCE_COMMIT|PM2_[A-Z_]+|pm_[a-z_]+|NODE_APP_INSTANCE|SUDO_[A-Z_]+|XDG_[A-Z_]+|SSH_[A-Z_]+|MAIL|LS_COLORS|MOTD_SHOWN|DBUS_[A-Z_]+|unique_id|windowsHide|kill_retry_time)$/;
const keysOf = (env: Record<string, string>) => Object.keys(env).filter((k) => !NOISE_ENV.test(k)).sort();
const hostsIn = (env: Record<string, string>): EnvHost[] => envRefs('', env).map(({ from: _f, kind: _k, ...r }) => r);
const SHARED_NETS = new Set(['bridge', 'host', 'none', 'coolify', 'unit7', 'dokploy-network', 'captain-overlay-network', 'ingress', 'kamal', 'easypanel']);

// a part of one container says its own plain name; a stack names the container inside it that has the problem
// Docker leaves a container stopped only when someone stopped it, or "on-failure" gave up: a crash under any
// other restart rule shows as restarting. Health checks only mean something while it runs.
const STOP_CODES = new Set([0, 137, 143]); // a clean exit, or docker stop's SIGTERM / SIGKILL
const healthOf = (cs: Ctr[], label?: string): Health => {
  const who = (c: Ctr) => label ?? c.name;
  const bad = cs.find((c) => c.state === 'restarting' || c.state === 'dead' || (c.state === 'running' && c.health === 'unhealthy') || (c.state === 'exited' && (c.oom || (c.restartPolicy === 'on-failure' && !STOP_CODES.has(c.exitCode ?? 0)))));
  if (bad) return { status: 'bad', reason: bad.oom ? `${who(bad)} ran out of memory and stopped` : bad.state === 'restarting' ? `${who(bad)} keeps restarting` : bad.health === 'unhealthy' ? `${who(bad)} fails its health check` : `${who(bad)} crashed and stopped (exit code ${bad.exitCode})` };
  const oom = cs.find((c) => c.oom);
  if (oom) return { status: 'warn', reason: `${who(oom)} ran out of memory${oom.restarts ? ` and restarted ${oom.restarts} times` : ''}` };
  const restarts = cs.find((c) => c.restarts >= 3);
  if (restarts) return { status: 'warn', reason: `${who(restarts)} restarted ${restarts.restarts} times` };
  if (cs.some((c) => c.state === 'running' && c.health === 'starting')) return { status: 'warn', reason: 'starting up' };
  if (cs.every((c) => c.state !== 'running')) return { status: 'off', reason: 'stopped' };
  const failed = cs.find((c) => c.state === 'exited' && !STOP_CODES.has(c.exitCode ?? 0));
  if (failed) return { status: 'warn', reason: `${who(failed)} stopped with an error (exit code ${failed.exitCode})` };
  return { status: 'ok' };
};
const RANK = { bad: 3, warn: 2, ok: 1, off: 0 } as const;
const worst = (hs: (Health | undefined)[]): Health => hs.filter(Boolean).sort((a, b) => RANK[b!.status] - RANK[a!.status])[0] ?? { status: 'ok' };

export function buildInventory(out: string, known: Known = {}, at = new Date().toISOString()): Inventory {
  const sec = sections(out);
  const host = kv(sec.host);
  const notes: string[] = [];
  const markers = new Set(lines(sec.markers));
  const ctrs = parseInspect(sec.ctrs);
  if (ctrs.some((c) => /portainer\/portainer/.test(c.image))) markers.add('portainer');
  if (ctrs.some((c) => c.name === 'kamal-proxy')) markers.add('kamal');
  const listeners = parseListeners(sec.ports);
  // Unit7's own firewall rules: a port Docker publishes is shut by its DOCKER-USER rule, a program's by its INPUT rule;
  // those no longer face the internet (everything below, exposed databases included, reads public)
  const blocks = parseBlocks(sec.fw);
  const shut = (port: number, chain: string) => !!blocks.get(port)?.has(chain);
  for (const c of ctrs) for (const x of c.ports) if (x.public && shut(x.port, 'DOCKER-USER')) Object.assign(x, { public: false, blockedBy: 'unit7' });
  for (const l of listeners) if (l.public && shut(l.port, l.process === 'docker-proxy' ? 'DOCKER-USER' : 'INPUT')) Object.assign(l, { public: false, blockedBy: 'unit7' });
  const pidInfo = new Map(lines(sec.pids).map((l) => { const [pid, cwd, comm] = l.split('|'); return [Number(pid), { cwd: cwd || undefined, comm: comm || undefined }] as const; }));
  const repos = parseRepos(sec.git);
  const rootOf = (dir?: string) => dir ? repos.filter((r) => dir === r.dir || dir.startsWith(`${r.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]?.dir ?? dir.replace(/\/+$/, '') : undefined;

  const parts = new Map<string, Part>();
  const groups = new Map<string, { name: string; owner: Owner; how: string; confidence: number; system?: boolean; dir?: string; environments: Set<string> }>();
  const groupOf = new Map<string, string>(); // part id -> group key
  const envOf = new Map<string, Record<string, string>>(); // part id -> settings (values stay in this function)
  const ctrsOf = new Map<string, Ctr[]>();
  const group = (key: string, g: { name: string; owner: Owner; how: string; confidence?: number; system?: boolean; dir?: string }) => {
    if (!groups.has(key)) groups.set(key, { ...g, confidence: g.confidence ?? 0.95, environments: new Set() });
    return key;
  };

  // 1. containers → parts, grouped by who runs them (PaaS labels, then compose)
  for (const c of ctrs) {
    const o = ownerOf(c, markers);
    if (o.owner === 'unit7' && o.part.startsWith('unit7:svc')) {
      const svc = known.unit7?.[o.part.slice(6)];
      if (svc?.project) { o.group = `unit7:${svc.project}`; o.groupName = svc.project; }
      o.name = svc?.name;
    }
    ctrsOf.set(o.part, [...(ctrsOf.get(o.part) ?? []), c]);
    const p = parts.get(o.part);
    const env = { ...(envOf.get(o.part) ?? {}), ...c.env };
    envOf.set(o.part, env);
    if (p) { p.containers!.push(c.name); continue; }
    parts.set(o.part, {
      id: o.part, kind: o.kind ?? 'app', name: o.name ?? c.name, owner: o.owner, trust: 'seen', containers: [c.name],
      ...(o.coolify && { coolify: o.coolify }),
      ...(c.labels['com.docker.compose.project'] && !o.coolify && { compose: { project: c.labels['com.docker.compose.project']!, service: c.labels['com.docker.compose.service'], workingDir: c.labels['com.docker.compose.project.working_dir'], files: c.labels['com.docker.compose.project.config_files'] } }),
    });
    if (o.group) {
      group(o.group, { name: o.groupName ?? o.group, owner: o.owner, how: o.how ?? 'labels', system: o.system, dir: c.labels['com.docker.compose.project.working_dir'] });
      groupOf.set(o.part, o.group);
      if (o.environment) groups.get(o.group)!.environments.add(o.environment);
    }
  }
  // docker compose ls knows each project's files: its folder, when the containers' labels don't say
  for (const c of tryJson<{ Name?: string; ConfigFiles?: string }[]>(sec.compose, [])) {
    const g = groups.get(`compose:${c.Name}`);
    if (g && !g.dir && c.ConfigFiles) g.dir = c.ConfigFiles.split(',')[0]!.replace(/\/[^/]+$/, '');
  }
  // fill in each container part: image, state, health, ports, product, database facts
  for (const [id, cs] of ctrsOf) {
    const p = parts.get(id)!;
    const prints = cs.map((c) => fingerprint(c.image, c.name)).filter(Boolean) as Print[];
    const stack = prints.find((x) => x.stack && prints.filter((y) => y.id === x.id).length >= 2) ?? (cs.length > 1 ? prints.find((x) => x.stack) : undefined);
    const print = stack ?? (cs.length === 1 ? prints[0] : prints.find((x) => x.kind === 'app')) ;
    const dbCtr = cs.find((c) => engineOf(c.image));
    const main = cs.find((c) => !engineOf(c.image)) ?? cs[0]!;
    Object.assign(p, {
      image: main.image, state: cs.some((c) => c.state === 'running') ? 'running' : main.state, health: healthOf(cs, cs.length === 1 ? p.name : undefined), restarts: Math.max(...cs.map((c) => c.restarts)), startedAt: main.startedAt,
      match: [...new Set(cs.flatMap((c) => [c.name, c.id, c.labels['coolify.name']].filter(Boolean) as string[]))],
      ports: cs.flatMap((c) => c.ports), networks: [...new Set(cs.flatMap((c) => c.networks.map((n) => n.name)))], envKeys: keysOf(envOf.get(id)!), env: hostsIn(envOf.get(id)!),
      binds: [...new Set(cs.flatMap((c) => c.mounts.filter((m) => m.type === 'bind' && m.source).map((m) => m.source!)))], memLimit: main.memLimit,
      ...(cs.length > 1 && { internals: cs.map((c) => ({ name: c.name, image: c.image, state: c.state })) }),
    });
    if (print) {
      p.product = { id: print.id, name: print.name };
      if (p.owner !== 'unit7' && !p.coolify?.type?.startsWith('app')) p.kind = p.kind === 'service' ? 'service' : print.kind;
      if (p.coolify?.type === 'application') p.kind = 'app';
      if (cs.length > 1 && !p.coolify && stack) p.name = print.name;
    }
    if (dbCtr) {
      p.engine = engineOf(dbCtr.image); p.version = versionOf(dbCtr.image);
      if (cs.length === 1 && p.kind !== 'service') p.kind = 'database';
      // a database port published by Docker is on the internet whatever the firewall says
      p.exposed = cs.some((c) => engineOf(c.image) && c.ports.some((x) => x.public));
    }
  }
  // a product made of several containers (Supabase's dozen) shows as one thing inside its project
  for (const [gk] of groups) {
    const members = [...parts.values()].filter((p) => groupOf.get(p.id) === gk && !p.coolify);
    for (const pid of new Set(members.map((p) => (ctrsOf.get(p.id) ?? []).map((c) => fingerprint(c.image, c.name)).find((x) => x?.stack)?.id).filter(Boolean) as string[])) {
      const same = members.filter((p) => (ctrsOf.get(p.id) ?? []).some((c) => fingerprint(c.image, c.name)?.id === pid));
      if (same.length >= 2) collapse(same, `stack:${gk}:${pid}`, PRINTS.find(([, x]) => x.id === pid)![1], gk);
    }
  }
  // loose Supabase (or other stack) containers with no compose project: one project of their own
  const looseStacks = new Map<string, Part[]>();
  for (const p of parts.values()) {
    if (groupOf.has(p.id) || p.owner !== 'unmanaged') continue;
    const s = (ctrsOf.get(p.id) ?? []).map((c) => fingerprint(c.image, c.name)).find((x) => x?.stack);
    if (s) looseStacks.set(s.id, [...(looseStacks.get(s.id) ?? []), p]);
  }
  for (const [pid, same] of looseStacks) {
    if (same.length < 2) continue;
    const pr = PRINTS.find(([, x]) => x.id === pid)![1];
    const gk = group(`fp:${pid}`, { name: pr.name, owner: 'unmanaged', how: 'known images', confidence: 0.8 });
    collapse(same, `stack:${gk}:${pid}`, pr, gk);
  }
  function collapse(same: Part[], id: string, pr: Print, gk: string) {
    const cs = same.flatMap((p) => ctrsOf.get(p.id) ?? []);
    const env = Object.assign({}, ...same.map((p) => envOf.get(p.id) ?? {}));
    for (const p of same) { parts.delete(p.id); groupOf.delete(p.id); ctrsOf.delete(p.id); envOf.delete(p.id); }
    const db = cs.find((c) => engineOf(c.image));
    const merged: Part = {
      id, kind: pr.kind, name: pr.name, owner: same[0]!.owner, trust: 'seen', product: { id: pr.id, name: pr.name }, image: db?.image ?? cs[0]!.image,
      state: cs.some((c) => c.state === 'running') ? 'running' : cs[0]!.state, health: healthOf(cs), restarts: Math.max(...cs.map((c) => c.restarts)),
      containers: cs.map((c) => c.name), match: [...new Set(cs.flatMap((c) => [c.name, c.id]))], internals: cs.map((c) => ({ name: c.name, image: c.image, state: c.state })),
      ports: cs.flatMap((c) => c.ports), networks: [...new Set(cs.flatMap((c) => c.networks.map((n) => n.name)))], envKeys: keysOf(env), env: hostsIn(env),
      binds: [...new Set(cs.flatMap((c) => c.mounts.filter((m) => m.type === 'bind' && m.source).map((m) => m.source!)))],
      ...(same[0]!.compose && { compose: { ...same[0]!.compose, service: undefined } }),
      ...(db && { engine: engineOf(db.image), version: versionOf(db.image), exposed: db.ports.some((x) => x.public) }),
    };
    parts.set(id, merged); groupOf.set(id, gk); ctrsOf.set(id, cs); envOf.set(id, env);
  }

  // 2. PM2 apps, system services, and programs listening on a port on their own
  const pm2 = parsePm2(sec.pm2);
  for (const a of pm2.apps) {
    const id = `pm2:${a.name}`;
    parts.set(id, { id, kind: 'app', name: a.name, owner: 'pm2', trust: 'seen', dir: a.cwd, envKeys: keysOf(a.env), env: hostsIn(a.env), pm2: { mode: a.mode, instances: a.instances, home: a.home },
      state: pm2.daemon ? (a.status === 'stopped' ? 'stopped' : 'running') : 'unknown', health: pm2.daemon ? (a.status === 'stopped' ? { status: 'off', reason: 'stopped in PM2' } : a.status === 'errored' ? { status: 'bad', reason: 'PM2 says it crashed' } : { status: 'ok' }) : { status: 'off', reason: 'PM2 isn’t running, so it isn’t either' } });
    envOf.set(id, a.env);
  }
  const units = parseUnits(sec.units);
  const unitOfPid = new Map<number, string>();
  for (const u of units) {
    const engine = HOST_DB.find(([re]) => re.test(u.id))?.[1];
    const web = HOST_WEB.test(u.id);
    const userMade = !!u.file?.startsWith('/etc/systemd/system/') && !SYSTEM_UNIT.test(u.id);
    if (!engine && !web && !userMade) continue;
    const id = `unit:${u.id}`;
    const name = u.id.replace(/\.service$/, '');
    parts.set(id, { id, kind: engine ? 'database' : web ? 'service' : 'app', name, owner: 'systemd', trust: 'seen', unit: u.id, dir: u.dir, command: u.exec, user: u.user, state: 'running', health: { status: 'ok' },
      ...(engine && { engine, product: PRINTS.find(([, x]) => x.engine === engine)?.[1] && { id: PRINTS.find(([, x]) => x.engine === engine)![1].id, name: PRINTS.find(([, x]) => x.engine === engine)![1].name } }) });
    if (web) groupOf.set(id, group('host:web', { name: 'Web server', owner: 'systemd', how: 'system services', system: true }));
    if (u.pid) unitOfPid.set(u.pid, id);
  }

  // 3. who answers on each port
  const byPublished = new Map<number, string>();
  for (const p of parts.values()) for (const x of p.ports ?? []) byPublished.set(x.port, p.id);
  for (const l of listeners) {
    const info = l.pid ? pidInfo.get(l.pid) : undefined;
    const cwd = info?.cwd;
    l.part = l.process === 'docker-proxy' ? byPublished.get(l.port)
      : (l.pid && unitOfPid.get(l.pid)) || [...parts.values()].find((p) => (p.owner === 'pm2' || p.owner === 'systemd') && p.dir && cwd && (cwd === p.dir || cwd.startsWith(`${p.dir}/`)))?.id;
    if (l.part) { const p = parts.get(l.part)!; if (p.owner !== 'unmanaged' && !(p.ports ?? []).some((x) => x.port === l.port)) p.ports = [...(p.ports ?? []), { port: l.port, proto: l.proto, ip: l.ip, public: l.public }]; continue; }
    const proc = l.process ?? info?.comm;
    if (!proc || SYSTEM_PROC.test(proc) || l.proto.startsWith('udp') || /^(127\.|::1$)/.test(l.ip) && !cwd) continue;
    const id = `p:${proc}:${l.port}`;
    if (!parts.has(id)) parts.set(id, { id, kind: 'app', name: `${proc} on port ${l.port}`, owner: 'unmanaged', trust: 'seen', dir: cwd, state: 'running', health: { status: 'ok' }, ports: [{ port: l.port, proto: l.proto, ip: l.ip, public: l.public }] });
    l.part = id;
  }
  for (const p of parts.values()) if (p.kind === 'database' && p.owner === 'systemd') p.exposed = listeners.some((l) => l.part === p.id && l.public);

  // 4. a folder (git checkout) joins PM2 apps, services and stray programs with the compose project in it; a
  // folder of its own makes a project when it's a git checkout or holds more than one thing
  const byRoot = new Map<string, Part[]>();
  for (const p of parts.values()) {
    const dir = p.dir ?? p.compose?.workingDir;
    if (!dir || (dir.split('/').filter(Boolean).length < 2 && !repos.some((r) => r.dir === dir))) continue; // "/" or "/root" says nothing
    const root = rootOf(dir)!;
    p.git = repos.find((r) => r.dir === root);
    if (groupOf.has(p.id)) continue;
    const existing = [...groups.entries()].find(([, g]) => g.dir && rootOf(g.dir) === root)?.[0];
    if (existing) groupOf.set(p.id, existing); else byRoot.set(root, [...(byRoot.get(root) ?? []), p]);
  }
  for (const [root, ps] of byRoot) {
    if (ps.length < 2 && !repos.some((r) => r.dir === root)) continue;
    const g = group(`dir:${root}`, { name: base(root), owner: ps[0]!.owner, how: 'the same folder', confidence: 0.85, dir: root });
    for (const p of ps) groupOf.set(p.id, g);
  }
  // a PM2 app is somebody's app even when it's alone in its folder
  for (const p of parts.values()) if (p.owner === 'pm2' && !groupOf.has(p.id)) groupOf.set(p.id, group(`pm2:${p.name}`, { name: p.name, owner: 'pm2', how: 'PM2’s own list', confidence: 0.9, dir: p.dir }));

  // 5. what each part talks to: another container named in its settings, or a port on this machine
  // container names are unique on the machine; a network alias ("db") only counts on a network both share
  const nameOf = new Map<string, string>(), aliasOf = new Map<string, { id: string; nets: string[] }[]>();
  for (const [id, cs] of ctrsOf) for (const c of cs) {
    nameOf.set(c.name.toLowerCase(), id);
    for (const n of c.networks) for (const a of [...n.aliases, c.labels['com.docker.compose.service'] ?? '']) if (a && a.length >= 2 && !/^[0-9a-f]{12}$/.test(a)) aliasOf.set(a.toLowerCase(), [...(aliasOf.get(a.toLowerCase()) ?? []), { id, nets: [n.name] }]);
  }
  const reach = (token: string, from?: Part) => nameOf.get(token) ?? (() => {
    const hits = [...new Set((aliasOf.get(token) ?? []).filter((x) => x.id !== from?.id && x.nets.some((n) => !['bridge', 'host', 'none'].includes(n) && from?.networks?.includes(n))).map((x) => x.id))];
    return hits.length === 1 ? hits[0] : undefined;
  })();
  const portOwner = new Map<number, string>();
  for (const l of listeners) if (l.part) portOwner.set(l.port, l.part);
  for (const [id, env] of envOf) {
    const uses = new Set<string>();
    for (const v of Object.values(env)) {
      const low = v.toLowerCase();
      for (const m of low.matchAll(/(?:^|[/@=,\s])([a-z0-9][a-z0-9_.-]+)(?::\d+|(?=[/?\s,]|$))/g)) { const t = reach(m[1]!, parts.get(id)); if (t && t !== id) uses.add(t); }
      for (const m of low.matchAll(/(?:localhost|127\.0\.0\.1|host\.docker\.internal):(\d{2,5})/g)) { const t = portOwner.get(Number(m[1])); if (t && t !== id) uses.add(t); }
    }
    if (uses.size) parts.get(id)!.uses = [...uses];
  }
  // a lone part that one project uses, or that shares a private network with only one project, belongs to it
  for (const p of parts.values()) {
    if (groupOf.has(p.id) || p.kind === 'domain') continue;
    const users = new Set([...parts.values()].filter((q) => q.uses?.includes(p.id) && groupOf.has(q.id)).map((q) => groupOf.get(q.id)!));
    const nets = (p.networks ?? []).filter((n) => !SHARED_NETS.has(n));
    const neighbours = new Set([...parts.values()].filter((q) => q.id !== p.id && groupOf.has(q.id) && q.networks?.some((n) => nets.includes(n))).map((q) => groupOf.get(q.id)!));
    const g = users.size === 1 ? [...users][0] : neighbours.size === 1 ? [...neighbours][0] : undefined;
    if (g) { groupOf.set(p.id, g); const gg = groups.get(g)!; gg.confidence = Math.min(gg.confidence, users.size === 1 ? 0.8 : 0.6); }
  }

  // 6. volumes: with the part that keeps its data in them; unused ones are leftovers
  const dangling = new Set(lines(sec.dangling));
  const allVolumes = lines(sec.volumes);
  for (const [id, cs] of ctrsOf) {
    const vols = [...new Set(cs.flatMap((c) => c.mounts.filter((m) => m.type === 'volume' && m.name).map((m) => m.name!)))];
    if (vols.length) parts.get(id)!.volumes = vols.map((v) => `v:${v}`);
    for (const v of vols) if (!parts.has(`v:${v}`)) { parts.set(`v:${v}`, { id: `v:${v}`, kind: 'volume', name: v, owner: parts.get(id)!.owner, trust: 'seen' }); if (groupOf.has(id)) groupOf.set(`v:${v}`, groupOf.get(id)!); }
  }
  for (const v of allVolumes) if (!parts.has(`v:${v}`)) parts.set(`v:${v}`, { id: `v:${v}`, kind: 'volume', name: v, owner: 'unmanaged', trust: 'seen', ...(dangling.has(v) && { health: { status: 'warn', reason: 'nothing uses it' } }) });

  // 7. domains: proxy labels on containers, then nginx, Caddy and Traefik files on the host
  const routes: Route[] = [...parseNginx(sec.nginx), ...parseCaddyfile(sec.caddy)];
  const traefik = parseTraefikFiles(sec.traefik);
  routes.push(...traefik.routes);
  const domain = (h: string, target: string, via: string) => {
    const id = `d:${h}`;
    if (parts.has(id)) return;
    const t = parts.get(target)!;
    parts.set(id, { id, kind: 'domain', name: h, owner: t.owner, trust: t.trust, via, target });
    t.hosts = [...new Set([...(t.hosts ?? []), h])];
    if (groupOf.has(target)) groupOf.set(id, groupOf.get(target)!);
  };
  for (const [id, cs] of ctrsOf) for (const h of cs.flatMap((c) => labelHosts(c.labels))) domain(h, id, `routed by ${OWNER_NAME[parts.get(id)!.owner] === 'nothing' ? 'its proxy labels' : OWNER_NAME[parts.get(id)!.owner]}`);
  for (const r of routes) {
    const name = r.upstream?.replace(/:\d+$/, '').toLowerCase();
    const target = (r.port && /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(name ?? '') ? portOwner.get(r.port) ?? byPublished.get(r.port) : undefined) ?? (name ? nameOf.get(name) ?? reach(name, { networks: ['coolify', 'dokploy-network'] } as Part) : undefined);
    if (target) domain(r.host, target, r.via);
  }

  // 8. scheduled jobs (cron), with the project whose folder or container they mention
  for (const c of parseCron(sec.cron)) {
    const id = `cron:${short(`${c.file}|${c.schedule}|${c.command}`)}`;
    parts.set(id, { id, kind: 'job', name: c.command.split(/\s+/).slice(0, 3).join(' ').slice(0, 60), owner: 'unmanaged', trust: 'seen', schedule: c.schedule, when: scheduleInWords(c.schedule), command: c.command.slice(0, 500), user: c.user, file: c.file });
    const ctr = /docker\s+(?:exec|restart|start|stop)\s+(?:-\S+\s+)*([a-zA-Z0-9][\w.-]+)/.exec(c.command)?.[1];
    const byCtr = ctr ? nameOf.get(ctr.toLowerCase()) : undefined;
    const byDir = [...groups.entries()].find(([, g]) => g.dir && c.command.includes(g.dir))?.[0];
    const g = (byCtr && groupOf.get(byCtr)) || byDir;
    if (g) groupOf.set(id, g);
  }

  // 9. trust, projects, leftovers
  const trustOf = (o: Owner): Trust => o === 'unit7' ? 'owned' : o === 'coolify' ? (known.coolify?.managed ? 'managed' : 'understood') : o === 'unmanaged' ? 'seen' : 'understood';
  for (const p of parts.values()) { p.trust = trustOf(p.owner); p.project = groupOf.get(p.id); }
  const projects: Project[] = [...groups.entries()].map(([id, g]) => {
    const mine = [...parts.values()].filter((p) => p.project === id);
    const dir = g.dir ? rootOf(g.dir) : undefined;
    return {
      id, name: g.name, owner: g.owner, trust: trustOf(g.owner),
      how: g.how, confidence: g.confidence, ...(g.system && { system: true }), ...(g.environments.size && { environments: [...g.environments].sort() }),
      parts: mine.map((p) => p.id), health: worst(mine.filter((p) => p.kind !== 'volume' && p.kind !== 'domain').map((p) => p.health)), domains: mine.filter((p) => p.kind === 'domain').map((p) => p.name),
      ...(dir && { dir }), ...(dir && repos.find((r) => r.dir === dir) && { git: repos.find((r) => r.dir === dir) }),
    };
  }).filter((p) => p.parts.length).sort((a, b) => +!!a.system - +!!b.system || a.name.localeCompare(b.name));
  const loose = [...parts.values()].filter((p) => !p.project).map((p) => p.id);

  // 10. PaaS on the box, and Coolify's details
  const PAAS: [string, string, string][] = [['/data/coolify', 'coolify', 'Coolify'], ['/etc/dokploy', 'dokploy', 'Dokploy'], ['/captain', 'caprover', 'CapRover'], ['/var/lib/dokku', 'dokku', 'Dokku'], ['/etc/easypanel', 'easypanel', 'Easypanel'],
    ['/home/clp', 'cloudpanel', 'CloudPanel'], ['/RunCloud', 'runcloud', 'RunCloud'], ['/home/forge', 'forge', 'Laravel Forge'], ['/home/ploi', 'ploi', 'Ploi'], ['/opt/1panel', '1panel', '1Panel'], ['/www/server/panel', 'aapanel', 'aaPanel'], ['/usr/local/hestia', 'hestia', 'HestiaCP'], ['/home/yellowtent', 'cloudron', 'Cloudron'], ['kamal', 'kamal', 'Kamal'], ['portainer', 'portainer', 'Portainer']];
  const paas = PAAS.filter(([m, id]) => markers.has(m) || (id === 'coolify' && ctrs.some((c) => c.name === 'coolify')) || (id === 'dokku' && markers.has('/home/dokku'))).map(([, id, name]) => ({ id, name }))
    .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
  const coolifyCtr = ctrs.find((c) => c.name === 'coolify');
  const coolify: Inventory['coolify'] = paas.some((p) => p.id === 'coolify') ? {
    version: versionTag(coolifyCtr?.image) ?? ctrs.map((c) => c.labels['coolify.version']).find(Boolean),
    dashboard: traefik.dashboard ? `https://${traefik.dashboard}` : known.serverHost ? `http://${known.serverHost}:${Number(/APP_PORT=(\d+)/.exec(sec.markers ?? '')?.[1] ?? 8000)}` : undefined,
    apiPort: Number(/APP_PORT=(\d+)/.exec(sec.markers ?? '')?.[1] ?? 8000), running: coolifyCtr?.state === 'running', sentinel: ctrs.some((c) => c.name === 'coolify-sentinel' && c.state === 'running'), proxy: ctrs.some((c) => c.name === 'coolify-proxy' && c.state === 'running'),
    ...(known.coolify?.accountId && { connected: known.coolify.accountId }), ...(known.coolify?.abilities && { abilities: known.coolify.abilities }),
  } : undefined;
  if (host.has_docker && !host.docker) notes.push('Docker is installed but Unit7 couldn’t use it: it isn’t running, or this user isn’t in the docker group.');
  if (sec.ctrs?.trim() && !ctrs.length) notes.push('Docker’s container list couldn’t be read in full.');

  const inv: Inventory = {
    version: 1, at,
    server: { os: host.os || undefined, cpus: num(host.cpus), memTotal: num(host.mem_total), memAvailable: num(host.mem_available), diskTotal: num(host.disk_total), diskUsed: num(host.disk_used), load: host.load || undefined, docker: host.docker || undefined, user: host.user || undefined },
    paas, ...(coolify && { coolify }), projects, parts: [...parts.values()], loose, ports: listeners, repos, disk: parseDisk(sec.df), summary: '', notes,
    ...(sec.fw !== undefined && { blocked: [...blocks].sort((a, b) => a[0] - b[0]).map(([port, chains]) => ({ port, chains: [...chains].sort() })) }),
  };
  inv.summary = summarize(inv);
  // nothing that looks like a secret survives into storage (cron commands and git remotes can carry them)
  return new Redactor().redactDeep(inv);
}
const versionTag = (image?: string) => image ? /:v?(\d+\.\d+[\w.-]*)$/.exec(image)?.[1] : undefined;

// server.close_port's rules, as `iptables -S` prints them ("-A DOCKER-USER -i eth0 … --comment unit7-close-5432 -j DROP"):
// port → the chains it's dropped in. Anyone else's rules are ignored.
export function parseBlocks(text?: string): Map<number, Set<string>> {
  const m = new Map<number, Set<string>>();
  for (const l of lines(text)) {
    const port = Number(/unit7-close-(\d+)\b/.exec(l)?.[1]), chain = /^-[AI] (\S+)/.exec(l)?.[1];
    if (!chain || !(port > 0 && port < 65536) || !/-j DROP\b/.test(l)) continue;
    if (!m.has(port)) m.set(port, new Set());
    m.get(port)!.add(chain);
  }
  return m;
}

// The facts in two sentences. The AI may rephrase this; it never invents what's in it.
export function summarize(inv: Inventory): string {
  const own = inv.projects.filter((p) => !p.system);
  const by = (id: string) => inv.parts.find((p) => p.id === id);
  const kinds = (p: Project) => p.parts.map(by).filter(Boolean) as Part[];
  const supa = own.filter((p) => kinds(p).some((x) => x.product?.id === 'supabase')).length;
  const dbs = inv.parts.filter((p) => p.kind === 'database' && p.product?.id !== 'supabase').length;
  const domains = inv.parts.filter((p) => p.kind === 'domain').length;
  const owners = [...new Set(own.map((p) => OWNER_NAME[p.owner]))].filter((o) => o !== 'nothing');
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const first = own.length || dbs
    ? `Runs ${n(own.length, 'project')}${supa ? ` (${supa} with ${supa === 1 ? 'its' : 'their'} own Supabase)` : ''}, ${n(dbs, 'database')} and ${n(domains, 'domain')}${owners.length ? `, run by ${owners.join(', ')}` : ''}.`
    : 'Nothing runs here yet apart from the system.';
  const bad = own.filter((p) => p.health.status === 'bad'), warn = own.filter((p) => p.health.status === 'warn');
  const allOk = !bad.length && !warn.length && own.some((p) => p.health.status === 'ok');
  const exposed = inv.parts.filter((p) => p.exposed);
  const list = (ps: Project[]) => ps.length > 3 ? `${ps.slice(0, 3).map((p) => p.name).join(', ')} and ${ps.length - 3} more` : ps.map((p) => p.name).join(', ');
  const health = bad.length ? `${list(bad)} ${bad.length === 1 ? 'has' : 'have'} a problem${bad.length === 1 ? `: ${bad[0]!.health.reason}` : `, for example ${bad[0]!.health.reason}`}.` : warn.length ? `${warn[0]!.name}: ${warn[0]!.health.reason}.` : allOk ? 'Everything running is healthy.' : '';
  const risk = exposed.length ? ` ${exposed.length === 1 ? 'One risk' : `${exposed.length} risks`}: ${exposed.map((p) => p.name).join(', ')} ${exposed.length === 1 ? 'is' : 'are'} open to the internet (Docker’s published ports skip the firewall).` : '';
  const loose = inv.loose.filter((id) => by(id)?.kind !== 'volume').length;
  const off = own.filter((p) => p.health.status === 'off').length;
  return `${first} ${health}${off ? ` ${n(off, 'project')} ${off === 1 ? 'is' : 'are'} stopped.` : ''}${risk}${loose ? ` ${n(loose, 'thing')} ${loose === 1 ? 'isn’t' : 'aren’t'} part of a project.` : ''}`.replace(/\s+/g, ' ').trim();
}

// --- sizes (the deep probe) --------------------------------------------------------------------------
export interface Sizes {
  at: string; method: string; volumes: Record<string, number>; binds: Record<string, number>; logs: Record<string, number>;
  databases: { part: string; container: string; name: string; bytes: number }[]; layers: Record<string, number>;
  images: { id: string; size: number; unique: number; containers: number }[]; buildCache?: number;
  projects: { id: string; name: string; bytes: number }[]; loose: number; reclaimable?: number;
}
export function sizeTargets(inv: Inventory): string[] {
  const out: string[] = [];
  const skip = /^\/(proc|sys|dev|run|etc|boot|var\/run|usr|bin|sbin|lib\w*)?(\/|$)|docker\.sock/;
  for (const p of inv.parts) {
    for (const b of p.binds ?? []) if (b.startsWith('/') && !skip.test(b) && b.length > 1 && !/[\n\r]/.test(b)) out.push(`bind:${b}`);
    const c = p.containers?.find((n) => p.internals ? /db|postgres/.test(n) : true);
    if (!c || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(c) || p.state !== 'running') continue;
    if (p.engine === 'postgres') out.push(`pg:${c}`);
    if (p.engine === 'mysql' || p.engine === 'mariadb') out.push(`my:${c}`);
    if (p.engine === 'redis') out.push(`redis:${c}`);
  }
  return [...new Set(out)];
}
export function parseSizes(out: string, inv: Inventory, at = new Date().toISOString()): Sizes {
  const sec = sections(out);
  const df = tryJson<any>(sec.df, {});
  const volumes: Record<string, number> = {}, binds: Record<string, number> = {}, logs: Record<string, number> = {}, layers: Record<string, number> = {};
  for (const v of df.Volumes ?? []) if (v?.Name && (v.UsageData?.Size ?? -1) >= 0) volumes[v.Name] = v.UsageData.Size;
  for (const l of lines(sec.vols)) { const [n, b] = l.split(' '); if (n && Number(b) >= 0) volumes[n] = Number(b); }
  for (const c of df.Containers ?? []) if (c?.Names?.[0]) layers[String(c.Names[0]).replace(/^\//, '')] = c.SizeRw ?? 0;
  for (const l of lines(sec.logs)) { const [n, b] = l.split(' '); if (n) logs[n.replace(/^\//, '')] = Number(b) || 0; }
  const databases: Sizes['databases'] = [];
  const partOfCtr = (c: string) => inv.parts.find((p) => p.containers?.includes(c))?.id ?? '';
  for (const l of lines(sec.items)) {
    const f = l.split(' ');
    if (f[0] === 'bind' && f[2]) binds[f.slice(2).join(' ')] = Number(f[1]) || 0;
    if (f[0] === 'db' && f[1] && Number(f[2]) >= 0) databases.push({ part: partOfCtr(f[1]), container: f[1], bytes: Number(f[2]), name: f.slice(3).join(' ') });
  }
  const images = (df.Images ?? []).map((i: any) => ({ id: i.Id, size: i.Size ?? 0, unique: Math.max(0, (i.Size ?? 0) - Math.max(0, i.SharedSize ?? 0)), containers: i.Containers ?? 0 }));
  const partBytes = (p: Part) => (p.volumes ?? []).reduce((s, v) => s + (volumes[v.slice(2)] ?? 0), 0) + (p.binds ?? []).reduce((s, b) => s + (binds[b] ?? 0), 0)
    + (p.containers ?? []).reduce((s, c) => s + (layers[c] ?? 0) + (logs[c] ?? 0), 0);
  const projects = inv.projects.map((pr) => ({ id: pr.id, name: pr.name, bytes: inv.parts.filter((p) => p.project === pr.id && p.kind !== 'volume').reduce((s, p) => s + partBytes(p), 0) }));
  const loose = inv.parts.filter((p) => !p.project).reduce((s, p) => s + (p.kind === 'volume' ? volumes[p.name] ?? 0 : partBytes(p)), 0);
  const unusedImages = images.filter((i: { containers: number }) => !i.containers).reduce((s: number, i: { unique: number }) => s + i.unique, 0);
  const cache = (df.BuildCache ?? []) as { Size?: number; InUse?: boolean }[];
  const buildCache = cache.length ? cache.reduce((s, c) => s + (c.Size ?? 0), 0) : undefined;
  const danglingVols = inv.parts.filter((p) => p.kind === 'volume' && !p.project && p.health?.reason === 'nothing uses it').reduce((s, p) => s + (volumes[p.name] ?? 0), 0);
  return {
    at, method: sec.df?.trim() ? 'Docker’s disk report, plus du for folders and each database’s own size query' : 'du on each volume folder, plus each database’s own size query',
    volumes, binds, logs, databases, layers, images, ...(buildCache !== undefined && { buildCache }), projects, loose,
    reclaimable: unusedImages + cache.filter((c) => !c.InUse).reduce((s, c) => s + (c.Size ?? 0), 0) + danglingVols,
  };
}

// --- usage right now -------------------------------------------------------------------------------
export interface Stat { cpu: number; mem: number; rx?: number; tx?: number; netTotal?: number }
// Sentinel /api/containers/current: [{ id (the container's name), cpu: { percent (string) }, memory: { used }, network: { rxBytesPerSec, txBytesPerSec } }].
// Since 1.1 a container with no numbers yet (metrics off) is still listed, with cpu and memory null: that's no reading, not a zero.
export function parseSentinel(text?: string): Map<string, Stat> {
  const out = new Map<string, Stat>();
  for (const x of tryJson<any[]>(text, [])) if (x?.id && (x.cpu || x.memory)) out.set(String(x.id).replace(/^\//, ''), { cpu: parseFloat(x.cpu?.percent) || 0, mem: Number(x.memory?.used) || 0, rx: Number(x.network?.rxBytesPerSec) || 0, tx: Number(x.network?.txBytesPerSec) || 0 });
  return out;
}
// docker stats --no-stream --format '{{json .}}': CPU as a percent of one core, memory and network totals as text
export function parseDockerStats(text?: string): Map<string, Stat> {
  const out = new Map<string, Stat>();
  for (const l of lines(text)) {
    const x = tryJson<Record<string, string>>(l, {});
    if (!x.Name) continue;
    const [rx = '', tx = ''] = (x.NetIO ?? '').split(' / ');
    out.set(x.Name, { cpu: parseFloat(x.CPUPerc ?? '') || 0, mem: bytes((x.MemUsage ?? '').split(' / ')[0]), netTotal: bytes(rx) + bytes(tx) });
  }
  return out;
}
export interface Slice { id: string; name: string; system?: boolean; cpu: number; mem: number; rx?: number; tx?: number; netTotal?: number; disk?: number; share: number; cost?: number }
export interface Usage {
  at: string; source: 'sentinel' | 'docker-stats'; method: string;
  server: { cpus: number; cpu: number; memTotal: number; memUsed: number; diskTotal: number; diskUsed: number };
  projects: Slice[]; loose: Slice; system: Slice; free: { mem: number; disk: number; cpu: number; cost?: number };
  reclaimable?: number; disk?: { measuredAt: string; method: string };
  price?: { monthly: number; currency: string; source: string; basis: string };
}
// share = half memory share, half CPU share (OpenCost's idea for one box); the rest of the price is free room
export function rollup(inv: Inventory, host: Usage['server'], per: Map<string, Stat>, source: Usage['source'], o: { sizes?: Sizes; price?: { monthly: number; currency: string; source: string }; at?: string } = {}): Usage {
  const cpus = Math.max(1, host.cpus || inv.server.cpus || 1);
  const statOf = (p: Part) => (p.match ?? p.containers ?? []).map((k) => per.get(k)).filter(Boolean) as Stat[];
  const slice = (id: string, name: string, ps: Part[], system?: boolean): Slice => {
    const st = ps.flatMap(statOf);
    const sum = (f: (s: Stat) => number | undefined) => st.reduce((a, s) => a + (f(s) ?? 0), 0);
    const cpu = sum((s) => s.cpu) / cpus, mem = sum((s) => s.mem);
    return { id, name, ...(system && { system: true }), cpu: round(cpu), mem, ...(source === 'sentinel' ? { rx: sum((s) => s.rx), tx: sum((s) => s.tx) } : { netTotal: sum((s) => s.netTotal) }),
      ...(o.sizes && { disk: id === 'loose' ? o.sizes.loose : o.sizes.projects.find((x) => x.id === id)?.bytes }), share: 0 };
  };
  const projects = inv.projects.map((pr) => slice(pr.id, pr.name, inv.parts.filter((p) => p.project === pr.id), pr.system));
  const loose = slice('loose', 'Not part of a project', inv.parts.filter((p) => !p.project));
  const counted = [...projects, loose];
  const sys: Slice = { id: 'system', name: 'The server itself', system: true, cpu: round(Math.max(0, host.cpu - counted.reduce((a, s) => a + s.cpu, 0))), mem: Math.max(0, host.memUsed - counted.reduce((a, s) => a + s.mem, 0)), share: 0 };
  const all = [...counted, sys];
  for (const s of all) {
    s.share = round(0.5 * (host.memTotal ? s.mem / host.memTotal : 0) + 0.5 * (s.cpu / 100), 4);
    if (o.price) s.cost = round(o.price.monthly * s.share, 2);
  }
  const used = all.reduce((a, s) => a + s.share, 0);
  return {
    at: o.at ?? new Date().toISOString(), source, server: host, projects, loose, system: sys,
    method: source === 'sentinel' ? 'Coolify’s monitor (Sentinel) inside the server, right now' : 'docker stats, right now (network as totals since each container started)',
    free: { mem: Math.max(0, host.memTotal - host.memUsed), disk: Math.max(0, host.diskTotal - host.diskUsed), cpu: round(Math.max(0, 100 - host.cpu)), ...(o.price && { cost: round(Math.max(0, o.price.monthly * (1 - used)), 2) }) },
    ...(o.sizes && { reclaimable: o.sizes.reclaimable, disk: { measuredAt: o.sizes.at, method: o.sizes.method } }),
    ...(!o.sizes && inv.disk?.reclaimable !== undefined && { reclaimable: inv.disk.reclaimable }),
    ...(o.price && { price: { ...o.price, basis: 'half memory share, half CPU share, from usage right now; an allocation of the server’s price, not a bill' } }),
  };
}
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// --- on the map: a server's X-ray as map things (projects as frames, their parts inside) -----------------
// Keys are owner:<serverId>/<part id>. Unit7's own things are left out: the map lists Unit7's services already.
export function xrayFound(serverId: string, inv: Inventory): { found: Found[]; refs: Ref[] } {
  const server = `unit7:${serverId}`;
  const shown = (p?: Part) => !!p && p.owner !== 'unit7';
  const key = (p: Part) => `${p.owner}:${serverId}/${p.id}`;
  const byId = new Map(inv.parts.map((p) => [p.id, p]));
  const projectKey = new Map(inv.projects.filter((p) => p.owner !== 'unit7').map((p) => [p.id, `${p.owner}:${serverId}/p/${p.id}`]));
  const found: Found[] = [], refs: Ref[] = [];
  for (const pr of inv.projects) {
    if (!projectKey.has(pr.id)) continue;
    found.push({ provider: pr.owner, kind: 'project', extId: `${serverId}/p/${pr.id}`, name: pr.name, owner: pr.owner, trust: pr.trust, server, health: pr.health, how: pr.how,
      ...(pr.system && { system: true }), ...(pr.environments?.length && { environment: pr.environments.join(', ') }),
      parts: pr.parts.map((id) => byId.get(id)).filter((p) => shown(p) && p!.kind !== 'domain').map((p) => key(p!)) });
  }
  for (const p of inv.parts) {
    if (!shown(p) || p.kind === 'domain') continue;
    const k = key(p);
    found.push({ provider: p.owner, kind: p.kind, extId: `${serverId}/${p.id}`, name: p.name, owner: p.owner, trust: p.trust, server,
      ...(p.project && projectKey.has(p.project) && { project: projectKey.get(p.project) }), ...(p.hosts?.length && { hosts: p.hosts, url: `https://${p.hosts[0]}` }),
      ...(p.envKeys?.length && { envKeys: p.envKeys }), ...(p.product && { product: p.product }), ...(p.engine && { engine: p.engine }), ...(p.version && { version: p.version }),
      ...(p.exposed && { exposed: true }), ...(p.health && { health: p.health }), ...(p.coolify?.environment && { environment: p.coolify.environment }),
      ...(p.state && p.state !== 'running' && { status: p.state }) });
    if (p.kind === 'app' || p.kind === 'database' || p.kind === 'service') refs.push({ from: k, kind: 'runs_on', via: `run by ${OWNER_NAME[p.owner]}`, to: server });
    for (const e of p.env ?? []) refs.push({ from: k, kind: 'env', ...e });
    for (const u of p.uses ?? []) { const t = byId.get(u); if (shown(t)) refs.push({ from: k, kind: 'uses', via: 'talks to it', to: key(t!) }); }
  }
  for (const d of inv.parts.filter((p) => p.kind === 'domain')) {
    const t = d.target ? byId.get(d.target) : undefined;
    if (shown(t)) refs.push({ from: key(t!), kind: 'domain', via: d.via ?? 'routed on the server', host: d.name });
  }
  return { found, refs };
}
