# Nepal Estate Index

A dependency-free HTML, CSS, and JavaScript concept for a Nepal-focused property index. The interface adapts the editorial, rounded-card language of the supplied video and uses the palette from `Plan.md`.

## Run locally

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

Create a production-ready static directory with:

```bash
npm run build
```

## Prototype scope

- Responsive home and discovery experience
- Client-side location, property, budget, purpose, and sort controls
- Sample listing detail dialog and local saved-property state
- Clear sample/roadmap labels so placeholder data is never presented as live
- API-ready listing model in `script.js`
- Local generated imagery; no external fonts, scripts, or image URLs

The scheduled scraper, database, deduplication logic, and FastAPI service described in `Plan.md` are not implemented in this frontend phase. Before building that ingestion layer, each source's robots directives, terms, reuse rights, and rate limits should be reviewed. The frontend copy describes that pipeline as planned rather than live.
