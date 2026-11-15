#!/usr/bin/env python3
"""Zieht Wanderwege aus einem OpenStreetMap-Auszug (.osm.pbf, vorgefiltert) und schreibt sie als
GeoJSON-Zeilen für tippecanoe.

Je Weg: SAC-Schwierigkeit (T1–T6), Name, Wegspur, Wegart und die Wanderrouten, zu denen er gehört.
Dazu Punkte (Biwaks, Hütten, Unterstände, Wasser) und die bekanntesten Wanderrouten des Landes
als Touren-Paket für die App.
Dazu Bus- und Bahnnetz (Linien und Haltestellen) in Städten ab 50.000 Einwohnern.
Aufruf: build_hiking.py <gefiltert.osm.pbf> <wege.geojsonseq> [punkte.geojsonseq] [touren.json] [oev.geojsonseq]
"""
import json
import math
import re
import sys
from collections import defaultdict

import osmium

SAC = {"hiking": 1, "mountain_hiking": 2, "demanding_mountain_hiking": 3,
       "alpine_hiking": 4, "demanding_alpine_hiking": 5, "difficult_alpine_hiking": 6}
VIS = {"excellent": 1, "good": 2, "intermediate": 3, "bad": 4, "horrible": 5, "no": 6}
NET = {"iwn": 4, "nwn": 3, "rwn": 2, "lwn": 1}

src, dst = sys.argv[1], sys.argv[2]
dst_pts = sys.argv[3] if len(sys.argv) > 3 else None
dst_tours = sys.argv[4] if len(sys.argv) > 4 else None
dst_oev = sys.argv[5] if len(sys.argv) > 5 else None
routes = []
member = defaultdict(list)

# ---------- Punkte: Biwaks, Hütten, Unterstände, Wasser ----------
BIWAK_RE = re.compile(r"biwak|bivacc|bivouac|bivak|bivac|biwakschachtel|refuge non gard|abri", re.I)
PT_MINZOOM = {"biwak": 9, "huette": 9, "wasser": 12, "quelle": 12, "ruine": 11, "burg": 11, "archaeologie": 11,
              "denkmal": 13, "hoehle": 12, "wasserfall": 12, "aussicht": 12, "sehenswert": 12}
MEMORIAL_SMALL = {"plaque", "stolperstein", "blue_plaque", "bench", "ghost_bike", "stone", "cross", "tree"}


def point_kind(t):
    tour, am = t.get("tourism"), t.get("amenity")
    if tour == "wilderness_hut":
        return "biwak"
    if tour == "alpine_hut":
        return "biwak" if BIWAK_RE.search(t.get("name", "")) or t.get("alpine_hut") == "unattended" else "huette"
    if am == "shelter":
        # nur geschlossene Hütten zum Übernachten, keine Unterstände, Wartehäuschen oder Pavillons
        return "biwak" if t.get("shelter_type") == "basic_hut" and not t.get("public_transport") else None
    if am in ("drinking_water", "water_point"):
        return "wasser"
    if t.get("natural") == "spring":
        return "quelle"
    # Sehenswertes unterwegs
    hist = t.get("historic")
    if hist == "ruins" or t.get("building") == "ruins" or (hist in ("castle", "fort") and t.get("ruins") == "yes"):
        return "ruine"
    if hist in ("castle", "fort", "city_gate", "tower"):
        return "burg" if hist != "tower" or t.get("name") else None
    if hist == "archaeological_site":
        return "archaeologie"
    if hist == "monument" or (hist == "memorial" and t.get("name") and t.get("memorial") not in MEMORIAL_SMALL):
        return "denkmal"
    if t.get("natural") == "cave_entrance":
        return "hoehle"
    if t.get("waterway") == "waterfall":
        return "wasserfall"
    if tour == "viewpoint":
        return "aussicht"
    if tour == "attraction" and t.get("name"):
        return "sehenswert"
    return None


