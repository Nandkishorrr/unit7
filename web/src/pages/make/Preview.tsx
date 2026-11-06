// Dev-only harness for the test-copy and add-a-tool pieces: open /src/pages/make/preview.html on the Vite dev server while
// signed in. ?theme=dark, ?show=plan|done|installed|cards. The plan runs for real against this Unit7 (the first project
// with something in Production); the success moments and chat cards are shaped exactly like their tools' output.
import '../../styles.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, runTool, startLive } from '../../lib/api';
import { Modal, Toaster } from '../../ui';
import { StagingButton, StagingPlanModal, type StagingTarget } from './Staging';
import { InstalledView } from './AddPage';
import { AddonChatCard, StagingChatCard } from './chat';
import { LiveMoment, Note } from './parts';

const q = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', q.get('theme') === 'dark');
const show = q.get('show') ?? 'plan';

const installed = {
  name: 'Uptime Kuma', url: 'https://uptime.example.com', healthy: true, via: 'coolify', dns: { written: true, at: 'cloudflare' }, credentials: [{ label: 'Extra password (user unit7), until you’ve set it up', saved: true }], gated: true,
  firstVisit: 'It stays behind an extra password until you’ve set it up: open it, sign in with the extra password (Show), and create the admin account. Then click “I’ve finished setup” and Unit7 takes the extra password away.',
  wire: { note: 'Add a monitor for each of your sites (Add New Monitor → HTTP(s)).' },
  monitors: { sites: ['https://shipman.example.com', 'https://api.example.com', 'https://status.example.com'], note: 'Add each as an HTTP(s) monitor in Uptime Kuma.' },
};
// the usual install now: Unit7 made its admin behind the extra password, then added a monitor per site (?which=watching)
const watching = {
  name: 'Uptime Kuma', url: 'https://uptime.example.com', healthy: true, via: 'coolify', dns: { written: true, at: 'cloudflare' }, credentials: [{ label: 'Admin password (user admin)', saved: true }],
  firstVisit: 'Unit7 set its admin login before it went live: sign in with the keys here (Show).',
  monitors: { synced: true, watching: 6, note: 'Uptime Kuma now watches 6 sites (5 new).', added: ['https://shipman.example.com', 'https://api.example.com', 'https://status.example.com', 'https://blog.example.com', 'https://shop.example.com'],
    sites: ['https://shipman.example.com', 'https://api.example.com', 'https://status.example.com', 'https://blog.example.com', 'https://shop.example.com', 'https://docs.example.com'] },
};
const umami = {
  name: 'Umami', url: 'https://analytics.example.com', healthy: true, via: 'coolify', credentials: [{ label: 'Admin password (admin)', saved: true }], firstVisit: 'Unit7 set its admin login before it went live: sign in with the keys here (Show).',
  wire: { note: 'Add your site in Umami (Settings → Websites) for its website id, then put the script in your app’s page head.', snippet: '<script defer src="https://analytics.example.com/script.js" data-website-id="your-website-id"></script>', env: [{ key: 'NEXT_PUBLIC_UMAMI_SRC', value: 'https://analytics.example.com/script.js' }] },
};

function App() {
  const [target, setTarget] = useState<StagingTarget>();
  const [srv, setSrv] = useState<string>();
  const [cards, setCards] = useState<any[]>([]);
  useEffect(() => {
    startLive();
    void api<any>('/api/graph').then((g) => {
      const p = g.projects.find((x: any) => x.environments.some((e: any) => e.kind === 'production' && e.services.length));
      if (p) setTarget({ projectId: p.id, name: p.name });
      setSrv(g.servers[0]?.id);
    });
  }, []);
  useEffect(() => {
    if (show !== 'cards' || !target) return;
    void Promise.all([runTool('staging.plan', { projectId: target.projectId }), runTool('addon.catalog', {})]).then(([a, b]) => setCards([
      <StagingChatCard key="p" tool="staging.plan" input={{ projectId: target.projectId }} output={(a as any).output} />,
      <StagingChatCard key="c" tool="staging.create" input={{ projectId: target.projectId }} output={{ created: true, name: target.name, url: 'https://web-x1y2z3.203-0-113-9.sslip.io', leftOut: ['PUBLIC_URL', 'STRIPE_SECRET_KEY'], done: ['Make the Staging environment', 'Add web to Staging', 'Add a fresh Postgres database shipman-db', 'Copy 3 settings from web', 'Take a fresh backup of shipman-db', 'Copy shipman-db’s data into Staging with names, emails and phones replaced', 'Deploy web in Staging'].map((step) => ({ step })) }} />,
      <AddonChatCard key="a" tool="addon.catalog" input={{}} output={(b as any).output} />,
      <AddonChatCard key="i" tool="addon.install" input={{ serverId: srv }} output={{ ...umami, addon: 'umami', server: 'box' }} />,
    ]));
  }, [target]);
  return (
    <main className="min-h-dvh bg-canvas p-6 text-ink">
      <Toaster />
      {show === 'plan' && target && <><StagingButton target={target} /><StagingPlanModal target={target} open onClose={() => {}} /></>}
      {show === 'done' && <Modal open onClose={() => {}} title={`A test copy of ${target?.name ?? 'shipman'}`}><LiveMoment title={`${target?.name ?? 'shipman'}’s test copy is live`} url="https://web-x1y2z3.203-0-113-9.sslip.io"><Note tone="warn">Left out, because they look live: PUBLIC_URL, STRIPE_SECRET_KEY. Give the copy test keys for them any time.</Note></LiveMoment></Modal>}
      {show === 'installed' && srv && <Modal open onClose={() => {}} title={q.get('which') === 'umami' ? 'Umami on box' : 'Uptime Kuma on box'}><InstalledView a={q.get('which') === 'umami' ? { id: 'umami', name: 'Umami' } : { id: 'uptime-kuma', name: 'Uptime Kuma' }} out={(q.get('which') === 'umami' ? umami : q.get('which') === 'watching' ? watching : installed) as any} serverId={srv} onClose={() => {}} /></Modal>}
      {show === 'cards' && <div className="mx-auto grid max-w-[720px] gap-4">{cards}</div>}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
