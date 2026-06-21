# LiveMD 重写可行性审计（修正版）

## 全局 Tree-sitter 增量解析 + Block-owned 分析/投影热路径

**研究日期：2026-06-20**  
**适用项目：`Eric-Song-Nop/codemirror-treesitter`**  
**重点版本：`web-tree-sitter@0.26.9`、`@codemirror/state@^6.6.0`、`@codemirror/view@^6.43.0`**  
**状态：本文件取代此前“普通输入绕过全局 Markdown parser”的方案。**

---

## 1. 最终结论

这个思路是可行的，但正确表述不是：

```text
普通输入
→ 绕过全局 Tree-sitter
→ 自己解析当前 Markdown block
```

而是：

```text
CodeMirror Text
→ 全局 Markdown Tree-sitter 增量解析（始终保留）
→ outer/nested syntax delta
→ 只更新发生变化的 LiveMD block
→ 只重新执行这些 block 的 query、semantic analysis 和 projection
→ patch CodeMirror DecorationSet
```

Tree-sitter 已经解决了“如何从旧语法树增量得到新的全局语法树”。LiveMD 不应再实现一个竞争性的 Markdown block parser。Typora 式 block 思想真正应该应用在 **parser 之后**：让 block 成为 query、分析、缓存、widget 和 decoration projection 的所有者。

### 可行性判断

| 目标 | 判断 |
|---|---|
| 保留全局 Markdown 增量 parse | 已实现，方向正确 |
| 普通段落输入只重新分析当前 inline block | 可实现 |
| 普通 list item 输入不重建整个 list | 可实现 |
| table cell 输入只重新 parse 对应 inline tree，但重投影整张 table | 可实现 |
| code fence 内部使用旧子语言 tree 增量 parse | 可实现 |
| selection 移动只重投影 old/new active block | 可实现 |
| viewport 滚动不触发 Markdown semantic re-query | 可实现 |
| 所有 layout widget 都改成 viewport-only ViewPlugin | **不可实现**，违反 CodeMirror direct-decoration 约束 |
| 任意 Markdown 编辑永远只影响当前 block | **不可实现**，语法可能真实传播到 EOF |
| 对任意 Markdown 保证严格 CommonMark 正确 | **不可由当前 grammar 保证** |
| 在 parser 暂未完成时始终拥有正确的新语法树 | **不可保证**，需要 provisional UI 策略 |
| 仅重写 `packages/live-md` 就消除所有大文档线性成本 | **不可实现**，还需修改 `packages/language` 的 nested-tree 调度 |

所以最终建议是：**重写 LiveMD，同时对 language 层做一次有针对性的增量 nested-tree 改造。**

---

## 2. 关键纠正：全局 parse 调用不等于全文重算

Tree-sitter 官方编辑流程就是：

1. 对旧树调用 `edit`，把节点位置映射到新文档；
2. 把 edit 后的旧树传给下一次 `parse`；
3. 新树与旧树共享仍然有效的内部结构。

项目当前 `TreeSitterParser.parse(doc, oldTree)`、`editTree`、`ParseContext.changes()` 已经按照这个模型工作。因此不能再把“每次 transaction 都调用全局 parser”视为架构错误。

真正需要判断的是：

```text
outer parse 完成后，应用层又做了多少 O(document blocks) 的工作？
```

Tree-sitter 的增量性只覆盖 syntax tree construction。它不会自动让以下步骤变成增量：

- nested language range discovery；
- 每个 nested parser 的调度；
- Tree-sitter query 结果缓存；
- semantic descriptor 构造；
- widget/render cache；
- DecorationSet projection；
- 全局 reference/footnote/heading 索引。

这正是当前项目仍然可能在大 Markdown 文档中退化的地方。

---

## 3. 当前最重要的性能风险不在 outer parser，而在 nested Markdown-inline 编排

项目使用 `tree-sitter-markdown` 的 split parser：

```text
Markdown block grammar
    ↓ 找到 inline / pipe_table_cell ranges
Markdown-inline grammar（多个 included-range groups）
```

这与 grammar 官方建议一致：先 parse block grammar，再对 `inline` 节点范围执行第二次 inline parse。

### 当前实现的代价

当前 `markdownInlineRangeGroups()` 每次都：

1. 在完整 outer tree 上 query exclusion captures；
2. 在完整 outer tree 上 query 所有 inline injection matches；
3. 构造全部 inline range groups。

