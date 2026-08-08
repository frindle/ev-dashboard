'use client';

// /12.3display's dedicated map card — unlike MapTile/MapTile14 (a single
// marker inside a 128px away-state tile, embedded in a vehicle card), this
// renders as its own full-size card showing BOTH vehicles at once with
// name labels, per the mockup's three-card row (Rivian | Map | Tesla).
//
// Leaflet touches window/document at import time, so this file is only ever
// loaded via next/dynamic({ ssr: false }) -- never import it directly from a
// server-rendered path.
import { useEffect, useRef } from 'react';
import L from 'leaflet';

export interface MapVehicle {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  color: string;
}

export default function MapTile12({ vehicles }: { vehicles: MapVehicle[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Record<string, L.CircleMarker>>({});

  const withCoords = vehicles.filter(
    (v): v is MapVehicle & { lat: number; lon: number } => v.lat !== null && v.lon !== null
  );
  const coordsKey = withCoords.map(v => `${v.id}:${v.lat.toFixed(5)},${v.lon.toFixed(5)}`).join('|');

  useEffect(() => {
    if (!elRef.current || mapRef.current || withCoords.length === 0) return;
    const map = L.map(elRef.current, {
      zoomControl: false, attributionControl: true,
      dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, touchZoom: false, keyboard: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    if (withCoords.length === 1) {
      map.setView([withCoords[0].lat, withCoords[0].lon], 15);
    } else {
      map.fitBounds(withCoords.map(v => [v.lat, v.lon]), { padding: [36, 36] });
    }
    for (const v of withCoords) {
      const marker = L.circleMarker([v.lat, v.lon], {
        radius: 8, color: v.color, weight: 2, fillColor: v.color, fillOpacity: 0.9,
      }).addTo(map);
      marker.bindTooltip(v.name, { permanent: true, direction: 'top', offset: [0, -8], className: 'maptile-12-label' });
      markersRef.current[v.id] = marker;
    }
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; markersRef.current = {}; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withCoords.length === 0]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const v of withCoords) {
      markersRef.current[v.id]?.setLatLng([v.lat, v.lon]);
    }
    if (withCoords.length > 1) map.fitBounds(withCoords.map(v => [v.lat, v.lon]), { padding: [36, 36] });
    else if (withCoords.length === 1) map.setView([withCoords[0].lat, withCoords[0].lon]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordsKey]);

  if (withCoords.length === 0) return null; // caller renders a placeholder — no GPS fix for either vehicle yet

  return <div className="maptile-12" style={{ width: '100%', height: '100%' }}>
    <div ref={elRef} style={{ width: '100%', height: '100%' }} />
  </div>;
}
