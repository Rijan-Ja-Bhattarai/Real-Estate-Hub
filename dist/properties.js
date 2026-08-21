const fallbackImage = "/assets/images/property-image-unavailable.svg";
const areaFactors = { aana: 342.25, ropani: 5476, paisa: 85.5625, daam: 21.390625, kattha: 3645, dhur: 182.25, bigha: 72900, sqft: 1 };
const cityCentroids = { Kathmandu: [27.7172, 85.324], Lalitpur: [27.6588, 85.3247], Bhaktapur: [27.671, 85.4298], Pokhara: [28.2096, 83.9856], Chitwan: [27.5291, 84.3542], Biratnagar: [26.4525, 87.2718], Itahari: [26.6631, 87.274], Tanahun: [27.9447, 84.2279], Kaski: [28.2096, 83.9856], Nepal: [28.3949, 84.124] };
const params = new URLSearchParams(window.location.search);
const state = {
  properties: [], purpose: params.get("purpose") === "rent" ? "rent" : "buy", city: params.get("city") || "all",
  type: params.get("type") || "all", query: params.get("query") || "", maxPrice: params.get("maxPrice") || "",
  beds: params.get("beds") || "all", minArea: params.get("minArea") || "", areaUnit: params.get("areaUnit") || "aana",
  sort: params.get("sort") || "newest", selectedId: params.get("listing"), savedOnly: false, saved: readSaved(),
};
const form = document.querySelector("[data-browse-filters]");
const list = document.querySelector("[data-browse-list]");
const empty = document.querySelector("[data-browse-empty]");
const resultCount = document.querySelector("[data-result-count]");
const mapFrame = document.querySelector("[data-map-frame]");
const detail = document.querySelector("[data-selected-detail]");

function readSaved() { try { const value = JSON.parse(localStorage.getItem("nei-saved") || "[]"); return new Set(Array.isArray(value) ? value : []); } catch { return new Set(); } }
function saveSaved() { try { localStorage.setItem("nei-saved", JSON.stringify([...state.saved])); } catch {} }
function escapeHTML(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function safeURL(value, fallback = "#") { if (typeof value !== "string" || !value.trim()) return fallback; try { const url = new URL(value, window.location.href); return ["http:", "https:"].includes(url.protocol) ? url.href : fallback; } catch { return fallback; } }
function normalise(item) {
  const price = Number(item.price); const latitude = Number(item.latitude); const longitude = Number(item.longitude);
  return { ...item, id: String(item.id || ""), title: String(item.title || "Untitled property"), purpose: item.purpose === "rent" ? "rent" : "buy",
    city: String(item.city || "Nepal"), locality: String(item.locality || ""), location: String(item.location || item.city || "Nepal"), type: String(item.type || "Property"),
    price: Number.isFinite(price) ? price : null, priceBasis: String(item.priceBasis || (item.purpose === "rent" ? "monthly" : "total")), priceLabel: String(item.priceLabel || "Price on request"),
    beds: item.beds == null ? null : Number(item.beds), baths: item.baths == null ? null : Number(item.baths), area: String(item.area || "Area on source"),
    image: safeURL(item.image, fallbackImage), sourceUrl: safeURL(item.sourceUrl), sourceName: String(item.sourceName || "Original publisher"),
    description: String(item.description || "Open the original listing for all publisher-supplied details."), facts: item.facts && typeof item.facts === "object" ? item.facts : {},
    latitude: Number.isFinite(latitude) ? latitude : null, longitude: Number.isFinite(longitude) ? longitude : null, locationPrecision: String(item.locationPrecision || "city"), indexedAt: String(item.indexedAt || "") };
}

function areaSqft(value) {
  const text = String(value || "").toLowerCase().replaceAll(",", " ");
  const compact = text.match(/\b(\d+)\s*-\s*(\d+)\s*-\s*(\d+)\s*-\s*(\d+)\b/);
  if (compact) return Number(compact[1]) * areaFactors.ropani + Number(compact[2]) * areaFactors.aana + Number(compact[3]) * areaFactors.paisa + Number(compact[4]) * areaFactors.daam;
  let total = 0; let matched = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(ropani|aana|anna|ana|paisa|daam|kattha|dhur|bigha|sq\.?\s*ft|square feet|square foot)/g)) {
    const key = match[2].replaceAll(".", "").replace(/\s+/g, " ");
    const unit = key === "anna" || key === "ana" ? "aana" : key.startsWith("sq") || key.startsWith("square") ? "sqft" : key;
    total += Number(match[1]) * areaFactors[unit]; matched = true;
  }
  return matched ? total : null;
}

