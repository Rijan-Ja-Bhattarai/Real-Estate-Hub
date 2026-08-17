from __future__ import annotations

import asyncio
import logging
import secrets
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.config import ENABLE_SCHEDULER, EXPORT_PATH, REFRESH_HOURS, REFRESH_TOKEN, ROOT_DIR
from backend.db import database_stats, initialise, list_listings, list_sources
from backend.ingest import export_snapshot, refresh_all, seed_from_snapshot


LOGGER = logging.getLogger("nepal_estate_index")


def report_refresh_failures(results: list[dict[str, object]]) -> None:
    for result in results:
        if result.get("status") == "failed":
            LOGGER.warning("Property refresh failed for %s: %s", result.get("source"), result.get("error"))


def data_freshness() -> dict[str, object]:
    stats = database_stats()
    latest = stats.get("latest_fetch_at")
    age_hours: float | None = None
    if isinstance(latest, str):
        try:
            age_hours = max(0.0, (datetime.now(UTC) - datetime.fromisoformat(latest)).total_seconds() / 3600)
        except ValueError:
            pass
    active_errors = [source["last_error"] for source in list_sources() if source["status"] == "active" and source["last_error"]]
    stale = age_hours is None or age_hours > REFRESH_HOURS * 2 or bool(active_errors)
    return {
        "state": "stale" if stale else "fresh",
        "ageHours": round(age_hours, 2) if age_hours is not None else None,
        "sourceErrors": active_errors,
    }


async def refresh_when_due() -> None:
    stats = database_stats()
    latest = stats.get("latest_fetch_at")
    due = latest is None
    if isinstance(latest, str):
        try:
            due = datetime.fromisoformat(latest) <= datetime.now(UTC) - timedelta(hours=REFRESH_HOURS)
        except ValueError:
            due = True
    if due:
        try:
            report_refresh_failures(await refresh_all())
        except Exception:
            LOGGER.exception("Unexpected scheduled property refresh failure")


async def scheduler() -> None:
    await refresh_when_due()
    while True:
        await asyncio.sleep(max(REFRESH_HOURS * 3600, 60))
        try:
            report_refresh_failures(await refresh_all())
        except Exception:
            LOGGER.exception("Unexpected scheduled property refresh failure")


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialise()
    seed_from_snapshot()
    if not EXPORT_PATH.exists():
        export_snapshot()
    task = asyncio.create_task(scheduler()) if ENABLE_SCHEDULER else None
    try:
        yield
    finally:
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


app = FastAPI(
    title="Nepal Estate Index API",
    version="0.2.0",
    description="Read-only, source-attributed property search backed by SQLite.",
    lifespan=lifespan,
)


@app.get("/api/health")
async def health() -> dict[str, object]:
    freshness = data_freshness()
    return {
        "status": "ok" if freshness["state"] == "fresh" else "degraded",
        "database": database_stats(),
        "freshness": freshness,
        "refreshHours": REFRESH_HOURS,
    }


@app.get("/api/sources")
async def sources() -> dict[str, object]:
    return {"items": list_sources()}


@app.get("/api/listings")
async def listings(
    purpose: Annotated[str | None, Query(pattern="^(buy|rent)$")] = None,
    city: str | None = None,
    property_type: Annotated[str | None, Query(alias="type")] = None,
    max_price: Annotated[int | None, Query(ge=0)] = None,
    source: str | None = None,
    limit: Annotated[int, Query(ge=1, le=250)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, object]:
    items, total = list_listings(
        purpose=purpose,
        city=city,
        property_type=property_type,
        max_price=max_price,
        source=source,
        limit=limit,
        offset=offset,
    )
    stats = database_stats()
    source_items = list_sources()
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "asOf": stats["latest_fetch_at"],
        "freshness": data_freshness(),
        "mode": "live-database",
        "sources": [
            {
                "slug": item["slug"],
                "name": item["name"],
                "status": item["status"],
                "listingCount": item["listing_count"],
            }
            for item in source_items
        ],
    }


@app.post("/api/admin/refresh")
async def refresh(x_refresh_token: Annotated[str | None, Header()] = None) -> JSONResponse:
    if not REFRESH_TOKEN:
        raise HTTPException(status_code=404, detail="Refresh route is disabled")
    if not x_refresh_token or not secrets.compare_digest(x_refresh_token, REFRESH_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    results = await refresh_all()
    return JSONResponse({"items": results})


@app.get("/")
def homepage() -> FileResponse:
    return FileResponse(ROOT_DIR / "index.html", media_type="text/html")


@app.get("/index.html")
def index_file() -> FileResponse:
    return FileResponse(ROOT_DIR / "index.html", media_type="text/html")


@app.get("/styles.css")
def stylesheet() -> FileResponse:
    return FileResponse(ROOT_DIR / "styles.css", media_type="text/css")


@app.get("/script.js")
def javascript() -> FileResponse:
    return FileResponse(ROOT_DIR / "script.js", media_type="text/javascript")


@app.get("/data/listings.json")
def snapshot() -> FileResponse:
    if not EXPORT_PATH.exists():
        export_snapshot()
    return FileResponse(EXPORT_PATH, media_type="application/json")


app.mount("/assets", StaticFiles(directory=Path(ROOT_DIR / "assets")), name="assets")
