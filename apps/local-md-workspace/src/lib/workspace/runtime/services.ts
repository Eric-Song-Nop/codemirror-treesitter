import { Effect } from "effect";
import {
  WorkspaceMutationNotApplied,
  WorkspaceNotFound,
  WorkspaceUnsupportedImage,
  type WorkspaceStoreError,
} from "../storage/errors.ts";
import type { WorkspaceEntry, WorkspaceObjectStore } from "../storage/types.ts";
import {
  buildMarkdownDirectoryFromEntries,
  joinWorkspacePath,
  normalizeMarkdownFileName,
  normalizeWorkspaceCreateTarget,
  normalizeWorkspaceDirectoryName,
  starterMarkdown,
  type MarkdownDirectoryNode,
  type WorkspaceEntry as LegacyWorkspaceEntry,
} from "../tree.ts";
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

/**
 * Runs a storage effect for a Promise-facing workspace port. Workspace runtimes
 * pass a runner bound to the services they were built with, so storage retries
 * and clocks follow the application runtime; the default uses Effect's default
 * services. Failures reject with the typed error itself.
 */
export type WorkspaceEffectRunner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

const defaultRunner: WorkspaceEffectRunner = (effect) => Effect.runPromise(effect);

/*
 * The classes below are the Promise boundary of the storage layer: the
 * document, collaboration, and Agent layers consume `WorkspaceRuntime` ports as
 * Promises, while every port method is implemented as one Effect program over
 * the Effect-native `WorkspaceObjectStore`.
 */

export class OpendalWorkspaceDocumentService implements WorkspaceDocumentPort {
  constructor(
    private readonly store: WorkspaceObjectStore,
    private readonly run: WorkspaceEffectRunner = defaultRunner,
  ) {}

  observe(path: string) {
    return this.run(observeDocument(this.store, path));
  }

  commit(input: Parameters<WorkspaceDocumentPort["commit"]>[0]) {
    return this.run(
      this.store.commit({
        bytes: new TextEncoder().encode(input.value),
        condition: input.condition,
        path: input.path,
      }),
    );
  }
}

export class OpendalWorkspaceTreeService implements WorkspaceTreePort {
  constructor(
    private readonly store: WorkspaceObjectStore,
    private readonly rootName: string,
    private readonly run: WorkspaceEffectRunner = defaultRunner,
  ) {}

  readTree() {
    return this.readDirectory("", this.rootName);
  }

  listEntries(path: string) {
    return this.run(this.store.listDirectory(path));
  }

  readDirectory(path: string, name: string): Promise<MarkdownDirectoryNode> {
    return this.run(
      this.store
        .listDirectory(path)
        .pipe(
          Effect.map((entries) =>
            buildMarkdownDirectoryFromEntries(
              name,
              path,
              entries
                .filter((entry) => !isIgnoredDirectory(entry.path, entry.kind))
                .map(storageEntryToLegacyEntry),
            ),
          ),
        ),
    );
  }
}

export class OpendalWorkspaceEntryService implements WorkspaceEntryPort {
  constructor(
    private readonly store: WorkspaceObjectStore,
    private readonly run: WorkspaceEffectRunner = defaultRunner,
  ) {}

  create(rawPath: string) {
    return this.run(createEntry(this.store, rawPath));
  }

  probe(path: string) {
    return this.run(this.store.probe(path));
  }

  delete(input: Parameters<WorkspaceEntryPort["delete"]>[0]) {
    return this.run(
      this.store.delete({
        condition: input.revision
          ? { kind: "if-unchanged", revision: input.revision }
          : { kind: "unconditional" },
        path: input.path,
        recursive: input.kind == "directory",
      }),
    );
  }

  rename(input: Parameters<WorkspaceEntryPort["rename"]>[0]) {
    return this.run(
      Effect.gen({ self: this }, function* () {
        let name =
          input.kind == "file"
            ? normalizeMarkdownFileName(input.rawName)
            : normalizeWorkspaceDirectoryName(input.rawName);
        let parent = input.path.split("/").slice(0, -1).join("/");
        let to = joinWorkspacePath(parent, name);
        if (to == input.path) return { path: input.path, result: { status: "applied" as const } };
        return {
          path: to,
          result: yield* moveEntry(this.store, { ...input, from: input.path, to }),
        };
      }),
    );
  }

  move(input: Parameters<WorkspaceEntryPort["move"]>[0]) {
    return this.run(moveEntry(this.store, input));
  }
}

export class OpendalWorkspaceAssetService implements WorkspaceAssetPort {
  constructor(
    private readonly store: WorkspaceObjectStore,
    private readonly run: WorkspaceEffectRunner = defaultRunner,
  ) {}

