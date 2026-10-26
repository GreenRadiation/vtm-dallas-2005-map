"""Собирает геометрию карты из сырых данных data/raw/ в data/geo/*.geojson.

Запуск из корня репозитория: python tools/build.py   (сначала python tools/fetch.py)

Что делает:
1. Подложка: дороги, вода, железные дороги, парки. Всё, что появилось после 2005 года и известно нам,
   вырезается (списки ANACHRONISM_*).
2. Средний масштаб (районы, l2): территория режется крупными дорогами, рекой и железной дорогой на куски.
   Кусок достаётся опорной точке района из data/seeds.tsv в том же городе (город — по большинству площади).
   Город без своих районов становится одним районом, озёра и парки из data/natural.tsv и аэропорты —
   отдельными районами. Слишком большие районы делятся на части примерно равной площади.
   Границы сглаживаются согласованно (shapely.coverage_simplify).
3. Мелкий масштаб (секторы, l3): каждый район делится на куски примерно равной площади по улицам
   (или по точкам из data/seeds3.tsv).
4. Крупный масштаб (области, l1) = объединение районов.

Геометрия считается в плоских километрах вокруг центра карты, на выходе снова широта и долгота.
"""
import warnings; warnings.filterwarnings("ignore", category=DeprecationWarning)
import json, math, pathlib, re, sys, collections, time
import numpy as np
import shapely
import shapefile
from shapely.geometry import (LineString, MultiLineString, Polygon, MultiPolygon, Point, box, shape, mapping)
from shapely.ops import unary_union, polygonize, linemerge, transform, polylabel
from shapely import STRtree, voronoi_polygons
from shapely.geometry import MultiPoint
from seeds import read_areas, read_cities, read_seeds, read_natural, read_seeds3
from build_common import fwd, inv, proj, unproj

T0 = time.time()
RAW = pathlib.Path("data/raw")
OUT = pathlib.Path("data/geo")
S, W, N, E = 32.58, -97.55, 33.08, -96.50

FRAME = box(*fwd(W, S), *fwd(E, N))

# Что появилось после марта 2005 года. Сверяется по name/ref дорог и названиям парков.
# Экспресс-полосы TEXpress и «Express» на I-35E, I-635, Loop 12, SH 183, US 67 построены в 2010-х.
ANACHRONISM_ROADS = re.compile(r"Margaret Hunt Hill|Chisholm Trail Parkway|Klyde Warren|Panther Island|TEXp|\bExpress\b|35Express|^CTP$|360 Toll|Chris Harris|Rosa Parks Memorial", re.I)
ANACHRONISM_PARKS = re.compile(r"Klyde Warren|Main Street Garden|Belo Garden|Pacific Plaza|Panther Island|Trinity Groves|Harwood Park", re.I)
# Участки, которых не было: (описание, условие на средние координаты пути, условие на теги)
#   SH 161 (западное продолжение платной дороги Буша, PGBT) южнее SH 183 открыт в 2009–2012 годах.
#   Восточное продолжение PGBT от SH 78 в Гарленде до I-30 в Роулетте открыто в 2011 году.
def anachronism_way(tags, lat, lon):
    ref = tags.get("ref", "")
    if tags.get("highway") != "motorway":
        return False
    if ("161" in ref or "PGBT" in ref) and lat < 32.835 and lon < -96.9:
        return True
    if "PGBT" in ref and lon > -96.615 and lat < 32.955:
        return True
    return False


def log(*a):
    print("[%5.1fs]" % (time.time() - T0), *a, flush=True)


def osm(name):
    return json.loads((RAW / ("osm_" + name + ".json")).read_text(encoding="utf-8"))["elements"]


def way_line(e):
    pts = [fwd(p["lon"], p["lat"]) for p in e["geometry"] if p]
    return LineString(pts) if len(pts) > 1 else None


def rel_polygon(e):
    """Мультиполигон из отношения OSM (out geom)."""
    outer, inner = [], []
    for m in e.get("members", []):
        if m.get("type") != "way" or not m.get("geometry"):
            continue
        pts = [fwd(p["lon"], p["lat"]) for p in m["geometry"] if p]
        if len(pts) < 2:
            continue
        (inner if m.get("role") == "inner" else outer).append(LineString(pts))
    if not outer:
        return None
    o = unary_union(list(polygonize(unary_union(outer))))
    if inner:
        o = o.difference(unary_union(list(polygonize(unary_union(inner)))))
    return o if not o.is_empty else None


def way_polygon(e):
    pts = [fwd(p["lon"], p["lat"]) for p in e["geometry"] if p]
    if len(pts) < 4 or pts[0] != pts[-1]:
        return None
    p = Polygon(pts)
    return p.buffer(0) if not p.is_valid else p


def area_polys(elements, keep=lambda t: True):
    out = []
    for e in elements:
        t = e.get("tags", {})
        if not keep(t):
            continue
        g = way_polygon(e) if e["type"] == "way" else rel_polygon(e) if e["type"] == "relation" else None
        if g is not None and not g.is_empty:
            out.append((g, t))
    return out


def lonlat_round(g, nd=5):
    return transform(lambda x, y, z=None: (round(x, nd), round(y, nd)), g)


def feature(g, props, tol):
    g = g.simplify(tol, preserve_topology=True) if tol else g
    return {"type": "Feature", "properties": props, "geometry": mapping(lonlat_round(unproj(g)))}


