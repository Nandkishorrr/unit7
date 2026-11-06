// Z4: the database-change checker. Each risky kind in plain words with its two-step fix, safe migrations passing,
// Prisma / Drizzle / plain SQL and the common ORM DSLs, down() sections ignored, and the Postgres lock limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrations, upPart, withLockLimits, lockHint, riskyMessage, runningMentions } from '../src/deploy/migcheck.ts';
import { testApp } from './helpers.ts';
import { ssh } from '../src/connectors/ssh.ts';
import type { Ctx } from '../src/tools/runtime.ts';

const one = (file: string, body: string, o = { oldVersion: true }) => checkMigrations({ [file]: body }, o);
const kinds = (c: ReturnType<typeof checkMigrations>) => c.changes.map((x) => `${x.kind}:${x.level}`);

test('each risky kind is named in plain words, with the two-step way to do it', () => {
  const rename = one('prisma/migrations/2_rename/migration.sql', 'ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";');
  assert.equal(rename.status, 'destructive', 'a rename is still stopped by the data-loss guard, as before');
  assert.equal(rename.changes[0]!.why, 'This renames a column (users.name → full_name). The old version still uses the old name, so visitors would see errors for about a minute while both run.');
  assert.deepEqual(rename.changes[0]!.steps.map((s) => s.split(' ')[0]), ['Add', 'Deploy', 'Copy', 'Switch', 'Remove'], 'add → write both → copy → switch reads → remove next release');
  assert.match(rename.changes[0]!.steps[2]!, /UPDATE users SET full_name = name/);

  const required = one('drizzle/0003_flat.sql', 'ALTER TABLE "orders" ADD COLUMN "region" text NOT NULL;');
  assert.deepEqual(kinds(required), ['required_column:risky']);
  assert.equal(required.status, 'risky');
  assert.match(required.changes[0]!.why, /adds a required column \(orders\.region\) with no default/);
  assert.match(required.summary, /can break the version still serving/);

  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE "orders" ADD COLUMN "region" text NOT NULL DEFAULT \'eu\';')), [], 'a default keeps the old version working');
  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE orders ADD COLUMN id2 BIGSERIAL NOT NULL;')), [], 'a serial fills itself');
  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;')), ['required_column:risky']);
  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE "users" ALTER COLUMN "age" SET DATA TYPE BIGINT;')), ['change_type:destructive']);
  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE users MODIFY COLUMN age BIGINT;')), ['change_type:risky'], 'MySQL MODIFY: a type change the old guard never saw');
  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE users CHANGE COLUMN name full_name VARCHAR(80);')), ['rename_column:risky']);
  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE "users" DROP COLUMN "age";')), ['drop_column:destructive']);
  assert.deepEqual(kinds(one('m.sql', 'DROP TABLE IF EXISTS "sessions", "tokens";')), ['drop_table:destructive', 'drop_table:destructive']);
  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE "users" RENAME TO "people";')), ['rename_table:destructive']);
  assert.deepEqual(kinds(one('m.sql', 'RENAME TABLE users TO people;')), ['rename_table:risky']);
  const unique = one('m.sql', 'CREATE UNIQUE INDEX "users_email_key" ON "users"("email");');
  assert.deepEqual(kinds(unique), ['add_unique:warning']);
  assert.equal(unique.status, 'warning', 'a warning never stops a deploy');
  assert.match(unique.changes[0]!.why, /If two rows already share a value/);
  assert.deepEqual(kinds(one('m.sql', 'ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);')), ['add_unique:warning']);
  assert.deepEqual(kinds(one('m.sql', 'DELETE FROM "sessions";')), ['removes_data:destructive']);
});

