// The ready-made jobs: each is one tap, a sentence you could type, and when it runs by itself. Pure, so a test can check that every
// tool here exists. `forEachServer` runs it once per server.
export type Job = { id: string; title: string; what: string; when: string; ai?: boolean } & ({ tool: string; input?: Record<string, unknown>; forEachServer?: boolean } | { href: string } | { ask: string });
export const JOBS: { group: string; jobs: Job[] }[] = [
  { group: 'Protection', jobs: [
    { id: 'protect', title: 'Protect everything now', what: 'The Safety Net, on everything important', when: 'When something is unprotected', href: '/protect' },
    { id: 'copy-first', title: 'Copy before I try this', what: 'A fresh copy, then go ahead', when: 'Before risky work', tool: 'safety.copy', input: { reason: 'before I try something' } },
    { id: 'past', title: 'Open yesterday’s copy', what: 'A side copy. Pull back one table or row', when: 'When you ask', href: '/protect' },
    { id: 'rehearse', title: 'Try this on a copy first', what: 'Rehearses a risky change on a throwaway', when: 'Before migrations', ask: 'I want to try a risky database change on a throwaway copy first. Ask me for the SQL, then use safety_rehearse and show me what would change.', ai: true },
    { id: 'help', title: 'Help, something’s wrong', what: 'Safety copy, full check, first step, customer message', when: 'When you ask', href: '/help-now' },
  ] },
  { group: 'Everyday', jobs: [
    { id: 'checkup', title: 'Is everything OK?', what: 'The full Check-up', when: 'Daily and weekly', href: '/checkup?run=1' },
    { id: 'slow', title: 'Why is it slow?', what: 'Slow routes, top queries, memory, recent deploys', when: 'When a site turns slow', ask: 'Why is my site slow? Look at slow routes, top queries, memory pressure and recent deploys. Look first, read-only.', ai: true },
    { id: 'reduce', title: 'Reduce my server', what: 'What can be freed, with sizes and undo', when: 'When disk or memory runs high', href: '/checkup' },
    { id: 'changed', title: 'What changed?', what: 'Since yesterday, or since it last worked', when: 'After an incident', ask: 'What changed since it last worked? Use story_timeline with untilHealthy.', ai: true },
    { id: 'did', title: 'What did Unit7 do?', what: 'Only real changes, with undo', when: 'Morning brief', href: '/changes' },
    { id: 'ai', title: 'What did my AI do?', what: 'Every change an AI made, by session', when: 'When you ask', href: '/ai-log' },
  ] },
  { group: 'Security', jobs: [
    { id: 'stranger', title: 'What can a stranger do?', what: 'Your own sites, from outside. Counts rows, reads none', when: 'Weekly, after deploys', tool: 'security.stranger' },
    { id: 'hacked', title: 'Have I been hacked?', what: 'Break-in signs on each server', when: 'Weekly', tool: 'security.hacked', forEachServer: true },
    { id: 'doors', title: 'Check my database rules', what: 'Who can read what, on self-hosted Supabase', when: 'Weekly', tool: 'security.doors', forEachServer: true },
    { id: 'defaults', title: 'Are my passwords defaults?', what: 'Compared on the server. Values never leave it', when: 'Weekly', tool: 'security.defaults', forEachServer: true },
    { id: 'panel', title: 'Is my panel safe?', what: 'Coolify, n8n and similar, against published holes', when: 'Weekly', tool: 'security.panels' },
    { id: 'running', title: 'Holes in what’s running', what: 'The version your site gives away, looked up', when: 'After deploys', tool: 'security.running' },
    { id: 'breach', title: 'A company got hacked', what: 'Your rotate-this list, most dangerous first', when: 'When you ask', href: '/deep' },
  ] },
  { group: 'App behaviour', jobs: [
    { id: 'calls', title: 'Find wrong and repeated calls', what: 'The Call Inspector', when: 'All the time, quietly', href: '/calls' },
    { id: 'db', title: 'Check my database', what: 'What it hears, compared with last time', when: 'Hourly', tool: 'inspect.database', forEachServer: true },
    { id: 'cron', title: 'Check my cron jobs', what: 'Overlaps and failures', when: 'When you ask', tool: 'cron.map', forEachServer: true },
    { id: 'outside', title: 'Check my outside services', what: 'Carriers, payments and email failing in your logs', when: 'Every 6 hours', tool: 'inspect.outside', forEachServer: true },
    { id: 'deploy-fail', title: 'Why did this deploy fail?', what: 'A read-only diagnosis of the latest failed deploy', when: 'Every failed deploy', tool: 'deploys.explain' },
    { id: 'digest', title: 'What do my logs say?', what: 'Twelve hours folded into a page of patterns', when: 'When you ask', ask: 'Read my app logs with logs_digest and tell me about wrong or repeated calls, noisy lines and anything worth fixing.', ai: true },
  ] },
  { group: 'Money', jobs: [
    { id: 'bill', title: 'Why did my bill go up?', what: 'Which thing, since when', when: 'When spend jumps', ask: 'Why did my bill go up? Use cost_radar and show which thing, since when.', ai: true },
    { id: 'brake', title: 'Could one night cost me a fortune?', what: 'Is there a real brake?', when: 'When you ask', href: '/deep' },
  ] },
  { group: 'Going live', jobs: [
    { id: 'ready', title: 'Am I ready for real users?', what: 'The checklist, on Coolify apps too', when: 'Before launch', ask: 'Am I ready for real users? Use project_readiness, with serverId and found for each project on my servers.', ai: true },
    { id: 'scale', title: 'Can it take 10× more users?', what: 'Which part breaks first, from real usage', when: 'When you ask', ask: 'Can my app take 10 times more users? From real usage, tell me which part breaks first. Don’t run a load test.', ai: true },
    { id: 'email', title: 'Will my emails arrive?', what: 'SPF, DKIM and DMARC', when: 'Before launch', ask: 'Will my emails arrive? Check SPF, DKIM and DMARC on my domains.', ai: true },
    { id: 'crawl', title: 'Can Google see my site?', what: 'Fetches it as a crawler', when: 'After deploys', ask: 'Can Google see my site? Fetch it the way a crawler would, and check robots and the sitemap.', ai: true },
  ] },
  { group: 'Safety nets and handover', jobs: [
    { id: 'proven', title: 'Prove my backups work', what: 'A real test restore', when: 'Weekly', href: '/protect' },
    { id: 'died', title: 'If this server died today?', what: 'A real restore, timed', when: 'Monthly', href: '/deep' },
    { id: 'expiry', title: 'What runs out?', what: 'Domains, certificates, plans and keys', when: 'Always there', href: '/expiry' },
    { id: 'update', title: 'Update safely', what: 'What’s behind, and a plan with a backup first', when: 'Monthly', ask: 'What’s outdated, and what’s the safest way to update it? Use fresh_plan, and show me a plan with a backup first.', ai: true },
    { id: 'dead', title: 'Clean up dead things', what: 'Abandoned apps and domains', when: 'Monthly', ask: 'What looks abandoned? Show me, and don’t remove anything.', ai: true },
    { id: 'report', title: 'Client report', what: 'The week on one page', when: 'Weekly', href: '/report-card' },
    { id: 'handover', title: 'Hand this project over', what: 'A passport: what runs where, by name', when: 'When you ask', href: '/servers' },
  ] },
];
