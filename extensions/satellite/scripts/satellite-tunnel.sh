#!/usr/bin/env bash
# satellite-tunnel.sh — keep an SSH tunnel to the HPC login alive
#
# Behavior:
#   - Probe login:22 with `</dev/tcp/...` (bash built-in, no nc/ssh dependency)
#   - If unreachable: sleep with exponential backoff (60s → 900s cap), then re-probe
#   - If reachable: run the SSH tunnel until it exits
#   - On any tunnel exit, briefly wait and re-probe
#
# Logging conventions (greppable):
#   - normal events  → log   (stdout, "[ts] msg")
#   - anomalies      → warn  (stderr, "[ts] WARNING: [TAG] msg")
#   - fatal config   → fatal (stderr + exit 1, "[ts] FATAL: [TAG] msg")
#
# Greppable tags:
#   [USER_RESOLVE]  SSH alias resolution or fallback path
#   [AUTH_FAIL]     SSH publickey/auth rejection
#   [PROBE_FAIL]    TCP probe cannot reach login:22

set -u

LOGIN_ALIAS=${LOGIN_ALIAS:-login}
LOGIN_PORT=${LOGIN_PORT:-22}
LOCAL_PORT=${LOCAL_PORT:-29001}
REMOTE_PORT=${REMOTE_PORT:-29001}

PROBE_TIMEOUT=5
PROBE_BACKOFF=60
PROBE_BACKOFF_MAX=900
TUNNEL_RESTART_DELAY=5
AUTH_FAIL_THRESHOLD=3      # consecutive auth fails before entering long-sleep
AUTH_FAIL_LONG_SLEEP=1800  # 30 min

log()   { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
warn()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }
fatal() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] FATAL: $*" >&2; exit 1; }

# Resolve the SSH alias to (hostname, user). `ssh -G` parses ~/.ssh/config
# like a real `ssh` invocation, so this picks up
# `Host login -> HostName 172.30.0.4` and `User qujiahao9430_test` mappings
# that bash's /dev/tcp can't see.
#
# On every fallback path, log a [USER_RESOLVE] warning. Specifically: if the
# User field is missing, do NOT silently fall back to $(whoami) — that is
# the bug that on 2026-06-08 caused the script to log in as `qjh` against
# a server where only `qujiahao9430_test` exists, producing 90 brute-force
# alerts. Log it loudly instead, but still let the script run (so we don't
# break setups where the local user IS the right HPC account).
resolve_login() {
  local cfg host user ssh_g_failed=0
  if ! cfg=$(ssh -G "$LOGIN_ALIAS" 2>&1); then
    warn "[USER_RESOLVE] ssh -G ${LOGIN_ALIAS} failed; trying getent fallback"
    cfg=""
    ssh_g_failed=1
  fi
  host=$(echo "$cfg" | awk '/^hostname / {print $2; exit}')
  user=$(echo "$cfg" | awk '/^user / {print $2; exit}')

  if [ -z "$host" ]; then
    warn "[USER_RESOLVE] ${LOGIN_ALIAS} has no HostName in ~/.ssh/config; trying getent"
    host=$(getent hosts "$LOGIN_ALIAS" 2>/dev/null | awk '{print $1; exit}')
  fi
  if [ -z "$host" ]; then
    warn "[USER_RESOLVE] ${LOGIN_ALIAS} unresolvable via ssh -G or getent; using literal as hostname (probe will likely fail)"
    host="$LOGIN_ALIAS"
  fi
  if [ -z "$user" ]; then
    user=$(whoami)
    warn "[USER_RESOLVE] ${LOGIN_ALIAS} has no User directive in ~/.ssh/config"
    warn "[USER_RESOLVE] falling back to \$(whoami)='${user}'"
    warn "[AUTH_GUARD] if '${user}' is NOT your HPC account, add 'User <account>' to ~/.ssh/config NOW"
    warn "[AUTH_GUARD] this is the exact bug that caused 90 brute-force alerts on 2026-06-08"
  fi
  if [ "$ssh_g_failed" -eq 1 ] && [ -n "$user" ]; then
    warn "[USER_RESOLVE] ssh -G failed but user was still resolved; that means the config WAS loaded — investigate"
  fi
  echo "${host} ${user}"
}

