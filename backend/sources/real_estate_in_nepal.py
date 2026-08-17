from __future__ import annotations

import asyncio
import re

import httpx
from bs4 import BeautifulSoup, Tag

from backend.config import USER_AGENT
from backend.localities import locate
from backend.sources.base import ListingRecord
from backend.sources.common import absolute_url, clean_text, format_npr, infer_property_type, parse_npr


class RealEstateInNepalSource:
    """Bounded adapter for current Real Estate in Nepal sale/rent indexes."""

    slug = "real-estate-in-nepal"
    name = "Real Estate in Nepal"
    base_url = "https://realestateinnepal.com"
    index_urls = {
        "buy": f"{base_url}/category/for-sale/",
        "rent": f"{base_url}/category/for-rent/",
    }
    max_records = 24
    max_response_bytes = 2_000_000

    @staticmethod
    def _purpose(title: str, source_url: str, badge: str, default: str) -> str:
        text = clean_text(f"{title} {source_url}").lower()
        has_rent = bool(re.search(r"\b(?:rent|rental|lease|let)\b", text))
        has_sale = bool(re.search(r"\b(?:sale|sell)\b", text))
        if has_rent and not has_sale:
            return "rent"
        if has_sale and not has_rent:
            return "buy"
        return "rent" if "rent" in badge.lower() else default

    @staticmethod
    def _price_basis(price_text: str, purpose: str) -> str:
        text = price_text.lower()
        if re.search(r"(?:per|/)\s*(?:aana|anna)|-\s*(?:aana|anna)", text):
            return "per-aana"
        if re.search(r"(?:per|/)\s*ropani|-\s*ropani", text):
            return "per-ropani"
        if re.search(r"(?:per|/)\s*(?:sq\.?\s*ft|sqft|square\s*feet)", text):
            return "per-sq-ft"
        if "month" in text:
            return "monthly"
        return "monthly" if purpose == "rent" else "total"

    @staticmethod
    def _price(price_text: str) -> int | None:
        lowered = price_text.lower()
        if not price_text or "$" in price_text or "call" in lowered or "c,all" in lowered:
            return None
        parsed = parse_npr(price_text)
        return parsed if parsed and parsed > 0 else None

    @staticmethod
    def _area_label(value: str) -> str:
        compact = re.sub(r"\s+", "", value)
        parts = compact.split("-")
        if len(parts) != 4:
            return clean_text(value) or "Area on source"
        labels = ("ropani", "aana", "paisa", "daam")
        shown: list[str] = []
        for part, label in zip(parts, labels, strict=True):
            try:
                amount = float(part)
            except ValueError:
                return clean_text(value) or "Area on source"
            if amount:
                shown.append(f"{amount:g} {label}")
        return " ".join(shown) if shown else "Area on source"

    @staticmethod
    def _icon_value(article: Tag, icon_class: str) -> str:
        icon = article.select_one(f".{icon_class}")
        return clean_text(icon.parent.get_text(" ", strip=True)) if icon and isinstance(icon.parent, Tag) else ""

    @classmethod
    def _record(cls, article: Tag, default_purpose: str) -> ListingRecord | None:
        root = article.find(id=re.compile(r"^property-id-\d+$"))
        title_link = article.select_one(".locationko h4 a")
        if not isinstance(root, Tag) or not isinstance(title_link, Tag):
            return None

        id_match = re.search(r"property-id-(\d+)", clean_text(root.get("id")))
        title = clean_text(title_link.get_text(" ", strip=True))
        source_url = absolute_url(cls.base_url, title_link.get("href"))
        if not id_match or not title or not source_url:
            return None
        lowered_title = title.lower()
        if "sold out" in lowered_title or "rented out" in lowered_title:
            return None

        location_node = article.select_one(".locationko")
        raw_location = clean_text(location_node.get_text(" ", strip=True)) if location_node else ""
        location_text = clean_text(raw_location[len(title) :]) if raw_location.startswith(title) else raw_location
        location_parts = [clean_text(part) for part in location_text.split(",") if clean_text(part)]
        locality = location_parts[0] if location_parts else "Nepal"
        city = location_parts[-1] if len(location_parts) > 1 else "Nepal"
        point = locate(locality, city)

        badge_node = article.select_one(".forsal")
        badge = clean_text(badge_node.get_text(" ", strip=True)) if badge_node else ""
        purpose = cls._purpose(title, source_url, badge, default_purpose)
        property_type = infer_property_type(title, source_url)
        if property_type == "Property" and re.search(r"\b(?:commer\w*|office|space|shop)\b", lowered_title):
            property_type = "Commercial"

        price_node = next(
            (node for node in article.find_all("h4") if clean_text(node.get_text(" ", strip=True)).lower().startswith("nrs")),
            None,
        )
        price_text = clean_text(price_node.get_text(" ", strip=True)) if isinstance(price_node, Tag) else ""
        price_basis = cls._price_basis(price_text, purpose)
        price = cls._price(price_text)

        image_node = article.select_one("figure img")
        image_url = ""
        if isinstance(image_node, Tag):
            image_url = absolute_url(cls.base_url, image_node.get("data-src") or image_node.get("src"))

        metadata_node = article.find("small")
        metadata = clean_text(metadata_node.get_text(" ", strip=True)) if isinstance(metadata_node, Tag) else ""
        code_match = re.search(r"Code\s+([A-Za-z0-9-]+)", metadata, re.IGNORECASE)
        posted_match = re.search(r"Posted\s+in\s+(.+)$", metadata, re.IGNORECASE)
        external_id = code_match.group(1).upper() if code_match else f"NRES-{id_match.group(1)}"

        area_text = cls._icon_value(article, "icon-landarea")
        bedroom_text = cls._icon_value(article, "icon-bed")
        bedroom_match = re.search(r"(-?\d+)\s*Bed", bedroom_text, re.IGNORECASE)
        bedrooms = int(bedroom_match.group(1)) if bedroom_match and int(bedroom_match.group(1)) >= 0 else None
        views_node = article.select_one(".views")
        views_match = re.search(r"([\d,]+)", clean_text(views_node.get_text(" ", strip=True))) if views_node else None

        price_label = "Foreign-currency price on source" if "$" in price_text else format_npr(price, price_basis)
        return ListingRecord(
            id=f"{cls.slug}:{external_id}",
            source_slug=cls.slug,
            external_id=external_id,
            source_url=source_url,
            title=title,
            purpose=purpose,
            property_type=property_type,
            price_npr=price,
            price_basis=price_basis,
            price_label=price_label,
            location_name=" · ".join(location_parts) if location_parts else location_text,
            locality=locality,
            city=city,
            area_label=cls._area_label(area_text),
            bedrooms=bedrooms,
            bathrooms=None,
            description_excerpt="",
            image_url=image_url,
            image_alt=f"{title}, source listing photograph",
            image_credit="Photograph from Real Estate in Nepal; rights remain with the original publisher.",
            latitude=point.latitude if point else None,
            longitude=point.longitude if point else None,
            location_precision=point.precision if point else "unknown",
            source_age_label=f"Posted {posted_match.group(1)}" if posted_match else "",
            raw_facts={
                "source_code": external_id,
                "source_price_text": price_text,
                "published_label": posted_match.group(1) if posted_match else "",
                "views": int(views_match.group(1).replace(",", "")) if views_match else None,
            },
        )

    @classmethod
    def _records_from_html(cls, html: str, default_purpose: str, limit: int) -> list[ListingRecord]:
        soup = BeautifulSoup(html, "html.parser")
        records: list[ListingRecord] = []
        for article in soup.find_all("article"):
            if not isinstance(article, Tag):
                continue
            try:
                record = cls._record(article, default_purpose)
            except (TypeError, ValueError, OverflowError):
                continue
            if record:
                records.append(record)
            if len(records) >= limit:
                break
        return records

    @classmethod
    async def _request(cls, client: httpx.AsyncClient, url: str) -> str:
        for attempt in range(3):
            try:
                response = await client.get(url)
                response.raise_for_status()
                if len(response.content) > cls.max_response_bytes:
                    raise RuntimeError("Real Estate in Nepal response exceeded the adapter size limit")
                return response.text
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500 or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.4 * (2**attempt))
        raise RuntimeError("Real Estate in Nepal request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        bounded_limit = min(max(int(limit), 1), self.max_records)
        sale_quota = (bounded_limit + 1) // 2
        rent_quota = max(1, bounded_limit - sale_quota)
        headers = {"Accept": "text/html,application/xhtml+xml", "User-Agent": USER_AGENT}
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
            sale_html, rent_html = await asyncio.gather(
                self._request(client, self.index_urls["buy"]),
                self._request(client, self.index_urls["rent"]),
            )
        sale_records = self._records_from_html(sale_html, "buy", sale_quota)
        rent_records = self._records_from_html(rent_html, "rent", rent_quota)
        records: list[ListingRecord] = []
        seen: set[str] = set()
        for record in (*sale_records, *rent_records):
            if record.id in seen:
                continue
            seen.add(record.id)
            records.append(record)
        return records[:bounded_limit]
