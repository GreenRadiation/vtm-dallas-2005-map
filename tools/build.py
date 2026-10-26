"""Собирает геометрию карты из сырых данных data/raw/ в data/geo/*.geojson.

Запуск из корня репозитория: python tools/build.py   (сначала python tools/fetch.py)

Что делает:
1. Подложка: дороги, вода, железные дороги, парки, городская черта 2000 года. Всё, что появилось
   после 2005 года и известно нам, вырезается (списки ANACHRONISM_*).
2. Районы: территория режется крупными дорогами, рекой и железной дорогой на куски. Каждый кусок
   достаётся ближайшей опорной точке района из data/seeds.tsv в том же городе. Город без своих районов
   становится одним районом. Мелкие куски на развязках прилипают к соседям, пригородная территория
   вне городов — к ближайшему району через соседей.
3. Области (крупный масштаб) = объединение их районов.

Геометрия считается в плоских километрах вокруг центра карты, на выходе снова широта и долгота.
"""
import warnings; warnings.filterwarnings("ignore", category=DeprecationWarning)
import json, math, pathlib, re, sys, collections, time
import shapefile
from shapely.geometry import (LineString, MultiLineString, Polygon, MultiPolygon, Point, box, shape, mapping)
from shapely.ops import unary_union, polygonize, linemerge, transform, polylabel
from shapely import STRtree, voronoi_polygons
from shapely.geometry import MultiPoint
from seeds import read_areas, read_cities, read_seeds
from build_common import fwd, proj, unproj

T0 = time.time()
RAW = pathlib.Path("data/raw")
OUT = pathlib.Path("data/geo")
S, W, N, E = 32.58, -97.55, 33.08, -96.50

FRAME = box(*fwd(W, S), *fwd(E, N))

# Что появилось после марта 2005 года. Сверяется по name/ref дорог и названиям парков.
# Экспресс-полосы TEXpress и «Express» на I-35E, I-635, Loop 12, SH 183, US 67 построены в 2010-х.
ANACHRONISM_ROADS = re.compile(r"Margaret Hunt Hill|Chisholm Trail Parkway|Klyde Warren|Panther Island|TEXpress|\bExpress\b", re.I)
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
missing = [c for c in cities if c not in cities_tsv]
if missing:
    log("ВНИМАНИЕ: нет в cities.tsv:", missing)

# ---------------------------------------------------------------- дороги
log("дороги")
roads = {"motorway": [], "trunk": [], "primary": [], "secondary": []}
road_refs = []
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
    if t["highway"] in ("motorway", "trunk") and t.get("ref"):
        road_refs.append((ln, t["ref"]))
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

# ---------------------------------------------------------------- нарезка на куски
seeds = read_seeds()
areas = read_areas()
aero_seed = {}  # id района → полигон аэродрома
for s in seeds:
    if s["city"].startswith("@aero:"):
        key = s["city"][6:].lower()
        cand = [g for g, t in aero if key in t.get("name", "").lower()]
        if not cand:
            sys.exit("не найден аэродром для " + s["id"] + ": " + key)
        aero_seed[s["id"]] = max(cand, key=lambda g: g.area).intersection(FRAME)

log("куски")
cut = roads["motorway"] + roads["trunk"] + roads["primary"] + rail + river_main + [FRAME.exterior]
cut += [g.exterior for a in aero_seed.values() for g in getattr(a, "geoms", [a])]
cut += [g.exterior for g in getattr(lakes, "geoms", [lakes]) if g.area > 1.0]
# городская черта 2000 года — тоже линия разреза: районы разных городов не смешиваются
cut += [c.boundary.simplify(0.03) for c in cities.values()]
faces = [f for f in polygonize(unary_union(cut)) if f.area > 1e-6]
log("кусков:", len(faces))

# Куски, в которые попали опорные точки двух разных районов, режем ещё и улицами второго уровня.
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
        lines = [roads["secondary"][i] for i in sec_tree.query(f)]
        sub = [g for g in polygonize(unary_union([f.exterior] + [g.exterior for g in [f]] + [l.intersection(f) for l in lines]))
               if f.contains(g.representative_point())]
        for g in (sub if sub else [f]):
            refined += split_by_seeds(g)
    else:
        refined.append(f)
faces = refined
log("после доразрезки:", len(faces))

# Город каждого куска: где больше площади.
city_names = list(cities)
city_tree = STRtree([cities[c] for c in city_names])


def city_of(f):
    best, ba = None, 0.0
    for i in city_tree.query(f):
        a = cities[city_names[i]].intersection(f).area
        if a > ba:
            best, ba = city_names[i], a
    return best if ba > 0.5 * f.area else None


face_city = [city_of(f) for f in faces]

