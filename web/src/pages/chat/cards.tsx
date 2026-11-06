// Live cards for tool results in the Home chat. toolCard returns a card for a step, or null to let the
// thread show its plain one-line step. Finished steps get a card per tool; a running deploy or sync gets
// its live card too (so the thread can render toolCard for every step, whatever its status), and a
// failed deploy gets one with "Ask Unit7 to fix". The cards live in ./cards/.
import { Component, type ReactNode } from 'react';
import type { ToolStep } from './types';
import { DomainCheckCard, DomainPointCard, DomainsCard } from './cards/domains';
import { AppCard, DeployCard, LogsCard, ProjectsCard, RollbackCard, ServiceCreatedCard } from './cards/apps';
import { DockerCard, FactsCard, MetricsCard, ServersCard, VpsCard } from './cards/servers';
import { AccountsCard, ApprovalsCard, BackupDoneCard, BackupsCard, BudgetCard, DatabaseCreatedCard, ErrorsCard, EventsCard, MapCard, SyncCard, TablesCard } from './cards/ops';
import { CoolifyBuildCard, CoolifyControlCard, CoolifyDeploysCard, CoolifyEnvsCard, CoolifyLogsCard, CoolifyMadeCard, CoolifyProjectsCard, UsageCard, XrayCard } from './cards/xray';
import { AnomaliesCard, FindingsCard, TrafficChatCard, TrendsCard } from '../watch/cards';
import { ChangesCard, PartDoneCard, PartImpactCard, PartSettingsCard, PartTextCard } from './cards/manage';
import { BriefChatCard, ReplayChatCard, TimelineChatCard } from '../story/cards';
import { ServerAppCard } from '../serverapps/Card';
import { CostRadar, ReadinessCard } from '../care';
import { AddonChatCard, StagingChatCard } from '../make/chat';
import { CloudChatCard } from '../clouds';
import { FreshChatCard } from '../fresh';

// question: the person's message that led to this step, when the thread knows it (picks the map's first tab)
export interface CardCtx { conversationId: string; question?: string }

const list = (o: unknown): o is any[] => Array.isArray(o);
const obj = (o: unknown): o is Record<string, any> => !!o && typeof o === 'object' && !Array.isArray(o);

