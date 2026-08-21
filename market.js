const fallbackImage = "/assets/images/property-image-unavailable.svg";
const DISTRIBUTION_CHART_HEIGHT = 300;
const SCENARIO_CHART_HEIGHT = 260;
const MARKET_FONT_FAMILY = getComputedStyle(document.documentElement).fontFamily || "Inter, Arial, sans-serif";

const state = {
  properties: [],
  analytics: new Map(),
  analyticsEligibleIds: new Set(),
  duplicateIds: new Set(),
  outlierIds: new Set(),
  history: new Map(),
  purpose: "buy",
  city: "all",
  type: "House",
  basis: "all",
  sort: "signal-high",
  search: "",
  horizon: 12,
  selectedIds: [],
  focusedId: null,
  asOf: null,
  sourceCount: 0,
  feedMode: "snapshot",
  freshness: null,
};

const elements = {
  workspace: document.querySelector(".workspace-grid"),
  analyticsRail: document.querySelector("[data-analytics-rail]"),
  feedState: document.querySelector("[data-feed-state]"),
  asOf: document.querySelector("[data-as-of]"),
  coverage: document.querySelector("[data-coverage]"),
  city: document.querySelector("[data-city]"),
  type: document.querySelector("[data-type]"),
  basis: document.querySelector("[data-basis]"),
  sort: document.querySelector("[data-sort]"),
  search: document.querySelector("[data-search]"),
  inventory: document.querySelector("[data-inventory-list]"),
  empty: document.querySelector("[data-empty]"),
  resultCount: document.querySelector("[data-result-count]"),
  compareCount: document.querySelector("[data-compare-count]"),
  comparisonStatus: document.querySelector("[data-comparison-status]"),
  comparisonGrid: document.querySelector("[data-comparison-grid]"),
  distributionCanvas: document.querySelector("[data-distribution-chart]"),
  distributionNote: document.querySelector("[data-distribution-note]"),
  chartBasis: document.querySelector("[data-chart-basis]"),
  chartScale: document.querySelector("[data-chart-scale]"),
  scenarioCanvas: document.querySelector("[data-scenario-chart]"),
  analysisEyebrow: document.querySelector("[data-analysis-eyebrow]"),
  analysisTitle: document.querySelector("[data-analysis-title]"),
  horizonControl: document.querySelector("[data-horizon-control]"),
  scenarioProperty: document.querySelector("[data-scenario-property]"),
  scenarioPeer: document.querySelector("[data-scenario-peer]"),
  scenarioSignal: document.querySelector("[data-scenario-signal]"),
  scenarioDirection: document.querySelector("[data-scenario-direction]"),
  scenarioChange: document.querySelector("[data-scenario-change]"),
  currentAsk: document.querySelector("[data-current-ask]"),
  currentAskLabel: document.querySelector("[data-current-ask-label]"),
  scenarioMid: document.querySelector("[data-scenario-mid]"),
  scenarioMidLabel: document.querySelector("[data-scenario-mid-label]"),
  scenarioRange: document.querySelector("[data-scenario-range]"),
  scenarioRangeLabel: document.querySelector("[data-scenario-range-label]"),
  confidence: document.querySelector("[data-confidence]"),
  confidenceLabel: document.querySelector("[data-confidence-label]"),
  historyStatus: document.querySelector("[data-history-status]"),
  methodLabel: document.querySelector("[data-method-label]"),
  methodCopy: document.querySelector("[data-method-copy]"),
  methodInputs: document.querySelector("[data-method-inputs]"),
  methodMissing: document.querySelector("[data-method-missing]"),
  inventoryKpi: document.querySelector("[data-kpi-inventory]"),
  inventoryKpiNote: document.querySelector("[data-kpi-inventory-note]"),
  medianKpi: document.querySelector("[data-kpi-median]"),
  basisKpi: document.querySelector("[data-kpi-basis]"),
  rangeKpi: document.querySelector("[data-kpi-range]"),
  coverageKpi: document.querySelector("[data-kpi-coverage]"),
  dataScope: document.querySelector("[data-data-scope]"),
  toast: document.querySelector("[data-toast]"),
};

let toastTimer;
let resizeTimer;

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeURL(value, fallback = "#") {
  const candidate = String(value ?? "").trim();
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normaliseProperty(property) {
  const facts = property.facts && typeof property.facts === "object" ? property.facts : {};
  const price = finiteNumber(property.price);
  return {
    id: String(property.id ?? ""),
    title: String(property.title || "Untitled property"),
    location: String(property.location || property.city || "Location not supplied"),
    locality: String(property.locality || ""),
    city: String(property.city || "Other"),
    type: String(property.type || "Property"),
    purpose: property.purpose === "rent" ? "rent" : "buy",
    price: price !== null && price > 0 ? price : null,
    priceBasis: String(property.priceBasis || (property.purpose === "rent" ? "monthly" : "total")),
    priceLabel: String(property.priceLabel || ""),
    beds: finiteNumber(property.beds),
    baths: finiteNumber(property.baths),
    area: String(property.area || ""),
    image: safeURL(property.image, fallbackImage),
    imageAlt: String(property.imageAlt || `${property.title || "Property"}, source listing photograph`),
    sourceName: String(property.sourceName || "Original publisher"),
    sourceUrl: safeURL(property.sourceUrl),
    sourceAgeLabel: String(property.sourceAgeLabel || ""),
    sourcePublishedAt: property.sourcePublishedAt || null,
    indexedAt: property.indexedAt || null,
    locationPrecision: String(property.locationPrecision || "unknown"),
    facts,
  };
}

function factValue(property, ...keys) {
  for (const key of keys) {
    const value = property.facts?.[key];
    if (value !== undefined && value !== null && String(value).trim() && String(value).trim() !== "-") {
      return String(value).trim();
    }
  }
  return "";
}

function qualityFlags(property) {
  const flags = property.facts?.quality_flags;
  return Array.isArray(flags) ? flags.filter(Boolean) : [];
}

function hasCurrencyMismatch(property) {
  const sourcePrice = factValue(property, "source_price_text", "source_price_label");
  return /\$|€|£|₹|\b(?:usd|dollars?|eur|euros?|inr|indian\s+rupees?|gbp|pounds?\s+sterling|aud|cad|cny|rmb|aed)\b/i.test(`${property.title} ${property.priceLabel} ${sourcePrice}`);
}

function isCleanForAnalytics(property) {
  return property.price !== null && property.price > 0 && qualityFlags(property).length === 0 && !hasCurrencyMismatch(property);
}

function parseArea(areaLabel) {
  const text = String(areaLabel || "")
    .toLowerCase()
    .replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1")
    .replaceAll(",", " ");
  if (/\d(?:\.\d+)?\s*(?:-|–|—|to)\s*\d/i.test(text)) return null;
  const ropani = text.match(/(\d+(?:\.\d+)?)\s*ropani\b/);
  const aana = text.match(/(\d+(?:\.\d+)?)\s*(?:aana|ana|anna)\b/);
  const paisa = text.match(/(\d+(?:\.\d+)?)\s*paisa\b/);
  const dam = text.match(/(\d+(?:\.\d+)?)\s*(?:dam|daam)\b/);
  if (ropani || aana || paisa || dam) {
    const aanaValue = Number(ropani?.[1] || 0) * 16 + Number(aana?.[1] || 0) + Number(paisa?.[1] || 0) / 4 + Number(dam?.[1] || 0) / 16;
    if (aanaValue > 0) return { value: aanaValue, unit: "aana" };
  }

  const squareFeet = text.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|square\s*feet)\b/);
  if (squareFeet && Number(squareFeet[1]) > 0) return { value: Number(squareFeet[1]), unit: "sq ft" };
  return null;
}

