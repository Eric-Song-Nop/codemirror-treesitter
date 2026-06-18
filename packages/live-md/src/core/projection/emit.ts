import { RangeSet, RangeSetBuilder, RangeValue, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type WidgetType } from "@codemirror/view";
import { forEachLineInRange, splitRangeByLine } from "../util.js";
import type {
  CodeFenceParseResult,
  LiveMdProjectionDecoration,
  LiveMdProjectionInput,
} from "./types.js";

export type LiveMdProjectionFinish = {
  readonly atomicRanges: RangeSet<RangeValue>;
  readonly codeFenceParses: readonly CodeFenceParseResult[];
  readonly decorations: DecorationSet;
};

export type LiveMdProjectionReplaceOptions = {
  readonly atomic?: boolean;
  readonly block?: boolean;
};

export type LiveMdSyntaxVisibilityOptions = {
  readonly hiddenDecoration?: LiveMdProjectionDecoration;
  readonly visibleDecoration?: LiveMdProjectionDecoration;
};

export type LiveMdAtomicParagraphGapOptions = {
  readonly className?: string;
  readonly line?: number;
};

export class LiveMdAtomicRange extends RangeValue {
  constructor(readonly kind = "atomic") {
    super();
  }

  eq(other: RangeValue) {
    return other instanceof LiveMdAtomicRange && other.kind == this.kind;
  }
}

export const liveMdAtomicRange = new LiveMdAtomicRange();
export const liveMdParagraphGapAtomicRange = new LiveMdAtomicRange("paragraphGap");

const visibleSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" });
const hiddenSyntax = Decoration.mark({ class: "cm-md-syntax cm-md-syntax-hidden" });

export class LiveMdProjectionEmitter {
  private readonly atomicRanges: Array<{ from: number; to: number; value: RangeValue }> = [];
  private readonly decorations: Array<Range<Decoration>> = [];
  private readonly lineClasses = new Map<number, Set<string>>();
  private readonly markCache = new Map<string, Decoration>();
  readonly codeFenceParses: CodeFenceParseResult[] = [];

  constructor(readonly input: LiveMdProjectionInput) {}

  mark(from: number, to: number, decoration: LiveMdProjectionDecoration) {
    if (from >= to) return;
    let resolved = this.decoration(decoration);
    this.forEachProjectionRange(from, to, (rangeFrom, rangeTo) => {
      this.decorations.push(resolved.range(rangeFrom, rangeTo));
    });
  }

  replace(
    from: number,
    to: number,
    widget: WidgetType,
    options: LiveMdProjectionReplaceOptions = {},
  ) {
    if (from >= to) return;
    this.decorations.push(
      Decoration.replace({ block: options.block ?? false, widget }).range(from, to),
    );
    if (options.atomic) this.atomicRange(from, to);
  }

  lineClass(lineNumber: number, className: string) {
    if (!this.lineTouchesProjectionRanges(lineNumber)) return;
    let classes = this.lineClasses.get(lineNumber);
    if (!classes) this.lineClasses.set(lineNumber, (classes = new Set()));
    classes.add(className);
  }

  lineRangeClass(from: number, to: number, className: string) {
    if (from >= to) return;
    this.forEachProjectionRange(from, to, (rangeFrom, rangeTo) => {
      forEachLineInRange(this.input.state, rangeFrom, rangeTo, (line) => {
        this.lineClass(line.number, className);
      });
    });
  }

  syntaxVisibility(from: number, to: number, options: LiveMdSyntaxVisibilityOptions = {}) {
    if (from >= to) return;
    splitRangeByLine(this.input.state, from, to, (lineNumber, rangeFrom, rangeTo) => {
      let active = this.input.activeLines.has(lineNumber);
      let decoration = active
        ? (options.visibleDecoration ?? visibleSyntax)
        : (options.hiddenDecoration ?? hiddenSyntax);
      this.mark(rangeFrom, rangeTo, decoration);
    });
  }

  atomicParagraphGap(from: number, to: number, options: LiveMdAtomicParagraphGapOptions = {}) {
    this.atomicRange(from, to, liveMdParagraphGapAtomicRange);
    this.lineClass(
      options.line ?? this.paragraphGapLine(from),
      options.className ?? "cm-md-block-separator",
    );
  }

