import { describe, expect, it } from "vite-plus/test";
import {
  createInitialDocument,
  projectUrl,
  shouldSeedInitialDocument,
} from "./initial-document.ts";

describe("collab editor initial document", () => {
  it("explains the project and hash share link", () => {
    let document = createInitialDocument("https://example.com/#Ab3kP9qLm2xZ");

    expect(document).toContain(projectUrl);
    expect(document).toContain("https://example.com/#Ab3kP9qLm2xZ");
    expect(document).toContain("Share this link to collaborate");
  });

  it("only seeds a generated empty room without a local snapshot", () => {
    expect(
      shouldSeedInitialDocument({
        docValue: "",
        editorValue: "",
        generatedRoom: true,
        hasLocalSnapshot: false,
      }),
    ).toBe(true);

    expect(
      shouldSeedInitialDocument({
        docValue: "# Existing",
        editorValue: "",
        generatedRoom: true,
        hasLocalSnapshot: false,
      }),
    ).toBe(false);

    expect(
      shouldSeedInitialDocument({
        docValue: "",
        editorValue: "",
        generatedRoom: true,
        hasLocalSnapshot: true,
      }),
    ).toBe(false);
  });
});
