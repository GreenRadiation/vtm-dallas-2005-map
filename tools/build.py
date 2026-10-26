"""Собирает геометрию карты из сырых данных data/raw/ в data/geo/*.geojson.

Запуск из корня репозитория: python tools/build.py   (сначала python tools/fetch.py)

Что делает:
1. Подложка: дороги, вода, железные дороги, парки. Всё, что появилось после 2005 года и известно нам,
   вырезается (списки ANACHRONISM_*).
2. Регионы — как провинции в стратегиях: простые почти выпуклые многоугольники.
   Районы (l3) — ячейки Вороного вокруг опорных точек из data/seeds.tsv; пустые места заполняются
   дополнительными точками так, чтобы ячейки были примерно равной площади (k-средних по сетке).
   Озёра и парки (data/natural.tsv) и аэропорты — готовые сглаженные регионы.
   Части областей (l2) — группы соседних районов, области (l1) — объединение районов по полю «область»,
   секторы (l4) — ячейки Вороного внутри района (или по точкам из data/seeds3.tsv).
   Все уровни вложены друг в друга, границы общие.

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


def smooth_simple(g, r, tol, min_part):
    """Простая гладкая форма: закругляем рваный край, убираем острова и мелочь, оставляем мало вершин."""
    g = g.buffer(r, 4).buffer(-2 * r, 4).buffer(r, 4)
    g = drop_small(fill_holes(g, 3.0), min_part)
    return drop_small(g.simplify(tol).buffer(0), min_part)


# Готовые регионы: озёра, парки (data/natural.tsv) и аэропорты (точки «@aero:» в seeds.tsv)
FIXED, fixed_info, taken = {}, {}, Polygon()
for n in natural:
    parts = [g for g, t in water_polys + green_polys if t.get("name") in n["names"]]
    if not parts:
        log("ВНИМАНИЕ: не найден природный регион", n["id"], n["names"]); continue
    g = smooth_simple(unary_union(parts).intersection(FRAME), 0.15, 0.12, 0.3).difference(taken)
    g = drop_small(g.buffer(0), 0.3)
    if g.is_empty:
        continue
    FIXED[n["id"]] = g; fixed_info[n["id"]] = {"name": n["name"], "kind": n["kind"]}
    taken = taken.union(g)
for s in seeds:
    if s["city"].startswith("@aero:") and s["id"] not in FIXED:
        key = s["city"][6:].lower()
        cand = [g for g, t in aero if key in t.get("name", "").lower()]
        if not cand:
            sys.exit("не найден аэродром для " + s["id"] + ": " + key)
        g = smooth_simple(max(cand, key=lambda g: g.area).intersection(FRAME), 0.2, 0.1, 0.3).difference(taken)
        FIXED[s["id"]] = drop_small(g.buffer(0), 0.3)
        fixed_info[s["id"]] = {"name": s["name"], "kind": "airport", "area": s["area"]}
        taken = taken.union(FIXED[s["id"]])
DOMAIN = FRAME.difference(taken)

# ---------------------------------------------------------------- к какой области относится точка
# Город точки — по сглаженной городской черте 2000 года. Область: у Далласа, Форт-Уэрта и других городов
# со своими районами — область ближайшего района того же города; у остальных городов — из cities.tsv;
# вне городов — область ближайшего сельского района или просто ближайшего района.
log("области по точкам")
named = {}  # id → первая строка района (с названием)
for s in seeds:
    if s["id"] not in named and not s["city"].startswith("@"):
        named[s["id"]] = s
for c, g in cities.items():  # города без своих районов: один район в центре города
    slug = "c-" + re.sub(r"[^a-z]+", "-", c.lower()).strip("-")
    if c in cities_tsv and not any(s["city"] == c for s in named.values()) and g.intersection(DOMAIN).area > 1.5:
        p = g.intersection(DOMAIN)
        p = max(getattr(p, "geoms", [p]), key=lambda q: q.area)
        lp = polylabel(p, 0.05)
        lon, lat = inv(lp.x, lp.y)
        named[slug] = {"id": slug, "area": cities_tsv[c]["area"], "city": c, "lat": lat, "lon": lon, "name": cities_tsv[c]["ru"]}
seed_xy = {k: np.array(fwd(s["lon"], s["lat"])) for k, s in named.items()}

city_list = list(cities)


def city_at(xs, ys):
    out = np.full(len(xs), -1)
    for i, c in enumerate(city_list):
        out[shapely.contains_xy(cities[c], xs, ys) & (out < 0)] = i
    return out


def nearest(ids, xs, ys):
    """Индекс ближайшей точки из ids для каждой (x, y)."""
    P = np.array([seed_xy[k] for k in ids])
    d = (xs[:, None] - P[None, :, 0]) ** 2 + (ys[:, None] - P[None, :, 1]) ** 2
    return np.argmin(d, axis=1), np.min(d, axis=1)


def area_at(xs, ys):
    cid = city_at(xs, ys)
    res = np.empty(len(xs), dtype=object)
    by_city = collections.defaultdict(list)
    for k, s in named.items():
        by_city[s["city"]].append(k)
    for ci in np.unique(cid):
        m = cid == ci
        c = city_list[ci] if ci >= 0 else "-"
        ids = by_city.get(c) or (by_city["-"] if ci < 0 else None)
        if ci >= 0 and not ids:
            res[m] = cities_tsv.get(c, {}).get("area", "dal-center"); continue
        j, d = nearest(ids, xs[m], ys[m])
        a = np.array([named[ids[q]]["area"] for q in j], dtype=object)
        if ci < 0:  # вне городов дальше 15 км от сельских точек — по ближайшему району вообще
            far = d > 225
            if far.any():
                allids = list(named)
                j2, _ = nearest(allids, xs[m][far], ys[m][far])
                a[far] = [named[allids[q]]["area"] for q in j2]
        res[m] = a
    return res


CORE = {"dal-center", "fw-center"}
URBAN = {a for a in areas if a.startswith("dal-") or a in ("fw-north", "fw-west", "fw-south", "fw-east")} - CORE
RURALISH = {"fw-nw", "fw-far-north", "flowermound", "collin-east", "se-suburbs"}


def area_class(aid):
    return "core" if aid in CORE else "urban" if aid in URBAN else "rural" if aid in RURALISH else "suburb"


# размеры ячеек (км²) по типу области: районы, части областей, секторы
T_DISTRICT = {"core": 5, "urban": 11, "suburb": 20, "rural": 45}
T_ZONE = {"core": 25, "urban": 45, "suburb": 70, "rural": 160}
T_SECTOR = {"core": 1.4, "urban": 3, "suburb": 5, "rural": 15}

# равномерная сетка точек по суше: по ней считаются площади и центры ячеек
STEP = 0.25
x0, y0, x1, y1 = FRAME.bounds
GX, GY = np.meshgrid(np.arange(x0 + STEP / 2, x1, STEP), np.arange(y0 + STEP / 2, y1, STEP))
GX, GY = GX.ravel(), GY.ravel()
on = shapely.contains_xy(DOMAIN, GX, GY)
GX, GY = GX[on], GY[on]
GA = area_at(GX, GY)
log("точек сетки:", len(GX))


def lloyd(P, fixed_pts, k_free, iters=35, seed=7):
    """k-средних по точкам P: фиксированные центры стоят на месте, свободные двигаются к центрам своих точек."""
    if k_free <= 0:
        return np.zeros((0, 2))
    rng = np.random.default_rng(seed)
    F = np.array(fixed_pts).reshape(-1, 2)
    C = []
    for _ in range(k_free):  # начальные центры — самые далёкие от уже стоящих
        allc = np.vstack([F] + ([np.array(C)] if C else [])) if len(F) or C else None
        if allc is None or not len(allc):
            C.append(P[rng.integers(len(P))]); continue
        d = np.min(((P[:, None, :] - allc[None, :, :]) ** 2).sum(-1), axis=1)
        C.append(P[int(np.argmax(d))])
    C = np.array(C, dtype=float)
    for _ in range(iters):
        allc = np.vstack([F, C]) if len(F) else C
        a = np.argmin(((P[:, None, :] - allc[None, :, :]) ** 2).sum(-1), axis=1) - len(F)
        for j in range(len(C)):
            if np.any(a == j):
                C[j] = P[a == j].mean(axis=0)
    return C


def voronoi_cells(points, clip):
    """Ячейки Вороного вокруг точек, обрезанные областью clip; порядок как у points."""
    if len(points) == 1:
        return [clip]
    mp = MultiPoint([Point(p) for p in points])
    cells = list(voronoi_polygons(mp, extend_to=clip).geoms)
    out = [None] * len(points)
    for c in cells:
        j = min(range(len(points)), key=lambda i: (points[i][0] - c.centroid.x) ** 2 + (points[i][1] - c.centroid.y) ** 2) \
            if not any(c.contains(Point(p)) for p in points) else next(i for i, p in enumerate(points) if c.contains(Point(p)))
        out[j] = c.intersection(clip)
    return [o if o is not None else Polygon() for o in out]


def tidy(cells, ids):
    """Ячейка, разрезанная озером или краем, оставляет себе большую часть; мелкие куски — соседям."""
    main, loose = {}, []
    for k, g in zip(ids, cells):
        parts = sorted([p for p in getattr(g, "geoms", [g]) if p.geom_type == "Polygon" and p.area > 1e-6], key=lambda p: -p.area)
        if not parts:
            continue
        main[k] = parts[0]
        loose += parts[1:]
    for p in sorted(loose, key=lambda p: -p.area):
        best, bl = None, 0
        for k, g in main.items():
            if g.distance(p) < 1e-6:
                l = g.boundary.intersection(p.boundary).length
                if l > bl:
                    best, bl = k, l
        if best:
            main[best] = unary_union([main[best], p]).buffer(0)
    return main


# ---------------------------------------------------------------- районы (мелкий масштаб, d)
log("районы")
fixed_pts_by_area = collections.defaultdict(list)
for k, s in named.items():
    fixed_pts_by_area[s["area"]].append(seed_xy[k])
dist_pts, dist_ids = [], []
for k in named:
    dist_pts.append(seed_xy[k]); dist_ids.append(k)
for aid in areas:
    m = GA == aid
    if not m.any():
        continue
    P = np.column_stack([GX[m], GY[m]])
    total = m.sum() * STEP * STEP
    k_free = max(0, round(total / T_DISTRICT[area_class(aid)]) - len(fixed_pts_by_area[aid]))
    C = lloyd(P, fixed_pts_by_area[aid], k_free)
    for j, c in enumerate(C):
        dist_pts.append(c); dist_ids.append("%s~%d" % (aid, j))
cells = tidy(voronoi_cells(dist_pts, DOMAIN), dist_ids)
log("ячеек районов:", len(cells))

D = {}  # id → {geom, name, area, kind, named}
area_of_auto = {}
for k, g in cells.items():
    if "~" in k:
        D[k] = {"geom": g, "area": k.split("~")[0], "kind": "", "named": False}
    else:
        s = named[k]
        D[k] = {"geom": g, "area": s["area"], "kind": "rural" if s["city"] == "-" else "", "named": True, "name": s["name"]}
# ячейка может оказаться в основном на земле другой области (точка у края) — переносим по большинству
for k, d in D.items():
    c = d["geom"].representative_point()
for k, d in D.items():
    if d["named"]:
        continue
    g = d["geom"]
    m = shapely.contains_xy(g, GX, GY)
    if m.any():
        vals, cnt = np.unique(GA[m], return_counts=True)
        d["area"] = vals[np.argmax(cnt)]


def direction(pt, centre, scale):
    dx, dy = pt.x - centre.x, pt.y - centre.y
    if math.hypot(dx, dy) < 0.28 * scale:
        return "центр"
    return DIRS[int(((math.degrees(math.atan2(dy, dx)) + 22.5) % 360) // 45)]


DIRS = ["восток", "северо-восток", "север", "северо-запад", "запад", "юго-запад", "юг", "юго-восток"]
DIR_ID = dict(zip(DIRS + ["центр"], ["e", "ne", "n", "nw", "w", "sw", "s", "se", "c"]))


def compass_names(geoms, centre, scale):
    """Названия по сторонам света; одинаковые различаем «ближний/дальний» или номером."""
    names = {k: direction(g.representative_point() if not g.centroid.within(g) else g.centroid, centre, scale) for k, g in geoms.items()}
    if list(names.values()).count("центр") > 1:  # «центр» только у ближайшей
        cs = sorted([k for k, n in names.items() if n == "центр"], key=lambda k: geoms[k].centroid.distance(centre))
        for k in cs[1:]:
            c = geoms[k].centroid
            names[k] = DIRS[int(((math.degrees(math.atan2(c.y - centre.y, c.x - centre.x)) + 22.5) % 360) // 45)]
    by = collections.defaultdict(list)
    for k, n in names.items():
        by[n].append(k)
    for n, ks in by.items():
        if len(ks) < 2:
            continue
        ks.sort(key=lambda k: geoms[k].centroid.distance(centre))
        for i, k in enumerate(ks):
            names[k] = (("ближний " if i == 0 else "дальний ") + n) if len(ks) == 2 else n + " " + str(i + 1)
    return names


def code(n):
    p = n.split()
    pre = {"ближний": "1", "дальний": "2"}.get(p[0], "")
    base = p[-1] if pre else p[0]
    return DIR_ID.get(base, "x") + pre + (p[-1] if p[-1].isdigit() else "")


# Названия ячеек без своей точки: по городу (если в городе нет своих районов) или по ближайшему району той же области.
auto = [k for k, d in D.items() if not d["named"]]
groups = collections.defaultdict(list)
for k in auto:
    g = D[k]["geom"]; c = g.representative_point()
    ci = city_at(np.array([c.x]), np.array([c.y]))[0]
    cname = city_list[ci] if ci >= 0 else None
    cand = [n for n in named if named[n]["area"] == D[k]["area"] and (cname is None or named[n]["city"] in (cname, "-") or named[n]["city"] == cname)]
    cand = cand or [n for n in named if named[n]["area"] == D[k]["area"]] or list(named)
    host = min(cand, key=lambda n: ((seed_xy[n] - np.array([c.x, c.y])) ** 2).sum())
    groups[host].append(k)
renamed = {}
for host, ks in groups.items():
    hg = D[host]["geom"] if host in D else None
    centre = Point(seed_xy[host]); scale = math.sqrt(sum(D[k]["geom"].area for k in ks) + (hg.area if hg else 0))
    names = compass_names({k: D[k]["geom"] for k in ks}, centre, scale)
    for k in ks:
        nm = names[k] if names[k] != "центр" else "окрестности"
        D[k]["name"] = named[host]["name"] + ", " + nm
        renamed[k] = host + "-" + code(nm if nm != "окрестности" else "центр")
D = {renamed.get(k, k): v for k, v in D.items()}
for k, g in FIXED.items():
    info = fixed_info[k]
    D[k] = {"geom": g, "area": info.get("area"), "kind": info["kind"], "named": True, "name": info["name"]}


def adjacency_map(geoms):
    keys = list(geoms)
    tree = STRtree([geoms[k] for k in keys])
    nb = {k: {} for k in keys}
    for i, k in enumerate(keys):
        for j in tree.query(geoms[k].buffer(1e-6)):
            if j <= i:
                continue
            l = geoms[k].boundary.intersection(geoms[keys[j]].boundary).length
            if l > 1e-4:
                nb[k][keys[j]] = l; nb[keys[j]][k] = l
    return nb


# клочки суши, не доставшиеся ни одной ячейке (у края рамки), — соседу с самой длинной общей границей
rest = FRAME.difference(unary_union([d["geom"] for d in D.values()]))
for part in getattr(rest, "geoms", [rest]):
    if part.geom_type != "Polygon" or part.area < 1e-6:
        continue
    best = max(D, key=lambda k: D[k]["geom"].boundary.intersection(part.boundary).length if D[k]["geom"].distance(part) < 1e-6 else -1)
    D[best]["geom"] = unary_union([D[best]["geom"], part]).buffer(0)
    if best in FIXED:
        FIXED[best] = D[best]["geom"]

nbD = adjacency_map({k: d["geom"] for k, d in D.items()})
for k, d in D.items():  # озёра и парки — в ту область, с которой у них самая длинная граница
    if d["area"] is None:
        tally = collections.Counter()
        for o, l in nbD[k].items():
            if D[o]["area"]:
                tally[D[o]["area"]] += l
        d["area"] = tally.most_common(1)[0][0] if tally else "dal-center"
log("районов:", len(D))

# ---------------------------------------------------------------- части областей (средний масштаб, z)
log("части областей")
Z = {}
for aid in areas:
    members = [k for k, d in D.items() if d["area"] == aid and d["kind"] not in ("water", "green", "airport")]
    if not members:
        continue
    tot = sum(D[k]["geom"].area for k in members)
    k2 = max(1, round(tot / T_ZONE[area_class(aid)]))
    P = np.array([[D[k]["geom"].centroid.x, D[k]["geom"].centroid.y] for k in members])
    W = np.array([D[k]["geom"].area for k in members])
    if k2 == 1 or len(members) <= k2:
        lab = np.zeros(len(members), dtype=int) if k2 == 1 else np.arange(len(members))
    else:
        rng = np.random.default_rng(3)
        C = [P[np.argmax(W)]]
        for _ in range(1, k2):
            d = np.min(((P[:, None, :] - np.array(C)[None]) ** 2).sum(-1), axis=1)
            C.append(P[int(np.argmax(d))])
        C = np.array(C, dtype=float)
        for _ in range(40):
            lab = np.argmin(((P[:, None, :] - C[None]) ** 2).sum(-1), axis=1)
            for j in range(k2):
                if np.any(lab == j):
                    C[j] = (P[lab == j] * W[lab == j, None]).sum(0) / W[lab == j].sum()
        # связность: оторванные куски — к соседней части
        for _ in range(4):
            changed = False
            for j in range(k2):
                idx = [members[i] for i in range(len(members)) if lab[i] == j]
                if len(idx) < 2:
                    continue
                s = set(idx); comps = []
                while s:
                    st = [s.pop()]; comp = []
                    while st:
                        q = st.pop(); comp.append(q)
                        for o in nbD[q]:
                            if o in s:
                                s.remove(o); st.append(o)
                    comps.append(comp)
                comps.sort(key=lambda c: -sum(D[q]["geom"].area for q in c))
                for comp in comps[1:]:
                    for q in comp:
                        tally = collections.Counter()
                        for o, l in nbD[q].items():
                            if o in members and lab[members.index(o)] != j:
                                tally[lab[members.index(o)]] += l
                        if tally:
                            lab[members.index(q)] = tally.most_common(1)[0][0]; changed = True
            if not changed:
                break
    parts = collections.defaultdict(list)
    for i, k in enumerate(members):
        parts[int(lab[i])].append(k)
    whole = unary_union([D[k]["geom"] for k in members])
    names_dir = compass_names({j: unary_union([D[k]["geom"] for k in ks]) for j, ks in parts.items()}, whole.centroid, math.sqrt(whole.area))
    for j, ks in parts.items():
        big = sorted([k for k in ks if D[k]["named"] and "," not in D[k]["name"]], key=lambda k: -D[k]["geom"].area)
        if len(parts) == 1:
            nm = areas[aid]
        elif len(big) >= 2:
            nm = D[big[0]]["name"] + " и " + D[big[1]]["name"]
        elif len(big) == 1:
            nm = D[big[0]]["name"] + " и окрестности"
        else:
            nm = areas[aid] + ", " + names_dir[j]
        zid = aid + "." + code(names_dir[j]) if len(parts) > 1 else aid
        Z[zid] = {"geom": unary_union([D[k]["geom"] for k in ks]), "area": aid, "name": nm, "members": ks}
        for k in ks:
            D[k]["zone"] = zid
for k, d in D.items():  # озёра, парки, аэропорты — сами себе часть области
    if "zone" not in d:
        Z[k] = {"geom": d["geom"], "area": d["area"], "name": d["name"], "members": [k], "kind": d["kind"]}
        d["zone"] = k
log("частей областей:", len(Z))

# ---------------------------------------------------------------- секторы (детальный масштаб, s)
log("секторы")
seeds3 = collections.defaultdict(list)
for s in read_seeds3():
    seeds3[s["parent"]].append(s)
S = {}
for k, d in D.items():
    g = d["geom"]
    if d["kind"] in ("water", "green", "airport"):
        S[k] = {"geom": g, "name": d["name"], "parent": k}; continue
    manual = [s for s in seeds3.get(k, []) if g.contains(Point(fwd(s["lon"], s["lat"])))]
    n = len(manual) if manual else max(1, round(g.area / T_SECTOR[area_class(d["area"])]))
    if n == 1:
        S[k] = {"geom": g, "name": d["name"], "parent": k}; continue
    if manual:
        pts = [np.array(fwd(s["lon"], s["lat"])) for s in manual]
    else:
        m = shapely.contains_xy(g, GX, GY)
        P = np.column_stack([GX[m], GY[m]])
        if len(P) < n * 3:  # мелкий район — сетка гуще
            st = math.sqrt(g.area / (n * 40))
            bx0, by0, bx1, by1 = g.bounds
            xs, ys = np.meshgrid(np.arange(bx0, bx1, st), np.arange(by0, by1, st))
            xs, ys = xs.ravel(), ys.ravel()
            ins = shapely.contains_xy(g, xs, ys)
            P = np.column_stack([xs[ins], ys[ins]])
        pts = list(lloyd(P, [], n))
    sub = tidy(voronoi_cells(pts, g), list(range(len(pts))))
    if manual:
        for j, sg in sub.items():
            S[manual[j]["id"]] = {"geom": sg, "name": manual[j]["name"], "parent": k}
    else:
        nm = compass_names(sub, g.centroid, math.sqrt(g.area))
        for j, sg in sub.items():
            S[k + "." + code(nm[j])] = {"geom": sg, "name": d["name"] + " — " + nm[j], "parent": k}
for p, ss in seeds3.items():
    for sd in ss:
        if sd["id"] not in S:
            log("ВНИМАНИЕ: ручной сектор %s (район %s) не применился" % (sd["id"], p))
log("секторов:", len(S))

# ---------------------------------------------------------------- области (крупный масштаб, a)
A = {}
for aid in areas:
    parts = [d["geom"] for d in D.values() if d["area"] == aid]
    if parts:
        A[aid] = {"geom": unary_union(parts), "name": areas[aid]}
    else:
        log("ВНИМАНИЕ: у области нет районов:", aid)
l1_geom = {a: v["geom"] for a, v in A.items()}
gap = FRAME.difference(unary_union([d["geom"] for d in D.values()]))
for part in getattr(gap, "geoms", [gap]):
    if part.area > 0.05:
        rp = part.representative_point()
        log("ВНИМАНИЕ: дыра %.2f км² у %.4f %.4f" % (part.area, inv(rp.x, rp.y)[1], inv(rp.x, rp.y)[0]))


def colour(items, ncol, group=lambda k: None):
    """Жадная раскраска: соседи (в той же группе) разного цвета."""
    keys = sorted(items, key=lambda k: -items[k].area)
    tree = STRtree([items[k] for k in keys])
    col = {}
    for k in keys:
        near = {col[keys[j]] for j in tree.query(items[k].buffer(0.01)) if keys[j] in col and group(keys[j]) == group(k)}
        col[k] = next(c for c in range(ncol * 4) if c not in near) % ncol
    return col


tone = colour(l1_geom, 6)
shadeZ = colour({k: v["geom"] for k, v in Z.items()}, 3, lambda k: Z[k]["area"])
shadeD = colour({k: v["geom"] for k, v in D.items()}, 3, lambda k: D[k]["zone"])
shadeS = colour({k: v["geom"] for k, v in S.items()}, 3, lambda k: S[k]["parent"])


def label_point(g, prec):
    big = max(getattr(g, "geoms", [g]), key=lambda p: p.area)
    return mapping(lonlat_round(unproj(polylabel(big, prec))))


labels, out = [], {"l1": [], "l2": [], "l3": [], "l4": []}


def emit(level, file, rid, g, props, prec):
    props = dict(id=rid, km2=round(g.area, 1), **props)
    out[file].append(feature(g, props, 0))
    labels.append({"type": "Feature", "properties": {"id": rid, "name": props["name"], "km2": props["km2"], "level": level, "kind": props.get("kind", "")},
                   "geometry": label_point(g, prec)})


for aid, v in A.items():
    emit(1, "l1", aid, v["geom"], {"name": v["name"], "tone": tone[aid]}, 0.05)
for zid, v in Z.items():
    emit(2, "l2", zid, v["geom"], {"name": v["name"], "area": v["area"], "kind": v.get("kind", ""), "tone": tone.get(v["area"], 0), "shade": shadeZ[zid]}, 0.03)
for did, d in D.items():
    emit(3, "l3", did, d["geom"], {"name": d["name"], "area": d["area"], "zone": d["zone"], "kind": d["kind"], "tone": tone.get(d["area"], 0), "shade": shadeD[did]}, 0.02)
for sid, s in S.items():
    p = D[s["parent"]]
    emit(4, "l4", sid, s["geom"], {"name": s["name"], "parent": s["parent"], "area": p["area"], "kind": p["kind"], "tone": tone.get(p["area"], 0), "shade": shadeS[sid]}, 0.01)
for f in ("l1", "l2", "l3", "l4"):
    write(f, out[f])
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

summary = sorted(((d["area"], d["zone"], did, d["name"], round(d["geom"].area, 1), sum(1 for v in S.values() if v["parent"] == did)) for did, d in D.items()))
(OUT / "regions.txt").write_text("\n".join("%s\t%s\t%s\t%s\t%.1f км²\tсекторов: %d" % r for r in summary) + "\n", encoding="utf-8")
log("готово: областей", len(A), "частей", len(Z), "районов", len(D), "секторов", len(S))
