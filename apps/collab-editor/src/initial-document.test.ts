import { describe, expect, it } from "vite-plus/test";
import { createInitialDocument, projectUrl } from "./initial-document.ts";

describe("collab editor initial document", () => {
  it("explains the project and share link", () => {
    let link = "https://example.com/#share=AAAAAAAAAAAAAAAAAAAAAA&key=secret";
    let document = createInitialDocument(link);

    expect(document).toContain(projectUrl);
    expect(document).toContain(link);
    expect(document).toContain("Share this link to collaborate");
    expect(document).toContain("expire after 7 days");
  });
});
