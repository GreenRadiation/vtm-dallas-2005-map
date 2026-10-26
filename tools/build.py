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


# ================================================================ РЕГИОНЫ (см. docs/REGIONS.md)
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

FORCE = "--force" in sys.argv  # записать результат, даже если проверки не прошли (для отладки)
SMOOTH = 0.6  # км: насколько сглаживать границы (coverage_simplify, Висвалингам)


def smooth_simple(g, r, tol, min_part):
    """Простая гладкая форма: закругляем рваный край, убираем острова и мелочь."""
    g = g.buffer(r, 4).buffer(-2 * r, 4).buffer(r, 4)
    g = drop_small(fill_holes(g, 3.0), min_part)
    return drop_small(g.simplify(tol).buffer(0), min_part)


# Озёра и парки (data/natural.tsv) и аэропорты (точки «@aero:» в seeds.tsv) — заготовки готовых регионов.
FIXED, fixed_info, taken = {}, {}, Polygon()
for n in natural:
    parts = [g for g, t in water_polys + green_polys if t.get("name") in n["names"]]
    if not parts:
        log("ВНИМАНИЕ: не найден природный регион", n["id"], n["names"]); continue
    g = drop_small(smooth_simple(unary_union(parts).intersection(FRAME), 0.15, 0.12, 0.3).difference(taken).buffer(0), 0.3)
    if not g.is_empty:
        FIXED[n["id"]] = g; fixed_info[n["id"]] = {"name": n["name"], "kind": n["kind"]}; taken = taken.union(g)
for s in seeds:
    if s["city"].startswith("@aero:") and s["id"] not in FIXED:
        key = s["city"][6:].lower()
        cand = [g for g, t in aero if key in t.get("name", "").lower()]
        if not cand:
            sys.exit("не найден аэродром для " + s["id"] + ": " + key)
        g = drop_small(smooth_simple(max(cand, key=lambda g: g.area).intersection(FRAME), 0.2, 0.1, 0.3).difference(taken).buffer(0), 0.3)
        FIXED[s["id"]] = g; fixed_info[s["id"]] = {"name": s["name"], "kind": "airport", "area": s["area"]}
        taken = taken.union(g)

# ---------------------------------------------------------------- подсказка области по точке
# Город — по сглаженной городской черте 2000 года. Область: у городов со своими районами — область ближайшего
# района того же города; у остальных — из cities.tsv; вне городов — ближайшего сельского района или любого.
# Это только подсказка: на карте области потом обязаны быть сплошными.
named = {}
for s in seeds:
    if s["id"] not in named and not s["city"].startswith("@"):
        named[s["id"]] = dict(s, source="seed")
for c, g in cities.items():  # город без своих районов — точка в его центре
    slug = "c-" + re.sub(r"[^a-z]+", "-", c.lower()).strip("-")
    if c in cities_tsv and not any(s["city"] == c for s in named.values()) and g.difference(taken).area > 1.5:
        p = g.difference(taken)
        p = max(getattr(p, "geoms", [p]), key=lambda q: q.area)
        lp = polylabel(p, 0.05)
        lon, lat = inv(lp.x, lp.y)
        named[slug] = {"id": slug, "area": cities_tsv[c]["area"], "city": c, "lat": lat, "lon": lon, "name": cities_tsv[c]["ru"], "source": "city"}
seed_xy = {k: np.array(fwd(s["lon"], s["lat"])) for k, s in named.items()}
city_list = list(cities)


def city_at(xs, ys):
    out = np.full(len(xs), -1)
    for i, c in enumerate(city_list):
        out[shapely.contains_xy(cities[c], xs, ys) & (out < 0)] = i
    return out


def area_at(xs, ys):
    cid = city_at(xs, ys)
    res = np.empty(len(xs), dtype=object)
    by_city = collections.defaultdict(list)
    for k, s in named.items():
        by_city[s["city"]].append(k)
    allids = list(named)
    alltree = cKDTree(np.array([seed_xy[k] for k in allids]))
    for ci in np.unique(cid):
        m = cid == ci
        c = city_list[ci] if ci >= 0 else "-"
        ids = by_city.get(c) or (by_city["-"] if ci < 0 else None)
        if ci >= 0 and not ids:
            res[m] = cities_tsv.get(c, {}).get("area", "dal-center"); continue
        d, j = cKDTree(np.array([seed_xy[k] for k in ids])).query(np.column_stack([xs[m], ys[m]]))
        a = np.array([named[ids[q]]["area"] for q in j], dtype=object)
        if ci < 0:  # вне городов дальше 15 км от сельских точек — по ближайшему району вообще
            far = d > 15
            if far.any():
                _, j2 = alltree.query(np.column_stack([xs[m][far], ys[m][far]]))
                a[far] = [named[allids[q]]["area"] for q in j2]
        res[m] = a
    return res


