export type ThemeAppearance = "light" | "dark";

type ThemeDefinitionSeed = {
  appearance: ThemeAppearance;
  id: string;
  label: string;
  pairedTheme?: string;
};

const themeDefinitionSeeds = [
  {
    appearance: "light",
    id: "gruvbox-light",
    label: "Gruvbox Light",
    pairedTheme: "gruvbox-dark",
  },
  {
    appearance: "dark",
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    pairedTheme: "gruvbox-light",
  },
  {
    appearance: "light",
    id: "github-light",
    label: "GitHub Light",
  },
  {
    appearance: "light",
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    pairedTheme: "catppuccin-macchiato",
  },
  {
    appearance: "dark",
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    pairedTheme: "catppuccin-latte",
  },
] as const satisfies readonly ThemeDefinitionSeed[];

export type Theme = (typeof themeDefinitionSeeds)[number]["id"];

export type ThemeDefinition = {
  appearance: ThemeAppearance;
  id: Theme;
  label: string;
  pairedTheme?: Theme;
};

export const themeDefinitions = themeDefinitionSeeds as readonly ThemeDefinition[];

export const themeValues = themeDefinitions.map((theme) => theme.id) as readonly Theme[];

export const defaultTheme: Theme = "gruvbox-dark";

export const defaultThemeByAppearance: Record<ThemeAppearance, Theme> = {
  dark: "gruvbox-dark",
  light: "gruvbox-light",
};

export function isTheme(value: unknown): value is Theme {
  return typeof value == "string" && themeValues.includes(value as Theme);
}

export function nextTheme(theme: Theme): Theme {
  let definition = themeDefinition(theme);
  if (definition.pairedTheme) return definition.pairedTheme;
  return definition.appearance == "dark"
    ? defaultThemeByAppearance.light
    : defaultThemeByAppearance.dark;
}

export function themeDefinition(theme: Theme): ThemeDefinition {
  return (
    themeDefinitions.find((definition) => definition.id == theme) ??
    themeDefinitions.find((definition) => definition.id == defaultTheme)!
  );
}

export function themeAppearance(theme: Theme): ThemeAppearance {
  return themeDefinition(theme).appearance;
}

export function coerceTheme(value: unknown): Theme | null {
  if (isTheme(value)) return value;
  if (value == "dark") return "gruvbox-dark";
  if (value == "light") return "gruvbox-light";
  return null;
}
