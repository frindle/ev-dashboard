# Vehicle Card — handoff snippet

Source: `EV Dashboard.dc.html` in the EV-Dashboard design project.
This file is the **vehicle card only** — the two cards at the top of the dashboard
(Midknight / R1S on the left, Model 3 on the right) extracted from the full
design. Use it to port the card UI into the Next.js app.

The card is rendered inside a `<sc-for list="{{ vehicles }}" as="v">` loop, so
every `v.*` reference below comes from a per-vehicle computed object built in
`renderVals()` (see "Logic — card-only" further down).

## Vehicle state shape

```js
{
  id: 'rivian' | 'tesla',
  charger: 'LEFT' | 'RIGHT',
  name: string,              // display name e.g. 'Midknight' or 'Model 3'
  model: string,             // e.g. 'R1S · QUAD-MOTOR · LARGE PACK'
  soc: number,               // 0..100, current state of charge
  limit: number,             // 50..100, charge target — user drags the dial
  range: number,             // miles
  odo: number,               // miles
  capacity: number,          // kWh, used only for ETA math
  charging: boolean,
  amps: number,              // explicit per-side amps if the charger reports it
  today: number,             // kWh delivered today (shown in the circuit panel, not the card)
  ctrl: 'full' | 'schedule', // 'full' = OEM exposes start/stop (Tesla Fleet);
                             // 'schedule' = no start/stop (Rivian unofficial)
  apiLabel: string,          // small footer caption
  ac: boolean,               // climate on/off
  locked: boolean,           // door lock
  location: 'home' | 'away',
  place: string,             // human label for non-home location
  speed: number              // mph if driving
}
```

## Template — card markup

> Engine syntax: `{{ path }}` = data lookup, `style="…"` = inline styles
> (React style strings), `<sc-for list as>` = list loop, `<sc-if value>` =
> conditional. Port to JSX as normal: `{v.range}`, `style={{…}}`,
> `vehicles.map(v => …)`, `{v.canStartStop && (…)}`.

