// Alerts on your phone (ntfy, no account needed) or in a Slack/Discord channel (incoming webhook), for
// the things that need you: something down, a failed deploy, an approval waiting, a backup that won't
// restore. Every message passes the secret scrubber first, and one kind of alert about one thing is
// sent at most once per 10 minutes.
import type { App } from '../app.ts';
import type { Unit7Event } from '../events.ts';
import { all, json } from '../db.ts';
import { Redactor } from '../redact.ts';
import { approvalButtons, missed, missReason, phoneButtons } from './phone.ts';
import { fixAction } from '../care/phonefix.ts';
import { verdictFor } from '../care/verdict.ts';
import { sendTelegram } from './telegram.ts';
import { whyAction } from './phone.ts';
import { quietNow } from './schedule.ts';
import { causeLine } from '../story/replay.ts';
import { phoneText } from '../explain.ts';
import { eventKey, snoozeState, stillHidden } from '../snooze.ts';

// fetch throws on anything past Latin-1 in a header, so one curly apostrophe in a title would lose the whole alert
export const headerSafe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e]/g, '');

// what's worth a buzz in your pocket, and how loudly (ntfy priority 1–5)
const ALERTS: Record<string, { title: string; priority: number; tag: string }> = {
  'incident.opened': { title: 'Incident', priority: 5, tag: 'rotating_light' },
  'service.down': { title: 'App down', priority: 5, tag: 'red_circle' },
  'server.unreachable': { title: 'Server not answering', priority: 5, tag: 'red_circle' },
  'server.recovered': { title: 'Server back', priority: 3, tag: 'white_check_mark' },
  'server.host_key_changed': { title: 'Server identity changed', priority: 5, tag: 'warning' },
  'deployment.failed': { title: 'Deploy failed', priority: 4, tag: 'x' },
  'backup.failed': { title: 'Scheduled backup failed', priority: 4, tag: 'floppy_disk' },
  'backup.offsite_failed': { title: 'Backup not copied off the server', priority: 4, tag: 'floppy_disk' },
  'backup.verify_failed': { title: 'Backup won’t restore', priority: 4, tag: 'floppy_disk' },
  'approval.requested': { title: 'Waiting for your OK', priority: 4, tag: 'hand' },
  'account.refused': { title: 'An account refused Unit7', priority: 3, tag: 'key' },
  'security.vulnerable': { title: 'Vulnerabilities to fix', priority: 3, tag: 'shield' },
  'security.found': { title: 'Security check found something', priority: 4, tag: 'shield' },
  'server.disk_high': { title: 'Disk filling up', priority: 3, tag: 'warning' },
  'job.failed': { title: 'Scheduled job failed', priority: 3, tag: 'alarm_clock' },
  'link.broken': { title: 'Connection broken', priority: 4, tag: 'link' },
  'domain.takeover_risk': { title: 'Domain could be taken over', priority: 5, tag: 'rotating_light' },
  'secret.leaked': { title: 'Secret found in code', priority: 5, tag: 'rotating_light' },
  'secret.manual': { title: 'Revoke a secret', priority: 5, tag: 'key' },
  'secret.rotation_failed': { title: 'Secret change undone', priority: 4, tag: 'key' },
  'budget.over': { title: 'Budget spent', priority: 5, tag: 'money_with_wings' },
  'budget.warning': { title: 'Budget forecast', priority: 3, tag: 'chart_with_upwards_trend' },
  'app.errors': { title: 'Errors in an app', priority: 4, tag: 'bug' },
  'site.down': { title: 'Site down', priority: 5, tag: 'red_circle' },
  'site.recovered': { title: 'Site back up', priority: 3, tag: 'white_check_mark' },
  'site.slow': { title: 'Site slow', priority: 3, tag: 'turtle' },
  'tls.expiring': { title: 'Certificate expiring', priority: 4, tag: 'lock' },
  'domain.expiring': { title: 'Domain expiring', priority: 4, tag: 'hourglass' },
  'domain.broken': { title: 'Domain stopped working', priority: 5, tag: 'globe_with_meridians' },
  'autonomy.lowered': { title: 'Autonomy lowered', priority: 3, tag: 'arrow_down' },
  'autopilot.paused': { title: 'Autopilot paused', priority: 2, tag: 'pause_button' },
  'safety.weekly': { title: 'What Unit7 blocked this week', priority: 2, tag: 'shield' },
  'watch.anomaly': { title: 'Unusual on a server', priority: 4, tag: 'chart_with_upwards_trend' },
  'watch.traffic': { title: 'Unusual traffic', priority: 4, tag: 'globe_with_meridians' },
  'watch.finding': { title: 'New risk on a server', priority: 3, tag: 'shield' },
  'watch.digest': { title: 'Your week', priority: 2, tag: 'calendar' },
  'story.brief': { title: 'Morning brief', priority: 2, tag: 'sunrise' },
  // saved routines: a report when the routine says "tell me", and always when one fails or pauses
  'routine.report': { title: 'Routine done', priority: 3, tag: 'repeat' },
  'routine.failed': { title: 'Routine didn’t work', priority: 4, tag: 'repeat' },
  'routine.paused': { title: 'Routine paused', priority: 4, tag: 'pause_button' },
  'domain.bought': { title: 'Domain bought', priority: 3, tag: 'globe_with_meridians' },
  // an AI archived something: Unit7 stopped watching it, so the person hears about it (with Undo in Activity)
  'asset.ai_archived': { title: 'Your AI archived something', priority: 4, tag: 'file_cabinet' },
};

