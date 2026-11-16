#!/usr/bin/env python3
"""Straßen- und Wegenetz für das Offline-Routing in der App.

Aufruf: build_routing.py <land.osm.pbf> <ausgabe.pmtiles> [Name]

Aus OpenStreetMap wird ein Graph gebaut: Knoten sind Kreuzungen und Wegenden, Kanten die Stücke
dazwischen (mit vereinfachter Linie, Länge, Straßenklasse, Einbahn, Fuß/Auto erlaubt, Belag, Name).
Die Kanten liegen in Kacheln (PMTiles, eigenes Binärformat, gzip):
  z10  alle Kanten (für die Umgebung von Start und Ziel und zu Fuß)
  z7   nur große Straßen (Autobahn bis Landstraße und Fähren) für den weiten Weg dazwischen
Knoten werden über ihre OpenStreetMap-Kennung verbunden; dadurch passen Kacheln aus
Nachbarländern an der Grenze von selbst zusammen.

Kachelformat 2 (alles varint, zz = zigzag), Kanten nach Knoten A sortiert und spaltenweise abgelegt:
  version(2), zz(origin_x), zz(origin_y)                 Ursprung der Kachel in 1e-5 Grad
  n_strings, je (len, utf8)                               Namen (Index 1-basiert, 0 = ohne)
  n_edges, dann die Spalten, jede für alle Kanten hintereinander:
    1 zz(idA - vorige idA)                                OpenStreetMap-Kennung von Knoten A
    2 zz(idB - idA)
    3 zz(dxA), zz(dyA), zz(dxB), zz(dyB)                  Heimatkachel der Endpunkte relativ zu dieser (0,0 = hier)
    4 cls + 16 * flags                                    flags: 1 Auto vor, 2 Auto zurück, 4 zu Fuß, 8 Zubringer,
                                                          16 Kreisverkehr, 32 unbefestigt, 64 Maut, 128 nur Anlieger,
                                                          256 Tunnel, 512 Brücke
    5 grade + 8 * sac + 64 * maxspeed                     Track-Güte 0-5, SAC 0-6, Tempo km/h (Fähre: Reisetempo)
    6 Länge in Metern
    7 name, ref, dest                                     Index in die Namen (dest: Ziel-Beschilderung an Zubringern)
    8 zz(xA - voriges xA), zz(yA - voriges yA)            (das erste ab dem Ursprung)
    9 zz(xB - xA), zz(yB - yA)
   10 Zahl der Zwischenpunkte
   11 Zwischenpunkte aller Kanten: je zz(dx), zz(dy) ab A
   12 je Kante 2 Bytes: Richtung beim Losfahren an A und beim Ankommen an B (0-255 = 0-360°)
  n_restr, je Abbiegeverbot (sortiert nach Knoten): zz(via - voriger via), zz(von - via), zz(nach - via), Art (0 verboten, 1 nur)
     von/nach sind die Nachbarknoten auf dem Weg, von dem man kommt / in den man abbiegt (nur fürs Auto)
"""
import array
import gzip
import json
import math
import struct
import sys

Z_FULL, Z_MAJOR = 10, 7
SCALE = 100000          # 1e-5 Grad

CLS = {
    'motorway': 0, 'motorway_link': 0, 'trunk': 1, 'trunk_link': 1, 'primary': 2, 'primary_link': 2,
    'secondary': 3, 'secondary_link': 3, 'tertiary': 4, 'tertiary_link': 4, 'unclassified': 5, 'road': 5,
    'residential': 6, 'living_street': 7, 'service': 8, 'track': 9,
    'path': 10, 'footway': 10, 'bridleway': 10, 'cycleway': 10, 'pedestrian': 12, 'steps': 13,
}
FERRY = 11
CAR_CLS = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9}
MAJOR_CLS = {0, 1, 2, 3}
SAC = {'hiking': 1, 'mountain_hiking': 2, 'demanding_mountain_hiking': 3, 'alpine_hiking': 4,
       'demanding_alpine_hiking': 5, 'difficult_alpine_hiking': 6}
