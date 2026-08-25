// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createChat } from "@shadcn/helpers/ai-sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_WORKSPACE_AGENT_MODEL } from "@/lib/agent/providers/deepseek/config";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel";

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as ReactActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkspaceAgentPanel", () => {
  it("moves a submitted API key out of the DOM and keeps it in the controller callback", async () => {
    let configure = vi.fn();
    await render(<KeyConfigurationHarness onConfigure={configure} />);
    let input = document.querySelector<HTMLInputElement>("#workspace-agent-api-key")!;
    let secret = "sk-browser-memory-only";

    input.value = secret;
    await act(async () => {
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(configure).toHaveBeenCalledWith({ apiKey: secret });
    expect(document.querySelector("#workspace-agent-api-key")).toBeNull();
    expect(document.body.textContent).not.toContain(secret);
    expect(document.body.textContent).toContain("API key ready for this tab");
  });

  it("renders message content as text, shows the activity ledger, and sends with Enter", async () => {
    let send = vi.fn(async () => true);
    let close = vi.fn();
    await render(
      <WorkspaceAgentPanel
        error={null}
        hasApiKey
        messages={agentMessages()}
        model={DEFAULT_WORKSPACE_AGENT_MODEL}
        open
        runStatus="success"
        workspaceAvailable
        onClose={close}
        onConfigure={vi.fn()}
        onNewChat={vi.fn()}
        onSend={send}
        onStop={vi.fn()}
      />,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("Done.");
    expect(document.body.textContent).toContain("Read file");
    expect(document.body.textContent).toContain("Complete");

    let prompt = document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        prompt,
        "Summarize the workspace",
      );
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      prompt.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
      );
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith("Summarize the workspace");
    expect(prompt.value).toBe("");

    act(() => {
      prompt.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
      );
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows every session and requests a switch without mixing the active transcript", async () => {
    let selectSession = vi.fn();
    await render(
      <WorkspaceAgentPanel
        activeSessionId="b"
        error={null}
        hasApiKey
        messages={sessionMessages("B")}
        model={DEFAULT_WORKSPACE_AGENT_MODEL}
        open
        runStatus="success"
        sessions={sessionSummaries}
        workspaceAvailable
        onClose={vi.fn()}
        onConfigure={vi.fn()}
        onNewChat={vi.fn()}
        onSelectSession={selectSession}
        onSend={vi.fn(async () => true)}
        onStop={vi.fn()}
      />,
    );

    let sessionA = sessionButton("Session A");
    let sessionB = sessionButton("Session B");
    expect(sessionA.textContent).toContain("Working…");
    expect(sessionB.textContent).toContain("Completed");
    expect(sessionA.hasAttribute("aria-current")).toBe(false);
    expect(sessionB.getAttribute("aria-current")).toBe("true");

    let log = document.querySelector<HTMLElement>("[role='log']")!;
    expect(log.getAttribute("aria-label")).toBe("Messages in Session B");
    expect(log.textContent).toContain("B request");
    expect(log.textContent).toContain("B answer");
    expect(log.textContent).not.toContain("A request");
    expect(log.textContent).not.toContain("A answer");

    act(() => sessionA.click());
    expect(selectSession).toHaveBeenCalledOnce();
    expect(selectSession).toHaveBeenCalledWith("a");
  });

  it("switches transcripts and preserves a separate prompt draft for each session", async () => {
    await render(<SessionSwitchHarness />);

    expect(sessionButton("Session B").getAttribute("aria-current")).toBe("true");
    expect(activeTranscript().textContent).toContain("B answer");
    expect(activeTranscript().textContent).not.toContain("A answer");
    await updatePrompt("draft for B");

    act(() => sessionButton("Session A").click());
    expect(sessionButton("Session A").getAttribute("aria-current")).toBe("true");
    expect(activeTranscript().textContent).toContain("A answer");
    expect(activeTranscript().textContent).not.toContain("B answer");
    expect(document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt")?.value).toBe("");
    await updatePrompt("draft for A");

    await act(async () => {
      sessionButton("Session A").dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowDown",
        }),
      );
    });
    expect(sessionButton("Session B").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(sessionButton("Session B"));
    expect(activeTranscript().textContent).toContain("B answer");
    expect(document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt")?.value).toBe(
      "draft for B",
    );

    await act(async () => {
      sessionButton("Session B").dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowUp",
        }),
      );
    });
    expect(sessionButton("Session A").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(sessionButton("Session A"));
    expect(activeTranscript().textContent).toContain("A answer");
    expect(document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt")?.value).toBe(
      "draft for A",
    );
  });

  it("defaults to V4 Flash and allows switching to V4 Pro", async () => {
    let configure = vi.fn();
    await render(
      <WorkspaceAgentPanel
        error={null}
        hasApiKey
        messages={[]}
        model={DEFAULT_WORKSPACE_AGENT_MODEL}
        open
        runStatus="idle"
        workspaceAvailable
        onClose={vi.fn()}
        onConfigure={configure}
        onNewChat={vi.fn()}
        onSend={vi.fn(async () => true)}
        onStop={vi.fn()}
      />,
    );
    let model = document.querySelector<HTMLSelectElement>("#workspace-agent-model")!;
    expect(model.value).toBe("deepseek-v4-flash");
    expect(Array.from(model.options, (option) => option.value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    model.value = "deepseek-v4-pro";

    await act(async () => model.dispatchEvent(new Event("change", { bubbles: true })));

    expect(configure).toHaveBeenCalledWith({ model: "deepseek-v4-pro" });
  });
});

