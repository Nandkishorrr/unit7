// Projects, environments, provider accounts, the vault, project memory and the infrastructure
// graph — the model everything else hangs off.
import { z } from 'zod';
import { defineTool, type Ctx, type AccountRow } from './runtime.ts';
import { all, get, id, json, now, run, tx, type DB } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { DEFAULT_AUTONOMY, DEFAULT_RULES, type EnvKind } from '../policy.ts';
import { makeRef, isRef, parseRef } from '../vault.ts';
import { detectSecrets, looksRandom, looksSecretName } from '../redact.ts';
import { fid, isAgent, name, requireHuman, requireRole, uniqueSlug } from './helpers.ts';
import { CATALOG } from '../connectors/oneclick.ts';
import { accountName, closeOauthMcp } from '../connectors/mcp-oauth.ts';
import { hostinger } from '../connectors/hostinger.ts';
import { keptMarks } from '../kept.ts';
import { foundProjects } from './xray.ts';

export const PROVIDERS = ['ssh', 'smtp', 'generic', 'coolify', ...CATALOG.map((p) => p.id)] as [string, ...string[]];
const ENV_KINDS = ['development', 'staging', 'production', 'custom'] as const;
const ruleSchema = z.record(z.string().regex(/^[a-z_]+$/), z.enum(['allowed', 'restricted', 'prohibited']));

// --- projects ---------------------------------------------------------------------------------

defineTool({
  name: 'project.list', title: 'List projects', risk: 'read', action: 'read',
  description: 'All projects in the organization with their environments, then the projects server.xray found on servers (source says who runs each: coolify, compose or pm2, with an ast_ id). project.readiness, project.passport and client.assign take that id; they stay where they run, so change them with coolify.* and part.*. Start here to find ids.',
  input: z.object({}),
  run: (ctx) => [...all<{ id: string; name: string; slug: string; description: string | null; repo: string | null; created_at: string }>(ctx.db,
    'SELECT id, name, slug, description, repo, created_at FROM projects WHERE org_id = ? ORDER BY name', ctx.orgId)
    .map((p) => ({ ...p, environments: all(ctx.db, "SELECT id, name, slug, kind, autonomy FROM environments WHERE project_id = ? ORDER BY CASE kind WHEN 'development' THEN 0 WHEN 'staging' THEN 1 WHEN 'production' THEN 2 ELSE 3 END, created_at", p.id) })), ...foundProjects(ctx.db, ctx.orgId)],
});

defineTool({
  name: 'project.create', title: 'Create a project', risk: 'write', action: 'project_write',
  description: 'Create a project. By default it gets development, staging and production environments.',
  input: z.object({
    name, description: z.string().max(500).optional(), repo: z.string().max(300).optional(),
    environments: z.array(z.enum(ENV_KINDS)).default(['development', 'staging', 'production']),
  }),
  run(ctx, i) {
    const slug = uniqueSlug(ctx, 'SELECT 1 FROM projects WHERE org_id = ? AND slug = ?', i.name, ctx.orgId);
    const projectId = id('prj');
    tx(ctx.db, () => {
      run(ctx.db, 'INSERT INTO projects (id, org_id, name, slug, description, repo) VALUES (?, ?, ?, ?, ?, ?)',
        projectId, ctx.orgId, i.name, slug, i.description ?? null, i.repo ?? null);
      for (const kind of new Set(i.environments)) insertEnv(ctx, projectId, kind[0]!.toUpperCase() + kind.slice(1), kind);
    });
    ctx.resources.push(projectId);
    ctx.emit('project.created', `Created project ${i.name}`, { severity: 'success', resource: projectId });
    return { projectId, slug, environments: all(ctx.db, 'SELECT id, name, kind FROM environments WHERE project_id = ?', projectId) };
  },
});

