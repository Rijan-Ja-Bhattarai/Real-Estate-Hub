const propertyImages = {
  contemporary: "assets/images/hero-residence.webp",
  apartment: "assets/images/lazimpat-courtyard.webp",
  hillside: "assets/images/budhanilkantha-home.webp",
};

const sampleProperties = [
  {
    id: "p1",
    title: "Garden residence in Budhanilkantha",
    location: "Budhanilkantha · Kathmandu",
    city: "Kathmandu",
    type: "House",
    purpose: "buy",
    price: 68000000,
    priceLabel: "रु 6.8 Cr",
    beds: 5,
    baths: 4,
    area: "8.2 aana",
    updatedHours: 1,
    image: propertyImages.contemporary,
    imagePosition: "58% center",
    description:
      "A light-filled family residence with planted terraces, warm timber screens and generous indoor-outdoor living at the edge of the valley.",
  },
  {
    id: "p2",
    title: "Quiet courtyard apartment",
    location: "Lazimpat · Kathmandu",
    city: "Kathmandu",
    type: "Apartment",
    purpose: "buy",
    price: 21500000,
    priceLabel: "रु 2.15 Cr",
    beds: 3,
    baths: 2,
    area: "1,425 sq ft",
    updatedHours: 2,
    image: propertyImages.apartment,
    imagePosition: "65% center",
    description:
      "A calm three-bedroom home arranged around a landscaped shared court, within easy reach of central Kathmandu.",
  },
  {
    id: "p3",
    title: "Brick home above the valley",
    location: "Tokha · Kathmandu",
    city: "Kathmandu",
    type: "House",
    purpose: "buy",
    price: 38500000,
    priceLabel: "रु 3.85 Cr",
    beds: 4,
    baths: 3,
    area: "6.5 aana",
    updatedHours: 3,
    image: propertyImages.hillside,
    imagePosition: "center",
    description:
      "Local brick, deep verandas and a garden facing the foothills give this four-bedroom home a quiet sense of place.",
  },
  {
    id: "p4",
    title: "Sunlit duplex near Sanepa",
    location: "Sanepa · Lalitpur",
    city: "Lalitpur",
    type: "Apartment",
    purpose: "buy",
    price: 34000000,
    priceLabel: "रु 3.4 Cr",
    beds: 4,
    baths: 3,
    area: "2,180 sq ft",
    updatedHours: 5,
    image: propertyImages.apartment,
    imagePosition: "35% center",
    description:
      "An expansive two-level apartment with a private terrace, cross ventilation and a restrained material palette.",
  },
  {
    id: "p5",
    title: "Family villa in Bhaisepati",
    location: "Bhaisepati · Lalitpur",
    city: "Lalitpur",
    type: "House",
    purpose: "buy",
    price: 49000000,
    priceLabel: "रु 4.9 Cr",
    beds: 5,
    baths: 4,
    area: "7 aana",
    updatedHours: 7,
    image: propertyImages.contemporary,
    imagePosition: "70% center",
    description:
      "A generous contemporary villa with five bedrooms, a planted roof terrace and a private south-facing garden.",
  },
  {
    id: "p6",
    title: "Ground-floor studio with garden",
    location: "Jhamsikhel · Lalitpur",
    city: "Lalitpur",
    type: "Apartment",
    purpose: "rent",
    price: 85000,
    priceLabel: "रु 85K / mo",
    beds: 1,
    baths: 1,
    area: "720 sq ft",
    updatedHours: 4,
    image: propertyImages.hillside,
    imagePosition: "30% center",
    description:
      "A furnished garden-level studio with a separate work nook and quiet outdoor space in walkable Jhamsikhel.",
  },
  {
    id: "p7",
    title: "Corner plot near Ring Road",
    location: "Hemja · Pokhara",
    city: "Pokhara",
    type: "Land",
    purpose: "buy",
    price: 29500000,
    priceLabel: "रु 2.95 Cr",
    beds: null,
    baths: null,
    area: "10 aana",
    updatedHours: 9,
    image: propertyImages.hillside,
    imagePosition: "75% center",
    description:
      "A road-access corner parcel in an established residential pocket, presented here as sample data for the land-search experience.",
  },
  {
    id: "p8",
    title: "Lakeside two-bedroom retreat",
    location: "Lakeside · Pokhara",
    city: "Pokhara",
    type: "Apartment",
    purpose: "rent",
    price: 65000,
    priceLabel: "रु 65K / mo",
    beds: 2,
    baths: 2,
    area: "1,080 sq ft",
    updatedHours: 10,
    image: propertyImages.apartment,
    imagePosition: "20% center",
    description:
      "A bright two-bedroom apartment with a long balcony and calm garden outlook, a short walk from the lakefront.",
  },
  {
    id: "p9",
    title: "Flexible street-facing workspace",
    location: "Narayangarh · Chitwan",
    city: "Chitwan",
    type: "Commercial",
    purpose: "rent",
    price: 120000,
    priceLabel: "रु 1.2L / mo",
    beds: null,
    baths: 2,
    area: "1,950 sq ft",
    updatedHours: 13,
    image: propertyImages.contemporary,
    imagePosition: "18% center",
    description:
      "A flexible ground-floor commercial space with broad frontage, a service entrance and room for a growing local team.",
  },
];