by_city = collections.defaultdict(list)
for s in seeds:
    by_city[s["city"]].append((fwd(s["lon"], s["lat"]), s["id"]))

label = [None] * len(faces)
seed_face = set()
for i, f in enumerate(faces):
    rp = f.representative_point()
    for did, ag in aero_seed.items():
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
        cx, cy = rp.x, rp.y
        label[i] = min(cand, key=lambda q: (q[0][0] - cx) ** 2 + (q[0][1] - cy) ** 2)[1]
    else:
        label[i] = "c-" + re.sub(r"[^a-z]+", "-", c.lower()).strip("-")
log("размечено:", sum(1 for x in label if x), "из", len(faces))

# Соседство кусков и длина общей границы.
log("соседство")
ftree = STRtree(faces)
nbr = [dict() for _ in faces]
for i, f in enumerate(faces):
    for j in ftree.query(f):
        if j <= i:
            continue
        l = f.boundary.intersection(faces[j].boundary).length
        if l > 0.005:
            nbr[i][j] = l; nbr[j][i] = l

SLIVER = 0.04  # км², куски на развязках и между проезжими частями


def best_neighbour(i, ok):
    tally = collections.Counter()
    for j, l in nbr[i].items():
        if ok(j) and label[j]:
            tally[label[j]] += l
    return tally.most_common(1)[0][0] if tally else None


# мелочь на развязках — к соседу с самой длинной общей границей
for i in sorted(range(len(faces)), key=lambda k: faces[k].area):
    if faces[i].area < SLIVER and label[i] not in aero_seed and i not in seed_face:
        b = best_neighbour(i, lambda j: faces[j].area >= SLIVER)
        if b:
            label[i] = b
# территория вне городов — растёт от соседей слоями
for _ in range(400):
    todo = [i for i in range(len(faces)) if not label[i]]
    if not todo:
        break
    upd = {}
    for i in todo:
        b = best_neighbour(i, lambda j: True)
        if b:
            upd[i] = b
    if not upd:
        break
    for i, b in upd.items():
        label[i] = b
unincorporated = [face_city[i] is None for i in range(len(faces))]

# оторванные кусочки района (меньше трети главной части) — к соседям
for _ in range(3):
    changed = 0
    groups = collections.defaultdict(list)
    for i, l in enumerate(label):
        groups[l].append(i)
    for l, idx in groups.items():
        s = set(idx); comps = []
        while s:
            st = [s.pop()]; comp = []
            while st:
                k = st.pop(); comp.append(k)
                for j in nbr[k]:
                    if j in s:
                        s.remove(j); st.append(j)
            comps.append(comp)
        if len(comps) < 2:
            continue
        # главная часть — та, где стоит опорная точка, иначе самая большая
        comps.sort(key=lambda c: (not any(k in seed_face for k in c), -sum(faces[k].area for k in c)))
        main = sum(faces[k].area for k in comps[0])
        for c in comps[1:]:
            if sum(faces[k].area for k in c) < main / 3 and not any(k in seed_face for k in c):
                for k in c:
                    b = best_neighbour(k, lambda j: label[j] != l)
                    if b:
                        label[k] = b; changed += 1
    if not changed:
        break

# проверка: опорная точка должна лежать в своём районе
for pt, sd in seed_pts:
    if sd["city"].startswith("@") or sd["city"] == "-":
        continue
    for i in ftree.query(pt):
        if faces[i].contains(pt) and label[i] != sd["id"]:
            log("ВНИМАНИЕ: точка %s (%s) лежит в куске района %s; город куска %s, площадь %.3f" % (sd["id"], sd["city"], label[i], face_city[i], faces[i].area))

# ---------------------------------------------------------------- районы и области
log("районы")
seed_info = {}
for s in seeds:
    if s["id"] not in seed_info:
        seed_info[s["id"]] = s
groups = collections.defaultdict(list)
for i, l in enumerate(label):
    if l:
        groups[l].append(i)
city_by_slug = {"c-" + re.sub(r"[^a-z]+", "-", c.lower()).strip("-"): c for c in cities}

water_cut = unary_union([g for g in getattr(lakes, "geoms", [lakes]) if g.area > 0.3])
districts = {}
for did, idx in groups.items():
    g = unary_union([faces[i] for i in idx]).buffer(0.002).buffer(-0.002).difference(water_cut)
    if g.is_empty:
        continue
    if did in seed_info:
        s = seed_info[did]
        name, area = s["name"], s["area"]
        city = None if s["city"].startswith("@") or s["city"] == "-" else s["city"]
    else:
        city = city_by_slug[did]
        name, area = cities_tsv[city]["ru"], cities_tsv[city]["area"]
    rural = sum(faces[i].area for i in idx if unincorporated[i])
    districts[did] = {"geom": g, "name": name, "area": area, "city": city,
                      "kind": "airport" if did in aero_seed else "rural" if seed_info.get(did, {}).get("city") == "-" else "",
                      "rural": round(rural / g.area, 2) if g.area else 0}