随后 `TreeSitterParser.wrapTree()` 对每一个 group 逐一调用 nested parser。即使每个 nested parse 都能快速复用 old tree，下面这些工作仍可能是线性的：

```text
发现全部 groups          O(block count)
匹配旧 nested tree       当前实现可能 O(group count²)
逐 group 调用 parse      O(group count) 次调用
构造新的 nested 数组     O(group count)
```

对于 20,000 个普通 paragraph 的文档，outer incremental parse 可能非常快，但如果之后仍遍历和调度 20,000 个 inline groups，用户最终感受到的仍是大文档卡顿。

### 更隐蔽的线性路径

当前复合 `Tree` 还存在以下问题：

- `nestedAt(pos)` 线性遍历所有 nested trees；
- `Tree.iterate(range)` 每次会 flat-map 并排序 nested ranges；
- `queryTreeMatches(..., includeNested !== false)` 会递归访问全部 nested trees，然后才在每棵 tree 内检查 query range 是否重叠。

所以即使 LiveMD query 已传递 `from/to`，如果 wrapper 仍先遍历全部 nested trees，复杂度依然是：

```text
O(total nested tree count + local query work)
```

而不是理想的：

```text
O(log total nested count + overlapping nested trees + local query work)
```

**这是实现真正 block 热路径前必须解决的 language-layer 问题。**

---

## 4. 推荐的最终架构

```text
┌──────────────────────────────────────────────┐
│ CodeMirror EditorState.doc                   │
│ 唯一 source of truth                         │
└──────────────────────┬───────────────────────┘
                       │ transaction / ChangeDesc
                       ▼
┌──────────────────────────────────────────────┐
│ packages/language                            │
│                                              │
│ 1. outer Markdown global incremental parse   │
│ 2. incremental NestedTreeIndex               │
│ 3. changed outer/nested tree delta            │
│ 4. complete / provisional parse state        │
└──────────────────────┬───────────────────────┘
                       │ SyntaxTreeDelta
                       ▼
┌──────────────────────────────────────────────┐
│ packages/live-md: LiveMdBlockIndex            │
│                                              │
│ paragraph / heading / table / fence / etc.   │
│ 每个 block 持有：                             │
│ - outer syntax context                       │
│ - inline/fence tree reference                │
│ - semantic descriptors                       │
│ - effects                                    │
│ - render/cache key                           │
└──────────────────────┬───────────────────────┘
                       │ changed owners only
                       ▼
┌──────────────────────────────────────────────┐
│ Projection                                   │
│                                              │
│ A. direct layout DecorationSet               │
│ B. optional viewport inline DecorationSet    │
│ C. atomic ranges                             │
│ D. widget/render/fence caches                │
└──────────────────────────────────────────────┘
```

### 设计原则

1. **Tree-sitter tree 是结构事实来源。**
2. **BlockIndex 是可丢弃的派生运行时索引。**
3. **query 是 block 内分析工具，而不是整个 runtime 的调度器。**
4. **viewport 不改变 semantic state。**
5. **旧 block/effect 先通过 `ChangeDesc` 映射，再 patch changed owners。**
6. **全局依赖使用少量领域索引，不建立通用 dependency graph。**

---

## 5. `packages/language` 必须增加的能力

### 5.1 `SyntaxTreeDelta`

当前 `syntaxTreeChangedRanges(transaction)` 最终只给出合并后的文档范围。LiveMD 更需要知道：

- outer block grammar 哪些范围改变；
- 哪些 nested tree 被新增、删除、移动、修改或复用；
- 当前 tree 是 complete 还是 provisional；
- 这是哪个 parse generation。

建议新增：

```ts
export type SyntaxTreeDelta = {
  generation: number;
  complete: boolean;

  outerChanged: readonly DocRange[];

  nested: readonly NestedTreeDelta[];
};

export type NestedTreeDelta = {
  sourceId: string;
  parser: TreeSitterParser;
  status: "added" | "removed" | "changed" | "reused";

  oldRanges?: readonly DocRange[];
  newRanges?: readonly DocRange[];

  oldTree?: Tree;
  newTree?: Tree;
};
```

`syntaxTreeChangedRanges` 可以继续作为兼容 API，由该 delta 合并得到。

### 5.2 增量 `NestedTreeIndex`

当前 nested trees 是普通数组。建议内部维护按 range 排序的索引：

