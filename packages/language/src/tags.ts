import type { NodeType } from "./tree.js";

let nextTagId = 0;

export class Tag {
  readonly id = nextTagId++;

  constructor(
    readonly name: string,
    readonly set: Tag[],
    readonly base: Tag | null,
    readonly modified: readonly Modifier[],
  ) {}

  toString() {
    let name = this.name;
    for (let mod of this.modified) if (mod.name) name = `${mod.name}(${name})`;
    return name;
  }

  static define(name?: string, parent?: Tag): Tag;
  static define(parent?: Tag): Tag;
  static define(nameOrParent?: string | Tag, parent?: Tag): Tag {
    let name = typeof nameOrParent == "string" ? nameOrParent : "?";
    if (nameOrParent instanceof Tag) parent = nameOrParent;
    if (parent?.base) throw new Error("Can not derive from a modified tag");

    let tag = new Tag(name, [], null, []);
    tag.set.push(tag);
    if (parent) tag.set.push(...parent.set);
    return tag;
  }

  static defineModifier(name?: string): (tag: Tag) => Tag {
    let mod = new Modifier(name);
    return (tag: Tag) => {
      if (tag.modified.includes(mod)) return tag;
      return Modifier.get(
        tag.base || tag,
        tag.modified.concat(mod).sort((a, b) => a.id - b.id),
      );
    };
  }
}

let nextModifierId = 0;

class Modifier {
  readonly instances: Tag[] = [];
  readonly id = nextModifierId++;

  constructor(readonly name?: string) {}

  static get(base: Tag, mods: readonly Modifier[]): Tag {
    if (!mods.length) return base;

    let exists = mods[0]!.instances.find(
      (tag) => tag.base == base && sameArray(tag.modified, mods),
    );
    if (exists) return exists;

    let set: Tag[] = [];
    let tag = new Tag(base.name, set, base, mods);
    for (let mod of mods) mod.instances.push(tag);

    for (let parent of base.set) {
      if (!parent.modified.length) {
        for (let config of powerSet(mods)) set.push(Modifier.get(parent, config));
      }
    }
    return tag;
  }
}

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  return a.length == b.length && a.every((value, index) => value == b[index]);
}

function powerSet<T>(values: readonly T[]): (readonly T[])[] {
  let sets: T[][] = [[]];
  for (let i = 0; i < values.length; i++) {
    for (let j = 0, end = sets.length; j < end; j++) {
      sets.push(sets[j]!.concat(values[i]!));
    }
  }
  return sets.sort((a, b) => b.length - a.length);
}

const tag = (name: string, parent?: Tag) => Tag.define(name, parent);

const comment = tag("comment");
const name = tag("name");
const typeName = tag("typeName", name);
const propertyName = tag("propertyName", name);
const literal = tag("literal");
const string = tag("string", literal);
const number = tag("number", literal);
const content = tag("content");
const heading = tag("heading", content);
const keyword = tag("keyword");
const operator = tag("operator");
const punctuation = tag("punctuation");
const bracket = tag("bracket", punctuation);
const meta = tag("meta");