```html
<sc-for list="{{ vehicles }}" as="v" hint-placeholder-count="2">
  <div style="background:#161c22;border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:20px 22px;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 44px -30px rgba(0,0,0,.85)">

    <!-- ── header: name + status badge + lock/AC buttons -->
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-direction:{{ v.rowDir }}">
      <div style="display:flex;flex-direction:column;gap:2px;align-items:{{ v.nameAlign }}">
        <span style="font-size:19px;font-weight:600">{{ v.name }}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:10.5px;color:#a4afba;letter-spacing:.03em">{{ v.model }}</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:{{ v.badgeAlign }};gap:8px;flex:none">
        <span style="display:inline-flex;align-items:center;gap:7px;background:{{ v.badgeBg }};color:{{ v.badgeColor }};font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:600;letter-spacing:.06em;padding:6px 12px;border-radius:999px">
          <span style="width:7px;height:7px;border-radius:50%;background:{{ v.badgeDotColor }};animation:{{ v.badgeDotAnim }}"></span>{{ v.badgeLabel }}
        </span>
        <div style="display:flex;gap:8px">
          <button onClick="{{ v.onLock }}" title="{{ v.lockLabel }}" style="appearance:none;cursor:pointer;width:42px;height:42px;border-radius:12px;background:{{ v.lockBg }};border:1px solid rgba(255,255,255,0.06);color:{{ v.lockColor }};display:flex;align-items:center;justify-content:center;padding:0">
            <span style="font-family:'Material Symbols Rounded';font-size:22px;line-height:1">{{ v.lockIcon }}</span>
          </button>
          <button onClick="{{ v.onAc }}" title="{{ v.acLabel }}" style="appearance:none;cursor:pointer;width:42px;height:42px;border-radius:12px;background:{{ v.acBg }};border:1px solid rgba(255,255,255,0.06);color:{{ v.acColor }};display:flex;align-items:center;justify-content:center;padding:0">
            <span style="font-family:'Material Symbols Rounded';font-size:23px;line-height:1;animation:acspin 2.4s linear infinite;animation-play-state:{{ v.acPlay }}">mode_fan</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ── middle: dial + 2x2 stats grid (mirrored: RANGE/TARGET hug the dial) -->
    <div style="display:flex;gap:22px;align-items:center;flex-direction:{{ v.rowDir }}">
      <svg width="128" height="128" viewBox="0 0 120 120"
           onPointerDown="{{ v.onDialDown }}" onPointerMove="{{ v.onDialMove }}" onPointerUp="{{ v.onDialUp }}"
           style="flex:none;cursor:grab;touch-action:none">
        <!-- track -->
        <circle cx="60" cy="60" r="52" fill="none" stroke="#222b34" stroke-width="9"></circle>
        <!-- soc arc (rotate -90 so 0% is at 12 o'clock) -->
        <g transform="rotate(-90 60 60)">
          <circle cx="60" cy="60" r="52" fill="none" stroke="{{ accent }}" stroke-width="9"
                  stroke-linecap="round" stroke-dasharray="326.726" stroke-dashoffset="{{ v.valueOffset }}"></circle>
        </g>
        <!-- charge-limit tick (radial line that crosses the arc) -->
        <line x1="{{ v.tickX1 }}" y1="{{ v.tickY1 }}" x2="{{ v.tickX2 }}" y2="{{ v.tickY2 }}"
              stroke="#e2685f" stroke-width="3" stroke-linecap="round"></line>
        <text x="60" y="48" text-anchor="middle" style="font-family:'JetBrains Mono',monospace;font-size:7px;letter-spacing:.22em;fill:#a4afba">CHARGE</text>
        <text x="60" y="68" text-anchor="middle" style="font-family:'Space Grotesk',sans-serif;font-size:24px;font-weight:600;fill:#e8edf2">{{ v.soc }}%</text>
        <text x="60" y="82" text-anchor="middle" style="font-family:'JetBrains Mono',monospace;font-size:7px;letter-spacing:.18em;fill:#e2685f">LIMIT {{ v.limit }}%</text>
      </svg>

      <!-- 2x2 stats. grid-auto-flow:dense + explicit grid-column on each cell
           makes the columns mirror so RANGE + TARGET always sit next to the dial.
           Per-vehicle vi==0 (left card, dial on right) uses colInside=2/colOutside=1;
           vi==1 (right card, dial on left) uses colInside=1/colOutside=2. -->
      <div style="display:grid;grid-template-columns:1fr 1fr;grid-auto-flow:dense;gap:13px 18px;flex:1;text-align:{{ v.statsTextAlign }}">
        <div style="display:flex;flex-direction:column;gap:2px;grid-column:{{ v.colInside }}">
          <span style="font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;color:#7d8893">RANGE LEFT</span>
          <span style="font-size:17px;font-weight:600">{{ v.range }} <span style="font-size:11px;color:#a4afba;font-weight:500">mi</span></span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;grid-column:{{ v.colOutside }}">
          <span style="font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;color:#7d8893">ODOMETER</span>
          <span style="font-size:17px;font-weight:600">{{ v.odoLabel }} <span style="font-size:11px;color:#a4afba;font-weight:500">mi</span></span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;grid-column:{{ v.colInside }}">
          <span style="font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;color:#7d8893">TARGET</span>
          <span style="font-size:17px;font-weight:600">{{ v.limit }}%</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;grid-column:{{ v.colOutside }}">
          <span style="font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;color:#7d8893">CHARGE RATE</span>
          <span style="font-size:17px;font-weight:600">{{ v.rateLabel }}</span>
        </div>
      </div>
    </div>

    <!-- ── footer: start/stop (only for ctrl:'full') + eta line + small caption -->
    <div style="display:flex;flex-direction:column;gap:11px;border-top:1px solid rgba(255,255,255,0.05);padding-top:14px">
      <div style="display:flex;align-items:center;gap:12px;flex-direction:{{ v.footerDir }}">
        <sc-if value="{{ v.canStartStop }}" hint-placeholder-val="{{ true }}">
          <!-- NOTE: both Start (accent fill) and Stop (transparent w/ red outline)
               carry the same 1px border so the card doesn't reflow on toggle. -->
          <button onClick="{{ v.onToggle }}"
                  style="appearance:none;cursor:pointer;flex:none;padding:10px 18px;border-radius:11px;
                         background:{{ v.btnBg }};border:{{ v.btnBorder }};color:{{ v.btnColor }};
                         font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:600">{{ v.btnLabel }}</button>
        </sc-if>
        <sc-if value="{{ v.scheduleOnly }}" hint-placeholder-val="{{ true }}">
          <span style="flex:none;padding:10px 14px;border-radius:11px;background:#1b232b;border:1px dashed rgba(255,255,255,0.12);color:#a4afba;font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.04em">SCHEDULE ONLY</span>
        </sc-if>
        <span style="display:inline-flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:11.5px;font-weight:600;letter-spacing:.04em;color:{{ v.etaColor }}">
          <span style="width:6px;height:6px;border-radius:50%;background:{{ v.etaColor }}"></span>{{ v.etaLabel }}
        </span>
      </div>
      <span style="font-family:'JetBrains Mono',monospace;font-size:8.5px;letter-spacing:.14em;color:#5e6873;text-align:{{ v.sourceAlign }}">{{ v.limitNote }} · DRAG DIAL · SOURCE {{ v.apiLabel }}</span>
    </div>
  </div>
</sc-for>
```