  atomicRange(from: number, to: number, value: RangeValue = liveMdAtomicRange) {
    if (from >= to || !this.rangeTouchesProjectionRanges(from, to)) return;
    this.atomicRanges.push({ from, to, value });
  }

  addCodeFenceParse(parse: CodeFenceParseResult) {
    this.codeFenceParses.push(parse);
  }

  finish(): LiveMdProjectionFinish {
    let lineDecorations = new RangeSetBuilder<Decoration>();
    let lineClasses = Array.from(this.lineClasses).sort(
      ([leftLine], [rightLine]) => leftLine - rightLine,
    );
    for (let [lineNumber, classes] of lineClasses) {
      let docLine = this.input.state.doc.line(lineNumber);
      lineDecorations.add(
        docLine.from,
        docLine.from,
        Decoration.line({ class: [...classes].join(" ") }),
      );
    }

    let atomicRanges = new RangeSetBuilder<RangeValue>();
    this.atomicRanges.sort((left, right) => left.from - right.from || left.to - right.to);
    for (let range of this.atomicRanges) {
      atomicRanges.add(range.from, range.to, range.value);
    }

    return {
      atomicRanges: atomicRanges.finish(),
      codeFenceParses: this.codeFenceParses
        .slice()
        .sort(
          (left, right) => left.contentFrom - right.contentFrom || left.contentTo - right.contentTo,
        ),
      decorations: RangeSet.join([lineDecorations.finish(), RangeSet.of(this.decorations, true)]),
    };
  }

  private decoration(decoration: LiveMdProjectionDecoration) {
    if (typeof decoration != "string") return decoration;
    let cached = this.markCache.get(decoration);
    if (!cached) {
      cached = Decoration.mark({ class: decoration });
      this.markCache.set(decoration, cached);
    }
    return cached;
  }

  private forEachProjectionRange(
    from: number,
    to: number,
    visit: (from: number, to: number) => void,
  ) {
    for (let range of this.input.ranges) {
      let rangeFrom = Math.max(from, range.from);
      let rangeTo = Math.min(to, range.to);
      if (rangeFrom < rangeTo) visit(rangeFrom, rangeTo);
    }
  }

  private lineTouchesProjectionRanges(lineNumber: number) {
    if (lineNumber < 1 || lineNumber > this.input.state.doc.lines) return false;
    let line = this.input.state.doc.line(lineNumber);
    let lineTo = line.to < this.input.state.doc.length ? line.to + 1 : line.to;
    return this.input.ranges.some((range) => rangesTouch(line.from, lineTo, range.from, range.to));
  }

  private paragraphGapLine(from: number) {
    let position = Math.min(this.input.state.doc.length, Math.max(0, from + 1));
    return this.input.state.doc.lineAt(position).number;
  }

  private rangeTouchesProjectionRanges(from: number, to: number) {
    return this.input.ranges.some((range) => rangesTouch(from, to, range.from, range.to));
  }
}

export function emitMark(
  emitter: LiveMdProjectionEmitter,
  from: number,
  to: number,
  decoration: LiveMdProjectionDecoration,
) {
  emitter.mark(from, to, decoration);
}

export function emitReplace(
  emitter: LiveMdProjectionEmitter,
  from: number,
  to: number,
  widget: WidgetType,
  options?: LiveMdProjectionReplaceOptions,
) {
  emitter.replace(from, to, widget, options);
}

export function emitLineClass(
  emitter: LiveMdProjectionEmitter,
  fromOrLine: number,
  toOrClassName: number | string,
  className?: string,
) {
  if (typeof toOrClassName == "string") {
    emitter.lineClass(fromOrLine, toOrClassName);
  } else if (className) {
    emitter.lineRangeClass(fromOrLine, toOrClassName, className);
  }
}

export function emitSyntaxVisibility(
  emitter: LiveMdProjectionEmitter,
  from: number,
  to: number,
  options?: LiveMdSyntaxVisibilityOptions,
) {
  emitter.syntaxVisibility(from, to, options);
}

export function emitAtomicParagraphGap(
  emitter: LiveMdProjectionEmitter,
  from: number,
  to: number,
  options?: LiveMdAtomicParagraphGapOptions,
) {
  emitter.atomicParagraphGap(from, to, options);
}

function rangesTouch(leftFrom: number, leftTo: number, rightFrom: number, rightTo: number) {
  return leftFrom < rightTo && leftTo > rightFrom;
}