```ts
type NestedTreeEntry = {
  sourceId: string;
  parser: TreeSitterParser;
  ranges: readonly DocRange[];
  tree: Tree;
  key: string;
};

class NestedTreeIndex {
  map(changes: ChangeDesc): NestedTreeIndex;
  overlapping(ranges: readonly DocRange[]): readonly NestedTreeEntry[];
  at(pos: number, side?: -1 | 0 | 1): NestedTreeEntry | null;
  patch(remove: readonly NestedTreeEntry[], add: readonly NestedTreeEntry[]): NestedTreeIndex;
}
```

至少需要：

- `nestedAt` 使用二分或 range tree；
- bounded query 只递归进入与 query window 重叠的 nested trees；
- `Tree.iterate` 不在每次调用时对所有 nested ranges 重新排序。

### 5.3 nested range provider 的增量接口

当前 `NestedParserSource.ranges(tree)` 只能全树计算。建议保持兼容，同时允许可选增量实现：

```ts
export interface NestedParserSource {
  id?: string;
  parser: NestedParser;

  ranges(tree: Tree): NestedParserRanges;

  updateRanges?(context: {
    oldTree: Tree;
    newTree: Tree;
    changes: ChangeDesc;
    outerChanged: readonly DocRange[];
    previous: readonly NestedTreeEntry[];
  }): NestedRangePatch;
}
```

Markdown provider 实现 `updateRanges`；HTML/其他语言暂时继续使用 full fallback。

另一种更小的 API 是让 range provider接受可选查询窗口：

```ts
ranges(tree: Tree, windows?: readonly DocRange[]): NestedParserRanges;
```

runtime 保留 windows 外的旧 groups，只 query windows 内的新 groups。

### 5.4 Markdown inline range patch 算法

对每次 transaction：

```text
1. edit/map 旧 nested entries
2. outer parser 增量得到 new outer tree
3. 计算 outerChanged
4. 找出 mapped old entries touching outerChanged
5. 对 outerChanged 执行 bounded injection query
6. query 返回完整相交的 inline/cell captures
7. reconcile old/new range groups
8. 只 parse added/changed groups
9. 直接复用未触碰 groups
```

Tree-sitter query 的 byte-range 语义很适合第 5 步：它返回与窗口相交的完整 match，而不是只返回窗口内的 capture 片段。

必须避免传 `{from: 0, to: 0}`，因为 Tree-sitter 把 end=0 解释为 unbounded，会匹配整个 tree。

### 5.5 nested parser 中断恢复必须按 group 建模

`web-tree-sitter` 的 parser 在 progress callback 取消后，默认在下一次 `parse` 调用继续上一次未完成的 parse，除非显式 `reset()`。

当前实现为同一种 nested language 共用一个底层 `TSParser`，但 `wrapTree()` 每次又从第一个 group 开始循环。如果第 N 个 group 中断，下一轮循环中的第一次 `parse` 可能恢复第 N 个 group，却被调用者误认为是第一个 group 的结果。

这需要专门 POC 验证，但从 API 语义看属于高风险设计。

正确做法二选一：

1. 保存 continuation：`sourceIndex + groupIndex + alreadyBuiltNested`，恢复时从中断 group 继续；
2. 切换到其他 group 前调用 `reset()`，并为超大 group单独保存 parser/continuation。

最稳妥的是让 `ParseContext` 显式保存 nested wrap continuation，而不是隐式依赖 `web-tree-sitter` parser 内部状态。

---

## 6. `packages/live-md` 的 BlockIndex

### 6.1 Block 的正确粒度

主要 owner 应是可独立分析和投影的 leaf/render block：

```ts
type LiveMdBlockKind =
  | "paragraph"
  | "heading"
  | "listItemParagraph"
  | "quoteParagraph"
  | "table"
  | "codeFence"
  | "mathBlock"
  | "imageLine"
  | "rule"
  | "htmlBlock";
```

不要把这些大型容器当普通输入的 owner：

```text
document
section
list
block_quote
```

它们只贡献上下文：

```ts
type LiveMdBlockContext = {
  quoteDepth: number;
  listPath: readonly {
    depth: number;
    ordered: boolean;
    marker: string;
  }[];
};
```

因此 10,000 项 list 内编辑第 5,000 项正文时，owner 是该 item 的 paragraph/inline tree，而不是整个 `list`。

### 6.2 建议的数据结构