## Logic — card-only

These are the helpers + the slice of `renderVals()` that builds the `v.*`
fields the template above consumes. `accent` is the deck-wide accent color
(default `#34e0c4`); `C = 326.726` is the SVG dial circumference (`2π * r=52`).

```js
// ── helpers (instance methods) ───────────────────────────────
fmtEta(min) {
  if (min <= 0) return 'AT TARGET';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m TO TARGET` : `${m}m TO TARGET`;
}

// 240 V circuit assumed throughout
kwFor(amps) { return amps * 240 / 1000; }

// Drag handler for the SVG dial — clamps target to 50..100% in 5% steps.
dialSet(e, vehId) {
  const svg = e.currentTarget;
  const r = svg.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  let ang = Math.atan2(dx, -dy);          // clockwise from 12 o'clock
  if (ang < 0) ang += Math.PI * 2;
  let pct = ang / (Math.PI * 2) * 100;
  pct = Math.max(50, Math.min(100, Math.round(pct / 5) * 5));
  this.setState(s => ({ vehicles: s.vehicles.map(x =>
    x.id === vehId ? { ...x, limit: pct } : x) }));
}

// ── card-row builder, called from renderVals() ──────────────
buildVehicleRows(vehicles, opts) {
  const { accent, accentSoft = 'rgba(52,224,196,0.16)', C = 326.726, alloc, etaFor } = opts;

  return vehicles.map((veh, vi) => {
    const charging     = veh.charging;
    const atHome       = veh.location === 'home';
    const chargingHome = charging && atHome;
    const a            = alloc(veh);                 // { amps, kw }
    const etaMin       = etaFor(veh, a.kw);

    // ── status badge text/color
    let badgeLabel, badgeAccent, badgePulse;
    if      (chargingHome) { badgeLabel = 'CHARGING';        badgeAccent = true;  badgePulse = true;  }
    else if (charging)     { badgeLabel = 'CHARGING · AWAY'; badgeAccent = true;  badgePulse = true;  }
    else if (!atHome)      { badgeLabel = 'AWAY';            badgeAccent = false; badgePulse = false; }
    else                   { badgeLabel = 'IDLE';            badgeAccent = false; badgePulse = false; }

    return {
      ...veh,
      charging, chargingHome, idle: !charging,

      // status pill
      badgeLabel,
      badgeColor:    badgeAccent ? accent     : '#a4afba',
      badgeBg:       badgeAccent ? accentSoft : '#1b232b',
      badgeDotColor: badgeAccent ? accent     : '#7d8893',
      badgeDotAnim:  badgePulse  ? 'evpulse 1.8s ease-in-out infinite' : 'none',

      // mirroring — vi===0 is the LEFT card (dial on right side of the row)
      rowDir:         vi === 0 ? 'row-reverse' : 'row',
      statsTextAlign: vi === 0 ? 'right'       : 'left',
      colInside:      vi === 0 ? 2 : 1,    // RANGE + TARGET column
      colOutside:     vi === 0 ? 1 : 2,    // ODOMETER + CHARGE RATE column
      badgeAlign:     vi === 0 ? 'flex-start' : 'flex-end',
      nameAlign:      vi === 0 ? 'flex-end'   : 'flex-start',
      footerDir:      vi === 0 ? 'row'        : 'row-reverse',
      sourceAlign:    vi === 0 ? 'left'       : 'right',

      // stats
      odoLabel:  veh.odo.toLocaleString('en-US'),
      rateLabel: chargingHome ? a.kw.toFixed(1) + ' kW' : (charging ? 'away' : '—'),

      // dial geometry (circle radius 52; offset = C - C*(soc/100))
      valueOffset: C - C * (veh.soc / 100),
      tickX1: (60 + 43 * Math.sin((veh.limit / 100) * Math.PI * 2)).toFixed(2),
      tickY1: (60 - 43 * Math.cos((veh.limit / 100) * Math.PI * 2)).toFixed(2),
      tickX2: (60 + 61 * Math.sin((veh.limit / 100) * Math.PI * 2)).toFixed(2),
      tickY2: (60 - 61 * Math.cos((veh.limit / 100) * Math.PI * 2)).toFixed(2),

      onDialDown: (e) => { this._dragId = veh.id; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {} this.dialSet(e, veh.id); },
      onDialMove: (e) => { if (this._dragId === veh.id) this.dialSet(e, veh.id); },
      onDialUp:   ()  => { this._dragId = null; },

      // footer eta / status line
      etaLabel: chargingHome ? this.fmtEta(etaMin)
              : (!atHome && charging) ? 'CHARGING AWAY · ' + veh.place
              : !atHome                ? (veh.speed > 0
                                          ? 'DRIVING ' + veh.speed + ' mph · ' + veh.place
                                          : 'PARKED · ' + veh.place)
              :                         (veh.soc >= veh.limit ? 'AT TARGET' : 'IDLE · NOT PLUGGED IN'),
      etaColor: charging ? accent : '#7d8893',

      // start/stop button — only OEMs with a real control API
      canStartStop: veh.ctrl === 'full',
      scheduleOnly: veh.ctrl === 'schedule',
      apiLabel:     veh.apiLabel,
      limitNote:    veh.ctrl === 'full' ? 'CHARGE LIMIT' : 'CHARGE LIMIT · VIA SCHEDULE',

      btnLabel:  charging ? 'Stop' : 'Start',
      btnBg:     charging ? 'transparent' : accent,
      // both states keep a 1px border so the card doesn't reflow on toggle
      btnBorder: charging ? '1px solid rgba(226,104,95,.5)' : '1px solid transparent',
      btnColor:  charging ? '#e2685f' : '#08231f',
      onToggle:  () => this.setState(s => ({
        vehicles: s.vehicles.map(x => x.id === veh.id ? { ...x, charging: !x.charging } : x)
      })),

      // climate + lock quick toggles
      acOn:      veh.ac,
      acLabel:   veh.ac ? 'AC on' : 'AC off',
      acBg:      veh.ac ? 'rgba(52,224,196,0.16)' : '#1b232b',
      acColor:   veh.ac ? accent : '#a4afba',
      acPlay:    veh.ac ? 'running' : 'paused',
      onAc:      () => this.setState(s => ({ vehicles: s.vehicles.map(x => x.id === veh.id ? { ...x, ac: !x.ac } : x) })),

      locked:    veh.locked,
      lockIcon:  veh.locked ? 'lock' : 'lock_open',
      lockBg:    veh.locked ? '#1b232b' : 'rgba(226,104,95,0.16)',
      lockColor: veh.locked ? '#a4afba' : '#e2685f',
      lockLabel: veh.locked ? 'Locked' : 'Unlocked',
      onLock:    () => this.setState(s => ({ vehicles: s.vehicles.map(x => x.id === veh.id ? { ...x, locked: !x.locked } : x) }))
    };
  });
}
```

## Design tokens used by the card

| token                       | value                             | role |
|---|---|---|
| background                  | `#0e1216`                         | page |
| card surface                | `#161c22`                         | card bg |
| card border                 | `rgba(255,255,255,0.06)`          | hairline |
| primary text                | `#e8edf2`                         | name, big numbers |
| secondary text              | `#d3dae1`                         | "Connected" / sub heads |
| tertiary text               | `#a4afba`                         | units, supporting labels |
| muted text                  | `#7d8893`                         | small caps labels |
| caption                     | `#5e6873`                         | footer source line |
| accent (charging / OK)      | `#34e0c4`                         | dial arc, charging badge, ETA pulse |
| accent soft                 | `rgba(52,224,196,0.16)`           | pill bg when charging |
| alert / charge-limit / Stop | `#e2685f`                         | dial tick, Stop button, unlocked |
| Stop button border          | `rgba(226,104,95,0.5)`            | |
| Unlocked button bg          | `rgba(226,104,95,0.16)`           | |
| corners                     | 20px (card), 12px (icon buttons), 11px (primary button), 999px (pill) | |
| fonts                       | "Space Grotesk" (UI), "JetBrains Mono" (labels/numbers), "Material Symbols Rounded" (icons) | |

## Notes for the port

- **Mirrored layout** is driven by per-row `rowDir`, `statsTextAlign`, `colInside`/`colOutside`, etc. Don't add a separate `<LeftCard>` / `<RightCard>` — keep one `<VehicleCard side="left"|"right">` component.
- The **dial limit tick** is a single SVG `<line>` from r=43 to r=61 along the angle `2π * (limit/100)`, drawn after the `<g rotate(-90)>` so it sits in the un-rotated coordinate space (12 o'clock = `limit=0`).
- The **charge-limit drag** uses pointer capture on the SVG and `atan2(dx, -dy)` to convert pointer position to 0..2π clockwise from 12 o'clock, then clamps to 50..100% in 5% steps.
- **Start/Stop button** must carry a `1px solid transparent` border in the Start state, otherwise the card height jumps 2px on toggle. Don't remove this.
- `ctrl:'schedule'` (Rivian unofficial API) renders a `SCHEDULE ONLY` chip instead of a Start/Stop button.
- The card receives a per-vehicle `amps` and `kw` from the parent's circuit allocator (`alloc(veh)`); the card itself doesn't decide how the shared 48 A circuit is split. Keep that math in the parent.
