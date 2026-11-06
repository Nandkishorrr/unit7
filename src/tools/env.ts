// The environment engine. Variables live at four levels and inherit downward:
//   organization → project → environment → service   (+ one-off overrides at deploy time)
// Every value is envelope-encrypted (or is a credential:// reference resolved at deploy). Each
// change is a new version, so "what was DATABASE_URL last Tuesday" has an answer.
import { z } from 'zod';
import { APP_KEY_REF, INTERNAL_REF, defineTool, peopleRef, type Ctx } from './runtime.ts';
import { type DB, all, get, id, json, now, run, tx } from '../db.ts';
import { Unit7Error, forbidden, notFound } from '../errors.ts';
import { detectSecrets, looksRandom, looksSecretName } from '../redact.ts';
import { envContext, isRef, parseRef, slugify } from '../vault.ts';
import { fid, isAgent, requireHuman, requireRole } from './helpers.ts';

type ScopeType = 'org' | 'project' | 'environment' | 'service';
interface Scope { type: ScopeType; id: string; label: string }

const scopeInput = {
  projectId: fid('prj').optional(), environmentId: fid('env').optional(), serviceId: fid('svc').optional(),
};
const KEY = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'letters, digits and _, not starting with a digit');
// Prefixes that frameworks inline into the browser bundle. A secret here is public.
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_|VUE_APP_)/;
export const isPublicKey = (k: string) => PUBLIC_PREFIX.test(k);

export { envContext };

function targetScope(ctx: Ctx, i: { projectId?: string; environmentId?: string; serviceId?: string }): Scope {
  if (i.serviceId) return { type: 'service', id: i.serviceId, label: get<{ name: string }>(ctx.db, 'SELECT name FROM services WHERE id = ?', i.serviceId)!.name };
  if (i.environmentId) return { type: 'environment', id: i.environmentId, label: get<{ name: string }>(ctx.db, 'SELECT name FROM environments WHERE id = ?', i.environmentId)!.name };
  if (i.projectId) return { type: 'project', id: i.projectId, label: get<{ name: string }>(ctx.db, 'SELECT name FROM projects WHERE id = ?', i.projectId)!.name };
  return { type: 'org', id: ctx.orgId, label: 'organization' };
}

// The chain a scope inherits from, most general first.
export function chain(db: DB, orgId: string, s: Scope): Scope[] {
  const out: Scope[] = [{ type: 'org', id: orgId, label: 'organization' }];
  let projectId: string | undefined, envId: string | undefined;
  if (s.type === 'service') {
    const r = get<{ project_id: string; environment_id: string }>(db, 'SELECT project_id, environment_id FROM services WHERE id = ?', s.id)!;
    projectId = r.project_id; envId = r.environment_id;
  } else if (s.type === 'environment') {
    projectId = get<{ project_id: string }>(db, 'SELECT project_id FROM environments WHERE id = ?', s.id)!.project_id; envId = s.id;
  } else if (s.type === 'project') projectId = s.id;
  if (projectId) out.push({ type: 'project', id: projectId, label: 'project' });
  if (envId) out.push({ type: 'environment', id: envId, label: 'environment' });
  if (s.type === 'service') {
    // a background worker sees its app's settings (database URL, secrets) unless it overrides them
    const parent = json<{ workerOf?: string }>(get<{ config: string }>(db, 'SELECT config FROM services WHERE id = ?', s.id)?.config ?? '{}', {}).workerOf;
    if (parent) out.push({ type: 'service', id: parent, label: 'app' });
    out.push(s);
  }
  return out;
}

interface VarRow { id: string; scope_type: string; scope_id: string; key: string; version: number; secret: number;
  ciphertext: Uint8Array | null; wrapped_key: Uint8Array | null; ref: string | null; hint: string; created_by: string | null; created_at: string }