def point_props(k, t):
    p = {"k": k}
    name = t.get("name:de") or t.get("name")
    if name:
        p["n"] = name[:60]
    m = re.match(r"^\s*(\d{1,4})", t.get("ele", ""))
    if m:
        p["e"] = int(m.group(1))
    cap = t.get("capacity") or t.get("beds")
    if cap and re.match(r"^\d{1,4}$", cap):
        p["cap"] = int(cap)
    for key, short in (("fireplace", "fp"), ("locked", "lk"), ("drinking_water", "dw"), ("reservation", "res"), ("fee", "fee")):
        if t.get(key) in ("yes", "no", "required", "recommended"):
            p[short] = t[key]
    if t.get("shelter_type"):
        p["st"] = t["shelter_type"][:20]
    if t.get("operator"):
        p["op"] = t["operator"][:50]
    web = t.get("website") or t.get("contact:website")
    if web and len(web) <= 120:
        p["web"] = web
    if t.get("opening_hours") and len(t["opening_hours"]) <= 60:
        p["oh"] = t["opening_hours"]
    wp = re.match(r"^([a-z-]{2,12}):(.+)$", t.get("wikipedia", ""))
    if wp:
        p["wp"] = f"https://{wp.group(1)}.wikipedia.org/wiki/{wp.group(2).replace(' ', '_')}"[:160]
    d = t.get("description:de") or t.get("description")
    if d:
        p["d"] = d[:200]
    sd = t.get("start_date") or t.get("construction_date")
    if sd and len(sd) <= 20:
        p["sd"] = sd
    for key in ("castle_type", "site_type", "memorial", "historic:civilization"):
        if t.get(key) and len(t[key]) <= 30:
            p["ty"] = t[key]
            break
    return p


def write_point(out, k, t, lon, lat):
    f = {"type": "Feature", "properties": point_props(k, t), "tippecanoe": {"minzoom": PT_MINZOOM[k]},
         "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]}}
    out.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")


class Points(osmium.SimpleHandler):
    def __init__(self, out):
        super().__init__()
        self.out = out
        self.n = 0

    def node(self, n):
        if not n.tags:
            return
        t = {x.k: x.v for x in n.tags}
        k = point_kind(t)
        if k:
            write_point(self.out, k, t, n.location.lon, n.location.lat)
            self.n += 1

    def way(self, w):
        if not w.tags:
            return
        t = {x.k: x.v for x in w.tags}
        k = point_kind(t)
        if not k:
            return
        try:
            cs = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if cs:
            write_point(self.out, k, t, sum(c[0] for c in cs) / len(cs), sum(c[1] for c in cs) / len(cs))
            self.n += 1


# ---------- Touren-Paket: die bekanntesten Wanderrouten ----------
TOUR_COLORS = ["#C2255C", "#2F9E44", "#E8590C", "#7048E8", "#1098AD", "#B5482A", "#5C940D", "#D6336C", "#1C6DD0", "#AE3EC9"]
cands = {}        # Relations-ID → Infos
supers = {}       # Fernwege aus Etappen (Superroute) → Infos
rel_ways = {}     # alle Wanderrouten → Weg-IDs
cand_ways = defaultdict(list)
geom = {}
way_sac = {}


GENERIC_RE = re.compile(r"^\s*(pass|route|trail|weg|tour|path|перевал|маршрут)?\s*[\d.,]+\s*(m|м)?\s*(pass|перевал)?\s*$", re.I)


def tour_score(t):
    sc = 0
    if t.get("wikidata") or t.get("wikipedia"):
        sc += 4
    sc += {"iwn": 3, "nwn": 2, "rwn": 1}.get(t.get("network", ""), 0)
    if t.get("description") or t.get("description:de") or t.get("description:en"):
        sc += 1
    if t.get("website") or t.get("url"):
        sc += 1
    return sc


class Rels(osmium.SimpleHandler):
    def relation(self, r):
        if r.tags.get("route") not in ("hiking", "foot"):
            return
        name = r.tags.get("name:de") or r.tags.get("name:en") or r.tags.get("name") or r.tags.get("ref") or ""
        info = {"name": name[:60], "ref": (r.tags.get("ref") or "")[:12], "net": NET.get(r.tags.get("network", ""), 1),
                "col": (r.tags.get("osmc:symbol") or "").split(":")[0][:10]}
        routes.append(info)
        idx = len(routes) - 1
        ways = [m.ref for m in r.members if m.type == "w"]
        for w in ways:
            member[w].append(idx)
        t = {x.k: x.v for x in r.tags}
        nm = t.get("name:de") or t.get("name:en") or t.get("name")
        subs = [m.ref for m in r.members if m.type == "r"]
        rel_ways[r.id] = ways
        if t.get("state") in ("proposed", "disused") or not nm:
            return
        if subs and (t.get("type") == "superroute" or not ways):
            supers[r.id] = {"t": t, "name": nm, "subs": subs}
        elif ways and t.get("type") == "route":
            cands[r.id] = {"t": t, "name": nm, "ways": ways, "score": tour_score(t)}


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
        if w.id in need_geom:
            try:
                geom[w.id] = [(n.lon, n.lat) for n in w.nodes]
                way_sac[w.id] = sac
            except osmium.InvalidLocationError:
                pass
        walk = hw in ("path", "footway", "bridleway", "steps", "via_ferrata", "track")
        if not rs and not sac and not walk:
            return
        if hw in ("motorway", "trunk", "primary", "secondary") and not rs:
            return
        if t.get("footway") in ("sidewalk", "crossing", "traffic_island") or t.get("area") == "yes":
            return
        if t.get("access") in ("private", "no") and not rs:
            return
        try:
            coords = [(round(n.lon, 6), round(n.lat, 6)) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return
        p = {"s": sac, "h": {"path": "p", "footway": "f", "bridleway": "b", "steps": "s", "via_ferrata": "k", "track": "t"}.get(hw, "o")}
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
        if rs:
            minz = 8 if p.get("net", 0) >= 3 else 9 if p.get("net") == 2 else 10
        elif sac:
            minz = 10
        elif hw in ("path", "bridleway", "via_ferrata"):
            minz = 11
        elif hw == "track":
            minz = 12
        else:
            minz = 13
        f = {"type": "Feature", "properties": p, "tippecanoe": {"minzoom": minz},
             "geometry": {"type": "LineString", "coordinates": coords}}
        self.out.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.n += 1


def dist(a, b):
    k = math.pi / 180
    return math.hypot((b[0] - a[0]) * math.cos((a[1] + b[1]) / 2 * k), b[1] - a[1]) * 111195


def length(line):
    return sum(dist(line[i - 1], line[i]) for i in range(1, len(line)))


def simplify(line, tol):
    """Douglas-Peucker in Metern (ohne Rekursion)."""
    if len(line) < 3:
        return line
    keep = [False] * len(line)
    keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]
    k = math.cos(line[0][1] * math.pi / 180) * 111195
    while stack:
        a, b = stack.pop()
        ax, ay = line[a][0] * k, line[a][1] * 111195
        bx, by = line[b][0] * k, line[b][1] * 111195
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1e-9
        best, bi = 0, -1
        for i in range(a + 1, b):
            px, py = line[i][0] * k, line[i][1] * 111195
            d = abs(dy * px - dx * py + bx * ay - by * ax) / L
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, kk in zip(line, keep) if kk]


