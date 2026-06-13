export type LiveMdThemeAppearance = "dark" | "light";

export const liveMdThemeVariableNames = [
  "--live-md-bg",
  "--live-md-text",
  "--live-md-muted",
  "--live-md-accent",
  "--live-md-accent-2",
  "--live-md-list-marker",
  "--live-md-border",
  "--live-md-code-bg",
  "--live-md-code-text",
  "--live-md-code-muted",
  "--live-md-code-border",
  "--live-md-cursor",
  "--live-md-selection",
  "--live-md-active-line",
  "--live-md-syntax",
  "--live-md-heading-1",
  "--live-md-heading-2",
  "--live-md-heading-3",
  "--live-md-heading-rest",
  "--live-md-inline-code-bg",
  "--live-md-inline-code-text",
  "--live-md-inline-code-border",
  "--live-md-link",
  "--live-md-link-underline",
  "--live-md-latex",
  "--live-md-error",
  "--live-md-error-border",
  "--live-md-surface",
  "--live-md-surface-error",
  "--live-md-surface-error-border",
  "--live-md-blockquote",
  "--live-md-blockquote-border",
  "--live-md-ordered-marker",
  "--live-md-task-border",
  "--live-md-task-bg",
  "--live-md-task-check",
  "--live-md-task-checked",
  "--live-md-task-checked-strong",
  "--live-md-rule",
  "--live-md-table-line-bg",
  "--live-md-table-divider",
  "--live-md-table-pipe",
  "--live-md-table-bg",
  "--live-md-table-border",
  "--live-md-table-header-bg",
  "--live-md-table-header-text",
  "--live-md-content-width",
  "--live-md-content-padding-block-start",
  "--live-md-content-padding-inline",
  "--live-md-content-padding-block-end",
  "--live-md-font-body",
  "--live-md-font-ui",
  "--live-md-font-code",
  "--live-md-mermaid-bg",
  "--live-md-mermaid-text",
  "--live-md-mermaid-muted",
  "--live-md-mermaid-line",
  "--live-md-mermaid-accent",
  "--live-md-mermaid-border",
  "--live-md-mermaid-surface",
  "--live-md-mermaid-font",
  "--live-md-mermaid-mono-font",
] as const;

export const liveMdThemeColorVariableNames = liveMdThemeVariableNames.filter(
  (name) =>
    !name.startsWith("--live-md-content-") &&
    name != "--live-md-font-body" &&
    name != "--live-md-font-ui" &&
    name != "--live-md-font-code" &&
    name != "--live-md-mermaid-font" &&
    name != "--live-md-mermaid-mono-font",
) as LiveMdThemeColorVariable[];

export type LiveMdThemeVariable = (typeof liveMdThemeVariableNames)[number];
export type LiveMdThemeColorVariable = Exclude<
  LiveMdThemeVariable,
  | "--live-md-content-width"
  | "--live-md-content-padding-block-start"
  | "--live-md-content-padding-inline"
  | "--live-md-content-padding-block-end"
  | "--live-md-font-body"
  | "--live-md-font-ui"
  | "--live-md-font-code"
  | "--live-md-mermaid-font"
  | "--live-md-mermaid-mono-font"
>;
export type LiveMdThemeVariables = Partial<Record<LiveMdThemeVariable, string>>;
export type LiveMdThemeColorVariables = Record<LiveMdThemeColorVariable, string>;

export type LiveMdThemeSpec = {
  appearance: LiveMdThemeAppearance;
  id: string;
  variables: LiveMdThemeVariables;
};

export type LiveMdThemeVariableTarget = {
  style: {
    removeProperty(name: string): string;
    setProperty(name: string, value: string): void;
  };
};

export function createLiveMdTheme(spec: LiveMdThemeSpec): LiveMdThemeSpec {
  return spec;
}

export function setLiveMdThemeVariables(
  target: LiveMdThemeVariableTarget,
  theme: LiveMdThemeSpec,
) {
  for (let name of liveMdThemeVariableNames) {
    let value = theme.variables[name];
    if (value == null) {
      target.style.removeProperty(name);
    } else {
      target.style.setProperty(name, value);
    }
  }
}

export function clearLiveMdThemeVariables(target: LiveMdThemeVariableTarget) {
  for (let name of liveMdThemeVariableNames) target.style.removeProperty(name);
}
