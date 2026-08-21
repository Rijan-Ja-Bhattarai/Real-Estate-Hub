const fallbackImage = "assets/images/property-image-unavailable.svg";
const cityCentroids = { Kathmandu: [27.7172, 85.324], Lalitpur: [27.6588, 85.3247], Bhaktapur: [27.671, 85.4298], Pokhara: [28.2096, 83.9856], Chitwan: [27.5291, 84.3542], Biratnagar: [26.4525, 87.2718], Itahari: [26.6631, 87.274], Tanahun: [27.9447, 84.2279], Kaski: [28.2096, 83.9856], Nepal: [28.3949, 84.124] };

const state = {
  properties: [],
  purpose: "buy",
  location: "all",
  type: "all",
  budget: "all",
  cardFilter: "all",
  sort: "featured",
  visible: 6,
  savedOnly: false,
  activePropertyId: null,
  mapPropertyId: null,
  loading: true,
  feedMode: "loading",
  asOf: null,
  saved: readSaved(),
};

const grid = document.querySelector("[data-property-grid]");
const emptyState = document.querySelector("[data-listing-empty]");
const loadMoreButton = document.querySelector("[data-load-more]");
const resultSummary = document.querySelector("[data-result-summary]");
const searchForm = document.querySelector("[data-search-form]");
const sortSelect = document.querySelector("[data-sort]");
const dialog = document.querySelector("[data-property-dialog]");
const toast = document.querySelector("[data-toast]");
const mapPanel = document.querySelector("[data-listing-map]");
const feedBadge = document.querySelector("[data-feed-badge]");
const sourceStatus = document.querySelector("[data-source-status]");
let toastTimer;

