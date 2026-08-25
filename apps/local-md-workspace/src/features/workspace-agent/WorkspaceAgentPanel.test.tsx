// @vitest-environment happy-dom

import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createChat } from "@shadcn/helpers/ai-sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_WORKSPACE_AGENT_MODEL } from "@/lib/agent/providers/deepseek/config";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel";

type PanelProps = ComponentProps<typeof WorkspaceAgentPanel>;
type ReactActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

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
  it("keeps credentials in Settings and presents empty, locked, and loading states", async () => {
    let openSettings = vi.fn();
    await renderPanel({ hasApiKey: false, onOpenSettings: openSettings });

    expect(document.querySelector("input[type='password']")).toBeNull();
    expect(document.body.textContent).toContain("Save or unlock the encrypted key in Settings.");
    expect(document.activeElement).toBe(buttonNamed("Open settings"));
    act(() => buttonNamed("Open settings").click());
    expect(openSettings).toHaveBeenCalledOnce();

    await renderPanel({ credentialStored: true, hasApiKey: false });
    expect(document.body.textContent).toContain("API key locked");
    expect(document.querySelector("#workspace-agent-prompt")).toBeNull();

    await renderPanel({ credentialLoading: true, hasApiKey: false });
    expect(document.body.textContent).toContain("Checking secure storage…");
    expect(buttonNamed("Open settings").disabled).toBe(true);
  });

  it("renders safe activity, sends keyboard input, closes, and changes models", async () => {
    let close = vi.fn();
    let modelChange = vi.fn();
    let send = vi.fn(async () => true);
    await renderPanel({
      messages: agentMessages(),
      onClose: close,
      onModelChange: modelChange,
      onSend: send,
      sessions: [{ id: "session", status: "success", title: null }],
    });

    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("Done.");
    expect(document.body.textContent).toContain("Read file");
    expect(document.body.textContent).toContain("Complete");

    let prompt = await updatePrompt("Summarize the workspace");
    await act(async () => {
      prompt.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith("Summarize the workspace");
    expect(prompt.value).toBe("");

    let model = document.querySelector<HTMLSelectElement>("#workspace-agent-model")!;
    expect(model.value).toBe("deepseek-v4-flash");
    expect(Array.from(model.options, ({ value }) => value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    model.value = "deepseek-v4-pro";
    await act(async () => model.dispatchEvent(new Event("change", { bubbles: true })));
    expect(modelChange).toHaveBeenCalledWith("deepseek-v4-pro");

    act(() => {
      prompt.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("switches isolated transcripts and drafts with mouse or keyboard", async () => {
    await render(<SessionHarness />);
    let sessionA = sessionButton("Session A");
    let sessionB = sessionButton("Session B");

    expect(sessionA.textContent).toContain("Working…");
    expect(sessionB.textContent).toContain("Completed");
    expect(activeTranscript().textContent).toContain("B answer");
    expect(activeTranscript().textContent).not.toContain("A answer");
    await updatePrompt("draft B");

    act(() => sessionA.click());
    expect(activeTranscript().textContent).toContain("A answer");
    expect(document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt")?.value).toBe("");
    await updatePrompt("draft A");

    act(() => {
      sessionA.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }),
      );
    });
    expect(sessionB.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(sessionB);
    expect(activeTranscript().textContent).toContain("B answer");
    expect(document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt")?.value).toBe(
      "draft B",
    );

    act(() => sessionA.click());
    expect(document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt")?.value).toBe(
      "draft A",
    );
  });
});

async function renderPanel(overrides: Partial<PanelProps>) {
  let props: PanelProps = {
    activeSessionId: "session",
    credentialLoading: false,
    credentialStored: false,
    error: null,
    hasApiKey: true,
    messages: [],
    model: DEFAULT_WORKSPACE_AGENT_MODEL,
    open: true,
    sessions: [{ id: "session", status: "idle", title: null }],
    workspaceAvailable: true,
    onClose: vi.fn(),
    onModelChange: vi.fn(),
    onNewChat: vi.fn(),
    onOpenSettings: vi.fn(),
    onSelectSession: vi.fn(),
    onSend: vi.fn(async () => true),
    onStop: vi.fn(),
    ...overrides,
  };
  await render(<WorkspaceAgentPanel {...props} />);
}

function SessionHarness() {
  let [activeSessionId, setActiveSessionId] = useState("b");
  return (
    <WorkspaceAgentPanel
      activeSessionId={activeSessionId}
      credentialLoading={false}
      credentialStored={false}
      error={null}
      hasApiKey
      messages={sessionMessages(activeSessionId)}
      model={DEFAULT_WORKSPACE_AGENT_MODEL}
      open
      sessions={[
        { id: "a", status: "running", title: "Session A" },
        { id: "b", status: "success", title: "Session B" },
      ]}
      workspaceAvailable
      onClose={vi.fn()}
      onModelChange={vi.fn()}
      onNewChat={vi.fn()}
      onOpenSettings={vi.fn()}
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

function sessionMessages(id: string) {
  let name = id.toUpperCase();
  return createChat()
    .user(`${name} request`)
    .assistant(({ writer }) => writer.text(`${name} answer`))
    .get();
}

async function updatePrompt(value: string) {
  let prompt = document.querySelector<HTMLTextAreaElement>("#workspace-agent-prompt")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      prompt,
      value,
    );
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return prompt;
}

function sessionButton(title: string) {
  let button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-agent-session]"),
  ).find((candidate) => candidate.textContent?.includes(title));
  if (!button) throw new Error(`Session not found: ${title}`);
  return button;
}

function buttonNamed(name: string) {
  let button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() == name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function activeTranscript() {
  return document.querySelector<HTMLElement>("[role='log']")!;
}

async function render(element: React.ReactNode) {
  if (!root) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  }
  await act(async () => root?.render(<TooltipProvider>{element}</TooltipProvider>));
}