defineTool({
  name: 'project.update', title: 'Update a project', risk: 'write', action: 'project_write',
  description: 'Rename a project or change its description or repository.',
  input: z.object({ projectId: fid('prj'), name: name.optional(), description: z.string().max(500).optional(), repo: z.string().max(300).optional() }),
  run(ctx, i) {
    run(ctx.db, 'UPDATE projects SET name = coalesce(?, name), description = coalesce(?, description), repo = coalesce(?, repo) WHERE id = ? AND org_id = ?',
      i.name ?? null, i.description ?? null, i.repo ?? null, i.projectId, ctx.orgId);
    return get(ctx.db, 'SELECT id, name, slug, description, repo FROM projects WHERE id = ?', i.projectId);
  },
});

defineTool({
  name: 'project.delete', title: 'Delete a project', risk: 'destructive', action: 'project_delete',
  description: "Delete a project from Unit7. Never while production runs something; otherwise refuses while it still has services: remove them first. Doesn't touch servers.",
  input: z.object({ projectId: fid('prj'), confirm: z.string().describe('the project slug, typed to confirm') }),
  run(ctx, i) {
    const p = get<{ slug: string; name: string }>(ctx.db, 'SELECT slug, name FROM projects WHERE id = ? AND org_id = ?', i.projectId, ctx.orgId)!;
    const prod = get<{ n: number }>(ctx.db, `SELECT count(*) n FROM services s JOIN environments e ON e.id = s.environment_id WHERE s.project_id = ? AND e.kind = 'production'`, i.projectId)!.n;
    // never a dead end: the guided delete (asset.delete, the Delete pop-up or the chat's Delete card) stops production first, then deletes
    if (prod) throw new Unit7Error('production_live', `Production is live, so ${p.name} can’t be deleted on its own. Delete it from the project’s page (or ask in the chat): Unit7 stops production first, then deletes everything, after you type its name. Or archive it instead.`, 409);
    if (i.confirm !== p.slug) throw new Unit7Error('confirm_mismatch', `Type the project slug "${p.slug}" to confirm.`);
    const n = get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM services WHERE project_id = ?', i.projectId)!.n;
    if (n) throw new Unit7Error('not_empty', `${p.name} still has ${n} service(s). Remove them first so nothing keeps running unmanaged.`, 409);
    run(ctx.db, 'DELETE FROM projects WHERE id = ? AND org_id = ?', i.projectId, ctx.orgId);
    return { deleted: p.slug };
  },
});

// --- environments -----------------------------------------------------------------------------

function insertEnv(ctx: Ctx, projectId: string, envName: string, kind: EnvKind) {
  const slug = uniqueSlug(ctx, 'SELECT 1 FROM environments WHERE project_id = ? AND slug = ?', envName, projectId);
  const envId = id('env');
  run(ctx.db, 'INSERT INTO environments (id, org_id, project_id, name, slug, kind, autonomy) VALUES (?, ?, ?, ?, ?, ?, ?)',
    // an AI can't make itself a fresh environment at full autopilot: what it creates starts at Safe actions
    envId, ctx.orgId, projectId, envName, slug, kind, isAgent(ctx) ? Math.min(2, DEFAULT_AUTONOMY[kind]) : DEFAULT_AUTONOMY[kind]);
  return envId;
}

defineTool({
  name: 'environment.create', title: 'Create an environment', risk: 'write', action: 'environment_write',
  description: 'Add an environment (e.g. "preview", "qa") to a project.',
  input: z.object({ projectId: fid('prj'), name, kind: z.enum(ENV_KINDS).default('custom') }),
  run(ctx, i) {
    const environmentId = insertEnv(ctx, i.projectId, i.name, i.kind);
    ctx.resources.push(environmentId);
    return get(ctx.db, 'SELECT id, name, slug, kind, autonomy FROM environments WHERE id = ?', environmentId);
  },
});

