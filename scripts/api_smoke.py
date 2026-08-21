from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ["INDEX_ENABLE_SCHEDULER"] = "false"
os.environ["INDEX_OLLAMA_BASE_URL"] = "http://127.0.0.1:1"
TEST_DATABASE_DIRECTORY = TemporaryDirectory(prefix="nei-api-smoke-")
os.environ["INDEX_DB_PATH"] = str(Path(TEST_DATABASE_DIRECTORY.name) / "real_estate.db")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

from backend.app import app
from backend.config import DB_PATH, EXPORT_PATH
from backend.db import connect, database_stats, initialise, list_listings, list_market_series, upsert_listings
from backend.ingest import export_snapshot, record_is_safe, seed_from_snapshot
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
            properties_page = await client.get("/properties")
            assert properties_page.status_code == 200
            assert "data-browse-filters" in properties_page.text
            assert (await client.get("/assistant.js")).status_code == 200

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

            with connect() as connection:
                observation_columns = {
                    row["name"] for row in connection.execute("PRAGMA table_info(listing_price_observations)")
                }
                observation_count = int(
                    connection.execute("SELECT COUNT(*) FROM listing_price_observations").fetchone()[0]
                )
            assert {
                "listing_id",
                "observed_at",
                "purpose",
                "city",
                "property_type",
                "price_npr",
                "price_basis",
                "is_active",
                "is_clean",
                "duplicate_fingerprint",
            } <= observation_columns
            assert not any(
                private_name in column
                for column in observation_columns
                for private_name in ("contact", "email", "phone", "description", "title", "url", "raw")
            )
            assert observation_count >= health_payload["database"]["listing_count"]

            market_response = await client.get("/api/market/series", params={"days": 90})
            assert market_response.status_code == 200
            market_payload = market_response.json()
            assert market_payload["items"]
            assert market_payload["status"] == "collecting"
            assert market_payload["readiness"]["ready"] is False
            assert market_payload["readiness"]["minimumWindowDays"] == 30
            assert market_payload["readiness"]["minimumDailySample"] == 8
            assert all(
                {
                    "date",
                    "purpose",
                    "city",
                    "propertyType",
                    "priceBasis",
                    "medianPriceNpr",
                    "listingCount",
                }
                == set(item)
                for item in market_payload["items"]
            )
            assert (await client.get("/api/market/series", params={"days": 6})).status_code == 422
            assert (await client.get("/api/market/series", params={"days": 366})).status_code == 422
            assert (await client.get("/api/market/series", params={"purpose": "lease"})).status_code == 422
            assert (
                await client.get("/api/market/series", params={"city": "x" * 81})
            ).status_code == 422

            budget_response = await client.get(
                "/api/listings", params={"purpose": "buy", "max_price": 100_000_000}
            )
            assert budget_response.status_code == 200
            assert all(item["priceBasis"] == "total" for item in budget_response.json()["items"])
            assert (await client.get("/api/listings", params={"purpose": "lease"})).status_code == 422
            assert (await client.post("/api/admin/refresh")).status_code == 404

            assistant_response = await client.post(
                "/api/assistant/chat",
                json={"message": "I want 1 ropani of land for a cafe", "page": "/market"},
            )
            assert assistant_response.status_code == 200
            assistant_payload = assistant_response.json()
            assert assistant_payload["mode"] == "database-fallback"
            assert assistant_payload["answer"]
            assert assistant_payload["filterUrl"].startswith("/properties?")
            assert assistant_payload["recommendations"]
            assert all(
                item["type"] == "Land"
                and item["purpose"] == "buy"
                and item["url"].startswith("/properties?")
                and item["reason"]
                for item in assistant_payload["recommendations"]
            )
            assert (await client.post("/api/assistant/chat", json={"message": ""})).status_code == 422

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

            history_records = [
                ListingRecord(
                    id=f"lalpurja-nepal:market-smoke-{index}",
                    source_slug="lalpurja-nepal",
                    external_id=f"market-smoke-{index}",
                    source_url=f"https://example.com/market-smoke/{index}",
                    title=f"Market history test house {index}",
                    purpose="buy",
                    property_type="House",
                    price_npr=10_000_000 + index * 100_000,
                    price_basis="total",
                    price_label=f"NPR {10_000_000 + index * 100_000}",
                    location_name="Smoke City",
                    locality="Smoke Ward",
                    city="Smoke City",
                    area_label="4 aana",
                    raw_facts={"quality_flags": []},
                )
                for index in range(8)
            ]
            history_now = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
            for days_ago in (29, 27, 25, 23, 21, 19, 17, 15, 13, 11, 9, 7, 5, 0):
                upsert_listings(
                    history_records,
                    DB_PATH,
                    fetched_at=(history_now - timedelta(days=days_ago)).isoformat(),
                )
            upsert_listings(history_records, DB_PATH, fetched_at=history_now.isoformat())
            with connect() as connection:
                history_observation_count = int(
                    connection.execute(
                        """
                        SELECT COUNT(*) FROM listing_price_observations
                        WHERE listing_id LIKE 'lalpurja-nepal:market-smoke-%'
                        """
                    ).fetchone()[0]
                )
            assert history_observation_count == 14 * len(history_records)

            ready_response = await client.get(
                "/api/market/series",
                params={
                    "purpose": "buy",
                    "city": "Smoke City",
                    "type": "House",
                    "price_basis": "total",
                    "days": 60,
                },
            )
            assert ready_response.status_code == 200
            ready_payload = ready_response.json()
            assert ready_payload["status"] == "ready"
            assert ready_payload["readiness"]["ready"] is True
            assert ready_payload["readiness"]["historyWindowDays"] == 30
            assert ready_payload["readiness"]["qualifyingDays"] == 14
            assert len(ready_payload["items"]) == 14
            assert all(item["listingCount"] == 8 for item in ready_payload["items"])
            assert all(item["medianPriceNpr"] == 10_350_000 for item in ready_payload["items"])
            assert all(
                item["purpose"] == "buy"
                and item["city"] == "Smoke City"
                and item["propertyType"] == "House"
                and item["priceBasis"] == "total"
                for item in ready_payload["items"]
            )

            inactive_at = (history_now + timedelta(seconds=1)).isoformat()
            upsert_listings(
                history_records[:1],
                DB_PATH,
                fetched_at=inactive_at,
                replace_index_window_for_source="lalpurja-nepal",
            )
            with connect() as connection:
                state_rows = connection.execute(
                    """
                    SELECT listing_id, is_active
                    FROM listing_price_observations
                    WHERE observed_at = ? AND listing_id LIKE 'lalpurja-nepal:market-smoke-%'
                    """,
                    (inactive_at,),
                ).fetchall()
            assert len(state_rows) == 8
            assert sum(int(row["is_active"]) for row in state_rows) == 1
            post_deactivation = (
                await client.get(
                    "/api/market/series",
                    params={
                        "purpose": "buy",
                        "city": "Smoke City",
                        "type": "House",
                        "price_basis": "total",
                        "days": 60,
                    },
                )
            ).json()
            assert post_deactivation["status"] == "collecting"
            assert post_deactivation["items"][-1]["listingCount"] == 1

            analytics_records = [
                ListingRecord(
                    id=f"nepal-homes:analytics-smoke-{index}",
                    source_slug="nepal-homes",
                    external_id=f"analytics-smoke-{index}",
                    source_url=f"https://example.com/analytics-smoke/{index}",
                    title=f"Analytics test house {index}",
                    purpose="buy",
                    property_type="House",
                    price_npr=10_000_000 + index * 100_000,
                    price_basis="total",
                    price_label=f"NPR {10_000_000 + index * 100_000}",
                    location_name="Analytics City",
                    locality="Analytics Ward",
                    city="Analytics City",
                    area_label="4 aana",
                    raw_facts={"quality_flags": []},
                )
                for index in range(8)
            ]
            analytics_records.extend(
                (
                    ListingRecord(
                        id="ghar-bazar:analytics-smoke-duplicate",
                        source_slug="ghar-bazar",
                        external_id="analytics-smoke-duplicate",
                        source_url="https://example.com/analytics-smoke/duplicate",
                        title="Analytics test house 0",
                        purpose="buy",
                        property_type="House",
                        price_npr=10_000_000,
                        price_basis="total",
                        price_label="NPR 10000000",
                        location_name="Analytics City",
                        locality="Analytics Ward",
                        city="Analytics City",
                        area_label="4 aana",
                        raw_facts={"quality_flags": []},
                    ),
                    ListingRecord(
                        id="kantipur-real-estate:analytics-smoke-outlier",
                        source_slug="kantipur-real-estate",
                        external_id="analytics-smoke-outlier",
                        source_url="https://example.com/analytics-smoke/outlier",
                        title="Analytics extreme test house",
                        purpose="buy",
                        property_type="House",
                        price_npr=1_000_000_000,
                        price_basis="total",
                        price_label="NPR 1000000000",
                        location_name="Analytics City",
                        locality="Analytics Ward",
                        city="Analytics City",
                        area_label="4 aana",
                        raw_facts={"quality_flags": []},
                    ),
                    ListingRecord(
                        id="real-estate-in-nepal:analytics-smoke-euro",
                        source_slug="real-estate-in-nepal",
                        external_id="analytics-smoke-euro",
                        source_url="https://example.com/analytics-smoke/euro",
                        title="Analytics foreign-currency test house",
                        purpose="buy",
                        property_type="House",
                        price_npr=10_400_000,
                        price_basis="total",
                        price_label="EUR 10400000",
                        location_name="Analytics City",
                        locality="Analytics Ward",
                        city="Analytics City",
                        area_label="4 aana",
                        raw_facts={"quality_flags": [], "source_price_text": "EUR 10400000"},
                    ),
                )
            )
            upsert_listings(analytics_records, DB_PATH, fetched_at=history_now.isoformat())
            analytics_response = await client.get(
                "/api/market/series",
                params={
                    "purpose": "buy",
                    "city": "Analytics City",
                    "type": "House",
                    "price_basis": "total",
                    "days": 7,
                },
            )
            analytics_payload = analytics_response.json()
            assert analytics_response.status_code == 200
            assert len(analytics_payload["items"]) == 1
            assert analytics_payload["items"][0]["listingCount"] == 8
            assert analytics_payload["items"][0]["medianPriceNpr"] == 10_350_000
            with connect() as connection:
                duplicate_fingerprints = connection.execute(
                    """
                    SELECT duplicate_fingerprint
                    FROM listing_price_observations
                    WHERE listing_id IN (
                        'nepal-homes:analytics-smoke-0',
                        'ghar-bazar:analytics-smoke-duplicate'
                    )
                    ORDER BY listing_id
                    """
                ).fetchall()
            assert len(duplicate_fingerprints) == 2
            assert duplicate_fingerprints[0]["duplicate_fingerprint"]
            assert len({row["duplicate_fingerprint"] for row in duplicate_fingerprints}) == 1

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
    unsafe_record.title = "Safe public title"
    unsafe_record.raw_facts = {"seller": {"email": "owner@example.com", "phone": "9812345678"}}
    assert not record_is_safe(unsafe_record, "test-source")

    with TemporaryDirectory(prefix="nei-cold-start-") as directory:
        cold_database = Path(directory) / "real_estate.db"
        initialise(cold_database)
        assert seed_from_snapshot(EXPORT_PATH, cold_database) == health_payload["database"]["listing_count"]
        assert database_stats(cold_database)["listing_count"] == health_payload["database"]["listing_count"]
        with connect(cold_database) as connection:
            cold_observation_count = int(
                connection.execute("SELECT COUNT(*) FROM listing_price_observations").fetchone()[0]
            )
        assert cold_observation_count == health_payload["database"]["listing_count"]

    with TemporaryDirectory(prefix="nei-history-migration-") as directory:
        migration_database = Path(directory) / "real_estate.db"
        initialise(migration_database)
        migrated_listing_count = seed_from_snapshot(EXPORT_PATH, migration_database)
        assert migrated_listing_count == health_payload["database"]["listing_count"]
        with connect(migration_database) as connection:
            migration_rows = connection.execute(
                """
                SELECT id, last_fetched_at
                FROM listings
                ORDER BY id
                LIMIT 3
                """
            ).fetchall()
            assert len(migration_rows) == 3
            inactive_id = migration_rows[0]["id"]
            dirty_id = migration_rows[1]["id"]
            fallback_id = migration_rows[2]["id"]
            preserved_observed_at = migration_rows[0]["last_fetched_at"]
            connection.execute(
                """
                UPDATE listings
                SET is_active = 0, title = 'Migration inactive listing', price_npr = 10000000,
                    price_label = 'NPR 10000000', raw_facts_json = '{"quality_flags":[]}'
                WHERE id = ?
                """,
                (inactive_id,),
            )
            connection.execute(
                """
                UPDATE listings
                SET title = 'Migration dirty listing', price_npr = 10000000,
                    price_label = 'NPR 10000000', raw_facts_json = '{"quality_flags":["migration-test"]}'
                WHERE id = ?
                """,
                (dirty_id,),
            )
            connection.execute(
                """
                UPDATE listings
                SET title = 'Migration fallback listing', price_npr = 10000000,
                    price_label = 'NPR 10000000', raw_facts_json = '{"quality_flags":[]}',
                    last_fetched_at = ''
                WHERE id = ?
                """,
                (fallback_id,),
            )
            connection.execute("DROP TABLE listing_price_observations")
            assert not connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listing_price_observations'"
            ).fetchone()

        initialise(migration_database)
        with connect(migration_database) as connection:
            backfilled_count = int(
                connection.execute("SELECT COUNT(*) FROM listing_price_observations").fetchone()[0]
            )
            backfilled_rows = {
                row["listing_id"]: row
                for row in connection.execute(
                    """
                    SELECT listing_id, observed_at, is_active, is_clean, duplicate_fingerprint
                    FROM listing_price_observations
                    WHERE listing_id IN (?, ?, ?)
                    """,
                    (inactive_id, dirty_id, fallback_id),
                ).fetchall()
            }
        assert backfilled_count == migrated_listing_count
        assert backfilled_rows[inactive_id]["is_active"] == 0
        assert backfilled_rows[inactive_id]["is_clean"] == 1
        assert backfilled_rows[inactive_id]["observed_at"] == preserved_observed_at
        assert backfilled_rows[dirty_id]["is_active"] == 1
        assert backfilled_rows[dirty_id]["is_clean"] == 0
        assert backfilled_rows[fallback_id]["is_active"] == 1
        assert backfilled_rows[fallback_id]["is_clean"] == 1
        assert all(row["duplicate_fingerprint"] for row in backfilled_rows.values())
        fallback_observed_at = datetime.fromisoformat(backfilled_rows[fallback_id]["observed_at"])
        assert abs((datetime.now(UTC) - fallback_observed_at).total_seconds()) < 5
        migrated_series, migrated_as_of = list_market_series(days=365, path=migration_database)
        assert migrated_series and migrated_as_of
        initialise(migration_database)
        with connect(migration_database) as connection:
            second_initialise_count = int(
                connection.execute("SELECT COUNT(*) FROM listing_price_observations").fetchone()[0]
            )
        assert second_initialise_count == backfilled_count
        with connect(migration_database) as connection:
            connection.execute(
                "ALTER TABLE listing_price_observations DROP COLUMN duplicate_fingerprint"
            )
        initialise(migration_database)
        with connect(migration_database) as connection:
            migrated_observation_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(listing_price_observations)")
            }
            migrated_fingerprint_count = int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM listing_price_observations
                    WHERE duplicate_fingerprint <> ''
                    """
                ).fetchone()[0]
            )
        assert "duplicate_fingerprint" in migrated_observation_columns
        assert migrated_fingerprint_count == backfilled_count

    with TemporaryDirectory(prefix="nei-full-export-") as directory:
        export_database = Path(directory) / "real_estate.db"
        export_path = Path(directory) / "listings.json"
        initialise(export_database)
        export_records = [
            ListingRecord(
                id=f"nepal-homes:export-smoke-{index}",
                source_slug="nepal-homes",
                external_id=f"export-smoke-{index}",
                source_url=f"https://example.com/export-smoke/{index}",
                title=f"Export test property {index}",
                purpose="buy",
                property_type="House",
                price_npr=10_000_000 + index,
                price_basis="total",
                price_label=f"NPR {10_000_000 + index}",
                location_name="Export City",
                locality="Export Ward",
                city="Export City",
                area_label="4 aana",
            )
            for index in range(251)
        ]
        upsert_listings(export_records, export_database)
        exported = export_snapshot(export_path, export_database)
        written_export = json.loads(export_path.read_text(encoding="utf-8"))
        assert exported["total"] == exported["limit"] == len(exported["items"]) == 251
        assert written_export["total"] == len(written_export["items"]) == 251

    with TemporaryDirectory(prefix="nei-legacy-basis-") as directory:
        legacy_database = Path(directory) / "real_estate.db"
        legacy_snapshot = Path(directory) / "listings.json"
        legacy_snapshot.write_text(
            json.dumps(
                {
                    "asOf": datetime.now(UTC).isoformat(),
                    "items": [
                        {
                            "id": "nepal-homes:legacy-land-total",
                            "sourceUrl": "https://example.com/legacy-land-total",
                            "title": "Legacy land total",
                            "purpose": "buy",
                            "type": "Land",
                            "price": 20_000_000,
                            "priceLabel": "NPR 20000000",
                            "location": "Legacy City",
                            "city": "Legacy City",
                        },
                        {
                            "id": "nepal-homes:legacy-private-contact",
                            "sourceUrl": "https://example.com/legacy-private-contact",
                            "title": "Legacy unsafe record",
                            "purpose": "buy",
                            "type": "House",
                            "price": 20_000_000,
                            "location": "Legacy City",
                            "city": "Legacy City",
                            "facts": {"seller_email": "owner@example.com"},
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        initialise(legacy_database)
        assert seed_from_snapshot(legacy_snapshot, legacy_database) == 1
        legacy_items, legacy_total = list_listings(path=legacy_database)
        assert legacy_total == 1
        assert legacy_items[0]["priceBasis"] == "total"

    print(
        "API smoke test passed: HTTP boundary, SQLite cold start, market history, filters, "
        "attribution, and privacy controls."
    )


if __name__ == "__main__":
    asyncio.run(main())