export const tags = {
  comment,
  lineComment: tag("lineComment", comment),
  blockComment: tag("blockComment", comment),
  docComment: tag("docComment", comment),

  name,
  variableName: tag("variableName", name),
  typeName,
  tagName: tag("tagName", typeName),
  propertyName,
  attributeName: tag("attributeName", propertyName),
  className: tag("className", name),
  labelName: tag("labelName", name),
  namespace: tag("namespace", name),
  macroName: tag("macroName", name),

  literal,
  string,
  docString: tag("docString", string),
  character: tag("character", string),
  attributeValue: tag("attributeValue", string),
  number,
  integer: tag("integer", number),
  float: tag("float", number),
  bool: tag("bool", literal),
  regexp: tag("regexp", literal),
  escape: tag("escape", literal),
  color: tag("color", literal),
  url: tag("url", literal),

  keyword,
  self: tag("self", keyword),
  null: tag("null", keyword),
  atom: tag("atom", keyword),
  unit: tag("unit", keyword),
  modifier: tag("modifier", keyword),
  operatorKeyword: tag("operatorKeyword", keyword),
  controlKeyword: tag("controlKeyword", keyword),
  definitionKeyword: tag("definitionKeyword", keyword),
  moduleKeyword: tag("moduleKeyword", keyword),

  operator,
  derefOperator: tag("derefOperator", operator),
  arithmeticOperator: tag("arithmeticOperator", operator),
  logicOperator: tag("logicOperator", operator),
  bitwiseOperator: tag("bitwiseOperator", operator),
  compareOperator: tag("compareOperator", operator),
  updateOperator: tag("updateOperator", operator),
  definitionOperator: tag("definitionOperator", operator),
  typeOperator: tag("typeOperator", operator),
  controlOperator: tag("controlOperator", operator),

  punctuation,
  separator: tag("separator", punctuation),
  bracket,
  angleBracket: tag("angleBracket", bracket),
  squareBracket: tag("squareBracket", bracket),
  paren: tag("paren", bracket),
  brace: tag("brace", bracket),

  content,
  heading,
  heading1: tag("heading1", heading),
  heading2: tag("heading2", heading),
  heading3: tag("heading3", heading),
  heading4: tag("heading4", heading),
  heading5: tag("heading5", heading),
  heading6: tag("heading6", heading),
  contentSeparator: tag("contentSeparator", content),
  list: tag("list", content),
  quote: tag("quote", content),
  emphasis: tag("emphasis", content),
  strong: tag("strong", content),
  link: tag("link", content),
  monospace: tag("monospace", content),
  strikethrough: tag("strikethrough", content),

  inserted: tag("inserted"),
  deleted: tag("deleted"),
  changed: tag("changed"),
  invalid: tag("invalid"),

  meta,
  documentMeta: tag("documentMeta", meta),
  annotation: tag("annotation", meta),
  processingInstruction: tag("processingInstruction", meta),

  definition: Tag.defineModifier("definition"),
  constant: Tag.defineModifier("constant"),
  function: Tag.defineModifier("function"),
  standard: Tag.defineModifier("standard"),
  local: Tag.defineModifier("local"),
  special: Tag.defineModifier("special"),
};

export interface Highlighter {
  style(tags: readonly Tag[]): string | null;
  scope?: (type: NodeType) => boolean;
}

export function tagHighlighter(
  specs: readonly { tag: Tag | readonly Tag[]; class: string }[],
  options: { scope?: (type: NodeType) => boolean; all?: string } = {},
): Highlighter {
  let map: Record<number, string | null> = Object.create(null);
  for (let spec of specs) {
    if (spec.tag instanceof Tag) {
      map[spec.tag.id] = spec.class;
    } else {
      for (let tag of spec.tag) map[tag.id] = spec.class;
    }
  }

  let { all = null, scope } = options;
  return {
    style: (active) => {
      let cls = all;
      for (let tag of active) {
        for (let sub of tag.set) {
          let tagClass = map[sub.id];
          if (tagClass) {
            cls = cls ? `${cls} ${tagClass}` : tagClass;
            break;
          }
        }
      }
      return cls;
    },
    scope,
  };
}

function withModifier(tag: Tag, modifier: string): Tag {
  switch (modifier) {
    case "builtin":
      return tags.standard(tag);
    case "call":
      return tag;
    case "constant":
      return tags.constant(tag);
    case "definition":
      return tags.definition(tag);
    case "documentation":
    case "doc":
      return tag == tags.comment ? tags.docComment : tag;
    case "function":
      return tags.function(tag);
    case "local":
      return tags.local(tag);
    case "member":
    case "method":
    case "parameter":
      return tag;
    case "special":
      return tags.special(tag);
    default:
      return tag;
  }
}

