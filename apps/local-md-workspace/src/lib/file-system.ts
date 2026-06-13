import {
  joinWorkspacePath,
  normalizeMarkdownFileName,
  normalizeWorkspaceDirectoryName,
  normalizeWorkspaceCreateTarget,
  sortMarkdownTreeNodes,
  starterMarkdown,
  type CreatedWorkspaceImageNode,
  type MarkdownDirectoryNode,
  type MarkdownTreeNode,
  type WorkspaceEntry,
  type WorkspaceEntryStat,
  type WorkspaceBackend,
  type WorkspaceImageNode,
} from "./workspace-backend.ts";

type AccessPermissionMode = "read" | "readwrite";

type AccessPermissionDescriptor = {
  mode?: AccessPermissionMode;
};

type AccessWritableFileData = Blob | BufferSource | string;

type AccessWritableFileStream = {
  abort?: () => Promise<void>;
  close: () => Promise<void>;
  write: (data: AccessWritableFileData) => Promise<void>;
};

type AccessHandleBase = {
  kind: "directory" | "file";
  name: string;
  isSameEntry?: (other: unknown) => Promise<boolean>;
  queryPermission?: (descriptor?: AccessPermissionDescriptor) => Promise<PermissionState>;
  requestPermission?: (descriptor?: AccessPermissionDescriptor) => Promise<PermissionState>;
};

export type AccessFileHandle = AccessHandleBase & {
  kind: "file";
  createWritable: () => Promise<AccessWritableFileStream>;
  getFile: () => Promise<File>;
};

export type AccessDirectoryHandle = AccessHandleBase & {
  kind: "directory";
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<AccessDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<AccessFileHandle>;
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
  values: () => AsyncIterable<AccessDirectoryHandle | AccessFileHandle>;
};

type PickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: (options?: {
      mode?: AccessPermissionMode;
    }) => Promise<AccessDirectoryHandle>;
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<AccessFileHandle>;
  };

type SaveFilePickerOptions = {
  suggestedName?: string;
  types?: Array<{
    accept: Record<string, string[]>;
    description?: string;
  }>;
};

const markdownFilePickerTypes = [
  {
    accept: {
      "text/markdown": [".md", ".markdown"],
    },
    description: "Markdown",
  },
];

export function supportsDirectoryPicker() {
  return typeof (window as PickerWindow).showDirectoryPicker == "function";
}

export function supportsSaveFilePicker() {
  return (
    typeof window != "undefined" && typeof (window as PickerWindow).showSaveFilePicker == "function"
  );
}

export async function pickWorkspaceDirectory() {
  let picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error("File System Access API is not available in this browser.");
  }
  return picker({ mode: "readwrite" });
}

export async function saveMarkdownFileAs(input: {
  suggestedName: string;
  value: string;
}): Promise<AccessFileHandle> {
  let picker =
    typeof window == "undefined" ? undefined : (window as PickerWindow).showSaveFilePicker;
  if (!picker) {
    throw new Error("File System Access API is not available in this browser.");
  }

  let handle = await picker({
    suggestedName: normalizeMarkdownFileName(input.suggestedName.trim() || "Untitled.md"),
    types: markdownFilePickerTypes,
  });
  await writeAccessFileHandle(handle, input.value);
  return handle;
}

export async function readAccessFileHandle(handle: AccessFileHandle) {
  return handle.getFile().then((file) => file.text());
}

export async function writeAccessFileHandle(handle: AccessFileHandle, value: string) {
  await writeFileData(handle, value);
}

export async function ensureReadWritePermission(handle: AccessDirectoryHandle) {
  if ((await queryReadWritePermission(handle)) == "granted") return true;
  if (!handle.requestPermission) return false;
  return (await handle.requestPermission({ mode: "readwrite" })) == "granted";
}

export async function queryReadWritePermission(handle: AccessDirectoryHandle) {
  if (!handle.queryPermission) return "granted";
  return handle.queryPermission({ mode: "readwrite" });
}