// what Warden did by itself, calmly (Undo is in Activity); a restart 10 minutes ahead, and how it went
Object.assign(ALERTS, {
  'autofix.applied': { title: 'Fixed by itself', priority: 2, tag: 'white_check_mark' },
  'reboot.soon': { title: 'Restart in 10 minutes', priority: 3, tag: 'arrows_counterclockwise' },
  'reboot.done': { title: 'Server restarted', priority: 2, tag: 'white_check_mark' },
});
// the big clouds: spending jumped (or a budget passed 100%); the plan to stop it waits for the person
Object.assign(ALERTS, { 'cost.spike': { title: 'Cloud spending jumped', priority: 5, tag: 'money_with_wings' } });
Object.assign(ALERTS, {
  'seven.did': { title: 'Seven did this', priority: 2, tag: 'seven' },
  'seven.note': { title: 'Seven found something', priority: 4, tag: 'seven' },
  'safety.started': { title: 'Safety Net is on', priority: 2, tag: 'shield' },
  'safety.protected': { title: 'Protected by itself', priority: 2, tag: 'shield' },
  'safety.failed': { title: 'Safety Net needs you', priority: 4, tag: 'shield' },
  'safety.lifeboat': { title: 'Lifeboat launched', priority: 4, tag: 'ship' },
  'delete.held': { title: 'A delete is waiting', priority: 3, tag: 'hourglass' },
  'coolify.changed': { title: 'Coolify changed', priority: 3, tag: 'warning' },
  'breakin.found': { title: 'Signs of a break-in', priority: 5, tag: 'rotating_light' },
  'catchup.done': { title: 'While I was away', priority: 2, tag: 'zzz' },
  'checkup.found': { title: 'Check-up found something new', priority: 3, tag: 'mag' },
  'finding.fixed': { title: 'Fixed, and proven', priority: 3, tag: 'white_check_mark' },
  'finding.still': { title: 'Still happening', priority: 3, tag: 'warning' },
  'finding.back': { title: 'It came back', priority: 4, tag: 'warning' },
  'watch.route': { title: 'Can’t reach your sites from here', priority: 3, tag: 'satellite' },
  'watch.blocked': { title: 'Your server banned this computer', priority: 4, tag: 'no_entry' },
});
// the watch after a deploy (src/deploy/release.ts): it rolled back by itself, or it got worse and couldn't
Object.assign(ALERTS, {
  'deployment.rolled_back': { title: 'Rolled back by itself', priority: 4, tag: 'rewind' },
  'deployment.watch_bad': { title: 'Worse after a deploy', priority: 4, tag: 'warning' },
});

