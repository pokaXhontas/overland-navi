#!/usr/bin/env python3
"""Zeigt, welche Wanderwege eine Wanderwege-Datei in bestimmten Gebieten enthält.
Aufruf: check_trails.py <datei.pmtiles> '<json: [{"name":..,"box":[w,s,e,n]}]>'"""
import gzip
import json
import math
import sys
from collections import Counter

import mapbox_vector_tile
from pmtiles.reader import MmapSource, Reader

src, areas = sys.argv[1], json.loads(sys.argv[2])
f = open(src, "rb")
r = Reader(MmapSource(f))
Z = 12


def tiles(box):
    w, s, e, n = box
    def xy(lon, lat):
        x = int((lon + 180) / 360 * 2 ** Z)
        y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** Z)
        return x, y
    x0, y1 = xy(w, s)
    x1, y0 = xy(e, n)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield x, y


for a in areas:
    sac, routes, names, kinds, n = Counter(), Counter(), Counter(), Counter(), 0
    for x, y in tiles(a["box"]):
        d = r.get(Z, x, y)
        if not d:
            continue
        if d[:2] == b"\x1f\x8b":
            d = gzip.decompress(d)
        for feat in mapbox_vector_tile.decode(d).get("wege", {}).get("features", []):
            p = feat["properties"]
            n += 1
            sac["T%s" % p.get("s", 0)] += 1
            kinds[p.get("h", "?")] += 1
            if p.get("r"):
                for rr in str(p["r"]).split(" · "):
                    routes[rr] += 1
            if p.get("n"):
                names[p["n"]] += 1
    print(f"\n== {a['name']}: {n} Wegstücke")
    print("   Schwierigkeit:", dict(sac))
    print("   Wegarten:", dict(kinds))
    print("   Routen:", "; ".join(k for k, _ in routes.most_common(12)) or "keine")
    print("   Wegnamen:", "; ".join(k for k, _ in names.most_common(12)) or "keine")
