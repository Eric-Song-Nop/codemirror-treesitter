import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { fileURLToPath, URL } from "node:url";
import { liveMdRawCssPlugin } from "../../packages/live-md/vite-plugin.ts";
import { workspaceAliases } from "../../vite.shared.ts";

export default defineConfig({
  plugins: [liveMdRawCssPlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      ...workspaceAliases,
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
