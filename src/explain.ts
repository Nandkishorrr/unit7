// Plain words for everything that needs a person: what happened, what it can cause, what Unit7 will do (or suggests),
// in sentences a non-coder gets, and the technical detail kept for "Advanced". One model for findings, security items,
// server watch alerts, Activity and phone alerts. Pure (no imports at runtime), so tests and the web can share it.
// The first three lines never use tool words (no ports, containers, volumes, OOM…): those go in `advanced` only.

export interface Explain { what: string; why: string; next: string; advanced?: string }
interface FindingLike { id: string; title: string; detail?: string; evidence?: string; severity?: string; fix?: { tool?: string; ask?: string; manual?: string[]; label?: string } | null; about?: { name: string } }
type Words = (n: string, f: FindingLike) => [what: string, why: string, next: string];

// what a finding is about, from its title ("shop-db has no backups…" → shop-db)
export const subjectOf = (f: Pick<FindingLike, 'title' | 'about'>) =>
  (/^Anyone\b/.test(f.title) ? f.about?.name : undefined) ?? /^(.+?)(?: \([^)]*\))? (?:has|have|keeps|is|isn’t|answers|can|prints|uses|wrote|shows|accepts|allows|needs|refused|runs|’s)\b/.exec(f.title)?.[1]?.replace(/’s$/, '') ?? f.about?.name ?? 'This';
const portOf = (id: string) => Number(/:(\d+)$/.exec(id)?.[1] ?? 0);
const DB_PORTS = new Set([5432, 3306, 6379, 27017, 9200, 5984, 11211]);

// the Unit7 line, by what the fix is: one click, an AI look, or steps a person takes
const nextBy = (f: FindingLike, click: string, ask = 'Unit7’s AI can look into it and tell you the fix, without changing anything first.', steps = 'Unit7 shows you the few steps to do it yourself.') =>
  f.fix?.tool ? click : f.fix?.ask ? ask : f.fix?.manual?.length ? steps : 'Nothing to do now; Unit7 keeps an eye on it.';