export function tagsForCapture(name: string): readonly Tag[] {
  let parts = name.split(".");
  let base = parts[0]!;
  let tag: Tag | readonly Tag[] | null = null;

  switch (base) {
    case "attribute":
      tag = tags.attributeName;
      break;
    case "boolean":
      tag = tags.bool;
      break;
    case "character":
      tag = parts.includes("special") ? tags.special(tags.character) : tags.character;
      break;
    case "comment":
      tag =
        parts.includes("doc") || parts.includes("documentation") ? tags.docComment : tags.comment;
      break;
    case "constant":
      tag = parts.includes("builtin")
        ? tags.atom
        : parts.includes("character")
          ? tags.character
          : tags.constant(tags.variableName);
      break;
    case "constructor":
      tag = tags.className;
      break;
    case "embedded":
      tag = tags.meta;
      break;
    case "error":
      tag = tags.invalid;
      break;
    case "escape":
      tag = tags.escape;
      break;
    case "field":
      tag = tags.propertyName;
      break;
    case "function":
      tag = parts.includes("method")
        ? tags.function(tags.propertyName)
        : parts.includes("macro")
          ? tags.function(tags.macroName)
          : tags.function(tags.variableName);
      break;
    case "keyword":
      tag = parts.includes("operator")
        ? tags.operatorKeyword
        : parts.includes("function") || parts.includes("type")
          ? tags.definitionKeyword
          : parts.includes("import") || parts.includes("directive")
            ? tags.moduleKeyword
            : parts.includes("modifier")
              ? tags.modifier
              : parts.includes("conditional") ||
                  parts.includes("repeat") ||
                  parts.includes("return") ||
                  parts.includes("exception")
                ? tags.controlKeyword
                : tags.keyword;
      break;
    case "label":
      tag = tags.labelName;
      break;
    case "method":
      tag = tags.function(tags.propertyName);
      break;
    case "module":
    case "namespace":
      tag = tags.namespace;
      break;
    case "none":
      tag = null;
      break;
    case "number":
      tag = parts.includes("float") ? tags.float : tags.number;
      break;
    case "operator":
      tag = tags.operator;
      break;
    case "parameter":
      tag = tags.variableName;
      break;
    case "preproc":
      tag = tags.processingInstruction;
      break;
    case "property":
      tag = parts.includes("definition") ? tags.definition(tags.propertyName) : tags.propertyName;
      break;
    case "punctuation":
      tag = parts.includes("bracket")
        ? tags.bracket
        : parts.includes("delimiter")
          ? tags.separator
          : tags.punctuation;
      break;
    case "regexp":
      tag = tags.regexp;
      break;
    case "selector":
      tag = tags.tagName;
      break;
    case "string":
      tag = parts.includes("escape")
        ? tags.escape
        : parts.includes("regex") || parts.includes("regexp")
          ? tags.regexp
          : parts.includes("special")
            ? tags.special(tags.string)
            : tags.string;
      break;
    case "tag":
      tag = parts.includes("error") ? [tags.tagName, tags.invalid] : tags.tagName;
      break;
    case "text":
      tag = parts.includes("title")
        ? tags.heading
        : parts.includes("literal")
          ? tags.monospace
          : parts.includes("reference")
            ? tags.link
            : parts.includes("emphasis")
              ? tags.emphasis
              : parts.includes("strong")
                ? tags.strong
                : parts.includes("uri")
                  ? tags.url
                  : tags.content;
      break;
    case "type":
      tag = parts.includes("definition")
        ? tags.definition(tags.typeName)
        : parts.includes("qualifier")
          ? tags.modifier
          : tags.typeName;
      break;
    case "variable":
      tag = parts.includes("member") ? tags.propertyName : tags.variableName;
      break;
  }

  if (!tag) return [];
  let result = Array.isArray(tag) ? tag : [tag];
  for (let part of parts.slice(1)) result = result.map((tag) => withModifier(tag, part));
  return result;
}

export const classHighlighter = tagHighlighter([
  { tag: tags.link, class: "tok-link" },
  { tag: tags.heading, class: "tok-heading" },
  { tag: tags.emphasis, class: "tok-emphasis" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: tags.keyword, class: "tok-keyword" },
  { tag: tags.atom, class: "tok-atom" },
  { tag: tags.bool, class: "tok-bool" },
  { tag: tags.url, class: "tok-url" },
  { tag: tags.labelName, class: "tok-labelName" },
  { tag: tags.inserted, class: "tok-inserted" },
  { tag: tags.deleted, class: "tok-deleted" },
  { tag: tags.literal, class: "tok-literal" },
  { tag: tags.string, class: "tok-string" },
  { tag: tags.number, class: "tok-number" },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], class: "tok-string2" },
  { tag: tags.variableName, class: "tok-variableName" },
  { tag: tags.local(tags.variableName), class: "tok-variableName tok-local" },
  { tag: tags.definition(tags.variableName), class: "tok-variableName tok-definition" },
  { tag: tags.special(tags.variableName), class: "tok-variableName2" },
  { tag: tags.definition(tags.propertyName), class: "tok-propertyName tok-definition" },
  { tag: tags.typeName, class: "tok-typeName" },
  { tag: tags.namespace, class: "tok-namespace" },
  { tag: tags.className, class: "tok-className" },
  { tag: tags.macroName, class: "tok-macroName" },
  { tag: tags.propertyName, class: "tok-propertyName" },
  { tag: tags.operator, class: "tok-operator" },
  { tag: tags.comment, class: "tok-comment" },
  { tag: tags.meta, class: "tok-meta" },
  { tag: tags.invalid, class: "tok-invalid" },
  { tag: tags.punctuation, class: "tok-punctuation" },
]);