function selectedMinimumArea() { const amount = Number(state.minArea); return Number.isFinite(amount) && amount > 0 ? amount * (areaFactors[state.areaUnit] || 1) : null; }
function filtered() {
  const query = state.query.trim().toLowerCase(); const minimumArea = selectedMinimumArea(); const maxPrice = Number(state.maxPrice);
  const items = state.properties.filter((item) => {
    if (item.purpose !== state.purpose) return false;
    if (state.city !== "all" && item.city !== state.city) return false;
    if (state.type !== "all" && item.type !== state.type) return false;
    if (state.beds !== "all" && (item.beds === null || item.beds < Number(state.beds))) return false;
    if (maxPrice > 0 && (item.price === null || !["total", "monthly"].includes(item.priceBasis) || item.price > maxPrice)) return false;
    if (minimumArea && (areaSqft(item.area) === null || areaSqft(item.area) < minimumArea)) return false;
    if (state.savedOnly && !state.saved.has(item.id)) return false;
    return !query || `${item.title} ${item.location} ${item.locality} ${item.city} ${item.type} ${item.sourceName}`.toLowerCase().includes(query);
  });
  return items.sort((a, b) => {
    if (state.sort === "price-low" || state.sort === "price-high") { if (a.price === null || b.price === null) return a.price === null ? 1 : -1; return (a.price - b.price) * (state.sort === "price-low" ? 1 : -1); }
    if (state.sort === "area-high") return (areaSqft(b.area) || -1) - (areaSqft(a.area) || -1);
    return new Date(b.indexedAt || 0) - new Date(a.indexedAt || 0);
  });
}

function fact(item, ...keys) { for (const key of keys) { const value = String(item.facts[key] || "").trim(); if (value) return value; } return ""; }
function roadAccess(item) { const value = fact(item, "road_access", "road_and_area"); const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(ft|feet|feets|foot|m|meter|meters|metre|metres)\b/gi)]; if (!matches.length) return value; const last = matches.at(-1); return `${last[1]} ${/^(ft|feet|feets|foot)$/i.test(last[2]) ? "ft" : "m"}`; }
function card(item) {
  const selected = item.id === state.selectedId; const facts = [item.area, item.beds !== null ? `${item.beds} bed` : "", item.baths !== null ? `${item.baths} bath` : "", roadAccess(item) ? `Road ${roadAccess(item)}` : ""].filter(Boolean);
  return `<article class="browse-card${selected ? " is-selected" : ""}" data-card-id="${escapeHTML(item.id)}">
    <div class="browse-card-image"><img src="${escapeHTML(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-listing-image /><span>${item.purpose === "buy" ? "For sale" : "For rent"}</span></div>
    <div class="browse-card-body"><p class="browse-card-kicker">${escapeHTML(item.location)} · ${escapeHTML(item.type)}</p><h3>${escapeHTML(item.title)}</h3><p class="browse-card-price">${escapeHTML(item.priceLabel)}</p>
      <div class="browse-card-facts">${facts.map((value) => `<span>${escapeHTML(value)}</span>`).join("")}</div>
      <div class="browse-card-actions"><button type="button" data-focus="${escapeHTML(item.id)}">View details</button><button type="button" data-map="${escapeHTML(item.id)}">Show on map</button><button class="browse-save" type="button" data-save="${escapeHTML(item.id)}">${state.saved.has(item.id) ? "Saved" : "Save"}</button></div>
    </div></article>`;
}

