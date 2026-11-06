// Plain words for what happened. The API speaks in tool ids, event codes and token names; people
// read short sentences. Every helper here keeps the original text available for a title= tooltip.
// No imports on purpose: test/words.test.ts loads this file under plain Node.

// --- provider names (BrandLogo re-exports providerName) ---
export const PROVIDER_NAMES: Record<string, string> = {
  forge: 'Unit7', unit7: 'Unit7', vercel: 'Vercel', supabase: 'Supabase', neon: 'Neon', hostinger: 'Hostinger', cloudflare: 'Cloudflare',
  godaddy: 'GoDaddy', porkbun: 'Porkbun', namecom: 'Name.com', namecheap: 'Namecheap', squarespace: 'Squarespace', digitalocean: 'DigitalOcean',
  netlify: 'Netlify', render: 'Render', railway: 'Railway', heroku: 'Heroku', fly: 'Fly.io', github: 'GitHub', gitlab: 'GitLab', docker: 'Docker',
  postgres: 'PostgreSQL', mysql: 'MySQL', redis: 'Redis', nextjs: 'Next.js', node: 'Node.js', slack: 'Slack', discord: 'Discord', ntfy: 'ntfy',
  openrouter: 'OpenRouter', anthropic: 'Anthropic', claude: 'Claude', gemini: 'Gemini', google: 'Google', openai: 'OpenAI', ollama: 'Ollama',
  gdrive: 'Google Drive', icloud: 'iCloud Drive', dropbox: 'Dropbox', onedrive: 'OneDrive', s3: 'S3 storage', letsencrypt: 'Let’s Encrypt',
  caddy: 'Caddy', ubuntu: 'Ubuntu', cursor: 'Cursor', windsurf: 'Windsurf', codex: 'Codex', antigravity: 'Antigravity', stripe: 'Stripe',
  sentry: 'Sentry', resend: 'Resend', upstash: 'Upstash', planetscale: 'PlanetScale', turso: 'Turso', vite: 'Vite', python: 'Python', go: 'Go', bun: 'Bun', mongodb: 'MongoDB', deno: 'Deno', rust: 'Rust', php: 'PHP', laravel: 'Laravel', astro: 'Astro', nuxt: 'Nuxt', svelte: 'Svelte', remix: 'Remix', django: 'Django', rails: 'Rails', ruby: 'Ruby', java: 'Java', nginx: 'Nginx', debian: 'Debian', webhook: 'Webhook', domain: 'DNS',
  'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', 'gemini-cli': 'Gemini CLI', ssh: 'SSH',
  coolify: 'Coolify', dokploy: 'Dokploy', caprover: 'CapRover', portainer: 'Portainer', pm2: 'PM2', traefik: 'Traefik', n8n: 'n8n', minio: 'MinIO',
  appwrite: 'Appwrite', mariadb: 'MariaDB', clickhouse: 'ClickHouse', pocketbase: 'PocketBase', wordpress: 'WordPress', directus: 'Directus',
  strapi: 'Strapi', metabase: 'Metabase', gitea: 'Gitea', nextcloud: 'Nextcloud', uptimekuma: 'Uptime Kuma', vaultwarden: 'Vaultwarden',
  gcp: 'Google Cloud', firebase: 'Firebase', cloudrun: 'Cloud Run', cloudfunctions: 'Cloud Functions', appengine: 'App Engine', cloudsql: 'Cloud SQL',
  firestore: 'Firestore', aws: 'AWS', amplify: 'AWS Amplify', lightsail: 'Lightsail', ec2: 'EC2', rds: 'Amazon RDS', route53: 'Route 53', azure: 'Azure',
  hetzner: 'Hetzner', linode: 'Linode', vultr: 'Vultr', githubpages: 'GitHub Pages', cloudflarepages: 'Cloudflare Pages', workers: 'Cloudflare Workers',
  grafana: 'Grafana', meilisearch: 'Meilisearch', typesense: 'Typesense', listmonk: 'Listmonk', nocodb: 'NocoDB', forgejo: 'Forgejo',
};
// ids used elsewhere that share a logo
export const PROVIDER_ALIAS: Record<string, string> = {
  'claude-code': 'claude', 'claude-desktop': 'claude', 'gemini-cli': 'gemini', postgresql: 'postgres', nodejs: 'node', 'google-drive': 'gdrive',
  googledrive: 'gdrive', flyio: 'fly', 'fly.io': 'fly', 'name.com': 'namecom', 'digital-ocean': 'digitalocean', next: 'nextjs',
  compose: 'docker', systemd: 'linux', mongo: 'mongodb',
};
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? PROVIDER_NAMES[PROVIDER_ALIAS[id] ?? ''] ?? id.charAt(0).toUpperCase() + id.slice(1);

// lowercase ids that are also everyday words (or commands) stay as they are inside sentences
const PLAIN_WORDS = new Set(['amplify', 'workers', 'domain', 'render', 'node', 'fly', 'webhook', 'forge', 'unit7', 'cursor', 'resend', 'go', 'bun', 'rust', 'remix', 'java', 'ruby', 'rails']);
const ID_IN_TEXT = new RegExp(`(?<![\\w./@:-])(${Object.keys(PROVIDER_NAMES).filter((id) => /^[a-z0-9]+$/.test(id) && !PLAIN_WORDS.has(id)).join('|')})(?![\\w/-]|\\.\\w)`, 'g');

