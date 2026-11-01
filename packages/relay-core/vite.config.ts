import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    dts: {
      tsgo: true,
    },
    entry: ["src/index.ts", "src/client.ts"],
    exports: true,
  },
});
