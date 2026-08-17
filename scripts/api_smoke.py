from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ["INDEX_ENABLE_SCHEDULER"] = "false"
TEST_DATABASE_DIRECTORY = TemporaryDirectory(prefix="nei-api-smoke-")
os.environ["INDEX_DB_PATH"] = str(Path(TEST_DATABASE_DIRECTORY.name) / "real_estate.db")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

from backend.app import app
from backend.config import EXPORT_PATH
from backend.db import database_stats, initialise
from backend.ingest import record_is_safe, seed_from_snapshot
from backend.sources.base import ListingRecord
from backend.sources.lalpurja import LalpurjaSource


async def main() -> None:
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            health_response = await client.get("/api/health")
            assert health_response.status_code == 200
            health_payload = health_response.json()
            assert health_payload["status"] in {"ok", "degraded"}
            assert health_payload["freshness"]["state"] in {"fresh", "stale"}
            assert health_payload["database"]["listing_count"] >= 1

            listings_response = await client.get("/api/listings", params={"purpose": "buy", "limit": 6})
            assert listings_response.status_code == 200
            payload = listings_response.json()
            assert payload["items"]
            assert len(payload["items"]) <= 6
            listing = payload["items"][0]
            assert listing["sourceName"]
            assert listing["sourceUrl"].startswith("https://")
            assert not listing["image"] or listing["image"].startswith("https://")
            assert listing["priceBasis"] in {
                "total",
                "monthly",
                "daily",
                "yearly",
                "per-aana",
                "per-ropani",
                "per-kattha",
                "per-dhur",
                "per-sq-ft",
                "per-floor-monthly",
                "per-house",
            }
            assert listing["locationPrecision"] in {
                "exact",
                "source",
                "locality",
                "city",
                "district",
                "unknown",
            }
            assert "postedByEmail" not in listing and "postedByContactNo" not in listing

            budget_response = await client.get(
                "/api/listings", params={"purpose": "buy", "max_price": 100_000_000}
            )
            assert budget_response.status_code == 200
            assert all(item["priceBasis"] == "total" for item in budget_response.json()["items"])
            assert (await client.get("/api/listings", params={"purpose": "lease"})).status_code == 422
            assert (await client.post("/api/admin/refresh")).status_code == 404

            all_listings = (await client.get("/api/listings", params={"limit": 250})).json()
            assert len(all_listings["items"]) == all_listings["total"] >= 9
            assert len({item["id"] for item in all_listings["items"]}) == all_listings["total"]
            assert len({item["sourceUrl"] for item in all_listings["items"]}) == all_listings["total"]
            assert all(item["mapQuery"] for item in all_listings["items"])
            assert sum(bool(item["image"]) for item in all_listings["items"]) >= int(all_listings["total"] * 0.9)

            source_items = (await client.get("/api/sources")).json()["items"]
            active = [source for source in source_items if source["status"] == "active"]
            assert len(active) == 9
            assert all(source["listing_count"] >= 1 for source in active)
            assert {item["sourceName"] for item in all_listings["items"]} == {
                source["name"] for source in active
            }
            assert all(
                source["content_license_status"] == "owner-permission-attested-private-prototype"
                and source["image_license_status"] == "owner-permission-attested-private-prototype"
                and source["permission_scope"]
                for source in active
            )

    redacted = LalpurjaSource._short_excerpt("Call +977 981-234-5678 or owner@example.com for a viewing")
    assert "981" not in redacted and "owner@" not in redacted
    unsafe_record = ListingRecord(
        id="test-source:1",
        source_slug="test-source",
        external_id="1",
        source_url="https://example.com/property/1",
        title="House from owner@example.com",
        purpose="buy",
        property_type="House",
        price_npr=1,
        price_basis="total",
        price_label="रु 1",
        location_name="Kathmandu",
        locality="Kathmandu",
        city="Kathmandu",
        area_label="Area on source",
    )
    assert not record_is_safe(unsafe_record, "test-source")

    with TemporaryDirectory(prefix="nei-cold-start-") as directory:
        cold_database = Path(directory) / "real_estate.db"
        initialise(cold_database)
        assert seed_from_snapshot(EXPORT_PATH, cold_database) == health_payload["database"]["listing_count"]
        assert database_stats(cold_database)["listing_count"] == health_payload["database"]["listing_count"]

    print("API smoke test passed: HTTP boundary, SQLite cold start, filters, attribution, and privacy controls.")


if __name__ == "__main__":
    asyncio.run(main())