// every kind of finding, by its id up to the second colon (server:port, xray:no-backup, traffic:surge…)
export const FINDING_WORDS: Record<string, Words> = {
  // --- open to the internet ---
  'server:port': (n, f) => {
    const p = portOf(f.id);
    // Unit7 closed it at the server, and the outside check still got in
    if (/still reachable from outside/i.test(f.title)) return ['Unit7 closed this door on the server, but it still opens from the internet.', 'The traffic gets in another way, so the block on the server isn’t enough on its own.', nextBy(f, 'Unit7 can close it again.', 'Unit7’s AI can find out how it still gets in, without changing anything first.')];
    if (p === 2375 || p === 2376) return ['The control switch for all your apps can be reached from the whole internet.', 'Anyone who finds it can take over the whole server.', nextBy(f, 'Unit7 can shut it off from the internet in one click; your apps keep working.')];
    if (DB_PORTS.has(p) || /database|PostgreSQL|MySQL|Redis|MongoDB/i.test(f.title)) return ['A database can be reached from the whole internet, not just from your apps.', 'Bots try passwords on it all day; one good guess and your data is theirs.', nextBy(f, 'Unit7 can shut it off from the internet in one click; your apps still reach it.')];
    if (p === 8080 || /dashboard|admin/i.test(f.title)) return ['An admin page can be opened by anyone on the internet.', 'Strangers can see how your sites are set up, and bots look for pages like this.', nextBy(f, 'Unit7 can close it to the internet in one click; you can open it again any time.')];
    return [`Something on ${n} can be reached directly from the internet.`, 'It skips the safe front door your websites use, so it is easier to attack.', nextBy(f, 'Unit7 can close it to the internet in one click, and open it again if you need it.')];
  },
  'xray:exposed': () => ['A database can be reached from the whole internet, not just from your apps.', 'Bots try passwords on it all day; one good guess and your data is theirs.', 'Unit7 can close it to the internet; your apps still reach it.'],
  'server:coolify-ports': () => ['Coolify keeps a few doors open for itself.', 'Nothing: Coolify needs them to work.', 'Nothing to do; this is expected.'],
  'xray:coolify-http': (_n, f) => ['You sign in to Coolify through an address without the padlock.', 'Your Coolify password travels unprotected each time, so someone on the way could read it.',
    (f.fix as { flow?: unknown } | null | undefined)?.flow ? 'Unit7 can give Coolify its own secure address, step by step, and check it works before anything else changes.' : nextBy(f, 'Unit7 can set it up for you.', 'Unit7’s AI can give Coolify its own secure address and walk you through it.')],
  'xray:coolify-port': (_n, f) => ['Coolify can be reached from the internet on a second, less protected address.', 'If its key ever leaks, someone could control Coolify from anywhere.',
    (f.fix as { flow?: unknown } | null | undefined)?.flow ? 'Unit7 can give Coolify its own secure address first, then close the other one, step by step, so you never get locked out.' : nextBy(f, 'Unit7 can close that address; Unit7 itself talks to Coolify from inside the server.')],
  'xray:coolify-realtime': (_n, f) => ['Coolify keeps two extra doors open that it no longer needs.', 'Now that Coolify has its own secure address, those doors only add ways in.', nextBy(f, 'Unit7 can close them; Coolify keeps working through its secure address.')],
  'xray:coolify-health': (_n, f) => ['Coolify has no way to tell when a new version of this app is ready.', 'So visitors can see errors each time a new version goes live.', nextBy(f, 'Unit7 can find a page the app answers on and turn on Coolify’s health check, then deploy once to test it. Undo puts it back.', undefined, 'Unit7 shows you where to turn it on in Coolify.')],
  // --- signing in ---
  'server:ssh-password': (n, f) => [`${n} lets people sign in with a password.`, 'Bots guess passwords all day; a lucky guess gives them the whole server.', nextBy(f, 'Unit7 can switch passwords off (your keys keep working) and turn on automatic security updates.')],
  'server:ssh-tries': (n, f) => [`${n} lets someone try many passwords in a row.`, 'More tries make it easier for bots to guess their way in.', nextBy(f, 'Unit7 can lower the number of tries and lock sign-in down.')],
  'server:ssh-guessing': (n, f) => [`Someone tried to sign in to ${n} many times and failed.`, /passwords? sign-in is on|password sign-in is on/i.test(f.detail ?? '') ? 'Password sign-in is on, so one lucky guess could let them in.' : 'Sign-in needs a key, so guessing can’t get in, but it is noise worth stopping.', nextBy(f, 'Unit7 can block the busiest guesser, or turn passwords off.')],
  'server:clock': (n, f) => [`${n}’s clock is drifting away from the real time.`, 'A wrong clock breaks secure websites, sign-in codes and scheduled backups.', nextBy(f, 'Unit7 can turn on automatic time keeping; nothing restarts.')],
  // --- the server itself ---
  'server:firewall': (n, f) => /on purpose|leaves the firewall|manage/i.test(`${f.title} ${f.detail}`) ? [`${n} is shared with other tools that open their own doors.`, 'Nothing by itself; a single wall around everything would break them.', 'Unit7 leaves the wall to them and closes single doors instead (each one is listed here).']
    : [`${n} has no wall keeping unwanted visitors out.`, 'Anything that starts listening on the server is open to the whole internet.', nextBy(f, 'Unit7 can turn the wall on so only sign-in and your websites get through.')],
  'server:container': (n, f) => [`${n} has full control of the whole server.`, 'If that one app is broken into, the attacker gets everything else too.', nextBy(f, 'Unit7 can lower its rights.', 'Unit7’s AI can check whether it really needs that power and suggest a safer setup.')],
  'server:coolify-docker': () => ['Coolify’s own parts have full control of the server.', 'Nothing: that is how Coolify works.', 'Nothing to do; this is expected.'],
  'server:disk': (n, f) => [`${n}’s storage is almost full.`, 'When it fills up, databases stop saving and you may not be able to sign in.', nextBy(f, 'Unit7 can clear out old leftovers from earlier updates; your data is never touched.')],
  'server:reboot': (n, f) => [`${n} installed updates that need a restart to finish.`, 'Until it restarts, some security fixes aren’t active yet.', nextBy(f, 'Unit7 can restart it now (about a minute offline) or at a quiet time you pick, then check every site comes back.')],
  'server:updates': (n, f) => /install tonight|nothing to do/i.test(`${f.title} ${f.detail}`) ? [`${n} has security updates waiting.`, 'Nothing: they install by themselves tonight.', 'Nothing to do.']
    : [`${n} doesn’t install security updates by itself.`, 'Known holes stay open until someone remembers to update.', nextBy(f, 'Unit7 can turn on automatic security updates; they install each night.')],
  'server:unreachable': (n, f) => [`Unit7 couldn’t look inside ${n}.`, 'Its safety checks were skipped, so problems there stay hidden.', nextBy(f, 'Unit7 can find out why.', undefined, 'Open the server: Unit7 runs a health check and offers a fix.')],
  // --- apps in trouble ---
  'xray:oom': (n, f) => [`${n} keeps running out of memory and restarting.`, 'Each time, visitors see errors, and it can slow down everything else on the server.', nextBy(f, 'Unit7 can give it a safe memory limit and check it keeps running.', undefined, 'Unit7 shows you where to set a memory limit for it.')],
  'xray:restart-loop': (n, f) => [`${n} keeps crashing and starting again.`, 'It is down most of the time, so people using it see errors.', nextBy(f, 'Unit7 can restart it cleanly.', 'Unit7’s AI can read what it printed and tell you why, before changing anything.')],
  'xray:layer': (n, f) => [`${n} keeps files in a place that is wiped on its next update.`, 'Those files disappear the next time it is updated or rebuilt.', nextBy(f, 'Unit7 can move them somewhere safe.', 'Unit7’s AI can move them somewhere that survives updates.')],
  // --- no way back ---
  'xray:weak-backup': (n, f) => [`${n} is only copied onto the same server.`, 'If the server dies, those copies go with it.', nextBy(f, 'Unit7 can send a copy off the server, encrypted, without touching anything else.', 'Unit7’s AI can set up a copy off the server.')],
  'part-errors': (n, f) => [`${n} keeps hitting the same error.`, 'People using it may be seeing failures.', nextBy(f, 'Unit7 can look into it for you.', 'Your AI can find the cause from what Unit7 measured.')],
  'db:connections': (n, f) => [`${n} is close to its limit of open connections.`, 'When it’s full, new visitors get errors.', nextBy(f, 'Unit7 can look into it for you.', 'Unit7’s AI can find which apps hold them.')],
  'db:stuck': (n, f) => [`${n} has work that started and never finished.`, 'It blocks cleanup, and can block other work.', nextBy(f, 'Unit7 can look into it for you.', 'Unit7’s AI can find which app left it open.')],
  'db:cache': (n, f) => [`${n} reads from disk more than it should.`, 'Pages feel slower than they need to.', nextBy(f, 'Unit7 can look into it for you.')],
  'xray:no-backup': (n, f) => [`${n} holds your app’s data, and no copy of it is kept anywhere Unit7 can see.`, 'If the server breaks or something is deleted by mistake, that data is gone for good.',
    nextBy(f, 'Unit7 can copy it every day, keep the last 7, and store them safely off the server, starting now.', 'Unit7’s AI can set up a daily copy for you.')],
  'unit7:no-backup': (n, f) => [`${n} has no copies of its data.`, 'If the server breaks or something is deleted by mistake, there is no way back.', nextBy(f, 'Unit7 can copy it every day and keep the last 7, safely off the server.')],
  'unit7:backup-broken': (n, f) => [`${n}’s newest copy doesn’t open when Unit7 tests it.`, 'If you needed it today, it wouldn’t bring your data back.', nextBy(f, 'Unit7 can take a fresh copy now and test it again this week.')],
  'unit7:backup-untested': (n, f) => [`${n}’s copy has never been tested.`, 'An untested copy might not work on the day you need it.', nextBy(f, 'Unit7 can test it on a throwaway copy; your real data isn’t touched.')],
  'xray:disk-forecast': (_n, f) => ['At the rate the server is filling up, its storage runs out soon.', 'When it is full, databases stop saving and sign-in can fail.', nextBy(f, 'Unit7 can clear out old leftovers now to buy time; your data is never touched.')],
  // --- waste ---
  'xray:logs': (_n, f) => ['Apps’ diaries (logs) keep growing and are never trimmed.', 'They slowly fill the server’s storage, a common reason a server stops.', nextBy(f, 'Unit7 can trim them and keep them small from now on; apps keep running.')],
  'xray:reclaim': (_n, f) => ['Old leftovers from earlier updates take up space.', 'They waste storage that your apps may need later.', nextBy(f, 'Unit7 can remove them safely; nothing that runs changes.')],
  'xray:volume': (n, f) => [`${n} is stored data that nothing uses any more.`, 'It takes up space, and might hold something old you still want.', nextBy(f, 'Unit7 can move it to a 7-day trash, so you can still bring it back.', undefined, 'Unit7 shows you how to check it and remove it where it was made.')],
  // --- tips ---
  'xray:git-dirty': (_n, f) => ['Some files were edited by hand on the server and never saved to your code history.', 'The next update or a new server loses those edits, and teammates can’t see them.', nextBy(f, 'Unit7 can save them.', 'Unit7’s AI can show you what changed and help save it to your code history.')],
  'xray:no-cap': (n, f) => [`${n} can use as much memory as it wants.`, 'If it misbehaves, it can take every other app on the server down with it.', nextBy(f, 'Unit7 can give it a safe limit, based on what it used this week, without restarting it.')],
  'xray:no-caps': (_n, f) => ['Some apps can use as much memory as they want.', 'One misbehaving app can take every other app on the server down with it.', nextBy(f, 'Unit7 can give each a safe limit.', 'Unit7’s AI can set a safe limit for each one, based on what they used this week.')],
  // --- apps ---
  'app:log-secret': (n, f) => [`${n} writes passwords or keys into its diary (logs).`, 'Anyone who can read those logs can use them to get in.', nextBy(f, 'Unit7 can change the password or key now and update the apps that use it.', undefined, 'Unit7 shows you how to change it and stop it being written down.')],
  'app:vulns': (n, f) => [`${n} uses add-on code with known security holes.`, 'Attackers look for exactly these holes; fixed versions already exist.', nextBy(f, 'Unit7 can prepare the update for you to review; nothing goes live until you say so.', 'Unit7’s AI can update them and redeploy the app.')],
  'app:public-secret': (_n, f) => ['A secret setting is named so that it gets shipped to every visitor’s browser.', 'Anyone visiting the site could read it and use it.', nextBy(f, 'Unit7 can fix it.', 'Unit7’s AI can rename it so it stays on the server, and help you change the secret.')],
  'app:exposed': (_n, f) => [/settings file/i.test(f.title) ? 'A website lets anyone download its secret settings file.' : 'A website lets anyone download its code history.', 'Passwords and keys in it should be treated as known to strangers.', nextBy(f, 'Unit7 can fix it.', 'Unit7’s AI can block those files and help you change every key that was in them.')],
  // --- domains ---
  'domain:tls': (n, f) => [`${n}’s padlock (its security certificate) is ${/broken/i.test(f.title) ? 'broken' : 'about to run out'}.`, 'Visitors get a scary warning page and many will leave.', nextBy(f, f.fix && 'tool' in f.fix && f.fix.tool === 'domain.renew_https' ? 'Unit7 can renew it now and check it from outside.' : 'Unit7 can check it again from outside.')],
  'domain:registration': (n, f) => [`${n} ${/expired/i.test(f.title) ? 'has run out' : 'is about to run out'} at the company you bought it from.`, 'Everything on it goes offline, and someone else could buy the name.', 'Renew it where you bought it; it costs money, so Unit7 never does it by itself.'],
  'domain:email': (n, f) => [`Anyone can send emails that look like they come from ${n}.`, 'Scammers can fake your address, and your real emails land in spam more often.', nextBy(f, 'Unit7 can add the record that tells email services to reject fakes; nothing else changes.')],
  'domain:takeover': (n, f) => [`${n} points to an app that no longer exists.`, 'Someone else could create that app and take over your address.', nextBy(f, 'Unit7 can remove the old pointer.', 'Unit7’s AI can find the old pointer and remove it, after you say yes.')],
  // --- Unit7 itself ---
  'unit7:paused': () => ['Autopilot is paused.', 'Unit7 can watch but can’t fix anything until you turn it back on.', 'Turn it back on from the Autopilot page when you’re ready.'],
  'unit7:autopilot': (_n) => ['Your live app lets AI make risky changes without asking you.', 'A mistake could reach your visitors before you see it.', 'Unit7 suggests asking you first for risky changes on the Autopilot page.'],
  'unit7:rotate': (_n, f) => ['A connection key is older than you wanted.', 'The longer a key lives, the more damage a leaked one can do.', nextBy(f, 'Unit7 can change it now; the old one keeps working for a day so nothing breaks.')],
  'unit7:db-passwords': (_n, f) => ['Your database passwords never change by themselves.', 'If one leaks, it keeps working until someone changes it.', nextBy(f, 'Unit7 can change them every 90 days, at night, and update the apps that use them.')],
  'unit7:token': () => ['An app key hasn’t been used in 3 months and never expires.', 'Forgotten keys are easy to miss if they leak.', 'Turn it off in Settings if nothing uses it.'],
  'unit7:alerts': () => ['Nobody hears about problems at night.', 'Something could be down for hours before anyone notices.', 'Set up phone alerts on the Connections page: scan a code, then tap once to prove your phone gets them. It’s free.'],
  'unit7:account': (n) => [`${n} stopped letting Unit7 in.`, 'Unit7 can’t watch what is in that account until it is reconnected.', 'Reconnect it on the Connections page.'],
  // --- traffic and logs (the watch) ---
  'traffic:surge': (_n, f) => ['Many more visits than usual arrived in the last half hour.', 'If it isn’t real visitors, it slows your sites and costs you money.', nextBy(f, 'Unit7 can block the address sending most of it, for a while.', 'Unit7’s AI can look at where it comes from and tell you if it’s real.')],
  'traffic:5xx': (_n, f) => ['Many visitors got an error page instead of your site.', 'People can’t use your site and may not come back.', nextBy(f, 'Unit7 can fix it.', 'Unit7’s AI can read the logs and recent changes and tell you the cause.')],
  'traffic:anon-one': (_n, f) => ['One address is hammering your site without signing in.', 'It can slow your site down for everyone and may be looking for a way in.', nextBy(f, 'Unit7 can block that address for a while; it lifts by itself.')],
  'traffic:anon-many': (_n, f) => ['A crowd of addresses is calling your site without signing in.', 'It can slow your site down; blocking one address at a time won’t help.', nextBy(f, 'Unit7 can slow them down.', 'Unit7’s AI can block the busiest ones and suggest a limit per visitor.')],
  'traffic:login-one': (_n, f) => ['One address keeps guessing passwords on your sign-in page.', 'A lucky guess would give them someone’s account.', nextBy(f, 'Unit7 can block that address for a while; it lifts by itself.')],
  'traffic:login-many': (_n, f) => ['Many addresses are guessing passwords on your sign-in page at once.', 'A lucky guess would give them someone’s account.', nextBy(f, 'Unit7 can slow them down.', 'Unit7’s AI can block the worst ones and suggest a limit on sign-in tries.')],
  'traffic:scan': (_n, f) => ['Bots poked at your server looking for weak spots.', 'Usually nothing; it only matters if one of them finds something.', nextBy(f, 'Unit7 can block the busiest one for a while.')],
  'traffic:no-log': (_n, f) => ['Coolify isn’t keeping a list of visits to your sites.', 'Unit7 can’t count visitors or spot floods and attacks without it.', nextBy(f, 'Unit7 can turn it on in Coolify’s own settings and check every site still answers.')],
  'logs:errors': (n, f) => [`${n} is reporting many more errors than usual.`, 'Something in it is going wrong, and people using it may see failures.', nextBy(f, 'Unit7 can fix it.', 'Unit7’s AI can read the errors and tell you the cause in plain words.')],
};
// a finding an AI added (ai:<hash>): its own title is the plain line
const AI_WORDS: Words = (_n, f) => [f.title.replace(/\.$/, '') + '.', (f.detail || 'An AI noticed this while looking around.').split(/(?<=[.!?])\s/)[0]!, nextBy(f, 'Unit7 can fix it.', 'Unit7’s AI can look into it further.', 'Unit7 shows you the steps the AI suggested.')];

