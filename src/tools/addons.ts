// Add a tool to my server: a dozen self-hosted tools a vibe coder wants (visitor stats, an uptime monitor, automation,
// an email list, a database browser, file storage, search, error tracking, a status page, a backups dashboard, feature
// flags), each one click. Where the server's Coolify is connected it's Coolify's own one-click service; elsewhere Unit7
// deploys it itself when it's one container and a database. Then its domain (the DNS record written where the domain
// lives), a check that it's healthy, its admin keys into the vault (shown only to a person who asks), and the wiring
// where it helps (a tracking snippet, settings for an app). The install is ONE action through the gate: one approval
// card says all of it, and its parts don't each ask again.
//
// Template keys, the part that gets the domain, and the variables Coolify generates are from coollabsio/coolify
// templates/compose/<key>.yaml at 1abcd3da (main, 2026-10-07). POST /api/v1/services resolves `type` against the
// published templates and takes `urls` as { name, url } (app/Http/Controllers/Api/ServicesController.php).
// plausible.yaml and minio.yaml carry `# ignore: true` there, so Coolify doesn't offer them as one-click right now.
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { defineTool, getTool, type Ctx } from './runtime.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { fid, requireHuman, requireRole } from './helpers.ts';
import { serverRow } from './servers.ts';
import { coolifyAccount, coolifyFor, lastXray } from './xray.ts';
import { b64, coolifyServerUuid, hostsOf, list, setEnvs, waitStatus } from '../connectors/coolify.ts';
import { ssh } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { sections } from '../discovery/xray.ts';
import { assertHostname, proxyFor } from '../deploy/caddy.ts';
import { setVar } from './env.ts';
import { writeRecords, type Rec } from '../connectors/dnswrite.ts';
import { publicResolver } from '../connectors/dnsinfo.ts';
import { makeRef } from '../vault.ts';
import { freeMb, madeDrop, madeGet, madeSet, SPARE_MB } from './staging.ts';
import { knownSites, runKuma, syncKuma } from './uptime.ts';
import { kumaWhy } from '../serverapps/uptimekuma.ts';
import type { ServerRow } from '../connectors/ssh.ts';