def stitch(segs):
    """Wegstücke zu möglichst wenigen Linien verbinden (vorn oder hinten anhängen)."""
    segs = [s for s in segs if len(s) > 1]
    if not segs:
        return []
    line = list(segs[0])
    lines = [line]
    left = set(range(1, len(segs)))
    while left:
        best = None
        for i in left:
            sg = segs[i]
            for where, pt in (("tail", line[-1]), ("head", line[0])):
                for piece in (sg, sg[::-1]):
                    g = dist(pt, piece[0] if where == "tail" else piece[-1])
                    if best is None or g < best[0]:
                        best = (g, i, where, piece)
        g, i, where, piece = best
        left.discard(i)
        if g > 300:
            line = list(piece)
            lines.append(line)
        elif where == "tail":
            line += piece[1:]
        else:
            line[:0] = piece[:-1]
    main = max(length(l) for l in lines)
    return [l for l in lines if length(l) >= min(1000, main * 0.2)]


def wiki_url(v):
    m = re.match(r"^([a-z-]{2,12}):(.+)$", v or "")
    return f"https://{m.group(1)}.wikipedia.org/wiki/{m.group(2).replace(' ', '_')}" if m else None


def write_tours(path):
    feats = []
    picked = []
    for rid, c in sorted(cands.items(), key=lambda x: (-x[1]["score"], -len(x[1]["ways"]))):
        have = [w for w in c["ways"] if w in geom]
        # an der Landesgrenze abgeschnittene Routen weglassen (Wege fehlen im Länderauszug)
        if len(have) < 0.85 * len(c["ways"]):
            continue
        lines = stitch([geom[w] for w in have])
        if not lines:
            continue
        km = sum(length(l) for l in lines) / 1000
        if km < 2 or km > 600:
            continue
        # Tageswanderungen und Mehrtagestouren vor sehr langen Fernwegen, bei gleicher Bekanntheit
        bonus = 1 if 5 <= km <= 120 else 0
        picked.append((c["score"] + bonus, km, rid, c, lines))
        if len(picked) >= 200:
            break
    # Namen ohne Aussage („Pass 3160m“, „Route 12“) weglassen; bei genug Auswahl nur Routen mit Hinweis auf Bekanntheit
    picked = [x for x in picked if not GENERIC_RE.match(x[3]["name"])]
    if sum(1 for x in picked if x[0] > 1) >= 15:
        picked = [x for x in picked if x[0] > 1]
    # gleicher Name nur einmal (die längste Fassung)
    best = {}
    for x in picked:
        k = x[3]["name"].strip().lower()
        if k not in best or (x[0], x[1]) > (best[k][0], best[k][1]):
            best[k] = x
    picked = sorted(best.values(), key=lambda x: (-x[0], x[1]))
    for n, (sc, km, rid, c, lines) in enumerate(picked[:40]):
        t = c["t"]
        tol = 8 if km < 30 else 20 if km < 150 else 40
        lines = [[[round(p[0], 5), round(p[1], 5)] for p in simplify(l, tol)] for l in lines]
        col = (t.get("osmc:symbol") or "").split(":")[0]
        sac = max((way_sac.get(w, 0) for w in c["ways"]), default=0)
        p = {"id": f"osm-{rid}", "kind": "tour", "name": c["name"][:80], "km": round(km, 1),
             "color": TOUR_COLORS[n % len(TOUR_COLORS)], "osm": rid, "score": sc}
        for key, short in (("from", "from"), ("to", "to"), ("ref", "ref"), ("operator", "op"), ("roundtrip", "rt"),
                           ("ascent", "asc"), ("descent", "desc_m"), ("duration", "dur"), ("distance", "dist")):
            if t.get(key):
                p[short] = t[key][:80]
        d = t.get("description:de") or t.get("description") or t.get("description:en")
        if d:
            p["desc"] = d[:600]
        if wiki_url(t.get("wikipedia")):
            p["wiki"] = wiki_url(t.get("wikipedia"))
        web = t.get("website") or t.get("url")
        if web and len(web) <= 200:
            p["web"] = web
        if t.get("network"):
            p["net"] = t["network"]
        if col:
            p["mark"] = col
        if sac:
            p["sac"] = sac
        feats.append({"type": "Feature", "properties": p, "geometry": {"type": "MultiLineString", "coordinates": lines}})
        a, b = lines[0][0], lines[-1][-1]
        feats.append({"type": "Feature", "properties": {"id": p["id"], "kind": "point", "icon": "start", "label": "Start" + (": " + p["from"] if p.get("from") else "")},
                      "geometry": {"type": "Point", "coordinates": a}})
        if dist(a, b) > 300:
            feats.append({"type": "Feature", "properties": {"id": p["id"], "kind": "point", "icon": "end", "label": "Ziel" + (": " + p["to"] if p.get("to") else "")},
                          "geometry": {"type": "Point", "coordinates": b}})
    json.dump({"v": 1, "type": "FeatureCollection", "features": feats}, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"{sum(1 for f in feats if f['properties']['kind'] == 'tour')} Touren im Paket", flush=True)


