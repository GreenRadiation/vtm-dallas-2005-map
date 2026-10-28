"""Слой DART: линии поездов и станции на весну 2005 года → data/geo/dart.geojson.

Запуск из корня репозитория: python tools/dart.py   (сырьё — data/raw/osm_transit.json из tools/fetch.py)

Линии берутся из маршрутов OpenStreetMap и обрезаются до 2005 года: красная — Уэстморленд–Паркер-роуд (как и сейчас),
синяя — Ледбеттер–Даунтаун-Гарленд (позже её продлили до Роулетта и UNT Dallas), TRE — Юнион-Стейшн–T&P.
Зелёной и оранжевой линий в 2005 году ещё нет. Общий участок красной и синой — отдельная линия `shared`,
тоннель под Центральным шоссе — `tunnel: true`. Станции — из data/dart.tsv, притянуты к своей линии.
"""
import json, pathlib, collections
from shapely.geometry import LineString, Point, mapping
from shapely.ops import linemerge, nearest_points, unary_union

RAW = pathlib.Path("data/raw")
OUT = pathlib.Path("data/geo/dart.geojson")
BLUE_2005 = lambda lat, lon: lat > 32.680 and lon < -96.634  # Ледбеттер на юге, Даунтаун-Гарленд на востоке

elements = json.load(open(RAW / "osm_transit.json", encoding="utf-8"))["elements"]
refs = collections.defaultdict(set)  # линия → id путей; A-Train и TEXRail в выгрузке тоже есть, но они позже 2005 года
for r in elements:
    name = r.get("tags", {}).get("name", "") if r["type"] == "relation" else ""
    for prefix, line in (("Red Line", "red"), ("Blue Line", "blue"), ("Trinity Railway Express", "tre")):
        if name.startswith(prefix):
            refs[line] |= {m["ref"] for m in r["members"] if m["type"] == "way"}

parts = collections.defaultdict(list)  # (линия, тоннель) → отрезки
for e in elements:
    if e["type"] != "way" or e["tags"].get("railway") not in ("rail", "light_rail"):
        continue
    pts = [(p["lon"], p["lat"]) for p in e["geometry"]]
    red, blue = e["id"] in refs["red"], e["id"] in refs["blue"]
    if e["id"] in refs["tre"]:
        line = "tre"
    elif red and blue:
        line = "shared"
    elif red:
        line = "red"
    elif blue:
        line = "blue"
        pts = [p for p in pts if BLUE_2005(p[1], p[0])]
    else:
        continue
    if len(pts) >= 2:
        parts[(line, line != "tre" and e["tags"].get("tunnel") == "yes")].append(LineString(pts))

feats, lines = [], collections.defaultdict(list)
for (line, tunnel), segs in sorted(parts.items()):
    g = unary_union(segs)
    g = (linemerge(g) if g.geom_type == "MultiLineString" else g).simplify(0.00008)
    lines[line].append(g)
    feats.append({"type": "Feature", "properties": {"kind": "line", "line": line, "tunnel": tunnel}, "geometry": mapping(g)})

WHICH = {"R": ["red", "shared"], "B": ["blue", "shared"], "T": ["tre"]}
n = 0
for row in open("data/dart.tsv", encoding="utf-8"):
    if row.startswith("#") or not row.strip():
        continue
    sid, name, en, codes, lat, lon, note = row.rstrip("\n").split("\t")
    p = Point(float(lon), float(lat))
    near = unary_union([g for c in codes for k in WHICH[c] for g in lines[k]])
    q = nearest_points(near, p)[0]
    if q.distance(p) > 0.004:
        print("далеко от линии:", sid, round(q.distance(p), 4))
    feats.append({"type": "Feature", "properties": {"kind": "station", "id": sid, "name": name, "en": en, "lines": codes, "note": note},
                  "geometry": {"type": "Point", "coordinates": [round(q.x, 5), round(q.y, 5)]}})
    n += 1

def rnd(o):
    return [rnd(x) for x in o] if isinstance(o, (list, tuple)) and o and isinstance(o[0], (list, tuple)) else [round(o[0], 5), round(o[1], 5)]
for f in feats:
    if f["properties"]["kind"] == "line":
        f["geometry"]["coordinates"] = rnd(f["geometry"]["coordinates"])
OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("линий:", sum(1 for f in feats if f["properties"]["kind"] == "line"), "станций:", n, "→", OUT, OUT.stat().st_size // 1024, "КБ")
