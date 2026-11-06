// The Test and Database steps of a release (Z6, Z4): what the tests said and what each database change does to the version
// still serving, in plain words, with the SQL and the last log lines under Advanced. The Release timeline shows TestStep and
// DbStep inside its Test and Database steps; ReleaseChecks is the app page's card for the newest deploy, with the way out
// when it stopped there: "Deploy anyway" / "Go ahead anyway" are a person's, held to confirm.
import { useState, type ReactNode } from 'react';
import { ChevronDown, Database, FlaskConical } from 'lucide-react';
import { act, Badge, Button, cx, HoldButton, HoverCard, StatusMark, type MarkState } from '../../ui';
import { Choices } from '../choices';
import { pick } from '../../lib/choices';

// the server's shapes: src/deploy/migcheck.ts DbCheck, src/deploy/testgate.ts TestResult, service.get's `safety`
export interface DbChange { kind: string; level: 'warning' | 'risky' | 'destructive'; file: string; sql: string; table?: string; column?: string; to?: string; title: string; why: string; steps: string[] }
export interface DbCheck { status: 'safe' | 'warning' | 'risky' | 'destructive'; summary: string; files: string[]; changes: DbChange[]; oldVersion: boolean; lockLimit?: string; held?: boolean; goAhead?: string }
export interface TestResult { status: 'passed' | 'failed' | 'timeout' | 'skipped' | 'off' | 'none'; label?: string; ms?: number; failure?: string; hint?: string; tail?: string[]; tip?: string; by?: string }
export interface Safety { deploymentId?: string; number?: number; tests?: TestResult; dbCheck?: DbCheck; stoppedAt?: 'tests' | 'database'; runTests: boolean; hasTests?: boolean }

const TEST_MARK: Record<TestResult['status'], MarkState> = { passed: 'ok', failed: 'bad', timeout: 'bad', skipped: 'warn', off: 'off', none: 'off' };
const DB_MARK: Record<DbCheck['status'], MarkState> = { safe: 'ok', warning: 'warn', risky: 'warn', destructive: 'bad' };
const LEVEL_WORD: Record<DbChange['level'], [string, 'warn' | 'bad' | 'neutral']> = { warning: ['Good to know', 'neutral'], risky: ['Can break the old version', 'warn'], destructive: ['Removes data', 'bad'] };
const secs = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export function testLine(t: TestResult): string {
  switch (t.status) {
    case 'passed': return `${t.label ? `${t.label}: ` : ''}all tests passed${t.ms ? ` in ${secs(t.ms)}` : ''}`;
    case 'failed': case 'timeout': return t.failure ?? 'A test failed';
    case 'skipped': return `Deployed without running the tests (${t.by ?? 'a person'} chose to)`;
    case 'off': return 'Tests are turned off for this app';
    case 'none': return 'No tests found in the code';
  }
}