defineTool({
  name: 'environment.policy', title: 'Change autonomy and policy', risk: 'write', action: 'policy_change', peopleOnly: true,
  description: "Set an environment's autonomy level (0 observe … 4 autopilot) and per-action rules. People only.",
  input: z.object({ environmentId: fid('env'), autonomy: z.number().int().min(0).max(4).optional(), rules: ruleSchema.optional() }),
  run(ctx, i) {
    // An agent must never be able to raise its own autonomy.
    requireHuman(ctx, 'change autonomy or policy');
    requireRole(ctx, ['owner', 'admin'], 'change autonomy or policy');
    run(ctx.db, 'UPDATE environments SET autonomy = coalesce(?, autonomy), rules = coalesce(?, rules) WHERE id = ? AND org_id = ?',
      i.autonomy ?? null, i.rules ? JSON.stringify(i.rules) : null, i.environmentId, ctx.orgId);
    const e = get<{ name: string; kind: EnvKind; autonomy: number; rules: string }>(ctx.db, 'SELECT name, kind, autonomy, rules FROM environments WHERE id = ?', i.environmentId)!;
    ctx.emit('policy.changed', `${ctx.actor.name} set ${e.name} to autonomy ${e.autonomy}`, { severity: 'warning', resource: i.environmentId });
    return { ...e, rules: { ...DEFAULT_RULES[e.kind], ...json(e.rules, {}) } };
  },
});

defineTool({
  name: 'environment.get', title: 'Read an environment', risk: 'read', action: 'read',
  description: 'An environment with its autonomy level and effective rules (defaults merged with overrides).',
  input: z.object({ environmentId: fid('env') }),
  run(ctx, i) {
    const e = get<{ id: string; name: string; slug: string; kind: EnvKind; autonomy: number; rules: string; project_id: string }>(ctx.db,
      'SELECT id, name, slug, kind, autonomy, rules, project_id FROM environments WHERE id = ? AND org_id = ?', i.environmentId, ctx.orgId)!;
    return { ...e, rules: { ...DEFAULT_RULES[e.kind], ...json(e.rules, {}) }, overrides: json(e.rules, {}) };
  },
});

defineTool({
  name: 'environment.delete', title: 'Delete an environment', risk: 'destructive', action: 'environment_delete',
  description: 'Delete an environment that has no services left.',
  input: z.object({ environmentId: fid('env') }),
  run(ctx, i) {
    const n = get<{ n: number }>(ctx.db, 'SELECT count(*) n FROM services WHERE environment_id = ?', i.environmentId)!.n;
    if (n) throw new Unit7Error('not_empty', `This environment still has ${n} service(s). Remove them first.`, 409);
    run(ctx.db, 'DELETE FROM environments WHERE id = ? AND org_id = ?', i.environmentId, ctx.orgId);
    return { deleted: i.environmentId };
  },
});

// --- provider accounts (identities) -----------------------------------------------------------

// Providers register a check here (phase 5): it proves the credential works and returns facts.
export type Verifier = (ctx: Ctx, account: AccountRow, token: string) => Promise<Record<string, unknown>>;
export const verifiers: Partial<Record<string, Verifier>> = {};

defineTool({
  name: 'account.list', title: 'List connected accounts', risk: 'read', action: 'read',
  description: 'Provider identities (e.g. Cloudflare / Client A) and which environments use them. Never returns secrets.',
  input: z.object({ provider: z.string().optional() }),
  run: (ctx, i) => all<AccountRow & { verified_at: string | null }>(ctx.db,
    'SELECT id, provider, name, slug, status, verified_at, meta FROM accounts WHERE org_id = ? AND (? IS NULL OR provider = ?) ORDER BY provider, name',
    ctx.orgId, i.provider ?? null, i.provider ?? null)
    .map((a) => {
      const meta = json<Record<string, unknown>>(a.meta, {});
      return {
        ...a, meta: undefined, credential: meta.ref ?? `credential://${a.provider}/${a.slug}/token`, facts: meta.facts ?? {}, ...(typeof meta.serverId === 'string' && { serverId: meta.serverId }),
        environments: all(ctx.db, `SELECT e.id, e.name, p.name project FROM environment_accounts ea JOIN environments e ON e.id = ea.environment_id
          JOIN projects p ON p.id = e.project_id WHERE ea.account_id = ?`, a.id),
      };
    }),
});

