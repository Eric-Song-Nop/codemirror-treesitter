import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@codemirror-treesitter/language";
export type DocLine = {
    from: number;
    number: number;
    to: number;
};
export declare function forEachLineInRange(state: EditorState, from: number, to: number, visit: (line: DocLine) => void): void;
export declare function splitRangeByLine(state: EditorState, from: number, to: number, visit: (lineNumber: number, from: number, to: number) => void): void;
export declare function isWhitespaceOnly(value: string): boolean;
export declare function isWhitespace(code: number): code is 9 | 10 | 13 | 32;
export declare function isAsciiDigit(code: number): boolean;
export declare function hasAncestor(node: SyntaxNode | null, name: string): boolean;
