#!/usr/bin/env python3
"""Hilfswerkzeug: Ebenen und Merkmale einer Kachel aus einer lokalen PMTiles-Datei zeigen."""
import gzip
import math
import sys
from collections import Counter

import mapbox_vector_tile
from pmtiles.reader import MmapSource, Reader

path, lat, lon, z = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
with open(path, "rb") as f:
    r = Reader(MmapSource(f))
    print("Metadaten:", {k: v for k, v in r.metadata().items() if k in ("vector_layers", "name")})
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    d = r.get(z, x, y)
    if not d:
        print("keine Kachel", z, x, y); sys.exit()
    if d[:2] == b"\x1f\x8b":
        d = gzip.decompress(d)
    t = mapbox_vector_tile.decode(d)
    for name, layer in t.items():
        feats = layer["features"]
        print(f"Ebene {name}: {len(feats)} Objekte", Counter(f["properties"].get("k") or f["properties"].get("m") or f["properties"].get("h") for f in feats).most_common(8))
        for f in feats[:3]:
            print("   ", f["properties"])