def write(name, feats):
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / (name + ".geojson")
    p.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log("записан", p, p.stat().st_size // 1024, "КБ,", len(feats), "объектов")


# ---------------------------------------------------------------- города 2000 года
log("города")
cities_tsv = read_cities()
cities = {}  # имя переписи → полигон (км)
for sr in shapefile.Reader(str(RAW / "places2000" / "tl_2010_48_place00.shp")).iterShapeRecords():
    rec = sr.record.as_dict()
    if rec["CLASSFP00"] != "C1":  # только настоящие города, без статистических поселений
        continue
    g = proj(shape(sr.shape.__geo_interface__))
    if not g.is_valid:
        g = g.buffer(0)
    if g.intersects(FRAME):
        cities[rec["NAME00"]] = g.intersection(FRAME)
# Сглаживаем городскую черту как единое покрытие (города + земля вне городов): общие границы упрощаются
# согласованно, без щелей. Мелкие зубцы и выступы пропадают — для игры точная черта не нужна.
_rest = FRAME.difference(unary_union(list(cities.values())))
_names = list(cities) + [None] * len(getattr(_rest, "geoms", [_rest]))
_smooth = shapely.coverage_simplify(list(cities.values()) + list(getattr(_rest, "geoms", [_rest])), 0.4, simplify_boundary=False)
city_lines = [g.boundary for g in _smooth]
cities = {n: (g if g.is_valid else g.buffer(0)) for n, g in zip(_names, _smooth) if n}
missing = [c for c in cities if c not in cities_tsv]
if missing:
    log("ВНИМАНИЕ: нет в cities.tsv:", missing)

# ---------------------------------------------------------------- дороги
log("дороги")
roads = {"motorway": [], "trunk": [], "primary": [], "secondary": []}
road_ways = []  # (класс, линия, теги) — для выгрузки дорог с названиями
dropped = collections.Counter()
for e in osm("roads"):
    t = e.get("tags", {})
    if ANACHRONISM_ROADS.search(t.get("name", "") + " " + t.get("ref", "")):
        dropped[t.get("name") or t.get("ref")] += 1; continue
    g = e.get("geometry") or []
    if len(g) < 2:
        continue
    lat = sum(p["lat"] for p in g) / len(g); lon = sum(p["lon"] for p in g) / len(g)
    if anachronism_way(t, lat, lon):
        dropped["PGBT/SH 161 после 2005"] += 1; continue
    ln = way_line(e)
    if ln is None:
        continue
    roads[t["highway"]].append(ln)
    road_ways.append((t["highway"], ln, t))
log("вырезано как анахронизм:", dict(dropped))

# ---------------------------------------------------------------- вода
log("вода")
water_el = osm("water")
lakes = [g for g, t in area_polys(water_el, lambda t: t.get("natural") == "water")]
lakes = [g.intersection(FRAME) for g in lakes if g.area > 0.08]
lakes = unary_union(lakes)
RIVERS_MAIN = re.compile(r"^(Trinity River|West Fork Trinity River|Elm Fork Trinity River|Clear Fork Trinity River|East Fork Trinity River)$")
river_main, creeks = [], []
for e in water_el:
    t = e.get("tags", {})
    if e["type"] != "way":
        continue
    ww = t.get("waterway")
    if ww == "river" and RIVERS_MAIN.match(t.get("name", "")):
        ln = way_line(e)
        if ln is not None: river_main.append(ln)
    elif ww in ("river", "stream") and t.get("name"):
        ln = way_line(e)
        if ln is not None: creeks.append((ln, t["name"]))
# ручьи покажем только длинные (в сумме по названию)
creek_len = collections.Counter()
for ln, nm in creeks:
    creek_len[nm] += ln.length
creeks = [ln for ln, nm in creeks if creek_len[nm] > 4.0]

# ---------------------------------------------------------------- железные дороги
log("железные дороги")
rail = []
for e in osm("rail"):
    t = e.get("tags", {})
    if t.get("railway") == "rail" and t.get("usage") in ("main", "branch", None) and t.get("service") is None:
        ln = way_line(e)
        if ln is not None: rail.append(ln)
# DART в 2005 году: только Красная и Синяя линии. Синяя тогда шла от Ledbetter до Downtown Garland.
dart = []
for e in osm("dart"):
    t = e.get("tags", {})
    nm = (t.get("name", "") + " " + t.get("ref", "") + " " + t.get("colour", "")).lower()
    if "red" not in nm and "blue" not in nm:
        continue
    blue = "blue" in nm
    for m in e.get("members", []):
        if m.get("type") != "way" or not m.get("geometry") or m.get("role") not in ("", None):
            continue
        pts = [(p["lon"], p["lat"]) for p in m["geometry"] if p]
        if blue and any(lon > -96.636 or lat < 32.668 for lon, lat in pts):
            continue
        if len(pts) > 1:
            dart.append(LineString([fwd(*p) for p in pts]))

# ---------------------------------------------------------------- зелень и аэропорты
log("парки и аэропорты")
green = [(g, t) for g, t in area_polys(osm("green")) if not ANACHRONISM_PARKS.search(t.get("name", ""))]
green = [(g.intersection(FRAME), t) for g, t in green if g.area > 0.15]
aero = [(g, t) for g, t in area_polys(osm("aero")) if g.area > 0.3]

# ---------------------------------------------------------------- природные регионы
log("природные регионы")
seeds = read_seeds()
areas = read_areas()
natural = read_natural()
water_polys = area_polys(water_el, lambda t: t.get("natural") == "water")
green_polys = area_polys(osm("green"))


def fill_holes(g, min_hole):
    """Убирает дырки (острова и т. п.) меньше min_hole км²."""
    out = []
    for p in getattr(g, "geoms", [g]):
        if p.geom_type != "Polygon":
            continue
        out.append(Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area >= min_hole]))
    return unary_union(out)


