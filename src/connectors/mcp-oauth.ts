// One-click "Connect with <provider>" for hosted MCP servers that use the standard MCP sign-in
// (OAuth 2.1 + PKCE + dynamic client registration). Unit7 registers itself, sends the person to the
// provider's own page, gets the tokens back on its callback, and keeps them encrypted in the vault.
// The AI never sees them; Unit7 refreshes them in the background before they expire.
//
// Providers only hand tokens to apps on your own computer (a localhost callback) or to apps they've
// approved, which is why this works out of the box for a Unit7 running locally.
import { randomBytes, createHash } from 'node:crypto';
import type { App } from '../app.ts';
import type { Ctx } from '../tools/runtime.ts';
import { get, id, json, run } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { makeRef } from '../vault.ts';
import { HttpMcp } from './mcp-http.ts';

export interface OAuthProvider { id: string; name: string; mcpUrl: string }

interface Endpoints { authorization: string; token: string; registration?: string; scopes: string[]; resource: string }
export interface OAuthSecret { access_token: string; refresh_token?: string; expires_at: number; client_id: string; client_secret?: string; auth_method?: string; token_endpoint: string; mcp_url: string; resource: string }
interface Client { id: string; secret?: string; method?: string }

const b64url = (b: Buffer) => b.toString('base64url');

async function discover(mcpUrl: string): Promise<Endpoints> {
  // the MCP server says where its metadata lives in the 401 it sends without a token
  const probe = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}', signal: AbortSignal.timeout(15_000) });
  const metaUrl = probe.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1] ?? new URL('/.well-known/oauth-protected-resource', mcpUrl).toString();
  const prm = await (await fetch(metaUrl, { signal: AbortSignal.timeout(15_000) })).json() as { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] };
  const as = prm.authorization_servers?.[0];
  if (!as) throw new Unit7Error('oauth_discovery', `${mcpUrl} doesn't publish a sign-in server.`, 502);
  const asm = await (await fetch(new URL('/.well-known/oauth-authorization-server', as), { signal: AbortSignal.timeout(15_000) })).json() as Record<string, any>;
  if (!asm.authorization_endpoint || !asm.token_endpoint) throw new Unit7Error('oauth_discovery', 'The sign-in server metadata is incomplete.', 502);
  return { authorization: asm.authorization_endpoint, token: asm.token_endpoint, registration: asm.registration_endpoint, scopes: prm.scopes_supported ?? [], resource: prm.resource ?? mcpUrl };
}

async function register(e: Endpoints, redirectUri: string): Promise<Client> {
  if (!e.registration) throw new Unit7Error('oauth_registration', 'This provider needs a pre-registered app; dynamic registration isn’t offered.', 502);
  const res = await fetch(e.registration, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Unit7', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => ({})) as { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string; error_description?: string };
  if (!res.ok || !j.client_id) throw new Unit7Error('oauth_registration', `Couldn't register Unit7 with the provider: ${j.error_description ?? res.status}`, 502);
  // some providers (Supabase, Neon, PlanetScale) issue a client secret anyway; keep it for the token calls
  return { id: j.client_id, secret: j.client_secret, method: j.token_endpoint_auth_method };
}

// pending sign-ins, keyed by the random `state` (memory: one process, a restart means "try again")
const pending = new Map<string, { provider: OAuthProvider; name: string; orgId: string; userId: string; verifier: string; client: Client; e: Endpoints; redirectUri: string; at: number }>();

export async function startOAuth(o: { provider: OAuthProvider; name: string; orgId: string; userId: string; redirectUri: string }): Promise<string> {
  const { provider } = o;
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  const e = await discover(provider.mcpUrl);
  const client = await register(e, o.redirectUri);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  pending.set(state, { provider, name: o.name, orgId: o.orgId, userId: o.userId, verifier, client, e, redirectUri: o.redirectUri, at: Date.now() });
  const url = new URL(e.authorization);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: client.id, redirect_uri: o.redirectUri, state, resource: e.resource,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    ...(e.scopes.length && { scope: e.scopes.join(' ') }),
  }).toString();
  return url.toString();
}

