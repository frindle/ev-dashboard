// Projected battery level over the calendar's days: the morning level and the level on getting
// home, joined into a sawtooth (the night charge is the rise, the day's driving the fall). Inline
// SVG, no client code.
import type { CalDay } from '@/lib/chargeCalendarRun';

const W = 840, H = 240, L = 40, R = 12, T = 14, B = 30;

export function SocChart({ days, floorPct, limitPct }: { days: CalDay[]; floorPct: number | null; limitPct: number | null }) {
  const pts = days.filter((d) => d.night && d.night.morningPct !== null && d.night.arrivalPct !== null);
  if (pts.length < 2) return <p className="cc-note">The battery chart needs the car's charge level, which is not available right now.</p>;
  const n = days.length;
  const cw = (W - L - R) / n;
  const y = (v: number) => T + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - T - B);
  const xAt = (i: number, f: number) => L + (i + f) * cw;
  const line: string[] = [];
  days.forEach((d, i) => {
    const nt = d.night;
    if (!nt || nt.morningPct === null || nt.arrivalPct === null) return;
    line.push(`${xAt(i, 0.15).toFixed(1)},${y(nt.morningPct).toFixed(1)}`, `${xAt(i, 0.85).toFixed(1)},${y(nt.arrivalPct).toFixed(1)}`);
  });
  const low = pts.reduce((m, d) => (d.night!.arrivalPct! < m.night!.arrivalPct! ? d : m), pts[0]);
  const label = `Projected battery level for the next ${n} days, morning and on getting home. Lowest on getting home: ${Math.round(low.night!.arrivalPct!)}% on ${low.label}.`;
  return (
    <figure className="cc-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
        <title>{label}</title>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line className="cc-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text className="cc-axis" x={L - 6} y={y(v) + 4} textAnchor="end">{v}%</text>
          </g>
        ))}
        {floorPct !== null && <>
          <line className="cc-floor" x1={L} x2={W - R} y1={y(floorPct)} y2={y(floorPct)} />
          <text className="cc-floor-t" x={W - R} y={y(floorPct) - 4} textAnchor="end">{floorPct}% floor</text>
        </>}
        {limitPct !== null && <>
          <line className="cc-limit" x1={L} x2={W - R} y1={y(limitPct)} y2={y(limitPct)} />
          <text className="cc-limit-t" x={W - R} y={y(limitPct) - 4} textAnchor="end">limit {limitPct}%</text>
        </>}
        <polyline className="cc-soc" points={line.join(' ')} fill="none" />
        {days.map((d, i) => d.night && d.night.morningPct !== null && (
          <circle key={d.day} className={d.night.charge ? 'cc-dot on' : 'cc-dot'} cx={xAt(i, 0.15)} cy={y(d.night.morningPct)} r={4}>
            <title>{`${d.label}: ${d.night.charge ? 'charge' : 'no charge'}, ${Math.round(d.night.morningPct)}% in the morning`}</title>
          </circle>
        ))}
        {days.map((d, i) => (
          <text key={d.day} className="cc-axis" x={xAt(i, 0.5)} y={H - 10} textAnchor="middle">{d.label.replace(/^\w+ /, '')}</text>
        ))}
      </svg>
      <figcaption className="cc-note">Filled dot: charge that night. Hollow: no plug-in needed.</figcaption>
      <details className="cc-numbers">
        <summary>Chart numbers</summary>
        <table>
          <thead><tr><th>Day</th><th>Morning</th><th>Home</th><th>Charge</th></tr></thead>
          <tbody>
            {pts.map((d) => (
              <tr key={d.day}><td>{d.label}</td><td>{Math.round(d.night!.morningPct!)}%</td><td>{Math.round(d.night!.arrivalPct!)}%</td><td>{d.night!.charge ? `${d.night!.amps}A` : 'no'}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
