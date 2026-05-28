import { type ChangeDesc, EditorState, RangeSet, RangeValue, StateField, Text } from "@codemirror/state";
import { type SyntaxNode, type Tree } from "@codemirror-treesitter/language";
import { Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import { type CodeFenceLanguageMap } from "./languages.js";
import { type LiveMdDirtyRange, type LiveMdDirtyReason } from "./dirty-ranges.js";
type VisitContext = {
    activeLines: Set<number>;
    codeFenceHighlightCache: Map<string, CodeFenceHighlightTree>;
    codeFenceLanguages: CodeFenceLanguageMap;
    dirtyRange: LiveMdDirtyRange | null;
    dirtyReasons: readonly LiveMdDirtyReason[] | null;
    plannedCodeFenceHighlightKeys: Set<string>;
    previousCodeFenceHighlights: readonly CodeFenceHighlightTree[];
    changes: ChangeDesc | null;
    plan: DecorationPlan;
    state: EditorState;
};
type CodeFenceParser = CodeFenceLanguageMap extends ReadonlyMap<string, infer Parser> ? Parser : never;
type CodeFenceHighlightTree = {
    contentFrom: number;
    contentTo: number;
    language: string;
    parser: CodeFenceParser;
    sourceText: Text;
    tree: Tree;
};
type LiveMdAnalysis = {
    activeLines: ReadonlySet<number>;
    atomicRanges: RangeSet<RangeValue>;
    codeFenceHighlightTrees: readonly CodeFenceHighlightTree[];
    codeFenceLanguages: CodeFenceLanguageMap;
    decorations: DecorationSet;
    dirtyRanges: readonly LiveMdDirtyRange[];
    expandedDirtyRanges: readonly LiveMdDirtyRange[];
};
export declare const liveMdAnalysis: StateField<LiveMdAnalysis>;
export declare const __testLiveMdFeatureRegistry: import("./features.js").LiveMdFeatureRegistry<VisitContext, SyntaxNode>;
declare class AtomicRange extends RangeValue {
    eq(other: RangeValue): other is AtomicRange;
}
declare class DecorationPlan {
    private atomicRanges;
    private codeFenceHighlightTrees;
    private dirtyRange;
    private lineClasses;
    private ranges;
    private state;
    constructor(state: EditorState);
    setDirtyRange(range: LiveMdDirtyRange | null): void;
    line(lineNumber: number, className: string): void;
    lineClass(from: number, to: number, className: string): void;
    atom(from: number, to: number): void;
    codeFenceHighlight(tree: CodeFenceHighlightTree): void;
    mark(from: number, to: number, decoration: Decoration): void;
    markByLine(from: number, to: number, decorationForLine: (lineNumber: number) => Decoration): void;
    replace(from: number, to: number, widget: WidgetType, block?: boolean): void;
    syntax(from: number, to: number, activeLines: Set<number>, decoration?: Decoration): void;
    finish(): RangeSet<Decoration>;
    finishDecorationRanges(): import("@codemirror/state").Range<Decoration>[];
    finishAtomicRanges(): RangeSet<RangeValue>;
    finishAtomicRangeValues(): import("@codemirror/state").Range<AtomicRange>[];
    finishCodeFenceHighlightTrees(): CodeFenceHighlightTree[];
    private finishDecorationSpecs;
    private touchesDirtyRange;
}
export declare function __testBuildLiveMdAnalysis(state: EditorState): LiveMdAnalysis;
export {};