function derivedUnitAsk(property) {
  if (property.price === null || !["total", "monthly"].includes(property.priceBasis)) return null;
  const parsed = parseArea(property.area);
  if (!parsed) return null;
  return {
    value: property.price / parsed.value,
    unit: property.priceBasis === "monthly" ? `${parsed.unit} / month` : parsed.unit,
  };
}

function cohortKey(property) {
  return [property.purpose, property.type, property.city, property.priceBasis].join("|");
}

function duplicateKey(property) {
  const title = property.title.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return [title, property.city.toLowerCase(), property.priceBasis, property.price].join("|");
}

function quantile(values, percentile) {
  if (!values.length) return null;
  const index = (values.length - 1) * percentile;
  const lower = Math.floor(index);
  const fraction = index - lower;
  const next = values[lower + 1];
  return next === undefined ? values[lower] : values[lower] + fraction * (next - values[lower]);
}

function buildAnalytics(properties) {
  const groups = new Map();
  const duplicateIds = new Set();
  properties.filter(isCleanForAnalytics).forEach((property) => {
    const key = cohortKey(property);
    if (!groups.has(key)) groups.set(key, new Map());
    const group = groups.get(key);
    const fingerprint = duplicateKey(property);
    if (group.has(fingerprint)) duplicateIds.add(property.id);
    else group.set(fingerprint, property);
  });

  const analytics = new Map();
  const analyticsEligibleIds = new Set();
  const outlierIds = new Set();
  groups.forEach((deduplicated, key) => {
    const candidates = [...deduplicated.values()].sort((first, second) => first.price - second.price);
    const values = candidates.map((property) => property.price);
    if (values.length < 8) return;

    const initialQ1 = quantile(values, 0.25);
    const initialQ3 = quantile(values, 0.75);
    const initialIqr = initialQ3 - initialQ1;
    const lowerFence = Math.max(0, initialQ1 - initialIqr * 2.5);
    const upperFence = initialQ3 + initialIqr * 2.5;
    const filteredProperties = candidates.filter((property) => property.price >= lowerFence && property.price <= upperFence);
    candidates.filter((property) => !filteredProperties.includes(property)).forEach((property) => outlierIds.add(property.id));
    if (filteredProperties.length < 8) return;
    const filtered = filteredProperties.map((property) => property.price);

    const q1 = quantile(filtered, 0.25);
    const median = quantile(filtered, 0.5);
    const q3 = quantile(filtered, 0.75);
    analytics.set(key, {
      values: filtered,
      q1,
      median,
      q3,
      lowerFence,
      upperFence,
      sampleCount: filtered.length,
      iqrRelative: median > 0 ? (q3 - q1) / median : 0,
    });
    filteredProperties.forEach((property) => analyticsEligibleIds.add(property.id));
  });
  return { groups: analytics, analyticsEligibleIds, duplicateIds, outlierIds };
}

function peerStats(property) {
  if (!property || !isCleanForAnalytics(property) || !state.analyticsEligibleIds.has(property.id)) return null;
  const group = state.analytics.get(cohortKey(property));
  if (!group || property.price < group.lowerFence || property.price > group.upperFence) return null;
  const belowOrEqual = group.values.filter((value) => value <= property.price).length;
  const percentile = Math.round((belowOrEqual / group.values.length) * 100);
  const delta = group.median > 0 ? property.price / group.median - 1 : 0;
  return { ...group, percentile, delta };
}

function analyticsExclusion(property) {
  if (!property || property.price === null || property.price <= 0) return "asking price unavailable";
  if (qualityFlags(property).length) return "excluded by a source-data quality flag";
  if (hasCurrencyMismatch(property)) return "currency is not verified as NPR";
  if (state.duplicateIds.has(property.id)) return "duplicate listing fingerprint";
  if (state.outlierIds.has(property.id)) return "robust price outlier";
  if (!state.analytics.has(cohortKey(property))) return "needs 8 clean, like-for-like peers";
  return "not eligible for this peer benchmark";
}

function scenarioFor(property) {
  const stats = peerStats(property);
  if (!stats || property.price === null) return { available: false };
  const years = state.horizon / 12;
  const percentage = Math.max(-0.18, Math.min(0.18, -stats.delta * 0.22 * Math.sqrt(years)));
  const uncertainty = Math.max(0.04, Math.min(0.16, stats.iqrRelative * 0.12 * Math.sqrt(years)));
  const midpoint = property.price * (1 + percentage);
  const low = Math.max(0, midpoint * (1 - uncertainty));
  const high = midpoint * (1 + uncertainty);
  const direction = percentage > 0.015 ? "Upside" : percentage < -0.015 ? "Downside" : "Balanced";
  const tone = percentage > 0.015 ? "positive" : percentage < -0.015 ? "negative" : "neutral";
  const confidence = stats.sampleCount >= 20 ? "Medium" : "Low";
  return { available: true, percentage, uncertainty, midpoint, low, high, direction, tone, confidence, stats };
}

function historyTrendFor(property, history = historyFor(property)) {
  const points = qualifyingHistoryPoints(history);
  if (!property || !peerStats(property) || points.length < 2) return { available: false };
  const first = points[0];
  const latest = points.at(-1);
  const percentage = first.medianPriceNpr > 0 ? latest.medianPriceNpr / first.medianPriceNpr - 1 : 0;
  const direction = percentage > 0.015 ? "Rising" : percentage < -0.015 ? "Falling" : "Stable";
  const tone = percentage > 0.015 ? "positive" : percentage < -0.015 ? "negative" : "neutral";
  return { available: true, percentage, direction, tone, points, first, latest, history };
}

function marketSignalFor(property) {
  const trend = historyTrendFor(property);
  if (trend.available) {
    return {
      ...trend,
      kind: "history",
      note: `observed · ${trend.points.length} days · latest n=${trend.latest.listingCount}`,
    };
  }
  const scenario = scenarioFor(property);
  if (!scenario.available) return { available: false, tone: "neutral", kind: "none" };
  return {
    ...scenario,
    kind: "scenario",
    note: `${state.horizon}M scenario · ${scenario.confidence.toLowerCase()} confidence`,
  };
}

function compactNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits }).format(value);
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) return "Price on request";
  if (value >= 10_000_000) return `रु ${compactNumber(value / 10_000_000)} Cr`;
  if (value >= 100_000) return `रु ${compactNumber(value / 100_000)} Lakh`;
  if (value >= 1_000) return `रु ${compactNumber(value / 1_000)}K`;
  return `रु ${compactNumber(value, 0)}`;
}

function basisShortLabel(basis) {
  return {
    total: "total",
    monthly: "/ month",
    "per-aana": "/ aana",
    "per-ropani": "/ ropani",
    "per-sq-ft": "/ sq ft",
  }[basis] || basis.replaceAll("-", " ");
}

