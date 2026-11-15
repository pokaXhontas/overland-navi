#!/usr/bin/env python3
"""Liste der Länder für die Wanderwege aus dem Geofabrik-Verzeichnis (eine Datei pro Land).
Ausgabe: JSON-Liste [{id, url, name, iso}] auf stdout. Optional: nur bestimmte Kennungen (Komma-Liste)."""
import json
import sys
import urllib.request

only = [x.strip() for x in (sys.argv[1] if len(sys.argv) > 1 else "").split(",") if x.strip()]
idx = json.load(urllib.request.urlopen("https://download.geofabrik.de/index-v1-nogeom.json", timeout=60))
out = []
for f in idx["features"]:
    p = f["properties"]
    iso = p.get("iso3166-1:alpha2")
    if not iso or "pbf" not in p.get("urls", {}):
        continue
    if only and p["id"] not in only:
        continue
    out.append({"id": p["id"], "url": p["urls"]["pbf"], "name": p.get("name", p["id"]), "iso": iso})
out.sort(key=lambda x: x["id"])
print(json.dumps(out))
