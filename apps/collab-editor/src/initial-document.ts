export const projectUrl = "https://github.com/Eric-Song-Nop/codemirror-treesitter";

export type InitialDocumentSeedInput = {
  docValue: string;
  editorValue: string;
  generatedRoom: boolean;
  hasLocalSnapshot: boolean;
};

export function createInitialDocument(shareUrl: string) {
  return `# Collaborative LiveMD

This room is a shared Markdown document powered by CodeMirror, Tree-sitter, Loro, and Cloudflare Durable Objects.

Project: [Eric-Song-Nop/codemirror-treesitter](${projectUrl})

## How to use this room

1. Write Markdown directly in this editor.
2. Share this link to collaborate: ${shareUrl}
3. Everyone with the same link edits the same document.

\`\`\`ts
const share = "copy the URL, including the short #room id";
console.log(share);
\`\`\`
`;
}

export function shouldSeedInitialDocument(input: InitialDocumentSeedInput) {
  return (
    input.generatedRoom &&
    !input.hasLocalSnapshot &&
    input.docValue.length == 0 &&
    input.editorValue.length == 0
  );
}