for s in seed_info:
    if s not in districts:
        log("ВНИМАНИЕ: району не досталось территории:", s)

area_geom = {}
for aid in areas:
    parts = [d["geom"] for d in districts.values() if d["area"] == aid]
    if not parts:
        log("ВНИМАНИЕ: у области нет районов:", aid); continue
    area_geom[aid] = unary_union(parts).buffer(0.01).buffer(-0.01)

# Цвет области: соседние области разного цвета (жадная раскраска, 6 тонов). Районы берут цвет своей области.
tone = {}
grown = {a: g.buffer(0.05, 2) for a, g in area_geom.items()}
for aid in sorted(area_geom, key=lambda a: -area_geom[a].area):
    near = {tone[b] for b in tone if grown[b].intersects(area_geom[aid])}
    tone[aid] = next(t for t in range(12) if t not in near) % 6

feats, labels = [], []
for did, d in sorted(districts.items()):
    g = d["geom"]
    big = max(getattr(g, "geoms", [g]), key=lambda p: p.area)
    lp = polylabel(big, 0.02)
    props = {"id": did, "name": d["name"], "area": d["area"], "city": cities_tsv.get(d["city"], {}).get("ru", "") if d["city"] else "",
             "kind": d["kind"], "km2": round(g.area, 1), "rural": d["rural"], "tone": tone.get(d["area"], 0)}
    feats.append(feature(g, props, 0.012))
    labels.append({"type": "Feature", "properties": {"id": did, "name": d["name"], "km2": round(g.area, 1), "level": "district"},
                   "geometry": mapping(lonlat_round(unproj(lp)))})
write("districts", feats)

afeats = []
for aid, g in area_geom.items():
    big = max(getattr(g, "geoms", [g]), key=lambda p: p.area)
    afeats.append(feature(g, {"id": aid, "name": areas[aid], "km2": round(g.area), "tone": tone[aid]}, 0.03))
    labels.append({"type": "Feature", "properties": {"id": aid, "name": areas[aid], "km2": round(g.area), "level": "area"},
                   "geometry": mapping(lonlat_round(unproj(polylabel(big, 0.05))))})
write("areas", afeats)
write("labels", labels)

# ---------------------------------------------------------------- подложка
log("подложка")


def lines_feature(ls, props, tol):
    m = linemerge(unary_union(ls).intersection(FRAME))
    return feature(m, props, tol)


write("roads", [lines_feature(roads[c], {"cls": c}, 0.015 if c != "secondary" else 0.025)
                for c in ("secondary", "primary", "trunk", "motorway")])
write("water", [feature(lakes, {"cls": "lake"}, 0.02),
                lines_feature(river_main, {"cls": "river"}, 0.02),
                lines_feature(creeks, {"cls": "creek"}, 0.03)])
write("rail", [lines_feature(rail, {"cls": "rail"}, 0.02), lines_feature(dart, {"cls": "dart"}, 0.015)])
write("green", [feature(unary_union([g for g, t in green]), {"cls": "park"}, 0.02),
                feature(unary_union([g for g, t in aero]).intersection(FRAME), {"cls": "airport"}, 0.02)])
write("cities", [feature(g.boundary, {"name": cities_tsv.get(c, {}).get("ru", c)}, 0.02) for c, g in cities.items()])

# подписи шоссе: по одной точке на номер на каждые ~8 км
shield = []
seen = collections.defaultdict(list)
for ln, ref in road_refs:
    r = ref.split(";")[0].strip()
    if not re.match(r"^((I|US|TX|SH|Loop|Spur) \w+|PGBT|DNT)$", r):
        continue
    r = re.sub(r"^I ", "I-", re.sub(r"^TX ", "SH ", r))
    for k in range(int(ln.length // 2) + 1):
        p = ln.interpolate(min(ln.length, 1 + 2 * k)) if ln.length > 2 else ln.interpolate(0.5, normalized=True)
        if not FRAME.contains(p) or any(p.distance(q) < 8 for q in seen[r]):
            continue
        seen[r].append(p)
        shield.append({"type": "Feature", "properties": {"ref": r}, "geometry": mapping(lonlat_round(unproj(p)))})
write("shields", shield)

summary = sorted(((d["area"], did, d["name"], round(d["geom"].area, 1)) for did, d in districts.items()))
(OUT / "districts.txt").write_text("\n".join("%s\t%s\t%s\t%.1f км²" % r for r in summary) + "\n", encoding="utf-8")
log("готово: районов", len(districts), "областей", len(afeats))
