// Who may do what, where. Two inputs decide every action:
//   1. role (RBAC): what this person or token may ever do in the org
//   2. the environment's policy (ABAC): its autonomy level for agents, plus per-action rules
//      (allowed / restricted / prohibited) that apply to everyone.
// Decisions: allow, approve (a human must confirm — the approval queue), deny.

export type Risk = 'read' | 'write' | 'destructive';
export type Rule = 'allowed' | 'restricted' | 'prohibited';
export type Decision = 'allow' | 'approve' | 'deny';
export type Role = 'owner' | 'admin' | 'developer' | 'agent' | 'readonly' | 'auditor';
export type EnvKind = 'development' | 'staging' | 'production' | 'custom';

export const ROLES: Role[] = ['owner', 'admin', 'developer', 'agent', 'readonly', 'auditor'];
export const AUTONOMY = ['Observe', 'Recommend', 'Safe actions', 'Production autonomy', 'Full autopilot'] as const;

const ROLE_RANK: Record<Role, number> = { auditor: 0, readonly: 0, agent: 1, developer: 2, admin: 3, owner: 4 };
export const canGrant = (granter: Role, role: Role) => ROLE_RANK[granter] >= ROLE_RANK[role] && (granter === 'owner' || role !== 'owner');
export const isAdmin = (r: Role) => r === 'owner' || r === 'admin';

// Sensible defaults; an org edits them per environment.
// Autopilot by default (Unit7 is meant to run without a human); the rules below still gate the dangerous parts.
export const DEFAULT_AUTONOMY: Record<EnvKind, number> = { development: 4, staging: 4, production: 3, custom: 3 };
export const DEFAULT_RULES: Record<EnvKind, Record<string, Rule>> = {
  development: { drop_database: 'restricted', destroy_server: 'restricted' },
  staging: { drop_database: 'restricted', destroy_server: 'restricted', provider_purchase: 'restricted' },
  production: {
    deploy: 'allowed', rollback: 'allowed', restart_service: 'allowed', backup: 'allowed',
    database_write: 'allowed', database_delete: 'restricted', restore: 'restricted', server_exec: 'restricted',
    drop_database: 'prohibited', destroy_server: 'prohibited', provider_purchase: 'restricted', vault_delete: 'restricted',
  },
  custom: { drop_database: 'restricted', destroy_server: 'restricted', provider_purchase: 'restricted' },
};

const ORG_BOOKKEEPING = new Set(['project_write', 'environment_write', 'memory']);

export interface PolicyInput {
  actor: 'human' | 'agent';
  role: Role;
  risk: Risk;
  action: string;
  env?: { kind: EnvKind; autonomy: number; rules: Record<string, Rule>; name: string; orgWide?: boolean } | undefined;
  green?: boolean; // only creates or copies: nothing that exists changes (see colourOf)
}

// Every action has a colour, and that's the whole model a person needs. Green only creates or copies, so Unit7 does it by
// itself. Yellow is a change with an undo, and follows the autonomy level. Red can lose something or cost money, and always
// waits for a person. Green is a tool's own promise (Tool.green), never a guess from its risk.
export type Colour = 'green' | 'yellow' | 'red';

