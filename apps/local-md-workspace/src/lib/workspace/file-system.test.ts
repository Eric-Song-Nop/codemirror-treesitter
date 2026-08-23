import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ensureReadWritePermission,
  findWorkspaceFilePathForHandle,
  pickWorkspaceDirectory,
  queryReadWritePermission,
  readAccessFileHandle,
  saveMarkdownFileAs,
  supportsDirectoryPicker,
  supportsSaveFilePicker,
  writeAccessFileHandle,
  type AccessDirectoryHandle,
} from "./file-system.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace host handles", () => {
  it("detects and opens the directory picker with write access", async () => {
    let handle = new MemoryDirectoryHandle("Workspace");
    let showDirectoryPicker = vi.fn(async () => handle);
    vi.stubGlobal("window", { showDirectoryPicker });

    expect(supportsDirectoryPicker()).toBe(true);
    await expect(pickWorkspaceDirectory()).resolves.toBe(handle);
    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("queries and requests read-write permission", async () => {
    let handle = new MemoryDirectoryHandle("Workspace");
    handle.permission = "prompt";

    await expect(queryReadWritePermission(handle)).resolves.toBe("prompt");
    await expect(ensureReadWritePermission(handle)).resolves.toBe(true);
    expect(handle.requestedPermission).toEqual({ mode: "readwrite" });
  });

  it("finds only visible Markdown handles in the selected workspace", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let notes = await root.getDirectoryHandle("notes", { create: true });
    let today = await notes.getFileHandle("today.md", { create: true });
    await notes.getFileHandle("image.png", { create: true });
    let git = await root.getDirectoryHandle(".git", { create: true });
    let hidden = await git.getFileHandle("hidden.md", { create: true });
    let liveMd = await root.getDirectoryHandle(".livemd", { create: true });
    let internal = await liveMd.getFileHandle("internal.md", { create: true });

    await expect(findWorkspaceFilePathForHandle(root, today)).resolves.toBe("notes/today.md");
    await expect(findWorkspaceFilePathForHandle(root, hidden)).resolves.toBeNull();
    await expect(findWorkspaceFilePathForHandle(root, internal)).resolves.toBeNull();
  });

  it("does not match an equivalent name from another workspace", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let outside = new MemoryDirectoryHandle("Outside");
    await root.getFileHandle("today.md", { create: true });
    let outsideHandle = await outside.getFileHandle("today.md", { create: true });

    await expect(findWorkspaceFilePathForHandle(root, outsideHandle)).resolves.toBeNull();
  });
});

describe("standalone file handles", () => {
  it("detects Save As picker support", () => {
    vi.stubGlobal("window", {});
    expect(supportsSaveFilePicker()).toBe(false);

    vi.stubGlobal("window", { showSaveFilePicker: vi.fn() });
    expect(supportsSaveFilePicker()).toBe(true);
  });

  it("saves Markdown through the Save As picker", async () => {
    let files = new Map<string, string>();
    let handle = new MemoryFileHandle("draft.md", files);
    let showSaveFilePicker = vi.fn(async () => handle);
    vi.stubGlobal("window", { showSaveFilePicker });

    await expect(saveMarkdownFileAs({ suggestedName: "draft", value: "# Draft\n" })).resolves.toBe(
      handle,
    );
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "draft.md",
      types: [
        {
          accept: { "text/markdown": [".md", ".markdown"] },
          description: "Markdown",
        },
      ],
    });
    await expect(readAccessFileHandle(handle)).resolves.toBe("# Draft\n");
  });

  it("reads and writes a standalone access handle", async () => {
    let files = new Map([["notes.md", "# Old\n"]]);
    let handle = new MemoryFileHandle("notes.md", files);

    await expect(readAccessFileHandle(handle)).resolves.toBe("# Old\n");
    await writeAccessFileHandle(handle, "# New\n");
    await expect(readAccessFileHandle(handle)).resolves.toBe("# New\n");
  });

  it("aborts a standalone write when the stream write fails", async () => {
    let failure = new Error("disk full");
    let abort = vi.fn(async () => {});
    let handle = {
      kind: "file" as const,
      name: "notes.md",
      createWritable: async () => ({
        abort,
        close: async () => {},
        write: async () => {
          throw failure;
        },
      }),
      getFile: async () => new File([], "notes.md"),
    };

    await expect(writeAccessFileHandle(handle, "# New\n")).rejects.toBe(failure);
    expect(abort).toHaveBeenCalledOnce();
  });
});

class MemoryFileHandle {
  kind = "file" as const;

  constructor(
    public name: string,
    private readonly files: Map<string, string>,
  ) {}

  async createWritable() {
    let chunks: string[] = [];
    return {
      abort: async () => {
        chunks = [];
      },
      close: async () => {
        this.files.set(this.name, chunks.join(""));
      },
      write: async (data: Blob | BufferSource | string) => {
        if (typeof data == "string") {
          chunks.push(data);
        } else if (data instanceof Blob) {
          chunks.push(await data.text());
        } else {
          chunks.push(new TextDecoder().decode(data instanceof ArrayBuffer ? data : data.buffer));
        }
      },
    };
  }

  async getFile() {
    return new File([this.files.get(this.name) ?? ""], this.name, {
      type: this.name.endsWith(".md") ? "text/markdown" : "application/octet-stream",
    });
  }

  async isSameEntry(other: unknown) {
    return (
      other instanceof MemoryFileHandle && other.name == this.name && other.files == this.files
    );
  }
}

class MemoryDirectoryHandle implements AccessDirectoryHandle {
  kind = "directory" as const;
  permission: PermissionState = "granted";
  requestedPermission: { mode?: "read" | "readwrite" } | null = null;
  private readonly directories = new Map<string, MemoryDirectoryHandle>();
  private readonly files = new Map<string, string>();

  constructor(public name: string) {}

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    let directory = this.directories.get(name);
    if (!directory) {
      if (!options.create) throw new DOMException("Directory not found.", "NotFoundError");
      directory = new MemoryDirectoryHandle(name);
      this.directories.set(name, directory);
    }
    return directory;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    if (!this.files.has(name)) {
      if (!options.create) throw new DOMException("File not found.", "NotFoundError");
      this.files.set(name, "");
    }
    return new MemoryFileHandle(name, this.files);
  }

  async queryPermission() {
    return this.permission;
  }

  async removeEntry(name: string) {
    if (this.files.delete(name) || this.directories.delete(name)) return;
    throw new DOMException("Entry not found.", "NotFoundError");
  }

  async requestPermission(descriptor?: { mode?: "read" | "readwrite" }) {
    this.requestedPermission = descriptor ?? null;
    this.permission = "granted";
    return this.permission;
  }

  async *values() {
    for (let directory of this.directories.values()) yield directory;
    for (let name of this.files.keys()) yield new MemoryFileHandle(name, this.files);
  }
}
