# Nepal Estate Index

A Nepal-focused property search pilot with a pure HTML/CSS/JavaScript frontend, a FastAPI read API, and a normalized SQLite database. The current workspace contains 189 source-attributed listings from all nine publishers named in `Plan.md`, fetched on 17 August 2026.

## Run the full app

```bash
python3 -m pip install -r requirements.txt
npm start
```

Open `http://localhost:4173`. FastAPI serves the site and these read routes:

- `GET /api/health`
- `GET /api/listings`
- `GET /api/market/series`
- `GET /api/sources`
- Interactive API documentation at `/docs`

The dedicated market workspace is available at `http://localhost:4173/market`.

Useful listing query parameters are `purpose`, `city`, `type`, `max_price`, `source`, `limit`, and `offset`.

## Refresh the data

```bash
npm run refresh
```

The nine enabled adapters make bounded requests, exclude records marked sold or rented, normalize their latest windows into `data/real_estate.db`, and export `data/listings.json` as the deployable fallback snapshot. A record leaving a bounded source window is hidden from this index; that alone is not treated as evidence that the property sold. Sources refresh independently with a global concurrency limit and deadline, so one unavailable publisher cannot discard another publisher's successful update. When the API is running, its scheduler checks whether a refresh is due every four hours.

A refresh must normalize at least 75% of the previous bounded window before it can replace visible data. New sources normally require six safe records; Property in Nepal uses a three-record quorum because its first-party endpoint intentionally exposes a smaller latest-listing window. Stale data and source failures make the health response `degraded` and are surfaced in the listing feed badge.

The SQLite file is a local runtime artifact and is not committed. On a fresh clone, the app seeds it from the attributed JSON snapshot before serving requests, then refreshes it when the source is due.

- `INDEX_REFRESH_HOURS` — defaults to `4`
- `INDEX_SOURCE_PAGE_SIZE` — bounded source import size, defaults to `24`
- `INDEX_SOURCE_REFRESH_TIMEOUT_SECONDS` — per-source deadline, defaults to `75`
- `INDEX_ENABLE_SCHEDULER` — defaults to `true`
- `INDEX_DB_PATH` and `INDEX_EXPORT_PATH` — optional storage overrides
- `INDEX_REFRESH_TOKEN` — enables the otherwise-hidden `POST /api/admin/refresh` route

Do not commit a refresh token. The public API never returns seller email addresses or phone numbers.

## Source and image policy

All nine `Plan.md` sources are enabled: Nepal Homes, Real Estate in Nepal, GharGhaderi, Nepal Property Bazaar, Property in Nepal, Ghar Sansar Nepal, Kantipur Real Estate, GharBazar, and Lalpurja Nepal. Each listing retains its publisher name, original detail URL, and source-hosted photograph URL. The interface links back to the original record and never claims ownership of a publisher's photograph.

The project owner has attested that the publishers authorized use of their listing information and photographs in this private prototype. That scope is recorded in [`SOURCE_PERMISSIONS.md`](SOURCE_PERMISSIONS.md) and exposed by `GET /api/sources`; the project does not store the underlying agreements. Seller and agent contact objects are intentionally discarded, and public text is checked for phone numbers and email addresses before a source window may replace indexed data. This private-prototype permission should be reviewed again before any public launch, resale, or materially different use.

## Maps

Each listing has a map handoff. If a source does not provide coordinates, the database uses a public locality or city centroid and sets `locationPrecision` accordingly. The interface labels these as approximate, displays the area with a Google Maps place embed, and provides a no-key Google Maps search link. It never presents a neighborhood centroid as the exact house or parcel.

Unit-rate prices are stored only when the publisher explicitly supplies a basis such as per-aana, per-ropani, or per-square-foot; they are excluded from total-budget comparisons. Unlabelled sale prices remain totals and rentals default to monthly unless the source says otherwise. Visitors should still confirm all amounts and units on the original listing.

## Market board and price history

The `/market` workspace renders the full filtered inventory as a compact listing tape, lets a user pin up to four
properties, and compares their asking prices, source facts, peer positions, and scenario signals. Benchmarks use
only the same purpose, city, property type, and exact price basis. Duplicate fingerprints, flagged prices,
foreign-currency records, and robust price outliers are excluded from analytics but remain visible as listings.

The scenario is a capped mean-reversion calculation against current asking-price peers. It is an experimental
research signal, not a valuation, closed-sale forecast, or promise of future performance. The interface shows the
cohort size, confidence, range, method, and missing inputs beside the result.

Every successful refresh now records a privacy-safe asking-price observation without titles, descriptions, URLs,
or contact fields. `GET /api/market/series` returns daily medians and listing counts for exact cohorts, with optional
`purpose`, `city`, `type`, `price_basis`, and `days` filters. Its status remains `collecting` until a cohort spans at
least 30 days, has 14 qualifying observed days, and has eight clean active asks on each qualifying day.

## Build and test

```bash
npm run check
npm run test:api
npm run build
```

The build embeds the current `data/listings.json` snapshot into the static worker, including an `/api/listings` compatibility route. That static route is a snapshot, not a writable production database; deploy the FastAPI service with persistent storage for true scheduled production refreshes.

Run the browser smoke test while either `npm start` or a static server is listening on port 4173:

```bash
npm run test:browser
npm run test:market
```
