#!/usr/bin/env python3
"""Baut die empfohlenen Touren (Linie + Wegpunkte) aus einem OpenStreetMap-Länderauszug.

Wegpunkte werden über ihre OSM-Merkmale gesucht (nächster Treffer zur geschätzten Lage),
der Weg dazwischen kommt aus einer eingetragenen Wanderroute, aus allen Wegen eines Gebiets
oder aus einer Fußweg-Berechnung mit Valhalla.
Aufruf: build_tours.py <touren-def.json> <land.osm.pbf> <ausgabe.geojson>
"""
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request

import osmium

VALHALLA = "https://valhalla1.openstreetmap.de/route"
FILTER_RE = re.compile(r'\["([^"]+)"(?:(=|~)"([^"]*)")?\]')


def dist(a, b):
    k = math.pi / 180
    x = (b[0] - a[0]) * math.cos((a[1] + b[1]) / 2 * k)
    y = b[1] - a[1]
    return math.hypot(x, y) * 111195


def parse_filter(s):
    return [(k, op, v) for k, op, v in FILTER_RE.findall(s or "")]


def matches(tags, flt):
    for k, op, v in flt:
        val = tags.get(k)
        if val is None:
            return False
        if op == "=" and val != v:
            return False
        if op == "~" and not re.search(v, val):
            return False
    return True


def tagdict(o):
    return {t.k: t.v for t in o.tags}


class Relations(osmium.SimpleHandler):
    """1. Durchgang: Wanderrouten und Wegpunkte, die als Relation eingetragen sind."""

    def __init__(self, tours):
        super().__init__()
        self.tours = tours
        self.found = []  # (Art, Tour, Punkt oder None, Name, [Weg-IDs])
        self.need = set()

    def relation(self, r):
        tags = tagdict(r)
        if not tags:
            return
        ways = [m.ref for m in r.members if m.type == "w"]
        if not ways:
            return
        for t in self.tours:
            name = tags.get("name:en") or tags.get("name", "")
            if r.id == t.get("relation_id") or (t.get("relation") and tags.get("route") in ("hiking", "foot")
                                                 and (re.search(t["relation"], tags.get("name", "")) or re.search(t["relation"], name))):
                self.found.append(("route", t["id"], None, name, ways))
                self.need.update(ways)
            for i, p in enumerate(t["points"]):
                if p.get("flt") and matches(tags, p["flt"]):
                    self.found.append(("point", t["id"], i, tags.get("name", ""), ways))
                    self.need.update(ways)