Rels().apply_file(src)
print(f"{len(routes)} Wanderrouten", flush=True)
# Fernwege aus Etappen als eine Tour; die einzelnen Etappen nicht extra
stages = set()
for rid, sp in supers.items():
    ways = [w for sub in sp["subs"] for w in rel_ways.get(sub, [])]
    if ways:
        cands[rid] = {"t": sp["t"], "name": sp["name"], "ways": ways, "score": tour_score(sp["t"]) + 1}
        stages.update(sp["subs"])
for rid in stages:
    if rid in cands and rid not in supers:
        cands[rid]["score"] -= 3
# Kandidaten fürs Touren-Paket: die bekanntesten zuerst, Geometrie nur für diese merken
top = sorted(cands.items(), key=lambda x: (-x[1]["score"], -len(x[1]["ways"])))[:250]
cands = dict(top) if dst_tours else {}
need_geom = {w for c in cands.values() for w in c["ways"]}
with open(dst, "w", encoding="utf-8") as out:
    h = Ways(out)
    h.apply_file(src, locations=True, idx="flex_mem")
print(f"{h.n} Wege", flush=True)
if dst_pts:
    with open(dst_pts, "w", encoding="utf-8") as out:
        ph = Points(out)
        ph.apply_file(src, locations=True, idx="flex_mem")
    print(f"{ph.n} Punkte (Biwaks, Hütten, Unterstände, Wasser)", flush=True)
if dst_tours:
    write_tours(dst_tours)


# ---------- Bus und Bahn in großen Städten ----------
OEV_MODES = {"train": "bahn", "subway": "ubahn", "light_rail": "sbahn", "monorail": "ubahn", "tram": "tram", "bus": "bus", "trolleybus": "bus", "share_taxi": "bus", "minibus": "bus"}
OEV_RANK = {"bahn": 5, "ubahn": 4, "sbahn": 3, "tram": 2, "bus": 1}
OEV_MINZOOM = {"bahn": 9, "ubahn": 10, "sbahn": 10, "tram": 11, "bus": 12}