const state = {
  properties: sampleProperties,
  purpose: "buy",
  location: "all",
  type: "all",
  budget: "all",
  cardFilter: "all",
  sort: "featured",
  visible: 6,
  savedOnly: false,
  activePropertyId: null,
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
let toastTimer;

function readSaved() {
  try {
    const parsed = JSON.parse(localStorage.getItem("nei-saved") || "[]");
    if (!Array.isArray(parsed)) return new Set();
    const knownIds = new Set(sampleProperties.map((property) => property.id));
    return new Set(parsed.filter((id) => typeof id === "string" && knownIds.has(id)));
  } catch {
    return new Set();
  }
}

function persistSaved() {
  try {
    localStorage.setItem("nei-saved", JSON.stringify([...state.saved]));
  } catch {
    // The experience still works if storage is unavailable.
  }
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function filteredProperties() {
  let results = state.properties.filter((property) => {
    const purposeMatch = state.savedOnly || property.purpose === state.purpose;
    const locationMatch = state.location === "all" || property.city === state.location;
    const typeMatch = state.type === "all" || property.type === state.type;
    const budgetMatch = state.budget === "all" || property.price <= Number(state.budget);
    const cardMatch =
      state.cardFilter === "all" ||
      property.type === state.cardFilter ||
      property.purpose === state.cardFilter;
    const savedMatch = !state.savedOnly || state.saved.has(property.id);
    return purposeMatch && locationMatch && typeMatch && budgetMatch && cardMatch && savedMatch;
  });

  if (state.sort === "newest") {
    results.sort((a, b) => a.updatedHours - b.updatedHours);
  } else if (state.sort === "price-low") {
    results.sort((a, b) => a.price - b.price);
  } else if (state.sort === "price-high") {
    results.sort((a, b) => b.price - a.price);
  }

  return results;
}

function factsLabel(property) {
  const facts = [];
  if (property.beds) facts.push(`${property.beds} bed`);
  if (property.baths) facts.push(`${property.baths} bath`);
  facts.push(property.area);
  return facts.join(" · ");
}

function propertyCard(property, index) {
  const saved = state.saved.has(property.id);
  return `
    <article class="property-card" style="animation-delay:${Math.min(index * 70, 350)}ms">
      <div class="property-image">
        <img src="${escapeHTML(property.image)}" alt="" loading="lazy" style="object-position:${escapeHTML(property.imagePosition)}" />
        <span class="property-badge">For ${property.purpose === "buy" ? "sale" : "rent"} · ${escapeHTML(property.type)}</span>
        <button class="property-save ${saved ? "is-saved" : ""}" type="button" data-save-property="${escapeHTML(property.id)}" aria-label="${
          saved ? "Remove" : "Save"
        } ${escapeHTML(property.title)}" aria-pressed="${saved}">${saved ? "♥" : "♡"}</button>
      </div>
      <div class="property-body">
        <p class="property-location">${escapeHTML(property.location)} · sample timestamp ${property.updatedHours}h</p>
        <h3>
          <button class="property-open" type="button" data-open-property="${escapeHTML(property.id)}">
            ${escapeHTML(property.title)}
          </button>
        </h3>
        <div class="property-price-row">
          <p class="property-price">${escapeHTML(property.priceLabel)}</p>
          <p class="property-facts">${escapeHTML(factsLabel(property))}</p>
        </div>
      </div>
    </article>`;
}

function renderProperties() {
  if (!state.savedOnly) syncPurposeButtons();
  const filtered = filteredProperties();
  const visible = filtered.slice(0, state.visible);
  grid.innerHTML = visible.map(propertyCard).join("");
  emptyState.hidden = filtered.length !== 0;
  loadMoreButton.hidden = filtered.length <= state.visible;

  const purposeLabel = state.savedOnly ? "across all purposes" : state.purpose === "buy" ? "for sale" : "for rent";
  const feedLabel = state.savedOnly ? "saved" : "sample";
  resultSummary.textContent = `${filtered.length} ${feedLabel} ${filtered.length === 1 ? "property" : "properties"} ${purposeLabel}`;
  sortSelect.disabled = state.savedOnly;
  updateSavedCount();
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

function updatePurpose(nextPurpose) {
  state.purpose = nextPurpose;
  state.cardFilter = "all";
  state.savedOnly = false;
  state.visible = 6;
  syncPurposeButtons();
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

function openProperty(id) {
  const property = state.properties.find((item) => item.id === id);
  if (!property) return;
  state.activePropertyId = id;

  const image = dialog.querySelector("[data-dialog-image]");
  image.src = property.image;
  image.alt = property.title;
  image.style.objectPosition = property.imagePosition;
  dialog.querySelector("[data-dialog-badge]").textContent = `For ${property.purpose === "buy" ? "sale" : "rent"}`;
  dialog.querySelector("[data-dialog-location]").textContent = `${property.location} · ${property.type}`;
  dialog.querySelector("[data-dialog-title]").textContent = property.title;
  dialog.querySelector("[data-dialog-price]").textContent = property.priceLabel;
  dialog.querySelector("[data-dialog-description]").textContent = property.description;

  const facts = [];
  if (property.beds) facts.push(`${property.beds} bedrooms`);
  if (property.baths) facts.push(`${property.baths} bathrooms`);
  facts.push(property.area);
  dialog.querySelector("[data-dialog-facts]").innerHTML = facts
    .map((fact) => `<span>${escapeHTML(fact)}</span>`)
    .join("");
  updateDialogSaveButton(property);

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
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
  state.location = data.get("location");
  state.type = data.get("type");
  state.budget = data.get("budget");
  state.cardFilter = "all";
  state.savedOnly = false;
  state.visible = 6;
  resetFilterChips();
  renderProperties();
  document.querySelector("#listings").scrollIntoView({ behavior: "smooth" });
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
    state.location = button.dataset.location;
    state.type = "all";
    state.budget = "all";
    state.cardFilter = "all";
    state.savedOnly = false;
    state.visible = 6;
    searchForm.elements.location.value = state.location;
    searchForm.elements.type.value = "all";
    searchForm.elements.budget.value = "all";
    resetFilterChips();
    renderProperties();
    document.querySelector("#listings").scrollIntoView({ behavior: "smooth" });
  });
});

grid.addEventListener("click", (event) => {
  const saveButton = event.target.closest("[data-save-property]");
  if (saveButton) {
    toggleSave(saveButton.dataset.saveProperty, { restoreCardFocus: true });
    return;
  }
  const openButton = event.target.closest("[data-open-property]");
  if (openButton) openProperty(openButton.dataset.openProperty);
});

document.querySelectorAll("[data-open-property]").forEach((button) => {
  if (!button.closest("[data-property-grid]")) {
    button.addEventListener("click", () => openProperty(button.dataset.openProperty));
  }
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
    document.querySelector("#listings").scrollIntoView({ behavior: "smooth" });
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
dialog.querySelector("[data-source-action]").addEventListener("click", () => {
  showToast("This is sample data. The original-source handoff arrives with the listing API.");
});

document.querySelector("[data-interest-form]").addEventListener("submit", (event) => {
  event.preventDefault();
  event.currentTarget.reset();
  showToast("Thanks—this prototype does not send or store your email.");
});

document.querySelectorAll("[data-info-action]").forEach((button) => {
  button.addEventListener("click", () => showToast(`${button.dataset.infoAction} content is planned for the next phase.`));
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

function closeMenu({ restoreFocus = false } = {}) {
  mobileMenu.classList.remove("is-open");
  mobileMenu.setAttribute("aria-hidden", "true");
  mobileMenu.inert = true;
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.setAttribute("aria-label", "Open menu");
  document.body.classList.remove("menu-open");
  if (restoreFocus) menuButton.focus();
}

menuButton.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") === "true";
  if (open) {
    closeMenu();
  } else {
    mobileMenu.classList.add("is-open");
    mobileMenu.setAttribute("aria-hidden", "false");
    mobileMenu.inert = false;
    menuButton.setAttribute("aria-expanded", "true");
    menuButton.setAttribute("aria-label", "Close menu");
    document.body.classList.add("menu-open");
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
} else {
  revealNodes.forEach((node) => node.classList.add("is-visible"));
}

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
renderProperties();