export function decide(p: PolicyInput): { decision: Decision; why: string } {
  const env = p.env;
  const rule: Rule | undefined = env ? (env.rules[p.action] ?? DEFAULT_RULES[env.kind][p.action]) : undefined;
  const where = env ? ` in ${env.name}` : '';

  if (rule === 'prohibited') return { decision: 'deny', why: `Policy prohibits ${p.action.replace(/_/g, ' ')}${where}.` };

  // RBAC first: some roles can never write.
  if (p.role === 'readonly' || p.role === 'auditor') {
    return p.risk === 'read' ? { decision: 'allow', why: 'read' } : { decision: 'deny', why: `The ${p.role} role can only look, not change anything.` };
  }
  const agent = p.actor === 'agent' || p.role === 'agent';

  if (!agent) {
    if (rule === 'restricted') return { decision: 'approve', why: `${p.action.replace(/_/g, ' ')}${where} is restricted, so it needs explicit confirmation.` };
    if (p.risk === 'destructive' && p.role === 'developer' && env?.kind === 'production') {
      return { decision: 'approve', why: `Destructive changes in production need an admin's approval.` };
    }
    return { decision: 'allow', why: 'role permits' };
  }

  // Agents act within the environment's autonomy level. No environment = org-level resource,
  // treated like production (the safest reading) — except bookkeeping that touches no
  // infrastructure, like creating a project or remembering a fact.
  if ((!env || env.orgWide) && p.risk === 'write' && ORG_BOOKKEEPING.has(p.action)) return { decision: 'allow', why: 'bookkeeping' };
  const level = env?.autonomy ?? 2;
  const prod = !env || env.kind === 'production';
  if (level <= 0) {
    return p.risk === 'read' ? { decision: 'allow', why: 'observe' } : { decision: 'deny', why: `Autonomy${where} is set to Observe: the agent can look but not act.` };
  }
  if (p.risk === 'read') return { decision: 'allow', why: 'read' };
  if (rule === 'restricted') return { decision: 'approve', why: `${p.action.replace(/_/g, ' ')}${where} is restricted, so a human must approve it.` };
  if (p.green && p.risk === 'write') return { decision: 'allow', why: 'it only creates or copies, so nothing that exists changes' };
  if (level === 1) return { decision: 'approve', why: `Autonomy${where} is Recommend: the agent proposes, a human approves.` };
  if (rule === 'allowed' && p.risk === 'write') return { decision: 'allow', why: `policy allows ${p.action}` };
  if (p.risk === 'destructive' && level < 4) return { decision: 'approve', why: `Destructive actions${where} need a human's approval at this autonomy level.` };
  if (p.risk === 'write' && prod && level < 3) return { decision: 'approve', why: `Changes${where} need approval at Safe-actions autonomy.` };
  return { decision: 'allow', why: `autonomy level ${level}` };
}

// --- risk tiers: how hard a change is to take back --------------------------------------------------
// T0 read: always automatic. T1 easy to undo (restart, start, back up): automatic on test copies; in production
// automatic from "Fix itself" up, at most 3 an hour per thing. T2 change with undo (settings, stop, update,
// limits): an undo recipe first, a health check after, rolled back when it fails; an AI asks first in production
// below Full autopilot. T3 data or hard to undo: a fresh backup first, and a person approves (people type the
// name). T4 never by an AI. Tiers only ever make decide() stricter: a tool that doesn't say its tier gets decide()
// exactly as before. Things Unit7 only discovered on a server (not set up, not adopted) stay at Recommend for AIs.
export type Tier = 0 | 1 | 2 | 3 | 4;
export const TIER_NAMES = ['Read', 'Easy to undo', 'Change with undo', 'Hard to undo', 'Never by the AI'] as const;
// The tier each existing action key sits on (shown on approvals). Labels only: these actions keep their rules above.
export const ACTION_TIER: Record<string, Tier> = {
  read: 0, server_read: 0,
  restart_service: 1, backup: 1, scale: 1, memory: 1,
  deploy: 2, rollback: 2, env_write: 2, stop_service: 2, settings_write: 2, service_write: 2, server_write: 2, server_setup: 2, server_harden: 2,
  dns_write: 2, proxy_config: 2, shield_block: 2, project_write: 2, environment_write: 2, database_create: 2, vault_write: 2, policy_change: 2,
  part_adopt: 2, change_undo: 2,
  // Coolify's own settings (its API switch, Unit7's token there): tools assess them as discovered, so an AI always
  // asks a person first; a person does it with one click. Not a "restricted" rule: that would make the person's own
  // click wait for an approval too (and page their phone).
  coolify_admin: 2,
  // saving or changing a routine (it runs as its owner later, through these same rules)
  routine_write: 2,
  // production's data copied into a test copy's new database (its own key, so a person can forbid it per environment)
  data_copy: 2,
  // making or taking back a credential for an app on a server (serverapp.connect / disconnect): assessed as discovered in
  // production, so an AI asks first there; a person connects with one click (the same reasoning as coolify_admin)
  serverapp_admin: 2,
  // cleanup: old images, old logs, leftover data. Gone for good, so never by itself
  cleanup: 3, database_write: 3, database_delete: 3, restore: 3, server_exec: 3, server_remove: 3, service_delete: 3, project_delete: 3, environment_delete: 3,
  vault_delete: 3, provider_purchase: 3, hostinger_batch: 3,
  drop_database: 4, destroy_server: 4, secret_reveal: 4,
};
export const tierOf = (action: string, risk: Risk): Tier => ACTION_TIER[action] ?? (risk === 'read' ? 0 : risk === 'destructive' ? 3 : 2);
export const colourOf = (action: string, risk: Risk, green?: boolean): Colour => (green || risk === 'read' ? 'green' : risk === 'destructive' || tierOf(action, risk) >= 3 ? 'red' : 'yellow');

