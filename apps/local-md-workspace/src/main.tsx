import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { defineLiveMdEditor, prepareLiveMd } from "@codemirror-treesitter/live-md";
import { App } from "./App";
import "./index.css";
import { LiveMdPreloadErrorProvider, liveMdPreloadErrorMessage } from "./lib/live-md-preload";
import { registerAppServiceWorker } from "./lib/pwa";
import { queryClient } from "./lib/query-client";
import {
  applyThemeToDocument,
  defaultTheme,
  loadStoredTheme,
  ThemeDocumentSync,
  ThemeProvider,
  ThemeStorageSync,
} from "./theme";

let initialTheme = loadStoredTheme() ?? defaultTheme;
applyThemeToDocument(initialTheme);

defineLiveMdEditor();
let liveMdPreloadStatus = prepareLiveMd().then(
  () => "",
  (error: unknown) => liveMdPreloadErrorMessage(error),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider initialTheme={initialTheme}>
        <ThemeDocumentSync />
        <ThemeStorageSync />
        <LiveMdPreloadErrorProvider preloadStatus={liveMdPreloadStatus}>
          <App />
        </LiveMdPreloadErrorProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);

void registerAppServiceWorker();
