// Start free: what each service gives you for $0, read from each provider's own pricing or limits page (October 2026),
// and a recommended free stack for what you're building. Plain data and pure functions (no React), so tests load it.
// "fits" is an ESTIMATE worked out from one stated limit and the assumption next to it; it is never a provider number.
// Prices and limits change: every plan links its source, and anything a page didn't make clear says "check their page".

export const CHECKED = '2026-10';
export const CHECKED_WORDS = 'October 2026';

export type Need = 'hosting' | 'database' | 'auth' | 'email' | 'newsletter' | 'payments' | 'domains' | 'dns' | 'vps' | 'storage' | 'analytics' | 'monitoring' | 'ai';
// free: a free plan; trial: free for a while; credit: a one-off credit; none: no free plan; self-host: free software on
// your own server; per-sale: no monthly fee, a cut of each sale
export type Free = 'free' | 'trial' | 'credit' | 'none' | 'self-host' | 'per-sale';

export interface Plan {
  id: string; name: string; logo: string; need: Need; free: Free;
  key: string;                 // the one limit that matters, for the badge
  limits: string[];            // what the free plan gives, in plain words ("Check their page" when unclear)
  fits?: number;               // about how many users it carries for $0 (estimate)
  assumes?: string;            // how that estimate was worked out
  uncapped?: true;             // no user cap worth counting (DNS, simple analytics)
  paid: { name: string; price: string }; // the first paid step
  gotchas: string[];
  source: string; checked: string;
  price?: { firstYear: string; renewal: string }; // domains: a .com, first year and renewal
  connect?: string;            // its tile on Connections, when Unit7 connects to it
  selfHost?: string;           // its card on Add to my server
  best?: string;               // why it's the recommended pick in its need (one per need)
}

export const NEEDS: { id: Need; label: string; blurb: string }[] = [
  { id: 'hosting', label: 'Hosting', blurb: 'Where your website or app lives.' },
  { id: 'database', label: 'Database', blurb: 'Where your app keeps its data.' },
  { id: 'auth', label: 'Sign-in', blurb: 'Accounts, passwords, “Sign in with Google”.' },
  { id: 'email', label: 'Sending email', blurb: 'Sign-up, password reset and receipt emails from your app.' },
  { id: 'newsletter', label: 'Newsletters', blurb: 'Email to a list of subscribers.' },
  { id: 'payments', label: 'Payments', blurb: 'Taking money: one-off or subscriptions.' },
  { id: 'domains', label: 'Domains', blurb: 'Your own .com. Never free: watch the renewal price.' },
  { id: 'dns', label: 'DNS & protection', blurb: 'Points your domain at your app, adds HTTPS, stops attacks.' },
  { id: 'vps', label: 'Servers', blurb: 'A whole server of your own. Unit7 sets it up for you.' },
  { id: 'storage', label: 'File storage', blurb: 'Uploads, images and backups.' },
  { id: 'analytics', label: 'Analytics', blurb: 'Who visits and what they do.' },
  { id: 'monitoring', label: 'Monitoring', blurb: 'Errors and “is it up?” checks.' },
  { id: 'ai', label: 'AI', blurb: 'An AI model for your app to call.' },
];

// --- the estimates: one stated limit, one plain assumption ------------------------------------------------------------
const round = (n: number) => { const step = n >= 10000 ? 1000 : n >= 1000 ? 100 : 10; return Math.max(step, Math.round(n / step) * step); };
const est = (users: number, assumes: string) => ({ fits: round(users), assumes });
const web = (gbMonth: number) => est((gbMonth * 1000) / 20, 'Assumes ~20 page views per user a month, about 1 MB each.');
const calls = (perMonth: number) => est(perMonth / 20, 'Assumes ~20 server requests per user a month. Plain files don’t count.');
const data = (mb: number) => est(mb * 10, 'Assumes ~100 KB of saved data per user.');
const mau = (n: number) => est(n, 'Counts people who sign in at least once a month.');
const mail = (perMonth: number) => est(perMonth / 3, 'Assumes ~3 emails per user a month: sign-up, a sign-in link, a receipt.');
const subs = (n: number, how = 'Counts subscribers: everyone on your list.') => est(n, how);
const files = (gb: number) => est(gb * 100, 'Assumes ~10 MB of uploads per user.');
const events = (perMonth: number) => est(perMonth / 20, 'Assumes ~20 page views per visitor a month.');
const redis = (perMonth: number) => est(perMonth / 100, 'Assumes ~100 cache reads and writes per user a month.');
const ram = (gb: number) => est(gb * 2000, 'Very rough: a small app and its database, ~2,000 monthly users per GB of memory.');

