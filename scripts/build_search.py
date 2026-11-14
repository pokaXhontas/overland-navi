#!/usr/bin/env python3
"""Baut pro Kartengebiet einen kleinen Offline-Suchindex aus OpenStreetMap (über die Overpass-API).

Ausgabe: data-cache/<id>/search.json
Format: {"v": 1, "items": [[name, weitere_namen, typ, lat, lon, höhe], ...]}
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

QUERY = """
[out:json][timeout:600];
(
  node["place"~"^(city|town|village|hamlet|suburb|quarter|locality|isolated_dwelling)$"]["name"]({b});
  node["natural"~"^(peak|volcano|saddle|spring)$"]["name"]({b});
  node["mountain_pass"="yes"]["name"]({b});
  nwr["natural"~"^(water|glacier)$"]["name"]({b});
  nwr["waterway"="river"]["name"]({b});
  nwr["tourism"~"^(camp_site|caravan_site|alpine_hut|wilderness_hut|viewpoint|attraction)$"]["name"]({b});
  nwr["amenity"="fuel"]({b});
  node["amenity"="drinking_water"]({b});
  node["barrier"="border_control"]({b});
);
out center tags qt;
"""

ALT_KEYS = ["name:de", "name:en", "int_name", "name:ru", "name:ky", "name:latin", "old_name"]


def classify(t):
    if "place" in t:
        return t["place"]
    if t.get("mountain_pass") == "yes" or t.get("natural") == "saddle":
        return "pass"
    if t.get("natural") in ("peak", "volcano"):
        return "peak"
    if t.get("natural") == "spring":
        return "spring"
    if t.get("natural") == "glacier":
        return "glacier"
    if t.get("natural") == "water":
        return "water"
    if t.get("waterway") == "river":
        return "river"
    if t.get("amenity") == "fuel":
        return "fuel"
    if t.get("amenity") == "drinking_water":
        return "drink"
    if t.get("barrier") == "border_control":
        return "border"
    tour = t.get("tourism", "")
    return {"camp_site": "camp", "caravan_site": "camp", "alpine_hut": "hut", "wilderness_hut": "hut",
            "viewpoint": "view", "attraction": "sight"}.get(tour, "other")


DEFAULT_NAMES = {"fuel": "Tankstelle", "drink": "Trinkwasser", "border": "Grenzkontrolle"}


def fetch(bbox):
    w, s, e, n = bbox
    q = QUERY.replace("{b}", f"{s},{w},{n},{e}")
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(3):
        for url in ENDPOINTS:
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "overland-navi build (GitHub Actions)"})
                with urllib.request.urlopen(req, timeout=900) as r:
                    return json.load(r)
            except Exception as ex:  # noqa: BLE001
                last = ex
                print(f"  {url}: {ex}", flush=True)
                time.sleep(10)
    raise RuntimeError(f"Overpass nicht erreichbar: {last}")


def build(region):
    out = f"data-cache/{region['id']}/search.json"
    if os.path.exists(out) and os.path.getsize(out) > 200:
        print(f"{region['id']}: Suchindex aus dem Cache")
        return
    print(f"{region['id']}: lade Suchdaten …", flush=True)
    elements = []
    for box in region["boxes"]:
        try:
            elements += fetch(box).get("elements", [])
        except Exception as ex:  # noqa: BLE001
            print(f"WARNUNG: {ex} – Teil der Suche für {region['id']} fehlt", flush=True)
    items, seen = [], set()
    for el in elements:
        t = el.get("tags", {})
        typ = classify(t)
        name = t.get("name") or DEFAULT_NAMES.get(typ)
        if not name:
            continue
        if el["type"] == "node":
            lat, lon = el["lat"], el["lon"]
        elif "center" in el:
            lat, lon = el["center"]["lat"], el["center"]["lon"]
        else:
            continue
        key = (name, typ, round(lat, 2), round(lon, 2))
        if key in seen:
            continue
        seen.add(key)
        alts = []
        for k in ALT_KEYS:
            v = t.get(k)
            if v and v != name and v not in alts:
                alts.append(v)
        ele = t.get("ele", "")
        try:
            ele = int(float(str(ele).replace(",", ".").split()[0])) if ele else None
        except ValueError:
            ele = None
        items.append([name, "|".join(alts), typ, round(lat, 5), round(lon, 5), ele])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "items": items}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{region['id']}: {len(items)} Einträge, {os.path.getsize(out) // 1024} kB")


def main():
    regions = json.load(open("regions.json", encoding="utf-8"))
    for r in regions:
        build(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
