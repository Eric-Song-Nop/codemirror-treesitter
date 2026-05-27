import { defineConfig } from "vite-plus";
import { workspaceAliases } from "./vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  fmt: {
    ignorePatterns: [
      "packages/*/dist/**",
      "packages/*/src/*.d.ts",
      "!packages/language-data/src/assets.d.ts",
    ],
  },
  lint: {
    ignorePatterns: [
      "packages/*/dist/**",
      "packages/*/src/*.d.ts",
      "!packages/language-data/src/assets.d.ts",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
