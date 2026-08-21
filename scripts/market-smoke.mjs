import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const siteUrl = process.env.SITE_URL || "http://127.0.0.1:4173/";
const marketUrl = new URL("/market", siteUrl).href;
const captureMarket = process.argv.includes("--capture");
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const debugPort = 9600 + (process.pid % 300);
const profileDir = mkdtempSync(join(tmpdir(), "nei-market-smoke-"));
const browser = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page");
      if (target) return target;
    } catch {
      // Chrome may need a moment to expose the debugging endpoint.
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not become available.");
}

function connect(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("Unable to connect to Chrome DevTools.")), {
      once: true,
    });
  });
}

const failures = [];
const runtimeErrors = [];
let socket;
let messageId = 0;
const pending = new Map();

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Evaluation failed.");
  }
  return response.result.value;
}

async function waitForInventory() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await evaluate(`({
      document: document.readyState,
      busy: document.querySelector('[data-inventory-list]')?.getAttribute('aria-busy'),
      rows: document.querySelectorAll('.inventory-row').length,
      comparisons: document.querySelectorAll('.comparison-card').length
    })`);
    if (["interactive", "complete"].includes(ready.document) && ready.busy === "false" && ready.rows > 0 && ready.comparisons === 0) return;
    await delay(100);
  }
  throw new Error("The market inventory did not finish loading with its initial comparison set.");
}

async function waitForHistoryState(expected = "settled") {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await evaluate(`({
      eyebrow: document.querySelector('[data-analysis-eyebrow]')?.textContent.trim(),
      status: document.querySelector('[data-history-status]')?.textContent.trim()
    })`);
    if (expected === "observed" && state.eyebrow === "OBSERVED ASK HISTORY") return;
    if (expected === "settled" && state.status && !state.status.startsWith("Checking")) return;
    await delay(100);
  }
  throw new Error(`The market history state did not become ${expected}.`);
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

