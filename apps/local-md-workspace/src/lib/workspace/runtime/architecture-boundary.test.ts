import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const srcRoot = fileURLToPath(new URL("../../..", import.meta.url));
const libRoot = join(srcRoot, "lib");

describe("workspace architecture boundary", () => {
  it("keeps domain modules out of the lib root", async () => {
    let rootModules = (await readdir(libRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
      .map((entry) => entry.name)
      .toSorted();

    expect(rootModules).toEqual(["i18n.tsx", "query-client.ts", "utils.ts"]);
  });

  it("keeps raw object storage and operator hosts out of React modules", async () => {
    let files = [
      ...(await sourceFiles(join(srcRoot, "components"))),
      ...(await sourceFiles(join(srcRoot, "hooks"))),
    ];
    let violations: string[] = [];

    for (let file of files) {
      let source = await readFile(file, "utf8");
      if (/opendal-workspace-object-store|opendal-operator-host/.test(source)) {
        violations.push(file.slice(srcRoot.length + 1));
      }
    }

    expect(violations).toEqual([]);
  });

  it("does not restore the removed broad workspace backend", async () => {
    let files = await sourceFiles(srcRoot);
    let violations: string[] = [];

    for (let file of files) {
      let relative = file.slice(srcRoot.length + 1);
      if (relative.endsWith("architecture-boundary.test.ts")) continue;
      let source = await readFile(file, "utf8");
      if (/WorkspaceBackend|workspace-backend/.test(source)) violations.push(relative);
    }

    expect(violations).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  let files: string[] = [];
  for (let entry of await readdir(root, { withFileTypes: true })) {
    let path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}
