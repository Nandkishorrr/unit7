// Fakes the cloud tests share: a stateful fake API on 127.0.0.1 and an account straight into the vault (no live check).
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { run } from '../src/db.ts';
import type { App } from '../src/app.ts';

export type Req = { method: string; path: string; auth: string; body: string; raw: Buffer; headers: Record<string, string | string[] | undefined> };
export async function fakeApi(handler: (r: Req) => unknown) {
  const calls: Req[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks), r = { method: req.method!, path: req.url!, auth: String(req.headers.authorization ?? ''), body: raw.toString(), raw, headers: req.headers };
    calls.push(r);
    const out = handler(r);
    const [status, data] = Array.isArray(out) && typeof out[0] === 'number' ? out as [number, unknown] : out === undefined ? [404, { error: { code: 404, message: 'Not found.' } }] : [200, out];
    res.writeHead(status, { 'content-type': typeof data === 'string' && data.startsWith('<') ? 'text/xml' : 'application/json' }).end(typeof data === 'string' ? data : JSON.stringify(data));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, close: () => server.close() };
}
export function account(app: App, orgId: string, provider: string, value: string, name = provider) {
  const id = `acc_${randomBytes(6).toString('hex')}`, slug = `${provider}-${id.slice(4, 10)}`, ref = `credential://${provider}/${slug}/token`;
  run(app.db, `INSERT INTO accounts (id, org_id, provider, name, slug, meta, status) VALUES (?, ?, ?, ?, ?, ?, 'verified')`, id, orgId, provider, name, slug, JSON.stringify({ ref }));
  app.vault.put(orgId, ref, value, { kind: 'token', accountId: id });
  return id;
}

