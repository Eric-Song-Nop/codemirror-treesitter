import type { EditorView } from "@codemirror/view";
import type { WorkspaceImageNode } from "@/lib/workspace-backend";
import type { WorkspaceImageAsset } from "@/lib/workspace/types";

export async function createWorkspaceImageAssets(nodes: WorkspaceImageNode[]) {
  let assets: WorkspaceImageAsset[] = [];
  for (let node of nodes) {
    assets.push({
      ...node,
      url: URL.createObjectURL(node.file),
    });
  }
  return assets;
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
  let insert = blockInsertText(view.state.doc, from, to, markdown);

  view.dispatch({
    changes: { from, insert, to },
    scrollIntoView: true,
    selection: { anchor: from + insert.length },
    userEvent: "input.image",
  });
  view.focus();
}

export function isImageFile(file: File) {
  return (
    file.type.startsWith("image/") || /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name)
  );
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
  return `${prefix}${markdown}${suffix}`;
}