const C = CHECKED;
export const PLANS: Plan[] = [
  // --- hosting --------------------------------------------------------------------------------------------------------
  { id: 'cloudflare-pages', name: 'Cloudflare Pages + Workers', logo: 'cloudflarepages', need: 'hosting', free: 'free', key: 'Unlimited visits to static pages',
    limits: ['Static pages: unlimited visits and bandwidth', 'Server code: 100,000 requests a day', '500 builds a month', '100 custom domains per project'],
    ...calls(3_000_000), paid: { name: 'Workers Paid', price: '$5/month (10 million requests)' },
    gotchas: ['Server code stops for the day after 100,000 requests (resets at midnight UTC)', '10 ms of CPU per request on free', 'Next.js needs Cloudflare’s adapter'],
    source: 'https://developers.cloudflare.com/pages/platform/limits/', checked: C, connect: 'cloudflare',
    best: 'The most free room, and no “personal use only” rule.' },
  { id: 'vercel', name: 'Vercel', logo: 'vercel', need: 'hosting', free: 'free', key: '100 GB transfer a month',
    limits: ['100 GB data transfer a month', '1 million function calls a month', '4 hours of function CPU a month', '100 deploys a day'],
    ...web(100), paid: { name: 'Pro', price: '$20/month per seat' },
    gotchas: ['Personal, non-commercial use only', 'Over a limit it stops (up to 30 days); you can’t pay for extra on free', 'Logs kept 1 hour'],
    source: 'https://vercel.com/docs/plans/hobby', checked: C, connect: 'vercel' },
  { id: 'netlify', name: 'Netlify', logo: 'netlify', need: 'hosting', free: 'credit', key: '300 credits a month (~15 GB)',
    limits: ['300 credits a month, never charged', '1 GB bandwidth costs 20 credits', 'Each live deploy costs 15 credits', 'Commercial use allowed'],
    ...web(15), paid: { name: 'Personal', price: '$9/month (1,000 credits)' },
    gotchas: ['Sites pause when credits run out, until next month', 'Bandwidth, deploys and functions share the same credits'],
    source: 'https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/', checked: C, connect: 'netlify' },
  { id: 'firebase-hosting', name: 'Firebase Hosting', logo: 'firebase', need: 'hosting', free: 'free', key: '10 GB transfer a month',
    limits: ['10 GB storage', '10 GB data transfer a month (360 MB a day)', 'Custom domain and HTTPS included', 'No server code on the free plan'],
    ...web(10), paid: { name: 'Blaze (pay as you go)', price: '$0.15 per GB over the free amount' },
    gotchas: ['The site goes offline at the limit until next month', 'Server code needs Blaze, which needs a card'],
    source: 'https://firebase.google.com/docs/hosting/usage-quotas-pricing', checked: C, connect: 'firebase' },
  { id: 'github-pages', name: 'GitHub Pages', logo: 'github', need: 'hosting', free: 'free', key: 'Static sites, 100 GB a month',
    limits: ['Static sites only', 'Site up to 1 GB', '100 GB bandwidth a month (soft limit)', 'Free accounts: public code only'],
    ...web(100), paid: { name: 'GitHub Pro (private repos)', price: '$4/month' },
    gotchas: ['Not allowed for online stores or SaaS', 'Your code must be public unless you pay'],
    source: 'https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits', checked: C, connect: 'github' },
  { id: 'render', name: 'Render', logo: 'render', need: 'hosting', free: 'free', key: 'Sleeps after 15 minutes idle',
    limits: ['750 server hours a month', '5 GB outbound bandwidth a month', 'Free Postgres: 1 GB, deleted after 30 days'],
    ...web(5), paid: { name: 'Starter', price: '$7/month per service' },
    gotchas: ['Sleeps after 15 minutes without visitors; about a minute to wake', 'Free Postgres is deleted after 30 days (14 more to upgrade)', 'Render says not to use free for production'],
    source: 'https://render.com/docs/free', checked: C, connect: 'render' },
  { id: 'railway', name: 'Railway', logo: 'railway', need: 'hosting', free: 'trial', key: '$5 trial, then $1 a month',
    limits: ['One-off $5 trial credit, up to 30 days', 'Then $1 of credit a month', 'Free: 0.5 GB memory per service'],
    paid: { name: 'Hobby', price: '$5/month (includes $5 of use)' },
    gotchas: ['When credit hits zero, every app stops', 'Trial disks are deleted 30 days after the credit runs out', '$1 a month only runs something tiny'],
    source: 'https://docs.railway.com/reference/pricing/plans', checked: C, connect: 'railway' },
  { id: 'fly', name: 'Fly.io', logo: 'fly', need: 'hosting', free: 'trial', key: 'Short trial only',
    limits: ['No free allowance for new accounts', 'Trial: 2 hours of machine time or 7 days', 'Then pay as you go'],
    paid: { name: 'Pay as you go', price: 'from about $2.19/month' },
    gotchas: ['No real free plan any more', 'Card needed after the trial', 'Billed by use, so no fixed price'],
    source: 'https://docs.fly.io/about/pricing', checked: C, connect: 'fly' },

  // --- databases ------------------------------------------------------------------------------------------------------
  { id: 'supabase', name: 'Supabase', logo: 'supabase', need: 'database', free: 'free', key: '500 MB database',
    limits: ['500 MB database', '1 GB file storage', '5 GB data out a month', '50,000 monthly sign-ins', '2 active free projects'],
    ...data(500), paid: { name: 'Pro', price: '$25/month' },
    gotchas: ['Pauses after 1 week with no activity', 'Only 2 active free projects'],
    source: 'https://supabase.com/pricing', checked: C, connect: 'supabase',
    best: 'Database, sign-in and file storage in one free project.' },
  { id: 'neon', name: 'Neon', logo: 'neon', need: 'database', free: 'free', key: '1 GB per project',
    limits: ['1 GB storage per project (20 GB in all)', '100 compute hours per project a month', 'Up to 100 projects', '5 GB data out per project'],
    ...data(1000), paid: { name: 'Launch', price: 'Pay for use, no monthly minimum' },
    gotchas: ['Sleeps after 5 minutes idle (can’t be turned off on free); first request after is slower'],
    source: 'https://neon.com/pricing', checked: C, connect: 'neon' },
  { id: 'turso', name: 'Turso', logo: 'turso', need: 'database', free: 'free', key: '5 GB, 100 databases',
    limits: ['100 databases', '5 GB storage', '500 million rows read a month', '10 million rows written a month'],
    ...data(5000), paid: { name: 'Developer', price: '$4.99/month' },
    gotchas: ['Over a limit, queries fail instead of billing you', 'Idle free databases are archived after 10 days'],
    source: 'https://turso.tech/pricing', checked: C, connect: 'turso' },
  { id: 'mongodb', name: 'MongoDB Atlas', logo: 'mongodb', need: 'database', free: 'free', key: '512 MB storage',
    limits: ['512 MB storage', 'Up to 100 operations a second', '500 connections', '10 GB in and out per 7 days'],
    ...data(512), paid: { name: 'Flex', price: 'from $8/month (capped at $30)' },
    gotchas: ['Paused after 30 days with no connections', 'One free cluster per project'],
    source: 'https://www.mongodb.com/pricing', checked: C },
  { id: 'firestore', name: 'Firebase Firestore', logo: 'firestore', need: 'database', free: 'free', key: '1 GB, 50,000 reads a day',
    limits: ['1 GB stored', '50,000 reads a day', '20,000 writes a day', '10 GB data out a month'],
    ...data(1000), paid: { name: 'Blaze (pay as you go)', price: 'free amounts, then per use' },
    gotchas: ['Reads and writes are counted per day, not per month', 'On Blaze the bill grows with traffic'],
    source: 'https://firebase.google.com/pricing', checked: C, connect: 'firebase' },
  { id: 'd1', name: 'Cloudflare D1', logo: 'cloudflare', need: 'database', free: 'free', key: '5 GB, 5 million reads a day',
    limits: ['5 GB storage', '5 million rows read a day', '100,000 rows written a day'],
    ...data(5000), paid: { name: 'Workers Paid', price: '$5/month' },
    gotchas: ['Limits are per day (reset at midnight UTC)', 'SQLite, so not a drop-in for Postgres apps'],
    source: 'https://developers.cloudflare.com/d1/platform/pricing/', checked: C, connect: 'cloudflare' },
  { id: 'upstash', name: 'Upstash Redis', logo: 'upstash', need: 'database', free: 'free', key: '500,000 commands a month',
    limits: ['500,000 commands a month', '256 MB data', '10 GB bandwidth a month'],
    ...redis(500_000), paid: { name: 'Pay as you go', price: '$0.20 per 100,000 commands' },
    gotchas: ['A cache and queue, not your main database', 'Archived after 30 days with no activity'],
    source: 'https://upstash.com/pricing/redis', checked: C, connect: 'upstash' },
  { id: 'planetscale', name: 'PlanetScale', logo: 'planetscale', need: 'database', free: 'none', key: 'No free plan since 2024',
    limits: ['No free plan (the free Hobby plan ended in 2024)', 'Cheapest: a single-node Postgres'],
    paid: { name: 'Single-node Postgres', price: '$5/month' },
    gotchas: ['The $5 plan has no standby copy', 'Included storage: check their page'],
    source: 'https://planetscale.com/pricing', checked: C, connect: 'planetscale' },

  // --- sign-in --------------------------------------------------------------------------------------------------------
  { id: 'supabase-auth', name: 'Supabase Auth', logo: 'supabase', need: 'auth', free: 'free', key: '50,000 monthly users',
    limits: ['50,000 monthly active users', 'Email, magic links and social sign-in', 'Shares the free project limits'],
    ...mau(50_000), paid: { name: 'Pro', price: '$25/month (100,000 users)' },
    gotchas: ['When the free project pauses (1 week idle), sign-in stops too'],
    source: 'https://supabase.com/pricing', checked: C, connect: 'supabase',
    best: '50,000 users free, and it comes with your Supabase database.' },
  { id: 'firebase-auth', name: 'Firebase Auth', logo: 'firebase', need: 'auth', free: 'free', key: '50,000 monthly users',
    limits: ['50,000 monthly active users', 'Email, Google, Apple and more'],
    ...mau(50_000), paid: { name: 'Blaze (pay as you go)', price: 'per use; text messages billed each' },
    gotchas: ['Sign-in by text message needs Blaze and costs per message', 'Company sign-in (SAML) is free for only 49 users'],
    source: 'https://firebase.google.com/docs/auth/limits', checked: C, connect: 'firebase' },
  { id: 'clerk', name: 'Clerk', logo: 'clerk', need: 'auth', free: 'free', key: '50,000 monthly users per app',
    limits: ['50,000 monthly retained users per app', 'Unlimited apps', 'Ready-made sign-in screens'],
    ...mau(50_000), paid: { name: 'Pro', price: '$25/month ($20 billed yearly)' },
    gotchas: ['No two-step sign-in or passkeys on free', 'Clerk branding stays on free'],
    source: 'https://clerk.com/pricing', checked: C },
  { id: 'auth0', name: 'Auth0', logo: 'auth0', need: 'auth', free: 'free', key: '25,000 monthly users',
    limits: ['25,000 monthly active users', '1 custom domain'],
    ...mau(25_000), paid: { name: 'B2C Essentials', price: 'from $35/month (500 users)' },
    gotchas: ['The first paid plan starts at only 500 users: a big jump from free'],
    source: 'https://auth0.com/pricing', checked: C },
  { id: 'better-auth', name: 'Better Auth / Auth.js', logo: 'betterauth', need: 'auth', free: 'self-host', key: 'Free, no user cap',
    limits: ['Free and open source (MIT)', 'Runs inside your app, on your database', 'No user limit'],
    uncapped: true, paid: { name: 'None needed', price: '$0 (optional dashboard $20/month)' },
    gotchas: ['You run and update it yourself', 'Auth.js (NextAuth) is now part of Better Auth; new projects start with Better Auth'],
    source: 'https://www.better-auth.com/pricing', checked: C },

  // --- sending email --------------------------------------------------------------------------------------------------
  { id: 'resend', name: 'Resend', logo: 'resend', need: 'email', free: 'free', key: '3,000 emails a month',
    limits: ['3,000 emails a month', '100 emails a day', '3 domains'],
    ...mail(3000), paid: { name: 'Pro', price: '$20/month (50,000 emails)' },
    gotchas: ['At most 100 a day on free', 'Free can’t go over its limits'],
    source: 'https://resend.com/pricing', checked: C, connect: 'resend',
    best: 'The simplest to wire into an app, with room to start.' },
  { id: 'brevo-send', name: 'Brevo', logo: 'brevo', need: 'email', free: 'free', key: '300 emails a day',
    limits: ['300 emails a day (about 9,000 a month)', 'No card needed'],
    ...mail(9000), paid: { name: 'Starter', price: '$9/month' },
    gotchas: ['The 300 a day is shared with newsletters', '“Sent with Brevo” badge on free', 'Your account must be approved before you send'],
    source: 'https://www.brevo.com/pricing/', checked: C },
  { id: 'mailgun', name: 'Mailgun', logo: 'mailgun', need: 'email', free: 'free', key: '100 emails a day',
    limits: ['100 emails a day (about 3,000 a month)', '1 sending domain', 'Logs kept 1 day'],
    ...mail(3000), paid: { name: 'Basic', price: '$15/month (10,000 emails)' },
    gotchas: ['At most 100 a day', 'Card for the free plan: check their page'],
    source: 'https://www.mailgun.com/pricing/', checked: C },
  { id: 'ses', name: 'Amazon SES', logo: 'aws', need: 'email', free: 'credit', key: '$0.10 per 1,000 emails',
    limits: ['New AWS accounts: up to $200 of credit for 6 months', 'No lasting free allowance', '$0.10 per 1,000 emails after'],
    paid: { name: 'Pay as you go', price: '$0.10 per 1,000 emails' },
    gotchas: ['Needs an AWS account with a card', 'The old 3,000 free a month is gone', 'Harder to set up than the others'],
    source: 'https://aws.amazon.com/ses/pricing/', checked: C, connect: 'aws' },
  { id: 'postmark', name: 'Postmark', logo: 'postmark', need: 'email', free: 'free', key: '100 emails a month',
    limits: ['100 emails a month, never expires'],
    ...mail(100), paid: { name: 'Basic', price: '$15/month (10,000 emails)' },
    gotchas: ['Free is only enough for testing'],
    source: 'https://postmarkapp.com/pricing', checked: C },

  // --- newsletters ----------------------------------------------------------------------------------------------------
  { id: 'brevo-news', name: 'Brevo', logo: 'brevo', need: 'newsletter', free: 'free', key: '300 emails a day',
    limits: ['300 emails a day', 'Up to 100,000 contacts', 'Automations for 2,000 contacts'],
    ...subs(300, 'Counts subscribers one send reaches in a day: 300 emails a day.'), paid: { name: 'Starter', price: '$9/month' },
    gotchas: ['A send to more than 300 people only reaches 300 that day', '“Sent with Brevo” badge in every free email'],
    source: 'https://www.brevo.com/pricing/', checked: C,
    best: 'The most free room and the cheapest upgrade.' },
  { id: 'mailerlite', name: 'MailerLite', logo: 'mailerlite', need: 'newsletter', free: 'free', key: '250 subscribers',
    limits: ['250 subscribers', '2,500 emails a month', '3 automations', '1 website and landing page'],
    ...subs(250), paid: { name: 'Comfort', price: 'from $12/month' },
    gotchas: ['MailerLite logo in free emails', 'Free used to be 1,000 subscribers'],
    source: 'https://www.mailerlite.com/pricing', checked: C },
  { id: 'buttondown', name: 'Buttondown', logo: 'buttondown', need: 'newsletter', free: 'free', key: '100 subscribers',
    limits: ['100 subscribers', 'One send a day to the whole list', 'Send from your own domain'],
    ...subs(100), paid: { name: 'Add-ons', price: 'from $9/month each' },
    gotchas: ['Buttondown branding on free', 'Paid is pick-and-pay add-ons'],
    source: 'https://buttondown.com/pricing', checked: C },
  { id: 'listmonk', name: 'Listmonk', logo: 'listmonk', need: 'newsletter', free: 'self-host', key: 'No limits, on your server',
    limits: ['Free and open source (AGPL)', 'No subscriber or email limits', 'One program plus a Postgres database'],
    uncapped: true, paid: { name: 'None', price: '$0 (you pay for the server and sending)' },
    gotchas: ['Needs an email sender, like Amazon SES', 'You run and update it (Unit7 can do that)'],
    source: 'https://listmonk.app/', checked: C, selfHost: 'listmonk' },

  // --- payments -------------------------------------------------------------------------------------------------------
  { id: 'stripe', name: 'Stripe', logo: 'stripe', need: 'payments', free: 'per-sale', key: 'No monthly fee',
    limits: ['No setup or monthly fee', '2.9% + 30¢ per US card payment', 'Subscriptions add 0.7% (Stripe Billing)'],
    uncapped: true, paid: { name: 'Per sale', price: '2.9% + 30¢' },
    gotchas: ['Sales tax and VAT are yours to handle', 'Rates differ by country'],
    source: 'https://stripe.com/pricing', checked: C, connect: 'stripe',
    best: 'No monthly fee: you pay only when you sell.' },
  { id: 'lemonsqueezy', name: 'Lemon Squeezy', logo: 'lemonsqueezy', need: 'payments', free: 'per-sale', key: '5% + 50¢ per sale',
    limits: ['No monthly fee', 'Handles sales tax and VAT for you (merchant of record)'],
    uncapped: true, paid: { name: 'Per sale', price: '5% + 50¢' },
    gotchas: ['Small extra fees for some international, PayPal and subscription payments'],
    source: 'https://www.lemonsqueezy.com/pricing', checked: C },

  // --- domains (a .com: first year and renewal) ------------------------------------------------------------------------
  { id: 'cf-registrar', name: 'Cloudflare Registrar', logo: 'cloudflare', need: 'domains', free: 'none', key: '.com at cost, same every year',
    price: { firstYear: '$10.46', renewal: '$10.46' },
    limits: ['Sold at cost, no markup', 'Free privacy', 'New domains and transfers'],
    paid: { name: '.com, a year', price: 'about $10.46' },
    gotchas: ['Must use Cloudflare for DNS', 'Their page shows no price: “at cost” is the wholesale price plus a $0.20 fee', 'The .com price rises a little on Nov 1, 2026'],
    source: 'https://www.cloudflare.com/products/registrar/', checked: C, connect: 'cloudflare',
    best: 'No markup and no renewal trap.' },
  { id: 'porkbun', name: 'Porkbun', logo: 'porkbun', need: 'domains', free: 'none', key: '.com $11.08, same every year',
    price: { firstYear: '$11.08', renewal: '$11.08' },
    limits: ['Same price to buy, renew and transfer', 'Free privacy'],
    paid: { name: '.com, a year', price: '$11.08' },
    gotchas: ['May rise after the Nov 1, 2026 .com price change'],
    source: 'https://porkbun.com/products/domains', checked: C, connect: 'porkbun' },
  { id: 'spaceship', name: 'Spaceship', logo: 'spaceship', need: 'domains', free: 'none', key: '$8.88 first year, $9.98 after',
    price: { firstYear: '$8.88', renewal: '$9.98' },
    limits: ['Free privacy', 'Plus a $0.20 fee each year'],
    paid: { name: '.com, a year', price: '$8.88, then $9.98' },
    gotchas: ['Small bump at renewal'],
    source: 'https://www.spaceship.com/domains/gtld/com/', checked: C },
  { id: 'namecheap', name: 'Namecheap', logo: 'namecheap', need: 'domains', free: 'none', key: '$10.98 first year, $18.48 after',
    price: { firstYear: '$10.98', renewal: '$18.48' },
    limits: ['Free privacy', 'Plus a $0.20 fee each year'],
    paid: { name: '.com, a year', price: '$10.98, then $18.48' },
    gotchas: ['Renewal trap: $18.48 a year from year two'],
    source: 'https://www.namecheap.com/domains/registration/gtld/com/', checked: C },
  { id: 'hostinger-domains', name: 'Hostinger', logo: 'hostinger', need: 'domains', free: 'none', key: '$0.01 first year, $19.99 after',
    price: { firstYear: '$0.01', renewal: '$19.99' },
    limits: ['Free privacy', 'A free .com for a year with yearly web hosting'],
    paid: { name: '.com, a year', price: '$0.01, then $19.99' },
    gotchas: ['Big renewal trap: $0.01, then $19.99 a year', 'The free domain with hosting is for the first year only'],
    source: 'https://www.hostinger.com/tld/com-domain', checked: C, connect: 'hostinger' },

  // --- DNS & protection -----------------------------------------------------------------------------------------------
  { id: 'cloudflare', name: 'Cloudflare', logo: 'cloudflare', need: 'dns', free: 'free', key: 'DNS, HTTPS and attack protection',
    limits: ['DNS', 'Worldwide cache (CDN)', 'Free HTTPS certificate', 'Unmetered attack (DDoS) protection', '70 rules'],
    uncapped: true, paid: { name: 'Pro', price: '$20/month billed yearly' },
    gotchas: ['Help from forums and docs only', 'Bandwidth limit: not stated, check their page'],
    source: 'https://www.cloudflare.com/plans/network-cdn/', checked: C, connect: 'cloudflare',
    best: 'Everything a domain needs, free, and Unit7 drives it for you.' },

  // --- servers --------------------------------------------------------------------------------------------------------
  { id: 'oracle', name: 'Oracle Cloud Always Free', logo: 'oracle', need: 'vps', free: 'free', key: 'Arm server: 2 CPUs, 12 GB',
    limits: ['Arm server: 2 CPUs, 12 GB memory', '200 GB disk', '10 TB traffic a month'],
    ...ram(12), paid: { name: 'Pay as you go', price: 'only above the free amounts' },
    gotchas: ['Card needed to sign up', 'Idle servers are taken back after 7 days', '“Out of capacity” is common; retry or another zone', 'Half of what it used to be'],
    source: 'https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm', checked: C },
  { id: 'gce-micro', name: 'Google Cloud e2-micro', logo: 'gcp', need: 'vps', free: 'free', key: 'One tiny server, US only',
    limits: ['One e2-micro server', 'Only in Oregon, Iowa or South Carolina', '30 GB disk', '1 GB data out a month'],
    paid: { name: 'Pay as you go', price: 'check their page' },
    gotchas: ['Card (billing account) needed', 'Only 1 GB of free traffic out a month', 'Memory: check their page'],
    source: 'https://docs.cloud.google.com/free/docs/free-cloud-features', checked: C, connect: 'gcp' },
  { id: 'hetzner', name: 'Hetzner', logo: 'hetzner', need: 'vps', free: 'none', key: '2 CPUs, 4 GB for €5.49',
    limits: ['CX23: 2 CPUs, 4 GB memory, 40 GB disk', '20 TB traffic', 'Germany and Finland'],
    ...ram(4), paid: { name: 'CX23', price: '€5.49/month (+€0.50 for IPv4)' },
    gotchas: ['Prices went up twice in 2026', 'US servers cost much more (from €17.49)', 'Prices are before VAT'],
    source: 'https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/', checked: C, connect: 'hetzner',
    best: 'The most server for the money, and Unit7 sets it up.' },
  { id: 'hostinger-vps', name: 'Hostinger VPS', logo: 'hostinger', need: 'vps', free: 'none', key: '4 GB for $6.49 (2-year term)',
    limits: ['KVM 1: 1 CPU, 4 GB memory, 50 GB disk', '4 TB bandwidth'],
    ...ram(4), paid: { name: 'KVM 1', price: '$6.49/month, 2 years upfront' },
    gotchas: ['Renews at $11.99/month', 'The low price needs 24 months paid upfront'],
    source: 'https://www.hostinger.com/vps-hosting', checked: C, connect: 'hostinger' },
  { id: 'digitalocean', name: 'DigitalOcean', logo: 'digitalocean', need: 'vps', free: 'credit', key: '$4/month, 512 MB',
    limits: ['1 CPU, 512 MB memory, 10 GB disk', '500 GB transfer', '$5 sign-up credit for 90 days'],
    ...ram(0.5), paid: { name: 'Basic Droplet', price: '$4/month' },
    gotchas: ['512 MB is very small', 'Card needed before you create a server'],
    source: 'https://www.digitalocean.com/pricing/droplets', checked: C, connect: 'digitalocean' },
  { id: 'vultr', name: 'Vultr', logo: 'vultr', need: 'vps', free: 'none', key: '$2.50/month, 512 MB',
    limits: ['1 CPU, 512 MB memory, 10 GB disk', '0.5 TB bandwidth'],
    ...ram(0.5), paid: { name: 'Regular, IPv6 only', price: '$2.50/month ($3.50 with IPv4)' },
    gotchas: ['No IPv4 on the $2.50 plan, so many visitors can’t reach it', 'Older CPUs'],
    source: 'https://www.vultr.com/products/regular-performance-compute/', checked: C },

  // --- file storage ---------------------------------------------------------------------------------------------------
  { id: 'r2', name: 'Cloudflare R2', logo: 'cloudflare', need: 'storage', free: 'free', key: '10 GB, free downloads',
    limits: ['10 GB storage a month', '1 million uploads a month', '10 million reads a month', 'Downloads are always free'],
    ...files(10), paid: { name: 'Pay as you go', price: '$0.015 per GB a month' },
    gotchas: ['Needs a card to turn on, even to stay free', 'Charged automatically above the free amounts'],
    source: 'https://developers.cloudflare.com/r2/pricing/', checked: C, connect: 'cloudflare',
    best: 'Downloads never cost anything.' },
  { id: 'backblaze', name: 'Backblaze B2', logo: 'backblaze', need: 'storage', free: 'free', key: 'First 10 GB free',
    limits: ['First 10 GB always free', 'Free downloads up to 3× what you store'],
    ...files(10), paid: { name: 'Pay as you go', price: '$6.95 per TB a month' },
    gotchas: ['Downloads above 3× your storage cost $0.01 per GB'],
    source: 'https://www.backblaze.com/cloud-storage/pricing', checked: C },
  { id: 'supabase-storage', name: 'Supabase Storage', logo: 'supabase', need: 'storage', free: 'free', key: '1 GB files',
    limits: ['1 GB file storage', '5 GB downloads a month', '50 MB per file'],
    ...files(1), paid: { name: 'Pro', price: '$25/month (100 GB)' },
    gotchas: ['Pauses with the project after 1 week idle'],
    source: 'https://supabase.com/pricing', checked: C, connect: 'supabase' },

  // --- analytics ------------------------------------------------------------------------------------------------------
  { id: 'cf-analytics', name: 'Cloudflare Web Analytics', logo: 'cloudflare', need: 'analytics', free: 'free', key: 'Free, no visitor cap',
    limits: ['Free', 'About 10 sites per account', 'Last 6 months of data'],
    uncapped: true, paid: { name: 'None', price: 'Free on every plan' },
    gotchas: ['Basic visitor stats only: no events or funnels', 'Older than 7 days is sampled'],
    source: 'https://developers.cloudflare.com/web-analytics/faq/', checked: C, connect: 'cloudflare',
    best: 'Free with no visitor cap; one line to add.' },
  { id: 'umami', name: 'Umami', logo: 'umami', need: 'analytics', free: 'free', key: '100,000 events a month',
    limits: ['Cloud: 100,000 events a month, 1 site', 'Data kept 6 months on free', 'Free forever on your own server'],
    ...events(100_000), paid: { name: 'Pro', price: '$20/month (1 million events)' },
    gotchas: ['Free cloud covers 1 website'],
    source: 'https://umami.is/pricing', checked: C, selfHost: 'umami' },
  { id: 'posthog', name: 'PostHog', logo: 'posthog', need: 'analytics', free: 'free', key: '1 million events a month',
    limits: ['1 million events a month', '5,000 session recordings', '1 million feature-flag checks', '1 project'],
    ...events(1_000_000), paid: { name: 'Pay as you go', price: '$0.00005 per event after 1 million' },
    gotchas: ['Stops at the limits unless you add a card'],
    source: 'https://posthog.com/pricing', checked: C },
  { id: 'plausible', name: 'Plausible', logo: 'plausible', need: 'analytics', free: 'trial', key: '30-day trial',
    limits: ['No free cloud plan', '30-day trial, no card', 'Free to run on your own server'],
    paid: { name: 'Starter', price: '$9/month (10,000 page views)' },
    gotchas: ['The cloud costs money after 30 days', 'The self-run version has fewer features'],
    source: 'https://plausible.io/#pricing', checked: C, selfHost: 'plausible' },

  // --- monitoring -----------------------------------------------------------------------------------------------------
  { id: 'sentry', name: 'Sentry', logo: 'sentry', need: 'monitoring', free: 'free', key: '5,000 errors a month',
    limits: ['5,000 errors a month', '1 person', '1 uptime check', '30 days of history'],
    paid: { name: 'Team', price: '$26/month billed yearly' },
    gotchas: ['Only one person can use free'],
    source: 'https://sentry.io/pricing/', checked: C, connect: 'sentry',
    best: 'See errors before your users tell you, and Unit7’s watcher reads them.' },
  { id: 'uptime-kuma', name: 'Uptime Kuma', logo: 'uptimekuma', need: 'monitoring', free: 'self-host', key: 'Free, on your server',
    limits: ['Open source (MIT)', 'Checks as often as every 20 seconds', 'Status pages', '90+ alert channels'],
    paid: { name: 'None', price: '$0 (you pay for the server)' },
    gotchas: ['On the same server it watches, it can’t warn you when that server dies'],
    source: 'https://github.com/louislam/uptime-kuma', checked: C, selfHost: 'uptime-kuma' },
  { id: 'betterstack', name: 'Better Stack', logo: 'betterstack', need: 'monitoring', free: 'free', key: '10 monitors, 3-minute checks',
    limits: ['10 uptime monitors', 'Checks every 3 minutes', '1 status page', 'Email, Slack and push alerts'],
    paid: { name: 'Responder', price: '$34/month ($29 billed yearly)' },
    gotchas: ['Text and phone alerts on free: check their page'],
    source: 'https://betterstack.com/pricing', checked: C },

  // --- AI -------------------------------------------------------------------------------------------------------------
  { id: 'gemini', name: 'Google Gemini API', logo: 'gemini', need: 'ai', free: 'free', key: 'Free Flash models, daily caps',
    limits: ['Free on the Flash models', 'Limits per minute and per day: check their page', 'Daily limit resets at midnight Pacific'],
    paid: { name: 'Pay as you go', price: 'per use, by the million tokens' },
    gotchas: ['Free prompts may be used to improve Google’s products (not in the EU, UK or Switzerland)', 'Don’t send private data on free', 'Free caps are low and have been cut before'],
    source: 'https://ai.google.dev/gemini-api/docs/pricing', checked: C, connect: 'google',
    best: 'The biggest free tier among the big AI models.' },
];

