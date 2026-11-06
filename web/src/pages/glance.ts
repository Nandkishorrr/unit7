// Home's "At a glance": what the person actually has, counted the way the Map counts it (map/data.ts derive()):
// every app and server any account holds (Unit7, Vercel, Coolify…), domains as roots with their subdomains, and
// what needs a look from the Map's own checks. Unit7's own apps and servers made since the last sync count too.
import type { Asset, Derived } from './map/data.ts';

export interface Mine {
  apps: { id: string; sick: boolean }[]; // Unit7 apps (graph services that aren't databases)
  servers: { name: string; ready: boolean }[];
  domains: { active: boolean }[];        // hostnames Unit7 manages, for before the first sync
}
export interface Glance {
  synced: boolean;
  apps: { n: number; look: number; hosts: string[] };
  servers: { n: number; look: number };
  domains: { n: number; subs: number; look: number };
}

export function glance(v: Derived | null, mine: Mine): Glance {
  const sickApps = new Set(mine.apps.filter((a) => a.sick).map((a) => a.id));
  if (!v || !v.assets.length) {
    return {
      synced: false,
      apps: { n: mine.apps.length, look: sickApps.size, hosts: mine.apps.length ? ['unit7'] : [] },
      servers: { n: mine.servers.length, look: mine.servers.filter((s) => !s.ready).length },
      domains: { n: mine.domains.length, subs: 0, look: mine.domains.filter((d) => !d.active).length },
    };
  }
  const of = (k: Asset['kind']) => v.assets.filter((a) => a.kind === k);
  const svc = (a: Asset) => (a.end?.kind === 'unit7' ? a.end.serviceId : undefined);

  const apps = of('app');
  const onMap = new Set(apps.map(svc).filter(Boolean));
  const newApps = mine.apps.filter((a) => !onMap.has(a.id));
  // where they run, for the logos: the host (Vercel…), or who runs it on a server (Coolify, Docker…)
  const hosts = [...new Set([...apps.map((a) => (a.provider === 'unmanaged' ? 'docker' : a.provider)), ...(newApps.length ? ['unit7'] : [])])];

  const servers = of('server');
  const unit7Servers = new Set(servers.filter((s) => s.provider === 'unit7').map((s) => s.name));
  const newServers = mine.servers.filter((s) => !unit7Servers.has(s.name));

  return {
    synced: true,
    apps: { n: apps.length + newApps.length, look: apps.filter((a) => v.attention(a) || sickApps.has(svc(a) ?? '')).length + newApps.filter((a) => a.sick).length, hosts },
    servers: { n: servers.length + newServers.length, look: servers.filter(v.attention).length + newServers.filter((s) => !s.ready).length },
    // roots that need a look, like n and the Map's Overview count them (not every subdomain on its own)
    domains: { n: v.groups.length, subs: v.groups.reduce((n, g) => n + g.subs.length, 0), look: v.groups.filter(v.groupAttention).length },
  };
}
