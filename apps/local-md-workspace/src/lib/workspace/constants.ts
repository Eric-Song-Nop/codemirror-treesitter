export const githubRepositoryUrl = "https://github.com/Eric-Song-Nop/codemirror-treesitter";

const mobileSidebarMediaQuery = "(max-width: 767px)";

export function isMobileSidebarViewport() {
  return typeof window != "undefined" && window.matchMedia(mobileSidebarMediaQuery).matches;
}

export function defaultSidebarOpen() {
  return !isMobileSidebarViewport();
}
