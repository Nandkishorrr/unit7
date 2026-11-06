// The one Help section. `unit7 help` prints it, the web app's Help page renders it. Keep it short
// and plain: someone who has never touched a server should be able to follow it.

export interface HelpItem { say: string; does: string }
export interface HelpSection { title: string; intro?: string; items: HelpItem[] }

export const HELP: HelpSection[] = [
  {
    title: '1. Connect your AI (pick one)',
    intro: 'Choose the AI you want to work with. Easiest: Connections → Your AI → click Connect next to it. Or in a terminal:',
    items: [
      { say: 'unit7 connect', does: 'Shows the AI agents on this computer and asks which one to connect.' },
      { say: 'unit7 connect claude', does: 'Connect just Claude Code. Also: antigravity, cursor, windsurf, claude-desktop, codex.' },
      { say: 'unit7 agents', does: 'See which AI agents use Unit7.' },
      { say: 'unit7 disconnect cursor', does: 'Stop one agent using Unit7.' },
      { say: 'unit7 doctor', does: 'Check Unit7 is running and everything is connected.' },
      { say: 'unit7 password', does: 'Set your own login password for the web app.' },
    ],
  },
  {
    title: '2. Talk to it from your AI',
    intro: 'In Claude Code type /unit7 and what you want. In Antigravity, Cursor or any other agent, just ask and mention Unit7. Use any model you like: Sonnet 5.5 in Claude Code, Gemini 3.8 Flash in Antigravity. Unit7 does the hard part, so small fast models work well.',
    items: [
      { say: '/unit7 connect my server 203.0.113.5', does: 'Adds the server and prepares it: Docker, HTTPS proxy, firewall.' },
      { say: '/unit7 deploy this folder', does: 'Detects the app, builds it, puts it live with a URL. Bad versions never go live.' },
      { say: '/unit7 add a postgres database to my app', does: 'Creates the database and wires DATABASE_URL in for you.' },
      { say: '/unit7 point app.example.com at my app', does: 'Sets DNS, routing and HTTPS in one step.' },
      { say: '/unit7 why is my site slow?', does: 'Checks CPU, memory, logs and recent deploys, then explains and fixes.' },
      { say: '/unit7 roll back', does: 'Puts the previous working version back, instantly.' },
      { say: '/unit7 secure my server', does: 'Locks SSH to keys, closes exposed ports, turns on security updates.' },
      { say: '/unit7 run a security check', does: 'Checks every server, app, domain and Unit7 itself for open doors, leaked secrets and weak spots, with a fix for each (Settings → Security).' },
      { say: '/unit7 watch', does: 'Your Claude Code answers what you type in Unit7\u2019s web app, in the same box. No API key, no extra subscription. Leave it running.' },
      { say: '/unit7 back up my database', does: 'Takes a backup now (Unit7 also backs up daily and before risky changes).' },
    ],
  },
  {
    title: '3. From the terminal',
    items: [
      { say: 'unit7 status', does: 'Everything Unit7 manages: servers, apps, databases, domains.' },
      { say: 'unit7 deploy --service <id>', does: 'Deploy the folder you are in.' },
      { say: 'unit7 logs <serviceId>', does: 'Recent logs of an app.' },
      { say: 'unit7 rollback <serviceId>', does: 'Back to the previous version.' },
      { say: 'unit7 agent "add redis to my api"', does: 'Ask Unit7’s own agent (needs an Anthropic key in Stored secrets).' },
      { say: 'unit7 serve', does: 'Run Unit7 yourself in the foreground (unit7 connect already runs it in the background).' },
    ],
  },
  {
    title: '4. Safe by default',
    items: [
      { say: 'Approvals', does: 'Risky actions (deleting data, buying a server, raw commands) wait for you on the Approvals page.' },
      { say: 'Warden', does: 'The round badge in the corner. Click it for the next useful thing to do, each with a one-click fix. It watches your servers day and night: restarts crashed apps, rolls back bad deploys, blocks attackers, backs up.' },
      { say: 'Stored secrets', does: 'Your keys are encrypted. AI agents only ever see a key’s name, never the key itself.' },
    ],
  },
  {
    title: '5. Around the web app',
    intro: 'The pages under your name (top right), and a few things on the others.',
    items: [
      { say: 'Morning brief', does: 'Three lines on Home each morning: yesterday, what Unit7 fixed overnight, and the one thing it needs from you.' },
      { say: 'Changes', does: 'What changed and who did it, newest first, with Undo. Every server, app and project has its own Changes too.' },
      { say: 'Replay', does: 'On an alert: the ten minutes before and after something broke, so you can see what led to it.' },
      { say: 'Ready for real users', does: 'The ring on each project: own domain, HTTPS, backups, alerts and the rest, with a fix for each gap.' },
      { say: 'Costs', does: 'What everything costs this month, where it goes, and ideas to spend less.' },
      { say: 'Archive or delete', does: 'The “…” on a project or app: archive it so Unit7 stops watching, or delete it after seeing what it affects. Connections lists each account’s projects for this.' },
      { say: 'Clients and Products', does: 'Group what belongs together into products, give them to clients, and filter Projects, Servers and the Map by client.' },
      { say: 'Routines', does: 'Things Unit7 does on a schedule. Save a chat’s steps as one with “Save as a routine”.' },
      { say: 'Make a test copy', does: 'A staging copy of a project or app, without the live keys and with names in the data replaced.' },
      { say: 'Add to my server', does: 'Tools a growing app needs (database viewer, analytics, automations), one click each, on your own server.' },
      { say: 'App access', does: 'On a server’s Apps tab: Unit7 makes its own keys in apps like Supabase or n8n and keeps them in the vault.' },
    ],
  },
];

export function helpText(): string {
  const out: string[] = ['Unit7: the backend developer your AI never had.', ''];
  for (const s of HELP) {
    out.push(s.title);
    if (s.intro) out.push(`  ${s.intro}`);
    const w = Math.min(44, Math.max(...s.items.map((i) => i.say.length)) + 2);
    for (const i of s.items) out.push(`  ${i.say.padEnd(w)}${i.does}`);
    out.push('');
  }
  out.push('Web app: http://localhost:4800  ·  More: unit7 <command> --help');
  return out.join('\n');
}
