# Self-hosted Valhalla and Nominatim for the trip planner (Unraid)

The trip layer (`PERSONAL_CAL_URL`) uses two LAN services that hold **Nevada only**:

- **Valhalla** routing at `VALHALLA_URL` (route miles and drive time)
- **Nominatim** geocoding at `NOMINATIM_URL` (event address to coordinates)

Anything outside Nevada goes to the public OpenStreetMap services instead (`lib/onlineGeo.ts`):

- a location the LAN Nominatim cannot place -> the public Nominatim (`NOMINATIM_ONLINE_URL`, default `https://nominatim.openstreetmap.org`, US results only);
- a route with an end outside Nevada -> the FOSSGIS Valhalla (`VALHALLA_ONLINE_URL`, default `https://valhalla1.openstreetmap.de`); a Nevada route goes there only if the LAN Valhalla fails (for example while the monthly rebuild swaps the data).

Both public services allow at most one request a second and ask for a User-Agent naming the app; the dashboard spaces its requests 1.1 s apart per host and sends `ev-dashboard-trip-planner/1.0 (self-hosted)` (no name, no contact address). What leaves the LAN: a location text the LAN copy could not place, and route end points rounded to 0.01 degrees (about 1 km), so home's exact point is never sent. Results are cached (routes on disk, places 7 days, misses 12 h), so a trip is looked up once. `GEO_ONLINE=0` turns the online fallback off.

