import { loadConfig } from './client.ts';

export async function doctor() {
  const c = loadConfig();
  if (!c) { console.log('✗ Not configured. Run `unit7 login --url <url> --token <token>`.'); process.exit(1); }
  console.log(`Unit7 URL: ${c.url}`);
  try {
    const h = await (await fetch(`${c.url}/api/health`)).json() as any;
    console.log(`✓ Server reachable (v${h.version})`);
  } catch (e) { console.log(`✗ Can't reach the server: ${(e as Error).message}`); process.exit(1); }
  try {
    const me = await (await fetch(`${c.url}/api/me`, { headers: { authorization: `Bearer ${c.token}` } })).json() as any;
    if (me.error) { console.log(`✗ Token rejected: ${me.error.message}`); process.exit(1); }
    console.log(`✓ Authenticated as ${me.user.email} in ${me.org.name} (role: ${me.role})`);
    const g = await (await fetch(`${c.url}/api/graph`, { headers: { authorization: `Bearer ${c.token}` } })).json() as any;
    console.log(`  ${g.projects.length} project(s), ${g.servers.length} server(s), ${g.accounts.length} account(s)`);
  } catch (e) { console.log(`✗ ${(e as Error).message}`); process.exit(1); }
}
