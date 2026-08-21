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
        return "" if re.fullmatch(r"\d+(?:\.\d+)?", value) else value
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
        if item_type == "Land" and item.get("area") and str(item.get("area")).lower() != "area on source":
            score += 2
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


def comparison_recommendations(
    selected: list[dict[str, object]],
    inventory: list[dict[str, object]],
) -> list[dict[str, object]]:
    medians = _cohort_medians(inventory)
    recommendations: list[dict[str, object]] = []
    for item in selected:
        reasons: list[str] = []
        area = str(item.get("area") or "Area not supplied")
        if area.lower() != "area on source":
            reasons.append(f"Reported area: {area}.")
        road = _road_access(item)
        if road:
            reasons.append(f"Reported road access: {road}.")
        key = (
            str(item.get("purpose") or ""),
            str(item.get("city") or ""),
            str(item.get("type") or ""),
            str(item.get("priceBasis") or ""),
        )
        cohort_median = medians.get(key)
        price = item.get("price")
        if cohort_median and isinstance(price, (int, float)):
            difference = round((float(price) / cohort_median - 1) * 100)
            position = f"{abs(difference)}% {'above' if difference > 0 else 'below'} its like-for-like peer median"
            reasons.append(f"Its current ask is about {position}.")
        if not reasons:
            reasons.append("The index has limited standardized facts for this selection; verify its source listing.")
        query = {
            "purpose": str(item.get("purpose") or "buy"),
            "type": str(item.get("type") or ""),
            "listing": str(item.get("id") or ""),
            "assistant": "1",
        }
        recommendations.append(
            {
                "id": item.get("id"),
                "title": item.get("title"),
                "location": item.get("location"),
                "city": item.get("city"),
                "type": item.get("type"),
                "purpose": item.get("purpose"),
                "price": item.get("price"),
                "priceBasis": item.get("priceBasis"),
                "priceLabel": item.get("priceLabel") or "Price on request",
                "area": item.get("area") or "Area on source",
                "beds": item.get("beds"),
                "baths": item.get("baths"),
                "sourceName": item.get("sourceName"),
                "reason": " ".join(reasons[:3]),
                "details": {
                    "roadAccess": road or None,
                    "parking": _fact(item, "parking") or None,
                    "facing": _fact(item, "facing") or None,
                    "furnishing": _fact(item, "furnishing", "furnished") or None,
                },
                "url": f"/properties?{urlencode(query)}",
            }
        )
    return recommendations


def comparison_fallback_answer(
    message: str,
    selected: list[dict[str, object]],
    recommendations: list[dict[str, object]],
) -> str:
    if not selected:
        return "I could not load the listings pinned in the comparison. Re-select them on the Market page and ask again."
    prefix = f"I’m using only your {len(selected)} selected Market listing{'s' if len(selected) != 1 else ''}. "
    lowered = message.lower()
    if any(word in lowered for word in ("road", "access", "vehicle")):
        details = [f"{item.get('title')}: {_road_access(item) or 'road access not supplied'}" for item in selected]
        return prefix + "Reported road access — " + "; ".join(details) + ". Verify these source-reported details before visiting."
    if any(word in lowered for word in ("price", "ask", "cost", "budget", "cheap", "value")):
        details = [f"{item.get('title')}: {item.get('priceLabel') or 'price on request'}" for item in selected]
        comparable = [item for item in selected if isinstance(item.get("price"), (int, float))]
        bases = {str(item.get("priceBasis") or "") for item in comparable}
        note = ""
        if comparable and len(bases) == 1:
            lowest = min(comparable, key=lambda item: float(item["price"]))
            note = f" {lowest.get('title')} has the lowest reported ask on their shared {next(iter(bases))} basis."
        return prefix + "Reported asks — " + "; ".join(details) + "." + note
    if any(word in lowered for word in ("area", "size", "space", "ropani", "aana", "sq ft", "land")):
        details = [f"{item.get('title')}: {item.get('area') or 'area not supplied'}" for item in selected]
        return prefix + "Reported sizes — " + "; ".join(details) + "."
    summaries = [
        f"{item.get('title')} — {item.get('priceLabel') or 'price on request'}, {item.get('area') or 'area not supplied'}, {item.get('location') or item.get('city') or 'location not supplied'}"
        for item in selected
    ]
    return prefix + "Here is the indexed comparison: " + "; ".join(summaries) + ". Ask me about price, size, road access, or suitability to compare one factor in detail."


def wants_single_recommendation(message: str) -> bool:
    lowered = message.lower()
    return bool(
        re.search(r"\b(best|choose|pick|recommend|winner)\b", lowered)
        or re.search(r"\bwhich\b.{0,45}\b(buy|purchase|better|value|one)\b", lowered)
        or re.search(r"\bwhat\b.{0,30}\bshould\s+i\s+buy\b", lowered)
    )


