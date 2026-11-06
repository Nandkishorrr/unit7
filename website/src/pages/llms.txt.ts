import { REPO_URL, SITE_URL } from '../site';

export const GET = () => new Response(`# Unit 7

> A free, open-source, self-hosted control room for servers, Coolify apps, domains, databases and backups. Made by Signull.

Unit 7 is early. Expect rough edges. The latest version is V2.1. It runs on macOS and Linux and needs Node 24.22 or newer.

You talk to it in plain words. It does the work on your real servers, and asks before anything risky. The web app, the command line and the MCP server all drive one engine, through one gate.

V2 checks and protects by itself, and proves its fixes. V2.1 adds Seven, an agent on shift. Work added since V2.1, such as Put this live, database tools, a file manager, server care and WordPress, is built and in testing. Every part is listed with its status.

- [Home](${SITE_URL}/): what Unit 7 does
- [V2](${SITE_URL}/v2/): what's in V2.1 and what's new since, with a status on every part
- [Open source](${SITE_URL}/open-source/): install, security model and FAQ
- [Source code](${REPO_URL}): Apache 2.0
`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
