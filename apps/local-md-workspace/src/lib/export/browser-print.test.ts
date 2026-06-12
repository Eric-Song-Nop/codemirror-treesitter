// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vite-plus/test";
import { openStandaloneHtmlPrintView, type BrowserPrintWindow } from "./browser-print.ts";

describe("browser print export", () => {
  it("throws a clear error when the print window is blocked", () => {
    expect(() =>
      openStandaloneHtmlPrintView({
        environment: {
          openWindow: () => null,
        },
        title: "Today",
      }),
    ).toThrow("Allow popups to open the print view.");
  });

  it("opens a preparing document before standalone HTML is ready", () => {
    let printWindow = createPrintWindow();

    openStandaloneHtmlPrintView({
      environment: {
        openWindow: () => printWindow,
      },
      title: "Today <draft>",
    });

    expect(printWindow.document.title).toBe("Today <draft>");
    expect(printWindow.document.body.textContent).toContain("Preparing print view...");
    expect(printWindow.opener).toBeNull();
  });

  it("writes standalone HTML, installs print controls, and prints", async () => {
    let printWindow = createPrintWindow();
    let printView = openStandaloneHtmlPrintView({
      environment: {
        openWindow: () => printWindow,
      },
      resourceWaitMs: 0,
      title: "Today",
    });

    await printView.printHtml(
      '<!doctype html><html><head><title>Export</title></head><body><main class="live-md-document">Body</main></body></html>',
    );

    expect(printWindow.document.title).toBe("Export");
    expect(printWindow.document.querySelector(".live-md-document")?.textContent).toBe("Body");
    expect(printWindow.document.querySelector(".local-md-print-toolbar")).not.toBeNull();
    expect(
      printWindow.document.querySelector("style[data-local-md-print-controls]")?.textContent,
    ).toContain("@media print");
    expect(
      printWindow.document.querySelector("style[data-local-md-print-controls]")?.textContent,
    ).toContain("display: none !important");
    expect(printWindow.focus).toHaveBeenCalled();
    expect(printWindow.print).toHaveBeenCalled();
  });

  it("keeps fallback print and close controls wired", async () => {
    let printWindow = createPrintWindow();
    let printView = openStandaloneHtmlPrintView({
      environment: {
        openWindow: () => printWindow,
      },
      resourceWaitMs: 0,
      title: "Today",
    });

    await printView.printHtml("<!doctype html><html><body><main>Body</main></body></html>");

    let buttons = Array.from(printWindow.document.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Print", "Close"]);

    buttons[0]!.click();
    expect(printWindow.print).toHaveBeenCalledTimes(2);

    buttons[1]!.click();
    expect(printWindow.close).toHaveBeenCalledTimes(1);
  });
});

function createPrintWindow(): BrowserPrintWindow {
  return {
    close: vi.fn(),
    document: document.implementation.createHTMLDocument(""),
    focus: vi.fn(),
    opener: {},
    print: vi.fn(),
  };
}
