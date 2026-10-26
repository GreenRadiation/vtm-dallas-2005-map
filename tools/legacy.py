"""Сопоставляет районы и области со старыми клетками карты 2005 (data/legacy/grid-2005.json).

Запуск после build.py: python tools/legacy.py
Пишет data/geo/legacy.json: тексты старых клеток и списки клеток, поверх которых лежит каждый район и каждая область.
Это переходный материал: в карточке района он показывается, пока у района нет своего текста.
"""
import json, pathlib, warnings
warnings.filterwarnings("ignore", category=DeprecationWarning)
from shapely.geometry import shape, box
from build_common import proj

BOARDS = {
    "city": (9, 9, 33.02, 32.62, -96.99, -96.55),
    "core": (8, 8, 32.842222, 32.753333, -96.843333, -96.745556),
    "fw": (9, 9, 33.00, 32.60, -97.55, -97.11),
}
L = "ABCDEFGHI"
old = json.loads(pathlib.Path("data/legacy/grid-2005.json").read_text(encoding="utf-8"))["cells"]


def cells(board):
    cols, rows, n, s, w, e = BOARDS[board]
    dx, dy = (e - w) / cols, (n - s) / rows
    for c in range(cols):
        for r in range(rows):
            yield board + ":" + L[c] + str(r + 1), proj(box(w + c * dx, n - (r + 1) * dy, w + (c + 1) * dx, n - r * dy))


grid = {b: list(cells(b)) for b in BOARDS}


def load(name):
    return [(f["properties"]["id"], proj(shape(f["geometry"])).buffer(0)) for f in
            json.loads(pathlib.Path("data/geo/" + name + ".geojson").read_text(encoding="utf-8"))["features"]]


def match(g, boards, min_share):
    out = []
    for b in boards:
        for k, cg in grid[b]:
            if k not in old or not cg.intersects(g):
                continue
            a = cg.intersection(g).area
            if a / cg.area >= min_share or a / g.area >= 0.3:
                out.append((a, k))
    return [k for a, k in sorted(out, reverse=True)]


core_box = proj(box(-96.843333, 32.753333, -96.745556, 32.842222))
res = {"districts": {}, "areas": {}}
for did, g in load("districts"):
    inside_core = g.intersection(core_box).area > 0.5 * g.area
    res["districts"][did] = match(g, ["core"] if inside_core else ["city", "fw"], 0.25)[:4]
for aid, g in load("areas"):
    res["areas"][aid] = match(g, ["city", "fw"], 0.4)[:8]
used = {k for v in res["districts"].values() for k in v} | {k for v in res["areas"].values() for k in v}
res["cells"] = {k: {f: old[k].get(f, "") for f in ("name", "summary", "details", "more")} for k in sorted(used)}
p = pathlib.Path("data/geo/legacy.json")
p.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("клеток в переходном материале:", len(used), "из", len(old), "·", p.stat().st_size // 1024, "КБ")
