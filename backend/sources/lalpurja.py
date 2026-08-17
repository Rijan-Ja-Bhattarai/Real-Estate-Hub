from __future__ import annotations

import asyncio
import base64
import random
import re
from datetime import datetime
from html import unescape
from zoneinfo import ZoneInfo

import httpx

from backend.config import USER_AGENT
from backend.localities import locate
from backend.sources.base import ListingRecord


class LalpurjaSource:
    slug = "lalpurja-nepal"
    name = "Lalpurja Nepal"
    base_url = "https://lalpurjanepal.com.np"
    api_url = "https://api.lalpurjanepal.com.np/pms/public/api/v1/property/search"
    document_url = "https://api.lalpurjanepal.com.np/doc/file/get-file"
    email_pattern = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
    mobile_pattern = re.compile(r"(?<!\w)(?:\+?977[- .]?)?9[678]\d(?:[- .]?\d){7}(?!\w)")
    landline_pattern = re.compile(r"(?<!\w)(?:\+?977[- .]?)?0\d{1,2}[- .]?\d{6,7}(?!\w)")

    @staticmethod
    def _urn() -> str:
        now = datetime.now(ZoneInfo("Asia/Kathmandu"))
        return f"{now.year % 100:02d}{now.timetuple().tm_yday:03d}{now.second:02d}{now.microsecond // 1000:03d}{random.randrange(100000):05d}"

    @staticmethod
    def _slugify(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")

    @staticmethod
    def _clean_text(value: str | None) -> str:
        cleaned = re.sub(r"\s+", " ", unescape(value or "")).strip()
        cleaned = LalpurjaSource.email_pattern.sub("[email removed]", cleaned)
        cleaned = LalpurjaSource.mobile_pattern.sub("[phone removed]", cleaned)
        return LalpurjaSource.landline_pattern.sub("[phone removed]", cleaned)

    @staticmethod
    def _short_excerpt(value: str | None, length: int = 280) -> str:
        cleaned = LalpurjaSource._clean_text(value)
        if len(cleaned) <= length:
            return cleaned
        return f"{cleaned[: length - 1].rstrip()}…"

    @staticmethod
    def _price_label(value: int | None) -> str:
        if value is None:
            return "Price on request"
        if value >= 10_000_000:
            return f"रु {value / 10_000_000:.2f}".rstrip("0").rstrip(".") + " Cr"
        if value >= 100_000:
            return f"रु {value / 100_000:.2f}".rstrip("0").rstrip(".") + " Lakh"
        return f"रु {value:,}"

    @staticmethod
    def _area_label(item: dict[str, object]) -> str:
        area = item.get("area")
        unit = str(item.get("areaUnit") or "").upper()
        if area is None:
            return "Area on source"
        unit_label = {"SQ_FT": "sq ft", "SQ_M": "sq m"}.get(unit, unit.replace("_", " ").lower())
        try:
            amount = f"{float(area):,.2f}".rstrip("0").rstrip(".")
        except (TypeError, ValueError):
            amount = str(area)
        return f"{amount} {unit_label}".strip()

    @staticmethod
    def _property_type(value: str | None, title: str = "") -> str:
        key = f"{value or 'Property'} {title}".strip().lower()
        if "commercial" in key or "office" in key:
            return "Commercial"
        if "land" in key:
            return "Land"
        if "apartment" in key or "flat" in key:
            return "Apartment"
        if any(label in key for label in ("house", "housing", "bungalow", "villa")):
            return "House"
        return (value or "Property").strip().title()

    @staticmethod
    def _optional_int(value: object) -> int | None:
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError, OverflowError):
            return None

    @staticmethod
    def _quality_flags(item: dict[str, object], property_type: str) -> list[str]:
        flags: list[str] = []
        try:
            area = float(item["area"])
        except (KeyError, TypeError, ValueError, OverflowError):
            area = None
        if (
            area is not None
            and 0 < area < 100
            and str(item.get("areaUnit") or "").upper() == "SQ_FT"
            and property_type in {"House", "Apartment", "Commercial"}
        ):
            flags.append("area-unit-needs-verification")
        return flags

    def _record(self, item: dict[str, object]) -> ListingRecord | None:
        external_id = item.get("id")
        title = self._clean_text(str(item.get("propertyName") or ""))
        sold = str(item.get("isSold") or "").strip().lower() in {"1", "true", "yes", "sold"}
        if external_id is None or not title or sold:
            return None

        encoded_id = base64.b64encode(str(external_id).encode()).decode()
        source_url = f"{self.base_url}/property-details/{encoded_id}-{self._slugify(title)}"
        street_address = self._clean_text(str(item.get("streetAddress") or ""))
        locality = street_address.split("|")[0].strip() or street_address
        city = self._clean_text(str(item.get("areaName") or "Nepal"))
        point = locate(locality, city)
        media = item.get("mediaList") if isinstance(item.get("mediaList"), list) else []
        first_image = media[0] if media and isinstance(media[0], dict) else {}
        image_path = str(first_image.get("path") or "")
        asking_price = item.get("askingPrice")
        try:
            price = int(float(asking_price)) if asking_price is not None else None
        except (TypeError, ValueError):
            price = None
        purpose = "rent" if str(item.get("propertyPurpose") or "").upper() == "RENT" else "buy"
        property_type = self._property_type(str(item.get("propertyType") or ""), title)
        price_basis = "monthly" if purpose == "rent" else "per-aana" if property_type == "Land" else "total"
        price_suffix = " / mo" if price_basis == "monthly" and price else " / aana" if price_basis == "per-aana" and price else ""
        quality_flags = self._quality_flags(item, property_type)
        area_label = self._area_label(item)
        if "area-unit-needs-verification" in quality_flags:
            area_label += " · verify source unit"

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
            price_label=self._price_label(price) + price_suffix,
            location_name=" · ".join(part for part in (locality, city) if part),
            locality=locality,
            city=city,
            area_label=area_label,
            bedrooms=self._optional_int(item.get("bedrooms")),
            bathrooms=self._optional_int(item.get("bathroom")),
            description_excerpt=self._short_excerpt(str(item.get("description") or "")),
            image_url=f"{self.document_url}/{image_path}" if image_path else "",
            image_alt=f"{title}, source listing photograph",
            image_credit="Photograph from Lalpurja Nepal; rights remain with the original publisher.",
            latitude=point.latitude if point else None,
            longitude=point.longitude if point else None,
            location_precision=point.precision if point else "unknown",
            source_age_label=str(item.get("propertyAge") or "").strip(),
            raw_facts={
                "property_code": item.get("propertyCode"),
                "road_access": item.get("roadAccess"),
                "road_access_unit": item.get("roadAccessUnit"),
                "facing": item.get("propertyFace"),
                "floors": item.get("totalFloors"),
                "quality_flags": quality_flags,
            },
        )

    @staticmethod
    async def _search(client: httpx.AsyncClient, payload: dict[str, object]) -> dict[str, object]:
        for attempt in range(3):
            try:
                response = await client.post(LalpurjaSource.api_url, json=payload)
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict):
                    raise RuntimeError("Lalpurja returned a non-object response")
                return body
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500 or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.4 * (2**attempt))
        raise RuntimeError("Lalpurja request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        per_purpose = max(1, (limit + 1) // 2)
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "URN": self._urn(),
            "deviceId": "WEB",
        }
        records: list[ListingRecord] = []
        async with httpx.AsyncClient(timeout=25, follow_redirects=True, headers=headers) as client:
            for purpose in ("SELL", "RENT"):
                payload = {"data": {"size": per_purpose, "page": 1, "searchValue": "", "purpose": [purpose]}}
                body = await self._search(client, payload)
                if not body.get("success"):
                    raise RuntimeError(body.get("message") or "Lalpurja returned an unsuccessful response")
                content = ((body.get("data") or {}).get("content") or [])[:per_purpose]
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    try:
                        record = self._record(item)
                    except (TypeError, ValueError, OverflowError):
                        continue
                    if record:
                        records.append(record)
        return records[:limit]
