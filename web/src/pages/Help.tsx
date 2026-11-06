// Help: short answers in plain words, a search over them, and a box that hands your question to
// Unit7's ask box on Home. Below, the ways to ask from your AI or a terminal (served by /api/help,
// the same guide as `unit7 help`).
import { useState, type FormEvent } from 'react';
import { ArrowUp, Rocket, Globe, Plug, Siren, ShieldCheck, Gauge, Lock, DatabaseBackup, Undo2, Pause, Bell, Terminal, SearchX, ArrowRight } from 'lucide-react';
import { useApi } from '../lib/api';
import { navigate } from '../lib/router';
import { AiButton, AiSparkle, Button, Card, CopyButton, IconCircle, PageHeader, SearchInput, Skeleton, cx } from '../ui';
import { fillAsk, sendAsk } from './Agent';
import type { ContextItem } from './chat/about';

interface HelpSection { title: string; intro?: string; items: { say: string; does: string }[] }
// the guide names commands and their arguments (cursor, claude-desktop…), so only the product name changes
const name = (t: string) => t.replace(/\bForge\b/g, 'Unit7');

const FAQ: { q: string; a: string; icon: typeof Rocket; go?: [string, string]; ask?: string }[] = [
  { q: 'How do I put my app online?', a: 'Ask Unit7 to deploy it. It finds your app, builds it and gives you a link. A broken new version never goes live.', icon: Rocket, ask: 'Deploy my app and give me the link' },
  { q: 'How do I use my own domain?', a: 'Connect the company your domain is with (Cloudflare, GoDaddy and others), then ask Unit7 to connect it. It sets up the address and HTTPS for you.', icon: Globe, go: ['Connections', '/connections#dns'] },
  { q: 'How do I connect my AI?', a: 'Open Connections and click Connect next to Claude Code, Cursor or another AI app. Then just ask it, and mention Unit7.', icon: Plug, go: ['Connections', '/connections'] },
  { q: 'What happens when something breaks?', a: 'Warden, Unit7’s guard, watches day and night. It restarts crashed apps, rolls back bad versions and tells you what it did.', icon: Siren, go: ['Activity', '/activity'] },
  { q: 'What needs my OK?', a: 'Anything risky: deleting things, spending money, changing a live app (depending on your Autopilot level). It waits on Approvals, and on your phone if you set up alerts.', icon: ShieldCheck, go: ['Approvals', '/approvals'] },
  { q: 'How much does Unit7 do on its own?', a: 'You choose, per environment, from “Watch only” to “Full autopilot”. Spending money always waits for you.', icon: Gauge, go: ['Autopilot', '/autopilot'] },
  { q: 'Are my keys safe?', a: 'They’re locked with a key kept in your Mac’s Keychain. Your AI only ever sees a key’s name, never the key itself.', icon: Lock },
  { q: 'Are my databases backed up?', a: 'Every day, and before risky changes. Copies also go off the server: to this computer, and to Google Drive, iCloud or a bucket if you add one.', icon: DatabaseBackup, go: ['Backup settings', '/settings?tab=backups'] },
  { q: 'How do I undo something?', a: 'Autopilot lists what Unit7 did on its own, with Undo where it can. Or ask Unit7 to roll your app back.', icon: Undo2, ask: 'Roll back my app to the previous version' },
  { q: 'How do I stop everything?', a: 'On Autopilot, press Pause everything. Unit7 and your AI can still look, but nothing changes until you turn it back on.', icon: Pause, go: ['Autopilot', '/autopilot'] },
  { q: 'Can I get alerts on my phone?', a: 'Yes. On Connections, set up phone alerts with the free ntfy app: scan a code with your phone, then tap once to prove it gets them. No account needed.', icon: Bell, go: ['Connections', '/connections#alerts'] },
];

// go Home and put the question in the ask box (it waits for the box to be on screen); send: ask it straight away;
// context: what it's about (a server, app, domain…), as a chip in the box
export function askOnHome(text: string, o: { send?: boolean; context?: ContextItem[] } = {}) {
  navigate('/');
  let tries = 0;
  const go = () => { if (document.getElementById('unit7-command')) setTimeout(() => (o.send ? sendAsk : fillAsk)(text, o.context), 30); else if (++tries < 60) setTimeout(go, 50); };
  setTimeout(go, 50);
}

// "Ask Unit7" from any page: puts a ready sentence in Home's ask box (nothing runs until you press Enter).
// The next step for any status Unit7 has no one-click tool for. It wears the AI look; primary is the filled one.
export function AskButton({ prompt, label = 'Ask Unit7 to fix it', size = 'sm', variant = 'soft', className, about }: { prompt: string; label?: string; size?: 'sm' | 'md'; variant?: 'primary' | 'soft' | 'secondary' | 'ghost'; className?: string; about?: ContextItem }) {
  return (
    <AiButton type="button" size={size} strong={variant === 'primary'} className={className}
      title="Opens Home with this question ready. Nothing happens until you send it." onClick={(e) => { e.stopPropagation(); askOnHome(prompt, { context: about ? [about] : undefined }); }}>
      {label}
    </AiButton>
  );
}

