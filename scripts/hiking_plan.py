#!/usr/bin/env python3
"""Liste der Länder für die Wanderwege aus dem Geofabrik-Verzeichnis (eine Datei pro Land).
Ist Geofabrik nicht erreichbar, wird die zuletzt gespeicherte Liste benutzt.
Ausgabe: JSON-Liste [{id, url, name, iso}] auf stdout. Optional: nur bestimmte Kennungen (Komma-Liste)."""
import fnmatch
import json
import os
import sys
import time
import urllib.request

# zu groß für den kostenlosen Bau-Rechner: stattdessen die Teilgebiete (Bundesstaaten)
SPLIT = {"us": "USA"}
CACHE = os.path.join(os.path.dirname(__file__), "hiking-countries.json")
only = [x.strip() for x in (sys.argv[1] if len(sys.argv) > 1 else "").split(",") if x.strip()]
allc = None
for attempt in range(3):
    try:
        idx = json.load(urllib.request.urlopen("https://download.geofabrik.de/index-v1-nogeom.json", timeout=60))
        allc = []
        for f in idx["features"]:
            p = f["properties"]
            if "pbf" not in p.get("urls", {}):
                continue
            par = p.get("parent") if p.get("parent") in SPLIT else next((k for k in SPLIT if p["id"].startswith(k + "/")), None)
            if par:
                # Teilgebiet eines zu großen Landes: eigene Datei, in der App über die Suche zu finden
                pid = p["id"].replace("/", "-")
                nm = p.get("name") or ""
                if not nm or "/" in nm:
                    nm = p["id"].split("/")[-1].replace("-", " ").title()
                allc.append({"id": pid, "url": p["urls"]["pbf"], "name": nm, "iso": p.get("iso3166-1:alpha2") or [par.upper()],
                             "label": f"{nm} ({SPLIT[par]})", "region": True})
            elif p.get("iso3166-1:alpha2") and p["id"] not in SPLIT:
                allc.append({"id": p["id"], "url": p["urls"]["pbf"], "name": p.get("name", p["id"]), "iso": p["iso3166-1:alpha2"]})
        allc.sort(key=lambda x: x["id"])
        json.dump(allc, open(CACHE, "w"), ensure_ascii=False, indent=0)
        break
    except Exception as e:
        print("Geofabrik nicht erreichbar:", e, file=sys.stderr)
        time.sleep(10)
if allc is None:
    allc = json.load(open(CACHE))
# Länder für die eigenen Reisen zuerst bauen, der Rest danach
FIRST = ["germany", "sweden", "norway", "finland", "denmark", "poland", "kyrgyzstan", "kazakhstan", "uzbekistan", "tajikistan",
         "switzerland", "austria", "liechtenstein", "georgia", "turkey", "mongolia"]
allc.sort(key=lambda c: (FIRST.index(c["id"]) if c["id"] in FIRST else len(FIRST), c["id"]))
print(json.dumps([c for c in allc if not only or any(fnmatch.fnmatch(c["id"], o) for o in only)]))
