// The web app's plain-words helpers: raw event text in, short sentences out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventWords, tidy, whoWords, approvalWords, providerName, changeWords, secretWords, eventKind, toolWords, foldEchoes, reasonWords, foldRuns, lookWords, askWords, verbAsks } from '../web/src/lib/words.ts';

test('token names become the AI’s name', () => {
  assert.equal(whoWords({ name: 'Sam (token Unit7 connect · Claude Code)', agent: 'Unit7 connect · Claude Code' }), 'Claude Code');
  assert.equal(whoWords('Warden'), 'Warden');
  assert.equal(tidy('Claude Code can now use Unit7'), 'Claude Code can now use Unit7');
});

test('events read as plain lines with a calm status', () => {
  assert.equal(eventWords({ type: 'app.errors', message: "blog-web: TypeError: Cannot read properties of undefined (reading 'plan') (8 times in the last few minutes)" }).text, 'blog-web is showing errors (8 in the last few minutes)');
  assert.equal(eventWords({ type: 'approval.requested', message: 'Sam (token Unit7 connect · Claude Code) wants to run roll back a service: …', data: { tool: 'deployment.rollback' } }).text, 'Claude Code wants to go back to the previous version');
  assert.equal(eventWords({ type: 'deployment.succeeded', message: 'web deploy #42 is live at https://acme.app' }).text, 'web is live at acme.app');
  assert.equal(eventWords({ type: 'deployment.failed', message: 'Deploy #40 of web failed: The build failed.' }).text, 'web didn’t go live: the build failed.');
  assert.equal(eventWords({ type: 'action.completed', message: 'Sam (token Unit7 connect · Claude Code): Deploy a service' }).text, 'Claude Code: deploy an app');
  const sync = eventWords({ type: 'sync.done', severity: 'critical', message: 'Map updated: 11 apps; 2 to look at' });
  assert.equal(sync.tone, 'neutral');
  assert.equal(sync.text, 'Map refreshed · 2 things to look at');
  assert.equal(eventWords({ type: 'something.new', severity: 'critical', message: 'x' }).word, 'Problem');
});

test('approvals name the thing and who asked', () => {
  const a = approvalWords({ tool: 'domain.point', input: { hostname: 'shop.acme.app' }, actor: { name: 'N (token Unit7 connect · Claude Code)', agent: 'Unit7 connect · Claude Code' }, environment: null });
  assert.equal(a.title, 'Point shop.acme.app at an app');
  assert.equal(a.who, 'Claude Code');
  assert.equal(approvalWords({ tool: 'domain.protect_email', input: { domain: 'example.com' } }).title, 'Protect example.com’s email');
});

test('provider ids inside server sentences become names, but not inside hostnames or commands', () => {
  assert.equal(tidy('Connect the hostinger account that holds example.com first, so Unit7 can read its records.'),
    'Connect the Hostinger account that holds example.com first, so Unit7 can read its records.');
  assert.equal(tidy('Created postgres "db", wired into the app'), 'Created PostgreSQL "db", wired into the app');
  assert.equal(tidy('Your project on vercel.'), 'Your project on Vercel.');
  assert.equal(tidy('shop.example.org points at orders-shop.vercel.app'), 'shop.example.org points at orders-shop.vercel.app');
  assert.equal(tidy('Run `unit7 connect` on github.com/acme'), 'Run `unit7 connect` on github.com/acme');
  assert.equal(tidy('Point the domain at the render app'), 'Point the domain at the render app');
  assert.equal(tidy('credential://cloudflare/main/token'), 'Cloudflare · main · token');
  assert.equal(providerName('fly.io'), 'Fly.io');
  assert.equal(providerName('something'), 'Something');
});

test('who asked, even after someone approved it', () => {
  assert.equal(whoWords('Sam (token Unit7 connect · Claude Code) (approved by Sam)'), 'Claude Code');
  assert.equal(whoWords('Sam (approved by Sam)'), 'Sam');
});

