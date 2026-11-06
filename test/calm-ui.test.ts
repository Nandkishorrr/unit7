// Two small web helpers: where a hover card goes, and whether a paste looks like a provider's key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCard } from '../web/src/lib/place.ts';
import { looksLikeToken } from '../web/src/lib/token.ts';

const view = { width: 1000, height: 800 };
const card = { width: 200, height: 100 };

test('a hover card sits under its trigger, centred, when it fits', () => {
  assert.deepEqual(placeCard({ left: 400, top: 100, width: 100, height: 40 }, card, view), { side: 'bottom', top: 148, left: 350 });
});

test('no room below: it goes above; no room either side: the roomier side, kept on screen', () => {
  assert.deepEqual(placeCard({ left: 400, top: 720, width: 100, height: 40 }, card, view), { side: 'top', top: 612, left: 350 });
  const tall = placeCard({ left: 400, top: 300, width: 100, height: 40 }, { width: 200, height: 700 }, view);
  assert.equal(tall.side, 'bottom');
  assert.equal(tall.top, 92); // pushed up so its bottom stays 8px inside the window
});

test('near an edge it slides sideways to stay inside the window', () => {
  assert.equal(placeCard({ left: 0, top: 100, width: 40, height: 40 }, card, view).left, 8);
  assert.equal(placeCard({ left: 980, top: 100, width: 20, height: 40 }, card, view).left, 792);
  assert.equal(placeCard({ left: 0, top: 100, width: 40, height: 40 }, { width: 1200, height: 100 }, view).left, 8); // wider than the window
});

test('a paste looks like a key by the provider’s pattern, else by its shape', () => {
  assert.equal(looksLikeToken('  sk-ant-api03-abcdefghijklmnop\n', { pattern: '^sk-ant-' }), true);
  assert.equal(looksLikeToken('sk-proj-abcdefghijklmnop', { pattern: '^sk-ant-' }), false);
  assert.equal(looksLikeToken('https://hooks.slack.com/services/T000/B000/XXXX', { pattern: '^https://(hooks\\.slack\\.com|(discord|discordapp)\\.com/api/webhooks)/' }), true);
  assert.equal(looksLikeToken('Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56'), true);
  assert.equal(looksLikeToken('FlyV1 fm2_lJPECAAAAAAAAMYAxBAbcdefghij'), true);
  assert.equal(looksLikeToken('https://vercel.com/account/tokens'), false); // the page's link, not the key
  assert.equal(looksLikeToken('my token is Ab12Cd34Ef56Gh78Ij90'), false);
  assert.equal(looksLikeToken('short1234'), false);
  assert.equal(looksLikeToken('anything long enough here', { pattern: '([' }), false); // a broken pattern falls back to the shape test
});

test('a key file is a service account’s JSON', () => {
  assert.equal(looksLikeToken(JSON.stringify({ type: 'service_account', project_id: 'demo', private_key: '-----BEGIN…' }), { file: true }), true);
  assert.equal(looksLikeToken('{"hello": "world"}', { file: true }), false);
  assert.equal(looksLikeToken('Ab12Cd34Ef56Gh78Ij90Kl12', { file: true }), false);
});
