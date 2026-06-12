import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { registerAppServiceWorker } from "./lib/pwa";
import {
  defaultTheme,
  loadStoredTheme,
  ThemeDocumentSync,
  ThemeProvider,
  ThemeStorageSync,
} from "./theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider initialTheme={loadStoredTheme() ?? defaultTheme}>
      <ThemeDocumentSync />
      <ThemeStorageSync />
      <App />
    </ThemeProvider>
  </StrictMode>,
);

void registerAppServiceWorker();
