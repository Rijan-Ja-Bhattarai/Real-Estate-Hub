from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

from backend.config import USER_AGENT
from backend.localities import locate
from backend.sources.base import ListingRecord
from backend.sources.common import clean_text, format_npr, optional_int, short_excerpt


class NepalHomesSource:
    """Bounded adapter for Nepal Homes' server-rendered public search results."""

    slug = "nepal-homes"
    name = "Nepal Homes"
    base_url = "https://www.nepalhomes.com"
    search_url = f"{base_url}/search"
    max_page_size = 24
    max_response_bytes = 5_000_000

    @staticmethod
    def _mapping(value: object) -> dict[str, object]:
        return value if isinstance(value, dict) else {}

    @classmethod
    def _title(cls, value: object) -> str:
        mapping = cls._mapping(value)
        return clean_text(mapping.get("title") or mapping.get("name"))

    @staticmethod
    def _property_type(value: object) -> str:
        label = clean_text(value).lower()
        if label in {"flat", "flats", "apartment", "apartments"}:
            return "Apartment"
        if any(word in label for word in ("office", "shop", "commercial")):
            return "Commercial"
        if "land" in label:
            return "Land"
        if any(word in label for word in ("house", "home", "bungalow", "villa")):
            return "House"
        return clean_text(value).title() or "Property"

    @staticmethod
    def _price_basis(value: object, purpose: str) -> str:
        label = clean_text(value).lower()
        if "month" in label:
            return "monthly"
        if "aana" in label or "anna" in label:
            return "per-aana"
        if "ropani" in label:
            return "per-ropani"
        if "kattha" in label:
            return "per-kattha"
        if "dhur" in label:
            return "per-dhur"
        if re.search(r"sq\.?\s*ft|square\s*feet", label):
            return "per-sq-ft"
        return "monthly" if purpose == "rent" else "total"

    @staticmethod
    def _price(value: object, on_call: object) -> int | None:
        if bool(on_call) or value in (None, ""):
            return None
        try:
            parsed = int(float(str(value).replace(",", "")))
        except (TypeError, ValueError, OverflowError):
            return None
        return parsed if parsed > 0 else None

    @staticmethod
    def _area_label(location: dict[str, object]) -> str:
        total_area = clean_text(location.get("total_area"))
        parts = [part.strip() for part in total_area.split("-")]
        if len(parts) == 4:
            labels = ("ropani", "aana", "paisa", "daam")
            values: list[str] = []
            for part, label in zip(parts, labels, strict=True):
                try:
                    amount = float(part)
                except ValueError:
                    values = []
                    break
                if amount:
                    shown = f"{amount:g}"
                    values.append(f"{shown} {label}")
            if values:
                return " ".join(values)

        for key, unit_key in (("super_area", "super_area_unit"), ("built_area", "built_area_unit")):
            amount = clean_text(location.get(key))
            unit = NepalHomesSource._title(location.get(unit_key))
            if amount:
                return clean_text(f"{amount} {unit}")
        return "Area on source"

    @staticmethod
    def _source_age(value: object) -> str:
        text = clean_text(value)
        if not text:
            return ""
        try:
            return f"Posted {datetime.fromisoformat(text.replace('Z', '+00:00')).date().isoformat()}"
        except ValueError:
            return f"Posted {text[:10]}"

    @classmethod
    def _record(cls, item: dict[str, object]) -> ListingRecord | None:
        if bool(item.get("is_sold_out")):
            return None

        basic = cls._mapping(item.get("basic"))
        title = clean_text(basic.get("title"))
        property_id = item.get("property_id")
        slug_url = clean_text(item.get("slug_url")).strip("/")
        if not title or property_id in (None, "") or not slug_url:
            return None

        public_id = clean_text(property_id)
        external_id = public_id if public_id.upper().startswith("NH") else f"NH{public_id}"
        purpose_label = cls._title(basic.get("property_purpose"))
        purpose = "rent" if purpose_label.lower() == "rent" else "buy"
        property_type = cls._property_type(cls._title(basic.get("property_category")))

        address = cls._mapping(item.get("address"))
        locality = cls._title(address.get("area_id"))
        city = cls._title(address.get("district_id")) or cls._title(address.get("city_id")) or "Nepal"
        point = locate(locality, city)

        location_property = cls._mapping(item.get("location_property"))
        building = cls._mapping(item.get("building"))
        room_counts = cls._mapping(building.get("no_of"))
        price_data = cls._mapping(item.get("price"))
        basis_label = cls._title(price_data.get("label"))
        price_basis = cls._price_basis(basis_label, purpose)
        price = cls._price(price_data.get("value"), price_data.get("is_price_on_call"))

        media = cls._mapping(item.get("media"))
        images = media.get("images") if isinstance(media.get("images"), list) else []
        first_image = cls._mapping(images[0]) if images else {}
        image_data = cls._mapping(first_image.get("id"))
        image_path = clean_text(image_data.get("path")).lstrip("/")
        image_url = f"{cls.base_url}/{quote(image_path, safe='/')}" if image_path else ""

        road_value = clean_text(location_property.get("road_access_value"))
        road_unit = cls._title(location_property.get("road_access_length_unit"))
        road_type = cls._title(location_property.get("road_access_road_type"))
        road_access = clean_text(" ".join(part for part in (road_value, road_unit, road_type) if part))
        facing = cls._title(location_property.get("property_face"))

        return ListingRecord(
            id=f"{cls.slug}:{external_id}",
            source_slug=cls.slug,
            external_id=external_id,
            source_url=f"{cls.base_url}/detail/{quote(slug_url, safe='-')}",
            title=title,
            purpose=purpose,
            property_type=property_type,
            price_npr=price,
            price_basis=price_basis,
            price_label=format_npr(price, price_basis),
            location_name=" · ".join(part for part in (locality, city) if part),
            locality=locality or city,
            city=city,
            area_label=cls._area_label(location_property),
            bedrooms=optional_int(room_counts.get("bedroom")),
            bathrooms=optional_int(room_counts.get("bathroom")),
            description_excerpt=short_excerpt(
                BeautifulSoup(str(basic.get("description") or ""), "html.parser").get_text(" ", strip=True)
            ),
            image_url=image_url,
            image_alt=f"{title}, source listing photograph",
            image_credit="Photograph from Nepal Homes; rights remain with the original publisher.",
            latitude=point.latitude if point else None,
            longitude=point.longitude if point else None,
            location_precision=point.precision if point else "unknown",
            source_age_label=cls._source_age(item.get("added_at")),
            raw_facts={
                "source_property_id": external_id,
                "source_price_basis": basis_label,
                "road_access": road_access,
                "facing": facing,
                "floors": optional_int(building.get("total_floor")),
                "published_at": clean_text(item.get("added_at")),
            },
        )

    @classmethod
    def _records_from_html(cls, html: str, limit: int) -> list[ListingRecord]:
        soup = BeautifulSoup(html, "html.parser")
        payload_node = soup.find("script", id="__NEXT_DATA__")
        if payload_node is None or not payload_node.string:
            raise RuntimeError("Nepal Homes did not include its listing payload")
        try:
            payload = json.loads(payload_node.string)
            page_props = cls._mapping(cls._mapping(payload.get("props")).get("pageProps"))
            properties = cls._mapping(page_props.get("properties"))
            response_data = cls._mapping(properties.get("data"))
            items = response_data.get("data")
        except (json.JSONDecodeError, AttributeError, TypeError) as error:
            raise RuntimeError("Nepal Homes returned an invalid listing payload") from error
        if not isinstance(items, list):
            raise RuntimeError("Nepal Homes listing payload did not contain a list")

        records: list[ListingRecord] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                record = cls._record(item)
            except (TypeError, ValueError, OverflowError):
                continue
            if record:
                records.append(record)
            if len(records) >= limit:
                break
        return records

    @classmethod
    async def _request(cls, client: httpx.AsyncClient, page_size: int) -> str:
        for attempt in range(3):
            try:
                response = await client.get(cls.search_url, params={"page": 1, "size": page_size, "sort": 1})
                response.raise_for_status()
                if len(response.content) > cls.max_response_bytes:
                    raise RuntimeError("Nepal Homes response exceeded the adapter size limit")
                return response.text
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500 or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.4 * (2**attempt))
        raise RuntimeError("Nepal Homes request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        page_size = min(max(int(limit), 1), self.max_page_size)
        headers = {"Accept": "text/html,application/xhtml+xml", "User-Agent": USER_AGENT}
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
            html = await self._request(client, page_size)
        return self._records_from_html(html, page_size)
