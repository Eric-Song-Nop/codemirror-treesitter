import { defineConfig } from "vite-plus";
import { workspaceAliases } from "../../vite.shared.ts";

export default defineConfig({
  resolve: { alias: workspaceAliases },
});
