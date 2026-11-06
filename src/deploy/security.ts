// Security at deploy. Two scanners, both run as containers on the server (nothing to install):
//  - gitleaks, during the deploy, on the source: a real credential committed to the code blocks the
//    deploy (a placeholder in a test, an example file or the docs only warns).
//  - trivy, after the deploy is live, on the built image (OS packages and npm/pip/go dependencies):
//    fixable critical/high vulnerabilities become a suggestion. Warden re-scans weekly.
// A scanner that can't run (no network, pull fails) never blocks a deploy: it's logged as skipped.
import type { Ctx } from '../tools/runtime.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import { run } from '../db.ts';

export interface Leak { rule: string; file: string; line: number }

// placeholders live here; real keys don't
const HARMLESS_PATH = /(^|\/)(tests?|spec|__tests__|__mocks__|fixtures?|examples?|samples?|mocks?|docs?)\/|\.(example|sample|template)(\.|$)|(^|\/)\.env\.(example|sample|template|defaults)$|\.(md|mdx|txt)$/i;
const NOISY_RULE = /^generic-api-key$/; // gitleaks' catch-all fires on hashes and IDs; warn, don't block

export function classifyLeaks(found: Leak[]): { block: Leak[]; warn: Leak[] } {
  const block: Leak[] = [], warn: Leak[] = [];
  for (const l of found) (HARMLESS_PATH.test(l.file) || NOISY_RULE.test(l.rule) ? warn : block).push(l);
  return { block, warn };
}

// gitleaks over the source folder. Exit 0 = clean, 1 = findings; anything else = couldn't scan.
export async function scanSecrets(ctx: Ctx, s: ServerRow, dir: string, log: (m: string) => void): Promise<{ block: Leak[]; warn: Leak[] } | undefined> {
  // pinned: the CLI changes between versions (8.30 writes nothing to "--report-path /dev/stdout"; "-" works)
  const r = await ssh(ctx.app).exec(s, script(
    'docker run --rm -v "$1":/repo:ro zricethezav/gitleaks:v8.30.1 dir /repo --report-format json --report-path - --exit-code 1 --redact --no-banner --log-level error 2>/dev/null',
    dir), { timeoutMs: 180_000, signal: ctx.signal });
  if (r.code !== 0 && r.code !== 1) { log('Secret scan skipped (the scanner could not run).'); return undefined; }
  let rows: { RuleID: string; File: string; StartLine: number }[] = [];
  try { rows = JSON.parse(r.stdout.trim() || (r.code === 0 ? '[]' : 'x')); } catch {
    // "found something" with no readable report must never count as clean
    log('Secret scan skipped (the report could not be read).'); return undefined;
  }
  const res = classifyLeaks(rows.map((x) => ({ rule: x.RuleID, file: x.File.replace(/^\/repo\//, ''), line: x.StartLine })));
  log(res.block.length ? `Secret scan: ${res.block.length} credential${res.block.length > 1 ? 's' : ''} found in the code.` : res.warn.length ? `Secret scan: clean (${res.warn.length} placeholder${res.warn.length > 1 ? 's' : ''} ignored).` : 'Secret scan: clean.');
  return res;
}

// Is any value Unit7 manages for this app (a connection key, a database password inside a URL) written in
// the code? The values reach the server over stdin only; only the positions of matches come back.
export async function findManagedLeaks(ctx: Ctx, s: ServerRow, dir: string, values: string[]): Promise<number[]> {
  const usable = values.map((v, i) => ({ v, i })).filter((x) => x.v.length >= 12 && !/[\r\n]/.test(x.v));
  if (!usable.length) return [];
  const r = await ssh(ctx.app).exec(s, script('n=0; while IFS= read -r v; do [ -n "$v" ] && grep -rqF -- "$v" "$1" 2>/dev/null && echo "$n"; n=$((n+1)); done', dir), { stdin: usable.map((x) => x.v).join('\n') + '\n', timeoutMs: 120_000 });
  return r.stdout.split('\n').filter(Boolean).map((n) => usable[Number(n)]?.i).filter((i): i is number => i !== undefined);
}

export interface Vuln { id: string; pkg: string; installed: string; fixed: string; severity: 'CRITICAL' | 'HIGH'; title?: string }
export interface ImageReport { critical: number; high: number; top: Vuln[]; scannedAt: string }

// trivy's JSON → counts plus the worst few, one line per package
export function summarizeTrivy(json: string): ImageReport {
  const doc = JSON.parse(json) as { Results?: { Vulnerabilities?: { VulnerabilityID: string; PkgName: string; InstalledVersion: string; FixedVersion?: string; Severity: string; Title?: string }[] }[] };
  const all: Vuln[] = [];
  for (const res of doc.Results ?? []) for (const v of res.Vulnerabilities ?? []) {
    if ((v.Severity === 'CRITICAL' || v.Severity === 'HIGH') && v.FixedVersion) all.push({ id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion, severity: v.Severity, title: v.Title });
  }
  const seen = new Set<string>();
  const top = all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'CRITICAL' ? -1 : 1)).filter((v) => !seen.has(v.pkg) && seen.add(v.pkg)).slice(0, 8);
  return { critical: all.filter((v) => v.severity === 'CRITICAL').length, high: all.filter((v) => v.severity === 'HIGH').length, top, scannedAt: new Date().toISOString() };
}

// trivy over a built image, cached between runs (its vulnerability database is large).
export async function scanImage(ctx: Ctx, s: ServerRow, image: string): Promise<ImageReport | undefined> {
  const r = await ssh(ctx.app).exec(s, script(
    'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v unit7-trivy-cache:/root/.cache/ aquasec/trivy:latest image --severity CRITICAL,HIGH --ignore-unfixed --format json --quiet --timeout 15m "$1" 2>/dev/null',
    image), { timeoutMs: 20 * 60_000 });
  if (r.code !== 0) return undefined;
  try { return summarizeTrivy(r.stdout); } catch { return undefined; }
}

// Scan a deployment's image and keep the report on the deployment (what suggestions read).
export async function scanDeployment(ctx: Ctx, s: ServerRow, deploymentId: string, image: string, serviceName: string) {
  const rep = await scanImage(ctx, s, image);
  if (!rep) return undefined;
  run(ctx.db, `UPDATE deployments SET plan = json_patch(plan, ?) WHERE id = ?`, JSON.stringify({ security: rep }), deploymentId);
  if (rep.critical + rep.high) ctx.emit('security.vulnerable', `${serviceName}: ${rep.critical} critical and ${rep.high} high vulnerabilities with fixes available`, { severity: 'warning' });
  return rep;
}