export const kindOf = (id: string) => id.split(':').slice(0, 2).join(':');
const advancedOf = (f: FindingLike) => [f.title.replace(/\.?$/, '.'), f.detail, f.evidence && `Seen: ${f.evidence}`].filter(Boolean).join(' ');
export function explainFinding(f: FindingLike): Explain {
  const w = f.id.startsWith('ai:') ? AI_WORDS : FINDING_WORDS[kindOf(f.id)];
  if (!w) return { what: f.title.replace(/\.?$/, '.'), why: (f.detail ?? '').split(/(?<=[.!?])\s/)[0] || 'Unit7 thinks this is worth a look.', next: nextBy(f, 'Unit7 can fix it in one click.'), advanced: advancedOf(f) };
  const [what, why, next] = w(subjectOf(f), f);
  return { what, why, next, advanced: advancedOf(f) };
}
export const withExplain = <T extends FindingLike>(f: T): T & { explain: Explain } => ({ ...f, explain: explainFinding(f) });

// --- the server watch's alerts (usage jumps; traffic and risks are findings) ---------------------------------
const USAGE: Record<string, (name: string, metric?: string) => [string, string, string]> = {
  high: (n, m) => [`${n} is using far more ${m === 'mem' ? 'memory' : m === 'net' ? 'network' : 'computer power'} than usual for this time.`, 'If it keeps climbing, apps slow down or stop.', 'Unit7 keeps watching; its AI can look at what changed.'],
  spike: (n) => [`${n} suddenly sent or received far more data than usual.`, 'It may be a rush of visitors, a bot, or something copying data out.', 'Unit7 keeps watching; its AI can look at where it comes from.'],
  leak: (n) => [`${n}’s memory keeps climbing and never comes back down.`, 'When it runs out, the app crashes and visitors see errors.', 'Unit7’s AI can find what grows; a restart buys time.'],
  restarts: (n) => [`${n} keeps stopping and starting again.`, 'People using it see errors each time it stops.', 'Unit7’s AI can read why it stops and suggest the fix.'],
  disk: (n) => [`${n}’s storage is filling much faster than usual.`, 'If it fills up, databases stop saving.', 'Unit7 can clear out old leftovers; its AI can find what grows.'],
};
export function explainAlert(a: { source: string; key: string; title: string; data?: Record<string, any> }): Explain {
  const d = a.data ?? {};
  if (a.source === 'usage' && USAGE[d.kind]) { const [what, why, next] = USAGE[d.kind]!(d.name ?? 'An app', d.metric); return { what, why, next, advanced: a.title }; }
  return explainFinding({ id: d.id ?? a.key, title: d.title ?? a.title, detail: d.detail, evidence: d.evidence, fix: d.fix, about: d.about });
}

