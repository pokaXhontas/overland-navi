#!/usr/bin/env python3
"""Baut die empfohlenen Touren (Linie + Wegpunkte) aus OpenStreetMap.

Wegpunkte werden über ihre OSM-Namen gesucht (mit Ersatzkoordinate), der Weg dazwischen
mit Valhalla als Fußweg berechnet oder aus einer eingetragenen Wanderroute zusammengesetzt.
Aufruf: build_tours.py <touren.json> <ausgabe.geojson>
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
VALHALLA = "https://valhalla1.openstreetmap.de/route"


def http(url, data=None, timeout=180):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "overland-navi (pokaXhontas)"})
            return json.load(urllib.request.urlopen(req, timeout=timeout))
        except Exception as e:
            print("  Netzfehler:", e, flush=True)
            time.sleep(10 * (attempt + 1))
    return None


def overpass(q):
    for u in OVERPASS:
        r = http(u, urllib.parse.urlencode({"data": "[out:json][timeout:120];" + q}).encode())
        if r is not None:
            return r.get("elements", [])
    return []


def dist(a, b):
    k = math.pi / 180
    x = (b[0] - a[0]) * math.cos((a[1] + b[1]) / 2 * k)
    y = b[1] - a[1]
    return math.hypot(x, y) * 111195


def center(el):
    if "lat" in el:
        return [el["lon"], el["lat"]]
    if "center" in el:
        return [el["center"]["lon"], el["center"]["lat"]]
    if "geometry" in el:
        g = el["geometry"]
        return [g[len(g) // 2]["lon"], g[len(g) // 2]["lat"]]
    return None


def find(p):
    """Wegpunkt per Name suchen: nächster Treffer zur Ersatzkoordinate."""
    lon, lat = p["near"]
    r = p.get("radius", 15000)
    q = "".join(f'{t}{p["filter"]}(around:{r},{lat},{lon});' for t in ("node", "way", "relation"))
    els = overpass(f"({q});out center tags;")
    best = None
    for e in els:
        c = center(e)
        if c and (best is None or dist(c, p["near"]) < dist(best[0], p["near"])):
            best = (c, e.get("tags", {}).get("name", ""))
    if best:
        print(f"  gefunden: {p['label']} = {best[1]} {best[0]} ({dist(best[0], p['near']) / 1000:.1f} km von der Schätzung)", flush=True)
        return best[0]
    print(f"  NICHT gefunden: {p['label']}, nehme Schätzung {p['near']}", flush=True)
    return p["near"]


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
         "costing_options": {"pedestrian": {"max_hiking_difficulty": 6, "use_tracks": 1, "walking_speed": 4}},
         "directions_options": {"units": "kilometers"}, "directions_type": "none"}
    r = http(VALHALLA + "?json=" + urllib.parse.quote(json.dumps(q)))
    if not r or "trip" not in r:
        print("  Valhalla: keine Route", r and r.get("error"), flush=True)
        return None
    coords = []
    for leg in r["trip"]["legs"]:
        pts = decode6(leg["shape"])
        coords += pts[1:] if coords else pts
    return coords


def relation_line(name_re, near):
    """Eingetragene Wanderroute zu einer Linie zusammensetzen."""
    lon, lat = near
    els = overpass(f'relation["route"="hiking"]["name"~"{name_re}"](around:40000,{lat},{lon});out geom;')
    if not els:
        print("  Wanderroute nicht gefunden:", name_re, flush=True)
        return None
    segs = [[[g["lon"], g["lat"]] for g in m["geometry"]] for m in els[0]["members"] if m.get("type") == "way" and m.get("geometry")]
    print(f"  Wanderroute: {els[0]['tags'].get('name')} mit {len(segs)} Wegstücken", flush=True)
    # am Ende, das der Schätzung am nächsten liegt, beginnen und der Reihe nach anhängen
    start = min(((i, s, end) for i, s in enumerate(segs) for end in (0, -1)), key=lambda x: dist(x[1][x[2]], near))
    line = segs[start[0]] if start[2] == 0 else segs[start[0]][::-1]
    used = {start[0]}
    while len(used) < len(segs):
        tail = line[-1]
        cand = min(((i, s) for i, s in enumerate(segs) if i not in used), key=lambda x: min(dist(tail, x[1][0]), dist(tail, x[1][-1])))
        i, s = cand
        if min(dist(tail, s[0]), dist(tail, s[-1])) > 1500:
            break
        line += (s if dist(tail, s[0]) <= dist(tail, s[-1]) else s[::-1])[1:]
        used.add(i)
    return line


def ways_lines(w):
    """Alle Wege eines Gebiets, z. B. Canyons ohne durchgehende Route."""
    lon, lat = w["near"]
    name = f'["name"~"{w["name"]}"]' if w.get("name") else ""
    els = overpass(f'way["highway"~"{w.get("highway", "path|footway|track")}"]{name}(around:{w.get("radius", 1500)},{lat},{lon});out geom;')
    lines = [[[g["lon"], g["lat"]] for g in e["geometry"]] for e in els if e.get("geometry")]
    print(f"  Wege im Gebiet: {len(lines)}", flush=True)
    return lines


def length(c):
    return sum(dist(c[i - 1], c[i]) for i in range(1, len(c)))


def main():
    tours = json.load(open(sys.argv[1], encoding="utf-8"))
    feats = []
    for t in tours:
        print(f"\n== {t['name']}", flush=True)
        pts = []
        for p in t["points"]:
            c = find(p) if "filter" in p else p["near"]
            pts.append({**p, "coord": c})
            time.sleep(2)
        lines = []
        if t.get("relation"):
            l = relation_line(t["relation"], t["points"][0]["near"])
            if l:
                lines.append(l)
        if t.get("ways"):
            lines = ways_lines(t["ways"])
        if not lines:
            for part in t.get("legs", [[p["label"] for p in t["points"] if p.get("on_route", True)]]):
                via = [next(x["coord"] for x in pts if x["label"] == lab) for lab in part]
                l = route(via)
                if l:
                    lines.append(l)
                time.sleep(2)
        km = sum(length(l) for l in lines) / 1000
        print(f"  Länge: {km:.1f} km (erwartet {t.get('expect_km')})", flush=True)
        feats.append({"type": "Feature", "properties": {"id": t["id"], "kind": "tour", "name": t["name"], "color": t["color"], "km": round(km, 1), "info": t.get("info", t["id"])},
                      "geometry": {"type": "MultiLineString", "coordinates": lines}})
        for p in pts:
            feats.append({"type": "Feature", "properties": {"id": t["id"], "kind": "point", "label": p["label"], "icon": p.get("icon", "dot")},
                          "geometry": {"type": "Point", "coordinates": p["coord"]}})
    json.dump({"type": "FeatureCollection", "features": feats}, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    main()
