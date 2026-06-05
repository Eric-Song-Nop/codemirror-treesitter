const DROPBOX_REQUIRED_SCOPES = [
  "files.metadata.read",
  "files.content.read",
  "files.content.write",
];

export function workspaceErrorMessage(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  let normalized = normalizeErrorText(message);

  if (matchesAny(normalized, ["popup was blocked", "popup blocked"])) {
    return "Dropbox authorization popup was blocked. Allow popups for this site and try again.";
  }

  if (matchesAny(normalized, ["authorization was closed", "closed before it completed"])) {
    return "Dropbox authorization was closed before it completed. Reconnect Dropbox to continue.";
  }

  if (matchesAny(normalized, ["authorization was denied", "access denied"])) {
    return "Dropbox authorization was denied.";
  }

  if (matchesAny(normalized, ["missing scope", "insufficient scope"]) || isMissingScope(message)) {
    return `Dropbox app is missing required file permissions: ${DROPBOX_REQUIRED_SCOPES.join(
      ", ",
    )}. Enable those scopes and reconnect Dropbox.`;
  }

  if (matchesAny(normalized, ["expired access token", "access token expired", "token expired"])) {
    return "Dropbox access token expired. Reconnect Dropbox to continue.";
  }

  if (
    matchesAny(normalized, [
      "invalid access token",
      "authorization was revoked",
      "token was revoked",
      "access token is invalid",
    ])
  ) {
    return "Dropbox authorization is invalid or was revoked. Reconnect Dropbox to continue.";
  }

  if (
    matchesAny(normalized, [
      "token exchange failed",
      "token exchange returned an invalid response",
      "invalid grant",
      "invalid client",
    ])
  ) {
    return "Dropbox token exchange failed. Check the app key and reconnect Dropbox.";
  }

  if (
    matchesAny(normalized, [
      "does not support native rename or copy fallback",
      "unsupported operation",
      "operation is not supported",
    ])
  ) {
    return "This storage backend does not support that operation.";
  }

  return message;
}

function isMissingScope(message: string) {
  let normalized = normalizeErrorText(message);
  return (
    matchesAny(normalized, ["missing scope", "not enough permissions"]) ||
    DROPBOX_REQUIRED_SCOPES.some((scope) => normalized.includes(scope))
  );
}

function matchesAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function normalizeErrorText(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/\//g, "_");
}