type Wire = { note: string; snippet?: string; env?: { key: string; from: string }[] }; // from: url, url:/path, or cred:<KEY>
// How a tool's admin login is made before anyone else can claim it (it's never public before then):
//   env:  settings the tool reads at its first start (the login Unit7 makes, set before it starts)
//   api:  the tool's own setup call or command, run from inside the server right after it starts (before its domain's
//         DNS is written), with a password made on the server that only comes back on the command's output
//   gate: no supported way: an extra password in front of its address (Coolify's proxy) until the person finishes setup
//   extra: plain settings set before the first start (no open sign-up, no setup wizard for a database)
//   socket: its own first-run setup over its socket.io API, from inside its container, while the extra password still
//         stands in front of it (so nobody else can reach it first); once that worked the extra password goes
export interface Claim { env?: (pw: string) => Record<string, string>; user?: string; api?: 'umami' | 'n8n' | 'glitchtip' | 'wordpress'; port?: number; gate?: number; extra?: Record<string, string>; socket?: boolean }
export interface Addon {
  id: string; name: string; logo: string; category: string; line: string; memoryMb: number; sub: string;
  template?: string; part?: string;           // Coolify's one-click key, and the part of it that gets the domain
  compose?: string;                           // Unit7's own compose for it instead of the template (where the template isn't safe)
  off?: string; instead?: string;             // why it can't be added right now, and what does the same job
  creds?: { key: string; label: string }[];   // what Coolify generates for it that a person signs in with
  claim?: Claim;
  firstVisit?: string;                        // what's left for the person on their first visit
  wire?: Wire;
  unit7?: { image: string; port: number; db?: 'postgres'; env?: Record<string, string>; secrets?: { key: string; cred: string }[] }; // one container + Postgres
}
const SIGNED = 'Unit7 set its admin login before it went live: sign in with the keys here (Show).';
const GATE = (what: string) => `It stays behind an extra password until you’ve set it up: open it, sign in with the extra password (Show), and ${what}. Then click “I’ve finished setup” and Unit7 takes the extra password away.`;
// Unleash: Coolify's template sets only the password (Unleash ignores it without the user name, so the login stays
// admin / unleash4all) and ships public demo API tokens (INIT_*_API_TOKENS ...unleash-insecure...): Unit7 adds it with
// the template's own compose minus those tokens, plus the user name (create-config.ts in unleash-server v8.2.0, 363-367).
const UNLEASH_COMPOSE = `services:
  unleash:
    image: "unleashorg/unleash-server:latest"
    environment:
      - SERVICE_URL_UNLEASH_4242
      - UNLEASH_URL=\${SERVICE_URL_UNLEASH}
      - UNLEASH_DEFAULT_ADMIN_USERNAME=admin
      - UNLEASH_DEFAULT_ADMIN_PASSWORD=\${SERVICE_PASSWORD_UNLEASH}
      - "DATABASE_URL=postgres://$SERVICE_USER_POSTGRES:$SERVICE_PASSWORD_POSTGRES@postgres/db"
      - DATABASE_SSL=false
      - LOG_LEVEL=warn
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: "wget --no-verbose --tries=1 --spider http://127.0.0.1:4242/health || exit 1"
      interval: 1s
      timeout: 1m
      retries: 5
      start_period: 15s
  postgres:
    image: postgres:15
    volumes:
      - postgresql-data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=$SERVICE_USER_POSTGRES
      - POSTGRES_PASSWORD=$SERVICE_PASSWORD_POSTGRES
      - POSTGRES_DB=db
    healthcheck:
      test: ["CMD", "pg_isready", "--username=$SERVICE_USER_POSTGRES", "--host=127.0.0.1", "--port=5432", "--dbname=db"]
      interval: 2s
      timeout: 1m
      retries: 5
      start_period: 10s
`;
export const ADDONS: Addon[] = [
  // Umami seeds admin / umami and has no setting for it (docs.umami.is/docs/login; prisma/migrations/01_init line 199):
  // Unit7 signs in from inside the server as soon as it answers and sets a new password (POST /api/auth/login, then
  // POST /api/users/{id} with { password }: src/app/api/users/[userId]/route.ts at v3.0.3).
  { id: 'umami', name: 'Umami', logo: 'umami', category: 'Analytics', line: 'Simple, private visitor stats for your sites', memoryMb: 512, sub: 'analytics', template: 'umami', part: 'umami',
    claim: { api: 'umami', port: 3000, user: 'admin' }, firstVisit: SIGNED,
    wire: { note: 'Add your site in Umami (Settings → Websites) for its website id, then put the script in your app’s page head.', snippet: '<script defer src="{url}/script.js" data-website-id="your-website-id"></script>', env: [{ key: 'NEXT_PUBLIC_UMAMI_SRC', from: 'url:/script.js' }] },
    unit7: { image: 'ghcr.io/umami-software/umami:3.0.3', port: 3000, db: 'postgres', env: { DATABASE_TYPE: 'postgres' }, secrets: [{ key: 'APP_SECRET', cred: 'APP_SECRET' }] } },
  { id: 'plausible', name: 'Plausible', logo: 'plausible', category: 'Analytics', line: 'Lightweight, cookie-free web analytics', memoryMb: 2048, sub: 'analytics',
    off: 'Coolify has switched off its one-click Plausible for now, so Unit7 can’t add it safely.', instead: 'umami' },
  // Uptime Kuma has no setting or command that makes its first admin (server/server.js 2.5.5 lines 705-735: only the
  // socket.io "setup" event), so it starts behind an extra password, and Unit7 sends that "setup" itself from inside
  // its container (serverapps/uptimekuma.ts); then the extra password goes and Unit7 adds a monitor for each site it
  // knows (uptime.sync). If the setup doesn't work, the extra password stays and the person sets it up.
  // UPTIME_KUMA_DB_TYPE=sqlite skips v2's open database wizard (server/setup-database.js 2.5.5 lines 98-111).
  { id: 'uptime-kuma', name: 'Uptime Kuma', logo: 'uptimekuma', category: 'Uptime monitor', line: 'Know the moment a site goes down', memoryMb: 256, sub: 'uptime', template: 'uptime-kuma', part: 'uptime-kuma',
    claim: { gate: 3001, socket: true, user: 'admin', extra: { UPTIME_KUMA_DB_TYPE: 'sqlite' } }, firstVisit: GATE('create the admin account'), wire: { note: 'Add a monitor for each of your sites (Add New Monitor → HTTP(s)).' } },
  // n8n's own owner setup (POST /rest/owner/setup, no sign-in until an owner exists: packages/cli/src/controllers/
  // owner.controller.ts, tag n8n@2.10.2); the template pins 2.10.2, older than the owner settings of n8n 2.17.
  { id: 'n8n', name: 'n8n', logo: 'n8n', category: 'Automation', line: 'Connect your apps and automate the boring parts', memoryMb: 768, sub: 'automate', template: 'n8n', part: 'n8n',
    claim: { api: 'n8n', port: 5678 }, firstVisit: SIGNED, wire: { note: 'Your app can start a workflow with a webhook: n8n shows the address on each Webhook node.' } },
  // Listmonk makes its admin at install from LISTMONK_ADMIN_USER / LISTMONK_ADMIN_PASSWORD (v4.0.0+; cmd/install.go
  // v6.0.0 lines 80-113); the template's install part runs --install on the fresh database.
  { id: 'listmonk', name: 'Listmonk', logo: 'listmonk', category: 'Email list', line: 'Newsletters and mailing lists you own', memoryMb: 384, sub: 'newsletter', template: 'listmonk', part: 'listmonk',
    claim: { env: (pw) => ({ LISTMONK_ADMIN_USER: 'admin', LISTMONK_ADMIN_PASSWORD: pw }), user: 'admin' }, firstVisit: SIGNED,
    wire: { note: 'Set where email is sent from (Settings → SMTP) before your first campaign.' } },
  // CloudBeaver configures itself (no setup wizard) from CB_SERVER_NAME, CB_ADMIN_NAME and CB_ADMIN_PASSWORD
  // (CBApplication.java performAutoConfiguration; dbeaver.com/docs/cloudbeaver/Server-configuration), and the
  // anonymous access its base config allows is turned off.
  { id: 'cloudbeaver', name: 'CloudBeaver', logo: 'dbeaver', category: 'Database admin', line: 'Browse and edit your databases in the browser', memoryMb: 768, sub: 'db', template: 'cloudbeaver', part: 'cloudbeaver',
    claim: { env: (pw) => ({ CB_SERVER_NAME: 'CloudBeaver', CB_ADMIN_NAME: 'cbadmin', CB_ADMIN_PASSWORD: pw }), user: 'cbadmin', extra: { CLOUDBEAVER_APP_ANONYMOUS_ACCESS_ENABLED: 'false' } }, firstVisit: SIGNED },
  { id: 'seaweedfs', name: 'SeaweedFS', logo: 'seaweedfs', category: 'File storage (S3)', line: 'S3-style storage for uploads, with a web admin (Coolify’s one-click MinIO is off)', memoryMb: 512, sub: 'files', template: 'seaweedfs', part: 'seaweedfs-admin',
    creds: [{ key: 'SERVICE_USER_ADMIN', label: 'Admin user' }, { key: 'SERVICE_PASSWORD_ADMIN', label: 'Admin password' }, { key: 'SERVICE_USER_S3', label: 'S3 access key' }, { key: 'SERVICE_PASSWORD_S3', label: 'S3 secret key' }],
    wire: { note: 'Your app uploads with any S3 library, using the S3 keys.', env: [{ key: 'S3_ACCESS_KEY_ID', from: 'cred:SERVICE_USER_S3' }, { key: 'S3_SECRET_ACCESS_KEY', from: 'cred:SERVICE_PASSWORD_S3' }] } },
  { id: 'meilisearch', name: 'Meilisearch', logo: 'meilisearch', category: 'Search', line: 'Fast, typo-friendly search for your app', memoryMb: 512, sub: 'search', template: 'meilisearch', part: 'meilisearch',
    creds: [{ key: 'SERVICE_PASSWORD_MEILISEARCH', label: 'Master key' }],
    wire: { note: 'Your app talks to it with the address and the key (make a search-only key in Meilisearch for the browser).', env: [{ key: 'MEILISEARCH_HOST', from: 'url' }, { key: 'MEILISEARCH_API_KEY', from: 'cred:SERVICE_PASSWORD_MEILISEARCH' }] } },
  // GlitchTip lets the first visitor register whatever ENABLE_USER_REGISTRATION says (apps/users/utils.py v6.0.11:
  // registration is open while no user exists), so Unit7 makes the superuser first with Django's own command
  // (manage.py createsuperuser --noinput, DJANGO_SUPERUSER_PASSWORD) and turns sign-ups off before it starts.
  { id: 'glitchtip', name: 'GlitchTip', logo: 'glitchtip', category: 'Error tracking', line: 'See your app’s errors as they happen (works with Sentry’s tools)', memoryMb: 1024, sub: 'errors', template: 'glitchtip', part: 'web',
    claim: { api: 'glitchtip', extra: { ENABLE_USER_REGISTRATION: 'False' } }, firstVisit: SIGNED, wire: { note: 'Make a project in GlitchTip and put its DSN in your app as SENTRY_DSN.' } },
  // Statusnook has only its web setup (main.go lines 3846-3917), so it stays behind an extra password until it's done.
  { id: 'statusnook', name: 'Statusnook', logo: 'statusnook', category: 'Status page', line: 'A public page that says if your service is up', memoryMb: 128, sub: 'status', template: 'statusnook', part: 'statusnook',
    claim: { gate: 8000 }, firstVisit: GATE('set it up') },
  // Databasus (v3.16.2 in the template) seeds an admin with no password that anyone can claim, and anyone can sign up
  // to it afterwards (is_allow_external_registrations defaults to true, with no setting): it holds database backups.
  { id: 'databasus', name: 'Databasus', logo: 'databasus', category: 'Backups dashboard', line: 'Scheduled database backups you can see (Postgres, MySQL, MongoDB)', memoryMb: 512, sub: 'backups', template: 'databasus', part: 'databasus',
    off: 'Coming soon: Databasus lets the first visitor become its admin and anyone sign up after that, so Unit7 can’t add it safely yet. Unit7 already backs up the databases it runs.' },
  // WordPress hands its admin to whoever opens /wp-admin/install.php first, so it starts behind the extra password, Unit7
  // runs its install through wp-cli from inside the server (CLAIM.wordpress), and only then does the extra password go.
  // templates/compose/wordpress-with-mariadb.yaml: parts wordpress and mariadb, volume wordpress-files on /var/www/html.
  { id: 'wordpress', name: 'WordPress', logo: 'wordpress', category: 'Website', line: 'A blog or business site you run yourself', memoryMb: 768, sub: 'blog', template: 'wordpress-with-mariadb', part: 'wordpress',
    claim: { api: 'wordpress', gate: 80, port: 80, user: 'siteadmin' }, firstVisit: SIGNED },
  { id: 'unleash', name: 'Unleash', logo: 'unleash', category: 'Feature flags', line: 'Turn features on and off without a deploy', memoryMb: 512, sub: 'flags', template: 'unleash-with-postgresql', part: 'unleash', compose: UNLEASH_COMPOSE,
    creds: [{ key: 'SERVICE_PASSWORD_UNLEASH', label: 'Admin password (user admin)' }],
    wire: { note: 'Make an API token in Unleash for your app, and point its SDK at the address.', env: [{ key: 'UNLEASH_URL', from: 'url:/api' }] },
    unit7: { image: 'unleashorg/unleash-server:latest', port: 4242, db: 'postgres', env: { DATABASE_SSL: 'false', UNLEASH_DEFAULT_ADMIN_USERNAME: 'admin' }, secrets: [{ key: 'UNLEASH_DEFAULT_ADMIN_PASSWORD', cred: 'SERVICE_PASSWORD_UNLEASH' }] } },
];
const IDS = ADDONS.map((a) => a.id) as [string, ...string[]];
// A server holds many WordPress sites: past the catalogue's one, each is the same add-on under its own id (wordpress.install,
// .staging, .import), with its own record and keys, and addon.remove, .credentials and .unlock work on it like any other.
const SITE_ID = /^wordpress-[a-z0-9-]{1,36}$/;
// short enough for a vault reference (credRef), and a long name stays its own with a piece of its hash
export const wordpressSite = (hostname: string): Addon => {
  const slug = hostname.replace(/[^a-z0-9]+/g, '-');
  return { ...ADDONS.find((a) => a.id === 'wordpress')!, id: `wordpress-${slug.length > 36 ? `${slug.slice(0, 28).replace(/-+$/, '')}-${createHash('sha256').update(hostname).digest('hex').slice(0, 7)}` : slug}` };
};
const ADDON_ID = z.union([z.enum(IDS), z.string().regex(SITE_ID)]);
const byId = (x: string): Addon => ADDONS.find((a) => a.id === x) ?? { ...ADDONS.find((a) => a.id === 'wordpress')!, id: x };
const credRef = (serverId: string, addon: string, key: string) => makeRef('addon', `${serverId}-${addon}`, key);
export interface AddonMade { via: 'coolify' | 'unit7'; uuid?: string; project?: string; serviceId?: string; dbId?: string; domain?: string; url?: string; healthy?: boolean; creds: { label: string; ref: string }[]; gate?: { file: string; ref: string } }

