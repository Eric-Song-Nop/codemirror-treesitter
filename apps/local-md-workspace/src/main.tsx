import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider initialTheme={initialTheme}>
      <ThemeDocumentSync />
      <ThemeStorageSync />
      <App />
    </ThemeProvider>
  </StrictMode>,
);

void registerAppServiceWorker();
