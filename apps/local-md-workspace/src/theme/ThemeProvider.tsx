import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { defaultTheme, nextTheme, type Theme } from "./theme";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

let ThemeContext = createContext<ThemeContextValue | null>(null);

type ThemeProviderProps = {
  children: ReactNode;
  initialTheme?: Theme;
};

export function ThemeProvider({ children, initialTheme = defaultTheme }: ThemeProviderProps) {
  let [theme, setTheme] = useState<Theme>(initialTheme);
  let toggleTheme = useCallback(() => setTheme((current) => nextTheme(current)), []);
  let value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  let value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
