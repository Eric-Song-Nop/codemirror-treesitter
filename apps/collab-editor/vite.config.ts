import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
import { liveMdRawCssPlugin } from "../../packages/live-md/vite-plugin.ts";
import { workspaceAliases } from "../../vite.shared.ts";

export default defineConfig({
  plugins: [liveMdRawCssPlugin(), cloudflare()],
  resolve: { alias: workspaceAliases },
});
