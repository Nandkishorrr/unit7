// Writes web/src/brand/logos.generated.ts with only the third-party logos the app shows.
// Colored logos come from @iconify-json/logos; anything missing there falls back to simple-icons
// (one path in the brand color). Logos that are a single dark color become currentColor so they
// stay visible in dark mode. Run: npm run brand:logos
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as simple from 'simple-icons';

const require = createRequire(import.meta.url);
const iconify = JSON.parse(readFileSync(require.resolve('@iconify-json/logos/icons.json'), 'utf8'));

// our id → [iconify logos name, simple-icons slug]; either may be missing
const WANT = {
  vercel: ['vercel-icon', 'vercel'], supabase: ['supabase-icon', 'supabase'], neon: ['neon-icon', 'neon'], hostinger: [null, 'hostinger'],
  cloudflare: ['cloudflare-icon', 'cloudflare'], godaddy: [null, 'godaddy'], porkbun: [null, 'porkbun'], namecom: [null, 'namedotcom'],
  namecheap: ['namecheap', 'namecheap'], squarespace: ['squarespace', 'squarespace'], digitalocean: ['digital-ocean-icon', 'digitalocean'],
  netlify: ['netlify-icon', 'netlify'], render: [null, 'render'], railway: ['railway', 'railway'], heroku: ['heroku-icon', 'heroku'],
  fly: ['fly-icon', 'flydotio'], github: ['github-icon', 'github'], gitlab: ['gitlab-icon', 'gitlab'], docker: ['docker-icon', 'docker'],
  postgres: ['postgresql', 'postgresql'], mysql: ['mysql-icon', 'mysql'], redis: ['redis', 'redis'], nextjs: [null, 'nextdotjs'],
  node: ['nodejs-icon', 'nodedotjs'], slack: ['slack-icon', 'slack'], discord: ['discord-icon', 'discord'], ntfy: [null, 'ntfy'],
  openrouter: [null, 'openrouter'], anthropic: ['anthropic-icon', 'anthropic'], claude: ['claude-icon', 'claude'], gemini: ['google-gemini-icon', 'googlegemini'],
  google: ['google-icon', 'google'], openai: ['openai-icon', 'openai'], ollama: [null, 'ollama'], gdrive: ['google-drive', 'googledrive'],
  icloud: [null, 'icloud'], dropbox: ['dropbox', 'dropbox'], onedrive: ['microsoft-onedrive', 'microsoftonedrive'], s3: ['aws-s3', 'amazons3'],
  letsencrypt: ['letsencrypt', 'letsencrypt'], caddy: [null, 'caddy'], ubuntu: ['ubuntu', 'ubuntu'], cursor: ['cursor-icon', 'cursor'],
  windsurf: [null, 'windsurf'], codex: ['codex', null], antigravity: ['antigravity', null], stripe: [null, 'stripe'],
  sentry: ['sentry-icon', 'sentry'], resend: [null, 'resend'], upstash: ['upstash-icon', 'upstash'], planetscale: ['planetscale', 'planetscale'],
  turso: [null, 'turso'],
  vite: ['vitejs', 'vite'], python: ['python', 'python'], go: ['go', 'go'], bun: ['bun', 'bun'], mongodb: ['mongodb-icon', 'mongodb'],
  deno: ['deno', 'deno'], rust: ['rust', 'rust'], php: ['php', 'php'], laravel: ['laravel', 'laravel'], astro: ['astro-icon', 'astro'],
  nuxt: ['nuxt-icon', 'nuxt'], svelte: ['svelte-icon', 'svelte'], remix: ['remix-icon', 'remix'], django: ['django-icon', 'django'],
  rails: ['rails', 'rubyonrails'], ruby: ['ruby', 'ruby'], java: ['java', 'openjdk'], nginx: ['nginx', 'nginx'], debian: ['debian', 'debian'],
  // what a server X-ray finds: who runs things (PaaS, process managers) and well-known self-hosted apps
  coolify: [null, 'coolify'], dokploy: ['dokploy', null], caprover: [null, 'caprover'], portainer: [null, 'portainer'], pm2: ['pm2-icon', 'pm2'],
  traefik: [null, 'traefikproxy'], linux: ['linux-tux', 'linux'], n8n: ['n8n-icon', 'n8n'], minio: [null, 'minio'], appwrite: ['appwrite-icon', 'appwrite'],
  plausible: [null, 'plausibleanalytics'], mariadb: ['mariadb-icon', 'mariadb'], clickhouse: [null, 'clickhouse'], pocketbase: [null, 'pocketbase'],
  wordpress: ['wordpress-icon', 'wordpress'], ghost: ['ghost', 'ghost'], directus: [null, 'directus'], strapi: ['strapi-icon', 'strapi'], umami: [null, 'umami'],
  metabase: ['metabase', 'metabase'], gitea: [null, 'gitea'], nextcloud: [null, 'nextcloud'], uptimekuma: [null, 'uptimekuma'], vaultwarden: [null, 'vaultwarden'],
  // the big clouds and their products as the map shows them (the products with no logo of their own use their cloud's)
  gcp: ['google-cloud', 'googlecloud'], firebase: ['firebase-icon', 'firebase'], cloudrun: ['google-cloud-run', 'googlecloud'], cloudfunctions: ['google-cloud-functions', 'googlecloud'],
  appengine: ['google-cloud', 'googlecloud'], cloudsql: ['google-cloud', 'googlecloud'], firestore: ['firebase-icon', 'firebase'],
  aws: ['aws', null], amplify: ['aws-amplify', null], lightsail: ['aws-lightsail', null], ec2: ['aws-ec2', null], rds: ['aws-rds', null], route53: ['aws-route53', null],
  azure: ['azure-icon', null], hetzner: [null, 'hetzner'], linode: ['linode', null], vultr: ['vultr-icon', 'vultr'], akamai: ['akamai', 'akamai'],
  githubpages: [null, 'githubpages'], cloudflarepages: [null, 'cloudflarepages'], workers: ['cloudflare-workers-icon', 'cloudflareworkers'],
  // more self-hosted apps a server X-ray finds (and Unit7 can connect: serverapps)
  grafana: ['grafana', 'grafana'], meilisearch: ['meilisearch', 'meilisearch'], typesense: ['typesense-icon', null], listmonk: [null, 'listmonk'],
  nocodb: ['nocodb', null], forgejo: [null, 'forgejo'],
  // tools Unit7 adds to a server (src/tools/addons.ts): CloudBeaver is DBeaver's
  dbeaver: [null, 'dbeaver'],
  // the free-plans guide (web/src/pages/guide/plans.ts): auth, email, payments, a registrar, clouds, storage, analytics, uptime
  clerk: ['clerk-icon', 'clerk'], auth0: ['auth0-icon', 'auth0'], betterauth: [null, 'betterauth'], brevo: [null, 'brevo'],
  mailgun: ['mailgun-icon', 'mailgun'], lemonsqueezy: [null, 'lemonsqueezy'], spaceship: [null, 'spaceship'], backblaze: [null, 'backblaze'],
  posthog: ['posthog-icon', 'posthog'], betterstack: [null, 'betterstack'],
  // in neither set (Postmark, MailerLite, Buttondown keep the letter tile); Oracle's is only a wide wordmark, so its "O" is drawn below
  oracle: [null, null],
};
// logos drawn here, for the ones whose only source logo doesn't work as a square icon
const DRAWN = {
  oracle: { w: 24, h: 24, body: '<rect x="2.2" y="6.6" width="19.6" height="10.8" rx="5.4" fill="none" stroke="#C74634" stroke-width="2.7"/>' },
};

