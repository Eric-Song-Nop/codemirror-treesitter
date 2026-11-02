#!/usr/bin/env node
// Publish step for .github/workflows/release.yml.
//
// `changeset publish` shells out to `npm publish` in a Bun workspace, and npm
// does not rewrite the `workspace:` protocol, so the published manifests would
// be uninstallable. This rewrites those ranges to the exact versions in the
// working tree (a throwaway CI checkout) and then runs `changeset publish`.
//
//   node tools/release-publish.mjs                 rewrite, then publish
//   node tools/release-publish.mjs --rewrite-only  rewrite and stop (for checks)
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies"];
const packagesRoot = join(import.meta.dirname, "..", "packages");

let manifests = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesRoot, entry.name, "package.json"))
  .flatMap((path) => {
    try {
      return [{ path, manifest: JSON.parse(readFileSync(path, "utf8")) }];
    } catch (error) {
      if (error.code == "ENOENT") return [];
      throw error;
    }
  });

let versions = new Map(manifests.map(({ manifest }) => [manifest.name, manifest]));

for (let { path, manifest } of manifests) {
  if (manifest.private) continue;
  for (let field of dependencyFields) {
    for (let [name, range] of Object.entries(manifest[field] ?? {})) {
      if (!range.startsWith("workspace:")) continue;
      let target = versions.get(name);
      if (!target) throw new Error(`${manifest.name} depends on unknown workspace package ${name}`);
      if (target.private) throw new Error(`${manifest.name} depends on private package ${name}`);
      manifest[field][name] = target.version;
    }
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv.includes("--rewrite-only")) process.exit(0);

// The version PR path never reaches this script. Without a token there is
// nothing to publish to, which should not turn every main push red.
if (!process.env.NPM_TOKEN) {
  console.log("::warning::NPM_TOKEN is not set; skipping npm publish.");
  process.exit(0);
}

let result = spawnSync("vp", ["exec", "changeset", "publish"], { stdio: "inherit" });
process.exit(result.status ?? 1);
