import { type Extension } from "@codemirror/state";
export type LiveMarkdownOptions = {
    ariaLabel?: string;
    className?: string;
    placeholder?: string;
    spellcheck?: boolean;
};
export declare function liveMarkdown(options?: LiveMarkdownOptions): Extension;
