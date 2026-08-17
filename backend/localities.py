from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class MapPoint:
    latitude: float
    longitude: float
    precision: str = "locality"


# Public locality centroids, intentionally not house-level coordinates. A source
# address such as "Pepsicola" should never be presented as the exact property pin.
LOCALITY_CENTROIDS: dict[str, MapPoint] = {
    "basundhara": MapPoint(27.7471, 85.3334),
    "bhaisepati": MapPoint(27.6468, 85.3014),
    "budhanilkantha": MapPoint(27.7784, 85.3618),
    "chapali": MapPoint(27.7694, 85.3584),
    "chabahil": MapPoint(27.7205, 85.3470),
    "dholahiti": MapPoint(27.6486, 85.3127),
    "duwakot": MapPoint(27.7086, 85.4282),
    "gothatar": MapPoint(27.6968, 85.3873),
    "imadol": MapPoint(27.6608, 85.3450),
    "jorpati": MapPoint(27.7266, 85.3758),
    "koteshwor": MapPoint(27.6782, 85.3490),
    "kuleshwor": MapPoint(27.6900, 85.2973),
    "lazimpat": MapPoint(27.7216, 85.3208),
    "lubhu": MapPoint(27.6450, 85.3779),
    "mulpani": MapPoint(27.7160, 85.4040),
    "pepsicola": MapPoint(27.6889, 85.3603),
    "sanepa": MapPoint(27.6818, 85.3017),
    "sitapaila": MapPoint(27.7043, 85.2763),
    "tokha": MapPoint(27.7544, 85.3264),
}

CITY_CENTROIDS: dict[str, MapPoint] = {
    "bhaktapur": MapPoint(27.6710, 85.4298, "city"),
    "chitwan": MapPoint(27.5291, 84.3542, "district"),
    "kathmandu": MapPoint(27.7172, 85.3240, "city"),
    "lalitpur": MapPoint(27.6588, 85.3247, "city"),
    "pokhara": MapPoint(28.2096, 83.9856, "city"),
}


def _normalise(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def locate(locality: str | None, city: str | None) -> MapPoint | None:
    locality_key = _normalise(locality)
    for name, point in LOCALITY_CENTROIDS.items():
        if name in locality_key:
            return point

    city_key = _normalise(city)
    for name, point in CITY_CENTROIDS.items():
        if name in city_key:
            return point
    return None
