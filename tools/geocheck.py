"""Сверяет опорные точки из data/tree.tsv с геокодером Nominatim (OSM).

Запуск: python tools/geocheck.py
Печатает районы, где точка из файла дальше 1 км от найденной геокодером. Ответы кэшируются в data/raw/geocode.json.
Геокодер тоже ошибается (особенно на названиях районов), поэтому точки не правятся автоматически.
"""
import json, math, pathlib, time, urllib.parse, urllib.request
from seeds import read_tree

CACHE = pathlib.Path("data/raw/geocode.json")
UA = {"User-Agent": "vtm-dallas-2005-map/0.1 (tabletop game map)"}

cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
for k, v in read_tree().items():
    q = v["query"]
    if not q or not v["pts"]:
        continue
    s = {"id": k, "lat": v["pts"][0][0], "lon": v["pts"][0][1]}
    if q not in cache:
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
            {"q": q + ", Texas", "format": "json", "limit": 1, "viewbox": "-97.6,33.1,-96.4,32.5", "bounded": 1})
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                res = json.loads(r.read())
            cache[q] = [float(res[0]["lat"]), float(res[0]["lon"]), res[0].get("display_name", "")] if res else None
        except Exception as e:
            print("ошибка", q, e)
            continue
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        time.sleep(1.1)
    g = cache[q]
    if not g:
        print("%-22s не найдено: %s" % (s["id"], q)); continue
    dx = (g[1] - s["lon"]) * 93.3; dy = (g[0] - s["lat"]) * 111
    d = math.hypot(dx, dy)
    if d > 1.0:
        print("%-22s %5.1f км  файл %.4f %.4f  геокодер %.4f %.4f  %s" % (s["id"], d, s["lat"], s["lon"], g[0], g[1], g[2][:70]))
