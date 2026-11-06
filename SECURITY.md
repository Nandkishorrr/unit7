# Security policy

Unit7 holds SSH keys and provider credentials and can act on real servers, so security reports matter a lot.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a few
days, and a fix and credit (if you want it) once it's resolved.

## Scope

The threat model is in the README under "Security model". In short: Unit7 defends against websites in your
browser, AI agents and scripts holding a token, and secrets at rest. It does not defend against malware already
running as your own user.
