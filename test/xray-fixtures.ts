// Captured-style X-ray output for made-up servers: what the probe prints, section by section.
import { createHash } from 'node:crypto';

interface C {
  name: string; image: string; labels?: Record<string, string>; ports?: [string, string, number][]; nets?: Record<string, string[]>;
  mounts?: { Type: string; Name?: string; Source?: string; Destination: string }[]; state?: string; restarts?: number; oom?: boolean; env?: string[]; exit?: number; policy?: string; health?: string;
}
export const ctr = (c: C) => ({
  Id: createHash('sha256').update(c.name).digest('hex'), Name: `/${c.name}`, Image: `sha256:${createHash('sha256').update(c.image).digest('hex')}`, LogPath: `/var/lib/docker/containers/${c.name}/log.json`,
  Config: { Image: c.image, Labels: c.labels ?? {}, Env: ['PATH=/usr/local/bin:/usr/bin', ...(c.env ?? [])] },
  State: { Status: c.state ?? 'running', OOMKilled: !!c.oom, ExitCode: c.exit ?? 0, Pid: 4000, StartedAt: '2026-10-06T08:00:00Z', ...(c.health && { Health: { Status: c.health } }) },
  RestartCount: c.restarts ?? 0, HostConfig: { RestartPolicy: { Name: c.policy ?? 'unless-stopped' }, Memory: 0 },
  NetworkSettings: { Ports: Object.fromEntries((c.ports ?? []).map(([k, ip, hp]) => [k, [{ HostIp: ip, HostPort: String(hp) }]])), Networks: Object.fromEntries(Object.entries(c.nets ?? { bridge: [] }).map(([n, a]) => [n, { Aliases: a, DNSNames: [c.name, ...a] }])) },
  Mounts: c.mounts ?? [],
});
export const probe = (s: Record<string, string>) => Object.entries(s).map(([k, v]) => `\n@@unit7:${k}\n${v}`).join('');
const docker = (ip: string, port: number) => `tcp LISTEN 0 4096 ${ip}:${port} 0.0.0.0:* users:(("docker-proxy",pid=${1000 + port},fd=4))`;
const HOST = 'os=Ubuntu 24.04.1 LTS\ncpus=4\nmem_total=16000000000\nmem_available=9000000000\ndisk_total=200000000000\ndisk_used=59000000000\nload=0.31 0.40 0.38\ndocker=27.3.1\nuser=root\nhas_docker=1';

// --- a Coolify server: 4 projects, 3 of them with their own Supabase, a Postgres database, Coolify itself ----
// Coolify 4.4 renamed its labels: half of these containers still carry the old numeric ones.
const base = (type: string, project: string, resource: string, name: string) => ({ 'coolify.managed': 'true', 'coolify.type': type, 'coolify.name': name, 'coolify.resourceName': resource, 'coolify.projectName': project, 'coolify.environmentName': 'production', 'coolify.pullRequestId': '0' });
const NEW = (type: string, uuid: string, project: string, resource: string, name = uuid) => ({ ...base(type, project, resource, name), 'coolify.version': '4.4.0', [`coolify.${type}Uuid`]: uuid, 'com.docker.compose.project': uuid });
const OLD = (type: string, id: number, uuid: string, project: string, resource: string, name = uuid) => ({ ...base(type, project, resource, name), 'coolify.version': '4.3.10', [`coolify.${type}Id`]: String(id), 'com.docker.compose.project': uuid });
const route = (uuid: string, host: string) => ({ 'traefik.enable': 'true', [`traefik.http.routers.https-0-${uuid}.rule`]: `Host(\`${host}\`) && PathPrefix(\`/\`)`, [`traefik.http.routers.https-0-${uuid}.tls`]: 'true' });
const SUPA = ['supabase-db=supabase/postgres:15.8.1.060', 'supabase-kong=kong:2.8.1', 'supabase-studio=supabase/studio:2026.01.07', 'supabase-auth=supabase/gotrue:v2.170.0', 'realtime-dev=supabase/realtime:v2.34.47',
  'supabase-rest=postgrest/postgrest:v12.2.12', 'supabase-meta=supabase/postgres-meta:v0.84.2', 'supabase-storage=supabase/storage-api:v1.19.3', 'supabase-edge-functions=supabase/edge-runtime:v1.67.4',
  'supabase-analytics=supabase/logflare:1.12.0', 'supabase-vector=timberio/vector:0.28.1-alpine', 'imgproxy=darthsim/imgproxy:v3.8.0', 'supabase-minio=minio/minio:latest'];