function readSaved() {
  try {
    const parsed = JSON.parse(localStorage.getItem("nei-saved") || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function persistSaved() {
  try {
    localStorage.setItem("nei-saved", JSON.stringify([...state.saved]));
  } catch {
    // Saving remains optional when browser storage is unavailable.
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeURL(value, fallback = "#") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value, window.location.href);
    if (["http:", "https:"].includes(url.protocol) || url.origin === window.location.origin) return url.href;
  } catch {
    // Use the safe fallback below.
  }
  return fallback;
}

function preferredScrollBehavior() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function normaliseProperty(property) {
  const price = property.price == null ? Number.NaN : Number(property.price);
  const latitude = property.latitude == null ? Number.NaN : Number(property.latitude);
  const longitude = property.longitude == null ? Number.NaN : Number(property.longitude);
  const imageLicenseStatus = String(property.imageLicenseStatus || "unconfirmed");
  const imageCanBeReferenced = !imageLicenseStatus.includes("prohibited");
  return {
    id: String(property.id),
    title: String(property.title || "Untitled property"),
    location: String(property.location || property.city || "Nepal"),
    locality: String(property.locality || ""),
    city: String(property.city || "Nepal"),
    type: String(property.type || "Property"),
    purpose: property.purpose === "rent" ? "rent" : "buy",
    price: Number.isFinite(price) ? price : null,
    priceBasis: String(property.priceBasis || (property.purpose === "rent" ? "monthly" : "total")),
    priceLabel: String(property.priceLabel || "Price on request"),
    beds: property.beds == null ? null : Number(property.beds),
    baths: property.baths == null ? null : Number(property.baths),
    area: String(property.area || "Area on source"),
    image: safeURL(imageCanBeReferenced ? property.image : "", fallbackImage),
    imageAlt: String(property.imageAlt || `${property.title || "Property"} source photograph`),
    imageCredit: String(property.imageCredit || "Photograph belongs to the original publisher."),
    imagePosition: String(property.imagePosition || "center"),
    description: String(property.description || "Open the original listing for full details."),
    sourceName: String(property.sourceName || "Original publisher"),
    sourceUrl: safeURL(property.sourceUrl),
    contentLicenseStatus: String(property.contentLicenseStatus || "unconfirmed"),
    imageLicenseStatus,
    sourceAgeLabel: String(property.sourceAgeLabel || ""),
    sourcePublishedAt: String(property.sourcePublishedAt || ""),
    indexedAt: String(property.indexedAt || ""),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    locationPrecision: String(property.locationPrecision || "unknown"),
    mapQuery: String(property.mapQuery || `${property.location || property.city || "Nepal"}, Nepal`),
    facts: property.facts && typeof property.facts === "object" ? property.facts : {},
  };
}

function recencyValue(property) {
  const publishedTimestamp = Date.parse(property.sourcePublishedAt);
  if (Number.isFinite(publishedTimestamp)) return -publishedTimestamp;
  const label = property.sourceAgeLabel.toLowerCase();
  const days = Number(label.match(/([\d.]+)\s*day/)?.[1] || 0);
  const hours = Number(label.match(/([\d.]+)\s*hour/)?.[1] || 0);
  if (days || hours) return days * 24 + hours;
  const timestamp = Date.parse(property.indexedAt);
  return Number.isFinite(timestamp) ? (Date.now() - timestamp) / 3_600_000 : Number.MAX_SAFE_INTEGER;
}

function comparePriceWithinBasis(first, second, direction) {
  const basisRank = (basis) => ["total", "monthly"].includes(basis) ? 0 : basis.startsWith("per-") ? 1 : 2;
  const basisDifference = basisRank(first.priceBasis) - basisRank(second.priceBasis);
  if (basisDifference) return basisDifference;
  const firstPrice = first.price ?? (direction > 0 ? Number.MAX_SAFE_INTEGER : -1);
  const secondPrice = second.price ?? (direction > 0 ? Number.MAX_SAFE_INTEGER : -1);
  return (firstPrice - secondPrice) * direction;
}

function filteredProperties() {
  const results = state.properties.filter((property) => {
    const purposeMatch = state.savedOnly || property.purpose === state.purpose;
    const locationMatch = state.location === "all" || property.city === state.location;
    const typeMatch = state.type === "all" || property.type === state.type;
    const budgetComparable = ["total", "monthly"].includes(property.priceBasis);
    const budgetMatch =
      state.budget === "all" || (budgetComparable && property.price != null && property.price <= Number(state.budget));
    const cardMatch =
      state.cardFilter === "all" || property.type === state.cardFilter || property.purpose === state.cardFilter;
    const savedMatch = !state.savedOnly || state.saved.has(property.id);
    return purposeMatch && locationMatch && typeMatch && budgetMatch && cardMatch && savedMatch;
  });

  if (state.sort === "newest") results.sort((a, b) => recencyValue(a) - recencyValue(b));
  if (state.sort === "price-low") results.sort((a, b) => comparePriceWithinBasis(a, b, 1));
  if (state.sort === "price-high") results.sort((a, b) => comparePriceWithinBasis(a, b, -1));
  return results;
}

function factsLabel(property) {
  const facts = [];
  if (property.beds) facts.push(`${property.beds} bed`);
  if (property.baths) facts.push(`${property.baths} bath`);
  if (property.area) facts.push(property.area);
  return facts.join(" · ");
}

function formatIndexedAt(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Indexed recently";
  return `Indexed ${new Intl.DateTimeFormat("en-NP", { dateStyle: "medium", timeStyle: "short" }).format(timestamp)}`;
}

function propertyCard(property, index) {
  const saved = state.saved.has(property.id);
  const sourceAge = property.sourceAgeLabel ? ` · Source age at index ${escapeHTML(property.sourceAgeLabel)}` : "";
  const imagePolicy = property.imageLicenseStatus.includes("unconfirmed")
    ? '<span class="property-image-policy">Source preview · rights unconfirmed</span>'
    : property.imageLicenseStatus.includes("owner-permission-attested")
      ? '<span class="property-image-policy">Owner-authorized prototype</span>'
    : "";
  const mapAction = hasMapLocation(property)
    ? `<button type="button" data-map-property="${escapeHTML(property.id)}">Show on map</button>`
    : `<a href="/properties?${new URLSearchParams({ purpose: property.purpose, city: property.city, listing: property.id, view: "map" })}">Browse named area →</a>`;
  return `
    <article class="property-card" style="animation-delay:${Math.min(index * 70, 350)}ms">
      <div class="property-image">
        <img src="${escapeHTML(property.image)}" alt="${escapeHTML(property.imageAlt)}" loading="lazy"
          referrerpolicy="no-referrer" style="object-position:${escapeHTML(property.imagePosition)}" />
        <span class="property-badge">For ${property.purpose === "buy" ? "sale" : "rent"} · ${escapeHTML(property.type)}</span>
        ${imagePolicy}
        <button class="property-save ${saved ? "is-saved" : ""}" type="button"
          data-save-property="${escapeHTML(property.id)}" aria-label="${saved ? "Remove" : "Save"} ${escapeHTML(property.title)}"
          aria-pressed="${saved}">${saved ? "♥" : "♡"}</button>
      </div>
      <div class="property-body">
        <p class="property-location">${escapeHTML(property.location)}${sourceAge}</p>
        <h3><button class="property-open" type="button" data-open-property="${escapeHTML(property.id)}">${escapeHTML(property.title)}</button></h3>
        <div class="property-price-row">
          <p class="property-price">${escapeHTML(property.priceLabel)}</p>
          <p class="property-facts">${escapeHTML(factsLabel(property))}</p>
        </div>
        <div class="property-source-row">
          <a href="${escapeHTML(property.sourceUrl)}" target="_blank" rel="noopener noreferrer"
            aria-label="Open ${escapeHTML(property.title)} on ${escapeHTML(property.sourceName)}">
            ${escapeHTML(property.sourceName)} <span aria-hidden="true">↗</span>
          </a>
          ${mapAction}
        </div>
      </div>
    </article>`;
}

function addImageFallbacks(root = document) {
  root.querySelectorAll(".property-image img, [data-dialog-image]").forEach((image) => {
    image.addEventListener(
      "error",
      () => {
        if (!image.src.endsWith(fallbackImage)) {
          image.src = fallbackImage;
          image.alt = "Source listing image unavailable";
        }
      },
      { once: true },
    );
  });
}

function renderLoading() {
  grid.innerHTML = Array.from(
    { length: 3 },
    () => '<article class="property-card property-card-loading" aria-hidden="true"><div></div><span></span><span></span></article>',
  ).join("");
  emptyState.hidden = true;
  loadMoreButton.hidden = true;
  mapPanel.hidden = true;
}

function renderProperties() {
  if (state.loading) {
    renderLoading();
    return;
  }
  if (!state.savedOnly) syncPurposeButtons();
  const filtered = filteredProperties();
  const visible = filtered.slice(0, state.visible);
  grid.innerHTML = visible.map(propertyCard).join("");
  addImageFallbacks(grid);
  emptyState.hidden = filtered.length !== 0;
  loadMoreButton.hidden = filtered.length <= state.visible;

  const purposeLabel = state.savedOnly ? "across all purposes" : state.purpose === "buy" ? "for sale" : "for rent";
  const feedLabel = state.savedOnly ? "saved" : "indexed";
  resultSummary.textContent = `${filtered.length} ${feedLabel} ${filtered.length === 1 ? "property" : "properties"} ${purposeLabel}`;
  sortSelect.disabled = state.savedOnly;
  updateSavedCount();

  if (visible.length) {
    const mapped = visible.find((property) => property.id === state.mapPropertyId) || visible.find(hasMapLocation);
    if (mapped) updateMap(mapped);
    else mapPanel.hidden = true;
  } else mapPanel.hidden = true;
}

function updateSavedCount() {
  document.querySelectorAll("[data-saved-count]").forEach((node) => {
    node.textContent = String(state.saved.size);
  });
}

function syncPurposeButtons() {
  document.querySelectorAll("[data-purpose]").forEach((button) => {
    const active = button.dataset.purpose === state.purpose;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function syncBudgetOptions() {
  const select = searchForm.elements.budget;
  const monthly = state.purpose === "rent";
  const options = monthly
    ? [
        ["50000", "Up to रु 50,000 / mo"],
        ["100000", "Up to रु 1 Lakh / mo"],
        ["200000", "Up to रु 2 Lakh / mo"],
        ["500000", "Up to रु 5 Lakh / mo"],
      ]
    : [
        ["20000000", "Up to रु 2 Cr"],
        ["40000000", "Up to रु 4 Cr"],
        ["60000000", "Up to रु 6 Cr"],
        ["100000000", "Up to रु 10 Cr"],
      ];
  document.querySelector("[data-budget-label]").textContent = monthly ? "Budget · monthly" : "Budget · total";
  select.innerHTML = '<option value="all">Any budget</option>' + options
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  if (![...select.options].some((option) => option.value === state.budget)) state.budget = "all";
  select.value = state.budget;
}

function updatePurpose(nextPurpose) {
  state.purpose = nextPurpose;
  state.budget = "all";
  state.cardFilter = "all";
  state.savedOnly = false;
  state.visible = 6;
  syncPurposeButtons();
  syncBudgetOptions();
  resetFilterChips();
  renderProperties();
}

function resetFilterChips() {
  document.querySelectorAll("[data-filter]").forEach((button) => {
    const active = button.dataset.filter === "all";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function clearFilters() {
  state.location = "all";
  state.type = "all";
  state.budget = "all";
  state.cardFilter = "all";
  state.savedOnly = false;
  state.visible = 6;
  searchForm.reset();
  updatePurpose("buy");
}

function toggleSave(id, { restoreCardFocus = false } = {}) {
  const property = state.properties.find((item) => item.id === id);
  if (!property) return;
  if (state.saved.has(id)) {
    state.saved.delete(id);
    showToast("Removed from your saved properties.");
  } else {
    state.saved.add(id);
    showToast("Saved for a closer look.");
  }
  persistSaved();
  renderProperties();
  if (restoreCardFocus) {
    const replacement = grid.querySelector(`[data-save-property="${CSS.escape(id)}"]`);
    (replacement || resultSummary).focus({ preventScroll: true });
  }
  if (state.activePropertyId === id && dialog.open) updateDialogSaveButton(property);
}

function mapPrecisionLabel(property) {
  if (property.locationPrecision === "exact") return "Coordinates supplied by source";
  if (property.locationPrecision === "unknown") return "Approximate named-place pin";
  return `Approximate ${property.locationPrecision} pin`;
}

function hasMapPoint(property) {
  return Number.isFinite(property.latitude) && Number.isFinite(property.longitude);
}

function hasMapLocation(property) {
  return hasMapPoint(property) || Boolean(property.mapQuery.trim());
}

function googleMapsEmbedURL(property) {
  const [latitude, longitude] = hasMapPoint(property) ? [property.latitude, property.longitude] : cityCentroids[property.city] || cityCentroids.Nepal;
  const span = property.locationPrecision === "exact" ? 0.012 : hasMapPoint(property) ? 0.04 : 0.35;
  const bounds = [longitude - span, latitude - span, longitude + span, latitude + span].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bounds)}&layer=mapnik&marker=${encodeURIComponent(`${latitude},${longitude}`)}`;
}

function updateMap(property, { scroll = false } = {}) {
  if (!hasMapLocation(property)) {
    mapPanel.hidden = true;
    return;
  }
  const changed = state.mapPropertyId !== property.id;
  state.mapPropertyId = property.id;
  mapPanel.hidden = false;
  mapPanel.querySelector("[data-map-title]").textContent = property.title;
  mapPanel.querySelector("[data-map-precision]").textContent = mapPrecisionLabel(property);
  mapPanel.querySelector("[data-map-description]").textContent =
    property.locationPrecision === "exact"
      ? `${property.location}. Confirm the position with the original publisher before visiting.`
      : property.locationPrecision === "unknown"
        ? `${property.location}. The map uses the place name supplied by the publisher; it is not an exact property pin.`
      : `${property.location}. This pin marks the named area, not the house or parcel's exact address.`;
  mapPanel.querySelector("[data-map-results]").href = `/properties?${new URLSearchParams({ purpose: property.purpose, city: property.city, type: property.type, listing: property.id, view: "map" })}`;
  mapPanel.querySelector("[data-map-source]").href = property.sourceUrl;
  const frame = mapPanel.querySelector("[data-map-frame]");
  if (changed || !frame.src) frame.src = googleMapsEmbedURL(property);
  frame.title = `${mapPrecisionLabel(property)} for ${property.title}`;
  if (scroll) {
    mapPanel.querySelector("[data-map-title]").focus({ preventScroll: true });
    mapPanel.scrollIntoView({ behavior: preferredScrollBehavior(), block: "center" });
  }
}

function openProperty(id) {
  const property = state.properties.find((item) => item.id === id);
  if (!property) return;
  state.activePropertyId = id;

  const image = dialog.querySelector("[data-dialog-image]");
  image.src = property.image;
  image.alt = property.imageAlt;
  image.referrerPolicy = "no-referrer";
  image.style.objectPosition = property.imagePosition;
  image.onerror = () => {
    image.onerror = null;
    image.src = fallbackImage;
    image.alt = `Source image unavailable for ${property.title}`;
  };
  dialog.querySelector("[data-dialog-badge]").textContent = `For ${property.purpose === "buy" ? "sale" : "rent"}`;
  dialog.querySelector("[data-dialog-location]").textContent = `${property.location} · ${property.type}`;
  dialog.querySelector("[data-dialog-title]").textContent = property.title;
  dialog.querySelector("[data-dialog-price]").textContent = property.priceLabel;
  dialog.querySelector("[data-dialog-description]").textContent = property.description;
  dialog.querySelector("[data-dialog-source-name]").textContent = property.sourceName;
  const imagePolicy = property.imageLicenseStatus.includes("unconfirmed")
    ? " Source-hosted preview rights are unconfirmed; use the original publisher for authorized photos."
    : property.imageLicenseStatus.includes("owner-permission-attested")
      ? " The project owner reports publisher permission for this private prototype."
    : "";
  dialog.querySelector("[data-dialog-source-copy]").textContent =
    `${formatIndexedAt(property.indexedAt)}. ${property.imageCredit}${imagePolicy}`;
  dialog.querySelector("[data-source-action]").href = property.sourceUrl;
  dialog.querySelector("[data-dialog-map-link]").dataset.propertyId = property.id;
  dialog.querySelector("[data-dialog-map-note]").textContent =
    `${mapPrecisionLabel(property)} — use the original listing to arrange a visit and confirm the address.`;

  const facts = [];
  if (property.beds) facts.push(`${property.beds} bedrooms`);
  if (property.baths) facts.push(`${property.baths} bathrooms`);
  if (property.area) facts.push(property.area);
  if (property.facts.road_access) {
    const unit = String(property.facts.road_access_unit || "").replaceAll("_", " ").toLowerCase();
    facts.push(`${property.facts.road_access} ${unit} road`.replace(/\s+/g, " "));
  }
  if (property.facts.facing) facts.push(`Faces ${String(property.facts.facing).replaceAll("_", " ").toLowerCase()}`);
  if (property.facts.floors) facts.push(`${property.facts.floors} floors`);
  if (property.facts.property_code) facts.push(`Source code ${property.facts.property_code}`);
  dialog.querySelector("[data-dialog-facts]").innerHTML = facts.map((fact) => `<span>${escapeHTML(fact)}</span>`).join("");
  updateDialogSaveButton(property);

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  document.body.classList.add("dialog-open");
}

function updateDialogSaveButton(property) {
  const button = dialog.querySelector("[data-dialog-save]");
  const saved = state.saved.has(property.id);
  button.textContent = saved ? "Saved ✓" : "Save property";
  button.setAttribute("aria-pressed", String(saved));
}

function closeProperty() {
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  document.body.classList.remove("dialog-open");
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function populateLocationOptions() {
  const select = searchForm.elements.location;
  const cities = [...new Set(state.properties.map((property) => property.city).filter(Boolean))].sort();
  select.innerHTML = '<option value="all">Across Nepal</option>' + cities
    .map((city) => `<option value="${escapeHTML(city)}">${escapeHTML(city)}</option>`)
    .join("");
}

function hydrateHero() {
  const property = state.properties.find((item) => item.type === "House" && item.image !== fallbackImage) || state.properties[0];
  if (!property) return;
  const image = document.querySelector("[data-hero-image]");
  image.src = property.image;
  image.alt = property.imageAlt;
  image.referrerPolicy = "no-referrer";
  image.onerror = () => {
    image.onerror = null;
    image.src = fallbackImage;
    image.alt = `Source image unavailable for ${property.title}`;
  };
  const previewPolicy = property.imageLicenseStatus.includes("unconfirmed") ? " · rights unconfirmed" : "";
  const authorizedPolicy = property.imageLicenseStatus.includes("owner-permission-attested")
    ? " · owner-authorized prototype"
    : previewPolicy;
  document.querySelector("[data-hero-source]").textContent =
    `${property.sourceName} · source-hosted preview${authorizedPolicy}`;
  document.querySelector("[data-hero-title]").textContent = property.title;
  if (hasMapPoint(property)) {
    document.querySelector("[data-hero-lat]").textContent = `${property.latitude.toFixed(3)}° N`;
    document.querySelector("[data-hero-lng]").textContent = `${property.longitude.toFixed(3)}° E · area`;
  }
  const button = document.querySelector("[data-hero-open]");
  button.disabled = false;
  button.dataset.propertyId = property.id;
}

async function fetchJSON(url, timeout = 9000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchDatabaseListings() {
  const pageSize = 250;
  const firstPage = await fetchJSON(`/api/listings?limit=${pageSize}&offset=0`);
  if (!Array.isArray(firstPage.items)) return firstPage;
  if (firstPage.mode === "database-snapshot") return firstPage;

  const items = [...firstPage.items];
  const seen = new Set(items.map((item) => String(item.id)));
  const total = Number(firstPage.total);
  let offset = items.length;
  while (Number.isFinite(total) && items.length < total) {
    const nextPage = await fetchJSON(`/api/listings?limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(nextPage.items) || !nextPage.items.length) break;
    offset += nextPage.items.length;
    const unseen = nextPage.items.filter((item) => !seen.has(String(item.id)));
    unseen.forEach((item) => seen.add(String(item.id)));
    if (!unseen.length) break;
    items.push(...unseen);
  }
  return { ...firstPage, items };
}

function showHeroDataState(source, title) {
  const image = document.querySelector("[data-hero-image]");
  image.src = fallbackImage;
  image.alt = "";
  document.querySelector("[data-hero-source]").textContent = source;
  document.querySelector("[data-hero-title]").textContent = title;
  document.querySelector("[data-hero-lat]").textContent = "Area latitude";
  document.querySelector("[data-hero-lng]").textContent = "Area longitude";
  const button = document.querySelector("[data-hero-open]");
  button.disabled = true;
  delete button.dataset.propertyId;
}

function feedIsStale(value, maxHours = 8) {
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || Date.now() - timestamp > maxHours * 3_600_000;
}

async function loadListings() {
  let payload;
  let mode = "live-database";
  try {
    payload = await fetchDatabaseListings();
    mode = payload.mode || mode;
  } catch (apiError) {
    try {
      payload = await fetchJSON("data/listings.json");
      mode = "database-snapshot";
    } catch (snapshotError) {
      console.error("Property data could not be loaded", { apiError, snapshotError });
      state.loading = false;
      state.feedMode = "unavailable";
      feedBadge.textContent = "Database unavailable";
      sourceStatus.textContent = "Source connection unavailable";
      resultSummary.textContent = "Property data could not be loaded";
      emptyState.querySelector("span").textContent = "The listing database is offline.";
      emptyState.querySelector("p").textContent = "Start the FastAPI service or refresh the generated data snapshot.";
      renderProperties();
      resultSummary.textContent = "Property data could not be loaded";
      showHeroDataState("Property feed unavailable", "The database is offline.");
      return;
    }
  }

  if (!Array.isArray(payload.items) || !payload.items.length) {
    state.loading = false;
    feedBadge.textContent = "No indexed listings";
    emptyState.querySelector("span").textContent = "The current index is empty.";
    emptyState.querySelector("p").textContent = "Refresh the source adapter to fetch the latest property window.";
    renderProperties();
    resultSummary.textContent = "The database is connected but currently empty";
    showHeroDataState("No current source records", "The property index is empty.");
    return;
  }

  state.properties = payload.items.map(normaliseProperty);
  state.saved = new Set([...state.saved].filter((id) => state.properties.some((property) => property.id === id)));
  state.feedMode = mode;
  state.asOf = payload.asOf || null;
  state.loading = false;
  persistSaved();
  populateLocationOptions();
  hydrateHero();
  const sourceCount = new Set(state.properties.map((property) => property.sourceName)).size;
  const stale = payload.freshness?.state === "stale" || feedIsStale(state.asOf);
  feedBadge.textContent = stale
    ? mode === "live-database" ? "Database refresh overdue" : "Snapshot · refresh overdue"
    : mode === "live-database" ? "Live database" : "Latest database snapshot";
  const indexedLabel = state.asOf ? formatIndexedAt(state.asOf) : "Index time unavailable";
  const catalog = Array.isArray(payload.sources) ? payload.sources : [];
  const authorizedCount = catalog.filter((source) => ["active", "authorized-pending-adapter"].includes(source.status)).length;
  const pendingCount = catalog.filter((source) => source.status === "authorized-pending-adapter").length;
  const catalogLabel = authorizedCount ? `${sourceCount} of ${authorizedCount}` : String(sourceCount);
  sourceStatus.textContent = `${catalogLabel} owner-authorized ${authorizedCount === 1 ? "source" : "sources"} indexed · ${indexedLabel}${pendingCount ? ` · ${pendingCount} adapters validating` : ""}`;
  renderProperties();
}

document.querySelectorAll("[data-purpose]").forEach((button) => {
  button.addEventListener("click", () => updatePurpose(button.dataset.purpose));
});

document.querySelectorAll("[data-purpose-link]").forEach((link) => {
  link.addEventListener("click", () => {
    updatePurpose(link.dataset.purposeLink);
    closeMenu();
  });
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(searchForm);
  const query = new URLSearchParams({ purpose: state.purpose });
  if (data.get("location") !== "all") query.set("city", data.get("location"));
  if (data.get("type") !== "all") query.set("type", data.get("type"));
  if (data.get("budget") !== "all") query.set("maxPrice", data.get("budget"));
  window.location.href = `/properties?${query}`;
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.cardFilter = button.dataset.filter;
    state.type = "all";
    searchForm.elements.type.value = "all";
    state.savedOnly = false;
    state.visible = 6;
    if (button.dataset.filter === "rent") {
      state.purpose = "rent";
      state.budget = "all";
      syncBudgetOptions();
    }
    document.querySelectorAll("[data-filter]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    renderProperties();
  });
});

sortSelect.addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderProperties();
});

document.querySelectorAll("[data-location]").forEach((button) => {
  button.addEventListener("click", () => {
    window.location.href = `/properties?${new URLSearchParams({ purpose: state.purpose, city: button.dataset.location, view: "map" })}`;
  });
});

grid.addEventListener("click", (event) => {
  const saveButton = event.target.closest("[data-save-property]");
  if (saveButton) {
    toggleSave(saveButton.dataset.saveProperty, { restoreCardFocus: true });
    return;
  }
  const mapButton = event.target.closest("[data-map-property]");
  if (mapButton) {
    const property = state.properties.find((item) => item.id === mapButton.dataset.mapProperty);
    if (property) updateMap(property, { scroll: true });
    return;
  }
  const openButton = event.target.closest("[data-open-property]");
  if (openButton) openProperty(openButton.dataset.openProperty);
});

document.querySelector("[data-hero-open]").addEventListener("click", (event) => {
  if (event.currentTarget.dataset.propertyId) openProperty(event.currentTarget.dataset.propertyId);
});

loadMoreButton.addEventListener("click", () => {
  state.visible += 3;
  renderProperties();
});

document.querySelector("[data-clear-filters]").addEventListener("click", clearFilters);

document.querySelectorAll("[data-open-saved]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.saved.size) {
      showToast("Save a property and it will appear here.");
      return;
    }
    state.savedOnly = true;
    state.location = "all";
    state.type = "all";
    state.budget = "all";
    state.cardFilter = "all";
    state.sort = "featured";
    state.visible = state.saved.size;
    searchForm.elements.location.value = "all";
    searchForm.elements.type.value = "all";
    searchForm.elements.budget.value = "all";
    sortSelect.value = "featured";
    resetFilterChips();
    document.querySelectorAll("[data-purpose]").forEach((purposeButton) => {
      purposeButton.classList.remove("is-active");
      purposeButton.setAttribute("aria-pressed", "false");
    });
    closeMenu();
    renderProperties();
    document.querySelector("#listings").scrollIntoView({ behavior: preferredScrollBehavior() });
  });
});

document.querySelector("[data-dialog-close]").addEventListener("click", closeProperty);
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeProperty();
});
dialog.addEventListener("close", () => document.body.classList.remove("dialog-open"));
dialog.querySelector("[data-dialog-save]").addEventListener("click", () => {
  if (state.activePropertyId) toggleSave(state.activePropertyId);
});

dialog.querySelector("[data-dialog-map-link]").addEventListener("click", (event) => {
  const property = state.properties.find((item) => item.id === event.currentTarget.dataset.propertyId);
  if (!property) return;
  closeProperty();
  updateMap(property, { scroll: true });
});

document.querySelector("[data-interest-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  event.currentTarget.reset();
  showToast("Thanks—this pilot does not send or store your email.");
});

document.querySelectorAll("[data-info-action]").forEach((button) => {
  button.addEventListener("click", () => showToast(`${button.dataset.infoAction} details are being prepared.`));
});

document.querySelectorAll("[data-accordion] .process-item > button").forEach((button) => {
  button.addEventListener("click", () => {
    const item = button.closest(".process-item");
    const wasOpen = item.classList.contains("is-open");
    document.querySelectorAll("[data-accordion] .process-item").forEach((other) => {
      other.classList.remove("is-open");
      other.querySelector("button").setAttribute("aria-expanded", "false");
      other.querySelector("button i").textContent = "+";
      const answer = other.querySelector(".process-answer");
      answer.setAttribute("aria-hidden", "true");
      answer.inert = true;
    });
    if (!wasOpen) {
      item.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      button.querySelector("i").textContent = "−";
      const answer = item.querySelector(".process-answer");
      answer.setAttribute("aria-hidden", "false");
      answer.inert = false;
    }
  });
});

const menuButton = document.querySelector("[data-menu-button]");
const mobileMenu = document.querySelector("[data-mobile-menu]");
const menuBackgroundNodes = document.querySelectorAll(
  "main, .site-footer, .site-header > .brand, .site-header > .desktop-nav, .site-header .saved-button",
);

function setMenuBackgroundInert(inert) {
  menuBackgroundNodes.forEach((node) => { node.inert = inert; });
}

function closeMenu({ restoreFocus = false } = {}) {
  mobileMenu.classList.remove("is-open");
  mobileMenu.setAttribute("aria-hidden", "true");
  mobileMenu.inert = true;
  setMenuBackgroundInert(false);
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.setAttribute("aria-label", "Open menu");
  document.body.classList.remove("menu-open");
  if (restoreFocus) menuButton.focus();
}

menuButton.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") === "true";
  if (open) closeMenu();
  else {
    mobileMenu.classList.add("is-open");
    mobileMenu.setAttribute("aria-hidden", "false");
    mobileMenu.inert = false;
    setMenuBackgroundInert(true);
    menuButton.setAttribute("aria-expanded", "true");
    menuButton.setAttribute("aria-label", "Close menu");
    document.body.classList.add("menu-open");
    mobileMenu.querySelector("a, button").focus();
  }
});

mobileMenu.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
window.addEventListener("resize", () => {
  if (window.innerWidth > 820) closeMenu();
});

window.addEventListener(
  "scroll",
  () => document.querySelector("[data-header]").classList.toggle("is-scrolled", window.scrollY > 20),
  { passive: true },
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mobileMenu.classList.contains("is-open")) closeMenu({ restoreFocus: true });
  if (event.key === "Tab" && mobileMenu.classList.contains("is-open")) {
    const focusable = [menuButton, ...mobileMenu.querySelectorAll("a, button")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

const revealNodes = document.querySelectorAll("[data-reveal]");
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -4%" },
  );
  revealNodes.forEach((node) => {
    node.classList.add("reveal-ready");
    revealObserver.observe(node);
  });
} else revealNodes.forEach((node) => node.classList.add("is-visible"));

const heroVisual = document.querySelector("[data-hero-visual]");
if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  heroVisual.addEventListener("pointermove", (event) => {
    const bounds = heroVisual.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    heroVisual.querySelector(".hero-image-wrap").style.transform = `translate(${x * 5}px, ${y * 5}px)`;
  });
  heroVisual.addEventListener("pointerleave", () => {
    heroVisual.querySelector(".hero-image-wrap").style.transform = "translate(0, 0)";
  });
}

document.querySelector("[data-year]").textContent = String(new Date().getFullYear());
renderLoading();
loadListings();
