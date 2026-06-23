import { defineConfig } from "vite-plus";
import { workspaceAliases } from "./vite.shared.ts";

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  fmt: {
    ignorePatterns: [
      "apps/*/worker-configuration.d.ts",
      "packages/*/dist/**",
      "packages/*/src/**/*.d.ts",
      "!packages/language-data/src/assets.d.ts",
      "src/**/*.d.ts",
      "!src/assets.d.ts",
      "vendor/**",
    ],
  },
  lint: {
    ignorePatterns: [
      "apps/*/worker-configuration.d.ts",
      "packages/*/dist/**",
      "packages/*/src/**/*.d.ts",
      "!packages/language-data/src/assets.d.ts",
      "src/**/*.d.ts",
      "!src/assets.d.ts",
      "vendor/**",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
