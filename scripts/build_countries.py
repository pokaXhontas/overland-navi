#!/usr/bin/env python3
"""Baut die Weltliste der Länder, die man in der App hinzufügen kann.

Jedes Land wird mit einem Raster aus Rechtecken abgedeckt, das sich eng an die Landesgrenze hält
(etwas Rand dazu). So lädt die App nur Kacheln, die wirklich zum Land gehören.
Die Downloadgrößen ermittelt das offizielle pmtiles-Werkzeug (Probelauf ohne Download).

Aufruf: build_countries.py <natural-earth-länder.geojson> <basemap-url> <höhen-url>
Ausgabe: countries.json
"""
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from shapely.geometry import box, shape
from shapely.prepared import prep

SRC, BASE_URL, DEM_URL = sys.argv[1:4]
CACHE = os.environ.get("CACHE_DIR", "countries-cache")
BUDGET_S = int(os.environ.get("BUDGET_S", 4 * 3600))
MAX_AGE_S = 45 * 24 * 3600
START = time.time()
MAX_CELLS = 260
MARGIN = 0.05  # Grad Rand um die Grenze (etwa 5 km)

GROUPS = {
    "Europe": "Europa", "Asia": "Asien", "Africa": "Afrika", "North America": "Nordamerika",
    "South America": "Südamerika", "Oceania": "Ozeanien", "Seven seas (open ocean)": "Inseln",
}
GROUP_ORDER = ["Europa", "Asien", "Afrika", "Nordamerika", "Südamerika", "Ozeanien", "Inseln"]


def cover(geom):
    """Rasterzellen über der Landesfläche, zu möglichst wenigen Rechtecken zusammengefasst."""
    g = geom.buffer(MARGIN)
    w, s, e, n = g.bounds
    pg = prep(g)
    for c in (0.25, 0.5, 1.0, 2.0, 4.0):
        x0, y0 = math.floor(w / c) * c, math.floor(s / c) * c
        nx, ny = math.ceil((e - x0) / c), math.ceil((n - y0) / c)
        rows = []
        for j in range(ny):
            y = y0 + j * c
            runs, start = [], None
            for i in range(nx + 1):
                hit = i < nx and pg.intersects(box(x0 + i * c, y, x0 + (i + 1) * c, y + c))
                if hit and start is None:
                    start = i
                if not hit and start is not None:
                    runs.append((start, i))
                    start = None
            rows.append(runs)
        cells = sum(b - a for runs in rows for a, b in runs)
        if cells <= MAX_CELLS or c == 4.0:
            break
    # gleiche Abschnitte übereinanderliegender Zeilen zusammenfassen
    boxes, open_ = [], {}
    for j, runs in enumerate(rows + [[]]):
        nxt = {}
        for r in runs:
            nxt[r] = open_.pop(r, j)
        for (a, b), j0 in open_.items():
            boxes.append([x0 + a * c, y0 + j0 * c, x0 + b * c, y0 + j * c])
        open_ = nxt
    clip = lambda v, lo, hi: round(max(lo, min(hi, v)), 4)
    return [[clip(b[0], -180, 180), clip(b[1], -85, 85), clip(b[2], -180, 180), clip(b[3], -85, 85)] for b in boxes]


def dry_size(url, boxes, mz, tag):
    geo = f"/tmp/{tag}.geojson"
    polys = [[[[w, s], [e, s], [e, n], [w, n], [w, s]]] for w, s, e, n in boxes]
    json.dump({"type": "MultiPolygon", "coordinates": polys}, open(geo, "w"))
    for attempt in range(3):
        p = subprocess.run(["pmtiles", "extract", url, f"/tmp/{tag}.pmtiles", f"--region={geo}", f"--maxzoom={mz}", "--dry-run"],
                           capture_output=True, text=True)
        out = p.stdout + p.stderr
        m = re.findall(r"archive size of ([0-9.]+)\s*([kKMGT]?B)", out) or re.findall(r"([0-9.]+)\s*([kMGT]B)", out)
        if m:
            v, u = m[-1]
            return int(float(v) * {"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}[u])
        print(f"  {tag}: keine Größe ({out.strip()[-200:]})", flush=True)
        time.sleep(5)
    return None


def sizes(c):
    key = hashlib.md5(json.dumps([c["boxes"], BASE_URL.rsplit("/", 1)[-1][:6]]).encode()).hexdigest()[:10]
    path = f"{CACHE}/{c['id']}-{key}.json"
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < MAX_AGE_S:
        return json.load(open(path))
    if time.time() - START > BUDGET_S:
        open("/tmp/countries-budget", "w").close()
        return None
    base = dry_size(BASE_URL, c["boxes"], 14, c["id"] + "-b")
    dem = dry_size(DEM_URL, c["boxes"], 11, c["id"] + "-d")
    dz = 11
    if dem and dem > 700e6:
        dz, dem = 10, dry_size(DEM_URL, c["boxes"], 10, c["id"] + "-d10")
    if base is None or dem is None:
        return None
    res = {"base": base, "dem": dem, "demMaxzoom": dz}
    json.dump(res, open(path, "w"))
    print(f"{c['name']:<28} Karte {base / 1e6:8.0f} MB  Höhen {dem / 1e6:7.0f} MB (z{dz})  {len(c['boxes'])} Rechtecke", flush=True)
    return res


def main():
    os.makedirs(CACHE, exist_ok=True)
    feats = json.load(open(SRC, encoding="utf-8"))["features"]
    countries, seen = [], set()
    for f in feats:
        p = f["properties"]
        group = GROUPS.get(p.get("CONTINENT"))
        a3 = p.get("ADM0_A3") or p.get("ISO_A3")
        if not group or not a3 or a3 in seen or not f.get("geometry"):
            continue
        seen.add(a3)
        name = p.get("NAME_DE") or p.get("NAME")
        countries.append({"id": "c-" + a3.lower(), "iso": a3, "name": name, "group": group,
                          "boxes": cover(shape(f["geometry"])), "maxzoom": 14})
    countries.sort(key=lambda c: (GROUP_ORDER.index(c["group"]), c["name"]))
    print(f"{len(countries)} Länder", flush=True)
    with ThreadPoolExecutor(6) as ex:
        for c, s in zip(countries, ex.map(sizes, countries)):
            c["demMaxzoom"] = (s or {}).get("demMaxzoom", 11)
            c["sizes"] = {"base": s["base"], "dem": s["dem"]} if s else None
    done = sum(1 for c in countries if c["sizes"])
    print(f"Größen bekannt für {done} von {len(countries)} Ländern", flush=True)
    json.dump({"v": 1, "base": BASE_URL.rsplit("/", 1)[-1], "countries": countries},
              open("countries.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
