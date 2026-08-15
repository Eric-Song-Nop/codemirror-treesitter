// @vitest-environment happy-dom

import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { renderLiveMdMermaidResult } from "../src/core/mermaid.js";

const childMode = process.env.LIVE_MD_MERMAID_SECURITY_CHILD == "1";
const workspaceDirectory =
  basename(process.cwd()) == "live-md" ? resolve(process.cwd(), "../..") : process.cwd();
const ganttExcludingEveryDay = [
  "gantt",
  "  excludes monday,tuesday,wednesday,thursday,friday,saturday,sunday",
  "  DoS :2025-01-01, 1d",
].join("\n");

describe("Mermaid security regressions", () => {
  if (childMode) {
    it("bounds Gantt rendering when every date is excluded", async () => {
      let result = await renderLiveMdMermaidResult(ganttExcludingEveryDay);

      if (result.ok) {
        expect(result.svg).toContain("cm-md-mermaid-");
      } else {
        // happy-dom does not implement every SVG geometry API Mermaid needs. A bounded
        // render error is acceptable here; the security invariant is that rendering returns.
        expect(result.message).toBeTruthy();
      }
    });
    return;
  }

  it("does not hang in the official renderer fallback", async () => {
    let result = await runSecurityRegressionInSubprocess();

    expect(result.timedOut, result.output).toBe(false);
    expect(result.exitCode, result.output).toBe(0);
  });
});

async function runSecurityRegressionInSubprocess() {
  let child = spawn(
    "vp",
    [
      "test",
      "run",
      "packages/live-md/tests/mermaid-security.test.ts",
      "--config",
      "packages/live-md/vite.config.ts",
    ],
    {
      cwd: workspaceDirectory,
      detached: process.platform != "win32",
      env: {
        ...process.env,
        LIVE_MD_MERMAID_SECURITY_CHILD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  let timedOut = false;
  let timer = setTimeout(() => {
    timedOut = true;
    killSubprocess(child.pid);
  }, 8_000);

  let exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timer);
  return { exitCode, output, timedOut };
}

function killSubprocess(pid: number | undefined) {
  if (pid == null) return;
  if (process.platform == "win32") {
    process.kill(pid, "SIGKILL");
  } else {
    process.kill(-pid, "SIGKILL");
  }
}
