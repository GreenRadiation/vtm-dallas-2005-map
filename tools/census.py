"""Перепись 2000 года по узлам дерева: кто живёт, достаток, жильё. Пишет data/census.json.

Запуск из корня репозитория после build.py: python tools/census.py

Источник — Summary File 3 переписи 2000 года (выборочные данные) по группам кварталов (block groups) и их границы
TIGER 2000. Файлы качаются с www2.census.gov в data/raw/census2000/ (около 70 МБ, один раз). API переписи
не используем: ему нужен ключ.

Группа кварталов делится между листьями дерева пропорционально площади пересечения; родитель — сумма детей.
Сводки:
  pop    — жителей;  dens — жителей на км² суши (озёра из подложки вычитаются);
  race   — доли в процентах: [белые, латиноамериканцы, чёрные, азиаты, прочие]. Белые, чёрные и азиаты —
           не латиноамериканского происхождения; латиноамериканцы — любой расы, как в переписи;
  inc    — медианный доход домохозяйства за 1999 год, долларов (по интервалам таблицы P52);
  own    — доля жилья, где живут владельцы, %;
  homes  — доли жилья в процентах: [частный дом, дуплекс и малоэтажка до 9 квартир, дом от 10 квартир, трейлер];
  built  — медианный год постройки жилья;
  hh     — домохозяйств (для взвешивания).
"""
import json, pathlib, re, sys, zipfile, collections, urllib.request
import numpy as np
import shapefile
from shapely.geometry import shape
from shapely.ops import unary_union
from shapely import STRtree
from build_common import proj

RAW = pathlib.Path("data/raw/census2000")
TREE = pathlib.Path("data/geo/tree")
SF3 = "https://www2.census.gov/census_2000/datasets/Summary_File_3/"
BG = "https://www2.census.gov/geo/tiger/TIGER2010/BG/2000/tl_2010_48%s_bg00.zip"
# Округа, которые попадают в рамку карты: Даллас, Таррант, Коллин, Дентон, Рокуолл, Эллис, Кауфман, Паркер, Джонсон
COUNTIES = ["113", "439", "085", "121", "397", "139", "257", "367", "251"]
SEGMENTS = {"01": ["P007"], "06": ["P052"], "56": ["H007"], "58": ["H030", "H034"]}


def get(url, path):
    if not path.exists():
        print("качаю", url, flush=True)
        urllib.request.urlretrieve(url, path)
    return path


RAW.mkdir(parents=True, exist_ok=True)
# порядок полей в файлах данных — из описания таблиц (table matrix)
doc = get(SF3 + "0SF3_table_matrix.doc", RAW / "matrix.doc").read_bytes().decode("latin-1")
order = collections.defaultdict(list)
for code, seg in re.findall(r"\b([PH]\d{6}[A-Z]?)\s+(\d\d)\s+\d+\b", doc):
    if code not in order[seg]:
        order[seg].append(code)

# группы кварталов нужных округов: номер логической записи → GEOID
z = zipfile.ZipFile(get(SF3 + "Texas/txgeo_uf3.zip", RAW / "txgeo_uf3.zip"))
logrec = {}
for line in z.read("txgeo.uf3").decode("latin-1").splitlines():
    if line[8:11] == "150" and line[11:13] == "00" and line[31:34] in COUNTIES:
        logrec[line[18:25]] = "48" + line[31:34] + line[55:61] + line[61]

data = collections.defaultdict(dict)
for seg, tables in SEGMENTS.items():
    name = "tx000%s_uf3" % seg
    z = zipfile.ZipFile(get(SF3 + "Texas/%s.zip" % name, RAW / (name + ".zip")))
    cols = [(i + 5, c) for i, c in enumerate(order[seg]) if c[:4] in tables]
    for line in z.read(name.replace("_", ".")).decode("latin-1").splitlines():
        f = line.split(",")
        g = logrec.get(f[4])
        if g:
            for i, c in cols:
                data[g][c] = int(f[i] or 0)
print("групп кварталов:", len(data))

bg_geom = {}
for c in COUNTIES:
    zp = get(BG % c, RAW / ("bg_%s.zip" % c))
    with zipfile.ZipFile(zp) as z:
        names = {pathlib.Path(n).suffix: n for n in z.namelist()}
        r = shapefile.Reader(shp=z.open(names[".shp"]), dbf=z.open(names[".dbf"]), shx=z.open(names[".shx"]))
        for sr in r.iterShapeRecords():
            rec = sr.record.as_dict()
            g = rec.get("BKGPIDFP00") or (rec["STATEFP00"] + rec["COUNTYFP00"] + rec["TRACTCE00"] + rec["BLKGRPCE00"])
            if g in data:
                bg_geom[g] = proj(shape(sr.shape.__geo_interface__)).buffer(0)
