// /trips: the next 7 days of personal-calendar trips and how the charge plan
// reads them (EV charge plan #8). Located events per day, the plan result, the
// events that could not be placed (with a search box on the local geocoder),
// the overlap choices, the #home / #straight toggles, the work-location pick, a
// typed need for any day (when a place or route cannot be found), and tonight's
// one-off charge override.
// Same access model as the rest of the app: no login, LAN only. The page shows
// event places; pushes, logs and Influx never do.
import { personalCalendarOn } from '@/lib/personalCalendar';
import { rivianNightPlan } from '@/lib/rivianNightPlan';
import { computeTrips, type DayView } from '@/lib/tripRun';
import type { ManualNeed } from '@/lib/tripStore';
import { RivianOverride } from '@/components/RivianOverride';
import PlaceSearch from './PlaceSearch';

export const dynamic = 'force-dynamic';

const time = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function Post({ fields, label, on }: { fields: Record<string, string | number>; label: string; on?: boolean }) {
  return (
    <form method="post" action="/api/trips/choice">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" className={on ? 'on' : undefined} aria-pressed={on}>{label}</button>
    </form>
  );
}

// "This day needs N % / miles": replaces the trip estimate for the day.
function NeedForm({ day, manual, days }: { day?: number; manual: ManualNeed | null; days?: { day: number; label: string }[] }) {
  return (
    <div className="trips-block">
      <form method="post" action="/api/trips/choice" className="trips-need">
        <input type="hidden" name="kind" value="need" />
        {days ? (
          <select name="day" aria-label="Day" defaultValue={days[0]?.day}>
            {days.map((x) => <option key={x.day} value={x.day}>{x.label}</option>)}
          </select>
        ) : <input type="hidden" name="day" value={day} />}
        <input name="value" type="number" inputMode="decimal" min={1} max={600} step={1} required defaultValue={manual?.value ?? ''} aria-label="How much the day needs" placeholder="Needs" />
        <select name="unit" defaultValue={manual?.unit ?? 'pct'} aria-label="Unit">
          <option value="pct">% battery</option>
          <option value="mi">miles</option>
        </select>
        <button type="submit">{manual ? 'Update' : 'Set'}</button>
      </form>
      {manual && day !== undefined && <Post fields={{ kind: 'need', day, value: '' }} label="Clear, use the plan" />}
    </div>
  );
}