// keep it fresh (src/fresh): a release that went out ("Security fix for shop is live · 0 s down"), one held back with its
// reason ("Held back: 2 tests failed · Show me"), updates waiting for a person, and the weekly report
Object.assign(ALERTS, {
  'fresh.released': { title: 'Updated', priority: 2, tag: 'sparkles' },
  'fresh.held': { title: 'Update held back', priority: 3, tag: 'pause_button' },
  'fresh.ready': { title: 'Updates ready', priority: 3, tag: 'package' },
  'fresh.weekly': { title: 'Your updates this week', priority: 2, tag: 'calendar' },
});

// many servers (src/fleet): a canary's step with Promote / Roll back, its roll back by itself; a warm standby taking over,
// one that can't, its data copy failing, and the monthly drill
Object.assign(ALERTS, {
  'fleet.canary': { title: 'Trying a new version', priority: 3, tag: 'hatching_chick' },
  'fleet.canary_rolled_back': { title: 'Rolled back by itself', priority: 4, tag: 'rewind' },
  'dr.failover': { title: 'Switched to the standby', priority: 5, tag: 'rotating_light' },
  'dr.cant_switch': { title: 'Server down, standby too', priority: 5, tag: 'rotating_light' },
  'dr.refresh_failed': { title: 'Standby data not copied', priority: 4, tag: 'floppy_disk' },
  'dr.drill': { title: 'Standby drill', priority: 2, tag: 'white_check_mark' },
});

const recent = new Map<string, number>(); // `${org}:${type}:${resource}` -> last sent


type Send = (url: string, init: RequestInit) => Promise<unknown>;