export async function tokenRequest(endpoint: string, client: Client, params: Record<string, string>) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = new URLSearchParams({ ...params, client_id: client.id });
  if (client.secret && client.method === 'client_secret_basic') headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString('base64')}`;
  else if (client.secret) body.set('client_secret', client.secret);
  const res = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) });
  const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  // a refused grant is final (the person signs in again); anything else may pass
  if (!res.ok || !j.access_token) throw new Unit7Error('oauth_token', `The provider didn't issue a token: ${[j.error ?? res.status, j.error_description].filter(Boolean).join(' — ')}`, /^(invalid_grant|invalid_client|unauthorized_client|bad_refresh_token)$/.test(j.error ?? '') ? 401 : 502);
  return j;
}

// The provider sent the person back with a code: swap it for tokens and create the account.
export async function finishOAuth(app: App, state: string, code: string, userId: string): Promise<{ accountId: string; name: string; provider: string }> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Unit7Error('oauth_state', 'That sign-in link expired. Click Connect again.', 400);
  if (p.userId !== userId) throw new Unit7Error('oauth_state', 'This sign-in was started by someone else.', 403);
  const t = await tokenRequest(p.e.token, p.client, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier, resource: p.e.resource });
  const { name, slug } = accountName(app, p.orgId, p.provider.id, p.name);
  const ref = makeRef(p.provider.id, slug, 'oauth');
  const secret: OAuthSecret = { access_token: t.access_token!, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 1200) * 1000, client_id: p.client.id, client_secret: p.client.secret, auth_method: p.client.method, token_endpoint: p.e.token, mcp_url: p.provider.mcpUrl, resource: p.e.resource };
  const accountId = id('acc');
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status, verified_at) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?)`,
    accountId, p.orgId, p.provider.id, name, slug, JSON.stringify({ ref, auth: 'oauth', mcpUrl: p.provider.mcpUrl }), new Date().toISOString());
  app.vault.put(p.orgId, ref, JSON.stringify(secret), { kind: 'oauth', accountId, by: 'oauth sign-in' });
  app.events.emit(p.orgId, 'account.connected', `${name} connected`, { severity: 'success', resource: accountId });
  return { accountId, name, provider: p.provider.name };
}

// A valid access token for an OAuth account, refreshed when it has less than `skewMs` left. `read` returns the
// stored blob and `store` writes the refreshed one back. Providers rotate refresh tokens, so two refreshes at
// once would spend the same one twice (invalid_grant): one refresh per stored sign-in runs at a time, and the
// others wait for it and use its result.
const refreshing = new Map<string, Promise<string>>();
export async function accessToken(key: string, read: () => string, store: (s: OAuthSecret) => void, skewMs = 90_000): Promise<string> {
  const s = JSON.parse(read()) as OAuthSecret;
  if (s.expires_at - Date.now() > skewMs) return s.access_token;
  let p = refreshing.get(key);
  if (!p) {
    p = (async () => {
      const s = JSON.parse(read()) as OAuthSecret; // read again: a refresh that just finished already stored a new one
      if (s.expires_at - Date.now() > skewMs) return s.access_token;
      if (!s.refresh_token) throw new Unit7Error('oauth_expired', 'The sign-in expired. Reconnect the account in the Vault.', 401);
      const t = await tokenRequest(s.token_endpoint, { id: s.client_id, secret: s.client_secret, method: s.auth_method }, { grant_type: 'refresh_token', refresh_token: s.refresh_token, ...(s.resource && { resource: s.resource }) });
      const next: OAuthSecret = { ...s, access_token: t.access_token!, refresh_token: t.refresh_token ?? s.refresh_token, expires_at: Date.now() + (t.expires_in ?? 1200) * 1000 };
      store(next);
      return next.access_token;
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, p);
  }
  return p;
}

export const isOAuthAccount = (meta: string) => json<{ auth?: string }>(meta, {}).auth === 'oauth';
// A bearer for a provider's REST API: a pasted token as is, or a one-click sign-in's access token (refreshed)
export async function bearerFor(ctx: Ctx, provider: string, accountId?: string) {
  const { ref, value, account } = ctx.credentialFor(provider, accountId);
  const token = isOAuthAccount(account.meta) ? await accessToken(`${ctx.orgId}:${ref}`, () => ctx.app.vault.resolve(ctx.orgId, ref), (s) => ctx.app.vault.put(ctx.orgId, ref, JSON.stringify(s), { kind: 'oauth', accountId: account.id, by: 'token refresh' })) : value;
  ctx.redactor.add(token, `${provider} token`); // the vault knew the JSON blob; an echo of the bearer itself is masked too
  return token;
}

// Nobody types an account name: the first is "Hostinger", a second one "Hostinger 2".
export function accountName(app: App, orgId: string, provider: string, base: string): { name: string; slug: string } {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'main';
    if (!get(app.db, 'SELECT 1 FROM accounts WHERE org_id = ? AND provider = ? AND (slug = ? OR name = ?)', orgId, provider, slug, name)) return { name, slug };
  }
}

// One MCP client per connected account, shared by every tool. The bearer is read (and refreshed and
// written back) from the vault on each request, through the caller's broker so account boundaries hold.
export interface ToolInfo { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema?: { properties?: Record<string, unknown> } }
const clients = new Map<string, { client: HttpMcp; lastUsed: number; tools?: ToolInfo[] }>();
setInterval(() => { for (const [k, p] of clients) if (Date.now() - p.lastUsed > 5 * 60_000) { p.client.close(); clients.delete(k); } }, 60_000).unref();
// each account's last listing outlives the idle close above, so a tool listed as a read stays a read
const listed = new Map<string, ToolInfo[]>();
// each provider's hosted MCP (the catalogue fills this): where a pasted key goes too
export const HOSTED_MCP: Record<string, string> = {};
// a server that keeps Bearer for its own sign-in takes a pasted token here instead
const KEY_HEADER: Record<string, string> = { sentry: 'sentry-bearer' };
export function oauthMcp(ctx: Ctx, accountId: string) {
  const acc = get<{ meta: string; provider: string; name: string }>(ctx.db, 'SELECT meta, provider, name FROM accounts WHERE id = ? AND org_id = ?', accountId, ctx.orgId);
  if (!acc) throw new Unit7Error('no_account', 'That account was not found.', 404);
  const signedIn = isOAuthAccount(acc.meta);
  // Hostinger's own local server takes a pasted token, and hostinger.do judges each operation
  if (!signedIn && acc.provider === 'hostinger') throw new Unit7Error('use_hostinger_do', 'This Hostinger account has a pasted token: use hostinger.search and hostinger.do for it.', 409);
  const url = signedIn ? json<{ mcpUrl: string }>(acc.meta, { mcpUrl: '' }).mcpUrl : HOSTED_MCP[acc.provider];
  if (url === undefined) throw new Unit7Error('no_hosted_tools', `${acc.name} has no hosted tools to call. Use Unit7’s own tools for it (tools.find).`, 409);
  const { ref } = ctx.credentialFor(acc.provider, accountId); // enforces the environment's account boundary
  let p = clients.get(accountId);
  if (!p) {
    const client = new HttpMcp({
      url, name: acc.name, pasted: !signedIn, header: signedIn ? undefined : KEY_HEADER[acc.provider],
      bearer: async () => (signedIn ? accessToken(`${ctx.orgId}:${ref}`, () => ctx.app.vault.resolve(ctx.orgId, ref), (s) => ctx.app.vault.put(ctx.orgId, ref, JSON.stringify(s), { kind: 'oauth', accountId, by: 'token refresh' })) : ctx.app.vault.resolve(ctx.orgId, ref)),
    });
    clients.set(accountId, (p = { client, lastUsed: Date.now() }));
  }
  p.lastUsed = Date.now();
  const pooled = p;
  return {
    client: pooled.client,
    tools: async (): Promise<ToolInfo[]> => { if (!pooled.tools) { pooled.tools = await pooled.client.listTools() as ToolInfo[]; listed.set(accountId, pooled.tools); } return pooled.tools; },
  };
}
// The provider's own hint for a tool, from the last listing. Like the MCP spec, a tool is destructive unless it
// says otherwise, and one Unit7 hasn't listed yet (a cold cache) is too.
export function toolHint(accountId: string, tool: string): 'read' | 'write' | 'destructive' {
  const a = listed.get(accountId)?.find((t) => t.name === tool)?.annotations;
  return a?.readOnlyHint === true ? 'read' : a?.destructiveHint === false ? 'write' : 'destructive';
}
export function closeOauthMcp(accountId: string) { clients.get(accountId)?.client.close(); clients.delete(accountId); listed.delete(accountId); }