CORE = {"dal-center", "fw-center"}
URBAN = {a for a in areas if a.startswith("dal-") or a in ("fw-north", "fw-west", "fw-south", "fw-east")} - CORE
RURALISH = {"fw-nw", "fw-far-north", "flowermound", "collin-east", "se-suburbs"}


def area_class(aid):
    return "core" if aid in CORE else "urban" if aid in URBAN else "rural" if aid in RURALISH else "suburb"


T_ATOM = {"core": 0.25, "urban": 0.6, "suburb": 1.0, "rural": 2.0}
T_DISTRICT = {"core": 5, "urban": 11, "suburb": 20, "rural": 45}
T_ZONE = {"core": 25, "urban": 45, "suburb": 70, "rural": 160}
T_SECTOR = {"core": 1.4, "urban": 3, "suburb": 5, "rural": 15}

# ---------------------------------------------------------------- 1. атомы
log("атомы")
STEP = 0.2
x0, y0, x1, y1 = FRAME.bounds
GX, GY = np.meshgrid(np.arange(x0 + STEP / 2, x1, STEP), np.arange(y0 + STEP / 2, y1, STEP))
GX, GY = GX.ravel(), GY.ravel()
GA = area_at(GX, GY)
GW = np.array([1.0 / T_ATOM[area_class(a)] for a in GA])  # плотность атомов
rng = np.random.default_rng(11)
n_atoms = int(round((GW * STEP * STEP).sum()))
pick = rng.choice(len(GX), n_atoms, replace=False, p=GW / GW.sum())
PTS = np.column_stack([GX[pick], GY[pick]]) + rng.uniform(-STEP / 2, STEP / 2, (n_atoms, 2))
G = np.column_stack([GX, GY])
for _ in range(12):  # Ллойд с весом плотности: атомы становятся ровнее
    _, own_ = cKDTree(PTS).query(G)
    sw = np.bincount(own_, weights=GW, minlength=n_atoms)
    sx = np.bincount(own_, weights=GW * GX, minlength=n_atoms)
    sy = np.bincount(own_, weights=GW * GY, minlength=n_atoms)
    ok = sw > 0
    PTS[ok] = np.column_stack([sx[ok] / sw[ok], sy[ok] / sw[ok]])
vor = voronoi_polygons(MultiPoint([Point(p) for p in PTS]), extend_to=FRAME, ordered=True)
AP = [c.intersection(FRAME) for c in vor.geoms]
AP = [max(getattr(c, "geoms", [c]), key=lambda q: q.area) if c.geom_type != "Polygon" else c for c in AP]
NA = len(AP)
AA = np.array([p.area for p in AP])
AC = np.array([[p.centroid.x, p.centroid.y] for p in AP])
HINT = area_at(AC[:, 0], AC[:, 1])
log("атомов:", NA, "средняя площадь %.2f км²" % AA.mean())

# соседство атомов и цена перехода
atree = STRtree(AP)
pairs = set()
for i, p in enumerate(AP):
    for j in atree.query(p.buffer(1e-6)):
        if j > i and p.boundary.intersection(AP[j].boundary).length > 1e-4:
            pairs.add((i, j))
pairs = sorted(pairs)
barriers = [(STRtree(roads["motorway"] + roads["trunk"]), roads["motorway"] + roads["trunk"], 4.0),
            (STRtree(river_main), river_main, 6.0), (STRtree(rail), rail, 2.0)]
EI, EJ, EW = [], [], []
for i, j in pairs:
    seg = LineString([AC[i], AC[j]])
    w = float(np.hypot(*(AC[i] - AC[j])))
    for tree, lines, f in barriers:
        if any(lines[k].intersects(seg) for k in tree.query(seg)):
            w *= f
    if HINT[i] != HINT[j]:
        w *= 2.0
    EI.append(i); EJ.append(j); EW.append(w)
EI, EJ, EW = np.array(EI), np.array(EJ), np.array(EW)
NB = [dict() for _ in range(NA)]
for i, j in pairs:
    l = AP[i].boundary.intersection(AP[j].boundary).length
    NB[i][j] = l; NB[j][i] = l
log("рёбер:", len(EI))