read -r LOGIN SSH_USER <<<"$(resolve_login)"
log "resolved ${LOGIN_ALIAS} -> ${LOGIN} (user ${SSH_USER})"
if [ "$SSH_USER" = "$(whoami)" ]; then
  warn "[USER_RESOLVE] SSH user equals local username '$(whoami)'; verify this is your HPC account"
fi

probe() {
  timeout "$PROBE_TIMEOUT" bash -c "exec 3<>/dev/tcp/${LOGIN}/${LOGIN_PORT}" 2>/dev/null
}

CONSECUTIVE_AUTH_FAILS=0

while true; do
  if probe; then
    PROBE_BACKOFF=60
    log "${LOGIN}:${LOGIN_PORT} reachable, starting tunnel localhost:${LOCAL_PORT} -> ${LOGIN}:${REMOTE_PORT}"

    # Capture stderr so we can classify the failure mode.
    # BatchMode=yes → never invoke ssh-askpass.
    # IdentitiesOnly=yes + IdentityFile → offer ONLY the one explicit key.
    # Use the alias + explicit user (NOT the resolved IP) so ~/.ssh/config
    # is fully applied.
    err=$(mktemp)
    /usr/bin/ssh \
      -N \
      -L "${LOCAL_PORT}:localhost:${REMOTE_PORT}" \
      -l "${SSH_USER}" \
      "${LOGIN_ALIAS}" \
      -o BatchMode=yes \
      -o IdentitiesOnly=yes \
      -o IdentityFile="${HOME}/.ssh/id_rsa" \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      2>"$err"
    rc=$?
    err_msg=$(tr '\n' ' ' < "$err" | head -c 200)
    rm -f "$err"

    if [ $rc -eq 0 ]; then
      log "tunnel exited cleanly (code=0)"
      CONSECUTIVE_AUTH_FAILS=0
      sleep "${TUNNEL_RESTART_DELAY}"
    elif echo "$err_msg" | grep -qE "Permission denied|Too many authentication failures|publickey"; then
      CONSECUTIVE_AUTH_FAILS=$((CONSECUTIVE_AUTH_FAILS + 1))
      warn "[AUTH_FAIL] ssh -l ${SSH_USER} ${LOGIN_ALIAS} rejected (consecutive=${CONSECUTIVE_AUTH_FAILS}, code=${rc})"
      warn "[AUTH_FAIL] stderr: ${err_msg}"
      if [ $CONSECUTIVE_AUTH_FAILS -ge $AUTH_FAIL_THRESHOLD ]; then
        warn "[AUTH_FAIL] hit threshold ${AUTH_FAIL_THRESHOLD}; entering long-sleep ${AUTH_FAIL_LONG_SLEEP}s to stop hammering sshd and avoid brute-force monitor"
        sleep "$AUTH_FAIL_LONG_SLEEP"
        CONSECUTIVE_AUTH_FAILS=0
      else
        sleep "${TUNNEL_RESTART_DELAY}"
      fi
    elif echo "$err_msg" | grep -qE "Connection refused|Connection timed out|No route|could not resolve"; then
      CONSECUTIVE_AUTH_FAILS=0
      log "[PROBE_FAIL-ish] tunnel exit code=${rc}; stderr: ${err_msg}"
      sleep "${TUNNEL_RESTART_DELAY}"
    else
      CONSECUTIVE_AUTH_FAILS=0
      log "tunnel exited (code=${rc}); stderr: ${err_msg}"
      sleep "${TUNNEL_RESTART_DELAY}"
    fi
  else
    log "[PROBE_FAIL] ${LOGIN}:${LOGIN_PORT} not reachable, sleep ${PROBE_BACKOFF}s"
    sleep "${PROBE_BACKOFF}"
    PROBE_BACKOFF=$(( PROBE_BACKOFF * 2 ))
    if [ "${PROBE_BACKOFF}" -gt "${PROBE_BACKOFF_MAX}" ]; then
      PROBE_BACKOFF=${PROBE_BACKOFF_MAX}
    fi
  fi
done
