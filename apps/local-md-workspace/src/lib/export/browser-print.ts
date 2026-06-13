export type BrowserPrintWindow = {
  close: () => void;
  document: Document;
  focus: () => void;
  opener?: unknown;
  print: () => void;
};

export type BrowserPrintEnvironment = {
  openWindow?: (url: string, target: string, features: string) => BrowserPrintWindow | null;
  setTimeout?: typeof setTimeout;
  window?: Window;
};

export type StandaloneHtmlPrintViewOptions = {
  environment?: BrowserPrintEnvironment;
  resourceWaitMs?: number;
  title: string;
};

export type StandaloneHtmlPrintView = {
  close: () => void;
  printHtml: (html: string) => Promise<void>;
};

const printWindowFeatures = "popup,width=980,height=720";
const defaultResourceWaitMs = 3_000;

export function openStandaloneHtmlPrintView({
  environment,
  resourceWaitMs = defaultResourceWaitMs,
  title,
}: StandaloneHtmlPrintViewOptions): StandaloneHtmlPrintView {
  let printWindow = openPrintWindow(environment);
  if (!printWindow) throw new Error("Allow popups to open the print view.");

  try {
    printWindow.opener = null;
  } catch {
    // Some browsers expose opener as readonly.
  }

  writePrintPreparingDocument(printWindow.document, title);

  return {
    close() {
      printWindow.close();
    },
    async printHtml(html: string) {
      writePrintDocument(printWindow.document, html);
      installPrintControls(printWindow, title);
      await waitForPrintResources(printWindow.document, resourceWaitMs, environment);
      printWindow.focus();
      printWindow.print();
    },
  };
}

function openPrintWindow(environment: BrowserPrintEnvironment | undefined) {
  let openWindow =
    environment?.openWindow ??
    ((url: string, target: string, features: string) =>
      (environment?.window ?? globalThis.window).open(url, target, features));
  return openWindow("about:blank", "_blank", printWindowFeatures);
}

function writePrintPreparingDocument(document: Document, title: string) {
  document.open();
  document.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #111827;
      color: #f9fafb;
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
  </style>
</head>
<body>
  <div>Preparing print view...</div>
</body>
</html>`);
  document.close();
}

function writePrintDocument(document: Document, html: string) {
  document.open();
  document.write(html);
  document.close();
}

function installPrintControls(printWindow: BrowserPrintWindow, title: string) {
  let { document } = printWindow;
  let style = document.createElement("style");
  style.setAttribute("data-local-md-print-controls", "true");
  style.textContent = printControlsCss();
  document.head.append(style);

  let toolbar = document.createElement("div");
  toolbar.className = "local-md-print-toolbar";
  toolbar.setAttribute("data-local-md-print-controls", "true");

  let label = document.createElement("div");
  label.className = "local-md-print-title";
  label.textContent = title;

  let printButton = document.createElement("button");
  printButton.type = "button";
  printButton.textContent = "Print";
  printButton.addEventListener("click", () => {
    printWindow.focus();
    printWindow.print();
  });

  let closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => printWindow.close());

  toolbar.append(label, printButton, closeButton);
  document.body.append(toolbar);
}

async function waitForPrintResources(
  document: Document,
  resourceWaitMs: number,
  environment: BrowserPrintEnvironment | undefined,
) {
  if (resourceWaitMs <= 0) return;

  await Promise.race([
    Promise.all([waitForFonts(document), waitForImages(document)]).then(() => undefined),
    delay(resourceWaitMs, environment),
  ]);
}

function waitForFonts(document: Document) {
  return (
    document.fonts?.ready.then(
      () => undefined,
      () => undefined,
    ) ?? Promise.resolve()
  );
}

function waitForImages(document: Document) {
  let images = Array.from(document.images);
  if (!images.length) return Promise.resolve();

  return Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  ).then(() => undefined);
}

function delay(milliseconds: number, environment: BrowserPrintEnvironment | undefined) {
  return new Promise<void>((resolve) => {
    (environment?.setTimeout ?? setTimeout)(resolve, milliseconds);
  });
}

function printControlsCss() {
  return `@media screen {
  .local-md-print-toolbar,
  .local-md-print-toolbar * {
    box-sizing: border-box;
  }

  .local-md-print-toolbar {
    all: initial;
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(420px, calc(100vw - 32px));
    padding: 8px;
    border: 1px solid rgba(15, 23, 42, 0.16);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 16px 36px rgba(15, 23, 42, 0.18);
    color: #111827;
    font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .local-md-print-title {
    min-width: 0;
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #374151;
  }

  .local-md-print-toolbar button {
    all: initial;
    cursor: pointer;
    border-radius: 6px;
    padding: 5px 9px;
    background: #111827;
    color: #ffffff;
    font: inherit;
  }

  .local-md-print-toolbar button + button {
    background: #f3f4f6;
    color: #111827;
  }
}

@media print {
  .local-md-print-toolbar {
    display: none !important;
  }
}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
