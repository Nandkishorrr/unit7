// Build from a sentence, through Coolify: "a Next.js app from my repo with a Supabase backend" becomes a short plan
// (project → environment → app → database or service, wired into the app → domain → deploy), shown to the person as
// ONE card with every change and how to undo it, then run step by step. Each step is its own Unit7 action (the same
// gate, approvals and audit as calling it alone) and its own step in the chat, and the run stops at the first one
// that doesn't work, saying what was done and what to do next. Running it again reuses what's already there.
import { z } from 'zod';
import { defineTool, execute, type Ctx } from './runtime.ts';
import { all, get, id, json } from '../db.ts';
import { Unit7Error } from '../errors.ts';
import { serverRow } from './servers.ts';
import { githubApps, need, splitImage } from './coolify.ts';
import { parseRepo } from '../connectors/github.ts';
import { ENGINES, byName, envResources, list as items, type Coolify, type EngineName } from '../connectors/coolify.ts';
import { ask, stamp, threadFor, type AskSpec } from '../agent/asks.ts';
import type { ServerRow } from '../connectors/ssh.ts';

// --- the sentence → what the person wants ------------------------------------------------------------------
type Pack = 'nixpacks' | 'railpack' | 'static' | 'dockerfile' | 'dockercompose';
const FRAMEWORKS: [RegExp, string, number, Pack?][] = [
  [/\bnext(\.?js)?\b/i, 'Next.js', 3000], [/\bnuxt(\.?js)?\b/i, 'Nuxt', 3000], [/\bremix\b/i, 'Remix', 3000], [/\bsvelte ?kit\b/i, 'SvelteKit', 3000],
  [/\b(express|nest(\.?js)?|node(\.?js)?)\b/i, 'Node.js', 3000], [/\bdjango\b/i, 'Django', 8000], [/\bflask\b/i, 'Flask', 8000], [/\bfastapi\b/i, 'FastAPI', 8000],
  [/\brails\b/i, 'Rails', 3000], [/\blaravel\b/i, 'Laravel', 80], [/\bgolang\b|\bgo (app|api|server|service)\b/i, 'Go', 8080],
  [/\bstatic\b|\bhtml\b/i, 'static site', 80, 'static'],
];
const DBS: [RegExp, EngineName][] = [
  [/\b(postgres(ql)?|pg)\b/i, 'postgresql'], [/\bmysql\b/i, 'mysql'], [/\bmaria(db)?\b/i, 'mariadb'], [/\bmongo(db)?\b/i, 'mongodb'],
  [/\bredis\b/i, 'redis'], [/\bkeydb\b/i, 'keydb'], [/\bdragonfly(db)?\b/i, 'dragonfly'], [/\bclickhouse\b/i, 'clickhouse'],
];
// Coolify one-click templates people name in a sentence (any other key works through coolify.create_service)
const TEMPLATES: Record<string, string> = { supabase: 'Supabase', pocketbase: 'PocketBase', appwrite: 'Appwrite', minio: 'MinIO', n8n: 'n8n', umami: 'Umami', plausible: 'Plausible' };
const NOT_DOMAINS = /^(github\.com|gitlab\.com|ghcr\.io|docker\.io|quay\.io|next\.js|node\.js|nuxt\.js|nest\.js)$/i;

