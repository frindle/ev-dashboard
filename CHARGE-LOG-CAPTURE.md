# Overnight charge-log capture

Run this on the **Unraid host** (`storagedemon`) before you and the Rivian both plug in for the night. Survives `docker-compose up -d`, Watchtower, SSH disconnects, and laptop sleep — the inner `docker logs -f` dies on container replacement, the outer `while` loop reconnects to whatever container holds the name `ev-dashboard-ev-dashboard-1` after each restart.

The log lands at `/mnt/user/appdata/ev-dashboard/ev-overnight.log` so it shows up on your SMB share — no `docker cp` needed.

---

## 1. Before plugging in — start the capture

```bash
mkdir -p /mnt/user/appdata/ev-dashboard
echo "===== capture started $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> /mnt/user/appdata/ev-dashboard/ev-overnight.log
nohup bash -c 'while true; do docker logs -f --since 1s ev-dashboard-ev-dashboard-1 2>&1; echo "===== reconnect $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="; sleep 2; done' >> /mnt/user/appdata/ev-dashboard/ev-overnight.log 2>&1 &
disown
echo "Started. log=/mnt/user/appdata/ev-dashboard/ev-overnight.log"
```

## 2. In the morning — stop the capture

```bash
pkill -f 'docker logs -f --since 1s ev-dashboard-ev-dashboard-1'
echo "===== capture stopped $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> /mnt/user/appdata/ev-dashboard/ev-overnight.log
ls -la /mnt/user/appdata/ev-dashboard/ev-overnight.log
```

Then grab `\\storagedemon\appdata\ev-dashboard\ev-overnight.log` over SMB and upload it.

## 3. Optional — check whether it's still running

```bash
pgrep -af 'docker logs -f --since 1s ev-dashboard-ev-dashboard-1'
```

If that returns nothing, the capture isn't running. Re-run step 1.

## 4. Optional — watch it live

```bash
tail -f /mnt/user/appdata/ev-dashboard/ev-overnight.log
```

---

## What we learned from the 2026-06-24 capture

The previous attempt died at **2026-06-26 07:00 UTC** because `ev-dashboard-ev-dashboard-1` was restarted at **07:01:53 UTC** (midnight Pacific). `docker logs -f` is bound to a container ID, not a name — when the container is recreated, the follower exits silently and the file stops growing. `restarts=0` is misleading; the counter only ticks on Docker's restart-policy auto-recoveries, not manual or compose-triggered stops.

The loop in step 1 above fixes this: each time the inner follower exits (container gone, OOM, manual stop), the outer `while` re-enters and reconnects after the new container comes up. The marker line `===== reconnect ... =====` lets you spot the discontinuity in the log.
