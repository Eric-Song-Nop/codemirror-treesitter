import { spawnSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/live-md/tests/incremental-parity-matrix.probe.ts");
const target = resolve(root, "packages/live-md/tests/.incremental-parity-matrix.generated.test.ts");

copyFileSync(source, target);

try {
  let result = spawnSync(
    "vp",
    [
      "run",
      "@codemirror-treesitter/live-md#test",
      "--",
      ".incremental-parity-matrix.generated.test.ts",
    ],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(target, { force: true });
}
