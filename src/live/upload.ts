// A ZIP or a folder dropped in the browser, as a normal upload: unpacked into a throwaway folder, then packed like any other
// folder. A ZIP's words about itself count for nothing here: every name is checked, links are left out, and the bytes are
// counted as they come out, so a small file can't unpack into a full disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';
import type { App } from '../app.ts';
import { Unit7Error } from '../errors.ts';
import { detect } from '../connectors/detect.ts';
import { factsOf, inspectFolder, packFolder, saveUpload } from '../connectors/folder.ts';
import { LIMITS, leftOut, siteName } from './source.ts';

const inflate = promisify(inflateRaw);
export const dropLimits = { files: LIMITS.files, bytes: LIMITS.bytes };
// one file of what was dropped. size is only what it claims; read gets what's left of the limit and can't go past it
export interface Part { path: string; size: number; read(left: number): Promise<Buffer> }

const notZip = (why = 'That file isn’t a ZIP Unit7 can read. Make it again, or drop the folder instead.') => new Unit7Error('bad_zip', why, 400);
const tooBig = () => new Unit7Error('too_large', `That unpacks to more than ${Math.round(dropLimits.bytes / 1024 ** 3)} GB. Take out what the site doesn’t need, like videos or old builds.`, 413);
const tooMany = () => new Unit7Error('too_large', `That has more than ${dropLimits.files} files. Take out what the site doesn’t need, like node_modules.`, 413);

// a path that stays inside the site, whatever a ZIP or a browser says. Windows writers use backslashes, so they count too
export function cleanPath(raw: string) {
  const parts = raw.replaceAll('\\', '/').split('/').filter((p) => p && p !== '.');
  if (raw.includes('\0') || /^[/\\]/.test(raw) || /^[a-z]:/i.test(raw) || parts.includes('..')) throw new Unit7Error('unsafe_path', 'Stopped: a file in there would land outside the site, so nothing was saved. Make the ZIP again from the folder itself.', 400);
  return parts.join('/');
}

// The list at the end of a ZIP (its central directory) names every file. Reading that, not the local headers, also covers the
// ZIPs Finder makes, whose local headers leave the sizes out. Only stored and deflated files, the two any tool writes.
export function readZip(zip: Buffer): Part[] {
  const parts: Part[] = [];
  const end = zip.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (end < 0) throw notZip();
  try {
    let at = zip.readUInt32LE(end + 16);
    const stop = at + zip.readUInt32LE(end + 12);
    while (at < stop) {
      if (zip.readUInt32LE(at) !== 0x02014b50) throw notZip();
      const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16), packed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24);
      const nameLen = zip.readUInt16LE(at + 28), mode = zip.readUInt32LE(at + 38) >>> 16, local = zip.readUInt32LE(at + 42), name = zip.toString('utf8', at + 46, at + 46 + nameLen);
      at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
      const path = cleanPath(name); // before anything is skipped: one bad name means the whole ZIP is bad
      if (!path || name.endsWith('/') || (mode & 0o170000) === 0o120000 || leftOut(path)) continue; // a link is left out: nothing may point outside the site
      if (flags & 0x41) throw notZip('That ZIP has a password. Make it again without one.');
      if (method !== 0 && method !== 8) throw notZip('That ZIP uses a kind of compression Unit7 can’t read. Make it again with Finder’s Compress, or drop the folder instead.');
      if ([packed, size, local].includes(0xffffffff)) throw notZip('That ZIP is in the format for huge files, which Unit7 doesn’t read. Make it again smaller, or drop the folder instead.');
      if (zip.readUInt32LE(local) !== 0x04034b50) throw notZip();
      const from = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), raw = zip.subarray(from, from + packed);
      if (raw.length < packed) throw notZip();
      if (parts.push({ path, size, read: (left) => unpack(raw, method, crc, left) }) > dropLimits.files) throw tooMany();
    }
  } catch (e) { throw e instanceof Unit7Error ? e : notZip(); }
  return parts;
}