function Day({ d, focus }: { d: DayView; focus: boolean }) {
  const p = d.plan, a = d.adj;
  const lost = !!p && (p.unplaced.length > 0 || p.unroutable);
  const attention = !d.manual && !!p && (lost || p.overlaps.length > 0 || p.needsWork);
  return (
    <section className={`trips-day${a?.raise ? ' raise' : ''}${attention ? ' attention' : ''}${focus ? ' focus' : ''}`} id={`day-${d.day}`}>
      <header>
        <h2>{d.dateLabel}</h2>
        <span className="trips-tag">{d.away ? 'Away on a trip' : d.isWork ? 'Work day' : 'Day off'}</span>
      </header>
      {a && (p || d.manual) && (
        <p className="trips-result mono">
          {d.manual ? <>set by you: {d.manual.value}{d.manual.unit === 'pct' ? '%' : ' mi'}</> : <>{Math.round(p!.miles)} mi{p!.multiDay ? ' outbound' : ''}</>} · need {Math.round(a.needPct)}%
          {a.raise && d.byMs ? <> · <strong>{Math.round(a.targetPct)}% by {time(d.byMs)}</strong></> : <> · normal plan covers it</>}
        </p>
      )}
      {p?.unroutable && !d.manual && <p className="trips-warn">A route could not be worked out (map service unreachable or no road route). Set what the day needs below.</p>}
      {p?.needsWork && <p className="trips-warn">Work location unknown, so events on this work day are not added. Pick it below.</p>}
      <ul className="trips-events">
        {d.events.map((e) => (
          <li key={e.uid}>
            <div className="trips-ev-head">
              <span className="mono">{e.allDay ? 'All day' : time(e.startMs)}</span>
              <span>{e.location || 'Map point only'}</span>
            </div>
            {!e.placed && (
              <div className="trips-block">
                <p className="trips-warn">This location could not be placed.</p>
                <PlaceSearch uid={e.uid} initial={e.location} />
              </div>
            )}
            {e.overlap && (
              <div className="trips-block">
                <p>Overlaps your shift.{e.choice === 'skip' ? ' Skipped.' : e.choice === 'going' ? " You're going: counted as a round trip from work." : e.choice === 'fix' ? " You'll fix the calendar: counted as a round trip from work until then." : ' Counted as a round trip from work until you choose.'}</p>
                <div className="trips-buttons">
                  <Post fields={{ kind: 'overlap', uid: e.uid, day: d.day, choice: 'skip' }} label="Skip it" on={e.choice === 'skip'} />
                  <Post fields={{ kind: 'overlap', uid: e.uid, day: d.day, choice: 'going' }} label="I'm going" on={e.choice === 'going'} />
                  <Post fields={{ kind: 'overlap', uid: e.uid, day: d.day, choice: 'fix' }} label="I'll fix the calendar" on={e.choice === 'fix'} />
                </div>
              </div>
            )}
            {e.placed && !e.overlap && !e.multiDay && (
              <div className="trips-buttons" role="group" aria-label="What happens after this stop">
                <Post fields={{ kind: 'toggle', uid: e.uid, day: d.day, value: 'home' }} label="Home after" on={(e.toggle ?? e.tag) === 'home'} />
                <Post fields={{ kind: 'toggle', uid: e.uid, day: d.day, value: 'straight' }} label="Straight on" on={(e.toggle ?? e.tag) === 'straight'} />
                {e.toggle && <Post fields={{ kind: 'toggle', uid: e.uid, day: d.day, value: '' }} label="Use the rule" />}
              </div>
            )}
            {e.multiDay && <p className="trips-note">Multi-day: only the outbound leg is planned. Charging while away is not planned.</p>}
          </li>
        ))}
      </ul>
      <div className={`trips-needbox${lost && !d.manual ? ' attention' : ''}`}>
        <p className={lost && !d.manual ? 'trips-warn' : 'trips-note'}>
          {d.manual ? 'You set what this day needs; it replaces the trip estimate.' : lost ? "Can't find a place? Set what the day needs instead." : 'Or set what this day needs yourself.'}
        </p>
        <NeedForm day={d.day} manual={d.manual} />
      </div>
    </section>
  );
}

export default async function TripsPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const q = await searchParams;
  const focusDay = Number.isInteger(Number(q.day)) && Number(q.day) > 0 ? Number(q.day) : null;
  const now = Date.now();
  const on = personalCalendarOn();
  const layer = on ? await computeTrips(await rivianNightPlan(now), now).catch(() => null) : null;
  const shown = layer?.days.filter((d) => d.events.length > 0 || d.manual) ?? [];
  const others = layer?.days.filter((d) => !d.events.length && !d.manual).map((d) => ({ day: d.day, label: d.dateLabel })) ?? [];
  return (
    <div className="trips-page">
      <main className="trips">
        <h1>Trips, next 7 days</h1>
        {!on && <p className="trips-note">The personal calendar is not connected. Set PERSONAL_CAL_URL to turn trip planning on.</p>}
        {on && !layer && <p className="trips-warn">The personal calendar could not be read, or the home location is not set.</p>}
        {layer && !shown.length && <p className="trips-note">No events with a location in the next 7 days.</p>}
        {shown.map((d) => <Day key={d.day} d={d} focus={d.day === focusDay} />)}
        {layer && others.length > 0 && (
          <section className="trips-day">
            <header><h2>Another day</h2></header>
            <p className="trips-note">A drive that is not on the calendar: set what that day needs.</p>
            <NeedForm manual={null} days={others} />
          </section>
        )}
        <section className="trips-day">
          <header><h2>Tonight's charge</h2></header>
          <p className="trips-note">One charge only: be at N% by a time. This wins over the daily plan and the trips above.</p>
          <RivianOverride />
        </section>
        {layer && (
          <section className="trips-day">
            <header><h2>Work location</h2><span className="trips-tag">{layer.workKnown ? 'Set' : 'Not set'}</span></header>
            <p className="trips-note">Taken from the shift event's location. Pick it once here if the shift events have none.</p>
            <PlaceSearch uid="work" button="Set work" />
          </section>
        )}
        <p className="trips-foot">No login on this page: it is meant for the home network only.</p>
      </main>
    </div>
  );
}
