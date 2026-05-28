import { StateField, type Extension } from "@codemirror/state";
import { type TreeSitterParser } from "@codemirror-treesitter/language";
export type CodeFenceLanguageMap = ReadonlyMap<string, TreeSitterParser>;
export declare const emptyCodeFenceLanguages: CodeFenceLanguageMap;
export declare const setCodeFenceLanguages: import("@codemirror/state").StateEffectType<CodeFenceLanguageMap>;
export declare const codeFenceLanguagesField: StateField<CodeFenceLanguageMap>;
export declare const codeFenceHighlightModule: Extension;
export declare function loadMarkdownExtension(): Promise<Extension>;
export declare function loadCodeFenceLanguages(): Promise<CodeFenceLanguageMap>;