function basisLongLabel(basis) {
  return {
    total: "Total asking price",
    monthly: "Monthly asking rent",
    "per-aana": "Asking price per aana",
    "per-ropani": "Asking price per ropani",
    "per-sq-ft": "Asking price per sq ft",
  }[basis] || basis.replaceAll("-", " ");
}

function formatAsk(property, includeBasis = true) {
  if (property.price === null) return "Price on request";
  const price = formatCurrency(property.price);
  const basis = basisShortLabel(property.priceBasis);
  return includeBasis && basis !== "total" ? `${price} ${basis}` : price;
}

function formatDate(value, includeTime = false) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return "Not supplied";
  return new Intl.DateTimeFormat("en-NP", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function formatPercent(value, forceSign = false) {
  if (!Number.isFinite(value)) return "--";
  const percentage = value * 100;
  const sign = forceSign && percentage > 0 ? "+" : "";
  return `${sign}${percentage.toFixed(Math.abs(percentage) < 10 ? 1 : 0)}%`;
}

function peerPosition(property, stats = peerStats(property)) {
  if (!stats) return { value: "Not benchmarked", note: analyticsExclusion(property) };
  const magnitude = Math.abs(stats.delta);
  const position = magnitude < 0.015 ? "at peer median" : stats.delta < 0 ? "below peer median" : "above peer median";
  return { value: `${formatPercent(magnitude)} ${position}`, note: `${stats.percentile}th ask percentile · n=${stats.sampleCount}` };
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 3200);
}

