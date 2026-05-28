import { Decoration, EditorView, WidgetType } from "@codemirror/view";
export type MarkdownTable = {
    alignments: Array<"center" | "default" | "left" | "right">;
    header: string[];
    rows: string[][];
};
export type LatexFormula = {
    block: boolean;
    displayMode: boolean;
    source: string;
    tex: string;
};
export type MermaidDiagram = {
    source: string;
};
export declare class TaskCheckboxWidget extends WidgetType {
    private checked;
    constructor(checked: boolean);
    eq(other: TaskCheckboxWidget): boolean;
    toDOM(view: EditorView): HTMLButtonElement;
    ignoreEvent(): boolean;
}
export declare class LatexWidget extends WidgetType {
    private block;
    private displayMode;
    private source;
    private tex;
    constructor(formula: LatexFormula);
    eq(other: LatexWidget): boolean;
    toDOM(): HTMLDivElement | HTMLSpanElement;
    ignoreEvent(): boolean;
}
export declare class MermaidWidget extends WidgetType {
    private source;
    constructor(diagram: MermaidDiagram);
    eq(other: MermaidWidget): boolean;
    toDOM(view: EditorView): HTMLDivElement;
    destroy(dom: HTMLElement): void;
    ignoreEvent(): boolean;
}
export declare class ListMarkerWidget extends WidgetType {
    private marker;
    constructor(marker: string);
    eq(other: ListMarkerWidget): boolean;
    toDOM(): HTMLSpanElement;
}
export declare class ImagePreviewWidget extends WidgetType {
    private alt;
    private src;
    constructor(alt: string, src: string);
    eq(other: ImagePreviewWidget): boolean;
    toDOM(): HTMLElement;
}
export declare class TablePreviewWidget extends WidgetType {
    private table;
    private tableKey;
    constructor(table: MarkdownTable);
    eq(other: TablePreviewWidget): boolean;
    toDOM(view: EditorView): HTMLDivElement;
}
export declare function replaceWithWidget(from: number, to: number, widget: WidgetType, block?: boolean): {
    decoration: Decoration;
    from: number;
    to: number;
};