// --- events (Activity rows and phone alerts): why it matters and what Unit7 does --------------------------------------
export const EVENT_WORDS: Record<string, [what: string, why: string, next: string]> = {
  'delete.held': ['An AI asked to delete something, and you said yes. It waits 48 hours before it happens.', 'That gives you time to change your mind.', 'You can cancel it from the list of waiting deletes.'],
  'coolify.changed': ['Coolify changed something Unit7 depends on.', 'Some Coolify features in Unit7 may not work until Unit7 updates.', 'Your apps aren’t affected. Update Unit7 when you can.'],
  'breakin.found': ['Unit7 found signs that someone got into a server.', 'Someone who got in can hide, so cleaning up can’t be trusted.', 'Don’t try to clean it. Make a new server, restore from a copy taken before this, and change every key. The evidence already left the server.'],
  'safety.started': ['Unit7 found data that matters, and it’s making safe copies of it.', 'If the server dies or something is deleted, you can get it back.', 'There’s nothing to do. It only creates copies, and it tells you when it’s done.'],
  'safety.protected': ['Unit7 made a safe copy of something important and proved it works.', 'That data can now survive losing the server.', 'There’s nothing to do. See the copies on the Safety Net page.'],
  'safety.failed': ['Unit7 tried to make a safe copy and couldn’t.', 'Until this works, that data has no safety net.', 'Open the Safety Net page to see why. Unit7 tries again by itself.'],
  'safety.lifeboat': ['Something dangerous is coming, so a fresh copy and the evidence left the server.', 'If the server goes, you keep your data and the record of what happened.', 'See what set it off on the Safety Net page. Nothing else changed.'],
  'catchup.done': ['This is what happened while Unit7 wasn’t watching.', 'Unit7 can’t see anything while this computer sleeps, so it read the server’s own record.', 'If this happens often, an Outpost keeps watch from the server.'],
  'checkup.found': ['A check that ran by itself found something new and serious.', 'It’s new since the last check, so it may need you soon.', 'Open the Check-up to see what it is and who can fix it.'],
  'watch.route': ['This computer lost its way to one of your sites, but the site itself is fine.', 'Visitors aren’t affected. Places outside could still reach it.', 'There’s nothing to do unless it stays like this.'],
  'watch.blocked': ['Your server’s own defence banned the internet address this computer uses.', 'Your sites are fine, but they won’t open from this network until the ban ends.', 'Ask Unit7 to lift it.'],
  'finding.fixed': ['The fix worked, and production proves it.', 'Unit7 read the same numbers again after your deploy, so this isn’t a guess.', 'There’s nothing to do. Unit7 keeps watching for a week in case it returns.'],
  'finding.still': ['The problem is still happening after your deploy.', 'The change didn’t fix it, or didn’t reach this part of the app.', 'Give the new numbers to your AI: it now knows what didn’t work.'],
  'finding.back': ['A problem that was fixed has come back.', 'Something undid the fix, or the real cause was never removed.', 'Open it and give it to your AI again, with the history.'],
  'incident.opened': ['Something important stopped working.', 'People using your apps may be stuck right now.', 'Unit7 is looking into it and will tell you the cause and the fix.'],
  'service.down': ['One of your apps stopped answering.', 'People can’t use it until it’s back.', 'Unit7 tries to bring it back and tells you why it stopped.'],
  'server.unreachable': ['One of your servers stopped answering Unit7.', 'Everything on it may be offline for visitors.', 'Unit7 keeps trying and shows the likely cause with a fix on the server’s page.'],
  'server.recovered': ['A server that stopped answering is back.', 'Nothing more; things should be working again.', 'Unit7 keeps watching it.'],
  'server.host_key_changed': ['A server’s identity card changed since Unit7 last saw it.', 'It can mean the server was rebuilt, or someone is pretending to be it.', 'Unit7 stopped talking to it until you confirm it’s really yours.'],
  'deployment.rolled_back': ['Right after an update, an app got clearly worse, so Unit7 put the version before back by itself.', 'Visitors are on the version that worked; the new changes aren’t live.', 'Show me opens the release: what got worse, and the update’s log to fix it from.'],
  'deployment.watch_bad': ['Right after an update, an app got clearly worse.', 'Visitors may be seeing errors or slow pages.', 'Roll it back from the app page, or ask Unit7 why.'],
  'deployment.failed': ['An update to one of your apps didn’t go live.', 'Visitors still see the old version; your new changes aren’t out yet.', 'Unit7 kept the old version running; its AI can read why it failed.'],
  'backup.failed': ['A scheduled copy of a database didn’t work.', 'If something went wrong now, the newest data couldn’t be brought back.', 'Unit7 tries again every 15 minutes and tells you if it keeps failing.'],
  'backup.offsite_failed': ['A database copy stayed only on its server.', 'If that server breaks, the copy goes with it.', 'Unit7 tries again with the next copy; you can retry it from Backups.'],
  'backup.verify_failed': ['A database copy didn’t open when Unit7 tested it.', 'It wouldn’t bring your data back if you needed it today.', 'Unit7 suggests taking a fresh copy now and testing it again.'],
  'seven.did': ['Seven, the agent on shift, did this by itself.', 'It only does what’s safe and can be taken back.', 'Nothing for you to do. See it on the Seven page.'],
  'seven.note': ['Seven found something that needs a look.', 'It couldn’t settle this by itself.', 'Open the Seven page to see what it found.'],
  'approval.requested': ['Unit7 or your AI wants to do something and is waiting for your OK.', 'Nothing happens until you say yes.', 'Approve it or say not now; either way you stay in charge.'],
  'account.refused': ['One of your connected accounts stopped letting Unit7 in.', 'Unit7 can’t watch what is in that account until it’s reconnected.', 'Reconnect it on the Connections page.'],
  'security.vulnerable': ['An app uses add-on code with known security holes.', 'Attackers look for exactly these holes.', 'Unit7 can prepare an update for you to review.'],
  'security.found': ['The safety check found something new and serious.', 'It could let someone in or lose data if left alone.', 'Each problem has a fix one click away on the security page.'],
  'server.disk_high': ['A server’s storage is almost full.', 'When it fills up, databases stop saving and sign-in can fail.', 'Unit7 can clear out old leftovers; your data is never touched.'],
  'job.failed': ['A scheduled task didn’t finish.', 'Whatever it does (emails, reports, clean-ups) didn’t happen this time.', 'Unit7 runs it again on schedule; its AI can read why it failed.'],
  'link.broken': ['A connection between your apps stopped working.', 'Parts of your app that rely on it may fail.', 'Unit7 shows what broke and how to reconnect it.'],
  'domain.takeover_risk': ['One of your web addresses points to an app that no longer exists.', 'Someone else could take over that address.', 'Unit7 can remove the old pointer after you say yes.'],
  'secret.leaked': ['A password or key was found in your code.', 'Anyone who sees the code can use it.', 'Unit7 changes it where it can and tells you which ones need you.'],
  'secret.manual': ['A password or key was found in your code that Unit7 can’t change by itself.', 'Anyone who sees the code can use it until it’s changed.', 'Change it where it comes from, then paste the new one into Unit7.'],
  'secret.rotation_failed': ['Changing a password didn’t work, so Unit7 put the old one back.', 'Nothing broke, but the password is still the old one.', 'Unit7 tries again later; its AI can read why it failed.'],
  'budget.over': ['You spent your whole monthly budget.', 'Costs keep adding up until something is stopped.', 'Unit7 shows what costs the most and a plan to stop it, for you to approve.'],
  'budget.warning': ['At this rate you will go over your monthly budget.', 'The bill may be higher than you planned.', 'Unit7 shows what costs the most and how to save.'],
  'app.errors': ['An app is reporting more errors than usual.', 'People using it may see failures.', 'Unit7’s AI can read the errors and tell you the cause.'],
  'site.down': ['A website stopped working.', 'Visitors can’t reach it right now.', 'Unit7 is checking why and will tell you the fix.'],
  'site.recovered': ['A website that was down is working again.', 'Nothing more; visitors can reach it.', 'Unit7 keeps watching it.'],
  'site.slow': ['A website is answering slowly.', 'Visitors may give up before it loads.', 'Unit7 keeps watching; its AI can look at what slows it down.'],
  'tls.expiring': ['A website’s padlock (its security certificate) runs out soon.', 'Visitors will get a scary warning page.', 'It should renew by itself; Unit7 can renew it now.'],
  'domain.expiring': ['One of your web addresses runs out soon at the company you bought it from.', 'Everything on it goes offline, and someone else could buy it.', 'Renew it where you bought it; Unit7 never spends money by itself.'],
  'domain.broken': ['One of your web addresses stopped leading to your site.', 'Visitors who type it get nowhere.', 'Unit7 shows what changed and how to point it back.'],
  'autonomy.lowered': ['Unit7 asks you before more changes now.', 'A few things will wait for your OK instead of happening by themselves.', 'You can change this on the Autopilot page.'],
  'autopilot.paused': ['Autopilot is paused.', 'Unit7 watches but fixes nothing by itself until you turn it back on.', 'Turn it back on from the Autopilot page.'],
  'safety.weekly': ['Here is what Unit7 stopped this week.', 'These were things that could have caused harm.', 'Nothing to do; Activity has the details.'],
  'watch.anomaly': ['Something on a server is behaving unusually.', 'If it keeps going, apps may slow down or stop.', 'Unit7 keeps watching; its AI can look at what changed.'],
  'watch.traffic': ['Your sites got unusual traffic.', 'It can slow sites down or be someone looking for a way in.', 'Unit7 can block the worst address; its AI can look closer.'],
  'watch.finding': ['Unit7 found a new risk on a server.', 'It could let someone in or lose data if left alone.', 'It has a fix on the server’s Health tab.'],
  'watch.digest': ['Here is your week in short.', 'Nothing urgent; it’s a summary.', 'Nothing to do.'],
  'story.brief': ['Here is your morning brief.', 'Nothing urgent; it’s a summary.', 'Nothing to do.'],
  'routine.report': ['A routine you saved finished.', 'Nothing; it’s the report you asked for.', 'Nothing to do.'],
  'routine.failed': ['A routine you saved didn’t work this time.', 'What it does didn’t happen.', 'Unit7 tries again next time; three failures in a row pause it.'],
  'routine.paused': ['A routine you saved was paused after failing several times.', 'It won’t run until it’s fixed.', 'Open it to see why and turn it back on.'],
  'domain.bought': ['A new web address was bought.', 'Nothing; it’s yours now.', 'Unit7 can point it at one of your apps.'],
  'asset.ai_archived': ['Your AI put something away, so Unit7 stopped watching it.', 'If it was still in use, problems with it would go unnoticed.', 'Undo it in Activity if that was a mistake.'],
  'autofix.applied': ['Unit7 fixed something small by itself.', 'Nothing; it was safe and can be undone.', 'Undo it in Activity if you’d rather it hadn’t.'],
  'reboot.soon': ['A server restarts in 10 minutes to finish its updates.', 'Its apps are offline for about a minute.', 'Unit7 backs up its databases first and checks every site comes back.'],
  'reboot.done': ['A server restarted to finish its updates.', 'Nothing more; the updates are active now.', 'Unit7 checked its sites came back.'],
  'cost.spike': ['Your cloud spending jumped.', 'The bill may be much higher than usual this month.', 'Unit7 has a plan to stop it, waiting for your OK.'],
};
export function explainEvent(type: string, message: string): Explain {
  const w = EVENT_WORDS[type];
  return w ? { what: w[0], why: w[1], next: w[2], advanced: message } : { what: message.split(/(?<=[.!?])\s/)[0] ?? message, why: '', next: '', advanced: message };
}
// the phone's short version: the specific message, then why it matters and what Unit7 does
export function phoneText(type: string, message: string): string {
  const w = EVENT_WORDS[type];
  return w ? `${message.trim()}\n${w[1]} ${w[2]}` : message;
}