GRADE = {'grade1': 1, 'grade2': 2, 'grade3': 3, 'grade4': 4, 'grade5': 5}
UNPAVED = {'unpaved', 'gravel', 'fine_gravel', 'dirt', 'earth', 'ground', 'grass', 'mud', 'sand', 'compacted',
           'pebblestone', 'rock', 'woodchips', 'grass_paver', 'clay', 'shells', 'salt', 'snow', 'ice'}
NO = {'no', 'private', 'agricultural', 'forestry', 'delivery;agricultural', 'agricultural;forestry', 'forestry;agricultural',
      'discouraged', 'military', 'restricted', 'emergency'}
YES = {'yes', 'permissive', 'designated', 'destination', 'customers', 'official'}
DEST = {'destination', 'customers', 'delivery'}
SKIP_SERVICE = {'parking_aisle', 'driveway', 'drive-through', 'emergency_access'}
SKIP_FOOTWAY = {'sidewalk', 'crossing', 'traffic_island'}


def classify(t):
    """Merkmale einer Kante aus den Tags eines Wegs, None = nicht routbar."""
    get = t.get
    hw = get('highway')
    ferry = get('route') == 'ferry'
    if not hw and not ferry:
        return None
    if get('area') == 'yes' or get('indoor') == 'yes':
        return None
    if ferry:
        cls = FERRY
    else:
        cls = CLS.get(hw)
        if cls is None:
            return None
    if hw == 'service' and get('service') in SKIP_SERVICE:
        return None
    if hw == 'footway' and get('footway') in SKIP_FOOTWAY:
        return None
    access = get('access')
    # Auto
    car = cls in CAR_CLS or cls == FERRY
    mv = get('motorcar') or get('motor_vehicle') or get('vehicle')
    dest = False
    if cls == FERRY:
        # Fähren nur mit ausdrücklicher Freigabe für Autos, sonst Personenfähre
        car = mv in YES
    elif car:
        if mv:
            if mv in NO:
                car = False
            elif mv in DEST:
                dest = True
        elif access in NO:
            car = False
        elif access in DEST:
            dest = True
    # zu Fuß
    ft = get('foot')
    if ft:
        foot = ft not in NO
    elif cls == 0 or get('motorroad') == 'yes':
        foot = False
    elif access in NO:
        foot = False
    else:
        foot = True
    if cls == 1 and ft is None and get('sidewalk') in (None, 'no', 'none') and get('motorroad') == 'yes':
        foot = False
    if not car and not foot:
        return None
    # Richtung (nur Auto)
    fwd = bwd = car
    ow = get('oneway')
    jn = get('junction')
    rb = jn in ('roundabout', 'circular')
    if car:
        if ow in ('yes', '1', 'true'):
            bwd = False
        elif ow == '-1' or ow == 'reverse':
            fwd = False
        elif ow == 'reversible' or ow == 'alternating':
            fwd = bwd = False
        elif ow != 'no' and (rb or hw in ('motorway', 'motorway_link')):
            bwd = False
        if not fwd and not bwd and not foot:
            return None
    flags = (1 if fwd else 0) | (2 if bwd else 0) | (4 if foot else 0)
    if hw and hw.endswith('_link'):
        flags |= 8
    if rb:
        flags |= 16
    surf = get('surface')
    grade = GRADE.get(get('tracktype'), 0)
    if (surf in UNPAVED) or (surf is None and (cls == 9 or grade >= 2)):
        if cls != FERRY:
            flags |= 32
    if get('toll') == 'yes' or get('toll:motorcar') == 'yes':
        flags |= 64
    if dest:
        flags |= 128
    if get('tunnel') in ('yes', 'building_passage', 'culvert'):
        flags |= 256
    if get('bridge') and get('bridge') != 'no':
        flags |= 512
    sac = SAC.get(get('sac_scale'), 0)
    ms = 0
    m = get('maxspeed')
    if m:
        if m == 'none':
            ms = 140
        elif m.isdigit():
            ms = min(int(m), 250)
        elif m.endswith(' mph') and m[:-4].isdigit():
            ms = min(round(int(m[:-4]) * 1.609), 250)
        elif m in ('DE:urban', 'AT:urban', 'CH:urban', 'urban'):
            ms = 50
        elif m in ('DE:rural', 'AT:rural', 'rural'):
            ms = 100
        elif m in ('DE:living_street', 'walk'):
            ms = 7
    return {'cls': cls, 'flags': flags, 'grade': grade, 'sac': sac, 'ms': ms,
            'name': (get('name') or '')[:80], 'ref': (get('ref') or '')[:40],
            'dest': ((get('destination') or get('destination:ref') or '').replace(';', ', ')[:60]) if flags & 8 else '',
            'duration': get('duration') if cls == FERRY else None}


