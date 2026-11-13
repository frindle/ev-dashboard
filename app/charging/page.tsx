// /charging: the coming two weeks of Rivian charging as the plan sees them today (Penn 11-12):
// forecast driving per day (adjustable: miles or %), the night before each day (plug in or not,
// amps, how much, morning and arrival level), and the battery over the whole stretch. Night 0 is
// the controller's real plan; later nights are a projection (lib/chargeCalendar.ts).
// Same access model as /trips: no login, LAN only. Typed needs go to /api/trips/choice.
import Link from 'next/link';
import { chargeCalendarView, viewDays, type CalDay, type ChargeCalendarView } from '@/lib/chargeCalendarRun';
import { localDayNumber } from '@/lib/chargePlan';
import { summarize } from '@/lib/planScore';
import { readScores } from '@/lib/planScoreStore';
import { SocChart } from './SocChart';

export const dynamic = 'force-dynamic';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pct = (n: number | null) => (n === null ? '?' : `${Math.round(n)}%`);
const signed = (n: number | null) => (n === null ? 'n/a' : `${n > 0 ? '+' : ''}${Math.round(n)}%`);
const clock = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function Header({ v }: { v: ChargeCalendarView }) {
  const h = v.header;
  return (
    <section className="cc-head" aria-label="Right now">
      <div className="cc-stat"><span className="cc-k">Car</span><span className="cc-v mono">{pct(h.socPct)}{h.limitPct !== null ? ` of ${h.limitPct}% limit` : ''}</span><span className="cc-s">{h.plugged === null ? 'plug state unknown' : h.plugged ? (h.charging ? 'plugged in, charging' : 'plugged in') : 'not plugged in'}</span></div>
      <div className="cc-stat">
        <span className="cc-k">Tonight{h.serveLabel ? `, for ${h.serveLabel}` : ''}</span>
        {v.planKnown ? <>
          <span className="cc-v mono">{h.plugIn === null ? 'plug-in unknown' : h.plugIn ? `Plug in${h.amps ? `, ${h.amps}A` : ''}` : 'No plug-in needed'}</span>
          <span className="cc-s mono">{h.windowLabel ? `${h.windowLabel} (${h.windowHours?.toFixed(1)}h)` : 'no charge window'}{h.addPct !== null && h.plugIn ? ` · +${Math.round(h.addPct)}% · ${h.kwh?.toFixed(1)} kWh` : ''}</span>
        </> : <span className="cc-s">No plan yet: not enough charge history.</span>}
      </div>
      <div className="cc-stat"><span className="cc-k">Schedule control</span><span className="cc-v">{h.controlOn ? 'On, the plan is written to the car' : 'Off, show only'}</span>
        <span className="cc-s">{h.override ? `${h.override.auto ? 'Trip' : 'Override'}: ${h.override.targetPct}% by ${clock(h.override.byMs)}` : 'No override active'}</span></div>
      {(h.raiseLimitTo !== null || h.shortfall) && (
        <p className="cc-warn">{h.raiseLimitTo !== null ? `Raise the charge limit to ${h.raiseLimitTo}% in the Rivian app. ` : ''}{h.shortfall ? 'The window is too short to cover the need.' : ''}</p>
      )}
    </section>
  );
}

function Need({ d }: { d: CalDay }) {
  return (
    <div className="cc-need">
      <form method="post" action="/api/trips/choice">
        <input type="hidden" name="kind" value="need" />
        <input type="hidden" name="day" value={d.day} />
        <input name="value" type="number" inputMode="decimal" min={1} max={600} step={1} required aria-label={`Driving on ${d.label}`} placeholder={d.miles !== null ? String(d.miles) : ''} defaultValue={d.typed?.value ?? ''} />
        <select name="unit" aria-label="Unit" defaultValue={d.typed?.unit ?? 'mi'}>
          <option value="mi">mi</option>
          <option value="pct">%</option>
        </select>
        <button type="submit">{d.typed ? 'Update' : 'Set'}</button>
      </form>
      {d.typedBelow && <p className="cc-warn">Your {d.typed!.value}{d.typed!.unit === 'pct' ? '%' : ' mi'} is below the forecast, so it is ignored.</p>}
      <p className="cc-note">Raises only: below the forecast is ignored.</p>
      {d.typed && (
        <form method="post" action="/api/trips/choice">
          <input type="hidden" name="kind" value="need" />
          <input type="hidden" name="day" value={d.day} />
          <input type="hidden" name="value" value="" />
          <button type="submit" className="ghost">Clear</button>
        </form>
      )}
    </div>
  );
}

function Night({ d, v }: { d: CalDay; v: ChargeCalendarView }) {
  const n = d.night;
  if (!n) return v.planKnown && d.today ? <p className="cc-night off">The night before has passed.</p> : <p className="cc-night off">No plan: {v.planKnown ? 'no night to plan' : 'not enough history'}.</p>;
  const tag = n.charge === null ? 'Charge unknown' : n.charge ? 'Plug in' : 'No plug-in';
  return (
    <div className={`cc-night${n.charge ? ' on' : ''}`}>
      <p className="cc-night-h"><span className="cc-k">Night before</span> <strong>{tag}</strong></p>
      {n.windowHours <= 0 ? <p className="cc-warn">No charge window</p> : (
        <p className="mono">
          {n.charge && n.amps ? `${n.amps}A · +${Math.round(n.addedPct)}% · ${n.kwh.toFixed(1)} kWh · ` : ''}
          {n.windowHours.toFixed(1)}h{n.windowHours < 6 ? ' (short)' : ''}
        </p>
      )}
      <p className="mono">{pct(n.morningPct)} morning → {pct(n.arrivalPct)} home</p>
      {n.raiseLimitTo !== null && <p className="cc-warn">Raise limit to {n.raiseLimitTo}%</p>}
      {n.shortfall && <p className="cc-warn">Short on charge</p>}
    </div>
  );
}

