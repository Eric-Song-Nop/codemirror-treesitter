export function createInitialMarkdown(imageUrl = "") {
  return `# LiveMD field note

The editor keeps Markdown as the source while the page reads like composed text. It uses **Tree-sitter Markdown** for the CodeMirror language layer, then applies local editing affordances on top.

> Drafting should feel quiet. Markup can stay available without shouting over the prose.

## Inline rhythm

Use _emphasis_, **strong text**, ~~removed words~~, \`inline code\`, and [project links](https://viteplus.dev/) in the same writing flow.

${imageUrl ? `![A writing surface](${imageUrl})` : ""}

## Working list

- [x] Render Markdown blocks in place
- [x] Keep Tree-sitter parsing active
- [ ] Tighten edge cases around nested inline spans
- [ ] Compare more LiveMD behaviors

1. Keep ordered lists moving.
2. Preserve the author's source text.
3. Make the active line easy to edit.

---

| Markdown shape | Editor treatment |
| --- | --- |
| Heading markers | Hidden away from the active line |
| Task markers | Clickable checkbox widgets |
| Code fences | Paper-like code blocks |

## Nested Markdown

> - [ ] Quote task with **strong _nested emphasis_** and [inline link](https://github.com/lezer-parser)
>   - Child quote item with \`inline code\` and ~~struck text~~

- Parent item
  - Child item with **strong [linked text](https://codemirror.net/)** and _soft emphasis_
    - Grandchild keeps markers quiet until the cursor lands there.

\`\`\`ts
type Note = {
  title: string;
  done: boolean;
};

const note: Note = { title: "Tree-sitter Markdown", done: false };
\`\`\`

\`\`\`markdown
### Markdown inside a fence

> Recursive source should still receive Markdown token colors.

- [ ] **Nested** source remains editable as plain fenced text.
\`\`\`\n
`;
}
