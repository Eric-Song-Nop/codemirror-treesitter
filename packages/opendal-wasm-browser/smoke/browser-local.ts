import {
  defaultOpendalBrowserRuntimeOptions,
  openOpendalBrowserOperator,
  type OpendalExactBrowserOperator,
} from "../src/index.js";

let output = document.querySelector<HTMLElement>("#output")!;
void run();

async function run() {
  let storageRoot = await navigator.storage.getDirectory();
  let fixtureName = `opendal-browser-local-${crypto.randomUUID()}`;
  let fixture = await storageRoot.getDirectoryHandle(fixtureName, { create: true });
  let operator: OpendalExactBrowserOperator | null = null;

  try {
    operator = await openOpendalBrowserOperator(
      { kind: "browser-local", rootHandle: fixture },
      defaultOpendalBrowserRuntimeOptions(),
    );
    let bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);

    await operator.createDirectory("notes/nested");
    let write = await operator.write({ bytes, path: "notes/nested/data.bin" });
    let read = await operator.read("notes/nested/data.bin");
    let stat = await operator.stat("notes/nested/data.bin");
    let entries = await operator.list("notes/nested");
    let traversalRejected = false;
    try {
      await operator.read("../outside.bin");
    } catch {
      traversalRejected = true;
    }
    let deletion = await operator.delete({ path: "notes", recursive: true });

    let result = {
      bytesRoundTrip: equalBytes(bytes, read.bytes),
      capabilities: operator.info.capabilities,
      deletion,
      entries,
      read,
      stat,
      traversalRejected,
      write,
    };
    if (
      !result.bytesRoundTrip ||
      !result.traversalRejected ||
      result.deletion.status != "applied" ||
      result.entries.length != 1
    ) {
      throw new Error(`BrowserLocal smoke assertion failed: ${JSON.stringify(result)}`);
    }
    output.dataset.state = "passed";
    output.textContent = JSON.stringify(result, byteJsonReplacer, 2);
  } catch (error) {
    output.dataset.state = "failed";
    output.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    operator?.dispose();
    await storageRoot.removeEntry(fixtureName, { recursive: true }).catch(() => {});
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.byteLength == b.byteLength && a.every((value, index) => value == b[index]);
}

function byteJsonReplacer(_key: string, value: unknown) {
  return value instanceof Uint8Array ? [...value] : value;
}
