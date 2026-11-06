// The Outpost: one small script on the server, so it's still looked after while the computer running Unit7 sleeps. It measures every
// minute, remembers, checks your sites from inside, takes the nightly copies and sends phone alerts by itself. It opens no port, and
// the only thing it holds is the alert channel. Everything it does is in this file, on the server, for anyone to read.
export const DIR = '/opt/unit7-outpost', CRON = '/etc/cron.d/unit7-outpost', BACKUPS = '/var/backups/unit7-outpost';
export interface Config { alertUrl?: string; heartbeatUrl?: string; sites: string[]; copyHour: number; jobs: { id: string; kind: 'postgres' | 'supabase' | 'mysql'; container: string }[] }

export const OUTPOST = `#!/bin/sh
# Unit7 Outpost. It looks after this server while Unit7 is asleep: no open port, nothing it can change but its own files.
# To remove it: rm -rf ${DIR} ${CRON}
export LC_ALL=C PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin"
umask 077
D=${DIR}
. "$D/config"
[ -f "$D/brakes" ] && . "$D/brakes" # Pause, Observe, Safety Net off and the copy hour, as Unit7 last said them
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
min=$(date -u +%M); hour=$(date -u +%H); m=\${min#0}

alert() { # title, message, priority: Unit7 says these itself while it's awake, so the Outpost only speaks when it's away
  [ -n "\${ALERT_URL:-}" ] || return 0
  if [ -f "$D/unit7-alive" ] && [ -n "$(find "$D/unit7-alive" -mmin -10 2>/dev/null)" ]; then return 0; fi
  printf 'url = "%s"\n' "$ALERT_URL" | curl -fsS -m 10 -K - -H "Title: $1" -H "Priority: $3" -H "Tags: satellite" -d "$2" >/dev/null 2>&1 # on stdin: a command line shows in ps
}
once() { # key, is it bad now (1 or 0), title, message when bad, message when it clears
  f="$D/state.$1"
  if [ "$2" = 1 ]; then
    n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"
    [ "$n" = 3 ] && alert "$3" "$4" 4
  else
    [ "$(cat "$f" 2>/dev/null || echo 0)" -ge 3 ] && alert "$3" "$5" 3
    rm -f "$f"
  fi
}

# --- a reading -------------------------------------------------------------------------------------------------
c1=$(awk '/^cpu /{print $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat); sleep 1; c2=$(awk '/^cpu /{print $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat)
cpu=$(echo "$c1 $c2" | awk '{d=$4-$2; printf "%.1f", (d>0 ? 100*($3-$1)/d : 0)}')
mem=$(awk '/^MemTotal/{t=$2*1024} /^MemAvailable/{a=$2*1024} END{printf "%.0f %.0f", t-a, t}' /proc/meminfo)
disk=$(df -Pk / | awk 'NR==2{printf "%.0f %.0f", $3*1024, $2*1024}')
memUsed=\${mem% *}; memTotal=\${mem#* }; diskUsed=\${disk% *}; diskTotal=\${disk#* }
running=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
down=""
for h in \${SITES:-}; do
  code=$(curl -k -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$h:443:127.0.0.1" "https://$h/" 2>/dev/null)
  case "$code" in 000|5*) down="$down \\"$h\\""; once "site.$h" 1 "$h is down" "$h doesn't answer from inside the server." "$h is back." ;; *) once "site.$h" 0 "$h is down" "" "$h is back." ;; esac
done
printf '{"at":"%s","cpu":%s,"memUsed":%s,"memTotal":%s,"diskUsed":%s,"diskTotal":%s,"running":%s,"down":[%s]}\\n' "$now" "$cpu" "$memUsed" "$memTotal" "$diskUsed" "$diskTotal" "$running" "$(echo $down | sed 's/ /,/g')" >> "$D/readings.jsonl"
[ "$m" = 0 ] && tail -n 20160 "$D/readings.jsonl" > "$D/readings.tmp" && mv "$D/readings.tmp" "$D/readings.jsonl"

# --- what's worth a phone buzz ---------------------------------------------------------------------------------
pct=$((diskTotal > 0 ? diskUsed * 100 / diskTotal : 0)); [ "$pct" -ge 90 ] && b=1 || b=0
once disk "$b" "Disk nearly full" "The disk is $pct% full." "The disk is back to $pct%."
pct=$((memTotal > 0 ? memUsed * 100 / memTotal : 0)); [ "$pct" -ge 95 ] && b=1 || b=0
once memory "$b" "Memory nearly gone" "Memory is $pct% used. Apps may get killed." "Memory is back to $pct%."

# --- someone outside notices if this stops --------------------------------------------------------------------
[ -n "\${HEARTBEAT_URL:-}" ] && [ "$(( m % 5 ))" = 0 ] && printf 'url = "%s"\n' "$HEARTBEAT_URL" | curl -fsS -m 10 -K - >/dev/null 2>&1

# --- the nightly copies. Unit7 picks them up when it wakes -------------------------------------------------------
if [ "$hour" = "\${COPY_HOUR:-03}" ] && [ "$(( m % 10 ))" = 0 ] && [ "\${COPIES:-on}" = on ] && [ -f "$D/jobs" ] && [ "$(cat "$D/copied" 2>/dev/null)" != "$(date -u +%F)" ]; then
  [ "$(awk -v c="$(nproc 2>/dev/null || echo 1)" '{print ($1 < c * 0.7)}' /proc/loadavg)" = 1 ] || exit 0 # busy: ten minutes later, while the hour lasts
  date -u +%F > "$D/copied"
  mkdir -p ${BACKUPS}; chmod 700 ${BACKUPS}
  free=$(df -Pk ${BACKUPS} | awk 'NR==2{print int($4*100/$2)}')
  if [ "$free" -lt 15 ]; then alert "Outpost skipped tonight's copy" "Only $free% of the disk is free." 4; exit 0; fi
  while IFS='|' read -r id kind ctr; do
    [ -n "$id" ] || continue
    d="${BACKUPS}/$id"; mkdir -p "$d"; f="$d/$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
    { case "$kind" in
      supabase) docker exec "$ctr" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec nice -n 19 pg_dumpall -h 127.0.0.1 -U supabase_admin' ;;
      postgres) docker exec "$ctr" sh -c 'exec nice -n 19 pg_dumpall -U "\${POSTGRES_USER:-postgres}"' ;;
      mysql) docker exec "$ctr" sh -c 'export MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; if command -v mysqldump >/dev/null; then c=mysqldump; else c=mariadb-dump; fi; exec nice -n 19 "$c" -uroot --all-databases --single-transaction' ;;
    esac </dev/null; echo $? > "$f.st"; } | gzip > "$f.tmp"
    st=$(cat "$f.st" 2>/dev/null); rm -f "$f.st"
    # only a whole copy gets its real name, and only then does the oldest go: a failed night never costs a good copy
    if [ "$st" = 0 ] && gzip -t "$f.tmp" 2>/dev/null && [ "$(gzip -dc "$f.tmp" | head -c 1 | wc -c)" -gt 0 ]; then mv "$f.tmp" "$f"; ( cd "$d" && ls -1t | tail -n +4 | while read -r old; do rm -f -- "$old"; done )
    else rm -f "$f.tmp"; alert "Outpost couldn't copy $id" "Tonight's copy didn't finish, so the last good one stays." 4; fi
  done < "$D/jobs"
fi
`;

