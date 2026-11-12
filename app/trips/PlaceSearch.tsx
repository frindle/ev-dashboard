'use client';
// Search the local geocoder and pick a place for an event (or the work location).
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Hit { lat: number; lon: number; label: string }

export default function PlaceSearch({ uid, initial, button }: { uid: string; initial?: string; button?: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial ?? '');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetch(`/api/trips/geocode?q=${encodeURIComponent(q)}`);
      setHits(((await r.json()) as { hits: Hit[] }).hits);
    } catch { setHits([]); }
    setBusy(false);
  }
  async function pick(h: Hit) {
    setBusy(true);
    await fetch('/api/trips/choice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'place', uid, lat: h.lat, lon: h.lon, label: h.label }),
    });
    router.refresh();
    setBusy(false);
  }

  return (
    <div className="trips-search">
      <form onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for the place" aria-label="Search for the place" />
        <button type="submit" disabled={busy || !q.trim()}>{button ?? 'Search'}</button>
      </form>
      {hits && !hits.length && <p className="trips-note">No match. Try a street and city, or set what the day needs below.</p>}
      {hits && hits.length > 0 && (
        <ul>
          {hits.map((h, i) => (
            <li key={i}><button type="button" disabled={busy} onClick={() => pick(h)}>{h.label || `${h.lat.toFixed(4)}, ${h.lon.toFixed(4)}`}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
