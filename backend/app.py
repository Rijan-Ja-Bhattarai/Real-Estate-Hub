from __future__ import annotations

import asyncio
import logging
import secrets
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.assistant import (
    additional_land_request,
    choose_comparison_winner,
    compound_recommendation_fallback_answer,
    comparison_fallback_answer,
    comparison_recommendations,
    fallback_answer,
    ollama_answer,
    rank_listings,
    single_recommendation_fallback_answer,
    valid_compound_recommendation_answer,
    valid_single_recommendation_answer,
    wants_single_recommendation,
)
from backend.config import ENABLE_SCHEDULER, EXPORT_PATH, OLLAMA_MODEL, REFRESH_HOURS, REFRESH_TOKEN, ROOT_DIR
from backend.db import database_stats, initialise, list_listings, list_market_series, list_sources
from backend.ingest import export_snapshot, refresh_all, seed_from_snapshot


LOGGER = logging.getLogger("nepal_estate_index")
MARKET_MINIMUM_WINDOW_DAYS = 30
MARKET_MINIMUM_OBSERVED_DAYS = 14
MARKET_MINIMUM_DAILY_SAMPLE = 8
NO_STORE_HEADERS = {"Cache-Control": "no-store, max-age=0"}


class AssistantTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=1200)


class AssistantRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1200)
    history: list[AssistantTurn] = Field(default_factory=list, max_length=8)
    page: str = Field(default="/", max_length=200)
    selectedListingIds: list[str] = Field(default_factory=list, max_length=4)


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


