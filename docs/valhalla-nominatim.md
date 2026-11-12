# Self-hosted Valhalla and Nominatim for the trip planner (Unraid)

The trip layer (`PERSONAL_CAL_URL`) needs two LAN-only services:

- **Valhalla** routing at `VALHALLA_URL` (route miles and drive time)
- **Nominatim** geocoding at `NOMINATIM_URL` (event address to coordinates)

Both cover California, Nevada, Utah and Arizona. Nothing here is exposed beyond the LAN: bind the ports to the server's LAN address, never forward them on the router. The dashboard sends coordinates and addresses only to these two containers.

Nothing in this document was run. Image names and variables were checked against the pages listed under Sources on the date of writing; re-check the tags before first use.

## Sizing

| Item | Figure | Basis |
|---|---|---|
| Source extracts (4 x .osm.pbf) | about 1.8 GB (CA 1.2 GB, NV 118 MB, UT 163 MB, AZ 290 MB) | Geofabrik listing |
| Valhalla tiles + tar + admin/timezone DBs + elevation | about 6-10 GB | estimate, not documented; measure after the first build |
| Nominatim database | about 20-30 GB for all four states; a few GB for Nevada alone | estimate (roughly 10-15x the PBF); not documented |
| Rebuild headroom | double the above while the side folder builds | only during a manual rebuild; the swap keeps the live copy until the new one is ready |
| Valhalla RAM | 4 GB comfortable | estimate; lower `server_threads` if the build is killed (documented) |
| Nominatim RAM | 2 GB is the hard minimum (documented); plan 8 GB for a 1.8 GB extract | estimate |

**Where it lives: the array, not cache.** The dashboard asks these services only when a new calendar event or a new route shows up: routes are cached on disk and place lookups in memory, so a normal day makes few or no requests. On a spun-down array disk the first lookup waits a few seconds for the spin-up, which the planner does not mind. Make an array-only share named `geo` (Primary storage: Array, no cache) and keep everything below in `/mnt/user/geo`. About 30-40 GB for all four states, plus the same again only while a manual rebuild runs. The Nominatim docs recommend fast disks for *imports*; the one-time import on the array is slow (hours), not broken.

**Smaller:** listing only the states you actually drive in cuts this a lot (Nevada alone is a 118 MB extract, about a tenth of California). Edit the `tile_urls` list and the state list in the rebuild script.

**No flatnode file:** the Nominatim docs suggest it only for very large imports (continents, planet); for a few states it costs disk and gains nothing, so it is left out here.

## docker-compose

Valhalla needs one merged build input list; Nominatim wants one PBF, so the rebuild script merges the four extracts into `region.osm.pbf` first (see the script). Save as `/mnt/user/geo/docker-compose.yml`. Use your LAN address in place of `192.168.1.10`.

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
      tile_urls: >-
        https://download.geofabrik.de/north-america/us/california-latest.osm.pbf
        https://download.geofabrik.de/north-america/us/nevada-latest.osm.pbf
        https://download.geofabrik.de/north-america/us/utah-latest.osm.pbf
        https://download.geofabrik.de/north-america/us/arizona-latest.osm.pbf
      use_tiles_ignore_pbf: "True"   # restarts reuse the built tiles
      build_elevation: "True"        # elevation tiles covering the graph
      build_admins: "True"
      build_time_zones: "True"
      build_tar: "True"
      serve_tiles: "True"
      server_threads: "4"            # lower this if the build gets killed

  nominatim:
    image: mediagis/nominatim:5.3
    container_name: nominatim
    restart: unless-stopped
    shm_size: 2gb                    # docs: at least 1 GB for big imports, ideally half the RAM
    ports:
      - "192.168.1.10:8080:8080"
    volumes:
      - /mnt/user/geo/nominatim-pbf:/nominatim/data:ro
      - /mnt/user/geo/nominatim-db:/var/lib/postgresql/16/main
    environment:
      PBF_PATH: /nominatim/data/region.osm.pbf
      NOMINATIM_PASSWORD: "change-me"   # the image's documented default is public; set your own
      THREADS: "4"
      UPDATE_MODE: none                 # a manual rebuild replaces the data; no replication (keeps the disk asleep)
```

Dashboard environment:

```
VALHALLA_URL=http://192.168.1.10:8002
NOMINATIM_URL=http://192.168.1.10:8080
```

Notes:

- `/var/lib/postgresql/16/main` is the data path the howto documents for the 5.3 image; check the howto for the tag you pull, because the PostgreSQL major version is part of the path.
- `PBF_PATH` and `PBF_URL` cannot be combined, and `PBF_URL` deletes the file after import. A mounted `PBF_PATH` file stays, which the rebuild needs.
- Valhalla's first start downloads the four extracts and builds; allow a long first run (tens of minutes to a couple of hours on a small server, an estimate). Nominatim's first import is longer.
- The old `gis-ops/docker-valhalla` repo is archived. The maintained image is the one above under the Valhalla organisation; its variables are the same.

## Rebuild (manual, a few times a year)

The script builds into a side folder with a throwaway container, swaps only when the build produced a working service, keeps the previous copy as `*.old`, and sends a Pushover on any failure. It needs `osmium-tool` for the merge (the one piece not verified against an official image; install it through NerdTools or run any osmium container), and your Pushover token and user key in `/mnt/user/geo/pushover.env`.

`/mnt/user/geo/rebuild.sh`:

```bash
#!/bin/bash
# Rebuild Valhalla + Nominatim data in side folders; swap only on success.
set -uo pipefail
G=/mnt/user/geo
. "$G/pushover.env"            # PUSHOVER_TOKEN=... PUSHOVER_USER=...
STAMP=$(date +%Y%m%d)
BASE=https://download.geofabrik.de/north-america/us