const current = (db: DB, orgId: string, s: Pick<Scope, 'type' | 'id'>) => all<VarRow>(db,
  `SELECT v.* FROM env_vars v WHERE v.org_id = ? AND v.scope_type = ? AND v.scope_id = ? AND v.deleted_at IS NULL
   AND v.version = (SELECT max(version) FROM env_vars w WHERE w.scope_type = v.scope_type AND w.scope_id = v.scope_id AND w.key = v.key)
   ORDER BY v.key`, orgId, s.type, s.id);

// Merged view: each key once, from the most specific scope that sets it.
export function merged(db: DB, orgId: string, s: Scope) {
  const out = new Map<string, VarRow & { from: string; overrides?: string[] }>();
  // A pull request preview runs code nobody has merged yet: it never gets the project's or organisation's
  // secrets (a project-wide DATABASE_URL is production's). Its own environment's and its own settings apply.
  const preview = s.type === 'service' && !!json<{ previewOf?: string }>(get<{ config: string }>(db, 'SELECT config FROM services WHERE id = ?', s.id)?.config ?? '{}', {}).previewOf;
  for (const sc of chain(db, orgId, s)) {
    for (const r of current(db, orgId, sc)) {
      if (preview && r.secret && (sc.type === 'org' || sc.type === 'project')) continue;
      const prev = out.get(r.key);
      out.set(r.key, { ...r, from: sc.type, overrides: prev ? [...(prev.overrides ?? []), prev.from] : undefined });
    }
  }
  return [...out.values()];
}

// Which vault references an app may use. Unit7's own keys never go into an app, whoever asks. An AI may also only wire
// in what a person bound to the environment: a connected account bound to it explicitly (never "the only one there is"),
// or a database that lives in it. A key a person stored by hand has no place to check, so the gate asks them first.
export function checkRef(ctx: Ctx, s: Scope, ref: string) {
  if (INTERNAL_REF.test(ref)) throw forbidden(`${ref} is one of Unit7's own keys. Apps can't use it.`);
  // an app's people-only keys go into another app only by a person's own hand (never a token or an AI)
  if (ctx.actor.kind !== 'user' && peopleRef(ctx.app, ctx.orgId, ref)) throw forbidden(`${ref} is a login or full-access key meant for people. An AI can't put it into an app, even with approval; a person can.`);
  if (!isAgent(ctx)) return;
  // any other key from an app on a server, an add-on or Coolify: only once a person said yes (the gate asks them first)
  if (APP_KEY_REF.test(ref) && !ctx.approvalId) throw forbidden(`${ref} is a key from an app on a server. An AI puts it into an app only once a person approves it; ask for it on its own and it goes to Approvals.`);
  const envId = chain(ctx.db, ctx.orgId, s).find((c) => c.type === 'environment')?.id;
  const { provider, account } = parseRef(ref);
  const acc = get<{ id: string; provider: string }>(ctx.db, 'SELECT id, provider FROM accounts WHERE org_id = ? AND provider = ? AND slug = ?', ctx.orgId, provider, account);
  if (acc && !(envId && get(ctx.db, 'SELECT 1 FROM environment_accounts WHERE environment_id = ? AND account_id = ?', envId, acc.id))) {
    throw forbidden(`${ref} is a connected account's credential that isn't bound to this environment. A person can bind it, or set the variable.`);
  }
  // ponytail: databases from before refs were named by service id (credential://postgres/<slug>/…) aren't matched here
  // a database's refs are named by its service id, slugified by makeRef (svc_Ab → svc-ab)
  const dbEnv = all<{ id: string; environment_id: string }>(ctx.db, 'SELECT id, environment_id FROM services WHERE org_id = ?', ctx.orgId).find((x) => slugify(x.id) === account)?.environment_id;
  if (dbEnv && dbEnv !== envId) throw forbidden(`${ref} belongs to a database in another environment. A person can wire it in.`);
}