def market_readiness(items: list[dict[str, object]]) -> dict[str, object]:
    cohorts: dict[tuple[object, object, object, object], list[dict[str, object]]] = {}
    for item in items:
        key = (item["purpose"], item["city"], item["propertyType"], item["priceBasis"])
        cohorts.setdefault(key, []).append(item)

    ready_cohorts = 0
    observed_days = 0
    history_window_days = 0
    qualifying_days = 0
    for cohort_items in cohorts.values():
        dates = sorted(datetime.fromisoformat(str(item["date"])).date() for item in cohort_items)
        cohort_window = (dates[-1] - dates[0]).days + 1
        cohort_qualifying_days = sum(
            int(item["listingCount"]) >= MARKET_MINIMUM_DAILY_SAMPLE for item in cohort_items
        )
        cohort_ready = (
            cohort_window >= MARKET_MINIMUM_WINDOW_DAYS
            and cohort_qualifying_days >= MARKET_MINIMUM_OBSERVED_DAYS
        )
        ready_cohorts += int(cohort_ready)
        observed_days = max(observed_days, len(dates))
        history_window_days = max(history_window_days, cohort_window)
        qualifying_days = max(qualifying_days, cohort_qualifying_days)

    ready = bool(cohorts) and ready_cohorts == len(cohorts)
    return {
        "status": "ready" if ready else "collecting",
        "ready": ready,
        "cohortCount": len(cohorts),
        "readyCohortCount": ready_cohorts,
        "observedDays": observed_days,
        "historyWindowDays": history_window_days,
        "qualifyingDays": qualifying_days,
        "minimumWindowDays": MARKET_MINIMUM_WINDOW_DAYS,
        "minimumObservedDays": MARKET_MINIMUM_OBSERVED_DAYS,
        "minimumDailySample": MARKET_MINIMUM_DAILY_SAMPLE,
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
    version="0.3.0",
    description="Source-attributed property search and a database-grounded local assistant backed by SQLite.",
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


@app.get("/api/market/series")
async def market_series(
    purpose: Annotated[str | None, Query(pattern="^(buy|rent)$")] = None,
    city: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
    property_type: Annotated[str | None, Query(alias="type", min_length=1, max_length=80)] = None,
    price_basis: Annotated[str | None, Query(min_length=1, max_length=40)] = None,
    days: Annotated[int, Query(ge=7, le=365)] = 90,
) -> dict[str, object]:
    items, as_of = list_market_series(
        purpose=purpose,
        city=city,
        property_type=property_type,
        price_basis=price_basis,
        days=days,
    )
    readiness = market_readiness(items)
    return {
        "items": items,
        "status": readiness["status"],
        "readiness": readiness,
        "asOf": as_of,
        "days": days,
        "filters": {
            "purpose": purpose,
            "city": city,
            "propertyType": property_type,
            "priceBasis": price_basis,
        },
        "mode": "observed-asking-price-history",
    }


@app.post("/api/assistant/chat")
async def assistant_chat(request: AssistantRequest) -> dict[str, object]:
    items, _ = list_listings(limit=1000)
    selected_ids = list(dict.fromkeys(request.selectedListingIds))
    selected_lookup = {str(item.get("id") or ""): item for item in items}
    selected = [selected_lookup[listing_id] for listing_id in selected_ids if listing_id in selected_lookup]
    single_recommendation = False
    compound_recommendation = False
    winner: dict[str, object] | None = None
    land_winner: dict[str, object] | None = None
    response_style = "search"
    if selected_ids:
        response_style = "comparison"
        brief: dict[str, object] = {
            "contextMode": "comparison",
            "selectedCount": len(selected),
            "selectedListingIds": selected_ids,
            "filterUrl": None,
        }
        recommendations = comparison_recommendations(selected, items)
        single_recommendation = wants_single_recommendation(request.message) and bool(selected)
        if single_recommendation:
            winner = choose_comparison_winner(request.message, selected, items)
            if winner:
                brief["recommendedListingId"] = str(winner.get("id") or "")
                brief["recommendedListingTitle"] = str(winner.get("title") or "")
                land_request = additional_land_request(request.message)
                if land_request:
                    land_brief, land_recommendations = rank_listings(land_request, items, limit=1)
                    land_winner = land_recommendations[0] if land_recommendations else None
                    winner_id = str(winner.get("id") or "")
                    winner_recommendation = next(
                        (item for item in recommendations if str(item.get("id") or "") == winner_id),
                        None,
                    )
                    recommendations = []
                    if winner_recommendation:
                        recommendations.append({**winner_recommendation, "recommendationRole": "selected-house"})
                    if land_winner:
                        land_winner = {**land_winner, "recommendationRole": "additional-land"}
                        recommendations.append(land_winner)
                    compound_recommendation = True
                    response_style = "compound-recommendation"
                    brief.update(
                        {
                            "contextMode": "compound",
                            "compoundRecommendation": True,
                            "landSearchBrief": land_brief,
                            "recommendedLandListingId": str((land_winner or {}).get("id") or ""),
                            "recommendedLandListingTitle": str((land_winner or {}).get("title") or ""),
                        }
                    )
                    fallback = compound_recommendation_fallback_answer(winner, selected, land_winner, request.message)
                else:
                    brief["singleRecommendation"] = True
                    response_style = "single-recommendation"
                    fallback = single_recommendation_fallback_answer(winner, selected, request.message)
            else:
                fallback = comparison_fallback_answer(request.message, selected, recommendations)
        else:
            response_style = "comparison"
            fallback = comparison_fallback_answer(request.message, selected, recommendations)
    else:
        brief, recommendations = rank_listings(request.message, items)
        brief["contextMode"] = "search"
        response_style = "search"
        fallback = fallback_answer(brief, recommendations)
    history = [{"role": turn.role, "content": turn.content} for turn in request.history]
    answer = await ollama_answer(request.message, brief, recommendations, items, history)
    if compound_recommendation and winner:
        if not valid_compound_recommendation_answer(answer, winner, land_winner, selected):
            answer = None
    elif single_recommendation and winner:
        if not valid_single_recommendation_answer(answer, winner, selected):
            answer = None
        winner_id = str(winner.get("id") or "")
        recommendations = [item for item in recommendations if str(item.get("id") or "") == winner_id]
    return {
        "answer": answer or fallback,
        "recommendations": recommendations,
        "filterUrl": brief.get("filterUrl"),
        "contextMode": brief["contextMode"],
        "responseStyle": response_style,
        "selectedListingIds": [str(item.get("id") or "") for item in selected] if selected_ids else [],
        "mode": "ollama" if answer else "database-fallback",
        "model": OLLAMA_MODEL,
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
    return FileResponse(ROOT_DIR / "index.html", media_type="text/html", headers=NO_STORE_HEADERS)


@app.get("/index.html")
def index_file() -> FileResponse:
    return FileResponse(ROOT_DIR / "index.html", media_type="text/html", headers=NO_STORE_HEADERS)


@app.get("/market")
@app.get("/market.html")
def market_file() -> FileResponse:
    return FileResponse(ROOT_DIR / "market.html", media_type="text/html", headers=NO_STORE_HEADERS)


@app.get("/properties")
@app.get("/properties.html")
def properties_file() -> FileResponse:
    return FileResponse(ROOT_DIR / "properties.html", media_type="text/html", headers=NO_STORE_HEADERS)


@app.get("/styles.css")
def stylesheet() -> FileResponse:
    return FileResponse(
        ROOT_DIR / "styles.css",
        media_type="text/css",
        headers=NO_STORE_HEADERS,
    )


@app.get("/script.js")
def javascript() -> FileResponse:
    return FileResponse(ROOT_DIR / "script.js", media_type="text/javascript", headers=NO_STORE_HEADERS)


@app.get("/navigation.js")
def navigation_javascript() -> FileResponse:
    return FileResponse(ROOT_DIR / "navigation.js", media_type="text/javascript", headers=NO_STORE_HEADERS)


@app.get("/market.css")
def market_stylesheet() -> FileResponse:
    return FileResponse(ROOT_DIR / "market.css", media_type="text/css")


@app.get("/market.js")
def market_javascript() -> FileResponse:
    return FileResponse(ROOT_DIR / "market.js", media_type="text/javascript")


@app.get("/properties.css")
def properties_stylesheet() -> FileResponse:
    return FileResponse(ROOT_DIR / "properties.css", media_type="text/css")


@app.get("/properties.js")
def properties_javascript() -> FileResponse:
    return FileResponse(ROOT_DIR / "properties.js", media_type="text/javascript")


@app.get("/assistant.css")
def assistant_stylesheet() -> FileResponse:
    return FileResponse(ROOT_DIR / "assistant.css", media_type="text/css")


@app.get("/assistant.js")
def assistant_javascript() -> FileResponse:
    return FileResponse(ROOT_DIR / "assistant.js", media_type="text/javascript", headers=NO_STORE_HEADERS)


@app.get("/data/listings.json")
def snapshot() -> FileResponse:
    if not EXPORT_PATH.exists():
        export_snapshot()
    return FileResponse(EXPORT_PATH, media_type="application/json")


app.mount("/assets", StaticFiles(directory=Path(ROOT_DIR / "assets")), name="assets")