function mapPoint(item) { return item.latitude !== null && item.longitude !== null ? [item.latitude, item.longitude] : cityCentroids[item.city] || cityCentroids.Nepal; }
function mapURL(item) {
  const [lat, lng] = mapPoint(item); const span = item.locationPrecision === "exact" ? .012 : item.latitude === null ? .35 : .04;
  const bbox = [lng - span, lat - span, lng + span, lat + span].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lng}`)}`;
}
function renderSelected(item, { scroll = false } = {}) {
  if (!item) { detail.hidden = true; return; }
  state.selectedId = item.id;
  document.querySelector("[data-map-title]").textContent = item.title;
  document.querySelector("[data-map-precision]").textContent = item.locationPrecision === "exact" ? "Source-supplied coordinates" : `Approximate ${item.locationPrecision || "locality"} pin`;
  document.querySelector("[data-map-note]").textContent = `${item.location}. This map marks the source-named area and updates inside Nepal Estate Index.`;
  mapFrame.src = mapURL(item); mapFrame.title = `Locality map for ${item.title}`;
  const road = roadAccess(item);
  detail.hidden = false; detail.innerHTML = `<img src="${escapeHTML(item.image)}" alt="" referrerpolicy="no-referrer" data-listing-image /><div class="browse-detail-copy"><span>Selected · ${escapeHTML(item.type)}</span><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.area)}${road ? ` · Road ${escapeHTML(road)}` : ""} · ${escapeHTML(item.priceLabel)}</p><div class="browse-detail-actions"><a href="${escapeHTML(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Continue with ${escapeHTML(item.sourceName)} ↗</a><small>Verify availability and title details</small></div></div>`;
  addImageFallbacks(detail);
  document.querySelectorAll("[data-card-id]").forEach((node) => node.classList.toggle("is-selected", node.dataset.cardId === item.id));
  updateURL();
  if (scroll) document.querySelector(".browse-map-card").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
}

function render() {
  const items = filtered(); list.setAttribute("aria-busy", "false"); list.innerHTML = items.map(card).join(""); list.hidden = !items.length; empty.hidden = Boolean(items.length);
  resultCount.textContent = `${items.length} ${items.length === 1 ? "property" : "properties"} · ${state.savedOnly ? "saved" : state.purpose === "buy" ? "for sale" : "for rent"}`;
  addImageFallbacks(list);
  let selected = state.properties.find((item) => item.id === state.selectedId);
  if (!selected || !items.some((item) => item.id === selected.id)) selected = items[0];
  if (selected) renderSelected(selected); else detail.hidden = true;
  syncSavedCount(); updateURL();
}

