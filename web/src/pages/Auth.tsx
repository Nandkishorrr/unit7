import { useState, type FormEvent } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Fingerprint, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { tidy } from '../lib/words';
import { Button, CopyButton, Field, Input, toast } from '../ui';
import { Logo } from '../brand/Logo';

// a centered card on the soft canvas, with the pastel glow from Home's ask box behind it
function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-bg px-4 py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 dark:opacity-40"
        style={{ background: 'radial-gradient(38% 45% at 12% 8%, rgb(31 91 255 / 0.16), transparent 70%), radial-gradient(34% 42% at 92% 6%, rgb(255 160 200 / 0.22), transparent 70%), radial-gradient(40% 48% at 88% 96%, rgb(198 244 50 / 0.26), transparent 70%), radial-gradient(30% 40% at 6% 92%, rgb(160 140 255 / 0.16), transparent 70%)' }} />
      <div className="relative w-full max-w-[420px] animate-rise">
        <div className="mb-7 flex justify-center"><Logo size={34} /></div>
        <div className="rounded-[32px] border border-line bg-surface/90 p-6 shadow-float backdrop-blur-xl sm:p-9">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.04em]">{title}</h1>
          <p className="mt-1.5 text-[14.5px] text-muted">{subtitle}</p>
          <div className="mt-7">{children}</div>
        </div>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[12.5px] text-muted"><Lock size={12} />Unit7 runs on your own computer. Your keys stay on it.</p>
      </div>
    </div>
  );
}

export function AuthScreen({ firstRun, onDone }: { firstRun: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null); // said next to the form too, with what to do about it
  const [f, setF] = useState({ name: '', email: '', password: '', orgName: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(firstRun ? '/api/auth/signup' : '/api/auth/login', { body: firstRun ? f : { email: f.email, password: f.password } });
      onDone();
    } catch (e) {
      const msg = tidy((e as Error).message);
      if (firstRun) toast('bad', 'Couldn’t create your account', msg); else setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    if (!passkeyHere()) return;
    try {
      const { key, options } = await api('/api/auth/passkey/login/options', { body: {} });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/api/auth/passkey/login/verify', { body: { key, response } });
      onDone();
    } catch (err) {
      toast('bad', 'That passkey didn’t work', tidy((err as Error).message));
    }
  };

  if (firstRun) {
    return (
      <Frame title="Set up Unit7" subtitle="You’re the first one here, so this Unit7 is yours. Invite your team later.">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Your name"><Input autoFocus required value={f.name} onChange={set('name')} autoComplete="name" /></Field>
          <Field label="Email"><Input required type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
          <Field label="Password" hint="At least 10 characters. You can add a passkey after."><Input required type="password" minLength={10} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
          <Field label="Organization" hint="Your company, agency or just your name."><Input value={f.orgName} onChange={set('orgName')} placeholder="Acme" /></Field>
          <Button variant="primary" size="lg" className="w-full" loading={busy}>Create my Unit7</Button>
        </form>
      </Frame>
    );
  }
  return (
    <Frame title="Welcome back" subtitle="Sign in to your Unit7.">
      <Button variant="dark" size="lg" className="w-full" icon={<Fingerprint size={17} />} onClick={passkey}>Sign in with a passkey</Button>
      <div className="my-6 flex items-center gap-3 text-[12.5px] text-muted"><div className="h-px flex-1 bg-line-strong" />or with email<div className="h-px flex-1 bg-line-strong" /></div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email"><Input autoFocus required type="email" value={f.email} onChange={set('email')} autoComplete="username webauthn" /></Field>
        <Field label="Password"><Input required type="password" value={f.password} onChange={set('password')} autoComplete="current-password" aria-invalid={!!err || undefined} aria-describedby={err ? 'signin-error' : undefined} /></Field>
        {err && <p id="signin-error" role="alert" className="rounded-[14px] bg-bad/8 px-3.5 py-2.5 text-[13px] text-ink-2"><span className="font-medium text-bad">Couldn’t sign you in.</span> {err}</p>}
        <Button variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
      </form>
      <details className="group mt-5 text-[13px] text-muted">
        <summary className="cursor-pointer list-none text-center font-medium hover:text-ink [&::-webkit-details-marker]:hidden">Forgot your password?</summary>
        <div className="mt-3 rounded-[16px] bg-raised p-3.5">
          <p>On the computer where Unit7 runs, open Terminal and type:</p>
          <p className="mt-2 flex items-center gap-1 rounded-full bg-surface py-0.5 pl-3 pr-0.5"><code className="flex-1 font-mono text-[12.5px] text-ink">unit7 password</code><CopyButton text="unit7 password" /></p>
          <p className="mt-2">Pick a new one there, then sign in here.</p>
        </div>
      </details>
    </Frame>
  );
}

export function InviteScreen({ token, signedIn, onDone }: { token: string; signedIn: boolean; onDone: () => void }) {
  const [f, setF] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  const accept = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/invites/accept', { body: { token, ...(signedIn ? {} : f) } });
      toast('ok', 'You’re in');
      onDone();
    } catch (err) {
      toast('bad', 'Couldn’t accept the invite', tidy((err as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Join the team" subtitle={signedIn ? 'Accept this invite with the account you’re signed in with.' : 'Pick a name and a password to join.'}>
      <form onSubmit={accept} className="space-y-4">
        {!signedIn && <>
          <Field label="Your name"><Input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Password" hint="At least 10 characters."><Input required type="password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
          <p className="text-[12.5px] text-muted">Already have an account? Sign in first, then open this link again.</p>
        </>}
        <Button variant="primary" size="lg" className="w-full" loading={busy}>Join the team</Button>
      </form>
    </Frame>
  );
}

// Passkeys belong to a name like localhost, never to a bare address like 127.0.0.1 (the browser refuses those). Say
// so plainly, with a button that opens the same page at localhost.
export function passkeyHere() {
  const h = location.hostname;
  if (!/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i.test(h)) return true;
  const there = new URL(location.href);
  there.hostname = 'localhost';
  toast('info', 'Passkeys work at localhost', `Your browser won’t use a passkey at ${h}. Open Unit7 at localhost instead (you sign in there once).`,
    { action: { label: 'Open it there', onClick: () => location.assign(there.toString()) }, ms: 12000 });
  return false;
}
