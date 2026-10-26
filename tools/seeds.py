"""Чтение таблиц data/areas.tsv, data/cities.tsv, data/seeds.tsv."""
import pathlib

DATA = pathlib.Path("data")


def rows(name):
    for line in (DATA / name).read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            yield [c.strip() for c in line.split("\t")]


def read_areas():
    return {r[0]: r[1] for r in rows("areas.tsv")}


def read_cities():
    return {r[0]: {"ru": r[1], "area": r[2]} for r in rows("cities.tsv")}


def read_seeds():
    out = []
    for r in rows("seeds.tsv"):
        r += [""] * (7 - len(r))
        out.append({"id": r[0], "area": r[1], "city": r[2], "lat": float(r[3]), "lon": float(r[4]),
                    "name": r[5], "query": r[6]})
    return out