const supabase = (svc: string, labels: (sub: string) => Record<string, string>) => SUPA.map((s) => {
  const [sub, image] = s.split('=') as [string, string];
  return ctr({ name: `${sub}-${svc}`, image, labels: { ...labels(sub), 'com.docker.compose.service': sub }, nets: { [svc]: [sub], ...(sub === 'supabase-kong' && { coolify: [] }) },
    mounts: sub === 'supabase-db' ? [{ Type: 'volume', Name: `${svc}_supabase-db-data`, Destination: '/var/lib/postgresql/data' }] : [],
    env: sub === 'supabase-db' ? ['POSTGRES_PASSWORD=sup3rs3cretdbpass', 'POSTGRES_DB=postgres'] : [`POSTGRES_HOST=supabase-db`, 'JWT_SECRET=jwts3cretvalue0123456789'] });
});
const sub = (svc: string) => (s: string) => ({ 'coolify.service.subUuid': `${s.replace(/[^a-z]/g, '')}${svc}`, 'coolify.service.subType': s === 'supabase-db' ? 'database' : 'application', 'coolify.service.subName': s });

export const COOLIFY_CONTAINERS = [
  // relay: an app (new labels) and a Postgres database (old labels) published on 5432
  ctr({ name: 'relayweb01-101530000001', image: 'relayweb01:4f2a9c1', labels: { ...NEW('application', 'relayweb01', 'relay', 'relay-api'), ...route('relayweb01', 'relay.example.com') }, nets: { coolify: [] },
    env: ['DATABASE_URL=postgres://postgres:r3layDBpass@relaydb01:5432/postgres', 'NODE_ENV=production', 'COOLIFY_FQDN=relay.example.com'] }),
  ctr({ name: 'relaydb01', image: 'postgres:16-alpine', labels: { ...OLD('database', 2, 'relaydb01', 'relay', 'relay-db'), 'coolify.database.subType': 'postgresql' }, nets: { coolify: [] },
    ports: [['5432/tcp', '0.0.0.0', 5432]], mounts: [{ Type: 'volume', Name: 'postgres-data-relaydb01', Destination: '/var/lib/postgresql/data' }], env: ['POSTGRES_PASSWORD=r3layDBpass'] }),
  // shop: an app (old labels) and Supabase (new labels)
  ctr({ name: 'shopapp01-101530000002', image: 'shopapp01:9e1b2c3', labels: { ...OLD('application', 3, 'shopapp01', 'shop', 'shop-web'), ...route('shopapp01', 'shop.example.com') }, nets: { coolify: [] },
    env: ['NEXT_PUBLIC_SUPABASE_URL=https://api.shop.example.com', 'SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlMTIzNDU2'] }),
  ...supabase('shopsupa01', (s) => ({ ...NEW('service', 'shopsupa01', 'shop', 'shop-supabase', `${s}-shopsupa01`), ...sub('shopsupa01')(s), ...(s === 'supabase-kong' && route('shopsupa01', 'api.shop.example.com')) })),
  // crm: an app that keeps running out of memory, and Supabase with the old labels
  ctr({ name: 'crmapp01-101530000003', image: 'crmapp01:77aa001', labels: { ...NEW('application', 'crmapp01', 'crm', 'crm-web'), ...route('crmapp01', 'crm.example.com') }, nets: { coolify: [] }, restarts: 3, oom: true }),
  ...supabase('crmsupa01', (s) => ({ ...OLD('service', 7, 'crmsupa01', 'crm', 'crm-supabase', `${s}-crmsupa01`), 'coolify.service.subId': '12' })),
  // ledger: an app and Supabase (new labels)
  ctr({ name: 'ledgapp01-101530000004', image: 'ledgapp01:0c0ffee', labels: { ...NEW('application', 'ledgapp01', 'ledger', 'ledger-web'), ...route('ledgapp01', 'ledger.example.com') }, nets: { coolify: [] } }),
  ...supabase('ledgsupa01', (s) => ({ ...NEW('service', 'ledgsupa01', 'ledger', 'ledger-supabase', `${s}-ledgsupa01`), ...sub('ledgsupa01')(s) })),
  // Coolify itself
  ctr({ name: 'coolify', image: 'ghcr.io/coollabsio/coolify:4.4.0', ports: [['8080/tcp', '0.0.0.0', 8000]], nets: { coolify: [] }, mounts: [{ Type: 'bind', Source: '/data/coolify/source/.env', Destination: '/var/www/html/.env' }] }),
  ctr({ name: 'coolify-db', image: 'postgres:15-alpine', nets: { coolify: [] }, mounts: [{ Type: 'volume', Name: 'coolify-db', Destination: '/var/lib/postgresql/data' }] }),
  ctr({ name: 'coolify-redis', image: 'redis:7-alpine', nets: { coolify: [] } }),
  ctr({ name: 'coolify-realtime', image: 'ghcr.io/coollabsio/coolify-realtime:1.0.10', ports: [['6001/tcp', '0.0.0.0', 6001], ['6002/tcp', '0.0.0.0', 6002]], nets: { coolify: [] } }),
  ctr({ name: 'coolify-proxy', image: 'traefik:v3.6', ports: [['80/tcp', '0.0.0.0', 80], ['443/tcp', '0.0.0.0', 443], ['8080/tcp', '0.0.0.0', 8080]], nets: { coolify: [] }, labels: { 'coolify.managed': 'true', 'coolify.proxy': 'true' } }),
  ctr({ name: 'coolify-sentinel', image: 'ghcr.io/coollabsio/sentinel:1.0.2', labels: { 'coolify.managed': 'true' }, env: ['TOKEN=s3ntinelt0ken'] }),
  // a leftover nobody runs
  ctr({ name: 'old-test', image: 'node:20', state: 'exited', exit: 0, policy: 'no' }),
];
export const COOLIFY_HOST = probe({
  host: HOST,
  ctrs: JSON.stringify(COOLIFY_CONTAINERS),
  volumes: ['postgres-data-relaydb01', 'shopsupa01_supabase-db-data', 'crmsupa01_supabase-db-data', 'ledgsupa01_supabase-db-data', 'coolify-db', 'orphan-data'].join('\n'),
  dangling: 'orphan-data',
  df: JSON.stringify({ LayersSize: 9_000_000_000, Images: [{ Id: 'sha256:a', Size: 4_000_000_000, SharedSize: 1_000_000_000, Containers: 0 }, { Id: 'sha256:b', Size: 5_000_000_000, SharedSize: 0, Containers: 3 }], BuildCache: [{ Size: 2_000_000_000, InUse: false }] }),
  ports: [`tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))`, ...[80, 443, 8080, 8000, 5432, 6001, 6002].map((p) => docker('0.0.0.0', p))].join('\n'),
  pids: '700|/|sshd',
  units: 'Id=ssh.service\nMainPID=700\nActiveState=active\nFragmentPath=/usr/lib/systemd/system/ssh.service\n\nId=docker.service\nMainPID=800\nActiveState=active\nFragmentPath=/usr/lib/systemd/system/docker.service',
  pm2: '', nginx: '', caddy: '',
  traefik: "##/data/coolify/proxy/dynamic/coolify.yaml\nhttp:\n  routers:\n    coolify-http:\n      entryPoints: [http]\n      service: coolify\n      rule: Host(`coolify.example.com`)\n  services:\n    coolify:\n      loadBalancer:\n        servers:\n          - url: 'http://coolify:8080'\n##/data/coolify/proxy/dynamic/unit7-other.example.com.yaml\nhttp: {}\n",
  cron: '##/etc/cron.d/e2scrub_all\n30 3 * * 0 root test -e /run/systemd/system || SERVICE_MODE=1 /usr/lib/x86_64-linux-gnu/e2fsprogs/e2scrub_all_cron\n##/var/spool/cron/crontabs/root\nMAILTO=""\n0 3 * * * docker exec relaydb01 pg_dump -U postgres postgres > /root/relay.sql',
  markers: '/data/coolify\nAPP_PORT=8000',
  git: '',
});