function pick(step: ToolStep, ctx: CardCtx): ReactNode | null {
  const { tool, input, output: o } = step;
  if (step.status === 'running') {
    if (tool === 'deployment.create') return <DeployCard input={input} state="running" />;
    if (tool === 'sync.run') return <SyncCard state="running" />;
    if (tool === 'coolify.control') return <CoolifyControlCard input={input} state="running" />;
    return null;
  }
  if (step.status === 'error') return tool === 'deployment.create' ? <DeployCard input={input} state="failed" error={step.error} code={step.code} /> : tool === 'coolify.control' ? <CoolifyControlCard input={input} state="failed" error={step.error} /> : null;
  if (step.status !== 'ok') return null; // approvals and refusals: the thread's own step line handles them
  switch (tool) {
    case 'map.get': return obj(o) && list(o.assets) ? <MapCard input={input} question={ctx.question} /> : null;
    case 'domain.list': return list(o) ? <DomainsCard only={o.map((d) => d.hostname)} /> : null;
    case 'domain.check': return obj(o) && o.hostname ? <DomainCheckCard input={input} output={o} /> : null;
    case 'domain.point': return obj(o) && o.hostname ? <DomainPointCard input={input} output={o} /> : null;
    case 'server.list': return list(o) ? <ServersCard list={o} /> : null;
    case 'server.metrics': return obj(o) && obj(o.now) ? <MetricsCard input={input} output={o} /> : null;
    case 'server.inspect': return obj(o) ? <FactsCard input={input} output={o} /> : null;
    case 'docker.list': return list(o) && (!input?.what || input.what === 'containers') ? <DockerCard input={input} output={o} /> : null;
    case 'hostinger.vps_list': return obj(o) && list(o.vps) ? <VpsCard output={o} /> : null;
    case 'project.list': return list(o) ? <ProjectsCard projects={o} /> : null;
    case 'graph.get': return obj(o) && list(o.projects) ? <ProjectsCard /> : null;
    case 'service.get': return obj(o) && o.id ? <AppCard output={o} /> : null;
    case 'service.create': return obj(o) && o.serviceId ? <ServiceCreatedCard input={input} output={o} /> : null;
    case 'deployment.create': return obj(o) && o.deploymentId ? <DeployCard input={input} state="ok" output={o} /> : null;
    case 'deployment.logs': return obj(o) && list(o.lines) ? <LogsCard input={input} output={o} /> : null;
    case 'deployment.rollback': return obj(o) && o.number != null ? <RollbackCard input={input} output={o} /> : null;
    case 'database.create': return obj(o) && o.serviceId ? <DatabaseCreatedCard input={input} output={o} /> : null;
    case 'database.inspect': return obj(o) && 'result' in o ? <TablesCard input={input} output={o} /> : null;
    case 'backup.create': return obj(o) && o.backupId ? <BackupDoneCard input={input} output={o} /> : null;
    case 'backup.list': return list(o) ? <BackupsCard list={o} /> : null;
    case 'backup.restore': return obj(o) && o.restored ? <BackupDoneCard input={input} output={o} restored /> : null;
    case 'errors.list': return list(o) ? <ErrorsCard list={o} /> : null;
    case 'events.recent': return list(o) ? <EventsCard list={o} /> : null;
    case 'approval.list': return list(o) ? <ApprovalsCard list={o} /> : null;
    case 'account.list': return list(o) ? <AccountsCard list={o} /> : null;
    case 'budget.check': return obj(o) && 'soFar' in o ? <BudgetCard output={o} /> : null;
    case 'project.readiness': return obj(o) && typeof o.projectId === 'string' ? <ReadinessCard projectId={o.projectId} /> : null;
    case 'cost.radar': return obj(o) && 'total' in o ? <CostRadar compact /> : null;
    case 'sync.run': return obj(o) && o.counts ? <SyncCard state="ok" output={o} /> : null;
    case 'server.xray': return obj(o) && list(o.projects) ? <XrayCard output={o as never} /> : null;
    case 'server.usage': return obj(o) && obj(o.server) && list(o.projects) ? <UsageCard output={o as never} /> : null;
    case 'server.trends': return obj(o) && list(o.series) ? <TrendsCard output={o as never} /> : null;
    case 'server.findings': return obj(o) && list(o.risks) ? <FindingsCard output={o as never} /> : null;
    case 'server.traffic': return obj(o) && obj(o.summary) ? <TrafficChatCard output={o as never} /> : null;
    case 'watch.anomalies': return obj(o) && list(o.open) ? <AnomaliesCard output={o as never} /> : null;
    case 'coolify.projects': return obj(o) && list(o.projects) ? <CoolifyProjectsCard input={input} output={o as never} /> : null;
    case 'coolify.control': return obj(o) && o.status ? <CoolifyControlCard input={input} state="ok" output={o as never} /> : null;
    case 'coolify.deployments': return list(o) ? <CoolifyDeploysCard input={input} output={o} /> : null;
    case 'coolify.logs': return obj(o) && list(o.lines) ? <CoolifyLogsCard input={input} output={o as never} /> : null;
    case 'coolify.envs': return list(o) && (!input?.op || input.op === 'list') ? <CoolifyEnvsCard input={input} output={o} /> : null;
    case 'coolify.build': return obj(o) && 'built' in o ? <CoolifyBuildCard input={input} output={o as never} /> : null;
    case 'coolify.create_project': case 'coolify.create_app': case 'coolify.create_database': case 'coolify.create_service':
    case 'coolify.set_domain': case 'coolify.backup': case 'coolify.task': case 'coolify.remove':
      return obj(o) ? <CoolifyMadeCard tool={tool} input={input} output={o} /> : null;
    case 'part.logs': case 'part.run': return obj(o) && (list(o.lines) || 'exitCode' in o) ? <PartTextCard tool={tool} input={input} output={o} /> : null;
    case 'part.impact': return obj(o) && list(o.lines) ? <PartImpactCard input={input} output={o} /> : null;
    case 'part.env': return obj(o) && list(o.settings) ? <PartSettingsCard input={input} output={o} /> : obj(o) && list(o.result) ? <CoolifyEnvsCard input={input} output={o.result} /> : obj(o) && (o.changeId || o.approvalRequired || o.deploy) ? <PartDoneCard tool={tool} input={input} output={o} /> : null;
    case 'part.restart': case 'part.start': case 'part.stop': case 'part.update': case 'part.limits': case 'part.remove': case 'change.undo':
      return obj(o) && o.through === 'Coolify' && o.status ? <CoolifyControlCard input={{ ...input, action: tool === 'part.update' ? 'deploy' : tool.slice(5) }} state="ok" output={o as never} /> : obj(o) ? <PartDoneCard tool={tool} input={input} output={o} /> : null;
    case 'change.list': return list(o) ? <ChangesCard input={input} output={o} /> : null;
    case 'story.timeline': return obj(o) && list(o.items) ? <TimelineChatCard input={input} output={o as never} /> : null;
    case 'story.replay': return obj(o) && obj(o.cause) && list(o.buckets) ? <ReplayChatCard output={o as never} /> : null;
    case 'story.brief': return obj(o) && list(o.lines) ? <BriefChatCard output={o as never} /> : null;
    case 'serverapp.list': return obj(o) && list(o.apps) ? <ServerAppCard tool={tool} input={input} output={o} /> : null;
    case 'serverapp.connect': case 'serverapp.keys': case 'serverapp.wire': case 'serverapp.disconnect': case 'serverapp.action':
      return obj(o) && !o.approvalRequired ? <ServerAppCard tool={tool} input={input} output={o} /> : null;
    case 'staging.plan': case 'staging.create': case 'staging.remove': return obj(o) ? <StagingChatCard tool={tool} input={input} output={o} /> : null;
    case 'addon.catalog': return obj(o) && list(o.items) ? <AddonChatCard tool={tool} input={input} output={o} /> : null;
    case 'addon.install': case 'addon.remove': return obj(o) && o.name ? <AddonChatCard tool={tool} input={input} output={o} /> : null;
    // the big clouds: a DNS record removed, a redeploy, a spending alert, spending by day, the stops carried out
    case 'domain.remove_record': return obj(o) && Array.isArray(o.removed) ? <CloudChatCard tool={tool} input={input} output={o} /> : null;
    case 'cloud.redeploy': return obj(o) && o.said ? <CloudChatCard tool={tool} input={input} output={o} /> : null;
    case 'cloud.budget_set': return obj(o) && obj(o.budget) ? <CloudChatCard tool={tool} input={input} output={o} /> : null;
    case 'cloud.spend': return obj(o) && list(o.days) ? <CloudChatCard tool={tool} input={input} output={o} /> : null;
    case 'cloud.stop_runaway': return obj(o) && list(o.stopped) ? <CloudChatCard tool={tool} input={input} output={o} /> : null;
    // keep it fresh: what's outdated (every app, or one with its batches), a batch's steps, the week
    case 'fresh.plan': case 'fresh.status': case 'fresh.run': case 'fresh.release': case 'fresh.batch': case 'fresh.report': return obj(o) ? <FreshChatCard tool={tool} input={input} output={o} /> : null;
  }
  return null;
}

// a card that can't draw itself becomes one quiet line, never a broken thread
class Safe extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="text-[12.5px] text-muted">Couldn’t show this result as a card.</p> : this.props.children; }
}

export function toolCard(step: ToolStep, ctx: CardCtx): ReactNode | null {
  const card = pick(step, ctx);
  return card && <Safe>{card}</Safe>;
}
