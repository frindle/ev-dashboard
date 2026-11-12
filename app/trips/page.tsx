// /trips: the next 7 days of personal-calendar trips and how the charge plan
// reads them (EV charge plan #8). Located events per day, the plan result, the
// events that could not be placed (with a search box on the local geocoder),
// the overlap choices, the #home / #straight toggles and the work-location pick.
// Same access model as the rest of the app: no login, LAN only. The page shows
// event places; pushes, logs and Influx never do.
import { personalCalendarOn } from '@/lib/personalCalendar';
import { rivianNightPlan } from '@/lib/rivianNightPlan';
import { computeTrips, type DayView } from '@/lib/tripRun';
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

function Day({ d, focus }: { d: DayView; focus: boolean }) {
  const p = d.plan, a = d.adj;
  const attention = !!p && (p.unplaced.length > 0 || p.overlaps.length > 0 || p.unroutable || p.needsWork);
  return (
    <section className={`trips-day${a?.raise ? ' raise' : ''}${attention ? ' attention' : ''}${focus ? ' focus' : ''}`} id={`day-${d.day}`}>
      <header>
        <h2>{d.dateLabel}</h2>
        <span className="trips-tag">{d.away ? 'Away on a trip' : d.isWork ? 'Work day' : 'Day off'}</span>
      </header>
      {p && a && (
        <p className="trips-result mono">
          {Math.round(p.miles)} mi{p.multiDay ? ' outbound' : ''} · need {Math.round(a.needPct)}%
          {a.raise && p.departMs ? <> · <strong>{Math.round(a.targetPct)}% by {time(p.departMs)}</strong></> : <> · normal plan covers it</>}
        </p>
      )}
      {p?.unroutable && <p className="trips-warn">A route could not be worked out (Valhalla unreachable or no road route). This day is not planned.</p>}
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
    </section>
  );
}

export default async function TripsPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const q = await searchParams;
  const focusDay = Number.isInteger(Number(q.day)) && Number(q.day) > 0 ? Number(q.day) : null;
  const now = Date.now();
  const on = personalCalendarOn();
  const layer = on ? await computeTrips(await rivianNightPlan(now), now).catch(() => null) : null;
  const shown = layer?.days.filter((d) => d.events.length > 0) ?? [];
  return (
    <div className="trips-page">
      <main className="trips">
        <h1>Trips, next 7 days</h1>
        {!on && <p className="trips-note">The personal calendar is not connected. Set PERSONAL_CAL_URL to turn trip planning on.</p>}
        {on && !layer && <p className="trips-warn">The personal calendar could not be read, or the home location is not set.</p>}
        {layer && !shown.length && <p className="trips-note">No events with a location in the next 7 days.</p>}
        {shown.map((d) => <Day key={d.day} d={d} focus={d.day === focusDay} />)}
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
