#!/usr/bin/env python3
"""Zeigt, welche OpenStreetMap-Objekte die Wanderebene als Biwak/Hütte einträgt (mit allen Tags).
Aufruf: check_points.py <datei.osm.pbf> [Arten, z. B. biwak,huette]"""
import sys
import osmium

src = open(__file__.replace("check_points.py", "build_hiking.py"), encoding="utf-8").read()
ns = {}
exec(src[:src.index("# ---------- Touren-Paket")], ns)   # nur Regeln und Klassen, nicht das ganze Skript
kinds = set((sys.argv[2] if len(sys.argv) > 2 else "biwak,huette").split(","))


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.n = 0

    def show(self, o, typ, loc, lon=None, lat=None):
        t = {x.k: x.v for x in o.tags}
        k = ns["point_kind"](t)
        if k in kinds and lon is not None and k in ("biwak", "huette") and places.urban(lon, lat):
            print(f"  (im Ort, fällt weg) {typ}{o.id} {loc} {t.get('name', '')}")
            return
        if k in kinds:
            self.n += 1
            print(f"{k:7} {typ}{o.id} {loc} " + " ".join(f"{a}={b}" for a, b in sorted(t.items()) if not a.startswith(("name:", "source", "check_date"))))

    def node(self, n):
        if n.tags:
            self.show(n, "n", f"{n.location.lat:.5f},{n.location.lon:.5f}", n.location.lon, n.location.lat)

    def way(self, w):
        if w.tags:
            try:
                c = w.nodes[0].location
                self.show(w, "w", f"{c.lat:.5f},{c.lon:.5f}", c.lon, c.lat)
            except Exception:
                self.show(w, "w", "?")


places = ns["Places"]()
places.apply_file(sys.argv[1])
h = H()
h.apply_file(sys.argv[1], locations=True, idx="flex_mem")
print(h.n, "Treffer")
