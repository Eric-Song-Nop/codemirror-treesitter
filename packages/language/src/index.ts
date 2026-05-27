export {
  DocInput,
  Language,
  LanguageDescription,
  LanguageSupport,
  LRLanguage,
  NodeProp,
  NodeType,
  ParseContext,
  Tag,
  Tree,
  TreeSitterLanguage,
  TreeSitterParser,
  classHighlighter,
  defineLanguageFacet,
  ensureSyntaxTree,
  forceParsing,
  getStyleTags,
  language,
  languageDataProp,
  styleTags,
  sublanguageProp,
  syntaxParserRunning,
  syntaxTreeChangedRanges,
  syntaxTree,
  syntaxTreeAvailable,
  tagHighlighter,
  tags,
  type DocRange,
  type Highlighter,
  type NestedParser,
  type NestedParserSource,
  type NestedTree,
  type NodePropSource,
  type StyleTags,
  type Sublanguage,
  type SyntaxNode,
  type SyntaxNodeRef,
  type TreeSitterParserConfig,
} from "./language.js";

export {
  IndentContext,
  TreeIndentContext,
  continuedIndent,
  delimitedIndent,
  flatIndent,
  getIndentUnit,
  getIndentation,
  indentNodeProp,
  indentOnInput,
  indentRange,
  indentService,
  indentString,
  indentUnit,
} from "./indent.js";

export {
  codeFolding,
  foldAll,
  foldCode,
  foldEffect,
  foldGutter,
  foldInside,
  foldKeymap,
  foldNodeProp,
  foldService,
  foldState,
  foldable,
  foldedRanges,
  toggleFold,
  unfoldAll,
  unfoldCode,
  unfoldEffect,
} from "./fold.js";

export {
  HighlightStyle,
  defaultHighlightStyle,
  highlightCode,
  highlightTree,
  highlightingFor,
  syntaxHighlighting,
  type TagStyle,
} from "./highlight.js";

export {
  addTouchedLineRange,
  changedLineRanges,
  clipToRanges,
  lineRangesForChanges,
  mergeDocRanges,
  patchRangeSet,
  rangesTouch,
} from "./incremental.js";

export {
  bracketMatching,
  bracketMatchingHandle,
  matchBrackets,
  type Config,
  type MatchResult,
} from "./matchbrackets.js";

export { StreamLanguage, type StreamParser } from "./stream-parser.js";
export { StringStream } from "./stringstream.js";
export { bidiIsolates } from "./isolate.js";
