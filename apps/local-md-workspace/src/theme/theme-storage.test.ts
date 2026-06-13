import { describe, expect, it } from "vite-plus/test";
import { loadStoredTheme, saveStoredTheme, themeStorageKey } from "./theme-storage";

describe("theme storage", () => {
  it("returns null when storage getItem throws", () => {
    let storage = createStorage({
      getItem() {
        throw new Error("localStorage blocked");
      },
    });

    expect(loadStoredTheme(storage)).toBeNull();
  });

  it("silently ignores storage setItem failures", () => {
    let storage = createStorage({
      setItem() {
        throw new Error("localStorage blocked");
      },
    });

    expect(() => saveStoredTheme("gruvbox-dark", storage)).not.toThrow();
  });

  it("loads known stored themes", () => {
    let storage = createStorage({
      getItem(key) {
        return key == themeStorageKey ? "github-light" : null;
      },
    });

    expect(loadStoredTheme(storage)).toBe("github-light");
  });

  it("returns null for invalid stored themes", () => {
    let storage = createStorage({
      getItem(key) {
        return key == themeStorageKey ? "unknown-theme" : null;
      },
    });

    expect(loadStoredTheme(storage)).toBeNull();
  });
});

function createStorage(overrides: Partial<Storage> = {}): Storage {
  let values = new Map<string, string>();
  let storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  return Object.assign(storage, overrides);
}