const TEXT_FOLLOWS = new Set(['aws']);
const bySlug = new Map(Object.values(simple).filter((i) => i && i.slug).map((i) => [i.slug, i]));
const dark = (hex, limit = 0.2) => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
  return Math.max(r, g, b) < limit; // near-black, whatever the hue
};

const out = {};
const missing = [];
for (const [id, [logo, slug]] of Object.entries(WANT)) {
  const icon = logo && iconify.icons[logo];
  if (icon) {
    let body = icon.body;
    const fills = [...body.matchAll(/(?:fill|stop-color)="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1]);
    // one dark color (or none, which renders black): follow the text color instead
    const mono = !/url\(#/.test(body) && fills.every((h) => dark(h)); // not every(dark): its index would be the limit
    if (mono) body = body.replace(/fill="#[0-9a-fA-F]{3,8}"/g, 'fill="currentColor"');
    // a colored logo with dark lettering (AWS): the lettering follows the text color, so it shows in dark mode too
    else if (TEXT_FOLLOWS.has(id)) body = body.replace(/fill="(#[0-9a-fA-F]{3,8})"/g, (m, hex) => (dark(hex, 0.3) ? 'fill="currentColor"' : m));
    out[id] = { w: icon.width ?? iconify.width, h: icon.height ?? iconify.height, body, ...(mono && { mono: true }) };
    continue;
  }
  if (DRAWN[id]) { out[id] = DRAWN[id]; continue; }
  const si = slug && bySlug.get(slug);
  if (si) {
    const mono = dark(si.hex);
    out[id] = { w: 24, h: 24, body: `<path fill="${mono ? 'currentColor' : `#${si.hex}`}" d="${si.path}"/>`, ...(mono && { mono: true }) };
    continue;
  }
  missing.push(id);
}

const target = new URL('../web/src/brand/logos.generated.ts', import.meta.url);
writeFileSync(target, `// Generated by scripts/brand-logos.mjs (npm run brand:logos). Do not edit by hand.
// Sources: @iconify-json/logos (CC0) and simple-icons (CC0). Trademarks belong to their owners.
export interface BrandIcon { w: number; h: number; body: string; mono?: true }
export const LOGOS: Record<string, BrandIcon> = ${JSON.stringify(out, null, 0).replace(/},"/g, '},\n  "').replace(/^{/, '{\n  ').replace(/}$/, ',\n}')};
`);
console.log(`brand logos: ${Object.keys(out).length} written${missing.length ? `, no logo for ${missing.join(', ')} (fallback tile)` : ''}`);