// Plaintext values for a deploy. References go through the broker (account boundaries apply).
export function resolveValues(ctx: Ctx, serviceId: string, overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const r of merged(ctx.db, ctx.orgId, { type: 'service', id: serviceId, label: '' })) {
    if (r.ref && INTERNAL_REF.test(r.ref)) throw forbidden(`${r.key} points at ${r.ref}, one of Unit7's own keys. Apps can't use it; change the variable.`);
    env[r.key] = r.ref ? ctx.secret(r.ref) : ctx.app.vault.openValue(ctx.orgId, envContext(r), r.ciphertext!, r.wrapped_key!);
    if (r.secret) ctx.redactor.add(env[r.key]!, `env ${r.key}`);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (isRef(v)) checkRef(ctx, { type: 'service', id: serviceId, label: '' }, v);
    env[k] = isRef(v) ? ctx.secret(v) : v;
  }
  return env;
}

// Teach the redactor every secret a service has (its variables and, for a database, its password), so logs
// that print them come back masked. Best effort: a value that can't be resolved can't be printed by it either.
export function learnSecrets(ctx: Ctx, serviceId: string) {
  for (const r of merged(ctx.db, ctx.orgId, { type: 'service', id: serviceId, label: '' })) {
    if (!r.secret) continue;
    try { ctx.redactor.add(r.ref ? ctx.app.vault.resolve(ctx.orgId, r.ref) : ctx.app.vault.openValue(ctx.orgId, envContext(r), r.ciphertext!, r.wrapped_key!), `env ${r.key}`); } catch { /* unreadable */ }
  }
  const pw = json<{ passwordRef?: string }>(get<{ config: string }>(ctx.db, 'SELECT config FROM services WHERE id = ?', serviceId)?.config, {}).passwordRef;
  if (pw) try { ctx.redactor.add(ctx.app.vault.resolve(ctx.orgId, pw), pw); } catch { /* gone */ }
}

// own: Unit7's own install putting a key it just made into the app it made it for (add-ons): only its own-keys rule applies
export function setVar(ctx: Ctx, s: Scope, key: string, value: string, secret?: boolean, o: { own?: boolean } = {}) {
  const ref = isRef(value) ? value : null;
  if (ref && o.own && INTERNAL_REF.test(ref)) throw forbidden(`${ref} is one of Unit7's own keys. Apps can't use it.`);
  if (ref && !o.own) checkRef(ctx, s, ref);
  const detected = ref ? [] : detectSecrets(value);
  const isSecret = secret ?? (!!ref || looksSecretName(key) || detected.length > 0 || looksRandom(value));
  const warnings: string[] = [];
  if (isSecret && isPublicKey(key)) {
    warnings.push(`${key} starts with a public prefix, so the framework will bake it into the browser bundle where anyone can read it. Keep secrets in a name without that prefix.`);
  }
  const version = (get<{ v: number | null }>(ctx.db, 'SELECT max(version) v FROM env_vars WHERE scope_type = ? AND scope_id = ? AND key = ?', s.type, s.id, key)?.v ?? 0) + 1;
  const row = { scope_type: s.type, scope_id: s.id, key, version };
  const sealed = ref ? null : ctx.app.vault.sealValue(ctx.orgId, envContext(row), value);
  if (isSecret && !ref) ctx.redactor.add(value, `env ${key}`);
  run(ctx.db, `INSERT INTO env_vars (id, org_id, scope_type, scope_id, key, version, secret, ciphertext, wrapped_key, ref, hint, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id('var'), ctx.orgId, s.type, s.id, key, version, isSecret ? 1 : 0,
    sealed?.ciphertext ?? null, sealed?.wrapped ?? null, ref, ref ?? (isSecret ? sealed!.hint : value.length > 64 ? `${value.slice(0, 61)}…` : value), ctx.actor.name);
  return { key, version, secret: isSecret, scope: `${s.type}:${s.label}`, detected, warnings };
}

// .env parser: KEY=value, export KEY=value, "double" (with \n escapes), 'single', # comments.
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[n]!);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if (q === '"' || q === "'" || q === '`') {
      // quoted values may span lines
      let body = v.slice(1);
      while (!new RegExp(`(^|[^\\\\])${q}\\s*(#.*)?$`).test(body) && n + 1 < lines.length) body += '\n' + lines[++n];
      body = body.replace(new RegExp(`${q}\\s*(#.*)?$`), '');
      v = q === '"' ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"') : body;
    } else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]!] = v;
  }
  return out;
}

