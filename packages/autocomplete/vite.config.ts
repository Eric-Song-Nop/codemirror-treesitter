import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@codemirror-treesitter/language": new URL("../language/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
