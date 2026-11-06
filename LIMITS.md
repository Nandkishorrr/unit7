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

## WordPress

- No multisite import. Uploads are capped at 100 MB. It needs the official image with a reachable MySQL or MariaDB container, and Coolify with Traefik for new sites. Premium plugin updates may not show.

## Files

- Text up to 1 MB, 64 KB for an AI, and 100 MB for transfers. Containers need a shell. Undo fails once a container is recreated.

## Domains

- Wildcard HTTPS needs a person to set up DNS-01. GoDaddy may refuse small accounts’ API keys. Vercel redirects work on whole domains only.

## Moving and changing servers

- server.move copies through this Mac and doesn’t resume. Built images, non-Coolify apps and host cron stay behind. Hostinger plan changes happen in hPanel. Port rules survive restarts only with systemd.

## Putting a site live

- Netlify, Cloudflare Pages and GitHub Pages take finished files only. One-click Hostinger accounts can’t upload, so add a token. Unit7’s GitHub App can’t create repos or turn on Pages. Hostinger settings change all together. Cloudflare uses a token’s first account.

- Fly needs a ready image or a copy of an app. Cloud Run needs a gcloud sign-in and uses us-central1. Render, Railway, DigitalOcean and Amplify builds need their GitHub app connected once in a browser.

- A dropped site: 100 MB sent, 90 MB packed, 1 GB unpacked, 20,000 files. No ZIP64 or password-protected ZIPs.

## Databases

- Hiding personal columns is best effort: a filter can reveal a value slowly. Switching to a new major version works for Postgres on Coolify or Compose only. part.query needs psql 12 or newer. Restoring to a moment in time isn’t built: the best case is the last copy.

## One-click apps

- Without Coolify, only Umami and Unleash can be added. Templates outside the catalogue get no admin protection and no domain.

## Connected accounts

- Stripe shows a signing secret once, so stripe.webhooks infers mismatches, and comparing test and live needs both connected. Setting GitHub secrets needs gh installed. With no AI connected, the ask box answers four fixed asks.

## Not built

- **Scoped server access.** Unit7 needs root or passwordless sudo. A real allow-list needs every script hashed and checked on the server.
- **The 15-minute tracing option.** The read-only closer look is built. The eBPF one isn't.
- **A model table.** Fault drills cover the fixed rules. A "works well with these models" table needs a key for each model.
- **Windows.** macOS and Linux only.
