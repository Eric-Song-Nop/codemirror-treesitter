import { useLayoutEffect } from "react";
import { useTheme } from "./ThemeProvider";
import type { Theme } from "./theme";

export function ThemeDocumentSync() {
  let { theme } = useTheme();

  useLayoutEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  return null;
}

export function applyThemeToDocument(theme: Theme, root = document.documentElement) {
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme == "dark");
  root.style.colorScheme = theme;
}
