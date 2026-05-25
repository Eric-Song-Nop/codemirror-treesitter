import { defineConfig } from "vite-plus";
import { workspaceAliases } from "../../vite.config.ts";

export default defineConfig({
  resolve: { alias: workspaceAliases },
});
