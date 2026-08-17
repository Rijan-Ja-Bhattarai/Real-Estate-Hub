from __future__ import annotations

import asyncio
import re

import httpx

from backend.config import USER_AGENT
from backend.localities import locate
from backend.sources.base import ListingRecord
from backend.sources.common import (
    clean_text,
    format_npr,
    infer_property_type,
    infer_price_basis,
    optional_int,
    parse_npr,
    short_excerpt,
)


class PropertyInNepalSource:
    """Property in Nepal's current first-party new-listing feed."""

    slug = "property-in-nepal"
    name = "Property in Nepal"
    # The first-party endpoint currently exposes a deliberately small
    # "new listings" window, so a three-record quorum is meaningful here.
    minimum_records = 3
    base_url = "https://propertyinnepal.com.np"
    api_url = "https://api.propertyinnepal.com.np/api/V1/new-listing-properties"

    @staticmethod
    def _features(item: dict[str, object]) -> dict[str, str]:
        features: dict[str, str] = {}
        values = item.get("features") if isinstance(item.get("features"), list) else []
        for feature in values:
            if not isinstance(feature, dict):
                continue
            name = clean_text(feature.get("name")).lower()
            value = clean_text(feature.get("value"))
            if name and value:
                features[name] = value
        return features

    @staticmethod
    def _safe_image(value: object) -> str:
        url = clean_text(value)
        return url if url.startswith("https://api.propertyinnepal.com.np/") else ""

    @staticmethod
    def _price(raw_price: str, on_calling: bool) -> int | None:
        if on_calling or not raw_price or "$" in raw_price or "usd" in raw_price.lower():
            return None
        return parse_npr(raw_price)

    @staticmethod
    def _price_label(raw_price: str, price: int | None, basis: str, on_calling: bool) -> str:
        if on_calling:
            return "Price on request"
        if "$" in raw_price or "usd" in raw_price.lower():
            return raw_price
        return format_npr(price, basis) if price is not None else (raw_price or "Price on request")

    def _record(self, item: dict[str, object]) -> ListingRecord | None:
        external_id = clean_text(item.get("id"))
        slug = clean_text(item.get("slug"))
        title = clean_text(item.get("name"))
        source_purpose = clean_text(item.get("for")).lower()
        if not external_id or not slug or not title or source_purpose not in {"sale", "rent"}:
            return None
        purpose = "rent" if source_purpose == "rent" else "buy"

        source_type = clean_text(item.get("type"))
        property_type = infer_property_type(source_type, title)
        if property_type == "Property" and source_type:
            property_type = source_type.replace("_", " ").title()

        raw_price = clean_text(item.get("price"))
        on_calling = clean_text(item.get("on_calling")).lower() in {"1", "true", "yes"}
        price = self._price(raw_price, on_calling)
        price_basis = infer_price_basis(raw_price, purpose, property_type)
        if property_type == "Land" and purpose == "buy" and not re.search(
            r"(?:/|per\s*)(?:aana|anna)\b", raw_price, re.IGNORECASE
        ):
            price_basis = "total"

        locality = clean_text(item.get("location")) or "Location on source"
        city = clean_text(item.get("city")) or "Nepal"
        point = locate(f"{locality} {title}", city)
        features = self._features(item)
        images = item.get("images") if isinstance(item.get("images"), list) else []
        image_url = self._safe_image(images[0]) if images else ""
        description = clean_text(item.get("description"))
        if description.lower() in {"description field", "description", "n/a", "na"}:
            description = ""

        facilities: list[str] = []
        for facility in item.get("facilities") if isinstance(item.get("facilities"), list) else []:
            if isinstance(facility, dict):
                name = clean_text(facility.get("name"))
                if name:
                    facilities.append(name)

        return ListingRecord(
            id=f"{self.slug}:{external_id}",
            source_slug=self.slug,
            external_id=external_id,
            source_url=f"{self.base_url}/property/{slug}",
            title=title,
            purpose=purpose,
            property_type=property_type,
            price_npr=price,
            price_basis=price_basis,
            price_label=self._price_label(raw_price, price, price_basis, on_calling),
            location_name=" · ".join(dict.fromkeys(part for part in (locality, city) if part)),
            locality=locality,
            city=city,
            area_label=clean_text(item.get("area")) or features.get("land size", "Area on source"),
            bedrooms=optional_int(features.get("bedroom")),
            bathrooms=optional_int(features.get("bathroom")),
            description_excerpt=short_excerpt(description),
            image_url=image_url,
            image_alt=f"{title}, source listing photograph",
            image_credit=(
                "Photograph from Property in Nepal; used in this private prototype "
                "with owner-authorized publisher permission."
            ),
            latitude=point.latitude if point else None,
            longitude=point.longitude if point else None,
            location_precision=point.precision if point else "unknown",
            source_age_label=clean_text(item.get("created_at_human")),
            raw_facts={
                "property_code": clean_text(item.get("code")),
                "road_access": features.get("road access", ""),
                "facing": features.get("faced", ""),
                "floor": features.get("floor", ""),
                "furnishing": features.get("furnishing", ""),
                "parking": features.get("parking", ""),
                "facilities": facilities,
            },
        )

    @staticmethod
    async def _get(client: httpx.AsyncClient) -> dict[str, object]:
        for attempt in range(3):
            try:
                response = await client.get(PropertyInNepalSource.api_url)
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict):
                    raise RuntimeError("Property in Nepal returned a non-object response")
                return body
            except httpx.HTTPStatusError as error:
                if error.response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.5 * (2**attempt))
        raise RuntimeError("Property in Nepal request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        if limit <= 0:
            return []
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
            body = await self._get(client)

        items = body.get("data") if isinstance(body.get("data"), list) else []
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
