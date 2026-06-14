// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { prepareLiveMd } from "../src/index.js";

let locationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("prepareLiveMd", () => {
  it("preloads Markdown support and LiveMD decoration queries", async () => {
    await expect(prepareLiveMd()).resolves.toBeUndefined();
    await expect(prepareLiveMd()).resolves.toBeUndefined();
  });

  it("can preload code-fence languages when requested", async () => {
    await expect(prepareLiveMd({ codeFences: true })).resolves.toBeUndefined();
  });
});
