const fallbackImage = "/assets/images/property-image-unavailable.svg";

const state = {
  properties: [],
  analytics: new Map(),
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
};

const elements = {
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
  scenarioProperty: document.querySelector("[data-scenario-property]"),
  scenarioPeer: document.querySelector("[data-scenario-peer]"),
  scenarioSignal: document.querySelector("[data-scenario-signal]"),
  scenarioDirection: document.querySelector("[data-scenario-direction]"),
  scenarioChange: document.querySelector("[data-scenario-change]"),
  currentAsk: document.querySelector("[data-current-ask]"),
  scenarioMid: document.querySelector("[data-scenario-mid]"),
  scenarioRange: document.querySelector("[data-scenario-range]"),
  confidence: document.querySelector("[data-confidence]"),
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
  try {
    const url = new URL(String(value), window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normaliseProperty(property) {
  const facts = property.facts && typeof property.facts === "object" ? property.facts : {};
  return {
    id: String(property.id ?? ""),
    title: String(property.title || "Untitled property"),
    location: String(property.location || property.city || "Location not supplied"),
    locality: String(property.locality || ""),
    city: String(property.city || "Other"),
    type: String(property.type || "Property"),
    purpose: property.purpose === "rent" ? "rent" : "buy",
    price: finiteNumber(property.price),
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
  return /\$|\busd\b|dollar/i.test(`${property.title} ${property.priceLabel} ${sourcePrice}`);
}

function isCleanForAnalytics(property) {
  return property.price !== null && property.price > 0 && qualityFlags(property).length === 0 && !hasCurrencyMismatch(property);
}

function parseArea(areaLabel) {
  const text = String(areaLabel || "").toLowerCase().replaceAll(",", " ");
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
  return { value: property.price / parsed.value, unit: parsed.unit };
}

function cohortKey(property) {
  return [property.purpose, property.type, property.city, property.priceBasis].join("|");
}

function duplicateKey(property) {
  const title = property.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  properties.filter(isCleanForAnalytics).forEach((property) => {
    const key = cohortKey(property);
    if (!groups.has(key)) groups.set(key, new Map());
    const group = groups.get(key);
    const fingerprint = duplicateKey(property);
    if (!group.has(fingerprint)) group.set(fingerprint, property);
  });

  const analytics = new Map();
  groups.forEach((deduplicated, key) => {
    const values = [...deduplicated.values()].map((property) => property.price).sort((a, b) => a - b);
    if (values.length < 8) return;

    const initialQ1 = quantile(values, 0.25);
    const initialQ3 = quantile(values, 0.75);
    const initialIqr = initialQ3 - initialQ1;
    const lowerFence = Math.max(0, initialQ1 - initialIqr * 2.5);
    const upperFence = initialQ3 + initialIqr * 2.5;
    const filtered = values.filter((value) => value >= lowerFence && value <= upperFence);
    if (filtered.length < 8) return;

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
  });
  return analytics;
}

function peerStats(property) {
  if (!property || !isCleanForAnalytics(property)) return null;
  const group = state.analytics.get(cohortKey(property));
  if (!group || property.price < group.lowerFence || property.price > group.upperFence) return null;
  const belowOrEqual = group.values.filter((value) => value <= property.price).length;
  const percentile = Math.round((belowOrEqual / group.values.length) * 100);
  const delta = group.median > 0 ? property.price / group.median - 1 : 0;
  return { ...group, percentile, delta };
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

function peerPosition(stats) {
  if (!stats) return { value: "Not benchmarked", note: "Insufficient clean peers" };
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
    const payload = await fetchJSON("/api/listings?limit=250&offset=0");
    if (!Array.isArray(payload.items)) throw new Error("Listing response is missing items");
    return { ...payload, feedMode: payload.mode === "live" ? "live" : "snapshot" };
  } catch {
    const payload = await fetchJSON("/data/listings.json");
    if (!Array.isArray(payload.items)) throw new Error("Snapshot is missing items");
    return { ...payload, feedMode: "snapshot" };
  }
}

function feedAgeHours(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return Infinity;
  return Math.max(0, (Date.now() - date.valueOf()) / 3_600_000);
}

function setFeedState() {
  const stale = feedAgeHours(state.asOf) > 8;
  const mode = state.feedMode === "live" ? "Live API" : "Deployable snapshot";
  elements.feedState.className = `feed-state ${stale ? "is-stale" : "is-live"}`;
  elements.feedState.querySelector("span:last-child").textContent = `${mode} · ${state.properties.length} listings`;
  elements.asOf.textContent = formatDate(state.asOf, true);
  elements.coverage.textContent = `${state.sourceCount} sources · ${stale ? "refresh overdue" : "refresh current"}`;
  elements.dataScope.textContent = `${state.properties.length} active asking listings from ${state.sourceCount} attributed publishers, indexed ${formatDate(state.asOf)}. This is a bounded listing sample, not a census of Nepal's housing market.`;
}

function populateCities() {
  const cities = [...new Set(state.properties.map((property) => property.city).filter(Boolean))].sort();
  elements.city.innerHTML = '<option value="all">All markets</option>' + cities.map((city) => `<option value="${escapeHTML(city)}">${escapeHTML(city)}</option>`).join("");
  elements.city.value = state.city;
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
    if (state.sort === "newest") return new Date(second.indexedAt || 0) - new Date(first.indexedAt || 0);
    if (state.sort === "price-low" || state.sort === "price-high") {
      const basisOrder = first.priceBasis.localeCompare(second.priceBasis);
      if (basisOrder && state.basis === "all") return basisOrder;
      const direction = state.sort === "price-low" ? 1 : -1;
      return ((first.price ?? Infinity) - (second.price ?? Infinity)) * direction;
    }
    if (state.sort === "value-low") return (peerStats(first)?.delta ?? Infinity) - (peerStats(second)?.delta ?? Infinity);
    const firstSignal = scenarioFor(first);
    const secondSignal = scenarioFor(second);
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
  const position = peerPosition(stats);
  const scenario = scenarioFor(property);
  const scenarioValue = scenario.available ? `${scenario.direction} ${formatPercent(scenario.percentage, true)}` : "No signal";
  const scenarioNote = scenario.available ? `${state.horizon}M · ${scenario.confidence.toLowerCase()} confidence` : "needs 8 clean peers";
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
      <div class="inventory-scenario is-${scenario.tone || "neutral"}">
        <strong>${escapeHTML(scenarioValue)}</strong>
        <span>${escapeHTML(scenarioNote)}</span>
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
  const position = peerPosition(stats);
  const scenario = scenarioFor(property);
  const derived = derivedUnitAsk(property);
  const bedsAndBaths = [property.beds !== null ? `${compactNumber(property.beds, 0)} bed` : "", property.baths !== null ? `${compactNumber(property.baths, 0)} bath` : ""].filter(Boolean).join(" · ");
  const road = factValue(property, "road_access", "road_and_area");
  const facing = factValue(property, "facing");
  const parking = factValue(property, "parking");
  const furnishing = factValue(property, "furnishing", "furnished");
  const signalClass = `comparison-signal is-${scenario.tone || "neutral"}`;
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
        ${comparisonMetric(`${state.horizon}M scenario`, scenario.available ? `${scenario.direction} ${formatPercent(scenario.percentage, true)}` : "History unavailable", signalClass)}
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
  context.font = "11px Helvetica, Arial, sans-serif";
  context.fillText(message, 14, Math.round(height / 2));
}

function drawDistribution(property) {
  const stats = peerStats(property);
  if (!property || !stats) {
    drawEmptyChart(elements.distributionCanvas, 220, "INSUFFICIENT CLEAN PEER DATA");
    elements.chartBasis.textContent = "No cohort";
    elements.chartScale.innerHTML = "<span>--</span><span>--</span><span>--</span>";
    elements.distributionNote.textContent = "A benchmark appears when a city, property type, purpose, and exact price basis have at least eight clean listings.";
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

  const { context, width, height } = setupCanvas(elements.distributionCanvas, 220);
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
  context.font = "bold 10px Helvetica, Arial, sans-serif";
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
  elements.distributionNote.textContent = `${stats.sampleCount} deduplicated, outlier-screened ${property.city} ${property.type.toLowerCase()} ${property.purpose === "buy" ? "sale" : "rental"} asks. Dark marker is the selected property; blue line is the peer median.`;
  elements.distributionCanvas.setAttribute("aria-label", `${property.title} asking price at percentile ${stats.percentile} among ${stats.sampleCount} comparable listings.`);
}

function drawScenario(property) {
  const scenario = scenarioFor(property);
  if (!property || !scenario.available) {
    drawEmptyChart(elements.scenarioCanvas, 170, "HISTORY UNAVAILABLE · PEER SCENARIO ONLY");
    elements.scenarioProperty.textContent = property?.title || "No property selected";
    elements.scenarioPeer.textContent = "At least 8 clean peers are required";
    elements.scenarioSignal.className = "scenario-signal is-neutral";
    elements.scenarioDirection.textContent = "NO SIGNAL";
    elements.scenarioChange.textContent = "--";
    elements.currentAsk.textContent = property ? formatAsk(property) : "--";
    elements.scenarioMid.textContent = "--";
    elements.scenarioRange.textContent = "--";
    elements.confidence.textContent = "Insufficient";
    return;
  }

  const { context, width, height } = setupCanvas(elements.scenarioCanvas, 170);
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
  context.font = "10px Helvetica, Arial, sans-serif";
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
  elements.scenarioCanvas.setAttribute("aria-label", `${state.horizon}-month experimental scenario for ${property.title}: ${scenario.direction}, ${formatPercent(scenario.percentage, true)}, with range ${formatCurrency(scenario.low)} to ${formatCurrency(scenario.high)}.`);
}

function focusedProperty(properties = filteredProperties()) {
  return state.properties.find((property) => property.id === state.focusedId) || properties.find((property) => peerStats(property)) || properties[0] || null;
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

function renderAnalytics(properties) {
  const focus = focusedProperty(properties);
  if (focus && state.focusedId !== focus.id) state.focusedId = focus.id;
  renderKpis(properties, focus);
  drawDistribution(focus);
  drawScenario(focus);
}

function renderAll({ resetScroll = false } = {}) {
  populateBases();
  const properties = filteredProperties();
  if (!properties.some((property) => property.id === state.focusedId)) {
    state.focusedId = properties.find((property) => peerStats(property))?.id || properties[0]?.id || null;
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

function toggleComparison(id) {
  const existingIndex = state.selectedIds.indexOf(id);
  if (existingIndex >= 0) {
    state.selectedIds.splice(existingIndex, 1);
  } else if (state.selectedIds.length >= 4) {
    showToast("Four listings are already pinned. Remove one before adding another.");
    return;
  } else {
    state.selectedIds.push(id);
    state.focusedId = id;
  }
  renderAll();
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
  state.type = "House";
  state.basis = "all";
  state.sort = "signal-high";
  state.search = "";
  state.horizon = 12;
  elements.city.value = state.city;
  elements.type.value = state.type;
  elements.sort.value = state.sort;
  elements.search.value = "";
  syncPurposeButtons();
  syncHorizonButtons();
  renderAll({ resetScroll: true });
}

function chooseInitialProperties() {
  const candidates = filteredProperties().filter((property) => peerStats(property));
  state.selectedIds = candidates.slice(0, 2).map((property) => property.id);
  state.focusedId = state.selectedIds[0] || filteredProperties()[0]?.id || null;
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
    renderAll();
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
    toggleComparison(compareButton.dataset.toggleCompare);
    return;
  }
  const focusButton = event.target.closest("[data-focus-property]");
  if (focusButton) setFocus(focusButton.dataset.focusProperty);
});

elements.comparisonGrid.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-comparison]");
  if (removeButton) toggleComparison(removeButton.dataset.removeComparison);
});

document.querySelector("[data-clear-comparison]").addEventListener("click", () => {
  state.selectedIds = [];
  renderAll();
});

document.querySelector("[data-method-open]").addEventListener("click", (event) => {
  const panel = document.querySelector("[data-method-panel]");
  const open = panel.hidden;
  panel.hidden = !open;
  event.currentTarget.setAttribute("aria-expanded", String(open));
  event.currentTarget.querySelector("span").textContent = open ? "−" : "+";
});

window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => renderAnalytics(filteredProperties()), 120);
});

async function initialise() {
  elements.type.value = state.type;
  try {
    const payload = await fetchListings();
    state.properties = payload.items.map(normaliseProperty).filter((property) => property.id);
    state.asOf = payload.asOf || state.properties.map((property) => property.indexedAt).filter(Boolean).sort().at(-1) || null;
    state.feedMode = payload.feedMode;
    state.sourceCount = Array.isArray(payload.sources) && payload.sources.length
      ? payload.sources.length
      : new Set(state.properties.map((property) => property.sourceName)).size;
    state.analytics = buildAnalytics(state.properties);
    populateCities();
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
    drawEmptyChart(elements.distributionCanvas, 220, "MARKET DATA UNAVAILABLE");
    drawEmptyChart(elements.scenarioCanvas, 170, "MARKET DATA UNAVAILABLE");
    console.error(error);
  }
}

initialise();