def graph(nodes):
    """Разреженная матрица графа на подмножестве атомов (индексы — позиции в nodes)."""
    pos = {a: k for k, a in enumerate(nodes)}
    m = np.array([(a in pos) and (b in pos) for a, b in zip(EI, EJ)], dtype=bool)
    r = np.array([pos[a] for a in EI[m]]); c = np.array([pos[b] for b in EJ[m]])
    return coo_matrix((EW[m], (r, c)), shape=(len(nodes), len(nodes))).tocsr(), pos


def grow(nodes, seed_nodes, fixed_n, iters=4):
    """Многоисточниковый Дейкстра: каждый атом — ближайшему по графу центру; свободные центры (после fixed_n)
    несколько раз сдвигаются в середину своей области. Возвращает метку (номер центра) для каждого узла."""
    M, pos = graph(nodes)
    sp = [pos[s] for s in seed_nodes]
    W = AA[nodes]; C = AC[nodes]
    for it in range(iters + 1):
        dist, _, src = dijkstra(M, directed=False, indices=sp, min_only=True, return_predecessors=True)
        lab = np.array([sp.index(s) if s >= 0 else -1 for s in src])
        if it == iters:
            break
        moved = False
        for k in range(fixed_n, len(sp)):
            mk = lab == k
            if not mk.any():
                continue
            cen = (C[mk] * W[mk, None]).sum(0) / W[mk].sum()
            cand = np.where(mk)[0]
            best = cand[np.argmin(((C[cand] - cen) ** 2).sum(1))]
            if best != sp[k] and best not in sp:
                sp[k] = best; moved = True
        if not moved:
            break
    # недостижимые (остров, отрезанный озером) — к ближайшему по прямой размеченному
    bad = np.where(lab < 0)[0]
    if len(bad):
        good = np.where(lab >= 0)[0]
        _, j = cKDTree(C[good]).query(C[bad])
        lab[bad] = lab[good[j]]
    return lab, [nodes[s] for s in sp]


def kmeans_pts(P, W, fixed_pts, k_free, iters=30):
    """Свободные центры для k-средних по точкам P с весами W; фиксированные стоят на месте."""
    if k_free <= 0:
        return np.zeros((0, 2))
    F = np.array(fixed_pts).reshape(-1, 2)
    C = []
    for _ in range(k_free):
        allc = np.vstack([F] + ([np.array(C)] if C else [])) if (len(F) or C) else None
        if allc is None or not len(allc):
            C.append(P[np.argmax(W)]); continue
        d = cKDTree(allc).query(P)[0]
        C.append(P[int(np.argmax(d * W))])
    C = np.array(C, dtype=float)
    for _ in range(iters):
        allc = np.vstack([F, C]) if len(F) else C
        a = cKDTree(allc).query(P)[1] - len(F)
        for j in range(len(C)):
            m = a == j
            if m.any():
                C[j] = (P[m] * W[m, None]).sum(0) / W[m].sum()
    return C


# ---------------------------------------------------------------- 2. готовые регионы из атомов
ATOM_FIX = np.full(NA, None, dtype=object)
for fid, g in FIXED.items():
    best, bestv = None, 0
    for i in atree.query(g):
        v = AP[i].intersection(g).area
        if v > 0.5 * AA[i]:
            ATOM_FIX[i] = fid
        if v > bestv:
            best, bestv = i, v
    if not (ATOM_FIX == fid).any():
        if best is not None and bestv > 0.25 * AA[best]:
            ATOM_FIX[best] = fid
        else:
            log("ВНИМАНИЕ: природный регион слишком мелкий для атомов, пропущен:", fid); fixed_info.pop(fid, None)
for fid in list(fixed_info):  # готовый регион — один кусок; отрывки отдаём окружению
    idx = set(np.where(ATOM_FIX == fid)[0])
    comps = []
    while idx:
        st = [idx.pop()]; comp = []
        while st:
            q = st.pop(); comp.append(q)
            for o in NB[q]:
                if o in idx:
                    idx.remove(o); st.append(o)
        comps.append(comp)
    comps.sort(key=lambda c: -AA[c].sum())
    for comp in comps[1:]:
        for q in comp:
            ATOM_FIX[q] = None
free = [i for i in range(NA) if ATOM_FIX[i] is None]
log("атомов под озёрами, парками и аэропортами:", NA - len(free))