def drop_small(g, min_part):
    parts = [p for p in getattr(g, "geoms", [g]) if p.geom_type == "Polygon" and p.area >= min_part]
    return unary_union(parts) if parts else Polygon()


nat_geom, nat_info, taken = {}, {}, Polygon()
for n in natural:
    parts = [g for g, t in water_polys + green_polys if t.get("name") in n["names"]]
    if not parts:
        log("ВНИМАНИЕ: не найден природный регион", n["id"], n["names"]); continue
    g = unary_union(parts).intersection(FRAME)
    g = g.buffer(0.12, 4).buffer(-0.12, 4)  # сглаживаем рваные берега и сливаем соседние куски
    g = drop_small(fill_holes(g, 1.0), 0.15).difference(taken).simplify(0.03)
    g = drop_small(g.buffer(0), 0.15)
    if g.is_empty:
        continue
    nat_geom[n["id"]] = g; nat_info[n["id"]] = n
    taken = taken.union(g)

# ---------------------------------------------------------------- нарезка на куски
aero_seed = {}  # id района → полигон аэродрома
for s in seeds:
    if s["city"].startswith("@aero:"):
        key = s["city"][6:].lower()
        cand = [g for g, t in aero if key in t.get("name", "").lower()]
        if not cand:
            sys.exit("не найден аэродром для " + s["id"] + ": " + key)
        aero_seed[s["id"]] = max(cand, key=lambda g: g.area).intersection(FRAME).difference(taken).buffer(0.05).buffer(-0.05)
FIXED = dict(aero_seed, **nat_geom)  # районы, заданные готовым полигоном

log("куски")
# Режут: фривеи и главные улицы, магистральные железные дороги, русло Тринити, аэродромы, природные регионы
# и сглаженная городская черта.
cut = roads["motorway"] + roads["trunk"] + roads["primary"] + rail + river_main + [FRAME.exterior] + city_lines
cut += [r for g in FIXED.values() for p in getattr(g, "geoms", [g]) for r in [p.exterior] + list(p.interiors)]


def polygonize_all(lines, frame):
    """polygonize + то, что он потерял (вырожденные кольца), отдельными кусками."""
    fs = [f for f in polygonize(unary_union(lines)) if f.area > 1e-6 and frame.contains(f.representative_point())]
    rest = frame.difference(unary_union(fs)) if fs else frame
    fs += [g for g in getattr(rest, "geoms", [rest]) if g.geom_type == "Polygon" and g.area > 1e-4]
    return fs


def chunk_thin(fs, step=0.6):
    """Длинные узкие полоски (между параллельными дорогами) режем на короткие куски,
    чтобы каждый кусок прилип к своему соседу, а не тянулся хвостом за одним регионом."""
    out = []
    for f in fs:
        if not (f.area / max(f.length, 1e-9) < 0.12 and f.length > 2 * step):
            out.append(f); continue
        x0, y0, x1, y1 = f.bounds
        for gx in np.arange(x0, x1, step):
            for gy in np.arange(y0, y1, step):
                piece = f.intersection(box(gx, gy, gx + step, gy + step))
                out += [p for p in getattr(piece, "geoms", [piece]) if p.geom_type == "Polygon" and p.area > 1e-6]
    return out


faces = chunk_thin(polygonize_all(cut, FRAME))
log("кусков:", len(faces))

seed_pts = [(Point(fwd(s["lon"], s["lat"])), s) for s in seeds]
sec_tree = STRtree(roads["secondary"])


def split_by_seeds(g):
    """Если в куске всё ещё точки нескольких районов, режем его посередине между ними."""
    pts = {}
    for p, sd in seed_pts:
        if not sd["city"].startswith("@") and g.contains(p):
            pts.setdefault(sd["id"], p)
    if len(pts) < 2:
        return [g]
    cells = voronoi_polygons(MultiPoint(list(pts.values())), extend_to=g)
    return [c.intersection(g) for c in cells.geoms if not c.intersection(g).is_empty and c.intersection(g).area > 1e-6]


refined = []
for f in faces:
    ids = {s["id"] for p, s in seed_pts if f.contains(p) and not s["city"].startswith("@")}
    if len(ids) > 1:
        lines = [roads["secondary"][i].intersection(f) for i in sec_tree.query(f)]
        for g in polygonize_all([f.boundary] + lines, f):
            refined += split_by_seeds(g)
    else:
        refined.append(f)
faces = refined
log("после доразрезки:", len(faces))

# Город каждого куска: тот, которому принадлежит больше площади (если земли вне городов не больше).
city_names = list(cities)
city_tree = STRtree([cities[c] for c in city_names])