test('what an approval will change', () => {
  const name = (id?: string) => ({ svc_1: 'web', srv_1: 'srv-1' } as Record<string, string>)[id ?? ''];
  assert.equal(changeWords('service.remove', { serviceId: 'svc_1', deleteData: false }, name), 'Web is removed. Its data is kept.');
  assert.equal(changeWords('deployment.rollback', { serviceId: 'svc_1' }, name), 'Web goes back to the version before this one.');
  assert.equal(changeWords('server.exec', { serverId: 'srv_1', command: 'docker system prune' }, name), 'Unit7 runs a command on srv-1.');
  assert.equal(changeWords('domain.point', { hostname: 'shop.acme.app' }), 'shop.acme.app will open your app, with HTTPS.');
  assert.equal(changeWords('env.unset', {}), 'The setting is removed.');
  assert.equal(changeWords('job.run', {}), 'Job run.');
  assert.equal(toolWords('budget.set', 'Set a monthly budget'), 'Set a monthly budget');
});

test('stored secrets read as names', () => {
  assert.deepEqual(secretWords('credential://postgres/db-staging/password'), { provider: 'postgres', text: 'PostgreSQL · db staging · password' });
  assert.equal(secretWords('credential://forge/backups/key').text, 'Unit7 · backups · key');
});

test('activity filters sort events into kinds', () => {
  assert.equal(eventKind('deployment.succeeded'), 'deploys');
  assert.equal(eventKind('deployment.rolledback'), 'fixes');
  assert.equal(eventKind('service.restarted'), 'fixes');
  assert.equal(eventKind('backup.offsite'), 'backups');
  assert.equal(eventKind('shield.blocked'), 'security');
  assert.equal(eventKind('agent.connected'), 'security');
  assert.equal(eventKind('sync.done'), 'other');
});