test('safe migrations pass: new tables, their indexes and columns, optional columns, dropped indexes', () => {
  const prisma = `-- CreateTable
CREATE TABLE "Post" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "Post_title_key" ON "Post"("title");
-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Post" ADD COLUMN "slug" TEXT NOT NULL;
ALTER TABLE "User" ADD COLUMN "bio" TEXT;
-- DropIndex
DROP INDEX "User_name_idx";
ALTER TABLE "User" DROP CONSTRAINT "User_old_check", ALTER COLUMN "bio" DROP NOT NULL, ALTER COLUMN "bio" SET DEFAULT '';`;
  const c = one('prisma/migrations/20261001_init/migration.sql', prisma);
  assert.equal(c.status, 'safe', JSON.stringify(c.changes));
  assert.match(c.summary, /safe for the version still serving/);
  assert.equal(checkMigrations({}, { oldVersion: true }).summary, 'No new database changes in this release.');

  // a function body with a ";" and words like DROP TABLE inside $$ … $$ is not read as statements
  assert.equal(one('m.sql', `CREATE FUNCTION f() RETURNS void AS $$ BEGIN DROP TABLE x; END; $$ LANGUAGE plpgsql;`).status, 'safe');
  // a first deploy has no old version to break: risky becomes something to know
  const first = one('m.sql', 'ALTER TABLE "orders" ADD COLUMN "region" text NOT NULL;', { oldVersion: false });
  assert.equal(first.status, 'warning');
  assert.match(first.summary, /Nothing is serving yet/);
});

test('Prisma, Drizzle and plain SQL together: one report, worst first, a table made in this release skipped', () => {
  const c = checkMigrations({
    'prisma/migrations/3_people/migration.sql': 'ALTER TABLE "User" DROP COLUMN "name",\nADD COLUMN "fullName" TEXT NOT NULL;',
    'drizzle/0004_audit.sql': 'CREATE TABLE "audit" ("id" serial PRIMARY KEY);\n--> statement-breakpoint\nALTER TABLE "audit" ADD COLUMN "who" text NOT NULL;',
    'migrations/005.sql': 'CREATE UNIQUE INDEX CONCURRENTLY orders_ref ON orders (ref);',
  }, { oldVersion: true });
  assert.deepEqual(kinds(c), ['drop_column:destructive', 'required_column:risky', 'add_unique:warning'], 'an ADD next to a DROP is not a drop; the new table is skipped');
  assert.equal(c.status, 'destructive');
  assert.equal(c.files.length, 3);
});

