import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { signup } from '../src/auth.ts';
import { execute, type Actor } from '../src/tools/runtime.ts';
import { run } from '../src/db.ts';
import type { Role } from '../src/policy.ts';
import '../src/tools/index.ts';

// tests must never find (and write test backups into) the real Google Drive / Dropbox on this computer
process.env.UNIT7_SYNC_HOME ??= mkdtempSync(join(tmpdir(), 'unit7-synchome-'));

export function testApp(): App {
  const home = mkdtempSync(join(tmpdir(), 'unit7-test-'));
  return createApp({ dbFile: ':memory:', home, masterKey: randomBytes(32) });
}

export async function testOrg(app: App, name = 'Ada') {
  const { userId, orgId } = await signup(app.db, { email: `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.com`, name, password: 'correct horse battery' });
  const human: Actor = { kind: 'user', id: userId, userId, name, role: 'owner' };
  const agent: Actor = { kind: 'agent', id: userId, userId, name: 'Unit7 agent', role: 'agent', agent: 'Unit7 agent' };
  const as = (actor: Actor) => (tool: string, input: unknown = {}, o = {}) => execute(app, orgId, actor, tool, input, o);
  return { orgId, userId, human, agent, h: as(human), a: as(agent), as, role: (role: Role): Actor => ({ ...human, role }) };
}

// unwrap an ok result or fail loudly with what came back
export function ok<T = any>(r: Awaited<ReturnType<typeof execute>>): T {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.output as T;
}

export const setAutonomy = (app: App, envId: string, autonomy: number) => run(app.db, 'UPDATE environments SET autonomy = ? WHERE id = ?', autonomy, envId);

// a stand-in bucket: path-style, signed requests only
export function fakeBucket() {
  const objects = new Map<string, Buffer>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    if (!/^AWS4-HMAC-SHA256 Credential=AKIDTEST1234\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(req.headers.authorization ?? '')) { res.writeHead(403); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
    const key = decodeURIComponent(req.url!);
    if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
    if (req.method === 'GET' || req.method === 'HEAD') { const o = objects.get(key); res.writeHead(o ? 200 : 404); return res.end(req.method === 'GET' ? o : undefined); }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });
  return new Promise<{ endpoint: string; objects: Map<string, Buffer>; close: () => void }>((r) => server.listen(0, '127.0.0.1', () => r({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, objects, close: () => server.close() })));
}