export interface Wish {
  goal?: string; repo?: string; branch?: string; image?: string; dockerfile?: string; name?: string; project?: string; environment?: string;
  domain?: string; database?: EngineName; service?: string; buildPack?: Pack; port?: number;
}
export interface Intent {
  name: string; project: string; environment: string;
  app?: { repo?: string; branch?: string; image?: string; dockerfile?: string; framework?: string; buildPack: Pack; port: number };
  databases: EngineName[]; services: string[]; domain?: string; missing: { field: string; ask: string }[];
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// What a sentence asks for, without asking anyone: words for the framework, the backend, where the code is, the
// environment and the domain. Anything given outright (repo, image, name…) wins over the words.
export function parseWish(w: Wish): Intent {
  const t = w.goal ?? '';
  const fw = FRAMEWORKS.find(([re]) => re.test(t));
  const repo = w.repo ?? /\b(?:https?:\/\/)?github\.com\/[\w-]+\/[\w.-]+/i.exec(t)?.[0]?.replace(/\.git$|[.,;]$/, '') ?? /\b(?:repo|from)\s+([A-Za-z0-9-]+\/[\w.-]*\w)(?=[\s,;]|$)/i.exec(t)?.[1];
  const image = w.image ?? /\bimage\s+([\w.-]+(?::\d+)?(?:\/[\w.-]+)*(?::[\w.-]+)?)/i.exec(t)?.[1]?.replace(/[.,;]$/, '');
  const wantsApp = !!(repo || image || w.dockerfile || fw || /\b(app|site|website|web ?app|api|frontend|backend|bot|repo|github)\b/i.test(t));
  const services = [...new Set([...(w.service ? [w.service] : []), ...Object.keys(TEMPLATES).filter((k) => new RegExp(`\\b${k}\\b`, 'i').test(t))])];
  let databases = [...new Set([...(w.database ? [w.database] : []), ...DBS.filter(([re]) => re.test(t)).map(([, e]) => e)])];
  // "a database" with no engine is Postgres, unless Supabase (it has its own) or the engine was named
  if (!databases.length && !services.includes('supabase') && /\b(database|db)\b/i.test(t)) databases = ['postgresql'];
  const environment = w.environment ?? (/\bstag(e|ing)\b/i.test(t) ? 'staging' : /\bdev(elopment)?\b/i.test(t) ? 'development' : 'production');
  const said = [...t.matchAll(/\b(?:on|at|domain|to|under)\s+((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi)].map((m) => m[1]!.toLowerCase()).find((h) => !NOT_DOMAINS.test(h));
  const domain = (w.domain ?? said)?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const gh = repo ? parseRepo(repo) : undefined;
  const name = slug(w.name ?? gh?.name ?? (image && splitImage(image).name.split('/').pop()) ?? fw?.[1] ?? services[0] ?? databases[0] ?? '') || 'app';
  const missing: Intent['missing'] = [];
  if (wantsApp && !repo && !image && !w.dockerfile) {
    missing.push({ field: 'repo', ask: /\b(repo|github|git)\b/i.test(t) || fw ? 'Which GitHub repo? (coolify.repos and github.repos list them)' : 'Where is the code: a GitHub repo, or a ready image?' });
  }
  const dockerfile = /\bdockerfile\b/i.test(t) && repo;
  return {
    name, project: w.project ?? name, environment, databases, services, ...(domain && { domain }), missing,
    ...(wantsApp && { app: {
      ...(repo && { repo }), ...(w.branch && { branch: w.branch }), ...(image && { image }), ...(w.dockerfile && { dockerfile: w.dockerfile }), ...(fw && { framework: fw[1] }),
      buildPack: w.buildPack ?? (dockerfile ? 'dockerfile' : fw?.[3] ?? 'nixpacks'), port: w.port ?? fw?.[2] ?? 3000,
    } }),
  };
}

// --- the plan: steps, plus the card the person sees ---------------------------------------------------------
interface Step { tool: string; title: string; input: Record<string, unknown>; keep?: Record<string, string> } // keep: the name later steps use ('$app') → its output field
export interface Plan { intent: Intent; steps: Step[]; card: Extract<AskSpec, { kind: 'confirm' }> }
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const SHORT: Record<EngineName, string> = { postgresql: 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongodb: 'mongo', redis: 'redis', keydb: 'keydb', dragonfly: 'dragonfly', clickhouse: 'clickhouse' };

export async function makePlan(api: Coolify, s: ServerRow, it: Intent): Promise<Plan> {
  const project = byName(items(await api.call('GET', '/projects')), it.project);
  const envs = project ? items((await api.call('GET', `/projects/${encodeURIComponent(project.uuid)}`))?.environments) : [];
  const envThere = envs.some((e) => e?.name === it.environment);
  const there = project && envThere ? await envResources(api, project.uuid, it.environment) : { application: [], database: [], service: [] };
  const where = { serverId: s.id, project: '$project', environment: it.environment };
  const steps: Step[] = [{ tool: 'coolify.create_project', title: `Set up the project ${it.project}`, input: { serverId: s.id, name: it.project, environment: it.environment }, keep: { project: 'project' } }];
  const changes: Plan['card']['changes'] = [
    { label: 'Project in Coolify', after: `${it.project}${project ? ', already there' : ', new'}` },
    { label: 'Environment', after: `${it.environment}${envThere ? ', already there' : ', new'}` },
  ];
  const a = it.app;
  const appThere = a && byName(there.application, it.name);
  if (a) {
    let from = a.image ? `the image ${a.image}` : a.dockerfile ? 'a Dockerfile' : a.repo ?? '';
    const gh = a.repo ? parseRepo(a.repo) : undefined;
    if (gh && !appThere) {
      const full = `${gh.owner}/${gh.name}`.toLowerCase();
      const via = (await githubApps(api).catch(() => [])).find((g) => g.repos.some((r) => r.fullName.toLowerCase() === full));
      from = `${gh.owner}/${gh.name}${a.branch ? ` (${a.branch})` : ''}${via ? `, through ${via.name}` : ''}`;
    }
    steps.push({ tool: 'coolify.create_app', title: `Create the app ${it.name}`, keep: { app: 'uuid' }, input: {
      ...where, name: it.name, ...(a.repo && { repo: a.repo }), ...(a.branch && { branch: a.branch }), ...(a.image && { image: a.image }), ...(a.dockerfile && { dockerfile: a.dockerfile }),
      ...(!a.image && !a.dockerfile && { buildPack: a.buildPack }), port: a.port,
    } });
    changes.push({ label: 'App', after: appThere ? `${it.name}, already there` : `${it.name} from ${from}: ${a.framework ?? a.buildPack} on port ${a.port}` });
  }
  const wired: string[] = [];
  for (const engine of it.databases) {
    const e = ENGINES[engine], name = it.name === engine ? SHORT[engine] : `${it.name}-${SHORT[engine]}`;
    const wire = a && !wired.includes(e.key);
    if (wire) wired.push(e.key);
    steps.push({ tool: 'coolify.create_database', title: `Add the ${e.label} database ${name}`, input: { ...where, engine, name, ...(wire && { injectInto: '$app' }) } });
    changes.push({ label: `${e.label} database`, after: `${name}, private to the server${byName(there.database, name) ? ', already there' : ''}` });
  }
  for (const type of it.services) {
    const name = it.name === type ? type : `${it.name}-${type}`, label = TEMPLATES[type] ?? type;
    const wire = a && type === 'supabase';
    if (wire) wired.push('SUPABASE_URL', 'SUPABASE_ANON_KEY', ...(a.framework === 'Next.js' ? ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] : []));
    steps.push({ tool: 'coolify.create_service', title: `Add ${label}`, input: { ...where, type, name, ...(wire && { injectInto: '$app', nextPublic: a.framework === 'Next.js' }) } });
    changes.push({ label, after: `${name}${type === 'supabase' ? ': its own Postgres, sign-in, storage and API' : ', a one-click stack'}${byName(there.service, name) ? ', already there' : ''}` });
  }
  if (wired.length) changes.push({ label: 'App settings', after: cut(`${wired.join(', ')}: filled in inside Coolify, values never shown here`, 200) });
  if (a && it.domain) {
    steps.push({ tool: 'coolify.set_domain', title: `Give ${it.name} the domain ${it.domain}`, input: { serverId: s.id, uuid: '$app', domains: [it.domain] } });
    changes.push({ label: 'Domain', before: 'none', after: `${it.domain}, then an A record to ${s.host} for HTTPS` });
  } else if (a) changes.push({ label: 'Address', after: 'a free test address from Coolify (add your domain any time)' });
  if (a) {
    steps.push({ tool: 'coolify.control', title: `Deploy ${it.name}`, input: { serverId: s.id, uuid: '$app', kind: 'application', action: 'deploy' } });
    changes.push({ label: 'Deploy', after: `build and start ${it.name}` });
  }
  return {
    intent: it, steps, card: {
      kind: 'confirm', title: cut(`Build ${it.name} on ${s.name} with Coolify`, 140),
      note: `${steps.length} steps. Passwords and keys go straight into Coolify, never into this chat.`,
      changes: changes.slice(0, 12).map((c) => ({ label: cut(c.label, 80), ...(c.before && { before: cut(c.before, 200) }), after: cut(c.after, 200) })),
      undo: 'Nothing is deleted. To undo, ask me to remove what this made; its data is kept unless you choose to delete it.', confirmLabel: 'Build it',
    },
  };
}

// --- which Coolify, and whether to show the card ---------------------------------------------------------------
function coolifyServer(ctx: Ctx, serverId?: string) {
  if (serverId) return serverRow(ctx, serverId);
  const ids = all<{ meta: string }>(ctx.db, `SELECT meta FROM accounts WHERE org_id = ? AND provider = 'coolify'`, ctx.orgId).map((a) => json<{ serverId?: string }>(a.meta, {}).serverId).filter(Boolean) as string[];
  if (ids.length === 1) return serverRow(ctx, ids[0]!);
  const names = ids.map((x) => serverRow(ctx, x).name).join(', ');
  throw new Unit7Error(ids.length ? 'pick_server' : 'coolify_not_connected', ids.length
    ? `Coolify is connected on ${ids.length} servers (${names}). Ask which one (ui_choose source servers) and pass serverId.`
    : 'No server has its Coolify connected yet. coolify.connect shows the three steps.', 400);
}
const TEST_ENV = /^(dev|development|staging|stage|test|testing|preview|qa|sandbox)$/i;
// ask: show the card here · skip: a person ran it, or autonomy says just do it (4 on a test environment), or the gate
// holds every step anyway (1) or allows none (0) · needs: outside the ask box, the caller confirms with the person
export function confirmMode(ctx: Pick<Ctx, 'db' | 'orgId' | 'actor' | 'conversationId'>, environment: string): { mode: 'ask' | 'skip' | 'needs'; why: string } {
  if (ctx.actor.kind === 'user') return { mode: 'skip', why: 'a person asked for it' };
  const level = get<{ autonomy: number }>(ctx.db, 'SELECT autonomy FROM orgs WHERE id = ?', ctx.orgId)?.autonomy ?? 3;
  if (level >= 4 && TEST_ENV.test(environment)) return { mode: 'skip', why: `autonomy ${level} on ${environment}: build, then report` };
  if (level <= 1) return { mode: 'skip', why: level === 1 ? 'each step waits for a person’s approval' : 'autonomy is Observe: nothing can change' };
  return threadFor(ctx) ? { mode: 'ask', why: 'the person confirms the plan here' } : { mode: 'needs', why: 'outside Unit7’s ask box' };
}

const WISH = {
  serverId: z.string().regex(/^srv_[A-Za-z0-9_-]{12}$/).optional().describe('The server whose Coolify builds it; by default the only one with Coolify connected.'),
  goal: z.string().trim().min(3).max(500).describe('The person’s own words: "a Next.js app from my repo with a Supabase backend on shop.example.com".'),
  repo: z.string().trim().max(300).optional().describe('owner/name or a GitHub URL, when the sentence doesn’t have it.'),
  branch: z.string().regex(/^[\w./-]{1,100}$/).optional(), image: z.string().trim().max(200).optional(),
  dockerfile: z.string().min(10).max(100_000).optional(), name: z.string().trim().max(60).optional(), project: z.string().trim().max(60).optional(),
  environment: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/i).optional(), domain: z.string().trim().max(200).optional(),
  database: z.enum(Object.keys(ENGINES) as [EngineName, ...EngineName[]]).optional(), service: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/).optional(),
  buildPack: z.enum(['nixpacks', 'railpack', 'static', 'dockerfile', 'dockercompose']).optional(), port: z.number().int().min(1).max(65535).optional(),
};

