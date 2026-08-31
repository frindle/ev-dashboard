# Logs API Endpoint

This API endpoint exposes all logging that was previously only accessible by 
shelling into the container. It provides access to:

## Files Exposed

1. **Raw provider payloads**:
   - `rivian-state-debug.json` - Full GetVehicleState response from Rivian polling
   - `tesla-api-bodies.jsonl` - Tesla API bodies (when TESLA_LOG_API_BODIES=1)

2. **Current state files**:
   - `rivian-push-state.json` - Current state from the WebSocket push
   - `rivian-parallax.json` - Current charging power data from parallax monitoring  
   - `tesla-state.json` - Current state from telemetry server

3. **Daily log files** (in `push-log/` and `parallax-log/` directories):
   - Daily JSONL logs for both Rivian and Tesla telemetry
   - Each file contains one JSON object per line with timestamped entries

## Query Parameters

- `?type=raw` - Raw provider payloads only  
- `?type=current` - Current state files only
- `?type=daily` - Daily log files only (requires date parameter)
- `?date=YYYY-MM-DD` - Specific date to filter daily logs (required for daily type)
- `?start=HH:MM` - Start time for filtering daily logs (optional, requires date)
- `?end=HH:MM` - End time for filtering daily logs (optional, requires date)

## Usage Examples

Get all logs:
```
GET /api/admin/logs
```

Get only current state files:
```
GET /api/admin/logs?type=current
```

Get daily logs for a specific day:
```
GET /api/admin/logs?type=daily&date=2026-08-24
```

Get filtered daily logs for a specific time window:
```
GET /api/admin/logs?type=daily&date=2026-08-24&start=09:00&end=17:00
```

## Security Note

This endpoint has no authentication and relies on the deployment being LAN-only. 
It exposes vehicle location information. If this app is ever put behind a public ingress, 
this route needs an access guard before that happens.