import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const outputDirectory = new URL("../dist/", import.meta.url);
const sourceRoot = new URL("../", import.meta.url);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const file of ["index.html", "styles.css", "script.js"]) {
  await cp(new URL(file, sourceRoot), new URL(file, outputDirectory));
}
await mkdir(new URL("assets/images/", outputDirectory), { recursive: true });
await cp(new URL("assets/favicon.svg", sourceRoot), new URL("assets/favicon.svg", outputDirectory));
for (const image of ["hero-residence.webp", "lazimpat-courtyard.webp", "budhanilkantha-home.webp"]) {
  await cp(new URL(`assets/images/${image}`, sourceRoot), new URL(`assets/images/${image}`, outputDirectory));
}

const hostingConfig = new URL(".openai/hosting.json", sourceRoot);
try {
  await readFile(hostingConfig, { flag: constants.R_OK });
  await mkdir(new URL(".openai/", outputDirectory), { recursive: true });
  await cp(hostingConfig, new URL(".openai/hosting.json", outputDirectory));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

await writeFile(new URL(".build-info", outputDirectory), "Nepal Estate Index static build\n", "utf8");
console.log("Built the static site into dist/.");