test('ORM DSLs: Rails, Django, Alembic, Knex, Sequelize, Laravel and TypeORM, with down() ignored', () => {
  const rails = one('db/migrate/20261001_rename.rb', `class RenameName < ActiveRecord::Migration[7.1]
  def up
    rename_column :users, :name, :full_name
    add_column :users, :plan, :string, null: false
    add_column :users, :nick, :string, null: false, default: ""
    add_index :users, :email, unique: true
  end
  def down
    remove_column :users, :plan
  end
end`);
  assert.deepEqual(kinds(rails), ['rename_column:risky', 'required_column:risky', 'add_unique:warning'], 'Rails snake_case calls, never the down section');
  assert.equal(rails.changes[0]!.column, 'name');

  const django = one('shop/migrations/0007_auto.py', `operations = [
        migrations.RenameField(
            model_name='order',
            old_name='total',
            new_name='amount',
        ),
        migrations.RemoveField(model_name='order', name='legacy'),
        migrations.AlterField(model_name='order', name='note', field=models.TextField(blank=True)),
        migrations.AddField(model_name='order', name='region', field=models.CharField(max_length=8)),
        migrations.AddField(model_name='order', name='promo', field=models.CharField(max_length=8, null=True)),
    ]`);
  assert.deepEqual(kinds(django), ['rename_column:destructive', 'drop_column:destructive', 'required_column:risky', 'change_type:warning']);

  const alembic = one('alembic/versions/abc_people.py', `def upgrade():
    op.alter_column('users', 'name', new_column_name='full_name')
    op.add_column('users', sa.Column('plan', sa.String(), nullable=False))
    op.add_column('users', sa.Column('tier', sa.String(), nullable=False, server_default='free'))
    op.create_unique_constraint('uq_email', 'users', ['email'])

def downgrade():
    op.drop_table('users')
`);
  assert.deepEqual(kinds(alembic), ['rename_column:risky', 'required_column:risky', 'add_unique:warning']);

  const knex = one('migrations/20261001_people.js', `exports.up = function (knex) {
  return knex.schema.alterTable('users', (t) => {
    t.renameColumn('name', 'full_name');
    t.dropColumn('age');
    t.string('email', 320).alter();
  });
};
exports.down = function (knex) { return knex.schema.dropTable('users'); };`);
  assert.deepEqual(kinds(knex), ['rename_column:destructive', 'drop_column:destructive', 'change_type:risky']);
  assert.ok(knex.changes.every((c) => c.table === 'users'), 'the table comes from alterTable');

  const knexNew = one('migrations/20261002_posts.js', `exports.up = (knex) => knex.schema.createTable('posts', (t) => { t.increments(); });
exports.down = (knex) => knex.schema.dropTable('posts');`);
  assert.equal(knexNew.status, 'safe', 'a dropTable in down() never runs on deploy');

  const sequelize = one('migrations/20261003-orders.js', `module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.renameColumn('Orders', 'total', 'amount');
    await queryInterface.addColumn('Orders', 'region', { type: Sequelize.STRING, allowNull: false });
    await queryInterface.changeColumn('Orders', 'note', { type: Sequelize.TEXT });
  },
  down: async (queryInterface) => { await queryInterface.removeColumn('Orders', 'region'); },
};`);
  assert.deepEqual(kinds(sequelize), ['rename_column:destructive', 'required_column:risky', 'change_type:risky']);

  const laravel = one('database/migrations/2026_10_01_change_users.php', `public function up(): void {
    Schema::table('users', function (Blueprint $table) {
        $table->renameColumn('name', 'full_name');
        $table->string('bio', 500)->change();
    });
}
public function down(): void { Schema::dropIfExists('users'); }`);
  assert.deepEqual(kinds(laravel), ['rename_column:destructive', 'change_type:risky']);

  const typeorm = one('src/migrations/1700000000000-People.ts', `export class People1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(\`ALTER TABLE "user" RENAME COLUMN "name" TO "fullName"\`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(\`ALTER TABLE "user" RENAME COLUMN "fullName" TO "name"\`);
  }
}`);
  assert.deepEqual(kinds(typeorm), ['rename_column:destructive']);
  assert.equal(typeorm.changes[0]!.to, 'fullName');
});

test('down sections and down files never count: dbmate, goose, golang-migrate', () => {
  assert.equal(upPart('-- migrate:up\nALTER TABLE a ADD b int;\n-- migrate:down\nDROP TABLE a;', 'db/migrations/1.sql'), '-- migrate:up\nALTER TABLE a ADD b int;\n');
  assert.equal(one('db/migrations/2.sql', '-- +goose Up\nCREATE TABLE t (id int);\n-- +goose Down\nDROP TABLE t;').status, 'safe');
  assert.equal(one('migrations/000002_users.down.sql', 'DROP TABLE users;').status, 'safe');
  // no up marker before it: nothing is cut (never hide what runs)
  assert.equal(upPart('down(); dropTable("x")', 'm.js'), 'down(); dropTable("x")');
});

