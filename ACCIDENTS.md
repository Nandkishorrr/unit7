# The famous accidents, replayed

These are real, public incidents where an AI destroyed something. Each is replayed against Unit7's gate in [`test/v2-accidents.test.ts`](test/v2-accidents.test.ts), and runs on every change. Details of each come from public reports, and some are disputed.

| Incident | What happened | Replayed here | Result |
|---|---|---|---|
| **PocketOS, Apr 2026** | After a credential mismatch in staging, an agent found a token in an unrelated file and deleted a production volume and its backups, in one call, in about nine seconds | The same delete, by an AI and by a token found lying around | **Stopped.** A volume delete needs a person. Deleting data with Coolify can't be approved for an AI at all. A findings-only token can do nothing else |
| **Replit, Jul 2025** | An agent deleted a production database during a code freeze | A freeze written as "Never touch shop", then a restart, a `dropdb`, and trying to remove the rule | **Stopped.** The rule binds at the gate, and an AI can't remove it or switch off the Safety Net |
| **DataTalks.Club, Feb 2026** | A clean-up removed infrastructure, snapshots included | A guided delete and a project delete by an AI | **Stopped, then slowed.** The guided delete is a person's. With a yes, it still waits 48 hours |
| **Kiro, Dec 2025** | An agent chose to delete and recreate an environment. Disputed | An environment delete by an AI | **Stopped.** It waits for a person |

## Where Unit7 would not have stopped it

Be clear about this:

- **An AI with its own keys never comes through this gate.** PocketOS's agent used a token it found. If that had been a Railway or Hetzner token, Unit7 wouldn't have seen it. Unit7 can only stop what passes through Unit7.
- **The seat belt only takes a copy.** Before a risky command in Claude Code, it copies your data. It doesn't block the command.
- **A person can say yes.** A tired yes on the wrong thing still counts, though AI deletes wait 48 hours so it can be taken back.
- **Off-server copies are what save you.** If your only copies share the disk, nothing here helps. That's why the Safety Net sends them off the server first.
