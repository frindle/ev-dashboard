'use client';

// /14display variant of components/MapTile.tsx. Identical behaviour, but
// draws CARTO "Dark Matter" tiles instead of standard OpenStreetMap raster,
// and shrinks Leaflet's oversized attribution control to fit a 128px tile.
// Kept as a separate file so the production dashboard at / keeps rendering
// the original MapTile with no change at all.
//
// Leaflet touches window/document at import time, so this file is only ever
// loaded via next/dynamic({ ssr: false }) -- never import it directly from a
// server-rendered path.
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

export default function MapTile14({ lat, lon }: { lat: number; lon: number }) {
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
    // CARTO "Dark Matter" raster basemap — genuinely dark-styled tiles, so
    // there's no need for a CSS grayscale/contrast/brightness filter to fake
    // a dark look out of standard OSM tiles.
    //
    // URL template and attribution verified 2026-08-01 against CARTO's own
    // basemap-styles docs (github.com/CartoDB/basemap-styles): the raster
    // pattern is
    //   https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}{scale}.png
    // with subdomains a-d and `dark_all` among the listed styles, and CARTO
    // requires BOTH the OpenStreetMap and the CARTO credit:
    //   '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>,
    //    &copy; <a href="https://carto.com/attributions">CARTO</a>'
    // {r} is Leaflet's retina placeholder, which fills in CARTO's "@2x".
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);
    // Drop Leaflet's own "Leaflet" prefix from the control -- the required
    // credit is the OSM/CARTO pair above, and on a 128px tile every character
    // counts. The control is then shrunk (not hidden) by the .maptile-14
    // rules in app/globals.css, so the credit stays visible and legible.
    map.attributionControl.setPrefix(false);
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
    // for a parked-but-slightly-drifting fix.
    if (last && distanceMeters(last.lat, last.lon, lat, lon) < MOVE_THRESHOLD_M) return;
    markerRef.current.setLatLng([lat, lon]);
    map.setView([lat, lon]);
    lastPos.current = { lat, lon };
  }, [lat, lon]);

  return <div className="maptile-14" style={{ width: '100%', height: '100%' }}>
    <div ref={elRef} style={{ width: '100%', height: '100%' }} />
  </div>;
}
