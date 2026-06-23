import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "web-tree-sitter";
const packageVersion = "0.26.9";
const expectedTarballIntegrity =
  "sha512-YJwSHANl6XFgeEjB8nitgj0qZYt5gkIesJ4w2srS2wcLB4GUa4xcOkM0YaMsU6WNR53YVIkDSY7Ej4pf3IXtCA==";
const expectedTarballShasum = "9e44cb876c68082a2129ee8aee20ee8b702d286b";
const expectedPatchedWasmSha256 = new Map([
  ["web-tree-sitter.wasm", "406176f41f9602138365088fb78b65abb892277ef19023d139b1d70c13097b53"],
  [
    "debug/web-tree-sitter.wasm",
    "fdf4e1db477e25278144b2bf667dde856ca88240223f9e5ea0c82cd52c6da635",
  ],
]);

let tempDir = await mkdtemp(path.join(os.tmpdir(), "web-tree-sitter-verify-"));

try {
  let tarball = packCleanPackage(tempDir);
  await verifyTarball(tarball);

  execFileSync("tar", ["-xzf", tarball, "-C", tempDir], { stdio: "inherit" });
  let cleanPackageRoot = path.join(tempDir, "package");
  execFileSync(
    process.execPath,
    [
      path.join(root, "tools/patch-web-tree-sitter-cursor-range.mjs"),
      "--package-root",
      cleanPackageRoot,
    ],
    { cwd: root, stdio: "inherit" },
  );

  await verifyPatchedPackage(cleanPackageRoot);
  await verifyPatchedPackage(path.join(root, "vendor/web-tree-sitter"));
  console.log("web-tree-sitter cursor range patch verification passed");
} finally {
  await rm(tempDir, { force: true, recursive: true });
}

function packCleanPackage(destination) {
  let output = execFileSync(
    "npm",
    ["pack", `${packageName}@${packageVersion}`, "--pack-destination", destination],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
  let filename = output.split(/\r?\n/).at(-1);
  if (!filename) throw new Error("npm pack did not report a tarball filename");
  return path.join(destination, filename);
}

async function verifyTarball(tarball) {
  let buffer = await readFile(tarball);
  let integrity = `sha512-${hash(buffer, "sha512", "base64")}`;
  if (integrity != expectedTarballIntegrity) {
    throw new Error(`unexpected ${packageName}@${packageVersion} integrity: ${integrity}`);
  }
  let shasum = hash(buffer, "sha1", "hex");
  if (shasum != expectedTarballShasum) {
    throw new Error(`unexpected ${packageName}@${packageVersion} shasum: ${shasum}`);
  }
}

async function verifyPatchedPackage(packageRoot) {
  for (let [file, expected] of expectedPatchedWasmSha256) {
    let actual = hash(await readFile(path.join(packageRoot, file)), "sha256", "hex");
    if (actual != expected) {
      throw new Error(
        `${path.relative(root, packageRoot)}/${file}: expected ${expected}, saw ${actual}`,
      );
    }
  }
}

function hash(buffer, algorithm, encoding) {
  return createHash(algorithm).update(buffer).digest(encoding);
}