export async function unpack(raw: Buffer, method: number, crc: number, left: number) {
  const out = method === 0 ? raw : await inflate(raw, { maxOutputLength: left + 1 }).catch((e: NodeJS.ErrnoException) => { throw e.code === 'ERR_BUFFER_TOO_LARGE' ? tooBig() : notZip('That ZIP is damaged. Make it again.'); });
  if (out.length > left) throw tooBig();
  if (crc32(out) !== crc) throw notZip('That ZIP is damaged. Make it again.');
  return out;
}

// a folder of files from the browser: each path beside its file, in the same order
export function formParts(form: FormData): Part[] {
  const paths = form.getAll('path'), files = form.getAll('file');
  if (paths.length !== files.length || paths.some((p) => typeof p !== 'string') || files.some((f) => typeof f === 'string')) throw new Unit7Error('invalid_input', 'Send a ZIP, or the folder’s files with their paths.');
  const parts = (files as File[]).map((f, i): Part => ({ path: cleanPath(paths[i] as string), size: f.size, read: async (left) => { if (f.size > left) throw tooBig(); return Buffer.from(await f.arrayBuffer()); } })).filter((p) => p.path && !leftOut(p.path));
  if (parts.length > dropLimits.files) throw tooMany();
  return parts;
}

// a ZIP of a folder puts the folder's name on every path, and a dropped folder arrives the same way: the site starts inside it
const topOf = (parts: Part[]) => { const top = parts[0]?.path.split('/')[0]; return top && parts.every((p) => p.path.startsWith(`${top}/`)) ? top : undefined; };

// what each upload turned out to be, from Unit7's own look: the AI's folder card answers with this, never with what the browser
// says. A restart ends a card anyway, so memory is enough.
interface Seen { orgId: string; name: string; stack: string; runtime: string | null }
const seen = new Map<string, Seen>();
const remember = (uploadId: string, s: Seen) => { seen.set(uploadId, s); if (seen.size > 500) seen.delete(seen.keys().next().value!); };
export const dropOf = (uploadId: string, orgId: string) => { const s = seen.get(uploadId); return s?.orgId === orgId ? { uploadId, name: s.name, stack: s.stack, ...(s.runtime && { runtime: s.runtime }) } : undefined; };

export async function saveDrop(app: App, orgId: string, userId: string | null, parts: Part[], name = '') {
  if (!parts.length) throw new Unit7Error('empty_site', 'There are no files to put live in that.', 400);
  if (parts.reduce((n, p) => n + p.size, 0) > dropLimits.bytes) throw tooBig(); // only a claim, but it saves the work when it's honest
  const tmp = mkdtempSync(join(tmpdir(), 'unit7-drop-')), top = topOf(parts);
  try {
    let left = dropLimits.bytes;
    for (const p of parts) {
      const data = await p.read(left), to = join(tmp, top ? p.path.slice(top.length + 1) : p.path);
      left -= data.length;
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data);
    }
    const d = detect(factsOf(tmp)), buf = await packFolder(tmp, undefined, { keepBuild: true });
    const uploadId = saveUpload(app, orgId, userId, buf), site = siteName(name.replace(/\.zip$/i, '') || top || '');
    remember(uploadId, { orgId, name: site, stack: d.stack, runtime: d.runtime ?? null });
    return { uploadId, name: site, stack: d.stack, runtime: d.runtime ?? null, files: parts.length, size: buf.length };
  } catch (e) {
    if (e instanceof Unit7Error) throw e;
    if (/^E[A-Z]+$/.test((e as NodeJS.ErrnoException).code ?? '')) throw new Unit7Error('bad_zip', 'Unit7 couldn’t unpack that: two files in it clash, or a name is too long. Make it again from the folder itself.', 400);
    throw e;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// a folder a person picked on this computer: the same upload, and only what it is comes back, never where it was
export async function saveFolder(app: App, orgId: string, userId: string | null, path: string) {
  const f = inspectFolder(path, app.home), buf = await packFolder(f.path, undefined, { keepBuild: true });
  const uploadId = saveUpload(app, orgId, userId, buf), name = siteName(f.name);
  remember(uploadId, { orgId, name, stack: f.stack, runtime: f.runtime });
  return { uploadId, name, stack: f.stack, runtime: f.runtime, size: buf.length };
}
