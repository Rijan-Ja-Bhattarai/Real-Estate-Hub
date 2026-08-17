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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await evaluate("document.readyState")) === "complete") {
      await delay(250);
      return;
    }
    await delay(100);
  }
  throw new Error("The site did not finish loading.");
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
      failures.push(`Browser error: ${message.params.entry.text}`);
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
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    heroVisible: document.querySelector('#hero-title').getBoundingClientRect().height > 0
  })`);
  assert(initial.title.includes("Nepal Estate Index"), "Document title is missing the product name.");
  assert(initial.cards === 6, `Expected 6 initial sale cards, found ${initial.cards}.`);
  assert(initial.result.includes("6 sample properties for sale"), "Initial result summary is incorrect.");
  assert(!initial.horizontalOverflow, "Desktop viewport has horizontal overflow.");
  assert(initial.heroVisible, "Hero heading is not visible.");

  if (captureSelector) {
    await evaluate(`document.querySelector(${JSON.stringify(captureSelector)})?.scrollIntoView({ block: 'start' })`);
    await delay(900);
    const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync("/tmp/nei-section.png", Buffer.from(screenshot.data, "base64"));
    console.log(`Captured ${captureSelector} to /tmp/nei-section.png.`);
  }

  const rentState = await evaluate(`(() => {
    document.querySelector('[data-purpose="rent"]').click();
    return {
      cards: document.querySelectorAll('.property-card').length,
      summary: document.querySelector('[data-result-summary]').textContent
    };
  })()`);
  assert(rentState.cards === 3, `Expected 3 rental cards, found ${rentState.cards}.`);
  assert(rentState.summary.includes("for rent"), "Rent result summary did not update.");

  const dialogState = await evaluate(`(() => {
    document.querySelector('.property-card [data-open-property]').click();
    return {
      open: document.querySelector('[data-property-dialog]').open,
      title: document.querySelector('[data-dialog-title]').textContent
    };
  })()`);
  assert(dialogState.open, "Property dialog did not open.");
  assert(dialogState.title.length > 4, "Property dialog did not receive listing content.");
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
      menuVisible: getComputedStyle(menuButton).display !== 'none'
    };
  })()`);
  assert(mobileState.menuOpen && mobileState.expanded === "true", "Mobile menu did not open.");
  assert(mobileState.menuVisible, "Mobile menu control is not visible.");
  assert(!mobileState.horizontalOverflow, "Mobile viewport has horizontal overflow.");

  if (failures.length) {
    throw new Error(failures.map((failure) => `- ${failure}`).join("\n"));
  }
  console.log("Browser smoke test passed: desktop render, filters, dialog, saved state, and mobile menu.");
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill("SIGTERM");
  await delay(150);
  rmSync(profileDir, { recursive: true, force: true });
}