def duration_s(v):
    """OpenStreetMap-Dauer (Fähre) in Sekunden: „1:30“, „01:30:00“, „90“ (Minuten)."""
    try:
        p = [float(x) for x in v.split(':')]
    except (ValueError, AttributeError):
        return None
    if len(p) == 1:
        return p[0] * 60
    if len(p) == 2:
        return p[0] * 3600 + p[1] * 60
    return p[0] * 3600 + p[1] * 60 + p[2]


def zz(v):
    return (v << 1) if v >= 0 else ((-v << 1) - 1)


def put(buf, v):
    while v >= 0x80:
        buf.append((v & 0x7F) | 0x80)
        v >>= 7
    buf.append(v)


def tile_of(x, y, z):
    n = 1 << z
    lon = x / SCALE
    lat = max(-85.0511, min(85.0511, y / SCALE))
    tx = int((lon + 180.0) / 360.0 * n)
    r = math.radians(lat)
    ty = int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n)
    return min(n - 1, max(0, tx)), min(n - 1, max(0, ty))


def tile_origin(z, tx, ty):
    n = 1 << z
    lon = tx / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + 1) / n))))
    return round(lon * SCALE), round(lat * SCALE)


def hav(x1, y1, x2, y2):
    la1, la2 = math.radians(y1 / SCALE), math.radians(y2 / SCALE)
    dla, dlo = la2 - la1, math.radians((x2 - x1) / SCALE)
    a = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(a)))


def bearing_q(pts, rev=False):
    """Richtung am Anfang einer Linie (etwa 15 m weit geschaut), auf 256 Stufen."""
    if rev:
        pts = pts[::-1]
    x0, y0 = pts[0]
    k = 1
    d = 0.0
    while k < len(pts) - 1:
        d += hav(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1])
        if d > 15:
            break
        k += 1
    x1, y1 = pts[min(k, len(pts) - 1)]
    la0, la1 = math.radians(y0 / SCALE), math.radians(y1 / SCALE)
    dl = math.radians((x1 - x0) / SCALE)
    b = math.degrees(math.atan2(math.sin(dl) * math.cos(la1), math.cos(la0) * math.sin(la1) - math.sin(la0) * math.cos(la1) * math.cos(dl)))
    if rev:
        b += 180
    return int(round((b % 360) / 360 * 256)) % 256


def simplify(pts, tol_m):
    """Douglas-Peucker in einer lokalen Ebene; pts = [(x, y)], Endpunkte bleiben."""
    if len(pts) <= 2:
        return pts
    ky = 1.1132   # Meter je 1e-5 Grad Breite
    kx = ky * math.cos(math.radians(pts[0][1] / SCALE))
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    tol2 = tol_m * tol_m
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = pts[i][0] * kx, pts[i][1] * ky
        bx, by = pts[j][0] * kx, pts[j][1] * ky
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        best, bk = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k][0] * kx - ax, pts[k][1] * ky - ay
            if L > 0:
                t = max(0.0, min(1.0, (px * dx + py * dy) / L))
                ex, ey = px - t * dx, py - t * dy
            else:
                ex, ey = px, py
            d = ex * ex + ey * ey
            if d > best:
                best, bk = d, k
        if best > tol2:
            keep[bk] = True
            stack.append((i, bk))
            stack.append((bk, j))
    return [p for p, k in zip(pts, keep) if k]


