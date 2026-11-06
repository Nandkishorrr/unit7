// /servers/:id/apps: every self-hosted app Unit7 can connect on one server, in one calm list (the same rows the
// server's project pop-up shows for its own apps).
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { useApi } from '../../lib/api';
import { A, PageHeader } from '../../ui';
import { AppAccess } from './AppAccess';

export function ServerAppsPage({ id, human = true }: { id: string; human?: boolean }) {
  const g = useApi<{ servers: { id: string; name: string }[] }>('/api/graph', { live: false });
  const name = g.data?.servers.find((s) => s.id === id)?.name ?? 'this server';
  return (
    <div className="w-full max-w-[880px] space-y-6 pb-16">
      <A href={`/servers/${id}`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition hover:text-ink"><ArrowLeft size={14} />Back to {name}</A>
      <PageHeader title={`Apps on ${name}`} subtitle="Connect one and Unit7 makes its own scoped key there over the server connection, keeps it in the vault, and puts it into your apps for you." />
      <div className="rounded-[24px] border border-line bg-surface p-4 shadow-soft md:p-5"><AppAccess serverId={id} human={human}
        empty={<p className="px-1 py-6 text-center text-[13.5px] text-muted">No apps here that Unit7 can connect yet. Supabase, n8n, PostgreSQL and others show up here once Unit7 looks inside the server and finds them.</p>} /></div>
      <p className="flex items-start gap-2 px-1 text-[12.5px] text-muted"><ShieldCheck size={14} className="mt-0.5 shrink-0" />Keys never pass through a chat or a log. An AI asks you first before connecting anything in production, and only you can see a key.</p>
    </div>
  );
}
