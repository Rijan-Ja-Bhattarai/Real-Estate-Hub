from __future__ import annotations

import asyncio
import math
import re
from html import unescape
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup, Tag

from backend.config import USER_AGENT
from backend.localities import locate
from backend.sources.base import ListingRecord
from backend.sources.common import clean_text, short_excerpt


class KantipurRealEstateSource:
    """Bounded adapter for Kantipur Real Estate's public property index."""

    slug = "kantipur-real-estate"
    name = "Kantipur Real Estate"
    base_url = "https://www.kantipurrealestate.com"
    property_url = f"{base_url}/property"
    max_records = 96
    max_response_bytes = 2_500_000

    _clean_text = staticmethod(clean_text)

    @staticmethod
    def _plain_text(value: object) -> str:
        return re.sub(r"\s+", " ", unescape(str(value or ""))).strip()

    @staticmethod
    def _safe_url(value: object, *, image: bool = False) -> str:
        url = str(value or "").strip()
        try:
            parsed = urlparse(url)
        except ValueError:
            return ""
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or host not in {"www.kantipurrealestate.com", "kantipurrealestate.com"}:
            return ""
        if image:
            return url if parsed.path.startswith("/storage/products/") else ""
        return url if parsed.path.startswith("/property/") else ""

    @staticmethod
    def _optional_positive_int(value: object) -> int | None:
        match = re.search(r"\d+", str(value or ""))
        if not match:
            return None
        number = int(match.group())
        return number if number > 0 else None

    @staticmethod
    def _price(value: str) -> tuple[int | None, list[str]]:
        label = value.lower()
        quality_flags: list[str] = []
        if not label or any(token in label for token in ("आपसी", "on call", "on request", "n/a")):
            return None, quality_flags
        # A slash between two amounts is an advertised range. Retain the source
        # label, but do not invent a single sortable value.
        if re.search(r"\d(?:[\d., ]*)\s*/\s*\d", label):
            return None, ["ambiguous-price-range"]

        total = 0.0
        found_component = False
        for pattern, multiplier in (
            (r"(\d+(?:\.\d+)?)\s*(?:crore|crores|cr\.?)(?![a-z])", 10_000_000),
            (r"(\d+(?:\.\d+)?)\s*(?:lakh|lakhs|lac|lacs)(?![a-z])", 100_000),
            (r"(\d+(?:\.\d+)?)\s*(?:thousand|k)(?![a-z])", 1_000),
        ):
            matches = re.findall(pattern, label)
            if matches:
                total += sum(float(amount) * multiplier for amount in matches)
                found_component = True
        if found_component:
            value_npr = int(round(total))
        else:
            match = re.search(r"(?:rs\.?|npr|रु)\s*([\d,]+(?:\.\d+)?)", label, re.IGNORECASE)
            if not match:
                return None, quality_flags
            try:
                value_npr = int(round(float(match.group(1).replace(",", ""))))
            except ValueError:
                return None, quality_flags
        if value_npr <= 0:
            return None, quality_flags
        if value_npr >= 2_000_000_000:
            quality_flags.append("unusually-high-source-price")
        return value_npr, quality_flags

    @staticmethod
    def _price_basis(purpose: str, label: str) -> str:
        text = label.lower()
        if purpose == "rent":
            if "per day" in text or "/day" in text:
                return "daily"
            if "per year" in text or "annual" in text:
                return "yearly"
            if "per floor" in text:
                return "per-floor-monthly"
            return "monthly"
        if re.search(r"p(?:e|a)r\s+a(?:a)?n(?:a|na)|per\s+anna|peraana", text):
            return "per-aana"
        if "per ropani" in text:
            return "per-ropani"
        if "per kattha" in text:
            return "per-kattha"
        if "per dhur" in text:
            return "per-dhur"
        if "per house" in text:
            return "per-house"
        return "total"

    @staticmethod
    def _property_type(title: str, listed_type: str) -> str:
        text = f"{title} {listed_type}".lower()
        if any(token in text for token in ("apartment", "flat", "penthouse")):
            return "Apartment"
        if any(token in text for token in ("land", "plot", "ghaderi")):
            return "Land"
        if any(token in text for token in ("house", "bungalow", "bunglow", "villa", "housing")):
            return "House"
        if any(token in text for token in ("commercial", "office", "shop", "business")):
            return "Commercial"
        return "Property"

    @staticmethod
    def _city(location: str, title: str) -> str:
        combined = f"{location}, {title}".lower()
        for needle, city in (
            ("lalitpur", "Lalitpur"),
            ("patan", "Lalitpur"),
            ("pulchowk", "Lalitpur"),
            ("pulchwok", "Lalitpur"),
            ("tikathali", "Lalitpur"),
            ("imadol", "Lalitpur"),
            ("imadole", "Lalitpur"),
            ("bhaisepati", "Lalitpur"),
            ("khumaltar", "Lalitpur"),
            ("hattiban", "Lalitpur"),
            ("godawari", "Lalitpur"),
            ("lubhu", "Lalitpur"),
            ("lele", "Lalitpur"),
            ("bungamati", "Lalitpur"),
            ("thecho", "Lalitpur"),
            ("harisiddhi", "Lalitpur"),
            ("lamatar", "Lalitpur"),
            ("bhaktapur", "Bhaktapur"),
            ("bhaktpur", "Bhaktapur"),
            ("tathali", "Bhaktapur"),
            ("suryabinayak", "Bhaktapur"),
            ("surabinayak", "Bhaktapur"),
            ("duwakot", "Bhaktapur"),
            ("sallaghari", "Bhaktapur"),
            ("sipadol", "Bhaktapur"),
            ("changunarayan", "Bhaktapur"),
            ("thimi", "Bhaktapur"),
            ("balkot", "Bhaktapur"),
            ("jhaukhel", "Bhaktapur"),
            ("pokhara", "Pokhara"),
            ("chitwan", "Chitwan"),
            ("bharatpur", "Chitwan"),
            ("rupandehi", "Rupandehi"),
            ("kathmandu", "Kathmandu"),
        ):
            if needle in combined:
                return city
        kathmandu_localities = (
            "gokarneshwor", "basbari", "bansbari", "budhanilkantha", "raniban", "ramhiti",
            "balkhu", "dhungedhara", "thankot", "bouddha", "boudha", "tokha", "jorpati",
            "nayapati", "gokarna", "narayantar", "hadigaun", "gongabu", "syuchatar",
            "sitapaila", "balaju", "basundhara", "kalanki", "anamnagar", "baneshwor",
            "soyambhu", "swayambhu", "bafal", "kirtipur", "chabahil", "koteshwor",
        )
        if any(locality in combined for locality in kathmandu_localities):
            return "Kathmandu"
        return "Nepal"

    @staticmethod
    def _field(card: Tag, selector: str) -> str:
        element = card.select_one(selector)
        return element.get_text(" ", strip=True) if element else ""

    @classmethod
    def _facts(cls, card: Tag) -> dict[str, str]:
        facts: dict[str, str] = {}
        for item in card.select(".address-list li"):
            text = item.get_text(" ", strip=True)
            key, separator, value = text.partition(":")
            if separator:
                facts[key.strip().lower()] = cls._clean_text(value)
        return facts

    def _record(self, card: Tag) -> ListingRecord | None:
        status = self._clean_text(self._field(card, ".listing-sale")).lower()
        if status not in {"for sale", "for rent"}:
            return None
        purpose = "rent" if status == "for rent" else "buy"

        link = card.select_one(".image-title a[href]")
        image = card.select_one(".property-image img[src]")
        source_url = self._safe_url(link.get("href") if link else "")
        image_url = self._safe_url(image.get("src") if image else "", image=True)
        title = self._clean_text(link.get_text(" ", strip=True) if link else self._field(card, ".image-title"))
        facts = self._facts(card)
        code = self._clean_text(facts.get("code"))
        external_id = re.sub(r"[^A-Za-z0-9_-]+", "-", code).strip("-").lower()
        if not external_id and source_url:
            external_id = urlparse(source_url).path.rstrip("/").rsplit("/", 1)[-1]
        if not source_url or not title or not external_id:
            return None

        locality = self._clean_text(facts.get("address"))
        if not locality:
            locality = self._clean_text(re.sub(r"^(?:house|land|plot|apartment)\s+(?:for\s+)?(?:sale|rent)?\s*at\s*", "", title, flags=re.I))
        city = self._city(locality, title)
        point = locate(locality, city)
        listed_type = self._clean_text(facts.get("type"))
        property_type = self._property_type(title, listed_type)

        source_price = self._plain_text(self._field(card, ".property-price"))
        price, quality_flags = self._price(source_price)
        price_basis = self._price_basis(purpose, source_price)
        price_label = source_price if price is not None or "ambiguous-price-range" in quality_flags else "Price on request"

        area_text = self._clean_text(self._field(card, ".area-section"))
        area_text = re.sub(r"^Land\s+Area\s*:\s*", "", area_text, flags=re.IGNORECASE).strip()
        area_label = f"Land area: {area_text}" if area_text and area_text.lower() != "n/a" else "Area on source"
        facilities = [self._clean_text(item.get_text(" ", strip=True)) for item in card.select(".facility-icons li")]
        bedrooms = self._optional_positive_int(facilities[0]) if facilities else None
        bathrooms = self._optional_positive_int(facilities[3]) if len(facilities) >= 4 else None

        description = f"{property_type} for {'rent' if purpose == 'rent' else 'sale'}"
        if locality:
            description += f" in {locality}"
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
            location_name=" · ".join(part for part in (locality, city) if part),
            locality=locality,
            city=city,
            area_label=area_label,
            bedrooms=bedrooms,
            bathrooms=bathrooms,
            description_excerpt=short_excerpt(description),
            image_url=image_url,
            image_alt=f"{title}, source listing photograph",
            image_credit="Photograph from Kantipur Real Estate; used in this private prototype with owner permission.",
            latitude=point.latitude if point else None,
            longitude=point.longitude if point else None,
            location_precision=point.precision if point else "unknown",
            source_age_label="",
            raw_facts={
                "listing_code": code,
                "listed_type": listed_type,
                "living_rooms": self._optional_positive_int(facilities[1]) if len(facilities) >= 2 else None,
                "kitchens": self._optional_positive_int(facilities[2]) if len(facilities) >= 3 else None,
                "source_price_label": source_price,
                "quality_flags": quality_flags,
            },
        )

    @classmethod
    async def _html(cls, client: httpx.AsyncClient, target_cards: int) -> bytes:
        for attempt in range(3):
            try:
                chunks: list[bytes] = []
                byte_count = 0
                card_count = 0
                extra_chunks = 0
                marker_tail = b""
                marker = b'class="card"'
                async with client.stream("GET", cls.property_url) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes(chunk_size=32_768):
                        byte_count += len(chunk)
                        if byte_count > cls.max_response_bytes:
                            raise RuntimeError("Kantipur property response exceeded the adapter size limit")
                        chunks.append(chunk)
                        combined = marker_tail + chunk
                        card_count += combined.count(marker)
                        marker_tail = combined[-(len(marker) - 1) :]
                        if card_count >= target_cards:
                            extra_chunks += 1
                            if extra_chunks >= 2:
                                break
                return b"".join(chunks)
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500 or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.4 * (2**attempt))
        raise RuntimeError("Kantipur request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        requested = max(1, min(int(limit), self.max_records))
        target_cards = max(24, requested * 3)
        headers = {"Accept": "text/html,application/xhtml+xml", "User-Agent": USER_AGENT}
        async with httpx.AsyncClient(timeout=25, follow_redirects=True, headers=headers) as client:
            html = await self._html(client, target_cards)

        soup = BeautifulSoup(html, "html.parser")
        records: list[ListingRecord] = []
        seen: set[str] = set()
        for card in soup.select("div.card"):
            try:
                record = self._record(card)
            except (TypeError, ValueError, OverflowError):
                continue
            if record and record.external_id not in seen:
                records.append(record)
                seen.add(record.external_id)
            if len(records) >= requested:
                break
        return records
