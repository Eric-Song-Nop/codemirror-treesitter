// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import { runWorkspaceAgentBrowserIntegration } from "../../../smoke/agent-integration.ts";

describe("browser Agent integration", () => {
  it("runs a fake model edit through the workspace collaborative document", async () => {
    let result = await runWorkspaceAgentBrowserIntegration();

    expect(result).toMatchObject({
      editorValue: "# Browser Agent\n\nafter\n",
      localUpdates: 1,
      loroValue: "# Browser Agent\n\nafter\n",
      persistedValue: "# Browser Agent\n\nafter\n",
      response: "Updated the workspace document.",
      standaloneBlocked: true,
      toolNames: ["read_file", "write_file"],
      unselectedValue: "unselected",
    });
  });
});