function Cell({ d, v }: { d: CalDay; v: ChargeCalendarView }) {
  if (!d.inRange && !d.past) return <div className="cc-cell pad" aria-hidden="true" />;
  const badge = d.away ? 'Away' : d.isWork ? 'Work' : 'Off';
  return (
    <section className={`cc-cell${d.past ? ' past' : ''}${d.today ? ' today' : ''}`} id={`day-${d.day}`} aria-label={`${WEEKDAYS[d.weekday]} ${d.label}`}>
      <header>
        <h3><span className="cc-wd">{WEEKDAYS[d.weekday]} </span>{d.label}</h3>
        {d.inRange && <span className={`cc-badge ${badge.toLowerCase()}`}>{badge}</span>}
      </header>
      {d.past && (d.actual
        ? <p className="mono cc-actual">drove {d.actual.miles.toFixed(0)} mi{d.actual.usedPct !== null ? ` · used ${Math.round(d.actual.usedPct)}%` : ''}</p>
        : <p className="cc-note">No record.</p>)}
      {d.inRange && <>
        {d.shiftLabel && <p className="cc-note mono">{d.shiftLabel}</p>}
        <p className="cc-use mono"><strong>{d.away ? 'Away' : d.miles !== null ? `${d.miles} mi` : '?'}</strong>{!d.away && d.usePct !== null ? ` · ${Math.round(d.usePct)}%` : ''}</p>
        <p className="cc-note">{d.source}{d.highF !== null ? ` · ${Math.round(d.highF)}°F` : ''}</p>
        <Need d={d} />
        <Night d={d} v={v} />
      </>}
    </section>
  );
}

// Last 14 days of the plan against what happened (lib/planScoreRun.ts): numbers only.
async function Accuracy() {
  const sum = summarize(await readScores().catch(() => []), localDayNumber(Date.now()) - 14, localDayNumber(Date.now()) - 1);
  return (
    <section className="cc-card" aria-label="Forecast vs actual">
      <h2>Forecast vs actual, last 14 days</h2>
      {sum.days === 0 && sum.peakDays === 0 ? <p className="cc-note">No scored days yet. Each morning scores the day before.</p> : (
        <p className="mono">
          Use error {signed(sum.medianUseErrPct)} median ({sum.days} days)
          {' · '}{sum.shortDays} short {sum.shortDays === 1 ? 'day' : 'days'}
          {' · '}Peak error {signed(sum.medianPeakErrPct)}{sum.peakDays ? ` (${sum.peakDays} days)` : ''}
        </p>
      )}
      <p className="cc-note">Use error: real use vs the plan's expected use (plus means the plan ran low). Short: ended under the arrival floor. Peak error: real day peak vs the forecast; needs the NV usage upload.</p>
    </section>
  );
}

export default async function ChargingPage() {
  const v = await chargeCalendarView(Date.now()).catch(() => null);
  const days = v ? viewDays(v) : [];
  return (
    <div className="cc-page">
      <main className="cc">
        <div className="cc-top">
          <h1>Charging, next 14 days</h1>
          <nav aria-label="Related pages"><Link href="/">Dashboard</Link> <Link href="/trips">Trips</Link></nav>
        </div>
        {!v && <p className="cc-warn">The plan could not be read right now.</p>}
        {v && <>
          <Header v={v} />
          {!v.tripsOn && <p className="cc-note">Trips are off (no personal calendar set), so days use the model only.</p>}
          {v.tripsOn && !v.tripsRead && <p className="cc-warn">The personal calendar could not be read, so trips are not counted.</p>}
          <div className="cc-grid-wrap">
            <div className="cc-dow" aria-hidden="true">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
            {v.weeks.map((w) => <div className="cc-week" key={w[0].day}>{w.map((d) => <Cell key={d.day} d={d} v={v} />)}</div>)}
          </div>
          <Accuracy />
          <section className="cc-card">
            <h2>Battery</h2>
            <SocChart days={days} floorPct={v.floorPct} limitPct={v.limitPct} />
          </section>
          <section className="cc-card">
            <h2>How to read this</h2>
            <p className="cc-note">Tonight's plan is the one the dashboard writes to the car. Later nights are a projection: each night follows the same rule (reach the floor on getting home, at the lowest amps) and assumes you plug in on the nights that say so and leave the car unplugged on the others. Each day uses its expected driving with no margin; the plan adds its 10% margin itself. A number you type is that day's total driving; it only raises the plan, and a number below the forecast is ignored. Trips from the personal calendar are known 7 days out; beyond that days use the work-day or day-off model. Away days are not charged at home, and the level after a trip is not known.</p>
            <p className="cc-note">The same numbers sync to the EV Charge Forecast calendar when it is set up: change the number in an event title there to change the plan.</p>
          </section>
        </>}
        <p className="cc-foot">No login on this page: it is meant for the home network only.</p>
      </main>
    </div>
  );
}