// --- the admin login, before anyone else can claim it ------------------------------------------------------------
// A password Unit7 makes for a setting a tool reads at its first start: upper case, lower case and digits (CloudBeaver's
// and n8n's rules), 39 characters. It goes to Coolify only inside the API call (curl's config on stdin) and to the vault.
export const adminPassword = () => `U7a${randomBytes(18).toString('hex')}`;
const keepCred = (ctx: Ctx, rec: AddonMade, s: ServerRow, a: Addon, key: string, label: string, value: string, user?: string) => {
  const ref = credRef(s.id, a.id, key);
  ctx.redactor.add(value, label);
  ctx.app.vault.put(ctx.orgId, ref, value, { kind: 'addon_credential', by: ctx.actor.name, meta: { addon: a.id, label, people: true, ...(user && { user }) } });
  rec.creds = [...rec.creds.filter((c) => c.ref !== ref), { label, ref }];
};
// wp-cli for a WordPress container $c, as its files' owner $u: the official image's throwaway container on the site's own
// files and network. wp-config.php reads its database login from the WORDPRESS_ settings, so they go along in a private
// file, gone when the script ends (--env-file takes one line each, and WORDPRESS_CONFIG_EXTRA can be several).
// Plugins and themes stay unloaded: a broken one can't stop wp-cli, and their code never runs on wp-cli's PHP.
export const WP_CLI = `e=$(mktemp) || exit 7
trap 'rm -f "$e"' EXIT; trap 'exit 1' HUP INT TERM
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -E '^WORDPRESS_[A-Z0-9_]+=' | grep -v '^WORDPRESS_CONFIG_EXTRA=' > "$e"
wp() { docker run --rm -i --volumes-from "$c" --network "container:$c" --user "$u" --env-file "$e" -e HOME=/tmp wordpress:cli wp --allow-root --skip-plugins --skip-themes "$@"; }`;

