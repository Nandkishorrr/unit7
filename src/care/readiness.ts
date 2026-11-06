// "Ready for real users 7/9": one checklist per project, every tick computed from what Unit7 has seen (never from what
// an AI says). Checks that don't apply drop out of the count (no database: no backup checks). Each unticked item says
// what's missing in plain words and carries one fix: a Unit7 tool run through the gate, a page to open, or a request
// for the person's AI on Home.
import { all, get, json, type DB } from '../db.ts';
import { archivedKeys } from '../archive.ts';
import { alertsVerified } from '../sentinel/phone.ts';

export type Fix = { tool: string; input: Record<string, unknown>; label: string } | { href: string; label: string } | { ask: string; label: string };
export interface Check { key: string; label: string; ok: boolean; detail: string; fix?: Fix }
export interface Readiness { projectId: string; name: string; done: number; total: number; ready: boolean; checks: Check[] }

const DBS = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];
// addresses a provider hands out: fine for testing, not a place to send real users
const TEST_HOST = /\.(sslip|nip)\.io$|\.(vercel\.app|netlify\.app|pages\.dev|workers\.dev|railway\.app|onrender\.com|fly\.dev|herokuapp\.com|web\.app|firebaseapp\.com|github\.io|ngrok-free\.app|ngrok\.app|azurewebsites\.net|appspot\.com|run\.app|amplifyapp\.com|surge\.sh|glitch\.me|replit\.app|coolify\.io|traefik\.me)$/i;
export const isTestHost = (host: string) => TEST_HOST.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host);
// ponytail: the last two labels, wrong for example.co.uk; the domain's own zone (when Unit7 knows it) wins
export const apexOf = (host: string, zone?: string | null) => (zone && host.endsWith(zone) ? zone : host.split('.').slice(-2).join('.')).toLowerCase();

interface Svc { id: string; name: string; kind: string; status: string; server_id: string | null; current_deployment_id: string | null; environment_id: string }
interface Dom { id: string; hostname: string; status: string; tls: string; zone: string | null }

