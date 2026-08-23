import type { WorkspaceObjectStore } from "../storage/types.ts";
import {
  buildMarkdownDirectoryFromEntries,
  joinWorkspacePath,
  normalizeMarkdownFileName,
  normalizeWorkspaceCreateTarget,
  normalizeWorkspaceDirectoryName,
  starterMarkdown,
  type MarkdownDirectoryNode,
  type WorkspaceEntry as LegacyWorkspaceEntry,
} from "../workspace-tree.ts";
import type {
  WorkspaceAssetPort,
  WorkspaceDocumentPort,
  WorkspaceEntryPort,
  WorkspaceTextSnapshot,
  WorkspaceTreePort,
} from "./types.ts";

const ignoredWorkspaceDirectories = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".parcel-cache",
  ".svn",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export class OpendalWorkspaceDocumentService implements WorkspaceDocumentPort {
  constructor(private readonly store: WorkspaceObjectStore) {}

  async observe(path: string) {
    let observation = await this.store.read(path);
    if (observation.state != "present") return observation;
    return {
      state: "present" as const,
      value: {
        ...observation.value,
        value: new TextDecoder().decode(observation.value.bytes),
      } satisfies WorkspaceTextSnapshot,
    };
  }

  commit(input: Parameters<WorkspaceDocumentPort["commit"]>[0]) {
    return this.store.commit({
      bytes: new TextEncoder().encode(input.value),
      condition: input.condition,
      path: input.path,
    });
  }
}

export class OpendalWorkspaceTreeService implements WorkspaceTreePort {
  constructor(
    private readonly store: WorkspaceObjectStore,
    private readonly rootName: string,
  ) {}

  async readTree() {
    return this.readDirectory("", this.rootName);
  }

  listEntries(path: string) {
    return this.store.listDirectory(path);
  }

  async readDirectory(path: string, name: string): Promise<MarkdownDirectoryNode> {
    let entries = (await this.store.listDirectory(path))
      .filter((entry) => !isIgnoredDirectory(entry.path, entry.kind))
      .map(storageEntryToLegacyEntry);
    return buildMarkdownDirectoryFromEntries(name, path, entries);
  }
}

export class OpendalWorkspaceEntryService implements WorkspaceEntryPort {
  constructor(private readonly store: WorkspaceObjectStore) {}

  async create(rawPath: string) {
    let target = normalizeWorkspaceCreateTarget(rawPath);
    if (target.kind == "directory") {
      assertApplied(
        await this.store.createDirectory(target.path, { kind: "if-absent" }),
        target.path,
      );
      return null;
    }

    let result = await this.store.commit({
      bytes: new TextEncoder().encode(starterMarkdown(target.path)),
      condition: { kind: "if-absent" },
      path: target.path,
    });
    if (result.status == "committed") return target.path;
    throw mutationFailure(target.path, result.status);
  }

  probe(path: string) {
    return this.store.probe(path);
  }

  delete(input: Parameters<WorkspaceEntryPort["delete"]>[0]) {
    return this.store.delete({
      condition: input.revision
        ? { kind: "if-unchanged", revision: input.revision }
        : { kind: "unconditional" },
      path: input.path,
      recursive: input.kind == "directory",
    });
  }

  async rename(input: Parameters<WorkspaceEntryPort["rename"]>[0]) {
    let name =
      input.kind == "file"
        ? normalizeMarkdownFileName(input.rawName)
        : normalizeWorkspaceDirectoryName(input.rawName);
    let parent = input.path.split("/").slice(0, -1).join("/");
    let to = joinWorkspacePath(parent, name);
    if (to == input.path) return { path: input.path, result: { status: "applied" as const } };

    return { path: to, result: await this.move({ ...input, from: input.path, to }) };
  }

  move(input: Parameters<WorkspaceEntryPort["move"]>[0]) {
    return this.store.move({
      from: input.from,
      kind: input.kind,
      sourceCondition: input.revision
        ? { kind: "if-unchanged", revision: input.revision }
        : { kind: "unconditional" },
      targetCondition: { kind: "if-absent" },
      to: input.to,
    });
  }
}

export class OpendalWorkspaceAssetService implements WorkspaceAssetPort {
  constructor(private readonly store: WorkspaceObjectStore) {}

  async read(path: string) {
    let observation = await this.store.read(path);
    if (observation.state == "present") return observation.value.bytes;
    if (observation.state == "unavailable") throw observation.error;
    throw new Error(`${path} does not exist.`);
  }

  async create(markdownFilePath: string, imageFile: File) {
    if (!isImageFile(imageFile)) {
      throw new Error(`${imageFile.name || "Dropped file"} is not a supported image.`);
    }
    let parent = markdownFilePath.split("/").slice(0, -1).join("/");
    let assetsPath = joinWorkspacePath(parent, "assets");
    let directory = await this.store.createDirectory(assetsPath, { kind: "unconditional" });
    assertApplied(directory, assetsPath);

    let { baseName, extension } = imageAssetNameParts(imageFile);
    let bytes = new Uint8Array(await imageFile.arrayBuffer());
    for (let suffix = 0; suffix < 10_000; suffix++) {
      let name = `${baseName}${suffix ? `-${suffix + 1}` : ""}${extension}`;
      let path = joinWorkspacePath(assetsPath, name);
      let result = await this.store.commit({
        bytes,
        condition: { kind: "if-absent" },
        path,
      });
      if (result.status == "conflict") continue;
      if (result.status == "unknown") throw mutationFailure(path, "unknown");
      return {
        file: imageFile,
        markdownReference: `assets/${name}`,
        name,
        path,
      };
    }
    throw new Error("Could not allocate a unique image asset name.");
  }

  delete(path: string) {
    return this.store.delete({ condition: { kind: "unconditional" }, path });
  }

  write(input: Parameters<WorkspaceAssetPort["write"]>[0]) {
    return this.store.commit({
      bytes: input.value,
      condition: input.condition,
      path: input.path,
    });
  }
}

function storageEntryToLegacyEntry(
  entry: Awaited<ReturnType<WorkspaceObjectStore["listDirectory"]>>[number],
): LegacyWorkspaceEntry {
  return {
    isDirectory: entry.kind == "directory",
    isFile: entry.kind == "file",
    path: entry.path,
  };
}

function isIgnoredDirectory(path: string, kind: "directory" | "file") {
  let name = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  return kind == "directory" && ignoredWorkspaceDirectories.has(name);
}

function assertApplied(
  result: Awaited<ReturnType<WorkspaceObjectStore["createDirectory"]>>,
  path: string,
) {
  if (result.status != "applied") throw mutationFailure(path, result.status);
}

function mutationFailure(path: string, status: string) {
  return new Error(`Workspace mutation for ${path} ended with ${status}.`);
}

function isImageFile(file: File) {
  return (
    file.type.startsWith("image/") || /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name)
  );
}

function imageAssetNameParts(file: File) {
  let knownExtension = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  let extension =
    knownExtension && /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(knownExtension)
      ? knownExtension
      : mimeExtension(file.type);
  let rawBase = file.name.replace(/\.[^.]*$/, "") || "image";
  let baseName =
    rawBase
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "image";
  return { baseName, extension };
}

function mimeExtension(type: string) {
  switch (type) {
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
}
