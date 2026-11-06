// A real restore into an empty database, on a real Postgres: a dump's tables come in name order, so a check that reads a later table
// refuses its rows. What came back empty goes again once the rest is in. A row that's really bad still fails, and nothing doubles.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { testApp } from './helpers.ts';
import { havePostgres, realShell, startPostgres, type Pg } from './data-real-pg.ts';
import { PG_SAID, provePostgres } from '../src/tools/partbackup.ts';

const pgUp = havePostgres() ? startPostgres() : undefined, real = { skip: pgUp ? false : 'no Postgres can start here' };
after(() => pgUp?.stop());

const box = { username: 'root' } as never;
function world() {
  const pg = pgUp as Pg, app = testApp(), seen = realShell(app, pg), file = join(pg.dir, 'all.sql.gz'), progress: string[] = [];
  const ctx = { app, progress: (m: string) => progress.push(m) } as never;
  pg.sql('DROP DATABASE IF EXISTS shop WITH (FORCE); CREATE DATABASE shop;');
  pg.sql(`
    CREATE SCHEMA other;
    CREATE TABLE zones (name text PRIMARY KEY);
    CREATE TABLE lanes (id int PRIMARY KEY, zone text REFERENCES zones);
    CREATE FUNCTION public.lane_known(l int) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.lanes WHERE id = l) $$;
    CREATE FUNCTION public.zone_known(z text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.zones WHERE name = z) $$;
    CREATE TABLE awb (id int PRIMARY KEY, lane int CHECK (public.lane_known(lane)), note text DEFAULT 'kept');
    CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := 'touched'; RETURN NEW; END $$;
    CREATE TRIGGER touch BEFORE INSERT ON awb FOR EACH ROW EXECUTE FUNCTION touch();
    ALTER TABLE lanes ADD CONSTRAINT lanes_zone_known CHECK (public.zone_known(zone));
    CREATE TABLE other.awb (id int);
    CREATE TABLE plain (id int);
    CREATE TABLE stops (id int, lane int REFERENCES lanes);
    CREATE TABLE "Odd Name" (id int, lane int, CONSTRAINT odd_lane FOREIGN KEY (lane) REFERENCES lanes);
    INSERT INTO zones VALUES ('north');
    INSERT INTO lanes VALUES (7, 'north');
    ALTER TABLE awb DISABLE TRIGGER touch; INSERT INTO awb VALUES (1, 7, 'kept'), (2, 7, 'kept'); ALTER TABLE awb ENABLE TRIGGER touch;
    INSERT INTO other.awb VALUES (1);
    INSERT INTO plain VALUES (1), (2), (3);
    INSERT INTO stops VALUES (1, 7);
    INSERT INTO "Odd Name" VALUES (1, 7);
  `, 'shop');
  pg.dumpTo(file);
  const load = () => {
    pg.sql('DROP DATABASE shop WITH (FORCE);');
    return execFileSync('sh', ['-c', `{ gunzip -c "$1" | psql -q -U postgres -d postgres 2>&1 >/dev/null | ${PG_SAID}; } 2>&1`, 'unit7', file], { env: pg.env, encoding: 'utf8' }).split('\n').filter(Boolean);
  };
  return { pg, ctx, file, load, seen, progress };
}

test('a table whose check reads a later table comes back, along a chain of them, with its triggers off and nothing doubled', real, async () => {
  const { pg, ctx, file, load, progress } = world();
  const said = load();
  assert.match(said.join('\n'), /awb: new row for relation "awb" violates check constraint/, 'it really is refused the first time');
  assert.equal(pg.sql('SELECT count(*) FROM awb', 'shop').trim(), '0');
  const proof = await provePostgres(ctx, box, 'copy', 'postgres:16', file, said);
  assert.deepEqual(proof, { ok: true, note: 'all 7 tables and 10 rows came back' });
  assert.match(progress[0]!, /refused at first/);
  assert.equal(progress.length, 2, 'lanes needs zones, awb needs lanes: a round each');
  assert.equal(pg.sql(`SELECT string_agg(id || note, ',' ORDER BY id) FROM awb`, 'shop').trim(), '1kept,2kept', 'as they were: the trigger stayed off');
  assert.equal(pg.sql('SELECT count(*) FROM other.awb', 'shop').trim(), '1', 'a table of the same name elsewhere was already in');
  assert.equal(pg.sql('SELECT count(*) FROM plain', 'shop').trim(), '3');
  assert.equal(pg.sql(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE contype = 'f'`, 'shop').trim(), 'lanes_zone_fkey,odd_lane,stops_lane_fkey', 'a key that pointed at an empty table is back');
});

test('a row that really is bad still fails, says why, and never shows the row', real, async () => {
  const { ctx, file, load } = world();
  const text = gunzipSync(readFileSync(file)).toString().replace(/^1\t7\tkept$/m, '1\t99\tsecret-row');
  writeFileSync(file, gzipSync(text));
  const proof = await provePostgres(ctx, box, 'copy', 'postgres:16', file, load());
  assert.equal(proof.ok, false);
  assert.match(proof.note, /1 of 7 tables came back short: public\.awb \(0 of 2 rows\)\. Postgres said: awb: new row for relation "awb" violates check constraint/);
  assert.doesNotMatch(proof.note, /secret-row/);
});

test('text in a dump that only looks like a key stays text', real, async () => {
  const { pg, ctx, file, load } = world();
  const planted = [
    'ALTER TABLE ONLY public.zones', '    ADD CONSTRAINT planted1 FOREIGN KEY (name) REFERENCES public.lanes(id); DROP TABLE plain;', '',
    'ALTER TABLE ONLY public.zones', '    ADD CONSTRAINT planted2 FOREIGN KEY (name) REFERENCES public.lanes(id) \\! touch /tmp/unit7-planted ;', '',
  ].join('\n');
  // a function's body is a place a visitor's text can reach
  pg.sql(`CREATE FUNCTION note() RETURNS text LANGUAGE sql AS $body$ SELECT $q$\n${planted}\n$q$ $body$`, 'shop');
  pg.dumpTo(file);
  const proof = await provePostgres(ctx, box, 'copy', 'postgres:16', file, load());
  assert.equal(proof.ok, true, proof.note);
  assert.equal(pg.sql('SELECT count(*) FROM plain', 'shop').trim(), '3');
  assert.equal(pg.sql(`SELECT count(*) FROM pg_constraint WHERE conname LIKE 'planted%'`, 'shop').trim(), '0');
});

test('nothing refused, nothing sent again', real, async () => {
  const { pg, ctx, file, seen, progress } = world();
  const proof = await provePostgres(ctx, box, 'copy', 'postgres:16', file, []);
  assert.equal(proof.ok, true, 'the live tables are all there');
  assert.equal(progress.length, 0);
  assert.equal(seen.filter((c) => c.command.includes('session_replication_role')).length, 0);
  assert.equal(pg.sql('SELECT count(*) FROM awb', 'shop').trim(), '2');
});