// What a tool does, as a person would say it
export const TOOL_WORDS: Record<string, string> = {
  'asset.delete': 'Delete a project or app', 'asset.archive': 'Archive or bring back', 'asset.pause': 'Pause a database', 'asset.impact': 'See what deleting it affects',
  'deployment.create': 'Deploy a new version', 'deployment.rollback': 'Go back to the previous version', 'database.create': 'Create a database',
  'database.rotate_password': 'Change a database password', 'domain.point': 'Point a domain at an app', 'domain.remove': 'Remove a domain',
  'domain.move_dns': 'Move a domain’s DNS', 'domain.protect_email': 'Protect a domain’s email', 'server.exec': 'Run a command on a server', 'server.remove': 'Stop managing a server',
  'server.bootstrap': 'Set up a server', 'service.remove': 'Remove an app', 'service.stop': 'Stop an app', 'service.restart': 'Restart an app',
  'service.scale': 'Change how many copies run', 'env.set': 'Change a setting', 'env.unset': 'Remove a setting', 'backup.restore': 'Restore a backup',
  'backup.create': 'Back up a database', 'docker.prune': 'Free up disk space', 'docker.restart': 'Restart a container',
  'environment.policy': 'Change how much Unit7 does alone', 'autopilot.set': 'Pause or resume Autopilot', 'account.connect': 'Connect an account',
  'account.disconnect': 'Disconnect an account', 'project.create': 'Create a project', 'project.delete': 'Delete a project', 'service.create': 'Add an app',
  'server.connect': 'Connect a server', 'server.harden': 'Lock down a server', 'shield.block': 'Block a visitor', 'backup.verify': 'Check a backup restores',
  'domain.check': 'Check a domain', 'vault.set': 'Store a secret', 'vault.retire': 'Retire a secret', 'link.create': 'Wire two things together', 'sync.run': 'Refresh the map', 'cloud.billing': 'See what a cloud costs',
  'secrets.rotation': 'Change keys on a schedule', 'environment.earn': 'Let it earn more freedom', 'server.repair': 'Fix a server problem', 'server.diagnose': 'Find out why a server is down',
  'service.settings': 'Change how an app builds', 'backup.offsite_set': 'Turn off-server copies on or off', 'backup.folder_set': 'Copy backups into a synced folder', 'budget.set': 'Set a monthly budget',
  'part.restart': 'Restart something on a server', 'part.stop': 'Stop something on a server', 'part.start': 'Start something on a server', 'part.logs': 'Read its logs',
  'part.env': 'Change a setting on a server', 'part.run': 'Run a command in an app', 'part.update': 'Update something on a server', 'part.limits': 'Cap its memory or CPU',
  'part.remove': 'Move leftover data to the trash', 'part.impact': 'See what happens if…', 'part.adopt': 'Let Unit7 manage it', 'change.undo': 'Undo a change', 'change.list': 'See what changed',
  'server.swap': 'Add swap when memory is tight', 'server.tidy_logs': 'Tidy up logs', 'server.time_sync': 'Turn on time sync', 'server.protect_sites': 'Hide secret files on every site',
  'domain.renew_https': 'Renew an HTTPS certificate', 'coolify.backup': 'Back up a database in Coolify',
  // ready for real users, and the cost radar
  'project.readiness': 'Check it’s ready for real users', 'cost.radar': 'Add up what everything costs', 'backup.offsite_copy': 'Copy a backup off its server', 'backup.schedule': 'Schedule backups', 'errors.scan': 'Read an app’s errors', 'watch.check': 'Check everything now',
  // saved routines, and a domain from idea to live
  'routine.create': 'Save a routine', 'routine.update': 'Change a routine', 'routine.pause': 'Pause or resume a routine', 'routine.remove': 'Remove a routine',
  'routine.run_now': 'Run a routine now', 'routine.list': 'See routines', 'domain.ideas': 'Find a domain', 'domain.buy': 'Buy a domain', 'domain.launch': 'Set up a domain',
  // apps on a server (self-hosted Supabase, databases, MinIO, Grafana, n8n)
  'serverapp.list': 'See the apps on a server', 'serverapp.connect': 'Connect an app on a server', 'serverapp.disconnect': 'Disconnect an app on a server',
  'serverapp.keys': 'See an app’s keys', 'serverapp.reveal': 'Show an app’s key', 'serverapp.wire': 'Use an app on a server in another app', 'serverapp.action': 'Check, open, back up or update an app', 'serverapp.autoconnect': 'Connect apps found on a server',
};
// the story (src/story): what changed, a failure's replay, the morning brief
Object.assign(TOOL_WORDS, { 'story.timeline': 'See what changed', 'story.replay': 'Replay what happened', 'story.brief': 'Read the morning brief' });
Object.assign(TOOL_WORDS, { 'deployment.release': 'See how a release went', 'deployment.watch_stop': 'Stop watching a new version', 'release.settings': 'Change how releases work' });
// products and clients (src/organize)
Object.assign(TOOL_WORDS, {
  'group.suggest': 'Find what belongs together', 'group.accept': 'Group things into one product', 'group.rename': 'Rename a product',
  'group.remove_member': 'Take something out of a product', 'group.dissolve': 'Ungroup a product', 'group.dismiss': 'Turn down a grouping',
  'client.create': 'Add a client', 'client.update': 'Change a client', 'client.remove': 'Remove a client', 'client.assign': 'Move something to a client',
  'client.list': 'See clients', 'client.costs': 'See what each client costs', 'client.status_link': 'Change a client’s status page',
});
// test copies and tools added to a server (src/tools/staging.ts, src/tools/addons.ts)
Object.assign(TOOL_WORDS, {
  'staging.plan': 'Plan a test copy', 'staging.create': 'Make a test copy', 'staging.remove': 'Take a test copy down',
  'staging.copy_data': 'Copy data into a test copy', 'staging.copy_settings': 'Copy settings into a test copy',
  'addon.catalog': 'See tools to add', 'addon.install': 'Add a tool to a server', 'addon.remove': 'Take a tool off a server', 'addon.credentials': 'Show a tool’s keys', 'addon.unlock': 'Remove a tool’s extra password',
  'domain.canonical': 'Choose the main address', 'uptime.sync': 'Watch my sites in Uptime Kuma',
});
// WordPress sites on a server (src/tools/wordpress.ts)
Object.assign(TOOL_WORDS, {
  'wordpress.status': 'Look at a WordPress site', 'wordpress.update': 'Update WordPress', 'wordpress.plugin': 'Change a WordPress plugin', 'wordpress.staging': 'Make a WordPress test copy',
  'wordpress.import': 'Move a WordPress site in', 'wordpress.install': 'Add a WordPress site', 'wordpress.admin': 'Get into a WordPress site',
});
// what Unit7 does by itself on a server, inside rules a person set (tools/firstkey.ts, autofix.ts, reboot.ts)
Object.assign(TOOL_WORDS, {
  'server.install_key_with_password': 'Add Unit7’s key with the root password', 'server.fingerprint': 'Read a server’s identity',
  'autofix.settings': 'Let Warden fix safe things by itself', 'autofix.status': 'See what Warden fixes by itself',
  'reboot.window': 'Set a restart window', 'reboot.status': 'See a server’s restart window', 'server.reboot': 'Restart a server',
});
// backups of databases Unit7 found on a server, and "This is fine" (tools/partbackup.ts, tools/snooze.ts)
Object.assign(TOOL_WORDS, {
  'part.backup': 'Back up a database on a server', 'part.backup_schedule': 'Back up a database every day', 'part.backups': 'See a server’s database backups', 'part.restore': 'Bring back a database from a backup',
  'snooze.set': 'Hide something for now', 'snooze.list': 'See what’s hidden', 'snooze.clear': 'Bring something back',
});
// the five Autopilot levels, as people say them (Autopilot shows these with a longer explanation)
export const LEVEL_NAMES = ['Watch only', 'Suggest', 'Ask first', 'Fix itself, ask for risky', 'Full autopilot'];
// the server's own tool title (from /api/tools) is the next best thing to a hand-written line
export const toolWords = (tool: string, title?: string) => TOOL_WORDS[tool] ?? (title ? tidy(title) : tool.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));