async function fetchJSON(url, timeout = 9000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchListings() {
  try {
    const pageSize = 250;
    const payload = await fetchJSON(`/api/listings?limit=${pageSize}&offset=0`);
    if (!Array.isArray(payload.items)) throw new Error("Listing response is missing items");
    const feedMode = /^live(?:-|$)/.test(String(payload.mode || "")) ? "live" : "snapshot";
    if (feedMode !== "live") return { ...payload, feedMode };

    const items = [...payload.items];
    const ids = new Set(items.map((item) => String(item.id ?? "")));
    const total = Math.max(items.length, Number(payload.total) || 0);
    let offset = items.length;
    while (offset < total) {
      const page = await fetchJSON(`/api/listings?limit=${pageSize}&offset=${offset}`);
      if (!Array.isArray(page.items) || !page.items.length) break;
      let added = 0;
      page.items.forEach((item) => {
        const id = String(item.id ?? "");
        if (id && !ids.has(id)) {
          ids.add(id);
          items.push(item);
          added += 1;
        }
      });
      offset += page.items.length;
      if (!added) break;
    }
    return { ...payload, items, total, feedMode };
  } catch {
    const payload = await fetchJSON("/data/listings.json");
    if (!Array.isArray(payload.items)) throw new Error("Snapshot is missing items");
    return { ...payload, feedMode: "snapshot" };
  }
}

function historyFor(property) {
  return property ? state.history.get(cohortKey(property)) || null : null;
}

function normaliseHistoryPayload(payload, property) {
  const readiness = payload?.readiness && typeof payload.readiness === "object" ? payload.readiness : {};
  const items = Array.isArray(payload?.items)
    ? payload.items.filter((item) => (
        item?.purpose === property.purpose
        && item?.city === property.city
        && item?.propertyType === property.type
        && item?.priceBasis === property.priceBasis
        && Number.isFinite(Number(item?.medianPriceNpr))
        && Number(item.medianPriceNpr) > 0
        && Number.isFinite(Number(item?.listingCount))
        && !Number.isNaN(new Date(item?.date).valueOf())
      )).map((item) => ({
        date: String(item.date),
        medianPriceNpr: Number(item.medianPriceNpr),
        listingCount: Number(item.listingCount),
      })).sort((first, second) => new Date(first.date) - new Date(second.date))
    : [];
  const ready = payload?.status === "ready" && readiness.ready === true;
  return { status: ready ? "ready" : "collecting", readiness, items, asOf: payload?.asOf || null, fetchedAt: Date.now() };
}

async function ensureHistory(property) {
  if (!property) return;
  const key = cohortKey(property);
  if (state.feedMode === "snapshot") {
    state.history.set(key, { status: "unavailable", readiness: {}, items: [] });
    return;
  }
  const existing = state.history.get(key);
  if (existing?.status === "loading" || existing?.status === "ready") return;
  if (existing?.status === "collecting" && Date.now() < existing.fetchedAt + 5 * 60_000) return;
  if (existing?.status === "unavailable" && Date.now() < existing.retryAt) return;
  state.history.set(key, { status: "loading", readiness: {}, items: [] });
  const parameters = new URLSearchParams({
    purpose: property.purpose,
    city: property.city,
    type: property.type,
    price_basis: property.priceBasis,
    days: "365",
  });
  try {
    const payload = await fetchJSON(`/api/market/series?${parameters}`);
    state.history.set(key, normaliseHistoryPayload(payload, property));
  } catch {
    state.history.set(key, { status: "unavailable", readiness: {}, items: [], retryAt: Date.now() + 30_000 });
  }
  const focus = focusedProperty(filteredProperties());
  if (focus && cohortKey(focus) === key) {
    const properties = filteredProperties();
    renderInventory(properties);
    renderComparison();
    renderAnalytics(properties, { loadHistory: false });
  }
}

function historyProgress(entry) {
  if (!entry || entry.status === "loading") return "Checking whether this exact cohort has enough observed history.";
  if (entry.status === "unavailable") {
    return state.feedMode === "snapshot"
      ? "Observed history is unavailable in this static snapshot; the experimental peer scenario remains in view."
      : "The history feed is temporarily unavailable; the experimental peer scenario remains in view.";
  }
  if (entry.status === "ready") return "Observed history is ready but needs at least two qualifying points to draw a trend.";
  const readiness = entry.readiness || {};
  const qualifying = Number(readiness.qualifyingDays) || 0;
  const minimumDays = Number(readiness.minimumObservedDays) || 14;
  const windowDays = Number(readiness.historyWindowDays) || 0;
  const minimumWindow = Number(readiness.minimumWindowDays) || 30;
  const minimumSample = Number(readiness.minimumDailySample) || 8;
  return `History collecting: ${qualifying}/${minimumDays} qualifying days across a ${windowDays}/${minimumWindow}-day window; each day needs at least ${minimumSample} clean asks.`;
}

function feedAgeHours(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return Infinity;
  return Math.max(0, (Date.now() - date.valueOf()) / 3_600_000);
}

function setFeedState() {
  const sourceErrors = Array.isArray(state.freshness?.sourceErrors) ? state.freshness.sourceErrors.length : 0;
  const stale = state.freshness?.state === "stale" || feedAgeHours(state.asOf) > 8 || sourceErrors > 0;
  const mode = state.feedMode === "live" ? "Live API" : "Deployable snapshot";
  elements.feedState.className = `feed-state ${stale ? "is-stale" : "is-live"}`;
  elements.feedState.querySelector("span:last-child").textContent = `${mode} · ${state.properties.length} listings`;
  elements.feedState.setAttribute(
    "aria-label",
    `${mode}, ${state.properties.length} listings, ${stale ? "data needs attention" : "data current"}${sourceErrors ? `, ${sourceErrors} source alerts` : ""}`,
  );
  elements.asOf.textContent = formatDate(state.asOf, true);
  const coverageState = sourceErrors
    ? `${sourceErrors} source alert${sourceErrors === 1 ? "" : "s"}`
    : stale
      ? "refresh overdue"
      : "refresh current";
  elements.coverage.textContent = `${state.sourceCount} sources · ${coverageState}`;
  elements.dataScope.textContent = `${state.properties.length} active asking listings from ${state.sourceCount} attributed publishers, indexed ${formatDate(state.asOf)}. This is a bounded listing sample, not a census of Nepal's housing market.`;
}

function populateCities() {
  const cities = [...new Set(state.properties.map((property) => property.city).filter(Boolean))].sort();
  elements.city.innerHTML = '<option value="all">All markets</option>' + cities.map((city) => `<option value="${escapeHTML(city)}">${escapeHTML(city)}</option>`).join("");
  elements.city.value = state.city;
}

function populateTypes() {
  const preferred = ["House", "Apartment", "Land", "Commercial"];
  const types = [...new Set(state.properties.map((property) => property.type).filter(Boolean))]
    .sort((first, second) => {
      const firstIndex = preferred.indexOf(first);
      const secondIndex = preferred.indexOf(second);
      if (firstIndex >= 0 || secondIndex >= 0) {
        return (firstIndex < 0 ? preferred.length : firstIndex) - (secondIndex < 0 ? preferred.length : secondIndex);
      }
      return first.localeCompare(second);
    });
  if (state.type !== "all" && !types.includes(state.type)) state.type = "all";
  elements.type.innerHTML = '<option value="all">All property</option>' + types.map((type) => `<option value="${escapeHTML(type)}">${escapeHTML(type)}</option>`).join("");
  elements.type.value = state.type;
}

function basisCandidates() {
  return state.properties.filter((property) => {
    if (property.purpose !== state.purpose) return false;
    if (state.city !== "all" && property.city !== state.city) return false;
    if (state.type !== "all" && property.type !== state.type) return false;
    return true;
  });
}

function populateBases() {
  const bases = [...new Set(basisCandidates().map((property) => property.priceBasis))].sort();
  if (state.basis !== "all" && !bases.includes(state.basis)) state.basis = "all";
  elements.basis.innerHTML = '<option value="all">Comparable basis</option>' + bases.map((basis) => `<option value="${escapeHTML(basis)}">${escapeHTML(basisLongLabel(basis))}</option>`).join("");
  elements.basis.value = state.basis;
}

function filteredProperties() {
  const query = state.search.trim().toLowerCase();
  const properties = state.properties.filter((property) => {
    if (property.purpose !== state.purpose) return false;
    if (state.city !== "all" && property.city !== state.city) return false;
    if (state.type !== "all" && property.type !== state.type) return false;
    if (state.basis !== "all" && property.priceBasis !== state.basis) return false;
    if (query && !`${property.title} ${property.location} ${property.locality} ${property.city} ${property.sourceName}`.toLowerCase().includes(query)) return false;
    return true;
  });

  return properties.sort((first, second) => {
    if (state.sort === "newest") {
      const firstTime = new Date(first.indexedAt || 0).valueOf();
      const secondTime = new Date(second.indexedAt || 0).valueOf();
      return (Number.isFinite(secondTime) ? secondTime : 0) - (Number.isFinite(firstTime) ? firstTime : 0);
    }
    if (state.sort === "price-low" || state.sort === "price-high") {
      if (first.price === null || second.price === null) {
        if (first.price === null && second.price === null) return 0;
        return first.price === null ? 1 : -1;
      }
      const direction = state.sort === "price-low" ? 1 : -1;
      return (first.price - second.price) * direction;
    }
    if (state.sort === "value-low") return (peerStats(first)?.delta ?? Infinity) - (peerStats(second)?.delta ?? Infinity);
    const firstSignal = marketSignalFor(first);
    const secondSignal = marketSignalFor(second);
    return (secondSignal.available ? secondSignal.percentage : -Infinity) - (firstSignal.available ? firstSignal.percentage : -Infinity);
  });
}

function addImageFallbacks(root = document) {
  root.querySelectorAll("[data-property-image]").forEach((image) => {
    image.addEventListener("error", () => {
      if (!image.src.endsWith(fallbackImage)) image.src = fallbackImage;
    }, { once: true });
  });
}

function inventoryRow(property) {
  const selected = state.selectedIds.includes(property.id);
  const focused = state.focusedId === property.id;
  const stats = peerStats(property);
  const position = peerPosition(property, stats);
  const signal = marketSignalFor(property);
  const signalValue = signal.available ? `${signal.direction} ${formatPercent(signal.percentage, true)}` : "No signal";
  const signalNote = signal.available ? signal.note : analyticsExclusion(property);
  const typeLabel = property.purpose === "rent" ? `${property.type} · rent` : `${property.type} · sale`;
  return `
    <article class="inventory-row${selected ? " is-selected" : ""}${focused ? " is-focused" : ""}" data-property-id="${escapeHTML(property.id)}">
      <div class="inventory-property">
        <button class="compare-check" type="button" data-toggle-compare="${escapeHTML(property.id)}" aria-label="${selected ? "Remove" : "Add"} ${escapeHTML(property.title)} ${selected ? "from" : "to"} comparison" aria-pressed="${selected}">✓</button>
        <img class="inventory-thumb" src="${escapeHTML(property.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-property-image />
        <div class="inventory-identity">
          <button type="button" data-focus-property="${escapeHTML(property.id)}">${escapeHTML(property.title)}</button>
          <span>${escapeHTML(property.location)}</span>
          <small>${escapeHTML(typeLabel)} · ${escapeHTML(property.sourceName)}</small>
        </div>
      </div>
      <div class="inventory-price">
        <strong>${escapeHTML(formatAsk(property, false))}</strong>
        <span>${escapeHTML(basisLongLabel(property.priceBasis))}</span>
      </div>
      <div class="inventory-peer">
        <strong>${escapeHTML(position.value)}</strong>
        <span>${escapeHTML(position.note)}</span>
        ${stats ? `<div class="inventory-peer-meter" aria-hidden="true"><i style="left: ${Math.max(0, Math.min(100, stats.percentile))}%"></i></div>` : ""}
      </div>
      <div class="inventory-scenario is-${signal.tone || "neutral"}">
        <strong>${escapeHTML(signalValue)}</strong>
        <span>${escapeHTML(signalNote)}</span>
      </div>
    </article>`;
}

function renderInventory(properties) {
  elements.inventory.setAttribute("aria-busy", "false");
  elements.empty.hidden = properties.length > 0;
  elements.inventory.hidden = properties.length === 0;
  elements.inventory.innerHTML = properties.map(inventoryRow).join("");
  elements.resultCount.textContent = `${properties.length} visible`;
  elements.compareCount.textContent = `${state.selectedIds.length} / 4 compared`;
  addImageFallbacks(elements.inventory);
}

function comparisonMetric(label, value, className = "") {
  return `<div><dt>${escapeHTML(label)}</dt><dd class="${escapeHTML(className)}">${escapeHTML(value || "Not supplied")}</dd></div>`;
}

function comparisonCard(property) {
  const stats = peerStats(property);
  const position = peerPosition(property, stats);
  const signal = marketSignalFor(property);
  const derived = derivedUnitAsk(property);
  const bedsAndBaths = [property.beds !== null ? `${compactNumber(property.beds, 0)} bed` : "", property.baths !== null ? `${compactNumber(property.baths, 0)} bath` : ""].filter(Boolean).join(" · ");
  const road = factValue(property, "road_access", "road_and_area");
  const facing = factValue(property, "facing");
  const parking = factValue(property, "parking");
  const furnishing = factValue(property, "furnishing", "furnished");
  const signalClass = `comparison-signal is-${signal.tone || "neutral"}`;
  const signalLabel = signal.kind === "history" ? "Observed median trend" : `${state.horizon}M scenario`;
  return `
    <article class="comparison-card" data-comparison-id="${escapeHTML(property.id)}">
      <div class="comparison-card-image">
        <img src="${escapeHTML(property.image)}" alt="${escapeHTML(property.imageAlt)}" loading="lazy" referrerpolicy="no-referrer" data-property-image />
        <button class="comparison-remove" type="button" data-remove-comparison="${escapeHTML(property.id)}" aria-label="Remove ${escapeHTML(property.title)} from comparison">×</button>
      </div>
      <div class="comparison-card-title">
        <span>${escapeHTML(property.location)}</span>
        <h3>${escapeHTML(property.title)}</h3>
        <a href="${escapeHTML(property.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(property.sourceName)} ↗</a>
      </div>
      <dl class="comparison-metrics">
        ${comparisonMetric("Asking price", formatAsk(property))}
        ${comparisonMetric("Area", property.area)}
        ${comparisonMetric("Derived unit ask", derived ? `${formatCurrency(derived.value)} / ${derived.unit}` : "Not standardized")}
        ${comparisonMetric("Beds / baths", bedsAndBaths)}
        ${comparisonMetric("Peer median", stats ? `${formatCurrency(stats.median)} ${basisShortLabel(property.priceBasis)}` : "Insufficient clean peers")}
        ${comparisonMetric("Peer position", position.value)}
        ${comparisonMetric(signalLabel, signal.available ? `${signal.direction} ${formatPercent(signal.percentage, true)}` : analyticsExclusion(property), signalClass)}
        ${comparisonMetric("Road / facing", [road, facing].filter(Boolean).join(" · "))}
        ${comparisonMetric("Parking / finish", [parking, furnishing].filter(Boolean).join(" · "))}
        ${comparisonMetric("Indexed", formatDate(property.indexedAt))}
      </dl>
    </article>`;
}

function comparisonPlaceholder(index) {
  return `<div class="comparison-placeholder"><span>${index + 1}</span><p>Select another listing from the live inventory.</p></div>`;
}

function renderComparison() {
  const properties = state.selectedIds.map((id) => state.properties.find((property) => property.id === id)).filter(Boolean);
  const placeholders = Array.from({ length: Math.max(0, 4 - properties.length) }, (_, index) => comparisonPlaceholder(properties.length + index));
  elements.comparisonGrid.innerHTML = properties.map(comparisonCard).concat(placeholders).join("");
  elements.comparisonStatus.textContent = properties.length < 2 ? "Select at least two listings" : `${properties.length} listings pinned`;
  elements.compareCount.textContent = `${properties.length} / 4 compared`;
  addImageFallbacks(elements.comparisonGrid);
  document.dispatchEvent(new CustomEvent("nei:comparison-change", { detail: { selectedListingIds: [...state.selectedIds] } }));
}

function setupCanvas(canvas, height) {
  const width = Math.max(280, Math.floor(canvas.clientWidth));
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function drawEmptyChart(canvas, height, message) {
  const { context, width } = setupCanvas(canvas, height);
  context.fillStyle = "#f7f6f2";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(54, 60, 70, 0.14)";
  context.beginPath();
  context.moveTo(12, height - 22);
  context.lineTo(width - 8, height - 22);
  context.stroke();
  context.fillStyle = "#5d6472";
  context.font = `11px ${MARKET_FONT_FAMILY}`;
  context.fillText(message, 14, Math.round(height / 2));
}

function drawDistribution(property) {
  const stats = peerStats(property);
  if (!property || !stats) {
    drawEmptyChart(elements.distributionCanvas, DISTRIBUTION_CHART_HEIGHT, "CHOOSE A LISTING WITH A PEER COHORT");
    elements.chartBasis.textContent = "No cohort";
    elements.chartScale.innerHTML = "<span>--</span><span>--</span><span>--</span>";
    elements.distributionNote.textContent = property
      ? `This listing is not benchmarked: ${analyticsExclusion(property)}.`
      : "Select a listing to inspect its like-for-like asking-price cohort.";
    elements.distributionCanvas.setAttribute("aria-label", elements.distributionNote.textContent);
    return;
  }

  const values = stats.values;
  const min = values[0];
  const max = values[values.length - 1];
  const bins = 9;
  const span = Math.max(1, max - min);
  const counts = Array.from({ length: bins }, () => 0);
  values.forEach((value) => {
    const index = Math.min(bins - 1, Math.floor(((value - min) / span) * bins));
    counts[index] += 1;
  });

  const { context, width, height } = setupCanvas(elements.distributionCanvas, DISTRIBUTION_CHART_HEIGHT);
  const pad = { top: 18, right: 12, bottom: 24, left: 12 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxCount = Math.max(...counts, 1);
  context.fillStyle = "#f7f6f2";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(54, 60, 70, 0.12)";
  context.lineWidth = 1;
  for (let line = 0; line <= 3; line += 1) {
    const y = pad.top + (chartHeight / 3) * line;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(width - pad.right, y);
    context.stroke();
  }

  const gap = 4;
  const barWidth = chartWidth / bins;
  counts.forEach((count, index) => {
    const barHeight = (count / maxCount) * (chartHeight - 8);
    context.fillStyle = index % 2 === 0 ? "#5d6472" : "#cfb6a8";
    context.fillRect(pad.left + index * barWidth + gap / 2, pad.top + chartHeight - barHeight, Math.max(2, barWidth - gap), barHeight);
  });

  const medianX = pad.left + ((stats.median - min) / span) * chartWidth;
  context.strokeStyle = "#286f86";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(medianX, pad.top);
  context.lineTo(medianX, height - pad.bottom);
  context.stroke();
  context.fillStyle = "#286f86";
  context.font = `700 10px ${MARKET_FONT_FAMILY}`;
  context.fillText("PEER MEDIAN", Math.min(width - 82, Math.max(4, medianX - 34)), 11);

  const propertyX = pad.left + ((property.price - min) / span) * chartWidth;
  context.strokeStyle = "#363c46";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(propertyX, pad.top + 20);
  context.lineTo(propertyX, height - pad.bottom);
  context.stroke();
  context.fillStyle = "#363c46";
  context.beginPath();
  context.arc(propertyX, pad.top + 22, 4, 0, Math.PI * 2);
  context.fill();

  elements.chartBasis.textContent = basisShortLabel(property.priceBasis);
  elements.chartScale.innerHTML = `<span>${escapeHTML(formatCurrency(min))}</span><span>${escapeHTML(formatCurrency(stats.median))}</span><span>${escapeHTML(formatCurrency(max))}</span>`;
  elements.distributionNote.textContent = `${stats.sampleCount} comparable ${property.city} ${property.type.toLowerCase()} asks. The dark marker is this property; the blue line is the peer median.`;
  elements.distributionCanvas.setAttribute("aria-label", `${property.title} asking price at percentile ${stats.percentile} among ${stats.sampleCount} comparable listings.`);
}

function setScenarioPresentation(history) {
  elements.analysisEyebrow.textContent = "UPSIDE VIEW";
  elements.analysisTitle.textContent = "Why this may stand out";
  elements.horizonControl.hidden = false;
  elements.currentAskLabel.textContent = "Current ask";
  elements.scenarioMidLabel.textContent = "Scenario midpoint";
  elements.scenarioRangeLabel.textContent = "Scenario range";
  elements.confidenceLabel.textContent = "Confidence";
  elements.historyStatus.textContent = historyProgress(history);
  elements.methodLabel.textContent = "Why this may be attractive";
  elements.methodCopy.textContent = "The signal starts with the selected property's position among comparable active asks, then shows how much room it has toward the peer midpoint.";
  elements.methodInputs.textContent = "Current asks, purpose, property type, city, and exact price basis.";
  elements.methodMissing.textContent = "A lower peer position can create a useful starting point for comparison and negotiation.";
}

function qualifyingHistoryPoints(history) {
  if (!history || history.status !== "ready") return [];
  const minimumSample = Number(history.readiness?.minimumDailySample) || 8;
  return history.items.filter((item) => item.listingCount >= minimumSample);
}

function drawObservedHistory(property, history) {
  const trend = historyTrendFor(property, history);
  if (!trend.available) return false;

  const { points, first, latest, percentage: change, direction, tone } = trend;
  const medians = points.map((point) => point.medianPriceNpr);
  const values = property.price === null ? medians : medians.concat(property.price);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(1, (rawMax - rawMin) * 0.12, rawMax * 0.02);
  const min = Math.max(0, rawMin - padding);
  const max = rawMax + padding;
  const valueSpan = Math.max(1, max - min);
  const startTime = new Date(first.date).valueOf();
  const endTime = new Date(latest.date).valueOf();
  const timeSpan = Math.max(1, endTime - startTime);
  const { context, width, height } = setupCanvas(elements.scenarioCanvas, SCENARIO_CHART_HEIGHT);
  const pad = { top: 16, right: 12, bottom: 28, left: 12 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const x = (date) => pad.left + ((new Date(date).valueOf() - startTime) / timeSpan) * chartWidth;
  const y = (value) => pad.top + chartHeight - ((value - min) / valueSpan) * chartHeight;

  context.fillStyle = "#f7f6f2";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(54, 60, 70, 0.12)";
  context.lineWidth = 1;
  for (let line = 0; line <= 3; line += 1) {
    const lineY = pad.top + (chartHeight / 3) * line;
    context.beginPath();
    context.moveTo(pad.left, lineY);
    context.lineTo(width - pad.right, lineY);
    context.stroke();
  }

  if (property.price !== null) {
    const askY = y(property.price);
    context.setLineDash([4, 4]);
    context.strokeStyle = "rgba(54, 60, 70, 0.55)";
    context.beginPath();
    context.moveTo(pad.left, askY);
    context.lineTo(width - pad.right, askY);
    context.stroke();
    context.setLineDash([]);
  }

  context.fillStyle = "rgba(40, 111, 134, 0.12)";
  context.beginPath();
  points.forEach((point, index) => index === 0 ? context.moveTo(x(point.date), y(point.medianPriceNpr)) : context.lineTo(x(point.date), y(point.medianPriceNpr)));
  context.lineTo(x(latest.date), height - pad.bottom);
  context.lineTo(x(first.date), height - pad.bottom);
  context.closePath();
  context.fill();

  context.strokeStyle = tone === "positive" ? "#16735a" : tone === "negative" ? "#ae453e" : "#286f86";
  context.lineWidth = 2.5;
  context.beginPath();
  points.forEach((point, index) => index === 0 ? context.moveTo(x(point.date), y(point.medianPriceNpr)) : context.lineTo(x(point.date), y(point.medianPriceNpr)));
  context.stroke();
  context.fillStyle = "#363c46";
  points.forEach((point) => {
    context.beginPath();
    context.arc(x(point.date), y(point.medianPriceNpr), 2.8, 0, Math.PI * 2);
    context.fill();
  });

  context.fillStyle = "#5d6472";
  context.font = `10px ${MARKET_FONT_FAMILY}`;
  context.fillText(formatDate(first.date).toUpperCase(), pad.left, height - 9);
  const endLabel = formatDate(latest.date).toUpperCase();
  const endWidth = context.measureText(endLabel).width;
  context.fillText(endLabel, width - pad.right - endWidth, height - 9);

  elements.analysisEyebrow.textContent = "OBSERVED ASK HISTORY";
  elements.analysisTitle.textContent = "Peer median trend";
  elements.horizonControl.hidden = true;
  elements.scenarioProperty.textContent = property.title;
  const historyWindowDays = Number(history.readiness?.historyWindowDays)
    || Math.round((new Date(latest.date) - new Date(first.date)) / 86_400_000) + 1;
  elements.scenarioPeer.textContent = `${points.length} qualifying days · ${historyWindowDays}-day span · latest n=${latest.listingCount}`;
  elements.scenarioSignal.className = `scenario-signal is-${tone}`;
  elements.scenarioDirection.textContent = direction.toUpperCase();
  elements.scenarioChange.textContent = formatPercent(change, true);
  elements.currentAskLabel.textContent = "Current ask";
  elements.currentAsk.textContent = formatAsk(property);
  elements.scenarioMidLabel.textContent = "Latest peer median";
  elements.scenarioMid.textContent = `${formatCurrency(latest.medianPriceNpr)} ${basisShortLabel(property.priceBasis)}`;
  elements.scenarioRangeLabel.textContent = "Observed median range";
  elements.scenarioRange.textContent = `${formatCurrency(Math.min(...medians))}–${formatCurrency(Math.max(...medians))}`;
  elements.confidenceLabel.textContent = "Coverage";
  elements.confidence.textContent = `${points.length} days · latest n=${latest.listingCount}`;
  elements.historyStatus.textContent = change > 0.015
    ? `This cohort met the history threshold. Comparable asking-price medians rose ${formatPercent(change, false)} across this observed window.`
    : change < -0.015
      ? "This cohort met the history threshold. The graph makes recent peer-price softness easy to compare against this property's ask."
      : "This cohort met the history threshold. Comparable asking-price medians were stable, creating a clear reference point.";
  elements.methodLabel.textContent = "Why this trend is useful";
  elements.methodCopy.textContent = "Each point is the median current ask for closely comparable listings, so the direction is easy to read alongside the selected property.";
  elements.methodInputs.textContent = "Daily asks with the same purpose, city, property type, and exact price basis.";
  elements.methodMissing.textContent = change > 0 ? "Rising peer medians can strengthen the selected property's relative position." : "A stable or softer cohort can support a more informed negotiation.";
  elements.scenarioCanvas.setAttribute("aria-label", `Observed peer median asking prices for ${property.city} ${property.type} listings from ${formatDate(first.date)} to ${formatDate(latest.date)} changed ${formatPercent(change, true)}. Dotted line marks the selected property's current ask.`);
  return true;
}

function drawScenario(property, history) {
  setScenarioPresentation(history);
  const scenario = scenarioFor(property);
  if (!property || !scenario.available) {
    drawEmptyChart(elements.scenarioCanvas, SCENARIO_CHART_HEIGHT, "SELECT ANOTHER LISTING FOR AN UPSIDE VIEW");
    elements.scenarioProperty.textContent = property?.title || "No property selected";
    elements.scenarioPeer.textContent = property ? analyticsExclusion(property) : "Select a listing to begin";
    elements.scenarioSignal.className = "scenario-signal is-neutral";
    elements.scenarioDirection.textContent = "NO SIGNAL";
    elements.scenarioChange.textContent = "--";
    elements.currentAsk.textContent = property ? formatAsk(property) : "--";
    elements.scenarioMid.textContent = "--";
    elements.scenarioRange.textContent = "--";
    elements.confidence.textContent = "Insufficient";
    if (!property) elements.historyStatus.textContent = "Select a listing to check its exact-cohort history.";
    else elements.historyStatus.textContent = `Observed history and the peer scenario are withheld for this listing: ${analyticsExclusion(property)}.`;
    elements.scenarioCanvas.setAttribute("aria-label", property ? `No experimental scenario for ${property.title}: ${analyticsExclusion(property)}.` : "No property selected for an experimental scenario.");
    return;
  }

  const { context, width, height } = setupCanvas(elements.scenarioCanvas, SCENARIO_CHART_HEIGHT);
  const pad = { top: 16, right: 12, bottom: 28, left: 12 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const min = Math.min(property.price, scenario.low) * 0.96;
  const max = Math.max(property.price, scenario.high) * 1.04;
  const valueSpan = Math.max(1, max - min);
  const y = (value) => pad.top + chartHeight - ((value - min) / valueSpan) * chartHeight;
  const steps = 4;

  context.fillStyle = "#f7f6f2";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(54, 60, 70, 0.12)";
  for (let line = 0; line <= 3; line += 1) {
    const lineY = pad.top + (chartHeight / 3) * line;
    context.beginPath();
    context.moveTo(pad.left, lineY);
    context.lineTo(width - pad.right, lineY);
    context.stroke();
  }

  const points = Array.from({ length: steps }, (_, index) => {
    const progress = index / (steps - 1);
    const midpoint = property.price + (scenario.midpoint - property.price) * progress;
    const band = scenario.uncertainty * progress;
    return {
      x: pad.left + chartWidth * progress,
      midpoint,
      low: midpoint * (1 - band),
      high: midpoint * (1 + band),
    };
  });

  context.fillStyle = "rgba(40, 111, 134, 0.15)";
  context.beginPath();
  points.forEach((point, index) => index === 0 ? context.moveTo(point.x, y(point.high)) : context.lineTo(point.x, y(point.high)));
  [...points].reverse().forEach((point) => context.lineTo(point.x, y(point.low)));
  context.closePath();
  context.fill();

  context.strokeStyle = scenario.tone === "positive" ? "#16735a" : scenario.tone === "negative" ? "#ae453e" : "#5d6472";
  context.lineWidth = 2.5;
  context.beginPath();
  points.forEach((point, index) => index === 0 ? context.moveTo(point.x, y(point.midpoint)) : context.lineTo(point.x, y(point.midpoint)));
  context.stroke();

  context.fillStyle = "#363c46";
  points.forEach((point) => {
    context.beginPath();
    context.arc(point.x, y(point.midpoint), 3.5, 0, Math.PI * 2);
    context.fill();
  });

  context.fillStyle = "#5d6472";
  context.font = `10px ${MARKET_FONT_FAMILY}`;
  context.fillText("NOW", pad.left, height - 9);
  context.fillText(`${state.horizon}M`, width - pad.right - 20, height - 9);

  elements.scenarioProperty.textContent = property.title;
  elements.scenarioPeer.textContent = `${scenario.stats.sampleCount} ${property.city} ${property.type.toLowerCase()} peers · ${basisShortLabel(property.priceBasis)}`;
  elements.scenarioSignal.className = `scenario-signal is-${scenario.tone}`;
  elements.scenarioDirection.textContent = scenario.direction.toUpperCase();
  elements.scenarioChange.textContent = formatPercent(scenario.percentage, true);
  elements.currentAsk.textContent = formatAsk(property);
  elements.scenarioMid.textContent = `${formatCurrency(scenario.midpoint)} ${basisShortLabel(property.priceBasis)}`;
  elements.scenarioRange.textContent = `${formatCurrency(scenario.low)}–${formatCurrency(scenario.high)}`;
  elements.confidence.textContent = `${scenario.confidence} · n=${scenario.stats.sampleCount}`;
  const historyLabel = historyProgress(history);
  elements.historyStatus.textContent = scenario.stats.delta < -0.015
    ? `${historyLabel} Why it stands out: the current ask is ${formatPercent(Math.abs(scenario.stats.delta), false)} below the peer median, leaving positive room toward the cohort midpoint.`
    : scenario.stats.delta > 0.015
      ? `${historyLabel} This home sits above its peer midpoint; use the larger distribution chart to see the premium clearly.`
      : `${historyLabel} This ask sits close to its peer midpoint, making it a balanced comparison candidate.`;
  elements.methodMissing.textContent = scenario.tone === "positive"
    ? "Its below-median starting position is the main upside signal in the current peer set."
    : "Its clearest value is as a transparent comparison against the live peer midpoint.";
  elements.scenarioCanvas.setAttribute("aria-label", `${state.horizon}-month experimental scenario for ${property.title}: ${scenario.direction}, ${formatPercent(scenario.percentage, true)}, with range ${formatCurrency(scenario.low)} to ${formatCurrency(scenario.high)}.`);
}

function focusedProperty(properties = filteredProperties()) {
  return properties.find((property) => property.id === state.focusedId) || null;
}

function renderKpis(properties, focus) {
  const eligible = properties.filter((property) => peerStats(property));
  const stats = peerStats(focus);
  elements.inventoryKpi.textContent = compactNumber(properties.length, 0);
  elements.inventoryKpiNote.textContent = `${state.purpose === "buy" ? "for sale" : "for rent"} · ${state.type === "all" ? "all property" : state.type.toLowerCase()}`;
  elements.coverageKpi.textContent = properties.length ? `${Math.round((eligible.length / properties.length) * 100)}%` : "0%";
  if (focus && stats) {
    elements.medianKpi.textContent = formatCurrency(stats.median);
    elements.basisKpi.textContent = `${focus.city} ${focus.type.toLowerCase()} · ${basisShortLabel(focus.priceBasis)} · n=${stats.sampleCount}`;
    elements.rangeKpi.textContent = `${formatCurrency(stats.q1)}–${formatCurrency(stats.q3)}`;
  } else {
    elements.medianKpi.textContent = "--";
    elements.basisKpi.textContent = "select a benchmarked listing";
    elements.rangeKpi.textContent = "--";
  }
}

function renderAnalytics(properties, { loadHistory = true } = {}) {
  const focus = focusedProperty(properties);
  renderKpis(properties, focus);
  elements.analyticsRail.hidden = !focus;
  elements.workspace.classList.toggle("has-focus", Boolean(focus));
  if (!focus) return;
  drawDistribution(focus);
  let history = historyFor(focus);
  if (focus && peerStats(focus) && !history && state.feedMode === "snapshot") {
    state.history.set(cohortKey(focus), { status: "unavailable", readiness: {}, items: [] });
    history = historyFor(focus);
  }
  if (!drawObservedHistory(focus, history)) drawScenario(focus, history);
  if (loadHistory && focus && peerStats(focus)) void ensureHistory(focus);
}

function renderAll({ resetScroll = false } = {}) {
  populateBases();
  const properties = filteredProperties();
  if (!properties.some((property) => property.id === state.focusedId)) {
    state.focusedId = null;
  }
  renderInventory(properties);
  renderComparison();
  renderAnalytics(properties);
  if (resetScroll) elements.inventory.scrollTop = 0;
}

function setFocus(id) {
  if (!state.properties.some((property) => property.id === id)) return;
  state.focusedId = id;
  elements.inventory.querySelectorAll(".inventory-row").forEach((row) => row.classList.toggle("is-focused", row.dataset.propertyId === id));
  renderAnalytics(filteredProperties());
}

function toggleComparison(id, { restoreInventoryFocus = false } = {}) {
  const existingIndex = state.selectedIds.indexOf(id);
  if (existingIndex >= 0) {
    state.selectedIds.splice(existingIndex, 1);
    if (state.focusedId === id) state.focusedId = state.selectedIds[0] || null;
  } else if (state.selectedIds.length >= 4) {
    showToast("Four listings are already pinned. Remove one before adding another.");
    return;
  } else {
    state.selectedIds.push(id);
    state.focusedId = id;
  }
  renderAll();
  if (restoreInventoryFocus) {
    window.requestAnimationFrame(() => {
      const target = elements.inventory.querySelector(`[data-toggle-compare="${CSS.escape(id)}"]`)
        || elements.inventory.querySelector("[data-toggle-compare]")
        || document.querySelector("[data-clear-comparison]");
      target?.focus();
    });
  }
}

function syncPurposeButtons() {
  document.querySelectorAll("[data-purpose]").forEach((button) => {
    const active = button.dataset.purpose === state.purpose;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function syncHorizonButtons() {
  document.querySelectorAll("[data-horizon]").forEach((button) => {
    const active = Number(button.dataset.horizon) === state.horizon;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function resetFilters() {
  state.purpose = "buy";
  state.city = "all";
  state.type = state.properties.some((property) => property.type === "House") ? "House" : "all";
  state.basis = "all";
  state.sort = "signal-high";
  state.search = "";
  state.horizon = 12;
  state.selectedIds = [];
  state.focusedId = null;
  elements.city.value = state.city;
  elements.type.value = state.type;
  elements.sort.value = state.sort;
  elements.search.value = "";
  syncPurposeButtons();
  syncHorizonButtons();
  renderAll({ resetScroll: true });
}

function chooseInitialProperties() {
  state.selectedIds = [];
  state.focusedId = null;
}

document.querySelectorAll("[data-purpose]").forEach((button) => {
  button.addEventListener("click", () => {
    state.purpose = button.dataset.purpose;
    state.basis = "all";
    syncPurposeButtons();
    renderAll({ resetScroll: true });
  });
});

document.querySelectorAll("[data-horizon]").forEach((button) => {
  button.addEventListener("click", () => {
    state.horizon = Number(button.dataset.horizon);
    syncHorizonButtons();
    renderInventory(filteredProperties());
    renderComparison();
    renderAnalytics(filteredProperties());
  });
});

elements.city.addEventListener("change", (event) => {
  state.city = event.target.value;
  state.basis = "all";
  renderAll({ resetScroll: true });
});

elements.type.addEventListener("change", (event) => {
  state.type = event.target.value;
  state.basis = "all";
  renderAll({ resetScroll: true });
});

elements.basis.addEventListener("change", (event) => {
  state.basis = event.target.value;
  renderAll({ resetScroll: true });
});

elements.sort.addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderAll({ resetScroll: true });
});

elements.search.addEventListener("input", (event) => {
  state.search = event.target.value;
  renderAll({ resetScroll: true });
});

document.querySelector("[data-reset]").addEventListener("click", resetFilters);

elements.inventory.addEventListener("click", (event) => {
  const compareButton = event.target.closest("[data-toggle-compare]");
  if (compareButton) {
    toggleComparison(compareButton.dataset.toggleCompare, { restoreInventoryFocus: true });
    return;
  }
  const focusButton = event.target.closest("[data-focus-property]");
  if (focusButton) setFocus(focusButton.dataset.focusProperty);
});

elements.comparisonGrid.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-comparison]");
  if (removeButton) toggleComparison(removeButton.dataset.removeComparison, { restoreInventoryFocus: true });
});

document.querySelector("[data-clear-comparison]").addEventListener("click", () => {
  state.selectedIds = [];
  state.focusedId = null;
  renderAll();
});

document.querySelector("[data-method-open]").addEventListener("click", (event) => {
  const panel = document.querySelector("[data-method-panel]");
  const open = panel.hidden;
  panel.hidden = !open;
  event.currentTarget.setAttribute("aria-expanded", String(open));
  event.currentTarget.querySelector("span[aria-hidden]").textContent = open ? "−" : "+";
});

window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderAnalytics(filteredProperties()), 120);
});

async function initialise() {
  try {
    const payload = await fetchListings();
    state.properties = payload.items.map(normaliseProperty).filter((property) => property.id);
    state.asOf = payload.asOf || state.properties.map((property) => property.indexedAt).filter(Boolean).sort().at(-1) || null;
    state.feedMode = payload.feedMode;
    state.freshness = payload.freshness && typeof payload.freshness === "object" ? payload.freshness : null;
    state.sourceCount = Array.isArray(payload.sources) && payload.sources.length
      ? payload.sources.length
      : new Set(state.properties.map((property) => property.sourceName)).size;
    const analytics = buildAnalytics(state.properties);
    state.analytics = analytics.groups;
    state.analyticsEligibleIds = analytics.analyticsEligibleIds;
    state.duplicateIds = analytics.duplicateIds;
    state.outlierIds = analytics.outlierIds;
    populateCities();
    populateTypes();
    chooseInitialProperties();
    setFeedState();
    renderAll();
  } catch (error) {
    elements.feedState.className = "feed-state is-error";
    elements.feedState.querySelector("span:last-child").textContent = "Market data unavailable";
    elements.inventory.setAttribute("aria-busy", "false");
    elements.inventory.innerHTML = "";
    elements.inventory.hidden = true;
    elements.empty.hidden = false;
    elements.empty.querySelector("strong").textContent = "Unable to load the market index";
    elements.empty.querySelector("span").textContent = "Check the data service, then reload this page.";
    drawEmptyChart(elements.distributionCanvas, DISTRIBUTION_CHART_HEIGHT, "MARKET DATA UNAVAILABLE");
    drawEmptyChart(elements.scenarioCanvas, SCENARIO_CHART_HEIGHT, "MARKET DATA UNAVAILABLE");
    console.error(error);
  }
}

initialise();
