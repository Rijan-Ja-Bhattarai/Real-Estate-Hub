from __future__ import annotations

import asyncio
import json
import re
from urllib.parse import quote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

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


class GharSansarSource:
    """Bounded Ghar Sansar collection and detail-page adapter."""

    slug = "ghar-sansar-nepal"
    name = "Ghar Sansar Nepal"
    base_url = "https://www.gharsansarnepal.com"
    index_urls = {
        "buy": f"{base_url}/buy-properties-in-nepal",
        "rent": f"{base_url}/gharsansar/nepal/rent",
    }
    max_detail_requests = 16

    @staticmethod
    def _source_url(value: object) -> str:
        url = urljoin(f"{GharSansarSource.base_url}/", clean_text(value))
        parsed = urlparse(url)
        if parsed.hostname not in {"gharsansarnepal.com", "www.gharsansarnepal.com"}:
            return ""
        if not re.search(r"/\d+/?$", parsed.path):
            return ""
        return url

    @staticmethod
    def _image_url(value: object) -> str:
        url = urljoin(f"{GharSansarSource.base_url}/", clean_text(value))
        parsed = urlparse(url)
        if parsed.hostname not in {"gharsansarnepal.com", "www.gharsansarnepal.com"}:
            return ""
        return quote(url, safe=":/?=&%")

    @classmethod
    def _cards(cls, html: str, purpose: str) -> list[dict[str, str]]:
        soup = BeautifulSoup(html, "html.parser")
        records: list[dict[str, str]] = []
        seen: set[str] = set()
        for card in soup.select(".explore-item"):
            anchor = card.select_one(".explore-item-title a[href]")
            if anchor is None:
                continue
            source_url = cls._source_url(anchor.get("href"))
            if not source_url or source_url in seen:
                continue
            title = clean_text(anchor.get_text(" "))
            if not title:
                continue
            image = card.select_one(".item-img img[src]")
            price_node = card.select_one(".price-details span") or card.select_one(".item-details ins")
            records.append(
                {
                    "source_url": source_url,
                    "title": title,
                    "image_url": cls._image_url(image.get("src")) if image else "",
                    "price": clean_text(price_node.get_text(" ")) if price_node else "",
                    "purpose": purpose,
                }
            )
            seen.add(source_url)
        return records

    @staticmethod
    def _json_ld(soup: BeautifulSoup) -> dict[str, object]:
        for node in soup.select('script[type="application/ld+json"]'):
            try:
                data = json.loads(node.string or node.get_text())
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            candidates = data if isinstance(data, list) else [data]
            for candidate in candidates:
                if isinstance(candidate, dict) and str(candidate.get("@type", "")).lower() in {
                    "product",
                    "house",
                    "residence",
                    "apartment",
                }:
                    return candidate
        return {}

    @staticmethod
    def _known_detail(soup: BeautifulSoup, label: str) -> str:
        pattern = re.compile(rf"\b{re.escape(label)}\s*:\s*(.+)", re.IGNORECASE)
        for node in soup.select(".contact-list li"):
            text = clean_text(node.get_text(" "))
            match = pattern.search(text)
            if match:
                return clean_text(match.group(1))
        return ""

    @staticmethod
    def _city(*values: object) -> str:
        text = " ".join(clean_text(value).lower() for value in values)
        for city in (
            "Kathmandu",
            "Lalitpur",
            "Bhaktapur",
            "Pokhara",
            "Chitwan",
            "Kavre",
            "Nuwakot",
        ):
            if city.lower() in text:
                return city
        return "Nepal"

    @staticmethod
    def _price(value: str) -> int | None:
        text = clean_text(value)
        if re.search(r"\d\s*(?:-|to)\s*\d", text, re.IGNORECASE):
            return None
        compact_lakh = re.search(r"(\d+(?:\.\d+)?)\s*l\b", text, re.IGNORECASE)
        if compact_lakh:
            return int(float(compact_lakh.group(1)) * 100_000)
        return parse_npr(text)

    @staticmethod
    def _locality(location: str, title: str, city: str) -> str:
        combined = f"{location} {title}".lower()
        # Keep the source's human-readable location, but prefer a recognizable
        # named part over generic phrases such as "Prime Location".
        for name in (
            "Basundhara",
            "Bhaisepati",
            "Budhanilkantha",
            "Chapali",
            "Chabahil",
            "Dholahiti",
            "Duwakot",
            "Gothatar",
            "Imadol",
            "Jorpati",
            "Koteshwor",
            "Kuleshwor",
            "Lazimpat",
            "Lubhu",
            "Mulpani",
            "Pepsicola",
            "Sanepa",
            "Sitapaila",
            "Tokha",
            "Chakrapath",
            "Bhatbhateni",
            "Maharajgunj",
            "Swoyambhu",
            "Raniban",
            "Kalanki",
        ):
            if name.lower() in combined:
                return name
        candidate = clean_text(location.split(",", 1)[0])
        if candidate and candidate.lower() not in {"prime location", "location", "nepal"}:
            return candidate
        return city if city != "Nepal" else "Location on source"

    @classmethod
    def _record(cls, card: dict[str, str], detail_html: str = "") -> ListingRecord | None:
        source_url = card["source_url"]
        external_match = re.search(r"/(\d+)/?$", source_url)
        if not external_match:
            return None
        external_id = external_match.group(1)

        soup = BeautifulSoup(detail_html, "html.parser") if detail_html else BeautifulSoup("", "html.parser")
        structured = cls._json_ld(soup)
        title = clean_text(structured.get("name")) or card["title"]
        raw_price = card["price"]
        offers = structured.get("offers") if isinstance(structured.get("offers"), dict) else {}
        if not raw_price:
            raw_price = clean_text(offers.get("price"))
        purpose = card["purpose"]
        property_type = infer_property_type(source_url, title)
        price = cls._price(raw_price)
        price_basis = infer_price_basis(raw_price, purpose, property_type)
        if property_type == "Land" and purpose == "buy" and not re.search(
            r"(?:/|per\s*)(?:aana|anna)\b", raw_price, re.IGNORECASE
        ):
            price_basis = "total"

        address = structured.get("address") if isinstance(structured.get("address"), dict) else {}
        location = clean_text(address.get("streetAddress"))
        if not location:
            location_node = soup.select_one(".overview-sub-title h5")
            location = clean_text(location_node.get_text(" ") if location_node else "")
            location = re.sub(r"^location\s*:\s*", "", location, flags=re.IGNORECASE)
        city = cls._city(location, title, source_url)
        locality = cls._locality(location, title, city)
        point = locate(f"{locality} {location} {title}", city)

        image = cls._image_url(structured.get("image")) or card["image_url"]
        description = short_excerpt(structured.get("description"))
        area = cls._known_detail(soup, "land area") or cls._known_detail(soup, "house area")
        bathrooms = optional_int(cls._known_detail(soup, "bathrooms"))

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
            price_label=format_npr(price, price_basis) if price is not None else (raw_price or "Price on request"),
            location_name=" · ".join(dict.fromkeys(part for part in (locality, city) if part)),
            locality=locality,
            city=city,
            area_label=area or "Area on source",
            bedrooms=None,
            bathrooms=bathrooms,
            description_excerpt=description,
            image_url=image,
            image_alt=f"{title}, source listing photograph",
            image_credit=(
                "Photograph from Ghar Sansar Nepal; used in this private prototype "
                "with owner-authorized publisher permission."
            ),
            latitude=point.latitude if point else None,
            longitude=point.longitude if point else None,
            location_precision=point.precision if point else "unknown",
            source_age_label=cls._known_detail(soup, "Posted on") or clean_text(structured.get("datePublished")),
            raw_facts={
                "road_access": cls._known_detail(soup, "Road Size"),
                "road_type": cls._known_detail(soup, "Road Type"),
                "facing": cls._known_detail(soup, "Property Face Direction"),
                "parking": cls._known_detail(soup, "Parking Space"),
                "house_area": cls._known_detail(soup, "house area"),
            },
        )

    @staticmethod
    async def _get_text(client: httpx.AsyncClient, url: str) -> str:
        for attempt in range(3):
            try:
                response = await client.get(url)
                response.raise_for_status()
                return response.text
            except httpx.HTTPStatusError as error:
                if error.response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                    raise
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 2:
                    raise
            await asyncio.sleep(0.5 * (2**attempt))
        raise RuntimeError("Ghar Sansar request retry loop ended unexpectedly")

    async def fetch(self, limit: int) -> list[ListingRecord]:
        if limit <= 0:
            return []
        bounded_limit = min(limit, self.max_detail_requests)
        per_purpose = max(1, (bounded_limit + 1) // 2)
        headers = {"Accept": "text/html,application/xhtml+xml", "User-Agent": USER_AGENT}
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
            pages = await asyncio.gather(
                *(self._get_text(client, url) for url in self.index_urls.values())
            )
            cards: list[dict[str, str]] = []
            for (purpose, _), page in zip(self.index_urls.items(), pages, strict=True):
                cards.extend(self._cards(page, purpose)[:per_purpose])
            cards = cards[:bounded_limit]

            semaphore = asyncio.Semaphore(2)

            async def detail(card: dict[str, str]) -> str:
                async with semaphore:
                    await asyncio.sleep(0.08)
                    try:
                        return await self._get_text(client, card["source_url"])
                    except (httpx.HTTPError, RuntimeError):
                        return ""

            detail_pages = await asyncio.gather(*(detail(card) for card in cards))

        records: list[ListingRecord] = []
        for card, detail_html in zip(cards, detail_pages, strict=True):
            try:
                record = self._record(card, detail_html)
            except (TypeError, ValueError, OverflowError):
                continue
            if record:
                records.append(record)
        return records[:limit]
