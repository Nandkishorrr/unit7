// People, organizations, sessions, API tokens and passkeys.
// Passwords: argon2id. Session cookies and API tokens: random 32 bytes, stored only as SHA-256.
import { argon2, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON, type WebAuthnCredential,
} from '@simplewebauthn/server';
import { type DB, all, get, id, now, run, tx } from './db.ts';
import { Unit7Error } from './errors.ts';
import { type Role, ROLES, canGrant } from './policy.ts';
import { SEVEN_TOOLS } from './seven/hands.ts';
import type { Actor } from './tools/runtime.ts';

const argon = promisify(argon2);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION_DAYS = 14;

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await argon('argon2id', { message: password, nonce: salt, parallelism: 1, tagLength: 32, memory: 19456, passes: 2 });
  return `argon2id$19456$2$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string | null) {
  // Hash something even for unknown users, so response time doesn't reveal which emails exist.
  const [alg, mem, passes, salt, hash] = (stored ?? 'argon2id$19456$2$AAAAAAAAAAAAAAAAAAAAAA==$AAAA').split('$');
  if (alg !== 'argon2id') return false;
  const got = await argon('argon2id', { message: password, nonce: Buffer.from(salt!, 'base64'), parallelism: 1, tagLength: 32, memory: +mem!, passes: +passes! });
  const want = Buffer.from(hash!, 'base64');
  return !!stored && got.length === want.length && timingSafeEqual(got, want);
}

export const validPassword = (p: string) => p.length >= 10 && p.length <= 200;

export interface Principal {
  user: { id: string; email: string; name: string };
  org: { id: string; name: string; slug: string };
  role: Role;
  via: 'session' | 'token';
  only?: readonly string[]; // a token that can reach these tools and nothing else
  sessionId?: string;
  tokenId?: string;
  tokenName?: string;
}

export function actorOf(p: Principal, agent?: string): Actor {
  // an agent working for someone who may only look can only look too
  if (agent) return { kind: 'agent', id: p.tokenId ?? p.user.id, userId: p.user.id, name: agent, role: p.role === 'readonly' || p.role === 'auditor' ? p.role : 'agent', agent, ...(p.only && { only: p.only }) };
  if (p.via === 'token') {
    return { kind: p.role === 'agent' ? 'agent' : 'token', id: p.tokenId!, userId: p.user.id, name: `${p.user.name} (token ${p.tokenName})`, role: p.role,
      agent: p.role === 'agent' ? p.tokenName : undefined, ...(p.only && { only: p.only }) };
  }
  return { kind: 'user', id: p.user.id, userId: p.user.id, name: p.user.name, role: p.role };
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

export async function signup(db: DB, i: { email: string; name: string; password: string; orgName?: string }) {
  if (!validPassword(i.password)) throw new Unit7Error('weak_password', 'Use a password of at least 10 characters.');
  if (get(db, 'SELECT 1 FROM users WHERE email = ?', i.email)) throw new Unit7Error('email_taken', 'That email already has an account. Sign in instead.', 409);
  const passwordHash = await hashPassword(i.password);
  return tx(db, () => {
    const userId = id('usr');
    const orgId = id('org');
    let slug = slugOf(i.orgName ?? i.name);
    while (get(db, 'SELECT 1 FROM orgs WHERE slug = ?', slug)) slug = `${slugOf(i.orgName ?? i.name)}-${randomBytes(2).toString('hex')}`;
    run(db, 'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)', userId, i.email, i.name, passwordHash);
    run(db, 'INSERT INTO orgs (id, name, slug) VALUES (?, ?, ?)', orgId, i.orgName ?? `${i.name}'s workspace`, slug);
    run(db, 'INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?)', orgId, userId, 'owner');
    return { userId, orgId };
  });
}

export async function login(db: DB, email: string, password: string) {
  const u = get<{ id: string; password_hash: string | null }>(db, 'SELECT id, password_hash FROM users WHERE email = ?', email);
  if (!(await verifyPassword(password, u?.password_hash ?? null)) || !u) throw new Unit7Error('bad_login', 'That email and password do not match.', 401);
  return u.id;
}