export interface Assessment {
  tier: Tier;
  discovered?: boolean; // the target is something Unit7 found but didn't set up, and no person adopted it
  recent?: number;      // how many times an AI did this to the same thing in the last hour (T1's limit)
  shows?: string;       // the literal command(s), for the approval card
  impact?: string;      // what happens if it runs, in words
  ask?: string;         // an AI always asks a person first, at any autonomy (a budget alert, a cost-spike stop): why, in words
}
const STRICT = { allow: 0, approve: 1, deny: 2 } as const;
// a read-only command is still a command: where running commands is prohibited, so is it
const PARENT_RULE: Record<string, string> = { server_read: 'server_exec' };
export function decideTiered(p: PolicyInput & Partial<Assessment>): { decision: Decision; why: string } {
  const parent = PARENT_RULE[p.action];
  if (parent && p.env && (p.env.rules[parent] ?? DEFAULT_RULES[p.env.kind][parent]) === 'prohibited') return { decision: 'deny', why: `Policy prohibits ${parent.replace(/_/g, ' ')} in ${p.env.name}.` };
  const base = decide(p);
  if (p.green && base.decision === 'allow') return base;
  if (p.tier === undefined || base.decision === 'deny' || !(p.actor === 'agent' || p.role === 'agent') || p.tier === 0) return base;
  const level = p.env?.autonomy ?? 2;
  const prod = !p.env || p.env.kind === 'production';
  const t: { decision: Decision; why: string } | undefined =
    p.tier === 4 ? { decision: 'deny', why: 'Unit7 never lets an AI do this: it can’t be taken back, or it would show secrets. A person can still do it themselves.' }
    : p.ask ? { decision: 'approve', why: p.ask }
    : p.tier === 3 ? { decision: 'approve', why: 'This is hard to undo, so a person approves it first (Unit7 takes a fresh backup before it runs).' }
    : p.discovered ? { decision: 'approve', why: 'Unit7 found this on the server but didn’t set it up, so an AI may only suggest changes to it until a person adopts it.' }
    : p.tier === 2 && prod && level < 4 ? { decision: 'approve', why: 'This changes something live, so a person approves it first (Unit7 keeps an undo and checks it afterwards).' }
    : p.tier === 1 && prod && (p.recent ?? 0) >= 3 ? { decision: 'approve', why: 'An AI already did this 3 times in the last hour, so the next one waits for a person.' }
    : undefined;
  return t && STRICT[t.decision] > STRICT[base.decision] ? t : base;
}

// Products and clients (src/organize): Unit7's own bookkeeping, easy to take back. A client's status page is a small static
// page on one of the person's servers: a person turns it on; keeping it fresh afterwards (every 5 minutes) is allowed.
Object.assign(ACTION_TIER, { group_write: 1, client_write: 1, client_delete: 2, status_publish: 1 } satisfies Record<string, Tier>);
DEFAULT_RULES.production.status_publish = 'allowed';