fail() {
  curl -fsS -o /dev/null --form-string "token=$PUSHOVER_TOKEN" --form-string "user=$PUSHOVER_USER" \
    --form-string "title=Map data rebuild failed" --form-string "message=$1. The previous data is still in use." \
    https://api.pushover.net/1/messages.json
  rm -rf "$G/valhalla.new" "$G/nominatim-db.new" "$G/nominatim-pbf.new"
  exit 1
}

# 1. Download and merge the extracts.
mkdir -p "$G/nominatim-pbf.new" "$G/dl" || fail "mkdir"
for s in california nevada utah arizona; do
  curl -fsSL -o "$G/dl/$s.osm.pbf" "$BASE/$s-latest.osm.pbf" || fail "download $s"
done
osmium merge "$G"/dl/*.osm.pbf -o "$G/nominatim-pbf.new/region.osm.pbf" --overwrite || fail "merge"

# 2. Valhalla: build in a side folder (a throwaway container, no port published).
mkdir -p "$G/valhalla.new"
cp "$G"/dl/*.osm.pbf "$G/valhalla.new/" || fail "copy pbf"
docker run --rm -v "$G/valhalla.new:/custom_files" \
  -e tile_urls="" -e use_tiles_ignore_pbf=False -e force_rebuild=True -e build_elevation=True \
  -e build_admins=True -e build_time_zones=True -e build_tar=True -e serve_tiles=False -e server_threads=4 \
  ghcr.io/valhalla/valhalla-scripted:latest || fail "valhalla build"
[ -s "$G/valhalla.new/valhalla_tiles.tar" ] || fail "valhalla tiles missing"

# 3. Nominatim: import into a side database, using the same image, then stop.
mkdir -p "$G/nominatim-db.new"
cid=$(docker run -d -v "$G/nominatim-pbf.new:/nominatim/data:ro" -v "$G/nominatim-db.new:/var/lib/postgresql/16/main" \
  -e PBF_PATH=/nominatim/data/region.osm.pbf \
  -e NOMINATIM_PASSWORD="$NOMINATIM_PASSWORD" -e UPDATE_MODE=none --shm-size=2g -p 127.0.0.1:18080:8080 mediagis/nominatim:5.3) || fail "nominatim start"
ok=0
for i in $(seq 1 720); do   # up to 6 hours
  sleep 30
  curl -fsS "http://127.0.0.1:18080/search?q=Las+Vegas&format=json" 2>/dev/null | grep -q '"lat"' && { ok=1; break; }
  [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = true ] || break
done
docker stop "$cid" >/dev/null; docker rm "$cid" >/dev/null
[ "$ok" = 1 ] || fail "nominatim import did not answer a test search"

# 4. Swap: stop services, rotate folders, start.
cd "$G" && docker compose stop valhalla nominatim
for d in valhalla nominatim-db nominatim-pbf; do
  rm -rf "$d.old"; [ -e "$d" ] && mv "$d" "$d.old"; mv "$d.new" "$d" || fail "swap $d (restore from $d.old)"
done
docker compose up -d valhalla nominatim || fail "restart after swap"
rm -rf "$G/dl"
echo "rebuilt $STAMP"
```

In the live service the Valhalla container keeps `use_tiles_ignore_pbf: "True"`, so on restart it serves the swapped-in tiles without rebuilding. The `NOMINATIM_PASSWORD` must match the compose file; export it in `pushover.env`.

### Running it (Unraid User Scripts)

Install the User Scripts plugin and add a script named `geo-rebuild` containing `bash /mnt/user/geo/rebuild.sh`. Leave the schedule on "Schedule Disabled" and run it by hand when you want fresher roads (new roads and addresses change slowly; a few times a year is plenty). It spins up the array disk for the hours it runs. Watch for the Pushover on failure.

## Sources checked

- Valhalla Docker image and variables: https://github.com/valhalla/valhalla/blob/master/docker/README.md (image `ghcr.io/valhalla/valhalla-scripted`, port 8002, `/custom_files`, variable defaults)
- Archived predecessor, same variables, no sizing figures: https://github.com/gis-ops/docker-valhalla
- Nominatim image: https://github.com/mediagis/nominatim-docker (image `mediagis/nominatim`, tag 5.3, port 8080)
- Nominatim image howto (volumes, `PBF_PATH`, `UPDATE_MODE`, `shm-size`, flatnode): https://github.com/mediagis/nominatim-docker/blob/master/howto.md
- Nominatim hardware guidance (2 GB minimum for small extracts; planet 128 GB RAM, 1 TB disk): https://nominatim.org/release-docs/latest/admin/Installation/
- Extract sizes: https://download.geofabrik.de/north-america/us.html
