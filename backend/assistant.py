from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from statistics import median
from typing import Any
from urllib.parse import urlencode

import httpx

from backend.config import OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT_SECONDS


AREA_TO_SQFT = {
    "ropani": 5_476.0,
    "aana": 342.25,
    "anna": 342.25,
    "paisa": 85.5625,
    "daam": 21.390625,
    "kattha": 3_645.0,
    "dhur": 182.25,
    "bigha": 72_900.0,
    "sqft": 1.0,
    "sq ft": 1.0,
    "square feet": 1.0,
    "square foot": 1.0,
}
AREA_PATTERN = re.compile(
    r"(?P<amount>\d+(?:\.\d+)?)\s*(?P<unit>ropani|aana|anna|paisa|daam|kattha|dhur|bigha|sq\.?\s*ft|square\s+feet|square\s+foot)\b",
    re.IGNORECASE,
)
COMPACT_AREA_PATTERN = re.compile(r"\b(\d+)\s*-\s*(\d+)\s*-\s*(\d+)\s*-\s*(\d+)\b")
BUDGET_PATTERN = re.compile(r"(?:under|below|up\s*to|budget(?:\s+of)?|within)\s*(?:npr|rs\.?|रु)?\s*(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lac|million|m)?", re.IGNORECASE)


def area_to_sqft(value: object) -> float | None:
    text = str(value or "").lower().replace(",", " ")
    compact = COMPACT_AREA_PATTERN.search(text)
    if compact:
        ropani, aana, paisa, daam = (int(part) for part in compact.groups())
        return ropani * AREA_TO_SQFT["ropani"] + aana * AREA_TO_SQFT["aana"] + paisa * AREA_TO_SQFT["paisa"] + daam * AREA_TO_SQFT["daam"]
    matches = list(AREA_PATTERN.finditer(text))
    if not matches:
        compact_aana = re.search(r"\b(\d+(?:\.\d+)?)\s*ana\b", text)
        return float(compact_aana.group(1)) * AREA_TO_SQFT["aana"] if compact_aana else None
    total = 0.0
    for match in matches:
        unit = re.sub(r"\s+", " ", match.group("unit").replace(".", "").lower())
        total += float(match.group("amount")) * AREA_TO_SQFT[unit]
    return total or None


def desired_area_sqft(message: str) -> float | None:
    number_words = {
        "a": 1,
        "an": 1,
        "one": 1,
        "two": 2,
        "three": 3,
        "four": 4,
        "five": 5,
        "six": 6,
        "seven": 7,
        "eight": 8,
        "nine": 9,
        "ten": 10,
    }
    units = r"ropani|aana|anna|kattha|dhur|bigha|square\s+feet|square\s+foot"
    normalized = message
    for word, value in number_words.items():
        normalized = re.sub(rf"\b{word}\s+(?=(?:{units})\b)", f"{value} ", normalized, flags=re.IGNORECASE)
    return area_to_sqft(normalized)


def desired_budget_npr(message: str) -> int | None:
    match = BUDGET_PATTERN.search(message.replace(",", ""))
    if not match:
        return None
    amount = float(match.group(1))
    multiplier = {
        "crore": 10_000_000,
        "cr": 10_000_000,
        "lakh": 100_000,
        "lac": 100_000,
        "million": 1_000_000,
        "m": 1_000_000,
    }.get((match.group(2) or "").lower(), 1)
    return round(amount * multiplier)


def infer_brief(message: str, listings: list[dict[str, object]]) -> dict[str, object]:
    lowered = message.lower()
    cities = sorted({str(item.get("city") or "") for item in listings if item.get("city")}, key=len, reverse=True)
    city = next((candidate for candidate in cities if candidate.lower() in lowered), None)
    explicit_types = {
        "land": "Land",
        "plot": "Land",
        "house": "House",
        "home": "House",
        "apartment": "Apartment",
        "flat": "Apartment",
        "commercial": "Commercial",
        "office": "Commercial",
        "room": "Room",
    }
    property_type = next((value for word, value in explicit_types.items() if re.search(rf"\b{word}\b", lowered)), None)
    if any(word in lowered for word in ("cafe", "café", "restaurant", "shop")) and property_type is None:
        property_type = "Commercial"
    purpose = "rent" if any(word in lowered for word in ("rent", "rental", "lease")) else "buy"
    bedrooms = None
    bedroom_match = re.search(r"\b(\d+)\s*(?:bed|bedroom|bhk)s?\b", lowered)
    if bedroom_match:
        bedrooms = int(bedroom_match.group(1))
    return {
        "purpose": purpose,
        "city": city,
        "propertyType": property_type,
        "areaSqft": desired_area_sqft(message),
        "budgetNpr": desired_budget_npr(message),
        "bedrooms": bedrooms,
        "businessUse": next((word for word in ("cafe", "café", "restaurant", "shop", "office") if word in lowered), None),
    }


