import { describe, expect, it } from "vite-plus/test";
import sourceConfig from "../wrangler.jsonc?raw";
import apiOnlyConfig from "../wrangler.worker.jsonc?raw";

describe("Wrangler configuration", () => {
  it("keeps the API-only deploy config in sync apart from main and assets", () => {
    let { assets, main: sourceMain, ...source } = parseJsonc(sourceConfig);
    let { main: apiMain, ...apiOnly } = parseJsonc(apiOnlyConfig);

    expect(sourceMain).toBe("./src/worker.ts");
    expect(apiMain).toBe("./dist/collab_editor/index.js");
    expect(assets).toMatchObject({ run_worker_first: ["/api/*"] });
    expect(apiOnly).toEqual(source);
  });
});

function parseJsonc(text: string): Record<string, unknown> {
  let output = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    let char = text[index]!;
    if (inString) {
      output += char;
      if (char == "\\") output += text[++index] ?? "";
      else if (char == '"') inString = false;
    } else if (char == '"') {
      inString = true;
      output += char;
    } else if (char == "/" && text[index + 1] == "/") {
      while (index < text.length && text[index] != "\n") index++;
      output += "\n";
    } else if (char == "/" && text[index + 1] == "*") {
      index = text.indexOf("*/", index + 2) + 1;
    } else {
      output += char;
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
}