// --- Warden's suggestions (src/suggestions.ts), by kind: what it can cause and what Unit7 does ----------------------------
export const SUGGESTION_WORDS: Record<string, [why: string, next: string]> = {
  backup: ['If the server breaks or something is deleted by mistake, there is no way back.', 'Unit7 can copy it every day and keep the copies safely off the server.'],
  badbackup: ['The newest copy wouldn’t bring your data back if you needed it.', 'Unit7 can take a fresh copy and test it.'],
  offsite: ['A copy that lives only on its server breaks with that server.', 'Unit7 can copy it off the server, locked so only you can open it.'],
  migration: ['An update that changes the database could lose data without a fresh copy.', 'Unit7 can copy the database first, then finish the update.'],
  deployfail: ['Your newest changes aren’t live; visitors still see the old version.', 'Unit7’s AI can read why it failed and suggest the fix.'],
  error: ['People using the app may be running into failures.', 'Unit7’s AI can read the errors and find the cause.'],
  '5xx': ['Visitors are getting error pages instead of your site.', 'Unit7’s AI can find what breaks and fix it.'],
  vuln: ['Attackers look for exactly these known holes.', 'Unit7 can prepare an update for you to review.'],
  devserver: ['A test setup is slower and less safe for real visitors.', 'Unit7 can switch it to a proper production build.'],
  leak: ['A secret named this way ends up in every visitor’s browser.', 'Unit7’s AI can rename it so it stays on the server.'],
  envmissing: ['The app may crash or misbehave without these settings.', 'Unit7 shows which ones are missing so you can add them.'],
  health: ['Without a health check, Unit7 can’t tell quickly when the app is stuck.', 'Unit7 can add one so problems are caught sooner.'],
  domain: ['People can only reach it through a long technical address.', 'Unit7 can connect one of your domains to it.'],
  cache: ['Every visit downloads the same files again, which makes pages slower.', 'Unit7 can let browsers keep them for a while.'],
  scale: ['One copy may not keep up when it gets busy.', 'Unit7 can run a second copy to share the work.'],
  'scale-blocked': ['A second copy would break it the way it’s built today.', 'Unit7’s AI can show what to change so it can share the work.'],
  'server-max': ['A full server slows everything on it down.', 'Unit7 can show a bigger plan or move some apps.'],
  mem: ['If memory keeps growing, the app crashes and visitors see errors.', 'Unit7’s AI can find what uses it.'],
  job: ['Whatever this task does (emails, reports, clean-ups) isn’t happening.', 'Unit7’s AI can read why it fails.'],
  worker: ['Work that runs in the background isn’t being done.', 'Unit7 can start it.'],
  idle: ['It costs money and power while nobody uses it.', 'Unit7 can stop it; you can start it again any time.'],
  down: ['People can’t use it right now.', 'Unit7 can find out why it stopped and bring it back.'],
  prepare: ['Unit7 can’t put apps on it yet.', 'Unit7 can set it up in one go.'],
  harden: ['Bots try to break in to servers all day.', 'Unit7 can lock down sign-in and close what shouldn’t be open.'],
  disk: ['When storage fills up, databases stop saving.', 'Unit7 can clear out old leftovers; your data is never touched.'],
  rightsize: ['You pay for more than the server uses.', 'Unit7 can show a smaller plan that fits.'],
  incident: ['Something important stopped working.', 'Unit7’s AI can find what happened and fix it if it’s safe.'],
  blocked: ['Something your AI tried was stopped by your rules.', 'Activity shows what was blocked and why.'],
  staging: ['Trying changes on your live app risks what visitors see.', 'Unit7 can make a test copy to try things first.'],
  group: ['Things that belong together are easier to watch as one.', 'Unit7 can group them; you can undo it.'],
  serverapp: ['Unit7 can’t look after it until it’s connected.', 'Unit7 can connect it in one click.'],
};
export function explainSuggestion(id: string, text: string): Explain {
  const w = SUGGESTION_WORDS[id.split(':')[0]!];
  const what = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return w ? { what, why: w[0], next: w[1], advanced: text } : { what, why: '', next: '', advanced: text };
}

