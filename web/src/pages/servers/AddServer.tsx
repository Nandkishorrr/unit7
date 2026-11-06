// "Add a server", made inviting: the 3D server, one line of what Unit7 does with it, and the two ways in (a Hostinger
// VPS in one click, or any Linux server you can log in to). The big version is the empty Servers page; the small one
// is the last card in the list.
import { useRef, type ReactNode } from 'react';
import { ArrowDown, Check, Terminal } from 'lucide-react';
import { openSignIn } from '../../lib/actions';
import { Button, Illustration } from '../../ui';
import { LogoTile } from '../kit';

const DOES = 'Unit7 sets it up (Docker, automatic HTTPS, a firewall, security updates), deploys your apps to it and keeps watch day and night.';

// the Hostinger card sits right after this one on the page; "Show my VPS" scrolls to it
function useNextScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const go = () => ref.current?.nextElementSibling?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  return [ref, go] as const;
}

export function AddServerWelcome({ hostinger, onAdd }: { hostinger: boolean; onAdd: () => void }) {
  const [ref, showVps] = useNextScroll<HTMLElement>();
  return (
    <section ref={ref} aria-labelledby="add-server-h" className="illo-host relative overflow-hidden rounded-[28px] border border-line bg-surface p-5 shadow-soft sm:p-8 animate-rise">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full bg-[#e7e2ff] opacity-70 blur-3xl dark:bg-[#3a3470] dark:opacity-40" />
      <div aria-hidden className="pointer-events-none absolute -bottom-28 left-10 size-64 rounded-full bg-[#ebfbc9] opacity-60 blur-3xl dark:bg-[#2c3a17] dark:opacity-40" />
      <div className="relative flex flex-col items-center gap-5 text-center sm:flex-row sm:text-left">
        <Illustration name="add-server" size={148} className="w-[120px] sm:w-[148px]" />
        <div className="min-w-0">
          <h2 id="add-server-h" className="text-[24px] font-semibold tracking-[-0.03em] sm:text-[28px]">Add your first server</h2>
          <p className="mt-1.5 max-w-xl text-[14.5px] text-ink-2">{DOES}</p>
        </div>
      </div>
      <div className="relative mt-6 grid gap-3 md:grid-cols-2">
        <Way logo="hostinger" title="A Hostinger VPS" tag="One click"
          body={hostinger ? 'Your Hostinger account is connected. Pick a VPS below and it’s ready in a few minutes.' : 'Sign in to Hostinger once, pick a VPS, and Unit7 does the rest.'}
          action={hostinger ? <Button variant="primary" icon={<ArrowDown size={15} />} onClick={showVps}>Show my VPS</Button>
            : <Button variant="primary" onClick={() => openSignIn('hostinger', 'Hostinger')}>Connect Hostinger</Button>} />
        <Way icon={<Terminal size={20} />} title="A server you already have"
          body="Any Linux VPS you can log in to: DigitalOcean, Hetzner, AWS and others. Unit7 can make the login key for you."
          action={<Button variant="secondary" onClick={onAdd}>Connect a VPS</Button>} />
      </div>
    </section>
  );
}

function Way({ logo, icon, title, tag, body, action }: { logo?: string; icon?: ReactNode; title: string; tag?: string; body: string; action: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-[22px] border border-line bg-surface/80 p-4 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <LogoTile id={logo} size={40}>{icon && <span className="text-ink-2">{icon}</span>}</LogoTile>
        <p className="min-w-0 flex-1 text-[15px] font-semibold tracking-[-0.015em]">{title}</p>
        {tag && <span className="inline-flex h-6 items-center gap-1 rounded-full bg-lime px-2.5 text-[11.5px] font-semibold text-lime-ink"><Check size={12} strokeWidth={3} aria-hidden />{tag}</span>}
      </div>
      <p className="text-[13px] text-muted">{body}</p>
      <div className="mt-auto">{action}</div>
    </div>
  );
}

// the last card in the server list
export function AddServerCard({ hostinger, onAdd }: { hostinger: boolean; onAdd: () => void }) {
  return (
    <div className="illo-host lift flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-[24px] border-2 border-dashed border-line-strong p-5 text-center transition-colors hover:border-blue">
      <Illustration name="add-server" size={88} />
      <p className="mt-1 text-[15px] font-semibold tracking-[-0.015em]">Add a server</p>
      <p className="max-w-[300px] text-[12.5px] text-muted">Unit7 sets it up, deploys your apps to it and keeps watch.</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {!hostinger && <Button size="sm" variant="primary" onClick={() => openSignIn('hostinger', 'Hostinger')}>Hostinger VPS in one click</Button>}
        <Button size="sm" variant={hostinger ? 'primary' : 'secondary'} onClick={onAdd}>Connect a VPS</Button>
      </div>
      {hostinger && <p className="text-[12px] text-muted">Or pick a Hostinger VPS below, one click each.</p>}
    </div>
  );
}
