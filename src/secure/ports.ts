// One port at the server's own firewall: which ports are dangerous to open, the rules that close or open one, and the
// boot-time restore that keeps those rules after a restart. Plain iptables rules are gone after a reboot unless
// netfilter-persistent is installed, so Unit7 keeps its own list (/etc/unit7/ports) and a small unit puts it back.
import type { Ctx } from '../tools/runtime.ts';
import { ssh, type ServerRow } from '../connectors/ssh.ts';
import { script } from '../connectors/shell.ts';
import type { Inventory } from '../discovery/xray.ts';

export const DB_PORTS: Record<number, string> = { 5432: 'PostgreSQL', 3306: 'MySQL', 6379: 'Redis', 27017: 'MongoDB', 9200: 'Elasticsearch', 5984: 'CouchDB', 11211: 'Memcached' };
export const COOLIFY_PORTS: Record<number, string> = { 8000: 'Coolify’s dashboard', 6001: 'Coolify’s live updates', 6002: 'Coolify’s terminal' };
const MORE_DB: Record<number, string> = { 1433: 'SQL Server', 1521: 'Oracle', 3307: 'MySQL', 5433: 'PostgreSQL', 6432: 'PgBouncer', 7687: 'Neo4j', 8086: 'InfluxDB', 8123: 'ClickHouse', 9042: 'Cassandra', 26257: 'CockroachDB' };
const ADMIN: Record<number, string> = { ...COOLIFY_PORTS, 22: 'SSH sign-in', 2375: 'Docker’s control port', 2376: 'Docker’s control port', 2019: 'the web proxy’s admin port', 8080: 'a proxy dashboard', 9090: 'an admin console', 9443: 'Portainer', 10000: 'Webmin', 3389: 'remote desktop', 5900: 'remote screen sharing' };
// what's behind a port a person should think twice about (undefined: nothing Unit7 knows of)
export const portRisk = (port: number): string | undefined => {
  const db = DB_PORTS[port] ?? MORE_DB[port];
  return db ? `a ${db} database` : ADMIN[port];
};
// the X-ray can know better than the number: a database published on an unusual port
export function databaseOn(inv: Inventory | undefined, port: number): string | undefined {
  const p = inv?.parts.find((x) => (x.kind === 'database' || x.engine) && x.ports?.some((y) => y.port === port));
  return p && `the database ${p.name}`;
}
export const riskWords = (port: number, what: string) => `Port ${port} is ${what}. Open to the internet, bots try passwords on it all day, and one weak password hands over your data or your server. A private way in (an SSH tunnel) is safer.`;

// One rule for one port on the internet-facing interface, tagged so it can be found and removed. In DOCKER-USER (Docker's
// published ports skip INPUT and ufw) and INPUT (programs on the server). --ctdir ORIGINAL: only connections that start
// outside, so an app's own calls out to some service on that port keep working. allow puts an ACCEPT in front of ufw and of
// server.harden's guard, and RETURN lets Docker's own rules carry on. $SU comes from whoever uses this.
const RULES = `ext=$(ip route show default 2>/dev/null | awk '{print $5; exit}'); [ -n "$ext" ] || { echo "couldn't find the internet-facing network interface" >&2; exit 3; }
rule() { w="$1"; ipt="$2"; c="$3"; j="$4"; t="$5"; shift 5
  if [ "$w" = add ]; then $SU $ipt -C "$c" "$@" -m comment --comment "$t" -j "$j" 2>/dev/null || $SU $ipt -I "$c" 1 "$@" -m comment --comment "$t" -j "$j"
  else while $SU $ipt -D "$c" "$@" -m comment --comment "$t" -j "$j" 2>/dev/null; do :; done; fi; }
both() { w="$1"; j="$2"; t="$3"; u="$4"
  rule "$w" iptables INPUT "$j" "$t" -i "$ext" -p tcp --dport "$P" || exit 4
  if $SU iptables -n -L DOCKER-USER >/dev/null 2>&1; then rule "$w" iptables DOCKER-USER "$u" "$t" -i "$ext" -p tcp -m conntrack --ctorigdstport "$P" --ctdir ORIGINAL || exit 4; fi
  command -v ip6tables >/dev/null 2>&1 && { rule "$w" ip6tables INPUT "$j" "$t" -i "$ext" -p tcp --dport "$P" 2>/dev/null || true; }; true; }
apply() { P="$1"; case "$2" in
  close) both del ACCEPT "unit7-open-$P" RETURN; both add DROP "unit7-close-$P" DROP ;;
  open) both del DROP "unit7-close-$P" DROP ;;
  allow) both del DROP "unit7-close-$P" DROP; both add ACCEPT "unit7-open-$P" RETURN ;;
esac; }`;

