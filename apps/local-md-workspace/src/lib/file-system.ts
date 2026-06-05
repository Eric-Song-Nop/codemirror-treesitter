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

export type MarkdownFileNode = {
  handle: AccessFileHandle;
  kind: "file";
  name: string;
  path: string;
};

export type WorkspaceImageNode = {
  handle: AccessFileHandle;
  name: string;
  path: string;
};

export type MarkdownDirectoryNode = {
  children: MarkdownTreeNode[];
  handle: AccessDirectoryHandle;
  kind: "directory";
  name: string;
  path: string;
};

export type MarkdownTreeNode = MarkdownDirectoryNode | MarkdownFileNode;

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

export async function readWorkspaceTree(
  handle: AccessDirectoryHandle,
): Promise<MarkdownDirectoryNode> {
  return {
    children: await readDirectoryChildren(handle, ""),
    handle,
    kind: "directory",
    name: handle.name || "Workspace",
    path: "",
  };
}

export async function readWorkspaceImages(handle: AccessDirectoryHandle) {
  let images: WorkspaceImageNode[] = [];
  await collectWorkspaceImages(handle, "", images);
  return images.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export function flattenMarkdownFiles(tree: MarkdownDirectoryNode) {
  let files: MarkdownFileNode[] = [];
  collectMarkdownFiles(tree.children, files);
  return files;
}

export async function readMarkdownFile(handle: AccessFileHandle) {
  return (await handle.getFile()).text();
}

export async function writeMarkdownFile(handle: AccessFileHandle, value: string) {
  await writeFileData(handle, value);
}

export async function writeFileData(handle: AccessFileHandle, data: AccessWritableFileData) {
  let writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
}

export async function createImageAsset(
  rootHandle: AccessDirectoryHandle,
  markdownFile: MarkdownFileNode,
  imageFile: File,
) {
  if (!isImageFile(imageFile)) {
    throw new Error(`${imageFile.name || "Dropped file"} is not a supported image.`);
  }

  let { directory, parentPath } = await resolveParentDirectory(rootHandle, markdownFile.path, true);
  let assetsDirectory = await directory.getDirectoryHandle("assets", { create: true });
  let { baseName, extension } = imageAssetNameParts(imageFile);
  let fileName = await nextAvailableFileName(assetsDirectory, baseName, extension);
  let handle = await assetsDirectory.getFileHandle(fileName, { create: true });
  await writeFileData(handle, imageFile);

  let path = joinPath(joinPath(parentPath, "assets"), fileName);
  return {
    handle,
    markdownReference: `assets/${fileName}`,
    name: fileName,
    path,
  } satisfies WorkspaceImageNode & { markdownReference: string };
}

export async function createMarkdownFile(rootHandle: AccessDirectoryHandle, rawPath: string) {
  let path = normalizeMarkdownPath(rawPath);
  let { directory, fileName } = await resolveParentDirectory(rootHandle, path, true);
  if (await fileExists(directory, fileName)) {
    throw new Error(`${path} already exists.`);
  }

  let handle = await directory.getFileHandle(fileName, { create: true });
  await writeMarkdownFile(handle, starterMarkdown(path));
  return path;
}

export async function deleteMarkdownFile(
  rootHandle: AccessDirectoryHandle,
  file: MarkdownFileNode,
) {
  let { directory } = await resolveParentDirectory(rootHandle, file.path, false);
  await directory.removeEntry(file.name);
}

export async function renameMarkdownFile(
  rootHandle: AccessDirectoryHandle,
  file: MarkdownFileNode,
  rawName: string,
) {
  let fileName = normalizeMarkdownFileName(rawName);
  if (fileName == file.name) return file.path;

  let { directory, parentPath } = await resolveParentDirectory(rootHandle, file.path, false);
  if (await fileExists(directory, fileName)) {
    throw new Error(`${fileName} already exists.`);
  }

  let nextHandle = await directory.getFileHandle(fileName, { create: true });
  await writeMarkdownFile(nextHandle, await readMarkdownFile(file.handle));
  await directory.removeEntry(file.name);
  return joinPath(parentPath, fileName);
}

export function normalizeMarkdownPath(rawPath: string) {
  let parts = splitUserPath(rawPath);
  if (!parts.length) throw new Error("Enter a file name.");

  let fileName = parts[parts.length - 1]!;
  if (!/\.md$/i.test(fileName)) fileName = `${fileName}.md`;
  parts[parts.length - 1] = fileName;
  return parts.join("/");
}

function normalizeMarkdownFileName(rawName: string) {
  let parts = splitUserPath(rawName);
  if (parts.length != 1) throw new Error("Enter a file name, not a path.");

  let fileName = parts[0]!;
  return /\.md$/i.test(fileName) ? fileName : `${fileName}.md`;
}

async function readDirectoryChildren(handle: AccessDirectoryHandle, path: string) {
  let children: MarkdownTreeNode[] = [];

  for await (let entry of handle.values()) {
    let entryPath = joinPath(path, entry.name);
    if (entry.kind == "directory") {
      let directoryChildren = await readDirectoryChildren(entry, entryPath);
      if (directoryChildren.length) {
        children.push({
          children: directoryChildren,
          handle: entry,
          kind: "directory",
          name: entry.name,
          path: entryPath,
        });
      }
    } else if (/\.md$/i.test(entry.name)) {
      children.push({
        handle: entry,
        kind: "file",
        name: entry.name,
        path: entryPath,
      });
    }
  }

  return children.sort(compareTreeNodes);
}

async function collectWorkspaceImages(
  handle: AccessDirectoryHandle,
  path: string,
  images: WorkspaceImageNode[],
) {
  for await (let entry of handle.values()) {
    let entryPath = joinPath(path, entry.name);
    if (entry.kind == "directory") {
      await collectWorkspaceImages(entry, entryPath, images);
    } else if (isImageFileName(entry.name)) {
      images.push({
        handle: entry,
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

function collectMarkdownFiles(nodes: MarkdownTreeNode[], files: MarkdownFileNode[]) {
  for (let node of nodes) {
    if (node.kind == "file") {
      files.push(node);
    } else {
      collectMarkdownFiles(node.children, files);
    }
  }
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

function splitUserPath(rawPath: string) {
  let normalized = rawPath
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (normalized.some((part) => part == "." || part == "..")) {
    throw new Error("File paths cannot include . or ..");
  }

  return normalized;
}

function starterMarkdown(path: string) {
  let title = path.split("/").at(-1)!.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();

  return title ? `# ${title}\n` : "";
}

function joinPath(parentPath: string, name: string) {
  return parentPath ? `${parentPath}/${name}` : name;
}

function compareTreeNodes(a: MarkdownTreeNode, b: MarkdownTreeNode) {
  if (a.kind != b.kind) return a.kind == "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