REC = struct.Struct('<qqhhhhHHIIIIiiiiBBHI')   # … Richtung an A und B, Zahl der Zwischenpunkte, Bytes der Zwischenpunkte


class Tile:
    """Kanten einer Kachel; erst als feste Datensätze gesammelt, am Ende sortiert und spaltenweise geschrieben."""
    __slots__ = ('z', 'x', 'y', 'ox', 'oy', 'recs', 'names', 'n', 'restr')

    def __init__(self, z, x, y):
        self.z, self.x, self.y = z, x, y
        self.ox, self.oy = tile_origin(z, x, y)
        self.recs = bytearray()
        self.names = {}
        self.n = 0
        self.restr = []

    def name(self, s):
        if not s:
            return 0
        i = self.names.get(s)
        if i is None:
            i = self.names[s] = len(self.names) + 1
        return i

    def add(self, e, ta, tb, geom, mids):
        a = e[2]
        x0, y0 = geom[0]
        x1, y1 = geom[-1]
        self.recs += REC.pack(e[0], e[1], ta[0] - self.x, ta[1] - self.y, tb[0] - self.x, tb[1] - self.y,
                              a['cls'] + 16 * a['flags'], a['grade'] + 8 * a['sac'] + 64 * e[4], e[3],
                              self.name(a['name']), self.name(a['ref']), self.name(a['dest']),
                              x0, y0, x1, y1, e[5], e[6], len(geom) - 2, len(mids))
        self.recs += mids
        self.n += 1

    def bytes(self):
        recs = []
        b = self.recs
        p = 0
        while p < len(b):
            r = REC.unpack_from(b, p)
            p += REC.size
            recs.append((r, p, r[19]))
            p += r[19]
        recs.sort(key=lambda x: (x[0][0], x[0][1]))
        cols = [bytearray() for _ in range(12)]
        last = 0
        px, py = self.ox, self.oy
        for r, mp, ml in recs:
            ida, idb, dxa, dya, dxb, dyb, cf, ex, ln, nm, rf, de, xa, ya, xb, yb, sb, eb, nmid, _ = r
            put(cols[0], zz(ida - last)); last = ida
            put(cols[1], zz(idb - ida))
            c = cols[2]; put(c, zz(dxa)); put(c, zz(dya)); put(c, zz(dxb)); put(c, zz(dyb))
            put(cols[3], cf)
            put(cols[4], ex)
            put(cols[5], ln)
            c = cols[6]; put(c, nm); put(c, rf); put(c, de)
            c = cols[7]; put(c, zz(xa - px)); put(c, zz(ya - py)); px, py = xa, ya
            c = cols[8]; put(c, zz(xb - xa)); put(c, zz(yb - ya))
            put(cols[9], nmid)
            cols[10] += b[mp:mp + ml]
            cols[11].append(sb)
            cols[11].append(eb)
        out = bytearray()
        put(out, 2)
        put(out, zz(self.ox)); put(out, zz(self.oy))
        names = sorted(self.names.items(), key=lambda kv: kv[1])
        put(out, len(names))
        for s, _ in names:
            u = s.encode('utf-8')
            put(out, len(u))
            out += u
        put(out, len(recs))
        for c in cols:
            out += c
        rs = sorted(set(self.restr))
        put(out, len(rs))
        last = 0
        for via, frm, to, kind in rs:
            put(out, zz(via - last)); last = via
            put(out, zz(frm - via)); put(out, zz(to - via)); put(out, kind)
        return bytes(out)


