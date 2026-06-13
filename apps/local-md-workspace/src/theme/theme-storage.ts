import { coerceTheme, type Theme } from "./theme";

export const themeStorageKey = "local-md-workspace:theme";

export function loadStoredTheme(storage: Storage | undefined = browserStorage()): Theme | null {
  if (!storage) return null;
  try {
    let value = storage.getItem(themeStorageKey);
    return coerceTheme(value);
  } catch {
    return null;
  }
}

export function saveStoredTheme(theme: Theme, storage: Storage | undefined = browserStorage()) {
  try {
    storage?.setItem(themeStorageKey, theme);
  } catch {
    return;
  }
}

function browserStorage() {
  if (typeof window == "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