defineTool({
  name: 'account.connect', title: 'Connect a provider account', risk: 'write', action: 'vault_write', sensitive: ['token'], peopleOnly: true,
  description: 'Connect an identity at a provider by storing its API token in the vault. People only. The name is automatic unless given.',
  input: z.object({ provider: z.enum(PROVIDERS), name: name.optional(), token: z.string().trim().min(8).max(20_000), meta: z.record(z.string(), z.string()).optional() }),
  async run(ctx, i) {
    requireHuman(ctx, 'paste a provider credential');
    const n = accountName(ctx.app, ctx.orgId, i.provider, i.name ?? CATALOG.find((p) => p.id === i.provider)?.name ?? i.provider[0]!.toUpperCase() + i.provider.slice(1));
    const ref = makeRef(i.provider, n.slug, 'token');
    const accountId = id('acc');
    tx(ctx.db, () => {
      run(ctx.db, 'INSERT INTO accounts (id, org_id, provider, name, slug, meta) VALUES (?, ?, ?, ?, ?, ?)',
        accountId, ctx.orgId, i.provider, n.name, n.slug, JSON.stringify({ ref, ...i.meta }));
      ctx.app.vault.put(ctx.orgId, ref, i.token, { kind: 'api_token', accountId, by: ctx.actor.name });
    });
    ctx.redactor.add(i.token, ref);
    ctx.resources.push(accountId);
    const verified = await verify(ctx, accountId);
    // many accounts at one provider: name each after whose it is ("Vercel · ada"), not "Vercel 7"
    const label = (verified as { facts?: { label?: string } }).facts?.label;
    if (label && !i.name) run(ctx.db, 'UPDATE accounts SET name = ? WHERE id = ?', accountName(ctx.app, ctx.orgId, i.provider, `${CATALOG.find((p) => p.id === i.provider)?.name ?? i.provider} · ${label}`).name, accountId);
    ctx.emit('account.connected', `${i.provider} account connected`, { severity: 'success', resource: accountId });
    return { accountId, credential: ref, ...verified };
  },
});

async function verify(ctx: Ctx, accountId: string) {
  const a = get<AccountRow>(ctx.db, 'SELECT * FROM accounts WHERE id = ?', accountId)!;
  const check = verifiers[a.provider];
  if (!check) return { status: 'unverified', note: `Unit7 has no live check for ${a.provider}; the credential is stored.` };
  try {
    const { value } = ctx.credentialFor(a.provider, accountId);
    const facts = await check(ctx, a, value);
    run(ctx.db, `UPDATE accounts SET status = 'verified', pause_until = NULL, verified_at = ?, meta = json_set(meta, '$.facts', json(?)) WHERE id = ?`,
      new Date().toISOString(), JSON.stringify(facts), accountId);
    return { status: 'verified', facts };
  } catch (e) {
    run(ctx.db, `UPDATE accounts SET status = 'failing' WHERE id = ?`, accountId);
    return { status: 'failing', problem: (e as Error).message };
  }
}

defineTool({
  name: 'account.verify', title: 'Check an account', risk: 'read', action: 'read',
  description: "Prove a connected account's credential still works (expired tokens show up here).",
  input: z.object({ accountId: fid('acc') }),
  run: (ctx, i) => verify(ctx, i.accountId),
});

defineTool({
  name: 'account.bind', title: 'Use an account in an environment', risk: 'write', action: 'environment_write', peopleOnly: true,
  description: 'Make an environment use this account for its provider. Each environment has exactly one account per provider.',
  input: z.object({ environmentId: fid('env'), accountId: fid('acc') }),
  run(ctx, i) {
    const a = get<AccountRow>(ctx.db, 'SELECT * FROM accounts WHERE id = ?', i.accountId)!;
    run(ctx.db, 'INSERT INTO environment_accounts (environment_id, provider, account_id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET account_id = excluded.account_id',
      i.environmentId, a.provider, i.accountId);
    return { environmentId: i.environmentId, provider: a.provider, account: a.name };
  },
});

