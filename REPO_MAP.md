# REPO_MAP

Auto-generated localization aid for this diagnosis. Consult this FIRST to find WHERE code lives, then open only the few files you need. Do not grep blind -- grep only to confirm a location this map already points to.

## Symbol index (file -> exported / top-level symbols)

### (root)
- `instrumentation.ts`: register (fn)
- `next.config.ts`: default (export)

### app
- `app/layout.tsx`: metadata (const), RootLayout (fn)
- `app/page.tsx`: Dashboard (fn)

### app/12.3display
- `app/12.3display/page.tsx`: Dashboard (fn)

### app/14display
- `app/14display/page.tsx`: Dashboard (fn)

### app/admin
- `app/admin/page.tsx`: AdminPage (fn)

### app/api/admin/api-stats
- `app/api/admin/api-stats/route.ts`: dynamic (const), GET (fn)

### app/api/admin/charge-stats
- `app/api/admin/charge-stats/route.ts`: dynamic (const), GET (fn)

### app/api/admin/logs
- `app/api/admin/logs/route.ts`: dynamic (const), GET (fn)

### app/api/admin/raw-state
- `app/api/admin/raw-state/route.ts`: dynamic (const), GET (fn)

### app/api/admin/wc-diagnostics
- `app/api/admin/wc-diagnostics/route.ts`: dynamic (const), GET (fn)

### app/api/camera/stream
- `app/api/camera/stream/route.ts`: dynamic (const), GET (fn)

### app/api/config
- `app/api/config/route.ts`: dynamic (const), GET (fn), POST (fn)

### app/api/dashboard
- `app/api/dashboard/route.ts`: dynamic (const), GET (fn)

### app/api/dashboard/cached
- `app/api/dashboard/cached/route.ts`: dynamic (const), GET (fn)

### app/api/energy
- `app/api/energy/route.ts`: dynamic (const), GET (fn)

### app/api/errors
- `app/api/errors/route.ts`: dynamic (const), POST (fn)

### app/api/nvr/clips
- `app/api/nvr/clips/route.ts`: dynamic (const), GET (fn)

### app/api/rivian/auth
- `app/api/rivian/auth/route.ts`: dynamic (const), POST (fn), GET (fn)

### app/api/rivian/auth/reconnect
- `app/api/rivian/auth/reconnect/route.ts`: dynamic (const), POST (fn)

### app/api/rivian/otp
- `app/api/rivian/otp/route.ts`: dynamic (const), POST (fn)

### app/api/rivian/resolve-vehicle
- `app/api/rivian/resolve-vehicle/route.ts`: dynamic (const), POST (fn)

### app/api/solaredge/live
- `app/api/solaredge/live/route.ts`: dynamic (const), GET (fn)

### app/api/tesla-public-key
- `app/api/tesla-public-key/route.ts`: dynamic (const), GET (fn)

### app/api/tesla/command
- `app/api/tesla/command/route.ts`: dynamic (const), POST (fn)

### app/api/tesla/wall-connectors
- `app/api/tesla/wall-connectors/route.ts`: dynamic (const), GET (fn)

### app/api/vacation
- `app/api/vacation/route.ts`: dynamic (const), GET (fn), POST (fn)

### app/api/version
- `app/api/version/route.ts`: dynamic (const), GET (fn)

### app/auth/callback
- `app/auth/callback/route.ts`: dynamic (const), GET (fn)

### components
- `components/FirefoxInputGuard.tsx`: FirefoxInputGuard (fn)
- `components/MapTile.tsx`: MapTile (fn)
- `components/MapTile12.tsx`: MapTile12 (fn)
- `components/MapTile14.tsx`: MapTile14 (fn)
- `components/VehicleCard.tsx`: GlobalKeyframes (const), buildChipsFor (fn), buildTopBanners (fn), AuthBanners (const), kwFor (const), fmtEta (fn), dialSetFromPointer (fn), VehicleCard (const)

