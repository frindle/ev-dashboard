#!/usr/bin/env bash
# Resilient overnight (or any-night) capture of ev-dashboard logs.
#
# Why this exists: a plain `docker logs -f` follower dies when the container
# is replaced (compose up, watchtower, manual restart). The 2026-06-24 capture
# died at 07:00 UTC because the container was restarted at 07:01:53 UTC and
# we lost ~13 hours of plug-in transitions. The loop here reconnects to
# whatever container holds the name after each restart.
#
# Run BEFORE you plug in for the night:
#   bash scripts/capture-charge-log.sh start
#
# Stop the morning after / when ready to share:
#   bash scripts/capture-charge-log.sh stop
#
# The log lands at /mnt/user/appdata/ev-dashboard/ev-overnight.log so you can
# grab it via the SMB share without docker cp.

set -euo pipefail

CONTAINER="ev-dashboard-ev-dashboard-1"
LOG_DIR="/mnt/user/appdata/ev-dashboard"
LOG_FILE="${LOG_DIR}/ev-overnight.log"
PID_FILE="${LOG_DIR}/ev-overnight.pid"
MARKER="docker logs -f --since 1s ${CONTAINER}"

cmd="${1:-status}"

case "$cmd" in
  start)
    mkdir -p "$LOG_DIR"
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Already running (pid $(cat "$PID_FILE")). Stop it first."
      exit 1
    fi
    # Header so we can tell sessions apart in one file.
    echo "===== capture started $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> "$LOG_FILE"
    nohup bash -c "while true; do ${MARKER} 2>&1; echo '===== ${CONTAINER} reconnect '\"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\"' =====' ; sleep 2; done" \
      >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    disown || true
    echo "Started. pid=$(cat "$PID_FILE") log=${LOG_FILE}"
    ;;
  stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      pid="$(cat "$PID_FILE")"
      # Kill the outer loop AND any inner `docker logs -f` it spawned.
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      pkill -f "${MARKER}" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "===== capture stopped $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> "$LOG_FILE"
      ls -la "$LOG_FILE"
    else
      # PID file missing or stale — kill by command marker as a fallback.
      pkill -f "${MARKER}" 2>/dev/null && echo "Killed orphaned follower." || echo "Nothing running."
      rm -f "$PID_FILE"
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Running. pid=$(cat "$PID_FILE")"
      ls -la "$LOG_FILE" 2>/dev/null || echo "(log file not yet written)"
    else
      echo "Not running."
    fi
    ;;
  tail)
    tail -f "$LOG_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|status|tail}"
    exit 2
    ;;
esac