// --- a plain Docker Compose server: an app with Postgres and Redis behind nginx, and a self-hosted Supabase ---
export const COMPOSE_HOST = probe({
  host: HOST,
  ctrs: JSON.stringify([
    ...[['web', 'shop-web:latest'], ['db', 'postgres:16'], ['redis', 'redis:7-alpine']].map(([svc, image]) => ctr({
      name: `shop-${svc}-1`, image: image!, nets: { shop_default: [svc!, `shop-${svc}-1`] },
      labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': svc!, 'com.docker.compose.project.working_dir': '/srv/shop', 'com.docker.compose.project.config_files': '/srv/shop/compose.yaml' },
      ...(svc === 'web' && { ports: [['3000/tcp', '127.0.0.1', 3000]] as [string, string, number][], env: ['DATABASE_URL=postgres://app:c0mposepw@db:5432/app', 'REDIS_URL=redis://redis:6379', 'STRIPE_KEY=sk_live_abcdefghijklmnop1234'] }),
      ...(svc === 'db' && { mounts: [{ Type: 'volume', Name: 'shop_pgdata', Destination: '/var/lib/postgresql/data' }] }),
    })),
    ...['supabase-db=supabase/postgres:15.8.1.060', 'supabase-kong=kong:2.8.1', 'supabase-studio=supabase/studio:2026.01.07', 'supabase-auth=supabase/gotrue:v2.170.0', 'supabase-rest=postgrest/postgrest:v12.2.12'].map((s) => {
      const [name, image] = s.split('=') as [string, string];
      return ctr({ name, image, nets: { supabase_default: [name.replace('supabase-', '')] }, labels: { 'com.docker.compose.project': 'supabase', 'com.docker.compose.service': name.replace('supabase-', ''), 'com.docker.compose.project.working_dir': '/opt/supabase/docker' },
        ...(name === 'supabase-kong' && { ports: [['8000/tcp', '0.0.0.0', 8000]] as [string, string, number][] }) });
    }),
  ]),
  volumes: 'shop_pgdata', dangling: '',
  df: '{"Type":"Images","TotalCount":"6","Active":"6","Size":"3.2GB","Reclaimable":"1.1GB (34%)"}\n{"Type":"Build Cache","TotalCount":"12","Active":"0","Size":"800MB","Reclaimable":"800MB"}',
  ports: [docker('127.0.0.1', 3000), docker('0.0.0.0', 8000), `tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=900,fd=6))`].join('\n'),
  pids: '900|/|nginx',
  units: 'Id=nginx.service\nMainPID=900\nActiveState=active\nFragmentPath=/usr/lib/systemd/system/nginx.service',
  nginx: 'upstream shopweb { server 127.0.0.1:3000; }\nserver {\n  listen 80;\n  server_name shop.example.com www.shop.example.com;\n  location / { proxy_pass http://shopweb; }\n}\nserver { listen 80 default_server; server_name _; return 444; }',
  git: '/srv/shop|https://git.example.com/sam/shop.git|abc1234 2026-10-01T09:00:00+00:00|3',
});