export const plan = (id: string) => PLANS.find((p) => p.id === id);
// needs where "how many users" makes sense (errors, payments, DNS and domains aren't counted in users)
export const perUser = (n: Need) => !['monitoring', 'payments', 'dns', 'domains'].includes(n);
export const plansFor = (need: Need) => PLANS.filter((p) => p.need === need).sort((a, b) => Number(!!b.best) - Number(!!a.best));

// --- what are you building? ------------------------------------------------------------------------------------------
export type Goal = 'website' | 'app' | 'saas' | 'newsletter' | 'ai';
export interface Pick { need: Need; plan: string; why: string }
export const GOALS: { id: Goal; label: string; picks: Pick[] }[] = [
  { id: 'website', label: 'A website', picks: [
    { need: 'hosting', plan: 'cloudflare-pages', why: 'Unlimited visits to a static site.' },
    { need: 'dns', plan: 'cloudflare', why: 'Free HTTPS and protection in front of it.' },
    { need: 'domains', plan: 'cf-registrar', why: 'Your .com at cost: the only thing you pay.' },
    { need: 'analytics', plan: 'cf-analytics', why: 'Visitor stats with no cap.' },
  ] },
  { id: 'app', label: 'An app with sign-in and a database', picks: [
    { need: 'hosting', plan: 'vercel', why: 'Smoothest for Next.js. Free while it’s a personal project.' },
    { need: 'database', plan: 'supabase', why: 'Database, sign-in and files in one free project.' },
    { need: 'auth', plan: 'supabase-auth', why: '50,000 signed-in users a month, built in.' },
    { need: 'email', plan: 'resend', why: 'Sign-up and password reset emails.' },
    { need: 'domains', plan: 'cf-registrar', why: 'Your .com at cost.' },
  ] },
  { id: 'saas', label: 'A SaaS with payments', picks: [
    { need: 'hosting', plan: 'cloudflare-pages', why: 'No “personal use only” rule (Vercel’s free plan has one).' },
    { need: 'database', plan: 'supabase', why: 'Database, sign-in and files in one free project.' },
    { need: 'auth', plan: 'supabase-auth', why: '50,000 signed-in users a month, built in.' },
    { need: 'payments', plan: 'stripe', why: 'No monthly fee: 2.9% + 30¢ a sale.' },
    { need: 'email', plan: 'resend', why: 'Receipts, sign-up and reset emails.' },
    { need: 'monitoring', plan: 'sentry', why: 'See errors before your customers do.' },
    { need: 'domains', plan: 'cf-registrar', why: 'Your .com at cost.' },
  ] },
  { id: 'newsletter', label: 'A newsletter', picks: [
    { need: 'newsletter', plan: 'brevo-news', why: 'Up to 100,000 contacts, 300 emails a day.' },
    { need: 'hosting', plan: 'cloudflare-pages', why: 'A free home for the archive and sign-up page.' },
    { need: 'domains', plan: 'cf-registrar', why: 'Send from your own domain: fewer emails land in spam.' },
  ] },
  { id: 'ai', label: 'An AI app', picks: [
    { need: 'ai', plan: 'gemini', why: 'Free Flash models to start with.' },
    { need: 'hosting', plan: 'vercel', why: 'Streams AI answers smoothly. Free while it’s personal.' },
    { need: 'database', plan: 'supabase', why: 'Saves chats; vector search built in (pgvector).' },
    { need: 'auth', plan: 'supabase-auth', why: '50,000 signed-in users a month, built in.' },
  ] },
];

