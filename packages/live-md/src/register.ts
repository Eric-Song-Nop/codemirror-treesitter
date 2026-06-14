import { prepareLiveMd } from "./core/languages.js";
import { defineLiveMdEditor } from "./element/live-md-editor.js";

defineLiveMdEditor();
void prepareLiveMd().catch((error: unknown) => {
  dispatchLiveMdRegisterError(error);
});

export { prepareLiveMd, type PrepareLiveMdOptions } from "./core/languages.js";
export { defineLiveMdEditor, LiveMdEditorElement } from "./element/live-md-editor.js";

function dispatchLiveMdRegisterError(error: unknown) {
  if (typeof globalThis.dispatchEvent != "function" || typeof CustomEvent != "function") return;
  globalThis.dispatchEvent(
    new CustomEvent("live-md-error", {
      detail: { error },
    }),
  );
}
