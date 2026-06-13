import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createLocalWorkspaceBackend,
  readAccessFileHandle,
  saveMarkdownFileAs,
  supportsSaveFilePicker,
  writeAccessFileHandle,
  type AccessDirectoryHandle,
} from "./file-system.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local workspace backend", () => {
  it("creates empty folders from trailing-slash paths", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let backend = createLocalWorkspaceBackend(root);

    await expect(backend.createFile("notes/daily/")).resolves.toBeNull();

    await expect(backend.readTree()).resolves.toMatchObject({
      children: [
        {
          children: [{ children: [], kind: "directory", name: "daily", path: "notes/daily" }],
          kind: "directory",
          name: "notes",
          path: "notes",
        },
      ],
      kind: "directory",
      name: "Workspace",
      path: "",
    });
  });

  it("creates parent folders for nested file paths", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let backend = createLocalWorkspaceBackend(root);

    await expect(backend.createFile("notes/daily/today")).resolves.toBe("notes/daily/today.md");
    await expect(backend.readFile("notes/daily/today.md")).resolves.toBe("# today\n");

    await expect(backend.readTree()).resolves.toMatchObject({
      children: [
        {
          children: [
            {
              children: [{ kind: "file", name: "today.md", path: "notes/daily/today.md" }],
              kind: "directory",
              name: "daily",
              path: "notes/daily",
            },
          ],
          kind: "directory",
          name: "notes",
          path: "notes",
        },
      ],
    });
  });

  it("keeps legacy .livemd files hidden from the Markdown tree", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let backend = createLocalWorkspaceBackend(root);

    await backend.createFile("notes/today.md");
    await backend.createDirectory!(".livemd/docs");
    await backend.writeTextFile!(".livemd/manifest.json", "{}\n");
    await backend.writeBytes!(".livemd/docs/doc.snapshot.b64", new Uint8Array([1, 2, 3]));

    await expect(backend.readTextFile!(".livemd/manifest.json")).resolves.toBe("{}\n");
    await expect(backend.readBytes!(".livemd/docs/doc.snapshot.b64")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await expect(backend.stat!(".livemd/docs/doc.snapshot.b64")).resolves.toMatchObject({
      exists: true,
      isFile: true,
      path: ".livemd/docs/doc.snapshot.b64",
      size: 3,
    });
    await expect(backend.readTree()).resolves.toMatchObject({
      children: [
        {
          children: [{ kind: "file", name: "today.md", path: "notes/today.md" }],
          kind: "directory",
          name: "notes",
          path: "notes",
        },
      ],
    });
  });

  it("finds a visible Markdown file path from a browser file handle", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let backend = createLocalWorkspaceBackend(root);

    await backend.createFile("notes/today.md");
    await backend.createFile("notes/other.md");
    let notes = await root.getDirectoryHandle("notes");
    let handle = await notes.getFileHandle("today.md");

    await expect(backend.findFilePathForHandle!(handle)).resolves.toBe("notes/today.md");
  });

  it("does not match file handles outside the current workspace", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let outside = new MemoryDirectoryHandle("Outside");
    let backend = createLocalWorkspaceBackend(root);

    await backend.createFile("today.md");
    await outside.getFileHandle("today.md", { create: true });
    let outsideHandle = await outside.getFileHandle("today.md");

    await expect(backend.findFilePathForHandle!(outsideHandle)).resolves.toBeNull();
  });

  it("deletes folders recursively", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let backend = createLocalWorkspaceBackend(root);

    await backend.createFile("notes/daily/today.md");
    expect(backend.deleteDirectory).toBeDefined();
    await expect(backend.deleteDirectory!("notes")).resolves.toBeUndefined();

    await expect(backend.readTree()).resolves.toMatchObject({
      children: [],
      kind: "directory",
      name: "Workspace",
      path: "",
    });
  });

  it("renames folders recursively", async () => {
    let root = new MemoryDirectoryHandle("Workspace");
    let backend = createLocalWorkspaceBackend(root);

    await backend.createFile("notes/daily/today.md");
    expect(backend.renameDirectory).toBeDefined();
    await expect(backend.renameDirectory!("notes", "docs")).resolves.toBe("docs");

    await expect(backend.readFile("docs/daily/today.md")).resolves.toBe("# today\n");
    await expect(backend.readTree()).resolves.toMatchObject({
      children: [
        {
          children: [
            {
              children: [{ kind: "file", name: "today.md", path: "docs/daily/today.md" }],
              kind: "directory",
              name: "daily",
              path: "docs/daily",
            },
          ],
          kind: "directory",
          name: "docs",
          path: "docs",
        },
      ],
      kind: "directory",
      name: "Workspace",
      path: "",
    });
  });
});

describe("single file access handles", () => {
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
          accept: {
            "text/markdown": [".md", ".markdown"],
          },
          description: "Markdown",
        },
      ],
    });
    await expect(readAccessFileHandle(handle)).resolves.toBe("# Draft\n");
  });

  it("reads and writes access file handles", async () => {
    let files = new Map([["notes.md", "# Old\n"]]);
    let handle = new MemoryFileHandle("notes.md", files);

    await expect(readAccessFileHandle(handle)).resolves.toBe("# Old\n");
    await writeAccessFileHandle(handle, "# New\n");

    await expect(readAccessFileHandle(handle)).resolves.toBe("# New\n");
  });
});

class MemoryFileHandle {
  kind = "file" as const;

  constructor(
    public name: string,
    private files: Map<string, string>,
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
  private directories = new Map<string, MemoryDirectoryHandle>();
  private files = new Map<string, string>();

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
    return "granted" as const;
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}) {
    if (this.files.delete(name)) return;
    let directory = this.directories.get(name);
    if (directory) {
      if (!options.recursive && !directory.isEmpty()) {
        throw new DOMException("Directory is not empty.", "InvalidModificationError");
      }
      this.directories.delete(name);
      return;
    }
    throw new DOMException("Entry not found.", "NotFoundError");
  }

  async requestPermission() {
    return "granted" as const;
  }

  async *values() {
    for (let directory of this.directories.values()) yield directory;
    for (let name of this.files.keys()) yield new MemoryFileHandle(name, this.files);
  }

  private isEmpty() {
    return this.directories.size == 0 && this.files.size == 0;
  }
}