try {
  const target = await getTarget();
  socket = await connect(target.webSocketDebuggerUrl);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") {
      runtimeErrors.push(`Runtime exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      const text = message.params.args.map((argument) => argument.value || argument.description || "unknown error").join(" ");
      runtimeErrors.push(`Console error: ${text}`);
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      const entry = message.params.entry;
      if (entry.url?.includes("/api/listings?") && entry.text.includes("404")) return;
      if (entry.url?.includes("/api/market/series?") && entry.text.includes("404")) return;
      runtimeErrors.push(`Browser error: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
    }
  });

  await command("Page.enable");
  await command("Runtime.enable");
  await command("Log.enable");
  const collectingHistoryScript = await command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const href = typeof input === 'string' ? input : input.url;
        const url = new URL(href, location.origin);
        if (url.pathname !== '/api/market/series') return nativeFetch(input, options);
        return Promise.resolve(new Response(JSON.stringify({
          items: [],
          status: 'collecting',
          readiness: {
            ready: false,
            historyWindowDays: 1,
            qualifyingDays: 1,
            minimumWindowDays: 30,
            minimumObservedDays: 14,
            minimumDailySample: 8
          },
          asOf: null
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      };
    })();`,
  });
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await command("Page.navigate", { url: marketUrl });
  await waitForInventory();

  const initial = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.inventory-row')];
    const comparisonCards = [...document.querySelectorAll('.comparison-card')];
    return {
      path: location.pathname,
      title: document.title,
      sharedHeader: Boolean(document.querySelector('.site-header .brand-name')),
      homeRoute: document.querySelector('.desktop-nav a')?.getAttribute('href'),
      navLabels: [...document.querySelectorAll('.desktop-nav a')].map((link) => link.textContent.trim()),
      typographyConsistent: ['.market-masthead h1', '.ticker-item strong', '.scenario-signal strong', '.inventory-panel']
        .every((selector) => getComputedStyle(document.querySelector(selector)).fontFamily === getComputedStyle(document.documentElement).fontFamily),
      purpose: document.querySelector('[data-purpose="buy"]').getAttribute('aria-pressed'),
      type: document.querySelector('[data-type]').value,
      rows: rows.length,
      houseRows: rows.every((row) => row.querySelector('.inventory-identity small').textContent.includes('House · sale')),
      comparisons: comparisonCards.length,
      uniqueComparisons: new Set(comparisonCards.map((card) => card.dataset.comparisonId)).size,
      compareCount: document.querySelector('[data-compare-count]').textContent.trim(),
      comparisonStatus: document.querySelector('[data-comparison-status]').textContent.trim(),
      selectedRows: document.querySelectorAll('[data-toggle-compare][aria-pressed="true"]').length,
      analyticsHidden: document.querySelector('[data-analytics-rail]').hidden,
      feedState: document.querySelector('[data-feed-state]').textContent.trim(),
      analysisEyebrow: document.querySelector('[data-analysis-eyebrow]').textContent.trim(),
      historyStatus: document.querySelector('[data-history-status]').textContent.trim(),
      propertyTypes: [...document.querySelector('[data-type]').options].map((option) => option.value),
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth + 2,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
    };
  })()`);
  assert(initial.path === "/market" || initial.path === "/market/", `Expected /market, loaded ${initial.path}.`);
  assert(initial.title.includes("Market Board"), "Market page title is missing.");
  assert(initial.sharedHeader, "Market is not using the shared site header.");
  assert(initial.homeRoute === "/", "Market navigation is missing the Home route.");
  assert(initial.navLabels.join("|") === "Home|Buy|Rent|Locations|Market", "Market navigation differs from the main site.");
  assert(initial.typographyConsistent, "Market contains a font override that differs from the site typography.");
  assert(initial.purpose === "true", "Buy is not the default listing purpose.");
  assert(initial.type === "House", `Expected House as the default property type, found ${initial.type}.`);
  assert(initial.rows > 2, `Expected at least three default House sale rows, found ${initial.rows}.`);
  assert(initial.houseRows, "Default inventory contains a non-House or non-sale listing.");
  assert(initial.comparisons === 0 && initial.uniqueComparisons === 0, "The board selected comparisons before the user chose a listing.");
  assert(initial.compareCount === "0 / 4 compared", `Unexpected initial comparison count: ${initial.compareCount}.`);
  assert(initial.comparisonStatus === "Select at least two listings", "Initial comparison status is incorrect.");
  assert(initial.selectedRows === 0, `Expected no initially selected rows, found ${initial.selectedRows}.`);
  assert(initial.analyticsHidden, "Analytics graphs are visible before a listing is selected.");
  const liveFeed = initial.feedState.includes("Live API");
  assert(liveFeed || initial.feedState.includes("Deployable snapshot"), `Unknown feed mode: ${initial.feedState}.`);
  assert(new Set(initial.propertyTypes).size === initial.propertyTypes.length && initial.propertyTypes.includes("House"), "The data-derived property options are missing, empty, or duplicated.");
  assert(!initial.bodyOverflow && !initial.documentOverflow, "Desktop viewport has horizontal overflow.");

  if (captureMarket) {
    const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const capturePath = join(tmpdir(), "nei-market.png");
    writeFileSync(capturePath, Buffer.from(screenshot.data, "base64"));
    console.log(`Captured Market to ${capturePath}.`);
  }

  await evaluate(`document.querySelector('[data-focus-property]')?.click()`);
  await waitForHistoryState();

  const comparisonSelection = await evaluate(`(() => {
    const addButton = document.querySelector('[data-toggle-compare][aria-pressed="false"]');
    const id = addButton?.dataset.toggleCompare;
    addButton?.click();
    return {
      id,
      cardsAfterAdd: document.querySelectorAll('.comparison-card').length,
      countAfterAdd: document.querySelector('[data-compare-count]').textContent.trim(),
      selectedAfterAdd: document.querySelector('[data-toggle-compare="' + CSS.escape(id || '') + '"]')?.getAttribute('aria-pressed'),
      removePresent: Boolean(document.querySelector('[data-remove-comparison="' + CSS.escape(id || '') + '"]'))
    };
  })()`);
  assert(Boolean(comparisonSelection.id), "No unselected listing was available to add to comparison.");
  assert(comparisonSelection.cardsAfterAdd === 1, `Adding a comparison produced ${comparisonSelection.cardsAfterAdd} cards instead of 1.`);
  assert(comparisonSelection.countAfterAdd === "1 / 4 compared", "Comparison count did not update after selection.");
  assert(comparisonSelection.selectedAfterAdd === "true" && comparisonSelection.removePresent, "Selected comparison state was not reflected across the board.");

  const comparisonRemoval = await evaluate(`(() => {
    const id = ${JSON.stringify(comparisonSelection.id)};
    document.querySelector('[data-remove-comparison="' + CSS.escape(id) + '"]')?.click();
    return {
      cards: document.querySelectorAll('.comparison-card').length,
      count: document.querySelector('[data-compare-count]').textContent.trim(),
      selected: document.querySelector('[data-toggle-compare="' + CSS.escape(id) + '"]')?.getAttribute('aria-pressed'),
      removed: !document.querySelector('[data-comparison-id="' + CSS.escape(id) + '"]')
    };
  })()`);
  assert(comparisonRemoval.cards === 0 && comparisonRemoval.count === "0 / 4 compared", "Removing a comparison did not clear the selection.");
  assert(comparisonRemoval.selected === "false" && comparisonRemoval.removed, "Removed comparison is still selected or rendered.");

  await evaluate(`(() => { document.querySelector('[data-focus-property]')?.click(); document.querySelector('[data-toggle-compare][aria-pressed="false"]')?.click(); })()`);
  await waitForHistoryState();

  const horizon = await evaluate(`(() => {
    const button = document.querySelector('[data-horizon="24"]');
    button.click();
    return {
      active: button.getAttribute('aria-pressed'),
      inactive12: document.querySelector('[data-horizon="12"]').getAttribute('aria-pressed'),
      scenarioLabel: document.querySelector('[data-scenario-chart]').getAttribute('aria-label'),
      metricLabels: [...document.querySelectorAll('.comparison-metrics dt')].map((node) => node.textContent),
      inventoryNotes: [...document.querySelectorAll('.inventory-scenario span')].map((node) => node.textContent)
    };
  })()`);
  assert(horizon.active === "true" && horizon.inactive12 === "false", "24-month horizon did not become active.");
  assert(horizon.scenarioLabel.startsWith("24-month experimental scenario"), "Scenario chart did not update to the 24-month horizon.");
  assert(horizon.metricLabels.includes("24M scenario"), "Comparison metrics did not update to the 24-month horizon.");
  assert(horizon.inventoryNotes.some((note) => note.startsWith("24M")), "Inventory signals did not update to the 24-month horizon.");

  const pinLimit = await evaluate(`(() => {
    const unselected = () => [...document.querySelectorAll('[data-toggle-compare][aria-pressed="false"]')];
    unselected()[0]?.click();
    unselected()[0]?.click();
    unselected()[0]?.click();
    const fifth = unselected()[0];
    fifth?.click();
    const atLimit = {
      cards: document.querySelectorAll('.comparison-card').length,
      count: document.querySelector('[data-compare-count]').textContent.trim(),
      toast: document.querySelector('[data-toast]').textContent.trim(),
      fifthPressed: fifth?.getAttribute('aria-pressed')
    };
    document.querySelector('[data-clear-comparison]').click();
    return {
      atLimit,
      afterClear: document.querySelectorAll('.comparison-card').length,
      clearCount: document.querySelector('[data-compare-count]').textContent.trim(),
      placeholders: document.querySelectorAll('.comparison-placeholder').length
    };
  })()`);
  assert(pinLimit.atLimit.cards === 4 && pinLimit.atLimit.count === "4 / 4 compared", "The comparison board did not reach its four-property limit.");
  assert(pinLimit.atLimit.toast.includes("Four listings are already pinned") && pinLimit.atLimit.fifthPressed === "false", "A fifth property was not rejected with an explanation.");
  assert(pinLimit.afterClear === 0 && pinLimit.clearCount === "0 / 4 compared" && pinLimit.placeholders === 4, "Clear did not reset all comparison slots.");

  const filtered = await evaluate(`(() => {
    const type = document.querySelector('[data-type]');
    type.value = 'all';
    type.dispatchEvent(new Event('change', { bubbles: true }));
    const allMarketCount = document.querySelectorAll('.inventory-row').length;
    const city = document.querySelector('[data-city]');
    let selectedCity = null;
    let cityCount = 0;
    for (const option of [...city.options].filter((item) => item.value !== 'all')) {
      city.value = option.value;
      city.dispatchEvent(new Event('change', { bubbles: true }));
      const count = document.querySelectorAll('.inventory-row').length;
      if (count > 0 && count < allMarketCount) {
        selectedCity = option.value;
        cityCount = count;
        break;
      }
    }
    const rent = document.querySelector('[data-purpose="rent"]');
    document.querySelector('[data-reset]').click();
    rent.click();
    const rentRows = [...document.querySelectorAll('.inventory-row')];
    return {
      allMarketCount,
      selectedCity,
      cityCount,
      rentPressed: rent.getAttribute('aria-pressed'),
      rentCount: rentRows.length,
      rentalRows: rentRows.every((row) => row.querySelector('.inventory-identity small').textContent.includes('· rent')),
      basisOptions: [...document.querySelector('[data-basis]').options].map((option) => option.value),
      zeroPrices: [...document.querySelectorAll('.inventory-price strong')].filter((node) => node.textContent.trim() === 'रु 0').length
    };
  })()`);
  assert(filtered.allMarketCount >= initial.rows, "All-property filter unexpectedly reduced the default inventory.");
  assert(Boolean(filtered.selectedCity) && filtered.cityCount > 0 && filtered.cityCount < filtered.allMarketCount, "City filtering did not narrow the inventory.");
  assert(filtered.rentPressed === "true" && filtered.rentCount > 0 && filtered.rentalRows, "Rent filtering did not return rental inventory.");
  assert(filtered.basisOptions.includes("monthly"), "Rental filter did not expose the monthly price basis.");
  assert(filtered.zeroPrices === 0, "A missing asking price was rendered as रु 0.");

  const method = await evaluate(`(() => {
    const button = document.querySelector('[data-method-open]');
    const panel = document.querySelector('[data-method-panel]');
    button.click();
    const opened = { expanded: button.getAttribute('aria-expanded'), hidden: panel.hidden, text: panel.textContent };
    button.click();
    return {
      opened,
      closed: { expanded: button.getAttribute('aria-expanded'), hidden: panel.hidden }
    };
  })()`);
  assert(method.opened.expanded === "true" && !method.opened.hidden, "Method panel did not open.");
  assert(method.opened.text.includes("peer midpoint") && method.opened.text.includes("Upside"), "Method panel is missing its upside explanation.");
  assert(method.closed.expanded === "false" && method.closed.hidden, "Method panel did not close.");

  const resetState = await evaluate(`(() => { document.querySelector('[data-reset]').click(); return { analyticsHidden: document.querySelector('[data-analytics-rail]').hidden }; })()`);
  assert(resetState.analyticsHidden, "Reset left analytics visible without a selected listing.");
  await evaluate(`document.querySelector('[data-focus-property]')?.click()`);
  await waitForHistoryState();
  const canvases = await evaluate(`(() => [...document.querySelectorAll('canvas')].map((canvas) => {
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaqueSamples = 0;
    let drawnSamples = 0;
    const sampledPixels = [];
    const stride = Math.max(1, Math.floor((canvas.width * canvas.height) / 5000));
    for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += stride) {
      const offset = pixel * 4;
      const rgba = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
      if (rgba[3] > 0) opaqueSamples += 1;
      if (rgba[3] > 0 && (rgba[0] !== 247 || rgba[1] !== 246 || rgba[2] !== 242)) {
        drawnSamples += 1;
        if (sampledPixels.length < 3) sampledPixels.push(rgba);
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      opaqueSamples,
      drawnSamples,
      sampledPixels
    };
  }))()`);
  assert(canvases.length === 2, `Expected two analytics canvases, found ${canvases.length}.`);
  canvases.forEach((canvas, index) => {
    assert(canvas.width >= 280 && canvas.height >= 170, `Canvas ${index + 1} has invalid ${canvas.width}x${canvas.height} dimensions.`);
    assert(canvas.opaqueSamples > 100, `Canvas ${index + 1} contains no opaque pixel sample.`);
    assert(canvas.drawnSamples > 5 && canvas.sampledPixels.length > 0, `Canvas ${index + 1} has no sampled pixels distinct from its background.`);
  });

  await command("Page.removeScriptToEvaluateOnNewDocument", { identifier: collectingHistoryScript.identifier });
  await command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const href = typeof input === 'string' ? input : input.url;
        const url = new URL(href, location.origin);
        if (url.pathname === '/api/listings') {
          return nativeFetch('/data/listings.json', options).then(async (response) => {
            const payload = await response.json();
            const expanded = [...payload.items];
            const seed = expanded[0];
            while (seed && expanded.length < 251) {
              const index = expanded.length;
              expanded.push({
                ...seed,
                id: seed.id + '-pagination-smoke-' + index,
                title: seed.title + ' pagination smoke ' + index,
                sourceUrl: seed.sourceUrl + '#pagination-smoke-' + index
              });
            }
            const offset = Number(url.searchParams.get('offset') || 0);
            const limit = Number(url.searchParams.get('limit') || 250);
            payload.items = expanded.slice(offset, offset + limit);
            payload.total = expanded.length;
            payload.limit = limit;
            payload.offset = offset;
            payload.mode = 'live-database';
            payload.freshness = { state: 'stale', sourceErrors: ['Synthetic source alert'] };
            return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
          });
        }
        if (url.pathname !== '/api/market/series') return nativeFetch(input, options);
        const dates = ['2026-07-01','2026-07-03','2026-07-05','2026-07-07','2026-07-09','2026-07-11','2026-07-13','2026-07-15','2026-07-17','2026-07-19','2026-07-21','2026-07-23','2026-07-25','2026-07-30'];
        const items = dates.map((date, index) => ({
          date,
          purpose: url.searchParams.get('purpose'),
          city: url.searchParams.get('city'),
          propertyType: url.searchParams.get('type'),
          priceBasis: url.searchParams.get('price_basis'),
          medianPriceNpr: 20000000 + index * 100000,
          listingCount: 8 + index % 3
        }));
        return Promise.resolve(new Response(JSON.stringify({
          items,
          status: 'ready',
          readiness: {
            ready: true,
            historyWindowDays: 30,
            qualifyingDays: 14,
            minimumWindowDays: 30,
            minimumObservedDays: 14,
            minimumDailySample: 8
          },
          asOf: '2026-07-30T12:00:00+00:00'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      };
    })();`,
  });
  await command("Page.reload", { ignoreCache: true });
  await waitForInventory();
  await evaluate(`(() => {
    document.querySelector('[data-focus-property]')?.click();
    document.querySelector('[data-toggle-compare][aria-pressed="false"]')?.click();
  })()`);
  await waitForHistoryState("observed");
  const observedHistory = await evaluate(`({
    eyebrow: document.querySelector('[data-analysis-eyebrow]').textContent.trim(),
    title: document.querySelector('[data-analysis-title]').textContent.trim(),
    feedState: document.querySelector('[data-feed-state]').textContent.trim(),
    feedClass: document.querySelector('[data-feed-state]').className,
    coverage: document.querySelector('[data-coverage]').textContent.trim(),
    horizonHidden: document.querySelector('[data-horizon-control]').hidden,
    chartLabel: document.querySelector('[data-scenario-chart]').getAttribute('aria-label'),
    status: document.querySelector('[data-history-status]').textContent.trim(),
    method: document.querySelector('[data-method-panel]').textContent,
    coverageLabel: document.querySelector('[data-confidence-label]').textContent.trim(),
    inventorySignals: [...document.querySelectorAll('.inventory-scenario span')].map((node) => node.textContent.trim()),
    comparisonLabels: [...document.querySelectorAll('.comparison-metrics dt')].map((node) => node.textContent.trim())
  })`);
  assert(observedHistory.eyebrow === "OBSERVED ASK HISTORY" && observedHistory.title === "Peer median trend", "A ready cohort did not replace the scenario with observed history.");
  assert(observedHistory.feedState.includes("Live API · 251 listings"), `The live paginated inventory was incomplete or mislabeled: ${observedHistory.feedState}.`);
  assert(observedHistory.feedClass.includes("is-stale") && observedHistory.coverage.includes("1 source alert"), "A degraded source state was not surfaced in the feed badge.");
  assert(observedHistory.horizonHidden && observedHistory.chartLabel.startsWith("Observed peer median asking prices"), "Observed history did not update the chart and controls.");
  assert(observedHistory.status.includes("met the history threshold") && observedHistory.method.includes("median current ask") && observedHistory.coverageLabel === "Coverage", "Observed-history explanation is incomplete.");
  assert(observedHistory.inventorySignals.some((label) => label.startsWith("observed")) && observedHistory.comparisonLabels.includes("Observed median trend"), "Observed history did not replace matching tape and comparison signals.");

  await command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await command("Page.reload", { ignoreCache: true });
  await waitForInventory();
  await delay(150);
  const mobile = await evaluate(`(() => {
    const menuButton = document.querySelector('[data-menu-button]');
    menuButton.click();
    return {
      width: window.innerWidth,
      rows: document.querySelectorAll('.inventory-row').length,
      menuOpen: document.querySelector('[data-mobile-menu]').classList.contains('is-open'),
      homeVisible: Boolean(document.querySelector('[data-mobile-menu] a[href="/"]')),
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth + 2,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
    };
  })()`);
  assert(mobile.width === 390 && mobile.rows > 0, "Market board did not render at the mobile viewport.");
  assert(mobile.menuOpen && mobile.homeVisible, "Market mobile navigation is inconsistent or missing Home.");
  assert(!mobile.bodyOverflow && !mobile.documentOverflow, "Mobile viewport has horizontal overflow.");

  failures.push(...runtimeErrors);
  if (failures.length) {
    throw new Error(failures.map((failure) => `- ${failure}`).join("\n"));
  }
  console.log("Market smoke test passed: feed modes, comparison limit, filters, scenario disclosure, observed history, canvas pixels, and responsive overflow.");
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill("SIGTERM");
  await delay(150);
  rmSync(profileDir, { recursive: true, force: true });
}
