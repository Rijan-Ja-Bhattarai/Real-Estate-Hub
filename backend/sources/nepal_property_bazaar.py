from __future__ import annotations

import asyncio
from datetime import datetime

import httpx
from bs4 import BeautifulSoup

from backend.config import USER_AGENT
from backend.localities import locate
from backend.sources.base import ListingRecord
from backend.sources.common import (
    clean_text,
    format_npr,
    infer_property_type,
    infer_purpose,
    infer_price_basis,
    optional_int,
    parse_npr,
    short_excerpt,
)


class NepalPropertyBazaarSource:
    """Latest public Nepal Property Bazaar listings via its WordPress API."""

    slug = "nepal-property-bazaar"
    name = "Nepal Property Bazaar"
    base_url = "https://nepalpropertybazaar.com"
    api_url = f"{base_url}/wp-json/wp/v2/properties"
    _fields = ",".join(
        (
            "id",
            "date",
            "link",
            "slug",
            "title",
            "excerpt",
            "property_attr",
            "property_meta",
            "thumbnail",
        )
    )

    @staticmethod
    def _first(meta: dict[str, object], key: str) -> object:
        value = meta.get(key)
        if isinstance(value, list):
            return value[0] if value else ""
        return value or ""

    @staticmethod
    def _html_text(value: object) -> str:
        return clean_text(BeautifulSoup(str(value or ""), "html.parser").get_text(" "))

    @staticmethod
    def _city(*values: object) -> str:
        text = " ".join(clean_text(value).lower() for value in values)
        for city in (
            "Kathmandu",
            "Lalitpur",
            "Bhaktapur",
            "Pokhara",
            "Chitwan",
            "Biratnagar",
            "Butwal",
            "Hetauda",
            "Itahari",
            "Dharan",
        ):
            if city.lower() in text:
                return city
        return "Nepal"

    @staticmethod
    def _safe_image(value: object) -> str:
        url = clean_text(value)
        return url if url.startswith("https://nepalpropertybazaar.com/") else ""

    @staticmethod
    def _source_age(value: object) -> str:
        raw = clean_text(value)
        try:
            published = datetime.fromisoformat(raw)
        except ValueError:
            return ""
        return f"Published {published:%b %-d, %Y}"

    def _record(self, item: dict[str, object]) -> ListingRecord | None:
        external_id = item.get("id")
        title_node = item.get("title") if isinstance(item.get("title"), dict) else {}
        title = self._html_text(title_node.get("rendered"))
        source_url = clean_text(item.get("link"))
        if external_id is None or not title or not source_url.startswith(f"{self.base_url}/property/"):
            return None

        attrs = item.get("property_attr") if isinstance(item.get("property_attr"), dict) else {}
        meta = item.get("property_meta") if isinstance(item.get("property_meta"), dict) else {}
        status = clean_text(attrs.get("property_status"))
        status_key = status.lower()
        if status_key in {"sold", "rented"} or " sold" in f" {status_key}" or "rented" in status_key:
            return None
        purpose = infer_purpose(status, title)

        source_type = clean_text(attrs.get("property_type"))
        property_type = infer_property_type(source_type, title)
        if property_type == "Property" and source_type:
            property_type = source_type.replace("/", " / ").strip().title()

        raw_price = clean_text(self._first(meta, "fave_property_price"))
        price = parse_npr(raw_price)
        postfix = clean_text(self._first(meta, "fave_property_price_postfix"))
        price_basis = infer_price_basis(f"{raw_price} {postfix}", purpose, property_type)
        if property_type == "Land" and purpose == "buy":
            # A lakh/crore amount is not necessarily a per-aana quote. Require
            # the publisher's postfix to say so instead of relying on type.
            price_basis = "per-aana" if postfix.lower() in {"aana", "anna", "/aana", "/anna"} else "total"
        price_label = format_npr(price, price_basis)
        if price is None:
            placeholder = clean_text(self._first(meta, "fave_property_price_placeholder"))
            price_label = placeholder or "Price on request"

        address = clean_text(
            self._first(meta, "fave_property_address")
            or self._first(meta, "fave_property_map_address")
        )
        city = self._city(address, title)
        locality = clean_text(address.split(",", 1)[0]) if address else ""
        if not locality:
            locality = city if city != "Nepal" else "Location on source"
        point = locate(f"{locality} {title}", city)

        area = clean_text(
            self._first(meta, "fave_property_land")
            or self._first(meta, "fave_property_size")
        )
        excerpt_node = item.get("excerpt") if isinstance(item.get("excerpt"), dict) else {}
        excerpt = self._html_text(excerpt_node.get("rendered"))

        return ListingRecord(
            id=f"{self.slug}:{external_id}",
            source_slug=self.slug,
            external_id=str(external_id),
            source_url=source_url,
            title=title,
            purpose=purpose,
            property_type=property_type,
            price_npr=price,
            price_basis=price_basis,
            price_label=price_label,
            location_name=" · ".join(dict.fromkeys(part for part in (locality, city) if part)),
            locality=locality,
            city=city,
            area_label=area or "Area on source",
            bedrooms=optional_int(self._first(meta, "fave_property_bedrooms")),
            bathrooms=optional_int(self._first(meta, "fave_property_bathrooms")),
            description_excerpt=short_excerpt(excerpt),
            image_url=self._safe_image(item.get("thumbnail")),
            image_alt=f"{title}, source listing photograph",
            image_credit=(
                "Photograph from Nepal Property Bazaar; used in this private prototype "
                "with owner-authorized publisher permission."
            ),
            latitude=point.latitude if point else None,
            longitude=point.longitude if point else None,
            location_precision=point.precision if point else "unknown",
            source_age_label=self._source_age(item.get("date")),
            raw_facts={
                "property_code": clean_text(self._first(meta, "fave_property_id")) or str(external_id),
                "road_access": clean_text(self._first(meta, "fave_road-size")),
                "road_type": clean_text(self._first(meta, "fave_road-type")),
                "facing": clean_text(self._first(meta, "fave_facing")),
                "floor": clean_text(self._first(meta, "fave_flour")),
                "furnishing": clean_text(self._first(meta, "fave_furnishing")),
                "parking": clean_text(self._first(meta, "fave_parking")),
            },
        )

    @staticmethod
    async def _get(client: httpx.AsyncClient, params: dict[str, object]) -> list[object]:
        for attempt in range(3):
            try:
                response = await client.get(NepalPropertyBazaarSource.api_url, params=params)
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, list):
                    raise RuntimeError("Nepal Property Bazaar returned a non-list response")
                return body
            except httpx.HTTPStatusError as error:
                if error.response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.5 * (2**attempt))
        raise RuntimeError("Nepal Property Bazaar request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        if limit <= 0:
            return []
        # Fetch at most two candidates per requested record so inactive entries can
        # be discarded without issuing an unbounded crawl.
        request_size = min(100, max(12, limit * 2))
        params: dict[str, object] = {
            "per_page": request_size,
            "page": 1,
            "orderby": "date",
            "order": "desc",
            "_fields": self._fields,
        }
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
            items = await self._get(client, params)

        records: list[ListingRecord] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                record = self._record(item)
            except (TypeError, ValueError, OverflowError):
                continue
            if record:
                records.append(record)
            if len(records) >= limit:
                break
        return records