def _cohort_medians(listings: list[dict[str, object]]) -> dict[tuple[str, str, str, str], float]:
    groups: dict[tuple[str, str, str, str], list[float]] = defaultdict(list)
    for item in listings:
        price = item.get("price")
        if not isinstance(price, (int, float)) or price <= 0:
            continue
        key = (
            str(item.get("purpose") or ""),
            str(item.get("city") or ""),
            str(item.get("type") or ""),
            str(item.get("priceBasis") or ""),
        )
        groups[key].append(float(price))
    return {key: median(values) for key, values in groups.items() if len(values) >= 3}


def _fact(item: dict[str, object], *keys: str) -> str:
    facts = item.get("facts")
    if not isinstance(facts, dict):
        return ""
    for key in keys:
        value = str(facts.get(key) or "").strip()
        if value:
            return value
    return ""


def _road_access(item: dict[str, object]) -> str:
    value = _fact(item, "road_access", "road_and_area")
    measurements = re.findall(r"(\d+(?:\.\d+)?)\s*(ft|feet|feets|foot|m|meter|meters|metre|metres)\b", value, re.IGNORECASE)
    if not measurements:
        return value
    amount, unit = measurements[-1]
    normalized_unit = "ft" if unit.lower() in {"ft", "feet", "feets", "foot"} else "m"
    return f"{amount} {normalized_unit}"


def _score_listing(item: dict[str, object], brief: dict[str, object]) -> float:
    score = 0.0
    item_type = str(item.get("type") or "")
    if item.get("purpose") == brief["purpose"]:
        score += 8
    else:
        score -= 18
    if brief["propertyType"]:
        score += 16 if item_type == brief["propertyType"] else -14
    if brief["businessUse"] and item_type in {"Land", "Commercial"}:
        score += 7
    if brief["city"]:
        score += 12 if item.get("city") == brief["city"] else -7
    if brief["bedrooms"] is not None:
        beds = item.get("beds")
        score += 7 if isinstance(beds, (int, float)) and beds >= brief["bedrooms"] else -5
    requested_area = brief["areaSqft"]
    item_area = area_to_sqft(item.get("area"))
    if isinstance(requested_area, (int, float)):
        if item_area is None:
            score -= 4
        elif item_area >= requested_area:
            score += max(4, 13 - abs(math.log(max(item_area / requested_area, 0.01))) * 4)
        else:
            score -= min(12, (requested_area - item_area) / requested_area * 16)
    budget = brief["budgetNpr"]
    price = item.get("price")
    basis = item.get("priceBasis")
    if isinstance(budget, int) and isinstance(price, (int, float)) and basis in {"total", "monthly"}:
        score += 9 if price <= budget else -min(14, (price - budget) / max(budget, 1) * 12)
    if _road_access(item):
        score += 2.5
    if _fact(item, "parking"):
        score += 1.5
    if item.get("description"):
        score += 0.5
    return score


def _filter_url(brief: dict[str, object]) -> str:
    query: dict[str, str] = {"purpose": str(brief["purpose"])}
    if brief["city"]:
        query["city"] = str(brief["city"])
    if brief["propertyType"]:
        query["type"] = str(brief["propertyType"])
    if brief["budgetNpr"]:
        query["maxPrice"] = str(brief["budgetNpr"])
    if brief["bedrooms"] is not None:
        query["beds"] = str(brief["bedrooms"])
    return f"/properties?{urlencode(query)}"


