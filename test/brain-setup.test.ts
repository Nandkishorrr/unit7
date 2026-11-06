// Install or sign in to Claude from the ask box: Unit7 opens Terminal with a fixed command, only for an owner
// or admin in the web app on this computer. These tests never open Terminal: they check the command text and the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { testApp } from './helpers.ts';
import { createHttp, resetRateLimits } from '../src/server/http.ts';
import { acceptInvite, createInvite, createToken } from '../src/auth.ts';
import { SETUP_COMMANDS, appleString, terminalCommand } from '../src/agent/brain-setup.ts';

test('the Terminal command: the official installer, then the sign-in; odd paths stay quoted', () => {
  assert.equal(terminalCommand('claude', 'install', undefined), 'curl -fsSL https://claude.ai/install.sh | bash && "$HOME/.local/bin/claude" auth login --claudeai');
  assert.equal(terminalCommand('claude', 'sign-in', "/Users/o'neil/.local/bin/claude"), `'/Users/o'\\''neil/.local/bin/claude' auth login --claudeai`);
  // the shell reads the quoted path back exactly
  if (process.platform !== 'win32') {
    const cmd = terminalCommand('claude', 'sign-in', "/tmp/a b/o'neil \"x\"/claude").replace(/ auth login --claudeai$/, '');
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${cmd}`], { encoding: 'utf8' }), "/tmp/a b/o'neil \"x\"/claude");
  }
});

test('AppleScript gets the command as one string, quotes and backslashes intact', { skip: process.platform !== 'darwin' }, () => {
  const s = `export PATH='/a "b"\\c':"$PATH"; gemini`;
  assert.equal(execFileSync('/usr/bin/osascript', ['-e', `return ${appleString(s)}`], { encoding: 'utf8' }).trimEnd(), s);
});

test('only an owner or admin, signed in on this computer, can open Terminal; everyone else gets the commands', async () => {
  resetRateLimits();
  const app = testApp();
  const http = createHttp(app);
  const BASE = 'http://localhost:4800';
  const browser = () => {
    let cookie = '', bind = '';
    return async (method: string, path: string, body?: unknown, bearer?: string) => {
      const r = await http.fetch(new Request(`${BASE}${path}`, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : { origin: BASE, ...(cookie && { cookie, 'x-unit7-bind': bind }) }) } }));
      const set = r.headers.get('set-cookie'); bind = r.headers.get('x-unit7-bind') ?? bind; if (set) cookie = set.split(';')[0]!;
      return { status: r.status, body: await r.json() as any };
    };
  };
  const sam = browser();
  await sam('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse battery' });
  const me = (await sam('GET', '/api/me')).body;
  const owner = { user: me.user, org: me.org, role: 'owner', via: 'session' } as any;

  const view = (await sam('GET', '/api/agent/setup')).body;
  assert.equal(view.canOpen, process.platform === 'darwin');
  assert.equal(view.commands.claude.install, 'curl -fsSL https://claude.ai/install.sh | bash');
  // only the two known CLIs and steps (checked before anything opens)
  assert.equal((await sam('POST', '/api/agent/setup', { cli: 'codex', step: 'install' })).status, 400);
  assert.equal((await sam('POST', '/api/agent/setup', { cli: 'claude', step: 'rm -rf' })).status, 400);

  // an API token (an AI) can't
  const token = createToken(app.db, owner, 'some agent', 'agent').token;
  assert.equal((await sam('POST', '/api/agent/setup', { cli: 'claude', step: 'install' }, token)).status, 403);
  assert.equal((await sam('GET', '/api/agent/setup', undefined, token)).body.canOpen, false);

  // a developer can't either: they see the commands to copy
  await acceptInvite(app.db, createInvite(app.db, owner, 'dev@example.com', 'developer'), { name: 'Dev', password: 'correct horse battery' });
  const dev = browser();
  assert.equal((await dev('POST', '/api/auth/login', { email: 'dev@example.com', password: 'correct horse battery' })).status, 200);
  assert.equal((await dev('GET', '/api/agent/setup')).body.canOpen, false);
  const no = await dev('POST', '/api/agent/setup', { cli: 'claude', step: 'sign-in' });
  assert.equal(no.status, 403);
  assert.match(no.body.error.message, /owners and admins/);

  // and nobody can when Unit7 listens beyond this computer
  app.services.listen = { host: '0.0.0.0', port: 4800 };
  assert.equal((await sam('GET', '/api/agent/setup')).body.canOpen, false);
  assert.equal((await sam('POST', '/api/agent/setup', { cli: 'claude', step: 'sign-in' })).status, 403);
});
