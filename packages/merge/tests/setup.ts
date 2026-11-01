import { TreeSitterParser } from "@codemirror-treesitter/language";

// Under happy-dom, `new URL("...wasm", import.meta.url).pathname` yields Vite
// `/@fs/<absolute path>` URLs; map them back to file paths for Node.
TreeSitterParser.setAssetResolver((url) => (url.startsWith("/@fs/") ? url.slice(4) : url));
