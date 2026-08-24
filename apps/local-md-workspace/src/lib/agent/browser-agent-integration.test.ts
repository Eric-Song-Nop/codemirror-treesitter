// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import { runWorkspaceAgentBrowserIntegration } from "../../../smoke/agent-integration.ts";

describe("browser Agent integration", () => {
  it("runs a fake model edit through the bound CodeMirror and main Loro peer", async () => {
    let result = await runWorkspaceAgentBrowserIntegration();

    expect(result).toMatchObject({
      editorValue: "# Browser Agent\n\nafter\n",
      localUpdates: 1,
      loroValue: "# Browser Agent\n\nafter\n",
      persistedValue: "# Browser Agent\n\nafter\n",
      response: "Updated the open document.",
      standaloneBlocked: true,
      switchedWriteReason: "active-document-unavailable",
      toolNames: ["read_markdown", "apply_current_document_edits"],
      userEvents: ["input.agent"],
    });
  });
});