```ts
type LiveMdBlockId = number & { readonly __brand: "LiveMdBlockId" };

type LiveMdBlock = {
  id: LiveMdBlockId;
  kind: LiveMdBlockKind;

  range: DocRange;
  contentRange: DocRange;
  structuralRanges: readonly DocRange[];
  context: LiveMdBlockContext;

  outerNodeType: string;
  inlineTree: Tree | null;

  semanticKey: string;
  activeMode: "source" | "preview";

  descriptors: readonly LiveMdDescriptor[];
  projection: LiveMdBlockProjection;
};

type LiveMdBlockProjection = {
  layoutEffects: readonly LiveMdEffect[];
  inlineEffects: readonly LiveMdEffect[];
  atomicEffects: readonly LiveMdEffect[];
};
```

### 6.3 Block identity

不要把 Tree-sitter `node.id` 当跨 transaction 永久 ID。Tree-sitter 官方建议：tree edit 后，已保存的 node 要么同步 edit，要么从新树重新获取。

Block identity 采用 reconcile：

1. 旧 block range 通过 `ChangeDesc` map；
2. 未触碰且 kind/context 相同的 block 原样复用；
3. changed window 内根据 overlap、kind、anchor、结构 fingerprint 匹配；
4. split/merge 时只保留最多一个旧 ID，其余生成新 ID；
5. render cache key 与位置分离。

```ts
type BlockKeys = {
  // 表示对象延续关系，可随 reconcile 保留
  identity: LiveMdBlockId;

  // 不含 from/to；决定重型 render 是否可复用
  semanticKey: string;

  // 含 active state/theme/config；决定 projection 是否可复用
  projectionKey: string;
};
```

---

## 7. 普通 transaction 的实际热路径

### 7.1 新 tree 在同步预算内完成

```text
1. CodeMirror transaction
2. language StateField 对 old tree 执行 edit
3. global outer parser incremental parse
4. incremental NestedTreeIndex patch
5. 发布 SyntaxTreeDelta
6. LiveMD map 旧 BlockIndex/effects
7. 只 reconcile delta 覆盖的 blocks
8. 只 query changed inline trees
9. 只 project changed owners + old/new active owners
10. patch direct DecorationSet / atomic ranges
```

普通 paragraph 内输入一个字符时，期望统计是：

```text
outer parse calls:              1
nested groups enumerated:       O(changed groups), ideally 1
nested inline parses:           1 incremental
LiveMD block queries:           1 inline tree
blocks reprojected:             1
heavy widgets recreated:        0
```

### 7.2 selection-only transaction

```text
不 parse
不 semantic query
不更新 BlockIndex
只重新 project old active block 和 new active block
```

如果光标在同一 block 内移动且 active mode 不变，甚至无需重新投影整个 block，只更新 marker visibility 的局部 effects。

### 7.3 viewport-only update

```text
不 parse
不更新 semantic BlockIndex
不重新 query Markdown
仅更新 viewport inline effects 或让 CodeMirror 自行挂载/卸载 widget DOM
```

---

## 8. parser 暂未完成时的现实问题

当前 Tree-sitter wrapper 使用短同步预算，然后在 idle worker 中继续。如果新 parse 在同步 transaction 内没有完成，新的 `LanguageState` 可能暂时拿不到完整新 tree。

这意味着不能假设每个 doc transaction 后 LiveMD 都能立即获得准确的新 block tree。

### 不应做的事

```text
new tree unavailable
→ full document invalidation
→ 清空所有 previews
→ 稍后整篇恢复
```

这会造成明显闪烁。

### 建议的 provisional 策略

```text
1. map 全部旧 blocks/effects through changes
2. 保留未触碰 block 的旧 projection
3. 对触碰到旧 replacement owner 的编辑：临时揭示源码
4. 标记 changed owner 为 pending
5. parser 发布新 generation 后只 reconcile pending owners
```

可以考虑 language 层暴露：

```ts
type SyntaxSnapshot = {
  tree: Tree;
  complete: boolean;
  parsedTo: number;
  generation: number;
};
```

其中 provisional tree 可以是 edit 后的旧 tree，但必须明确标记“不保证语法正确”，避免普通 consumers 把它当最终语法树。

### 无法完全消除的行为

对于删除 fence delimiter、巨型 HTML block 等结构变化，同步 parse 可能无法在预算内完成。此时“当前 owner 暂时显示源码，完成后再恢复 preview”是可接受降级，但无法保证绝对零视觉变化。

---

## 9. Query 系统如何使用才正确

