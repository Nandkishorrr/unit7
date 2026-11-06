// A failed step in the chat answers with buttons by itself, no AI turn needed: its choices (lib/choices.ts), the
// recommended one first. A click runs the tool as the person, or sends the sentence as the person's reply. When the
// step failed because something isn't set up yet, "Set it up" opens that setup right here as its own step (connect
// the account, phone alerts, Coolify; the server and domain pop-ups), and once it's done "Continue" carries the task on.
import { useState } from 'react';
import { ArrowUpRight, Check, Plus, X } from 'lucide-react';
import { Button, IconCircle, cx } from '../../ui';
import { navigate } from '../../lib/router';
import { continueText, pick, setupHref, setupTitle, stepChoices, type Choice, type Setup } from '../../lib/choices';
import { Choices } from '../choices';
import { sendAsk } from '../Agent';
import { ConnectInline } from '../Connections';
import { ConnectServer } from '../Servers';
import { ConnectFlow } from '../servers/CoolifyTile';
import { DomainLaunch } from '../flow/DomainLaunch';
import type { ToolStep } from './types';

export function StepChoices({ id, step, href, className }: { id: string; step: ToolStep; href?: string; className?: string }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [ready, setReady] = useState(false);
  const choices = stepChoices(step, href);
  if (!choices.length) return null;
  // the chat's own way for a choice: a sentence is the person's reply here; a setup opens below
  const here = (c: Choice) => {
    if (c.setup) { setSetup(c.setup); setReady(false); return true; }
    if (c.ask) { sendAsk(c.ask); return true; }
    return false;
  };
  if (setup && ready) {
    const again = choices.find((c) => c.tool && c.label === 'Try again');
    return (
      <div className={cx('animate-rise', className)}>
        <p className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-ok"><Check size={14} strokeWidth={3} />{setupTitle(setup)}: done</p>
        <Choices id={id} label="Carry on" choices={pick([{ label: 'Continue', ask: continueText(setup), recommended: true, why: 'it’s set up now, so Unit7 can carry on with the task' }, again, { label: 'Not now', key: 'later', why: 'nothing else happens' }])}
          onPick={(c) => (c.key === 'later' ? (setSetup(null), true) : here(c))} />
      </div>
    );
  }
  return (
    <div className={cx('min-w-0', className)}>
      {!setup && <Choices id={id} choices={choices} onPick={here} />}
      {setup && <SetupStep setup={setup} onDone={() => setReady(true)} onCancel={() => setSetup(null)} />}
    </div>
  );
}

// the setup as its own step in the thread
export function SetupStep({ setup, onDone, onCancel }: { setup: Setup; onDone: () => void; onCancel: () => void }) {
  const [open, setOpen] = useState(true); // the server and domain pop-ups
  const page = setupHref(setup);
  let body;
  if (setup.kind === 'account' || setup.kind === 'phone') body = <ConnectInline provider={setup.kind === 'phone' ? 'ntfy' : setup.provider} onDone={onDone} />;
  else if (setup.kind === 'coolify' && setup.serverId) body = <ConnectFlow serverId={setup.serverId} serverName="your server" human onConnected={onDone} />;
  else if (setup.kind === 'server' || setup.kind === 'domain') body = (
    <>
      {setup.kind === 'server' ? <ConnectServer open={open} onClose={() => setOpen(false)} onConnected={onDone} stay /> : <DomainLaunch open={open} onClose={() => setOpen(false)} />}
      <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">{open ? (setup.kind === 'server' ? 'Connect it in the pop-up.' : 'Set it up in the pop-up.') : 'Closed before it finished?'}
        {!open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Open it again</Button>}
        {!open && setup.kind === 'domain' && <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={onDone}>It’s set up</Button>}</p>
    </>
  );
  else body = (
    <div className="flex flex-wrap items-center gap-2">
      {page && <Button size="sm" variant="secondary" icon={<ArrowUpRight size={13} />} onClick={() => navigate(page)}>Open it</Button>}
      <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={onDone}>I’ve done it</Button>
    </div>
  );
  return (
    <section aria-label={setupTitle(setup)} className="animate-rise rounded-[20px] border border-blue/25 bg-surface p-4 ring-4 ring-blue-soft/60">
      <header className="mb-3 flex items-center gap-3">
        <IconCircle tone="blue" size={32}><Plus size={15} /></IconCircle>
        <p className="min-w-0 flex-1 text-[14px] font-semibold tracking-[-0.01em] text-ink">Set it up <span className="font-normal text-muted">· {setupTitle(setup)}</span></p>
        <button type="button" onClick={onCancel} aria-label="Not now" className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-raised hover:text-ink"><X size={15} /></button>
      </header>
      {body}
    </section>
  );
}
