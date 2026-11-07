// A site with no index.html is still a website: its likely home page goes up as index.html, in a copy, and the person's own folder never changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, homeOf } from '../src/connectors/detect.ts';
import { aboutOf, openSource } from '../src/live/source.ts';
import { finished } from '../src/live/hosts.ts';
import { dockerfileFor } from '../src/deploy/dockerfiles.ts';

const facts = (...files: string[]) => detect({ files, manifests: {} });
const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'home-'));
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), v); }
  return dir;
};
const ctx = { app: { home: '/nowhere' }, db: undefined, orgId: 'o' } as never;

test('a folder of pages with no index.html is a plain website, and a home page is picked', () => {
  const d = facts('404-stl.html', 'about.html', 'home-5.html', 'css/a.css', 'css/._a.html');
  assert.equal(d.stack, 'static');
  assert.equal(d.home, 'home-5.html');
  assert.deepEqual(d.pages, ['404-stl.html', 'about.html', 'home-5.html']); // a Mac's ._ file isn't a page
});

test('the likeliest home page wins, and an error page is the last choice', () => {
  assert.equal(homeOf(['about.html', 'index.htm']), 'index.htm');
  assert.equal(homeOf(['404.html', 'demo.html', 'landing.html']), 'landing.html');
  assert.equal(homeOf(['404.html', 'pricing.html']), 'pricing.html');
  assert.equal(homeOf(['404.html']), '404.html');
});

test('a site with an index.html stays exactly as it was', () => {
  const d = facts('index.html', 'about.html');
  assert.equal(d.home, undefined);
  assert.equal(d.pages, undefined);
});

test('the languages a build service can run are named, and templates in them are not a website', () => {
  assert.equal(facts('Gemfile', 'views/a.html').stack, 'ruby');
  assert.equal(facts('pom.xml', 'src/a.html').stack, 'java');
  assert.equal(facts('app.csproj').stack, 'dotnet');
  assert.equal(facts('index.php').stack, 'php');
  assert.equal(facts('notes.txt').stack, 'unknown');
});

test('the home page goes up as index.html in a copy, and the person’s folder is left alone', async () => {
  const dir = folder({ 'home-5.html': '<title>Shop</title>', 'about.html': 'a', 'css/a.css': 'b' });
  const site = await openSource(ctx, { folder: dir });
  assert.equal(site.home, 'home-5.html');
  assert.ok(site.files.some((f) => f.path === 'index.html'));
  assert.equal(finished(site)!.dir, '.');
  assert.equal(existsSync(join(dir, 'index.html')), false);
  const copy = site.dir;
  assert.notEqual(copy, dir);
  site.done();
  assert.equal(existsSync(copy), false);
  assert.equal(existsSync(join(dir, 'home-5.html')), true);
});

test('a person can pick another page, and only a page of this site', async () => {
  const dir = folder({ 'home.html': 'h', 'about.html': 'a' });
  const site = await openSource(ctx, { folder: dir, home: 'about.html' });
  assert.equal(site.home, 'about.html');
  site.done();
  await assert.rejects(openSource(ctx, { folder: dir, home: '../secret.html' }), /isn’t a page/);
});

test('a site that has its own index.html can’t be given another', async () => {
  await assert.rejects(openSource(ctx, { folder: folder({ 'index.html': 'i' }), home: 'index.html' }), /already has its own/);
});

test('the guide reads the description and top-level names, never the code', async () => {
  const dir = folder({ 'README.md': 'A shop for tea.', 'package.json': '{"name":"tea","description":"Tea shop","dependencies":{"next":"1"}}', 'src/secret-logic.ts': 'const hidden = "do not read";' });
  const site = await openSource(ctx, { folder: dir });
  const { said, brief } = aboutOf(site);
  site.done();
  assert.equal(said, 'Tea shop');
  assert.match(brief, /A shop for tea/);
  assert.match(brief, /next/);
  assert.doesNotMatch(brief, /do not read/);
});

test('Unit7’s own deploy serves the home page too, and a strange file name is left out of the Dockerfile', () => {
  const made = dockerfileFor(facts('home-5.html', 'about.html'), []);
  assert.match(made!, /RUN cp \/srv\/home-5\.html \/srv\/index\.html/);
  const odd = dockerfileFor({ ...facts('a.html'), home: 'a b;rm.html' }, []);
  assert.doesNotMatch(odd!, /RUN cp/);
});
