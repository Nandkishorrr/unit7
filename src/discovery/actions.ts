// Typed actions on what a server's X-ray found, and the classifier behind server.exec. Pure code, no I/O.
// Unit7 renders every command itself (each value single-quoted by connectors/shell.ts), so an AI never writes
// shell for routine work. A command an AI does write (server.exec, part.run) is parsed the way a shell would and
// put on a risk tier from its text alone: nothing a server prints can make a command look safer than it is.
import type { Tier } from '../policy.ts';
import { cmd, shq } from '../connectors/shell.ts';
import { Unit7Error } from '../errors.ts';
import { OWNER_NAME, type Inventory, type Owner, type Part } from './xray.ts';

// ===== the shell classifier ==============================================================================
interface Word { v: string; raw: string; glob: boolean; expand: boolean; subs: string[] }
interface Redir { redir: string; to?: Word; body?: Word }
type Tok = { w: Word } | { op: string } | Redir;

// A POSIX-sh tokenizer: quotes, escapes, $(…) and backticks (their bodies kept, to be classified too), ${…} and
// $VAR, redirections with fd numbers, here-documents, comments. Throws on what it can't read (unclosed quotes).
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [], n = src.length, pending: Redir[] = [];
  let i = 0;
  const fail = (m: string): never => { throw new Error(m); };
  const close = (j: number): number => { // just past the ) closing a ( opened before j
    let depth = 1;
    while (j < n) {
      const c = src[j]!;
      if (c === '\\') { j += 2; continue; }
      if (c === "'") { const k = src.indexOf("'", j + 1); if (k < 0) fail('a quote isn’t closed'); j = k + 1; continue; }
      if (c === '"') { j++; while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1; if (j >= n) fail('a quote isn’t closed'); j++; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j + 1;
      j++;
    }
    return fail('a bracket isn’t closed');
  };
  const dollar = (w: Word) => {
    w.expand = true;
    if (src[i] === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      if (j >= n) fail('a backtick isn’t closed');
      w.subs.push(src.slice(i + 1, j).replace(/\\`/g, '`')); w.v += src.slice(i, j + 1); i = j + 1; return;
    }
    const nx = src[i + 1];
    if (nx === '(') { const e = close(i + 2), body = src.slice(i + 2, e - 1); if (!body.startsWith('(')) w.subs.push(body); w.v += src.slice(i, e); i = e; return; }
    if (nx === '{') { const e = src.indexOf('}', i + 2); if (e < 0) fail('a ${ isn’t closed'); w.v += src.slice(i, e + 1); i = e + 1; return; }
    if (nx === "'") { let j = i + 2; while (j < n && src[j] !== "'") j += src[j] === '\\' ? 2 : 1; if (j >= n) fail('a quote isn’t closed'); w.v += src.slice(i + 2, j); i = j + 1; return; }
    const m = /^\$([A-Za-z_]\w*|\d|[?$!#@*-])/.exec(src.slice(i));
    if (m) { w.v += m[0]; i += m[0].length; return; }
    w.expand = false; w.v += '$'; i++;
  };
  const word = (): Word => {
    const start = i, w: Word = { v: '', raw: '', glob: false, expand: false, subs: [] };
    while (i < n) {
      const c = src[i]!;
      if (' \t\r\n;&|()<>'.includes(c)) break;
      if (c === "'") { const k = src.indexOf("'", i + 1); if (k < 0) fail('a quote isn’t closed'); w.v += src.slice(i + 1, k); i = k + 1; }
      else if (c === '"') {
        i++;
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) { if (src[i + 1] !== '\n') w.v += src[i + 1]; i += 2; }
          else if (src[i] === '$' || src[i] === '`') dollar(w);
          else w.v += src[i++];
        }
        if (i >= n) fail('a quote isn’t closed');
        i++;
      } else if (c === '\\') { if (i + 1 < n && src[i + 1] !== '\n') w.v += src[i + 1]; i += 2; }
      else if (c === '$' || c === '`') dollar(w);
      else { if ('*?[{'.includes(c)) w.glob = true; w.v += c; i++; }
    }
    w.raw = src.slice(start, i);
    return w;
  };
  const heredocs = () => { // bodies of pending here-documents, line by line up to their delimiters
    for (const h of pending.splice(0)) {
      const delim = h.to?.v ?? '', strip = h.redir === '<<-', lines: string[] = [];
      for (;;) {
        if (i >= n) break;
        const e = src.indexOf('\n', i), line = src.slice(i, e < 0 ? n : e);
        i = e < 0 ? n : e + 1;
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        lines.push(line);
      }
      // an unquoted delimiter means the body is expanded like a "…" string: $(…) inside runs
      if (h.to && h.to.raw === h.to.v) { const t = tokenize(`"${lines.join('\n').replace(/"/g, '\\"')}"`)[0]; if (t && 'w' in t) h.body = t.w; }
    }
  };
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '\n') { toks.push({ op: ';' }); i++; heredocs(); continue; }
    const rest = src.slice(i);
    if (/^[<>]\(/.test(rest)) { const e = close(i + 2); toks.push({ w: { v: src.slice(i, e), raw: src.slice(i, e), glob: false, expand: true, subs: [src.slice(i + 2, e - 1)] } }); i = e; continue; }
    let m = /^\d*(&>>|&>|>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/.exec(rest);
    if (m && !rest.startsWith('&&')) {
      i += m[0].length;
      while (src[i] === ' ' || src[i] === '\t') i++;
      const r: Redir = { redir: m[1]!, ...(i < n && !'\n;&|()<>'.includes(src[i]!) && { to: word() }) };
      if (r.redir === '<<' || r.redir === '<<-') pending.push(r);
      toks.push(r);
      continue;
    }
    m = /^(&&|\|\||;;|\|&|[|&;()])/.exec(rest);
    if (m) { toks.push({ op: m[1] === '|&' ? '|' : m[1] === ';;' ? ';' : m[1]! }); i += m[1]!.length; continue; }
    toks.push({ w: word() });
  }
  heredocs();
  return toks;
}

interface Simple { words: Word[]; redirs: Redir[] }
const RESERVED = new Set(['{', '}', '!', 'time', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function']);
const FLOW = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function']);
// pipelines of simple commands; ( and ) only group, so they're dropped
function parse(toks: Tok[]) {
  const pipes: Simple[][] = [];
  let pipe: Simple[] = [], cur: Simple = { words: [], redirs: [] }, bg = false, flow = false;
  const endCmd = () => { if (cur.words.length || cur.redirs.length) pipe.push(cur); cur = { words: [], redirs: [] }; };
  const endPipe = () => { endCmd(); if (pipe.length) pipes.push(pipe); pipe = []; };
  for (const t of toks) {
    if ('op' in t) { if (t.op === '|') endCmd(); else if (t.op !== '(' && t.op !== ')') { if (t.op === '&') bg = true; endPipe(); } continue; }
    if ('redir' in t) { cur.redirs.push(t); continue; }
    if (!cur.words.length && t.w.raw === t.w.v && RESERVED.has(t.w.v)) { if (FLOW.has(t.w.v)) flow = true; continue; }
    cur.words.push(t.w);
  }
  endPipe();
  return { pipes, bg, flow };
}

interface Res { tier: Tier; why: string }
const R = (tier: Tier, why: string): Res => ({ tier, why });
const READS = R(0, 'only reads');
const worst = (a: Res, b: Res) => (b.tier > a.tier ? b : a);

// Files whose contents are secrets, and places an AI may never write to
// Secret by name, and by place. The folders where a container engine or a panel keeps every container's settings in the clear (Docker's
// and containerd's own, a named volume's data apart), Unit7's copies, and what a process's folder under /proc leads to.
export const SECRET_FILE = /(^|\/)(\.env(\.(?!(example|sample|template|dist|defaults?)$)[\w.-]+)?|\.envrc|id_(rsa|dsa|ecdsa|ed25519)|ssh_host_\w+_key|[^/]+\.(key|p12|pfx|jks|keystore|kdbx|pem)|\.pgpass|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.my\.cnf|debian\.cnf|\.s3cfg|\.(bash|zsh|sh|mysql|psql)_history|wp-config\.php(\.[\w-]+)?|master\.key|credentials(\.json)?|secrets?\.(ya?ml|json|env|txt))$|^\/etc\/(shadow|gshadow|sudoers)|\/proc\/.*\/environ$|^\/proc\/[^/]+\/(root|cwd|fd)\/|^\/(data\/coolify|etc\/dokploy|etc\/kubernetes|captain|home\/dokku|var\/snap\/docker|var\/lib\/(containerd|containers|kubelet|rancher|lxc|lxd|unit7)|var\/backups\/unit7|(var\/)?run\/(containerd|containers|docker|podman|k3s))\/|^\/var\/lib\/docker\/(?!volumes(\/|$))|(^|\/)\.(aws|docker|kube|gnupg)\/|(^|\/)\.ssh\/(?!known_hosts$|authorized_keys$|[^/]*\.pub$)|(^|\/)(secrets?|private)\//i;
export const PROTECTED = /(^|\/)(sshd_config(\.d\/.*)?|authorized_keys2?)$|^\/etc\/(sudoers|passwd|shadow|group|gshadow|pam\.d\/)|^\/etc\/ssh\/|^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|md|dm-|mapper\/|disk\/|loop)|^\/boot\//;
const protectedWhy = (p: string) => (/^\/dev\//.test(p) ? 'would overwrite a disk' : 'changes who can sign in to the server');
const TRASH = /^\/var\/(lib\/unit7\/trash|backups\/unit7\/trash)\//;
const SAFE_ENV = /^(LC_\w+|LANG|LANGUAGE|TZ|COLUMNS|LINES|NO_COLOR|TERM|SYSTEMD_COLORS|SYSTEMD_PAGER|DOCKER_CLI_HINTS)$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'busybox']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'perl', 'ruby', 'node', 'nodejs', 'php', 'lua', 'deno', 'bun', 'java', 'go', 'Rscript', 'tclsh', 'osascript']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'aria2c', 'http', 'https', 'lynx']);
const base = (p: string) => p.split('/').pop() ?? p;