export function readiness(db: DB, orgId: string, projectId: string, at = Date.now()): Readiness | undefined {
  const project = get<{ name: string }>(db, 'SELECT name FROM projects WHERE id = ? AND org_id = ?', projectId, orgId);
  if (!project) return undefined;
  const envs = all<{ id: string; name: string; kind: string; autonomy: number }>(db, 'SELECT id, name, kind, autonomy FROM environments WHERE project_id = ? AND org_id = ?', projectId, orgId);
  // the live copy is what real users meet; a project with no production yet is judged on what it has
  const scope = envs.some((e) => e.kind === 'production') ? envs.filter((e) => e.kind === 'production') : envs;
  const svcs = scope.flatMap((e) => all<Svc>(db, 'SELECT id, name, kind, status, server_id, current_deployment_id, environment_id FROM services WHERE environment_id = ?', e.id));
  const apps = svcs.filter((s) => !DBS.includes(s.kind)), dbs = svcs.filter((s) => DBS.includes(s.kind));
  const doms = svcs.flatMap((s) => all<Dom>(db, 'SELECT id, hostname, status, tls, zone FROM domains WHERE service_id = ?', s.id));
  const own = doms.filter((d) => !isTestHost(d.hostname));
  const watch = (host: string, kind: string) => get<{ status: string; detail: string | null; checked_at: string | null }>(db, 'SELECT status, detail, checked_at FROM watch WHERE org_id = ? AND host = ? AND kind = ?', orgId, host, kind);
  const day = new Date(at - 86400_000).toISOString(), month = new Date(at - 30 * 86400_000).toISOString();
  const checks: Check[] = [];
  const add = (key: string, label: string, ok: boolean, detail: string, fix?: Fix) => checks.push({ key, label, ok, detail, ...(!ok && fix && { fix }) });

  // 1. its own address
  if (apps.length) add('domain', 'Its own domain', own.length > 0, own.length ? own[0]!.hostname : doms.length ? `Only a test address so far (${doms[0]!.hostname})` : 'No web address yet',
    { ask: `Connect my own domain to ${project.name}`, label: 'Connect a domain' });

  // 2. HTTPS works on every address (the daily certificate check when there is one, else the domain's own check)
  if (doms.length) {
    const bad = doms.find((d) => { const w = watch(d.hostname, 'tls'); return w ? w.status !== 'ok' : d.tls !== 'active'; });
    add('https', 'HTTPS works', !bad, bad ? `${bad.hostname}: ${watch(bad.hostname, 'tls')?.detail ?? 'the certificate isn’t working yet'}` : 'Every address has a working certificate',
      bad && { tool: 'domain.check', input: { domainId: bad.id }, label: 'Check again' });
  }

  // 3. nobody can send email pretending to be the domain (SPF and DMARC, from the daily check)
  if (own.length) {
    const apexes = [...new Set(own.map((d) => apexOf(d.hostname, d.zone)))];
    const rows = apexes.map((a) => ({ a, w: watch(a, 'email') }));
    const unknown = rows.find((r) => !r.w), weak = rows.find((r) => r.w && r.w.status !== 'ok');
    add('email', 'Email can’t be faked', !unknown && !weak, weak ? `${weak.a}: ${weak.w!.detail ?? 'SPF or DMARC missing'}` : unknown ? `${unknown.a}: not checked yet` : 'SPF and DMARC set',
      weak ? { tool: 'domain.protect_email', input: { domain: weak.a }, label: 'Protect email' } : { tool: 'watch.check', input: { daily: true }, label: 'Check now' });
  }

  // 4. daily backups, and one proven to restore in the last 30 days
  if (dbs.length) {
    let missing: { detail: string; fix: Fix } | undefined;
    for (const d of dbs) {
      const scheduled = get(db, `SELECT 1 FROM backup_schedules WHERE service_id = ? AND frequency IN ('hourly', 'daily')`, d.id);
      const any = get(db, `SELECT 1 FROM backups WHERE service_id = ? AND status = 'done'`, d.id);
      const proven = get(db, `SELECT 1 FROM backups WHERE service_id = ? AND status = 'done' AND verify_ok = 1 AND verified_at > ?`, d.id, month);
      missing = !scheduled ? { detail: `${d.name}: no daily backups`, fix: { tool: 'backup.schedule', input: { serviceId: d.id, frequency: 'daily' }, label: 'Back up daily' } }
        : !any ? { detail: `${d.name}: no backup yet`, fix: { tool: 'backup.create', input: { serviceId: d.id }, label: 'Back up now' } }
        : !proven ? { detail: `${d.name}: no restore tested this month`, fix: { tool: 'backup.verify', input: { serviceId: d.id }, label: 'Test a restore' } } : undefined;
      if (missing) break;
    }
    add('backups', 'Daily backups, restore tested', !missing, missing?.detail ?? 'Backed up daily, and a restore worked', missing?.fix);

    // 5. a copy that survives the server
    const on = get<{ offsite: string }>(db, 'SELECT offsite FROM orgs WHERE id = ?', orgId)?.offsite !== 'off';
    let off: { detail: string; fix: Fix } | undefined = on ? undefined : { detail: 'Off-server copies are switched off', fix: { tool: 'backup.offsite_set', input: { on: true }, label: 'Turn them on' } };
    for (const d of off ? [] : dbs) {
      const last = get<{ id: string; offsite: string | null }>(db, `SELECT id, offsite FROM backups WHERE service_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`, d.id);
      const copy = json<{ at?: string; error?: string }>(last?.offsite, {});
      if (!last) off = { detail: `${d.name}: no backup to copy yet`, fix: { tool: 'backup.create', input: { serviceId: d.id }, label: 'Back up now' } };
      else if (!copy.at || copy.error) off = { detail: `${d.name}: the last backup is only on its server`, fix: { tool: 'backup.offsite_copy', input: { backupId: last.id }, label: 'Copy it off' } };
      if (off) break;
    }
    add('offsite', 'A copy off the server', !off, off?.detail ?? 'Each backup is also kept on this computer', off?.fix);
  }

  // 6. problems reach a phone
  const phone = alertsVerified(db, orgId); // only once the phone proved it gets them
  add('alerts', 'Phone alerts on', phone, phone ? 'Problems reach your phone' : 'Nothing tells you when it breaks', { href: '/connections#alerts', label: 'Set up phone alerts' });

  // 7. something checks from the outside that it answers
  if (doms.length) {
    const seen = doms.map((d) => ({ d, w: watch(d.hostname, 'site') })).find((x) => x.w?.checked_at && x.w.checked_at > day);
    add('uptime', 'An uptime check', !!seen, seen ? `${seen.d.hostname} is checked every 5 minutes` : 'Nobody checks that it answers', { tool: 'watch.check', input: { daily: false }, label: 'Check now' });
  }

  // 8. its errors are read (Unit7 reads a live app's logs every minute; a failing read means they aren't)
  const live = apps.filter((s) => s.server_id && s.current_deployment_id && get(db, `SELECT 1 FROM deployments WHERE id = ? AND status = 'live' AND container IS NOT NULL`, s.current_deployment_id));
  if (live.length) {
    const failing = live.find((s) => get<{ result: string }>(db, `SELECT result FROM audit WHERE org_id = ? AND tool = 'errors.scan' AND created_at > ? AND input LIKE ? ORDER BY created_at DESC LIMIT 1`,
      orgId, day, `%"serviceId":"${s.id}"%`)?.result === 'error');
    add('errors', 'Errors tracked', !failing, failing ? `${failing.name}: Unit7 can’t read its logs` : 'Unit7 reads its errors every minute', failing && { tool: 'errors.scan', input: { serviceId: failing.id }, label: 'Try again' });
  }

  // 9. a spending limit
  const budget = get<{ budget_monthly: number | null; budget_currency: string }>(db, 'SELECT budget_monthly, budget_currency FROM orgs WHERE id = ?', orgId);
  add('budget', 'A budget set', !!budget?.budget_monthly, budget?.budget_monthly ? `${budget.budget_monthly} ${budget.budget_currency} a month` : 'No warning before a bill runs away', { href: '/autopilot', label: 'Set a budget' });

  // 10. no real credential in the code (the secret scan of its last deploy from code)
  const built = apps.filter((s) => get(db, `SELECT 1 FROM deployments WHERE service_id = ? AND coalesce(json_extract(source, '$.type'), '') != 'image'`, s.id))
    .map((s) => ({ s, scan: get<{ log: string }>(db, `SELECT log FROM deployments WHERE service_id = ? AND log LIKE '%Secret scan%' ORDER BY number DESC LIMIT 1`, s.id)?.log.match(/Secret scan[^\n]*/g)?.at(-1) }));
  if (built.length) {
    const leak = built.find((x) => /credentials? found/.test(x.scan ?? '')), unscanned = built.find((x) => !x.scan || /skipped/.test(x.scan));
    add('secrets', 'No secrets in the code', !leak && !unscanned, leak ? `${leak.s.name}: a password or key is written in the code` : unscanned ? `${unscanned.s.name}: its code hasn’t been checked yet` : 'The last deploy’s code had no passwords or keys in it',
      leak ? { ask: `Help me move the secrets out of ${leak.s.name}'s code and change them`, label: 'Fix with AI' } : unscanned ? { ask: `Deploy ${unscanned.s.name} again so Unit7 checks its code for secrets`, label: 'Check with AI' } : undefined);
  }

  // 11. a person chose how much Unit7 does on its own here
  const chosen = scope.filter((e) => get(db, `SELECT 1 FROM audit WHERE org_id = ? AND environment_id = ? AND tool IN ('environment.policy', 'environment.earn') AND result = 'success'`, orgId, e.id));
  if (scope.length) add('autonomy', 'Autonomy chosen', chosen.length === scope.length, chosen.length === scope.length ? 'You chose how much Unit7 does alone' : 'Still on the default level', { href: '/autopilot', label: 'Choose a level' });

  const done = checks.filter((c) => c.ok).length;
  return { projectId, name: project.name, done, total: checks.length, ready: checks.length > 0 && done === checks.length, checks };
}

// every project not archived, for the cards' rings
export function allReadiness(db: DB, orgId: string, at = Date.now()) {
  const off = archivedKeys(db, orgId);
  return all<{ id: string }>(db, 'SELECT id FROM projects WHERE org_id = ? ORDER BY name', orgId).filter((p) => !off.has(p.id))
    .map((p) => readiness(db, orgId, p.id, at)!).map(({ checks: _c, ...r }) => r);
}
