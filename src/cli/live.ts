// `unit7 live`: put the folder you're in on the internet. It's your folder and your terminal, so what's sent is what you asked for.
import { requireConfig, tool } from './client.ts';
import { packFolder } from '../connectors/folder.ts';

export async function live(dir: string, o: { to?: string; name?: string; domain?: string; update?: boolean }) {
  const c = requireConfig();
  process.stdout.write('Packing your folder…\n');
  const body = await packFolder(dir, undefined, { keepBuild: true }).catch((e: Error) => { console.error(e.message); process.exit(1); });
  const up = await fetch(`${c.url}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/gzip' }, body });
  const j = await up.json().catch(() => null) as { uploadId?: string; error?: { message?: string } } | null;
  if (!up.ok || !j?.uploadId) { console.error(`Upload failed: ${j?.error?.message ?? up.status}`); process.exit(1); }
  const out = await tool('live.put', { uploadId: j.uploadId, to: o.to, name: o.name, domain: o.domain, update: !!o.update }, { config: c, quiet: true });
  console.log(`✓ Live: ${out.url}`);
  for (const n of out.notes ?? []) console.log(`  ${n}`);
}
