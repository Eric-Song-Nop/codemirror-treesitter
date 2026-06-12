import { useLayoutEffect } from "react";
import { useTheme } from "./ThemeProvider";

export function ThemeDocumentSync() {
  let { theme } = useTheme();

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme == "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  return null;
}