// "Sam (token Unit7 connect · Claude Code)" → "Claude Code"; plain names stay as they are
export function whoWords(actor?: { kind?: string; name?: string; agent?: string } | string | null): string {
  const name = (typeof actor === 'string' ? actor : actor?.agent ?? actor?.name ?? '').replace(/\s*\(approved by [^)]*\)\s*$/, '');
  const tail = name.match(/·\s*([^)·]+)\)?\s*$/)?.[1];
  return (tail ?? name.replace(/\s*\(.*\)\s*$/, '')).trim() || 'Someone';
}

// tidy any server sentence: token names become the AI's name, the old product name becomes Unit7,
// and a provider id in a sentence becomes its name ("the hostinger account" → "the Hostinger account")
// A secret's address (credential://…) never reaches the screen: "not found" becomes what's missing,
// and any other mention becomes the secret's name.
const REF = /credential:\/\/[\w-]+(?:\/[\w.-]*[\w-])*/;
export const tidy = (text: string) => text
  .replace(/[\w .'-]+ \(token [^)]*·\s*([^)]+)\)/g, '$1')
  .replace(new RegExp(`The credential (${REF.source}) was not found\\.?`, 'g'), (_, ref: string) => missingWords(ref))
  .replace(new RegExp(REF.source, 'g'), (ref) => secretWords(ref).text)
  .replace(/\bForge\b/g, 'Unit7')
  .replace(/\bVPS\b/g, 'server')
  .replace(/https?:\/\//g, '')
  .replace(ID_IN_TEXT, (id) => providerName(id));

// for raw records: everything stays as recorded except secret addresses and the old product name
export const rawWords = (text: string) => text.replace(new RegExp(REF.source, 'g'), (ref) => secretWords(ref).text).replace(/\bForge\b/g, 'Unit7');

// what a missing secret means, in a sentence: a sign-in to connect, or a server's login key
function missingWords(ref: string) {
  const [provider = '', account = '', ...what] = ref.replace(/^credential:\/\//, '').split('/');
  if (provider === 'ssh') return `Unit7 doesn’t have the login key for ${account} yet.`;
  if (PROVIDER_NAMES[provider] && /^(oauth|token|api[-_]?(key|token)|key)$/.test(what.join('/'))) return `Unit7 isn’t signed in to ${providerName(provider)} yet. Connect it on Connections.`;
  return `Unit7 is missing a saved secret (${secretWords(ref).text}).`;
}

// Warden's short reasons, said plainly
export const reasonWords = (why: string) => tidy(why).replace(/^Warden: /, '')
  .replace(/^new commit \w+$/, 'new code was pushed').replace(/^container down$/, 'the app stopped responding');

// An approval as a short title ("Point shop.acme.app at an app", "Remove preview-web") and who asked. `name` turns
// ids (svc_…, srv_…, prj_…) into names, so the title says which thing.
export function approvalWords(a: { tool: string; input?: any; actor?: any; environment?: string | null; why?: string; reason?: string | null }, name: (id?: string) => string | undefined = () => undefined) {
  const i = a.input ?? {};
  const app = name(i.serviceId), server = name(i.serverId);
  const thing = a.tool.startsWith('part.') ? (i.part ? partName(i.part) : undefined) : app ?? server ?? name(i.projectId);
  const title = a.tool === 'domain.point' && i.hostname ? `Point ${i.hostname} at ${app ?? 'an app'}`
    : a.tool === 'domain.remove' && i.hostname ? `Remove ${i.hostname}`
    : a.tool === 'database.create' && i.engine ? `Create a ${providerName(i.engine)} database`
    : a.tool === 'domain.protect_email' && i.domain ? `Protect ${i.domain}’s email`
    : a.tool === 'domain.move_dns' && i.domain ? `Move ${i.domain}’s DNS to Cloudflare`
    : NAMED[a.tool] && thing ? NAMED[a.tool]!(thing, i)
    : toolWords(a.tool);
  const why = a.environment ? `${a.environment} is protected, so this waits for your OK.` : 'This touches your whole account, so it waits for your OK.';
  return { title, who: whoWords(a.actor), why, raw: [a.why, a.reason, i.command, i.content].filter(Boolean).join(' · ') };
}

// approval titles that say which thing ("Remove preview-web", "Restart api")
const NAMED: Record<string, (x: string, i: any) => string> = {
  'service.remove': (x) => `Remove ${x}`, 'service.stop': (x) => `Stop ${x}`, 'service.restart': (x) => `Restart ${x}`, 'service.scale': (x, i) => `Run ${i.replicas ?? 'more'} cop${i.replicas === 1 ? 'y' : 'ies'} of ${x}`,
  'deployment.create': (x) => `Deploy ${x}`, 'deployment.rollback': (x) => `Roll ${x} back`, 'backup.restore': (x) => `Restore ${x} from a backup`, 'backup.create': (x) => `Back up ${x}`,
  'database.rotate_password': (x) => `Change ${x}’s password`, 'env.set': (x, i) => `Change ${i.key ?? 'a setting'} in ${x}`, 'env.unset': (x, i) => `Remove ${i.key ?? 'a setting'} from ${x}`,
  'server.exec': (x) => `Run a command on ${x}`, 'server.remove': (x) => `Stop managing ${x}`, 'server.harden': (x) => `Lock down ${x}`, 'docker.prune': (x) => `Free up disk space on ${x}`,
  'project.delete': (x) => `Delete ${x}`, 'part.restart': (x) => `Restart ${x}`, 'part.stop': (x) => `Stop ${x}`, 'part.start': (x) => `Start ${x}`, 'part.update': (x) => `Update ${x}`,
  'part.env': (x, i) => `Change ${i.key ?? 'a setting'} of ${x}`, 'part.run': (x) => `Run a command in ${x}`, 'part.limits': (x) => `Cap ${x}’s memory or CPU`, 'part.remove': (x) => `Move ${x}’s leftover data to the trash`,
  'server.swap': (x, i) => (i.off ? `Remove the swap from ${x}` : `Add swap to ${x}`), 'server.tidy_logs': (x) => `Tidy up logs on ${x}`, 'server.time_sync': (x) => `Turn on time sync on ${x}`,
  'server.protect_sites': (x) => `Hide secret files on ${x}’s sites`,
};

// The same thing again and again in a row is one line that says how many times ("Remove preview-web · 3 times").
export function foldRuns<T>(list: T[], key: (x: T) => string): (T & { times: number })[] {
  const out: (T & { times: number })[] = [];
  for (const x of list) {
    const prev = out.at(-1);
    if (prev && key(prev) === key(x)) prev.times++;
    else out.push({ ...x, times: 1 });
  }
  return out;
}

// Warden's badge and its panel say the same count: "5 need a look · 2 tips"
export const lookWords = (todo: number, tips: number) =>
  [todo && `${todo} need${todo === 1 ? 's' : ''} a look`, tips && `${tips} tip${tips === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'all clear';

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';
export interface Said { text: string; tone: Tone; word: string }

const SEVERITY: Record<string, [Tone, string]> = { success: ['ok', 'Done'], warning: ['warn', 'Heads up'], critical: ['bad', 'Problem'], info: ['neutral', 'Info'] };

// An event as one plain line, a tone and a one-word status
// o.attention: how many things need a look right now (the Map's own count), for the newest "Map refreshed" line
export function eventWords(e: { type: string; severity?: string; message?: string; resource?: string | null; data?: any }, o: { attention?: number } = {}): Said {
  const m = e.message ?? '';
  const d = e.data ?? {};
  const say = (text: string, tone: Tone, word: string): Said => ({ text: tidy(text), tone, word });
  const t = e.type;
  let x: RegExpMatchArray | null;
  if (t === 'approval.requested') return say(`${whoWords(m.split(' wants to ')[0])} wants to ${toolWords(d.tool ?? '').toLowerCase()}`, 'warn', 'Needs you');
  if (t === 'approval.rejected' || t === 'approval.approved') {
    const tool = m.split(' ').pop() ?? '';
    return t === 'approval.approved' ? say(`Approved: ${toolWords(tool).toLowerCase()}`, 'ok', 'Approved') : say(`Said not now to: ${toolWords(tool).toLowerCase()}`, 'neutral', 'Skipped');
  }
  if (t === 'deployment.succeeded' && (x = m.match(/^(.+?) deploy #\d+ is live(?: at (\S+))?/))) return say(x[2] ? `${x[1]} is live at ${x[2]}` : `${x[1]} is live`, 'ok', 'Live');
  if (t === 'deployment.started' && (x = m.match(/^Deploy #\d+ of (.+) started/))) return say(`Deploying ${x[1]}`, 'neutral', 'Started');
  if (t === 'deployment.auto' && (x = m.match(/deploying (.+)$/))) return say(`New code pushed, deploying ${x[1]}`, 'neutral', 'Started');
  if (t === 'deployment.failed' && (x = m.match(/^Deploy #\d+ of (.+?) failed:?\s*(.*)$/))) return say(`${x[1]} didn’t go live${x[2] ? `: ${x[2].replace(/^\w/, (c) => c.toLowerCase())}` : ''}`, 'bad', 'Failed');
  if (t.startsWith('deployment.roll') || t === 'service.rollback') return say(m, 'warn', 'Rolled back');
  if (t === 'backup.created') return say(m.split(' — ')[0]!, 'ok', 'Done');
  if (t === 'backup.offsite' || t === 'backup.verified') return say(t === 'backup.verified' && (x = m.match(/^Backup of (\S+)/)) ? `${x[1]}’s backup restores cleanly` : m, 'ok', 'Safe');
  if (t.startsWith('backup.') && t.includes('fail')) return say(m, 'bad', 'Failed');
  if (t === 'shield.blocked' && (x = m.match(/ on (\S+)/))) return say(`Blocked a suspicious visitor on ${x[1]}`, 'ok', 'Blocked');
  if (t === 'sync.done') { const n = o.attention ?? Number(m.match(/(\d+) to look at/)?.[1] ?? 0); return say(`Map refreshed${n ? ` · ${n} thing${n > 1 ? 's' : ''} to look at` : ''}`, 'neutral', 'Updated'); }
  if (t === 'domain.takeover_risk') return say(`${e.resource ?? m.split(' ')[0]} points at an app that’s gone. Anyone could take it over.`, 'bad', 'Fix this');
  if (t === 'domain.broken') return say(`${m.split(' (')[0]}`, 'bad', 'Broken');
  if (t === 'domain.expiring') return say(m, 'warn', 'Expiring');
  if (t === 'app.errors' && (x = m.match(/^([^:]+):.*?\((\d+) times? (in [^)]*)\)/))) return say(`${x[1]} is showing errors (${x[2]} ${x[3]})`, 'warn', 'Errors');
  if (t === 'app.errors') return say(`${m.split(':')[0]} is showing errors`, 'warn', 'Errors');
  if (t === 'service.down' || t === 'site.down' || t === 'server.unreachable') return say(m, 'bad', 'Down');
  if (t === 'service.unhealthy' || t === 'site.slow') return say(m, 'warn', 'Slow');
  if (t === 'site.recovered' || t === 'service.restarted') return say(m, 'ok', 'Done');
  if (t === 'server.disk_high') return say(m, 'warn', 'Disk full soon');
  // the server watch: something unusual (usage, traffic, a new risk), back to normal, the weekly digest
  if (t === 'watch.anomaly' || t === 'watch.traffic' || t === 'watch.finding') return say(m, e.severity === 'critical' ? 'bad' : 'warn', t === 'watch.finding' ? 'New risk' : t === 'watch.traffic' ? 'Traffic' : 'Unusual');
  if (t === 'watch.cleared') return say(m, 'ok', 'Normal again');
  // an alert whose problem is gone (a fix checked, or its next check): "Cleared: …"
  if (t === 'alert.cleared') return say(m.replace(/^Cleared( on [^:]+)?: /, (_, on) => on ? `${on.slice(4)}: ` : ''), 'ok', 'Cleared');
  if (t === 'map.rechecked') return say('Checked again', 'neutral', 'Checked');
  if (t === 'watch.digest') return say(m, 'neutral', 'Your week');
  if (t === 'story.brief') return say(m, 'neutral', 'Morning brief');
  // actions use the same words as Approvals and the record ("Add an app", not "Create a service")
  const what = (title: string) => (typeof d.tool === 'string' && TOOL_WORDS[d.tool]) || title.replace(/\ba service\b/g, 'an app').replace(/\bservice\b/g, 'app');
  if (t === 'action.completed' && (x = m.match(/^(.+?): (.+)$/))) return say(`${whoWords(x[1])}: ${what(x[2]).replace(/^\w/, (c) => c.toLowerCase())}`, 'ok', 'Done');
  if (t === 'action.failed' && (x = m.match(/^(.+?) failed: (.+)$/))) return say(`${what(x[1])} didn’t work: ${x[2]}`, 'bad', 'Failed');
  if (t === 'action.failed') return say(m, 'bad', 'Failed');
  if (t === 'policy.changed' && (x = m.match(/^(.+?) set (.+) to autonomy (\d)$/))) return say(`${whoWords(x[1])} set ${x[2]} to “${LEVEL_NAMES[Number(x[3])] ?? x[3]}”`, 'neutral', 'Changed');
  if (t === 'policy.changed' && (x = m.match(/^(.+?) let (.+?) earn autonomy/))) return say(`${whoWords(x[1])} let ${x[2]} earn more freedom`, 'neutral', 'Changed');
  if (t === 'policy.changed' && (x = m.match(/^(.+?) fixed (.+?)’?'?s autonomy$/))) return say(`${whoWords(x[1])} stopped ${x[2]} earning more freedom`, 'neutral', 'Changed');
  if (t === 'policy.changed') return say('Autopilot settings changed', 'neutral', 'Changed');
  if (t === 'secret.revealed' && (x = m.match(/^(.+?) revealed (\S+)$/))) return say(`${whoWords(x[1])} looked at the hidden setting ${x[2]}`, 'neutral', 'Info');
  if (t === 'secret.revealed') return say(m, 'neutral', 'Info');
  // a change on a server that keeps its undo
  if (t === 'change.made') return say(m.replace(/\. It can be undone\.$/, ''), 'neutral', 'Changed');
  if (t === 'change.undone') return say(m, 'ok', 'Undone');
  if (t === 'change.rolled_back') return say(m, 'warn', 'Put back');
  if (t === 'budget.over') return say(m, 'bad', 'Over budget');
  if (t === 'budget.warning') return say(m, 'warn', 'Heads up');
  // "Let Unit7 fix it" from a phone alert: started, fixed, didn't work, not now
  if (t.startsWith('care.')) return say(m, t === 'care.fixed' ? 'ok' : t === 'care.fix_failed' ? 'bad' : 'neutral', t === 'care.fixed' ? 'Fixed' : t === 'care.fix_failed' ? 'Didn’t work' : t === 'care.declined' ? 'Not now' : 'Looking');
  // by itself, inside rules a person set: a safe fix (its Undo is the row's button), a fresh server, a restart window
  if (t === 'autofix.applied') return say(m.replace(/ · Undo$/, ''), 'ok', 'Fixed');
  if (t === 'server.preparing') return say(m, 'neutral', 'Preparing');
  if (t === 'server.shared') return say(m, 'neutral', 'Shared');
  if (t === 'reboot.soon') return say(m, 'warn', 'In 10 min');
  if (t === 'reboot.done') return say(m, e.severity === 'success' ? 'ok' : 'warn', 'Restarted');
  if (t === 'reboot.window') return say(m, 'neutral', 'Changed');
  // the watch after a deploy (src/deploy/release.ts); rolling back by itself reads as "Rolled back" above
  if (t === 'deployment.watch_started') return say(m, 'neutral', 'Watching');
  if (t === 'deployment.watch_ok') return say(m, 'ok', 'Looks good');
  if (t === 'deployment.watch_bad') return say(m, 'warn', 'Worse');
  const [tone, word] = SEVERITY[e.severity ?? 'info'] ?? SEVERITY.info!;
  return say(m, tone, word);
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// What an approval will change, in one plain sentence. `name` turns ids (svc_…, srv_…) into names.
// an X-ray part id (c:shop-web-1, pm2:api, unit:worker.service) as its plain name
const partName = (p?: string) => String(p ?? 'It').replace(/^(stack:.*:|[a-z0-9]+:)/, '').replace(/\.service$/, '');
// a port closed or opened, a database backed up every day (tools/security.ts, tools/partbackup.ts)
Object.assign(TOOL_WORDS, { 'server.close_port': 'Close a door to the internet' });
Object.assign(NAMED, {
  'server.close_port': (x: string, i: any) => (i.open ? `Open port ${i.port} on ${x} again` : `Close port ${i.port} on ${x} to the internet`),
  'part.backup_schedule': (x: string, i: any) => (i.off ? `Stop backing up ${x}` : `Back up ${x} every day`),
  'part.backup': (x: string) => `Back up ${x} now`,
  'part.restore': (x: string, i: any) => (i.into === 'live' ? `Restore ${x} from a backup` : `Make a test copy of ${x} from a backup`),
});
// files on a server (tools/files.ts)
Object.assign(TOOL_WORDS, { 'file.list': 'See the files on a server', 'file.read': 'Read a file on a server', 'file.write': 'Save a file on a server', 'file.upload': 'Upload a file to a server', 'file.download': 'Download a file from a server', 'file.move': 'Move a file on a server', 'file.remove': 'Move a file to the trash' });
Object.assign(NAMED, {
  'file.write': (x: string, i: any) => `Save ${i.path} on ${x}`, 'file.upload': (x: string, i: any) => `Upload ${i.path} to ${x}`,
  'file.move': (x: string, i: any) => `Move ${i.path} on ${x}`, 'file.remove': (x: string, i: any) => `Move ${i.path} on ${x} to the trash`,
});
export function changeWords(tool: string, input: any = {}, name: (id?: string) => string | undefined = () => undefined): string {
  const i = input ?? {};
  const app = name(i.serviceId) ?? 'the app';
  const server = name(i.serverId) ?? 'the server';
  switch (tool) {
    case 'domain.point': return `${i.hostname ?? 'The domain'} will open ${name(i.serviceId) ?? 'your app'}${String(i.hostname ?? '').startsWith('*.') ? '. Its certificate needs one more step from you' : ', with HTTPS'}.`;
    case 'domain.remove': return `${i.hostname ?? 'The domain'} stops pointing at your app.`;
    case 'domain.redirect': return i.remove ? `${i.from ?? 'It'} stops sending visitors elsewhere.` : `${i.from ?? 'The domain'} sends visitors to ${i.to ?? 'the new address'}.`;
    case 'dns.set': return `${i.name ?? 'The name'} gets a ${i.type ?? 'DNS'} record: ${i.value ?? ''}. Undo puts the old one back.`;
    case 'dns.remove': return `The ${i.type ?? 'DNS'} record at ${i.name ?? 'that name'} goes. Undo puts it back.`;
    case 'client.subdomain': return `${i.name ?? 'The client'}.${i.domain ?? 'your domain'} opens the client’s app, with HTTPS.`;
    case 'domain.protect_email': return `${i.domain ?? 'The domain'} gets records that stop strangers sending email as it.`;
    case 'domain.move_dns': return `${i.domain ?? 'The domain'}’s DNS moves to Cloudflare. The site stays up.`;
    case 'domain.canonical': { const d = String(i.domain ?? 'the domain').replace(/^www\./, ''); return i.prefer === 'www' ? `${d} sends visitors to www.${d}, keeping the page they asked for.` : `www.${d} sends visitors to ${d}, keeping the page they asked for.`; }
    case 'uptime.sync': return `Uptime Kuma on ${server} checks each of your sites every minute. Your own monitors stay as they are.`;
    case 'service.remove': return `${cap(app)} is removed. ${i.deleteData ? 'Its data is deleted too.' : 'Its data is kept.'}`;
    case 'service.stop': return `${cap(app)} stops until you start it again.`;
    case 'service.restart': return `${cap(app)} restarts. It may be offline for a few seconds.`;
    case 'deployment.rollback': return `${cap(app)} goes back to the version before this one.`;
    case 'deployment.create': return `A new version of ${app} goes live.`;
    case 'database.create': return `A new ${i.engine ? `${providerName(i.engine)} ` : ''}database is created.`;
    case 'database.rotate_password': return `${cap(app)} gets a new password. Apps that use it restart.`;
    case 'backup.restore': return 'A database goes back to an earlier backup. Newer changes are lost.';
    case 'env.set': return `The setting ${i.key ?? ''} changes. Apps that use it restart.`.replace('  ', ' ');
    case 'env.unset': return `The setting ${i.key ?? ''} is removed.`.replace('  ', ' ');
    case 'server.exec': return `Unit7 runs a command on ${server}.`;
    case 'server.remove': return `Unit7 stops looking after ${server}.`;
    case 'docker.prune': return `Unused files are cleared off ${server} to free space.`;
    case 'part.restart': return `${partName(i.part)} on ${server} restarts. It may be offline for a few seconds.`;
    case 'part.stop': return `${partName(i.part)} on ${server} stops until it’s started again (Undo starts it).`;
    case 'part.start': return `${partName(i.part)} on ${server} starts.`;
    case 'part.env': return `The setting ${i.key ?? ''} of ${partName(i.part)} changes, and it restarts. The old settings are kept to undo.`;
    case 'part.run': return `Unit7 runs a command in ${partName(i.part)} on ${server}.`;
    case 'part.update': return `${partName(i.part)} gets its newest version. The current one is kept to go back to.`;
    case 'part.limits': return `${partName(i.part)} gets a cap${i.memoryMb ? ` of ${i.memoryMb} MB of memory` : ''}${i.memoryMb && i.cpus ? ' and' : ''}${i.cpus ? ` of ${i.cpus} CPU${i.cpus === 1 ? '' : 's'}` : ''}.`;
    case 'part.remove': return `${partName(i.part)} moves to a 7-day trash on ${server}. Undo brings it back.`;
    case 'change.undo': return 'A change Unit7 made goes back to how it was.';
    case 'file.write': case 'file.upload': return `${i.path ?? 'The file'} on ${server} gets new content. The old copy is kept to undo.`;
    case 'file.move': return `${i.path ?? 'The file'} moves to ${i.to ?? 'a new place'} on ${server}. Undo moves it back.`;
    case 'file.remove': return `${i.path ?? 'The file'} moves to a 7-day trash on ${server}. Undo brings it back.`;
    case 'server.swap': return i.off ? `${cap(server)} loses Unit7’s swap. Apps keep running.` : `${cap(server)} gets up to 2 GB of swap, so a memory spike slows it down instead of stopping apps.`;
    case 'server.tidy_logs': return `Old system log lines and downloaded package files are cleared off ${server}. Apps keep running.`;
    case 'server.time_sync': return `${cap(server)}’s clock is kept right by itself from now on.`;
    case 'server.protect_sites': return `Every site on ${server} answers “not found” for secret files like .env and .git.`;
    case 'server.reboot': return `${cap(server)} restarts: offline for a minute or two. Unit7 backs up its databases first and checks every site comes back.`;
    case 'server.bootstrap': return `${cap(server)} gets Docker, automatic HTTPS and security updates${i.firewall === false ? '' : ', and a firewall unless other apps there need their own ports'}.`;
    case 'domain.renew_https': return i.restartProxy ? 'Coolify’s proxy restarts so it tries the certificate again: every site pauses for a few seconds.' : 'The web proxy renews the HTTPS certificate now. No visitor is cut off.';
    case 'server.close_port': return i.open ? `Port ${i.port} on ${server} answers the internet again.` : `Nobody on the internet can reach port ${i.port} on ${server} any more. Your apps still reach it inside the server.`;
    case 'part.backup_schedule': return i.off ? `${partName(i.part)} isn’t backed up by Unit7 any more. Copies already made stay.` : `${partName(i.part)} is copied every day (the first copy now), the last ${i.keep ?? 7} kept, encrypted off the server. Nothing in the database changes.`;
    case 'part.restore': return i.into === 'live' ? `${partName(i.part)} goes back to the backup. Newer changes are lost; Unit7 backs it up as it is now first.` : `A test copy of ${partName(i.part)} starts next to it from the backup. The live one doesn’t change.`;
    case 'part.backup': return `${partName(i.part)} is copied now and the copy goes off the server, encrypted. Nothing in the database changes.`;
  }
  return `${toolWords(tool)}.`;
}

// "credential://postgres/db/password" → PostgreSQL · db · password (the raw ref stays for a tooltip)
export function secretWords(ref: string) {
  const [provider = '', ...rest] = ref.replace(/^credential:\/\//, '').split('/');
  return { provider, text: [providerName(provider), ...rest.map((x) => x.replace(/[-_]+/g, ' '))].join(' · ') };
}

// Activity's filters. Problems aren't a kind: they're anything whose eventWords tone is bad or warn.
export type EventKind = 'deploys' | 'fixes' | 'security' | 'backups' | 'other';
export function eventKind(type: string): EventKind {
  if (type.startsWith('backup.')) return 'backups';
  if (/^(service\.(restarted|rollback|autoscaled|scaled)|site\.recovered|server\.(disk_freed|hardened)|deployment\.(healed|healing|rolledback))$/.test(type)) return 'fixes';
  if (type.startsWith('deployment.')) return 'deploys';
  if (/^(shield|secret|approval|policy|autopilot|auth|account)\.|^agent\.(connected|disconnected)$|^server\.(host_key_changed|key_refused)$|^domain\.takeover_risk$/.test(type)) return 'security';
  return 'other';
}

// The server records one action twice: "Sam: Remove a service" and "Removed preview-web (data
// kept)". Keep the specific one, remember who did it, and drop the echo.
const ECHO: Record<string, string> = {
  'environment.policy': 'policy.changed', 'environment.earn': 'policy.changed', 'service.remove': 'service.removed', 'service.restart': 'service.restarted',
  'project.create': 'project.created', 'project.delete': 'project.deleted', 'database.create': 'database.created', 'server.connect': 'server.connected', 'account.connect': 'account.connected',
  'asset.delete': 'asset.deleted', 'asset.archive': 'asset.archived', 'asset.pause': 'asset.paused',
};
const BY_TITLE: Record<string, string> = { 'Restart a service': 'service.restart', 'Remove a service': 'service.remove', 'Create a project': 'project.create' };
interface Ev { type: string; message?: string; data?: any; created_at: string }
export function foldEchoes<T extends Ev>(events: T[]): (T & { by?: string })[] {
  const by = new Map<T, string>();
  const drop = new Set<T>();
  // ponytail: scans the whole list per action; fine for the few hundred events a page shows
  for (const a of events) {
    if (a.type !== 'action.completed') continue;
    const m = (a.message ?? '').match(/^(.+?): (.+)$/);
    const tool = typeof a.data?.tool === 'string' ? a.data.tool : BY_TITLE[m?.[2] ?? ''];
    const near = (e: T) => !by.has(e) && Math.abs(Date.parse(e.created_at) - Date.parse(a.created_at)) < 2000;
    // its known echo, else the line it said about the same kind of thing in the same moment ("Sam added the client Northwind")
    const twin = tool && ECHO[tool] ? events.find((e) => e.type === ECHO[tool] && near(e))
      : m && tool ? events.find((e) => e.type.split('.')[0] === tool.split('.')[0] && near(e) && (e.message ?? '').startsWith(`${m[1]} `)) : undefined;
    if (twin) { drop.add(a); by.set(twin, whoWords(m?.[1] ?? '')); }
  }
  return events.filter((e) => !drop.has(e)).map((e) => (by.has(e) ? { ...e, by: by.get(e) } : e));
}

// --- ⌘K never dead-ends: whatever you type can be asked, said with where you are ---------------------------------
// where: the page you're on ("On srv-1", "For shop, Staging"); name: the thing it's about, so "restart srv-1" on
// srv-1's page isn't said twice
export function askWords(typed: string, where?: { prefix: string; name: string }) {
  const t = typed.trim();
  return !where || !t || t.toLowerCase().includes(where.name.toLowerCase()) ? t : `${where.prefix}: ${t}`;
}
// the six things people ask most, matched by a word, each as a whole sentence about the thing you're looking at
const ASK_VERBS: { id: string; words: string[]; say: (x?: string) => string }[] = [
  { id: 'deploy', words: ['deploy', 'ship', 'publish', 'go live', 'launch', 'release'], say: (x) => `Deploy ${x ?? 'my app'} and give me the link` },
  { id: 'domain', words: ['domain', 'dns', 'address', 'url', 'subdomain'], say: (x) => `Connect a domain to ${x ?? 'my app'}` },
  { id: 'backup', words: ['backup', 'back up', 'snapshot', 'save a copy'], say: (x) => `Back up ${x ? `${x}’s data` : 'my database'} now` },
  { id: 'restart', words: ['restart', 'reboot', 'reload', 'kick'], say: (x) => `Restart ${x ?? 'my app'}` },
  { id: 'logs', words: ['logs', 'log', 'errors', 'error', 'crash'], say: (x) => `Show me the latest logs of ${x ?? 'my app'} and what’s wrong` },
  { id: 'rollback', words: ['roll back', 'rollback', 'revert', 'undo', 'previous version', 'go back'], say: (x) => `Roll ${x ?? 'my app'} back to the previous version` },
];
export function verbAsks(typed: string, subject?: string): { id: string; text: string }[] {
  const q = typed.trim().toLowerCase();
  if (q.length < 2) return [];
  return ASK_VERBS.filter((v) => v.words.some((w) => w.startsWith(q) || q.includes(w))).map((v) => ({ id: v.id, text: v.say(subject) }));
}

// DNS records of any kind, redirects, a client's own address (tools/clouds-dns.ts, tools/redirects.ts, organize/clients.ts)
Object.assign(TOOL_WORDS, {
  'dns.list': 'See DNS records', 'dns.set': 'Add or change a DNS record', 'dns.remove': 'Remove a DNS record',
  'domain.redirect': 'Send a domain or a page somewhere else', 'client.subdomain': 'Give a client their own address',
});
// the big clouds (src/tools/clouds-*.ts): DNS records, redeploys, spending alerts and the cost-spike stopper
Object.assign(TOOL_WORDS, {
  'domain.remove_record': 'Remove a DNS record', 'cloud.redeploy': 'Redeploy, restart or roll back a cloud app', 'cloud.app_actions': 'See what a cloud app can do',
  'cloud.budget_set': 'Set a spending alert', 'cloud.spend': 'See spending by day', 'cloud.spend_watch': 'Watch cloud spending',
  'cloud.stop_runaway': 'Stop the runaway thing', 'cloud.billing_export': 'Look for Google’s billing export',
});
// keep it fresh (tools/fresh.ts)
Object.assign(TOOL_WORDS, {
  'fresh.plan': 'See what’s outdated', 'fresh.status': 'See updates at a glance', 'fresh.batch': 'See a batch of updates', 'fresh.report': 'See how the week went',
  'fresh.run': 'Get updates ready', 'fresh.release': 'Release updates', 'fresh.hold': 'Hold updates back', 'fresh.settings': 'Change how far updates go', 'fresh.server_patch': 'Install a server’s security updates',
});
// Coolify's own address, then its port closed (tools/coolify-dashboard.ts)
Object.assign(TOOL_WORDS, {
  'coolify.dashboard_domain': 'Give Coolify a domain, then close its port', 'coolify.instance_domain': 'Set Coolify’s own address',
  'coolify.dashboard': 'See where Coolify opens', 'server.closed_ports': 'Check closed ports from outside',
});
Object.assign(NAMED, {
  'coolify.dashboard_domain': (x: string, i: any) => (i.domain ? `Give Coolify on ${x} the address ${i.domain}, then close its port` : `Close Coolify’s ports on ${x}`),
  'coolify.instance_domain': (x: string, i: any) => (i.url ? `Set ${String(i.url).replace(/^https:\/\//, '')} as Coolify’s address on ${x}` : `Take Coolify’s address away on ${x}`),
});
// many servers (tools/fleet.ts, tools/dr.ts, tools/coolify-fleet.ts)
Object.assign(TOOL_WORDS, {
  'fleet.get': 'See an app’s servers', 'fleet.readiness': 'Check it’s ready for more servers', 'fleet.traffic': 'See how visitors are spread', 'fleet.deploy': 'Roll a release across servers',
  'fleet.control': 'Pause or roll back a rollout', 'fleet.add_server': 'Run an app on one more server', 'fleet.remove_server': 'Stop running an app on a server', 'fleet.rotate': 'Take a server out, or put it back',
  'fleet.canary': 'Try a new version on some visitors', 'fleet.canary_control': 'Promote or roll back the new version', 'fleet.care': 'Check the servers are alike',
  'fleet.sync_settings': 'Give every server the current settings', 'fleet.server_offers': 'See servers you could add', 'fleet.buy_server': 'Buy a server', 'fleet.regions': 'See where visitors come from', 'fleet.label_region': 'Say where a server is',
  'dr.setup': 'Keep a warm standby', 'dr.status': 'See the standby', 'dr.refresh': 'Copy fresh data to the standby', 'dr.failover': 'Switch visitors to the standby', 'dr.drill': 'Test the standby', 'dr.remove': 'Stop keeping a standby',
  'coolify.servers': 'See a Coolify app’s servers', 'coolify.add_server': 'Run a Coolify app on one more server', 'coolify.remove_server': 'Stop running a Coolify app on a server',
});

// an app in Coolify, day to day (tools/coolify-app.ts)
Object.assign(TOOL_WORDS, {
  'coolify.auto_deploy': 'Turn deploy on push on or off', 'coolify.previews': 'Turn pull request previews on or off', 'coolify.storage': 'Change an app’s storage', 'coolify.scale': 'See if an app can have more copies',
});
// a server itself (tools/vps.ts, tools/access.ts, tools/move.ts, tools/security.ts)
Object.assign(TOOL_WORDS, {
  'server.snapshot': 'Snapshot a whole server', 'server.open_port': 'Open a door to the internet', 'hostinger.firewall': 'Change Hostinger’s firewall', 'server.ssh_keys': 'Change who can sign in', 'server.users': 'Change a server’s users',
  'server.resize': 'See or change a server’s plan', 'server.offers': 'See servers you could buy', 'server.buy': 'Buy a server', 'server.power': 'Turn a server off or on', 'server.delete': 'Delete a server for good',
  'server.move_plan': 'Plan a server move', 'server.move': 'Copy a server to a new one', 'server.move_start': 'Start Coolify on the new server', 'team.give_access': 'Give a teammate server access', 'team.email_invite': 'Email an invite',
});
Object.assign(NAMED, {
  'server.open_port': (x: string, i: any) => `Open port ${i.port} on ${x} to the internet`,
  'server.ssh_keys': (x: string, i: any) => (i.op === 'add' ? `Add an SSH key to ${x}` : i.op === 'remove' ? `Remove an SSH key from ${x}` : `See who can sign in to ${x}`),
  'server.users': (x: string, i: any) => (i.op === 'add' ? `Add ${i.user} to ${x}` : i.op === 'remove' ? `Take ${i.user} off ${x}` : `See the users on ${x}`),
  'server.snapshot': (x: string, i: any) => (i.op === 'restore' ? `Take ${x} back to a snapshot` : i.replace ? `Replace ${x}’s snapshot` : i.op === 'create' ? `Take a snapshot of ${x}` : `See ${x}’s snapshots`),
  'server.power': (x: string, i: any) => `Turn ${x} ${i.op}`,
  'server.resize': (x: string, i: any) => (i.plan ? `Move ${x} to ${i.plan}` : `See what fits ${x}`),
  'server.move': (x: string) => `Copy ${x} to a new server`,
});

// Staging → Production (tools/promote.ts), and the chat's Delete card (tools/ui.ts)
Object.assign(TOOL_WORDS, { 'deployment.promote': 'Promote to Production', 'ui.delete': 'Ask about deleting it' });
Object.assign(NAMED, { 'deployment.promote': (x: string) => `Promote ${x} to Production` });

// A raw error (often with a build log under it) as ONE plain sentence for a toast or a chat line, and the whole text
// for "Show details". line: the first line that reads like words (not a log line), tidied, one sentence, cut on a word
// under max. more: the full text (secret addresses masked) when the line doesn't already say it all.
const LOGGY = /^\s*(\d{2}:\d{2}:\d{2}|#\d+\s|\[[^\]]*\]\s|at\s+\S+\s*\(|at\s+[\w.<>]+:\d|npm (ERR!|error|warn)|pnpm|yarn|ERR_|WARN|>\s|\$\s|[│├└┌┐╭╰|]|\S+\.(tsx?|jsx?|json|lock|ya?ml|py|go|rs)[:(]|(\w+)?Error:|E[A-Z]{3,}\b|\{|\}|\/[\w.-]+\/)/;
export function plainError(text: string | null | undefined, max = 160): { line: string; more?: string } {
  const raw = String(text ?? '').replace(/\r/g, '').trim();
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  let line = tidy(lines.find((l) => !LOGGY.test(l) && /[a-z]{2,}\s+[a-z]{2,}/i.test(l)) ?? (lines.length === 1 && lines[0]!.length < 80 ? lines[0]! : ''))
    .replace(/\s*(Last output|Output|Logs?|Details):?\s*$/i, '')
    .replace(/:\s*((\w+)?Error|E[A-Z]{3,}|ERR_\w+)\b.*$/, '.') // "Deploy failed: Error: EACCES …" → "Deploy failed."
    .replace(/[\s:;,-]+$/, '');
  const stop = line.search(/[.!?](\s|$)/);
  if (stop >= 12) line = line.slice(0, stop + 1);
  if (line.length > max) { const cut = line.lastIndexOf(' ', max - 1); line = `${line.slice(0, cut > max / 2 ? cut : max - 1).replace(/[\s,:;]+$/, '')}…`; }
  if (line && !/[.!?…]$/.test(line)) line += '.';
  if (!line) return { line: 'Something went wrong.', ...(raw && { more: rawWords(raw) }) };
  return lines.length > 1 || raw.length > line.length + 12 ? { line, more: rawWords(raw) } : { line };
}

// A toast's body: never more than two short lines. A short one stays as it is; a long or many-line one (a raw log)
// becomes its one plain sentence, and the rest moves under "Show details".
const TOAST_MAX = 180;
export function toastBody(body?: string): { line?: string; more?: string } {
  if (!body) return {};
  if (!body.includes('\n') && body.length <= TOAST_MAX) return { line: body };
  return plainError(body);
}
