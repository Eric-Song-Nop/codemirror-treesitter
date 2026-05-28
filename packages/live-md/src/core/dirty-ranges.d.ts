import type { ChangeDesc, EditorState } from "@codemirror/state";
import { type DocRange, type SyntaxNode } from "@codemirror-treesitter/language";
import type { LiveMdFeatureRegistry } from "./features.js";
export type LiveMdDirtyReason = "codeFenceLanguages" | "selection" | "syntax" | "text";
export type LiveMdDirtyRange = {
    from: number;
    reasons: readonly LiveMdDirtyReason[];
    to: number;
};
export type LiveMdDirtySourceRange = {
    from: number;
    reason: LiveMdDirtyReason;
    to: number;
};
export type LiveMdDirtyInvalidation = {
    nodes: readonly string[];
    reason: LiveMdDirtyReason;
};
export type CollectLiveMdDirtyRangesInput = {
    activeLines?: readonly number[];
    changes: ChangeDesc;
    previousActiveLines?: readonly number[];
    sourceRanges?: readonly LiveMdDirtySourceRange[];
    startState: EditorState;
    state: EditorState;
    syntaxChangedRanges?: readonly DocRange[];
};
export type ExpandLiveMdDirtyRangesInput = {
    ranges: readonly LiveMdDirtyRange[];
    registry: LiveMdDirtyRangeRegistry;
    state: EditorState;
};
export type AnalyzeLiveMdDirtyRangesInput = CollectLiveMdDirtyRangesInput & {
    invalidations?: readonly LiveMdDirtyInvalidation[];
    registry: LiveMdDirtyRangeRegistry;
};
export type LiveMdDirtyAnalysis = {
    dirtyRanges: LiveMdDirtyRange[];
    expandedDirtyRanges: LiveMdDirtyRange[];
};
export type LiveMdDirtyRangeRegistry = Pick<LiveMdFeatureRegistry<unknown, SyntaxNode>, "hasNode" | "scopeFor">;
export declare function analyzeLiveMdDirtyRanges(input: AnalyzeLiveMdDirtyRangesInput): LiveMdDirtyAnalysis;
export declare function collectLiveMdDirtyRanges(input: CollectLiveMdDirtyRangesInput): LiveMdDirtyRange[];
export declare const __testCollectLiveMdDirtyRanges: typeof collectLiveMdDirtyRanges;
export type CollectSyntaxNodeDirtyRangesInput = {
    nodes: readonly string[];
    reason: LiveMdDirtyReason;
    state: EditorState;
};
export declare function collectSyntaxNodeDirtyRanges(input: CollectSyntaxNodeDirtyRangesInput): LiveMdDirtySourceRange[];
export declare function expandLiveMdDirtyRanges(input: ExpandLiveMdDirtyRangesInput): LiveMdDirtyRange[];