### 9.1 Query 不是增量数据库

每次 `Query.matches` 都是一次新的执行。Tree-sitter 不会保存上一轮 match 集合并自动 patch。

因此正确方式是：

```text
incremental syntax tree
+ changed tree/block delta
→ query only changed block trees
→ patch persistent descriptors
```

而不是：

```text
incremental syntax tree
→ query entire composite tree again
```

### 9.2 优先 query local tree

对于 paragraph、heading、table cell：

```ts
queryNodeMatches(block.inlineTree.topNode, liveMdInlineQuery)
```

不再从 composite document root递归寻找该 block。

对于 outer block features，只对 `outerChanged` windows 执行 bounded query。

### 9.3 wrapper 应暴露完整的 range options

当前 wrapper 至少应支持：

```ts
type TreeSitterQueryOptions = {
  from?: number;
  to?: number;
  containingFrom?: number;
  containingTo?: number;
  includeNested?: boolean;
  matchLimit?: number;
  maxStartDepth?: number;
  progressCallback?: ...;
};
```

但 `maxStartDepth` 和 `matchLimit` 只是防护，不是增量架构的替代品。

### 9.4 避免复杂 query DSL

不建议把 dirty scope、cache policy、active semantics 等全部塞进 `#set!` properties。Query 只负责：

- 找 feature root；
- 捕获必要的子范围；
- 提供静态属性，例如 heading level。

TypeScript handler 负责把 match 转成 block descriptor/effects。

---

## 10. 段落分隔与空白 gap

空白 gap 往往没有独立 AST node。纯 query 不能完整解决这一问题，但也不需要建立通用 dependency graph。

BlockIndex 同时维护相邻边：

```ts
type LiveMdBoundary = {
  left: LiveMdBlockId | null;
  right: LiveMdBlockId | null;
  range: DocRange;
  paragraphBreak: boolean;
};
```

当一个 block 被新增、删除、split、merge 或改变范围时，只重算：

- 它与前一个 block 的 boundary；
- 它与后一个 block 的 boundary；
- 必要时前后各一个 boundary。

这样不需要向上爬到 `section`、`list` 或 `block_quote`，也不会因为大型容器而全文失效。

---

## 11. Table、Fence 和其他特殊 block

### 11.1 Table

- 每个 cell 可有独立 Markdown-inline tree；
- table preview 是 table owner 的 projection；
- 一个 cell 改动时，只增量 parse 该 cell inline tree；
- 但整个 table descriptor/widget 需要重新投影，因为列数、alignment、行结构可能改变。

复杂度取决于 table 大小，而不是全文大小。巨型 table 本身仍是不可规避的局部病理输入。

### 11.2 Code fence

保存：

```ts
type FenceParseState = {
  blockId: LiveMdBlockId;
  parser: TreeSitterParser;
  parserIdentity: string;
  language: string;

  contentRange: DocRange;
  source: Text;
  tree: Tree;
};
```

当所有 changes 都满足：

- 完全位于 old/new content range；
- 未触碰 opening/closing delimiter；
- 未触碰 info string/language；
- parser identity 未变化；

则把全局 change 转为 fence-local `ChangeDesc`：

```text
edit old local tree
→ parser.parse(new local Text, edited old tree)
```

否则只 full-parse 这一块 fence。

高亮 decorations 只需对 visible fence-local ranges 生成；local tree 可以保持完整。

### 11.3 Mermaid、LaTeX、Image、Table widget

重型 render key 不应含绝对位置：

```text
Mermaid: hash(source + rendererVersion + theme)
LaTeX:   hash(tex + displayMode + rendererVersion + macros)
Image:   hash(resolvedSrc + alt + resolverIdentity)
Table:   hash(normalizedTableModel + theme)
```

位置前移只 map decoration，不重新 render。

---

## 12. CodeMirror API 的硬约束

### 12.1 不能把全部 projection 都改成 viewport-only ViewPlugin

CodeMirror 明确规定：只有直接提供的 decoration set 可以影响垂直布局。由 `view => DecorationSet` 或 ViewPlugin 提供的 decorations 不能包含：

- block widgets；
- 覆盖换行的 replacing decorations。

因此以下 LiveMD 功能必须保留在 direct decoration StateField：

- table block replacement；
- Mermaid block replacement；
- block LaTeX；
- full-line image replacement；
- 任何覆盖多行源码的 preview；
- 会改变行高的 heading/line styling（保守起见也应 direct）。