ids = list(bg_geom)
bg_tree = STRtree([bg_geom[g] for g in ids])
print("с границами:", len(ids))

# листья дерева и их геометрия
index = {x["id"]: x for x in json.load(open(TREE / "index.json", encoding="utf-8"))}
geom = {}
for p in ["_root"] + [k for k, x in index.items() if x["n"]]:
    for f in json.load(open(TREE / (p + ".geojson"), encoding="utf-8"))["features"]:
        geom[f["properties"]["id"]] = proj(shape(f["geometry"])).buffer(0)
water = json.load(open("data/geo/water.geojson", encoding="utf-8"))["features"]
lakes = unary_union([proj(shape(f["geometry"])).buffer(0) for f in water if f["properties"]["cls"] == "lake"])

KEYS = sorted({c for g in data.values() for c in g})
sums = {}
for k, x in index.items():
    if x["n"]:
        continue
    G = geom[k]
    v = collections.Counter()
    for i in bg_tree.query(G):
        b = bg_geom[ids[i]]
        share = b.intersection(G).area / b.area if b.area else 0
        if share > 1e-4:
            for c in KEYS:
                v[c] += data[ids[i]].get(c, 0) * share
    v["land"] = G.difference(lakes).area
    sums[k] = v


def total(k):
    if k not in sums:
        v = collections.Counter()
        for c in (c for c, x in index.items() if x["parent"] == k):
            v.update(total(c))
        sums[k] = v
    return sums[k]


INC = [0, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 100, 125, 150, 200, 250]  # границы интервалов P52, тыс. долларов
YEAR = [2000, 1999, 1995, 1990, 1980, 1970, 1960, 1950, 1940, 1920]  # H34 от новых к старым


def median(counts, edges):
    """Медиана по интервалам: counts[i] лежит между edges[i] и edges[i + 1]."""
    n = sum(counts)
    if n <= 0:
        return None
    acc = 0
    for i, c in enumerate(counts):
        if acc + c >= n / 2:
            return edges[i] + (edges[i + 1] - edges[i]) * ((n / 2 - acc) / c if c else 0)
        acc += c
    return edges[-1]


def pct(a, b):
    return round(100 * a / b) if b else 0


out = {}
for k in index:
    v = total(k)
    pop = v["P007001"]
    if pop < 50:
        out[k] = {"pop": round(pop)}
        continue
    w, h, b, a = v["P007003"], v["P007010"], v["P007004"], v["P007006"]
    inc = median([v["P0520%02d" % i] for i in range(2, 18)], INC)
    built = median([v["H0340%02d" % i] for i in range(2, 11)], YEAR)
    units = v["H030001"] or 1
    out[k] = {
        "pop": round(pop), "dens": round(pop / v["land"]) if v["land"] > 0.05 else None, "hh": round(v["P052001"]),
        "race": [pct(w, pop), pct(h, pop), pct(b, pop), pct(a, pop), pct(pop - w - h - b - a, pop)],
        "inc": round(inc * 1000, -2) if inc is not None else None,
        "own": pct(v["H007002"], v["H007001"]),
        "homes": [pct(v["H030002"] + v["H030003"], units), pct(v["H030004"] + v["H030005"] + v["H030006"], units),
                  pct(v["H030007"] + v["H030008"] + v["H030009"], units), pct(v["H030010"] + v["H030011"], units)],
        "built": round(built) if built else None,
    }

# медиана по всей карте — точка отсчёта для ступеней достатка
allv = collections.Counter()
for k, x in index.items():
    if not x["parent"]:
        allv.update(total(k))
ref = median([allv["P0520%02d" % i] for i in range(2, 18)], INC)
res = {"source": "Перепись США 2000, Summary File 3, группы кварталов", "inc_ref": round(ref * 1000, -2), "nodes": out}
pathlib.Path("data/census.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print("медианный доход по карте:", res["inc_ref"], "жителей:", round(sum(total(k)["P007001"] for k, x in index.items() if not x["parent"])))
for k in ["dallas", "dal-oakcliff", "bishoparts", "anatole", "highlandpark", "fw", "plano"]:
    if k in out:
        print(k, out[k])