export function createSession(db: DB, userId: string, meta: { ip?: string; userAgent?: string; orgId?: string } = {}) {
  const orgId = meta.orgId ?? get<{ org_id: string }>(db, 'SELECT org_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1', userId)?.org_id;
  if (!orgId) throw new Unit7Error('no_org', 'This account is not in any organization.', 403);
  const token = randomBytes(32).toString('base64url');
  run(db, 'INSERT INTO sessions (id, user_id, org_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token), userId, orgId, new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null);
  return token;
}

export function endSession(db: DB, token: string) {
  run(db, 'DELETE FROM sessions WHERE id = ?', sha256(token));
}

const principalSql = `SELECT u.id uid, u.email, u.name uname, o.id oid, o.name oname, o.slug, m.role FROM users u
  JOIN memberships m ON m.user_id = u.id JOIN orgs o ON o.id = m.org_id WHERE u.id = ? AND o.id = ?`;
type PRow = { uid: string; email: string; uname: string; oid: string; oname: string; slug: string; role: Role };
const toPrincipal = (r: PRow, extra: Partial<Principal>): Principal => ({
  user: { id: r.uid, email: r.email, name: r.uname }, org: { id: r.oid, name: r.oname, slug: r.slug }, role: r.role, via: 'session', ...extra,
});

export function fromSession(db: DB, token: string): Principal | undefined {
  const s = get<{ id: string; user_id: string; org_id: string; expires_at: string }>(db, 'SELECT id, user_id, org_id, expires_at FROM sessions WHERE id = ?', sha256(token));
  if (!s || s.expires_at < now()) return undefined;
  const r = get<PRow>(db, principalSql, s.user_id, s.org_id);
  if (!r) return undefined; // removed from the org since
  // sliding expiry, refreshed at most daily
  if (new Date(s.expires_at).getTime() - Date.now() < (SESSION_DAYS - 1) * 86400_000) {
    run(db, 'UPDATE sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(), s.id);
  }
  return toPrincipal(r, { via: 'session', sessionId: s.id });
}

export function switchOrg(db: DB, sessionId: string, userId: string, orgId: string) {
  if (!get(db, 'SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ?', userId, orgId)) throw new Unit7Error('not_member', 'You are not a member of that organization.', 403);
  run(db, 'UPDATE sessions SET org_id = ? WHERE id = ?', orgId, sessionId);
}

// --- API tokens (CLI, MCP clients, CI) ---

// a coding agent reading log-derived text gets this much and no more: no server, no deploys, no settings
export const FINDINGS_ONLY = ['findings.list', 'finding.get', 'finding.check', 'finding.prompt', 'checkup.get', 'safety.status', 'expiry.list'] as const;
// small sets of tools for an MCP client that shouldn't see all of them (ops/index.ts lists them)
export const scopes: Record<string, readonly string[]> = { findings: FINDINGS_ONLY };
export function createToken(db: DB, p: Principal, name: string, role: Role, expiresDays?: number, scope?: string) {
  if (!ROLES.includes(role) || !canGrant(p.role, role)) throw new Unit7Error('bad_role', `You can't create a token with more power than your own role (${p.role}).`, 403);
  const token = `unit7_pat_${randomBytes(24).toString('base64url')}`;
  const tokenId = id('tok');
  run(db, 'INSERT INTO api_tokens (id, org_id, user_id, name, prefix, token_hash, role, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    tokenId, p.org.id, p.user.id, name, token.slice(0, 14), sha256(token), role,
    expiresDays ? new Date(Date.now() + expiresDays * 86400_000).toISOString() : null, scope ?? null);
  return { id: tokenId, token };
}

export function fromToken(db: DB, token: string): Principal | undefined {
  if (!/^(unit7|forge)_pat_/.test(token)) return undefined; // forge_pat_: keys made before the rename
  const t = get<{ id: string; org_id: string; user_id: string; name: string; role: Role; expires_at: string | null; scope: string | null }>(db,
    'SELECT id, org_id, user_id, name, role, expires_at, scope FROM api_tokens WHERE token_hash = ?', sha256(token));
  if (!t || (t.expires_at && t.expires_at < now())) return undefined;
  const r = get<PRow>(db, principalSql, t.user_id, t.org_id);
  if (!r) return undefined;
  run(db, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), t.id);
  // a token never outranks the person who made it, even if their role dropped later
  const role = canGrant(r.role, t.role) ? t.role : r.role;
  return { ...toPrincipal(r, { via: 'token', tokenId: t.id, tokenName: t.name, role }), ...(t.scope && { only: t.scope === 'seven' ? SEVEN_TOOLS : scopes[t.scope] ?? FINDINGS_ONLY }) };
}

export const listTokens = (db: DB, orgId: string, userId: string) =>
  all(db, 'SELECT id, name, prefix, role, expires_at, last_used_at, created_at FROM api_tokens WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC', orgId, userId);
export const revokeToken = (db: DB, orgId: string, userId: string, tokenId: string) =>
  run(db, 'DELETE FROM api_tokens WHERE id = ? AND org_id = ? AND user_id = ?', tokenId, orgId, userId).changes > 0;

// --- invites ---

export function createInvite(db: DB, p: Principal, email: string, role: Role) {
  if (!canGrant(p.role, role) || !['owner', 'admin'].includes(p.role)) throw new Unit7Error('bad_role', 'Only owners and admins can invite, and not above their own role.', 403);
  const token = randomBytes(24).toString('base64url');
  run(db, 'INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id('inv'), p.org.id, email, role, sha256(token), p.user.id, new Date(Date.now() + 7 * 86400_000).toISOString());
  return token;
}

export async function acceptInvite(db: DB, token: string, i: { name?: string; password?: string; userId?: string }) {
  const inv = get<{ id: string; org_id: string; email: string; role: Role; expires_at: string; accepted_at: string | null }>(db,
    'SELECT id, org_id, email, role, expires_at, accepted_at FROM invites WHERE token_hash = ?', sha256(token));
  if (!inv || inv.accepted_at || inv.expires_at < now()) throw new Unit7Error('bad_invite', 'This invite link is invalid or has expired.', 410);
  let userId = i.userId;
  if (!userId && get(db, 'SELECT 1 FROM users WHERE email = ?', inv.email)) {
    // the link alone must never sign anyone in as an existing account (an admin of any org could invite your email)
    throw new Unit7Error('sign_in_first', 'You already have a Unit7 account. Sign in first, then open this link again.', 401);
  }
  if (!userId) {
    if (!i.name || !i.password || !validPassword(i.password)) throw new Unit7Error('weak_password', 'Pick a name and a password of at least 10 characters.');
    userId = id('usr');
    run(db, 'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)', userId, inv.email, i.name, await hashPassword(i.password));
  }
  tx(db, () => {
    run(db, 'INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', inv.org_id, userId!, inv.role);
    run(db, 'UPDATE invites SET accepted_at = ? WHERE id = ?', now(), inv.id);
  });
  return { userId, orgId: inv.org_id };
}

// --- passkeys (WebAuthn) ---
// Challenges live in memory for 5 minutes: Unit7 is one process, and a restart just means "try again".
const challenges = new Map<string, { challenge: string; userId?: string; at: number }>();
const putChallenge = (key: string, challenge: string, userId?: string) => {
  for (const [k, v] of challenges) if (Date.now() - v.at > 300_000) challenges.delete(k);
  challenges.set(key, { challenge, userId, at: Date.now() });
};
const takeChallenge = (key: string) => {
  const c = challenges.get(key);
  challenges.delete(key);
  if (!c || Date.now() - c.at > 300_000) throw new Unit7Error('passkey_expired', 'That passkey prompt expired. Try again.', 400);
  return c;
};

export interface RP { id: string; name: string; origin: string }

export async function passkeyRegisterOptions(db: DB, rp: RP, user: Principal['user']) {
  const existing = all<{ id: string; transports: string | null }>(db, 'SELECT id, transports FROM passkeys WHERE user_id = ?', user.id);
  const opts = await generateRegistrationOptions({
    rpName: rp.name, rpID: rp.id, userName: user.email, userDisplayName: user.name, userID: new TextEncoder().encode(user.id),
    attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
  });
  putChallenge(`reg:${user.id}`, opts.challenge, user.id);
  return opts;
}

export async function passkeyRegisterVerify(db: DB, rp: RP, user: Principal['user'], response: RegistrationResponseJSON, name?: string) {
  const { challenge } = takeChallenge(`reg:${user.id}`);
  const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id });
  if (!v.verified) throw new Unit7Error('passkey_failed', 'The passkey could not be verified.', 400);
  const c = v.registrationInfo.credential;
  run(db, 'INSERT INTO passkeys (id, user_id, public_key, counter, transports, name) VALUES (?, ?, ?, ?, ?, ?)',
    c.id, user.id, c.publicKey, c.counter, JSON.stringify(c.transports ?? []), name ?? 'Passkey');
  return { id: c.id };
}

export async function passkeyLoginOptions(rp: RP) {
  const opts = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'preferred' });
  const key = randomBytes(16).toString('base64url');
  putChallenge(`auth:${key}`, opts.challenge);
  return { key, options: opts };
}

export async function passkeyLoginVerify(db: DB, rp: RP, key: string, response: AuthenticationResponseJSON) {
  const { challenge } = takeChallenge(`auth:${key}`);
  const pk = get<{ id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string | null }>(db,
    'SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?', response.id);
  if (!pk) throw new Unit7Error('passkey_unknown', 'That passkey is not registered with Unit7.', 401);
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id,
    credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) as WebAuthnCredential['transports'] : undefined },
  });
  if (!v.verified) throw new Unit7Error('passkey_failed', 'The passkey could not be verified.', 401);
  run(db, 'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', v.authenticationInfo.newCounter, now(), pk.id);
  return pk.user_id;
}
