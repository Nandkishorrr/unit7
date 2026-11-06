// The control plane's HTTP surface. Reads come straight from the database; every change goes
// through POST /api/tools/:name, the same gate the CLI, MCP clients and the agent use.
import { Hono, type Context } from 'hono';
import { EVENT_WORDS, explainEvent, explainSuggestion } from '../explain.ts';
import { visible } from '../snooze.ts';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { App } from '../app.ts';
import { all, get, json, run } from '../db.ts';
import { Unit7Error, forbidden } from '../errors.ts';
import { ROLES, canGrant, isAdmin, type Role } from '../policy.ts';
import * as auth from '../auth.ts';
import { execute, decideApproval, tools, viewInput } from '../tools/runtime.ts';
import { getTool, hardToUndo } from '../tools/runtime.ts';
import type { DB } from '../db.ts';
import { tierOf } from '../policy.ts';
import { graph } from '../tools/core.ts';
import { sendToAgent, getConversation, listConversations, stopAgent, agentStatus, CONTEXT } from '../agent/conversations.ts';
import { watcherActive, pendingCount } from '../agent/bridge.ts';
import { brainStatus, setBrain } from '../agent/subscription.ts';
import { autopilotView } from '../tools/autopilot.ts';
import { testAlerts } from '../sentinel/notify.ts';
import { warden } from '../sentinel/warden.ts';
import { HELP } from '../help.ts';
import { agentList, connectAgent, disconnectAgent } from '../agents/connect.ts';
import { suggestions } from '../suggestions.ts';
import { finishOAuth } from '../connectors/mcp-oauth.ts';
import { MANIFEST_SCRIPT_HASH, connections, connectGithubCli, githubCliReady, cloudClis, connectCloudCli, cliSignIns, addCliSignIn, setupNtfy, startConnect, finishOpenRouter, githubManifestPage, githubCreated, githubInstalled, provider as catalogProvider } from '../connectors/oneclick.ts';
import { handleMcp } from '../mcp/server.ts';
import { answerAsk, optionsFor } from '../agent/asks.ts';
import { chooseFolder, inspectFolder } from '../connectors/folder.ts';
import { SETUP_COMMANDS, openTerminal, terminalCommand } from '../agent/brain-setup.ts';

type Env = { Variables: { principal?: auth.Principal } };
const WEB = fileURLToPath(new URL('../../dist/web', import.meta.url));
const COOKIE = 'unit7_session';

// --- rate limiting: a token bucket per key, in memory (one process) ---
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(key: string, perMinute: number) {
  const b = buckets.get(key) ?? { tokens: perMinute, at: Date.now() };
  b.tokens = Math.min(perMinute, b.tokens + ((Date.now() - b.at) / 60_000) * perMinute);
  b.at = Date.now();
  if (b.tokens < 1) throw new Unit7Error('rate_limited', 'Too many attempts. Wait a minute and try again.', 429);
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 50_000) buckets.clear(); // ponytail: crude cap; per-key LRU if this ever matters
}

export const resetRateLimits = () => buckets.clear();