# ---------------------------------------------------------------- 3. районы
log("районы")
ftree = cKDTree(AC)
free_set = set(free)
seed_atoms, seed_ids = [], []
for k, s in named.items():
    _, cand = ftree.query(seed_xy[k], k=8)
    a = next((c for c in cand if c in free_set and c not in seed_atoms), None)
    if a is None:
        log("ВНИМАНИЕ: точка района %s под водой или занята, пропущена" % k); continue
    seed_atoms.append(int(a)); seed_ids.append(k)
fixed_n = len(seed_atoms)
for aid in areas:
    m = np.array([HINT[i] == aid for i in free])
    if not m.any():
        continue
    nodes = np.array(free)[m]
    total = AA[nodes].sum()
    have = [seed_xy[k] for k in seed_ids if k in named and named[k]["area"] == aid]
    k_free = max(0, round(total / T_DISTRICT[area_class(aid)]) - len(have))
    for j, c in enumerate(kmeans_pts(AC[nodes], AA[nodes], have, k_free)):
        a = int(nodes[np.argmin(((AC[nodes] - c) ** 2).sum(1))])
        if a not in seed_atoms:
            seed_atoms.append(a); seed_ids.append("%s~%d" % (aid, j))
lab, seed_atoms = grow(free, seed_atoms, fixed_n)
DIST = {}  # id района → {atoms, area, kind, name, source}
for k, sid in enumerate(seed_ids):
    atoms_k = [free[i] for i in np.where(lab == k)[0]]
    if not atoms_k:
        continue
    if "~" in sid:
        vals = collections.Counter()
        for a in atoms_k:
            vals[HINT[a]] += AA[a]
        DIST[sid] = {"atoms": atoms_k, "area": vals.most_common(1)[0][0], "kind": "", "auto": True, "seed": seed_atoms[k]}
    else:
        s = named[sid]
        DIST[sid] = {"atoms": atoms_k, "area": s["area"], "kind": "rural" if s["city"] == "-" else "", "auto": False,
                     "name": s["name"], "source": s["source"], "seed": seed_atoms[k]}
for fid, info in fixed_info.items():
    atoms_f = list(np.where(ATOM_FIX == fid)[0])
    if atoms_f:
        DIST[fid] = {"atoms": atoms_f, "area": info.get("area"), "kind": info["kind"], "auto": False, "name": info["name"],
                     "source": "airport" if info["kind"] == "airport" else "natural"}
def region_adjacency(atom_label):
    """Соседство регионов по меткам атомов: {регион: {сосед: длина общей границы}}."""
    out = collections.defaultdict(collections.Counter)
    for i, j in pairs:
        a, b = atom_label[i], atom_label[j]
        if a != b:
            out[a][b] += NB[i][j]; out[b][a] += NB[i][j]
    return out


def relabel():
    lab_ = np.empty(NA, dtype=object)
    for d, v in DIST.items():
        for a in v["atoms"]:
            lab_[a] = d
    return lab_


ATOM_D = relabel()
adjD = region_adjacency(ATOM_D)
# автоматический район, зажатый соседями (меньше трети целевой площади), — к соседу той же области
for d in sorted([d for d, v in DIST.items() if v["auto"]], key=lambda d: AA[DIST[d]["atoms"]].sum()):
    v = DIST[d]
    if AA[v["atoms"]].sum() >= T_DISTRICT[area_class(v["area"])] / 3:
        continue
    tally = collections.Counter({o: l for o, l in adjD[d].items() if o in DIST and DIST[o]["area"] == v["area"] and DIST[o]["kind"] in ("", "rural")})
    if tally:
        o = tally.most_common(1)[0][0]
        DIST[o]["atoms"] += v["atoms"]; del DIST[d]
        ATOM_D = relabel(); adjD = region_adjacency(ATOM_D)

# именованный район, зажатый автоматическими соседями (меньше четверти цели), забирает себе самого большого из них
for d in [d for d, v in DIST.items() if not v["auto"] and v["kind"] in ("", "rural")]:
    v = DIST.get(d)
    if not v or AA[v["atoms"]].sum() >= T_DISTRICT[area_class(v["area"])] / 4:
        continue
    tally = collections.Counter({o: l for o, l in adjD[d].items() if o in DIST and DIST[o]["auto"] and DIST[o]["area"] == v["area"]})
    if tally:
        o = tally.most_common(1)[0][0]
        v["atoms"] += DIST[o]["atoms"]; del DIST[o]
        ATOM_D = relabel(); adjD = region_adjacency(ATOM_D)

