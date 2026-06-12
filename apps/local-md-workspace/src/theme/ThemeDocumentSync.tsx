import { useLayoutEffect } from "react";
import { useTheme } from "./ThemeProvider";
import { themeAppearance, type Theme, type ThemeAppearance } from "./theme";

export function ThemeDocumentSync() {
  let { appearance, theme } = useTheme();

  useLayoutEffect(() => {
    applyThemeToDocument(theme, appearance);
  }, [appearance, theme]);

  return null;
}

export function applyThemeToDocument(
  theme: Theme,
  appearance: ThemeAppearance = themeAppearance(theme),
  root = document.documentElement,
) {
  root.dataset.theme = theme;
  root.classList.toggle("dark", appearance == "dark");
  root.style.colorScheme = appearance;
}
