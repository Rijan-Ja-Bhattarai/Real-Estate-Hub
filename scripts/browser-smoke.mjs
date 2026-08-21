import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const siteUrl = process.env.SITE_URL || "http://127.0.0.1:4173/";
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const captureSelector = process.argv[2];
const debugPort = 9300 + (process.pid % 300);
const profileDir = mkdtempSync(join(tmpdir(), "nei-smoke-"));
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
    throw new Error(response.exceptionDetails.text || "Evaluation failed.");
  }
  return response.result.value;
}

async function waitForReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await evaluate(`({
      document: document.readyState,
      data: document.querySelector('[data-feed-badge]')?.textContent !== 'Loading database',
      cards: document.querySelectorAll('.property-card:not(.property-card-loading)').length
    })`);
    if (["interactive", "complete"].includes(ready.document) && ready.data && ready.cards > 0) return;
    await delay(100);
  }
  throw new Error("The site or listing database did not finish loading.");
}

async function waitForBrowseReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await evaluate(`({
      path: location.pathname,
      busy: document.querySelector('[data-browse-list]')?.getAttribute('aria-busy'),
      cards: document.querySelectorAll('.browse-card').length
    })`);
    if (ready.path === "/properties" && ready.busy === "false" && ready.cards > 0) return;
    await delay(100);
  }
  throw new Error("The dedicated property browser did not finish loading.");
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
      failures.push(`Runtime exception: ${message.params.exceptionDetails.text}`);
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      const entry = message.params.entry;
      if (entry.url?.includes("/api/listings?") && entry.text.includes("404")) return;
      failures.push(`Browser error: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
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
  await command("Page.navigate", { url: siteUrl });
  await waitForReady();

  const initial = await evaluate(`({
    title: document.title,
    cards: document.querySelectorAll('.property-card').length,
    result: document.querySelector('[data-result-summary]').textContent,
    mapVisible: !document.querySelector('[data-listing-map]').hidden,
    sourceLink: document.querySelector('.property-source-row a')?.href,
    landRateVisible: [...document.querySelectorAll('.property-price')].some((node) => node.textContent.includes('/ aana')),
    rightsNoticeVisible: Boolean(document.querySelector('.property-image-policy')),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    heroVisible: document.querySelector('#hero-title').getBoundingClientRect().height > 0,
    assistantVisible: Boolean(document.querySelector('[data-nei-assistant]')),
    buyRoute: document.querySelector('.desktop-nav a')?.getAttribute('href')
  })`);
  assert(initial.title.includes("Nepal Estate Index"), "Document title is missing the product name.");
  assert(initial.cards === 6, `Expected 6 initial sale cards, found ${initial.cards}.`);
  assert(initial.result.includes("indexed") && initial.result.includes("for sale"), "Initial result summary is incorrect.");
  assert(initial.mapVisible, "Approximate listing map is not visible.");
  assert(
    initial.sourceLink?.startsWith("https://") && !initial.sourceLink.startsWith(siteUrl),
    "Listing source handoff is missing.",
  );
  assert(initial.rightsNoticeVisible, "Source-image rights status is not surfaced beside previews.");
  assert(!initial.horizontalOverflow, "Desktop viewport has horizontal overflow.");
  assert(initial.heroVisible, "Hero heading is not visible.");
  assert(initial.assistantVisible, "The site-wide property assistant is missing.");
  assert(initial.buyRoute === "/properties?purpose=buy", "Buy does not point to the dedicated property browser.");

  const landState = await evaluate(`(() => {
    document.querySelector('[data-filter="Land"]').click();
    return {
      cards: document.querySelectorAll('.property-card').length,
      unitRateVisible: [...document.querySelectorAll('.property-price')]
        .some((node) => [' / aana', ' / ropani', ' / kattha', ' / dhur', ' / sq ft']
          .some((basis) => node.textContent.toLowerCase().includes(basis)))
    };
  })()`);
  assert(landState.cards > 0, "Land filtering returned no actual source records.");
  assert(landState.unitRateVisible, "Source-labelled land unit rates are not displayed with their basis.");

  const mapFocusState = await evaluate(`(() => {
    document.querySelector('.property-card [data-map-property]').click();
    return {
      focused: document.activeElement.matches('[data-map-title]'),
      title: document.querySelector('[data-map-title]').textContent
    };
  })()`);
  assert(mapFocusState.focused, "Map selection did not move focus to the updated map heading.");
  assert(mapFocusState.title.length > 4, "Map selection did not update the map heading.");

  if (captureSelector) {
    await evaluate(`document.querySelector(${JSON.stringify(captureSelector)})?.scrollIntoView({ block: 'start' })`);
    // Captured source photographs can be several megabytes; give the browser
    // enough time to replace the local placeholder before visual inspection.
    await delay(5000);
    const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync("/tmp/nei-section.png", Buffer.from(screenshot.data, "base64"));
    console.log(`Captured ${captureSelector} to /tmp/nei-section.png.`);
  }

  const rentState = await evaluate(`(() => {
    document.querySelector('[data-purpose="rent"]').click();
    return {
      cards: document.querySelectorAll('.property-card').length,
      summary: document.querySelector('[data-result-summary]').textContent,
      budgetLabel: document.querySelector('[data-budget-label]').textContent,
      budgetOption: document.querySelector('[name="budget"] option:nth-child(2)').textContent
    };
  })()`);
  assert(rentState.cards > 0 && rentState.cards <= 6, `Expected visible rental cards, found ${rentState.cards}.`);
  assert(rentState.summary.includes("for rent"), "Rent result summary did not update.");
  assert(rentState.budgetLabel.includes("monthly"), "Rental budget did not switch to a monthly basis.");
  assert(rentState.budgetOption.includes("/ mo"), "Rental budget options are missing monthly units.");

  await evaluate(`(() => {
    const form = document.querySelector('[data-search-form]');
    form.elements.type.value = 'Commercial';
    form.requestSubmit();
  })()`);
  await waitForBrowseReady();
  const commercialState = await evaluate(`({
    path: location.pathname,
    purpose: new URLSearchParams(location.search).get('purpose'),
    type: document.querySelector('[name="type"]').value,
    cards: document.querySelectorAll('.browse-card').length,
    types: [...document.querySelectorAll('.browse-card-kicker')].map((node) => node.textContent)
  })`);
  assert(commercialState.path === "/properties", "Landing search did not redirect to the internal property browser.");
  assert(commercialState.purpose === "rent", "Landing search did not preserve the Rent purpose.");
  assert(commercialState.cards > 0, "Commercial rental filtering returned no real source records.");
  assert(
    commercialState.type === "Commercial" && commercialState.types.every((value) => value.includes("Commercial")),
    "Commercial results contain a mismatched normalized type.",
  );

  await command("Page.navigate", { url: siteUrl });
  await waitForReady();

  const dialogState = await evaluate(`(() => {
    document.querySelector('.property-card [data-open-property]').click();
    return {
      open: document.querySelector('[data-property-dialog]').open,
      title: document.querySelector('[data-dialog-title]').textContent,
      facts: document.querySelectorAll('[data-dialog-facts] span').length
    };
  })()`);
  assert(dialogState.open, "Property dialog did not open.");
  assert(dialogState.title.length > 4, "Property dialog did not receive listing content.");
  assert(dialogState.facts >= 1, "Source facts were not rendered in the property dialog.");
  await evaluate(`document.querySelector('[data-dialog-close]').click()`);

  const savedState = await evaluate(`(() => {
    document.querySelector('.property-card [data-save-property]').click();
    return {
      count: document.querySelector('[data-saved-count]').textContent,
      pressed: document.querySelector('.property-card [data-save-property]').getAttribute('aria-pressed'),
      focusRestored: document.activeElement.matches('[data-save-property]')
    };
  })()`);
  assert(savedState.count === "1", "Saved-property count did not update.");
  assert(savedState.pressed === "true", "Saved-property control did not update its pressed state.");
  assert(savedState.focusRestored, "Keyboard focus was not restored after saving a property.");

  const savedView = await evaluate(`(() => {
    document.querySelector('[data-open-saved]').click();
    return {
      cards: document.querySelectorAll('.property-card').length,
      summary: document.querySelector('[data-result-summary]').textContent
    };
  })()`);
  assert(savedView.cards === 1, "Saved-only view did not narrow to the saved property.");
  assert(savedView.summary.includes("1 saved property across all purposes"), "Saved-only summary is incorrect.");

  await command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await command("Page.reload", { ignoreCache: true });
  await waitForReady();
  const mobileState = await evaluate(`(() => {
    const menuButton = document.querySelector('[data-menu-button]');
    menuButton.click();
    return {
      menuOpen: document.querySelector('[data-mobile-menu]').classList.contains('is-open'),
      expanded: menuButton.getAttribute('aria-expanded'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      menuVisible: getComputedStyle(menuButton).display !== 'none',
      backgroundInert: document.querySelector('main').inert && document.querySelector('.site-footer').inert,
      focusInsideMenu: document.activeElement.closest('[data-mobile-menu]') !== null
    };
  })()`);
  assert(mobileState.menuOpen && mobileState.expanded === "true", "Mobile menu did not open.");
  assert(mobileState.menuVisible, "Mobile menu control is not visible.");
  assert(mobileState.backgroundInert, "Mobile menu did not make obscured page content inert.");
  assert(mobileState.focusInsideMenu, "Mobile menu did not move focus into the overlay.");
  assert(!mobileState.horizontalOverflow, "Mobile viewport has horizontal overflow.");

  if (failures.length) {
    throw new Error(failures.map((failure) => `- ${failure}`).join("\n"));
  }
  console.log("Browser smoke test passed: real-data render, price bases, filters, map, dialog, saved state, and mobile menu.");
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill("SIGTERM");
  await delay(150);
  rmSync(profileDir, { recursive: true, force: true });
}
