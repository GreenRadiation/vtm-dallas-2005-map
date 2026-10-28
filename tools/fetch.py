"""Скачивает сырые геоданные в data/raw/ (в репозиторий они не попадают).

Запуск из корня репозитория: python tools/fetch.py
Повторный запуск пропускает уже скачанные файлы; чтобы обновить, удали файл.

- OpenStreetMap через Overpass: дороги, вода, железные дороги, парки, аэропорты, названия районов.
- Перепись США: границы городов Техаса на 2000 год (TIGER/Line).
"""
import pathlib, sys, time, urllib.request, urllib.parse, zipfile, io

BBOX = (32.58, -97.55, 33.08, -96.50)  # юг, запад, север, восток — весь охват карты
RAW = pathlib.Path("data/raw")
UA = {"User-Agent": "vtm-dallas-2005-map/0.1 (tabletop game map)"}
OVERPASS = "https://overpass-api.de/api/interpreter"

b = "(%s,%s,%s,%s)" % BBOX
QUERIES = {
    "roads": 'way["highway"~"^(motorway|trunk|primary|secondary)$"]' + b + ';',
    "rail": 'way["railway"~"^(rail|light_rail)$"]["service"!~"."]' + b + ';',
    "dart": 'rel["route"="light_rail"]["network"~"DART"]' + b + ';',
    # линии DART и TRE для слоя DART: пути маршрутов с тегами (тоннели) и станции
    "transit": ('rel["route"="light_rail"]["network"~"DART"]' + b + ';rel["route"="train"]["name"~"Trinity|TRE"]' + b + ';)->.r;('
                '.r;way(r.r);node(r.r);node["railway"~"^(station|halt)$"]' + b + ';'),
    "water": ('way["natural"="water"]' + b + ';rel["natural"="water"]' + b + ';'
              'way["waterway"="river"]' + b + ';rel["waterway"="river"]' + b + ';'
              'way["waterway"~"^(stream|canal)$"]["name"]' + b + ';'),
    "green": ('way["leisure"~"^(park|nature_reserve|golf_course)$"]' + b + ';'
              'rel["leisure"~"^(park|nature_reserve)$"]' + b + ';'
              'way["landuse"="cemetery"]' + b + ';'),
    "aero": 'way["aeroway"="aerodrome"]' + b + ';rel["aeroway"="aerodrome"]' + b + ';',
    "places": 'node["place"~"^(city|town|village|suburb|quarter|neighbourhood|hamlet)$"]' + b + ';',
    "hoods": ('way["place"~"^(suburb|quarter|neighbourhood)$"]' + b + ';rel["place"~"^(suburb|quarter|neighbourhood)$"]' + b + ';'
              'rel["boundary"~"^(neighborhood|neighbourhood)$"]' + b + ';way["boundary"~"^(neighborhood|neighbourhood)$"]' + b + ';'
              'rel["boundary"="historic"]' + b + ';way["historic"="district"]' + b + ';rel["historic"="district"]' + b + ';'),
    "landmarks": ('way["amenity"~"^(hospital|university|college)$"]' + b + ';rel["amenity"~"^(hospital|university|college)$"]' + b + ';'
                  'way["leisure"="stadium"]' + b + ';rel["leisure"="stadium"]' + b + ';way["tourism"~"^(zoo|theme_park)$"]' + b + ';'
                  'way["shop"="mall"]' + b + ';rel["shop"="mall"]' + b + ';way["landuse"="military"]' + b + ';'),
}


def overpass(name, body):
    out = RAW / ("osm_" + name + ".json")
    if out.exists():
        print("есть", out); return
    q = "[out:json][timeout:300];(" + body + ");out body geom;"
    for attempt in range(4):
        try:
            req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
            with urllib.request.urlopen(req, timeout=400) as r:
                out.write_bytes(r.read())
            print("скачано", out, out.stat().st_size // 1024, "КБ"); return
        except Exception as e:
            print("ошибка", name, e, "— повтор"); time.sleep(20 * (attempt + 1))
    sys.exit("не удалось скачать " + name)


def census():
    out = RAW / "places2000"
    if out.exists():
        print("есть", out); return
    url = "https://www2.census.gov/geo/tiger/TIGER2010/PLACE/2000/tl_2010_48_place00.zip"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        zipfile.ZipFile(io.BytesIO(r.read())).extractall(out)
    print("скачано", out)


if __name__ == "__main__":
    RAW.mkdir(parents=True, exist_ok=True)
    census()
    for n, body in QUERIES.items():
        overpass(n, body)
