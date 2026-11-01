import { describe, expect, it } from "vite-plus/test";
import sourceConfig from "../wrangler.jsonc?raw";
import ciConfig from "../wrangler.worker.ci.jsonc?raw";

describe("Wrangler configuration", () => {
  it("keeps the CI config identical to wrangler.jsonc apart from main and routes", () => {
    let { main: sourceMain, routes, ...source } = parseJsonc(sourceConfig);
    let { main: ciMain, ...ci } = parseJsonc(ciConfig);

    expect(sourceMain).toBe("./src/worker.ts");
    expect(routes).toEqual([
      { custom_domain: true, pattern: "relay.grovemd.net", zone_name: "grovemd.net" },
    ]);
    expect(ciMain).toBe("./dist/grove_relay/index.js");
    expect(ci).toEqual(source);
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
