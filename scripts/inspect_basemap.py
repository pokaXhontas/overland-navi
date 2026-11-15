#!/usr/bin/env python3
"""Hilfswerkzeug: zeigt, was in der Grundkarte (Protomaps) an einer Stelle steckt (POI-Arten, Gebäude-Merkmale)."""
import gzip
import json
import math
import sys
from collections import Counter

import mapbox_vector_tile
from pmtiles.reader import Reader, MmapSource  # noqa: F401
import urllib.request


def http_source(url):
    def get(offset, length):
        req = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{offset + length - 1}"})
        return urllib.request.urlopen(req, timeout=60).read()
    return get


url = sys.argv[1]
spots = json.loads(sys.argv[2])
r = Reader(http_source(url))
for s in spots:
    z = s.get("z", 15)
    n = 2 ** z
    x = int((s["lon"] + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(s["lat"]))) / math.pi) / 2 * n)
    data = r.get(z, x, y)
    if not data:
        print("==", s["name"], "keine Kachel"); continue
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    t = mapbox_vector_tile.decode(data)
    print(f"== {s['name']} z{z}: Ebenen {list(t.keys())}")
    pois = t.get("pois", {}).get("features", [])
    kinds = Counter(f["properties"].get("kind") for f in pois)
    print("  POI-Arten:", dict(kinds.most_common(60)))
    for f in pois:
        p = f["properties"]
        if p.get("kind") in ("ruins", "castle", "memorial", "monument", "archaeological_site", "historic", "fort", "attraction", "wayside_shrine", "tower", "building"):
            print("   ", {k: v for k, v in p.items() if k in ("kind", "kind_detail", "name", "name:de", "min_zoom")})
    b = t.get("buildings", {}).get("features", [])
    keys = Counter(k for f in b for k in f["properties"].keys())
    print("  Gebäude:", len(b), "Merkmale:", dict(keys))
    named = [f["properties"] for f in b if any(k.startswith("name") for k in f["properties"])]
    print("  Gebäude mit Namen:", len(named), named[:5])
    lu = Counter(f["properties"].get("kind") for f in t.get("landuse", {}).get("features", []))
    print("  Landnutzung:", dict(lu.most_common(30)))