def additional_land_request(message: str) -> str | None:
    lowered = message.lower()
    if not re.search(r"\b(land|plot)\b", lowered) or not re.search(r"\b(cafe|cafÃ©|restaurant|shop)\b", lowered):
        return None
    split = re.search(r"\b(?:and\s+)?(?:i\s+)?also\b", message, re.IGNORECASE)
    if not split:
        split = re.search(r"\b(?:and|plus)\b(?=[^.!?]*(?:land|plot))", message, re.IGNORECASE)
    request = message[split.end():].strip() if split else message
    return f"buy {request}" if not re.search(r"\b(buy|purchase)\b", request, re.IGNORECASE) else request


def choose_comparison_winner(
    message: str,
    selected: list[dict[str, object]],
    inventory: list[dict[str, object]],
) -> dict[str, object] | None:
    if not selected:
        return None
    brief = infer_brief(message, inventory)
    medians = _cohort_medians(inventory)
    budget = brief.get("budgetNpr")

    def score(item: dict[str, object]) -> float:
        value = _score_listing(item, brief)
        price = item.get("price")
        basis = item.get("priceBasis")
        if isinstance(budget, int) and isinstance(price, (int, float)) and basis in {"total", "monthly"}:
            if price <= budget:
                value += 18
            else:
                value -= 30 * min((price - budget) / max(budget, 1), 1)
        value += 5 if _road_access(item) else 0
        value += 2.5 if _fact(item, "facing") else 0
        value += 2.5 if _fact(item, "parking") else 0
        value += 1.5 if _fact(item, "furnishing", "furnished") else 0
        value += 1 if item.get("area") and str(item.get("area")).lower() != "area on source" else 0
        key = (
            str(item.get("purpose") or ""),
            str(item.get("city") or ""),
            str(item.get("type") or ""),
            str(item.get("priceBasis") or ""),
        )
        cohort_median = medians.get(key)
        if cohort_median and isinstance(price, (int, float)) and price < cohort_median:
            value += min(12, (cohort_median - float(price)) / cohort_median * 20)
        return value

    return max(selected, key=score)


def single_recommendation_fallback_answer(
    winner: dict[str, object],
    selected: list[dict[str, object]],
    message: str,
) -> str:
    title = str(winner.get("title") or "this property")
    reasons: list[str] = []
    budget = desired_budget_npr(message)
    price = winner.get("price")
    if isinstance(budget, int) and isinstance(price, (int, float)) and price <= budget:
        reasons.append(f"its {winner.get('priceLabel') or 'reported ask'} is within your stated budget")
    elif winner.get("priceLabel"):
        reasons.append(f"its reported ask is {winner.get('priceLabel')}")
    road = _road_access(winner)
    if road:
        reasons.append(f"it reports {road} road access")
    facing = _fact(winner, "facing")
    if facing:
        reasons.append(f"it reports {facing} facing")
    parking = _fact(winner, "parking")
    if parking:
        reasons.append("it includes reported parking")
    if not reasons:
        comparable = [item for item in selected if item.get("priceBasis") == winner.get("priceBasis") and isinstance(item.get("price"), (int, float))]
        if comparable and winner is min(comparable, key=lambda item: float(item["price"])):
            reasons.append("it has the lowest reported ask on the shared price basis")
        else:
            reasons.append("it has the strongest combination of available price and property facts in your shortlist")
    explanation = ", and ".join(reasons[:2])
    return f"The strongest fit among your selected listings is {title} because {explanation}. Prioritize this one for verification and due diligence before making an offer."


def compound_recommendation_fallback_answer(
    house_winner: dict[str, object],
    selected: list[dict[str, object]],
    land_winner: dict[str, object] | None,
    message: str,
) -> str:
    house_sentence = single_recommendation_fallback_answer(house_winner, selected, message).split(". Prioritize", 1)[0]
    house_sentence = house_sentence.replace("The strongest fit among your selected listings is", "For the house, the strongest fit is", 1)
    if not land_winner:
        return f"{house_sentence}. I could not find an indexed land listing for the cafe yet, so broaden the land search filters."
    land_reason = str(land_winner.get("reason") or "it is the closest cafe-land match in the current index").split(".", 1)[0]
    if land_reason:
        land_reason = land_reason[0].lower() + land_reason[1:]
    return f"{house_sentence}. For the cafe, the strongest land match is {land_winner.get('title')} because {land_reason}."


