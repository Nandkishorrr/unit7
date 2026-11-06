// Dev-only harness: the care pieces as their pages will mount them (project cards with the readiness badge, the
// project page's checklist, Home's cost panel). Not in the app's routes or build; open /src/pages/care/preview.html on
// the Vite dev server while signed in. ?theme=dark, ?w=375.
import '../../styles.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, startLive } from '../../lib/api';
import { Card, Prompts, Toaster } from '../../ui';
import { CostRadar, ReadinessBadge, ReadinessCard } from '.';

const q = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', q.get('theme') === 'dark');
const width = Number(q.get('w') ?? 1180);

function App() {
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => { startLive(); void api<any>('/api/graph').then((g) => setProjects(g.projects)); }, []);
  if (!projects) return <p className="p-6">Loading…</p>;
  const first = projects.find((p) => p.id === q.get('project') || p.name === q.get('project')) ?? projects[0];
  return (
    <div className="mx-auto space-y-4 bg-bg p-4" style={{ maxWidth: width }}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {projects.map((p) => (
          <Card key={p.id} className="flex items-center gap-3 p-5"><span className="min-w-0 flex-1 truncate text-[16px] font-medium">{p.name}</span><ReadinessBadge projectId={p.id} /></Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        {first && <ReadinessCard projectId={first.id} />}
        <CostRadar compact />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /><Toaster /><Prompts /></StrictMode>);