defineTool({
  name: 'env.list', title: 'List environment variables', risk: 'read', action: 'read',
  description: 'Variables a scope sees after inheritance, with where each comes from. Secret values are never returned, only masked hints.',
  input: z.object(scopeInput),
  run(ctx, i) {
    const s = targetScope(ctx, i);
    return { scope: `${s.type}:${s.label}`, variables: merged(ctx.db, ctx.orgId, s).map((r) => ({
      key: r.key, from: r.from, overrides: r.overrides, version: r.version, secret: !!r.secret,
      value: r.ref ?? (r.secret ? r.hint : r.hint), reference: !!r.ref, public: isPublicKey(r.key), updatedBy: r.created_by, updatedAt: r.created_at,
    })) };
  },
});

defineTool({
  name: 'env.set', title: 'Set an environment variable', risk: 'write', action: 'env_write', sensitive: ['value'],
  description: 'Set a variable at org, project, environment or service level (the most specific id given). value may be a credential:// reference — preferred for secrets.',
  input: z.object({ ...scopeInput, key: KEY, value: z.string().max(65_536), secret: z.boolean().optional() }),
  run(ctx, i) {
    const r = setVar(ctx, targetScope(ctx, i), i.key, i.value, i.secret);
    ctx.emit('env.changed', `${i.key} set on ${r.scope}`, { resource: i.key });
    return r;
  },
});

defineTool({
  name: 'env.unset', title: 'Remove an environment variable', risk: 'write', action: 'env_write',
  description: 'Remove a variable from a scope (key), or several at once (keys). Its history is kept and it can be restored.',
  input: z.object({ ...scopeInput, key: KEY.optional(), keys: z.array(KEY).min(1).max(50).optional() }).refine((i) => !!i.key || !!i.keys?.length, 'Give key, or keys.'),
  run(ctx, i) {
    const s = targetScope(ctx, i);
    const keys = [...new Set([...(i.key ? [i.key] : []), ...(i.keys ?? [])])];
    for (const key of keys) {
      const r = run(ctx.db, 'UPDATE env_vars SET deleted_at = ? WHERE org_id = ? AND scope_type = ? AND scope_id = ? AND key = ? AND deleted_at IS NULL',
        now(), ctx.orgId, s.type, s.id, key);
      if (!r.changes && keys.length === 1) throw notFound(`${key} on ${s.type} ${s.label}`);
    }
    ctx.emit('env.changed', `${keys.join(', ')} removed from ${s.type}:${s.label}`, { resource: keys[0] });
    return keys.length === 1 ? { removed: keys[0], scope: `${s.type}:${s.label}` } : { removed: keys, scope: `${s.type}:${s.label}` };
  },
});