// Spending money or changing a bill through a provider's raw passthrough (hostinger.do / hostinger.batch, connection.call):
// people-only for an AI, never even with an approval, and a person's own write goes through provider_purchase. Matched
// on the operation id or tool name, which covers Hostinger's whole `billing_*` category and its purchase/renew verbs;
// anything that only might be money counts as money.
export const MONEY_OP = /purchase|order|payment|billing|subscription|renew|cancel|refund|payout|invoice|checkout|charge|buy|upgrade|cost|money|transfer|recipient|convert_currency/i;
// A money tool that only looks: it starts with a read verb (after one provider prefix, as in planetscale_list_invoices) and
// nothing in its name acts. The provider's own read-only hint has to agree: a hint is their word, the name is the check on it.
const READ_VERB = /^(?:[a-z0-9]+[_.-])?(?:list|get|read|retrieve|search|find|fetch|show|view|describe|count)(?:[_.-]|$)/i;
const ACTS = /(?:^|[_.-])(?:and|or|then|create|update|set|add|delete|remove|cancel|pay|buy|purchase|renew|upgrade|downgrade|confirm|finalize|void)(?:[_.-]|$)/i;
export const plainRead = (name: string) => { const n = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2'); return READ_VERB.test(n) && !ACTS.test(n); };

// Uptime Kuma monitors (uptime.sync): an HTTP check for each site Unit7 knows, tagged "unit7", never changing or removing
// the person's own. A person adds Uptime Kuma (or gives Unit7 its login); keeping its monitors in step with new sites
// afterwards is allowed. One Unit7 only found on a server stays at "ask first" for an AI (assessed as discovered).
Object.assign(ACTION_TIER, { monitor_write: 1 } satisfies Record<string, Tier>);
DEFAULT_RULES.production.monitor_write = 'allowed';

// Restarting a whole server (server.reboot): like restarting an app, it comes back by itself (T1). Its assess makes it a
// change with undo (T2) outside the restart window a person set, so an AI asks first there; inside it, the person's
// window is their OK.
Object.assign(ACTION_TIER, { server_restart: 1 } satisfies Record<string, Tier>);

// The big clouds (tools/clouds-*.ts): deleting a DNS record and stopping things to cut a cost spike are hard to undo for
// what they break (each keeps an undo, and an AI always asks); a spending alert only warns.
Object.assign(ACTION_TIER, { dns_delete: 3, stop_runaway: 3, budget_alert: 2 } satisfies Record<string, Tier>);

// "It's in use" / "important" marks (asset.keep): Unit7's own bookkeeping, easy to take back, but it changes what Unit7
// suggests and how carefully it treats a thing, so the tool's assess makes an AI ask a person first either way.
Object.assign(ACTION_TIER, { keep_write: 1 } satisfies Record<string, Tier>);

// Many servers (tools/fleet.ts): taking a server out of an app's rotation, or putting it back, is easy to undo, and Warden
// does it by itself when a server fails its health checks (DNS mode). Adding or removing a server, and rolling a release,
// are deploys.
Object.assign(ACTION_TIER, { fleet_rotate: 1 } satisfies Record<string, Tier>);
DEFAULT_RULES.production.fleet_rotate = 'allowed';

// Keep it fresh (tools/fresh.ts): getting a batch of updates ready is easy to undo (a branch, a pull request and a test
// copy; production isn't touched), so Warden does it by itself from "Ask first" up. Releasing it is a deploy, and the
// tool's own assess says when an AI must ask (majors below Autopilot, anything at "Ask first").
Object.assign(ACTION_TIER, { fresh_prepare: 1 } satisfies Record<string, Tier>);
DEFAULT_RULES.production.fresh_prepare = 'allowed';

// Many servers, part two (tools/fleet.ts, tools/dr.ts): a server's region label is Unit7's own bookkeeping (T1). Moving
// every visitor to a warm standby (dr.failover) changes what's live: its assess lets Warden do it by itself only at
// "Production autonomy" or higher with the main server down 5+ minutes; any other AI asks, a person does it in one tap.
Object.assign(ACTION_TIER, { server_label: 1, dr_failover: 2 } satisfies Record<string, Tier>);
DEFAULT_RULES.production.server_label = 'allowed';

// Files on a server (tools/files.ts): saving or moving one is a change with an undo. Removing one moves it to a 7-day trash,
// and an AI always asks first. A write to a system path (/etc, /boot, an SSH folder) has its own key, restricted, so even a
// person's own click waits on Approvals, and its assess makes an AI ask at any autonomy.
Object.assign(ACTION_TIER, { file_write: 2, file_remove: 3, system_file_write: 2 } satisfies Record<string, Tier>);
DEFAULT_RULES.production.system_file_write = 'restricted';
// A server itself (tools/vps.ts, tools/access.ts): who can sign in is hard to undo for what it opens or locks out, and an AI
// always asks first; turning one off is a change with undo; deleting one at its provider is never for an AI.
Object.assign(ACTION_TIER, { server_access: 3, server_power: 2, server_delete: 4 } satisfies Record<string, Tier>);