// The tool's own setup, from inside the server (its container's own address, so nothing has to be public): a password
// made on the server, printed first (Unit7 learns it before anything else reads the output), then handed to the tool on
// stdin (curl's config, or the container's shell): never on a command line. printf turns each doubled backslash into
// one, so curl's config reads an escaped quote. It also says whether someone else got there first (the default login no
// longer works, an owner already exists, or there's more than one user).
const CLAIM = {
  head: `c=$1; port=$2; who=$3
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{println}}{{end}}' "$c" 2>/dev/null | grep -m1 .)
[ -n "$ip" ] || { echo "it isn't running" >&2; exit 7; }
pw="U7a$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
[ \${#pw} -eq 39 ] || { echo "the server couldn't make a random password" >&2; exit 7; }
printf '\n@@unit7:secret\n%s\n' "$pw"
printf '\n@@unit7:reply\n'`,
  // Umami: sign in with its seeded admin / umami, then set the new password on that user
  umami: `i=0; while :; do
  r=$(curl -s -m 8 -w '\n%{http_code}' -H 'Content-Type: application/json' -d '{"username":"admin","password":"umami"}' "http://$ip:$port/api/auth/login")
  case "$(printf '%s' "$r" | tail -n1)" in 200) break;; 401|403) echo unit7-taken; exit 0;; esac
  i=$((i+1)); [ $i -ge 90 ] && { echo "it didn't answer" >&2; exit 7; }; sleep 2
done
t=$(printf '%s' "$r" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4); u=$(printf '%s' "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
case "$t$u" in *[!A-Za-z0-9._~+/=-]*|'') echo unit7-taken; exit 0;; esac
{ printf 'header = "Authorization: Bearer %s"\n' "$t"; printf 'data = "{\\\\"password\\\\":\\\\"%s\\\\"}"\n' "$pw"; } | curl -s -m 10 -K - -H 'Content-Type: application/json' -o /dev/null -w 'unit7-http=%{http_code}\n' -X POST "http://$ip:$port/api/users/$u"`,
  // n8n: its owner setup, once it answers (it refuses once an owner exists)
  n8n: `i=0; until [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$ip:$port/healthz")" = 200 ]; do i=$((i+1)); [ $i -ge 90 ] && { echo "it didn't answer" >&2; exit 7; }; sleep 2; done
printf 'data = "{\\\\"email\\\\":\\\\"%s\\\\",\\\\"firstName\\\\":\\\\"Unit7\\\\",\\\\"lastName\\\\":\\\\"Owner\\\\",\\\\"password\\\\":\\\\"%s\\\\"}"\n' "$who" "$pw" | curl -s -m 15 -K - -H 'Content-Type: application/json' -o /dev/null -w 'unit7-http=%{http_code}\n' -X POST "http://$ip:$port/rest/owner/setup"`,
  // GlitchTip: Django's own superuser command once its tables exist (the password on the command's stdin), then a count
  glitchtip: `i=0; until printf '%s\n' "$pw" | docker exec -i "$c" sh -c 'IFS= read -r p; DJANGO_SUPERUSER_PASSWORD="$p" exec ./manage.py createsuperuser --noinput --email "$1"' unit7 "$who" >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 60 ] && { echo "it couldn't make the admin" >&2; exit 7; }; sleep 3; done
docker exec "$c" ./manage.py shell -c 'from django.contrib.auth import get_user_model as g; print("unit7-users=%d" % g().objects.count())' 2>/dev/null | grep -o 'unit7-users=[0-9]*'
echo unit7-http=200`,
  // WordPress: its own install through wp-cli, the password on wp-cli's stdin (--prompt, from wp-cli's own docs), once its
  // files and database are up; "already installed" is no error there, so its only login has to be the one Unit7 asked for
  wordpress: `i=0; until u=$(docker exec "$c" stat -c '%u:%g' /var/www/html/wp-includes/version.php 2>/dev/null); do i=$((i+1)); [ $i -ge 30 ] && { echo "it didn't start" >&2; exit 7; }; sleep 2; done
${WP_CLI}
wp core is-installed >/dev/null 2>&1 && { echo unit7-taken; exit 0; }
i=0; until printf '%s\\n' "$pw" | wp core install --url="$4" --title='My site' --admin_user=siteadmin --admin_email="$who" --skip-email --prompt=admin_password >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 40 ] && { echo "it couldn't make the admin" >&2; exit 7; }; sleep 3; done
[ "$(wp user list --field=user_login 2>/dev/null)" = siteadmin ] && echo unit7-users=1 || echo unit7-taken
echo unit7-http=200`,
};
export const claimScript = (kind: NonNullable<Claim['api']>, container: string, port: number, who: string, url = '') => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw new Unit7Error('invalid_input', 'That isn’t a container name Unit7 will use.', 400);
  if (!/^[^\s"'\\@]+@[^\s"'\\@]+\.[A-Za-z]{2,}$/.test(who)) throw new Unit7Error('invalid_input', 'That isn’t an email address Unit7 will use.', 400);
  if (kind === 'wordpress' && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) throw new Unit7Error('invalid_input', 'That isn’t an address Unit7 will use.', 400);
  return script(`${CLAIM.head}\n${CLAIM[kind]}`, container, port, who, ...(url ? [url] : []));
};
// what the claim said: the password, or why it can't be trusted (someone else got there first)
export function claimResult(out: string): { pw?: string; taken?: boolean; why?: string } {
  const sec = sections(out), pw = (sec.secret ?? '').trim(), reply = sec.reply ?? '';
  const users = /unit7-users=(\d+)/.exec(reply)?.[1];
  if (/unit7-taken/.test(reply) || (users !== undefined && users !== '1')) return { taken: true };
  const code = /unit7-http=(\d{3})/.exec(reply)?.[1];
  if (!pw || !code || !/^2/.test(code)) return { why: code ? `it answered ${code}` : 'it didn’t answer' };
  return { pw };
}
async function claimFirst(ctx: Ctx, s: ServerRow, a: Addon, container: string, port: number, url?: string): Promise<{ pw: string; user: string }> {
  const email = get<{ email: string }>(ctx.db, 'SELECT email FROM users WHERE id = ?', ctx.actor.userId ?? '')?.email ?? 'admin@unit7.local';
  const asRoot = json<{ sudo?: string }>(s.facts, {}).sudo === 'yes' ? 'sudo -n ' : '';
  const r = await ssh(ctx.app).exec(s, asRoot + claimScript(a.claim!.api!, container, port, email, url), { timeoutMs: 5 * 60_000, signal: ctx.signal });
  const made = sections(r.stdout).secret?.trim();
  if (made) ctx.redactor.add(made, `${a.name}’s admin password`);
  const got = claimResult(r.stdout);
  if (got.taken) throw new Unit7Error('claimed_by_someone', `Someone else reached ${a.name}’s first sign-in before Unit7 could set it, so Unit7 stopped it. Take it off with its data and add it again.`, 409, { stop: true });
  if (!got.pw) throw new Unit7Error('claim_failed', `Unit7 couldn’t set ${a.name}’s admin login (${got.why ?? ctx.redactor.redact(r.stderr).slice(-200)}), so it stopped it rather than leave its first sign-in open. Take it off and add it again.`, 502, { stop: true });
  return { pw: got.pw, user: a.claim!.user ?? email };
}

// --- the extra password: Coolify's proxy (Traefik) asks for it on every address of the tool until the person has set
// it up. A file of Unit7's own in Traefik's dynamic folder, above Coolify's routes for those names; https names get a
// redirect on plain http, so the password only travels encrypted where it can. Taking the file away ends it.
const GATE_DIR = '/data/coolify/proxy/dynamic';
export function gateRoute(id: string, hosts: { host: string; https: boolean }[], upstream: string, port: number, hash: string): string {
  if (!/^[a-z0-9]{3,64}$/i.test(id) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(upstream) || !/^\{SHA\}[A-Za-z0-9+/=]{28}$/.test(hash)) throw new Error('bad gate');
  for (const h of hosts) assertHostname(h.host);
  const n = `unit7-gate-${id.toLowerCase()}`, rule = (hs: string[]) => `"${hs.map((h) => `Host(\`${h}\`)`).join(' || ')}"`;
  const secure = hosts.filter((h) => h.https).map((h) => h.host), plain = hosts.filter((h) => !h.https).map((h) => h.host);
  return [
    'http:', '  routers:',
    ...(secure.length ? [`    ${n}-https:`, `      rule: ${rule(secure)}`, '      entryPoints: [https]', '      priority: 100000', `      middlewares: [${n}-auth]`, `      service: ${n}`, '      tls:', '        certResolver: letsencrypt',
      `    ${n}-redirect:`, `      rule: ${rule(secure)}`, '      entryPoints: [http]', '      priority: 100000', `      middlewares: [${n}-to-https]`, `      service: ${n}`] : []),
    ...(plain.length ? [`    ${n}-http:`, `      rule: ${rule(plain)}`, '      entryPoints: [http]', '      priority: 100000', `      middlewares: [${n}-auth]`, `      service: ${n}`] : []),
    '  middlewares:', `    ${n}-auth:`, '      basicAuth:', '        users:', `          - "unit7:${hash}"`,
    `    ${n}-to-https:`, '      redirectScheme:', '        scheme: https', '        permanent: false',
    '  services:', `    ${n}:`, '      loadBalancer:', '        servers:', `          - url: "http://${upstream}:${port}"`, '',
  ].join('\n');
}
const gateFile = (uuid: string) => `${GATE_DIR}/unit7-gate-${uuid.toLowerCase()}.yaml`;
async function putGate(ctx: Ctx, s: ServerRow, rec: AddonMade, a: Addon, uuid: string, urls: string[]) {
  const hosts = [...new Map(urls.map((u) => [hostsOf(u)[0], /^https:/i.test(u)] as const).filter(([h]) => !!h)).entries()].map(([host, https]) => ({ host: host!, https }));
  if (!hosts.length) throw new Unit7Error('no_address', `Coolify didn’t say ${a.name}’s address, so Unit7 can’t put a password in front of it. Nothing was started.`, 502);
  const pw = adminPassword();
  keepCred(ctx, rec, s, a, 'UNIT7_EXTRA_PASSWORD', 'Extra password (user unit7), until you’ve set it up', pw, 'unit7');
  const hash = `{SHA}${createHash('sha1').update(pw).digest('base64')}`;
  const su = s.username === 'root' ? '' : 'sudo ';
  // the route goes on stdin (it carries only the password's hash); written aside, then moved into place
  await ssh(ctx.app).check(s, script(`${su}mkdir -p "$(dirname "$1")" && ${su}tee "$1.tmp" >/dev/null && ${su}chmod 600 "$1.tmp" && ${su}mv -f "$1.tmp" "$1"`, gateFile(uuid)),
    { what: `Putting a password in front of ${a.name}`, stdin: gateRoute(uuid, hosts, `${a.part}-${uuid}`, a.claim!.gate!, hash), timeoutMs: 30_000 });
  rec.gate = { file: gateFile(uuid), ref: credRef(s.id, a.id, 'UNIT7_EXTRA_PASSWORD') };
}
async function dropGate(ctx: Ctx, s: ServerRow, rec: AddonMade) {
  if (!rec.gate) return;
  const su = s.username === 'root' ? '' : 'sudo ';
  await ssh(ctx.app).check(s, script(`case "$1" in ${GATE_DIR}/unit7-gate-*.yaml) ${su}rm -f "$1";; *) exit 3;; esac`, rec.gate.file), { what: 'Taking the extra password away', timeoutMs: 30_000 });
  try { ctx.app.vault.retire(ctx.orgId, rec.gate.ref); } catch { /* already gone */ }
  rec.creds = rec.creds.filter((c) => c.ref !== rec.gate!.ref);
  delete rec.gate;
}