function addImageFallbacks(root) { root.querySelectorAll("[data-listing-image]").forEach((image) => image.addEventListener("error", () => { image.src = fallbackImage; }, { once: true })); }
function syncSavedCount() { document.querySelectorAll("[data-saved-count]").forEach((node) => { node.textContent = state.saved.size; }); }
function syncPurpose() {
  document.querySelectorAll("[data-purpose]").forEach((button) => { const active = button.dataset.purpose === state.purpose; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); });
  document.querySelectorAll("[data-nav-purpose]").forEach((link) => { if (link.dataset.navPurpose === state.purpose) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
  document.querySelector("[data-browse-title]").innerHTML = state.purpose === "buy" ? "Homes and land<br><em>for sale.</em>" : "A place that fits<br><em>your next chapter.</em>";
  document.querySelector("[data-browse-intro]").textContent = state.purpose === "buy" ? "Shape the search around your budget, preferred area, property type, and space needs." : "Compare monthly asks, locations, room counts, and property types in one focused rental search.";
  document.querySelector("[data-max-price-label]").textContent = state.purpose === "buy" ? "Maximum total ask" : "Maximum monthly rent";
}
function syncForm() { for (const name of ["city", "type", "query", "maxPrice", "beds", "minArea", "areaUnit", "sort"]) if (form.elements[name]) form.elements[name].value = state[name]; syncPurpose(); }
function updateURL() {
  const next = new URLSearchParams({ purpose: state.purpose });
  for (const key of ["city", "type", "query", "maxPrice", "beds", "minArea", "areaUnit", "sort"]) if (state[key] && !["all", "newest", "aana"].includes(state[key])) next.set(key, state[key]);
  if (state.selectedId) next.set("listing", state.selectedId); if (params.get("assistant") === "1") next.set("assistant", "1"); if (params.get("view") === "map") next.set("view", "map");
  history.replaceState(null, "", `/properties?${next}`);
}
function clearFilters() { Object.assign(state, { city: "all", type: "all", query: "", maxPrice: "", beds: "all", minArea: "", areaUnit: "aana", sort: "newest", savedOnly: false, selectedId: null }); syncForm(); render(); }

async function fetchListings() {
  for (const url of ["/api/listings?limit=250", "/data/listings.json"]) { try { const response = await fetch(url, { headers: { Accept: "application/json" } }); if (response.ok) return await response.json(); } catch {} }
  throw new Error("Listing index unavailable");
}
function populateOptions() {
  const cities = [...new Set(state.properties.map((item) => item.city))].sort(); const types = [...new Set(state.properties.map((item) => item.type))].sort();
  form.elements.city.innerHTML = '<option value="all">Anywhere in Nepal</option>' + cities.map((value) => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join("");
  form.elements.type.innerHTML = '<option value="all">Any type</option>' + types.map((value) => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join("");
}

document.querySelectorAll("[data-purpose]").forEach((button) => button.addEventListener("click", () => { state.purpose = button.dataset.purpose; state.maxPrice = ""; state.savedOnly = false; state.selectedId = null; syncForm(); render(); }));
form.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(form); for (const key of ["city", "type", "query", "maxPrice", "beds", "minArea", "areaUnit", "sort"]) state[key] = String(data.get(key) || ""); state.savedOnly = false; state.selectedId = null; render(); });
document.querySelectorAll("[data-clear-browse]").forEach((button) => button.addEventListener("click", clearFilters));
list.addEventListener("click", (event) => {
  const save = event.target.closest("[data-save]"); if (save) { state.saved.has(save.dataset.save) ? state.saved.delete(save.dataset.save) : state.saved.add(save.dataset.save); saveSaved(); render(); return; }
  const target = event.target.closest("[data-focus], [data-map]"); if (!target) return; const id = target.dataset.focus || target.dataset.map; const item = state.properties.find((property) => property.id === id); if (item) renderSelected(item, { scroll: Boolean(target.dataset.map) });
});
document.querySelector("[data-browse-saved]").addEventListener("click", () => { state.savedOnly = !state.savedOnly; state.selectedId = null; render(); });
document.querySelector("[data-dismiss-arrival]").addEventListener("click", () => { document.querySelector("[data-assistant-arrival]").hidden = true; });
document.querySelector("[data-year]").textContent = new Date().getFullYear();

(async () => {
  try {
    const payload = await fetchListings(); state.properties = (payload.items || []).map(normalise).filter((item) => item.id); populateOptions(); syncForm();
    if (params.get("assistant") === "1" && state.selectedId) { const item = state.properties.find((property) => property.id === state.selectedId); if (item) { document.querySelector("[data-assistant-arrival-title]").textContent = `${item.title} is ready to review`; document.querySelector("[data-assistant-arrival]").hidden = false; } }
    render();
  } catch (error) { list.innerHTML = ""; list.hidden = true; empty.hidden = false; empty.querySelector("strong").textContent = "The property index is unavailable."; resultCount.textContent = "Unable to load"; console.error(error); }
})();
