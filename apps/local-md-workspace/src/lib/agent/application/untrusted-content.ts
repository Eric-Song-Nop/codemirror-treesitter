const nonceBytes = 9;

/**
 * Wraps tool results that carry workspace data (file text, names, search
 * previews) in a delimited block the model is told to treat as data. A fresh
 * random nonce per block keeps file content from forging the closing tag, and
 * the payload stays JSON so read_file offsets keep their meaning.
 */
export function wrapUntrustedWorkspaceContent(toolName: string, output: unknown) {
  let nonce = randomNonce();
  return [
    `<untrusted-workspace-content tool="${toolName}" nonce="${nonce}">`,
    JSON.stringify(output),
    `</untrusted-workspace-content nonce="${nonce}">`,
  ].join("\n");
}

function randomNonce() {
  let bytes = crypto.getRandomValues(new Uint8Array(nonceBytes));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
