"""Собирает геометрию карты из сырых данных data/raw/ в data/geo/*.geojson.

Запуск из корня репозитория: python tools/build.py   (сначала python tools/fetch.py)

Что делает:
1. Подложка: дороги, вода, железные дороги, парки. Всё, что появилось после 2005 года и известно нам,
   вырезается (списки ANACHRONISM_*).
2. Регионы — дерево из data/tree.tsv (docs/TREE.md): карта режется на мелкие атомы, дети делят землю
   родителя — города, аэродромы и знаковые места по готовым контурам, остальное растёт от опорных точек
   по графу соседства атомов. Границы сглаживаются один раз на листьях, всё выше — их объединения.
   Озёра и парки (data/natural.tsv) — отдельный слой поверх дерева.

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
from seeds import read_natural, read_tree
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

# ---------------------------------------------------------------- природный слой
# Озёра, леса и большие парки (data/natural.tsv) — отдельный слой поверх дерева: виден и кликается всегда.
log("природный слой")
natural = read_natural()
water_polys = area_polys(water_el, lambda t: t.get("natural") == "water")
green_polys = area_polys(osm("green"))
landmark_polys = area_polys(osm("landmarks"))


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
    """Простая гладкая форма: закругляем рваный край, убираем острова и мелочь."""
    g = g.buffer(r, 4).buffer(-2 * r, 4).buffer(r, 4)
    g = drop_small(fill_holes(g, 3.0), min_part)
    return drop_small(g.simplify(tol).buffer(0), min_part)


NATURE, taken = {}, Polygon()
for n in natural:
    parts = [g for g, t in water_polys + green_polys if t.get("name") in n["names"]]
    if not parts:
        log("ВНИМАНИЕ: не найден природный регион", n["id"], n["names"]); continue
    g = drop_small(smooth_simple(unary_union(parts).intersection(FRAME), 0.15, 0.08, 0.15).difference(taken).buffer(0), 0.15)
    if not g.is_empty:
        NATURE[n["id"]] = {"geom": g, "name": n["name"], "kind": n["kind"]}; taken = taken.union(g)

# ================================================================ ДЕРЕВО РЕГИОНОВ (docs/TREE.md, docs/REGIONS.md)
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

FORCE = "--force" in sys.argv  # записать результат, даже если проверки не прошли (для отладки)
SMOOTH = 0.6  # доля размера атома: насколько упрощать границы перед скруглением
errors, warns = [], []

T = read_tree()
KIDS = collections.defaultdict(list)
for k, v in T.items():
    if v["parent"] is not None and v["parent"] not in T:
        sys.exit("tree.tsv: у %s нет родителя %s" % (k, v["parent"]))
    KIDS[v["parent"]].append(k)
for k, ks in KIDS.items():
    if len(ks) < 3:
        errors.append("у %s всего %d ребёнка: нужно 0 или от трёх" % (k or "верхнего уровня", len(ks)))
ROOTS = KIDS[None]


def depth(k):
    return 0 if T[k]["parent"] is None else 1 + depth(T[k]["parent"])


def top_of(k):
    while T[k]["parent"] is not None:
        k = T[k]["parent"]
    return k


def subtree(k):
    out = [k]
    for c in KIDS.get(k, []):
        out += subtree(c)
    return out


# готовые контуры: город, аэродром, знаковое место. Сила: знаковое место > аэродром > город.
log("контуры городов, аэродромов и знаковых мест")
SHAPE, STRENGTH = {}, {}
for k, v in T.items():
    kind = v["kind"]
    if kind.startswith("city:"):
        c = kind[5:]
        if c not in cities:
            sys.exit("tree.tsv: %s — нет города «%s» в переписи" % (k, c))
        SHAPE[k] = cities[c]; STRENGTH[k] = 1
    elif kind.startswith("aero:"):
        key = kind[5:].lower()
        cand = [g for g, t in aero if key in t.get("name", "").lower()]
        if not cand:
            sys.exit("tree.tsv: %s — не найден аэродром «%s»" % (k, key))
        SHAPE[k] = smooth_simple(max(cand, key=lambda g: g.area).intersection(FRAME), 0.2, 0.1, 0.3); STRENGTH[k] = 2
    elif kind.startswith("osm:"):
        names = kind[4:].split("|")
        cand = [g for g, t in landmark_polys + green_polys if t.get("name") in names]
        if not cand:
            sys.exit("tree.tsv: %s — не найден контур OSM %s" % (k, names))
        SHAPE[k] = unary_union(cand).buffer(0.05).buffer(-0.05).intersection(FRAME); STRENGTH[k] = 3
    elif kind not in ("", "group", "place"):
        sys.exit("tree.tsv: %s — непонятный вид «%s»" % (k, kind))
# точки: свои, а у готового контура без точек — середина контура
PTS = {}
for k, v in T.items():
    p = [np.array(fwd(lon, lat)) for lat, lon in v["pts"]]
    if not p and k in SHAPE:
        lp = polylabel(max(getattr(SHAPE[k], "geoms", [SHAPE[k]]), key=lambda q: q.area), 0.05)
        p = [np.array([lp.x, lp.y])]
    PTS[k] = p
    if not p and not KIDS.get(k):
        sys.exit("tree.tsv: у листа %s нет ни точек, ни контура" % k)

# ---------------------------------------------------------------- 1. атомы
# Плотность атомов — от густоты листьев: где листья мелкие (центр Далласа), атомы мельче.
log("атомы")
LEAVES = [k for k in T if not KIDS.get(k)]
LP = np.array([p for k in LEAVES for p in PTS[k]])
STEP = 0.1
x0, y0, x1, y1 = FRAME.bounds
GX, GY = np.meshgrid(np.arange(x0 + STEP / 2, x1, STEP), np.arange(y0 + STEP / 2, y1, STEP))
GX, GY = GX.ravel(), GY.ravel()
G = np.column_stack([GX, GY])
r4 = cKDTree(LP).query(G, k=4)[0][:, -1]
T_ATOM = np.clip(math.pi * r4 ** 2 / 4 / 20, 0.05, 2.0)
GW = 1.0 / T_ATOM
rng = np.random.default_rng(11)
n_atoms = int(round((GW * STEP * STEP).sum()))
pick = rng.choice(len(GX), n_atoms, replace=False, p=GW / GW.sum())
APTS = G[pick] + rng.uniform(-STEP / 2, STEP / 2, (n_atoms, 2))
for _ in range(10):  # Ллойд с весом плотности: атомы становятся ровнее
    _, own_ = cKDTree(APTS).query(G)
    sw = np.bincount(own_, weights=GW, minlength=n_atoms)
    sx = np.bincount(own_, weights=GW * GX, minlength=n_atoms)
    sy = np.bincount(own_, weights=GW * GY, minlength=n_atoms)
    ok = sw > 0
    APTS[ok] = np.column_stack([sx[ok] / sw[ok], sy[ok] / sw[ok]])
vor = voronoi_polygons(MultiPoint([Point(p) for p in APTS]), extend_to=FRAME, ordered=True)
AP = [c.intersection(FRAME) for c in vor.geoms]
AP = [max(getattr(c, "geoms", [c]), key=lambda q: q.area) if c.geom_type != "Polygon" else c for c in AP]
NA = len(AP)
AA = np.array([p.area for p in AP])
AC = np.array([[p.centroid.x, p.centroid.y] for p in AP])
log("атомов:", NA, "площадь от %.2f до %.2f км²" % (AA.min(), AA.max()))

# кому принадлежит атом по готовым контурам
CLAIM = np.full(NA, None, dtype=object); CLAIM_S = np.zeros(NA, dtype=int)
atree = STRtree(AP)
for k, g in SHAPE.items():
    s = STRENGTH[k]
    if s == 1:  # город — по центру атома
        hit = np.where(shapely.contains_xy(g, AC[:, 0], AC[:, 1]))[0]
    else:
        hit, best, bestv = [], None, 0
        for i in atree.query(g):
            v = AP[i].intersection(g).area
            if v > 0.5 * AA[i]:
                hit.append(i)
            if v > bestv:
                best, bestv = i, v
        if not hit and best is not None and bestv > 0.2 * AA[best]:
            hit = [best]
        if not hit:
            errors.append("%s: контур слишком мелкий для атомов" % k)
    for i in hit:
        if s > CLAIM_S[i]:
            CLAIM[i] = k; CLAIM_S[i] = s

# соседство атомов и цена перехода
pairs = set()
for i, p in enumerate(AP):
    for j in atree.query(p.buffer(1e-6)):
        if j > i and p.boundary.intersection(AP[j].boundary).length > 1e-4:
            pairs.add((i, j))
pairs = sorted(pairs)
in_lake = shapely.contains_xy(lakes, AC[:, 0], AC[:, 1])
barriers = [(STRtree(roads["motorway"] + roads["trunk"]), roads["motorway"] + roads["trunk"], 4.0),
            (STRtree(river_main), river_main, 6.0), (STRtree(rail), rail, 2.0)]
city_of = np.full(NA, -1)
for ci, c in enumerate(cities):
    city_of[shapely.contains_xy(cities[c], AC[:, 0], AC[:, 1]) & (city_of < 0)] = ci
EI, EJ, EW = [], [], []
NB = [dict() for _ in range(NA)]
for i, j in pairs:
    l = AP[i].boundary.intersection(AP[j].boundary).length
    NB[i][j] = l; NB[j][i] = l
    seg = LineString([AC[i], AC[j]])
    w = float(np.hypot(*(AC[i] - AC[j])))
    for tree, lines, f in barriers:
        if any(lines[k].intersects(seg) for k in tree.query(seg)):
            w *= f
    if in_lake[i] != in_lake[j]:
        w *= 3.0
    if city_of[i] != city_of[j]:
        w *= 1.5
    EI.append(i); EJ.append(j); EW.append(w)
EI, EJ, EW = np.array(EI), np.array(EJ), np.array(EW)
log("рёбер:", len(EI))


def graph(nodes):
    """Разреженная матрица графа на подмножестве атомов (индексы — позиции в nodes)."""
    pos = {a: k for k, a in enumerate(nodes)}
    m = np.array([(a in pos) and (b in pos) for a, b in zip(EI, EJ)], dtype=bool)
    r = np.array([pos[a] for a in EI[m]]); c = np.array([pos[b] for b in EJ[m]])
    return coo_matrix((EW[m], (r, c)), shape=(len(nodes), len(nodes))).tocsr(), pos


def components(atoms_):
    rest = set(atoms_); out = []
    while rest:
        st = [rest.pop()]; comp = []
        while st:
            q = st.pop(); comp.append(q)
            for o in NB[q]:
                if o in rest:
                    rest.remove(o); st.append(o)
        out.append(comp)
    return sorted(out, key=lambda c: -AA[c].sum())


# ---------------------------------------------------------------- 2. нарезка сверху вниз
# Дети делят землю родителя: готовые контуры (свои и потомков) закреплены, остальное растёт от точек по графу.
log("нарезка")
SUB = {k: subtree(k) for k in T}
ATOMS = {}


# Знаковые места по точке («place»: отель, торговый квартал, сад) не расползаются: дальше PLACE_R км от точки
# (по прямой, барьеры не считаются) земля уходит соседям. Так здание остаётся маленьким регионом, а не забирает полрайона. Места с контуром OSM растут
# как обычные районы: вокруг больницы или кампуса обычно нет другого имени, и земля достаётся им.
# Если место при этом оказалось анклавом внутри одного соседа, предел для него удваивается, пока не перестанет.
PLACE_R = 0.6
PLACE = {k for k, v in T.items() if not KIDS.get(k) and v["kind"] == "place"}


def split(parent, atoms_):
    kids = KIDS.get(parent, [])
    if not kids:
        return
    S = set(atoms_)
    lab = {}
    for a in atoms_:
        c = CLAIM[a]
        if c is not None:
            for k in kids:
                if c in SUB[k]:
                    lab[a] = k; break
    nodes = list(atoms_)
    M, pos = graph(nodes)
    ctree = cKDTree(AC[nodes])
    src, src_kid = [], []
    for a, k in lab.items():
        src.append(pos[a]); src_kid.append(k)
    for k in kids:
        for d in SUB[k]:
            for p in PTS[d]:
                _, cand = ctree.query(p, k=min(12, len(nodes)))
                a = next((nodes[c] for c in np.atleast_1d(cand) if lab.get(nodes[c], k) == k), None)
                if a is None:
                    warns.append("точка %s не легла в землю %s" % (d, parent or "карты")); continue
                src.append(pos[a]); src_kid.append(k)
    if not src:
        errors.append("%s: нет ни точек, ни контуров у детей" % parent); return
    srcu, first = np.unique(src, return_index=True)
    kid_of_src = {s: src_kid[f] for s, f in zip(srcu, first)}
    dist, _, owner0 = dijkstra(M, directed=False, indices=list(srcu), min_only=True, return_predecessors=True)
    owner = owner0
    other = [x for x in srcu if kid_of_src[x] not in PLACE]
    places = [k for k in kids if k in PLACE]
    if places and other:
        _, _, owner2 = dijkstra(M, directed=False, indices=other, min_only=True, return_predecessors=True)
        rlim = {k: PLACE_R for k in places}
        for _ in range(6):
            owner = owner0.copy()
            for i, o in enumerate(owner0):
                k = kid_of_src[o] if o >= 0 else None
                if k in rlim and np.min(np.hypot(*(AC[nodes[i]] - np.array(PTS[k])).T)) > rlim[k] and nodes[i] not in lab and owner2[i] >= 0:
                    owner[i] = owner2[i]
            enclaved = []
            for k in places:
                mine = {nodes[i] for i, o in enumerate(owner) if o >= 0 and kid_of_src[o] == k}
                around = collections.Counter()  # длина общей границы с каждым соседом (None — край родителя)
                for a in mine:
                    for q, l in NB[a].items():
                        if q not in mine:
                            around[kid_of_src.get(owner[pos[q]]) if q in S else None] += l
                second = sorted(around.values())[-2] if len(around) > 1 else 0
                if second < 0.3 and rlim[k] < 50:  # короткий стык со вторым соседом сгладится — всё равно анклав
                    enclaved.append(k)
            if not enclaved:
                break
            for k in enclaved:
                rlim[k] *= 2
    res = {}
    for i, o in enumerate(owner):
        if o >= 0:
            res[nodes[i]] = kid_of_src[o]
    for a in nodes:  # недостижимое (остров) — к ближайшему по прямой
        if a not in res:
            _, j = cKDTree(AC[list(res)]).query(AC[a]); res[a] = res[list(res)[j]]
    # каждый ребёнок — один кусок; оторванные куски отдаём соседу с самой длинной общей границей
    for _ in range(20):
        changed = False
        for k in kids:
            mine = [a for a in nodes if res[a] == k]
            comps = components(mine)
            for comp in comps[1:]:
                tally = collections.Counter()
                cs = set(comp)
                for q in comp:
                    for o, l in NB[q].items():
                        if o in S and o not in cs and res[o] != k:
                            tally[res[o]] += l
                if tally:
                    nk = tally.most_common(1)[0][0]
                    claimed = {CLAIM[q] for q in comp if CLAIM[q] in SUB[k]}
                    if claimed or AA[comp].sum() > 3:
                        warns.append("оторванный кусок %s (%.1f км²%s) отдан %s" % (k, AA[comp].sum(), ", " + ", ".join(sorted(claimed)) if claimed else "", nk))
                    for q in comp:
                        res[q] = nk
                    changed = True
        if not changed:
            break
    for k in kids:
        ATOMS[k] = [a for a in nodes if res[a] == k]
        if not ATOMS[k]:
            errors.append("%s («%s») не получил земли" % (k, T[k]["name"])); continue
        split(k, ATOMS[k])


ATOMS[None] = list(range(NA))
split(None, ATOMS[None])
log("узлов:", len(ATOMS) - 1, "листьев:", sum(1 for k in LEAVES if ATOMS.get(k)))

# ---------------------------------------------------------------- 3. геометрия: листья → сглаженное покрытие → всё остальное
def chaikin(c, n):
    for _ in range(n):
        q = c[:-1] * 0.75 + c[1:] * 0.25
        r = c[:-1] * 0.25 + c[1:] * 0.75
        c = np.vstack([c[:1], np.column_stack([q, r]).reshape(-1, 2), c[-1:]])
    return c


def smooth_coverage(polys):
    """Сглаживает общие границы покрытия: каждая граница между двумя соседями (от узла до узла) упрощается
    с допуском по местному размеру атомов и скругляется (Чайкин); концы границ не двигаются, поэтому
    соседи остаются без щелей. Потом грани собираются заново и раздаются исходным регионам."""
    merged = shapely.line_merge(unary_union([p.boundary for p in polys]))
    ctree = cKDTree(AC)
    edges = []
    for e in getattr(merged, "geoms", [merged]):
        m = e.interpolate(0.5, normalized=True)
        tol = SMOOTH * math.sqrt(AA[ctree.query([m.x, m.y], k=4)[1]].mean())
        if e.boundary.intersects(FRAME.boundary) and e.within(FRAME.boundary.buffer(1e-6)):
            edges.append(e); continue
        c = np.array(e.simplify(tol).coords)
        if e.is_ring:
            edges.append(LineString(c)); continue
        edges.append(LineString(chaikin(c, 3)))
    faces = list(polygonize(unary_union(edges)))
    own = collections.defaultdict(list)
    ptree = STRtree(polys)
    for f in faces:
        best, bv = None, 0
        for i in ptree.query(f):
            v = polys[i].intersection(f).area
            if v > bv:
                best, bv = i, v
        if best is not None:
            own[best].append(f)
    out = []
    for i, p in enumerate(polys):
        g = unary_union(own[i]) if own[i] else p
        out.append(g if g.is_valid else g.buffer(0))
    return out



log("геометрия")
leaf_ids = [k for k in LEAVES if ATOMS.get(k)]
raw = [unary_union([AP[a] for a in ATOMS[k]]) for k in leaf_ids]
GEOM = dict(zip(leaf_ids, smooth_coverage(raw)))


def build_geom(k):
    if k not in GEOM:
        GEOM[k] = unary_union([build_geom(c) for c in KIDS[k] if ATOMS.get(c)])
    return GEOM[k]


for k in ROOTS:
    build_geom(k)
l1_geom = {k: GEOM[k] for k in ROOTS if k in GEOM}

# ---------------------------------------------------------------- проверки
log("проверки")
if not shapely.coverage_is_valid([GEOM[k] for k in leaf_ids]):
    errors.append("листья: наложения или щели")
if abs(unary_union([GEOM[k] for k in ROOTS if k in GEOM]).area - FRAME.area) > 0.01:
    errors.append("верхний уровень покрывает не всю карту")
for k in T:
    if k not in GEOM:
        continue
    g = GEOM[k]
    if g.geom_type != "Polygon":
        errors.append("%s («%s»): %d кусков" % (k, T[k]["name"], len(getattr(g, "geoms", [g]))))
        continue
    for ring in g.interiors:
        hole = Polygon(ring)
        inside = sorted({j for j in LEAVES if j in GEOM and GEOM[j].intersection(hole).area > 0.5 * GEOM[j].area})
        errors.append("%s («%s»): дыра %.2f км², внутри %s" % (k, T[k]["name"], hole.area, ", ".join(inside)))
    if not KIDS.get(k):
        pp = 4 * math.pi * g.area / (g.length ** 2)
        if pp < 0.2 and k not in SHAPE:
            warns.append("%s («%s»): вытянутый или изрезанный (компактность %.2f)" % (k, T[k]["name"], pp))
    for p in PTS[k] if T[k]["pts"] else []:
        if not g.buffer(0.05).contains(Point(p)):
            warns.append("точка %s лежит не в нём" % k)
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
shade = colour({k: GEOM[k] for k in GEOM if T[k]["parent"] is not None}, 3, lambda k: T[k]["parent"])


def label_point(g, prec):
    big = max(getattr(g, "geoms", [g]), key=lambda p: p.area)
    lp = polylabel(big, prec)
    return inv(lp.x, lp.y)


def kind_of(k):
    """city, aero, osm, place (знаковое место по точке), group (объединение городков) или пусто (часть города или район)."""
    v = T[k]["kind"]
    return v.split(":")[0] if v else ""


SOURCE = {"city": "город по переписи 2000", "aero": "аэродром (OSM)", "osm": "контур места (OSM)", "place": "знаковое место (точка)", "group": "объединение детей", "": "опорная точка"}
TREE_OUT = OUT / "tree"
TREE_OUT.mkdir(parents=True, exist_ok=True)
for f in TREE_OUT.glob("*.geojson"):
    f.unlink()
index, review = [], []
for parent, ks in KIDS.items():
    feats = []
    for k in ks:
        if k not in GEOM:
            continue
        g = GEOM[k]
        lon, lat = label_point(g, 0.01 if depth(k) else 0.05)
        b = unproj(g).bounds
        n = sum(1 for c in KIDS.get(k, []) if c in GEOM)
        props = {"id": k, "name": T[k]["name"], "kind": kind_of(k), "n": n, "tone": tone[top_of(k)], "shade": shade.get(k, 0),
                 "lx": round(lon, 5), "ly": round(lat, 5), "km2": round(g.area, 1)}
        feats.append(feature(g, props, 0))
        index.append({"id": k, "parent": parent or "", "name": T[k]["name"], "kind": kind_of(k), "n": n, "depth": depth(k),
                      "lx": round(lon, 5), "ly": round(lat, 5), "bbox": [round(x, 4) for x in b], "km2": round(g.area, 1)})
        review.append({"level": depth(k) + 1, "id": k, "name": T[k]["name"], "parent": parent or "", "km2": round(g.area, 1),
                       "source": SOURCE["group" if KIDS.get(k) and not T[k]["kind"] else kind_of(k)], "lat": round(lat, 5), "lon": round(lon, 5)})
    write("tree/" + (parent or "_root"), feats)
(TREE_OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(OUT / "review.json").write_text(json.dumps(review, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
nat = []
for k, v in NATURE.items():
    lon, lat = label_point(v["geom"], 0.02)
    nat.append(feature(v["geom"], {"id": k, "name": v["name"], "kind": v["kind"], "km2": round(v["geom"].area, 1), "lx": round(lon, 5), "ly": round(lat, 5)}, 0))
write("nature", nat)

# старые ссылки и пометки (карта в четыре масштаба и карта в клетку) → узел дерева по точке
LEGACY = pathlib.Path("data/legacy/review-v4.json")
leaf_tree = STRtree([GEOM[k] for k in leaf_ids])


def node_at(lon, lat):
    pt = Point(fwd(lon, lat))
    hit = [leaf_ids[i] for i in leaf_tree.query(pt) if GEOM[leaf_ids[i]].contains(pt)]
    return hit[0] if hit else None


aliases = {}
if LEGACY.exists():
    for r in json.loads(LEGACY.read_text(encoding="utf-8")):
        key = "azds"[r["level"] - 1] + ":" + r["id"]
        if r["id"] in GEOM:
            aliases[key] = r["id"]; continue
        k = node_at(r["lon"], r["lat"])
        if k and r["level"] == 1:  # старая область — верхний узел дерева
            k = top_of(k)
        if k:
            aliases[key] = k
GRIDS = {"city": (9, 9, 33.02, 32.62, -96.99, -96.55), "core": (8, 8, 32.842222, 32.753333, -96.843333, -96.745556), "fw": (9, 9, 33.00, 32.60, -97.55, -97.11)}
for b, (nc, nr, n_, s_, w_, e_) in GRIDS.items():
    for c in range(nc):
        for r in range(nr):
            k = node_at(w_ + (c + .5) * (e_ - w_) / nc, n_ - (r + .5) * (n_ - s_) / nr)
            if k:
                aliases[b + ":" + "ABCDEFGHI"[c] + str(r + 1)] = k
# старые районы, которые теперь стали частью города целиком
aliases.update({k: v for k, v in {"d:medical": "dal-medical", "d:downtown": "dal-downtown", "d:oaklawn": "dal-oaklawn",
                                   "d:lakehighlands": "dal-lakehighlands", "s:anatole": "anatole"}.items() if v in GEOM})
(TREE_OUT / "aliases.json").write_text(json.dumps(aliases, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


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

def tree_lines(k, ind):
    out = ["%s%s\t%s\t%s\t%.1f км²" % ("  " * ind, k, T[k]["name"], T[k]["kind"] or "-", GEOM[k].area)] if k in GEOM else []
    for c in KIDS.get(k, []):
        out += tree_lines(c, ind + 1)
    return out


(OUT / "regions.txt").write_text("\n".join(l for r in ROOTS for l in tree_lines(r, 0)) + "\n", encoding="utf-8")
log("готово: узлов", len(GEOM), "верхнего уровня", len(l1_geom), "листьев", len(leaf_ids))