// words a non-coder shouldn't meet in the first three lines (they belong in Advanced); whole words, any case
export const JARGON = ['oom', 'docker-user', 'mad', 'cgroup', 'iptables', 'ufw', 'sshd', 'ssh', 'cve', 'spf', 'dmarc', 'tls', 'ssl', 'dns', 'cname', 'container', 'containers', 'volume', 'volumes',
  'kernel', 'systemd', 'cron', 'env', 'stdout', 'stderr', 'daemon', 'json', 'api', 'traefik', 'caddy', 'pg_dump', 'pg_dumpall', 'mysqldump', 'mongodump', 'bgsave', 'rdb', '5xx', '4xx', 'http', 'https',
  'tcp', 'udp', 'ntp', 'root', 'sudo', 'swap', 'proxy', 'port', 'ports', 'endpoint', 'payload', 'token', 'registry', 'image', 'images', 'compose', 'pm2', 'nginx', 's3', 'cli', 'uuid', 'webhook', 'regex', 'mem_limit', 'journal', 'journald'];
export const jargonIn = (text: string) => JARGON.filter((w) => new RegExp(`(^|[^\\w-])${w.replace(/[-_]/g, '[-_]')}($|[^\\w-])`, 'i').test(text));

// keep it fresh (src/fresh): updates that went out, one held back, updates waiting for a person, the weekly report
Object.assign(EVENT_WORDS, {
  'fresh.released': ['Updates for one of your apps are live.', 'Nothing for you to do; it was tested on a copy first and visitors weren’t cut off.', 'Unit7 watched it after the switch and would have put the version before back by itself.'],
  'fresh.held': ['Unit7 held updates back for one of your apps.', 'Nothing changed on the live app; it keeps running the version that works.', 'Show me opens the app with the reason. Unit7 tries again next week, or right away once it’s fixed.'],
  'fresh.ready': ['Updates for one of your apps are ready for your OK.', 'Until they go out, the app keeps known problems those updates fix.', 'Release tests them on a copy first and ships them without downtime; or hold them for later.'],
  'fresh.weekly': ['How keeping your apps up to date went this week.', 'Nothing; it’s a short report.', 'Settings, Updates changes how far updates go by themselves.'],
} satisfies Record<string, [string, string, string]>);

