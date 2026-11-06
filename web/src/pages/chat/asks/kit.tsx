// What every ask card shares: the frame (icon, the question, a note), the footer with "Not now" and the main
// button, and the plain words for an answer once it's given.
import type { ReactNode } from 'react';
import { AppWindow, Database, FolderGit2, Globe, KeyRound, ListChecks, Server } from 'lucide-react';
import { Button, IconCircle, cx } from '../../../ui';
import type { AskAnswer, AskSource, AskSpec } from '../types';

export interface KindProps<S extends AskSpec['kind']> {
  spec: Extract<AskSpec, { kind: S }>;
  askId: string;
  busy: boolean;
  error?: string;
  send: (answer: AskAnswer, shown?: string) => void; // shown: the summary while the server confirms
}

export const SOURCE_ICON: Record<AskSource, typeof Globe> = { domains: Globe, apps: AppWindow, servers: Server, projects: FolderGit2, databases: Database, accounts: KeyRound };
export const sourceIcon = (s?: AskSource) => (s ? SOURCE_ICON[s] : ListChecks);
// what a source's things are called, one and many
export const SOURCE_WORDS: Record<AskSource, [string, string]> = {
  domains: ['domain', 'domains'], apps: ['website', 'websites'], servers: ['server', 'servers'], projects: ['project', 'projects'], databases: ['database', 'databases'], accounts: ['account', 'accounts'],
};

export function AskFrame({ icon, tone = 'soft', title, note, titleId, children, footer, className }: {
  icon: ReactNode; tone?: 'soft' | 'bad' | 'lime' | 'dark'; title: string; note?: string; titleId: string; children?: ReactNode; footer?: ReactNode; className?: string;
}) {
  return (
    <section aria-labelledby={titleId} className={cx('@container animate-rise w-full min-w-0 rounded-[24px] border border-line bg-surface p-4 shadow-soft @md:p-5', className)}>
      <header className="flex items-start gap-3">
        <IconCircle tone={tone} size={36}>{icon}</IconCircle>
        <div className="min-w-0 flex-1 pt-[7px]">
          <h3 id={titleId} className="text-[15px] font-semibold leading-snug tracking-[-0.015em] text-ink">{title}</h3>
          {note && <p className="mt-0.5 text-[13px] text-muted">{note}</p>}
        </div>
      </header>
      {children && <div className="mt-4">{children}</div>}
      {footer && <div className="mt-4 flex flex-wrap items-center gap-2">{footer}</div>}
    </section>
  );
}

// "Not now" on the left, the error (if the answer didn't go through) in the middle, the main button on the right
export function Footer({ onSkip, skipLabel = 'Not now', busy, error, children }: { onSkip: () => void; skipLabel?: string; busy: boolean; error?: string; children: ReactNode }) {
  return (
    <>
      <Button size="md" variant="ghost" onClick={onSkip} disabled={busy}>{skipLabel}</Button>
      <span className="min-w-0 flex-1">{error && <span role="alert" className="block text-[12.5px] text-bad">{error}</span>}</span>
      {children}
    </>
  );
}

// an answer in a few words: "example.com", "Confirmed", "Name api · API key saved"
export function answerWords(spec: AskSpec, a: AskAnswer): string {
  if ('cancelled' in a) return 'Skipped';
  if (spec.kind === 'choose') {
    if ('new' in a) return spec.allowNew?.label ?? 'Add a new one';
    if ('labels' in a) return a.labels.join(', ');
  }
  if (spec.kind === 'confirm' && 'ok' in a) return a.ok ? 'Confirmed' : 'Not now';
  if (spec.kind === 'folder' && 'uploadId' in a) return a.name ?? 'Your site';
  if (spec.kind === 'hide') {
    if ('hidden' in a) return !a.hidden ? 'Kept it showing' : a.forGood ? 'Fine for good' : a.until ? `Hidden until ${new Date(a.until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : 'Hidden';
    if ('done' in a) return 'Hidden';
  }
  if (spec.kind === 'delete' && 'outcome' in a) return a.outcome === 'deleted' ? 'Deleted' : a.outcome === 'archived' ? 'Archived instead' : 'Stopped it';
  if (spec.kind === 'form' && 'values' in a) {
    return spec.fields.filter((f) => a.values[f.id]).map((f) => (f.type === 'secret' ? `${f.label} saved securely` : `${f.label} ${a.values[f.id]}`)).join(' · ') || 'Sent';
  }
  return 'Answered';
}
