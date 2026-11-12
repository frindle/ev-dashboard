// Shifts around a night, to fix a conflict on the calendar: lists the shifts
// for ?day=<days since 1970-01-01> (and the day before) with an Ignore button
// each. Ignored events are skipped by the charge plan (lib/shiftChoices.ts).
import { getShiftCalendar } from '@/lib/shiftCalendar';
import { readIgnored } from '@/lib/shiftChoicesStore';
import { localDayNumber } from '@/lib/chargePlan';

export const dynamic = 'force-dynamic';

const fmt = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export default async function ShiftsPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const q = await searchParams;
  const parsed = Number(q.day);
  const day = Number.isInteger(parsed) && parsed > 0 ? parsed : localDayNumber(Date.now()) + 1;
  const cal = await getShiftCalendar();
  const ignored = await readIgnored();
  const shifts = (cal?.shifts ?? []).filter((s) => s.day === day || s.day === day - 1);
  return (
    <main style={{ maxWidth: 560, margin: '24px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}>
      <h1 style={{ fontSize: 20 }}>Shifts for the night before {new Date(day * 86_400_000).toISOString().slice(0, 10)}</h1>
      {!shifts.length && <p>No shifts on the calendar for these days.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {shifts.map((s, i) => (
          <li key={s.uid ?? i} style={{ margin: '12px 0', padding: 12, border: '1px solid #374151', borderRadius: 8 }}>
            {fmt(s.startMs)} to {fmt(s.endMs)}
            {s.uid && ignored.has(s.uid) ? (
              <span> (ignored)</span>
            ) : s.uid ? (
              <form method="post" action="/api/shifts/choice" style={{ display: 'inline', marginLeft: 12 }}>
                <input type="hidden" name="uid" value={s.uid} />
                <input type="hidden" name="action" value="ignore" />
                <button type="submit">Ignore this shift</button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: 13, opacity: 0.7 }}>Deleting the event itself needs calendar write access, not set up yet.</p>
    </main>
  );
}