可以 viewport-only 的通常是：

- inline emphasis/strong marks；
- 不跨换行的 syntax-marker hiding；
- link marks；
- code fence visible-range syntax highlighting marks。

### 12.2 推荐混合投影

```text
LiveMdLayoutField (StateField, direct)
- block replacements
- layout-sensitive line classes
- atomic ranges
- full-doc lightweight RangeSet

LiveMdInlinePlugin (ViewPlugin, viewport)
- inline marks
- syntax visibility
- link styling
- code highlight marks
```

第一阶段也可以先全部保持 direct，确认正确后再拆 viewport inline layer。

### 12.3 RangeSet 支持所需的增量操作

CodeMirror `RangeSet` 原生支持：

- `map(changes)`；
- `update({add, filter, filterFrom, filterTo})`；
- `between(from,to)`。

所以按 changed block owner patch direct DecorationSet 是完全可行的，无需每次重建整套 decorations。

### 12.4 Widget DOM 复用

`WidgetType` 提供：

- `eq`：新旧 widget 等价时避免重绘；
- `updateDOM`：内容改变时原地 patch DOM；
- `estimatedHeight`：帮助未挂载内容的高度估计；
- DOM 高度异步改变后配合 `view.requestMeasure()`。

因此“全 doc 维护 block decoration”不等于“全 doc 创建 widget DOM”。CodeMirror 只绘制 visible ranges，widget DOM 会延迟创建。

---

## 13. 异步 render 与视觉稳定性的现实限制

Mermaid、图片加载、某些公式渲染会异步改变高度。即使 semantic/projection 完全增量，也不能无条件承诺零 layout shift。

必须做：

```ts
type AsyncRenderToken = {
  blockId: LiveMdBlockId;
  renderKey: string;
  generation: number;
};
```

异步结果提交前检查 token；旧 generation 的结果必须丢弃。

DOM 高度变化后调用 `requestMeasure`。同时缓存已测量高度，给 `estimatedHeight` 提供尽量准确的值。

可以显著减少跳动，但以下情况仍无法完全消除：

- 首次加载未知尺寸远程图片；
- 首次渲染从未见过的 Mermaid；
- theme/font 加载改变文本度量；
- active block 从大型 preview 切回多行源码。

---

## 14. 全局 Markdown 依赖

Block-local runtime 不能自动解决所有跨文档语义，例如：

- reference link definitions；
- footnotes；
- heading/TOC；
- citation numbering；
- 自定义 feature 的全局聚合。

不建议建立通用依赖图。建议建立少量领域索引：

```ts
type ReferenceIndex = {
  definitionsByLabel: ReadonlyMap<string, Definition>;
  referencesByLabel: ReadonlyMap<string, readonly LiveMdBlockId[]>;
};

type HeadingIndex = {
  headings: readonly HeadingEntry[];
};
```

定义 `[foo]` 改变时，只重新投影引用 `foo` 的 blocks。

Custom feature API 分两级：

```ts
// 默认：局部、纯 block feature
localFeature({ query, analyze, project })

// 高级：feature 自己维护领域索引并显式返回 invalidated owners
indexedFeature({ stateField, update, invalidatedBlocks, project })
```

这比通用 dependency graph 可维护。

---

## 15. 无法规避的 Markdown 大范围变化

Tree-sitter 增量解析的承诺是“复用仍然有效的旧子树”，不是“每次只解析当前行”。

以下编辑可能真实影响很远：

- 新增/删除未闭合 fence delimiter；
- HTML block 开始/结束条件变化；
- list/blockquote lazy continuation 与缩进变化；
- setext heading underline；
- table delimiter row；
- 整篇是一个巨大 paragraph；
- 整篇是一个巨大 table/fence。

这些情况下 changed range 接近 EOF 或整个巨大 block 是正确结果。

因此性能目标必须表述为：

> 对普通 leaf-block 内容编辑，后处理成本与 changed blocks 成比例；对真实跨文档结构变化，允许按 parser delta 扩大。

不能承诺每次按键 O(1)。

---

## 16. Grammar 正确性的现实边界

`tree-sitter-markdown` 官方明确说明，受 Tree-sitter grammar 规则限制，输出仍存在不少不准确之处，不建议用于 correctness-critical 场景；主要目标偏向语法高亮。

这不代表 LiveMD 不可用，但必须：

