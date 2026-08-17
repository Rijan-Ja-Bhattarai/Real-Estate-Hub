import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const outputDirectory = new URL("../dist/", import.meta.url);
const sourceRoot = new URL("../", import.meta.url);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const file of ["index.html", "styles.css", "script.js"]) {
  await cp(new URL(file, sourceRoot), new URL(file, outputDirectory));
}
await mkdir(new URL("data/", outputDirectory), { recursive: true });
await cp(new URL("data/listings.json", sourceRoot), new URL("data/listings.json", outputDirectory));
await mkdir(new URL("assets/images/", outputDirectory), { recursive: true });
await cp(new URL("assets/favicon.svg", sourceRoot), new URL("assets/favicon.svg", outputDirectory));
for (const image of ["hero-residence.webp", "lazimpat-courtyard.webp", "budhanilkantha-home.webp"]) {
  await cp(new URL(`assets/images/${image}`, sourceRoot), new URL(`assets/images/${image}`, outputDirectory));
}
await cp(
  new URL("assets/images/property-image-unavailable.svg", sourceRoot),
  new URL("assets/images/property-image-unavailable.svg", outputDirectory),
);

const hostingConfig = new URL(".openai/hosting.json", sourceRoot);
try {
  await readFile(hostingConfig, { flag: constants.R_OK });
  await mkdir(new URL(".openai/", outputDirectory), { recursive: true });
  await cp(hostingConfig, new URL(".openai/hosting.json", outputDirectory));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

await writeFile(new URL(".build-info", outputDirectory), "Nepal Estate Index static build\n", "utf8");

const workerAssets = [
  { route: "/", file: "index.html", type: "text/html; charset=utf-8", cache: "no-cache" },
  { route: "/index.html", file: "index.html", type: "text/html; charset=utf-8", cache: "no-cache" },
  { route: "/styles.css", file: "styles.css", type: "text/css; charset=utf-8", cache: "no-cache" },
  { route: "/script.js", file: "script.js", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  {
    route: "/data/listings.json",
    file: "data/listings.json",
    type: "application/json; charset=utf-8",
    cache: "public, max-age=900, stale-while-revalidate=3600",
  },
  {
    route: "/api/listings",
    file: "data/listings.json",
    type: "application/json; charset=utf-8",
    cache: "public, max-age=900, stale-while-revalidate=3600",
  },
  {
    route: "/assets/favicon.svg",
    file: "assets/favicon.svg",
    type: "image/svg+xml; charset=utf-8",
    cache: "public, max-age=86400",
  },
  {
    route: "/assets/images/property-image-unavailable.svg",
    file: "assets/images/property-image-unavailable.svg",
    type: "image/svg+xml; charset=utf-8",
    cache: "public, max-age=31536000, immutable",
  },
  {
    route: "/assets/images/hero-residence.webp",
    file: "assets/images/hero-residence.webp",
    type: "image/webp",
    cache: "public, max-age=31536000, immutable",
    binary: true,
  },
  {
    route: "/assets/images/lazimpat-courtyard.webp",
    file: "assets/images/lazimpat-courtyard.webp",
    type: "image/webp",
    cache: "public, max-age=31536000, immutable",
    binary: true,
  },
  {
    route: "/assets/images/budhanilkantha-home.webp",
    file: "assets/images/budhanilkantha-home.webp",
    type: "image/webp",
    cache: "public, max-age=31536000, immutable",
    binary: true,
  },
];

const encodedAssets = [];
for (const asset of workerAssets) {
  const contents = await readFile(new URL(asset.file, outputDirectory));
  encodedAssets.push({
    route: asset.route,
    type: asset.type,
    cache: asset.cache,
    encoding: asset.binary ? "base64" : "text",
    body: asset.binary ? contents.toString("base64") : contents.toString("utf8"),
  });
}

const workerSource = `const assets = new Map(${JSON.stringify(encodedAssets)}.map((asset) => [asset.route, asset]));

function decodeBase64(value) {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const asset = assets.get(pathname);
    if (!asset) return new Response("Not found", { status: 404 });

    const headers = new Headers({
      "Cache-Control": asset.cache,
      "Content-Type": asset.type,
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    const body = method === "HEAD" ? null : asset.encoding === "base64" ? decodeBase64(asset.body) : asset.body;
    return new Response(body, { status: 200, headers });
  },
};
`;

await mkdir(new URL("server/", outputDirectory), { recursive: true });
await writeFile(new URL("server/index.js", outputDirectory), workerSource, "utf8");
console.log("Built the static site into dist/.");
