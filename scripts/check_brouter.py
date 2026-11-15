#!/usr/bin/env python3
"""Hilfswerkzeug: BRouter (Wander-Profil) ansehen: Antwortformat, Abbiegehinweise, Wegarten."""
import json
import urllib.request
from collections import Counter

for prof in ("hiking-mountain", "trekking"):
    # Bad Urach -> Reutlingen (beide Städte, Wanderwege dazwischen)
    U = f"https://brouter.de/brouter?lonlats=9.398,48.493|9.204,48.491&profile={prof}&alternativeidx=0&format=geojson&timode=3"
    req = urllib.request.Request(U, headers={"User-Agent": "overland-navi (pokaXhontas)", "Origin": "https://pokaxhontas.github.io"})
    try:
        r = urllib.request.urlopen(req, timeout=90)
    except Exception as e:
        print(prof, "Fehler", e); continue
    print("==", prof, "CORS:", r.headers.get("Access-Control-Allow-Origin"))
    d = json.load(r)
    f = d["features"][0]
    p = f["properties"]
    print("  Merkmale:", {k: (v if not isinstance(v, list) else f"Liste[{len(v)}]") for k, v in p.items()})
    print("  Punkte:", len(f["geometry"]["coordinates"]), f["geometry"]["coordinates"][0])
    msgs = p.get("messages", [])
    print("  messages Kopf:", msgs[:1], "Beispiel:", msgs[1:3])
    hdr = msgs[0] if msgs else []
    wi = hdr.index("WayTags") if "WayTags" in hdr else None
    di = hdr.index("Distance") if "Distance" in hdr else None
    if wi is not None:
        tot, route, road = 0, 0, Counter()
        for m in msgs[1:]:
            dd = int(m[di]); tot += dd
            tags = m[wi]
            if "route_hiking" in tags or "route_foot" in tags: route += dd
            hw = [t.split("=")[1] for t in tags.split() if t.startswith("highway=")]
            road[hw[0] if hw else "?"] += dd
        print(f"  Länge {tot} m, auf Wanderrouten {route} m ({100 * route // max(tot, 1)} %), Wegarten:", road.most_common(8))
    print("  voicehints:", (p.get("voicehints") or [])[:4])