1. 明确支持的 Markdown dialect；
2. 建立 CommonMark/GFM fixture corpus；
3. 对 ERROR/MISSING 和已知不可靠结构保守显示源码；
4. 保存/导出永远以 CodeMirror 原始文本为准；
5. 不让 preview 投影修改文本含义。

因此 Tree-sitter 是编辑时结构投影依据，不应成为 Markdown 数据正确性的唯一证明。

---

## 17. 对 PR #61 的判断

PR #61 已经提供了很多可复用部件：

- analysis / projection / runtime 分层；
- semantic unit discriminated union；
- emitter/effect 思想；
- unit mapping/reconcile；
- widget cache；
- code fence parse cache；
- bounded query 的基础 wrapper。

但它目前仍以：

```text
document tree
→ semantic query pipeline
→ document-level semantic index
→ loop all semantic units
→ rebuild projection snapshot
```

为中心，而且 viewport change 也进入 semantic snapshot lifecycle。

建议保留：

- 模块拆分；
- descriptor/effect 类型；
- projection emitter；
- cache 类；
- unit reconcile 中可复用的 range mapping 工具。

建议替换：

- 以 document semantic index 作为 runtime 中心；
- viewport 驱动 semantic invalidation；
- 每次 projection 遍历全部 units；
- 每次 snapshot 重建 global state；
- exact-signature-only 的 fence full parse cache。

新的中心应是：

```text
SyntaxTreeDelta + LiveMdBlockIndex + per-block ProjectionRecord
```

这属于架构重写，不只是继续给现有 dirty-range 逻辑添加特例。

---

## 18. 分阶段实施路线

### Phase 0：Instrumentation 与基线

先加入：

```ts
type LiveMdTrace = {
  outerParseMs: number;
  outerChangedBytes: number;

  nestedGroupsVisited: number;
  nestedGroupsParsed: number;
  nestedGroupsReused: number;

  queryCalls: number;
  queryBytes: number;

  blocksReconciled: number;
  blocksProjected: number;

  widgetToDomCalls: number;
  widgetUpdateDomCalls: number;
};
```

没有这些计数，wall-clock 很容易被机器噪声掩盖。

### Phase 1：改造 language nested-tree 基础设施

1. 新增 `NestedTreeIndex`；
2. range-aware `nestedAt` / nested traversal；
3. `SyntaxTreeDelta`；
4. Markdown incremental range provider；
5. nested parser cancellation continuation 测试。

这是决定大文档普通段落输入能否真正与 paragraph 数量解耦的阶段。

### Phase 2：建立 `LiveMdBlockIndex`

1. 从 outer+nested trees 建 leaf block records；
2. map + delta reconcile；
3. boundary/gap edges；
4. local inline query；
5. old/new active owner patch。

### Phase 3：per-block projection store

```ts
type ProjectionStore = {
  byBlockId: ReadonlyMap<LiveMdBlockId, LiveMdBlockProjection>;
  layoutDecorations: DecorationSet;
  atomicRanges: RangeSet<...>;
};
```

只删除并重新加入 changed owners 的 effects。

### Phase 4：重型 block caches

- fence-local incremental parser；
- Mermaid/LaTeX/table/image render LRU；
- async generation guards；
- measured height cache。

### Phase 5：可选拆分 viewport inline projection

正确性稳定后，再把不影响垂直布局的 inline effects 移到 ViewPlugin。

### Phase 6：领域全局索引与 feature API

- reference definitions；
- headings/TOC；
- footnotes；
- indexed custom features。

---

## 19. 必须执行的 POC 与测试

### 19.1 Language 层性能测试

构造 20,000 个 paragraphs，在中间输入一个普通字符：

```text
期望：
nestedGroupsVisited 不是 20,000
nestedGroupsParsed <= 1~3
nestedAt/query nested traversal 为对数 + overlap
```

如果仍访问所有 groups，LiveMD 重写不能解决最终性能问题。

### 19.2 Nested cancellation correctness

强制 progress callback 在第 N 个 inline group 取消：

- 下一轮必须继续第 N 个 group；
- 不得把恢复得到的 tree 关联到第 1 个 group；
- 最终 composite tree 必须等于不中断 full parse。

### 19.3 Incremental/full rebuild 等价测试

对随机 edits：

```text
incremental BlockIndex/effects
==
fresh full build BlockIndex/effects
```

至少覆盖：

