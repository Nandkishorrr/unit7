// Self-hosted apps on a server Unit7 has root on (Supabase, Postgres, MySQL, Redis, MongoDB, n8n, MinIO, Grafana):
// how Unit7 recognises each one in the X-ray, where it opens, and how it gets a credential for it through the
// app's own supported way (a role or user it makes, a service account, a scoped token). Reading the app's own
// root secret is the fallback, only where the app has no way to make a narrower one. Pure code, no I/O: every
// command is rendered here, each value single-quoted (connectors/shell.ts) and checked to be a plain name.
//
// The rule every script follows: a secret leaves the server only on the command's stdout.
// - It is never on a command line: a new password is made on the server and handed to the app's own client on
//   its stdin through the shell's builtin printf; a setting is read with docker inspect's own filter, which
//   prints only the named keys (never the whole environment).
// - Nothing is written to a file (no here-documents: some shells keep those in /tmp).
// - The script prints a secret before it uses it, so Unit7 can mask it in whatever the app prints back.
import { createHash } from 'node:crypto';
import { script } from '../connectors/shell.ts';
import { safe } from '../discovery/actions.ts';
import { sections, type Inventory, type Part } from '../discovery/xray.ts';

export interface Cred {
  name: string;           // its name in the vault: "anon-key"
  label: string;          // what people see: "Anon key"
  value: string;
  scope: string;          // what it can do, in words
  made: boolean;          // Unit7 made it (and takes it back on disconnect), or read the app's own
  env?: string;           // the setting apps usually read it from
  user?: string;          // the login that goes with it (not a secret)
  public?: boolean;       // safe in a browser (Supabase's anon key)
  people?: boolean;       // a login for a person (a dashboard password): revealed to people, never wired into an app
}
export interface Got { creds: Cred[]; facts: Record<string, string>; revoke: string[]; note?: string; next?: 'fallback' | 'paste'; problem?: string }
export type ActionId = 'dashboard' | 'health' | 'backup' | 'update';
export interface Paste { what: string; steps: string[]; env: string; label: string; scope: string }
export interface Adapter {
  id: string; name: string;
  how: string;                                   // how Unit7 recognises it, in words
  detect: (p: Part) => boolean;
  connect?: (p: Part) => string[];               // the steps of the one SSH trip that makes (or reads) its credentials (each run as root)
  parse?: (out: string, p: Part) => Got;
  fallback?: (p: Part) => string[];              // reads the app's own root secret when it can't make a narrower one
  parseFallback?: (out: string, p: Part) => Got;
  paste?: Paste;                                 // apps that make keys only in their own settings page (n8n)
  makes: string;                                 // what connecting does, in words (approval cards, the pop-up)
  health?: (p: Part) => string;
  dashboard?: (p: Part, serverHost: string) => string | undefined;
  actions: ActionId[];
  people: string[];                              // what stays a person's job, and why
}

export const ROLE = 'unit7_read';
const UNTRUSTED_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ctr = (name: string | undefined) => { if (!name || !UNTRUSTED_NAME.test(name)) safe(undefined, 'container'); return name!; };
// the container of a stack that matches (Supabase's kong, its database), else the part's only one
export function pick(p: Part, re: RegExp): string | undefined {
  const hit = p.internals?.find((x) => re.test(x.image) || re.test(x.name))?.name ?? (p.containers ?? []).find((c) => re.test(c));
  return hit ?? (p.containers?.length === 1 ? p.containers[0] : undefined);
}
const one = (p: Part) => ctr(p.containers?.[0]);
const host = (p: Part) => (p.hosts?.[0] ? `https://${p.hosts[0]}` : undefined);
const published = (p: Part, port: number, serverHost: string) => (p.ports?.some((x) => x.port === port && x.public) ? `http://${serverHost}:${port}` : undefined);

// --- the scripts (constants; values are arguments) -------------------------------------------------------------
// docker inspect's own filter: for each container, only the named settings, one JSON string per line
export const keysTemplate = (keys: string[]) => {
  for (const k of keys) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) throw new Error(`refusing to read the setting ${k}`);
  return `{{$n := .Name}}{{range .Config.Env}}{{if eq (index (split . "=") 0) ${keys.map((k) => JSON.stringify(k)).join(' ')}}}{{$n}}|{{json .}}{{println}}{{end}}{{end}}`;
};
const READ = `printf '\\n@@unit7:keys\\n'
tpl=$1; shift
docker inspect -f "$tpl" "$@"`;
export const readKeys = (containers: string[], keys: string[]) => script(READ, keysTemplate(keys), ...containers.map(ctr));

