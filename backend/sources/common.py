from __future__ import annotations

import re
from html import unescape
from urllib.parse import urljoin


EMAIL_PATTERN = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
MOBILE_PATTERN = re.compile(r"(?<!\w)(?:\+?977[- .]?)?9[678]\d(?:[- .]?\d){7}(?!\w)")
LANDLINE_PATTERN = re.compile(r"(?<!\w)(?:\+?977[- .]?)?0\d{1,2}[- .]?\d{6,7}(?!\w)")


def clean_text(value: object) -> str:
    cleaned = re.sub(r"\s+", " ", unescape(str(value or ""))).strip()
    cleaned = EMAIL_PATTERN.sub("[email removed]", cleaned)
    cleaned = MOBILE_PATTERN.sub("[phone removed]", cleaned)
    return LANDLINE_PATTERN.sub("[phone removed]", cleaned)


def short_excerpt(value: object, length: int = 280) -> str:
    cleaned = clean_text(value)
    if len(cleaned) <= length:
        return cleaned
    return f"{cleaned[: length - 1].rstrip()}…"


def optional_int(value: object) -> int | None:
    try:
        return int(float(str(value).replace(",", ""))) if value not in (None, "") else None
    except (TypeError, ValueError, OverflowError):
        return None


def parse_npr(value: object) -> int | None:
    text = clean_text(value).lower().replace("रु", "rs").replace("रू", "rs")
    numeric_text = text.replace(",", "")
    crore_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:crore|cr)\b", numeric_text)
    lakh_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:lakh|lakhs|lac|lacs|lk)\b", numeric_text)
    if crore_match or lakh_match:
        return int(
            (float(crore_match.group(1)) if crore_match else 0) * 10_000_000
            + (float(lakh_match.group(1)) if lakh_match else 0) * 100_000
        )
    number_match = re.search(r"(\d+(?:\.\d+)?)", numeric_text)
    if not number_match:
        return None
    number = float(number_match.group(1))
    if re.search(r"\bmillion\b", text):
        number *= 1_000_000
    return int(number)


def format_npr(value: int | None, basis: str = "total") -> str:
    if value is None:
        return "Price on request"
    if value >= 10_000_000:
        label = f"रु {value / 10_000_000:.2f}".rstrip("0").rstrip(".") + " Cr"
    elif value >= 100_000:
        label = f"रु {value / 100_000:.2f}".rstrip("0").rstrip(".") + " Lakh"
    else:
        label = f"रु {value:,}"
    suffixes = {
        "monthly": " / mo",
        "per-aana": " / aana",
        "per-ropani": " / ropani",
        "per-kattha": " / kattha",
        "per-dhur": " / dhur",
        "per-sq-ft": " / sq ft",
    }
    return label + suffixes.get(basis, "")


def infer_purpose(*values: object) -> str:
    text = " ".join(clean_text(value).lower() for value in values)
    return "rent" if re.search(r"\b(?:rent|rental|lease|let)\b", text) else "buy"


def infer_property_type(*values: object) -> str:
    text = " ".join(clean_text(value).lower() for value in values)
    if re.search(r"\b(?:commercial|office|shop|shutter|business|hotel|restaurant)\b", text):
        return "Commercial"
    if re.search(r"\b(?:apartment|flat|penthouse|studio)\b", text):
        return "Apartment"
    if re.search(r"\b(?:land|plot|ghaderi)\b", text):
        return "Land"
    return "House" if re.search(r"\b(?:house|home|bungalow|villa|residence)\b", text) else "Property"


def infer_price_basis(price_text: object, purpose: str, property_type: str) -> str:
    text = clean_text(price_text).lower()
    if re.search(r"(?:/|per\s*)(?:aana|anna)", text):
        return "per-aana"
    if re.search(r"(?:/|per\s*)ropani", text):
        return "per-ropani"
    if re.search(r"(?:/|per\s*)kattha", text):
        return "per-kattha"
    if re.search(r"(?:/|per\s*)dhur", text):
        return "per-dhur"
    if re.search(r"(?:/|per\s*)(?:sq\.?\s*ft|square\s*feet)", text):
        return "per-sq-ft"
    if purpose == "rent":
        return "monthly"
    # A land price is not automatically a unit rate. Only use a per-unit basis
    # when the publisher labels it explicitly; otherwise keep it as a total.
    return "total"


def absolute_url(base_url: str, value: object) -> str:
    return urljoin(base_url, clean_text(value)) if value else ""