def population(t):
    m = re.match(r"^\s*([\d.,' ]+)", t.get("population", ""))
    if not m:
        return 0
    try:
        return int(re.sub(r"[.,' ]", "", m.group(1)))
    except ValueError:
        return 0


class OevNodes(osmium.SimpleHandler):
    """Städte ab 50.000 Einwohnern und alle Haltestellen."""

    def __init__(self):
        super().__init__()
        self.cities = []
        self.stops = []

    def node(self, n):
        if not n.tags:
            return
        t = n.tags
        if t.get("place") in ("city", "town"):
            pop = population({"population": t.get("population", "")})
            if pop >= 50000:
                # Umkreis wächst mit der Größe: 50.000 → 5 km, 500.000 → 12 km, 3,5 Mio. → 25 km
                r = 2500 * (pop / 10000) ** 0.4
                self.cities.append((n.location.lon, n.location.lat, min(r, 30000)))
            return
        kind = None
        if t.get("railway") in ("station", "halt"):
            st = t.get("station", "")
            kind = "ubahn" if st == "subway" else "sbahn" if st == "light_rail" else "tram" if st == "tram" else "bahn"
        elif t.get("railway") == "tram_stop":
            kind = "tram"
        elif t.get("highway") == "bus_stop":
            kind = "bus"
        if kind:
            name = t.get("name:de") or t.get("name") or ""
            self.stops.append((n.location.lon, n.location.lat, kind, name[:50]))


def in_city(cities, lon, lat):
    for cx, cy, r in cities:
        if abs(cy - lat) * 111195 < r and dist((cx, cy), (lon, lat)) < r:
            return True
    return False


class OevRels(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = defaultdict(list)   # Weg → [(Art, Linie, Farbe)]

    def relation(self, r):
        t = r.tags
        mode = OEV_MODES.get(t.get("route", ""))
        if not mode or t.get("type") != "route":
            return
        ref = (t.get("ref") or t.get("name") or "")[:14]
        col = t.get("colour", "")[:9]
        for m in r.members:
            if m.type == "w" and m.role in ("", "forward", "backward", "main"):
                self.ways[m.ref].append((mode, ref, col))


class OevWays(osmium.SimpleHandler):
    def __init__(self, out, ways, cities):
        super().__init__()
        self.out, self.ways, self.cities = out, ways, cities
        self.n = 0

    def way(self, w):
        lines = self.ways.get(w.id)
        if not lines:
            return
        try:
            coords = [(round(n.lon, 6), round(n.lat, 6)) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2 or not any(in_city(self.cities, *coords[k]) for k in (0, len(coords) // 2, -1)):
            return
        mode = max((x[0] for x in lines), key=lambda m: OEV_RANK[m])
        refs = sorted({x[1] for x in lines if x[1]}, key=lambda r: (len(r), r))
        p = {"m": mode, "n": len(refs)}
        if refs:
            p["r"] = " · ".join(refs)[:70]
        col = next((x[2] for x in lines if x[0] == mode and x[2]), "")
        if col:
            p["c"] = col
        f = {"type": "Feature", "properties": p, "tippecanoe": {"layer": "oev", "minzoom": OEV_MINZOOM[mode]},
             "geometry": {"type": "LineString", "coordinates": coords}}
        self.out.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.n += 1


if dst_oev:
    nodes = OevNodes()
    nodes.apply_file(src)
    rels = OevRels()
    rels.apply_file(src)
    print(f"{len(nodes.cities)} Städte ab 50.000 Einwohnern, {len(rels.ways)} Linienwege", flush=True)
    with open(dst_oev, "w", encoding="utf-8") as out:
        n_stops, seen = 0, set()
        for lon, lat, kind, name in nodes.stops:
            if not in_city(nodes.cities, lon, lat):
                continue
            key = (kind, name, round(lat * 400), round(lon * 400))   # gleiche Haltestelle auf beiden Straßenseiten nur einmal
            if name and key in seen:
                continue
            seen.add(key)
            p = {"k": kind}
            if name:
                p["n"] = name
            f = {"type": "Feature", "properties": p, "tippecanoe": {"layer": "halt", "minzoom": 12 if kind != "bus" else 14},
                 "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]}}
            out.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")
            n_stops += 1
        ow = OevWays(out, rels.ways, nodes.cities)
        ow.apply_file(src, locations=True, idx="flex_mem")
    print(f"Bus und Bahn: {n_stops} Haltestellen, {ow.n} Linienstücke", flush=True)