- insertion/deletion/replacement；
- 多 cursor；
- IME composition；
- Unicode/emoji；
- CRLF；
- split/merge paragraph；
- list/quote indentation；
- table formation/destruction；
- fence open/close；
- valid→invalid→valid markup。

### 19.4 病理输入测试

- 10,000-item list；
- nested list；
- 10,000-line blockquote；
- 单一超长 paragraph；
- 未闭合 fence 到 EOF；
- 5,000-row table；
- 大量 inline math/image/reference links。

测试应区分：

- parser 真实大 changed range；
- 应用层错误地额外全文遍历。

### 19.5 CodeMirror 交互/视觉测试

浏览器测试覆盖：

- task checkbox 点击；
- widget 中心/边缘 raw mouse click；
- active preview ↔ source 切换；
- 滚动前后 selection 坐标；
- scrollTop/anchor 稳定；
- async Mermaid/image 完成后的 measure；
- MutationObserver 统计 widget DOM churn；
- screenshot/video 检测整页闪烁。

Playwright/CDP 只能验证真实交互和视觉，不足以证明增量性；必须与内部 trace counters 联合。

---

## 20. Go / No-Go 标准

### Go

在 100k+ 行、10k+ leaf blocks 文档中，普通 paragraph 编辑满足：

- outer parser 使用 old tree；
- nested range discovery 不遍历全部 groups；
- <= 3 个 nested trees 被 parse；
- <= 3 个 LiveMD blocks 被 semantic query；
- 未触碰 widgets 的 `toDOM` 调用为 0；
- incremental result 与 full rebuild 等价；
- 编辑帧没有全局 decoration rebuild。

### No-Go / 需要重新评估

任意一个成立：

- `wrapTree` 每次仍枚举所有 Markdown inline groups；
- bounded query 仍递归访问所有 nested trees；
- parse 未完成时清空整篇 syntax/decorations；
- direct block replacements 被移到 viewport-only provider；
- global reference/feature 仍在每次 snapshot 全文 query；
- 无法在 nested cancellation 后正确关联恢复 tree；
- block reconcile 需要频繁扫描全部 blocks。

---

## 21. 最终推荐

### 应做

```text
保留全局 Tree-sitter incremental parse
             +
增量 NestedTreeIndex / SyntaxTreeDelta
             +
LiveMdBlockIndex
             +
per-block semantic/query/projection
             +
CodeMirror RangeSet map/patch
             +
stable widget/render caches
```

### 不应做

```text
绕过全局 parser 的独立 Markdown block parser
复杂 query metadata DSL
通用 dependency graph
祖先一路扩到 list/blockquote/document
viewport change 驱动 semantic rebuild
每轮遍历全部 semantic units
```

最准确的一句话是：

> **Tree-sitter 继续负责增量维护全局 Markdown 结构；LiveMD 把 Tree-sitter 产生的 outer/nested delta 转换成 block-owned 局部分析和局部投影。**

这套架构能真正借鉴 Typora 的核心：不是避免拥有整篇文档结构，而是让普通编辑的 UI 热路径只触碰当前语义块。

---

## 22. 主要资料

### Tree-sitter 官方

- [Advanced Parsing：edit old tree、old-tree parse、included ranges、多语言协调责任](https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html)
- [Query API：range intersection、containing range、end=0 unbounded](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/4-api.html)
- [web-tree-sitter v0.26.9 Parser source](https://github.com/tree-sitter/tree-sitter/blob/v0.26.9/lib/binding_web/src/parser.ts)
- [web-tree-sitter v0.26.9 Query source](https://github.com/tree-sitter/tree-sitter/blob/v0.26.9/lib/binding_web/src/query.ts)
- [tree-sitter-markdown README](https://github.com/tree-sitter-grammars/tree-sitter-markdown)

### CodeMirror 官方

- [CodeMirror Reference Manual](https://codemirror.net/docs/ref/)
- [CodeMirror language ParseContext source](https://github.com/codemirror/language/blob/main/src/language.ts)

### 当前项目

- [PR #61：query-based analysis/projection](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/61)
- [`packages/language/src/language.ts`](https://github.com/Eric-Song-Nop/codemirror-treesitter/blob/main/packages/language/src/language.ts)
- [`packages/language/src/tree.ts`](https://github.com/Eric-Song-Nop/codemirror-treesitter/blob/main/packages/language/src/tree.ts)
- [`packages/language-data/src/index.ts`](https://github.com/Eric-Song-Nop/codemirror-treesitter/blob/main/packages/language-data/src/index.ts)

