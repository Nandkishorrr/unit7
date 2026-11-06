// One click per connection. Every provider Unit7 knows, and the single way to connect each:
//   mcp         the provider's hosted MCP with standard sign-in: its own page, Allow, back, connected
//   github-app  Unit7 creates a private GitHub App in your account from a manifest, you pick repos, say yes once, done
//   openrouter  OpenRouter's sign-in hands back an API key for every model (Claude, Gemini, GPT…)
//   key         no sign-in for local apps: the button opens the provider's key page pre-filled, and the
//               key is picked up the moment you paste it on Unit7's page
//   local       found on this machine; nothing to do
// Nobody names accounts or picks options: names are automatic and permissions are fixed per provider.
import { randomBytes, createHash, createSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { App } from '../app.ts';
import { all, get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { makeRef } from '../vault.ts';
import { accessToken, accountName, HOSTED_MCP, startOAuth, tokenRequest, type OAuthProvider, type OAuthSecret } from './mcp-oauth.ts';
import { alertState, ensureReplies, newTopic } from '../sentinel/phone.ts';
import { addGoogleSignIn, cliFor, forgetSignedIn, signInsFor, TOOLS_FOR, TOOL_LABEL } from './cloudcli.ts';

export type Method =
  | { kind: 'mcp'; mcpUrl: string }
  | { kind: 'github-app' }
  | { kind: 'openrouter' }
  | { kind: 'key'; keyUrl: string; hint: string; pattern?: string; file?: true } // file: the key is a file (a .json) people may pick instead of paste
  | { kind: 'local' }
  | { kind: 'ntfy' };

export interface Provider { id: string; name: string; group: string; what: string; method: Method; alt?: Extract<Method, { kind: 'key' }> }

const cfToken = 'https://dash.cloudflare.com/profile/api-tokens?' + new URLSearchParams({
  name: 'Unit7',
  permissionGroupKeys: JSON.stringify([{ key: 'zone', type: 'edit' }, { key: 'dns', type: 'edit' }, { key: 'zone_settings', type: 'edit' }, { key: 'cache_purge', type: 'edit' }, { key: 'page', type: 'edit' }, { key: 'workers_scripts', type: 'edit' }, { key: 'workers_routes', type: 'read' }, { key: 'd1', type: 'edit' }, { key: 'workers_r2', type: 'edit' }, { key: 'account_analytics', type: 'read' }, { key: 'account_settings', type: 'read' }, { key: 'email_routing_address', type: 'edit' }, { key: 'email_routing_rule', type: 'edit' }]),
  accountId: '*', zoneId: 'all',
});

// Every `mcp` URL below was probed live (2026-10-06): dynamic registration accepted Unit7's localhost
// callback. Providers whose sign-in isn't open to local apps get a pre-filled key page instead.
const mcp = (id: string, name: string, group: string, what: string, mcpUrl: string): Provider => ({ id, name, group, what, method: { kind: 'mcp', mcpUrl } });
export const CATALOG: Provider[] = [
  { id: 'hostinger', name: 'Hostinger', group: 'Servers & domains', what: 'Your VPS, domains and DNS. Unit7 sets up servers for you.', method: { kind: 'mcp', mcpUrl: 'https://mcp.hostinger.com' },
    alt: { kind: 'key', keyUrl: 'https://hpanel.hostinger.com/profile/api', hint: 'Create a token, then paste it here.' } },
  { id: 'cloudflare', name: 'Cloudflare', group: 'Servers & domains', what: 'DNS and HTTPS for domains on Cloudflare, websites on Cloudflare Pages, and Workers, D1 databases and R2 storage.', method: { kind: 'key', keyUrl: cfToken, hint: 'Permissions are pre-filled. Click Continue, Create, then paste the token here. To let Unit7 read a Worker’s errors, first add Workers Observability: Edit by hand: the link can’t pre-fill that one.' } },
  { id: 'godaddy', name: 'GoDaddy', group: 'Servers & domains', what: 'DNS for domains on GoDaddy. Unit7 points them at your apps.', method: { kind: 'key', keyUrl: 'https://developer.godaddy.com/personal-access-token', hint: 'Create a personal access token with DNS update permission, then paste it here.' } },
  { id: 'porkbun', name: 'Porkbun', group: 'Servers & domains', what: 'DNS for domains on Porkbun.', method: { kind: 'key', keyUrl: 'https://porkbun.com/account/api', hint: 'Create an API key, then paste it as KEY:SECRET (both parts, colon between). Also switch on API Access for each domain.', pattern: '^pk1_[^:]+:sk1_' } },
  { id: 'namecom', name: 'Name.com', group: 'Servers & domains', what: 'DNS for domains on Name.com.', method: { kind: 'key', keyUrl: 'https://www.name.com/account/settings/api', hint: 'Create a token, then paste it as USERNAME:TOKEN. With 2FA on, also switch on API access under Security.', pattern: '^[^:]+:.+' } },
  { id: 'github', name: 'GitHub', group: 'Code', what: 'Deploy straight from your repos, private ones too.', method: { kind: 'github-app' },
    alt: { kind: 'key', keyUrl: 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Unit7', hint: 'Keep repo and workflow ticked: new repos, Pages, Actions logs, re-runs and secrets need them. Click Generate token, then paste it here. A fine-grained token needs Administration, Contents, Pages, Webhooks, Workflows, Actions and Secrets, read and write, on all your repos.', pattern: '^(gh[pousr]_|github_pat_)' } },
  { id: 'openrouter', name: 'OpenRouter', group: 'AI models', what: 'Every model (Claude, Gemini, GPT) with one sign-in. Powers Unit7’s own AI box.', method: { kind: 'openrouter' } },
  { id: 'anthropic', name: 'Anthropic API', group: 'AI models', what: 'Claude models for Unit7’s AI box, billed to your API account (not your Claude subscription).', method: { kind: 'key', keyUrl: 'https://platform.claude.com/settings/keys', hint: 'Click Create Key, then paste it here.', pattern: '^sk-ant-' } },
  { id: 'google', name: 'Google Gemini', group: 'AI models', what: 'Gemini models for Unit7’s AI box. Has a free tier.', method: { kind: 'key', keyUrl: 'https://aistudio.google.com/apikey', hint: 'Click Create API key, then paste it here.', pattern: '^AIza' } },
  { id: 'openai', name: 'OpenAI', group: 'AI models', what: 'GPT models for Unit7’s AI box.', method: { kind: 'key', keyUrl: 'https://platform.openai.com/api-keys', hint: 'Click Create new secret key, then paste it here.', pattern: '^sk-' } },
  { id: 'ollama', name: 'Ollama', group: 'AI models', what: 'Free models running on this Mac. Found automatically when Ollama is open.', method: { kind: 'local' } },
  { id: 'ntfy', name: 'Phone alerts', group: 'Alerts', what: 'A buzz on your phone when something needs you. Free ntfy app, no account.', method: { kind: 'ntfy' } },
  { id: 'webhook', name: 'Slack or Discord', group: 'Alerts', what: 'The same alerts in a team channel.', method: { kind: 'key', keyUrl: 'https://api.slack.com/messaging/webhooks', hint: 'Create an incoming webhook (Slack) or a channel webhook (Discord, channel settings → Integrations), then paste its URL here.', pattern: '^https://(hooks\\.slack\\.com|(discord|discordapp)\\.com/api/webhooks)/' } },
  { ...mcp('supabase', 'Supabase', 'Databases', 'Postgres, auth and storage projects. Unit7 wires them into your apps.', 'https://mcp.supabase.com/mcp'),
    alt: { kind: 'key', keyUrl: 'https://supabase.com/dashboard/account/tokens', hint: 'Generate a token, then paste it here. It also covers custom domains and server keys, which the one-click sign-in can\u2019t.', pattern: '^sbp_' } },
  { ...mcp('neon', 'Neon', 'Databases', 'Serverless Postgres branches.', 'https://mcp.neon.tech/mcp'),
    alt: { kind: 'key', keyUrl: 'https://console.neon.tech/app/settings/api-keys', hint: 'Create a personal API key, then paste it here. It also covers new projects, branches and logs, which the one-click sign-in may not.', pattern: '^napi_' } },
  { ...mcp('planetscale', 'PlanetScale', 'More services', 'MySQL and Postgres databases.', 'https://mcp.pscale.dev/mcp/planetscale'),
    alt: { kind: 'key', keyUrl: 'https://app.planetscale.com/~/settings/service-tokens', hint: 'Create a service token with read_organization and read_databases, then paste its secret here (an older token as ID:SECRET). To also add, connect and remove databases, give it create_databases, delete_databases, and on each database read_database, read_branch, connect_production_branch, create_production_branch_password and delete_database.', pattern: '^([\\w-]+:)?pscale_tkn_' } },
  { ...mcp('turso', 'Turso', 'More services', 'SQLite at the edge.', 'https://mcp.turso.tech/mcp'),
    alt: { kind: 'key', keyUrl: 'https://app.turso.tech/', hint: 'Open your organization, then Settings → API Tokens. Create a token with read, then paste it here. To also add, connect and remove databases, give it db:create, db:delete, db:mint-token and org:read, plus group:create if you have no group yet.' } },
  { ...mcp('upstash', 'Upstash', 'More services', 'Redis and queues.', 'https://mcp.upstash.io/mcp'),
    alt: { kind: 'key', keyUrl: 'https://console.upstash.com/account/api', hint: 'Create a management API key, then paste it as EMAIL:KEY (the email you sign in with, a colon, the key). A Read Only key can see your databases. To add, connect and remove them, use Read/Write.', pattern: '^[^:\\s]+@[^:\\s]+:.+' } },
  { ...mcp('stripe', 'Stripe', 'More services', 'Payments: products, prices, webhooks.', 'https://mcp.stripe.com'),
    alt: { kind: 'key', keyUrl: 'https://dashboard.stripe.com/apikeys', hint: 'Create a restricted key that can only read Webhook Endpoints, Events and Products, then paste it here. A test key sees test mode and a live key sees live mode: add one of each to compare them.', pattern: '^[rs]k_(test|live)_' } },
  { ...mcp('resend', 'Resend', 'More services', 'Sending email from your domain and your app.', 'https://mcp.resend.com/mcp'),
    alt: { kind: 'key', keyUrl: 'https://resend.com/api-keys', hint: 'Create an API key with full access (a sending-only key can’t list your domains), then paste it here.', pattern: '^re_' } },
  { ...mcp('sentry', 'Sentry', 'More services', 'Errors from your app, for Warden to read.', 'https://mcp.sentry.dev/mcp'),
    alt: { kind: 'key', keyUrl: 'https://sentry.io/settings/account/api/auth-tokens/', hint: 'Create a token with org:read, project:read and event:read, then paste it here.' } },
  // a token, not Vercel's MCP sign-in: that's only open to clients Vercel approves, and Unit7 needs the REST API (settings, domains)
  { id: 'vercel', name: 'Vercel', group: 'Servers & domains', what: 'Projects, settings and domains on Vercel. Unit7 wires them to your databases and APIs.', method: { kind: 'key', keyUrl: 'https://vercel.com/account/tokens', hint: 'Click Create Token (scope: your team, or Full Account), then paste it here.' } },
  { ...mcp('netlify', 'Netlify', 'Servers & domains', 'Sites on Netlify: settings, builds and domains.', 'https://netlify-mcp.netlify.app/mcp'),
    alt: { kind: 'key', keyUrl: 'https://app.netlify.com/user/applications#personal-access-tokens', hint: 'Click New access token, then paste it here.' } },
  { ...mcp('railway', 'Railway', 'Servers & domains', 'Apps and databases on Railway: variables, deploys and domains.', 'https://mcp.railway.com/mcp'),
    alt: { kind: 'key', keyUrl: 'https://railway.com/account/tokens', hint: 'Create an account token (not a project token), then paste it here.' } },
  { id: 'fly', name: 'Fly.io', group: 'Servers & domains', what: 'Apps and Postgres on Fly.io: secrets, restarts and domains.', method: { kind: 'key', keyUrl: 'https://fly.io/user/personal_access_tokens', hint: 'Create a personal access token (it sees all your organisations), then paste it here.' } },
  { id: 'heroku', name: 'Heroku', group: 'Servers & domains', what: 'Apps and databases on Heroku: settings and domains.', method: { kind: 'key', keyUrl: 'https://dashboard.heroku.com/account/applications/authorizations/new', hint: 'Create an authorization (no expiry, or a long one), then paste its token here.' } },
  { id: 'render', name: 'Render', group: 'Servers & domains', what: 'Services and databases on Render: settings, deploys and domains.', method: { kind: 'key', keyUrl: 'https://dashboard.render.com/u/settings#api-keys', hint: 'Click Create API Key, then paste it here.', pattern: '^rnd_' } },
  { ...mcp('digitalocean', 'DigitalOcean', 'Servers & domains', 'Droplets, managed apps and DNS.', 'https://apps.mcp.digitalocean.com/mcp'),
    alt: { kind: 'key', keyUrl: 'https://cloud.digitalocean.com/account/api/tokens', hint: 'Generate a token with domain read and write, then paste it here.' } },
  // The big clouds: one click when their command-line tool is signed in on this Mac (Unit7 asks it for a short-lived
  // token each time; connectors/cloudcli.ts), else a read-only key. Unit7 only reads them for now.
  { id: 'gcp', name: 'Google Cloud', group: 'Servers & domains', what: 'Cloud Run, App Engine, Cloud SQL, Cloud DNS, your domains and who pays for what. Unit7 hides the hard parts.', method: { kind: 'key', file: true,
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts/create', hint: 'Create a service account with the Viewer role, then Keys → Add key → JSON. Paste the file here or pick it. Quicker: run gcloud auth login on this Mac.' } },
  { id: 'firebase', name: 'Firebase', group: 'Servers & domains', what: 'Hosting sites and their domains, App Hosting, functions, Firestore and Realtime Database.', method: { kind: 'key', file: true,
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts/create', hint: 'Pick your Firebase project, create a service account with the Firebase Viewer role, then Keys → Add key → JSON. Paste the file here or pick it. Quicker: run firebase login on this Mac.' } },
  { id: 'aws', name: 'AWS', group: 'Servers & domains', what: 'Amplify, Lightsail, EC2, RDS, Route 53 and this month’s bill, without the AWS console.', method: { kind: 'key', pattern: '^(AKIA|ASIA)[A-Z0-9]{12,}:',
    keyUrl: 'https://console.aws.amazon.com/iam/home#/users', hint: 'Create a user with the ReadOnlyAccess policy, add an access key, then paste it as KEY_ID:SECRET. Quicker: sign in with the AWS CLI on this Mac.' } },
  { id: 'azure', name: 'Microsoft Azure', group: 'Servers & domains', what: 'Static Web Apps, App Service, databases, Azure DNS and this month’s cost.', method: { kind: 'key', pattern: '^[0-9a-f-]{36}:[0-9a-f-]{36}:',
    keyUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', hint: 'Register an app, give it the Reader role on your subscription, add a client secret, then paste TENANT_ID:CLIENT_ID:SECRET. Quicker: run az login on this Mac.' } },
  { id: 'hetzner', name: 'Hetzner Cloud', group: 'Servers & domains', what: 'Cloud servers and DNS zones on Hetzner. Unit7 can then set them up for you.', method: { kind: 'key',
    keyUrl: 'https://console.hetzner.cloud/projects', hint: 'Open your project, then Security → API tokens → Generate API token. Read is enough to see your servers; Read & Write also lets you buy, snapshot and turn them off from Unit7. Paste it here.' } },
];

export const provider = (id: string) => CATALOG.find((p) => p.id === id);
for (const p of CATALOG) if (p.method.kind === 'mcp') HOSTED_MCP[p.id] = p.method.mcpUrl;

// --- what the Connections page shows --------------------------------------------------------------

export function connections(app: App, orgId: string, extra: { ollama?: boolean; ghCli?: boolean; clis?: Record<string, string> } = {}) {
  const accounts = all<{ id: string; provider: string; name: string; status: string; meta: string; verified_at: string | null }>(app.db, 'SELECT id, provider, name, status, meta, verified_at FROM accounts WHERE org_id = ? ORDER BY created_at', orgId);
  return CATALOG.map((p) => ({
    id: p.id, name: p.name, group: p.group, what: p.what,
    method: p.method.kind, cli: (p.id === 'github' && !!extra.ghCli) || !!extra.clis?.[p.id], cliName: p.id === 'github' ? 'GitHub CLI' : extra.clis?.[p.id], file: p.method.kind === 'key' && !!p.method.file, keyUrl: p.method.kind === 'key' ? p.method.keyUrl : p.alt?.keyUrl, hint: p.method.kind === 'key' ? p.method.hint : p.alt?.hint,
    pattern: p.method.kind === 'key' ? p.method.pattern : p.alt?.pattern,
    accounts: p.id === 'ollama' ? (extra.ollama ? [{ id: 'local', name: 'This Mac', status: 'verified', pending: null, finishUrl: null }] : [])
      : accounts.filter((a) => a.provider === p.id).map((a) => {
        const m = json<{ pending?: string; slug?: string; replies?: string; approver?: string }>(a.meta, {});
        return { id: a.id, name: a.name, status: a.status, pending: m.pending ?? null, finishUrl: m.pending === 'install' && m.slug ? `https://github.com/apps/${m.slug}/installations/new` : null,
          ...(p.id === 'ntfy' && { phoneApprovals: !!(m.approver && (m as { proof?: unknown }).proof) }),
          // alert channels: connected only once a test went through (phone: it arrived; team chat: it was taken)
          ...(p.group === 'Alerts' && { alert: alertState(p.id, a.status, a.verified_at, a.meta) }) };
      }),
  }));
}

// --- start: the URL the Connect button sends the browser to ---------------------------------------

const pending = new Map<string, { kind: string; orgId: string; userId: string; at: number; verifier?: string; accountId?: string; origin?: string }>();
const fresh = (state: string, userId: string) => {
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
  const p = pending.get(state);
  if (!p || p.userId !== userId) throw new Unit7Error('oauth_state', 'That sign-in link expired. Click Connect again.', 400);
  return p;
};

export async function startConnect(app: App, o: { providerId: string; orgId: string; userId: string; origin: string }): Promise<string> {
  const p = provider(o.providerId);
  if (!p) throw new Unit7Error('unknown_provider', `Unit7 doesn't know ${o.providerId}.`, 404);
  const state = randomBytes(24).toString('base64url');
  if (p.method.kind === 'mcp') {
    const op: OAuthProvider = { id: p.id, name: p.name, mcpUrl: p.method.mcpUrl };
    return startOAuth({ provider: op, name: accountName(app, o.orgId, p.id, p.name).name, orgId: o.orgId, userId: o.userId, redirectUri: `${o.origin}/api/oauth/callback` });
  }
  if (p.method.kind === 'openrouter') {
    const verifier = randomBytes(32).toString('base64url');
    pending.set(state, { kind: 'openrouter', orgId: o.orgId, userId: o.userId, at: Date.now(), verifier });
    return 'https://openrouter.ai/auth?' + new URLSearchParams({ callback_url: `${o.origin}/api/connect/openrouter/done/${state}`, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', key_label: 'Unit7' });
  }
  if (p.method.kind === 'github-app') {
    pending.set(state, { kind: 'github', orgId: o.orgId, userId: o.userId, at: Date.now(), origin: o.origin });
    return `${o.origin}/api/connect/github/form/${state}`; // a tiny page that posts the manifest to GitHub
  }
  if (p.method.kind === 'key') return p.method.keyUrl;
  if (p.method.kind === 'ntfy') throw new Unit7Error('use_setup', 'Phone alerts are set up with one click on the Connections page.', 400);
  throw new Unit7Error('nothing_to_do', `${p.name} is found automatically.`, 400);
}

// --- OpenRouter: the sign-in returns a code, the code becomes an API key ---------------------------

export async function finishOpenRouter(app: App, state: string, code: string, userId: string) {
  const p = fresh(state, userId);
  pending.delete(state);
  const r = await fetch('https://openrouter.ai/api/v1/auth/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: p.verifier, code_challenge_method: 'S256' }), signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({})) as { key?: string; error?: { message?: string } };
  if (!r.ok || !j.key) throw new Unit7Error('oauth_token', `OpenRouter didn't issue a key: ${j.error?.message ?? r.status}`, 502);
  return saveAccount(app, p.orgId, 'openrouter', 'OpenRouter', j.key, { auth: 'oauth' });
}

function saveAccount(app: App, orgId: string, providerId: string, base: string, secret: string, meta: Record<string, unknown>, kind = 'api_token') {
  const { name, slug } = accountName(app, orgId, providerId, base);
  const ref = makeRef(providerId, slug, 'token');
  const accountId = id('acc');
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status, verified_at) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?)`,
    accountId, orgId, providerId, name, slug, JSON.stringify({ ref, ...meta }), new Date().toISOString());
  app.vault.put(orgId, ref, secret, { kind, accountId, by: 'one-click sign-in' });
  app.events.emit(orgId, 'account.connected', `${name} connected`, { severity: 'success', resource: accountId });
  return { accountId, name };
}

// --- GitHub, zero browser steps: reuse the GitHub CLI's sign-in when it's logged in on this machine ---
const gh = (args: string[]) => new Promise<string>((resolve, reject) =>
  execFile('gh', args, { timeout: 8000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (e, out) => (e ? reject(e) : resolve(out.trim()))));
export const githubCliReady = () => gh(['auth', 'token']).then((t) => t.length > 20, () => false);
export async function connectGithubCli(app: App, orgId: string) {
  const token = await gh(['auth', 'token']).catch(() => { throw new Unit7Error('gh_not_signed_in', 'The GitHub CLI isn’t signed in here. Click Connect GitHub to use the browser instead.', 409); });
  const login = await gh(['api', 'user', '--jq', '.login']).catch(() => '');
  const existing = get<{ id: string; name: string }>(app.db, `SELECT id, name FROM accounts WHERE org_id = ? AND provider = 'github' AND json_extract(meta, '$.login') = ?`, orgId, login);
  if (existing) return { accountId: existing.id, name: existing.name };
  return saveAccount(app, orgId, 'github', login ? `GitHub (${login})` : 'GitHub', token, { auth: 'gh-cli', login });
}

// --- GitHub: a private GitHub App made from a manifest (how Coolify and Dokploy do it) --------------
// Click 1 on GitHub: "Create GitHub App". Click 2: "Install" on the repos you choose. Click 3: "Authorize", for the one
// thing an install token can't do. Unit7 then mints one-hour install tokens itself and uses those for everything else.

const API = () => process.env.UNIT7_GITHUB_API ?? 'https://api.github.com';
const LOGIN = () => process.env.UNIT7_GITHUB_LOGIN ?? 'https://github.com/login/oauth';
const callbackOf = (origin: string) => `${origin}/api/connect/github/authorized`;
// administration makes repos and adds deploy keys, pages turns on Pages, repository_hooks adds webhooks, and workflows lets a
// push carry a .github/workflows file (GitHub turns such a push down without it)
const RIGHTS: Record<string, string> = { contents: 'write', metadata: 'read', pull_requests: 'write', statuses: 'write', deployments: 'write', actions: 'write', secrets: 'write', workflows: 'write', administration: 'write', pages: 'write', repository_hooks: 'write' };

export function githubManifestPage(state: string, userId: string, origin: string): string {
  fresh(state, userId);
  const manifest = {
    name: `Unit7 ${randomBytes(3).toString('hex')}`,
    url: origin.startsWith('https://') ? origin : 'https://github.com/Nandkishorrr/unit7',
    redirect_url: `${origin}/api/connect/github/created`,
    setup_url: `${origin}/api/connect/github/installed`,
    setup_on_update: true,
    callback_urls: [callbackOf(origin)],
    public: false,
    default_permissions: RIGHTS,
    default_events: [],
  };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><meta charset="utf-8"><title>Connecting GitHub…</title><link rel="icon" href="/favicon.svg?v=7" type="image/svg+xml">
<body style="font:15px system-ui;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">
<form method="post" action="https://github.com/settings/apps/new?state=${esc(state)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<p>Opening GitHub…</p><noscript><button>Continue to GitHub</button></noscript></form>
<script>${SUBMIT}</script>`;
}
const SUBMIT = 'document.forms[0].submit()';
export const MANIFEST_SCRIPT_HASH = `sha256-${createHash('sha256').update(SUBMIT).digest('base64')}`;

// GitHub sent us back with a code: turn it into the app's credentials, then send the person to install it.
export async function githubCreated(app: App, state: string, code: string, userId: string): Promise<string> {
  const p = fresh(state, userId);
  const r = await fetch(`${API()}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json', 'user-agent': 'Unit7' }, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({})) as { id?: number; slug?: string; pem?: string; client_id?: string; client_secret?: string; owner?: { login?: string }; message?: string };
  if (!r.ok || !j.id || !j.pem || !j.slug) throw new Unit7Error('github_app', `GitHub didn't finish creating the app: ${j.message ?? r.status}`, 502);
  const { accountId } = saveAccount(app, p.orgId, 'github', j.owner?.login ? `GitHub (${j.owner.login})` : 'GitHub',
    JSON.stringify({ app_id: j.id, pem: j.pem, client_id: j.client_id, client_secret: j.client_secret }),
    { auth: 'github-app', appId: j.id, slug: j.slug, owner: j.owner?.login, pending: 'install', ...(p.origin && { callback: callbackOf(p.origin) }) }, 'github_app');
  p.accountId = accountId; p.at = Date.now();
  return `https://github.com/apps/${j.slug}/installations/new?state=${encodeURIComponent(state)}`;
}

export function githubInstalled(app: App, state: string | undefined, installationId: string, userId: string): { name: string; next?: string } {
  const p = state ? fresh(state, userId) : undefined;
  if (state) pending.delete(state);
  // without our state (installed later from GitHub's side), the token code finds the install itself
  if (p?.accountId && /^\d+$/.test(installationId)) run(app.db, `UPDATE accounts SET meta = json_remove(json_set(meta, '$.installationId', ?), '$.pending') WHERE id = ? AND org_id = ?`, Number(installationId), p.accountId, p.orgId);
  const name = get<{ name: string }>(app.db, 'SELECT name FROM accounts WHERE id = ?', p?.accountId ?? '')?.name ?? 'GitHub';
  return { name, next: p?.accountId ? githubSignIn(app, p.orgId, userId, p.accountId) : undefined };
}

// The Authorize page, for the person's own token. No redirect_uri: GitHub uses the callback the App was made with.
export function githubSignIn(app: App, orgId: string, userId: string, accountId: string): string {
  const acc = get<{ meta: string }>(app.db, `SELECT meta FROM accounts WHERE id = ? AND org_id = ? AND provider = 'github'`, accountId, orgId);
  const m = json<{ ref?: string; auth?: string }>(acc?.meta ?? '{}', {});
  if (m.auth !== 'github-app' || !m.ref) throw new Unit7Error('not_found', 'That GitHub connection isn’t here any more. Click Connect GitHub in Connections.', 404);
  const { client_id } = JSON.parse(app.vault.resolve(orgId, m.ref)) as { client_id: string };
  const state = randomBytes(24).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  pending.set(state, { kind: 'github-user', orgId, userId, at: Date.now(), verifier, accountId });
  return `${LOGIN()}/authorize?${new URLSearchParams({ client_id, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`;
}

// The person's token sits next to the App's own secret in the vault, and no tool ever hands it out. It lasts eight hours and its
// refresh token works once: accessToken refreshes it, one at a time. An App with expiring tokens turned off gets one with no end.
const userRef = (ref: string) => ref.replace(/[^/]+$/, 'user');
export async function githubAuthorized(app: App, state: string, code: string, userId: string): Promise<string> {
  const p = fresh(state, userId);
  pending.delete(state);
  const acc = p.kind === 'github-user' ? get<{ name: string; meta: string }>(app.db, 'SELECT name, meta FROM accounts WHERE id = ? AND org_id = ?', p.accountId ?? '', p.orgId) : undefined;
  if (!acc) throw new Unit7Error('oauth_state', 'That sign-in link expired. Click Connect again.', 400);
  const { ref } = json<{ ref: string }>(acc.meta, { ref: '' });
  const { client_id, client_secret } = JSON.parse(app.vault.resolve(p.orgId, ref)) as { client_id: string; client_secret: string };
  const token_endpoint = `${LOGIN()}/access_token`;
  const t = await tokenRequest(token_endpoint, { id: client_id, secret: client_secret }, { code, code_verifier: p.verifier! });
  const secret: OAuthSecret = { access_token: t.access_token!, refresh_token: t.refresh_token, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : Number.MAX_SAFE_INTEGER, client_id, client_secret, token_endpoint, mcp_url: '', resource: '' };
  app.vault.put(p.orgId, userRef(ref), JSON.stringify(secret), { kind: 'oauth', accountId: p.accountId, by: 'one-click sign-in' });
  return acc.name;
}

// What GitHub is asked as the App itself, signed with its private key
function asApp(secret: string) {
  const s = JSON.parse(secret) as { app_id: number; pem: string };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(s.app_id) })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(s.pem).toString('base64url')}`;
  return (path: string, method = 'GET') => fetch(`${API()}${path}`, { method, headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'Unit7' }, signal: AbortSignal.timeout(20_000) });
}

// A one-hour install token for a GitHub App account (cached until five minutes before it expires). Kept with where it came
// from, so a token handed around as a plain string can still be traced back to its App (held) when GitHub says no.
interface Held { token: string; until: number; app: App; orgId: string; accountId: string; inst: number; user?: string }
const ghTokens = new Map<string, Held>();
const held = (token?: string) => (token ? [...ghTokens.values()].find((t) => t.token === token || t.user === token) : undefined);
export const fromGithubApp = (token?: string) => !!held(token);
export async function githubAppToken(app: App, orgId: string, account: { id: string; meta: string }, secret: string): Promise<string> {
  const hit = ghTokens.get(account.id);
  if (hit && hit.until > Date.now()) return hit.token;
  const gh = asApp(secret);
  let inst = json<{ installationId?: number }>(account.meta, {}).installationId;
  if (!inst) {
    const list = await (await gh('/app/installations')).json() as { id: number }[];
    inst = Array.isArray(list) ? list[0]?.id : undefined;
    if (!inst) throw new Unit7Error('github_not_installed', 'The Unit7 GitHub App isn’t installed on any repos yet. Open Connections and click Install on GitHub.', 409);
    run(app.db, `UPDATE accounts SET meta = json_remove(json_set(meta, '$.installationId', ?), '$.pending') WHERE id = ? AND org_id = ?`, inst, account.id, orgId);
  }
  const r = await gh(`/app/installations/${inst}/access_tokens`, 'POST');
  const j = await r.json().catch(() => ({})) as { token?: string; expires_at?: string; message?: string };
  if (!r.ok || !j.token) throw new Unit7Error('github_token', `GitHub refused an install token: ${j.message ?? r.status}`, 502);
  ghTokens.set(account.id, { token: j.token, until: Date.parse(j.expires_at ?? '') - 5 * 60_000 || Date.now() + 50 * 60_000, app, orgId, accountId: account.id, inst });
  return j.token;
}

const metaOf = (t: Held) => json<{ ref: string; slug?: string; callback?: string }>(get<{ meta: string }>(t.app.db, 'SELECT meta FROM accounts WHERE id = ?', t.accountId)?.meta ?? '{}', { ref: '' });
interface Install { account: { login: string; type?: string }; permissions?: Record<string, string>; html_url: string }
async function installOf(t: Held): Promise<Install> {
  const r = await asApp(t.app.vault.resolve(t.orgId, metaOf(t).ref))(`/app/installations/${t.inst}`);
  if (!r.ok) throw new Unit7Error('github_api', `GitHub said ${r.status} when Unit7 asked about its GitHub App.`, 502, { status: r.status });
  return r.json() as Promise<Install>;
}
const label = (k: string) => ({ repository_hooks: 'Webhooks', statuses: 'Commit statuses' } as Record<string, string>)[k] ?? `${k[0]!.toUpperCase()}${k.slice(1).replace('_', ' ')}`;
const lacking = (i: Install) => Object.keys(RIGHTS).filter((k) => i.permissions?.[k] !== RIGHTS[k] && i.permissions?.[k] !== 'write').map(label);

// What the App's owner has to do, as exact links. A manifest only counts when an App is made and GitHub has no route to change one
// afterwards, so an App made before a right was added gets it by hand: on the App, then accepted on the install.
function refusal(t: Held, i: Install, signIn: boolean, detail?: object) {
  ghTokens.delete(t.accountId); // the next try needs a token made after the owner said yes
  const m = metaOf(t), lack = lacking(i), mine = `https://github.com/settings/apps/${m.slug}`;
  const here = m.callback ? new URL(m.callback).origin : process.env.UNIT7_URL ?? `http://localhost:${(t.app.services.listen as { port?: number } | undefined)?.port ?? 4800}`;
  const steps = [
    ...(lack.length ? [`Open ${mine}/permissions, set ${new Intl.ListFormat('en').format(lack)} to Read and write, then click Save changes.`] : []),
    ...(signIn && !m.callback ? [`Open ${mine}, put ${callbackOf(here)} under Callback URL, then click Save changes.`] : []),
    ...(lack.length ? [`Open ${i.html_url}, click Review request, then Accept new permissions.`] : []),
    ...(signIn ? [`Open ${here}/api/connect/github/authorize/${t.accountId} and click Authorize.`] : []),
  ];
  const first = lack.length || !m.callback ? 'Unit7’s GitHub App was made before it could do this, and only you can change that on GitHub:' : 'GitHub only lets a person create a repo on a personal account, so Unit7 needs your OK once:';
  return new Unit7Error('github_rights', `${first}\n${steps.length > 1 ? steps.map((x, n) => `${n + 1}. ${x}`).join('\n') : steps[0]}\nThen run this again.`, 403, detail);
}

// An App's "not allowed", in plain words. Undefined for any other token, or when it's about something else (a rate limit, an archived repo).
export async function githubRefused(token: string | undefined, status: number, why = ''): Promise<Unit7Error | undefined> {
  const t = held(token), detail = { status, why };
  if (status === 401 && t && t.user === token) return refusal(t, await installOf(t), true, detail); // the person took back their OK on GitHub
  if (!t || status !== 403 || !/not accessible/i.test(why)) return undefined;
  const i = await installOf(t).catch(() => undefined);
  if (!i) return undefined;
  if (lacking(i).length) return refusal(t, i, false, detail);
  ghTokens.delete(t.accountId);
  return new Unit7Error('github_rights', `GitHub still said no, though Unit7’s GitHub App has the rights. Open ${i.html_url} and, under Repository access, choose All repositories or tick this repo. If you only just accepted new rights, run this again.`, 403, detail);
}

async function userToken(t: Held) {
  const ref = userRef(metaOf(t).ref);
  if (!t.app.vault.has(t.orgId, ref)) return undefined;
  const token = await accessToken(`${t.orgId}:${ref}`, () => t.app.vault.resolve(t.orgId, ref), (x) => t.app.vault.put(t.orgId, ref, JSON.stringify(x), { kind: 'oauth', accountId: t.accountId, by: 'token refresh' }))
    .catch((e: Unit7Error) => { if (e.status === 401) return undefined; throw e; }); // refused for good: the person says yes again
  t.user = token;
  return token;
}

// The account a GitHub App is installed on: an install token has no user behind it, so GET /user turns it down
export const githubHome = async (token: string) => { const t = held(token); return t && (await installOf(t)).account.login; };

// Who makes a new repo. Anything but an App token does it itself. An App on an organisation uses its install token. On a personal
// account it takes the person's own token: GitHub's docs list POST /user/repos for install tokens, but it answers 403 to them.
export async function githubRepoMaker(token: string, org?: string): Promise<{ token: string; org?: string }> {
  const t = held(token);
  if (!t) return { token, org };
  const i = await installOf(t), home = i.account.login, onOrg = i.account.type === 'Organization';
  if (org && org.toLowerCase() !== home.toLowerCase()) throw new Unit7Error('github_rights', `Unit7’s GitHub App is on ${home}, so it can’t reach ${org}. To make repos in ${org}, connect GitHub with a token in Connections.`, 403);
  const user = onOrg ? undefined : await userToken(t);
  if (i.permissions?.administration !== 'write' || (!onOrg && !user)) throw refusal(t, i, !onOrg && !user);
  return onOrg ? { token, org: home } : { token: user! };
}

// Phone alerts: a private random ntfy topic for the alerts and a second one for the phone's answers, both kept in the
// vault like any credential. Not "connected" yet: that waits until the phone shows a test arrived (sentinel/phone.ts),
// and so do phone approvals. Asked again, it gives back the same topic, so the steps can be shown again.
export function setupNtfy(app: App, orgId: string, byUserId?: string): { accountId: string; subscribeUrl: string } {
  const had = get<{ id: string; meta: string }>(app.db, `SELECT id, meta FROM accounts WHERE org_id = ? AND provider = 'ntfy' ORDER BY created_at LIMIT 1`, orgId);
  if (had) return { accountId: had.id, subscribeUrl: app.vault.resolve(orgId, json<{ ref: string }>(had.meta, { ref: '' }).ref) };
  const url = newTopic('unit7-');
  const { name, slug } = accountName(app, orgId, 'ntfy', 'Phone alerts');
  const ref = makeRef('ntfy', slug, 'token'), accountId = id('acc');
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta) VALUES (?, ?, 'ntfy', ?, ?, ?)`, accountId, orgId, name, slug, JSON.stringify({ ref, auth: 'ntfy', ...(byUserId && { by: byUserId }) }));
  app.vault.put(orgId, ref, url, { kind: 'api_token', accountId, by: 'phone alerts' });
  ensureReplies(app, orgId, accountId);
  app.events.emit(orgId, 'account.added', 'Phone alerts set up: waiting for your phone to get a test', { resource: accountId });
  return { accountId, subscribeUrl: url };
}

// --- Google Cloud, Firebase, AWS, Azure with zero browser steps: their own CLI, signed in on this Mac ----------
// The vault keeps which tool and which sign-in, never a token: each scan asks the tool for a fresh short-lived one.
export const cloudClis = async () => Object.fromEntries((await Promise.all(Object.keys(TOOLS_FOR).map(async (id) => [id, (await cliFor(id))?.tool] as const)))
  .filter(([, t]) => t).map(([id, t]) => [id, TOOL_LABEL[t!]]));
// account: which of the tool's sign-ins (an email, a profile). Without one: the active sign-in, or else the first one
// not connected yet. One already connected here is refused (an expired one is simply back in use).
const WHAT: Record<string, string> = { gcp: 'Google account', firebase: 'Google account', aws: 'AWS profile', azure: 'Azure account' };
const loginOf = (app: App, orgId: string, providerId: string, who: string) =>
  get<{ id: string; name: string; status: string }>(app.db, `SELECT id, name, status FROM accounts WHERE org_id = ? AND provider = ? AND json_extract(meta, '$.auth') = 'cli' AND lower(json_extract(meta, '$.login')) = lower(?)`, orgId, providerId, who);
export async function connectCloudCli(app: App, orgId: string, providerId: string, account?: string) {
  const p = provider(providerId);
  forgetSignedIn(); // a sign-in made a moment ago counts
  const { signIns } = p ? await signInsFor(providerId) : { signIns: [] };
  const found = account ? signIns.find((s) => s.who.toLowerCase() === account.toLowerCase())
    : signIns.find((s) => s.active && !loginOf(app, orgId, providerId, s.who)) ?? signIns.find((s) => !loginOf(app, orgId, providerId, s.who)) ?? signIns[0];
  if (!p || !found) throw new Unit7Error('cli_not_signed_in', account ? `${account} isn’t signed in on this Mac any more. Sign in again, or use a key.` : `Nothing is signed in to ${p?.name ?? providerId} on this Mac. Use a key instead, or sign in there first.`, 409);
  const existing = loginOf(app, orgId, providerId, found.who);
  if (existing?.status === 'verified') throw new Unit7Error('already_connected', `This ${WHAT[providerId] ?? 'account'} is already connected. Sign in with another one to add it.`, 409);
  const secret = found.tool === 'aws' ? { cli: 'aws', profile: found.who } : found.tool === 'az' ? { cli: 'az', user: found.who, subscription: found.subscription } : { cli: found.tool, account: found.who };
  if (existing) { // signed in again: back in use, on the sign-in found now
    run(app.db, `UPDATE accounts SET status = 'verified', pause_until = NULL, meta = json_set(meta, '$.cli', ?) WHERE id = ?`, found.tool, existing.id);
    app.vault.put(orgId, json<{ ref: string }>(get<{ meta: string }>(app.db, 'SELECT meta FROM accounts WHERE id = ?', existing.id)!.meta, { ref: '' }).ref, JSON.stringify(secret), { kind: 'cli_signin', accountId: existing.id, by: 'one-click sign-in' });
    return { accountId: existing.id, name: existing.name };
  }
  return saveAccount(app, orgId, providerId, `${p.name} · ${found.who}`, JSON.stringify(secret), { auth: 'cli', cli: found.tool, login: found.who }, 'cli_signin');
}

// For the connect pop-up: every sign-in this Mac has for a tile (which are connected already), and how to add one:
// 'browser' (gcloud's own sign-in, started from Unit7), or a command to run in Terminal.
export async function cliSignIns(app: App, orgId: string, providerId: string) {
  forgetSignedIn();
  const { signIns, tools } = await signInsFor(providerId);
  const login = tools.includes('gcloud') ? 'browser' : ({ firebase: 'firebase login:add', aws: 'aws configure sso', azure: 'az login', gcp: 'gcloud auth login' } as Record<string, string>)[providerId];
  return { signIns: signIns.map((s) => ({ who: s.who, tool: TOOL_LABEL[s.tool], active: s.active, connected: loginOf(app, orgId, providerId, s.who)?.status === 'verified' })), login };
}
// "Sign in with another Google account" (Google Cloud and Firebase, through gcloud), then connect it
export async function addCliSignIn(app: App, orgId: string, providerId: string) {
  if (!['gcp', 'firebase'].includes(providerId)) throw new Unit7Error('use_terminal', 'Add the sign-in in Terminal, then come back.', 400);
  const who = await addGoogleSignIn();
  if (!who) return { added: null, ...(await cliSignIns(app, orgId, providerId)) }; // an account gcloud already had: pick it below
  return { added: await connectCloudCli(app, orgId, providerId, who), ...(await cliSignIns(app, orgId, providerId)) };
}
