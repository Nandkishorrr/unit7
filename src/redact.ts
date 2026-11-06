// Secrets never reach logs, the UI, audit rows, events or the model. A Redactor knows the exact
// values resolved during one execution (the strongest guarantee) and also catches well-known
// secret shapes it was never told about (keys pasted into a log line, a DSN with a password).

const SHAPES: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, 'private key'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, 'api key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 'github token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, 'gitlab token'],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 'stripe key'],
  [/\bwhsec_[A-Za-z0-9]{20,}\b/g, 'webhook secret'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws key'],
  [/\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g, 'slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'google key'],
  [/\b(?:unit7|forge)_pat_[A-Za-z0-9_-]{20,}\b/g, 'unit7 token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt'],
  // the providers Unit7 itself connects to
  [/\bsbp_[A-Za-z0-9]{30,}\b/g, 'supabase token'],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}/g, 'supabase key'],
  [/\brnd_[A-Za-z0-9]{20,}\b/g, 'render key'],
  [/\bdop_v1_[a-f0-9]{40,}\b/g, 'digitalocean token'],
  [/\bFlyV1 [A-Za-z0-9_,+/=-]{20,}/g, 'fly token'],
  [/\bfm[12][ar]?_[A-Za-z0-9_+/=-]{20,}/g, 'fly token'],
  [/\bfo1_[A-Za-z0-9_-]{20,}\b/g, 'fly token'],
  [/\bHRKU-[A-Za-z0-9_-]{20,}\b/g, 'heroku key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, 'npm token'],
  [/\bnfp_[A-Za-z0-9]{30,}\b/g, 'netlify token'],
  [/\bnapi_[A-Za-z0-9]{40,}\b/g, 'neon key'],
  [/\btk_[a-z0-9]{29}\b/g, 'ntfy token'],
  [/\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}\b/g, 'resend key'],
  [/\bsk-or-v1-[a-f0-9]{40,}\b/g, 'openrouter key'],
  [/\bpscale_tkn_[A-Za-z0-9_-]{20,}/g, 'planetscale token'],
  [/\bpscale_pw_[A-Za-z0-9_-]{20,}/g, 'planetscale password'],
  [/\bsntry[us]_[A-Za-z0-9_-]{20,}/g, 'sentry token'],
];
// scheme://user:PASSWORD@host — keep everything but the password
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)(@)/gi;

// Env var names that hold secrets even when the value doesn't look like one.
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PASS$|PRIVATE|API_?KEY|ACCESS_?KEY|DSN|DATABASE_URL|REDIS_URL|MONGO(DB)?_URI|CREDENTIAL|AUTH|SALT|SIGNING|ENCRYPTION|JWT|COOKIE|SESSION|(^|_)KEY$|KEY_?BASE|(^|_)PW$|(^|_)PWD$)/i;
const PUBLIC_NAME = /(PUBLISHABLE|ANON|PUBLIC_?KEY)/i; // meant to be seen (Supabase anon, Stripe publishable)
export const looksSecretName = (name: string) => SECRET_NAME.test(name) && !PUBLIC_NAME.test(name);

// A value that looks machine-made (long, no spaces, letters and digits, high entropy) is treated as a secret
// even under a plain name: APP_KEY=base64:… or a provider token Unit7 doesn't know the shape of.
export function looksRandom(raw: string): boolean {
  const v = raw.replace(/^base64:/, ''); // Laravel's APP_KEY
  if (v.length < 20 || /[\s:/]/.test(v) || !/[a-z]/.test(v) || !/[A-Z]/.test(v) || !/\d/.test(v)) return false;
  const n = new Map<string, number>();
  for (const ch of v) n.set(ch, (n.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of n.values()) bits -= (c / v.length) * Math.log2(c / v.length);
  return bits >= 3.5;
}

// Object keys whose string value is a secret whatever it looks like (a `password` in a provider call's params)
const SECRET_FIELD = /(password|passwd|secret|token|api_?key|private_?key|credential|client_?secret)/i;

export function detectSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const [re, label] of SHAPES) if (text.match(re)) found.add(label);
  if (text.match(URL_PASSWORD)) found.add('password in url');
  return [...found];
}

export class Redactor {
  private known = new Map<string, string>();

  // label is shown in place of the value, e.g. the credential:// reference it came from
  add(value: string, label = 'secret') {
    if (value && value.length >= 6) this.known.set(value, label);
  }

  redact(text: string): string {
    let out = text;
    // longest first, so a secret that contains another is replaced whole
    for (const [value, label] of [...this.known].sort((a, b) => b[0].length - a[0].length)) {
      out = out.split(value).join(`[redacted ${label}]`);
    }
    for (const [re, label] of SHAPES) out = out.replace(re, `[redacted ${label}]`);
    return out.replace(URL_PASSWORD, '$1[redacted]$3');
  }

  redactDeep<T>(value: T): T {
    if (typeof value === 'string') {
      // a row turned into text: its keys are in there, so look inside
      if (/^\s*[{[]/.test(value)) { try { return JSON.stringify(this.redactDeep(JSON.parse(value))) as T; } catch { /* only looks like JSON */ } }
      return this.redact(value) as T;
    }
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) =>
        [k, typeof v === 'string' && v.length >= 6 && SECRET_FIELD.test(k) && !v.startsWith('credential://') && !v.startsWith('[') ? '[redacted]' : this.redactDeep(v)])) as T;
    }
    return value;
  }
}

export const redact = (text: string) => new Redactor().redact(text);