// --- copy settings from another environment (most often Production's into a test copy) ----------------------------
// For the keys the target doesn't have yet. Values never leave the server: each is opened and sealed again for its new
// place. A key that looks live (rzp_live_…, sk_live_…) is flagged, so a test copy doesn't use real money by mistake.
const LIVE = /(^|[^a-z])live([^a-z]|$)/i;
function copyPlan(ctx: Ctx, i: { fromServiceId: string; environmentId: string; keys: string[] }) {
  const from = get<{ name: string; project_id: string; env: string; environment_id: string }>(ctx.db,
    'SELECT s.name, s.project_id, s.environment_id, e.name env FROM services s JOIN environments e ON e.id = s.environment_id WHERE s.id = ?', i.fromServiceId)!;
  const to = get<{ name: string; project_id: string }>(ctx.db, 'SELECT name, project_id FROM environments WHERE id = ?', i.environmentId)!;
  if (to.project_id !== from.project_id || i.environmentId === from.environment_id) throw new Unit7Error('invalid_input', 'Settings are copied between two environments of the same project.');
  const scope: Scope = { type: 'environment', id: i.environmentId, label: to.name };
  const have = new Set(merged(ctx.db, ctx.orgId, scope).map((v) => v.key));
  const source = new Map(merged(ctx.db, ctx.orgId, { type: 'service', id: i.fromServiceId, label: from.name }).map((v) => [v.key, v]));
  const rows = [...new Set(i.keys)].filter((k) => source.has(k) && !have.has(k)).map((key) => {
    const r = source.get(key)!;
    const value = r.ref ?? ctx.app.vault.openValue(ctx.orgId, envContext(r), r.ciphertext!, r.wrapped_key!);
    return { key, value, secret: !!r.secret, live: LIVE.test(key) || LIVE.test(value) || /^(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?):\/\//i.test(value) };
  });
  return { from: `${from.name} in ${from.env}`, fromEnv: from.env, to: to.name, scope, rows, skipped: i.keys.filter((k) => !rows.some((r) => r.key === k)) };
}
const copyInput = z.object({ fromServiceId: fid('svc'), environmentId: fid('env'), keys: z.array(KEY).min(1).max(50) });
defineTool({
  name: 'env.copy', title: 'Copy settings from another environment', risk: 'write', action: 'env_write',
  description: 'Copy variables an app has in one environment (usually Production) into another environment of the same project (environmentId), for the given keys the target doesn’t have yet. Values stay on the server. A dry run lists the keys and flags live-looking ones (rzp_live_, sk_live_…): a test copy should usually get test keys. Its undo removes them again.',
  input: copyInput,
  dryRun: (ctx, i) => { const p = copyPlan(ctx, i); return { from: p.from, to: p.to, keys: p.rows.map(({ key, secret, live }) => ({ key, secret, live })), skipped: p.skipped }; },
  run(ctx, i) {
    const p = copyPlan(ctx, i);
    if (!p.rows.length) throw new Unit7Error('nothing_to_copy', `${p.to} already has ${i.keys.length > 1 ? 'these settings' : 'that setting'}, or ${p.from} doesn’t.`, 409);
    // a live-looking key (sk_live_…, a database address) goes into another environment only once a person said so
    const live = p.rows.filter((r) => r.live).map((r) => r.key);
    if (live.length && isAgent(ctx) && !ctx.approvalId) throw forbidden(`These look live, so an AI doesn’t copy them: ${live.join(', ')}. A person chooses on the test copy’s plan, or sets them, and nothing was copied.`);
    tx(ctx.db, () => p.rows.forEach((r) => setVar(ctx, p.scope, r.key, r.value, r.secret)));
    const keys = p.rows.map((r) => r.key);
    ctx.emit('env.changed', `Copied ${keys.join(', ')} from ${p.from} to ${p.to}`, { resource: keys[0] });
    return { copied: keys, from: p.from, to: p.to, live: p.rows.filter((r) => r.live).map((r) => r.key),
      undo: { tool: 'env.unset', input: { environmentId: i.environmentId, keys }, label: 'Remove them again' } };
  },
});

defineTool({
  name: 'env.import', title: 'Import a .env file', risk: 'write', action: 'env_write', sensitive: ['dotenv'],
  description: 'Import KEY=value lines into a scope. Secrets are detected and flagged automatically.',
  input: z.object({ ...scopeInput, dotenv: z.string().max(1_000_000) }),
  run(ctx, i) {
    const s = targetScope(ctx, i);
    const vars = parseDotenv(i.dotenv);
    if (!Object.keys(vars).length) throw new Unit7Error('empty_import', 'No KEY=value lines were found.');
    const results = tx(ctx.db, () => Object.entries(vars).map(([k, v]) => setVar(ctx, s, k, v)));
    ctx.emit('env.changed', `Imported ${results.length} variables into ${s.type}:${s.label}`);
    return { imported: results.length, secrets: results.filter((r) => r.secret).map((r) => r.key), warnings: results.flatMap((r) => r.warnings) };
  },
});

defineTool({
  name: 'env.history', title: 'Variable history', risk: 'read', action: 'read',
  description: 'Every version of one variable in one scope.',
  input: z.object({ ...scopeInput, key: KEY }),
  run(ctx, i) {
    const s = targetScope(ctx, i);
    return all(ctx.db, `SELECT version, secret, hint, ref, created_by, created_at, deleted_at FROM env_vars
      WHERE org_id = ? AND scope_type = ? AND scope_id = ? AND key = ? ORDER BY version DESC`, ctx.orgId, s.type, s.id, i.key);
  },
});

defineTool({
  name: 'env.restore', title: 'Restore a variable version', risk: 'write', action: 'env_write',
  description: 'Make an older version of a variable current again.',
  input: z.object({ ...scopeInput, key: KEY, version: z.number().int().min(1) }),
  run(ctx, i) {
    const s = targetScope(ctx, i);
    const r = get<VarRow>(ctx.db, 'SELECT * FROM env_vars WHERE org_id = ? AND scope_type = ? AND scope_id = ? AND key = ? AND version = ?',
      ctx.orgId, s.type, s.id, i.key, i.version);
    if (!r) throw notFound(`Version ${i.version} of ${i.key}`);
    const value = r.ref ?? ctx.app.vault.openValue(ctx.orgId, envContext(r), r.ciphertext!, r.wrapped_key!);
    return setVar(ctx, s, i.key, value, !!r.secret);
  },
});

defineTool({
  name: 'env.reveal', title: 'Reveal a variable value', risk: 'read', action: 'secret_reveal', peopleOnly: true,
  description: 'Show the plaintext value of one variable. People only, audited; secret values need an owner or admin.',
  input: z.object({ ...scopeInput, key: KEY }),
  run(ctx, i) {
    requireHuman(ctx, 'reveal a value');
    const s = targetScope(ctx, i);
    const r = merged(ctx.db, ctx.orgId, s).find((v) => v.key === i.key);
    if (!r) throw notFound(i.key);
    if (r.secret) requireRole(ctx, ['owner', 'admin'], 'reveal secret values');
    if (r.ref) return { key: i.key, reference: r.ref, note: 'This variable points at a vault credential; its value is resolved only at deploy time.' };
    const value = ctx.app.vault.openValue(ctx.orgId, envContext(r), r.ciphertext!, r.wrapped_key!);
    ctx.emit('secret.revealed', `${ctx.actor.name} revealed ${i.key}`, { severity: 'warning', resource: i.key });
    // returned deliberately: this is the one tool whose job is to show a value to a person
    return { key: i.key, value: { __reveal: value } };
  },
});

defineTool({
  name: 'env.export', title: 'Export variables', risk: 'read', action: 'secret_reveal', peopleOnly: true,
  description: 'Export a scope as .env text. Secret values are written as their reference or masked; people only.',
  input: z.object({ ...scopeInput, includeSecrets: z.boolean().default(false) }),
  run(ctx, i) {
    requireHuman(ctx, 'export variables');
    if (i.includeSecrets) requireRole(ctx, ['owner', 'admin'], 'export secret values');
    const s = targetScope(ctx, i);
    const lines = merged(ctx.db, ctx.orgId, s).map((r) => {
      const v = r.ref ?? (r.secret && !i.includeSecrets ? `# secret, masked: ${r.hint}` : ctx.app.vault.openValue(ctx.orgId, envContext(r), r.ciphertext!, r.wrapped_key!));
      return v.startsWith('# secret') ? `${r.key}= ${v}` : `${r.key}=${JSON.stringify(v)}`;
    });
    return { dotenv: { __reveal: lines.join('\n') + '\n' } };
  },
});