export async function deliver(app: App, e: Unit7Event, send: Send = (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(10_000) }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; })) {
  const kind = ALERTS[e.type];
  if (!kind || e.live) return 0;
  // quiet hours (the server watch's setting): its non-critical alerts stay in Activity, off the phone
  if (e.type.startsWith('watch.') && e.severity !== 'critical' && quietNow(app.db, e.org_id)) return 0;
  // a person said this one is fine (or hid it for now): it stays in Activity, off the phone
  if (stillHidden(snoozeState(app.db, e.org_id).hidden.get(eventKey(e)), e.severity)) return 0; // unless it got worse
  const key = `${e.org_id}:${e.type}:${e.resource ?? ''}`;
  if (Date.now() - (recent.get(key) ?? 0) < 10 * 60_000) return 0;
  const channels = all<{ id: string; provider: string; slug: string; meta: string }>(app.db, `SELECT id, provider, slug, meta FROM accounts WHERE org_id = ? AND provider IN ('ntfy', 'webhook', 'telegram')`, e.org_id);
  if (!channels.length) return 0;
  const before = recent.get(key);
  recent.set(key, Date.now()); // held while sending, so the same alert raised twice at once goes out once
  const text = new Redactor().redact(e.message + causeLine(app.db, e)).slice(0, 500); // the replay's likely cause, when a rule found one
  // what the phone shows: the message, then in plain words why it matters and what Unit7 does (src/explain.ts)
  // looked at first: is it real? From this server's own record, and a soft buzz when it's probably nothing
  const judged = verdictFor(app.db, e), quietly = judged.verdict === 'Probably noise' && e.severity !== 'critical';
  // a question from Seven is already plain, so it goes as it is
  const shown = new Redactor().redact(e.data?.question ? e.message : `${judged.verdict === 'Not sure' ? '' : `${judged.verdict}. `}${phoneText(e.type, e.message + causeLine(app.db, e))}${judged.line ? ` ${judged.line}` : ''}`).slice(0, 500);
  const click = process.env.UNIT7_URL;
  let sent = 0;
  for (const c of channels) {
    const ref = json<{ ref?: string }>(c.meta, {}).ref ?? `credential://${c.provider}/${c.slug}/token`;
    let url: string;
    try { url = app.vault.resolve(e.org_id, ref); } catch { continue; }
    try {
      if (c.provider === 'ntfy') {
        // an approval: Approve / Reject buttons right on the alert (answered through the reply channel)
        // (only on a phone that showed it gets alerts: phone.ts)
        const replies = phoneButtons(app, e.org_id, c.meta);
        // a fix asked for from the phone says "Not now" rather than "Reject"; a problem alert offers "Let Unit7 fix it"
        const buttons = e.type === 'approval.requested' && e.resource && replies ? approvalButtons(app, e.org_id, e.resource, replies.replies, e.data?.question ? 'No' : e.data?.phoneFix ? 'Not now' : undefined, e.data?.question ? 'Yes, do it' : undefined)
          // rolled back by itself: nothing left to fix, "Show me" opens the app's release
          : e.type === 'deployment.rolled_back' ? (click && e.project_id && e.resource ? `view, Show me, ${click.replace(/\/$/, '')}/projects/${e.project_id}/services/${e.resource}, clear=true` : undefined)
          // a canary's step: Promote / Roll back right on the alert (src/fleet/canary.ts handles the tap)
          : e.type === 'fleet.canary' && replies && typeof e.data?.canaryId === 'string' ? await (await import('../fleet/canary.ts')).canaryButtons(app, e.org_id, e.data.canaryId, replies.replies)
          // held back: "Show me" opens the app, where the batch says why
          : e.type === 'fresh.held' || e.type === 'fresh.ready' ? (click && e.project_id && e.resource?.startsWith('svc_') ? `view, Show me, ${click.replace(/\/$/, '')}/projects/${e.project_id}/services/${e.resource}, clear=true` : undefined)
          : replies ? fixAction(app, e, { title: kind.title, text, replies: replies.replies, accountId: c.id, approver: replies.approver }) : undefined;
        // "Why?" sits beside the other buttons, on any problem a person might wonder about
        const why = e.severity === 'critical' || e.severity === 'warning' ? (replies ? whyAction(app, e, replies.replies) : undefined) : undefined;
        await send(url, { method: 'POST', body: shown, headers: { Title: headerSafe(e.data?.question ? 'Seven asks' : `Unit7: ${kind.title}`), Priority: String(quietly ? Math.min(2, kind.priority) : kind.priority), Tags: kind.tag, ...(click && { Click: click }), ...((buttons || why) && { Actions: headerSafe([buttons, why].filter(Boolean).join('; ')) }) } });
      } else if (c.provider === 'telegram') {
        await sendTelegram(url, json<{ chatId: number }>(c.meta, { chatId: 0 }).chatId, `${kind.title}\n${shown}`);
      } else if (/discord(?:app)?\.com\/api\/webhooks/.test(url)) {
        await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `**Unit7: ${kind.title}**\n${shown}` }) });
      } else {
        await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `*Unit7: ${kind.title}*\n${shown}` }) });
      }
      sent++;
      missed(app, e.org_id, c.id, null);
    } catch (err) { missed(app, e.org_id, c.id, missReason(err, c.provider === 'ntfy' ? 'ntfy' : 'the team chat')); /* a dead channel never breaks Unit7: it shows as not reaching you */ }
  }
  // only a delivered alert holds back repeats; one no channel took is tried again next time
  if (!sent) { if (before === undefined) recent.delete(key); else recent.set(key, before); }
  return sent;
}

// "Send a test": prove each channel works, right now (its unique key skips the repeat limit).
export async function testAlerts(app: App, orgId: string, send?: Send) {
  return deliver(app, { id: 'test', org_id: orgId, type: 'autopilot.paused', severity: 'info', message: 'Test from Unit7: alerts reach you here.', project_id: null, environment_id: null, resource: `test-${Date.now()}`, data: {}, created_at: new Date().toISOString() }, send);
}

export function startNotifier(app: App) {
  return app.events.on((e) => { void deliver(app, e).catch(() => undefined); });
}
