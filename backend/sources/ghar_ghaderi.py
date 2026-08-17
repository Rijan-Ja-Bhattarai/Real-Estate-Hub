from __future__ import annotations

import asyncio
import re

import httpx
from bs4 import BeautifulSoup, Tag

from backend.config import USER_AGENT
from backend.localities import locate
from backend.sources.base import ListingRecord
from backend.sources.common import absolute_url, clean_text, format_npr, infer_property_type


class GharGhaderiSource:
    """Bounded adapter for GharGhaderi's canonical latest-listing indexes."""

    slug = "ghar-ghaderi"
    name = "GharGhaderi"
    base_url = "https://www.gharghaderi.com"
    index_urls = (
        f"{base_url}/house-for-sale/?sort=latest",
        f"{base_url}/land-for-sale/?sort=latest",
        f"{base_url}/rent/?sort=latest",
    )
    max_records = 24
    max_response_bytes = 1_000_000

    @staticmethod
    def _parse_price(value: str) -> int | None:
        text = clean_text(value).lower().replace(",", "")
        if not text or "call" in text or "$" in text:
            return None

        multipliers = (
            (r"(\d+(?:\.\d+)?)\s*(?:crore|cr)\b", 10_000_000),
            (r"(\d+(?:\.\d+)?)\s*(?:lakh|lakhs|lac|lacs)\b", 100_000),
            (r"(\d+(?:\.\d+)?)\s*(?:thousand|thousands)\b", 1_000),
        )
        total = 0.0
        found_unit = False
        for pattern, multiplier in multipliers:
            match = re.search(pattern, text)
            if match:
                total += float(match.group(1)) * multiplier
                found_unit = True
        if found_unit:
            return int(total) if total > 0 else None

        numeric = re.search(r"(?:रु|रू|rs\.?|npr)?\s*(\d+(?:\.\d+)?)", text)
        if not numeric:
            return None
        parsed = int(float(numeric.group(1)))
        return parsed if parsed > 0 else None

    @staticmethod
    def _price_basis(price_text: str, purpose: str) -> str:
        text = price_text.lower()
        if re.search(r"(?:per|/)\s*(?:aana|anna)", text):
            return "per-aana"
        if re.search(r"(?:per|/)\s*ropani", text):
            return "per-ropani"
        if re.search(r"(?:per|/)\s*(?:kattha|katha)", text):
            return "per-kattha"
        if re.search(r"(?:per|/)\s*dhur", text):
            return "per-dhur"
        if re.search(r"(?:per\s*)?(?:sq\.?\s*ft|sqft|square\s*feet)\b", text):
            return "per-sq-ft"
        if "month" in text:
            return "monthly"
        return "monthly" if purpose == "rent" else "total"

    @staticmethod
    def _area_label(grid: Tag) -> tuple[str, str]:
        area_node = grid.select_one(".land")
        if not isinstance(area_node, Tag):
            return "Area on source", ""
        road_and_area = clean_text(area_node.get_text(" ", strip=True))
        first_value = area_node.find("span")
        area = clean_text(first_value.get_text(" ", strip=True)) if isinstance(first_value, Tag) else ""
        if area and not re.search(r"[A-Za-z]", area):
            area = f"{area} · source unit"
        return area or "Area on source", road_and_area

    @classmethod
    def _record(cls, link: Tag) -> ListingRecord | None:
        grid = link.find("div", class_="grid-item", recursive=False)
        href = clean_text(link.get("href"))
        id_match = re.search(r"/(?:house|land|flat|office|apartment)/([0-9]+)(?:-|/)", href, re.IGNORECASE)
        if not isinstance(grid, Tag) or not id_match:
            return None
        sold_node = grid.select_one(".sold")
        if sold_node and clean_text(sold_node.get_text(" ", strip=True)):
            return None

        image_node = grid.select_one(".image img")
        title = clean_text(image_node.get("alt")) if isinstance(image_node, Tag) else ""
        if not title:
            return None
        lowered_title = title.lower()
        if "sold out" in lowered_title or "rented out" in lowered_title:
            return None

        purpose_node = grid.select_one(".loc")
        purpose_text = clean_text(purpose_node.get_text(" ", strip=True)).lower() if purpose_node else ""
        purpose = "rent" if purpose_text == "rent" or re.search(r"\b(?:rent|rental|lease)\b", lowered_title) else "buy"
        property_type = infer_property_type(title, href)

        price_node = grid.select_one(".title")
        price_text = clean_text(price_node.get_text(" ", strip=True)) if price_node else ""
        price_basis = cls._price_basis(price_text, purpose)
        price = cls._parse_price(price_text)
        area_label, road_and_area = cls._area_label(grid)

        location_node = grid.select_one(".road")
        location_text = clean_text(location_node.get_text(" ", strip=True)) if location_node else "Nepal"
        location_parts = [clean_text(part) for part in location_text.split(",") if clean_text(part)]
        locality = location_parts[0] if location_parts else location_text
        city = location_parts[-1] if len(location_parts) > 1 else "Nepal"
        point = locate(locality, city)

        source_url = absolute_url(cls.base_url, href)
        image_url = ""
        if isinstance(image_node, Tag):
            image_url = absolute_url(cls.base_url, image_node.get("data-src") or image_node.get("src"))
        external_id = id_match.group(1)
        featured_node = grid.select_one(".featured")

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
            price_label=format_npr(price, price_basis),
            location_name=" · ".join(location_parts) if location_parts else location_text,
            locality=locality,
            city=city,
            area_label=area_label,
            bedrooms=None,
            bathrooms=None,
            description_excerpt="",
            image_url=image_url,
            image_alt=f"{title}, source listing photograph",
            image_credit="Photograph from GharGhaderi; rights remain with the original publisher.",
            latitude=point.latitude if point else None,
            longitude=point.longitude if point else None,
            location_precision=point.precision if point else "unknown",
            source_age_label="",
            raw_facts={
                "source_price_text": price_text,
                "road_and_area": road_and_area,
                "category_path": href.split("/", 2)[1] if href.startswith("/") else "",
                "featured": bool(featured_node and clean_text(featured_node.get_text(" ", strip=True))),
            },
        )

    @classmethod
    def _records_from_html(cls, html: str, limit: int) -> list[ListingRecord]:
        soup = BeautifulSoup(html, "html.parser")
        records: list[ListingRecord] = []
        for link in soup.find_all("a", href=True):
            if not isinstance(link, Tag):
                continue
            try:
                record = cls._record(link)
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
                    raise RuntimeError("GharGhaderi response exceeded the adapter size limit")
                return response.text
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500 or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.4 * (2**attempt))
        raise RuntimeError("GharGhaderi request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        bounded_limit = min(max(int(limit), 1), self.max_records)
        base_quota, remainder = divmod(bounded_limit, len(self.index_urls))
        quotas = [base_quota + (1 if index < remainder else 0) for index in range(len(self.index_urls))]
        active = [(url, quota) for url, quota in zip(self.index_urls, quotas, strict=True) if quota]
        headers = {"Accept": "text/html,application/xhtml+xml", "User-Agent": USER_AGENT}
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
            pages = await asyncio.gather(*(self._request(client, url) for url, _ in active))

        records: list[ListingRecord] = []
        seen: set[str] = set()
        for page, (_, quota) in zip(pages, active, strict=True):
            for record in self._records_from_html(page, quota):
                if record.id in seen:
                    continue
                seen.add(record.id)
                records.append(record)
        return records[:bounded_limit]
