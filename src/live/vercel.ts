// Vercel: make the project, send the files, let Vercel build them, and wait until it's really live.
//   POST /v11/projects, POST /v13/deployments (answers missing_files until they're sent), POST /v2/files, GET /v13/deployments/{id}
// vercel.com/docs/rest-api. Only hashes go first, so a redeploy sends just what changed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bearerFor } from '../connectors/mcp-oauth.ts';
import { vc, vercel, vercelBase } from '../connectors/clouds.ts';
import { assertReachable } from '../netguard.ts';
import { Unit7Error } from '../errors.ts';
import type { Ctx } from '../tools/runtime.ts';
import { accountsOf, addHost, type Host, type Put, type Ref, type Tuned } from './hosts.ts';

export const liveTiming = { pollMs: 3000, buildMs: 25 * 60_000, answerMs: 15_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAMEWORK: Record<string, string | null> = { next: 'nextjs', vite: 'vite', astro: 'astro', nuxt: 'nuxtjs', sveltekit: 'sveltekit', remix: 'remix', cra: 'create-react-app', gatsby: 'gatsby', angular: 'angular', static: null };

type Sent = { status: number; data: any };
async function send(ctx: Ctx, acc: string, path: string, o: { method?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string>; team?: string; query?: Record<string, string> } = {}): Promise<Sent> {
  const token = await bearerFor(ctx, 'vercel', acc);
  await assertReachable(new URL(vercelBase()).hostname);
  const q = new URLSearchParams({ ...(o.team && { teamId: o.team }), ...o.query });
  const res = await fetch(`${vercelBase()}${path}${q.size ? `?${q}` : ''}`, {
    method: o.method ?? (o.body || o.raw ? 'POST' : 'GET'), signal: AbortSignal.timeout(180_000),
    headers: { authorization: `Bearer ${token}`, ...(o.raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...o.headers },
    body: o.raw ? new Uint8Array(o.raw) : o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const fail = (what: string, r: Sent) => new Unit7Error('vercel_error', `Vercel refused to ${what}: ${r.data?.error?.message ?? r.status}`, r.status === 403 ? 403 : 502);

// a person's own scope on Vercel, or their default team where the account has moved to teams
async function scopeOf(ctx: Ctx, acc: string, team?: string) {
  if (team) return team;
  const me = await vc<{ user?: { defaultTeamId?: string | null } }>(ctx, acc, '/v2/user').catch(() => undefined);
  return me?.user?.defaultTeamId ?? undefined;
}

const settingsOf = (t?: Tuned) => ({ ...(t?.buildCommand && { buildCommand: t.buildCommand }), ...(t?.staticDir && { outputDirectory: t.staticDir }) });

async function project(ctx: Ctx, p: Put, acc: string, team: string | undefined) {
  const found = await send(ctx, acc, `/v9/projects/${encodeURIComponent(p.name)}`, { team });
  if (found.status === 200) {
    if (!p.update) throw new Unit7Error('already_exists', `${p.name} already exists on this Vercel account. Choose another name, or say you want to update it.`, 409);
    return { id: String(found.data.id), notes: [] as string[] };
  }
  const framework = FRAMEWORK[p.site.detection.stack];
  const base = { name: p.name, ...(framework !== undefined && { framework }), ...settingsOf(p.tuned) };
  const repo = p.site.repo && { gitRepository: { type: 'github', repo: `${p.site.repo.owner}/${p.site.repo.name}` } };
  let made = await send(ctx, acc, '/v11/projects', { team, body: { ...base, ...repo } });
  const notes: string[] = [];
  // linking needs Vercel's GitHub app on that repo. The site can still go live from the files, just without deploy on push
  if (repo && made.status >= 400) { notes.push('Vercel’s GitHub app can’t reach this repo, so a push won’t deploy by itself yet. Install it at https://github.com/apps/vercel to turn that on.'); made = await send(ctx, acc, '/v11/projects', { team, body: base }); }
  if (made.status >= 400) throw fail('create the project', made);
  return { id: String(made.data.id), notes, linked: !!repo && !notes.length };
}

async function upload(ctx: Ctx, acc: string, team: string | undefined, want: Set<string>, bySha: Map<string, string>) {
  const queue = [...want];
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (let sha = queue.pop(); sha; sha = queue.pop()) {
      const abs = bySha.get(sha);
      if (!abs) throw new Unit7Error('vercel_error', 'Vercel asked for a file Unit7 didn’t offer.', 502);
      const raw = readFileSync(abs);
      const r = await send(ctx, acc, '/v2/files', { raw, team, headers: { 'x-vercel-digest': sha, 'x-now-digest': sha, 'x-now-size': String(raw.length) } });
      if (r.status >= 400) throw fail('take a file', r);
    }
  }));
}

export async function vercelLogs(ctx: Ctx, r: Ref) {
  const acc = r.place.accountId!;
  const team = await scopeOf(ctx, acc, r.team);
  const got = await send(ctx, acc, `/v3/deployments/${encodeURIComponent(r.deployment ?? r.project)}/events`, { team, query: { limit: '300', direction: 'backward', builds: '1' } });
  if (got.status >= 400) throw fail('share the build log', got);
  const rows = (Array.isArray(got.data) ? got.data : got.data?.events ?? []) as { text?: string; payload?: { text?: string } }[];
  return rows.map((e) => String(e.text ?? e.payload?.text ?? '').trim()).filter(Boolean).slice(-120);
}

async function live(ctx: Ctx, acc: string, team: string | undefined, id: string, place: Ref['place']) {
  const end = Date.now() + liveTiming.buildMs;
  let said = '';
  while (Date.now() < end) {
    const d = await send(ctx, acc, `/v13/deployments/${encodeURIComponent(id)}`, { team });
    if (d.status >= 400) throw fail('say how the build is going', d);
    const state = String(d.data.readyState ?? d.data.status ?? '');
    if (state !== said) ctx.progress(`Vercel: ${(said = state).toLowerCase()}`);
    if (state === 'READY') return d.data as { url: string; alias?: string[] };
    if (state === 'ERROR' || state === 'CANCELED') {
      const tail = await vercelLogs(ctx, { place, project: id, deployment: id, team }).catch(() => []);
      throw new Unit7Error('build_failed', `Vercel couldn’t build it: ${d.data.errorMessage ?? d.data.errorCode ?? state.toLowerCase()}`, 502, { logTail: tail.slice(-40).join('\n') });
    }
    await sleep(liveTiming.pollMs);
  }
  throw new Unit7Error('build_slow', 'The build is still running after 25 minutes. It may finish by itself: check it with live.status.', 504);
}

export const vercelHost: Host = addHost({
  id: 'vercel', name: 'Vercel', builds: true, pushes: true, tunes: true,
  price: 'Free on Hobby, for personal projects. Business use needs Pro, $20 a month per person.',
  places: (ctx) => accountsOf(ctx, 'vercel', 'vercel'),
  fit(site) {
    const d = site.detection;
    if (d.dockerfile || d.builder === 'compose') return { ok: false, why: 'Vercel doesn’t run Docker. Your own server does.' };
    if (!(d.stack in FRAMEWORK) && !d.staticDir) return { ok: false, why: `Vercel runs websites and short functions, not an always-on ${d.stack} server.` };
    return { ok: true, best: d.stack === 'next', why: d.stack === 'next' ? 'Vercel makes Next.js, and it builds it for you.' : 'It builds it for you, with HTTPS and a free address.' };
  },
  async put(ctx, p) {
    const acc = p.place.accountId!, team = await scopeOf(ctx, acc, p.team), d = p.site.detection;
    ctx.progress('Getting the project ready on Vercel…');
    const pj = await project(ctx, p, acc, team);
    if (p.env.length) await vercel.setEnv(ctx, acc, pj.id, team, p.env);
    // Vercel builds it, so an old build folder would only be sent for nothing
    const files = p.site.files.filter((f) => !d.buildCommand || !/^(dist|build|out)\//.test(f.path));
    const bySha = new Map<string, string>();
    const list = files.map((f) => { const sha = createHash('sha1').update(readFileSync(f.abs)).digest('hex'); bySha.set(sha, f.abs); return { file: f.path, sha, size: f.size }; });
    const framework = FRAMEWORK[d.stack];
    const body = { name: p.name, project: pj.id, target: 'production', files: list, projectSettings: { ...(framework !== undefined && { framework }), ...settingsOf(p.tuned) } };
    ctx.progress(`Sending ${list.length} file${list.length === 1 ? '' : 's'} to Vercel…`);
    let made: Sent | undefined;
    for (let tries = 0; tries < 5; tries++) {
      made = await send(ctx, acc, '/v13/deployments', { team, body, query: { skipAutoDetectionConfirmation: '1' } });
      if (made.status < 400) break;
      const missing = made.data?.error?.missing as string[] | undefined;
      if (made.data?.error?.code !== 'missing_files' || !missing?.length) throw fail('start the build', made);
      await upload(ctx, acc, team, new Set(missing), bySha);
    }
    if (!made || made.status >= 400) throw fail('start the build', made ?? { status: 502, data: {} });
    const id = String(made.data.id);
    const done = await live(ctx, acc, team, id, p.place);
    const host = done.alias?.[0] ?? done.url;
    return { url: `https://${host}`, project: pj.id, deployment: id, dashboard: `https://vercel.com/dashboard`, notes: pj.notes, autoDeploy: !!pj.linked, point: { vercel: { accountId: acc, project: pj.id, ...(team && { team }) } } };
  },
  logs: vercelLogs,
  async env(ctx, r, op) {
    const acc = r.place.accountId!, team = await scopeOf(ctx, acc, r.team);
    if (op.set?.length) await vercel.setEnv(ctx, acc, r.project, team, op.set);
    const have = await vercel.env(ctx, acc, r.project, team);
    for (const key of op.unset ?? []) {
      const row = have.find((e) => e.key === key) as { id?: string } | undefined;
      if (!row?.id) continue;
      const out = await send(ctx, acc, `/v9/projects/${encodeURIComponent(r.project)}/env/${encodeURIComponent(row.id)}`, { method: 'DELETE', team });
      if (out.status >= 400) throw fail('remove a setting', out);
    }
    return (await vercel.env(ctx, acc, r.project, team)).map((e) => ({ key: e.key }));
  },
});
