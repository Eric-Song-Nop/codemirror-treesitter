import { describe, expect, it } from "vite-plus/test";
import { LSPClient, type Transport } from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };

class MockTransport implements Transport {
  sent: any[] = [];
  handlers: ((value: string) => void)[] = [];

  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  subscribe(handler: (value: string) => void) {
    this.handlers.push(handler);
  }
  unsubscribe(handler: (value: string) => void) {
    this.handlers = this.handlers.filter((h) => h != handler);
  }
  receive(message: unknown) {
    let text = typeof message == "string" ? message : JSON.stringify(message);
    for (let h of this.handlers) h(text);
  }
  respondToInitialize() {
    let init = this.sent.find((m) => m.method == "initialize");
    this.receive({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } });
  }
}

function setup(timeout = 3000) {
  let errors: Error[] = [];
  let client = new LSPClient({ timeout, onError: (_client, error) => errors.push(error) });
  let transport = new MockTransport();
  client.connect(transport);
  return { client, transport, errors };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LSPClient transport handling", () => {
  it("identifies itself with this package's name and version", () => {
    let { transport } = setup();
    let init = transport.sent.find((m) => m.method == "initialize");
    expect(init.params.clientInfo).toEqual({
      name: "@codemirror-treesitter/lsp-client",
      version: packageJson.version,
    });
  });

  it("rejects in-flight and later requests after disconnect", async () => {
    let { client, transport } = setup();
    transport.respondToInitialize();
    await client.initializing;
    let pending = client.request("textDocument/hover", {});
    await tick();
    expect(transport.sent.some((m) => m.method == "textDocument/hover")).toBe(true);

    client.disconnect();
    expect(client.connected).toBe(false);
    await expect(pending).rejects.toThrow("Client disconnected");
    await expect(client.request("textDocument/hover", {})).rejects.toThrow("Client not connected");
    expect(transport.handlers).toHaveLength(0);
  });

  it("rejects requests waiting on initialization when disconnected", async () => {
    let { client, transport } = setup();
    let pending = client.request("textDocument/hover", {});
    client.disconnect();
    await expect(pending).rejects.toThrow("Client disconnected");
    expect(transport.sent.some((m) => m.method == "textDocument/hover")).toBe(false);
  });

  // Vitest fails the run on unhandled rejections, so this also guards
  // against the initialize failure leaking through the notification chain.
  it("reports initialize failures once and drops later notifications", async () => {
    let { client, transport, errors } = setup(10);
    client.notification("textDocument/didChange", {});
    client.notification("$/cancelRequest", { id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(errors.map((e) => e.message)).toEqual(["LSP initialize failed: Request timed out"]);
    expect(transport.sent.map((m) => m.method)).toEqual(["initialize"]);
    await expect(client.initializing).rejects.toThrow("Request timed out");
  });

  it("drops malformed frames through the error callback", async () => {
    let { client, transport, errors } = setup();
    transport.receive("{not json");
    transport.receive("42");
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toMatch(/^Dropped malformed LSP message/);
    expect(errors[1].message).toMatch(/expected a JSON-RPC object/);

    transport.respondToInitialize();
    await expect(client.initializing).resolves.toBeNull();
  });
});
