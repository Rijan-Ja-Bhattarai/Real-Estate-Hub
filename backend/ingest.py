from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
from pathlib import Path
from urllib.parse import urlparse

from backend.config import DB_PATH, EXPORT_PATH, SOURCE_PAGE_SIZE, SOURCE_REFRESH_TIMEOUT_SECONDS
from backend.db import (
    database_stats,
    finish_run,
    initialise,
    list_listings,
    list_sources,
    start_run,
    upsert_listings,
)
from backend.sources import (
    GharBazarSource,
    GharGhaderiSource,
    GharSansarSource,
    KantipurRealEstateSource,
    LalpurjaSource,
    NepalHomesSource,
    NepalPropertyBazaarSource,
    PropertyInNepalSource,
    RealEstateInNepalSource,
)
from backend.sources.base import ListingRecord
from backend.sources.common import EMAIL_PATTERN, LANDLINE_PATTERN, MOBILE_PATTERN


ADAPTER_TYPES = (
    LalpurjaSource,
    NepalHomesSource,
    RealEstateInNepalSource,
    GharGhaderiSource,
    NepalPropertyBazaarSource,
    PropertyInNepalSource,
    GharSansarSource,
    KantipurRealEstateSource,
    GharBazarSource,
)
ADAPTERS = {adapter.slug: adapter for adapter in ADAPTER_TYPES}
refresh_lock = asyncio.Lock()


def record_is_safe(record: ListingRecord, source_slug: str) -> bool:
    if (
        record.source_slug != source_slug
        or not record.id.startswith(f"{source_slug}:")
        or not record.external_id
        or not record.title.strip()
        or record.purpose not in {"buy", "rent"}
        or record.price_npr is not None and record.price_npr < 0
    ):
        return False
    source_url = urlparse(record.source_url)
    image_url = urlparse(record.image_url) if record.image_url else None
    if source_url.scheme not in {"http", "https"} or not source_url.netloc:
        return False
    if image_url and (image_url.scheme not in {"http", "https"} or not image_url.netloc):
        return False
    if (record.latitude is None) != (record.longitude is None):
        return False
    if record.latitude is not None and not (-90 <= record.latitude <= 90 and -180 <= record.longitude <= 180):
        return False
    public_text = " ".join(
        (record.title, record.location_name, record.locality, record.city, record.description_excerpt)
    )
    return not any(pattern.search(public_text) for pattern in (EMAIL_PATTERN, MOBILE_PATTERN, LANDLINE_PATTERN))


def seed_from_snapshot(
    snapshot_path: Path = EXPORT_PATH,
    database_path: Path = DB_PATH,
) -> int:
    """Restore the generated database from the deployable snapshot on a cold start."""
    if database_stats(database_path)["listing_count"] or not snapshot_path.exists():
        return 0

    try:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return 0

    records: list[ListingRecord] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        listing_id = str(item.get("id") or "")
        source_slug, separator, external_id = listing_id.partition(":")
        source_url = str(item.get("sourceUrl") or "")
        if not separator or not source_slug or not external_id or not source_url:
            continue
        facts = item.get("facts") if isinstance(item.get("facts"), dict) else {}
        records.append(
            ListingRecord(
                id=listing_id,
                source_slug=source_slug,
                external_id=external_id,
                source_url=source_url,
                title=str(item.get("title") or "Property listing"),
                purpose="rent" if item.get("purpose") == "rent" else "buy",
                property_type=str(item.get("type") or "Property"),
                price_npr=item.get("price") if isinstance(item.get("price"), int) else None,
                price_basis=str(
                    item.get("priceBasis")
                    or ("per-aana" if item.get("purpose") == "buy" and item.get("type") == "Land" else "monthly" if item.get("purpose") == "rent" else "total")
                ),
                price_label=str(item.get("priceLabel") or "Price on request"),
                location_name=str(item.get("location") or "Nepal"),
                locality=str(item.get("locality") or ""),
                city=str(item.get("city") or ""),
                area_label=str(item.get("area") or "Area on source"),
                bedrooms=item.get("beds") if isinstance(item.get("beds"), int) else None,
                bathrooms=item.get("baths") if isinstance(item.get("baths"), int) else None,
                description_excerpt=str(item.get("description") or ""),
                image_url=str(item.get("image") or ""),
                image_alt=str(item.get("imageAlt") or "Source listing photograph"),
                image_credit=str(item.get("imageCredit") or ""),
                latitude=float(item["latitude"]) if isinstance(item.get("latitude"), (int, float)) else None,
                longitude=float(item["longitude"]) if isinstance(item.get("longitude"), (int, float)) else None,
                location_precision=str(item.get("locationPrecision") or "unknown"),
                source_age_label=str(item.get("sourceAgeLabel") or ""),
                raw_facts=facts,
            )
        )

    fetched_at = payload.get("asOf") if isinstance(payload.get("asOf"), str) else None
    inserted, _ = upsert_listings(records, database_path, fetched_at=fetched_at)
    return inserted