def valid_single_recommendation_answer(
    answer: str | None,
    winner: dict[str, object],
    selected: list[dict[str, object]],
) -> bool:
    if not answer or len(answer) > 520 or "**" in answer or "\n-" in answer or "\n*" in answer or "\n\u2022" in answer:
        return False
    title = str(winner.get("title") or "").strip().lower()
    if not title or title not in answer.lower():
        return False
    for item in selected:
        listing_id = str(item.get("id") or "").lower()
        other_title = str(item.get("title") or "").strip().lower()
        if listing_id and listing_id in answer.lower():
            return False
        if item is winner:
            continue
        if other_title and other_title != title and other_title in answer.lower():
            return False
    return answer.count(".") <= 3


def valid_compound_recommendation_answer(
    answer: str | None,
    house_winner: dict[str, object],
    land_winner: dict[str, object] | None,
    selected: list[dict[str, object]],
) -> bool:
    if not answer or len(answer) > 760 or "**" in answer or "\n-" in answer or "\n*" in answer or "\n\u2022" in answer:
        return False
    lowered = answer.lower()
    house_title = str(house_winner.get("title") or "").strip().lower()
    land_title = str((land_winner or {}).get("title") or "").strip().lower()
    if not house_title or house_title not in lowered or (land_title and land_title not in lowered):
        return False
    for item in [*selected, *([land_winner] if land_winner else [])]:
        listing_id = str(item.get("id") or "").lower()
        if listing_id and listing_id in lowered:
            return False
    for item in selected:
        if item is house_winner:
            continue
        other_title = str(item.get("title") or "").strip().lower()
        if other_title and other_title != house_title and other_title in lowered:
            return False
    return answer.count(".") <= 4


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


async def ollama_answer(
    message: str,
    brief: dict[str, object],
    recommendations: list[dict[str, object]],
    listings: list[dict[str, object]],
    history: list[dict[str, str]] | None = None,
) -> str | None:
    market_counts: dict[str, int] = defaultdict(int)
    for item in listings:
        market_counts[str(item.get("city") or "Nepal")] += 1
    evidence = {
        "searchBrief": brief,
        "recommendations": recommendations,
        "inventory": {"total": len(listings), "cities": dict(sorted(market_counts.items(), key=lambda pair: pair[1], reverse=True)[:8])},
    }
    comparison_mode = brief.get("contextMode") == "comparison"
    compound_mode = brief.get("contextMode") == "compound"
    system = (
        "You are the Nepal Estate Index assistant. Answer using only the supplied live-index evidence. "
        "Be concise, practical, and optimistic without making promises. Explain the strongest matching factors such as size, locality, road access, and relative asking-price position. "
        "Do not invent facts, links, returns, zoning approval, footfall, legal status, or transaction prices. "
        "Call a listing a strong match within this index, never objectively the best property. Do not output URLs; the interface adds verified internal links."
    )
    if comparison_mode:
        system += (
            " The user has pinned the listings in recommendations for comparison. Analyze only those selected listings, "
            "explicitly acknowledge the shortlist, and do not suggest or rank any unselected inventory. "
            "Compare only prices with the same price basis and clearly state when a fact is not supplied."
        )
        if brief.get("singleRecommendation"):
            system += (
                " The user wants one decision, not a comparison report. Recommend only the listing identified by recommendedListingId. "
                "Return no more than two short plain-text sentences. Use its human title, never listing IDs. "
                "Do not use Markdown, bullets, headings, or mention the other selections. Give one concrete reason and advise verification before an offer."
            )
    elif compound_mode:
        system += (
            " The request contains two jobs. First, choose only the selected house identified by recommendedListingId. "
            "Second, recommend only the additional land identified by recommendedLandListingId for the user's cafe. "
            "Return exactly two short plain-text sentences: one for the house and one for the cafe land. "
            "Use human titles, never listing IDs. Do not use Markdown, bullets, headings, mention other selected houses, or add more properties."
        )
    conversation = [
        {"role": turn["role"], "content": turn["content"]}
        for turn in (history or [])[-6:]
        if turn.get("role") in {"user", "assistant"} and turn.get("content")
    ]
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "think": False,
        "messages": [
            {"role": "system", "content": system},
            *conversation,
            {"role": "user", "content": f"User request: {message}\n\nIndex evidence:\n{json.dumps(evidence, ensure_ascii=False)}"},
        ],
        "options": {"temperature": 0.15, "num_predict": 170 if compound_mode else 120 if brief.get("singleRecommendation") else 260},
    }
    try:
        async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
            response.raise_for_status()
        content = response.json().get("message", {}).get("content", "")
        return str(content).replace("�", "·").strip() or None
    except (httpx.HTTPError, ValueError, TypeError):
        return None
