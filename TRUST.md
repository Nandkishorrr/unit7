# Trust

Unit7 holds keys to your servers and can act on them. This page says what that means, plainly.

## What it can reach

| Thing | Access | Where the secret lives |
|---|---|---|
| Your servers | SSH, as the user you connected, usually root | The vault, encrypted. On a Mac, its key is in the Keychain |
| Coolify | An API token Unit7 makes for itself | The vault |
| Your AI's API key | Sent only to that provider | The vault |
| Your data | Backups are encrypted before they leave the server | Off-server copies go where you choose |

Nothing is sent to us. There's no Unit7 cloud, no telemetry and no account. It's one process and one SQLite file on your computer or your server.

## Threat model

**What Unit7 protects against**
- An AI doing something you didn't ask for. Every action passes one gate, whoever asks. Risky ones wait for a person.
- An AI reading text written by an attacker. Logs are data. Prompts are built from parsed fields, and Unit7's own checks need no AI.
- A leaked Unit7 key doing damage. Keys can be scoped to read-only, or to findings only.
- A bad delete. An AI's delete waits 48 hours, even after a yes. A person can cancel it.

**What it doesn't protect against**
- Someone with your server's root password, or your Mac unlocked. They don't need Unit7.
- An AI with its own SSH key or cloud token. It never comes through the gate. See [ACCIDENTS.md](ACCIDENTS.md).
- Unit7 itself being compromised. It runs with root on your servers. Read the code, and pin a version.
- Hours when it's asleep. On a laptop, without an Outpost, nobody is watching.

**Access is broad on purpose, for now.** Unit7 connects as root or with passwordless sudo, because it runs many small scripts. A real allow-list needs each script hashed and checked on the server, and that isn't built. See [LIMITS.md](LIMITS.md).

## What it does by itself

Automatic steps only create or copy. Unit7 never deletes or restarts anything of yours on its own initiative to protect you.

- **By itself:** backups, sending them off the server, test restores in a throwaway container with no network, and keeping evidence. The older automatic copies it replaces and the throwaway are the only things it removes. After signs of a break-in it keeps every copy for 30 days, because the old ones are the clean ones.
- **Seven, the agent on shift:** alone it does the same, plus adding swap and renewing a certificate. Restarts, memory caps, blocks, closing ports and clean-ups are questions, unless you taught it that fix. Fixed code decides this, not the AI.
- **Always a person:** removing old images, old logs and past copies. At 90% disk it asks you, on your phone if that's connected, and doesn't clean up alone. A rollback uses those images, and old logs are the evidence after a break-in.
- **Every brake applies:** Pause, Safety Net off and your busy hours stop all automatic copies, the Outpost's included. It hears them each time Unit7 syncs with it. A copy never starts on a server that's already busy. The one exception is a break-in, where evidence and copies leave at once unless the Safety Net is off.
- **Past copies stay until you put them away.** One may be what your app runs on by now. Unit7 reminds you after two days.

## AI disclosure

Unit7 can use an AI you connect: an API key, a local model, or your own signed-in Claude Code for requests you type. Text it reads, including server logs and table names, can go to that provider.

- Check-ups, the Safety Net, the Outpost, the Call Inspector and security checks use **no AI**.
- Secrets are removed before anything reaches a model, and addresses are removed from what you hand your own AI.
- Automatic runs with nobody watching need an API key or a local model. Unit7 doesn't start your personal subscription by itself.
- Seven's routine shifts use fixed rules until you connect one. A Claude Code you left on `/unit7 watch` takes a shift only when something goes wrong, and while it holds one its Unit7 tools can only look.
- This project is built with heavy use of AI coding tools. A person reviews and owns what ships.

## What an AI can read

- supabase.sql denies an AI vault, key and sign-in tables by name. An app’s own table under a plain name is only column-masked.
- wp-cli output is data. WordPress admin passwords reach only the vault and the person asking, and a failed update’s automatic put-back touches files, never the database.
- An AI can’t open secret files on a server, even through a link, and can’t change who can sign in. File contents stay out of the audit log.
- Mail record changes need a person’s yes. The proxy only restarts when asked for, through the gate.
- A deploy key’s private half goes only to Coolify. Unit7’s own Coolify key can delete, because Coolify needs that to replace things, and approvals still decide.
- Unit7 never removes its own key or the last working key on a server. Key changes update the break-in baseline line by line. server.move only reads the old server, apart from a fresh backup file.
- Hostinger deploys overwrite with no undo: a site with content needs update, an AI needs a person, and WordPress, Builder and Horizons sites are refused. Uploads to Hostinger and servers are repacked from checked files, so left-out keys never leave.
- Your GitHub token goes to Azure or AWS only to connect your repo. A key in finished files stops publishing.
- A dropped ZIP is never trusted: paths leaving the site stop it, links are dropped, and bytes are counted as they unpack. An AI hears an upload’s id, name and stack, never a path.
- An AI reads found databases only through a read-only login in a throwaway container. That login can see every row, so people-only limits still apply, and exports are people-only.
- Unit7 claims an add-on’s admin at install, or keeps it behind an extra password. Templates outside the catalogue are unprotected, so an AI asks first.
- connection.call masks secret fields for an AI, treats unlisted tools as destructive, and leaves buying to people. stripe.webhooks shares only setting names and modes.
- move.switch always needs a person. Copying readable settings needs a person’s yes, and values are never shown.

## Licence promise

Unit7 is open source under the licence in [LICENSE](LICENSE). What's open today stays open: if a paid version ever exists, it's for things that are extra, and nothing here gets moved behind it.

## Reporting a problem

See [SECURITY.md](SECURITY.md).
