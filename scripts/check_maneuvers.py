#!/usr/bin/env python3
"""Abbiegehinweise prüfen: dieselbe Strecke bei OSRM und Valhalla abfragen und zeigen, was die App daraus macht
(Text und Sprachbaustein), dazu der tatsächliche Knick der Straße an jeder Stelle.
Aufruf: check_maneuvers.py "<Start>" "<Ziel>"   (Adresse oder lat,lon)"""
import json
import math
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "overland-navi-check (pokaXhontas)"}


def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))


def place(q):
    if "," in q and all(p.strip().replace(".", "").replace("-", "").isdigit() for p in q.split(",")):
        a, b = (float(x) for x in q.split(","))
        return a, b, q
    r = get("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + urllib.parse.quote(q))
    return float(r[0]["lat"]), float(r[0]["lon"]), r[0]["display_name"][:90]


def act(t, exit_=0):
    if t in (4, 5, 6):
        return "dest"
    if t == 26:
        return f"rb{exit_}" if 1 <= exit_ <= 6 else "rb"
    return {9: "slight_right", 10: "right", 11: "sharp_right", 12: "uturn", 13: "uturn", 14: "sharp_left", 15: "left", 16: "slight_left",
            17: "ramp", 18: "ramp", 19: "ramp", 20: "exit_right", 21: "exit_left", 22: "straight", 23: "keep_right", 24: "keep_left",
            25: "merge", 28: "ferry"}.get(t, "straight")


def osrm_type(s):
    t, m = s["maneuver"]["type"], s["maneuver"].get("modifier", "")
    if t == "arrive":
        return 4
    if t in ("roundabout", "rotary"):
        return 26
    return {"left": 15, "right": 10, "slight left": 16, "slight right": 9, "sharp left": 14, "sharp right": 11, "uturn": 13}.get(m, 8)


def turn(a, b):
    d = (b - a + 540) % 360 - 180
    return d


a = place(sys.argv[1])
b = place(sys.argv[2])
print("Start:", a, "\nZiel: ", b)

print("\n=== OSRM ===")
o = get(f"https://routing.openstreetmap.de/routed-car/route/v1/driving/{a[1]},{a[0]};{b[1]},{b[0]}?overview=full&geometries=geojson&steps=true&alternatives=true")
def hav(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    x = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 12742017.6 * math.asin(math.sqrt(x))


def brg(a, b):
    la1, la2, dl = math.radians(a[1]), math.radians(b[1]), math.radians(b[0] - a[0])
    return math.degrees(math.atan2(math.sin(dl) * math.cos(la2), math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl))) % 360


def geo_type(c, i, s):
    def walk(m, d):
        k, dd = i, 0.0
        while 0 <= k + d < len(c) and dd < m:
            dd += hav(c[k], c[k + d]); k += d
        return k
    a, b = walk(25, -1), walk(25, 1)
    t = s["maneuver"]["type"]
    ang = turn(brg(c[a], c[i]), brg(c[i], c[b])) if a != i and b != i else 0
    x = abs(ang)
    if t == "depart": return 1, ang
    if t == "arrive": return 4, ang
    if t in ("roundabout", "rotary"): return 26, ang
    if t in ("exit roundabout", "exit rotary"): return 27, ang
    if t == "fork": return (23 if ang >= 0 else 24), ang
    if t == "end of road": return (10 if ang >= 0 else 15), ang
    if x >= 170: return 13, ang
    if x >= 135: return (11 if ang > 0 else 14), ang
    if x >= 45: return (10 if ang > 0 else 15), ang
    if x >= 20: return (9 if ang > 0 else 16), ang
    return 0, ang


for ri, route in enumerate(o["routes"]):
    print(f"-- Vorschlag {ri + 1}: {route['distance'] / 1000:.1f} km, {route['duration'] / 60:.0f} min")
    c = route["geometry"]["coordinates"]
    idx = 0
    for s in route["legs"][0]["steps"]:
        mv = s["maneuver"]
        lon, lat = mv["location"]
        idx = min(range(idx, len(c)), key=lambda k: abs(c[k][0] - lon) + abs(c[k][1] - lat))
        ang = turn(mv.get("bearing_before", 0), mv.get("bearing_after", 0))
        t = osrm_type(s)
        nt, gang = geo_type(c, idx, s)
        print(f"  {mv['type']:<12} {mv.get('modifier', ''):<12} OSRM-Knick {ang:+5.0f}° alt '{act(t, mv.get('exit', 0))}' | gemessen {gang:+5.0f}° neu '{act(nt) if nt else '(kein Hinweis)'}'  {s.get('name', '')}  ({s['distance']:.0f} m)")

print("\n=== Valhalla ===")
q = {"locations": [{"lat": a[0], "lon": a[1]}, {"lat": b[0], "lon": b[1]}], "costing": "auto",
     "costing_options": {"auto": {"use_tracks": 0, "use_highways": 1, "use_living_streets": 0.6, "destination_only_penalty": 120, "service_penalty": 10}},
     "directions_options": {"units": "kilometers", "language": "de-DE"}, "alternates": 1}
v = get("https://valhalla1.openstreetmap.de/route?json=" + urllib.parse.quote(json.dumps(q)))
for ti, trip in enumerate([v["trip"]] + [x["trip"] for x in v.get("alternates", [])]):
    print(f"-- Vorschlag {ti + 1}: {trip['summary']['length']:.1f} km, {trip['summary']['time'] / 60:.0f} min")
    for m in trip["legs"][0]["maneuvers"]:
        print(f"  Typ {m['type']:<2} → Ansage '{act(m['type'], m.get('roundabout_exit_count', 0))}'  {m['instruction']}  ({m['length'] * 1000:.0f} m)")
print(json.dumps({"a": a[:2], "b": b[:2]}))