defineTool({
  name: 'account.disconnect', title: 'Disconnect an account', risk: 'destructive', action: 'vault_delete', peopleOnly: true,
  description: 'Remove a provider account and retire its credentials. Environments using it lose access.',
  input: z.object({ accountId: fid('acc') }),
  run(ctx, i) {
    const a = get<AccountRow>(ctx.db, 'SELECT * FROM accounts WHERE id = ?', i.accountId)!;
    tx(ctx.db, () => {
      // gone for good (every version; secure_delete overwrites them): a disconnected account leaves nothing to steal
      run(ctx.db, 'DELETE FROM secrets WHERE org_id = ? AND ref LIKE ?', ctx.orgId, `credential://${a.provider}/${a.slug}/%`);
      run(ctx.db, 'DELETE FROM accounts WHERE id = ? AND org_id = ?', i.accountId, ctx.orgId);
    });
    closeOauthMcp(i.accountId);
    hostinger(ctx.app).closeAccount(i.accountId); // its MCP process holds the token in memory
    return { disconnected: a.name };
  },
});

// --- vault ------------------------------------------------------------------------------------
// Unit7's own keys (phone approvals, backup encryption, SSH, backup storage) are made and changed by Unit7 only:
// whoever could set one could approve from a "phone" or choose the backup key. A connected account's credential
// (and phone alerts, which carry approve buttons) is an owner's or admin's to change.
function guardRef(ctx: Ctx, ref: string) {
  const { provider, account } = parseRef(ref);
  const isAccount = !!get(ctx.db, 'SELECT 1 FROM accounts WHERE org_id = ? AND provider = ? AND slug = ?', ctx.orgId, provider, account);
  if (/^credential:\/\/(unit7|forge|ssh|storage)\//.test(ref)) throw new Unit7Error('forbidden', `${ref} is one of Unit7's own keys. Unit7 manages it.`, 403);
  if (isAccount || /^credential:\/\/ntfy\//.test(ref)) requireRole(ctx, ['owner', 'admin'], 'change a connected account\u2019s credential');
}
// Changing a credential is people-only: an AI that could rewrite one could point phone alerts (and the
// approve codes in them) or a provider token somewhere it controls.

defineTool({
  name: 'vault.list', title: 'List credentials', risk: 'read', action: 'read',
  description: 'Credential references and metadata (kind, version, last used, a masked hint). Values are never returned.',
  input: z.object({ prefix: z.string().startsWith('credential://').optional() }),
  run: (ctx, i) => ctx.app.vault.list(ctx.orgId, i.prefix).map((s) => ({ ...s, meta: json(s.meta, {}) })),
});

defineTool({
  name: 'vault.set', title: 'Store a credential', risk: 'write', action: 'vault_write', sensitive: ['value'], peopleOnly: true,
  description: 'Store or rotate a credential under a credential:// reference. Rotation keeps the old version restorable.',
  input: z.object({ ref: z.string().refine(isRef, 'must look like credential://provider/account/name'), value: z.string().min(1).max(100_000), kind: z.string().max(40).default('secret') }),
  run(ctx, i) {
    const { provider, account } = parseRef(i.ref);
    const acc = get<{ id: string }>(ctx.db, 'SELECT id FROM accounts WHERE org_id = ? AND provider = ? AND slug = ?', ctx.orgId, provider, account);
    guardRef(ctx, i.ref);
    ctx.redactor.add(i.value, i.ref);
    const r = ctx.app.vault.put(ctx.orgId, i.ref, i.value, { kind: i.kind, accountId: acc?.id ?? null, by: ctx.actor.name });
    ctx.emit(r.version > 1 ? 'credential.rotated' : 'credential.created', `${r.version > 1 ? 'Rotated' : 'Stored'} ${i.ref}`, { resource: i.ref });
    return r;
  },
});

defineTool({
  name: 'vault.history', title: 'Credential history', risk: 'read', action: 'read',
  description: 'Versions of a credential: when it was rotated and by whom.',
  input: z.object({ ref: z.string().refine(isRef) }),
  run: (ctx, i) => ctx.app.vault.history(ctx.orgId, i.ref),
});

defineTool({
  name: 'vault.restore', title: 'Restore a credential version', risk: 'write', action: 'vault_write', peopleOnly: true,
  description: 'Make an older version current again (undo a bad rotation).',
  input: z.object({ ref: z.string().refine(isRef), version: z.number().int().min(1) }),
  run: (ctx, i) => { guardRef(ctx, i.ref); return ctx.app.vault.restore(ctx.orgId, i.ref, i.version, ctx.actor.name); },
});

defineTool({
  name: 'vault.retire', title: 'Retire a credential', risk: 'destructive', action: 'vault_delete', peopleOnly: true,
  description: 'Stop a credential being used anywhere. Its history is kept.',
  input: z.object({ ref: z.string().refine(isRef) }),
  run(ctx, i) {
    guardRef(ctx, i.ref);
    ctx.app.vault.retire(ctx.orgId, i.ref);
    ctx.emit('credential.retired', `Retired ${i.ref}`, { severity: 'warning', resource: i.ref });
    return { retired: i.ref };
  },
});

// --- memory -----------------------------------------------------------------------------------

defineTool({
  name: 'memory.remember', title: 'Remember a fact', risk: 'write', action: 'memory',
  description: 'Save a durable fact about a project (a decision, a quirk, a preference). Infrastructure state already lives in the graph: do not duplicate it here.',
  input: z.object({ projectId: fid('prj').optional(), content: z.string().min(3).max(2000), about: z.string().max(200).optional().describe('A project found on a server, by name: known noise, things not to touch'), days: z.number().int().min(1).max(365).optional().describe('Forget it after this many days') }),
  run(ctx, i) {
    const pairs = [...i.content.matchAll(/\b([A-Za-z_][\w]*)\s*[=:]\s*(\S{6,})/g)].some(([, k, v]) => looksSecretName(k!) && !isRef(v!));
    if (detectSecrets(i.content).length || pairs || i.content.split(/\s+/).some(looksRandom) || /ntfy\.sh\/|\bpassword (is|:)/i.test(i.content)) throw new Unit7Error('secret_in_memory', 'That looks like it contains a secret. Store secrets in the Vault; memory is readable by every agent.', 400);
    const memId = id('mem');
    run(ctx.db, 'INSERT INTO memories (id, org_id, project_id, content, source, about, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', memId, ctx.orgId, i.projectId ?? null, i.content, ctx.actor.name, i.about ?? null, i.days ? new Date(Date.now() + i.days * 86400_000).toISOString() : null);
    return { remembered: i.content };
  },
});

defineTool({
  name: 'memory.recall', title: 'Recall project memory', risk: 'read', action: 'read',
  description: 'Facts saved about a project (or the whole organization).',
  input: z.object({ projectId: fid('prj').optional() }),
  run: (ctx, i) => all(ctx.db, 'SELECT id, content, source, about, expires_at, created_at FROM memories WHERE org_id = ? AND (project_id IS ? OR project_id IS NULL) AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 100',
    ctx.orgId, i.projectId ?? null, now()),
});

defineTool({
  name: 'memory.forget', title: 'Forget a fact', risk: 'write', action: 'memory',
  description: 'Remove a remembered fact that is no longer true.',
  input: z.object({ contains: z.string().min(3) }),
  run(ctx, i) {
    // an AI may only forget what an AI wrote; a person's notes are a person's to remove
    const r = isAgent(ctx)
      ? run(ctx.db, `DELETE FROM memories WHERE org_id = ? AND instr(content, ?) > 0 AND source = ?`, ctx.orgId, i.contains, ctx.actor.name)
      : run(ctx.db, `DELETE FROM memories WHERE org_id = ? AND instr(content, ?) > 0`, ctx.orgId, i.contains);
    return { forgotten: Number(r.changes) };
  },
});

// --- the infrastructure graph -----------------------------------------------------------------

defineTool({
  name: 'graph.get', title: 'Read the infrastructure graph', risk: 'read', action: 'read',
  description: 'The structured state of everything Unit7 manages: projects → environments → accounts, services (apps, workers, databases) on servers, their domains, current deployments and credential references. foundProjects are the Coolify, Docker Compose and PM2 projects server.xray found (an ast_ id; project.readiness, project.passport and client.assign take it, and they change through coolify.* and part.*). Query this before assuming anything.',
  input: z.object({ projectId: z.string().regex(/^(prj|ast)_[A-Za-z0-9_-]{12}$/, 'must be a prj_ or ast_ id').optional() }),
  run: (ctx, i) => graph(ctx, i.projectId),
});

export function graph(ctx: Pick<Ctx, 'db' | 'orgId'>, projectId?: string) {
  const { db, orgId } = ctx;
  const marks = keptMarks(db, orgId);
  const servers = all<{ id: string; name: string; host: string; status: string; facts: string; last_seen_at: string | null; provider_ref: string | null }>(db,
    'SELECT id, name, host, status, facts, last_seen_at, provider_ref FROM servers WHERE org_id = ? ORDER BY name', orgId)
    .map((s) => ({ ...s, facts: json(s.facts, {}), ...reachOf(db, s) }));
  const projects = all<{ id: string; name: string; slug: string; repo: string | null }>(db,
    'SELECT id, name, slug, repo FROM projects WHERE org_id = ? AND (? IS NULL OR id = ?) ORDER BY name', orgId, projectId ?? null, projectId ?? null)
    .map((p) => ({
      ...p,
      // the person said it's in use (asset.keep); important: take extra care, an AI asks before changing it in production
      ...(marks.has(p.id) && { kept: true, ...(marks.get(p.id)!.important && { important: true }) }),
      environments: all<{ id: string; name: string; slug: string; kind: string; autonomy: number }>(db,
        "SELECT id, name, slug, kind, autonomy FROM environments WHERE project_id = ? ORDER BY CASE kind WHEN 'development' THEN 0 WHEN 'staging' THEN 1 WHEN 'production' THEN 2 ELSE 3 END, created_at", p.id).map((e) => ({
        ...e,
        accounts: all(db, `SELECT a.id, a.provider, a.name, a.status FROM environment_accounts ea JOIN accounts a ON a.id = ea.account_id WHERE ea.environment_id = ?`, e.id),
        services: all<{ id: string; name: string; slug: string; kind: string; status: string; server_id: string | null; config: string; current_deployment_id: string | null }>(db,
          'SELECT id, name, slug, kind, status, server_id, config, current_deployment_id FROM services WHERE environment_id = ? ORDER BY kind, name', e.id).map((s) => ({
          ...s, config: publicConfig(json(s.config, {})),
          domains: all(db, 'SELECT id, hostname, status, tls FROM domains WHERE service_id = ?', s.id),
          deployment: s.current_deployment_id ? get(db, 'SELECT id, number, status, image, started_at, finished_at FROM deployments WHERE id = ?', s.current_deployment_id) : null,
        })),
      })),
    }));
  const accounts = all(db, 'SELECT id, provider, name, slug, status FROM accounts WHERE org_id = ? ORDER BY provider, name', orgId);
  const found = foundProjects(db, orgId).filter((p) => !projectId || p.id === projectId).map((p) => ({ ...p, ...(marks.has(p.id) && { kept: true, ...(marks.get(p.id)!.important && { important: true }) }) }));
  return { servers, projects, foundProjects: found, accounts };
}

// Whether a server answered the last time Unit7 looked (its last X-ray, or a sign-in since), and when it last did:
// one answer for every page that shows the server
function reachOf(db: DB, s: { id: string; last_seen_at: string | null }) {
  const tried = get<{ ok: number; created_at: string }>(db, `SELECT ok, created_at FROM xrays WHERE server_id = ? AND kind = 'fast' ORDER BY created_at DESC LIMIT 1`, s.id);
  if (!tried) return {};
  const good = tried.ok ? tried.created_at : get<{ created_at: string }>(db, `SELECT created_at FROM xrays WHERE server_id = ? AND kind = 'fast' AND ok = 1 ORDER BY created_at DESC LIMIT 1`, s.id)?.created_at;
  const lastGood = [good, s.last_seen_at].filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { reach: { ok: !!tried.ok || (!!lastGood && lastGood > tried.created_at), triedAt: tried.created_at, lastGood } };
}

// config can carry references but never values; strip anything that isn't plainly public
function publicConfig(c: Record<string, unknown>) {
  const { password: _p, ...rest } = c;
  return rest;
}

