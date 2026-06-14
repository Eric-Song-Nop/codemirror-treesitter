import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const i18nDir = join(appRoot, "src/i18n");
const srcDir = join(appRoot, "src");
const sourceExtensions = new Set([".ts", ".tsx"]);
const requiredLocales = ["en", "zh-CN"];
const keyPattern = /\bt\(\s*["']([^"']+)["']/g;
const placeholderPattern = /\{([a-zA-Z0-9_]+)\}/g;

let failures = [];
let localeMessages = new Map();

for (let locale of requiredLocales) {
  let fileName = `${locale}.json`;
  let filePath = join(i18nDir, fileName);
  try {
    let parsed = JSON.parse(await readFile(filePath, "utf8"));
    localeMessages.set(locale, parsed);
  } catch (error) {
    failures.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!failures.length) {
  checkLocaleKeys();
  await checkSourceKeys();
}

if (failures.length) {
  console.error("local-md-workspace i18n check failed:");
  for (let failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("local-md-workspace i18n check passed.");

function checkLocaleKeys() {
  let reference = localeMessages.get("en");
  let referenceKeys = Object.keys(reference).sort();
  let referenceKeySet = new Set(referenceKeys);

  for (let [locale, messages] of localeMessages) {
    let keys = Object.keys(messages).sort();
    let keySet = new Set(keys);
    let missing = referenceKeys.filter((key) => !keySet.has(key));
    let extra = keys.filter((key) => !referenceKeySet.has(key));

    if (missing.length) failures.push(`${locale}.json missing keys: ${missing.join(", ")}`);
    if (extra.length) failures.push(`${locale}.json extra keys: ${extra.join(", ")}`);

    for (let key of keys) {
      let value = messages[key];
      if (typeof value != "string" || !value.trim()) {
        failures.push(`${locale}.json ${key} must be a non-empty string`);
        continue;
      }

      let expectedPlaceholders = placeholders(reference[key] ?? "");
      let actualPlaceholders = placeholders(value);
      if (expectedPlaceholders.join(",") != actualPlaceholders.join(",")) {
        failures.push(
          `${locale}.json ${key} placeholders differ: expected {${expectedPlaceholders.join(
            "},{",
          )}}, got {${actualPlaceholders.join("},{")}}`,
        );
      }
    }
  }
}

async function checkSourceKeys() {
  let reference = localeMessages.get("en");
  let validKeys = new Set(Object.keys(reference));
  let usedKeys = new Set();
  for (let filePath of await listSourceFiles(srcDir)) {
    let source = await readFile(filePath, "utf8");
    for (let match of source.matchAll(keyPattern)) {
      let key = match[1];
      usedKeys.add(key);
      if (!validKeys.has(key)) {
        failures.push(`${relative(appRoot, filePath)} references unknown i18n key ${key}`);
      }
    }
  }

  if (!usedKeys.size) failures.push("No i18n translation keys were referenced from source.");
}

async function listSourceFiles(directory) {
  let entries = await readdir(directory, { withFileTypes: true });
  let files = [];
  for (let entry of entries) {
    let path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)));
    } else if (sourceExtensions.has(extension(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function extension(fileName) {
  let index = fileName.lastIndexOf(".");
  return index == -1 ? "" : fileName.slice(index);
}

function placeholders(value) {
  return [...new Set([...value.matchAll(placeholderPattern)].map((match) => match[1]))].sort(
    compareText,
  );
}

function compareText(left, right) {
  return left.localeCompare(right);
}