export function createLocalWorkspaceBackend(
  handle: AccessDirectoryHandle,
  workspaceId = `local:${handle.name || "workspace"}`,
): WorkspaceBackend {
  return {
    id: workspaceId,
    kind: "local",
    name: handle.name || "Workspace",
    createDirectory: (path) => createWorkspaceDirectory(handle, path),
    createFile: (path) => createMarkdownFile(handle, path),
    createImageAsset: (markdownFilePath, imageFile) =>
      createImageAsset(handle, markdownFilePath, imageFile),
    deleteEntry: (path, options) => deleteWorkspaceEntry(handle, path, options),
    deleteDirectory: (path) => deleteMarkdownDirectory(handle, path),
    deleteFile: (path) => deleteMarkdownFile(handle, path),
    listEntries: (path) => listWorkspaceEntries(handle, path),
    readBytes: (path) => readWorkspaceBytes(handle, path),
    readFile: (path) => readMarkdownPath(handle, path),
    readImages: () => readWorkspaceImages(handle),
    readTextFile: (path) => readMarkdownPath(handle, path),
    readTree: () => readWorkspaceTree(handle),
    findFilePathForHandle: (fileHandle) => findWorkspacePathForFileHandle(handle, fileHandle),
    renameEntry: (from, to) => renameWorkspaceEntry(handle, from, to),
    renameDirectory: (path, rawName) => renameMarkdownDirectory(handle, path, rawName),
    renameFile: (path, rawName) => renameMarkdownFile(handle, path, rawName),
    stat: (path) => statWorkspaceEntry(handle, path),
    writeBytes: (path, bytes) => writeWorkspaceBytes(handle, path, bytes),
    writeFile: (path, value) => writeMarkdownPath(handle, path, value),
    writeTextFile: (path, value) => writeWorkspaceText(handle, path, value),
  };
}

async function readWorkspaceTree(handle: AccessDirectoryHandle): Promise<MarkdownDirectoryNode> {
  return {
    children: await readDirectoryChildren(handle, ""),
    kind: "directory",
    name: handle.name || "Workspace",
    path: "",
  };
}

async function findWorkspacePathForFileHandle(
  rootHandle: AccessDirectoryHandle,
  fileHandle: unknown,
) {
  if (!isAccessFileHandle(fileHandle)) return null;
  return findMarkdownFilePathForHandle(rootHandle, "", fileHandle);
}

async function readWorkspaceImages(handle: AccessDirectoryHandle) {
  let images: WorkspaceImageNode[] = [];
  await collectWorkspaceImages(handle, "", images);
  return images.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
  );
}

async function readMarkdownPath(rootHandle: AccessDirectoryHandle, path: string) {
  return (await resolveFileHandle(rootHandle, path)).getFile().then((file) => file.text());
}

async function writeMarkdownPath(rootHandle: AccessDirectoryHandle, path: string, value: string) {
  await writeFileData(await resolveFileHandle(rootHandle, path), value);
}