When a place still cannot be found or a route cannot be worked out, the dashboard pushes (daytime, or at the evening update and again at 23:00 when it is tonight's charge) and the push opens `/trips`, where you can pick the place or type what the day needs (% of battery or miles). A typed need replaces the trip estimate for that day; "Tonight's charge" on the same page sets a one-off "N% by time".

Nothing here is exposed beyond the LAN: bind the ports to the server's LAN address, never forward them on the router.

Nothing in this document was run. Image names and variables were checked against the pages listed under Sources on the date of writing; re-check the tags before first use.

## Sizing (Nevada only)

| Item | Figure | Basis |
|---|---|---|
| Source extract | about 120 MB (`nevada-latest.osm.pbf`) | Geofabrik listing |
| Valhalla tiles + tar + admin/timezone DBs + elevation | about 1-3 GB | estimate, not documented; measure after the first build |
| Nominatim database | a few GB (roughly 10-15x the PBF) | estimate; not documented |
| Rebuild headroom | the same again while the side folders build | only during the monthly rebuild |
| Valhalla RAM | 2 GB comfortable | estimate |
| Nominatim RAM | 2 GB is the documented minimum; 4 GB is comfortable for one state | documented minimum + estimate |

Plan on about 5-10 GB in `/mnt/user/geo`, plus the same again for the few hours a rebuild runs.

**Where it lives: the array, not cache.** The dashboard asks these services only when a new calendar event or a new route shows up, so a normal day makes few or no requests. On a spun-down array disk the first lookup waits a few seconds for the spin-up, which the planner does not mind. Make an array-only share named `geo` (Primary storage: Array, no cache). The one-time import on the array is slower than on SSD, not broken.

**No flatnode file:** the Nominatim docs suggest it only for continent or planet imports.

## docker-compose

Save as `/mnt/user/geo/docker-compose.yml` (Unraid runs it through the Compose Manager plugin). Use your LAN address in place of `192.168.1.10`.

```yaml
services:
  valhalla:
    image: ghcr.io/valhalla/valhalla-scripted:latest
    container_name: valhalla
    restart: unless-stopped
    ports:
      - "192.168.1.10:8002:8002"
    volumes:
      - /mnt/user/geo/valhalla:/custom_files
    environment:
      tile_urls: https://download.geofabrik.de/north-america/us/nevada-latest.osm.pbf
      use_tiles_ignore_pbf: "True"   # restarts reuse the built tiles (the rebuild script makes new ones)
      build_elevation: "True"
      build_admins: "True"
      build_time_zones: "True"
      build_tar: "True"
      serve_tiles: "True"
      server_threads: "2"

  nominatim:
    image: mediagis/nominatim:5.3
    container_name: nominatim
    restart: unless-stopped
    shm_size: 1gb
    ports:
      - "192.168.1.10:8080:8080"
    volumes:
      - /mnt/user/geo/nominatim-pbf:/nominatim/data:ro
      - /mnt/user/geo/nominatim-db:/var/lib/postgresql/16/main
    environment:
      PBF_PATH: /nominatim/data/nevada.osm.pbf
      NOMINATIM_PASSWORD: "change-me"   # the image's documented default is public; set your own
      THREADS: "4"
      UPDATE_MODE: none                 # the monthly rebuild replaces the data; no replication (keeps the disk asleep)
```

Dashboard environment:

```
VALHALLA_URL=http://192.168.1.10:8002
NOMINATIM_URL=http://192.168.1.10:8080
# optional: GEO_ONLINE=0 (LAN only), NOMINATIM_ONLINE_URL=..., VALHALLA_ONLINE_URL=...
```

Notes:

- `/var/lib/postgresql/16/main` is the data path the howto documents for the 5.3 image; check it for the tag you pull, because the PostgreSQL major version is part of the path.
- `PBF_PATH` and `PBF_URL` cannot be combined, and `PBF_URL` deletes the file after import. A mounted `PBF_PATH` file stays, which the rebuild needs.
- First start: the first time, run the rebuild script below once by hand instead of starting the containers on empty folders; it builds both data sets and starts them.
- The old `gis-ops/docker-valhalla` repo is archived. The maintained image is the one above under the Valhalla organisation; its variables are the same.

## Rebuild (automatic, monthly)

The script downloads the Nevada extract, builds Valhalla tiles and a Nominatim database in side folders with throwaway containers, swaps them in only when both built and answer a test query, keeps the previous copy as `*.old`, and sends a Pushover on any failure (the previous data stays in use). A lock stops two runs overlapping, and it refuses to start without 15 GB free. While the swap stops the two containers (about a minute), the dashboard's online fallback covers lookups. Put your Pushover token and user key and the Nominatim password in `/mnt/user/geo/pushover.env`.

`/mnt/user/geo/rebuild.sh`:

```bash
#!/bin/bash
# Monthly: rebuild Nevada Valhalla + Nominatim data in side folders; swap only on success.
set -uo pipefail
G=/mnt/user/geo
LAN=192.168.1.10              # the same LAN address as in docker-compose.yml
. "$G/pushover.env"            # PUSHOVER_TOKEN=... PUSHOVER_USER=... NOMINATIM_PASSWORD=...
URL=https://download.geofabrik.de/north-america/us/nevada-latest.osm.pbf
exec 9>"$G/.rebuild.lock"; flock -n 9 || { echo "already running"; exit 0; }

push() {
  curl -fsS -o /dev/null --form-string "token=$PUSHOVER_TOKEN" --form-string "user=$PUSHOVER_USER" \
    --form-string "title=$1" --form-string "message=$2" https://api.pushover.net/1/messages.json
}
fail() {
  push "Map data rebuild failed" "$1. The previous data is still in use."
  [ -n "${cid:-}" ] && { docker stop "$cid" >/dev/null 2>&1; docker rm "$cid" >/dev/null 2>&1; }
  rm -rf "$G/valhalla.new" "$G/nominatim-db.new" "$G/nominatim-pbf.new"
  exit 1
}

free_gb=$(df -BG --output=avail "$G" | tail -1 | tr -dc 0-9)
[ "${free_gb:-0}" -ge 15 ] || fail "only ${free_gb} GB free on the geo share"

# 1. Download the extract and check it against Geofabrik's md5.
rm -rf "$G/valhalla.new" "$G/nominatim-db.new" "$G/nominatim-pbf.new"
mkdir -p "$G/nominatim-pbf.new" "$G/valhalla.new" "$G/nominatim-db.new" || fail "mkdir"
curl -fsSL -o "$G/nominatim-pbf.new/nevada.osm.pbf" "$URL" || fail "download"
want=$(curl -fsSL "$URL.md5" | cut -d' ' -f1)
got=$(md5sum "$G/nominatim-pbf.new/nevada.osm.pbf" | cut -d' ' -f1)
[ -n "$want" ] && [ "$want" = "$got" ] || fail "download checksum mismatch"

# 2. Valhalla: build in the side folder (throwaway container, no port published).
cp "$G/nominatim-pbf.new/nevada.osm.pbf" "$G/valhalla.new/" || fail "copy pbf"
docker run --rm -v "$G/valhalla.new:/custom_files" \
  -e tile_urls="" -e use_tiles_ignore_pbf=False -e force_rebuild=True -e build_elevation=True \
  -e build_admins=True -e build_time_zones=True -e build_tar=True -e serve_tiles=False -e server_threads=2 \
  ghcr.io/valhalla/valhalla-scripted:latest || fail "valhalla build"
[ -s "$G/valhalla.new/valhalla_tiles.tar" ] || fail "valhalla tiles missing"

# 3. Nominatim: import into the side database with the same image, test it, stop it.
cid=$(docker run -d -v "$G/nominatim-pbf.new:/nominatim/data:ro" -v "$G/nominatim-db.new:/var/lib/postgresql/16/main" \
  -e PBF_PATH=/nominatim/data/nevada.osm.pbf -e NOMINATIM_PASSWORD="$NOMINATIM_PASSWORD" -e UPDATE_MODE=none \
  --shm-size=1g -p 127.0.0.1:18080:8080 mediagis/nominatim:5.3) || fail "nominatim start"
ok=0
for i in $(seq 1 480); do   # up to 4 hours
  sleep 30
  curl -fsS "http://127.0.0.1:18080/search?q=Las+Vegas&format=json" 2>/dev/null | grep -q '"lat"' && { ok=1; break; }
  [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = true ] || break
done
docker stop "$cid" >/dev/null; docker rm "$cid" >/dev/null; cid=
[ "$ok" = 1 ] || fail "nominatim import did not answer a test search"

# 4. Swap: stop the services, rotate the folders, start, check Valhalla answers.
cd "$G" && docker compose stop valhalla nominatim
for d in valhalla nominatim-db nominatim-pbf; do
  rm -rf "$d.old"; [ -e "$d" ] && mv "$d" "$d.old"; mv "$d.new" "$d" || fail "swap $d (restore from $d.old)"
done
docker compose up -d valhalla nominatim || fail "restart after swap"
sleep 60
curl -fsS "http://$LAN:8002/status" >/dev/null || fail "valhalla did not come back after the swap (old data in *.old)"
echo "rebuilt $(date +%F)" >> "$G/rebuild.log"
```

In the live service the Valhalla container keeps `use_tiles_ignore_pbf: "True"`, so on restart it serves the swapped-in tiles without rebuilding. `NOMINATIM_PASSWORD` must match the compose file.

### Scheduling it (Unraid User Scripts)

Install the User Scripts plugin, add a script named `geo-rebuild` containing `bash /mnt/user/geo/rebuild.sh`, and set its schedule to **Custom** with `30 3 2 * *` (03:30 on the 2nd of each month, after the mover). It spins up the array disk for the hour or two it runs. A failure sends a Pushover and leaves the old data serving; `rebuild.log` lists the successful runs. Run it once by hand for the first build.

## Sources checked

- Valhalla Docker image and variables: https://github.com/valhalla/valhalla/blob/master/docker/README.md (image `ghcr.io/valhalla/valhalla-scripted`, port 8002, `/custom_files`, variable defaults)
- Archived predecessor, same variables, no sizing figures: https://github.com/gis-ops/docker-valhalla
- Nominatim image: https://github.com/mediagis/nominatim-docker (image `mediagis/nominatim`, tag 5.3, port 8080)
- Nominatim image howto (volumes, `PBF_PATH`, `UPDATE_MODE`, `shm-size`, flatnode): https://github.com/mediagis/nominatim-docker/blob/master/howto.md
- Nominatim hardware guidance (2 GB minimum for small extracts; planet 128 GB RAM, 1 TB disk): https://nominatim.org/release-docs/latest/admin/Installation/
- Extract sizes and md5 files: https://download.geofabrik.de/north-america/us.html
- Public services: Nominatim usage policy (1 request/s, identifying User-Agent): https://operations.osmfoundation.org/policies/nominatim/ ; FOSSGIS terms covering valhalla1.openstreetmap.de (1 request/s for routing, don't hard-code the URL): https://fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen
