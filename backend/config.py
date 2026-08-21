from __future__ import annotations

import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.getenv("INDEX_DB_PATH", DATA_DIR / "real_estate.db"))
EXPORT_PATH = Path(os.getenv("INDEX_EXPORT_PATH", DATA_DIR / "listings.json"))
REFRESH_HOURS = float(os.getenv("INDEX_REFRESH_HOURS", "4"))
SOURCE_PAGE_SIZE = max(1, min(int(os.getenv("INDEX_SOURCE_PAGE_SIZE", "24")), 48))
SOURCE_REFRESH_TIMEOUT_SECONDS = max(
    15,
    min(int(os.getenv("INDEX_SOURCE_REFRESH_TIMEOUT_SECONDS", "75")), 180),
)
ENABLE_SCHEDULER = os.getenv("INDEX_ENABLE_SCHEDULER", "true").lower() in {"1", "true", "yes", "on"}
REFRESH_TOKEN = os.getenv("INDEX_REFRESH_TOKEN", "")
OLLAMA_BASE_URL = os.getenv("INDEX_OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("INDEX_OLLAMA_MODEL", "gemma4:e4b")
OLLAMA_TIMEOUT_SECONDS = max(3, min(int(os.getenv("INDEX_OLLAMA_TIMEOUT_SECONDS", "20")), 60))
USER_AGENT = os.getenv(
    "INDEX_USER_AGENT",
    "NepalEstateIndex/0.1 (+source-attributed property search; contact: local-development)",
)
