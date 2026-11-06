// Does a paste look like a key for this provider? Its own pattern when the catalog has one (sk-ant-…, ghp_…, a
// Slack webhook URL), a service-account .json for providers whose key is a file, else one long run of key characters
// (a word or two at most: Fly.io's start "FlyV1 fm2_…"), and never a plain link or a sentence.
export function looksLikeToken(text: string, o: { pattern?: string; file?: boolean } = {}): boolean {
  const t = text.trim();
  if (o.file) {
    try { const j = JSON.parse(t) as Record<string, unknown>; return !!j && typeof j === 'object' && (j.type === 'service_account' || 'private_key' in j); }
    catch { return false; }
  }
  if (o.pattern) { try { return new RegExp(o.pattern).test(t); } catch { /* a pattern the browser can't read: the shape test below */ } }
  const words = t.split(/\s+/);
  return t.length >= 16 && t.length <= 20_000 && words.length <= 2 && words.some((w) => w.length >= 16) && !/^https?:\/\//i.test(t);
}