# ---------------------------------------------------------------- 4. области: сплошные, без анклавов
overrides = collections.defaultdict(dict)
ov_path = pathlib.Path("data/overrides.tsv")
if ov_path.exists():
    for line in ov_path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            c = [x.strip() for x in line.split("\t")]
            if len(c) >= 3:
                overrides[c[0]][c[1]] = c[2]
for d, v in DIST.items():
    if v["area"] is None:  # озеро или парк — в область соседа с самой длинной границей
        tally = collections.Counter()
        for o, l in adjD[d].items():
            if DIST[o]["area"]:
                tally[DIST[o]["area"]] += l
        v["area"] = tally.most_common(1)[0][0] if tally else "dal-center"
for d, a in overrides["area"].items():
    if d in DIST:
        DIST[d]["area"] = a; DIST[d]["pinned"] = True
    else:
        log("ВНИМАНИЕ: overrides.tsv: нет района", d)
for _ in range(10):
    changed = False
    for aid in areas:
        members = [d for d, v in DIST.items() if v["area"] == aid]
        rest = set(members); comps = []
        while rest:
            st = [rest.pop()]; comp = []
            while st:
                q = st.pop(); comp.append(q)
                for o in adjD[q]:
                    if o in rest:
                        rest.remove(o); st.append(o)
            comps.append(comp)
        if len(comps) < 2:
            continue
        comps.sort(key=lambda c: -sum(AA[DIST[q]["atoms"]].sum() for q in c))
        for comp in comps[1:]:
            for q in comp:
                if DIST[q].get("pinned"):
                    continue
                tally = collections.Counter()
                for o, l in adjD[q].items():
                    if DIST[o]["area"] != aid:
                        tally[DIST[o]["area"]] += l
                if tally:
                    DIST[q]["area"] = tally.most_common(1)[0][0]; changed = True
    if not changed:
        break

# ---------------------------------------------------------------- названия районов без своей точки
DIRS = ["восток", "северо-восток", "север", "северо-запад", "запад", "юго-запад", "юг", "юго-восток"]
DIR_ID = dict(zip(DIRS + ["центр"], ["e", "ne", "n", "nw", "w", "sw", "s", "se", "c"]))


