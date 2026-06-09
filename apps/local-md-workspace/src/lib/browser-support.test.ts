import { describe, expect, it } from "vite-plus/test";
import { isMobileBrowser, localFolderAccessUnavailableMessage } from "./browser-support.ts";

describe("browser support messaging", () => {
  it("detects common mobile browser environments", () => {
    expect(isMobileBrowser({ userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile" })).toBe(true);
    expect(isMobileBrowser({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" })).toBe(true);
    expect(
      isMobileBrowser({
        maxTouchPoints: 5,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe(true);
  });

  it("keeps desktop browser environments on the desktop message", () => {
    expect(
      isMobileBrowser({
        maxTouchPoints: 0,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe(false);
  });

  it("recommends Google Chrome only for mobile users", () => {
    expect(
      localFolderAccessUnavailableMessage({
        userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile",
      }),
    ).toContain("Google Chrome");
    expect(
      localFolderAccessUnavailableMessage({
        maxTouchPoints: 0,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toContain("Chromium browser");
  });
});
