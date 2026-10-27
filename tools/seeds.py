"""Чтение таблиц data/*.tsv: города, дерево регионов, природный слой."""
import pathlib

DATA = pathlib.Path("data")


def rows(name):
    for line in (DATA / name).read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            yield [c.strip() for c in line.split("\t")]


def read_natural():
    return [{"id": r[0], "kind": r[1], "names": r[2].split("|"), "name": r[3]} for r in rows("natural.tsv")]



def read_tree():
    """Дерево регионов: id → {parent, kind, name, pts [(широта, долгота)], query}; порядок как в файле."""
    out = {}
    for r in rows("tree.tsv"):
        r += [""] * (6 - len(r))
        if r[0] in out:
            raise SystemExit("tree.tsv: id %s повторяется" % r[0])
        pts = [tuple(float(v) for v in p.split(",")) for p in r[4].split()]
        out[r[0]] = {"parent": None if r[1] == "-" else r[1], "kind": r[2], "name": r[3], "pts": pts, "query": r[5]}
    return out