// How far a stack goes for $0: the lowest "fits" among its picks is where you'd start paying, and that pick is what to
// upgrade first. Picks whose limit can't be counted (no number on their page) are listed, not guessed. A domain is the
// one thing that's never free: its first-year price is said separately.
export interface StackSummary {
  users: number | null;        // $0/month until about this many users (null: nothing in it has a counted limit)
  first: Plan | null;          // the one to upgrade first
  uncounted: Plan[];           // limits we can't turn into users ("check their page")
  perSale: Plan[];             // free to start, a cut of each sale
  domain: Plan | null;         // a yearly cost on top
}
export function summarize(ids: string[]): StackSummary {
  const ps = ids.map(plan).filter((p): p is Plan => !!p);
  let first: Plan | null = null;
  for (const p of ps) if (p.fits !== undefined && (!first || p.fits < first.fits!)) first = p;
  return {
    users: first?.fits ?? null, first,
    uncounted: ps.filter((p) => p.fits === undefined && !p.uncapped && perUser(p.need)),
    perSale: ps.filter((p) => p.free === 'per-sale'),
    domain: ps.find((p) => p.need === 'domains') ?? null,
  };
}

export function recommend(goal: Goal): { goal: Goal; picks: Pick[] } & StackSummary {
  const g = GOALS.find((x) => x.id === goal) ?? GOALS[0]!;
  return { goal: g.id, picks: g.picks, ...summarize(g.picks.map((p) => p.plan)) };
}

// a pick in or out of a stack: one per need (picking another in the same need swaps it), picking it again takes it out
export function toggle(stack: Pick[], p: Plan): Pick[] {
  if (stack.some((x) => x.plan === p.id)) return stack.filter((x) => x.plan !== p.id);
  const pick = { need: p.need, plan: p.id, why: p.best ?? p.key };
  const at = stack.findIndex((x) => x.need === p.need);
  return at < 0 ? [...stack, pick] : stack.map((x, i) => (i === at ? pick : x));
}