def city_of(f):
    shares = {}
    for i in city_tree.query(f):
        a = cities[city_names[i]].intersection(f).area
        if a > 0:
            shares[city_names[i]] = a
    if not shares:
        return None
    best = max(shares, key=shares.get)
    return best if shares[best] >= f.area - sum(shares.values()) else None


face_city = [city_of(f) for f in faces]
by_city = collections.defaultdict(list)
for s in seeds:
    by_city[s["city"]].append((fwd(s["lon"], s["lat"]), s["id"]))

label = [None] * len(faces)
seed_face = set()
for i, f in enumerate(faces):
    rp = f.representative_point()
    for did, ag in FIXED.items():
        if ag.contains(rp):
            label[i] = did; break
    if label[i]:
        continue
    c = face_city[i]
    if c is None:
        # земля вне городов: к ближайшему сельскому району (город "-" в seeds.tsv) не дальше 15 км
        cand = [q for q in by_city.get("-", []) if (q[0][0] - rp.x) ** 2 + (q[0][1] - rp.y) ** 2 < 225]
        if cand:
            label[i] = min(cand, key=lambda q: (q[0][0] - rp.x) ** 2 + (q[0][1] - rp.y) ** 2)[1]
        continue
    cand = by_city.get(c)
    inside = [q for q in cand or [] if f.contains(Point(q[0]))]
    if inside:  # опорная точка внутри куска — кусок её, даже если он мелкий
        cand = inside
        seed_face.add(i)
    if cand:
        label[i] = min(cand, key=lambda q: (q[0][0] - rp.x) ** 2 + (q[0][1] - rp.y) ** 2)[1]
    else:
        label[i] = "c-" + re.sub(r"[^a-z]+", "-", c.lower()).strip("-")
log("размечено:", sum(1 for x in label if x), "из", len(faces))


def adjacency(polys, min_len=0.005):
    tree = STRtree(polys)
    nb = [dict() for _ in polys]
    for i, f in enumerate(polys):
        for j in tree.query(f):
            if j <= i:
                continue
            l = f.boundary.intersection(polys[j].boundary).length
            if l > min_len:
                nb[i][j] = l; nb[j][i] = l
    return nb


log("соседство")
ftree = STRtree(faces)
nbr = adjacency(faces)
SLIVER = 0.04  # км², куски на развязках и между проезжими частями


def best_neighbour(lab, nb, i, ok):
    tally = collections.Counter()
    for j, l in nb[i].items():
        if ok(j) and lab[j]:
            tally[lab[j]] += l
    return tally.most_common(1)[0][0] if tally else None


def components(idx, nb):
    s = set(idx); comps = []
    while s:
        st = [s.pop()]; comp = []
        while st:
            k = st.pop(); comp.append(k)
            for j in nb[k]:
                if j in s:
                    s.remove(j); st.append(j)
        comps.append(comp)
    return comps


def fix_detached(lab, nb, area, keep=lambda k: False, frac=1 / 3, rounds=3):
    """Оторванные кусочки района (меньше frac главной части) — к соседям."""
    for _ in range(rounds):
        changed = 0
        groups = collections.defaultdict(list)
        for i, l in enumerate(lab):
            groups[l].append(i)
        for l, idx in groups.items():
            comps = components(idx, nb)
            if len(comps) < 2:
                continue
            comps.sort(key=lambda c: (not any(keep(k) for k in c), -sum(area(k) for k in c)))
            main = sum(area(k) for k in comps[0])
            for c in comps[1:]:
                if sum(area(k) for k in c) < main * frac and not any(keep(k) for k in c):
                    for k in c:
                        b = best_neighbour(lab, nb, k, lambda j: lab[j] != l)
                        if b:
                            lab[k] = b; changed += 1
        if not changed:
            break


# мелочь на развязках — к соседу с самой длинной общей границей
def thin(f):  # узкая полоска: средняя ширина меньше ~250 м
    return f.area / max(f.length, 1e-9) < 0.12 and f.area < 1.5


for i in sorted(range(len(faces)), key=lambda k: faces[k].area):
    if (faces[i].area < SLIVER or thin(faces[i])) and label[i] not in FIXED and i not in seed_face:
        b = best_neighbour(label, nbr, i, lambda j: faces[j].area >= SLIVER)
        if b:
            label[i] = b
# территория вне городов — растёт от соседей слоями
for _ in range(400):
    todo = [i for i in range(len(faces)) if not label[i]]
    if not todo:
        break
    upd = {i: b for i in todo for b in [best_neighbour(label, nbr, i, lambda j: True)] if b}
    if not upd:
        break
    for i, b in upd.items():
        label[i] = b
fix_detached(label, nbr, lambda k: faces[k].area, keep=lambda k: k in seed_face or label[k] in FIXED)

for pt, sd in seed_pts:
    if sd["city"].startswith("@") or sd["city"] == "-":
        continue
    for i in ftree.query(pt):
        if faces[i].contains(pt) and label[i] != sd["id"]:
            log("ВНИМАНИЕ: точка %s (%s) лежит в куске района %s; город куска %s, площадь %.3f" % (sd["id"], sd["city"], label[i], face_city[i], faces[i].area))

# ---------------------------------------------------------------- средний масштаб: районы
log("районы")
seed_info = {}
for s in seeds:
    if s["id"] not in seed_info:
        seed_info[s["id"]] = s
