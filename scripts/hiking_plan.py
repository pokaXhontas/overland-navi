#!/usr/bin/env python3
"""Liste der Länder für die Wanderwege aus dem Geofabrik-Verzeichnis (eine Datei pro Land).
Ist Geofabrik nicht erreichbar, wird die zuletzt gespeicherte Liste benutzt.
Ausgabe: JSON-Liste [{id, url, name, iso}] auf stdout. Optional: nur bestimmte Kennungen (Komma-Liste)."""
import json
import os
import sys
import time
import urllib.request

CACHE = os.path.join(os.path.dirname(__file__), "hiking-countries.json")
only = [x.strip() for x in (sys.argv[1] if len(sys.argv) > 1 else "").split(",") if x.strip()]
allc = None
for attempt in range(3):
    try:
        idx = json.load(urllib.request.urlopen("https://download.geofabrik.de/index-v1-nogeom.json", timeout=60))
        allc = []
        for f in idx["features"]:
            p = f["properties"]
            if p.get("iso3166-1:alpha2") and "pbf" in p.get("urls", {}):
                allc.append({"id": p["id"], "url": p["urls"]["pbf"], "name": p.get("name", p["id"]), "iso": p["iso3166-1:alpha2"]})
        allc.sort(key=lambda x: x["id"])
        json.dump(allc, open(CACHE, "w"), ensure_ascii=False, indent=0)
        break
    except Exception as e:
        print("Geofabrik nicht erreichbar:", e, file=sys.stderr)
        time.sleep(10)
if allc is None:
    allc = json.load(open(CACHE))
print(json.dumps([c for c in allc if not only or c["id"] in only]))
