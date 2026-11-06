// `unit7 deploy`: tar the current folder (respecting .gitignore-ish excludes), upload it to Unit7,
// and deploy. No git needed — the folder is the source.
import { requireConfig } from './client.ts';
import { packFolder } from '../connectors/folder.ts';

export async function deployFolder(serviceId: string, dir: string) {
  const c = requireConfig();
  process.stdout.write('Packing your folder…\n');
  const body = await packFolder(dir).catch((e: Error) => { console.error(e.message); process.exit(1); });

  process.stdout.write(`Uploading ${(body.length / 1024 / 1024).toFixed(1)} MB…\n`);
  const up = await fetch(`${c.url}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/gzip' }, body });
  const upJson = await up.json().catch(() => null) as any;
  if (!up.ok) { console.error(`Upload failed: ${upJson?.error?.message ?? up.status}`); process.exit(1); }

  process.stdout.write('Deploying…\n');
  const { tool } = await import('./client.ts');
  const out = await tool('deployment.create', { serviceId, source: { type: 'upload', uploadId: upJson.uploadId } }, { config: c, quiet: true });
  console.log(`✓ ${out.status}${out.url ? ` — ${out.url}` : ''} (deploy #${out.number})`);
}
