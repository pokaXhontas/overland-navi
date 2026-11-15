#!/usr/bin/env python3
"""Schreibt app/tours/index.json: welche recherchierten Touren-Pakete es gibt."""
import glob
import json
import os

packs = []
for d in sorted(glob.glob("tours/*-def.json")):
    file = os.path.basename(d)[:-9]
    j = json.load(open(d, encoding="utf-8"))
    if not os.path.exists(f"app/tours/{file}.geojson"):
        continue
    packs.append({"file": file, "country": j["country"], "name": j["name"], "n": len(j["tours"]),
                  "top": [t["name"] for t in j["tours"][:3]]})
json.dump({"v": 1, "packs": packs}, open("app/tours/index.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(packs), "Pakete")