// A new password made on the server, printed first, then handed to the app's own client (run by the container's
// shell) on its stdin: the text before, the line with the password (exactly one %s), the text after.
// With form sha256 the line gets the password's SHA-256 instead (Redis ACLs take #<hash>), so the app never sees it at all.
const MAKE = `c=$1; client=$2; pre=$3; line=$4; post=$5; form=$6
pw=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n')
[ \${#pw} -eq 48 ] || { echo "the server couldn't make a random password" >&2; exit 7; }
printf '\\n@@unit7:secret\\n%s\\n' "$pw"
v=$pw; [ "$form" = sha256 ] && v=$(printf '%s' "$pw" | sha256sum | cut -d' ' -f1)
[ \${#v} -ge 48 ] || { echo "the server couldn't hash the password" >&2; exit 7; }
printf '\\n@@unit7:reply\\n'
{ printf '%s\\n' "$pre"; printf "$line\\n" "$v"; printf '%s\\n' "$post"; } | docker exec -i "$c" sh -c "$client" 2>&1
printf '\\n@@unit7:exit\\n%s\\n' "$?"`;
export const make = (container: string, client: string, pre: string, line: string, post: string, form: 'plain' | 'sha256' = 'plain') => script(MAKE, ctr(container), client, pre, line, post, form);

// Constant text (no secret) to the app's own client: taking a role away, a health check
const SEND = `c=$1; client=$2; text=$3
printf '\\n@@unit7:reply\\n'
printf '%s\\n' "$text" | docker exec -i "$c" sh -c "$client" 2>&1
printf '\\n@@unit7:exit\\n%s\\n' "$?"`;
export const send = (container: string, client: string, text: string) => script(SEND, ctr(container), client, text);

// An HTTP status from inside the server: the container's own address, so nothing has to be open to the internet
const PROBE = `c=$1; port=$2; path=$3
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{println}}{{end}}' "$c" | grep -m1 .)
printf '\\n@@unit7:http\\n'
[ -n "$ip" ] && curl -s -o /dev/null -m 6 -w '%{http_code}' "http://$ip:$port$path" || printf 000`;
export const probe = (container: string, port: number, path: string) => script(PROBE, ctr(container), port, path);