city_by_slug = {"c-" + re.sub(r"[^a-z]+", "-", c.lower()).strip("-"): c for c in cities}
groups = collections.defaultdict(list)
for i, l in enumerate(label):
    if l:
        groups[l].append(i)

l2 = {}  # id → {geom, name, area, kind, city, faces}
for did, idx in groups.items():
    if did in nat_info:
        n = nat_info[did]
        l2[did] = {"name": n["name"], "area": None, "kind": n["kind"], "city": None}
    elif did in seed_info:
        s = seed_info[did]
        l2[did] = {"name": s["name"], "area": s["area"], "city": None if s["city"][:1] in "@-" else s["city"],
                   "kind": "airport" if did in aero_seed else "rural" if s["city"] == "-" else ""}
    else:
        c = city_by_slug[did]
        l2[did] = {"name": cities_tsv[c]["ru"], "area": cities_tsv[c]["area"], "kind": "", "city": c}
    l2[did]["faces"] = idx
for s in list(seed_info) + list(nat_geom):
    if s not in l2:
        log("ВНИМАНИЕ: району не досталось территории:", s)

# Природные регионы — в ту крупную область, с которой у них самая длинная общая граница.
for did, d in l2.items():
    if d["area"] is None:
        tally = collections.Counter()
        for i in d["faces"]:
            for j, l in nbr[i].items():
                o = label[j]
                if o != did and l2.get(o, {}).get("area"):
                    tally[l2[o]["area"]] += l
        d["area"] = tally.most_common(1)[0][0] if tally else "dal-center"

# Крупная область — какого она типа: от этого зависят размеры районов и секторов.
CORE = {"dal-center", "fw-center"}
URBAN = {a for a in areas if a.startswith("dal-") or a in ("fw-north", "fw-west", "fw-south", "fw-east")} - CORE
RURALISH = {"fw-nw", "fw-far-north", "flowermound", "collin-east", "se-suburbs"}


def area_class(aid, kind):
    if kind in ("water", "green", "airport"):
        return "fixed"
    if kind == "rural":
        return "rural"
    return "core" if aid in CORE else "urban" if aid in URBAN else "rural" if aid in RURALISH else "suburb"


L2_MAX = {"core": 10, "urban": 16, "suburb": 28, "rural": 70}      # км²: больше — режем
L3_TARGET = {"core": 1.4, "urban": 3, "suburb": 5, "rural": 15}    # км²: размер сектора

DIRS = ["восток", "северо-восток", "север", "северо-запад", "запад", "юго-запад", "юг", "юго-восток"]
DIR_ID = ["e", "ne", "n", "nw", "w", "sw", "s", "se"]


