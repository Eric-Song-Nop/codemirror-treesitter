import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { defineLiveMdEditor, prepareLiveMd } from "@codemirror-treesitter/live-md";
import { createWorkspaceApplication } from "./app/workspace-application";
import { WorkspaceApplicationProvider } from "./app/WorkspaceApplicationProvider";
import { App } from "./App";
import "./index.css";
import { LiveMdPreloadErrorProvider } from "./lib/editor/live-md-preload";
import { registerAppServiceWorker } from "./lib/platform/pwa";
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

const workspaceApplication = createWorkspaceApplication();

createRoot(document.getElementById("root")!).render(
  <WorkspaceApplicationProvider application={workspaceApplication}>
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider initialTheme={initialTheme}>
          <ThemeDocumentSync />
          <ThemeStorageSync />
          <LiveMdPreloadErrorProvider preload={prepareLiveMd}>
            <App />
          </LiveMdPreloadErrorProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>
  </WorkspaceApplicationProvider>,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void workspaceApplication.dispose();
  });
}

void registerAppServiceWorker();
