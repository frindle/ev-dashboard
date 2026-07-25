'use client';

// Live vehicle-location map for the away/driving tile. Leaflet touches
// window/document at import time, so this file is only ever loaded via
// next/dynamic({ ssr: false }) from VehicleCard.tsx -- never import it
// directly from a server-rendered path.
import { useEffect, useRef } from 'react';
import L from 'leaflet';

const MOVE_THRESHOLD_M = 15; // ignore GPS jitter smaller than this

function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const φ1 = aLat * Math.PI / 180, φ2 = bLat * Math.PI / 180;
  const Δφ = (bLat - aLat) * Math.PI / 180, Δλ = (bLon - aLon) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function MapTile({ lat, lon }: { lat: number; lon: number }) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const lastPos = useRef<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, {
      center: [lat, lon], zoom: 15, zoomControl: false, attributionControl: true,
      dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, touchZoom: false, keyboard: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    markerRef.current = L.circleMarker([lat, lon], {
      radius: 7, color: '#34e0c4', weight: 2, fillColor: '#34e0c4', fillOpacity: 0.9,
    }).addTo(map);
    mapRef.current = map;
    lastPos.current = { lat, lon };
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !markerRef.current) return;
    const last = lastPos.current;
    // Skip re-panning on GPS jitter -- avoids refetching tiles every poll
    // for a parked-but-slightly-drifting fix, same reasoning as picking
    // Leaflet/OSM over a metered API in the first place.
    if (last && distanceMeters(last.lat, last.lon, lat, lon) < MOVE_THRESHOLD_M) return;
    markerRef.current.setLatLng([lat, lon]);
    map.setView([lat, lon]);
    lastPos.current = { lat, lon };
  }, [lat, lon]);

  return <div ref={elRef} style={{ width: '100%', height: '100%' }} />;
}