type Rule = (a: string[], ws: Word[]) => Res;
const NONE = new Set<string>();
// the arguments that aren't flags (skipping the values of flags that take one)
const pos = (a: string[], valued: Set<string> = NONE) => {
  const out: string[] = [];
  for (let k = 0; k < a.length; k++) {
    const x = a[k]!;
    if (x === '--') { out.push(...a.slice(k + 1)); break; }
    if (x.startsWith('-') && x !== '-') { if (valued.has(x)) k++; continue; }
    out.push(x);
  }
  return out;
};
const has = (a: string[], re: RegExp) => a.some((x) => re.test(x));
const T0: Rule = () => READS;
// a program that prints files: never secret ones, never ones picked by a pattern (that could match a secret)
const prints = (o: { pattern?: boolean } = {}): Rule => (a, ws) => {
  let files = ws.slice(1).filter((w) => !w.v.startsWith('-') || w.v === '-');
  if (o.pattern && !has(a, /^(-[a-zA-Z]*[ef]|--(regexp|file))/)) files = files.slice(1);
  if (files.some((w) => SECRET_FILE.test(w.v))) return R(4, 'would show secret values');
  if (files.some((w) => w.glob)) return R(2, 'reads files picked by a pattern, which could include secret ones');
  return READS;
};
// a program with sub-commands: these read; the ones named in t4 are never for an AI; t3 ones are hard to undo
const sub = (read: string[], o: { valued?: string[]; t4?: Record<string, string>; t3?: string[]; why3?: string; why2?: string } = {}): Rule => (a) => {
  const p = pos(a.slice(1), new Set(o.valued));
  const s = p[0] ?? '';
  if (o.t4?.[s]) return R(4, o.t4[s]!);
  if (!s || read.includes(s)) return READS;
  if (o.t3?.includes(s) || (o.t3 && !o.t3.length)) return R(3, o.why3 ?? `${base(a[0]!)} ${s} is hard to undo`);
  return R(2, o.why2 ?? `${base(a[0]!)} ${s} changes something`);
};
const PKG = (read: string[]) => sub(read, { t3: [], why3: 'installs, removes or upgrades software' });
const LOGIN = R(3, 'changes who can sign in');
const DB_CLIENT: Rule = (a) => (/\bdrop\s+(database|schema)\b|\bflushall\b|\bdropDatabase\b/i.test(a.join(' ')) ? R(4, 'drops a database') : has(a, /^(--version|-V)$/) && a.length === 2 ? READS : R(3, 'can change data in a database'));
const FIREWALL_OR_SSH = /^(ufw|firewalld|nftables|iptables|ip6tables|netfilter-persistent|ssh|sshd)(\.(service|socket))?$/;