// --- a PM2 server: a Node API with a worker, a host Postgres, Caddy in front, and a stray program --------
export const PM2_HOST = probe({
  host: HOST.replace('docker=27.3.1', 'docker=').replace('\nhas_docker=1', ''),
  ctrs: '', volumes: '', dangling: '', df: '',
  ports: [
    `tcp LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=20))`, `tcp LISTEN 0 244 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=950,fd=6))`,
    `tcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=960,fd=8))`, `tcp LISTEN 0 5 0.0.0.0:8888 0.0.0.0:* users:(("python3",pid=2222,fd=3))`,
  ].join('\n'),
  pids: '1234|/var/www/api|node\n950|/var/lib/postgresql|postgres\n960|/|caddy\n2222|/root/scratch|python3',
  units: [
    'Id=postgresql@16-main.service\nMainPID=950\nActiveState=active\nFragmentPath=/usr/lib/systemd/system/postgresql@.service',
    'Id=caddy.service\nMainPID=960\nActiveState=active\nFragmentPath=/usr/lib/systemd/system/caddy.service',
    'Id=worker.service\nMainPID=1500\nActiveState=active\nWorkingDirectory=/var/www/api\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node worker.js ; ignore_errors=no }\nFragmentPath=/etc/systemd/system/worker.service\nUser=sam',
    'Id=cron.service\nMainPID=600\nActiveState=active\nFragmentPath=/usr/lib/systemd/system/cron.service',
  ].join('\n\n'),
  pm2: `1100 PM2 v5.4.2: God Daemon (/home/sam/.pm2)\n##/home/sam/.pm2\n${JSON.stringify([{ name: 'api', pm_cwd: '/var/www/api', exec_mode: 'cluster_mode', instances: 2, status: 'online', env: { DATABASE_URL: 'postgres://app:pm2s3cret@localhost:5432/app', PORT: '3000', PATH: '/usr/bin', HOME: '/home/sam' } }])}`,
  caddy: 'api.example.com {\n\treverse_proxy localhost:3000\n}\n',
  cron: '##/var/spool/cron/crontabs/sam\n*/5 * * * * cd /var/www/api && node scripts/sync.js',
  git: '/var/www/api|https://git.example.com/sam/api.git|def5678 2026-10-05T12:00:00+00:00|2',
});