export function HelpPage() {
  const help = useApi<HelpSection[]>('/api/help', { live: false });
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const faq = FAQ.filter((f) => !needle || `${f.q} ${f.a}`.toLowerCase().includes(needle));
  const sections = (help.data ?? []).map((s) => ({ ...s, items: s.items.filter((i) => !needle || `${i.say} ${name(i.does)}`.toLowerCase().includes(needle)) })).filter((s) => s.items.length);

  return (
    <>
      <PageHeader title="Help" subtitle="Short answers in plain words. Or just ask Unit7." />
      <TalkBox />

      <div className="mt-10 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <h2 className="px-1 text-[18px] font-semibold tracking-[-0.025em]">Common questions</h2>
        <SearchInput value={q} onChange={setQ} placeholder="Search help" label="Search help" className="md:w-[320px]" />
      </div>
      {faq.length === 0 && !sections.length ? (
        <Card className="mt-4 flex flex-col items-center px-6 py-12 text-center">
          <IconCircle size={52} className="text-muted"><SearchX size={24} /></IconCircle>
          <p className="mt-4 text-[15px] font-medium">No answers mention “{q.trim()}”</p>
          <p className="mt-1 text-[13.5px] text-muted">Unit7 can probably tell you, though.</p>
          <AiButton strong className="mt-5" onClick={() => askOnHome(q.trim())}>Ask Unit7</AiButton>
        </Card>
      ) : (
        <div key={needle} className="stagger mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3 min-[105rem]:grid-cols-4">
          {faq.map((f) => (
            <Card key={f.q} className="flex flex-col p-5 md:p-6">
              <IconCircle size={40}><f.icon size={18} /></IconCircle>
              <h3 className="mt-4 text-[16px] font-semibold tracking-[-0.015em]">{f.q}</h3>
              <p className="mt-1.5 flex-1 text-[13.5px] leading-relaxed text-muted">{f.a}</p>
              {(f.go || f.ask) && (
                <div className="mt-4">
                  {f.ask ? <AiButton size="sm" onClick={() => askOnHome(f.ask!)}>Ask Unit7 to do it</AiButton>
                    : <Button size="sm" variant="soft" onClick={() => navigate(f.go![1])}>Open {f.go![0]}<ArrowRight size={14} /></Button>}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <section aria-labelledby="ways-h" className="mt-12 space-y-4">
        <div className="px-1">
          <h2 id="ways-h" className="text-[18px] font-semibold tracking-[-0.025em]">Ways to ask</h2>
          <p className="mt-0.5 text-[13.5px] text-muted">From your AI, or from a terminal. Copy any line.</p>
        </div>
        {!help.data ? <Skeleton className="h-64 rounded-[24px]" /> : !sections.length ? (
          <p className="px-1 text-[13.5px] text-muted">Nothing here mentions “{q.trim()}”.</p>
        ) : (
          <div className="stagger grid gap-4 lg:grid-cols-2">
            {sections.map((s) => (
              <Card key={s.title} className="min-w-0 p-5 md:p-6">
                <h3 className="text-[16px] font-semibold tracking-[-0.015em]">{name(s.title.replace(/^\d+\.\s*/, ''))}</h3>
                {s.intro && <p className="mt-1 text-[13px] text-muted">{name(s.intro)}</p>}
                <ul className="mt-3 divide-y divide-line">
                  {s.items.map((i) => {
                    const command = /^(unit7 |\/unit7)/.test(i.say);
                    return (
                      <li key={i.say} className="py-3">
                        {command ? (
                          <span className="inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full bg-raised py-0.5 pl-3 pr-0.5">
                            <Terminal size={12} aria-hidden className="shrink-0 text-muted" />
                            <code className="min-w-0 truncate font-mono text-[12.5px] text-ink" title={i.say}>{i.say}</code>
                            <CopyButton text={i.say.replace(/<[^>]+>/g, '').trim()} />
                          </span>
                        ) : <p className="text-[14px] font-medium">{i.say}</p>}
                        <p className="mt-1 text-[13px] text-muted">{name(i.does)}</p>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// "Talk to Unit7": a soft card like the ask box on Home; sending takes your words there
function TalkBox() {
  const [text, setText] = useState('');
  const send = (e: FormEvent) => { e.preventDefault(); if (text.trim()) askOnHome(text.trim()); };
  return (
    <section aria-label="Talk to Unit7" className="animate-rise relative overflow-hidden rounded-[28px] border border-line bg-surface p-5 shadow-soft md:p-8">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-90 dark:opacity-40"
        style={{ background: 'radial-gradient(40% 70% at 0% 0%, rgb(31 91 255 / 0.18), transparent 70%), radial-gradient(35% 60% at 100% 0%, rgb(255 160 200 / 0.22), transparent 70%), radial-gradient(40% 70% at 100% 100%, rgb(198 244 50 / 0.26), transparent 70%)' }} />
      <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:gap-8">
        <div className="md:w-[300px] md:shrink-0">
          <p className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.025em]"><AiSparkle size={20} />Talk to Unit7</p>
          <p className="mt-1 text-[13.5px] text-muted">Ask anything about your apps, or tell it what to do. It answers on Home.</p>
        </div>
        <form onSubmit={send} className="flex min-w-0 flex-1 items-center gap-2 rounded-[22px] border border-line-strong bg-surface p-2 pl-5 shadow-soft transition focus-within:border-blue focus-within:ring-4 focus-within:ring-blue-soft">
          <label htmlFor="help-ask" className="sr-only">Ask Unit7</label>
          <input id="help-ask" value={text} onChange={(e) => setText(e.target.value)} placeholder="Why is my site slow?" autoComplete="off"
            className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint focus-visible:outline-none" />
          <button type="submit" aria-label="Ask Unit7" disabled={!text.trim()}
            className={cx('grid size-11 shrink-0 place-items-center rounded-full bg-blue text-white transition hover:brightness-110 active:scale-95', !text.trim() && 'opacity-45')}>
            <ArrowUp size={19} />
          </button>
        </form>
      </div>
    </section>
  );
}
