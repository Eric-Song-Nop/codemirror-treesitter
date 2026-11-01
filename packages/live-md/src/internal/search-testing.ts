// Test-only search hooks; see `testing.ts`. Kept separate because importing
// `core/search.ts` registers LiveMD's search visibility test as a side effect.
import type { EditorState } from "@codemirror/state";
import { isLiveMdSearchVisible } from "../core/search.js";

export function __testIsLiveMdSearchVisible(state: EditorState, from: number, to: number) {
  return isLiveMdSearchVisible(state, from, to);
}