### lib
- `lib/apiLog.ts`: logApiCall (fn), logApiBody (fn), loggedFetch (fn), readApiCalls (fn)
- `lib/chargeHistory.ts`: readChargeHistory (fn), appendChargeHistory (fn)
- `lib/circuitStatus.ts`: circuitStatus (fn)
- `lib/config.ts`: readConfig (fn), writeConfig (fn), readTokens (fn), writeTokens (fn)
- `lib/ecobee-sync.ts`: syncEcobeeVacation (fn)
- `lib/feedFreshness.ts`: FEED_ERROR_THRESHOLD (const), shouldShowFeedError (fn)
- `lib/gasPrice.ts`: GAS_PRICE_LABEL (const), fetchGasPriceUsdPerGallon (fn)
- `lib/logger.ts`: logError (fn)
- `lib/notifications.ts`: notifyFlagChanges (fn)
- `lib/pushover.ts`: pushoverConfigured (fn), sendPush (fn)
- `lib/rates.ts`: RATE_SCHEDULE_LABEL (const), touBucketFor (fn), ratePerKwh (fn), sessionElectricityCostUsd (fn), COMPARABLES (const)
- `lib/ratgdo.ts`: readGarageDoorState (fn)
- `lib/rawState.ts`: redact (fn), readRivianRaw (fn), readTeslaRaw (fn)
- `lib/reolink.ts`: getMonthStatus (fn), getDayClips (fn), buildPlaybackUrl (fn)
- `lib/rivian.ts`: checkRivianSessionAge (fn), noteRivianAuthRefreshed (fn), rivianApiDegraded (fn), readRivianParallaxState (fn), applyParallaxToRivianState (fn), readRivianTokens (fn), writeRivianTokens (fn), rivianLogin (fn), rivianLoginOtp (fn), reresolveVehicleId (fn), mapRawVehicleState (fn), fetchRivianVehicleState (fn), ...(+10 more)
- `lib/sessionFlags.ts`: readFlags (fn), writeFlags (fn), markTeslaReauthRequired (fn), clearTeslaReauthRequired (fn), markTeslaApiForbidden (fn), clearTeslaApiForbidden (fn), markRivianReauthRequired (fn), markRivianReauthDueSoon (fn), clearRivianReauthFlags (fn), shouldPushOncePerLapse (fn), shouldPushDueSoonOnce (fn), shouldPushOtaOnce (fn), ...(+4 more)
- `lib/solaredge-web.ts`: readSolarWebLive (fn)
- `lib/solaredge.ts`: readSolarLive (fn)
- `lib/tesla.ts`: resetCircuitBreaker (fn), getCircuitBreakerRetryMinutes (fn), fetchVehicleState (fn), fetchWallConnectorVitals (fn), fetchWallConnectorList (fn), verifyEnergySiteId (fn), wakeVehicle (fn), setChargeLimit (fn), startCharging (fn), stopCharging (fn), lockDoors (fn), unlockDoors (fn), ...(+3 more)
- `lib/vacation.ts`: VACATION_LOCATION_STATE_KEYS (const), redactDashboardLocation (fn), scrubRawLocation (fn)
- `lib/wcDiagnostics.ts`: logWcDiagnostic (fn), readWcDiagnostics (fn)

## Computation digest (where quantities/totals/counts are computed)

Grep-built list of sums/reduces/totals -- the classic 'where is X computed' hits. file:line -> code.