// Advanced: closed by default, a native disclosure (keyboard and readers for free)
function Advanced({ label = 'Advanced', children }: { label?: string; children: ReactNode }) {
  return (
    <details className="group mt-1.5 open:basis-full">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-full text-[12px] font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        {label}<ChevronDown size={13} aria-hidden className="transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}
const Code = ({ children }: { children: ReactNode }) => (
  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[12px] bg-sunken p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{children}</pre>
);

export function TestStep({ tests, className }: { tests: TestResult; className?: string }) {
  return (
    <div className={cx('min-w-0', className)}>
      <p className="flex items-start gap-2 text-[13.5px] text-ink"><StatusMark state={TEST_MARK[tests.status]} size={18} className="mt-px" /><span className="min-w-0">{testLine(tests)}</span></p>
      {(tests.hint || tests.tip) && <p className="mt-1 sm:pl-[26px] text-[12.5px] text-muted">{tests.hint ?? tests.tip!.replace(/^Tip: /, '')}</p>}
      {!!tests.tail?.length && <div className="sm:pl-[26px]"><Advanced label="Last 30 lines"><Code>{tests.tail.join('\n')}</Code></Advanced></div>}
    </div>
  );
}

function Change({ c }: { c: DbChange }) {
  const [word, tone] = LEVEL_WORD[c.level];
  return (
    <li className="min-w-0 rounded-[14px] bg-surface p-3 ring-1 ring-inset ring-line">
      <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-ink">{c.title}<Badge tone={tone}>{word}</Badge></p>
      <p className="mt-1 text-[13px] text-ink-2">{c.why}</p>
      <div className="flex flex-wrap items-start gap-x-4">
        {!!c.steps.length && (
          <Advanced label="Do it in two steps">
            <HoverCard content={<p className="max-w-[260px] text-[12.5px]">Both versions run side by side for about a minute while visitors move over. Doing it in steps keeps the old one working the whole time.</p>}>
              <span className="cursor-help text-[12px] text-muted underline decoration-dotted underline-offset-2">Why two steps?</span>
            </HoverCard>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[12.5px] text-ink-2 marker:text-muted">{c.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          </Advanced>
        )}
        <Advanced><p className="mb-1 truncate text-[11.5px] text-muted" title={c.file}>{c.file}</p><Code>{c.sql}</Code></Advanced>
      </div>
    </li>
  );
}

export function DbStep({ check, className }: { check: DbCheck; className?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? check.changes : check.changes.slice(0, 3);
  return (
    <div className={cx('min-w-0', className)}>
      <p className="flex items-start gap-2 text-[13.5px] text-ink"><StatusMark state={check.goAhead ? 'warn' : DB_MARK[check.status]} size={18} className="mt-px" /><span className="min-w-0">{check.summary}</span></p>
      {check.goAhead && <p className="mt-1 sm:pl-[26px] text-[12.5px] text-muted">{check.goAhead} chose to go ahead anyway.</p>}
      {!!shown.length && <ul className="mt-2 space-y-2 sm:pl-[26px]">{shown.map((c) => <Change key={`${c.kind}${c.file}${c.sql}`} c={c} />)}</ul>}
      {check.changes.length > 3 && !all && <button type="button" onClick={() => setAll(true)} className="mt-1.5 sm:pl-[26px] text-[12px] font-medium text-blue-text hover:underline">+{check.changes.length - 3} more</button>}
    </div>
  );
}

function Row({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5 first:pt-1 last:pb-0">
      <span aria-hidden className="mt-0.5 hidden size-7 shrink-0 sm:grid place-items-center rounded-full bg-surface text-muted ring-1 ring-inset ring-line">{icon}</span>
      <div className="min-w-0 flex-1"><p className="text-[12px] font-medium text-muted">{title}</p>{children}</div>
    </div>
  );
}

// The newest deploy's Test and Database steps on the app page, and the way out when it stopped at one of them.
export function ReleaseChecks({ serviceId, safety, className }: { serviceId: string; safety: Safety; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState(false); // "Cancel": keep the version that's serving, put the choice away
  const { tests, dbCheck, stoppedAt } = safety;
  const quiet = (!tests || tests.status === 'none' && !tests.tip) && (!dbCheck || (dbCheck.status === 'safe' && !dbCheck.changes.length && !dbCheck.files.length));
  if ((!tests && !dbCheck) || (quiet && !stoppedAt)) return null;
  const stopped = !!stoppedAt && !kept;
  const go = async (input: Record<string, unknown>, success: string) => { setBusy(true); await act('deployment.create', { serviceId, ...input }, { success }); setBusy(false); };
  const hold = 'bg-ink text-bg hover:brightness-110';
  return (
    <section aria-label={`Checks on v${safety.number ?? ''}`} className={cx('rounded-[18px] p-4 animate-rise', stopped ? 'bg-warn/8 ring-1 ring-inset ring-warn/30' : 'bg-raised', className)}>
      <p className="text-[12.5px] font-medium text-ink-2">{stopped ? `v${safety.number} stopped before anything changed` : `Checks on v${safety.number}`}</p>
      <div className="divide-y divide-line">
        {tests && <Row icon={<FlaskConical size={14} />} title="Test"><TestStep tests={tests} /></Row>}
        {dbCheck && <Row icon={<Database size={14} />} title="Database"><DbStep check={dbCheck} /></Row>}
      </div>
      {/* the way out, as one choice row: fixing it is recommended; going ahead anyway is a person's, held to confirm */}
      {stopped && (
        <div className="mt-3">
          <Choices disabled={busy} label="What to do now" onPick={(c) => {
            if (c.key === 'keep') { setKept(true); return true; }
            if (c.key === 'tests') { void go({ skipTests: true }, 'Deploying without the tests'); return true; }
            if (c.key === 'destructive') { void go({ allowDestructiveMigration: true }, 'Backed up, migrated and deployed'); return true; }
            if (c.key === 'risky') { void go({ allowRiskyMigration: true }, 'Going ahead with the database change'); return true; }
            return false;
          }} choices={pick([
            { label: 'Ask Unit7 to fix it', recommended: true, why: 'the old version is still serving, so there’s time to fix the cause first',
              ask: stoppedAt === 'tests' ? `The tests stopped v${safety.number} before it deployed: ${(tests?.failure ?? '').slice(0, 300)}. Find out why and fix it.` : `The database check stopped v${safety.number}: ${(dbCheck?.summary ?? '').slice(0, 300)}. Show me how to make this change safely, in two steps if it needs them.` },
            stoppedAt === 'tests' ? { key: 'tests', label: 'Deploy anyway', risk: 'danger', peopleOnly: true, change: 'Deploys without running the tests' }
              : dbCheck?.status === 'destructive' ? { key: 'destructive', label: 'Back up and go ahead', risk: 'danger', peopleOnly: true, change: 'Takes a backup, then runs the change that removes data' }
              : { key: 'risky', label: 'Go ahead anyway', risk: 'danger', peopleOnly: true, change: 'Runs the database change while the old version still serves' },
            { key: 'keep', label: 'Keep the old version', why: 'nothing changes' },
          ])} />
        </div>
      )}
    </section>
  );
}