class Graph:
    def __init__(self):
        self.tiles = {}
        self.bbox = [1e9, 1e9, -1e9, -1e9]
        self.stats = {'edges': 0, 'major': 0, 'points': 0, 'points_raw': 0, 'restr': 0}

    def restriction(self, via, x, y, frm, to, kind):
        self.stats['restr'] += 1
        for z in (Z_FULL, Z_MAJOR):
            t = self.tiles.get((z,) + tile_of(x, y, z))
            if t is not None or z == Z_FULL:
                self.tile(z, *tile_of(x, y, z)).restr.append((via, frm, to, kind))

    def tile(self, z, x, y):
        k = (z, x, y)
        t = self.tiles.get(k)
        if t is None:
            t = self.tiles[k] = Tile(z, x, y)
        return t

    def edge(self, a, seg):
        """seg = [(osm_id, x, y), …] von Kreuzung zu Kreuzung"""
        ida, idb = seg[0][0], seg[-1][0]
        raw = [(p[1], p[2]) for p in seg]
        length = 0.0
        for i in range(1, len(raw)):
            length += hav(raw[i - 1][0], raw[i - 1][1], raw[i][0], raw[i][1])
        if ida == idb and length < 1:
            return
        geom = simplify(raw, 5.0 if a['cls'] <= 8 else 3.5)
        ms = a['ms']
        if a['cls'] == FERRY:
            d = duration_s(a['duration']) if a['duration'] else None
            ms = max(5, min(60, round(length / d * 3.6))) if d else 0
        e = (ida, idb, a, max(1, round(length)), ms, bearing_q(raw), bearing_q(raw, True))
        s = self.stats
        s['edges'] += 1
        s['points'] += len(geom)
        s['points_raw'] += len(raw)
        bb = self.bbox
        for x, y in (geom[0], geom[-1]):
            if x < bb[0]: bb[0] = x
            if y < bb[1]: bb[1] = y
            if x > bb[2]: bb[2] = x
            if y > bb[3]: bb[3] = y
        levels = [Z_FULL]
        if (a['flags'] & 3) and (a['cls'] in MAJOR_CLS or a['cls'] == FERRY):
            levels.append(Z_MAJOR)
            s['major'] += 1
        mids = bytearray()
        px, py = geom[0]
        for x, y in geom[1:-1]:
            put(mids, zz(x - px)); put(mids, zz(y - py))
            px, py = x, y
        for z in levels:
            ta = tile_of(geom[0][0], geom[0][1], z)
            tb = tile_of(geom[-1][0], geom[-1][1], z)
            self.tile(z, *ta).add(e, ta, tb, geom, mids)
            if tb != ta:
                self.tile(z, *tb).add(e, ta, tb, geom, mids)


# ---------------- Einlesen ----------------

def parse_restriction(tags, members):
    """Abbiegeverbot fürs Auto: (von-Weg, über-Knoten, nach-Weg, 0 verboten / 1 nur) oder None."""
    if tags.get('type') != 'restriction':
        return None
    r = tags.get('restriction:motorcar') or tags.get('restriction')
    if not r or 'motorcar' in (tags.get('except') or '').replace(' ', '').split(';'):
        return None
    kind = 0 if r.startswith('no_') else 1 if r.startswith('only_') else None
    if kind is None:
        return None
    fr = [m[1] for m in members if m[0] == 'w' and m[2] == 'from']
    via = [m[1] for m in members if m[0] == 'n' and m[2] == 'via']
    to = [m[1] for m in members if m[0] == 'w' and m[2] == 'to']
    if len(fr) != 1 or len(via) != 1 or len(to) != 1:
        return None
    return fr[0], via[0], to[0], kind


class Restrictions:
    def __init__(self):
        self.list = []          # [von-Weg, Knoten, nach-Weg, Art, von-Nachbar, nach-Nachbar, x, y]
        self.ways = {}          # Weg → [(Index, 'f'|'t')]

    def add(self, r):
        i = len(self.list)
        self.list.append([r[0], r[1], r[2], r[3], None, None, None, None])
        self.ways.setdefault(r[0], []).append((i, 4))
        self.ways.setdefault(r[2], []).append((i, 5))

    def way(self, wid, pts, nodes):
        for i, slot in self.ways.get(wid, ()):
            e = self.list[i]
            via = e[1]
            ids = [p[0] for p in pts]
            if ids[0] == via:
                seq = ids[1:]
                xy = pts[0]
            elif ids[-1] == via:
                seq = ids[-2::-1]
                xy = pts[-1]
            else:
                continue                      # Weg läuft durch den Knoten: unklar, weglassen
            nb = next((n for n in seq if n in nodes), seq[-1] if seq else None)
            e[slot] = nb
            e[6], e[7] = xy[1], xy[2]

    def apply(self, g):
        for f, via, t, kind, nf, nt, x, y in self.list:
            if nf is not None and nt is not None and x is not None:
                g.restriction(via, x, y, nf, nt, kind)


