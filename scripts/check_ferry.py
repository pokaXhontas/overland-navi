#!/usr/bin/env python3
"""Hilfswerkzeug: Wie fängt Valhalla einen Punkt auf See ein, und nimmt die Route dann die Fähre?"""
import json
import sys
import urllib.parse
import urllib.request

V = "https://valhalla1.openstreetmap.de"


def get(path, q):
    req = urllib.request.Request(f"{V}/{path}?json=" + urllib.parse.quote(json.dumps(q)), headers={"User-Agent": "overland-navi (pokaXhontas)"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=90))
    except urllib.error.HTTPError as e:
        return {"fehler": e.code, "text": e.read()[:300].decode()}


for lat, lon in [(54.776865, 12.481319), (54.70, 12.60), (54.90, 12.75)]:
    print(f"== locate {lat},{lon}")
    d = get("locate", {"locations": [{"lat": lat, "lon": lon}], "costing": "auto", "verbose": True})
    if isinstance(d, dict):
        print("  ", d); continue
    for loc in d:
        edges = loc.get("edges") or []
        if not edges:
            print("   keine Kanten")
        for e in edges[:4]:
            ei, ed = e.get("edge_info", {}), e.get("edge", {})
            print("  ", ei.get("names"), ed.get("use"), "Abstand", round(e.get("distance", 0)), e.get("correlated_lat"), e.get("correlated_lon"))

stops = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
for via in stops:
    print("== Route Berlin -> Trelleborg über", via)
    q = {"locations": [{"lat": 52.52, "lon": 13.405}, via, {"lat": 55.3759, "lon": 13.1461}], "costing": "auto"}
    d = get("route", q)
    if "trip" not in d:
        print("   Fehler", d); continue
    t = d["trip"]
    print("  ", round(t["summary"]["length"]), "km", round(t["summary"]["time"] / 3600, 1), "h")
    for leg in t["legs"]:
        for m in leg["maneuvers"]:
            if m.get("travel_type") == "ferry" or m["type"] in (28, 29):
                print("    Fähre:", m["type"], m.get("street_names"), round(m["length"]), "km", round(m["time"] / 60), "min")