async function readWorkspaceBytes(rootHandle: AccessDirectoryHandle, path: string) {
  let file = await (await resolveFileHandle(rootHandle, path)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeWorkspaceBytes(
  rootHandle: AccessDirectoryHandle,
  path: string,
  bytes: Uint8Array,
) {
  let { directory, fileName } = await resolveParentDirectory(rootHandle, path, true);
  let buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  await writeFileData(await directory.getFileHandle(fileName, { create: true }), buffer);
}

async function writeWorkspaceText(rootHandle: AccessDirectoryHandle, path: string, value: string) {
  let { directory, fileName } = await resolveParentDirectory(rootHandle, path, true);
  await writeFileData(await directory.getFileHandle(fileName, { create: true }), value);
}

async function writeFileData(handle: AccessFileHandle, data: AccessWritableFileData) {
  let writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
}

async function createWorkspaceDirectory(rootHandle: AccessDirectoryHandle, path: string) {
  await resolveDirectoryPath(rootHandle, normalizeDirectoryPath(path), true);
}

async function deleteWorkspaceEntry(
  rootHandle: AccessDirectoryHandle,
  path: string,
  options: { recursive?: boolean } = {},
) {
  let { directory, fileName } = await resolveParentDirectory(rootHandle, path, false);
  await directory.removeEntry(fileName, options);
}

async function listWorkspaceEntries(rootHandle: AccessDirectoryHandle, path: string) {
  let directory = await resolveDirectoryPath(rootHandle, normalizeDirectoryPath(path), false);
  let entries: WorkspaceEntry[] = [];

  for await (let entry of directory.values()) {
    entries.push({
      isDirectory: entry.kind == "directory",
      isFile: entry.kind == "file",
      path: joinWorkspacePath(path, entry.name),
    });
  }

  return entries.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
  );
}

async function renameWorkspaceEntry(rootHandle: AccessDirectoryHandle, from: string, to: string) {
  let source = await statWorkspaceEntry(rootHandle, from);
  if (!source.exists) throw new DOMException("Entry not found.", "NotFoundError");

  if (source.isDirectory) {
    let { directory, fileName } = await resolveParentDirectory(rootHandle, from, false);
    let { directory: targetDirectory, fileName: targetName } = await resolveParentDirectory(
      rootHandle,
      to,
      true,
    );
    if (await entryExists(targetDirectory, targetName)) {
      throw new Error(`${to} already exists.`);
    }
    let currentDirectory = await directory.getDirectoryHandle(fileName);
    let nextDirectory = await targetDirectory.getDirectoryHandle(targetName, { create: true });
    await copyDirectoryEntries(currentDirectory, nextDirectory);
    await directory.removeEntry(fileName, { recursive: true });
    return;
  }

  let { directory, fileName } = await resolveParentDirectory(rootHandle, from, false);
  let { directory: targetDirectory, fileName: targetName } = await resolveParentDirectory(
    rootHandle,
    to,
    true,
  );
  if (await entryExists(targetDirectory, targetName)) throw new Error(`${to} already exists.`);
  let nextHandle = await targetDirectory.getFileHandle(targetName, { create: true });
  await writeFileData(nextHandle, await readWorkspaceBytes(rootHandle, from));
  await directory.removeEntry(fileName);
}

async function statWorkspaceEntry(
  rootHandle: AccessDirectoryHandle,
  path: string,
): Promise<WorkspaceEntryStat> {
  let normalized = normalizeEntryPath(path);
  if (!normalized) {
    return { exists: true, isDirectory: true, isFile: false, path: "" };
  }

  try {
    let file = await resolveFileHandle(rootHandle, normalized);
    let blob = await file.getFile();
    return {
      exists: true,
      isDirectory: false,
      isFile: true,
      mtime: blob.lastModified || undefined,
      path: normalized,
      size: blob.size,
    };
  } catch (error) {
    if (!isNotFoundError(error) && !isEntryTypeMismatchError(error)) throw error;
  }

  try {
    await resolveDirectoryPath(rootHandle, normalized, false);
    return { exists: true, isDirectory: true, isFile: false, path: normalized };
  } catch (error) {
    if (!isNotFoundError(error) && !isEntryTypeMismatchError(error)) throw error;
  }

  return { exists: false, isDirectory: false, isFile: false, path: normalized };
}

async function createImageAsset(
  rootHandle: AccessDirectoryHandle,
  markdownFilePath: string,
  imageFile: File,
): Promise<CreatedWorkspaceImageNode> {
  if (!isImageFile(imageFile)) {
    throw new Error(`${imageFile.name || "Dropped file"} is not a supported image.`);
  }

  let { directory, parentPath } = await resolveParentDirectory(rootHandle, markdownFilePath, true);
  let assetsDirectory = await directory.getDirectoryHandle("assets", { create: true });
  let { baseName, extension } = imageAssetNameParts(imageFile);
  let fileName = await nextAvailableFileName(assetsDirectory, baseName, extension);
  let handle = await assetsDirectory.getFileHandle(fileName, { create: true });
  await writeFileData(handle, imageFile);

  let path = joinWorkspacePath(joinWorkspacePath(parentPath, "assets"), fileName);
  return {
    file: imageFile,
    markdownReference: `assets/${fileName}`,
    name: fileName,
    path,
  };
}

async function createMarkdownFile(rootHandle: AccessDirectoryHandle, rawPath: string) {
  let target = normalizeWorkspaceCreateTarget(rawPath);
  if (target.kind == "directory") {
    await resolveDirectoryPath(rootHandle, target.path, true);
    return null;
  }

  let path = target.path;
  let { directory, fileName } = await resolveParentDirectory(rootHandle, path, true);
  if (await fileExists(directory, fileName)) {
    throw new Error(`${path} already exists.`);
  }

  let handle = await directory.getFileHandle(fileName, { create: true });
  await writeFileData(handle, starterMarkdown(path));
  return path;
}

async function deleteMarkdownFile(rootHandle: AccessDirectoryHandle, path: string) {
  let { directory, fileName } = await resolveParentDirectory(rootHandle, path, false);
  await directory.removeEntry(fileName);
}

async function deleteMarkdownDirectory(rootHandle: AccessDirectoryHandle, path: string) {
  let targetPath = normalizeWorkspaceDirectoryPath(path);
  let { directory, fileName } = await resolveParentDirectory(rootHandle, targetPath, false);
  await directory.removeEntry(fileName, { recursive: true });
}

function normalizeWorkspaceDirectoryPath(path: string) {
  let normalized = path.trim().replace(/\/+$/g, "");
  let target = normalizeWorkspaceCreateTarget(`${normalized}/`);
  if (target.kind != "directory") throw new Error("Enter a folder name.");
  return target.path;
}

async function renameMarkdownFile(
  rootHandle: AccessDirectoryHandle,
  path: string,
  rawName: string,
) {
  let fileName = normalizeMarkdownFileName(rawName);
  let currentName = path.split("/").at(-1);
  if (!currentName) throw new Error("Enter a file name.");
  if (fileName == currentName) return path;

  let { directory, parentPath } = await resolveParentDirectory(rootHandle, path, false);
  if (await fileExists(directory, fileName)) {
    throw new Error(`${fileName} already exists.`);
  }

  let nextHandle = await directory.getFileHandle(fileName, { create: true });
  await writeFileData(nextHandle, await readMarkdownPath(rootHandle, path));
  await directory.removeEntry(currentName);
  return joinWorkspacePath(parentPath, fileName);
}

async function renameMarkdownDirectory(
  rootHandle: AccessDirectoryHandle,
  path: string,
  rawName: string,
) {
  let directoryName = normalizeWorkspaceDirectoryName(rawName);
  let targetPath = normalizeWorkspaceDirectoryPath(path);
  let currentName = targetPath.split("/").at(-1);
  if (!currentName) throw new Error("Enter a folder name.");
  if (directoryName == currentName) return targetPath;

  let { directory, parentPath } = await resolveParentDirectory(rootHandle, targetPath, false);
  if (await entryExists(directory, directoryName)) {
    throw new Error(`${directoryName} already exists.`);
  }

  let currentDirectory = await directory.getDirectoryHandle(currentName);
  let nextDirectory = await directory.getDirectoryHandle(directoryName, { create: true });
  await copyDirectoryEntries(currentDirectory, nextDirectory);
  await directory.removeEntry(currentName, { recursive: true });
  return joinWorkspacePath(parentPath, directoryName);
}

async function copyDirectoryEntries(source: AccessDirectoryHandle, target: AccessDirectoryHandle) {
  for await (let entry of source.values()) {
    if (entry.kind == "directory") {
      await copyDirectoryEntries(
        entry,
        await target.getDirectoryHandle(entry.name, { create: true }),
      );
    } else {
      await writeFileData(
        await target.getFileHandle(entry.name, { create: true }),
        await entry.getFile(),
      );
    }
  }
}

async function readDirectoryChildren(handle: AccessDirectoryHandle, path: string) {
  let children: MarkdownTreeNode[] = [];

  for await (let entry of handle.values()) {
    if (isLiveMdEntry(path, entry.name)) continue;
    let entryPath = joinWorkspacePath(path, entry.name);
    if (entry.kind == "directory") {
      let directoryChildren = await readDirectoryChildren(entry, entryPath);
      children.push({
        children: directoryChildren,
        kind: "directory",
        name: entry.name,
        path: entryPath,
      });
    } else if (/\.md$/i.test(entry.name)) {
      children.push({
        kind: "file",
        name: entry.name,
        path: entryPath,
      });
    }
  }

  return sortMarkdownTreeNodes(children);
}

async function findMarkdownFilePathForHandle(
  handle: AccessDirectoryHandle,
  path: string,
  target: AccessFileHandle,
): Promise<string | null> {
  for await (let entry of handle.values()) {
    if (isLiveMdEntry(path, entry.name)) continue;
    let entryPath = joinWorkspacePath(path, entry.name);
    if (entry.kind == "directory") {
      let match = await findMarkdownFilePathForHandle(entry, entryPath, target);
      if (match) return match;
    } else if (/\.md$/i.test(entry.name) && (await isSameAccessEntry(entry, target))) {
      return entryPath;
    }
  }
  return null;
}

async function collectWorkspaceImages(
  handle: AccessDirectoryHandle,
  path: string,
  images: WorkspaceImageNode[],
) {
  for await (let entry of handle.values()) {
    if (isLiveMdEntry(path, entry.name)) continue;
    let entryPath = joinWorkspacePath(path, entry.name);
    if (entry.kind == "directory") {
      await collectWorkspaceImages(entry, entryPath, images);
    } else if (isImageFileName(entry.name)) {
      images.push({
        file: await entry.getFile(),
        name: entry.name,
        path: entryPath,
      });
    }
  }
}

function normalizeDirectoryPath(path: string) {
  return normalizeEntryPath(path).replace(/\/+$/g, "");
}

function normalizeEntryPath(path: string) {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function isLiveMdEntry(parentPath: string, name: string) {
  return !parentPath && name == ".livemd";
}

async function isSameAccessEntry(left: AccessFileHandle, right: AccessFileHandle) {
  if (left === right) return true;
  if (left.isSameEntry) {
    try {
      if (await left.isSameEntry(right)) return true;
    } catch {
      // Try the reverse comparison below when a handle rejects unknown shapes.
    }
  }

  if (!right.isSameEntry) return false;

  try {
    return await right.isSameEntry(left);
  } catch {
    return false;
  }
}

function isAccessFileHandle(value: unknown): value is AccessFileHandle {
  return (
    typeof value == "object" &&
    value != null &&
    (value as { kind?: unknown }).kind == "file" &&
    typeof (value as { getFile?: unknown }).getFile == "function" &&
    typeof (value as { createWritable?: unknown }).createWritable == "function"
  );
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || isImageFileName(file.name);
}

function isImageFileName(fileName: string) {
  return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(fileName);
}

function imageAssetNameParts(file: File) {
  let extension = imageFileExtension(file);
  let name = file.name.replace(/\.[^.]*$/, "");
  let baseName = sanitizeImageAssetBaseName(name || "image");
  return { baseName, extension };
}

function imageFileExtension(file: File) {
  let nameExtension = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (nameExtension && isImageFileName(`image${nameExtension}`)) return nameExtension;

  switch (file.type) {
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
}

function sanitizeImageAssetBaseName(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "image"
  );
}

async function nextAvailableFileName(
  directory: AccessDirectoryHandle,
  baseName: string,
  extension: string,
) {
  let fileName = `${baseName}${extension}`;
  if (!(await fileExists(directory, fileName))) return fileName;

  for (let index = 2; index < 10_000; index++) {
    fileName = `${baseName}-${index}${extension}`;
    if (!(await fileExists(directory, fileName))) return fileName;
  }

  throw new Error("Could not allocate an image file name.");
}

async function resolveFileHandle(rootHandle: AccessDirectoryHandle, path: string) {
  let { directory, fileName } = await resolveParentDirectory(rootHandle, path, false);
  return directory.getFileHandle(fileName);
}

async function resolveDirectoryPath(
  rootHandle: AccessDirectoryHandle,
  path: string,
  create: boolean,
) {
  let directory = rootHandle;
  for (let part of path.split("/").filter(Boolean)) {
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return directory;
}

async function resolveParentDirectory(
  rootHandle: AccessDirectoryHandle,
  path: string,
  create: boolean,
) {
  let parts = path.split("/");
  let fileName = parts.pop();
  if (!fileName) throw new Error("Enter a file name.");

  let directory = await resolveDirectoryPath(rootHandle, parts.join("/"), create);

  return {
    directory,
    fileName,
    parentPath: parts.join("/"),
  };
}

async function fileExists(directory: AccessDirectoryHandle, fileName: string) {
  try {
    await directory.getFileHandle(fileName);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function entryExists(directory: AccessDirectoryHandle, name: string) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (isEntryTypeMismatchError(error)) return true;
    if (!isNotFoundError(error)) throw error;
  }

  try {
    await directory.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    if (isEntryTypeMismatchError(error)) return true;
    throw error;
  }
}

function isNotFoundError(error: unknown) {
  return error instanceof DOMException && error.name == "NotFoundError";
}

function isEntryTypeMismatchError(error: unknown) {
  return error instanceof DOMException && error.name == "TypeMismatchError";
}
