from __future__ import annotations

import asyncio
import math
import re
from html import unescape
from urllib.parse import urlparse

import httpx

from backend.config import USER_AGENT
from backend.localities import locate
from backend.sources.base import ListingRecord
from backend.sources.common import clean_text, short_excerpt


class GharBazarSource:
    """Bounded adapter for the JSON feed used by GharBazar's search page."""

    slug = "ghar-bazar"
    name = "GharBazar"
    base_url = "https://www.gharbazar.com"
    search_url = f"{base_url}/property/GetSearchProperties"
    records_per_page = 24
    max_records = 96
    max_pages = 5

    _clean_text = staticmethod(clean_text)

    @staticmethod
    def _safe_url(value: object, *, image: bool = False) -> str:
        url = str(value or "").strip()
        try:
            parsed = urlparse(url)
        except ValueError:
            return ""
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https":
            return ""
        if image:
            if host not in {"cdn.gharbazar.com", "www.gharbazar.com", "gharbazar.com"}:
                return ""
            if any(token in parsed.path.lower() for token in ("default-house", "house-clipart")):
                return ""
        elif host not in {"www.gharbazar.com", "gharbazar.com"} or not parsed.path.startswith(
            "/property/details/"
        ):
            return ""
        return url

    @staticmethod
    def _optional_positive_int(value: object) -> int | None:
        try:
            number = int(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return number if number > 0 else None

    @staticmethod
    def _number(value: object) -> float | None:
        try:
            number = float(str(value or "").strip())
        except (TypeError, ValueError, OverflowError):
            return None
        return number if math.isfinite(number) else None

    @classmethod
    def _coordinates(cls, item: dict[str, object]) -> tuple[float | None, float | None]:
        latitude = cls._number(item.get("latitude"))
        longitude = cls._number(item.get("longitude"))
        # A broad Nepal bounding box rejects zeroes and obviously misplaced pins.
        if latitude is None or longitude is None or not (26 <= latitude <= 31 and 80 <= longitude <= 89):
            return None, None
        return latitude, longitude

    @staticmethod
    def _price(value: object) -> int | None:
        label = re.sub(r"\s+", " ", unescape(str(value or ""))).strip().lower()
        if not label or any(token in label for token in ("on call", "on request", "n/a")):
            return None
        if re.search(r"\d(?:[\d., ]*)\s*/\s*\d", label):
            return None

        components = 0.0
        found_component = False
        for pattern, multiplier in (
            (r"(\d+(?:\.\d+)?)\s*(?:crore|crores|cr\.?)(?![a-z])", 10_000_000),
            (r"(\d+(?:\.\d+)?)\s*(?:lakh|lakhs|lac|lacs)(?![a-z])", 100_000),
            (r"(\d+(?:\.\d+)?)\s*(?:thousand|k)(?![a-z])", 1_000),
        ):
            matches = re.findall(pattern, label)
            if matches:
                components += sum(float(amount) * multiplier for amount in matches)
                found_component = True
        if found_component:
            return int(round(components)) or None

        match = re.search(r"(?:rs\.?|npr|रु)\s*([\d,]+(?:\.\d+)?)", label, re.IGNORECASE)
        if not match:
            return None
        try:
            amount = float(match.group(1).replace(",", ""))
        except ValueError:
            return None
        return int(round(amount)) or None

    @staticmethod
    def _property_type(value: object, title: str) -> str:
        text = f"{value or ''} {title}".lower()
        if re.search(r"\b(?:apartment|flat|penthouse)\b", text):
            return "Apartment"
        if re.search(r"\b(?:commercial|office|shop|store|business|cafe)\b", text):
            return "Commercial"
        if re.search(r"\b(?:land|plot|ghaderi)\b", text):
            return "Land"
        if re.search(r"\b(?:house|bungalow|villa|housing)\b", text):
            return "House"
        return str(value or "Property").strip().title() or "Property"

    @staticmethod
    def _city(location: str, title: str) -> str:
        combined = f"{location}, {title}".lower()
        for needle, city in (
            ("kathmandu", "Kathmandu"),
            ("lalitpur", "Lalitpur"),
            ("bhaktapur", "Bhaktapur"),
            ("pokhara", "Pokhara"),
            ("kaski", "Kaski"),
            ("chitwan", "Chitwan"),
            ("rupandehi", "Rupandehi"),
            ("sunsari", "Sunsari"),
            ("morang", "Morang"),
            ("kavre", "Kavre"),
        ):
            if needle in combined:
                return city
        parts = [part.strip() for part in location.split(",") if part.strip()]
        return parts[-1] if len(parts) > 1 else "Nepal"

    @staticmethod
    def _area_label(value: object) -> str:
        area = re.sub(r"\s+", " ", unescape(str(value or ""))).strip()
        if not area or area.lower() in {"n/a", "na", "0", "0-", "-"}:
            return "Area on source"
        if re.fullmatch(r"\d+(?:-\d+){2,3}", area):
            return f"Land area: {area}"
        return f"Area: {area}"

    @staticmethod
    def _price_basis(purpose: str, property_type: str, price_text: str) -> str:
        text = price_text.lower()
        if purpose == "rent":
            if "per day" in text or "/day" in text:
                return "daily"
            if "per year" in text or "annual" in text:
                return "yearly"
            if "per floor" in text:
                return "per-floor-monthly"
            return "monthly"
        if re.search(r"per\s+a(?:a)?n(?:a|na)|per\s+anna", text):
            return "per-aana"
        if "per ropani" in text:
            return "per-ropani"
        if "per kattha" in text:
            return "per-kattha"
        if "per dhur" in text:
            return "per-dhur"
        return "total" if property_type != "Land" else "total"

    def _record(self, item: dict[str, object]) -> ListingRecord | None:
        external_id = str(item.get("id") or "").strip()
        title = self._clean_text(item.get("headline"))
        source_url = self._safe_url(item.get("detail_url"))
        taken_tag = str(item.get("taken_tag") or "").lower()
        property_for = str(item.get("property_for") or "").strip().lower()
        # Sale/rent records provide only one price, so their price basis cannot be
        # represented truthfully by the application's buy/rent model.
        if (
            not external_id
            or not title
            or not source_url
            or any(token in taken_tag for token in ("sold", "rent", "taken"))
            or property_for not in {"sale", "rent"}
        ):
            return None

        purpose = "rent" if property_for == "rent" else "buy"
        location = self._clean_text(item.get("location"))
        city = self._city(location, title)
        parts = [part.strip() for part in location.split(",") if part.strip()]
        title_location = re.search(r"\b(?:at|in|near)\s+([^,]+)", title, re.IGNORECASE)
        locality = parts[0] if parts else self._clean_text(title_location.group(1) if title_location else title)
        fallback_point = locate(locality, city)
        latitude, longitude = self._coordinates(item)
        if latitude is not None and longitude is not None:
            precision = "source"
        elif fallback_point:
            latitude, longitude, precision = (
                fallback_point.latitude,
                fallback_point.longitude,
                fallback_point.precision,
            )
        else:
            precision = "unknown"

        property_type = self._property_type(item.get("property_type"), title)
        source_price = re.sub(r"\s+", " ", unescape(str(item.get("price") or ""))).strip()
        price_text = re.sub(r"\s+", " ", unescape(str(item.get("price_text") or ""))).strip()
        price = self._price(source_price or price_text)
        price_basis = self._price_basis(purpose, property_type, f"{source_price} {price_text}")
        price_label = source_price or "Price on request"
        if price_basis == "monthly" and price is not None and "month" not in price_label.lower():
            price_label += " / mo"

        description = f"{property_type} for {'rent' if purpose == 'rent' else 'sale'}"
        if location:
            description += f" in {location}"
        description += ". See the original listing for full details."

        return ListingRecord(
            id=f"{self.slug}:{external_id}",
            source_slug=self.slug,
            external_id=external_id,
            source_url=source_url,
            title=title,
            purpose=purpose,
            property_type=property_type,
            price_npr=price,
            price_basis=price_basis,
            price_label=price_label,
            location_name=location or " · ".join(part for part in (locality, city) if part),
            locality=locality,
            city=city,
            area_label=self._area_label(item.get("land_area")),
            bedrooms=self._optional_positive_int(item.get("bedrooms")),
            bathrooms=self._optional_positive_int(item.get("bathrooms")),
            description_excerpt=short_excerpt(description),
            image_url=self._safe_url(item.get("cover_image"), image=True),
            image_alt=f"{title}, source listing photograph",
            image_credit="Photograph from GharBazar; used in this private prototype with owner permission.",
            latitude=latitude,
            longitude=longitude,
            location_precision=precision,
            source_age_label=self._clean_text(item.get("updated_ago")),
            raw_facts={
                "living_rooms": self._optional_positive_int(item.get("livingrooms")),
                "kitchens": self._optional_positive_int(item.get("kitchens")),
                "negotiable": str(item.get("price_negotiable") or "") == "1",
                "source_property_type": self._clean_text(item.get("property_type")),
                "source_price_text": price_text,
            },
        )

    @staticmethod
    async def _page(client: httpx.AsyncClient, offset: int) -> dict[str, object]:
        params = {
            "_vt": 0,
            "_q": "",
            "_r": 0,
            "_pt": "both",
            "_srt": "latest",
            "_si": 0,
            "offset": offset,
            "useoffset": "true",
        }
        for attempt in range(3):
            try:
                response = await client.get(GharBazarSource.search_url, params=params)
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict):
                    raise RuntimeError("GharBazar returned a non-object response")
                if str(body.get("status") or "").lower() != "ok":
                    raise RuntimeError(str(body.get("message") or "GharBazar returned an unsuccessful response"))
                return body
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500 or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.4 * (2**attempt))
        raise RuntimeError("GharBazar request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        requested = max(1, min(int(limit), self.max_records))
        page_count = min(self.max_pages, max(1, math.ceil(requested / self.records_per_page) + 1))
        records: list[ListingRecord] = []
        seen: set[str] = set()
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
            for offset in range(page_count):
                body = await self._page(client, offset)
                items = body.get("data")
                if not isinstance(items, list) or not items:
                    break
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    try:
                        record = self._record(item)
                    except (TypeError, ValueError, OverflowError):
                        continue
                    if record and record.external_id not in seen:
                        records.append(record)
                        seen.add(record.external_id)
                    if len(records) >= requested:
                        return records
        return records