- `app/page.tsx:70` -> `const total = Math.round(min);`
- `app/page.tsx:71` -> `const h = Math.floor(total / 60), m = total % 60;`
- `app/page.tsx:526` -> `if (!res.ok) { feedErrorCount.current += 1; if (shouldShowFeedError(feedErrorCount.current)) { setFe`
- `app/page.tsx:532` -> `feedErrorCount.current += 1; if (shouldShowFeedError(feedErrorCount.current)) { setFeedState('error'`
- `app/page.tsx:610` -> `// Strict: only count vehicles with explicit positive home GPS. The earlier`
- `app/page.tsx:616` -> `const vehiclesHome = vehicles.filter(v => v.connected && v.atHome === true).length;`
- `app/page.tsx:712` -> `const bothAway = vehicles.length > 0 && vehicles.every(veh => veh.atHome === false);`
- `app/14display/page.tsx:95` -> `const total = Math.round(min);`
- `app/14display/page.tsx:96` -> `const h = Math.floor(total / 60), m = total % 60;`
- `app/14display/page.tsx:152` -> `const weekTotal = series.reduce((sum, v) => sum + v.dailyKwh.reduce((a, b) => a + b, 0), 0);`
- `app/14display/page.tsx:154` -> `const groupW = days.length ? W / days.length : W;`
- `app/14display/page.tsx:155` -> `const barW = Math.max(3, (groupW - 8) / Math.max(1, series.length) - PAD);`
- `app/14display/page.tsx:162` -> `{weekTotal.toFixed(1)} kWh total`
- `app/14display/page.tsx:166` -> `{days.length === 0 ? (`
- `app/14display/page.tsx:193` -> `{days[0]?.slice(5)} → {days[days.length - 1]?.slice(5)} · PEAK {peak.toFixed(1)} kWh/DAY`
- `app/14display/page.tsx:244` -> `{energy?.vehicles.length ? ' · vs ' + energy.vehicles.map(v => `${v.comparable} (${v.mpg} mpg)`).joi`
- `app/14display/page.tsx:679` -> `if (!res.ok) { feedErrorCount.current += 1; if (shouldShowFeedError(feedErrorCount.current)) { setFe`
- `app/14display/page.tsx:685` -> `feedErrorCount.current += 1; if (shouldShowFeedError(feedErrorCount.current)) { setFeedState('error'`
- `app/14display/page.tsx:763` -> `// Strict: only count vehicles with explicit positive home GPS. The earlier`
- `app/14display/page.tsx:769` -> `const vehiclesHome = vehicles.filter(v => v.connected && v.atHome === true).length;`
- `app/14display/page.tsx:864` -> `const bothAway = vehicles.length > 0 && vehicles.every(veh => veh.atHome === false);`
- `app/admin/page.tsx:590` -> `: wcDiscovered.length > 0 ? `${wcDiscovered.length} wall connector${wcDiscovered.length !== 1 ? 's' `
- `app/admin/page.tsx:1303` -> `{!stats || stats.vehicles.length === 0 ? (`
- `app/api/energy/route.ts:54` -> `monthLabel: string;          // local YYYY-MM the savings total covers`
- `app/api/energy/route.ts:138` -> `daily[idFor(r)][i] += r.energyKwh;`
- `app/api/energy/route.ts:158` -> `if (t >= sixMoCutoff) sixMoKwh[id] += r.energyKwh;`
- `app/api/energy/route.ts:207` -> `monthKwh += r.energyKwh;`
- `app/api/energy/route.ts:208` -> `monthElectricityUsd += p.electricityUsd;`
- `app/api/energy/route.ts:209` -> `if (p.gasEquivalentUsd !== null) { monthGasEquivalentUsd += p.gasEquivalentUsd; anyGasPriced = true;`
- `app/api/admin/api-stats/route.ts:13` -> `//   total, ok, error counts and rate/min`
- `app/api/admin/api-stats/route.ts:40` -> `totalCalls: recs.length,`
- `app/api/admin/api-stats/route.ts:46` -> `const total = list.length;`
- `app/api/admin/api-stats/route.ts:51` -> `const endpoint: Record<string, { total: number; ok: number; errors: number }> = {};`
- `app/api/admin/api-stats/route.ts:59` -> `const ep = endpoint[r.endpoint] ??= { total: 0, ok: 0, errors: 0 };`
- `app/api/admin/api-stats/route.ts:60` -> `ep.total++;`
- `app/api/admin/api-stats/route.ts:67` -> `const p = (q: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(late`
- `app/api/admin/api-stats/route.ts:69` -> `total,`
- `app/api/admin/api-stats/route.ts:71` -> `errors: total - ok,`
- `app/api/admin/api-stats/route.ts:72` -> `errorRate: total ? +(1 - ok / total).toFixed(3) : 0,`
- `app/api/admin/api-stats/route.ts:73` -> `callsPerMin: +(total / (hours * 60)).toFixed(2),`
- `app/api/admin/api-stats/route.ts:74` -> `backoffActiveFraction: total ? +(backoffActive / total).toFixed(3) : 0,`
- `app/api/admin/api-stats/route.ts:79` -> `Object.entries(endpoint).sort(([, a], [, b]) => b.total - a.total),`
- `app/api/admin/charge-stats/route.ts:58` -> `totalKwh += r.energyKwh;`
- `app/api/admin/charge-stats/route.ts:61` -> `agg.sessions += 1;`
- `app/api/admin/charge-stats/route.ts:70` -> `totalSessions: list.length,`
- `app/api/admin/charge-stats/route.ts:73` -> `avgSessionKwh: list.length ? Math.round((totalKwh / list.length) * 100) / 100 : 0,`
- `app/api/admin/wc-diagnostics/route.ts:16` -> `count: number; minCurrentA: number; maxCurrentA: number; minPowerW: number; maxPowerW: number;`
- `app/api/admin/wc-diagnostics/route.ts:27` -> `count: 1, minCurrentA: r.currentA, maxCurrentA: r.currentA,`
- `app/api/admin/wc-diagnostics/route.ts:31` -> `g.count++;`
- `app/api/admin/wc-diagnostics/route.ts:42` -> `totalRows: rows.length,`
- `app/api/tesla/wall-connectors/route.ts:20` -> `if (apiList.length > 0) {`
- `app/api/dashboard/route.ts:529` -> `// accumulate into per-side session + today buckets. Persisted in keys/`
- `app/api/dashboard/route.ts:606` -> `// — otherwise nothing would ever count as unchanged.`
- `app/12.3display/page.tsx:94` -> `const total = Math.round(min);`
- `app/12.3display/page.tsx:95` -> `const h = Math.floor(total / 60), m = total % 60;`
- `app/12.3display/page.tsx:561` -> `if (!res.ok) { feedErrorCount.current += 1; if (shouldShowFeedError(feedErrorCount.current)) { setFe`
- `app/12.3display/page.tsx:567` -> `feedErrorCount.current += 1; if (shouldShowFeedError(feedErrorCount.current)) { setFeedState('error'`
- `app/12.3display/page.tsx:645` -> `// Strict: only count vehicles with explicit positive home GPS. The earlier`
- `app/12.3display/page.tsx:651` -> `const vehiclesHome = vehicles.filter(v => v.connected && v.atHome === true).length;`
- `app/12.3display/page.tsx:664` -> `const bothAway = vehicles.length > 0 && vehicles.every(v => v.atHome === false);`
