# Limits

What Unit7 can and can't do, so you don't find out the hard way.

## Apps Unit7 deployed, and apps it found

| | Deployed by Unit7 | Found on a server (Coolify, Compose, Docker) |
|---|---|---|
| Disk, memory, who's using what | Yes | Yes |
| Errors in logs | Every minute | In each Check-up |
| Setting names | Yes | Yes |
| Known holes in images | Each deploy, then weekly | After you press Scan: the first scan downloads about 1 GB |
| Backups, proof of restore | Yes | Postgres and Supabase compare every table and row with the file. MySQL/MariaDB, MongoDB and Redis check that data came back. Uploaded files aren't test-restored |
| Uploaded files and settings | Yes | Yes, for what the X-ray can see |
| Memory caps | Yes | Coolify applications and services, Docker, Compose |
| Roll back | Yes, one click | Through Coolify |
| Change app code | Never | Never. Your AI does that, and Unit7 checks it worked |

## The Call Inspector

- It reads the proxy's log and the database's counters. A call between two containers that skips the proxy is invisible.
- It runs silently for its first week. A signal has to repeat before it counts.
- It can't see inside your app. Causes are marked as likely.
- Database detail is Postgres only. MariaDB keeps those counters off by default.
- Detection was built on test traffic. Expect to tune it on yours.

## When it's asleep

On a Mac, Unit7 stops when the Mac sleeps. The Always on page shows the hours it missed. "Keep this Mac awake" helps while plugged in. The Outpost keeps measuring, alerting and copying from the server, and it can't investigate or fix anything. Only an outside heartbeat can tell you a whole server died.

## Security checks

- "No signs of a break-in" doesn't prove nobody got in. A strong sign means rebuild, not clean.
- What a stranger can do is checked on addresses tied to you, from your connection. It counts rows and reads none.
- Door rules are a shorter set than Supabase's own splinter lints.
- The brake table is what each provider's docs said in November 2026. It doesn't read your live setting yet.

## Hosted Supabase and Neon

- Self-hosted Supabase: auth changes need Coolify, there are no sign-in providers or email templates, realtime off lasts until the next deploy, and functions have no history.
- supabase.sql’s checks for an AI are a list of names and forms. A column named like json or xml, or named like its own table, is a person’s to read.

## WordPress

- No multisite import. Uploads are capped at 100 MB. It needs the official image with a reachable MySQL or MariaDB container, and Coolify with Traefik for new sites. Premium plugin updates may not show.

## Files

- Text up to 1 MB, 64 KB for an AI, and 100 MB for transfers. Containers need a shell. Undo fails once a container is recreated.

## Domains

- Wildcard HTTPS needs a person to set up DNS-01. GoDaddy may refuse small accounts’ API keys. Vercel redirects work on whole domains only.

## Moving and changing servers

- server.move copies through this Mac and doesn’t resume. Built images, non-Coolify apps and host cron stay behind. Hostinger plan changes happen in hPanel. Port rules survive restarts only with systemd.

## Putting a site live

- Netlify’s build logs aren’t in its API, so Unit7 can’t show them: read them on Netlify. Azure Static Web Apps has no logs or domains through Unit7. On AWS, Google Cloud and Azure, Unit7 runs one product each: Amplify, Cloud Run and Static Web Apps.
- Prices and sizes are written into Unit7 from each host’s price page in November 2026, and they can change. The host’s bill is what counts. Railway has no size to pick: it bills what the app uses.
- A build or start command can be changed on Coolify, your own server, Vercel, Render and DigitalOcean. Elsewhere the host works out its own build. Sizes aren’t offered for a plain website.
- A site with no domain on Coolify gets a free test address on sslip.io. Its certificate comes from Let’s Encrypt, which can refuse when too many people ask at once, so it isn’t for real visitors. Add your domain for that.
- A push goes live by itself on Coolify only when GitHub can reach it: through Coolify’s GitHub App, or a webhook Unit7 adds when Coolify has a public address. If it can’t, the page says so.
- Netlify, Cloudflare Pages and GitHub Pages take finished files only. One-click Hostinger accounts can’t upload, so add a token. A GitHub App connected earlier needs its rights changed by hand: Unit7 gives the links. Hostinger settings change all together. Cloudflare uses a token’s first account.

