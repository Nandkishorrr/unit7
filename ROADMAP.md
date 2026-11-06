# Roadmap

**Now:** V2.1 is the latest version. V2 answers "is everything OK?" with no AI, protects important data by itself, and checks production after your AI ships a fix. V2.1 adds Seven, an agent on shift that does the safe work and asks one clear question.

**In testing:** built and tested against fake servers.
- Put this live, on 16 hosts.
- Tools for your real databases, plus Supabase and Neon.
- DNS records, redirects and wildcards.
- A file manager and server care.
- WordPress, deeper Coolify tools and one-click tools.

**Next:**
- First runs of all that on real accounts.
- Seven on a real API key, and its first actions on real servers.
- Test restores on full Supabase stacks.
- Tuning the Call Inspector on real traffic.
- A first tagged release, with a signed image and a one-line install.

**Later:**
- Scoped server access, with an allow-list checked on the server.
- MySQL detail in the Call Inspector.

**Not planned:** a hosted Unit7 that holds your root keys, our own coding agent, our own AI model, a Kubernetes layer.

What's built today, and where each part stops, is in [LIMITS.md](LIMITS.md).
