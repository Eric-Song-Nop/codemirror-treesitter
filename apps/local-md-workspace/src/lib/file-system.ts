import {
  joinWorkspacePath,
  normalizeMarkdownFileName,
  normalizeMarkdownPath,
  sortMarkdownTreeNodes,
  starterMarkdown,
  type CreatedWorkspaceImageNode,
  type MarkdownDirectoryNode,
  type MarkdownTreeNode,
  type WorkspaceBackend,
  type WorkspaceImageNode,
} from "@/lib/workspace-backend";

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
  };

export function supportsDirectoryPicker() {
  return typeof (window as PickerWindow).showDirectoryPicker == "function";
}

export async function pickWorkspaceDirectory() {
  let picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error("File System Access API is not available in this browser.");
  }
  return picker({ mode: "readwrite" });
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

export function createLocalWorkspaceBackend(handle: AccessDirectoryHandle): WorkspaceBackend {
  return {
    id: `local:${handle.name || "workspace"}`,
    kind: "local",
    name: handle.name || "Workspace",
    createFile: (path) => createMarkdownFile(handle, path),
    createImageAsset: (markdownFilePath, imageFile) =>
      createImageAsset(handle, markdownFilePath, imageFile),
    deleteFile: (path) => deleteMarkdownFile(handle, path),
    readFile: (path) => readMarkdownPath(handle, path),
    readImages: () => readWorkspaceImages(handle),
    readTree: () => readWorkspaceTree(handle),
    renameFile: (path, rawName) => renameMarkdownFile(handle, path, rawName),
    writeFile: (path, value) => writeMarkdownPath(handle, path, value),
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
  let path = normalizeMarkdownPath(rawPath);
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

async function readDirectoryChildren(handle: AccessDirectoryHandle, path: string) {
  let children: MarkdownTreeNode[] = [];

  for await (let entry of handle.values()) {
    let entryPath = joinWorkspacePath(path, entry.name);
    if (entry.kind == "directory") {
      let directoryChildren = await readDirectoryChildren(entry, entryPath);
      if (directoryChildren.length) {
        children.push({
          children: directoryChildren,
          kind: "directory",
          name: entry.name,
          path: entryPath,
        });
      }
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

async function collectWorkspaceImages(
  handle: AccessDirectoryHandle,
  path: string,
  images: WorkspaceImageNode[],
) {
  for await (let entry of handle.values()) {
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

async function resolveParentDirectory(
  rootHandle: AccessDirectoryHandle,
  path: string,
  create: boolean,
) {
  let parts = path.split("/");
  let fileName = parts.pop();
  if (!fileName) throw new Error("Enter a file name.");

  let directory = rootHandle;
  for (let part of parts) {
    directory = await directory.getDirectoryHandle(part, { create });
  }

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
    if (error instanceof DOMException && error.name == "NotFoundError") return false;
    throw error;
  }
}
