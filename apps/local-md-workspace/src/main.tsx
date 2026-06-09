import { preloadLiveMdPreviewAssets } from "@codemirror-treesitter/live-md";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { preloadAppInstallAssets, registerAppServiceWorker } from "./lib/pwa";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void registerAppServiceWorker();
preloadAppInstallAssets(preloadLiveMdPreviewAssets);