- Fly needs a ready image or a copy of an app. Cloud Run needs a gcloud sign-in and uses us-central1. Render, Railway, DigitalOcean and Amplify builds need their GitHub app connected once in a browser.

- A dropped site: 100 MB sent, 90 MB packed, 1 GB unpacked, 20,000 files. No ZIP64 or password-protected ZIPs.

## Databases

- A table refused during a restore, because a check reads a table that isn’t in yet, goes again once the rest is in, with its triggers off. So do the foreign keys pointing at it, unless a name in the key holds a quote or a semicolon. Only tested on a real Postgres so far, not a real Supabase backup.
- For an AI, a column shows when its name isn’t personal, so a secret under a plain name still shows, and a filter can reveal a value slowly. Only plain columns, counts and simple sums prove themselves, so anything computed comes back hidden. MySQL can’t show what a view renamed. Redis has no columns, so only key names and value shapes are checked. database.query, on databases Unit7 runs itself, doesn’t hide anything.
- A dump is checked for what it says, not what it builds: SQL put together while it runs, such as in a DO block, isn’t caught. So load only dumps you trust. A plain string with a backslash right before a quote is refused: double it or use E''.
- Switching to a new major version works for Postgres on Coolify or Compose only. part.query needs psql 12 or newer. Restoring to a moment in time isn’t built: the best case is the last copy.

## One-click apps

- Without Coolify, only Umami and Unleash can be added. Templates outside the catalogue get no admin protection and no domain.

## Connected accounts

- Stripe shows a signing secret once, so stripe.webhooks infers mismatches, and comparing test and live needs both connected. Setting GitHub secrets needs gh installed.

- A move doesn’t copy data, cron or host redirects, and never removes the old site. A site that runs from a compose file asks a person when it’s made and at each update.

## Email

- Forwarding needs Cloudflare DNS. Mailboxes aren’t hosted. DKIM is found by usual names unless the DNS host is connected. A Compose file that sets GOTRUE_SITE_URL is edited by hand. Older Cloudflare keys need Email Routing permissions.

## PlanetScale, Turso and Upstash

- One-click sign-ins to these three only read. Creating, connecting, removing and sizes need a key. A Turso token can’t be revoked alone. Upstash gives no login to a read-only key.

## Login and email forwarding

- Google and GitHub sign-in clients can’t be created by API: Unit7 gives the steps and the callback address. Supabase’s built-in sender stays at two emails an hour, so real use needs your own sender. Forwarding needs Cloudflare DNS, and undoing a subdomain forward leaves Cloudflare’s records. Subdomain forwarding hasn’t been tried on a real zone.

## Hostinger and Firebase

- A Hostinger plan with no website yet can’t be seen, so Unit7 can’t make the first website on an empty plan. Hostinger is retiring the website route Unit7 uses, and its replacement is an order route. Firebase logs are visitor requests only, once Cloud Logging is linked.

## Cloudflare

- Workers take finished JavaScript: there’s no build, and routes are made on Cloudflare. D1 runs one statement at a time, with no triggers. New Workers get Workers Logs on, which can bill past Cloudflare’s free allowance on a paid plan.

## Hosted platforms after the first deploy

- Render has no free cron, and a database address is copied, so a password changed there isn’t followed. Railway has no cron here. Fly.io’s release list misses deploys made by API. Heroku’s add-ons and data don’t roll back. A DigitalOcean disk can’t shrink. Railway databases use a route its API docs don’t cover, and it hasn’t been tried on a real account.

## Package updates

- Updating packages runs the package tool on the repo’s own files in a throwaway container that holds a GitHub key. With Unit7’s GitHub App that key reaches one repo’s files for an hour. A pasted or CLI token reaches all it can, and a Yarn plugin in the repo could read it.

## Home with no AI connected

- With no AI connected, Home answers seven questions and offers to connect one. Other requests aren’t kept. WordPress move-in takes files up to 100 MB each.

## Not built

- **Scoped server access.** Unit7 needs root or passwordless sudo. A real allow-list needs every script hashed and checked on the server.
- **The 15-minute tracing option.** The read-only closer look is built. The eBPF one isn't.
- **A model table.** Fault drills cover the fixed rules. A "works well with these models" table needs a key for each model.
- **Windows.** macOS and Linux only.
