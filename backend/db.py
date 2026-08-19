from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections import defaultdict
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from statistics import median
from typing import Iterator, Sequence

from backend.config import DB_PATH
from backend.sources.base import ListingRecord


SOURCE_CATALOG = (
    {
        "slug": "lalpurja-nepal",
        "name": "Lalpurja Nepal",
        "base_url": "https://lalpurjanepal.com.np/home",
        "terms_url": "https://lalpurjanepal.com.np/robots.txt",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Project owner states that the publisher authorized listing data and photographs for this private prototype.",
    },
    {
        "slug": "nepal-homes",
        "name": "Nepal Homes",
        "base_url": "https://www.nepalhomes.com/",
        "terms_url": "https://www.nepalhomes.com/term-and-condition",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Owner permission asserted for this private prototype; the bounded source adapter is enabled.",
    },
    {
        "slug": "real-estate-in-nepal",
        "name": "Real Estate in Nepal",
        "base_url": "https://realestateinnepal.com/",
        "terms_url": "https://realestateinnepal.com/terms-conditions/",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Owner permission asserted for this private prototype; the bounded source adapter is enabled.",
    },
    {
        "slug": "ghar-ghaderi",
        "name": "GharGhaderi",
        "base_url": "https://www.gharghaderi.com/",
        "terms_url": "https://www.gharghaderi.com/terms-of-use/",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Owner permission asserted for this private prototype; the bounded source adapter is enabled.",
    },
    {
        "slug": "nepal-property-bazaar",
        "name": "Nepal Property Bazaar",
        "base_url": "https://nepalpropertybazaar.com/",
        "terms_url": "https://nepalpropertybazaar.com/terms-and-conditions/",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Owner permission asserted for this private prototype; the bounded source adapter is enabled.",
    },
    {
        "slug": "property-in-nepal",
        "name": "Property in Nepal",
        "base_url": "https://www.propertyinnepal.com.np/",
        "terms_url": "",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Owner permission asserted for this private prototype; the bounded source adapter is enabled.",
    },
    {
        "slug": "ghar-sansar-nepal",
        "name": "Ghar Sansar Nepal",
        "base_url": "https://gharsansarnepal.com/",
        "terms_url": "https://www.gharsansarnepal.com/gharsansar/nepal/term",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Owner permission asserted for this private prototype; the bounded source adapter is enabled.",
    },
    {
        "slug": "kantipur-real-estate",
        "name": "Kantipur Real Estate",
        "base_url": "https://www.kantipurrealestate.com/",
        "terms_url": "",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Owner permission asserted for this private prototype; the bounded source adapter is enabled.",
    },
    {
        "slug": "ghar-bazar",
        "name": "GharBazar",
        "base_url": "https://www.gharbazar.com/",
        "terms_url": "https://www.gharbazar.com/contents/page/ghar-jagga-bazar-nepal-terms-of-use",
        "status": "active",
        "collection_mode": "owner-authorized-prototype",
        "content_license_status": "owner-permission-attested-private-prototype",
        "image_license_status": "owner-permission-attested-private-prototype",
        "permission_basis": "Project owner attestation received 2026-08-17",
        "permission_scope": "Private prototype use of listing data and photographs",
        "policy_note": "Owner permission asserted for this private prototype; the bounded source adapter is enabled.",
    },
)


SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    terms_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    collection_mode TEXT NOT NULL,
    content_license_status TEXT NOT NULL DEFAULT 'unconfirmed',
    image_license_status TEXT NOT NULL DEFAULT 'unconfirmed',
    permission_basis TEXT NOT NULL DEFAULT '',
    permission_scope TEXT NOT NULL DEFAULT '',
    policy_note TEXT NOT NULL DEFAULT '',
    last_run_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    listing_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    source_slug TEXT NOT NULL REFERENCES sources(slug),
    external_id TEXT NOT NULL,
    source_url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('buy', 'rent')),
    property_type TEXT NOT NULL,
    price_npr INTEGER,
    price_basis TEXT NOT NULL DEFAULT 'total',
    price_label TEXT NOT NULL,
    location_name TEXT NOT NULL,
    locality TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    area_label TEXT NOT NULL DEFAULT '',
    bedrooms INTEGER,
    bathrooms INTEGER,
    description_excerpt TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    image_alt TEXT NOT NULL DEFAULT '',
    image_credit TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    location_precision TEXT NOT NULL DEFAULT 'unknown',
    source_age_label TEXT NOT NULL DEFAULT '',
    raw_facts_json TEXT NOT NULL DEFAULT '{}',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_fetched_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(source_slug, external_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_filters
ON listings(is_active, purpose, city, property_type, price_npr);

CREATE TABLE IF NOT EXISTS listing_price_observations (
    listing_id TEXT NOT NULL REFERENCES listings(id),
    observed_at TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('buy', 'rent')),
    city TEXT NOT NULL DEFAULT '',
    property_type TEXT NOT NULL,
    price_npr INTEGER,
    price_basis TEXT NOT NULL,
    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
    is_clean INTEGER NOT NULL CHECK (is_clean IN (0, 1)),
    duplicate_fingerprint TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(listing_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_price_observations_market_series
ON listing_price_observations(
    observed_at, purpose, city, property_type, price_basis, is_active, is_clean
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_slug TEXT NOT NULL REFERENCES sources(slug),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    discovered INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
"""


def utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@contextmanager
def connect(path: Path = DB_PATH) -> Iterator[sqlite3.Connection]:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def initialise(path: Path = DB_PATH) -> None:
    with connect(path) as connection:
        connection.executescript(SCHEMA)
        columns = {row[1] for row in connection.execute("PRAGMA table_info(sources)")}
        if "content_license_status" not in columns:
            connection.execute("ALTER TABLE sources ADD COLUMN content_license_status TEXT NOT NULL DEFAULT 'unconfirmed'")
        if "image_license_status" not in columns:
            connection.execute("ALTER TABLE sources ADD COLUMN image_license_status TEXT NOT NULL DEFAULT 'unconfirmed'")
        if "permission_basis" not in columns:
            connection.execute("ALTER TABLE sources ADD COLUMN permission_basis TEXT NOT NULL DEFAULT ''")
        if "permission_scope" not in columns:
            connection.execute("ALTER TABLE sources ADD COLUMN permission_scope TEXT NOT NULL DEFAULT ''")
        listing_columns = {row[1] for row in connection.execute("PRAGMA table_info(listings)")}
        if "price_basis" not in listing_columns:
            connection.execute("ALTER TABLE listings ADD COLUMN price_basis TEXT NOT NULL DEFAULT 'total'")
            connection.execute("UPDATE listings SET price_basis = 'monthly' WHERE purpose = 'rent'")
        observation_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(listing_price_observations)")
        }
        if "duplicate_fingerprint" not in observation_columns:
            connection.execute(
                """
                ALTER TABLE listing_price_observations
                ADD COLUMN duplicate_fingerprint TEXT NOT NULL DEFAULT ''
                """
            )
        connection.execute(
            """
            UPDATE listings
            SET property_type = 'Commercial'
            WHERE property_type = 'Rental'
              AND (LOWER(title) LIKE '%commercial%' OR LOWER(title) LIKE '%office%')
            """
        )
        connection.execute(
            """
            UPDATE listings
            SET price_label = price_label || ' / aana'
            WHERE price_basis = 'per-aana'
              AND price_npr IS NOT NULL
              AND LOWER(price_label) NOT LIKE '%/ aana%'
              AND LOWER(price_label) NOT LIKE '%per aana%'
              AND LOWER(price_label) NOT LIKE '%per anna%'
            """
        )
        connection.execute(
            """
            UPDATE listings
            SET price_label = SUBSTR(price_label, 1, LENGTH(price_label) - LENGTH(' / aana'))
            WHERE LOWER(price_label) LIKE '%per aana% / aana'
               OR LOWER(price_label) LIKE '%per anna% / aana'
            """
        )
        connection.execute(
            """
            UPDATE listings
            SET area_label = REPLACE(area_label, ' · verify source unit', '')
            WHERE area_label LIKE '%verify source unit%'
              AND CAST(REPLACE(area_label, ',', '') AS REAL) >= 100
            """
        )
        connection.execute(
            """
            UPDATE listings
            SET area_label = area_label || ' · verify source unit'
            WHERE property_type IN ('House', 'Apartment', 'Commercial')
              AND area_label LIKE '%sq ft%'
              AND CAST(REPLACE(area_label, ',', '') AS REAL) > 0
              AND CAST(REPLACE(area_label, ',', '') AS REAL) < 100
              AND area_label NOT LIKE '%verify source unit%'
            """
        )
        connection.executemany(
            """
            INSERT INTO sources(
                slug, name, base_url, terms_url, status, collection_mode,
                content_license_status, image_license_status, permission_basis,
                permission_scope, policy_note
            ) VALUES(
                :slug, :name, :base_url, :terms_url, :status, :collection_mode,
                :content_license_status, :image_license_status, :permission_basis,
                :permission_scope, :policy_note
            )
            ON CONFLICT(slug) DO UPDATE SET
                name = excluded.name,
                base_url = excluded.base_url,
                terms_url = excluded.terms_url,
                status = excluded.status,
                collection_mode = excluded.collection_mode,
                content_license_status = excluded.content_license_status,
                image_license_status = excluded.image_license_status,
                permission_basis = excluded.permission_basis,
                permission_scope = excluded.permission_scope,
                policy_note = excluded.policy_note
            """,
            SOURCE_CATALOG,
        )
        _backfill_price_observations(connection)


def start_run(source_slug: str, path: Path = DB_PATH) -> int:
    now = utcnow()
    with connect(path) as connection:
        cursor = connection.execute(
            "INSERT INTO ingestion_runs(source_slug, started_at, status) VALUES (?, ?, 'running')",
            (source_slug, now),
        )
        connection.execute(
            "UPDATE sources SET last_run_at = ?, last_error = NULL WHERE slug = ?",
            (now, source_slug),
        )
        return int(cursor.lastrowid)


def finish_run(
    run_id: int,
    source_slug: str,
    *,
    status: str,
    discovered: int = 0,
    inserted: int = 0,
    updated: int = 0,
    error: str | None = None,
    path: Path = DB_PATH,
) -> None:
    now = utcnow()
    with connect(path) as connection:
        connection.execute(
            """
            UPDATE ingestion_runs
            SET finished_at = ?, status = ?, discovered = ?, inserted = ?, updated = ?, error = ?
            WHERE id = ?
            """,
            (now, status, discovered, inserted, updated, error, run_id),
        )
        if status == "success":
            connection.execute(
                """
                UPDATE sources
                SET last_success_at = ?, last_error = NULL,
                    listing_count = (SELECT COUNT(*) FROM listings WHERE source_slug = ? AND is_active = 1)
                WHERE slug = ?
                """,
                (now, source_slug, source_slug),
            )
        else:
            connection.execute("UPDATE sources SET last_error = ? WHERE slug = ?", (error, source_slug))


def _is_clean_asking_price(
    *,
    price_npr: int | None,
    title: str,
    price_label: str,
    raw_facts: dict[str, object],
) -> bool:
    if price_npr is None or price_npr <= 0:
        return False
    quality_flags = raw_facts.get("quality_flags")
    if quality_flags:
        return False
    source_price = " ".join(
        str(raw_facts.get(key) or "") for key in ("source_price_text", "source_price_label")
    )
    return re.search(
        r"\$|€|£|₹|\b(?:usd|dollars?|eur|euros?|inr|indian\s+rupees?|gbp|pounds?\s+sterling|aud|cad|cny|rmb|aed)\b",
        f"{title} {price_label} {source_price}",
        re.IGNORECASE,
    ) is None


def _duplicate_fingerprint(
    *,
    title: str,
    purpose: str,
    city: str,
    property_type: str,
    price_npr: int | None,
    price_basis: str,
) -> str:
    """Hash the public comparison identity without retaining title text in history."""

    def normalise(value: object) -> str:
        return re.sub(r"[\W_]+", " ", str(value or "").casefold(), flags=re.UNICODE).strip()

    identity = "\x1f".join(
        (
            normalise(title),
            normalise(purpose),
            normalise(city),
            normalise(property_type),
            str(price_npr) if price_npr is not None else "",
            normalise(price_basis),
        )
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _append_price_observation(
    connection: sqlite3.Connection,
    *,
    listing_id: str,
    observed_at: str,
    purpose: str,
    city: str,
    property_type: str,
    price_npr: int | None,
    price_basis: str,
    is_active: bool,
    is_clean: bool,
    duplicate_fingerprint: str,
) -> None:
    connection.execute(
        """
        INSERT INTO listing_price_observations(
            listing_id, observed_at, purpose, city, property_type,
            price_npr, price_basis, is_active, is_clean, duplicate_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(listing_id, observed_at) DO NOTHING
        """,
        (
            listing_id,
            observed_at,
            purpose,
            city,
            property_type,
            price_npr,
            price_basis,
            int(is_active),
            int(is_clean),
            duplicate_fingerprint,
        ),
    )


def _backfill_price_observations(connection: sqlite3.Connection) -> None:
    fallback_observed_at = utcnow()
    if not connection.execute("SELECT 1 FROM listing_price_observations LIMIT 1").fetchone():
        rows = connection.execute(
            """
            SELECT id, title, purpose, city, property_type, price_npr, price_basis,
                   price_label, raw_facts_json, last_fetched_at, is_active
            FROM listings
            """
        ).fetchall()
        for row in rows:
            try:
                raw_facts = json.loads(row["raw_facts_json"] or "{}")
            except json.JSONDecodeError:
                raw_facts = {}
            observed_at = row["last_fetched_at"] or fallback_observed_at
            try:
                datetime.fromisoformat(observed_at)
            except (TypeError, ValueError):
                observed_at = fallback_observed_at
            _append_price_observation(
                connection,
                listing_id=row["id"],
                observed_at=observed_at,
                purpose=row["purpose"],
                city=row["city"],
                property_type=row["property_type"],
                price_npr=row["price_npr"],
                price_basis=row["price_basis"],
                is_active=bool(row["is_active"]),
                is_clean=_is_clean_asking_price(
                    price_npr=row["price_npr"],
                    title=row["title"],
                    price_label=row["price_label"],
                    raw_facts=raw_facts if isinstance(raw_facts, dict) else {},
                ),
                duplicate_fingerprint=_duplicate_fingerprint(
                    title=row["title"],
                    purpose=row["purpose"],
                    city=row["city"],
                    property_type=row["property_type"],
                    price_npr=row["price_npr"],
                    price_basis=row["price_basis"],
                ),
            )

    missing_fingerprints = connection.execute(
        """
        SELECT o.rowid AS observation_rowid, l.title, o.purpose, o.city,
               o.property_type, o.price_npr, o.price_basis
        FROM listing_price_observations o
        JOIN listings l ON l.id = o.listing_id
        WHERE o.duplicate_fingerprint = ''
        """
    ).fetchall()
    connection.executemany(
        "UPDATE listing_price_observations SET duplicate_fingerprint = ? WHERE rowid = ?",
        (
            (
                _duplicate_fingerprint(
                    title=row["title"],
                    purpose=row["purpose"],
                    city=row["city"],
                    property_type=row["property_type"],
                    price_npr=row["price_npr"],
                    price_basis=row["price_basis"],
                ),
                row["observation_rowid"],
            )
            for row in missing_fingerprints
        ),
    )


def upsert_listings(
    records: Sequence[ListingRecord],
    path: Path = DB_PATH,
    *,
    fetched_at: str | None = None,
    replace_index_window_for_source: str | None = None,
) -> tuple[int, int]:
    if not records:
        return 0, 0
    if replace_index_window_for_source and any(
        record.source_slug != replace_index_window_for_source for record in records
    ):
        raise ValueError("Replacement records must all belong to the selected source")
    now = fetched_at or utcnow()
    inserted = 0
    updated = 0
    with connect(path) as connection:
        deactivated_rows: list[sqlite3.Row] = []
        # is_active means "present in the current bounded index window". It is
        # not a claim that a property outside that window has sold.
        if replace_index_window_for_source:
            deactivated_rows = connection.execute(
                """
                SELECT id, title, purpose, city, property_type, price_npr,
                       price_basis, price_label, raw_facts_json
                FROM listings
                WHERE source_slug = ? AND is_active = 1
                """,
                (replace_index_window_for_source,),
            ).fetchall()
            connection.execute(
                "UPDATE listings SET is_active = 0 WHERE source_slug = ?",
                (replace_index_window_for_source,),
            )
        active_ids: set[str] = set()
        for record in records:
            active_ids.add(record.id)
            exists = connection.execute("SELECT 1 FROM listings WHERE id = ?", (record.id,)).fetchone()
            connection.execute(
                """
                INSERT INTO listings(
                    id, source_slug, external_id, source_url, title, purpose, property_type,
                    price_npr, price_basis, price_label, location_name, locality, city, area_label,
                    bedrooms, bathrooms, description_excerpt, image_url, image_alt, image_credit,
                    latitude, longitude, location_precision, source_age_label, raw_facts_json,
                    first_seen_at, last_seen_at, last_fetched_at, is_active
                ) VALUES(
                    :id, :source_slug, :external_id, :source_url, :title, :purpose, :property_type,
                    :price_npr, :price_basis, :price_label, :location_name, :locality, :city, :area_label,
                    :bedrooms, :bathrooms, :description_excerpt, :image_url, :image_alt, :image_credit,
                    :latitude, :longitude, :location_precision, :source_age_label, :raw_facts_json,
                    :first_seen_at, :last_seen_at, :last_fetched_at, 1
                )
                ON CONFLICT(id) DO UPDATE SET
                    source_url = excluded.source_url,
                    title = excluded.title,
                    purpose = excluded.purpose,
                    property_type = excluded.property_type,
                    price_npr = excluded.price_npr,
                    price_basis = excluded.price_basis,
                    price_label = excluded.price_label,
                    location_name = excluded.location_name,
                    locality = excluded.locality,
                    city = excluded.city,
                    area_label = excluded.area_label,
                    bedrooms = excluded.bedrooms,
                    bathrooms = excluded.bathrooms,
                    description_excerpt = excluded.description_excerpt,
                    image_url = excluded.image_url,
                    image_alt = excluded.image_alt,
                    image_credit = excluded.image_credit,
                    latitude = excluded.latitude,
                    longitude = excluded.longitude,
                    location_precision = excluded.location_precision,
                    source_age_label = excluded.source_age_label,
                    raw_facts_json = excluded.raw_facts_json,
                    last_seen_at = excluded.last_seen_at,
                    last_fetched_at = excluded.last_fetched_at,
                    is_active = 1
                """,
                {
                    **record.as_dict(),
                    "raw_facts_json": json.dumps(record.raw_facts, ensure_ascii=False, separators=(",", ":")),
                    "first_seen_at": now,
                    "last_seen_at": now,
                    "last_fetched_at": now,
                },
            )
            if exists:
                updated += 1
            else:
                inserted += 1
            _append_price_observation(
                connection,
                listing_id=record.id,
                observed_at=now,
                purpose=record.purpose,
                city=record.city,
                property_type=record.property_type,
                price_npr=record.price_npr,
                price_basis=record.price_basis,
                is_active=True,
                is_clean=_is_clean_asking_price(
                    price_npr=record.price_npr,
                    title=record.title,
                    price_label=record.price_label,
                    raw_facts=record.raw_facts,
                ),
                duplicate_fingerprint=_duplicate_fingerprint(
                    title=record.title,
                    purpose=record.purpose,
                    city=record.city,
                    property_type=record.property_type,
                    price_npr=record.price_npr,
                    price_basis=record.price_basis,
                ),
            )
        for row in deactivated_rows:
            if row["id"] in active_ids:
                continue
            try:
                raw_facts = json.loads(row["raw_facts_json"] or "{}")
            except json.JSONDecodeError:
                raw_facts = {}
            _append_price_observation(
                connection,
                listing_id=row["id"],
                observed_at=now,
                purpose=row["purpose"],
                city=row["city"],
                property_type=row["property_type"],
                price_npr=row["price_npr"],
                price_basis=row["price_basis"],
                is_active=False,
                is_clean=_is_clean_asking_price(
                    price_npr=row["price_npr"],
                    title=row["title"],
                    price_label=row["price_label"],
                    raw_facts=raw_facts if isinstance(raw_facts, dict) else {},
                ),
                duplicate_fingerprint=_duplicate_fingerprint(
                    title=row["title"],
                    purpose=row["purpose"],
                    city=row["city"],
                    property_type=row["property_type"],
                    price_npr=row["price_npr"],
                    price_basis=row["price_basis"],
                ),
            )
        connection.execute(
            """
            UPDATE sources
            SET listing_count = (
                SELECT COUNT(*) FROM listings
                WHERE source_slug = sources.slug AND is_active = 1
            )
            """
        )
    return inserted, updated


def _approximate_source_published_at(age_label: str, fetched_at: str) -> str | None:
    try:
        published = datetime.fromisoformat(fetched_at)
    except (TypeError, ValueError):
        return None
    units = {name: float(amount) for amount, name in re.findall(r"([\d.]+)\s*(year|month|week|day|hour|minute)s?", age_label.lower())}
    if not units:
        return None
    published -= timedelta(
        days=units.get("year", 0) * 365 + units.get("month", 0) * 30 + units.get("week", 0) * 7 + units.get("day", 0),
        hours=units.get("hour", 0),
        minutes=units.get("minute", 0),
    )
    return published.isoformat(timespec="seconds")


def _frontend_listing(row: sqlite3.Row) -> dict[str, object]:
    latitude = row["latitude"]
    longitude = row["longitude"]
    map_query = ", ".join(part for part in (row["locality"], row["city"], "Nepal") if part)
    return {
        "id": row["id"],
        "title": row["title"],
        "location": row["location_name"],
        "locality": row["locality"],
        "city": row["city"],
        "type": row["property_type"],
        "purpose": row["purpose"],
        "price": row["price_npr"],
        "priceBasis": row["price_basis"],
        "priceLabel": row["price_label"],
        "beds": row["bedrooms"],
        "baths": row["bathrooms"],
        "area": row["area_label"],
        "image": row["image_url"],
        "imageAlt": row["image_alt"],
        "imageCredit": row["image_credit"],
        "imagePosition": "center",
        "description": row["description_excerpt"],
        "sourceName": row["source_name"],
        "sourceUrl": row["source_url"],
        "contentLicenseStatus": row["content_license_status"],
        "imageLicenseStatus": row["image_license_status"],
        "sourceAgeLabel": row["source_age_label"],
        "sourcePublishedAt": _approximate_source_published_at(row["source_age_label"], row["last_fetched_at"]),
        "indexedAt": row["last_fetched_at"],
        "latitude": latitude,
        "longitude": longitude,
        "locationPrecision": row["location_precision"],
        "mapQuery": map_query,
        "facts": json.loads(row["raw_facts_json"] or "{}"),
    }


def list_listings(
    *,
    purpose: str | None = None,
    city: str | None = None,
    property_type: str | None = None,
    max_price: int | None = None,
    source: str | None = None,
    limit: int = 100,
    offset: int = 0,
    path: Path = DB_PATH,
) -> tuple[list[dict[str, object]], int]:
    clauses = ["l.is_active = 1"]
    parameters: list[object] = []
    for column, value in (("l.purpose", purpose), ("l.city", city), ("l.property_type", property_type), ("l.source_slug", source)):
        if value:
            clauses.append(f"{column} = ?")
            parameters.append(value)
    if max_price is not None:
        clauses.append("l.price_basis IN ('total', 'monthly') AND l.price_npr IS NOT NULL AND l.price_npr <= ?")
        parameters.append(max_price)
    where = " AND ".join(clauses)
    with connect(path) as connection:
        total = int(connection.execute(f"SELECT COUNT(*) FROM listings l WHERE {where}", parameters).fetchone()[0])
        rows = connection.execute(
            f"""
            SELECT l.*, s.name AS source_name, s.content_license_status, s.image_license_status
            FROM listings l JOIN sources s ON s.slug = l.source_slug
            WHERE {where}
            ORDER BY l.last_fetched_at DESC, l.id DESC
            LIMIT ? OFFSET ?
            """,
            (*parameters, min(max(limit, 1), 250), max(offset, 0)),
        ).fetchall()
    return [_frontend_listing(row) for row in rows], total


def list_sources(path: Path = DB_PATH) -> list[dict[str, object]]:
    with connect(path) as connection:
        rows = connection.execute(
            """
            SELECT slug, name, base_url, terms_url, status, collection_mode,
                   content_license_status, image_license_status, permission_basis,
                   permission_scope, policy_note,
                   last_run_at, last_success_at, last_error, listing_count
            FROM sources ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name
            """
        ).fetchall()
    return [dict(row) for row in rows]


def _market_quantile(values: Sequence[int], percentile: float) -> float:
    index = (len(values) - 1) * percentile
    lower = int(index)
    fraction = index - lower
    if lower + 1 >= len(values):
        return float(values[lower])
    return float(values[lower]) + fraction * (values[lower + 1] - values[lower])


def _screen_market_outliers(prices: Sequence[int]) -> list[int]:
    ordered = sorted(prices)
    if len(ordered) < 8:
        return ordered
    first_quartile = _market_quantile(ordered, 0.25)
    third_quartile = _market_quantile(ordered, 0.75)
    interquartile_range = third_quartile - first_quartile
    lower_fence = max(0.0, first_quartile - interquartile_range * 2.5)
    upper_fence = third_quartile + interquartile_range * 2.5
    return [price for price in ordered if lower_fence <= price <= upper_fence]


def list_market_series(
    *,
    purpose: str | None = None,
    city: str | None = None,
    property_type: str | None = None,
    price_basis: str | None = None,
    days: int = 90,
    path: Path = DB_PATH,
) -> tuple[list[dict[str, object]], str | None]:
    """Return daily medians for exact, like-for-like asking-price cohorts."""
    bounded_days = min(max(days, 7), 365)
    today = datetime.now(UTC).date()
    first_date = (today - timedelta(days=bounded_days - 1)).isoformat()
    next_date = (today + timedelta(days=1)).isoformat()
    cohort_clauses: list[str] = []
    parameters: list[object] = [first_date, next_date]
    for column, value in (
        ("purpose", purpose),
        ("city", city),
        ("property_type", property_type),
        ("price_basis", price_basis),
    ):
        if value:
            cohort_clauses.append(f"{column} = ?")
            parameters.append(value)
    cohort_where = "" if not cohort_clauses else f" AND {' AND '.join(cohort_clauses)}"
    with connect(path) as connection:
        latest_observation = connection.execute(
            f"""
            SELECT MAX(observed_at)
            FROM listing_price_observations
            WHERE observed_at >= ? AND observed_at < ?
              AND is_active = 1
              AND is_clean = 1
              AND price_npr > 0
              {cohort_where}
            """,
            parameters,
        ).fetchone()[0]
        rows = connection.execute(
            f"""
            WITH ranked AS (
                SELECT observed_at, DATE(observed_at) AS observed_date,
                       listing_id, purpose, city, property_type, price_npr,
                       price_basis, is_active, is_clean, duplicate_fingerprint,
                       ROW_NUMBER() OVER (
                           PARTITION BY listing_id, DATE(observed_at)
                           ORDER BY observed_at DESC
                       ) AS daily_rank
                FROM listing_price_observations
                WHERE observed_at >= ? AND observed_at < ?
            )
            SELECT observed_at, observed_date, listing_id, purpose, city, property_type,
                   price_npr, price_basis, duplicate_fingerprint
            FROM ranked
            WHERE daily_rank = 1
              AND is_active = 1
              AND is_clean = 1
              AND price_npr > 0
              {cohort_where}
            ORDER BY observed_date, purpose, city, property_type, price_basis, price_npr
            """,
            parameters,
        ).fetchall()

    groups: dict[tuple[str, str, str, str, str], dict[str, int]] = defaultdict(dict)
    for row in rows:
        key = (
            row["observed_date"],
            row["purpose"],
            row["city"],
            row["property_type"],
            row["price_basis"],
        )
        fingerprint = row["duplicate_fingerprint"] or f"listing:{row['listing_id']}"
        groups[key].setdefault(fingerprint, int(row["price_npr"]))

    items: list[dict[str, object]] = []
    for (date, group_purpose, group_city, group_type, group_basis), deduplicated in groups.items():
        prices = _screen_market_outliers(list(deduplicated.values()))
        if not prices:
            continue
        median_price = median(prices)
        items.append(
            {
                "date": date,
                "purpose": group_purpose,
                "city": group_city,
                "propertyType": group_type,
                "priceBasis": group_basis,
                "medianPriceNpr": int(median_price) if float(median_price).is_integer() else median_price,
                "listingCount": len(prices),
            }
        )
    return items, latest_observation


def database_stats(path: Path = DB_PATH) -> dict[str, object]:
    with connect(path) as connection:
        listing_count = int(connection.execute("SELECT COUNT(*) FROM listings WHERE is_active = 1").fetchone()[0])
        latest = connection.execute("SELECT MAX(last_fetched_at) FROM listings WHERE is_active = 1").fetchone()[0]
    return {"listing_count": listing_count, "latest_fetch_at": latest}
