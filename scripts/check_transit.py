#!/usr/bin/env python3
"""Hilfswerkzeug: Antwort der Transitous-Verbindungssuche (MOTIS) ansehen."""
import json
import urllib.request

import sys
U = sys.argv[1] if len(sys.argv) > 1 else "https://api.transitous.org/api/v5/plan?fromPlace=52.5219,13.4132&toPlace=52.5076,13.3904&numItineraries=3"
req = urllib.request.Request(U, headers={"User-Agent": "overland-navi (https://github.com/pokaXhontas/overland-navi)", "Origin": "https://pokaxhontas.github.io"})
r = urllib.request.urlopen(req, timeout=60)
print("CORS:", r.headers.get("Access-Control-Allow-Origin"))
d = json.load(r)
print("Schlüssel:", list(d.keys()))
for it in d.get("itineraries", [])[:3]:
    print("== Verbindung", {k: v for k, v in it.items() if k != "legs"})
    for leg in it["legs"]:
        short = {k: (v if not isinstance(v, (dict, list)) else type(v).__name__) for k, v in leg.items()}
        print("  Abschnitt:", json.dumps(short, ensure_ascii=False)[:600])
        print("    from:", json.dumps(leg.get("from"), ensure_ascii=False)[:300])
        lg = leg.get("legGeometry") or {}
        print("    Geometrie:", {k: (v[:40] if isinstance(v, str) else v) for k, v in lg.items()})
        if leg.get("steps"):
            print("    Schritt:", json.dumps(leg["steps"][0], ensure_ascii=False)[:300])
