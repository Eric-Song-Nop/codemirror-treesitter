import type { EditorView } from "@codemirror/view";
import type { WorkspaceImageAsset } from "@/lib/workspace/types";

export function createWorkspaceImageAssetFromBytes(
  path: string,
  bytes: Uint8Array,
): WorkspaceImageAsset {
  let name = path.split("/").at(-1) ?? path;
  let buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  let file = new File([buffer], name, { type: imageMediaTypeFromPath(path) });
  return {
    file,
    name,
    path,
    url: URL.createObjectURL(file),
  };
}

export function revokeImageAssetUrls(assets: ReadonlyMap<string, WorkspaceImageAsset>) {
  for (let asset of assets.values()) {
    URL.revokeObjectURL(asset.url);
  }
}

export function insertImageMarkdown(
  view: EditorView | null,
  assets: Array<WorkspaceImageAsset & { markdownReference: string }>,
  position?: number,
) {
  if (!view || !assets.length) return;

  let selection = view.state.selection.main;
  let from = position ?? selection.from;
  let to = position ?? selection.to;
  let markdown = assets.map(imageAssetMarkdown).join("\n\n");
  let { insert, selectionOffset } = blockInsertText(view.state.doc, from, to, markdown);

  view.dispatch({
    changes: { from, insert, to },
    scrollIntoView: true,
    selection: { anchor: from + selectionOffset },
    userEvent: "input.image",
  });
  view.focus();
}

export function isImageFile(file: File) {
  return file.type.startsWith("image/") || isImageFileName(file.name);
}

export function isImageFileName(fileName: string) {
  return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(fileName);
}

function imageAssetMarkdown(asset: WorkspaceImageAsset & { markdownReference: string }) {
  return `![${imageAltText(asset.name)}](${asset.markdownReference})`;
}

function imageAltText(fileName: string) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function imageMediaTypeFromPath(path: string) {
  let extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function blockInsertText(
  doc: EditorView["state"]["doc"],
  from: number,
  to: number,
  markdown: string,
) {
  let before = doc.sliceString(Math.max(0, from - 2), from);
  let after = doc.sliceString(to, Math.min(doc.length, to + 2));
  let prefix = from == 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  let suffix =
    to == doc.length || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return {
    insert: `${prefix}${markdown}${suffix}`,
    selectionOffset: prefix.length + markdown.length,
  };
}
