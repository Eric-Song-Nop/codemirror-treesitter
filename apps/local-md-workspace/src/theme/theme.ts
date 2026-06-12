export const themeValues = ["light", "dark"] as const;

export type Theme = (typeof themeValues)[number];

export const defaultTheme: Theme = "dark";

export function isTheme(value: unknown): value is Theme {
  return value == "light" || value == "dark";
}

export function nextTheme(theme: Theme): Theme {
  return theme == "dark" ? "light" : "dark";
}
