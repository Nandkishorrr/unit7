// Any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, DigitalOcean Spaces, Wasabi, MinIO):
// put, get and delete objects with AWS Signature V4. Bodies stream from and to disk, so a large
// backup never sits in memory. Path-style URLs (endpoint/bucket/key) work with every one of them.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { request as https } from 'node:https';
import { request as http } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';

export interface Bucket { endpoint: string; bucket: string; region: string; accessKeyId: string; secret: string }

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const hex = (data: string) => createHash('sha256').update(data).digest('hex');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const objectPath = (bucket: string, key: string) => `/${enc(bucket)}/${key.split('/').map(enc).join('/')}`;

// The Authorization header for one request (headers are lowercase and include host, x-amz-date, x-amz-content-sha256)
export function signV4(o: { method: string; path: string; query?: string; headers: Record<string, string>; region: string; accessKeyId: string; secret: string; service?: string }) {
  const date = o.headers['x-amz-date']!, day = date.slice(0, 8), service = o.service ?? 's3';
  const names = Object.keys(o.headers).map((k) => k.toLowerCase()).sort();
  const canonical = [o.method, o.path, o.query ?? '', ...names.map((k) => `${k}:${o.headers[k]!.trim()}`), '', names.join(';'), o.headers['x-amz-content-sha256']!].join('\n');
  const scope = `${day}/${o.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secret}`, day), o.region), service), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', key).update(toSign).digest('hex')}`;
}

async function call(b: Bucket, method: 'PUT' | 'GET' | 'DELETE' | 'HEAD', key: string, o: { file?: string; out?: string; body?: Buffer } = {}) {
  const url = new URL(b.endpoint);
  await assertReachable(url.hostname);
  // an endpoint can sit under a path (a MinIO behind a proxy at /s3): it's part of every object's path
  const path = `${url.pathname.replace(/\/+$/, '')}${objectPath(b.bucket, key)}`;
  const length = o.file ? statSync(o.file).size : o.body?.length;
  const headers: Record<string, string> = { host: url.host, 'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
  const auth = signV4({ method, path, headers, region: b.region, accessKeyId: b.accessKeyId, secret: b.secret });
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = (url.protocol === 'http:' ? http : https)({ method, host: url.hostname, port: url.port || undefined, path, headers: { ...headers, authorization: auth, ...(length !== undefined && { 'content-length': String(length) }) }, timeout: 60_000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (o.out && status === 200) { pipeline(res, createWriteStream(o.out)).then(() => resolve({ status, text: '' }), reject); return; }
      let text = '';
      res.on('data', (d: Buffer) => { if (text.length < 4000) text += d.toString('utf8'); });
      res.on('end', () => resolve({ status, text }));
    });
    req.on('timeout', () => req.destroy(new Error('the storage didn’t answer for 60s')));
    req.on('error', reject);
    if (o.file) pipeline(createReadStream(o.file), req).catch(reject);
    else req.end(o.body);
  }).then((r) => {
    if (r.status >= 300 && !(method === 'DELETE' && r.status === 404)) {
      const why = /<Code>([^<]+)<\/Code>/.exec(r.text)?.[1] ?? `HTTP ${r.status}`;
      throw new Unit7Error('storage_error', `Backup storage said ${why}${/SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/.test(why) ? ' (check the access key, secret and bucket)' : ''}.`, r.status === 403 ? 403 : 502);
    }
    return r;
  });
}

export const s3 = {
  put: (b: Bucket, key: string, file: string) => call(b, 'PUT', key, { file }),
  get: (b: Bucket, key: string, out: string) => call(b, 'GET', key, { out }),
  del: (b: Bucket, key: string) => call(b, 'DELETE', key),
  // write, read back and delete a tiny object: proves the key, the secret and the bucket all work
  async test(b: Bucket) {
    const key = `unit7-check-${Date.now()}.txt`;
    await call(b, 'PUT', key, { body: Buffer.from('unit7') });
    await call(b, 'HEAD', key);
    await call(b, 'DELETE', key);
  },
};
