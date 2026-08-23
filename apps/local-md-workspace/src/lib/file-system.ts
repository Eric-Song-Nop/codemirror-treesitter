import { normalizeMarkdownFileName } from "./workspace-tree.ts";

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
  let writable = await handle.createWritable();
  try {
    await writable.write(value);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
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

export async function findWorkspaceFilePathForHandle(
  rootHandle: AccessDirectoryHandle,
  fileHandle: unknown,
) {
  if (!isAccessFileHandle(fileHandle)) return null;
  return findMarkdownFilePathForHandle(rootHandle, "", fileHandle);
}

async function findMarkdownFilePathForHandle(
  handle: AccessDirectoryHandle,
  path: string,
  target: AccessFileHandle,
): Promise<string | null> {
  for await (let entry of handle.values()) {
    if (!path && entry.name == ".livemd") continue;
    let entryPath = path ? `${path}/${entry.name}` : entry.name;
    if (entry.kind == "directory") {
      if (ignoredWorkspaceDirectories.has(entry.name)) continue;
      let match = await findMarkdownFilePathForHandle(entry, entryPath, target);
      if (match) return match;
    } else if (/\.md$/i.test(entry.name) && (await isSameAccessEntry(entry, target))) {
      return entryPath;
    }
  }
  return null;
}

async function isSameAccessEntry(left: AccessFileHandle, right: AccessFileHandle) {
  if (left === right) return true;
  if (left.isSameEntry) {
    try {
      if (await left.isSameEntry(right)) return true;
    } catch {
      // Some handles reject comparisons with values from another provider.
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