const RULES: Record<string, Rule> = {
  ...Object.fromEntries(['ls', 'pwd', 'whoami', 'id', 'uname', 'uptime', 'df', 'du', 'free', 'ps', 'w', 'who', 'last', 'lastlog', 'lsblk', 'lscpu', 'lsmem', 'nproc',
    'ss', 'netstat', 'stat', 'file', 'wc', 'tree', 'which', 'whereis', 'realpath', 'readlink', 'basename', 'dirname', 'true', 'false', 'test', '[', 'md5sum', 'sha1sum',
    'sha256sum', 'sha512sum', 'cksum', 'lsof', 'vmstat', 'iostat', 'mpstat', 'pidstat', 'findmnt', 'lsmod', 'lspci', 'lsusb', 'getconf', 'arch', 'tty', 'locale', 'pgrep',
    'pstree', 'cd', 'sleep', 'type', 'nslookup', 'dig', 'host', 'ping', 'traceroute', 'tracepath', 'column', 'cut', 'tr', 'comm', 'cmp', 'seq', 'pg_isready', 'iptables-save',
    'ip6tables-save', 'dpkg-query', 'apt-cache'].map((p) => [p, T0])),
  // harmless alone, but not on the read-only list: they're how text gets into files and other programs
  echo: () => R(2, 'isn’t on Unit7’s read-only list'), printf: () => R(2, 'isn’t on Unit7’s read-only list'),
  ...Object.fromEntries(['cat', 'tac', 'nl', 'head', 'tail', 'zcat', 'strings', 'od', 'hexdump', 'diff', 'jq', 'base64'].map((p) => [p, prints()])),
  sort: (a, ws) => (has(a, /^(-o|--output)/) ? (a.some((w) => PROTECTED.test(w.replace(/^(-o|--output=?)/, ''))) ? R(4, 'changes who can sign in to the server') : R(2, 'writes to a file')) : prints()(a, ws)),
  uniq: (a, ws) => (pos(a.slice(1)).length > 1 ? (PROTECTED.test(pos(a.slice(1))[1]) ? R(4, 'changes who can sign in to the server') : R(2, 'writes to a file')) : prints()(a, ws)),
  xxd: (a, ws) => (has(a, /^-r/) || pos(a.slice(1)).length > 1 ? (pos(a.slice(1)).slice(1).some((f) => PROTECTED.test(f)) ? R(4, 'changes who can sign in to the server') : R(2, 'writes to a file')) : prints()(a, ws)),
  ...Object.fromEntries(['grep', 'egrep', 'fgrep', 'zgrep', 'rg'].map((p) => [p, (a, ws) => (has(a, /^(-[a-zA-Z]*[rR]|--recursive|--dereference-recursive|-d)/) || p === 'rg'
    ? R(2, 'searches whole folders, which can include secret files') : prints({ pattern: true })(a, ws))])),
  sed: (a, ws) => {
    if (has(a, /^(-[a-zA-Z]*i|--in-place)/)) return pos(a.slice(1)).some((f) => PROTECTED.test(f)) ? R(4, 'changes who can sign in to the server') : R(2, 'edits a file');
    const p = pos(a.slice(1), new Set(['-e', '--expression', '-f', '--file']));
    const e = a.indexOf('-e'), script = (e > 0 ? a[e + 1] : p[0]) ?? '';
    if (has(a, /^(-f|--file)/) || !/^((\d+|\$)(,(\d+|\$))?|\/[^/]*\/)p$/.test(script)) return R(2, 'runs a sed script, which can write files');
    return prints()(a, ws.filter((w) => w.v !== script));
  },
  ...Object.fromEntries(['awk', 'gawk', 'mawk'].map((p) => [p, (a, ws) => {
    const prog = pos(a.slice(1), new Set(['-F', '-v']))[0] ?? '';
    return has(a, /^(-f|--file)/) || /system|getline|[|>]|close|fflush/.test(prog) ? R(2, 'runs an awk program that can write files or run commands') : prints()(a, ws.filter((w) => w.v !== prog));
  }])),
  find: (a, ws) => {
    if (has(a, /^-delete$/)) return pos(a.slice(1)).some((p) => p === '/' || p === '/*') ? R(4, 'deletes folders for good') : R(3, 'deletes files');
    if (has(a, /^-(exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/)) return R(2, 'runs a command or writes a file for what it finds');
    return ws.some((w) => w.glob) ? R(2, 'uses a pattern the shell expands first') : READS;
  },
  journalctl: (a) => (has(a, /^--(vacuum|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)/) ? R(2, 'changes or removes logs') : READS),
  dmesg: (a) => (has(a, /^(-[a-zA-Z]*[cCDEn]|--(clear|read-clear|console))/) ? R(2, 'changes the kernel log') : READS),
  systemctl: (a) => {
    if (has(a, /^(-H|--host|-M|--machine)/)) return R(2, 'reaches another machine');
    const p = pos(a.slice(1), new Set(['-p', '--property', '-t', '--type', '--state', '-n', '--lines', '-o', '--output']));
    const s = p[0] ?? '';
    if (s === 'show-environment') return R(4, 'would show secret values');
    if (!s || ['status', 'show', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'list-jobs', 'list-machines', 'is-active', 'is-enabled',
      'is-failed', 'is-system-running', 'cat', 'help', 'get-default'].includes(s)) return READS;
    if (['stop', 'disable', 'mask', 'kill'].includes(s) && p.slice(1).some((u) => FIREWALL_OR_SSH.test(u))) return R(4, 'turns off the firewall or SSH');
    if (['reboot', 'poweroff', 'halt', 'kexec', 'rescue', 'emergency', 'suspend', 'hibernate', 'soft-reboot'].includes(s)) return R(3, 'restarts or turns off the server');
    return R(2, 'changes a service');
  },
  service: (a) => {
    const [, unit = '', s = ''] = a;
    if (unit === '--status-all' || s === 'status' || !s) return READS;
    return ['stop', 'disable'].includes(s) && FIREWALL_OR_SSH.test(unit) ? R(4, 'turns off the firewall or SSH') : R(2, 'changes a service');
  },
  docker: (a) => {
    if (has(a, /^(-H|--host|-c|--context|--config)(=|$)/)) return R(2, 'reaches another Docker');
    const p = pos(a.slice(1), new Set(['-l', '--log-level', '-p', '--project-name', '-f', '--file', '--project-directory', '--env-file', '--profile', '--ansi', '--progress', '--format', '-n', '--tail', '--since', '--until', '--filter']));
    const [s = '', t = ''] = p, two = `${s} ${t}`;
    if (s === 'inspect' || two === 'container inspect') return R(2, 'prints settings, values included');
    if (!s || ['ps', 'logs', 'stats', 'images', 'version', 'info', 'top', 'port', 'diff', 'history', 'events', 'search'].includes(s)) return READS;
    if (['system df', 'system info', 'system events', 'volume ls', 'volume list', 'volume inspect', 'network ls', 'network list', 'network inspect', 'image ls', 'image list',
      'image inspect', 'image history', 'container ls', 'container list', 'container ps', 'container logs', 'container top', 'container port', 'container diff',
      'container stats', 'context ls', 'context show', 'context inspect', 'compose ps', 'compose ls', 'compose logs', 'compose images', 'compose top', 'compose version', 'compose events',
      'compose port', 'buildx ls', 'builder ls'].includes(two)) return READS;
    if (two === 'compose config') return has(a, /^(-q|--quiet|--services|--volumes|--images|--profiles|--networks|--hash)/) ? READS : R(2, 'prints settings, values included');
    if (['volume rm', 'volume prune', 'system prune', 'image prune', 'container prune', 'builder prune', 'network prune'].includes(two) || (s === 'rm' && has(a, /^(-[a-zA-Z]*v[a-zA-Z]*|--volumes)$/))) return R(3, 'deletes Docker data');
    if ((s === 'run' || two === 'container run' || two === 'container create' || s === 'create') && (has(a, /^--privileged$|^--(pid|network|net|ipc|userns|uts)(=|$)host|^host$/) || has(a, /^\/:|docker\.sock/))) return R(3, 'starts a container with power over the whole server');
    return R(2, 'changes containers');
  },
  git: (a) => {
    if (has(a, /^(--output|--ext-diff|--upload-pack|--receive-pack|--exec|-u$)/)) return has(a, /^(--upload-pack|--receive-pack|--exec)/) ? R(3, 'runs a command Unit7 can’t read') : R(2, 'writes files or runs a program');
    if (has(a, /^-c$/)) return R(2, 'changes git’s settings for this run');
    const p = pos(a.slice(1), new Set(['-C', '--git-dir', '--work-tree', '-n', '--max-count', '--format', '--pretty', '--since', '--until', '--author']));
    const [s = '', ...rest] = p;
    if (!s || ['status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'ls-files', 'ls-tree', 'ls-remote', 'blame', 'shortlog', 'cat-file', 'grep', 'whatchanged', 'rev-list',
      'name-rev', 'for-each-ref', 'show-ref', 'count-objects', 'version', 'help'].includes(s)) return READS;
    if (s === 'branch') return rest.length || has(a, /^-[a-zA-Z]*[dDmMcCfu]|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/) ? R(2, 'git branch changes branches') : READS;
    if (s === 'remote') return !rest.length || rest[0] === 'show' || rest[0] === 'get-url' ? READS : R(2, 'git remote changes where code comes from');
    if (s === 'tag') return rest.length || has(a, /^-[a-zA-Z]*[dfas]/) ? R(2, 'git tag changes tags') : READS;
    if (s === 'reflog') return !rest.length || rest[0] === 'show' ? READS : R(2, 'git reflog changes the repository');
    if (s === 'stash' || s === 'worktree') return rest[0] === 'list' || (s === 'stash' && rest[0] === 'show') ? READS : R(2, `git ${s} changes the repository`);
    if (s === 'config') return has(a, /^--(get|get-all|get-regexp|list|show-origin|show-scope)$|^-l$/) && !has(a, /^--(unset|add|replace-all|rename-section|remove-section|edit)/) ? READS : R(2, 'changes git’s settings');
    return R(2, `git ${s} changes the repository`);
  },
  pm2: sub(['list', 'ls', 'l', 'jlist', 'prettylist', 'status', 'describe', 'desc', 'info', 'show', 'id', 'logs', 'log'], { t4: { env: 'would show secret values' }, why2: 'changes PM2 apps' }),
  nginx: (a) => (a.slice(1).every((x) => /^-(t|T|v|V|q)$/.test(x)) ? READS : R(2, 'reloads or changes the web server')),
  caddy: sub(['version', 'validate', 'adapt', 'list-modules', 'build-info', 'help'], { t4: { environ: 'would show secret values' }, why2: 'changes the web server' }),
  crontab: (a) => (has(a, /^-r$/) ? R(3, 'deletes scheduled jobs') : a.slice(1).every((x, k, r) => x === '-l' || x === '-u' || r[k - 1] === '-u') && has(a, /^-l$/) ? READS : R(2, 'changes scheduled jobs')),
  ufw: sub(['status', 'show', 'version', 'app'], { t4: { disable: 'turns off the firewall', reset: 'turns off the firewall' }, t3: [], why3: 'changes the firewall' }),
  ...Object.fromEntries(['iptables', 'ip6tables', 'iptables-legacy', 'iptables-nft'].map((p) => [p, (a) => {
    if (has(a, /^(-F|--flush|-X|--delete-chain)$/) || (has(a, /^(-P|--policy)$/) && has(a, /^ACCEPT$/))) return R(4, 'turns off the firewall');
    if (has(a, /^(-[a-zA-Z]*[AIDRNEZP][a-zA-Z]*|--(append|insert|delete|replace|new-chain|rename-chain|zero|policy))$/)) return R(3, 'changes the firewall');
    return has(a, /^(-[a-zA-Z]*[LS][a-zA-Z]*|--list|--list-rules)$/) ? READS : R(3, 'changes the firewall');
  }])),
  nft: (a) => (/^flush ruleset/.test(a.slice(1).join(' ')) ? R(4, 'turns off the firewall') : a[1] === 'list' ? READS : R(3, 'changes the firewall')),
  ip: (a) => { const [obj = '', verb = ''] = pos(a.slice(1)); return ['', 'show', 'list', 'ls', 'get'].includes(verb) && /^(a|addr|address|r|route|l|link|n|neigh|neighbor|neighbour|rule|maddr|)$/.test(obj) ? READS : R(3, 'changes the network, which can cut the server off'); },
  sysctl: (a) => (has(a, /^(-w|-p|--load|--system|--write)|=/) ? R(3, 'changes kernel settings') : READS),
  mount: (a) => (pos(a.slice(1), new Set(['-t'])).length ? R(3, 'mounts a disk') : READS),
  getent: (a) => (/^g?shadow$/.test(a[1] ?? '') ? R(4, 'would show secret values') : READS),
  hostname: (a) => (pos(a.slice(1)).length ? R(3, 'renames the server') : READS),
  date: (a) => (has(a, /^(-s|--set)/) ? R(3, 'changes the server’s clock') : READS),
  timedatectl: sub(['status', 'show', 'list-timezones', 'timesync-status', 'show-timesync'], { t3: [], why3: 'changes the server’s clock' }),
  hostnamectl: sub(['status'], { t3: [], why3: 'renames the server' }),
  apt: PKG(['list', 'show', 'search', 'policy', 'depends', 'rdepends', 'showsrc', 'madison', 'changelog']),
  'apt-get': (a) => (has(a, /^(-s|--simulate|--dry-run|--just-print|--no-act|--recon)$/) || a[1] === 'changelog' ? READS : R(3, 'installs, removes or upgrades software')),
  dpkg: (a) => (a.slice(1).every((x) => /^(-l|--list|-L|--listfiles|-s|--status|-S|--search|-p|--print-avail|--get-selections|--print-architecture|--print-foreign-architectures|-C|--audit|--version)$/.test(x) || !x.startsWith('-')) && a.length > 1 ? READS : R(3, 'installs or removes software')),
  rpm: (a) => (has(a, /^(-q|--query)/) && !has(a, /^(-e|--erase|-i|--install|-U|--upgrade)/) ? READS : R(3, 'installs or removes software')),
  yum: PKG(['list', 'info', 'search', 'check-update', 'repolist', 'provides', 'deplist']), dnf: PKG(['list', 'info', 'search', 'check-update', 'repolist', 'provides', 'deplist']),
  apk: PKG(['info', 'list', 'search', 'policy', 'version', 'stats', 'dot']), snap: PKG(['list', 'info', 'version', 'find', 'services', 'connections', 'changes', 'tasks', 'warnings']),
  pip: PKG(['list', 'show', 'freeze', 'check', 'help']), pip3: PKG(['list', 'show', 'freeze', 'check', 'help']), gem: PKG(['list', 'info', 'search', 'help']),
  ...Object.fromEntries(['npm', 'pnpm', 'yarn'].map((p) => [p, sub(['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'outdated', 'why', 'help', 'explain'], { t3: ['install', 'i', 'ci', 'add', 'uninstall', 'remove', 'rm', 'update', 'upgrade', 'up', 'rebuild', 'prune', 'dedupe', 'link', 'publish'], why3: 'installs or removes software', why2: 'runs a project script' })])),
  npx: () => R(3, 'downloads and runs a package'),
  openssl: (a) => (a[1] === 'version' || (a[1] === 'x509' && has(a, /^-noout$/) && !has(a, /^-out$/)) ? READS : R(2, 'runs openssl, which can write keys')),
  ...Object.fromEntries(['fdisk', 'sfdisk', 'gdisk', 'parted', 'cfdisk', 'sgdisk'].map((p) => [p, (a) => (has(a, /^(-l|--list|print|-p)$/) ? READS : R(4, 'changes a disk’s partitions'))])),
  ...Object.fromEntries(['mkfs', 'mke2fs', 'mkswap', 'wipefs', 'shred', 'blkdiscard'].map((p) => [p, () => R(4, 'wipes a disk or a file for good')])),
  dd: (a) => (has(a, /^of=\/dev\//) ? R(4, 'would overwrite a disk') : R(2, 'copies raw data')),
  rm: (a) => {
    const targets = pos(a.slice(1));
    if (has(a, /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/)) return targets.length && targets.every((t) => TRASH.test(t)) ? R(3, 'deletes from Unit7’s trash') : R(4, 'deletes folders for good');
    return targets.some((t) => /\/backups?\/|backup|\.(dump|sql|sql\.gz|bak|tgz|tar\.gz)$/i.test(t)) ? R(4, 'deletes backups') : R(3, 'deletes files');
  },
  unlink: () => R(3, 'deletes files'), rmdir: () => R(2, 'removes a folder'), truncate: () => R(3, 'empties a file'),
  ...Object.fromEntries(['chmod', 'chown', 'chgrp', 'chattr', 'setfacl'].map((p) => [p, (a) => (has(a, /^(-[a-zA-Z]*R[a-zA-Z]*|--recursive)$/) && pos(a.slice(1)).some((t) => /^\/(\*|etc|var|usr|home|root|bin|sbin|lib\w*|boot|opt|srv|data)?\/?$/.test(t))
    ? R(4, 'changes permissions on the whole system') : pos(a.slice(1)).some((t) => PROTECTED.test(t)) ? R(4, protectedWhy('')) : R(2, 'changes file permissions'))])),
  ...Object.fromEntries(['mv', 'cp', 'ln', 'install', 'touch', 'mkdir', 'rsync', 'tee'].map((p) => [p, (a) => {
    const t = pos(a.slice(1));
    if (t.some((x) => PROTECTED.test(x))) return R(4, protectedWhy(t.find((x) => PROTECTED.test(x))!));
    return p === 'tee' && !t.length ? READS : R(2, p === 'rsync' ? 'copies files' : 'changes files');
  }])),
  ...Object.fromEntries(['passwd', 'chpasswd', 'usermod', 'useradd', 'userdel', 'adduser', 'deluser', 'groupadd', 'groupdel', 'groupmod', 'gpasswd', 'visudo', 'chsh', 'chage', 'ssh-copy-id', 'pam-auth-update'].map((p) => [p, () => LOGIN])),
  ...Object.fromEntries(['reboot', 'shutdown', 'poweroff', 'halt', 'init', 'telinit', 'kexec'].map((p) => [p, () => R(3, 'restarts or turns off the server')])),
  ...Object.fromEntries(['kill', 'pkill', 'killall'].map((p) => [p, (a) => (a[1] === '-l' ? READS : R(2, 'stops programs'))])),
  ...Object.fromEntries(['psql', 'mysql', 'mariadb', 'mongo', 'mongosh', 'redis-cli', 'sqlite3', 'clickhouse-client', 'cqlsh'].map((p) => [p, DB_CLIENT])),
  dropdb: () => R(4, 'drops a database'), dropuser: () => R(3, 'changes database logins'),
  ...Object.fromEntries(['pg_dump', 'pg_dumpall', 'mysqldump', 'mariadb-dump', 'mongodump'].map((p) => [p, () => R(2, 'prints or saves a whole database')])),
  printenv: () => R(4, 'would show secret values'),
  export: (a) => (a.length === 1 || has(a, /^-p$/) ? R(4, 'would show secret values') : R(2, 'sets a variable for what runs next')),
  set: (a) => (a.length === 1 ? R(4, 'would show secret values') : a.slice(1).every((x) => /^[-+][a-zA-Z]+$/.test(x) || x === '-o' || x === '+o' || /^(errexit|nounset|pipefail|xtrace)$/.test(x)) ? READS : R(2, 'changes the shell')),
  ...Object.fromEntries(['declare', 'typeset'].map((p) => [p, (a) => (a.length === 1 || has(a, /^-[a-zA-Z]*[px]/) ? R(4, 'would show secret values') : R(2, 'sets a variable for what runs next'))])),
  eval: () => R(3, 'runs text as a command'), source: () => R(3, 'runs a script file'), '.': () => R(3, 'runs a script file'),
  ...Object.fromEntries(['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp'].map((p) => [p, () => R(2, 'connects to another machine')])),
  ...Object.fromEntries(['at', 'batch', 'systemd-run', 'chroot', 'unshare', 'nsenter'].map((p) => [p, () => R(3, 'runs a command Unit7 can’t follow')])),
  ...Object.fromEntries(['screen', 'tmux', 'setsid', 'disown'].map((p) => [p, () => R(2, 'keeps running in the background')])),
};
for (const p of DOWNLOADERS) RULES[p] = (a) => {
  // sending a file off the server is never for an AI; saving one is a change; just looking is still a change (it reaches out)
  const joined = a.slice(1);
  if (has(joined, /^(-T|--upload-file|--post-file|--body-file)$/) || joined.some((x, k) => /^(-d|--data|--data-binary|--data-raw|--data-urlencode|-F|--form)$/.test(joined[k - 1] ?? '') && /^@|=@|^<|=</.test(x)) || has(joined, /^--(data[\w-]*|form)=@/)) return R(4, 'sends a file from the server to the internet');
  return R(2, 'talks to the internet');
};
for (const p of [...SHELLS, ...INTERPRETERS]) RULES[p] ??= (a) => (a.length === 2 && /^(--version|-v|-V|version)$/.test(a[1]!) ? READS : R(3, 'runs code Unit7 can’t read'));

// Wrappers that run the command after them: sudo, timeout, nice, env… The command they run is what's classified.
function unwrap(a: string[], ws: Word[]): { a: string[]; ws: Word[]; res: Res } {
  let res = READS;
  const skip = (k: number) => { a = a.slice(k); ws = ws.slice(k); };
  for (let guard = 0; guard < 8 && a.length; guard++) {
    const p = base(a[0]!);
    let k = 1;
    if (p === 'sudo') {
      while (a[k]?.startsWith('-')) { if (/^(-n|--non-interactive)$/.test(a[k]!)) k++; else if (/^-[ug]$/.test(a[k]!)) k += 2; else if (/^--(user|group)=/.test(a[k]!)) k++; else return { a, ws, res: worst(res, R(3, 'uses sudo in a way Unit7 can’t follow')) }; }
    } else if (p === 'timeout') {
      while (a[k]?.startsWith('-')) k += /^-[ks]$/.test(a[k]!) ? 2 : 1;
      k++;
    } else if (p === 'nice' || p === 'ionice' || p === 'stdbuf') {
      while (a[k]?.startsWith('-')) k += /^-[nct]$/.test(a[k]!) || /^-[ioe]$/.test(a[k]!) ? 2 : 1;
    } else if (p === 'time' || p === 'exec' || p === 'nohup' || p === 'watch' || p === 'xargs') {
      while (a[k]?.startsWith('-')) k += /^-[nLPsdEIa]$/.test(a[k]!) ? 2 : 1;
      if (p !== 'time') res = worst(res, R(2, p === 'xargs' ? 'runs a command for each line it reads' : p === 'watch' ? 'runs a command over and over' : 'keeps running in the background'));
    } else if (p === 'command') {
      if (/^-[vV]$/.test(a[1] ?? '')) return { a: [], ws: [], res };
      while (a[k] === '-p') k++;
    } else if (p === 'env') {
      for (;;) {
        const x = a[k];
        if (x === undefined) break;
        if (/^(-S|--split-string)/.test(x)) return { a, ws, res: worst(res, R(3, 'runs a command Unit7 can’t follow')) };
        if (/^-[u]$/.test(x)) k += 2;
        else if (x.startsWith('-')) k++;
        else if (/^[A-Za-z_]\w*=/.test(x)) { if (!SAFE_ENV.test(x.split('=')[0]!)) res = worst(res, R(2, `sets ${x.split('=')[0]}, which changes what runs`)); k++; }
        else break;
      }
      if (k >= a.length) return { a: [], ws: [], res: R(4, 'would show secret values') };
    } else break;
    skip(k);
  }
  return { a, ws, res };
}

export interface Classified { tier: Tier; why: string; commands: string[][] }
export function classify(command: string, depth = 0): Classified {
  if (depth > 4) return { tier: 3, why: 'nests commands too deep to read', commands: [] };
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(tokenize(command)); } catch (e) { return { tier: 3, why: `can’t be read safely: ${(e as Error).message}`, commands: [] }; }
  let res = READS;
  const commands: string[][] = [];
  if (parsed.flow) res = worst(res, R(2, 'uses loops or conditions'));
  if (parsed.bg) res = worst(res, R(2, 'keeps running in the background'));
  for (const pipe of parsed.pipes) {
    let prev: string[] = [], fetched = false; // fetched: something earlier in this pipe downloads
    for (const c of pipe) {
      commands.push(c.words.map((w) => w.v));
      // what's inside $(…), `…`, <(…) runs too; a variable's value is unknown
      for (const w of [...c.words, ...c.redirs.flatMap((r) => [r.to, r.body].filter(Boolean) as Word[])]) {
        for (const b of w.subs) { const inner = classify(b, depth + 1); res = worst(res, inner.tier > 2 ? inner : R(2, 'runs a command inside the command')); }
        if (w.expand && !w.subs.length) res = worst(res, R(2, 'uses a variable whose value Unit7 can’t see'));
      }
      for (const r of c.redirs) {
        const to = r.to?.v ?? '';
        if (/^(>|>>|>\||&>|&>>|<>)$/.test(r.redir) || (r.redir === '>&' && !/^(\d+|-)$/.test(to))) {
          if (!/^\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(to)) res = worst(res, PROTECTED.test(to) ? R(4, protectedWhy(to)) : R(2, 'writes to a file'));
        } else if ((r.redir === '<' || r.redir === '<&') && SECRET_FILE.test(to)) res = worst(res, R(4, 'would show secret values'));
      }
      let ws = c.words;
      while (ws.length && /^[A-Za-z_]\w*=/.test(ws[0]!.raw)) { const name = ws[0]!.raw.split('=')[0]!; if (!SAFE_ENV.test(name)) res = worst(res, R(2, `sets ${name}, which changes what runs`)); ws = ws.slice(1); }
      if (!ws.length) { if (c.words.length) res = worst(res, R(2, 'sets a variable for what runs next')); prev = []; continue; }
      const u = unwrap(ws.map((w) => w.v), ws);
      res = worst(res, u.res);
      if (!u.a.length) { prev = []; continue; }
      const prog = u.a[0]!;
      const named = !prog.includes('/') ? prog : /^\/(usr\/)?(local\/)?s?bin\/[^/]+$/.test(prog) ? base(prog) : '';
      const name = /^mkfs\./.test(named) ? 'mkfs' : named;
      const reads = SHELLS.has(name) || INTERPRETERS.has(name) ? !u.a.slice(1).some((x) => !x.startsWith('-')) && !u.a.includes('-c') && !u.a.includes('-e') : false;
      if (reads && fetched) res = worst(res, R(4, 'runs code straight from the internet'));
      else if (reads && prev.length && (prev[0] === 'echo' || prev[0] === 'printf')) res = worst(res, worst(R(2, 'runs a script'), classify(prev.slice(1).join(' '), depth + 1)));
      // bash -c "$(curl …)", sh <(wget …), eval "$(curl …)": what the internet sends runs
      else if ((SHELLS.has(name) || INTERPRETERS.has(name) || ['eval', 'source', '.'].includes(name)) && u.ws.some((w) => w.subs.some((b) => /\b(curl|wget|fetch|aria2c)\b/.test(b)))) res = worst(res, R(4, 'runs code straight from the internet'));
      else if (SHELLS.has(name) && u.a.includes('-c')) res = worst(res, worst(R(2, 'runs a script'), classify(u.a[u.a.indexOf('-c') + 1] ?? '', depth + 1)));
      else if (u.ws[0]?.glob || !name) res = worst(res, R(2, name ? 'runs a program picked by a pattern' : `runs ${prog}, a program Unit7 doesn’t know`));
      else {
        const rule = RULES[name];
        res = worst(res, rule ? rule(u.a, u.ws) : R(2, `runs ${name}, which Unit7 doesn’t know as read-only`));
      }
      prev = u.a;
      if (DOWNLOADERS.has(name)) fetched = true;
    }
  }
  return { ...res, commands };
}
// For an approval card: exactly how the command splits into programs and arguments
export const argvWords = (c: Classified) => c.commands.map((a) => JSON.stringify(a)).join(' then ');

// ===== typed verbs on a part, by who runs it =============================================================
export type Verb = 'restart' | 'stop' | 'start' | 'logs' | 'env' | 'run' | 'update' | 'limits' | 'remove';
export const VERB_TIER: Record<Verb, Tier> = { logs: 0, restart: 1, start: 1, stop: 2, env: 2, update: 2, limits: 2, run: 2, remove: 3 };
export type How = 'docker' | 'compose' | 'pm2' | 'systemd' | 'process';
export type CoolifyKind = 'application' | 'database' | 'service';
export type Route = { via: 'ssh'; how: How } | { via: 'coolify'; kind: CoolifyKind; uuid: string } | { via: 'refuse'; why: string };
const OTHER_PAAS = new Set<Owner>(['dokploy', 'caprover', 'dokku', 'easypanel', 'kamal', 'portainer']);
export const coolifyKind = (p: Part): CoolifyKind => (p.coolify?.type === 'database' ? 'database' : p.coolify?.type === 'service' ? 'service' : 'application');

// Who carries out a verb on a part: Unit7 over SSH, Coolify's API (so Coolify stays in charge), or nobody, with
// why in words. A PaaS's things change only through that PaaS; looking at them (logs) and running a one-off
// command inside them is fine over SSH.
export function routeOf(p: Part, verb: Verb, inSystemProject = false): Route {
  const no = (why: string): Route => ({ via: 'refuse', why });
  const who = OWNER_NAME[p.owner];
  if (p.kind === 'domain') return no(`${p.name} is a domain: change the app it opens instead.`);
  if (p.kind === 'job') return no(`${p.name} is a scheduled job; Unit7 can’t ${verb} those yet.`);
  if (p.kind === 'volume') return verb === 'remove' && p.owner !== 'coolify' && !OTHER_PAAS.has(p.owner) && !inSystemProject ? { via: 'ssh', how: 'docker' } : no(`${p.name} is stored data${p.owner !== 'unmanaged' ? ` that ${who} looks after` : ''}; Unit7 only removes leftover data nothing uses (into a 7-day trash).`);
  if (verb === 'remove') return no('Only leftover stored data (a volume nothing uses) can be removed this way.');
  if (p.owner === 'unit7') return no(`Unit7 runs ${p.name} itself: use service.restart, service.stop, env.set or deployment.create, which also check it comes back healthy.`);
  if (inSystemProject && p.owner !== 'systemd') return no(`${p.name} is part of ${who} itself, so Unit7 leaves it alone.`);
  if (p.owner === 'coolify') {
    if (!p.coolify) return no(`${p.name} belongs to Coolify itself, so Unit7 leaves it alone.`);
    if (verb === 'limits') return no(`Coolify runs ${p.name}: set its memory and CPU limits in Coolify (coolify.memory_cap, or the resource’s Resource limits), so Coolify keeps them.`);
    if (verb === 'run') return { via: 'ssh', how: 'docker' };
    return { via: 'coolify', kind: coolifyKind(p), uuid: p.coolify.uuid };
  }
  if (OTHER_PAAS.has(p.owner)) {
    if ((verb === 'logs' || verb === 'run') && p.containers?.length) return { via: 'ssh', how: 'docker' };
    return no(`${p.name} is run by ${who}, so change it through ${who} (its next deploy would undo a change made here).`);
  }
  if (p.owner === 'pm2') {
    if (verb === 'env') return no(`PM2 keeps ${p.name}’s settings in its ecosystem file: change them there, then restart it here.`);
    if (verb === 'update' || verb === 'limits') return no(`Unit7 can’t ${verb === 'update' ? 'update' : 'cap'} a PM2 app yet: ${verb === 'update' ? 'update it the way you deploy it' : 'set max_memory_restart in its ecosystem file'}, then restart it here.`);
    return { via: 'ssh', how: 'pm2' };
  }
  if (p.owner === 'systemd') return verb === 'update' ? no('Unit7 can’t update a system service yet: update it the way it was installed, then restart it here.') : { via: 'ssh', how: 'systemd' };
  if (p.owner === 'compose') return p.compose ? { via: 'ssh', how: 'compose' } : no(`${p.name} runs as a Docker Swarm service; Unit7 can’t change those yet.`);
  if (p.containers?.length) {
    if (verb === 'env' || verb === 'update') return no(`Docker can’t change a running container’s ${verb === 'env' ? 'settings' : 'image'} in place: it has to be recreated. Put it in a Docker Compose file first, then change it here.`);
    return { via: 'ssh', how: 'docker' };
  }
  return verb === 'run' && p.dir ? { via: 'ssh', how: 'process' } : no(`Nothing manages ${p.name} (a program started by hand), so Unit7 can’t ${verb} it safely. Put it under PM2 or systemd first.`);
}

// Values from the X-ray (names, folders, units) go into commands quoted; these also can't pass for a flag.
const SAFE_VALUE = /^[\w@%+=:,./][\w@%+=:,./ -]*$/;
export function safe(v: string | undefined, what: string): string {
  if (!v || !SAFE_VALUE.test(v) || v.length > 300) throw new Unit7Error('unsafe_name', `The ${what} “${String(v).slice(0, 60)}” has characters Unit7 won’t put in a command.`, 400);
  return v;
}
export const pm2User = (p: Part) => /^\/home\/([^/]+)\/\.pm2$/.exec(p.pm2?.home ?? '')?.[1];
const pm2 = (p: Part, ...args: string[]) => {
  const user = pm2User(p);
  return [...(user ? ['runuser', '-u', safe(user, 'user'), '--'] : []), 'env', `PM2_HOME=${safe(p.pm2?.home ?? '/root/.pm2', 'PM2 folder')}`, 'pm2', ...args];
};
export function composeArgs(p: Part, withFiles = false): string[] {
  const c = p.compose!;
  const files = withFiles ? (c.files ?? '').split(',').map((f) => f.trim()).filter(Boolean) : [];
  return ['docker', 'compose', '-p', safe(c.project, 'Compose project'), ...(withFiles && c.workingDir ? ['--project-directory', safe(c.workingDir, 'folder')] : []), ...files.flatMap((f) => ['-f', safe(f, 'Compose file')])];
}
export const composeService = (p: Part) => (p.compose?.service ? [safe(p.compose.service, 'Compose service')] : []);
export const containersOf = (p: Part) => (p.containers ?? []).map((c) => safe(c, 'container'));
export const run = (argv: string[]) => cmd(argv[0]!, ...argv.slice(1));
export const show = (argv: string[]) => JSON.stringify(argv);

export function lifecycleArgv(p: Part, verb: 'restart' | 'stop' | 'start', how: How): string[] {
  if (how === 'compose') return [...composeArgs(p), verb, ...composeService(p)];
  if (how === 'pm2') return pm2(p, verb, safe(p.name, 'PM2 app'));
  if (how === 'systemd') return ['systemctl', verb, safe(p.unit, 'service')];
  return ['docker', verb, ...containersOf(p)];
}

export function logsCommand(p: Part, how: How, o: { lines: number; grep?: string; sinceMinutes?: number; container?: string }): { shows: string; command: string } {
  const n = String(o.grep ? 5000 : o.lines);
  const argv = how === 'systemd' ? ['journalctl', '-u', safe(p.unit, 'service'), '-n', n, '--no-pager', '-o', 'short-iso', ...(o.sinceMinutes ? ['--since', `${o.sinceMinutes} min ago`] : [])]
    : how === 'pm2' ? ['tail', '-q', '-n', n, ...['out', 'error'].map((k) => `${safe(p.pm2?.home ?? '/root/.pm2', 'PM2 folder')}/logs/${safe(p.name, 'PM2 app')}-${k}.log`)]
    : ['docker', 'logs', '--timestamps', '--tail', n, ...(o.sinceMinutes ? ['--since', `${o.sinceMinutes}m`] : []), safe(o.container ?? p.containers?.[0], 'container')];
  // the search pattern is a value, single-quoted: never part of the command itself
  const tail = `${o.grep ? ` | grep -i -e ${shq(o.grep)}` : ''} | tail -n ${o.lines}`;
  return { shows: `${show(argv)}${o.grep ? ` then ["grep","-i","-e",${JSON.stringify(o.grep)}]` : ''}`, command: `${run(argv)} 2>&1${tail}` };
}

export function runArgv(p: Part, how: How, command: string, seconds: number, container?: string): { argv: string[]; dir?: string } {
  if (how === 'docker' || how === 'compose') return { argv: ['timeout', String(seconds), 'docker', 'exec', safe(container, 'container'), 'sh', '-c', command] };
  const user = how === 'pm2' ? pm2User(p) : how === 'systemd' && p.user && p.user !== 'root' ? p.user : undefined;
  return { dir: safe(p.dir ?? '/', 'folder'), argv: ['timeout', String(seconds), ...(user ? ['runuser', '-u', safe(user, 'user'), '--'] : []), 'sh', '-c', command] };
}

export function limitsArgv(p: Part, how: How, o: { memoryMb?: number; cpus?: number }): string[] {
  if (how === 'systemd') return ['systemctl', 'set-property', safe(p.unit, 'service'), ...(o.memoryMb ? [`MemoryMax=${o.memoryMb}M`] : []), ...(o.cpus ? [`CPUQuota=${Math.round(o.cpus * 100)}%`] : [])];
  return ['docker', 'update', ...(o.memoryMb ? ['--memory', `${o.memoryMb}m`, '--memory-swap', `${o.memoryMb * 2}m`] : []), ...(o.cpus ? ['--cpus', String(o.cpus)] : []), ...containersOf(p)];
}

// ===== "What happens if…?" ================================================================================
export interface Impact { lines: string[]; domains: string[]; dependents: string[]; backup?: string }
const list = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more` : xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
export function impactOf(inv: Inventory, p: Part, verb: Verb, o: { lastBackup?: string } = {}): Impact {
  const domains = [...new Set([...(p.hosts ?? []), ...inv.parts.filter((d) => d.kind === 'domain' && d.target === p.id).map((d) => d.name)])];
  const dependents = inv.parts.filter((q) => q.id !== p.id && q.uses?.includes(p.id)).map((q) => q.name);
  const down = verb === 'restart' || verb === 'update' || verb === 'env' ? 'for a few seconds' : verb === 'stop' ? 'until it’s started again' : '';
  const lines: string[] = [];
  if (down) lines.push(domains.length ? `${list(domains)} ${domains.length === 1 ? 'goes' : 'go'} down ${down}.` : `${p.name} is offline ${down}.`);
  if (down && dependents.length) lines.push(`${list(dependents)} ${dependents.length === 1 ? 'depends' : 'depend'} on it and may show errors meanwhile.`);
  if (verb === 'limits') lines.push(`${p.name} keeps running; if it goes over the new cap, it’s restarted.`);
  if (verb === 'remove') lines.push('Its data moves to a 7-day trash first; undo brings it back.');
  const job = inv.parts.find((j) => j.kind === 'job' && /dump|backup/i.test(j.command ?? '') && (p.containers ?? [p.name]).some((c) => j.command!.includes(c)));
  const backup = o.lastBackup ?? (job ? `a scheduled job backs it up ${job.when ?? job.schedule}` : undefined);
  if (p.kind === 'database' || verb === 'remove' || o.lastBackup) lines.push(backup ? `Last backup: ${backup}.` : 'No backup of it is known.');
  return { lines, domains, dependents, ...(backup && { backup }) };
}