test('a secret’s address never reaches the screen', () => {
  assert.equal(tidy('The credential credential://hostinger/hostinger/oauth was not found.'), 'Unit7 isn’t signed in to Hostinger yet. Connect it on Connections.');
  assert.equal(tidy('The credential credential://ssh/srv-1/private-key was not found.'), 'Unit7 doesn’t have the login key for srv-1 yet.');
  assert.equal(tidy('Stored credential://postgres/db/password.'), 'Stored PostgreSQL · db · password.');
  const failed = eventWords({ type: 'action.failed', message: 'Fix a server problem failed: The credential credential://hostinger/hostinger/oauth was not found.', data: { tool: 'server.repair' } });
  assert.equal(failed.text, 'Fix a server problem didn’t work: Unit7 isn’t signed in to Hostinger yet. Connect it on Connections.');
  assert.ok(!/credential:\/\//.test(failed.text));
  assert.equal(tidy('Your VPS, domains and DNS.'), 'Your server, domains and DNS.');
});

test('actions read the same everywhere', () => {
  assert.equal(eventWords({ type: 'action.completed', message: 'Sam: Create a service', data: { tool: 'service.create' } }).text, 'Sam: add an app');
  assert.equal(eventWords({ type: 'action.completed', message: 'Sam: Change autonomy and policy', data: { tool: 'environment.policy' } }).text, 'Sam: change how much Unit7 does alone');
  assert.equal(eventWords({ type: 'policy.changed', message: 'Sam set Staging to autonomy 4' }).text, 'Sam set Staging to “Full autopilot”');
  assert.equal(eventWords({ type: 'policy.changed', message: "Sam fixed Production's autonomy" }).text, 'Sam stopped Production earning more freedom');
  assert.equal(reasonWords('Warden: container down'), 'the app stopped responding');
  assert.equal(reasonWords('new commit 1c1c051'), 'new code was pushed');
});

test('one action shows once, with who did it', () => {
  const t = '2026-10-06T23:49:13.993Z';
  const folded = foldEchoes([
    { type: 'action.completed', message: 'Sam: Remove a service', data: { tool: 'service.remove' }, created_at: t },
    { type: 'service.removed', message: 'Removed preview-web (data kept)', data: {}, created_at: t },
    { type: 'action.completed', message: 'Sam: Delete a project', data: { tool: 'project.delete' }, created_at: t },
  ]);
  assert.deepEqual(folded.map((e) => [e.type, e.by]), [['service.removed', 'Sam'], ['action.completed', undefined]]);
  // no known echo: the line the same person said in the same moment
  const own = foldEchoes([
    { type: 'action.completed', message: 'Sam: Move something to a client', data: { tool: 'project.update' }, created_at: t },
    { type: 'client.created', message: 'Sam added the client Northwind', data: {}, created_at: t },
    { type: 'action.completed', message: 'Sam: Add a client', data: { tool: 'client.create' }, created_at: t },
  ]);
  assert.deepEqual(own.map((e) => [e.type, e.by]), [['action.completed', undefined], ['client.created', 'Sam']]);
});

test('approvals say which thing, and the same decision again and again is one line', () => {
  const names: Record<string, string> = { svc_a: 'preview-web', srv_b: 'box' };
  const name = (id?: string) => (id ? names[id] : undefined);
  assert.equal(approvalWords({ tool: 'service.remove', input: { serviceId: 'svc_a' } }, name).title, 'Remove preview-web');
  assert.equal(approvalWords({ tool: 'server.exec', input: { serverId: 'srv_b', command: 'ls' } }, name).title, 'Run a command on box');
  assert.equal(approvalWords({ tool: 'part.restart', input: { serverId: 'srv_b', part: 'c:shop-web-1' } }, name).title, 'Restart shop-web-1');
  assert.equal(approvalWords({ tool: 'service.remove', input: { serviceId: 'svc_gone' } }, name).title, 'Remove an app'); // a name nobody knows any more
  assert.equal(approvalWords({ tool: 'domain.point', input: { hostname: 'shop.example.com', serviceId: 'svc_a' } }, name).title, 'Point shop.example.com at preview-web');
  const rows = [{ t: 'Remove preview-web', d: 'Not now' }, { t: 'Remove preview-web', d: 'Not now' }, { t: 'Remove preview-web', d: 'Not now' }, { t: 'Remove api', d: 'Not now' }, { t: 'Remove preview-web', d: 'Not now' }];
  assert.deepEqual(foldRuns(rows, (r) => `${r.t}|${r.d}`).map((r) => [r.t, r.times]), [['Remove preview-web', 3], ['Remove api', 1], ['Remove preview-web', 1]]);
});

test('looking at a secret is a record, not a problem; server changes read plainly', () => {
  const look = eventWords({ type: 'secret.revealed', severity: 'warning', message: 'Sam revealed JWT_SECRET' });
  assert.deepEqual([look.text, look.tone, look.word], ['Sam looked at the hidden setting JWT_SECRET', 'neutral', 'Info']);
  assert.equal(eventWords({ type: 'secret.revealed', severity: 'warning', message: 'Sam viewed the backup recovery key' }).tone, 'neutral');
  assert.equal(eventWords({ type: 'change.made', message: 'Stopped worker on box. It can be undone.' }).text, 'Stopped worker on box');
  assert.equal(eventWords({ type: 'change.undone', message: 'Undid: Stopped worker on box' }).word, 'Undone');
});

test('one count everywhere: Warden says what its badge says, Activity says what the Map says', () => {
  assert.equal(lookWords(5, 2), '5 need a look · 2 tips');
  assert.equal(lookWords(1, 0), '1 needs a look');
  assert.equal(lookWords(0, 1), '1 tip');
  assert.equal(lookWords(0, 0), 'all clear');
  // the newest refresh takes the Map's live number over the one recorded at the time
  const sync = { type: 'sync.done', message: 'Map updated: 11 apps; 5 to look at' };
  assert.equal(eventWords(sync).text, 'Map refreshed · 5 things to look at');
  assert.equal(eventWords(sync, { attention: 7 }).text, 'Map refreshed · 7 things to look at');
  assert.equal(eventWords(sync, { attention: 0 }).text, 'Map refreshed');
});

test('⌘K never dead-ends: what you type is asked about the page you are on', () => {
  const here = { prefix: 'For shop, Staging', name: 'shop' };
  assert.equal(askWords('why is it slow', here), 'For shop, Staging: why is it slow');
  assert.equal(askWords('restart shop', here), 'restart shop'); // already says which
  assert.equal(askWords('  deploy  '), 'deploy');
  assert.deepEqual(verbAsks('dep', 'shop in Staging'), [{ id: 'deploy', text: 'Deploy shop in Staging and give me the link' }]);
  assert.deepEqual(verbAsks('roll back please').map((v) => v.id), ['rollback']);
  assert.deepEqual(verbAsks('why are the logs red').map((v) => v.text), ['Show me the latest logs of my app and what’s wrong']);
  assert.deepEqual(verbAsks('d'), []); // one letter is too little to guess
});