def export_snapshot(path: Path = EXPORT_PATH) -> dict[str, object]:
    listings, total = list_listings(limit=250)
    stats = database_stats()
    payload: dict[str, object] = {
        "items": listings,
        "total": total,
        "limit": 250,
        "offset": 0,
        "asOf": stats["latest_fetch_at"],
        "mode": "database-snapshot",
        "sources": [
            {
                "slug": source["slug"],
                "name": source["name"],
                "baseUrl": source["base_url"],
                "status": source["status"],
                "listingCount": source["listing_count"],
            }
            for source in list_sources()
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return payload


async def refresh_source(source_slug: str, *, limit: int = SOURCE_PAGE_SIZE) -> dict[str, object]:
    initialise()
    adapter_type = ADAPTERS.get(source_slug)
    if not adapter_type:
        raise ValueError(f"No enabled adapter for {source_slug}")
    run_id = start_run(source_slug)
    try:
        received_records = await adapter_type().fetch(limit)
        records = [record for record in received_records if record_is_safe(record, source_slug)]
        records = list({record.id: record for record in records}.values())
        rejected = len(received_records) - len(records)
        previous_count = next(
            (int(source["listing_count"]) for source in list_sources() if source["slug"] == source_slug),
            0,
        )
        adapter_minimum = max(1, int(getattr(adapter_type, "minimum_records", 6)))
        minimum_count = min(limit, adapter_minimum)
        if previous_count:
            minimum_count = max(minimum_count, math.ceil(min(previous_count, limit) * 0.75))
        if len(records) < minimum_count:
            raise RuntimeError(
                f"Only {len(records)} safe listings were normalized from {len(received_records)} records; at least {minimum_count} are required to replace the previous index window"
            )
        inserted, updated = upsert_listings(records, replace_index_window_for_source=source_slug)
        finish_run(
            run_id,
            source_slug,
            status="success",
            discovered=len(records),
            inserted=inserted,
            updated=updated,
        )
        export_snapshot()
        return {
            "source": source_slug,
            "status": "success",
            "discovered": len(records),
            "rejected": rejected,
            "inserted": inserted,
            "updated": updated,
        }
    except asyncio.CancelledError:
        finish_run(
            run_id,
            source_slug,
            status="failed",
            error="Refresh cancelled or exceeded its source deadline",
        )
        raise
    except Exception as error:
        message = f"{type(error).__name__}: {error}"
        finish_run(run_id, source_slug, status="failed", error=message)
        raise


async def refresh_all(*, limit: int = SOURCE_PAGE_SIZE) -> list[dict[str, object]]:
    async with refresh_lock:
        semaphore = asyncio.Semaphore(3)

        async def refresh_one(source_slug: str) -> dict[str, object]:
            async with semaphore:
                try:
                    return await asyncio.wait_for(
                        refresh_source(source_slug, limit=limit),
                        timeout=SOURCE_REFRESH_TIMEOUT_SECONDS,
                    )
                except TimeoutError:
                    return {
                        "source": source_slug,
                        "status": "failed",
                        "error": (
                            "Source refresh exceeded "
                            f"{SOURCE_REFRESH_TIMEOUT_SECONDS} seconds"
                        ),
                    }
                except Exception as error:
                    return {
                        "source": source_slug,
                        "status": "failed",
                        "error": f"{type(error).__name__}: {error}",
                    }

        results = await asyncio.gather(*(refresh_one(source_slug) for source_slug in ADAPTERS))
        # Each successful source exports as it completes; export once more so the
        # final snapshot always reflects the entire batch.
        if any(result.get("status") == "success" for result in results):
            export_snapshot()
        return list(results)


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Refresh permitted property sources into SQLite.")
    parser.add_argument(
        "--source",
        choices=sorted(ADAPTERS),
        help="Refresh one source. Omit this option to refresh every enabled source.",
    )
    parser.add_argument("--limit", type=int, default=SOURCE_PAGE_SIZE)
    parser.add_argument("--export-only", action="store_true")
    arguments = parser.parse_args()

    initialise(DB_PATH)
    seed_from_snapshot(EXPORT_PATH, DB_PATH)
    if arguments.export_only:
        result = export_snapshot(EXPORT_PATH)
        print(json.dumps({"exported": result["total"], "path": str(EXPORT_PATH)}, indent=2))
        return
    bounded_limit = max(1, min(arguments.limit, 96))
    result = (
        await refresh_source(arguments.source, limit=bounded_limit)
        if arguments.source
        else await refresh_all(limit=bounded_limit)
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())