test('a drop the running version no longer mentions is the safe last step; one it still uses is not', () => {
  const body = { 'm.sql': 'ALTER TABLE "users" DROP COLUMN "legacy_flag";\nALTER TABLE "users" RENAME COLUMN "nick" TO "handle";' };
  const unused = checkMigrations(body, { oldVersion: true, used: () => false });
  assert.match(unused.changes.find((c) => c.kind === 'drop_column')!.why, /The running version doesn’t use it, so visitors won’t notice/);
  assert.equal(unused.changes.find((c) => c.kind === 'drop_column')!.level, 'destructive', 'its data is still gone: the data-loss guard still asks');
  assert.deepEqual(unused.changes.find((c) => c.kind === 'drop_column')!.steps, []);
  const used = checkMigrations(body, { oldVersion: true, used: (n) => n === 'nick' });
  assert.match(used.changes.find((c) => c.kind === 'rename_column')!.why, /The old version still uses the old name/);
  const rails = checkMigrations({ 'db/migrate/1_x.rb': 'def change\n  remove_column :users, :legacy_flag\nend' }, { oldVersion: true, used: () => false });
  assert.equal(rails.status, 'warning', 'not used and not a data-loss line the old guard knows: shown, not stopped');
});

test('the risky message: what, the two steps, and the way to go ahead; the last line is the plain why', () => {
  const c = one('drizzle/0003.sql', 'ALTER TABLE "orders" ADD COLUMN "region" text NOT NULL;');
  const m = riskyMessage(c);
  assert.match(m, /^The new version changes the database in a way that can break the version still serving, so Unit7 paused before running it\. The old version is still serving\./);
  assert.match(m, /\n1\. Add the column as optional, or give it a default\.\n2\. /);
  assert.match(m, /Go ahead anyway/);
  assert.match(m.split('\n').at(-1)!, /^This adds a required column/);
});

test('Postgres migrations run with a 5-second lock limit through PGOPTIONS, keeping the app’s own options', () => {
  const pg = withLockLimits({ DATABASE_URL: 'postgresql://app:pw@db:5432/app', PGOPTIONS: '-c search_path=app' });
  assert.equal(pg.PGOPTIONS, '-c search_path=app -c lock_timeout=5s -c statement_timeout=15min');
  assert.equal(withLockLimits({ DATABASE_URL: 'postgres://x@db/app', PGOPTIONS: '-c lock_timeout=2s' }).PGOPTIONS, '-c lock_timeout=2s -c statement_timeout=15min', 'the app’s own lock limit wins');
  assert.equal(withLockLimits({ DATABASE_URL: 'mysql://x@db/app' }).PGOPTIONS, undefined, 'only Postgres');
  const said: string[] = [];
  withLockLimits({ DATABASE_URL: 'postgres://x@db/app' }, (m) => said.push(m));
  assert.match(said[0]!, /wait at most 5s for a lock/);
  assert.match(lockHint('ERROR: canceling statement due to lock timeout'), /gave up after waiting 5s/);
  assert.equal(lockHint('syntax error'), '');
});

test('which names the running version still mentions: one grep inside it, and "can’t tell" when grep can’t run', async () => {
  const app = testApp();
  const ctx = { app } as unknown as Ctx;
  const s = { id: 'srv_x', name: 'box' } as never;
  let command = '';
  ssh(app).exec = async (_s, c) => { command = c; return { code: 0, stdout: 'nick\n@@rc=0\n', stderr: '', truncated: false }; };
  assert.deepEqual([...(await runningMentions(ctx, s, 'unit7-web-1', ['nick', 'legacy_flag', 'bad name;']))!], ['nick']);
  assert.match(command, /docker exec "\$1" grep -rIhowE/);
  assert.ok(command.includes(`'nick|legacy_flag'`), 'names go in as one argument, never as shell; odd ones are left out');
  ssh(app).exec = async () => ({ code: 0, stdout: '\n@@rc=1\n', stderr: '', truncated: false });
  assert.equal((await runningMentions(ctx, s, 'unit7-web-1', ['nick']))!.size, 0, 'grep ran and found none');
  ssh(app).exec = async () => ({ code: 0, stdout: '\n@@rc=126\n', stderr: '', truncated: false });
  assert.equal(await runningMentions(ctx, s, 'unit7-web-1', ['nick']), undefined, 'no grep in the image: can’t tell');
});
