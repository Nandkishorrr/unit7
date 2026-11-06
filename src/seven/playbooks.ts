// What Seven knows in depth, loaded only when a shift needs it, so the prompt stays small. Each playbook is how a senior engineer
// approaches the topic: what to check first, what usually causes it, what's a trap. Anything with a version or a date in it gets
// checked live (lookup_software, lookup_outage), because a playbook ages too.
export const PLAYBOOKS: Record<string, string> = {
  incident: `Something is broken right now.
1. Is it real? Check from outside and from inside. If only Unit7 can't reach it, say that before anything else.
2. Is it us or them? lookup_outage for the host, the CDN and the big dependencies before digging.
3. What changed? story_timeline. Most outages follow a deploy, a setting, an expired thing, or a full disk.
4. Stop the bleeding before finding the cause. A rollback or a restart beats a clever fix at 3am. Take a copy first if data is involved.
5. Check it's actually better. Look at what users see, not at whether the command worked.
6. Write down what happened, why, and what would have caught it sooner.
Common causes, in rough order: a bad deploy; disk full; out of memory; an expired certificate or key; a database out of connections; a dependency down; a cron job that piled up.`,

  security: `Order matters. Lead with what a stranger can do right now, not a count of issues.
1. Secrets in the open: .env or .git served on the web, keys in JS bundles and source maps, a service key under a public name.
2. Data doors: databases and admin panels reachable from the internet, Supabase tables with no door rule (RLS), public storage buckets.
3. Broken access: routes that work with no sign-in or with someone else's id. This is the top web risk on OWASP's list year after year.
4. Known holes that are being exploited now. Check the running version with lookup_software. Internet-facing frameworks first.
5. Supply chain: lockfiles committed, install scripts, unpinned GitHub Actions, packages published by a stolen account.
6. Headers and TLS come last. They never outweigh a readable database.
OWASP Top 10 (2025): broken access control, security misconfiguration, software supply chain failures, cryptographic failures, injection, insecure design, authentication failures, software or data integrity failures, logging and alerting failures, mishandling of exceptional conditions.
Docker published ports go around UFW by default. A port can look closed in the firewall and be open to the world. Trust a test from outside.
Signs of a break-in: an unknown busy process, new SSH keys, new cron or @reboot lines, changed shell files, odd outbound connections, a miner's CPU pattern. A hit means rebuild, not clean. Copy logs and data off the server first, and touch nothing else.
After any leak: rotate the key where it comes from. Deleting it from the code doesn't un-leak it.`,

  supabase: `The anon key is meant to be public. The service role key must never reach a browser: it ignores every door rule.
Door rules (RLS): every table in an exposed schema needs RLS on and a policy. RLS on with no policy returns nothing, and looks like a bug. Policies with "true" are open doors.
Slow policies: auth.uid() runs once per row. Wrapped as (select auth.uid()) it runs once per query. On big tables this is often the whole slowness.
Security definer functions need a fixed search_path, and they skip RLS.
Storage: check which buckets are public, and whether the policies on storage.objects match.
Repeated /auth/v1/user calls: getUser() asks the Auth server every time. In middleware that's one call per route change. Check the session once, verify the JWT locally where you can, and share the result.
PostgREST caps rows at db-max-rows, 1000 in the usual compose files. A route always returning exactly 1000 rows is hiding the rest and has no filter.
Realtime postgres_changes checks each change once per subscriber, so one busy table with many subscribers costs a lot. realtime.list_changes at the top of pg_stat_statements isn't an app bug.
Self-hosted: change the default JWT secret, keys and dashboard password from the template. Don't expose Studio or Postgres to the internet. The gateway is Kong in Coolify's template and Envoy in newer Supabase releases.
Uploaded files live in a volume, not in the database. A database dump doesn't include them.`,

  nextjs: `NEXT_PUBLIC_ settings are written into the browser bundle at build time. They can't hold secrets, and changing one needs a rebuild.
Server Actions are public POST endpoints: each one must check who's calling. Middleware isn't a security boundary on its own; authorise again where the data is read.
Two kinds of settings: build-time and run-time. In Docker, a value set only at run time doesn't reach code that was built earlier. This causes most "works locally" deploy failures.
Common build failures: out of memory (raise the heap or add swap), a lockfile that doesn't match package.json, a wrong Node version, a page that calls the database during build.
Common slowness: fetching in client effects where a server component would do, one component calling the same data many times, images not going through the optimiser, no cache headers on API routes.
<Link> prefetches what enters the viewport, in production only, so a page full of links can look like a burst of calls.
With output: 'standalone', the Docker image needs public and .next/static copied in by hand.
Serious framework holes keep appearing, in middleware and in React Server Components. Check the running version with lookup_software before calling a Next.js app safe.`,

  postgres: `Find what's wrong by sorting pg_stat_statements three ways: by calls (N+1 and polling), by total time (what costs the most overall), by mean time (slow queries). Read differences between snapshots, not raw totals.
Rows per call high: over-fetching, usually a missing filter or limit. Blocks read per row high: a missing index.
Connections: each costs memory, and the limit is hard. Too many means pooling is missing, or a leak. Transaction-mode poolers break prepared statements and session settings unless the client is told.
Idle in transaction blocks vacuum and can block writes. Set idle_in_transaction_session_timeout. Look for an app that begins a transaction and then calls something slow.
Migrations that hurt: ALTER TABLE needs a strong lock, and one waiting lock blocks everyone behind it. Use lock_timeout, CREATE INDEX CONCURRENTLY, and expand then contract: add new, write both, backfill in batches, switch, remove old. Never rename in one step on a live app.
Disk growing with steady data: bloat, or WAL kept by a dead replication slot. Check pg_replication_slots.
A backup isn't real until it restored. A dump is a moment in time; everything since is lost.`,

  docker: `Disk fills from: images from old builds, build cache, and container logs. Logs have no limit by default: set max-size on the json-file driver. docker system df shows the split.
Every app should have a memory cap, about 1.5 times its real peak, or one leak takes down its neighbours. A kill by the kernel shows as OOMKilled or exit code 137.
A restart loop hides the error: read the logs of the failed run, and check the exit code. 137 is memory, 1 is the app, 127 is a missing command.
Health checks need a tool inside the image. No curl or wget in the image means the check fails every deploy, though the app is fine.
Published ports bypass UFW. Bind to 127.0.0.1 or use the proxy, and test from outside.
Coolify: change what Coolify runs through Coolify, or the next deploy undoes it. Its proxy is Traefik. Memory caps go in Resource limits and apply from the next deploy. Supabase and other stacks are Coolify services, set through their compose file. Its API needs read:sensitive to show logs.
Named volumes and bind folders survive a redeploy; the container's own filesystem doesn't. Check where uploads really live.`,

  cicd: `A failed deploy: read the first error, not the last line. Sort it into build, tests, or start-up, because the fixes differ.
Build: lockfile out of step, wrong Node or package manager version, out of memory, a missing build-time setting, a registry that's down.
Start-up: a missing run-time setting, a bad migration, the wrong port, a failed health check.
Roll back first if users are affected. Find out why afterwards. A rollback can't undo a migration that already ran, so migrations must work with the previous version of the code.
Deploy the same image you tested, by digest, not by a moving tag.
GitHub Actions: pin third-party actions to a full commit SHA, give GITHUB_TOKEN least permissions, prefer OIDC to long-lived keys. pull_request_target with a checkout of the PR's code runs a stranger's code with your secrets.
Keep secrets out of build logs and out of image layers. docker history shows them.
Good pipelines are boring: fast tests first, one artifact, a preview for each PR, a health check gate, an automatic rollback.`,

  frontend: `Good Core Web Vitals, at the 75th percentile: LCP under 2.5 s, INP under 200 ms, CLS under 0.1.
Slow first paint: a big JS bundle, unoptimised hero image, blocking fonts, a slow first server answer. Start with the server: nothing can beat a slow TTFB.
Hashed static files should send Cache-Control: public, max-age=31536000, immutable. HTML shouldn't.
Repeated calls usually come from: an effect with an unstable dependency, two components asking for the same thing, polling that could be a push, a retry with no back-off, a tab left open.
SWR and TanStack Query dedupe and refetch on focus by default. Know which one is doing the calling before calling it a bug.
Hidden tabs slow timers, but don't stop them. Polling every 5 seconds is 17,280 calls a day per open tab.
Lists: virtualise long ones, and fetch one page, not everything.
A blank page in production is usually a chunk from an old deploy, a missing public setting, or an error boundary with nothing in it.`,

  api: `Everything that crosses a network needs a timeout. Most cascades start with a call that waits forever.
Retries: only on what can succeed later (429, 5xx, network), with exponential back-off and jitter, and a limit. Without a budget, retries multiply load just when the server is struggling.
Anything that can retry must be safe to repeat: use an idempotency key on writes, above all payments.
Rate limits: send 429 with Retry-After, and respect it from others.
Lists: always paginate, and cap the page size. Fetch several by id in one call, not one call per id.
Webhooks: verify the signature on the raw body, reject old timestamps, answer fast and do the work later, and expect the same event twice.
CORS protects browsers, not your API. It isn't authentication.
401 means who are you; 403 means not allowed; 404 can hide that something exists. A client looping on 401 has an expired token and no refresh.
For outside services, log the status and how long each call took, without the body. It's how you can tell "they're down" from "our key expired".`,

  ai: `Apps built on AI have three recurring problems: cost, injection, and quality going quiet.
Cost: a loop or a retry around a model call can burn a budget overnight. Set a hard spending limit at the provider, cap per user, log tokens per feature, cache repeated prompts. The provider's key must never reach a browser.
Prompt injection isn't solved. Any text the model reads can steer it. The dangerous mix is private data, untrusted text and a way to send data out, all in one agent. Remove one of the three. Give each tool the least access it can work with, and check actions with code, not with the model.
RAG: filter by the user's permissions before retrieval, not after.
MCP servers are code you run, and tool descriptions are text the model believes. Pin them and review them.
Quality drifts silently when models change. Keep a small eval, and pin model versions in production.
Have a fallback for when a provider is down. Check lookup_outage first when calls start failing.`,
};
export const TOPICS = Object.keys(PLAYBOOKS);