// the domain a person's things live under (the one most of their hostnames share), for "analytics.<their domain>"
// ponytail: two labels, three for co.uk-style endings; a public-suffix list when that's ever wrong
const rootOf = (h: string) => h.toLowerCase().split('.').slice(/\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/.test(h) ? -3 : -2).join('.');
export function rootDomain(ctx: Pick<Ctx, 'db' | 'orgId'>) {
  const n = new Map<string, number>();
  for (const { hostname } of all<{ hostname: string }>(ctx.db, `SELECT hostname FROM domains WHERE org_id = ? AND hostname NOT LIKE '%.sslip.io' AND hostname NOT LIKE '%.nip.io'`, ctx.orgId)) n.set(rootOf(hostname), (n.get(rootOf(hostname)) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// A tool's own code, run inside the install: the gate decided on the whole install (one approval, one audit row), so
// its parts don't each ask again. Only these, each doing no more than an install says.
const PARTS = new Set(['coolify.create_project', 'coolify.create_service', 'coolify.remove', 'project.create', 'service.create', 'database.create', 'env.set', 'deployment.create', 'domain.point', 'service.remove', 'service.stop']);
async function inside<T = any>(ctx: Ctx, name: string, input: unknown): Promise<T> {
  const t = getTool(name);
  if (!t || !PARTS.has(name)) throw new Error(`${name} isn’t part of an install`);
  return await t.run(ctx, t.input.parse(input)) as T;
}

// the A record for an add-on's domain, written where the domain's DNS lives (tests swap the writer); Unit7 then watches
// it like any domain it knows (domain.check), so it shows up and Uptime Kuma's list includes it
export const addonDns = { write: writeRecords, look: publicResolver };
const ipOf = (s: ServerRow) => json<{ publicIp?: string }>(s.facts, {}).publicIp ?? s.host;
// What the name points at right now, asked of public DNS (not Unit7's own records): an add-on never takes over an address
// that already goes somewhere else, unless a person typed the name to move it here (takeover). A lookup that fails isn't
// "nothing there": it's asked again right before the record is written.
async function liveElsewhere(hostname: string, ip: string): Promise<string | undefined> {
  const dns = addonDns.look();
  const [a, cname] = await Promise.all([dns.a(hostname).catch(() => [] as string[]), dns.cname(hostname).catch(() => [] as string[])]);
  if (cname.length) return `${hostname} is an alias of ${cname[0]!.replace(/\.$/, '')}`;
  const other = a.filter((x) => x !== ip);
  return other.length ? `${hostname} points at ${other.join(', ')}` : undefined;
}
async function mayTakeOver(hostname: string, ip: string, takeover?: string) {
  const there = await liveElsewhere(hostname, ip);
  if (there && takeover?.trim().toLowerCase() !== hostname) throw new Unit7Error('domain_in_use', `${there} right now, so Unit7 didn’t touch it: something may be using that address. Pick another name, or type ${hostname} to move it to this server.`, 409, { confirm: hostname });
}
async function pointHere(ctx: Ctx, s: ServerRow, hostname: string, uuid: string, takeover?: string) {
  const ip = ipOf(s);
  await mayTakeOver(hostname, ip, takeover); // again, right before the record is written
  const records: Rec[] = [{ type: 'A', name: hostname, content: ip }];
  const w = await addonDns.write(ctx, hostname, records);
  run(ctx.db, `INSERT INTO domains (id, org_id, hostname, service_id, account_id, zone, status, tls, tls_mode, auto, target, records) VALUES (?, ?, ?, NULL, ?, ?, ?, 'issuing', 'auto', 0, ?, ?)
    ON CONFLICT(hostname) DO UPDATE SET account_id = excluded.account_id, zone = excluded.zone, status = excluded.status, target = excluded.target, records = excluded.records`,
    id('dom'), ctx.orgId, hostname, w.accountId ?? null, w.zone ?? null, w.written ? 'pending' : 'waiting_dns', JSON.stringify({ kind: 'addon', serverId: s.id, uuid }), JSON.stringify(records));
  return w.written ? { written: true, at: w.provider } : { written: false, addThese: [{ type: 'A', name: hostname, value: ip }], at: w.host ?? 'your DNS provider', why: w.why };
}
// a subdomain nothing else uses: an add-on never takes over a site's address, Unit7's own or one the X-ray found on this server
function checkHost(ctx: Ctx, serverId: string, hostname: string, mine?: string) {
  if (hostname.split('.').length <= rootOf(hostname).split('.').length) throw new Unit7Error('needs_subdomain', `Use a subdomain like analytics.${hostname}, so ${hostname} keeps pointing where it does.`, 400);
  const d = get<{ org_id: string; service_id: string | null; target: string | null }>(ctx.db, 'SELECT org_id, service_id, target FROM domains WHERE hostname = ?', hostname);
  if (d && !(mine && d.org_id === ctx.orgId && !d.service_id && json<{ uuid?: string }>(d.target, {}).uuid === mine)) throw new Unit7Error('domain_taken', `${hostname} already goes somewhere. Pick another name.`, 409);
  if (lastXray(ctx.db, ctx.orgId, serverId)?.data.parts?.some((p) => p.hosts?.includes(hostname) && !(mine && p.coolify?.uuid === mine))) throw new Unit7Error('domain_taken', `${hostname} is already live on this server. Pick another name.`, 409);
}

function catalogOf(ctx: Pick<Ctx, 'db' | 'orgId'>, s: ServerRow) {
  const coolify = !!coolifyAccount(ctx, s.id);
  const room = freeMb(ctx, s.id), root = rootDomain(ctx);
  return {
    server: { id: s.id, name: s.name, coolify }, freeMb: room.mb, ...(room.at && { at: room.at }), root,
    items: ADDONS.map((a) => {
      const had = madeGet<AddonMade>(ctx, 'addon', `${s.id}:${a.id}`);
      const how = a.off ? 'off' : coolify && a.template ? 'coolify' : a.unit7 ? 'unit7' : 'needs_coolify';
      return {
        id: a.id, name: a.name, logo: a.logo, category: a.category, line: a.line, memoryMb: a.memoryMb, how, suggest: root ? `${a.sub}.${root}` : undefined,
        ...(room.mb !== undefined && { fits: room.mb - a.memoryMb >= SPARE_MB }), ...(a.off && { off: a.off, instead: a.instead }),
        ...(how === 'needs_coolify' && { off: `${a.name} has several parts, so Unit7 adds it through Coolify. Connect Coolify on ${s.name} first.` }),
        installed: had ? { url: had.url, healthy: had.healthy ?? null, at: had.at, keys: had.creds.length, ...(had.gate && { gated: true }) } : null,
      };
    }),
  };
}

defineTool({
  name: 'addon.catalog', title: 'Tools to add to a server', risk: 'read', action: 'read',
  description: 'The tools Unit7 can add to a server in one click (Umami analytics, Uptime Kuma, n8n, Listmonk, CloudBeaver, SeaweedFS storage, Meilisearch, GlitchTip, Statusnook, Databasus, WordPress, Unleash; Plausible is listed but off in Coolify right now), each with the memory it needs against the server’s free room, how it would be added (Coolify’s one-click, or Unit7’s own deploy), whether it’s already there, and a suggested subdomain. Without serverId: the server with Coolify connected, else the first one.',
  input: z.object({ serverId: fid('srv').optional() }),
  run(ctx, i) {
    const servers = all<{ id: string; name: string }>(ctx.db, `SELECT id, name FROM servers WHERE org_id = ? ORDER BY created_at`, ctx.orgId).map((s) => ({ ...s, coolify: !!coolifyAccount(ctx, s.id) }));
    const pick = i.serverId ?? servers.find((s) => s.coolify)?.id ?? servers[0]?.id;
    if (!pick) return { servers, items: [], note: 'Connect a server first: the tools run on it.' };
    return { servers, ...catalogOf(ctx, serverRow(ctx, pick)) };
  },
});

// One tool onto one server, as one action. wordpress.install, .staging and .import are this too, under their own id.
export async function installAddon(ctx: Ctx, a: Addon, i: { serverId: string; domain?: string; takeover?: string }) {
  const s = serverRow(ctx, i.serverId), key = `${s.id}:${a.id}`;
  if (a.off) throw new Unit7Error('not_available', `${a.off}${a.instead ? ` ${byId(a.instead).name} does the same job.` : ''}`, 409);
  const had = madeGet<AddonMade>(ctx, 'addon', key);
  if (had?.url) return { installed: true, already: true, addon: a.id, name: a.name, url: had.url, note: `${a.name} is already on ${s.name}.` };
  if (i.domain) { checkHost(ctx, s.id, i.domain, had?.uuid); await mayTakeOver(i.domain, ipOf(s), i.takeover); }
  const c = coolifyAccount(ctx, s.id) && a.template ? coolifyFor(ctx, s) : undefined;
  if (!c && !a.unit7) throw new Unit7Error('needs_coolify', `${a.name} has several parts, so Unit7 adds it through Coolify. Connect Coolify on ${s.name} first, or pick a server that has it.`, 409);
  const cl = a.claim ?? {};
  if (c && cl.gate && proxyFor(s).kind !== 'coolify') throw new Unit7Error('no_gate', `${a.name} makes its admin from its first visitor, and ${s.name}’s web proxy isn’t one Unit7 can put a password in front of, so Unit7 won’t add it here.`, 409);
  const presets = c && (cl.env || cl.extra);
  const titles = c ? ['Set up the Tools project', `Add ${a.name}`, ...(presets ? ['Set its admin login before it starts'] : []), ...(cl.gate ? ['Put an extra password in front of it'] : []), 'Start it and check it’s healthy',
    ...(cl.api || cl.socket ? ['Set its admin login'] : []), ...(i.domain ? [`Point ${i.domain} here`] : []), ...(a.creds?.length ? ['Keep its keys in the vault'] : []), ...(a.id === 'uptime-kuma' ? ['Watch your sites'] : [])]
    : ['Set up the Tools project', `Add ${a.name}`, ...(a.unit7!.db ? ['Give it a database'] : []), 'Deploy it and check it’s healthy', ...(cl.api ? ['Set its admin login'] : []), ...(i.domain ? [`Point ${i.domain} at it`] : [])];
  let n = 0;
  const say = () => ctx.progress(`Step ${++n} of ${titles.length}: ${titles[n - 1]}`);
  const rec: AddonMade = { via: c ? 'coolify' : 'unit7', creds: [], ...(i.domain && { domain: i.domain }) };
  let url: string | undefined, healthy = false, status: string | undefined, dns: Record<string, unknown> | undefined, signedIn = false, socketWhy: string | undefined;
  if (c) {
    say();
    const p = await inside(ctx, 'coolify.create_project', { serverId: s.id, name: 'Tools', description: 'Tools added from Unit7', environment: 'production' });
    say();
    // made but not started: its admin login (or the extra password) is in place before it ever answers anyone
    const made = await c.api.call('POST', '/services', { project_uuid: p.project, environment_name: 'production', server_uuid: await coolifyServerUuid(c.api, s.host), name: a.id, instant_deploy: false,
      ...(a.compose ? { docker_compose_raw: b64(a.compose) } : { type: a.template }), ...(i.domain && { urls: [{ name: a.part, url: `https://${i.domain}` }] }) });
    const uuid = typeof made?.uuid === 'string' && /^[a-z0-9]{3,64}$/i.test(made.uuid) ? made.uuid as string : undefined;
    if (!uuid) throw new Unit7Error('coolify_error', `Coolify made ${a.name} but didn’t say which one it is.`, 502);
    Object.assign(rec, { uuid, project: p.project });
    madeSet(ctx, 'addon', key, rec); // written down now, so it can be taken off even if a later step fails
    const detail = await c.api.call('GET', `/services/${encodeURIComponent(uuid)}`).catch(() => undefined);
    const fqdns = String(list(detail?.applications).find((x) => x?.name === a.part)?.fqdn ?? '').split(',').map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x));
    const given = hostsOf(Array.isArray(made.domains) ? made.domains.join(',') : made.domains);
    url = i.domain ? `https://${i.domain}` : fqdns[0]?.replace(/\/$/, '') ?? (given[0] && `http://${given[0]}`);
    if (presets) {
      say();
      const env: Record<string, string> = { ...cl.extra };
      const pw = cl.env ? adminPassword() : undefined;
      if (pw) { Object.assign(env, cl.env!(pw)); keepCred(ctx, rec, s, a, 'UNIT7_ADMIN_PASSWORD', `Admin password (user ${cl.user})`, pw, cl.user); }
      await setEnvs(c.api, 'service', uuid, Object.entries(env).map(([k, value]) => ({ key: k, value })));
      madeSet(ctx, 'addon', key, rec);
    }
    if (cl.gate) { say(); await putGate(ctx, s, rec, a, uuid, [...fqdns, ...(i.domain ? [`https://${i.domain}`] : []), ...(fqdns.length ? [] : given.map((h) => `http://${h}`))]); madeSet(ctx, 'addon', key, rec); }
    say();
    await c.api.call('POST', `/services/${encodeURIComponent(uuid)}/start`);
    status = await waitStatus(c.api, 'service', uuid, /^running/, (m) => ctx.progress(m), ctx.signal);
    healthy = /^running/.test(status) && !/unhealthy|exited/.test(status);
    if (cl.api) {
      say();
      // its own setup, from inside the server, before its domain points here; if someone else got there first, it's stopped
      const got = await claimFirst(ctx, s, a, `${a.part}-${uuid}`, cl.port ?? 8000, url).catch(async (e) => {
        if ((e as Unit7Error).detail && ((e as Unit7Error).detail as { stop?: boolean }).stop) await c.api.call('POST', `/services/${encodeURIComponent(uuid)}/stop`).catch(() => undefined);
        throw e;
      });
      keepCred(ctx, rec, s, a, 'UNIT7_ADMIN_PASSWORD', `Admin password (${got.user})`, got.pw, got.user);
      if (cl.gate) await dropGate(ctx, s, rec).catch(() => undefined); // if it can't go now, “I’ve finished setup” takes it away
      madeSet(ctx, 'addon', key, rec);
    }
    if (cl.socket) {
      say();
      // its first-run setup from inside its container, the extra password still in front; kept first, so a login that
      // was made is never lost (it goes again if the tool clearly said no)
      const pw = adminPassword();
      keepCred(ctx, rec, s, a, 'UNIT7_ADMIN_PASSWORD', `Admin password (user ${cl.user})`, pw, cl.user);
      madeSet(ctx, 'addon', key, rec);
      // the trip itself failing (the connection dropped) says nothing about the setup: the password is kept, and so is the extra password
      let lost: string | undefined;
      const r = healthy ? await runKuma(ctx, s, `${a.part}-${uuid}`, { username: cl.user!, password: pw, sites: [], setup: true }).catch((e: Error) => { lost = e.message; return undefined; }) : undefined;
      if (r?.ok) { signedIn = true; await dropGate(ctx, s, rec).catch(() => undefined); } // if it can't go now, “I’ve finished setup” takes it away
      else if (lost) socketWhy = `Unit7 lost the connection while setting up ${a.name} (${lost}). Its admin password is in your vault in case it was made.`;
      else {
        socketWhy = r ? kumaWhy(r, a.name) : `${a.name} wasn’t running yet.`;
        // it never ran, couldn't connect, or said no to the setup: no admin was made with this password
        if (!r || !r.version || ['setup', 'taken', 'unreachable', 'no_client'].includes(r.why ?? '')) {
          try { ctx.app.vault.retire(ctx.orgId, credRef(s.id, a.id, 'UNIT7_ADMIN_PASSWORD')); } catch { /* not there */ }
          rec.creds = rec.creds.filter((x) => x.ref !== credRef(s.id, a.id, 'UNIT7_ADMIN_PASSWORD'));
        }
      }
      madeSet(ctx, 'addon', key, rec);
    }
    if (i.domain) { say(); dns = await pointHere(ctx, s, i.domain, uuid, i.takeover); }
    if (a.creds?.length) {
      say();
      const envs = list(await c.api.call('GET', `/services/${encodeURIComponent(uuid)}/envs`).catch(() => []));
      for (const cr of a.creds) {
        const v = envs.find((e) => e?.key === cr.key && !e.is_preview);
        const value = v?.real_value ?? v?.value;
        if (typeof value !== 'string' || !value.trim() || /^\*+$|redacted|hidden/i.test(value)) continue;
        const ref = credRef(s.id, a.id, cr.key);
        ctx.redactor.add(value, cr.label);
        ctx.app.vault.put(ctx.orgId, ref, value, { kind: 'addon_credential', by: ctx.actor.name, meta: { addon: a.id, label: cr.label } });
        rec.creds.push({ label: cr.label, ref });
      }
    }
  } else {
    const u = a.unit7!;
    say();
    const tools = get<{ id: string }>(ctx.db, `SELECT id FROM projects WHERE org_id = ? AND slug = 'tools'`, ctx.orgId)?.id
      ?? (await inside(ctx, 'project.create', { name: 'Tools', description: 'Tools added from Unit7', environments: ['production'] })).projectId;
    const envId = get<{ id: string }>(ctx.db, `SELECT id FROM environments WHERE project_id = ? AND kind = 'production'`, tools)!.id;
    say();
    const svcId = get<{ id: string }>(ctx.db, 'SELECT id FROM services WHERE environment_id = ? AND name = ?', envId, a.id)?.id
      ?? (await inside(ctx, 'service.create', { environmentId: envId, name: a.id, serverId: s.id, source: { type: 'image', image: u.image }, port: u.port })).serviceId;
    Object.assign(rec, { serviceId: svcId });
    madeSet(ctx, 'addon', key, rec);
    if (u.db) {
      say();
      rec.dbId = get<{ id: string }>(ctx.db, 'SELECT id FROM services WHERE environment_id = ? AND name = ?', envId, `${a.id}-db`)?.id
        ?? (await inside(ctx, 'database.create', { environmentId: envId, engine: u.db, name: `${a.id}-db`, serverId: s.id, injectInto: svcId })).serviceId;
      madeSet(ctx, 'addon', key, rec);
    }
    for (const [k, v] of Object.entries(u.env ?? {})) await inside(ctx, 'env.set', { serviceId: svcId, key: k, value: v });
    for (const sec of u.secrets ?? []) {
      const ref = credRef(s.id, a.id, sec.cred);
      const label = a.creds?.find((x) => x.key === sec.cred)?.label;
      if (!ctx.app.vault.has(ctx.orgId, ref)) ctx.app.vault.put(ctx.orgId, ref, randomBytes(24).toString('base64url'), { kind: 'addon_credential', by: ctx.actor.name, meta: { addon: a.id, ...(label && { label, people: true }) } });
      // the install wiring the key it just made into its own app (not an app's key placed somewhere else)
      setVar(ctx, { type: 'service', id: svcId, label: a.id }, sec.key, ref, true, { own: true });
      if (label) rec.creds.push({ label, ref });
    }
    say();
    const d = await inside(ctx, 'deployment.create', { serviceId: svcId });
    healthy = d.status === 'live'; status = d.status; url = d.url;
    if (cl.api) {
      say();
      const container = get<{ container: string | null }>(ctx.db, 'SELECT d.container FROM services s JOIN deployments d ON d.id = s.current_deployment_id WHERE s.id = ?', svcId)?.container;
      const got = await (container ? claimFirst(ctx, s, a, container, cl.port ?? u.port) : Promise.reject(new Unit7Error('claim_failed', `${a.name} didn’t start, so Unit7 couldn’t set its admin login.`, 502, { stop: true })))
        .catch(async (e) => { if (((e as Unit7Error).detail as { stop?: boolean } | undefined)?.stop) await inside(ctx, 'service.stop', { serviceId: svcId }).catch(() => undefined); throw e; });
      keepCred(ctx, rec, s, a, 'UNIT7_ADMIN_PASSWORD', `Admin password (${got.user})`, got.pw, got.user);
      madeSet(ctx, 'addon', key, rec);
    }
    if (i.domain) { say(); await mayTakeOver(i.domain, ipOf(s), i.takeover); dns = await inside(ctx, 'domain.point', { hostname: i.domain, serviceId: svcId }); url = `https://${i.domain}`; }
  }
  Object.assign(rec, { url, healthy });
  madeSet(ctx, 'addon', key, rec);
  const refs = Object.fromEntries(rec.creds.map((x, k) => [a.creds?.find((y) => y.label === x.label)?.key ?? String(k), x.ref]));
  const wire = a.wire && url ? {
    note: a.wire.note, ...(a.wire.snippet && { snippet: a.wire.snippet.replace('{url}', url) }),
    env: (a.wire.env ?? []).map((e) => ({ key: e.key, value: e.from === 'url' ? url : e.from.startsWith('url:') ? `${url}${e.from.slice(4)}` : refs[e.from.slice(5)] })).filter((e): e is { key: string; value: string } => !!e.value),
  } : undefined;
  // Uptime Kuma: Unit7 adds a monitor for each site it knows (uptime.sync, with the login it just made); without that
  // login, the sites are listed for the person to add
  let monitors: Record<string, unknown> | undefined;
  if (a.id === 'uptime-kuma') {
    if (signedIn) { say(); monitors = await syncKuma(ctx, s.id).catch((e: Error) => ({ synced: false, note: `${e.message} Add each site as an HTTP(s) monitor in Uptime Kuma meanwhile.` })); }
    const sites = knownSites(ctx, s.id, i.domain ? [i.domain] : []).map((x) => x.url);
    if (!monitors?.synced) monitors = { ...monitors, sites: (monitors?.sites as string[] | undefined) ?? sites, note: [socketWhy, (monitors?.note as string | undefined) ?? 'Add each as an HTTP(s) monitor in Uptime Kuma.'].filter(Boolean).join(' ') };
    if (!(monitors.sites as string[]).length && !monitors.synced) monitors = undefined;
  }
  ctx.emit('addon.installed', `Added ${a.name} to ${s.name}${url ? ` at ${url.replace(/^https?:\/\//, '')}` : ''}`, { severity: healthy ? 'success' : 'warning', resource: s.id, data: { addon: a.id } });
  return {
    installed: true, addon: a.id, name: a.name, server: s.name, via: rec.via, url, healthy, status, ...(dns && { dns }), ...(rec.gate && { gated: true }),
    credentials: [...rec.creds.map((x) => ({ label: x.label, saved: true })), ...(a.creds ?? []).filter((cr) => !rec.creds.some((x) => x.label === cr.label)).map((cr) => ({ label: cr.label, saved: false }))],
    ...(a.creds?.length && rec.creds.length < a.creds.length && rec.via === 'coolify' && { credentialsNote: 'Coolify didn’t share some of its keys (that needs a token with read:sensitive): they’re in Coolify, in the service’s settings.' }),
    ...(a.firstVisit && { firstVisit: signedIn ? SIGNED : a.firstVisit }), ...(wire && !signedIn && { wire }), ...(monitors && { monitors }),
    ...(!healthy && { next: `${a.name} is still starting (${status}). Give it a minute, then open it.` }),
    undo: `addon.remove takes ${a.name} off ${s.name}; its data is kept unless a person chooses otherwise.`,
  };
}

export const HOST = z.string().trim().toLowerCase().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'a subdomain like analytics.example.com');
defineTool({
  name: 'addon.install', title: 'Add a tool to a server', risk: 'write', action: 'service_write', timeoutMs: 30 * 60_000,
  description: 'Add one of addon.catalog’s tools to a server, as one action: through Coolify’s one-click service where Coolify is connected (else Unit7 deploys it, for the ones that are one container and a database), on the domain given (a subdomain like analytics.example.com: its DNS record is written where the domain lives) or a free test address, then waits until it’s healthy. Its admin login is never left for the first visitor: Unit7 sets it before it starts (or through the tool’s own setup right after, before its domain points here), or it stays behind an extra password until the person finishes setup (addon.unlock); a name that already points somewhere else is never taken over unless a person types it as takeover. Keeps the admin keys in the vault (a person sees them with addon.credentials), and returns the wiring: a tracking snippet, settings for an app (addresses and vault references, never values), and for Uptime Kuma the sites to watch.',
  input: z.object({ serverId: fid('srv'), addon: z.enum(IDS), domain: HOST.optional(),
    takeover: z.string().max(253).optional().describe('People only: the domain typed again, to move a name that already points somewhere else to this server.') }),
  peopleOnly: (i) => !!i.takeover,
  assess: (ctx, i) => {
    const a = byId(i.addon), s = get<{ name: string }>(ctx.db, 'SELECT name FROM servers WHERE id = ? AND org_id = ?', i.serverId, ctx.orgId);
    return { tier: 2, impact: `Adds ${a.name} to ${s?.name ?? 'the server'} (about ${a.memoryMb} MB)${i.domain ? ` at ${i.domain}, writing its DNS record` : ' on a free test address'}; its keys go to the vault.` };
  },
  run: (ctx, i) => installAddon(ctx, byId(i.addon), i),
});

// what an install made, for what comes after it (a WordPress copy going into the new site)
export const addonMade = (ctx: Pick<Ctx, 'db' | 'orgId'>, serverId: string, a: Addon) => madeGet<AddonMade>(ctx, 'addon', `${serverId}:${a.id}`);
// A copy brings its own people along, so the login made for the empty site is gone with its database: it leaves the vault too
export function forgetLogin(ctx: Ctx, serverId: string, a: Addon) {
  const key = `${serverId}:${a.id}`, rec = madeGet<AddonMade>(ctx, 'addon', key), ref = credRef(serverId, a.id, 'UNIT7_ADMIN_PASSWORD');
  if (!rec) return;
  try { ctx.app.vault.retire(ctx.orgId, ref); } catch { /* not there */ }
  madeSet(ctx, 'addon', key, { ...rec, creds: rec.creds.filter((c) => c.ref !== ref) });
}

defineTool({
  name: 'addon.remove', title: 'Take a tool off a server', risk: 'destructive', action: (i) => (i.deleteData ? 'database_delete' : 'service_delete'), peopleOnly: true, timeoutMs: 5 * 60_000,
  description: 'Take an add-on off a server (addon.install made it). Its data is kept unless deleteData, which needs its name typed as confirmName. Its keys leave the vault (restorable for 30 days); the DNS record stays where it is. People only.',
  input: z.object({ serverId: fid('srv'), addon: ADDON_ID, deleteData: z.boolean().default(false), confirmName: z.string().max(80).optional() })
    .refine((i) => !i.deleteData || i.confirmName?.trim() === i.addon, 'To delete its data too, type its name as confirmName.'),
  async run(ctx, i) {
    requireHuman(ctx, 'take a tool off a server');
    const a = byId(i.addon), s = serverRow(ctx, i.serverId), key = `${s.id}:${a.id}`;
    const rec = madeGet<AddonMade>(ctx, 'addon', key);
    if (!rec) throw new Unit7Error('not_installed', `Unit7 didn’t add ${a.name} to ${s.name}.`, 404);
    await dropGate(ctx, s, rec).catch(() => undefined); // its extra password's route goes with it
    if (rec.via === 'coolify' && rec.uuid) await inside(ctx, 'coolify.remove', { serverId: s.id, uuid: rec.uuid, kind: 'service', deleteVolumes: i.deleteData, ...(i.deleteData && { confirmName: i.confirmName }) }).catch((e) => { if ((e as Unit7Error).code !== 'not_found') throw e; });
    for (const x of [rec.serviceId, rec.dbId].filter((v): v is string => !!v)) {
      if (get(ctx.db, 'SELECT 1 FROM services WHERE id = ? AND org_id = ?', x, ctx.orgId)) await inside(ctx, 'service.remove', { serviceId: x, deleteData: i.deleteData });
    }
    if (rec.domain) run(ctx.db, 'DELETE FROM domains WHERE hostname = ? AND org_id = ?', rec.domain, ctx.orgId);
    for (const c of rec.creds) { try { ctx.app.vault.retire(ctx.orgId, c.ref); } catch { /* already gone */ } }
    madeDrop(ctx, 'addon', key);
    ctx.emit('addon.removed', `${ctx.actor.name} took ${a.name} off ${s.name}${i.deleteData ? ', with its data' : ' (data kept)'}`, { severity: 'warning', resource: s.id, data: { addon: a.id } });
    return { removed: true, addon: a.id, name: a.name, dataKept: !i.deleteData, ...(rec.domain && { note: `The DNS record for ${rec.domain} stays; remove it where your DNS lives if you want the name back.` }) };
  },
});

defineTool({
  name: 'addon.unlock', title: 'Remove a tool’s extra password', risk: 'write', action: 'proxy_config', peopleOnly: true, timeoutMs: 60_000,
  description: 'People only: “I’ve finished setup”. Takes away the extra password Unit7 put in front of a tool that makes its admin from its first visitor (Uptime Kuma, Statusnook), once the person has made their own admin login there. Its address then answers anyone, and the tool’s own sign-in protects it.',
  input: z.object({ serverId: fid('srv'), addon: ADDON_ID }),
  async run(ctx, i) {
    requireHuman(ctx, 'take a tool’s extra password away');
    requireRole(ctx, ['owner', 'admin'], 'take a tool’s extra password away');
    const a = byId(i.addon), s = serverRow(ctx, i.serverId), key = `${s.id}:${a.id}`;
    const rec = madeGet<AddonMade>(ctx, 'addon', key);
    if (!rec) throw new Unit7Error('not_installed', `Unit7 didn’t add ${a.name} to ${s.name}.`, 404);
    if (!rec.gate) return { name: a.name, unlocked: false, note: `${a.name} has no extra password.` };
    await dropGate(ctx, s, rec);
    madeSet(ctx, 'addon', key, rec);
    ctx.emit('addon.unlocked', `${ctx.actor.name} finished setting up ${a.name} on ${s.name}: its extra password is gone`, { severity: 'info', resource: s.id, data: { addon: a.id } });
    return { name: a.name, unlocked: true, url: rec.url, note: `${a.name} now answers anyone at its address; its own sign-in protects it.` };
  },
});

defineTool({
  name: 'addon.credentials', title: 'Show a tool’s sign-in keys', risk: 'read', action: 'secret_reveal', peopleOnly: true,
  description: 'The admin keys an add-on generated (kept in the vault by addon.install), shown to the person who asks. People only, owners and admins, audited.',
  input: z.object({ serverId: fid('srv'), addon: ADDON_ID }),
  run(ctx, i) {
    requireHuman(ctx, 'see a tool’s keys');
    requireRole(ctx, ['owner', 'admin'], 'see a tool’s keys');
    const a = byId(i.addon), s = serverRow(ctx, i.serverId);
    const rec = madeGet<AddonMade>(ctx, 'addon', `${s.id}:${a.id}`);
    if (!rec) throw new Unit7Error('not_installed', `Unit7 didn’t add ${a.name} to ${s.name}.`, 404);
    ctx.emit('secret.revealed', `${ctx.actor.name} looked at ${a.name}’s keys on ${s.name}`, { severity: 'warning', resource: s.id });
    return { name: a.name, url: rec.url, items: rec.creds.map((c) => ({ label: c.label, value: { __reveal: ctx.secret(c.ref) } })), ...(a.firstVisit && { firstVisit: a.firstVisit }), ...(rec.gate && { gated: true }) };
  },
});
