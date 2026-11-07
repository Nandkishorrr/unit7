// What several hosts share: one call that keeps the status, a wait until the host is done, a site's finished files, a clean
// copy of a site, and a .zip.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { Repo } from '../connectors/github.ts';
import { Unit7Error } from '../errors.ts';
import { assertReachable } from '../netguard.ts';
import type { Ctx } from '../tools/runtime.ts';
import type { Put } from './hosts.ts';
import type { Site, SiteFile } from './source.ts';
import { liveTiming } from './vercel.ts';

export type Sent = { status: number; data: any };
export async function send(url: string, o: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: Buffer } = {}): Promise<Sent> {
  await assertReachable(new URL(url).hostname);
  const res = await fetch(url, {
    method: o.method ?? (o.body !== undefined || o.raw ? 'POST' : 'GET'), signal: AbortSignal.timeout(300_000),
    headers: { accept: 'application/json', ...(o.body !== undefined && { 'content-type': 'application/json' }), ...o.headers },
    body: o.raw ? new Uint8Array(o.raw) : o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  try { return { status: res.status, data: text ? JSON.parse(text) : {} }; } catch { return { status: res.status, data: text }; }
}
// a log kept at an address the host gave
export async function textOf(url: string) {
  await assertReachable(new URL(url).hostname);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return res.ok ? res.text() : '';
}

// Asks until the host says it's finished, saying each new state. ask throws when it failed.
export async function until<T>(ctx: Ctx, who: string, ask: () => Promise<{ state: string; done?: T }>, ms = liveTiming.buildMs): Promise<T> {
  const end = Date.now() + ms;
  let said = '';
  while (Date.now() < end) {
    ctx.signal.throwIfAborted();
    const { state, done } = await ask();
    if (state !== said) ctx.progress(`${who}: ${(said = state)}`);
    if (done !== undefined) return done;
    await new Promise((r) => setTimeout(r, liveTiming.pollMs));
  }
  throw new Unit7Error('build_slow', `${who} is still working after ${Math.round(ms / 60_000)} minutes. It may finish by itself: look at it with live.logs.`, 504);
}

// the files a visitor gets, index.html at the top: a plain site as it is, or what a build left in its output folder
export function finished(site: Site): SiteFile[] | undefined {
  const dir = site.detection.staticDir, from = dir === '.' ? '' : `${dir}/`;
  const files = dir ? site.files.filter((f) => f.path.startsWith(from)).map((f) => ({ ...f, path: f.path.slice(from.length) })) : [];
  return files.some((f) => f.path === 'index.html') ? files : undefined;
}

// finished files go on the internet as they are, so a key in one stops it, as it does in a plain website
export function publicFiles(site: Site) {
  const dir = site.detection.staticDir, keys = site.secrets.filter((s) => dir === '.' || s.file.startsWith(`${dir}/`));
  if (keys.length) throw new Unit7Error('keys_in_site', `Stopped: these files would put secret keys on the internet: ${keys.slice(0, 5).map((s) => `${s.file} (${s.kinds.join(', ')})`).join('; ')}. Take them out, then run this again.`, 400);
  return finished(site)!;
}

// a throwaway folder with only what may leave this computer, for a tool that reads a whole folder
export function cleanCopy(site: Site) {
  const dir = mkdtempSync(join(tmpdir(), 'unit7-send-'));
  for (const f of site.files) { mkdirSync(dirname(join(dir, f.path)), { recursive: true }); cpSync(f.abs, join(dir, f.path)); }
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// a .zip with these files at its top (ZIP's plain layout: each file with a header, then a list of them all)
export function zipOf(files: SiteFile[]): Buffer {
  const body: Buffer[] = [], list: Buffer[] = [];
  let at = 0;
  for (const f of files) {
    const raw = readFileSync(f.abs), packed = deflateRawSync(raw), name = Buffer.from(f.path);
    const head = Buffer.alloc(30), item = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50, 0); item.writeUInt32LE(0x02014b50, 0); item.writeUInt16LE(20, 4);
    for (const [b, o] of [[head, 4], [item, 6]] as const) {
      b.writeUInt16LE(20, o); b.writeUInt16LE(0x0800, o + 2); b.writeUInt16LE(8, o + 4); b.writeUInt16LE(0x21, o + 8); // version, utf-8 names, deflate, 1980-01-01
      b.writeUInt32LE(crc32(raw), o + 10); b.writeUInt32LE(packed.length, o + 14); b.writeUInt32LE(raw.length, o + 18); b.writeUInt16LE(name.length, o + 22);
    }
    item.writeUInt32LE(at, 42);
    body.push(head, name, packed); list.push(item, name);
    at += 30 + name.length + packed.length;
  }
  const end = Buffer.alloc(22), names = Buffer.concat(list);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(names.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...body, names, end]);
}

// the one a person meant: the one they named, or the only one there is
export function one(what: string, names: string[], said?: string) {
  if (said && names.includes(said)) return said;
  const list = names.slice(0, 8).join(', ');
  if (said) throw new Unit7Error('not_found', `${said} isn’t one of your ${what}: ${list}.`, 404);
  if (names.length === 1) return names[0]!;
  throw names.length ? new Unit7Error('choose_one', `This account has several ${what}: ${list}. Say which with team.`, 400) : new Unit7Error('not_found', `This account has no ${what} yet.`, 404);
}

// a project made of n parts (a/b/c), each safe in a URL path
export function parts(project: string, n = 1) {
  const p = project.split('/');
  if (p.length !== n || p.some((x) => !/^[\w.-]+$/.test(x) || /^\.+$/.test(x))) throw new Unit7Error('invalid_input', `“${project.slice(0, 120)}” isn’t a project here. Use the project live.put gave.`, 400);
  return p;
}

export const keptIn = (p: Put, r: Repo) => (p.site.repo && !p.site.home ? [] : [`The code is in the private repo ${r.owner}/${r.name}.`]);
export const taken = (host: string, name: string) => new Unit7Error('already_exists', `${name} already exists on ${host}. Choose another name, or say you want to update it.`, 409);
