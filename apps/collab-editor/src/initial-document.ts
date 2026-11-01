export const projectUrl = "https://github.com/Eric-Song-Nop/codemirror-treesitter";

export function createInitialDocument(shareUrl: string) {
  return `# Collaborative LiveMD

This room is a shared Markdown document powered by CodeMirror, Tree-sitter, Loro, and Cloudflare Durable Objects.

Project: [Eric-Song-Nop/codemirror-treesitter](${projectUrl})

## How to use this room

1. Write Markdown directly in this editor.
2. Share this link to collaborate: <${shareUrl}>
3. Everyone with the same link edits the same document.

The link carries an edit key in its \`#\` fragment, so treat it like a password.
Rooms expire after 7 days and are deleted after a further retention period.
`;
}