// what's written to the server. The alert channel goes over stdin, never on a command line.
export function configOf(c: Config) {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return [`ALERT_URL=${q(c.alertUrl ?? '')}`, `HEARTBEAT_URL=${q(c.heartbeatUrl ?? '')}`, `SITES=${q(c.sites.filter((s) => /^[a-z0-9.-]+$/i.test(s)).join(' '))}`, `COPY_HOUR=${String(c.copyHour).padStart(2, '0')}`].join('\n') + '\n';
}
export const jobsOf = (c: Config) => c.jobs.filter((j) => /^[\w.-]+$/.test(j.id) && /^[\w.-]+$/.test(j.container)).map((j) => `${j.id}|${j.kind}|${j.container}`).join('\n') + '\n';
export const CRON_LINE = `# Unit7 Outpost: remove this file and ${DIR} to stop it\n* * * * * root ${DIR}/outpost.sh >/dev/null 2>&1\n`;

export interface Reading { at: string; cpu: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number; running: number; down: string[] }
export const parseReadings = (text: string): Reading[] => text.split('\n').flatMap((l) => { try { const r = JSON.parse(l) as Reading; return r.at && typeof r.memUsed === 'number' ? [r] : []; } catch { return []; } });

// (pure) what's still blind in a gap once the Outpost's readings are laid over it
export function uncovered(gap: { from: number; to: number }, readings: number[], maxGap = 10 * 60_000) {
  const points = [gap.from, ...readings.filter((r) => r > gap.from && r < gap.to).sort((a, b) => a - b), gap.to], out: { from: number; to: number }[] = [];
  for (let i = 1; i < points.length; i++) if (points[i]! - points[i - 1]! > maxGap) out.push({ from: points[i - 1]!, to: points[i]! });
  return out;
}
