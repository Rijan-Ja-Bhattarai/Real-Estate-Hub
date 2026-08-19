import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const siteUrl = process.env.SITE_URL || "http://127.0.0.1:4173/";
const marketUrl = new URL("/market", siteUrl).href;
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
    if (["interactive", "complete"].includes(ready.document) && ready.busy === "false" && ready.rows > 0 && ready.comparisons === 2) return;
    await delay(100);
  }
  throw new Error("The market inventory did not finish loading with its initial comparison set.");
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
      runtimeErrors.push(`Browser error: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
    }
  });

  await command("Page.enable");
  await command("Runtime.enable");
  await command("Log.enable");
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
      purpose: document.querySelector('[data-purpose="buy"]').getAttribute('aria-pressed'),
      type: document.querySelector('[data-type]').value,
      rows: rows.length,
      houseRows: rows.every((row) => row.querySelector('.inventory-identity small').textContent.includes('House · sale')),
      comparisons: comparisonCards.length,
      uniqueComparisons: new Set(comparisonCards.map((card) => card.dataset.comparisonId)).size,
      compareCount: document.querySelector('[data-compare-count]').textContent.trim(),
      comparisonStatus: document.querySelector('[data-comparison-status]').textContent.trim(),
      selectedRows: document.querySelectorAll('[data-toggle-compare][aria-pressed="true"]').length,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth + 2,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
    };
  })()`);
  assert(initial.path === "/market" || initial.path === "/market/", `Expected /market, loaded ${initial.path}.`);
  assert(initial.title.includes("Market Board"), "Market page title is missing.");
  assert(initial.purpose === "true", "Buy is not the default listing purpose.");
  assert(initial.type === "House", `Expected House as the default property type, found ${initial.type}.`);
  assert(initial.rows > 2, `Expected at least three default House sale rows, found ${initial.rows}.`);
  assert(initial.houseRows, "Default inventory contains a non-House or non-sale listing.");
  assert(initial.comparisons === 2 && initial.uniqueComparisons === 2, "The board did not pin two distinct initial comparisons.");
  assert(initial.compareCount === "2 / 4 compared", `Unexpected initial comparison count: ${initial.compareCount}.`);
  assert(initial.comparisonStatus === "2 listings pinned", "Initial comparison status is incorrect.");
  assert(initial.selectedRows === 2, `Expected two selected inventory rows, found ${initial.selectedRows}.`);
  assert(!initial.bodyOverflow && !initial.documentOverflow, "Desktop viewport has horizontal overflow.");

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
  assert(comparisonSelection.cardsAfterAdd === 3, `Adding a comparison produced ${comparisonSelection.cardsAfterAdd} cards instead of 3.`);
  assert(comparisonSelection.countAfterAdd === "3 / 4 compared", "Comparison count did not update after selection.");
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
  assert(comparisonRemoval.cards === 2 && comparisonRemoval.count === "2 / 4 compared", "Removing a comparison did not restore the initial count.");
  assert(comparisonRemoval.selected === "false" && comparisonRemoval.removed, "Removed comparison is still selected or rendered.");

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
      basisOptions: [...document.querySelector('[data-basis]').options].map((option) => option.value)
    };
  })()`);
  assert(filtered.allMarketCount >= initial.rows, "All-property filter unexpectedly reduced the default inventory.");
  assert(Boolean(filtered.selectedCity) && filtered.cityCount > 0 && filtered.cityCount < filtered.allMarketCount, "City filtering did not narrow the inventory.");
  assert(filtered.rentPressed === "true" && filtered.rentCount > 0 && filtered.rentalRows, "Rent filtering did not return rental inventory.");
  assert(filtered.basisOptions.includes("monthly"), "Rental filter did not expose the monthly price basis.");

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
  assert(method.opened.text.includes("mean-reversion scenario") && method.opened.text.includes("not a valuation"), "Method panel is missing its model limitations.");
  assert(method.closed.expanded === "false" && method.closed.hidden, "Method panel did not close.");

  await evaluate(`document.querySelector('[data-reset]').click()`);
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

  await command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await command("Page.reload", { ignoreCache: true });
  await waitForInventory();
  await delay(150);
  const mobile = await evaluate(`({
    width: window.innerWidth,
    rows: document.querySelectorAll('.inventory-row').length,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth + 2,
    documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
  })`);
  assert(mobile.width === 390 && mobile.rows > 0, "Market board did not render at the mobile viewport.");
  assert(!mobile.bodyOverflow && !mobile.documentOverflow, "Mobile viewport has horizontal overflow.");

  failures.push(...runtimeErrors);
  if (failures.length) {
    throw new Error(failures.map((failure) => `- ${failure}`).join("\n"));
  }
  console.log("Market smoke test passed: defaults, comparisons, filters, horizon, method panel, canvas pixels, and responsive overflow.");
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill("SIGTERM");
  await delay(150);
  rmSync(profileDir, { recursive: true, force: true });
}