  read(path: string) {
    return this.run(readAsset(this.store, path));
  }

  create(markdownFilePath: string, imageFile: File) {
    return this.run(createImageAsset(this.store, markdownFilePath, imageFile));
  }

  delete(path: string) {
    return this.run(this.store.delete({ condition: { kind: "unconditional" }, path }));
  }

  write(input: Parameters<WorkspaceAssetPort["write"]>[0]) {
    return this.run(
      this.store.commit({
        bytes: input.value,
        condition: input.condition,
        path: input.path,
      }),
    );
  }
}

const observeDocument = Effect.fn("WorkspaceDocuments.observe")(function* (
  store: WorkspaceObjectStore,
  path: string,
) {
  let observation = yield* store.read(path);
  if (observation.state != "present") return observation;
  return {
    state: "present" as const,
    value: {
      ...observation.value,
      value: new TextDecoder().decode(observation.value.bytes),
    } satisfies WorkspaceTextSnapshot,
  };
});

const createEntry = Effect.fn("WorkspaceEntries.create")(function* (
  store: WorkspaceObjectStore,
  rawPath: string,
): Effect.fn.Return<string | null, WorkspaceMutationNotApplied | WorkspaceStoreError> {
  let target = normalizeWorkspaceCreateTarget(rawPath);
  if (target.kind == "directory") {
    yield* assertApplied(
      yield* store.createDirectory(target.path, { kind: "if-absent" }),
      target.path,
    );
    return null;
  }

  let result = yield* store.commit({
    bytes: new TextEncoder().encode(starterMarkdown(target.path)),
    condition: { kind: "if-absent" },
    path: target.path,
  });
  if (result.status == "committed") return target.path;
  return yield* WorkspaceMutationNotApplied.forStatus(target.path, result.status);
});

function moveEntry(store: WorkspaceObjectStore, input: Parameters<WorkspaceEntryPort["move"]>[0]) {
  return store.move({
    from: input.from,
    kind: input.kind,
    sourceCondition: input.revision
      ? { kind: "if-unchanged", revision: input.revision }
      : { kind: "unconditional" },
    targetCondition: { kind: "if-absent" },
    to: input.to,
  });
}

const readAsset = Effect.fn("WorkspaceAssets.read")(function* (
  store: WorkspaceObjectStore,
  path: string,
) {
  let observation = yield* store.read(path);
  if (observation.state == "present") return observation.value.bytes;
  if (observation.state == "unavailable") return yield* Effect.fail(observation.error);
  return yield* new WorkspaceNotFound({ message: `${path} does not exist.`, path });
});

const createImageAsset = Effect.fn("WorkspaceAssets.create")(function* (
  store: WorkspaceObjectStore,
  markdownFilePath: string,
  imageFile: File,
) {
  if (!isImageFile(imageFile)) {
    let name = imageFile.name || "Dropped file";
    return yield* new WorkspaceUnsupportedImage({
      message: `${name} is not a supported image.`,
      name,
    });
  }
  let parent = markdownFilePath.split("/").slice(0, -1).join("/");
  let assetsPath = joinWorkspacePath(parent, "assets");
  yield* assertApplied(
    yield* store.createDirectory(assetsPath, { kind: "unconditional" }),
    assetsPath,
  );

  let { baseName, extension } = imageAssetNameParts(imageFile);
  let bytes = new Uint8Array(yield* Effect.promise(() => imageFile.arrayBuffer()));
  for (let suffix = 0; suffix < 10_000; suffix++) {
    let name = `${baseName}${suffix ? `-${suffix + 1}` : ""}${extension}`;
    let path = joinWorkspacePath(assetsPath, name);
    let result = yield* store.commit({ bytes, condition: { kind: "if-absent" }, path });
    if (result.status == "conflict") continue;
    if (result.status == "unknown")
      return yield* WorkspaceMutationNotApplied.forStatus(path, "unknown");
    return {
      file: imageFile,
      markdownReference: `assets/${name}`,
      name,
      path,
    };
  }
  return yield* new WorkspaceMutationNotApplied({
    message: "Could not allocate a unique image asset name.",
    path: assetsPath,
    status: "exhausted",
  });
});

function storageEntryToLegacyEntry(entry: WorkspaceEntry): LegacyWorkspaceEntry {
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

function assertApplied(result: { status: string }, path: string) {
  return result.status == "applied"
    ? Effect.void
    : Effect.fail(WorkspaceMutationNotApplied.forStatus(path, result.status));
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