// --- reading what came back -----------------------------------------------------------------------------------
// "/supabase-kong-x|\"KEY=value\"" lines → { container: { KEY: value } }
export function parseKeys(text = ''): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const l of text.split('\n')) {
    const bar = l.indexOf('|');
    if (bar < 1) continue;
    let kv: string;
    try { kv = JSON.parse(l.slice(bar + 1)); } catch { continue; }
    if (typeof kv !== 'string' || !kv.includes('=')) continue;
    const name = l.slice(0, bar).replace(/^\//, '');
    (out[name] ??= {})[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  }
  return out;
}
const first = (keys: Record<string, Record<string, string>>, order: (string | undefined)[], ...names: string[]) => {
  for (const n of names) for (const c of [...order.filter(Boolean), ...Object.keys(keys)] as string[]) { const v = keys[c]?.[n]?.trim(); if (v) return v; }
  return undefined;
};
const made = (sec: Record<string, string>) => ({ secret: (sec.secret ?? '').trim(), ok: (sec.exit ?? '').trim() === '0', reply: (sec.reply ?? '').trim() });
const failed = (what: string, reply: string) => `${what} (${reply.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 240) || 'no answer'})`;
// "https://a.example.com,https://b.example.com" or "a.example.com" → "https://a.example.com"
export const firstUrl = (v?: string) => { const u = v?.split(',')[0]?.trim(); return u ? (/^https?:\/\//.test(u) ? u.replace(/\/+$/, '') : `https://${u.replace(/\/+$/, '')}`) : undefined; };

// --- Postgres: a read-only role ---------------------------------------------------------------------------------
// The session stops logging statements first (and pg_stat_statements stops keeping utility ones), so the
// password never lands in the server's log; the role can't write and can't make roles. It reads past row-level security: on
// Supabase nearly every table has it, and a login that meets it counts nothing (part.query turns that into an error, not a zero).
const QUIET_PG = [`SET log_statement = 'none';`, `SET log_min_duration_statement = -1;`, `SET log_min_error_statement = 'panic';`, `SET pg_stat_statements.track_utility = off;`];
const roleSql = (owner?: string) => ({
  pre: [...QUIET_PG, `SELECT 'CREATE ROLE ${ROLE}' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}')\\gexec`].join('\n'),
  line: `ALTER ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD '%s';`,
  post: [
    `SELECT format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database())\\gexec`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE};`, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE};`, `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};`,
    `ALTER DEFAULT PRIVILEGES${owner ? ` FOR ROLE ${owner}` : ''} IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE};`,
    `ALTER ROLE ${ROLE} SET default_transaction_read_only = on;`,
  ].join('\n'),
});
// The default privileges go first by name, then DROP OWNED takes back every other grant in this database, then the role
const ifRole = (sql: string) => `SELECT '${sql}' WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}')\\gexec`;
export const dropRoleSql = (owner?: string) => [...QUIET_PG, ifRole(`ALTER DEFAULT PRIVILEGES${owner ? ` FOR ROLE ${owner}` : ''} IN SCHEMA public REVOKE SELECT ON TABLES FROM ${ROLE}`), ifRole(`DROP OWNED BY ${ROLE}`), `DROP ROLE IF EXISTS ${ROLE};`].join('\n');
export const DROP_ROLE_SQL = dropRoleSql();
// psql inside the container, as the image's own superuser: plain Postgres over its socket (trusted inside the
// container); Supabase's image as supabase_admin over 127.0.0.1 (its pg_hba trusts that inside the container)
// (the image's own password goes to psql in its environment, used only if the server asks for one)
export const PSQL = 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"';
export const PSQL_SUPABASE = 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse -h 127.0.0.1 -U supabase_admin -d postgres';
function roleGot(sec: Record<string, string>, container: string, client: string, scope: string, owner?: string): Pick<Got, 'creds' | 'revoke' | 'problem'> {
  const m = made(sec);
  if (!m.secret || !m.ok) return { creds: [], revoke: [], problem: failed('Postgres didn’t make the read-only login', m.reply) };
  return { creds: [{ name: 'db-read-password', label: 'Read-only database login', value: m.secret, scope, made: true, user: ROLE }], revoke: [send(container, client, dropRoleSql(owner))] };
}

// --- MySQL and MariaDB: a read-only user on the app databases (never MySQL's own, which holds password hashes) ---
// signed in as root with the image's own root password, read inside the container (MYSQL_PWD: the client's environment, not its command line)
export const MYSQL_LOGIN = [
  'p="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"',
  '[ -z "$p" ] && [ -n "${MYSQL_ROOT_PASSWORD_FILE:-}" ] && p=$(cat "$MYSQL_ROOT_PASSWORD_FILE")',
  '[ -n "$p" ] && export MYSQL_PWD="$p"',
  'm=$(command -v mysql || command -v mariadb)',
].join('; ');
export const MYSQL_ROOT = `${MYSQL_LOGIN}; exec "$m" -uroot -N -B`;
// the grants go after what came on stdin: one per app database, found by asking the server. A database name is
// anyone's text (an app user who can make a schema names it), so it's read one line at a time, never split or
// globbed, and only a plain name (letters, digits, _ $ -) gets a grant; its backticks are doubled anyway.
export const MYSQL = [
  MYSQL_LOGIN,
  'set -f',
  `dbs=$("$m" -uroot -N -B -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','sys','performance_schema','information_schema')")`,
  `{ cat; printf '%s\\n' "$dbs" | while IFS= read -r d; do case "$d" in ''|*[!A-Za-z0-9_\\$-]*) continue;; esac; e=$(printf '%s' "$d" | sed 's/\`/\`\`/g'); printf 'GRANT SELECT, SHOW VIEW ON \`%s\`.* TO ${ROLE}@%s;\\n' "$e" "'%'"; done; } | "$m" -uroot -N -B`,
].join('; ');
const MYSQL_PRE = 'SET SESSION sql_log_off = 1;';
const MYSQL_LINE = `DROP USER IF EXISTS '${ROLE}'@'%%'; CREATE USER '${ROLE}'@'%%' IDENTIFIED BY '%s';`;
export const DROP_USER_SQL = `SET SESSION sql_log_off = 1; DROP USER IF EXISTS '${ROLE}'@'%';`;

// --- Redis 6+: an ACL user that can only read (Redis 5 and older have one shared password: the fallback) ---------
export const REDIS = '[ -n "${REDIS_PASSWORD:-}" ] && export REDISCLI_AUTH="$REDIS_PASSWORD"; exec redis-cli';
// (Redis 6.0's own words: resetpass drops an older password, #<sha256> sets one without sending it, -@all drops an older grant)
const REDIS_LINE = `ACL SETUSER ${ROLE} on resetpass #%s resetkeys ~* -@all +@read -@dangerous +ping +info`;
// kept across restarts when Redis has an ACL file (ACL SAVE) or a config file (CONFIG REWRITE); otherwise it lives until a restart
const REDIS_POST = 'ACL SAVE\nCONFIG REWRITE';
export const REDIS_DROP = `ACL DELUSER ${ROLE}\nACL SAVE\nCONFIG REWRITE`;

// --- MongoDB: a readAnyDatabase user, made by mongosh signed in with the image's own root (read inside the container) ---
export const MONGO = 'exec mongosh --quiet --norc mongodb://127.0.0.1:27017/admin';
const MONGO_PRE = `const a = db.getSiblingDB('admin'); if (process.env.MONGO_INITDB_ROOT_USERNAME) a.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);`;
const MONGO_LINE = `const pw = '%s'; const roles = [{ role: 'readAnyDatabase', db: 'admin' }]; if (a.getUser('${ROLE}')) a.updateUser('${ROLE}', { pwd: pw, roles }); else a.createUser({ user: '${ROLE}', pwd: pw, roles });`;
const MONGO_POST = `print('unit7-' + 'done');`;
export const MONGO_DROP = `${MONGO_PRE} a.dropUser('${ROLE}'); print('unit7-' + 'done');`;

// --- MinIO: a service account under the root user, limited to S3 (no admin), made by mc inside the container ---
// mc reaches the server through MC_HOST_unit7 (an environment variable of mc alone, built inside the container from
// the container's own root settings), never through `mc alias set` with the keys on its command line.
const MC_HOST = 'u="${MINIO_ROOT_USER:-${MINIO_ACCESS_KEY:-}}"; p="${MINIO_ROOT_PASSWORD:-${MINIO_SECRET_KEY:-}}"; command -v mc >/dev/null 2>&1 || { echo unit7-no-mc; exit 0; }';
export const S3_ONLY = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:*'], Resource: ['arn:aws:s3:::*'] }] });
const MINIO_ADD = `c=$1; policy=$2
printf '\\n@@unit7:account\\n'
printf '%s' "$policy" | docker exec -i "$c" sh -c '${MC_HOST}; f=$(mktemp 2>/dev/null || echo /tmp/unit7-policy-$$); trap "rm -f \\"$f\\"" EXIT; cat > "$f"; MC_HOST_unit7="http://$u:$p@127.0.0.1:9000" mc admin user svcacct add unit7 "$u" --name unit7 --description "Made by Unit7" --policy "$f" --json' 2>&1
printf '\\n@@unit7:exit\\n%s\\n' "$?"`;
const MINIO_RM = `c=$1; key=$2
printf '\\n@@unit7:reply\\n'
docker exec "$c" sh -c '${MC_HOST}; MC_HOST_unit7="http://$u:$p@127.0.0.1:9000" mc admin user svcacct rm unit7 "$1"' unit7 "$key" 2>&1
printf '\\n@@unit7:exit\\n%s\\n' "$?"`;
export const minioRemove = (container: string, accessKey: string) => script(MINIO_RM, ctr(container), safe(accessKey, 'access key'));

// --- Grafana: a Viewer service account and a token for it, over Grafana's own API from inside the server ---------
// The admin login comes from the container's settings into the shell, and reaches curl on its stdin (curl -K -).
const GRAFANA_AUTH = `ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{println}}{{end}}' "$c" | grep -m1 .)
u=$(docker inspect -f "$tu" "$c"); u=\${u#*=}; p=$(docker inspect -f "$tp" "$c"); p=\${p#*=}
auth() { printf 'user = "%s"\\n' "$(printf '%s:%s' "\${u:-admin}" "\${p:-admin}" | sed 's/[\\\\"]/\\\\&/g')"; }
api() { auth | curl -s -m 10 -K - -H 'Content-Type: application/json' "$@"; }`;
const GRAFANA_ADD = `c=$1; port=$2; name=$3; tu=$4; tp=$5
${GRAFANA_AUTH}
b="http://$ip:$port/api/serviceaccounts"
printf '\\n@@unit7:account\\n'
sa=$(api -d '{"name":"unit7","role":"Viewer","isDisabled":false}' "$b")
id=$(printf '%s' "$sa" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
[ -n "$id" ] || id=$(api "$b/search?query=unit7" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
[ -n "$id" ] || { printf '%s\\n' "$sa" | grep -q -i -e 'unauthorized' -e 'invalid username' -e 'password' && echo unit7-login; exit 0; }
printf 'sa=%s\\n' "$id"
printf '\\n@@unit7:token\\n'
api -d "{\\"name\\":\\"$name\\"}" "$b/$id/tokens"`;
const GRAFANA_RM = `c=$1; port=$2; id=$3; tu=$4; tp=$5
${GRAFANA_AUTH}
printf '\\n@@unit7:reply\\n'
api -X DELETE "http://$ip:$port/api/serviceaccounts/$id"
printf '\\n@@unit7:exit\\n%s\\n' "$?"`;
// KEY=value as it is (one setting each, so the shell strips KEY= itself)
export const rawTemplate = (key: string) => { keysTemplate([key]); return `{{range .Config.Env}}{{if eq (index (split . "=") 0) ${JSON.stringify(key)}}}{{.}}{{end}}{{end}}`; };
const GF = { u: rawTemplate('GF_SECURITY_ADMIN_USER'), p: rawTemplate('GF_SECURITY_ADMIN_PASSWORD') };
export const grafanaRemove = (container: string, port: number, id: string) => script(GRAFANA_RM, ctr(container), port, safe(id, 'service account'), GF.u, GF.p);

// --- the adapters -------------------------------------------------------------------------------------------------
// Coolify's template runs Kong (SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY); Supabase's own compose moved to an Envoy gateway
// (ANON_KEY, SERVICE_ROLE_KEY). Studio has SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY / SUPABASE_PUBLIC_URL in both.
const SUPA_KEYS = ['SUPABASE_ANON_KEY', 'ANON_KEY', 'SUPABASE_SERVICE_KEY', 'SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD',
  'SUPABASE_PUBLIC_URL', 'SERVICE_URL_SUPABASEKONG', 'SERVICE_URL_SUPABASEKONG_8000', 'SERVICE_FQDN_SUPABASEKONG', 'API_EXTERNAL_URL'];
const kong = (p: Part) => pick(p, /(^|\/)kong[:/]|supabase-kong|envoyproxy\/envoy|supabase-envoy|api-gw/);
const supaDb = (p: Part) => pick(p, /supabase\/postgres|supabase-db/);
const studio = (p: Part) => p.internals?.find((x) => /supabase\/studio|supabase-studio/.test(x.image + x.name))?.name;

const supabase: Adapter = {
  id: 'supabase', name: 'Supabase', how: 'its containers (kong, studio, gotrue, postgrest and the supabase/postgres database) shown as one stack',
  detect: (p) => p.product?.id === 'supabase' && !!kong(p) && !!supaDb(p),
  makes: 'Unit7 makes a read-only database login for itself, and keeps the stack’s public key, service key and dashboard login in the vault. A self-hosted Supabase has one key of each kind and can’t make narrower ones, so those are its own.',
  connect: (p) => [readKeys([kong(p)!, ...[studio(p)].filter(Boolean) as string[]], SUPA_KEYS), make(supaDb(p)!, PSQL_SUPABASE, roleSql('postgres').pre, roleSql().line, roleSql('postgres').post)],
  parse(out, p): Got {
    const sec = sections(out), keys = parseKeys(sec.keys), k = kong(p)!, order = [k, studio(p)];
    const anon = first(keys, order, 'SUPABASE_ANON_KEY', 'ANON_KEY'), service = first(keys, order, 'SUPABASE_SERVICE_KEY', 'SERVICE_ROLE_KEY');
    const publishable = first(keys, order, 'SUPABASE_PUBLISHABLE_KEY'), secretKey = first(keys, order, 'SUPABASE_SECRET_KEY');
    const url = firstUrl(first(keys, [studio(p), k], 'SUPABASE_PUBLIC_URL', 'SERVICE_URL_SUPABASEKONG', 'SERVICE_URL_SUPABASEKONG_8000', 'SERVICE_FQDN_SUPABASEKONG', 'API_EXTERNAL_URL'));
    const creds: Cred[] = [];
    if (anon) creds.push({ name: 'anon-key', label: 'Anon key', value: anon, scope: 'public: safe in a browser; row-level security decides what it sees', made: false, env: 'SUPABASE_ANON_KEY', public: true });
    if (publishable) creds.push({ name: 'publishable-key', label: 'Publishable key', value: publishable, scope: 'public: the newer form of the anon key', made: false, env: 'SUPABASE_PUBLISHABLE_KEY', public: true });
    if (service) creds.push({ name: 'service-role-key', label: 'Service key', value: service, scope: 'full access: skips row-level security; for server code only, never a browser', made: false, env: 'SUPABASE_SERVICE_ROLE_KEY' });
    if (secretKey) creds.push({ name: 'sb-secret-key', label: 'Secret key', value: secretKey, scope: 'full access: the newer form of the service key; server code only', made: false, env: 'SUPABASE_SECRET_KEY' });
    const pass = first(keys, [k], 'DASHBOARD_PASSWORD');
    if (pass) creds.push({ name: 'dashboard-password', label: 'Dashboard login', value: pass, scope: 'signs a person in to Supabase Studio', made: false, user: first(keys, [k], 'DASHBOARD_USERNAME') ?? 'supabase', people: true });
    const role = roleGot(sec, supaDb(p)!, PSQL_SUPABASE, 'read-only: tables in the public schema, past row-level security so counts are right; it can’t write', 'postgres');
    return { creds: [...creds, ...role.creds], revoke: role.revoke, facts: { ...(url && { url }) }, ...(!anon && !publishable && { problem: 'Unit7 didn’t find the stack’s public (anon) key in its settings.' }), ...(role.problem && { note: role.problem }) };
  },
  health: (p) => probe(kong(p)!, 8000, '/rest/v1/'),
  dashboard: (p, h) => host(p) ?? published(p, 8000, h),
  actions: ['dashboard', 'health', 'backup', 'update'],
  people: ['Rotating the JWT secret (it signs every key and session: changing it signs everyone out and needs new keys everywhere)', 'Showing the service key or the dashboard login', 'Restoring the database'],
};

const engineAdapter = (o: { id: string; name: string; engines: string[]; how: string; makes: string; client: string; make: (c: string) => string; got: (sec: Record<string, string>, c: string) => Got; health: (c: string) => string; people: string[] }): Adapter => ({
  id: o.id, name: o.name, how: o.how, makes: o.makes,
  detect: (p) => !!p.engine && o.engines.includes(p.engine) && p.product?.id !== 'supabase' && p.kind === 'database' && p.containers?.length === 1,
  connect: (p) => [o.make(one(p))], parse: (out, p) => o.got(sections(out), one(p)), health: (p) => o.health(one(p)),
  actions: ['health', 'backup', 'update'], people: o.people,
});

const postgres = engineAdapter({
  id: 'postgres', name: 'PostgreSQL', engines: ['postgres'], how: 'a postgres, postgis, pgvector or timescaledb image', client: PSQL,
  makes: `Unit7 makes a read-only login (${ROLE}) inside the database, so it can look without being able to change anything.`,
  make: (c) => make(c, PSQL, roleSql().pre, roleSql().line, roleSql().post),
  got: (sec, c) => { const r = roleGot(sec, c, PSQL, 'read-only: tables in the public schema of its database'); return { ...r, facts: {} }; },
  health: (c) => send(c, 'exec pg_isready -q', ''),
  people: ['Dropping a database or restoring one', 'Changing the main (superuser) password apps use'],
});

const mysql = engineAdapter({
  id: 'mysql', name: 'MySQL', engines: ['mysql', 'mariadb'], how: 'a mysql or mariadb image', client: MYSQL,
  makes: `Unit7 makes a read-only user (${ROLE}) for the app databases (never MySQL’s own, which holds password hashes).`,
  make: (c) => make(c, MYSQL, MYSQL_PRE, MYSQL_LINE, ''),
  got(sec, c): Got {
    const m = made(sec);
    if (!m.secret || !m.ok) return { creds: [], revoke: [], facts: {}, problem: failed('MySQL didn’t make the read-only user', m.reply) };
    return { creds: [{ name: 'db-read-password', label: 'Read-only database login', value: m.secret, scope: 'read-only: the app databases, not MySQL’s own', made: true, user: ROLE }], revoke: [send(c, MYSQL_ROOT, DROP_USER_SQL)], facts: {} };
  },
  // "alive" (exit 0) even when the login is refused: it only asks whether the server answers
  health: (c) => send(c, 'a=$(command -v mysqladmin || command -v mariadb-admin); exec "$a" ping --silent', ''),
  people: ['Dropping a database or restoring one', 'Changing the root password'],
});

const redis: Adapter = {
  ...engineAdapter({
    id: 'redis', name: 'Redis', engines: ['redis'], how: 'a redis, valkey, keydb or dragonfly image', client: REDIS,
    makes: `Unit7 makes a read-only Redis user (${ROLE}). Redis 5 and older have one shared password, which Unit7 then keeps instead.`,
    make: (c) => make(c, REDIS, '', REDIS_LINE, REDIS_POST, 'sha256'),
    got(sec, c): Got {
      const m = made(sec), lines = m.reply.split('\n').map((l) => l.trim()).filter(Boolean);
      if (/unknown command|unknown subcommand/i.test(lines[0] ?? '')) return { creds: [], revoke: [], facts: {}, next: 'fallback' };
      if (!m.secret || lines[0] !== 'OK') return { creds: [], revoke: [], facts: {}, problem: failed('Redis didn’t make the read-only user', m.reply) };
      const kept = lines.slice(1).includes('OK');
      return {
        creds: [{ name: 'read-password', label: 'Read-only Redis login', value: m.secret, scope: 'read-only: reads keys, can’t write or run admin commands', made: true, user: ROLE }],
        revoke: [send(c, REDIS, REDIS_DROP)], facts: { kept: kept ? 'yes' : 'no' },
        ...(!kept && { note: 'This Redis has no ACL or config file, so it forgets the user when it restarts. Connect again after a restart.' }),
      };
    },
    health: (c) => send(c, REDIS, 'PING'),
    people: ['Flushing data (FLUSHALL) or changing the shared password'],
  }),
  fallback: (p) => [readKeys([one(p)], ['REDIS_PASSWORD'])],
  parseFallback(out, p): Got {
    const v = first(parseKeys(sections(out).keys), [one(p)], 'REDIS_PASSWORD');
    return v ? { creds: [{ name: 'password', label: 'Redis password', value: v, scope: 'full access: Redis older than 6 has one shared password', made: false, env: 'REDIS_PASSWORD' }], revoke: [], facts: {}, note: 'Redis older than 6 can’t make a narrower user, so Unit7 keeps its own password.' }
      : { creds: [], revoke: [], facts: {}, problem: 'This Redis has no password in its settings: anything that can reach it can use it.' };
  },
};

const mongo = engineAdapter({
  id: 'mongodb', name: 'MongoDB', engines: ['mongo'], how: 'a mongo image', client: MONGO,
  makes: `Unit7 makes a read-only MongoDB user (${ROLE}, readAnyDatabase), signed in as the image’s own root inside the container.`,
  make: (c) => make(c, MONGO, MONGO_PRE, MONGO_LINE, MONGO_POST),
  got(sec, c): Got {
    const m = made(sec);
    if (!m.secret || !m.ok || !m.reply.includes('unit7-done')) return { creds: [], revoke: [], facts: {}, problem: failed(/not found|mongosh/.test(m.reply) ? 'This MongoDB image has no mongosh, so Unit7 can’t make a user in it' : 'MongoDB didn’t make the read-only user', m.reply) };
    return { creds: [{ name: 'db-read-password', label: 'Read-only database login', value: m.secret, scope: 'read-only: every database (readAnyDatabase)', made: true, user: ROLE }], revoke: [send(c, MONGO, MONGO_DROP)], facts: {} };
  },
  health: (c) => send(c, 'exec mongosh --quiet --norc --eval "db.runCommand({ ping: 1 }).ok"', ''),
  people: ['Dropping a database or restoring one', 'Changing the root user'],
});

const n8n: Adapter = {
  id: 'n8n', name: 'n8n', how: 'the n8nio/n8n image', detect: (p) => p.product?.id === 'n8n' && !!p.containers?.length,
  makes: 'n8n makes API keys only in its own settings page, so you make one there and paste it here once. Unit7 checks it and keeps it in the vault.',
  paste: { what: 'an n8n API key', env: 'N8N_API_KEY', label: 'API key', scope: 'what you chose when you made it in n8n', steps: ['Open n8n and go to Settings, then n8n API.', 'Create an API key. Name it Unit7 and pick an expiry.', 'Copy it and paste it here. n8n shows it once.'] },
  health: (p) => probe(one(p), 5678, '/healthz'),
  dashboard: (p, h) => host(p) ?? published(p, 5678, h),
  actions: ['dashboard', 'health', 'backup', 'update'],
  people: ['Making the API key (only n8n’s settings page can)', 'Exporting credentials decrypted'],
};

const minio: Adapter = {
  id: 'minio', name: 'MinIO', how: 'the minio/minio image', detect: (p) => p.product?.id === 'minio' && p.containers?.length === 1,
  makes: 'Unit7 makes a MinIO service account that can use storage (S3) but not change MinIO’s settings or users.',
  connect: (p) => [script(MINIO_ADD, one(p), S3_ONLY)],
  parse(out, p): Got {
    const sec = sections(out);
    if ((sec.account ?? '').includes('unit7-no-mc')) return { creds: [], revoke: [], facts: {}, next: 'fallback' };
    const line = (sec.account ?? '').split('\n').find((l) => l.trim().startsWith('{') && l.includes('accessKey'));
    let j: { accessKey?: string; secretKey?: string } = {};
    try { j = JSON.parse(line ?? '{}'); } catch { /* not JSON: the problem below */ }
    if (!j.accessKey || !j.secretKey) return { creds: [], revoke: [], facts: {}, problem: failed('MinIO didn’t make the service account', sec.account ?? '') };
    return {
      creds: [{ name: 'secret-key', label: 'Storage key', value: j.secretKey, scope: 'storage (S3) only: no admin, no users', made: true, user: j.accessKey, env: 'S3_SECRET_ACCESS_KEY' }],
      revoke: [minioRemove(one(p), j.accessKey)], facts: { accessKey: j.accessKey },
    };
  },
  fallback: (p) => [readKeys([one(p)], ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY'])],
  parseFallback(out, p): Got {
    const keys = parseKeys(sections(out).keys), c = one(p);
    const user = first(keys, [c], 'MINIO_ROOT_USER', 'MINIO_ACCESS_KEY'), pass = first(keys, [c], 'MINIO_ROOT_PASSWORD', 'MINIO_SECRET_KEY');
    return pass ? { creds: [{ name: 'secret-key', label: 'Root storage key', value: pass, scope: 'full access: this MinIO has no mc to make a narrower account', made: false, user, env: 'S3_SECRET_ACCESS_KEY' }], revoke: [], facts: { ...(user && { accessKey: user }) }, note: 'This MinIO image has no mc, so Unit7 keeps its root key instead of a narrower one.' }
      : { creds: [], revoke: [], facts: {}, problem: 'Unit7 didn’t find MinIO’s root user in its settings.' };
  },
  health: (p) => probe(one(p), 9000, '/minio/health/live'),
  dashboard: (p, h) => host(p) ?? published(p, 9001, h),
  actions: ['dashboard', 'health', 'backup', 'update'],
  people: ['Deleting buckets', 'Changing the root user'],
};

const grafana: Adapter = {
  id: 'grafana', name: 'Grafana', how: 'the grafana/grafana image', detect: (p) => p.product?.id === 'grafana' && p.containers?.length === 1,
  makes: 'Unit7 makes a Viewer service account in Grafana and a token for it: it can look at dashboards, not change them.',
  connect: (p) => [script(GRAFANA_ADD, one(p), 3000, `unit7-${Date.now().toString(36)}`, GF.u, GF.p)],
  parse(out, p): Got {
    const sec = sections(out);
    if ((sec.account ?? '').includes('unit7-login')) return { creds: [], revoke: [], facts: {}, next: 'paste' };
    const sa = /sa=(\d+)/.exec(sec.account ?? '')?.[1];
    let j: { key?: string } = {};
    try { j = JSON.parse((sec.token ?? '').trim() || '{}'); } catch { /* not JSON */ }
    if (!sa || !j.key) return { creds: [], revoke: [], facts: {}, problem: failed('Grafana didn’t make the token', `${sec.account ?? ''} ${sec.token ?? ''}`) };
    return { creds: [{ name: 'token', label: 'Viewer token', value: j.key, scope: 'Viewer: looks at dashboards, can’t change them', made: true, env: 'GRAFANA_TOKEN' }], revoke: [grafanaRemove(one(p), 3000, sa)], facts: { serviceAccount: sa } };
  },
  paste: { what: 'a Grafana service account token', env: 'GRAFANA_TOKEN', label: 'Token', scope: 'the role you gave its service account', steps: ['Open Grafana: Administration, then Users and access, then Service accounts.', 'Add a service account called Unit7 with the Viewer role, then add a token.', 'Copy the token and paste it here.'] },
  health: (p) => probe(one(p), 3000, '/api/health'),
  dashboard: (p, h) => host(p) ?? published(p, 3000, h),
  actions: ['dashboard', 'health', 'backup', 'update'],
  people: ['Admin users and their passwords'],
};

export const ADAPTERS: Adapter[] = [supabase, postgres, mysql, redis, mongo, n8n, minio, grafana];

// The supported app a part is, unless it belongs to a PaaS itself (Coolify's own database) or to Unit7
export function adapterOf(inv: Inventory, p: Part): Adapter | undefined {
  if (p.owner === 'unit7' || inv.projects.find((x) => x.id === p.project)?.system) return undefined;
  return ADAPTERS.find((a) => a.detect(p));
}
// Production unless the part says otherwise (a Coolify environment called staging, preview, dev…)
const NONPROD = /^(dev|develop|development|staging|stage|preview|previews|test|testing|qa|sandbox|demo)$/i;
export const environmentOf = (inv: Inventory, p: Part) => p.coolify?.environment ?? inv.projects.find((x) => x.id === p.project)?.environments?.[0];
export const isProduction = (inv: Inventory, p: Part) => !NONPROD.test(environmentOf(inv, p) ?? '');
// the vault account a part's credentials live under: credential://serverapp/<this>/<app>.<name>
export const vaultAccount = (serverId: string, part: string) => `${serverId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${createHash('sha256').update(part).digest('hex').slice(0, 10)}`;
