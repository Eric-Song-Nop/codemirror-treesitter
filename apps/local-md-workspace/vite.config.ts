import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { fileURLToPath, URL } from "node:url";
import { liveMdRawCssPlugin } from "../../packages/live-md/vite-plugin.ts";
import { workspaceAliases } from "../../vite.shared.ts";
import { serviceWorkerPrecachePlugin } from "./service-worker-precache-plugin.ts";

export default defineConfig({
  build: {
    manifest: true,
  },
  plugins: [
    liveMdRawCssPlugin(),
    react(),
    tailwindcss(),
    serviceWorkerPrecachePlugin(
      fileURLToPath(new URL("./public/service-worker.js", import.meta.url)),
    ),
  ],
  resolve: {
    alias: {
      ...workspaceAliases,
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