def rank_listings(message: str, listings: list[dict[str, object]], limit: int = 3) -> tuple[dict[str, object], list[dict[str, object]]]:
    brief = infer_brief(message, listings)
    medians = _cohort_medians(listings)
    ordered = sorted(listings, key=lambda item: _score_listing(item, brief), reverse=True)
    recommendations: list[dict[str, object]] = []
    for item in ordered:
        if item.get("purpose") != brief["purpose"]:
            continue
        if brief["propertyType"] and item.get("type") != brief["propertyType"]:
            continue
        reasons: list[str] = []
        item_area = area_to_sqft(item.get("area"))
        requested_area = brief["areaSqft"]
        if isinstance(requested_area, (int, float)) and item_area is not None and item_area >= requested_area:
            reasons.append(f"Its reported {item.get('area')} meets the requested size.")
        elif item.get("area") and str(item.get("area")).lower() != "area on source":
            reasons.append(f"The source reports an area of {item.get('area')}.")
        road = _road_access(item)
        if road:
            reasons.append(f"Reported road access is {road}.")
        parking = _fact(item, "parking")
        if parking and brief["businessUse"]:
            reasons.append(f"The listing reports parking: {parking}.")
        key = (str(item.get("purpose") or ""), str(item.get("city") or ""), str(item.get("type") or ""), str(item.get("priceBasis") or ""))
        cohort_median = medians.get(key)
        price = item.get("price")
        if cohort_median and isinstance(price, (int, float)) and price < cohort_median:
            difference = round((cohort_median - price) / cohort_median * 100)
            reasons.append(f"Its ask is about {difference}% below the current median for the same city, type, purpose, and price basis.")
        if brief["city"] and item.get("city") == brief["city"]:
            reasons.append(f"It is in the requested {brief['city']} market.")
        if not reasons:
            reasons.append("It is one of the closest matches in the current indexed inventory.")
        query = {"purpose": str(item.get("purpose") or "buy"), "type": str(item.get("type") or "") , "listing": str(item.get("id") or ""), "assistant": "1"}
        recommendations.append(
            {
                "id": item.get("id"),
                "title": item.get("title"),
                "location": item.get("location"),
                "type": item.get("type"),
                "purpose": item.get("purpose"),
                "priceLabel": item.get("priceLabel") or "Price on request",
                "area": item.get("area") or "Area on source",
                "sourceName": item.get("sourceName"),
                "reason": " ".join(reasons[:3]),
                "url": f"/properties?{urlencode(query)}",
            }
        )
        if len(recommendations) >= limit:
            break
    brief["filterUrl"] = _filter_url(brief)
    return brief, recommendations


def fallback_answer(brief: dict[str, object], recommendations: list[dict[str, object]]) -> str:
    if not recommendations:
        return "I could not find a close match in the current index. Open the filtered results and broaden the location, size, or property type to see more options."
    kind = str(brief.get("propertyType") or "property").lower()
    place = f" in {brief['city']}" if brief.get("city") else ""
    first = recommendations[0]
    return (
        f"I found {len(recommendations)} strong {kind} matches{place} in the current database. "
        f"{first['title']} is the closest starting point: {first['reason']} "
        "Use the in-site links below to inspect each option, its locality map, and the source facts."
    )


async def ollama_answer(message: str, brief: dict[str, object], recommendations: list[dict[str, object]], listings: list[dict[str, object]]) -> str | None:
    market_counts: dict[str, int] = defaultdict(int)
    for item in listings:
        market_counts[str(item.get("city") or "Nepal")] += 1
    evidence = {
        "searchBrief": brief,
        "recommendations": recommendations,
        "inventory": {"total": len(listings), "cities": dict(sorted(market_counts.items(), key=lambda pair: pair[1], reverse=True)[:8])},
    }
    system = (
        "You are the Nepal Estate Index assistant. Answer using only the supplied live-index evidence. "
        "Be concise, practical, and optimistic without making promises. Explain the strongest matching factors such as size, locality, road access, and relative asking-price position. "
        "Do not invent facts, links, returns, zoning approval, footfall, legal status, or transaction prices. "
        "Call a listing a strong match within this index, never objectively the best property. Do not output URLs; the interface adds verified internal links."
    )
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "think": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": f"User request: {message}\n\nIndex evidence:\n{json.dumps(evidence, ensure_ascii=False)}"},
        ],
        "options": {"temperature": 0.2, "num_predict": 260},
    }
    try:
        async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
            response.raise_for_status()
        content = response.json().get("message", {}).get("content", "")
        return str(content).replace("�", "·").strip() or None
    except (httpx.HTTPError, ValueError, TypeError):
        return None
