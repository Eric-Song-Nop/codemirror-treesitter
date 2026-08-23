import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoUrl = "git+https://github.com/Eric-Song-Nop/codemirror-treesitter.git";
const bugsUrl = "https://github.com/Eric-Song-Nop/codemirror-treesitter/issues";
const packageVersion = "0.0.0";
const runtimePackageName = "@codemirror-treesitter/web-tree-sitter";
const runtimePackageVersion = "0.26.9-codemirror-treesitter.0";
const disallowedProtocol = /^(?:workspace|catalog|file):/;

let failures = 0;

const packages = await publishablePackages();
await checkManifests(packages);
await checkPackedTarballs(packages);
await runPackageLinters(packages);
await installAndSmoke(packages);

if (failures) {
  console.error(`package validation failed with ${failures} issue${failures == 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log(`package validation passed for ${packages.length} packages`);
}

async function publishablePackages() {
  let entries = [];
  for (let dirName of await sortedDirNames(path.join(root, "packages"))) {
    let dir = path.join(root, "packages", dirName);
    let packagePath = path.join(dir, "package.json");
    if (!existsSync(packagePath)) continue;
    let manifest = await readManifest(packagePath);
    if (manifest.private) continue;
    entries.push({ dir, dirName, manifest, packagePath, kind: "workspace" });
  }

  let runtimeDir = path.join(root, "vendor/web-tree-sitter");
  let runtimePath = path.join(runtimeDir, "package.json");
  let runtimeManifest = await readManifest(runtimePath);
  if (!runtimeManifest.private) {
    entries.push({
      dir: runtimeDir,
      dirName: "web-tree-sitter",
      manifest: runtimeManifest,
      packagePath: runtimePath,
      kind: "runtime",
    });
  }

  return entries.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

async function checkManifests(entries) {
  let rootLicense = await readFile(path.join(root, "LICENSE"), "utf8");
  for (let entry of entries) {
    let { manifest, dir, packagePath } = entry;
    let relativePackage = relative(packagePath);

    if (!manifest.name?.startsWith("@codemirror-treesitter/")) {
      fail(`${relativePackage} must use the @codemirror-treesitter scope`);
    }
    if (manifest.private) fail(`${relativePackage} must not be private`);
    if (!manifest.version) fail(`${relativePackage} is missing version`);
    if (!manifest.description) fail(`${relativePackage} is missing description`);
    if (manifest.type != "module") fail(`${relativePackage} must be type: module`);
    if (!manifest.exports) fail(`${relativePackage} is missing exports`);
    if (!manifest.types) fail(`${relativePackage} is missing root types`);
    if (!manifest.files?.includes("dist") && entry.kind == "workspace") {
      fail(`${relativePackage} must include dist in files`);
    }
    if (manifest.repository?.url != repoUrl) {
      fail(`${relativePackage} repository.url must be ${repoUrl}`);
    }
    if (manifest.repository?.directory != relative(dir)) {
      fail(`${relativePackage} repository.directory must be ${relative(dir)}`);
    }
    if (!manifest.homepage?.includes(relative(dir))) {
      fail(`${relativePackage} homepage must point at the package README`);
    }
    if (manifest.bugs?.url != bugsUrl) fail(`${relativePackage} bugs.url must be ${bugsUrl}`);
    if (!Array.isArray(manifest.keywords) || manifest.keywords.length < 3) {
      fail(`${relativePackage} should include npm keywords`);
    }
    if (manifest.publishConfig?.access != "public") {
      fail(`${relativePackage} publishConfig.access must be public`);
    }

    if (entry.kind == "runtime") {
      if (manifest.license != "MIT") fail(`${relativePackage} runtime license must remain MIT`);
      if (manifest.version != runtimePackageVersion) {
        fail(`${relativePackage} runtime version must be ${runtimePackageVersion}`);
      }
    } else {
      if (manifest.license != "Apache-2.0") {
        fail(`${relativePackage} package license must match the Apache-2.0 root license`);
      }
      let licensePath = path.join(dir, "LICENSE");
      if (!existsSync(licensePath)) fail(`${relativePackage} package must include LICENSE`);
      else if ((await readFile(licensePath, "utf8")) != rootLicense) {
        fail(`${relativePackage} LICENSE must match the root LICENSE`);
      }
    }

    for (let [section, dependencies] of dependencySections(manifest)) {
      for (let [name, spec] of Object.entries(dependencies)) {
        let specText = String(spec);
        if (disallowedProtocol.test(specText)) {
          fail(`${relativePackage} ${section}.${name} uses non-publishable spec ${specText}`);
        }
        if (name.startsWith("@codemirror-treesitter/") && name != runtimePackageName) {
          if (specText != packageVersion) {
            fail(`${relativePackage} ${section}.${name} must use ${packageVersion}`);
          }
        }
        if (name == runtimePackageName && specText != runtimePackageVersion) {
          fail(`${relativePackage} ${section}.${name} must use ${runtimePackageVersion}`);
        }
      }
    }

    if (entry.kind == "workspace") {
      let distIndex = path.join(dir, "dist/index.mjs");
      if (!existsSync(distIndex)) {
        fail(`${relativePackage} is missing dist/index.mjs; run vp run -r build first`);
      }
    }
  }
}

async function checkPackedTarballs(entries) {
  for (let entry of entries) {
    let output = JSON.parse(exec("npm", ["pack", "--dry-run", "--json"], { cwd: entry.dir }))[0];
    let files = new Set(output.files.map((file) => file.path));
    if (!files.has("package.json")) fail(`${entry.manifest.name} tarball is missing package.json`);
    if (!files.has("README.md")) fail(`${entry.manifest.name} tarball is missing README.md`);
    if (!files.has("LICENSE")) fail(`${entry.manifest.name} tarball is missing LICENSE`);
    if (entry.kind == "workspace" && !files.has("dist/index.mjs")) {
      fail(`${entry.manifest.name} tarball is missing dist/index.mjs`);
    }
  }
}

async function runPackageLinters(entries) {
  for (let entry of entries) {
    exec(bin("publint"), [entry.dir], { cwd: root, stdio: "inherit" });

    let attwArgs = ["--pack", entry.dir, "--format", "ascii", "--no-emoji"];
    if (entry.kind == "runtime") {
      attwArgs.push(
        "--profile",
        "node16",
        "--exclude-entrypoints",
        "./web-tree-sitter.wasm",
        "./debug/web-tree-sitter.wasm",
      );
    } else {
      attwArgs.push("--profile", "esm-only");
    }
    if (entry.manifest.name == "@codemirror-treesitter/live-md") {
      attwArgs.push("--exclude-entrypoints", "./style.css");
    }
    exec(bin("attw"), attwArgs, { cwd: root, stdio: "inherit" });
  }
}

async function installAndSmoke(entries) {
  let tempDir = await mkdtemp(path.join(os.tmpdir(), "codemirror-treesitter-package-"));
  try {
    let packDir = path.join(tempDir, "tarballs");
    let consumerDir = path.join(tempDir, "consumer");
    await mkdir(packDir);
    await mkdir(consumerDir);

    let tarballs = [];
    for (let entry of entries) {
      let output = JSON.parse(
        exec("npm", ["pack", "--pack-destination", packDir, "--json"], { cwd: entry.dir }),
      )[0];
      tarballs.push(path.join(packDir, output.filename));
      await assertPackedManifest(path.join(packDir, output.filename), entry);
    }

    await writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }, null, 2),
    );
    exec(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...tarballs,
      ],
      { cwd: consumerDir, stdio: "inherit" },
    );

    await writeFile(
      path.join(consumerDir, "smoke.mjs"),
      `${entries.map((entry) => `await import(${JSON.stringify(entry.manifest.name)});`).join("\n")}
await import("@codemirror-treesitter/live-md/fixtures");
console.log("package import smoke passed");
`,
    );
    exec(process.execPath, ["smoke.mjs"], { cwd: consumerDir, stdio: "inherit" });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function assertPackedManifest(tarball, entry) {
  let packageJson = exec("tar", ["-xOf", tarball, "package/package.json"], { cwd: root });
  let manifest = JSON.parse(packageJson);
  for (let [section, dependencies] of dependencySections(manifest)) {
    for (let [name, spec] of Object.entries(dependencies)) {
      let specText = String(spec);
      if (disallowedProtocol.test(specText)) {
        fail(`${entry.manifest.name} packed ${section}.${name} uses ${specText}`);
      }
    }
  }
}

function dependencySections(manifest) {
  return ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]
    .filter((section) => manifest[section])
    .map((section) => [section, manifest[section]]);
}

async function sortedDirNames(dir) {
  return (await readdir(dir)).sort((a, b) => a.localeCompare(b));
}

async function readManifest(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function bin(name) {
  return path.join(
    root,
    "node_modules",
    ".bin",
    process.platform == "win32" ? `${name}.cmd` : name,
  );
}

function exec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function fail(message) {
  failures++;
  console.error(`fail: ${message}`);
}