function KeyConfigurationHarness({ onConfigure }: { onConfigure: (value: unknown) => void }) {
  let [hasApiKey, setHasApiKey] = useState(false);
  return (
    <WorkspaceAgentPanel
      error={null}
      hasApiKey={hasApiKey}
      messages={[]}
      model={DEFAULT_WORKSPACE_AGENT_MODEL}
      open
      runStatus="idle"
      workspaceAvailable
      onClose={vi.fn()}
      onConfigure={(input) => {
        onConfigure(input);
        if (input.apiKey) setHasApiKey(true);
      }}
      onNewChat={vi.fn()}
      onSend={vi.fn(async () => true)}
      onStop={vi.fn()}
    />
  );
}

function SessionSwitchHarness() {
  let [activeSessionId, setActiveSessionId] = useState("b");
  return (
    <WorkspaceAgentPanel
      activeSessionId={activeSessionId}
      error={null}
      hasApiKey
      messages={sessionMessages(activeSessionId == "a" ? "A" : "B")}
      model={DEFAULT_WORKSPACE_AGENT_MODEL}
      open
      runStatus="idle"
      sessions={draftSessionSummaries}
      workspaceAvailable
      onClose={vi.fn()}
      onConfigure={vi.fn()}
      onNewChat={vi.fn()}
      onSelectSession={setActiveSessionId}
      onSend={vi.fn(async () => true)}
      onStop={vi.fn()}
    />
  );
}

function agentMessages() {
  return createChat()
    .user("Please inspect this note.")
    .assistant(({ writer }) => {
      writer.tool("read_file", { input: {}, output: { status: "success" } });
      writer.text('<img src="x" onerror="alert(1)"> Done.');
    })
    .get();
}

function sessionMessages(session: "A" | "B") {
  return createChat()
    .user(`${session} request`)
    .assistant(({ writer }) => writer.text(`${session} answer`))
    .get();
}

function sessionButton(title: string) {
  let button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-agent-session]"),
  ).find((candidate) => candidate.textContent?.includes(title));
  if (!button) throw new Error(`Agent session button was not found: ${title}`);
  return button;
}

function activeTranscript() {
  let log = document.querySelector<HTMLElement>("[role='log']");
  if (!log) throw new Error("The active Agent transcript was not found.");
  return log;
}

async function updatePrompt(value: string) {
  let prompt = document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt");
  if (!prompt) throw new Error("The Agent prompt was not found.");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      prompt,
      value,
    );
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function render(element: React.ReactNode) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(<TooltipProvider>{element}</TooltipProvider>);
  });
}

const sessionSummaries = [
  { id: "a", status: "running", title: "Session A" },
  { id: "b", status: "success", title: "Session B" },
] as const;

const draftSessionSummaries = [
  { id: "a", status: "idle", title: "Session A" },
  { id: "b", status: "idle", title: "Session B" },
] as const;