class Scan(osmium.SimpleHandler):
    """2. Durchgang mit Koordinaten: Punkte, Gebietswege und Geometrie der Relationswege."""

    def __init__(self, tours, need):
        super().__init__()
        self.tours = tours
        self.need = need
        self.geom = {}
        self.cands = {}   # (Tour, Punkt) → [(Abstand, Lage, Name)]
        self.zone = {}    # Tour → [Linien]

    def check_point(self, tags, c):
        for t in self.tours:
            for i, p in enumerate(t["points"]):
                if p.get("flt") and matches(tags, p["flt"]):
                    d = dist(c, p["near"])
                    if d <= p.get("radius", 15000):
                        self.cands.setdefault((t["id"], i), []).append((d, c, tags.get("name", "")))

    def node(self, n):
        if not n.tags:
            return
        self.check_point(tagdict(n), [n.location.lon, n.location.lat])

    def way(self, w):
        tags = tagdict(w) if w.tags else {}
        try:
            line = [[round(n.lon, 6), round(n.lat, 6)] for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(line) < 2:
            return
        if w.id in self.need:
            self.geom[w.id] = line
        if not tags:
            return
        self.check_point(tags, line[len(line) // 2])
        for t in self.tours:
            a = t.get("ways")
            if not a or not re.search(a.get("highway", "^(path|footway|track)$"), tags.get("highway", "")):
                continue
            if a.get("name") and not re.search(a["name"], tags.get("name", "")):
                continue
            if any(dist(c, a["near"]) <= a.get("radius", 1500) for c in line[:: max(1, len(line) // 8)]):
                self.zone.setdefault(t["id"], []).append(line)


def stitch(segs, near):
    """Wegstücke einer Route der Reihe nach zu Linien verbinden (Beginn nahe 'near')."""
    if not segs:
        return []
    i0, end = min(((i, e) for i in range(len(segs)) for e in (0, -1)), key=lambda x: dist(segs[x[0]][x[1]], near))
    line = list(segs[i0] if end == 0 else segs[i0][::-1])
    used = {i0}
    lines = [line]
    while len(used) < len(segs):
        tail = line[-1]
        i = min((i for i in range(len(segs)) if i not in used), key=lambda i: min(dist(tail, segs[i][0]), dist(tail, segs[i][-1])))
        s = segs[i]
        gap = min(dist(tail, s[0]), dist(tail, s[-1]))
        used.add(i)
        piece = s if dist(tail, s[0]) <= dist(tail, s[-1]) else s[::-1]
        if gap > 300:
            line = list(piece)
            lines.append(line)
        else:
            line += piece[1:]
    return lines


def decode6(s):
    out, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(res >> 1) if res & 1 else res >> 1)
        lat += vals[0]
        lon += vals[1]
        out.append([round(lon / 1e6, 6), round(lat / 1e6, 6)])
    return out


def route(points):
    q = {"locations": [{"lon": p[0], "lat": p[1], "type": "break"} for p in points], "costing": "pedestrian",
         "costing_options": {"pedestrian": {"max_hiking_difficulty": 6, "use_tracks": 1}},
         "directions_type": "none"}
    for attempt in range(3):
        try:
            req = urllib.request.Request(VALHALLA + "?json=" + urllib.parse.quote(json.dumps(q)), headers={"User-Agent": "overland-navi (pokaXhontas)"})
            r = json.load(urllib.request.urlopen(req, timeout=60))
            coords = []
            for leg in r["trip"]["legs"]:
                pts = decode6(leg["shape"])
                coords += pts[1:] if coords else pts
            return coords
        except urllib.error.HTTPError as e:
            print("  Valhalla:", e.code, e.read()[:200], flush=True)
            if e.code == 400:
                return None
        except Exception as e:
            print("  Valhalla:", e, flush=True)
        time.sleep(10 * (attempt + 1))
    return None


def length(c):
    return sum(dist(c[i - 1], c[i]) for i in range(1, len(c)))


INTEREST = ("natural", "mountain_pass", "tourism", "place", "waterway", "route", "amenity", "historic")


class Explore(osmium.SimpleHandler):
    """Hilfsmodus: benannte Objekte rund um jede Tour auflisten, um Wegpunkte festzulegen."""

    def __init__(self, tours):
        super().__init__()
        self.boxes = []
        for t in tours:
            xs = [p["near"][0] for p in t["points"]]
            ys = [p["near"][1] for p in t["points"]]
            self.boxes.append((t["id"], min(xs) - 0.12, min(ys) - 0.1, max(xs) + 0.12, max(ys) + 0.1))
        self.hits = {b[0]: [] for b in self.boxes}

    def add(self, kind, o, c):
        tags = tagdict(o)
        name = tags.get("name") or tags.get("name:en")
        if not name or not any(k in tags for k in INTEREST):
            return
        if kind == "w" and "route" not in tags and not any(k in tags for k in ("natural", "tourism", "place", "amenity")):
            return
        for tid, x0, y0, x1, y1 in self.boxes:
            if c and x0 <= c[0] <= x1 and y0 <= c[1] <= y1:
                info = ",".join(f"{k}={tags[k]}" for k in INTEREST + ("ele", "name:en") if k in tags)
                self.hits[tid].append(f"{kind} {name} | {info} | {c[0]:.5f},{c[1]:.5f}")

    def node(self, n):
        if n.tags:
            self.add("n", n, [n.location.lon, n.location.lat])

    def way(self, w):
        if not w.tags:
            return
        try:
            c = [w.nodes[len(w.nodes) // 2].lon, w.nodes[len(w.nodes) // 2].lat]
        except Exception:
            return
        self.add("w", w, c)


def explore(defs, pbf):
    tours = json.load(open(defs, encoding="utf-8"))["tours"]
    ex = Explore(tours)
    ex.apply_file(pbf, locations=True, idx="flex_mem")
    for tid, lst in ex.hits.items():
        print(f"\n#### {tid}: {len(lst)} Objekte")
        for h in sorted(lst)[:400]:
            print("  ", h)
    class R(osmium.SimpleHandler):
        def relation(self, r):
            tags = tagdict(r)
            if tags.get("type") == "route" or tags.get("route"):
                print("REL", r.id, tags.get("route"), tags.get("name"), "|", tags.get("name:en", ""))
    print("\n#### Routen-Relationen im Land")
    R().apply_file(pbf)


def main():
    if sys.argv[1] == "--explore":
        return explore(sys.argv[2], sys.argv[3])
    defs, pbf, out = sys.argv[1:4]
    tours = json.load(open(defs, encoding="utf-8"))["tours"]
    for t in tours:
        for p in t["points"]:
            p["flt"] = parse_filter(p.get("filter"))

    t0 = time.time()
    rel = Relations(tours)
    rel.apply_file(pbf)
    print(f"Relationen gelesen ({time.time() - t0:.0f} s), Treffer: {len(rel.found)}", flush=True)
    scan = Scan(tours, rel.need)
    scan.apply_file(pbf, locations=True, idx="flex_mem")
    print(f"Knoten und Wege gelesen ({time.time() - t0:.0f} s)", flush=True)

    # Wegpunkte, die als Relation eingetragen sind (z. B. Seen), mit ihrer Mitte
    for kind, tid, i, name, ways in rel.found:
        if kind != "point":
            continue
        pts = [c for w in ways for c in scan.geom.get(w, [])]
        if pts:
            c = [sum(x[0] for x in pts) / len(pts), sum(x[1] for x in pts) / len(pts)]
            p = next(t for t in tours if t["id"] == tid)["points"][i]
            d = dist(c, p["near"])
            if d <= p.get("radius", 15000):
                scan.cands.setdefault((tid, i), []).append((d, c, name))

    feats = []
    for t in tours:
        print(f"\n== {t['name']}", flush=True)
        pts = []
        for i, p in enumerate(t["points"]):
            c = p["near"]
            if p.get("flt"):
                cs = sorted(scan.cands.get((t["id"], i), []), key=lambda x: x[0])
                if cs:
                    c = cs[0][1]
                    print(f"  gefunden: {p['label']} = {cs[0][2] or '(ohne Namen)'} {[round(v, 5) for v in c]} ({cs[0][0] / 1000:.1f} km von der Schätzung)", flush=True)
                else:
                    print(f"  NICHT gefunden: {p['label']}, nehme Schätzung {c}", flush=True)
            pts.append({"label": p["label"], "icon": p.get("icon", "dot"), "coord": [round(c[0], 6), round(c[1], 6)], "on_route": p.get("on_route", True)})

        lines = []
        if t.get("relation") or t.get("relation_id"):
            routes = [x for x in rel.found if x[0] == "route" and x[1] == t["id"]]
            for _, _, _, name, ways in routes[:1]:
                segs = [scan.geom[w] for w in ways if w in scan.geom]
                lines = stitch(segs, pts[0]["coord"])
                print(f"  Wanderroute: {name} mit {len(segs)} Wegstücken, {len(lines)} Teil(e)", flush=True)
            if not routes:
                print("  Wanderroute nicht gefunden:", t["relation"], flush=True)
        if t.get("ways"):
            lines = scan.zone.get(t["id"], [])
            print(f"  Wege im Gebiet: {len(lines)}", flush=True)
        if not lines and t.get("mode") == "line":
            # Gelände ohne eingetragene Pfade: Punkte direkt verbinden
            lines = [[p["coord"] for p in pts if p["on_route"]]]
            print("  direkt verbunden (keine Pfade eingetragen)", flush=True)
        if not lines:
            via = [p["coord"] for p in pts if p["on_route"]]
            l = route(via) if len(via) >= 2 else None
            if l:
                lines = [l]
                print(f"  Fußweg berechnet über {len(via)} Punkte", flush=True)
        km = sum(length(l) for l in lines) / 1000
        print(f"  Länge: {km:.1f} km (erwartet {t.get('expect_km')})", flush=True)
        feats.append({"type": "Feature", "properties": {"id": t["id"], "kind": "tour", "name": t["name"], "color": t["color"], "km": round(km, 1), "info": t.get("info", t["id"])},
                      "geometry": {"type": "MultiLineString", "coordinates": lines}})
        for p in pts:
            feats.append({"type": "Feature", "properties": {"id": t["id"], "kind": "point", "label": p["label"], "icon": p["icon"]},
                          "geometry": {"type": "Point", "coordinates": p["coord"]}})
    json.dump({"type": "FeatureCollection", "features": feats}, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