def direction(pt, centre, scale):
    dx, dy = pt.x - centre.x, pt.y - centre.y
    if math.hypot(dx, dy) < 0.28 * scale:
        return "центр", "c"
    k = int(((math.degrees(math.atan2(dy, dx)) + 22.5) % 360) // 45)
    return DIRS[k], DIR_ID[k]


def cvt_centres(poly, k, iters=40):
    """Центры k кусков примерно равной площади: k-средних по равномерной сетке точек внутри многоугольника."""
    x0, y0, x1, y1 = poly.bounds
    step = math.sqrt(poly.area / max(400, 80 * k))
    xs, ys = np.meshgrid(np.arange(x0 + step / 2, x1, step), np.arange(y0 + step / 2, y1, step))
    xs, ys = xs.ravel(), ys.ravel()
    inside = shapely.contains_xy(poly, xs, ys)
    P = np.column_stack([xs[inside], ys[inside]])
    if len(P) < k:
        P = np.array([[p.x, p.y] for p in [poly.representative_point()] * k])
    rng = np.random.default_rng(7)
    C = [P[rng.integers(len(P))]]
    for _ in range(1, k):  # дальние точки как начальные центры
        d = np.min(((P[:, None, :] - np.array(C)[None, :, :]) ** 2).sum(-1), axis=1)
        C.append(P[int(np.argmax(d))])
    C = np.array(C, dtype=float)
    for _ in range(iters):
        a = np.argmin(((P[:, None, :] - C[None, :, :]) ** 2).sum(-1), axis=1)
        for j in range(k):
            if np.any(a == j):
                C[j] = P[a == j].mean(axis=0)
    return [Point(c) for c in C]


def major_faces(poly):
    """Куски многоугольника между фривеями, главными улицами, железной дорогой и рекой."""
    lines = [poly.boundary]
    for ls in (roads["motorway"], roads["trunk"], roads["primary"], rail, river_main):
        lines += [l.intersection(poly) for l in ls if l.intersects(poly)]
    return polygonize_all(lines, poly)


def split_region(poly, centres, target):
    """Делит многоугольник между центрами. Небольшие куски между крупными дорогами отдаются целиком
    ближайшему центру (граница идёт по дороге), большие режутся прямой посередине между центрами."""
    cells = list(voronoi_polygons(MultiPoint(centres), extend_to=poly).geoms)
    cell_of = [min(range(len(centres)), key=lambda j: centres[j].distance(c.representative_point())) for c in cells]
    fs, lab = [], []
    for f in chunk_thin(major_faces(poly)):
        if f.area < 0.45 * target and not thin(f):
            fs.append(f); lab.append(min(range(len(centres)), key=lambda j: centres[j].distance(f.representative_point())))
            continue
        for c, j in zip(cells, cell_of):
            piece = c.intersection(f)
            for p in getattr(piece, "geoms", [piece]):
                if p.geom_type == "Polygon" and p.area > 1e-5:
                    fs.append(p); lab.append(j)
    nb = adjacency(fs, 0.002)
    for i in sorted(range(len(fs)), key=lambda k: fs[k].area):  # мелочь и полоски — к соседям
        if fs[i].area < 0.03 or thin(fs[i]):
            b = best_neighbour(lab, nb, i, lambda j: fs[j].area >= 0.03 and not thin(fs[j]))
            if b is not None:
                lab[i] = b
    fix_detached(lab, nb, lambda k: fs[k].area, frac=1.0, rounds=4)
    parts = collections.defaultdict(list)
    for i, l in enumerate(lab):
        parts[l].append(fs[i])
    return {j: unary_union(v) for j, v in parts.items()}


def compass_names(geoms, whole):
    """Названия частей по сторонам света относительно целого: «север», «центр», «дальний юг»…"""
    centre, scale = whole.centroid, math.sqrt(whole.area)
    info = {}
    for k, g in geoms.items():
        c = g.representative_point() if not g.centroid.within(g) else g.centroid
        info[k] = (math.hypot(c.x - centre.x, c.y - centre.y), direction(c, centre, scale)[0] if math.hypot(c.x - centre.x, c.y - centre.y) >= 1e-9 else "центр")
    names = {}
    order = sorted(info, key=lambda k: info[k][0])
    if order and info[order[0]][0] < 0.28 * scale:
        names[order[0]] = "центр"
    for k in order:
        if k in names:
            continue
        d = info[k][1]
        if d == "центр":  # второй «центр» — по направлению
            c = geoms[k].representative_point()
            k8 = int(((math.degrees(math.atan2(c.y - centre.y, c.x - centre.x)) + 22.5) % 360) // 45)
            d = DIRS[k8]
        names[k] = d
    # одинаковые направления: ближний / дальний, дальше номера
    by = collections.defaultdict(list)
    for k, n in names.items():
        by[n].append(k)
    for n, ks in by.items():
        if len(ks) < 2:
            continue
        ks.sort(key=lambda k: info[k][0])
        for i, k in enumerate(ks):
            names[k] = ("ближний " if i == 0 else "дальний ") + n if len(ks) == 2 else n + " " + str(i + 1)
    return names


DIR_CODE = dict(zip(DIRS, DIR_ID), **{"центр": "c"})


def code_of(name):
    parts = name.split()
    pre = {"ближний": "1", "дальний": "2"}.get(parts[0], "")
    base = parts[-1] if pre else parts[0]
    num = parts[-1] if parts[-1].isdigit() else ""
    return DIR_CODE.get(base, "x") + pre + num


# Слишком большие районы режем на части примерно равной площади.
for did in list(l2):
    d = l2[did]
    d["geom"] = unary_union([faces[i] for i in d["faces"]])
    cls = area_class(d["area"], d["kind"])
    d["cls"] = cls
    if cls == "fixed" or d["geom"].area <= L2_MAX[cls] * 1.25:
        continue
    k = math.ceil(d["geom"].area / L2_MAX[cls])
    parts = split_region(d["geom"], cvt_centres(d["geom"], k), L2_MAX[cls])
    if len(parts) < 2:
        continue
    names = compass_names(parts, d["geom"])
    for j, g in parts.items():
        l2[did + "-" + code_of(names[j])] = dict(d, geom=g, name=d["name"] + ", " + names[j], split_of=did, base_name=d["name"])
    del l2[did]
log("районов после деления крупных:", len(l2))

# Сглаживание: общие границы упрощаются согласованно, без щелей и наложений.
ids2 = list(l2)
smooth = shapely.coverage_simplify([l2[i]["geom"] for i in ids2], 0.3, simplify_boundary=False)
for i, g in zip(ids2, smooth):
    l2[i]["geom"] = g if g.is_valid else g.buffer(0)

# ---------------------------------------------------------------- мелкий масштаб: секторы
log("секторы")
seeds3 = collections.defaultdict(list)
for s in read_seeds3():
    seeds3[s["parent"]].append(s)
l3 = {}
auto3 = collections.defaultdict(dict)  # исходный район → {id сектора: геометрия}, чтобы назвать по сторонам света от него
for did, d in l2.items():
    P = d["geom"]
    orig = d.get("split_of", did)
    if d["cls"] == "fixed":
        l3[did] = {"geom": P, "name": d["name"], "parent": did}; continue
    manual = [s for s in seeds3.get(orig, []) if P.contains(Point(fwd(s["lon"], s["lat"])))]
    target = L3_TARGET[d["cls"]]
    k = len(manual) if manual else max(1, round(P.area / target))
    if k == 1:
        l3[did] = {"geom": P, "name": d["name"], "parent": did}; continue
    centres = [Point(fwd(s["lon"], s["lat"])) for s in manual] if manual else cvt_centres(P, k)
    parts = split_region(P, centres, target)
    ids = list(parts)
    sm = shapely.coverage_simplify([parts[j] for j in ids], 0.15, simplify_boundary=False)
    for j, g in zip(ids, sm):
        g = g if g.is_valid else g.buffer(0)
        if manual:
            l3[manual[j]["id"]] = {"geom": g, "name": manual[j]["name"], "parent": did}
        else:
            auto3[orig][(did, j)] = g
for orig, parts in auto3.items():
    whole = unary_union(list(parts.values()))
    base = next(d.get("base_name", d["name"]) for k, d in l2.items() if d.get("split_of", k) == orig)
    names = compass_names(parts, whole)
    for (did, j), g in parts.items():
        l3[orig + "." + code_of(names[(did, j)])] = {"geom": g, "name": base + ", " + names[(did, j)], "parent": did}
for p, ss in seeds3.items():
    for sd in ss:
        if sd["id"] not in l3:
            log("ВНИМАНИЕ: ручной сектор %s (район %s) не применился" % (sd["id"], p))
log("секторов:", len(l3))

# ---------------------------------------------------------------- крупный масштаб: области
l1 = {}
for aid in areas:
    parts = [d["geom"] for d in l2.values() if d["area"] == aid]
    if not parts:
        log("ВНИМАНИЕ: у области нет районов:", aid); continue
    l1[aid] = {"geom": unary_union(parts), "name": areas[aid]}
l1_geom = {a: v["geom"] for a, v in l1.items()}

covered = unary_union([d["geom"] for d in l2.values()])
gap = FRAME.difference(covered)
for part in getattr(gap, "geoms", [gap]):
    if part.area > 0.2:
        rp = part.representative_point()
        log("ВНИМАНИЕ: дыра %.1f км² у %.4f %.4f" % (part.area, inv(rp.x, rp.y)[1], inv(rp.x, rp.y)[0]))


def colour(items, ncol, group=lambda k: None):
    """Жадная раскраска: соседи (в той же группе) разного цвета."""
    keys = sorted(items, key=lambda k: -items[k].area)
    tree = STRtree([items[k] for k in keys])
    grown = {k: items[k].buffer(0.03, 2) for k in keys}
    col = {}
    for k in keys:
        near = {col[keys[j]] for j in tree.query(grown[k]) if keys[j] in col and group(keys[j]) == group(k)}
        col[k] = next(c for c in range(ncol * 3) if c not in near) % ncol
    return col


tone = colour(l1_geom, 6)
shade2 = colour({k: v["geom"] for k, v in l2.items()}, 3, lambda k: l2[k]["area"])
shade3 = colour({k: v["geom"] for k, v in l3.items()}, 3, lambda k: l3[k]["parent"])


def label_point(g, prec):
    big = max(getattr(g, "geoms", [g]), key=lambda p: p.area)
    return mapping(lonlat_round(unproj(polylabel(big, prec))))


labels, f1, f2, f3 = [], [], [], []
for aid, v in l1.items():
    g = v["geom"]
    f1.append(feature(g, {"id": aid, "name": v["name"], "km2": round(g.area), "tone": tone[aid]}, 0.03))
    labels.append({"type": "Feature", "properties": {"id": aid, "name": v["name"], "km2": round(g.area), "level": 1, "kind": ""},
                   "geometry": label_point(g, 0.05)})
for did, d in sorted(l2.items()):
    g = d["geom"]
    f2.append(feature(g, {"id": did, "name": d["name"], "area": d["area"], "kind": d["kind"],
                          "city": cities_tsv.get(d["city"], {}).get("ru", "") if d["city"] else "",
                          "km2": round(g.area, 1), "tone": tone.get(d["area"], 0), "shade": shade2[did]}, 0.01))
    labels.append({"type": "Feature", "properties": {"id": did, "name": d["name"], "km2": round(g.area, 1), "level": 2, "kind": d["kind"]},
                   "geometry": label_point(g, 0.02)})
for sid, s in sorted(l3.items()):
    g = s["geom"]; p = l2[s["parent"]]
    f3.append(feature(g, {"id": sid, "name": s["name"], "parent": s["parent"], "area": p["area"], "kind": p["kind"],
                          "km2": round(g.area, 1), "tone": tone.get(p["area"], 0), "shade": shade3[sid]}, 0.01))
    labels.append({"type": "Feature", "properties": {"id": sid, "name": s["name"], "km2": round(g.area, 1), "level": 3, "kind": p["kind"]},
                   "geometry": label_point(g, 0.01)})
write("l1", f1)
write("l2", f2)
write("l3", f3)
write("labels", labels)


def merge_lines(g):
    return linemerge(g) if g.geom_type == "MultiLineString" else g


# ---------------------------------------------------------------- дороги с названиями
# Названия, которых в 2005 году ещё не было (их пропускаем и берём другое название той же дороги)
LATER_NAMES = re.compile(r"Sam Rayburn Tollway|Ronald Reagan Memorial|Margaret McDermott|Ralph Hall", re.I)


def norm_ref(ref):
    r = (ref or "").split(";")[0].strip()
    r = {"SRT": "SH 121"}.get(r, r)  # Sam Rayburn Tollway — название 2008 года, в 2005 это SH 121
    r = re.sub(r" (HOV|North|South|East|West)$", "", r)
    r = re.sub(r"^TX ", "SH ", r)
    return re.sub(r"^I ", "I-", r)


def norm_name(n):
    n = (n or "").strip()
    if "Frontage" in n or "Service Road" in n or re.match(r"^(I|US|SH) \d+ HOV$", n):
        return ""
    short = re.sub(r"^(North|South|East|West|N|S|E|W)\.? ", "", n)
    if len(short.split()) >= 2:  # «North Freeway» оставляем, «North Stemmons Freeway» → «Stemmons Freeway»
        n = short
    n = re.sub(r"\b(\w)\.(\w)\. ", r"\1 \2 ", n)  # «S.G. Alexander» → «S G Alexander»
    return re.sub(r"\b(\w)\. ", r"\1 ", n)  # «John W. Carpenter» → «John W Carpenter»


def road_features():
    """Дороги, сгруппированные по номеру (фривеи) или по названию (улицы) и разбитые на связные куски."""
    groups = collections.defaultdict(list)
    for cls, ln, t in road_ways:
        big = cls in ("motorway", "trunk")
        ref = norm_ref(t.get("ref"))
        key = (ref if big and ref else norm_name(t.get("name"))) or ""
        c = "motorway" if big else cls
        groups[(c, key)].append((ln, t))
    area_tree_ids = list(l1_geom)
    area_tree = STRtree([l1_geom[a] for a in area_tree_ids])
    feats, used_ids = [], collections.Counter()
    for (cls, key), items in groups.items():
        if not key:  # безымянные съезды и куски — одной линией без карточки
            feats.append(lines_feature([ln for ln, t in items], {"cls": cls, "id": ""}, 0.015 if cls != "secondary" else 0.025))
            continue
        # связные куски: одноимённые улицы в разных городах — разные дороги
        if cls == "motorway":
            comps = [items]
        else:
            blobs = unary_union([ln.buffer(0.3, 2) for ln, t in items])
            blobs = list(getattr(blobs, "geoms", [blobs]))
            comps = [[] for _ in blobs]
            for ln, t in items:
                mid = ln.interpolate(0.5, normalized=True)
                k = next((i for i, b in enumerate(blobs) if b.contains(mid)), 0)
                comps[k].append((ln, t))
        for comp in comps:
            if not comp:
                continue
            total = sum(ln.length for ln, t in comp)
            if total < 0.4:
                continue
            names = collections.Counter()
            lanes = collections.Counter()
            speed = collections.Counter()
            toll = 0.0
            for ln, t in comp:
                n = norm_name(t.get("name"))
                if n and not LATER_NAMES.search(n):
                    names[n] += ln.length
                try:
                    l = int(str(t.get("lanes", "")).split(";")[0])
                    lanes[l if t.get("oneway") in ("yes", "1") else max(1, l // 2)] += ln.length
                except ValueError:
                    pass
                m = re.match(r"(\d+)\s*mph", t.get("maxspeed", ""))
                if m:
                    speed[int(m.group(1))] += ln.length
                if t.get("toll") == "yes":
                    toll += ln.length
            geom = merge_lines(unary_union([ln for ln, t in comp]).intersection(FRAME))
            if geom.is_empty:
                continue
            crossed = []
            for i in area_tree.query(geom):
                l = l1_geom[area_tree_ids[i]].intersection(geom).length
                if l > 0.5:
                    crossed.append((l, area_tree_ids[i]))
            rid = re.sub(r"[^a-z0-9]+", "-", (cls[0] + "-" + key).lower()).strip("-")
            used_ids[rid] += 1
            if used_ids[rid] > 1:
                rid += "-" + str(used_ids[rid])
            ref = key if cls == "motorway" and re.match(r"^(I-|US |SH |Loop |Spur )|^(PGBT|DNT)$", key) else ""
            props = {"cls": cls, "id": rid, "ref": ref,
                     "name": names.most_common(1)[0][0] if names else ("" if ref else key),
                     "aka": [n for n, _ in names.most_common(4)[1:]],
                     "lanes": lanes.most_common(1)[0][0] if lanes else 0,
                     "speed": speed.most_common(1)[0][0] if speed else 0,
                     "toll": toll > 0.5 * total,
                     "km": round(total / (2 if cls == "motorway" else 1)),
                     "areas": [a for l, a in sorted(crossed, reverse=True)][:8]}
            feats.append(feature(geom, props, 0.015 if cls != "secondary" else 0.025))
    log("дорог с названиями:", sum(1 for f in feats if f["properties"]["id"]))
    return feats


# ---------------------------------------------------------------- подложка
log("подложка")


def lines_feature(ls, props, tol):
    m = merge_lines(unary_union(ls).intersection(FRAME))
    return feature(m, props, tol)


write("roads", road_features())
write("water", [feature(lakes, {"cls": "lake"}, 0.02),
                lines_feature(river_main, {"cls": "river"}, 0.02),
                lines_feature(creeks, {"cls": "creek"}, 0.03)])
write("rail", [lines_feature(rail, {"cls": "rail"}, 0.02), lines_feature(dart, {"cls": "dart"}, 0.015)])
write("green", [feature(unary_union([g for g, t in green]).difference(taken), {"cls": "park"}, 0.02),
                feature(unary_union([g for g, t in aero]).intersection(FRAME), {"cls": "airport"}, 0.02)])

summary = sorted(((d["area"], did, d["name"], round(d["geom"].area, 1), sum(1 for v in l3.values() if v["parent"] == did)) for did, d in l2.items()))
(OUT / "regions.txt").write_text("\n".join("%s\t%s\t%s\t%.1f км²\tсекторов: %d" % r for r in summary) + "\n", encoding="utf-8")
log("готово: областей", len(l1), "районов", len(l2), "секторов", len(l3))
