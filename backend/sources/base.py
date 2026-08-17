from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Protocol


@dataclass(slots=True)
class ListingRecord:
    id: str
    source_slug: str
    external_id: str
    source_url: str
    title: str
    purpose: str
    property_type: str
    price_npr: int | None
    price_basis: str
    price_label: str
    location_name: str
    locality: str
    city: str
    area_label: str
    bedrooms: int | None = None
    bathrooms: int | None = None
    description_excerpt: str = ""
    image_url: str = ""
    image_alt: str = ""
    image_credit: str = ""
    latitude: float | None = None
    longitude: float | None = None
    location_precision: str = "unknown"
    source_age_label: str = ""
    raw_facts: dict[str, object] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


class ListingSource(Protocol):
    slug: str

    async def fetch(self, limit: int) -> list[ListingRecord]: ...
