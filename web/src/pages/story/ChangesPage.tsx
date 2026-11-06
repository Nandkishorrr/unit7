// /changes: the whole timeline, for everything or one server, app or project (?server=, ?service=, ?project=), and
// "since it last worked" straight away with ?since=healthy. Where the chat's cards and the brief link to.
import { useApi } from '../../lib/api';
import { useQuery } from '../../lib/router';
import { PageHeader } from '../../ui';
import { Timeline } from './Timeline';

const ok = (v: string | null, prefix: string) => (v && new RegExp(`^${prefix}_[A-Za-z0-9_-]{12}$`).test(v) ? v : undefined);

export function ChangesPage() {
  const q = useQuery();
  const serverId = ok(q.get('server'), 'srv'), serviceId = ok(q.get('service'), 'svc'), projectId = ok(q.get('project'), 'prj');
  const graph = useApi<any>('/api/graph', { live: false });
  const svc = serviceId && graph.data?.projects?.flatMap((p: any) => p.environments.flatMap((e: any) => e.services)).find((s: any) => s.id === serviceId);
  const name = (serverId && graph.data?.servers?.find((s: any) => s.id === serverId)?.name) || svc?.name || (projectId && graph.data?.projects?.find((p: any) => p.id === projectId)?.name);
  return (
    <>
      <PageHeader title="What changed" subtitle={name ? `On ${name}, newest first. Undo what Unit7 can take back.` : 'Everything Unit7 looks after, newest first. Undo what it can take back.'} />
      <Timeline key={`${serverId}${serviceId}${projectId}`} serverId={serverId} serviceId={serviceId} projectId={projectId} startHealthy={q.get('since') === 'healthy'} title={name ? `What changed on ${name}` : 'What changed'} />
    </>
  );
}
