"""Общая плоская проекция: километры вокруг центра карты (достаточно точно для 100 км)."""
import math
from shapely.ops import transform

LAT0 = 32.83
KX = 111.32 * math.cos(math.radians(LAT0))
KY = 110.57


def fwd(lon, lat, z=None):
    return ((lon + 97.0) * KX, (lat - LAT0) * KY)


def inv(x, y, z=None):
    return (x / KX - 97.0, y / KY + LAT0)


def proj(g):
    return transform(fwd, g)


def unproj(g):
    return transform(inv, g)