export const PORT_RULES = `SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"
command -v iptables >/dev/null 2>&1 || { echo "no iptables on this server" >&2; exit 3; }
${RULES}
apply "$1" "$2"
command -v netfilter-persistent >/dev/null 2>&1 && $SU netfilter-persistent save >/dev/null 2>&1
echo done`;

// the boot script: server.harden's guard first (restoring it empties Docker's chain), then every port on the list
export const BOOT_PORTS = `#!/bin/sh
# Unit7's firewall rules, put back at every start (unit7-ports.service). The list is /etc/unit7/ports: "close 5432", "allow 8080".
export PATH="$PATH:/usr/sbin:/sbin"; SU=""
command -v iptables >/dev/null 2>&1 || exit 0
${RULES}
[ -f /etc/unit7/docker-user.rules ] && sed "s/EXT_IF/$ext/" /etc/unit7/docker-user.rules | iptables-restore -n
[ -f /etc/unit7/ports ] || exit 0
while read -r a p; do case "$p" in ''|*[!0-9]*) continue ;; esac; ( apply "$p" "$a" ) || true; done < /etc/unit7/ports
`;
// $1 a port and $2 its state (open drops it from the list); the boot script comes on stdin. No systemd: it says so, and
// the rule lasts until the next restart, when server.closed_ports sees it gone and offers it again.
export const KEEP_PORTS = `SU=""; [ "$(id -u)" = 0 ] || SU="sudo -n"
command -v systemctl >/dev/null 2>&1 || { cat >/dev/null; echo unsaved; exit 0; }
$SU mkdir -p /etc/unit7 && $SU tee /etc/unit7/ports.sh >/dev/null
l=$($SU cat /etc/unit7/ports 2>/dev/null | grep -v " $1$")
{ [ -z "$l" ] || printf '%s\\n' "$l"; [ "$2" = open ] || echo "$2 $1"; } | $SU tee /etc/unit7/ports >/dev/null
printf '%s\\n' '[Unit]' 'Description=Unit7 firewall rules' 'After=docker.service network-online.target' 'Wants=network-online.target' '[Service]' 'Type=oneshot' 'RemainAfterExit=yes' 'ExecStart=/bin/sh /etc/unit7/ports.sh' '[Install]' 'WantedBy=multi-user.target' | $SU tee /etc/systemd/system/unit7-ports.service >/dev/null
$SU systemctl daemon-reload && $SU systemctl enable unit7-ports.service >/dev/null 2>&1 && echo saved || echo unsaved`;

// a rule that's in place stays useful even if keeping it fails, so this only says whether it survives a restart
export async function keepPorts(ctx: Pick<Ctx, 'app'>, s: ServerRow, port: number, state: 'close' | 'open' | 'allow') {
  const r = await ssh(ctx.app).exec(s, script(KEEP_PORTS, port, state), { stdin: BOOT_PORTS, timeoutMs: 30_000 }).catch(() => undefined);
  return !!r && r.stdout.trim().endsWith('saved') && !r.stdout.includes('unsaved');
}
