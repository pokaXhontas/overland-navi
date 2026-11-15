#!/usr/bin/env python3
"""Zieht Wanderwege aus einem OpenStreetMap-Auszug (.osm.pbf, vorgefiltert) und schreibt sie als
GeoJSON-Zeilen für tippecanoe.

Je Weg: SAC-Schwierigkeit (T1–T6), Name, Wegspur, Wegart und die Wanderrouten, zu denen er gehört.
Aufruf: build_hiking.py <gefiltert.osm.pbf> <ausgabe.geojsonseq>
"""
import json
import sys
from collections import defaultdict

import osmium

SAC = {"hiking": 1, "mountain_hiking": 2, "demanding_mountain_hiking": 3,
       "alpine_hiking": 4, "demanding_alpine_hiking": 5, "difficult_alpine_hiking": 6}
VIS = {"excellent": 1, "good": 2, "intermediate": 3, "bad": 4, "horrible": 5, "no": 6}
NET = {"iwn": 4, "nwn": 3, "rwn": 2, "lwn": 1}

src, dst = sys.argv[1], sys.argv[2]
routes = []
member = defaultdict(list)


class Rels(osmium.SimpleHandler):
    def relation(self, r):
        if r.tags.get("route") not in ("hiking", "foot"):
            return
        name = r.tags.get("name:de") or r.tags.get("name:en") or r.tags.get("name") or r.tags.get("ref") or ""
        info = {"name": name[:60], "ref": (r.tags.get("ref") or "")[:12], "net": NET.get(r.tags.get("network", ""), 1),
                "col": (r.tags.get("osmc:symbol") or "").split(":")[0][:10]}
        routes.append(info)
        idx = len(routes) - 1
        for m in r.members:
            if m.type == "w":
                member[m.ref].append(idx)


class Ways(osmium.SimpleHandler):
    def __init__(self, out):
        super().__init__()
        self.out = out
        self.n = 0

    def way(self, w):
        t = w.tags
        hw = t.get("highway")
        rs = member.get(w.id, [])
        sac = SAC.get(t.get("sac_scale", ""), 0)
        if not rs and not sac and hw != "path":
            return
        if hw in ("motorway", "trunk", "primary", "secondary") and not rs:
            return
        if t.get("footway") in ("sidewalk", "crossing") or t.get("area") == "yes":
            return
        try:
            coords = [(round(n.lon, 6), round(n.lat, 6)) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return
        p = {"s": sac, "h": hw or ""}
        name = t.get("name:de") or t.get("name")
        if name:
            p["n"] = name[:60]
        if t.get("trail_visibility") in VIS:
            p["v"] = VIS[t["trail_visibility"]]
        if rs:
            rr = sorted((routes[i] for i in rs), key=lambda x: -x["net"])
            p["r"] = " · ".join(dict.fromkeys(x["name"] for x in rr if x["name"]))[:90]
            p["net"] = rr[0]["net"]
            if rr[0]["ref"]:
                p["ref"] = rr[0]["ref"]
            if rr[0]["col"]:
                p["c"] = rr[0]["col"]
        # wichtige Routen früh zeigen, schwierige Pfade ab mittlerem Zoom, einfache Pfade erst nah dran
        minz = (8 if p.get("net", 0) >= 3 else 9 if p.get("net") == 2 else 10) if rs else (11 if sac >= 2 else 12)
        f = {"type": "Feature", "properties": p, "tippecanoe": {"minzoom": minz},
             "geometry": {"type": "LineString", "coordinates": coords}}
        self.out.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.n += 1


Rels().apply_file(src)
print(f"{len(routes)} Wanderrouten", flush=True)
with open(dst, "w", encoding="utf-8") as out:
    h = Ways(out)
    h.apply_file(src, locations=True, idx="flex_mem")
print(f"{h.n} Wege", flush=True)