defineTool({
  name: 'coolify.plan', title: 'Plan a build in Coolify', risk: 'read', action: 'read', timeoutMs: 60_000,
  description: 'Turn the person’s sentence ("make me a Next.js app with Supabase from my GitHub repo") into the steps Unit7 would take through the Coolify on their server: project, environment, app, database or one-click service (Supabase…), wiring their settings into the app, domain, deploy. Reuses what exists. Changes nothing. Returns the steps, the card the person will see, and `missing` (like the repo) to ask for first. Then call coolify.build with the same words.',
  input: z.object(WISH),
  async run(ctx, i) {
    const s = coolifyServer(ctx, i.serverId);
    const p = await makePlan(need(ctx, s).api, s, parseWish(i));
    return { server: s.name, ready: !p.intent.missing.length, missing: p.intent.missing, steps: p.steps.map((x, n) => `${n + 1}. ${x.title}`), card: p.card, confirm: confirmMode(ctx, p.intent.environment) };
  },
});

// a step's input with the names earlier steps made ('$project', '$app') filled in
function fill(input: Record<string, unknown>, made: Record<string, string>) {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('$') ? made[v.slice(1)] : v]));
}

defineTool({
  name: 'coolify.build', title: 'Build it in Coolify', risk: 'read', action: 'read', timeoutMs: 75 * 60_000,
  description: 'Build what the person asked for through the Coolify on their server, from their sentence (same input as coolify.plan). In Unit7’s ask box it first shows them the whole plan as ONE card (every change and how to undo it) and waits for Build it, unless autonomy says otherwise; elsewhere, show them coolify.plan’s card and pass confirmed once they say yes. Then it runs each step as its own Unit7 action (same approvals and autonomy as calling it alone; this tool changes nothing by itself) and stops at the first that doesn’t work, saying what was done and what to do next. Database passwords and Supabase keys go straight into the app’s settings in Coolify, never into the chat. Running it again reuses what’s already there.',
  input: z.object({ ...WISH, confirmed: z.boolean().default(false).describe('Only outside the ask box: the person saw the plan and said yes.') }),
  async run(ctx, i) {
    const s = coolifyServer(ctx, i.serverId);
    const p = await makePlan(need(ctx, s).api, s, parseWish(i));
    const steps = p.steps.map((x, n) => `${n + 1}. ${x.title}`);
    if (p.intent.missing.length) return { built: false, missing: p.intent.missing, steps, note: 'Ask the person for what’s missing (a picker or a short form), then call coolify.build again with it.' };
    const c = confirmMode(ctx, p.intent.environment);
    if (c.mode === 'needs' && !i.confirmed) return { built: false, needsConfirm: true, card: p.card, steps, note: 'Show the person this plan in your own words, and call again with confirmed: true once they say yes.' };
    if (c.mode === 'ask') {
      const a = await ask(ctx, p.card);
      if (a.ok !== true) return { built: false, steps, ...(a.ok === false ? { declined: true, note: 'They said not now. Nothing was changed.' } : a) };
    }
    // run: each step through the gate, shown in the thread as it goes
    const show = threadFor(ctx);
    const made: Record<string, string> = {};
    const done: Record<string, unknown>[] = [];
    const undo: string[] = [];
    let url: string | undefined;
    for (const [n, st] of p.steps.entries()) {
      const input = fill(st.input, made);
      const msg = { id: id('step'), role: 'tool' as const, content: { tool: st.tool, title: st.title, input, status: 'running' }, created_at: stamp() };
      show?.(msg);
      ctx.progress(`Step ${n + 1} of ${p.steps.length}: ${st.title}`);
      const r = await execute(ctx.app, ctx.orgId, ctx.actor, st.tool, input, { reason: `build: ${i.goal.slice(0, 120)}`, signal: ctx.signal, conversationId: ctx.conversationId, onProgress: (m) => ctx.progress(m) });
      const out = r.status === 'ok' ? r.output as Record<string, any> : undefined;
      // a deploy that ran but didn't go live is a failed step too
      const why = r.status === 'error' ? r.error.message : r.status === 'denied' ? r.why : r.status === 'approval_required' ? r.why
        : out && st.tool === 'coolify.control' && !/^finished/.test(String(out.status)) ? `The deploy ended as ${out.status}.` : undefined;
      show?.({ ...msg, content: { ...msg.content, ...(r.status === 'ok' ? { status: why ? 'error' : 'ok', output: r.output, durationMs: r.durationMs, ...(why && { error: why }) }
        : r.status === 'approval_required' ? { status: 'approval_required', why: r.why, approvalId: r.approvalId, approvalState: 'pending' }
        : { status: r.status === 'denied' ? 'denied' : 'error', error: why }) } });
      if (why) {
        return {
          built: false, done, failed: { step: st.title, why, ...(r.status === 'approval_required' && { approvalId: r.approvalId }), ...(out?.logTail && { untrusted: out.untrusted, logTail: out.logTail }) },
          next: r.status === 'approval_required' ? 'It waits for a person’s approval (the card above, or Approvals). Once it’s approved, ask me to carry on: what’s done is reused.'
            : r.status === 'denied' ? 'Unit7’s settings don’t allow this step here. A person can change autonomy for the server, or do it themselves.'
            : out?.logTail ? 'The build log’s end is above (coolify.logs with the deployment has all of it). Fix the cause, then ask me to build again: what’s done is reused.'
            : 'Fix that, then ask me to build again: what’s done is reused, nothing is made twice.',
          ...(undo.length && { undo }),
        };
      }
      for (const [as, field] of Object.entries(st.keep ?? {})) if (typeof out?.[field] === 'string') made[as] = out[field];
      if (typeof out?.undo === 'string') undo.push(out.undo);
      if (st.tool === 'coolify.create_app' && out?.domains?.[0]) url ??= `https://${out.domains[0]}`;
      if (st.tool === 'coolify.set_domain' && p.intent.domain) url = `https://${p.intent.domain}`;
      done.push({ step: st.title, ...(out?.reused && { reused: true }), ...(out?.wired?.length && { wired: out.wired }), ...(out?.status && { status: out.status }) });
    }
    ctx.emit('coolify.built', `Built ${p.intent.name} on ${s.name} through Coolify${url ? ` at ${url.replace(/^https?:\/\//, '')}` : ''}`, { severity: 'success', resource: s.id });
    return {
      built: true, done, ...(url && { url }), undo,
      ...(p.intent.domain && { next: `Point ${p.intent.domain} at ${s.host} (an A record; domain.point can do it), then Coolify turns on HTTPS.` }),
    };
  },
});
