import { isTheme, type Theme } from "./theme";

export const themeStorageKey = "local-md-workspace:theme";

export function loadStoredTheme(storage: Storage | undefined = browserStorage()): Theme | null {
  if (!storage) return null;
  let value = storage.getItem(themeStorageKey);
  return isTheme(value) ? value : null;
}

export function saveStoredTheme(theme: Theme, storage: Storage | undefined = browserStorage()) {
  storage?.setItem(themeStorageKey, theme);
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
