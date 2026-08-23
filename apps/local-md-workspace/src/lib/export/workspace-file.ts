import type { TFunction } from "@/lib/i18n";

export function htmlExportTitle(fileName: string, t: TFunction) {
  return (
    fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() ||
    t("defaults.markdownExportTitle")
  );
}

export function htmlExportFileName(fileName: string, t: TFunction) {
  let baseName = fileName.replace(/\.md$/i, "").trim() || t("defaults.markdownExportFileName");
  return `${sanitizeExportFileName(baseName, t)}.html`;
}

export function markdownHtmlExportWarningMessage(count: number, t: TFunction) {
  return count == 1
    ? t("errors.markdownHtmlExportWarning_one")
    : t("errors.markdownHtmlExportWarning_other", { count });
}

export function markdownPrintWarningMessage(count: number, t: TFunction) {
  return count == 1
    ? t("errors.markdownPrintWarning_one")
    : t("errors.markdownPrintWarning_other", { count });
}

export function downloadTextFile(fileName: string, value: string, type: string) {
  let blob = new Blob([value], { type });
  let url = URL.createObjectURL(blob);
  let anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sanitizeExportFileName(value: string, t: TFunction) {
  let sanitized = "";
  for (let character of value) {
    sanitized +=
      character.charCodeAt(0) < 32 || invalidExportFileNameCharacters.has(character)
        ? "-"
        : character;
  }
  return sanitized.replace(/-+/g, "-").replace(/^-+|-+$/g, "") || t("export.fallbackFileName");
}

const invalidExportFileNameCharacters = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
