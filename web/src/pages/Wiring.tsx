// What's wired to what, across providers: a database on Supabase to a site on Vercel, your CRM here to
// that site. Unit7 lists what it set up, what looks missing (one click, or it does it by itself every
// few hours), and lets you connect any two things.
import { useEffect, useState } from 'react';
import { ArrowRight, Check, CircleAlert, Link2, RefreshCw, Sparkles } from 'lucide-react';
import { onLive, runTool } from '../lib/api';
import { act, Button, Section, Skeleton, cx } from '../ui';

type End = { kind: string; [k: string]: string };
interface LinkRow { id: string; from: End & { name: string }; to: End & { name: string }; settings: string[]; status: string; detail: string | null; checkedAt: string | null }
interface Thing { end: End; name: string; provider: string; role: 'app' | 'database' }
interface Suggestion { from: End; to: End; fromName: string; toName: string; why: string; sure: boolean }
interface Options { things: Thing[]; suggestions: Suggestion[]; problems: string[] }

const WHERE: Record<string, string> = { unit7: 'here', vercel: 'Vercel', supabase: 'Supabase', neon: 'Neon', planetscale: 'PlanetScale', turso: 'Turso', upstash: 'Upstash', netlify: 'Netlify', render: 'Render', railway: 'Railway', heroku: 'Heroku', fly: 'Fly.io' };
const key = (e: End) => JSON.stringify(e);

export function Wiring({ human }: { human: boolean }) {
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const loadLinks = async () => { const r = await runTool('link.list'); if (r.status === 'ok') setLinks(r.output); };
  const loadOpts = async () => { const r = await runTool('link.options'); setOpts(r.status === 'ok' ? r.output : { things: [], suggestions: [], problems: [r.status === 'error' ? r.error.message : r.status] }); };
  useEffect(() => { void loadLinks(); void loadOpts(); }, []);
  useEffect(() => onLive((e) => { if (e.type.startsWith('link.') || e.type.startsWith('account.')) { void loadLinks(); void loadOpts(); } }), []);

  const connect = async (f: End, t: End, label: string) => {
    await act('link.create', { from: f, to: t }, { success: `${label} connected` });
    await loadLinks(); await loadOpts(); // a connection that can't finish yet is still listed, with why
  };
  const sure = opts?.suggestions.filter((s) => s.sure) ?? [];
  const named = (k: string) => opts?.things.find((t) => key(t.end) === k);

  return (
    <Section title="Wired together" actions={human && sure.length > 1 && (
      <Button size="sm" variant="primary" onClick={async () => { if (await act('link.autoconnect', {}, { success: 'Connected what belongs together' })) { await loadLinks(); await loadOpts(); } }}>
        <Sparkles size={13} /> Connect all {sure.length}
      </Button>
    )}>
      <p className="-mt-1 text-[13px] text-muted">Apps, sites and databases on any provider, connected to each other. Unit7 sets the URLs and keys on both sides, rebuilds, and keeps them in sync.</p>

      {!links ? <Skeleton className="h-16" /> : links.length > 0 && (
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          {links.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
              <span className={cx('grid size-6 place-items-center rounded-full', l.status === 'ok' ? 'bg-ok/12 text-ok' : 'bg-bad/12 text-bad')}>{l.status === 'ok' ? <Check size={13} strokeWidth={3} /> : <CircleAlert size={13} />}</span>
              <span className="text-[13.5px] font-medium">{l.from.name} <span className="text-faint">({WHERE[l.from.kind]})</span></span>
              <ArrowRight size={14} className="text-faint" />
              <span className="text-[13.5px] font-medium">{l.to.name} <span className="text-faint">({WHERE[l.to.kind]})</span></span>
              <span className="flex flex-wrap gap-1">{l.settings.map((s) => <code key={s} className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-muted">{s}</code>)}</span>
              {human && (
                <span className="ml-auto flex items-center gap-3 text-[12px]">
                  <button className="inline-flex items-center gap-1 text-muted hover:text-ink" onClick={async () => { if (await act('link.sync', { linkId: l.id }, { success: 'In sync' })) await loadLinks(); }}><RefreshCw size={12} />Sync</button>
                  <button className="text-faint hover:text-bad" onClick={async () => { if (confirm('Forget this connection? The settings it made stay in place.') && await act('link.remove', { linkId: l.id })) await loadLinks(); }}>Forget</button>
                </span>
              )}
              {l.detail && <p className="w-full pl-9 text-[12px] text-bad">{l.detail}</p>}
            </div>
          ))}
        </div>
      )}

      {!opts ? <Skeleton className="h-12" /> : (
        <>
          {opts.suggestions.map((s) => (
            <div key={key(s.from) + key(s.to)} className="flex flex-wrap items-center gap-3 rounded-xl border border-ember/30 bg-ember-soft/30 px-4 py-3">
              <Link2 size={15} className="text-ember" />
              <span className="min-w-0 flex-1 text-[13.5px]"><b>{s.fromName}</b> → <b>{s.toName}</b><span className="block text-[12px] text-muted">{s.why}{s.sure ? '. Unit7 connects this by itself within a few hours.' : '.'}</span></span>
              {human && <Button size="sm" variant="primary" onClick={() => connect(s.from, s.to, `${s.fromName} → ${s.toName}`)}>Connect</Button>}
            </div>
          ))}
          {human && opts.things.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-muted">Connect</span>
              <select value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-[13px]">
                <option value="">a database or API…</option>
                {opts.things.map((t) => <option key={key(t.end)} value={key(t.end)}>{t.name} ({WHERE[t.provider]})</option>)}
              </select>
              <span className="text-muted">to</span>
              <select value={to} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-[13px]">
                <option value="">an app or site…</option>
                {opts.things.filter((t) => t.role === 'app' && key(t.end) !== from).map((t) => <option key={key(t.end)} value={key(t.end)}>{t.name} ({WHERE[t.provider]})</option>)}
              </select>
              <Button size="sm" disabled={!from || !to} onClick={() => connect(JSON.parse(from), JSON.parse(to), `${named(from)?.name} → ${named(to)?.name}`)}>Connect</Button>
            </div>
          )}
          {opts.things.length <= 1 && !links?.length && <p className="text-[12.5px] text-faint">Connect Vercel, Supabase or Neon below, or deploy two apps here, and they show up to wire together.</p>}
          {opts.problems.map((p) => <p key={p} className="flex items-center gap-1.5 text-[12px] text-warn"><CircleAlert size={12} />{p}</p>)}
        </>
      )}
    </Section>
  );
}