def dir_of(p, centre, scale):
    dx, dy = p[0] - centre[0], p[1] - centre[1]
    if math.hypot(dx, dy) < 0.28 * scale:
        return "центр"
    return DIRS[int(((math.degrees(math.atan2(dy, dx)) + 22.5) % 360) // 45)]


def compass_names(cents, centre, scale):
    """Названия по сторонам света; одинаковые различаем «ближний/дальний» или номером."""
    names = {k: dir_of(c, centre, scale) for k, c in cents.items()}
    dist_ = {k: math.hypot(c[0] - centre[0], c[1] - centre[1]) for k, c in cents.items()}
    cs = sorted([k for k, n in names.items() if n == "центр"], key=lambda k: dist_[k])
    for k in cs[1:]:
        c = cents[k]
        names[k] = DIRS[int(((math.degrees(math.atan2(c[1] - centre[1], c[0] - centre[0])) + 22.5) % 360) // 45)]
    by = collections.defaultdict(list)
    for k, n in names.items():
        by[n].append(k)
    for n, ks in by.items():
        if len(ks) < 2:
            continue
        ks.sort(key=lambda k: dist_[k])
        for i, k in enumerate(ks):
            names[k] = (("ближний " if i == 0 else "дальний ") + n) if len(ks) == 2 else n + " " + str(i + 1)
    return names


def code(n):
    p = n.split()
    pre = {"ближний": "1", "дальний": "2"}.get(p[0], "")
    base = p[-1] if pre else p[0]
    return DIR_ID.get(base, "x") + pre + (p[-1] if p[-1].isdigit() else "")


def centroid(atoms_):
    w = AA[atoms_]
    return (AC[atoms_] * w[:, None]).sum(0) / w.sum()


hosts = collections.defaultdict(list)
for d, v in DIST.items():
    if not v["auto"]:
        continue
    c = centroid(v["atoms"])
    cand = [k for k in named if named[k]["area"] == v["area"] and k in DIST] or [k for k in named if k in DIST]
    host = min(cand, key=lambda k: ((seed_xy[k] - c) ** 2).sum())
    hosts[host].append(d)
rename = {}
for host, ds in hosts.items():
    allat = DIST[host]["atoms"] + [a for d in ds for a in DIST[d]["atoms"]]
    nm = compass_names({d: centroid(DIST[d]["atoms"]) for d in ds}, seed_xy[host], math.sqrt(AA[allat].sum()))
    for d in ds:
        n = nm[d] if nm[d] != "центр" else "окрестности"
        DIST[d]["name"] = named[host]["name"] + ", " + n
        DIST[d]["source"] = "auto"
        rename[d] = host + "-" + code(nm[d])
DIST = {rename.get(k, k): v for k, v in DIST.items()}
for d, nm in overrides["name"].items():
    if d in DIST:
        DIST[d]["name"] = nm; DIST[d]["source"] = "override"
ATOM_D = np.empty(NA, dtype=object)
for d, v in DIST.items():
    for a in v["atoms"]:
        ATOM_D[a] = d
adjD = region_adjacency(ATOM_D)
log("районов:", len(DIST))

# ---------------------------------------------------------------- 5. части областей
log("части областей")
def zone_groups(aid, members):
    """Делит связный набор районов одной области на части примерно равной площади, ростом по графу соседства."""
    tot = sum(AA[DIST[d]["atoms"]].sum() for d in members)
    k2 = max(1, min(len(members), round(tot / T_ZONE[area_class(aid)])))
    if k2 == 1:
        groups = {0: members}
    else:
        P = np.array([centroid(DIST[d]["atoms"]) for d in members]); Wd = np.array([AA[DIST[d]["atoms"]].sum() for d in members])
        cs = kmeans_pts(P, Wd, [], k2)
        sd = []
        for c in cs:
            order = np.argsort(((P - c) ** 2).sum(1))
            sd.append(next(int(o) for o in order if int(o) not in sd))
        # рост по графу соседства районов от центров (связность гарантирована)
        pos = {d: k for k, d in enumerate(members)}
        r, cc, w = [], [], []
        for d in members:
            for o in adjD[d]:
                if o in pos:
                    r.append(pos[d]); cc.append(pos[o]); w.append(float(np.hypot(*(P[pos[d]] - P[pos[o]]))))
        M = coo_matrix((w, (r, cc)), shape=(len(members), len(members))).tocsr()
        for it in range(5):
            _, _, src = dijkstra(M, directed=False, indices=sd, min_only=True, return_predecessors=True)
            lab2 = np.array([sd.index(s) if s >= 0 else 0 for s in src])
            new = []
            for j in range(len(sd)):
                mk = np.where(lab2 == j)[0]
                cen = (P[mk] * Wd[mk, None]).sum(0) / Wd[mk].sum()
                b = int(mk[np.argmin(((P[mk] - cen) ** 2).sum(1))])
                new.append(b if b not in new else sd[j])
            if new == sd:
                break
            sd = new
        groups = collections.defaultdict(list)
        for i, d in enumerate(members):
            groups[int(lab2[i])].append(d)
    return groups


ZONE = {}
for aid in areas:
    all_members = [d for d, v in DIST.items() if v["area"] == aid and v["kind"] not in ("water", "green", "airport")]
    # районы, связанные только через озеро или парк, — разные куски; каждый кусок делится отдельно
    rest = set(all_members); pieces = []
    while rest:
        st = [rest.pop()]; comp = []
        while st:
            q = st.pop(); comp.append(q)
            for o in adjD[q]:
                if o in rest:
                    rest.remove(o); st.append(o)
        pieces.append(comp)
    groups = {}
    for members in pieces:
        groups.update({len(groups) + j: g for j, g in zone_groups(aid, members).items()})
    if not groups:
        continue
    members = all_members
    allat = [a for d in members for a in DIST[d]["atoms"]]
    cz = centroid(allat)
    nmd = compass_names({j: centroid([a for d in ds for a in DIST[d]["atoms"]]) for j, ds in groups.items()}, cz, math.sqrt(AA[allat].sum()))
    for j, ds in groups.items():
        big = sorted([d for d in ds if not DIST[d]["auto"]], key=lambda d: -AA[DIST[d]["atoms"]].sum())
        if len(groups) == 1:
            nm = areas[aid]
        elif len(big) >= 2:
            nm = DIST[big[0]]["name"] + " и " + DIST[big[1]]["name"]
        elif len(big) == 1:
            nm = DIST[big[0]]["name"] + " и окрестности"
        else:
            nm = areas[aid] + ", " + nmd[j]
        zid = aid if len(groups) == 1 else aid + "." + code(nmd[j])
        ZONE[zid] = {"area": aid, "name": nm, "members": ds}
        for d in ds:
            DIST[d]["zone"] = zid


for d, v in DIST.items():
    if "zone" not in v:  # озёра, парки, аэропорты — сами себе часть области
        ZONE[d] = {"area": v["area"], "name": v["name"], "members": [d], "kind": v["kind"]}
        v["zone"] = d
log("частей областей:", len(ZONE))

# ---------------------------------------------------------------- 6. секторы
log("секторы")
seeds3 = collections.defaultdict(list)
for s in read_seeds3():
    seeds3[s["parent"]].append(s)
SECT = {}
for d, v in DIST.items():
    at = v["atoms"]
    if v["kind"] in ("water", "green", "airport"):
        SECT[d] = {"atoms": at, "name": v["name"], "parent": d}; continue
    manual = []
    for s in seeds3.get(d, []):
        _, a = cKDTree(AC[at]).query(fwd(s["lon"], s["lat"]))
        if at[a] not in [m[1] for m in manual]:
            manual.append((s, at[a]))
    k = len(manual) if manual else max(1, min(len(at) // 2, round(AA[at].sum() / T_SECTOR[area_class(v["area"])])))
    if k <= 1:
        SECT[d] = {"atoms": at, "name": v["name"], "parent": d}; continue
    if manual:
        sp = [m[1] for m in manual]; fixed_k = len(sp)
    else:
        sp = []
        for c in kmeans_pts(AC[at], AA[at], [], k):
            order = np.argsort(((AC[at] - c) ** 2).sum(1))
            sp.append(next(at[o] for o in order if at[o] not in sp))
        fixed_k = 0
    lab3, _ = grow(at, sp, fixed_k, iters=3)
    parts = {j: [at[i] for i in np.where(lab3 == j)[0]] for j in range(len(sp))}
    parts = {j: p for j, p in parts.items() if p}
    if manual:
        for j, p in parts.items():
            SECT[manual[j][0]["id"]] = {"atoms": p, "name": manual[j][0]["name"], "parent": d}
    else:
        nm = compass_names({j: centroid(p) for j, p in parts.items()}, centroid(at), math.sqrt(AA[at].sum()))
        for j, p in parts.items():
            SECT[d + "." + code(nm[j])] = {"atoms": p, "name": v["name"] + " — " + nm[j], "parent": d}
for p, ss in seeds3.items():
    for sd in ss:
        if sd["id"] not in SECT:
            log("ВНИМАНИЕ: ручной сектор %s (район %s) не применился" % (sd["id"], p))
log("секторов:", len(SECT))

# ---------------------------------------------------------------- 7. геометрия: секторы → упрощённое покрытие → всё остальное
log("геометрия")
sids = list(SECT)
raw = [unary_union([AP[a] for a in SECT[s]["atoms"]]) for s in sids]
smooth = shapely.coverage_simplify(raw, SMOOTH, simplify_boundary=False)
for s, g in zip(sids, smooth):
    SECT[s]["geom"] = g if g.is_valid else g.buffer(0)
for d, v in DIST.items():
    v["geom"] = unary_union([SECT[s]["geom"] for s in sids if SECT[s]["parent"] == d])
for z, v in ZONE.items():
    v["geom"] = unary_union([DIST[d]["geom"] for d in v["members"]])
A = {aid: {"geom": unary_union([v["geom"] for v in DIST.values() if v["area"] == aid]), "name": areas[aid]}
     for aid in areas if any(v["area"] == aid for v in DIST.values())}
l1_geom = {a: v["geom"] for a, v in A.items()}
D, Z, S = DIST, ZONE, SECT  # короткие имена для выгрузки ниже

# ---------------------------------------------------------------- проверки
log("проверки")
errors, warns = [], []
fixed_union = unary_union([D[d]["geom"] for d in D if D[d]["kind"] in ("water", "green", "airport")])


def check_level(name, items, parent_of=None, parents=None):
    geoms = [v["geom"] for v in items.values()]
    if not shapely.coverage_is_valid(geoms):
        errors.append("%s: наложения или щели между регионами" % name)
    if abs(unary_union(geoms).area - FRAME.area) > 0.01:
        errors.append("%s: покрыто %.2f км² из %.2f" % (name, unary_union(geoms).area, FRAME.area))
    for k, v in items.items():
        g = v["geom"]
        if g.geom_type != "Polygon":
            errors.append("%s %s («%s»): %d кусков" % (name, k, v["name"], len(getattr(g, "geoms", [g]))))
            continue
        for ring in g.interiors:
            hole = Polygon(ring)
            if hole.intersection(fixed_union).area < 0.9 * hole.area:
                errors.append("%s %s («%s»): дыра %.2f км² не из озёр и парков" % (name, k, v["name"], hole.area))
        if parent_of:
            par = parents[parent_of(k)]["geom"]
            if g.difference(par.buffer(1e-6)).area > 1e-4:
                errors.append("%s %s вылезает из родителя" % (name, k))


check_level("сектор", S, lambda k: S[k]["parent"], D)
check_level("район", D, lambda k: D[k]["zone"], Z)
check_level("часть области", Z, lambda k: Z[k]["area"], A)
check_level("область", A)
adjA = collections.defaultdict(set)
for i, j in pairs:
    a, b = D[ATOM_D[i]]["area"], D[ATOM_D[j]]["area"]
    if a != b:
        adjA[a].add(b); adjA[b].add(a)
for aid, v in A.items():
    touches_edge = v["geom"].boundary.intersection(FRAME.boundary).length > 0
    if len(adjA[aid]) == 1 and not touches_edge:
        errors.append("область %s — анклав внутри %s" % (aid, list(adjA[aid])[0]))
for d, v in D.items():
    if v["kind"] in ("water", "green", "airport"):
        continue
    g = v["geom"]
    pp = 4 * math.pi * g.area / (g.length ** 2)
    if pp < 0.2:
        errors.append("район %s («%s»): слишком вытянутый или изрезанный (компактность %.2f)" % (d, v["name"], pp))
    t = T_DISTRICT[area_class(v["area"])]
    if not 0.25 * t <= g.area <= 4 * t:
        warns.append("район %s («%s»): %.1f км² при цели %d" % (d, v["name"], g.area, t))
for k in named:
    if k in D and not D[k]["geom"].contains(Point(seed_xy[k])) and not fixed_union.contains(Point(seed_xy[k])):
        warns.append("точка района %s лежит не в нём" % k)
for w in warns:
    log("предупреждение:", w)
for e in errors:
    log("ОШИБКА:", e)
if errors and not FORCE:
    sys.exit("проверки не прошли (%d), карта не записана; для отладки: python tools/build.py --force" % len(errors))

# ---------------------------------------------------------------- выгрузка
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
    return polylabel(big, prec)


labels, out, review = [], {"l1": [], "l2": [], "l3": [], "l4": []}, []


def emit(level, file, rid, g, props, prec, source=""):
    props = dict(id=rid, km2=round(g.area, 1), **props)
    out[file].append(feature(g, props, 0))
    lp = label_point(g, prec)
    lon, lat = inv(lp.x, lp.y)
    labels.append({"type": "Feature", "properties": {"id": rid, "name": props["name"], "km2": props["km2"], "level": level, "kind": props.get("kind", "")},
                   "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}})
    review.append({"level": level, "id": rid, "name": props["name"], "parent": props.get("parent") or props.get("zone") or props.get("area") or "",
                   "km2": props["km2"], "source": source, "lat": round(lat, 5), "lon": round(lon, 5)})


for aid, v in A.items():
    emit(1, "l1", aid, v["geom"], {"name": v["name"], "tone": tone[aid]}, 0.05, "список областей")
for zid, v in Z.items():
    emit(2, "l2", zid, v["geom"], {"name": v["name"], "area": v["area"], "kind": v.get("kind", ""), "tone": tone.get(v["area"], 0), "shade": shadeZ[zid]}, 0.03,
         "по районам внутри" if not v.get("kind") else "озеро, парк или аэропорт")
for did, d in D.items():
    emit(3, "l3", did, d["geom"], {"name": d["name"], "area": d["area"], "zone": d["zone"], "kind": d["kind"], "tone": tone.get(d["area"], 0), "shade": shadeD[did]}, 0.02,
         {"seed": "опорная точка", "city": "город", "auto": "автоматически", "natural": "озеро или парк", "airport": "аэропорт", "override": "ручная правка"}.get(d.get("source", ""), ""))
for sid, s in S.items():
    p = D[s["parent"]]
    emit(4, "l4", sid, s["geom"], {"name": s["name"], "parent": s["parent"], "area": p["area"], "kind": p["kind"], "tone": tone.get(p["area"], 0), "shade": shadeS[sid]}, 0.01,
         "ручная точка" if sid in {x["id"] for xs in seeds3.values() for x in xs} else "автоматически")
for f in ("l1", "l2", "l3", "l4"):
    write(f, out[f])
write("labels", labels)
(OUT / "review.json").write_text(json.dumps(review, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


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