def split_way(g, a, pts, nodes):
    start = 0
    last = len(pts) - 1
    for i in range(1, len(pts)):
        if i == last or pts[i][0] in nodes:
            g.edge(a, pts[start:i + 1])
            start = i


def read_pbf(path, g):
    import numpy as np
    import osmium

    rs = Restrictions()

    class Rels(osmium.SimpleHandler):
        def relation(self, r):
            if r.tags.get('type') != 'restriction':
                return
            x = parse_restriction(r.tags, [(m.type, m.ref, m.role) for m in r.members])
            if x:
                rs.add(x)

    Rels().apply_file(path)
    print(f'{len(rs.list):,} Abbiegeverbote', file=sys.stderr)

    class Count(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.refs = array.array('q')
            self.ends = array.array('q')

        def way(self, w):
            if len(w.nodes) < 2 or classify(w.tags) is None:
                return
            r = [n.ref for n in w.nodes]
            self.refs.extend(r)
            self.ends.append(r[0])
            self.ends.append(r[-1])

    c = Count()
    c.apply_file(path)
    r = np.frombuffer(c.refs, dtype=np.int64).copy()
    del c.refs
    r.sort()
    dup = np.unique(r[1:][r[1:] == r[:-1]])
    del r
    nodes = set(np.union1d(dup, np.frombuffer(c.ends, dtype=np.int64)).tolist())
    del dup, c
    print(f'{len(nodes):,} Kreuzungen und Wegenden', file=sys.stderr)

    class Build(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.bad = 0

        def way(self, w):
            if len(w.nodes) < 2:
                return
            a = classify(w.tags)
            if a is None:
                return
            try:
                pts = [(n.ref, round(n.lon * SCALE), round(n.lat * SCALE)) for n in w.nodes]
            except Exception:
                self.bad += 1
                return
            split_way(g, a, pts, nodes)
            if w.id in rs.ways:
                rs.way(w.id, pts, nodes)

    b = Build()
    b.apply_file(path, locations=True, idx='flex_mem')
    if b.bad:
        print(f'{b.bad} Wege ohne Koordinaten übersprungen', file=sys.stderr)
    rs.apply(g)


def read_xml(path, g):
    """Kleines .osm-XML (für Tests ohne pyosmium)."""
    import xml.etree.ElementTree as ET
    root = ET.parse(path).getroot()
    loc = {}
    for n in root.iter('node'):
        loc[int(n.get('id'))] = (round(float(n.get('lon')) * SCALE), round(float(n.get('lat')) * SCALE))
    rs = Restrictions()
    for r in root.iter('relation'):
        tags = {t.get('k'): t.get('v') for t in r.iter('tag')}
        mem = [(m.get('type')[0], int(m.get('ref')), m.get('role')) for m in r.iter('member')]
        x = parse_restriction(tags, mem)
        if x:
            rs.add(x)
    ways = []
    for w in root.iter('way'):
        tags = {t.get('k'): t.get('v') for t in w.iter('tag')}
        refs = [int(nd.get('ref')) for nd in w.iter('nd')]
        a = classify(tags)
        if a and len(refs) >= 2:
            ways.append((a, refs, int(w.get('id'))))
    count = {}
    for _, refs, _ in ways:
        for r in refs:
            count[r] = count.get(r, 0) + 1
        count[refs[0]] = count.get(refs[0], 0) + 2
        count[refs[-1]] = count.get(refs[-1], 0) + 2
    nodes = {k for k, v in count.items() if v >= 2}
    for a, refs, wid in ways:
        pts = [(r,) + loc[r] for r in refs]
        split_way(g, a, pts, nodes)
        rs.way(wid, pts, nodes)
    rs.apply(g)


# ---------------- PMTiles schreiben ----------------

def tile_id(z, x, y):
    acc = 0
    for t in range(z):
        acc += (1 << t) * (1 << t)
    n = 1 << z
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x = s - 1 - x
                y = s - 1 - y
            x, y = y, x
        s >>= 1
    return acc + d


def dir_bytes(entries):
    b = bytearray()
    put(b, len(entries))
    last = 0
    for e in entries:
        put(b, e[0] - last)
        last = e[0]
    for e in entries:
        put(b, e[3])
    for e in entries:
        put(b, e[2])
    for i, e in enumerate(entries):
        if i > 0 and e[1] == entries[i - 1][1] + entries[i - 1][2]:
            put(b, 0)
        else:
            put(b, e[1] + 1)
    return gzip.compress(bytes(b), 9, mtime=0)


def write_pmtiles(path, g, name):
    items = sorted((tile_id(*k), t) for k, t in g.tiles.items())
    data = bytearray()
    entries = []
    for tid, t in items:
        blob = gzip.compress(t.bytes(), 9, mtime=0)
        entries.append((tid, len(data), len(blob), 1))
        data += blob
    root = dir_bytes(entries)
    leaves = bytearray()
    if len(root) > 16000:
        # Blätter zu je 4096 Einträgen
        roots = []
        for i in range(0, len(entries), 4096):
            chunk = entries[i:i + 4096]
            lb = dir_bytes(chunk)
            roots.append((chunk[0][0], len(leaves), len(lb), 0))
            leaves += lb
        root = dir_bytes(roots)
    bb = g.bbox
    meta = gzip.compress(json.dumps({'name': name, 'format': 'ovl-route-1', 'attribution': '© OpenStreetMap-Mitwirkende',
                                     'zooms': [Z_MAJOR, Z_FULL], 'stats': g.stats}).encode(), 9, mtime=0)
    root_off = 127
    meta_off = root_off + len(root)
    leaf_off = meta_off + len(meta)
    data_off = leaf_off + len(leaves)
    h = bytearray(b'PMTiles') + bytes([3])
    h += struct.pack('<QQQQQQQQ', root_off, len(root), meta_off, len(meta), leaf_off, len(leaves), data_off, len(data))
    h += struct.pack('<QQQ', len(entries), len(entries), len(entries))
    h += bytes([1, 2, 2, 0])            # clustered, interne Kompression gzip, Kacheln gzip, Kacheltyp unbekannt
    h += bytes([Z_MAJOR, Z_FULL])
    e7 = lambda v: int(round(v / SCALE * 1e7))
    h += struct.pack('<iiii', e7(bb[0]), e7(bb[1]), e7(bb[2]), e7(bb[3]))
    h += bytes([Z_FULL])
    h += struct.pack('<ii', e7((bb[0] + bb[2]) / 2), e7((bb[1] + bb[3]) / 2))
    assert len(h) == 127, len(h)
    with open(path, 'wb') as f:
        f.write(h)
        f.write(root)
        f.write(meta)
        f.write(leaves)
        f.write(data)
    return len(h) + len(root) + len(meta) + len(leaves) + len(data)


def main():
    src, out = sys.argv[1], sys.argv[2]
    name = sys.argv[3] if len(sys.argv) > 3 else src
    g = Graph()
    if src.endswith('.osm') or src.endswith('.xml'):
        read_xml(src, g)
    else:
        read_pbf(src, g)
    if not g.tiles:
        print('keine Straßen gefunden', file=sys.stderr)
        sys.exit(1)
    size = write_pmtiles(out, g, name)
    s = g.stats
    print(f"{s['edges']:,} Kanten ({s['major']:,} große Straßen), {s['restr']:,} Abbiegeverbote, Punkte {s['points_raw']:,} → {s['points']:,}, "
          f"{len(g.tiles):,} Kacheln, {size / 1e6:.1f} MB", file=sys.stderr)


if __name__ == '__main__':
    main()