// many servers (src/fleet): a new version tried on some visitors, rolled back by itself; a warm standby taking over, one
// that couldn't, its data copy failing, and the monthly drill
Object.assign(EVENT_WORDS, {
  'fleet.canary': ['A new version of one of your apps is being tried on some of its visitors first.', 'The rest stay on the version that works; Unit7 compares the two and moves on only while the new one does as well.', 'Promote gives every visitor the new version now; Roll back puts everyone on the old one.'],
  'fleet.canary_rolled_back': ['A new version did worse than the old one on the visitors it was tried on, so Unit7 put everyone back.', 'Visitors are on the version that worked; most never saw the new one.', 'Show me opens the app with what got worse, to fix it before trying again.'],
  'dr.failover': ['One of your servers stopped answering, so its app now runs on the warm standby.', 'Visitors reach the standby; anything saved since its last data copy may be missing there.', 'Once the server is fine, switch back from the app’s page: what the standby collected goes back first.'],
  'dr.cant_switch': ['A server stopped answering, and its warm standby doesn’t answer either.', 'The app is offline until one of them is back.', 'Open the server’s page: Unit7 says what it found and how to bring it back.'],
  'dr.refresh_failed': ['Unit7 couldn’t copy fresh data to an app’s warm standby.', 'If the main server died now, the standby would have older data.', 'Unit7 tries again on its next round; the app’s page says why it failed.'],
  'dr.drill': ['Unit7 tested an app’s warm standby, as it does once a month.', 'Nothing changed for visitors: it only asked the standby for the site.', 'The app’s page shows the result and how fast you’d be back.'],
} satisfies Record<string, [string, string, string]>);
