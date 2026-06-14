import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { defineLiveMdEditor, prepareLiveMd } from "@codemirror-treesitter/live-md";
import { App } from "./App";
import "./index.css";
import { LiveMdPreloadErrorProvider, liveMdPreloadErrorMessage } from "./lib/live-md-preload";
import { registerAppServiceWorker } from "./lib/pwa";
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
    <ThemeProvider initialTheme={initialTheme}>
      <ThemeDocumentSync />
      <ThemeStorageSync />
      <LiveMdPreloadErrorProvider preloadStatus={liveMdPreloadStatus}>
        <App />
      </LiveMdPreloadErrorProvider>
    </ThemeProvider>
  </StrictMode>,
);

void registerAppServiceWorker();
