import { useEffect } from "react";
import { saveStoredTheme } from "./theme-storage";
import { useTheme } from "./ThemeProvider";

export function ThemeStorageSync() {
  let { theme } = useTheme();

  useEffect(() => {
    saveStoredTheme(theme);
  }, [theme]);

  return null;
}
