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
| Memory caps | Yes | Coolify applications, Docker, Compose. Not Coolify services such as Supabase |
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

## Not built

- **Scoped server access.** Unit7 needs root or passwordless sudo. A real allow-list needs every script hashed and checked on the server.
- **The 15-minute tracing option.** The read-only closer look is built. The eBPF one isn't.
- **A model table.** Fault drills cover the fixed rules. A "works well with these models" table needs a key for each model.
- **Windows.** macOS and Linux only.
