import { prepareLiveMd } from "./core/languages.js";
import { defineLiveMdEditor } from "./element/live-md-editor.js";

await prepareLiveMd();
defineLiveMdEditor();

export { prepareLiveMd, type PrepareLiveMdOptions } from "./core/languages.js";
export { defineLiveMdEditor, LiveMdEditorElement } from "./element/live-md-editor.js";
