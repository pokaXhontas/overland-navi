#!/usr/bin/env python3
"""Baut index.json der Wanderwege-Dateien: Größe, Datum und Ausdehnung (aus dem PMTiles-Kopf)."""
import json
import struct
import subprocess
import sys
import urllib.request

repo = sys.argv[1]
meta = {x["id"]: x for x in json.load(open(sys.argv[2]))} if len(sys.argv) > 2 else {}
rel = json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/releases/tags/wanderwege"]))
index = {}
tours = {a["name"][:-12]: a for a in rel["assets"] if a["name"].endswith("-touren.json")}
for a in rel["assets"]:
    if not a["name"].endswith(".pmtiles") or a["name"].endswith("-route.pmtiles"):
        continue   # Straßennetz für das Offline-Routing hat einen eigenen Index
    key = a["name"][:-8]
    if meta and key not in meta:
        # alte Dateien aus früheren Fassungen entfernen
        subprocess.run(["gh", "api", "-X", "DELETE", f"repos/{repo}/releases/assets/{a['id']}"], check=False)
        print("entfernt:", a["name"])
        continue
    req = urllib.request.Request(a["browser_download_url"], headers={"Range": "bytes=0-126"})
    h = urllib.request.urlopen(req, timeout=60).read()
    w, s, e, n = (v / 1e7 for v in struct.unpack_from("<iiii", h, 102))
    m = meta.get(key, {})
    index[key] = {"size": a["size"], "date": a["updated_at"][:10], "ts": a["updated_at"], "bbox": [round(w, 4), round(s, 4), round(e, 4), round(n, 4)],
                  "name": m.get("name", key), "iso": m.get("iso", [])}
    t = tours.get(key)
    if t:
        try:
            d = json.load(urllib.request.urlopen(t["browser_download_url"], timeout=120))
            names = [f["properties"]["name"] for f in d["features"] if f["properties"].get("kind") == "tour"]
            index[key]["tours"] = {"n": len(names), "size": t["size"], "top": names[:3]}
        except Exception as e:
            print("Touren-Paket nicht lesbar:", key, e)
json.dump(index, open("index.json", "w"), ensure_ascii=False, separators=(",", ":"))
print(len(index), "Wanderwege-Dateien")