// X-Forwarded-For is only believed behind a proxy we were told about; otherwise anyone could
// send a fresh fake address with every request and walk straight past the rate limits.
const ip = (c: Context) => (process.env.UNIT7_TRUST_PROXY === '1' && c.req.header('x-forwarded-for')?.split(',')[0]?.trim())
  || (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress || 'local';

export function rpOf(c: Context): auth.RP {
  const base = process.env.UNIT7_URL ? new URL(process.env.UNIT7_URL) : new URL(c.req.url);
  return { id: base.hostname, name: 'Unit7', origin: base.origin };
}

export function createHttp(app: App) {
  const http = new Hono<Env>();
  const { db } = app;

  const headers = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"],
    },
    referrerPolicy: 'same-origin',
  });
  // the GitHub hand-off page sets its own, even tighter policy (one hashed script, posts only to GitHub)
  http.use('*', (c, next) => (c.req.path.startsWith('/api/connect/github/form/') ? next() : headers(c, next)));
  // every body is capped while it streams in, before anything reads it (uploads: 100 MB, the rest: 2 MB)
  const limit = (mb: number) => bodyLimit({ maxSize: mb * 1024 * 1024, onError: (cc) => cc.json({ error: { code: 'too_large', message: `That request is too large (${mb} MB max).` } }, 413) });
  http.use('/api/*', (c, next) => limit(c.req.path === '/api/uploads' ? 100 : 2)(c, next));
  http.use('/mcp', limit(2));

  // DNS rebinding: a website whose name points at 127.0.0.1 reaches Unit7 as "same-origin" from the browser's
  // view, but its Host header still says its own name. Only names that really mean this computer (or UNIT7_URL's,
  // or UNIT7_ALLOWED_HOSTS when serving on a network) get an answer.
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.UNIT7_URL ? [new URL(process.env.UNIT7_URL).hostname] : []),
    ...(process.env.UNIT7_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  http.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase().replace(/:\d+$/, '');
    if (!hosts.has(host)) return c.json({ error: { code: 'bad_host', message: `Unit7 doesn't answer to ${host}. Open it at http://localhost (or set UNIT7_URL).` } }, 421);
    await next();
  });

  // Callback pages providers send the browser to: a navigation can't carry the session header, and each is
  // tied to its own one-time state instead.
  const NAVIGATION = /^\/api\/(oauth\/callback|connect\/[a-z0-9-]+\/done\/|connect\/github\/(created|installed|form\/))/;

  // who is calling: a session cookie (browser) or a bearer token (CLI, MCP, CI)
  http.use('/api/*', async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const cookie = getCookie(c, COOKIE);
    // CSRF: a browser's change must come from Unit7's own page, signed in or not (a website must not be able to
    // sign up first on a new install, or burn the login rate limit). Programs send no Origin and no Sec-Fetch-Site.
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      const selves = [new URL(c.req.url).origin, ...(process.env.UNIT7_URL ? [new URL(process.env.UNIT7_URL).origin] : [])];
      if ((origin !== undefined && !selves.includes(origin)) || (site !== undefined && site !== 'same-origin' && site !== 'none') || (cookie && origin === undefined && site !== 'same-origin')) {
        return c.json({ error: { code: 'bad_origin', message: 'Cross-site request refused.' } }, 403);
      }
    }
    if (bearer) {
      const p = auth.fromToken(db, bearer);
      if (!p) return c.json({ error: { code: 'bad_token', message: 'That API token is invalid, revoked or expired.' } }, 401);
      // a key limited to some tools reaches those tools and nothing else: every other route speaks for the whole account
      if (p.only && c.req.path !== '/api/tools' && !(c.req.method === 'POST' && /^\/api\/tools\/[^/]+$/.test(c.req.path))) return c.json({ error: { code: 'forbidden', message: 'This key can only use its own tools.' } }, 403);
      c.set('principal', p);
    } else if (cookie) {
      const p = auth.fromSession(db, cookie);
      const tag = c.req.header('x-unit7-bind') ?? (c.req.path === '/api/stream' ? c.req.query('bind') : undefined);
      const want = Buffer.from(app.vault.bindTag(cookie));
      const bound = !!tag && Buffer.byteLength(tag) === want.length && timingSafeEqual(Buffer.from(tag), want);
      // a cookie without its header came from somewhere other than Unit7's own page: treat it as signed out
      if (p && (bound || (c.req.method === 'GET' && NAVIGATION.test(c.req.path)))) c.set('principal', p);
    }
    await next();
  });

  const me = (c: Context<Env>) => {
    const p = c.get('principal');
    if (!p) throw new Unit7Error('signed_out', 'Sign in first.', 401);
    return p;
  };
  // Who can sign in and who is in the team is changed by a person in the web app, never with an API token:
  // a token (an AI's included) that could add a passkey or change members could make itself a person.
  const person = (c: Context) => {
    const p = me(c);
    if (p.via !== 'session') throw forbidden('Do this in the web app, signed in. API tokens can’t change sign-ins or members.');
    return p;
  };
  const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
    const raw = await c.req.json().catch(() => {
      throw new Unit7Error('bad_json', 'The request body must be JSON.');
    });
    const r = schema.safeParse(raw);
    if (!r.success) throw new Unit7Error('invalid_input', z.prettifyError(r.error));
    return r.data;
  };
  const startSession = (c: Context, userId: string) => {
    const token = auth.createSession(db, userId, { ip: ip(c), userAgent: c.req.header('user-agent') });
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:' || process.env.UNIT7_URL?.startsWith('https:'), path: '/', maxAge: 14 * 86400 });
    c.header('x-unit7-bind', app.vault.bindTag(token)); // the web app keeps this and sends it back (see the auth middleware)
  };
  const authAudit = (p: { orgId: string; userId: string; name: string }, tool: string, result = 'success', detail?: object) =>
    run(db, `INSERT INTO audit (id, org_id, actor_kind, actor_id, actor_name, user_id, tool, action, risk, input, result) VALUES (?, ?, 'user', ?, ?, ?, ?, 'auth', 'write', ?, ?)`,
      `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, p.orgId, p.userId, p.name, p.userId, tool, JSON.stringify(detail ?? {}), result);

  http.get('/api/health', (c) => c.json({ ok: true, version: '0.1.0' }));
  // a README badge: an unguessable address, and an empty picture the moment it stops being true (ops/report.ts)
  http.get('/badge/:file', async (c) => { const { badgeOf } = await import('../ops/report.ts'); return c.body(badgeOf(db, c.req.param('file').replace(/\.svg$/, '')), 200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' }); });

  // --- upload a source folder (for `unit7 deploy`); stored under UNIT7_HOME/uploads ---
  http.post('/api/uploads', async (c) => {
    const p = me(c);
    if (!['owner', 'admin', 'developer', 'agent'].includes(p.role)) throw forbidden('Your role cannot upload code.');
    rateLimit(`upload:${p.org.id}`, 60);
    const { randomBytes, createHash } = await import('node:crypto');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length) throw new Unit7Error('empty_upload', 'The upload was empty.');
    if (buf.length > 100 * 1024 * 1024) throw new Unit7Error('too_large', 'Uploads are capped at 100 MB.', 413);
    const uploadId = `upl_${randomBytes(9).toString('base64url')}`;
    const dir = join(app.home, 'uploads'); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${uploadId}.tgz`);
    writeFileSync(path, buf, { mode: 0o600 });
    run(db, 'INSERT INTO uploads (id, org_id, path, size, sha256, created_by) VALUES (?, ?, ?, ?, ?, ?)', uploadId, p.org.id, path, buf.length, createHash('sha256').update(buf).digest('hex'), p.user.id);
    return c.json({ uploadId, size: buf.length });
  });

  // --- MCP endpoint for external AI agents (Claude Code, Cursor). Bearer token only. ---
  http.post('/mcp', async (c) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const p = bearer ? auth.fromToken(db, bearer) : undefined;
    if (!p) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unit7 MCP needs a Bearer token. Create one in Settings → API tokens (role: agent).' } }, 401);
    rateLimit(`mcp:${p.org.id}`, 600);
    const msg = await c.req.json().catch(() => null);
    if (!msg) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    if (Array.isArray(msg) && msg.length > 20) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'At most 20 requests per batch.' } }, 400);
    // each call in a batch spends from the same budget as a single call, one after another
    const handle = async (m: any) => { if (m !== msg) rateLimit(`mcp:${p.org.id}`, 600); return (await handleMcp(app, p, m)) ?? null; };
    const out = Array.isArray(msg) ? await (async () => { const r = []; for (const m of msg) r.push(await handle(m)); return r.filter(Boolean); })() : await handle(msg);
    return out == null ? c.body(null, 202) : c.json(out);
  });

  // --- account & session ---
  http.get('/api/setup', (c) => c.json({ needsSetup: !get(db, 'SELECT 1 FROM users LIMIT 1'), openSignup: process.env.UNIT7_OPEN_SIGNUP === '1' }));

  http.post('/api/auth/signup', async (c) => {
    rateLimit(`signup:${ip(c)}`, 5);
    const i = await body(c, z.object({ email: z.email().max(200), name: z.string().trim().min(1).max(80), password: z.string(), orgName: z.string().trim().max(80).optional() }));
    // Self-hosted: the first person sets Unit7 up. After that, people join by invite unless open signup is on.
    if (get(db, 'SELECT 1 FROM users LIMIT 1') && process.env.UNIT7_OPEN_SIGNUP !== '1') throw forbidden('This Unit7 is already set up. Ask an admin for an invite.');
    const { userId, orgId } = await auth.signup(db, i);
    startSession(c, userId);
    authAudit({ orgId, userId, name: i.name }, 'auth.signup');
    return c.json({ ok: true });
  });

  http.post('/api/auth/login', async (c) => {
    const i = await body(c, z.object({ email: z.string().max(200), password: z.string().max(200) }));
    rateLimit(`login:${ip(c)}`, 10);
    rateLimit(`login:${i.email.toLowerCase()}`, 10);
    const userId = await auth.login(db, i.email, i.password);
    startSession(c, userId);
    return c.json({ ok: true });
  });

  http.post('/api/auth/logout', (c) => {
    const t = getCookie(c, COOKIE);
    if (t) auth.endSession(db, t);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  http.get('/api/me', (c) => {
    const p = me(c);
    return c.json({
      user: p.user, org: p.org, role: p.role, via: p.via,
      orgs: all(db, 'SELECT o.id, o.name, o.slug, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name', p.user.id),
      passkeys: all(db, 'SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ?', p.user.id),
    });
  });

  http.post('/api/auth/switch-org', async (c) => {
    const p = me(c);
    if (p.via !== 'session') throw forbidden('Tokens belong to one organization.');
    const { orgId } = await body(c, z.object({ orgId: z.string() }));
    auth.switchOrg(db, p.sessionId!, p.user.id, orgId);
    return c.json({ ok: true });
  });

  http.post('/api/orgs', async (c) => {
    const p = me(c);
    if (p.via !== 'session') throw forbidden('Create organizations from the web app.');
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
    const orgId = `org_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'org'}-${orgId.slice(-4).toLowerCase()}`;
    run(db, 'INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)', orgId, name, slug);
    run(db, 'INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?)', orgId, p.user.id, 'owner');
    auth.switchOrg(db, p.sessionId!, p.user.id, orgId);
    return c.json({ orgId });
  });

  // passkeys
  http.post('/api/auth/passkey/register/options', async (c) => c.json(await auth.passkeyRegisterOptions(db, rpOf(c), person(c).user)));
  http.post('/api/auth/passkey/register/verify', async (c) => {
    const p = person(c);
    const i = await body(c, z.object({ response: z.any(), name: z.string().max(60).optional() }));
    const r = await auth.passkeyRegisterVerify(db, rpOf(c), p.user, i.response, i.name);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'auth.passkey_added');
    return c.json(r);
  });
  http.post('/api/auth/passkey/login/options', async (c) => {
    rateLimit(`passkey:${ip(c)}`, 20);
    return c.json(await auth.passkeyLoginOptions(rpOf(c)));
  });
  http.post('/api/auth/passkey/login/verify', async (c) => {
    rateLimit(`passkey:${ip(c)}`, 20);
    const i = await body(c, z.object({ key: z.string(), response: z.any() }));
    startSession(c, await auth.passkeyLoginVerify(db, rpOf(c), i.key, i.response));
    return c.json({ ok: true });
  });
  http.delete('/api/auth/passkey/:id', (c) => {
    const p = person(c);
    run(db, 'DELETE FROM passkeys WHERE id = ? AND user_id = ?', c.req.param('id'), p.user.id);
    return c.json({ ok: true });
  });

  // API tokens
  http.get('/api/tokens', (c) => {
    const p = me(c);
    return c.json(auth.listTokens(db, p.org.id, p.user.id));
  });
  http.post('/api/tokens', async (c) => {
    const p = me(c);
    if (p.via !== 'session') throw forbidden('Create tokens from the web app or `unit7 login`.');
    const i = await body(c, z.object({ name: z.string().trim().min(1).max(60), role: z.enum(ROLES as [Role, ...Role[]]).default('agent'), expiresDays: z.number().int().min(1).max(3650).optional() }));
    const t = auth.createToken(db, p, i.name, i.role, i.expiresDays);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'auth.token_created', 'success', { name: i.name, role: i.role });
    return c.json(t);
  });
  http.delete('/api/tokens/:id', (c) => {
    const p = me(c);
    if (!auth.revokeToken(db, p.org.id, p.user.id, c.req.param('id'))) throw new Unit7Error('not_found', 'That token was not found.', 404);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'auth.token_revoked');
    return c.json({ ok: true });
  });

  // members & invites
  http.get('/api/members', (c) => {
    const p = me(c);
    return c.json({
      members: all(db, 'SELECT u.id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name', p.org.id),
      invites: isAdmin(p.role) ? all(db, 'SELECT id, email, role, expires_at, created_at FROM invites WHERE org_id = ? AND accepted_at IS NULL ORDER BY created_at DESC', p.org.id) : [],
    });
  });
  http.post('/api/invites', async (c) => {
    const p = person(c);
    const i = await body(c, z.object({ email: z.email(), role: z.enum(ROLES as [Role, ...Role[]]) }));
    const token = auth.createInvite(db, p, i.email, i.role);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'auth.invite', 'success', { email: i.email, role: i.role });
    return c.json({ link: `${rpOf(c).origin}/invite/${token}` });
  });
  http.post('/api/invites/accept', async (c) => {
    rateLimit(`invite:${ip(c)}`, 10);
    const i = await body(c, z.object({ token: z.string(), name: z.string().trim().max(80).optional(), password: z.string().optional() }));
    const p = c.get('principal');
    if (p && p.via !== 'session') throw forbidden('Open the invite link in the web app.');
    const { userId } = await auth.acceptInvite(db, i.token, { name: i.name, password: i.password, userId: p?.user.id });
    if (!p) startSession(c, userId);
    return c.json({ ok: true });
  });
  http.patch('/api/members/:userId', async (c) => {
    const p = person(c);
    const { role } = await body(c, z.object({ role: z.enum(ROLES as [Role, ...Role[]]) }));
    const target = get<{ role: Role }>(db, 'SELECT role FROM memberships WHERE org_id = ? AND user_id = ?', p.org.id, c.req.param('userId'));
    if (!target) throw new Unit7Error('not_found', 'That member was not found.', 404);
    if (!isAdmin(p.role) || !canGrant(p.role, role) || !canGrant(p.role, target.role)) throw forbidden('You cannot set that role.');
    if (target.role === 'owner' && role !== 'owner' && get<{ n: number }>(db, `SELECT count(*) n FROM memberships WHERE org_id = ? AND role = 'owner'`, p.org.id)!.n < 2) {
      throw forbidden('An organization needs at least one owner.');
    }
    run(db, 'UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?', role, p.org.id, c.req.param('userId'));
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'auth.role_changed', 'success', { member: c.req.param('userId'), role });
    return c.json({ ok: true });
  });
  http.delete('/api/members/:userId', (c) => {
    const p = person(c);
    const target = get<{ role: Role }>(db, 'SELECT role FROM memberships WHERE org_id = ? AND user_id = ?', p.org.id, c.req.param('userId'));
    if (!target) throw new Unit7Error('not_found', 'That member was not found.', 404);
    const self = c.req.param('userId') === p.user.id;
    if (!self && (!isAdmin(p.role) || !canGrant(p.role, target.role))) throw forbidden('You cannot remove that member.');
    if (target.role === 'owner' && get<{ n: number }>(db, `SELECT count(*) n FROM memberships WHERE org_id = ? AND role = 'owner'`, p.org.id)!.n < 2) {
      throw forbidden('An organization needs at least one owner.');
    }
    run(db, 'DELETE FROM memberships WHERE org_id = ? AND user_id = ?', p.org.id, c.req.param('userId'));
    run(db, 'DELETE FROM sessions WHERE user_id = ? AND org_id = ?', c.req.param('userId'), p.org.id);
    run(db, 'DELETE FROM api_tokens WHERE user_id = ? AND org_id = ?', c.req.param('userId'), p.org.id);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'auth.member_removed', 'success', { member: c.req.param('userId') });
    return c.json({ ok: true });
  });

  // --- tools: the one write path ---
  http.get('/api/tools', (c) => {
    const { only } = me(c);
    return c.json(tools().filter((t) => !only || only.includes(t.name)).map((t) => ({
      name: t.name, title: t.title, description: t.description, risk: typeof t.risk === 'string' ? t.risk : 'varies',
      action: typeof t.action === 'string' ? t.action : 'varies', input: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }),
    })));
  });

  http.post('/api/tools/:name', async (c) => {
    const p = me(c);
    rateLimit(`tools:${p.org.id}`, 600);
    const i = await body(c, z.object({ input: z.unknown().optional(), dryRun: z.boolean().optional(), reason: z.string().max(500).optional() }));
    const r = await execute(app, p.org.id, auth.actorOf(p), c.req.param('name'), i.input ?? {}, { dryRun: i.dryRun, reason: i.reason, signal: c.req.raw.signal });
    const status = r.status === 'approval_required' ? 202 : r.status === 'denied' ? 403
      : r.status === 'error' ? (r.error.code === 'not_found' || r.error.code === 'unknown_tool' ? 404 : r.error.code === 'forbidden' ? 403 : r.error.code === 'internal' ? 500 : 400) : 200;
    return c.json(r, status);
  });

  // --- approvals ---
  http.get('/api/approvals', (c) => {
    const p = me(c);
    return c.json(all(db, `SELECT a.id, a.tool, a.input, a.reason, a.why, a.actor, a.status, a.decided_by, a.decided_at, a.result, a.expires_at, a.created_at,
      e.name environment FROM approvals a LEFT JOIN environments e ON e.id = a.environment_id WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT 100`, p.org.id)
      .map((a: any) => ({ ...a, input: viewInput(a.input), actor: json(a.actor, {}), names: namesIn(db, p.org.id, a.input), ...(a.status === 'pending' && hardToUndo(db, p.org.id, a)) })));
  });
  http.post('/api/approvals/:id/:decision{approve|reject}', async (c) => {
    const p = person(c);
    const body = await c.req.json().catch(() => ({})) as { confirm?: unknown };
    const r = await decideApproval(app, p.org.id, auth.actorOf(p), c.req.param('id'), c.req.param('decision') === 'approve', typeof body.confirm === 'string' ? body.confirm : undefined);
    return c.json(r);
  });

  // --- AI agents on this computer: one-click connect ---
  // Only when Unit7 runs on the user's own machine (bound to loopback) and the browser is on that
  // machine too: these buttons edit config files of apps installed on the computer Unit7 runs on.
  const local = (c: Context) => {
    const bind = (app.services.listen as { host?: string } | undefined)?.host ?? '127.0.0.1';
    const from = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? '';
    return ['127.0.0.1', 'localhost', '::1'].includes(bind) && /^(127\.|::1$|::ffff:127\.)/.test(from || '127.0.0.1');
  };
  const unit7Url = () => process.env.UNIT7_URL ?? `http://127.0.0.1:${(app.services.listen as { port?: number } | undefined)?.port ?? 4800}`;
  http.get('/api/agents', (c) => {
    me(c);
    if (!local(c)) return c.json({ local: false, agents: [], hint: 'Run `unit7 connect` on the computer where your AI agents are.' });
    return c.json({ local: true, agents: agentList() });
  });
  http.post('/api/agents/:id/:action{connect|disconnect}', (c) => {
    const p = me(c);
    if (p.via !== 'session') throw forbidden('Connect agents from the web app, not with a token.');
    if (!isAdmin(p.role)) throw forbidden('Only owners and admins can connect AI agents.');
    if (!local(c)) throw forbidden('One-click connect works when Unit7 runs on this computer. Otherwise run `unit7 connect` there.');
    const r = c.req.param('action') === 'connect' ? connectAgent(db, p, c.req.param('id'), unit7Url()) : disconnectAgent(db, p, c.req.param('id'));
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, `agent.${c.req.param('action')}`, r.status === 'failed' ? 'error' : 'success', { agent: r.client, status: r.status });
    if (r.status === 'failed') throw new Unit7Error('connect_failed', `${r.client}: ${r.note ?? 'failed'}`, 500);
    app.events.emit(p.org.id, `agent.${c.req.param('action')}ed`, `${r.client} ${c.req.param('action') === 'connect' ? 'can now use Unit7' : 'no longer uses Unit7'}`, { severity: 'success' });
    return c.json({ ...r, agents: agentList() });
  });

  // --- Connections: one click per provider (connectors/oneclick.ts) ---
  const ollamaUp = () => fetch((process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/v1$/, '/api/tags'), { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false);
  const connector = (c: Context) => {
    const p = me(c);
    if (p.via !== 'session' || !isAdmin(p.role)) throw forbidden('Only owners and admins connect provider accounts.');
    return p;
  };
  const origin = (c: Context) => process.env.UNIT7_URL ?? new URL(c.req.url).origin;
  const done = (c: Context, q: Record<string, string>) => c.redirect(`/connections?${new URLSearchParams(q)}`);
  // asking this Mac's CLIs and Ollama takes seconds: a minute-old answer is fine for the tiles (a failed look isn't kept)
  let probed: { at: number; v: Promise<[boolean, boolean, Awaited<ReturnType<typeof cloudClis>>]> } | null = null;
  const probes = () => {
    if (!probed || Date.now() - probed.at > 60_000) {
      const v = Promise.all([ollamaUp(), githubCliReady(), cloudClis()]);
      probed = { at: Date.now(), v };
      v.catch(() => { if (probed?.v === v) probed = null; });
    }
    return probed.v;
  };
  http.get('/api/connections', async (c) => {
    const p = me(c);
    const here = local(c);
    const [ollama, ghCli, clis] = here ? await probes() : [false, false, {}];
    return c.json(connections(app, p.org.id, { ollama, ghCli, clis }));
  });
  // phone alerts in one click (a private ntfy channel), and a test for every alert channel
  http.post('/api/connect/ntfy/setup', async (c) => { const p = connector(c); return c.json(setupNtfy(app, p.org.id, p.user.id)); });
  http.post('/api/alerts/test', async (c) => { const p = connector(c); return c.json({ sent: await testAlerts(app, p.org.id) }); });
  // GitHub with zero browser steps: reuse this Mac's GitHub CLI sign-in (only when Unit7 runs here)
  http.post('/api/connect/github/cli', async (c) => {
    const p = connector(c);
    if (!local(c)) throw forbidden('This only works when Unit7 runs on your own computer.');
    const r = await connectGithubCli(app, p.org.id);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'account.github_cli_connected', 'success', { account: r.name });
    return c.json(r);
  });
  // Google Cloud, Firebase, AWS and Azure the same way: their own CLI's sign-in on this Mac (connectors/cloudcli.ts)
  http.post('/api/connect/:provider/cli', async (c) => {
    const p = connector(c);
    if (!local(c)) throw forbidden('This only works when Unit7 runs on your own computer.');
    const r = await connectCloudCli(app, p.org.id, c.req.param('provider'));
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'account.cli_connected', 'success', { account: r.name });
    return c.json(r);
  });
  // which of those sign-ins to use (several Google accounts in gcloud, several AWS profiles…), one picked by name, and
  // "Sign in with another Google account" (gcloud's own browser sign-in on this Mac; waits for it)
  const cliHere = (c: Context) => { const p = connector(c); if (!local(c)) throw forbidden('This only works when Unit7 runs on your own computer.'); return p; };
  http.get('/api/connect/:provider/signins', async (c) => c.json(await cliSignIns(app, cliHere(c).org.id, c.req.param('provider'))));
  http.post('/api/connect/:provider/signin', async (c) => {
    const p = cliHere(c);
    const i = await body(c, z.object({ account: z.string().trim().min(1).max(320) }));
    const r = await connectCloudCli(app, p.org.id, c.req.param('provider'), i.account);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'account.cli_connected', 'success', { account: r.name });
    return c.json(r);
  });
  http.post('/api/connect/:provider/login', async (c) => {
    const p = cliHere(c);
    const r = await addCliSignIn(app, p.org.id, c.req.param('provider'));
    if (r.added) authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'account.cli_connected', 'success', { account: r.added.name });
    return c.json(r);
  });
  http.get('/api/connect/:provider/start', async (c) => {
    const p = connector(c);
    return c.json({ url: await startConnect(app, { providerId: c.req.param('provider'), orgId: p.org.id, userId: p.user.id, origin: origin(c) }) });
  });
  // a pasted key: stored, verified, named automatically
  http.post('/api/connect/:provider/key', async (c) => {
    const p = connector(c);
    const prov = catalogProvider(c.req.param('provider'));
    if (!prov) throw new Unit7Error('unknown_provider', 'Unit7 doesn’t know that provider.', 404);
    const i = await body(c, z.object({ token: z.string().trim().min(8).max(20_000) }));
    const r = await execute(app, p.org.id, auth.actorOf(p), 'account.connect', { provider: prov.id, token: i.token }, { reason: 'connections' });
    if (r.status !== 'ok') throw new Unit7Error(r.status === 'error' ? r.error.code : r.status, r.status === 'error' ? r.error.message : 'That key could not be saved.', 400);
    return c.json(r.output);
  });
  const signedIn = async (c: Context, what: () => Promise<string>): Promise<Response> => {
    const p = c.get('principal');
    if (c.req.query('error')) return done(c, { oauth_error: c.req.query('error_description') ?? c.req.query('error') ?? 'cancelled' });
    if (!p) return done(c, { oauth_error: 'Sign in to Unit7 first, then click Connect again.' });
    try {
      const name = await what();
      authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'account.oauth_connected', 'success', { account: name });
      return done(c, { connected: name });
    } catch (e) { return done(c, { oauth_error: (e as Error).message }); }
  };
  http.get('/api/oauth/callback', (c) => signedIn(c, async () => (await finishOAuth(app, c.req.query('state') ?? '', c.req.query('code') ?? '', c.get('principal')!.user.id)).name));
  http.get('/api/connect/openrouter/done/:state', (c) => signedIn(c, async () => (await finishOpenRouter(app, c.req.param('state'), c.req.query('code') ?? '', c.get('principal')!.user.id)).name));
  http.get('/api/connect/github/form/:state', (c) => {
    const p = connector(c);
    c.header('content-security-policy', `default-src 'none'; script-src '${MANIFEST_SCRIPT_HASH}'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'`);
    c.header('referrer-policy', 'no-referrer');
    return c.html(githubManifestPage(c.req.param('state'), p.user.id, origin(c)));
  });
  http.get('/api/connect/github/created', async (c) => {
    const p = c.get('principal');
    if (!p) return done(c, { oauth_error: 'Sign in to Unit7 first, then click Connect again.' });
    try { return c.redirect(await githubCreated(app, c.req.query('state') ?? '', c.req.query('code') ?? '', p.user.id)); }
    catch (e) { return done(c, { oauth_error: (e as Error).message }); }
  });
  http.get('/api/connect/github/installed', (c) => signedIn(c, async () => githubInstalled(app, c.req.query('state'), c.req.query('installation_id') ?? '', c.get('principal')!.user.id)));

  // what Warden suggests right now (one-click fixes, most urgent first)
  // Autopilot: the kill switch, each environment's level, and what Unit7 did on its own (with undo)
  http.get('/api/autopilot', (c) => c.json(autopilotView(db, me(c).org.id)));

  // what Unit7 remembers about a project (its profile from the code, facts the AI saved)
  http.get('/api/projects/:id/memory', (c) => {
    const p = me(c);
    return c.json(all(db, 'SELECT content, source, created_at FROM memories WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 50', p.org.id, c.req.param('id')));
  });
  http.get('/api/suggestions', (c) => {
    const p = me(c);
    const projectId = c.req.query('projectId');
    const project = projectId ? get<{ id: string; name: string }>(db, 'SELECT id, name FROM projects WHERE id = ? AND org_id = ?', projectId, p.org.id) : undefined;
    if (projectId && !project) throw new Unit7Error('not_found', 'That project was not found.', 404);
    // what a person hid ("This is fine", or for now) stays out; each in plain words (src/explain.ts)
    const items = visible(db, p.org.id, suggestions(app, p.org.id, { agents: local(c) ? agentList() : undefined, projectId: project?.id }), (x) => x.id);
    return c.json({ scope: project?.name ?? 'Everything', items: items.map((x) => ({ ...x, explain: explainSuggestion(x.id, x.text) })) });
  });

  // --- help + org settings ---
  http.get('/api/help', (c) => c.json(HELP));
  // the agent's model: status carries the live list of models from every connected source
  http.get('/api/org/settings', async (c) => { const p = me(c); const status = await agentStatus(app, p.org.id); return c.json({ agentModel: status.model, status }); });
  http.patch('/api/org/settings', async (c) => {
    const p = me(c);
    if (!isAdmin(p.role)) throw forbidden('Only owners and admins can change organization settings.');
    const i = await body(c, z.object({ agentModel: z.string().regex(/^[a-z]+:[A-Za-z0-9][\w.:/@-]{1,120}$/, 'a model like openrouter:google/gemini-3.8-flash').optional() }));
    if (i.agentModel) run(db, 'UPDATE orgs SET agent_model = ? WHERE id = ?', i.agentModel, p.org.id);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'org.agent_settings', 'success', i);
    const status = await agentStatus(app, p.org.id);
    return c.json({ agentModel: status.model, status });
  });

  // --- agent ---
  // which brain answers the command box: Unit7's own model, or your AI through the inbox
  http.get('/api/agent/status', async (c) => {
    const p = me(c);
    return c.json({ ...(await agentStatus(app, p.org.id)), bridge: { watching: watcherActive(app, p.org.id, p.user.id), pending: pendingCount(app, p.org.id, p.user.id) }, ...(await brainStatus(app, p)) });
  });
  // your own Claude subscription or Google account answers your ask box (null: back to the org's model)
  http.post('/api/agent/brain', async (c) => {
    const p = me(c);
    const { brain } = await body(c, z.object({ brain: z.enum(['claude']).nullable() }));
    await setBrain(app, p, brain, local(c));
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'agent.brain', 'success', { brain });
    return c.json({ ok: true, ...(await brainStatus(app, p)) });
  });
  http.get('/api/agent/conversations', (c) => c.json(listConversations(app, me(c).org.id, me(c).user.id)));
  http.get('/api/agent/conversations/:id', (c) => c.json(getConversation(app, me(c).org.id, c.req.param('id'), me(c).user.id)));
  http.post('/api/agent/conversations', async (c) => {
    const p = me(c);
    rateLimit(`agent:${p.org.id}`, 60);
    const { message, conversationId, context } = await body(c, z.object({ message: z.string().min(1).max(8000), conversationId: z.string().optional(), context: CONTEXT.optional() })); // context: what the chat is about (the @ chips)
    return c.json(await sendToAgent(app, p, message, conversationId, context));
  });
  http.post('/api/agent/conversations/:id/stop', (c) => {
    const p = me(c);
    getConversation(app, p.org.id, c.req.param('id'), p.user.id); // yours (or Warden's), or not found
    stopAgent(c.req.param('id'));
    return c.json({ ok: true });
  });
  // the AI's pickers in the chat (src/agent/asks.ts): the live options of a pick, and the person's answer. Only the
  // conversation's own person, in the web app (an AI's token can't answer its own question)
  const asked = (c: Context) => {
    const p = me(c);
    if (p.via !== 'session') throw forbidden('Answer in Unit7’s web app, signed in. An API token can’t answer the AI’s questions.');
    return p;
  };
  http.get('/api/agent/asks/:id/options', (c) => c.json(optionsFor(app, asked(c), c.req.param('id'))));
  http.post('/api/agent/asks/:id', async (c) => {
    const p = asked(c);
    rateLimit(`ask:${p.user.id}`, 120);
    return c.json(answerAsk(app, p, c.req.param('id'), await c.req.json().catch(() => null)));
  });
  // Install or sign in to Claude Code / Gemini CLI from the ask box (src/agent/brain-setup.ts): Unit7 opens Terminal on
  // this Mac with the official command, so a person in the web app, an owner or admin, Unit7 and the browser both here.
  // Anyone else gets the commands to run themselves.
  const setupPerson = (c: Context) => {
    const p = me(c);
    if (p.via !== 'session') throw forbidden('Set up Claude or Gemini in the web app, signed in. API tokens can’t.');
    if (!isAdmin(p.role)) throw forbidden('Only owners and admins can install or sign in to an AI on this computer.');
    if (!local(c)) throw forbidden('This works only when Unit7 runs on this computer. Copy the command and run it there.');
    return p;
  };
  http.get('/api/agent/setup', (c) => {
    const p = me(c);
    return c.json({ canOpen: process.platform === 'darwin' && p.via === 'session' && isAdmin(p.role) && local(c), commands: SETUP_COMMANDS });
  });
  http.post('/api/agent/setup', async (c) => {
    const p = setupPerson(c);
    rateLimit(`setup:${p.user.id}`, 10);
    const { cli, step } = await body(c, z.object({ cli: z.enum(['claude']), step: z.enum(['install', 'sign-in']) }));
    await openTerminal(terminalCommand(cli, step));
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, `agent.${step === 'install' ? 'install' : 'sign_in'}`, 'success', { cli });
    return c.json({ ok: true });
  });

  // --- incidents ---
  // Prometheus: bearer token or session, like everything else here
  http.get('/api/metrics', async (c) => { const { metricsText } = await import('../ops/index.ts'); return c.text(metricsText(db, me(c).org.id), 200, { 'content-type': 'text/plain; version=0.0.4' }); });
  http.get('/api/incidents', (c) => c.json(all(db, 'SELECT id, title, status, severity, trigger_event, root_cause, created_at, resolved_at FROM incidents WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', me(c).org.id)));

  // --- reads ---
  http.get('/api/graph', (c) => c.json(graph({ db, orgId: me(c).org.id }, c.req.query('projectId'))));

  http.get('/api/audit', (c) => {
    const p = me(c);
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const before = c.req.query('before') ?? '9999';
    return c.json(all(db, `SELECT id, actor_kind, actor_name, agent, tool, action, risk, reason, input, output, result, error, duration_ms, resources,
      project_id, environment_id, approval_id, created_at FROM audit WHERE org_id = ? AND created_at < ?
      AND (? IS NULL OR project_id = ?) AND (? IS NULL OR tool = ?) ORDER BY created_at DESC LIMIT ?`,
      p.org.id, before, c.req.query('projectId') ?? null, c.req.query('projectId') ?? null, c.req.query('tool') ?? null, c.req.query('tool') ?? null, limit));
  });

  http.get('/api/events', (c) => {
    const p = me(c);
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    return c.json(all(db, `SELECT id, type, severity, message, project_id, environment_id, resource, data, created_at FROM events
      WHERE org_id = ? AND (? IS NULL OR project_id = ?) ORDER BY created_at DESC LIMIT ?`,
      p.org.id, c.req.query('projectId') ?? null, c.req.query('projectId') ?? null, limit).map((e: any) => ({ ...e, data: json(e.data, {}), ...(EVENT_WORDS[e.type] && { explain: explainEvent(e.type, e.message) }) })));
  });

  // live events for this org
  http.get('/api/stream', (c) => {
    const p = me(c);
    return streamSSE(c, async (s) => {
      const queue: string[] = ['ping']; // a first byte at once, so a proxy in between passes the stream on straight away
      let wake: (() => void) | undefined;
      const off = app.events.on((e) => {
        if (e.org_id !== p.org.id) return;
        const conv = e.type.startsWith('agent.') ? (e.data as { conversationId?: string }).conversationId : undefined;
        if (conv && !get(db, `SELECT 1 FROM conversations WHERE id = ? AND (user_id = ? OR user_id = 'warden')`, conv, p.user.id)) return;
        queue.push(JSON.stringify(e));
        wake?.();
      });
      s.onAbort(() => { off(); wake?.(); });
      const beat = setInterval(() => { queue.push('ping'); wake?.(); }, 25_000);
      try {
        while (!s.aborted) {
          while (queue.length) {
            const m = queue.shift()!;
            await (m === 'ping' ? s.writeSSE({ event: 'ping', data: '' }) : s.writeSSE({ data: m }));
          }
          await new Promise<void>((r) => (wake = r));
        }
      } finally {
        clearInterval(beat);
        off();
      }
    });
  });

  // --- a project folder on this computer (New project → From a folder; src/connectors/folder.ts) ---
  // Opens a window on this Mac and reads (later packs and ships) a local folder, so: a person in the web app
  // (never a token or an AI), an owner or admin, and Unit7 and the browser both on this computer.
  const folderPerson = (c: Context) => {
    const p = me(c);
    if (p.via !== 'session') throw forbidden('Pick a folder in the web app, signed in. API tokens can’t.');
    if (!isAdmin(p.role)) throw forbidden('Only owners and admins can use a folder on this computer.');
    if (!local(c)) throw forbidden('This works only when Unit7 runs on this computer.');
    return p;
  };
  // no path: open the Mac's folder window; a typed path (other computers, or by hand): just check it
  http.post('/api/local/choose-folder', async (c) => {
    folderPerson(c);
    const { path } = await body(c, z.object({ path: z.string().trim().min(1).max(1024).optional() }));
    const picked = path ?? await chooseFolder();
    return c.json(picked ? inspectFolder(picked, app.home) : { cancelled: true });
  });
  // remember an app's folder: a person's Deploy then packs it fresh, like `unit7 deploy`
  http.post('/api/local/link-folder', async (c) => {
    const p = folderPerson(c);
    const i = await body(c, z.object({ serviceId: z.string().regex(/^svc_[\w-]{12}$/), path: z.string().trim().min(1).max(1024) }));
    const f = inspectFolder(i.path, app.home);
    const r = run(db, `UPDATE services SET config = json_set(config, '$.folder', ?) WHERE id = ? AND org_id = ? AND kind IN ('app', 'worker')`, f.path, i.serviceId, p.org.id);
    if (!Number(r.changes)) throw new Unit7Error('not_found', 'That app was not found.', 404);
    authAudit({ orgId: p.org.id, userId: p.user.id, name: p.user.name }, 'service.folder_linked', 'success', { serviceId: i.serviceId, folder: f.path });
    return c.json(f);
  });

  http.notFound((c) => {
    if (!c.req.path.startsWith('/api/')) return c.text('Not found', 404);
    return c.json({ error: { code: 'not_found', message: `No API route ${c.req.method} ${c.req.path}.` } }, 404);
  });

  http.onError((e, c) => {
    if (e instanceof Unit7Error) return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
    console.error(e);
    return c.json({ error: { code: 'internal', message: 'Something went wrong inside Unit7. The error is in the server log.' } }, 500);
  });

  // --- the web app (built into dist/web) ---
  // Built files have unique names, so browsers keep them a year; the page itself is always re-checked
  // (and read fresh), so an update shows up on the next load, not after a hard refresh.
  if (existsSync(WEB)) {
    const page = (c: Context) => { c.header('cache-control', 'no-cache'); return c.html(readFileSync(`${WEB}/index.html`, 'utf8')); };
    http.use('/assets/*', serveStatic({ root: WEB, onFound: (_p, c) => { c.header('cache-control', 'public, max-age=31536000, immutable'); } }));
    http.get('/', page);
    http.use('*', serveStatic({ root: WEB, onFound: (_p, c) => { c.header('cache-control', 'no-cache'); } }));
    http.get('*', (c) => (c.req.path.startsWith('/api/') ? c.notFound() : page(c)));
  }

  return http;
}


// The names of the things an approval is about, so "Remove an app" can say "Remove preview-api", even after it was
// removed (then its name comes from the record of removing it).
function namesIn(db: DB, orgId: string, input: string): Record<string, string> {
  const i = json<Record<string, unknown>>(input, {}), out: Record<string, string> = {};
  for (const [k, table] of [['serviceId', 'services'], ['serverId', 'servers'], ['projectId', 'projects']] as const) {
    const v = i[k];
    if (typeof v !== 'string') continue;
    const name = get<{ name: string }>(db, `SELECT name FROM ${table} WHERE id = ? AND org_id = ?`, v, orgId)?.name
      ?? get<{ n: string | null }>(db, `SELECT json_extract(output, '$.removed') n FROM audit WHERE org_id = ? AND result = 'success' AND json_extract(input, '$.${k}') = ? AND json_extract(output, '$.removed') IS NOT NULL ORDER BY created_at DESC LIMIT 1`, orgId, v)?.n ?? undefined;
    if (name) out[v] = name;
  }
  return out;
}
