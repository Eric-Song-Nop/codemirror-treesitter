const DROPBOX_REQUIRED_SCOPES = [
  "files.metadata.read",
  "files.content.read",
  "files.content.write",
];

const ONEDRIVE_REQUIRED_SCOPES = ["Files.ReadWrite"];
const GOOGLE_DRIVE_REQUIRED_SCOPES = ["https://www.googleapis.com/auth/drive.file"];

export function workspaceErrorMessage(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  let normalized = normalizeErrorText(message);

  if (isGoogleDriveError(normalized)) {
    if (matchesAny(normalized, ["popup was blocked", "popup blocked"])) {
      return "Google Drive authorization popup was blocked. Allow popups for this site and try again.";
    }

    if (
      matchesAny(normalized, [
        "authorization was closed",
        "closed before it completed",
        "timed out",
      ])
    ) {
      return "Google Drive authorization was closed before it completed. Reconnect Google Drive workspace to continue.";
    }

    if (
      matchesAny(normalized, [
        "authorization was denied",
        "access denied",
        "access_denied",
        "org internal",
        "org_internal",
      ])
    ) {
      return "Google Drive authorization was denied or blocked by Google OAuth app settings. If this is a development app, add your Google account as a test user and check the Drive scope before reconnecting.";
    }

    if (
      matchesAny(normalized, ["missing scope", "insufficient scope"]) ||
      isGoogleDriveMissingScope(message)
    ) {
      return `Google Drive app is missing required file permissions: ${GOOGLE_DRIVE_REQUIRED_SCOPES.join(
        ", ",
      )}. Enable those scopes and reconnect Google Drive workspace.`;
    }

    if (matchesAny(normalized, ["expired access token", "access token expired", "token expired"])) {
      return "Google Drive access token expired. Reconnect Google Drive workspace to continue.";
    }

    if (
      matchesAny(normalized, [
        "invalid access token",
        "authorization was revoked",
        "token was revoked",
        "access token is invalid",
        "invalid token",
        "invalid credentials",
        "unauthorized",
        "401",
      ])
    ) {
      return "Google Drive authorization is invalid or was revoked. Reconnect Google Drive workspace to continue.";
    }

    if (
      matchesAny(normalized, [
        "token request failed",
        "token request returned an invalid response",
        "identity services",
      ])
    ) {
      return "Google Drive authorization failed. Check the Web client ID, authorized JavaScript origin, and OAuth consent screen, then reconnect Google Drive workspace.";
    }

    if (
      matchesAny(normalized, [
        "token exchange failed",
        "token exchange returned an invalid response",
        "invalid grant",
        "invalid client",
      ])
    ) {
      return "Google Drive token exchange failed. Check the client ID and reconnect Google Drive workspace.";
    }

    if (isGoogleDrivePathUnavailable(normalized)) {
      return "Grove Google Drive workspace is no longer available. Reconnect Google Drive workspace; this app can only access files it creates or that Google Drive grants to it.";
    }
  }

  if (isOneDriveError(normalized)) {
    if (matchesAny(normalized, ["popup was blocked", "popup blocked"])) {
      return "OneDrive authorization popup was blocked. Allow popups for this site and try again.";
    }

    if (
      matchesAny(normalized, [
        "authorization was closed",
        "closed before it completed",
        "timed out",
      ])
    ) {
      return "OneDrive authorization was closed before it completed. Reconnect OneDrive workspace to continue.";
    }

    if (matchesAny(normalized, ["authorization was denied", "access denied"])) {
      return "OneDrive authorization was denied.";
    }

    if (
      matchesAny(normalized, ["missing scope", "insufficient scope"]) ||
      isOneDriveMissingScope(message)
    ) {
      return `OneDrive app is missing required file permissions: ${ONEDRIVE_REQUIRED_SCOPES.join(
        ", ",
      )}. Enable those scopes and reconnect OneDrive workspace.`;
    }

    if (matchesAny(normalized, ["expired access token", "access token expired", "token expired"])) {
      return "OneDrive access token expired. Reconnect OneDrive workspace to continue.";
    }

    if (
      matchesAny(normalized, [
        "invalid access token",
        "authorization was revoked",
        "token was revoked",
        "access token is invalid",
        "invalidauthenticationtoken",
      ])
    ) {
      return "OneDrive authorization is invalid or was revoked. Reconnect OneDrive workspace to continue.";
    }

    if (
      matchesAny(normalized, [
        "token exchange failed",
        "token exchange returned an invalid response",
        "invalid grant",
        "invalid client",
      ])
    ) {
      return "OneDrive token exchange failed. Check the client ID and reconnect OneDrive workspace.";
    }

    if (isOneDrivePathUnavailable(normalized)) {
      return "OneDrive workspace path is no longer available. Check the OneDrive root setting, then reconnect OneDrive workspace.";
    }
  }

  if (normalized.includes("dropbox no clobber conflict")) {
    return "A file already exists at that Dropbox path. Choose another name.";
  }

  if (normalized.includes("dropbox revision conflict")) {
    return "This Dropbox file changed elsewhere. Reload it before saving again.";
  }

  if (matchesAny(normalized, ["popup was blocked", "popup blocked"])) {
    return "Dropbox authorization popup was blocked. Allow popups for this site and try again.";
  }

  if (matchesAny(normalized, ["authorization was closed", "closed before it completed"])) {
    return "Dropbox authorization was closed before it completed. Reconnect Dropbox workspace to continue.";
  }

  if (matchesAny(normalized, ["authorization was denied", "access denied"])) {
    return "Dropbox authorization was denied.";
  }

  if (matchesAny(normalized, ["missing scope", "insufficient scope"]) || isMissingScope(message)) {
    return `Dropbox app is missing required file permissions: ${DROPBOX_REQUIRED_SCOPES.join(
      ", ",
    )}. Enable those scopes and reconnect Dropbox workspace.`;
  }

  if (matchesAny(normalized, ["expired access token", "access token expired", "token expired"])) {
    return "Dropbox access token expired. Reconnect Dropbox workspace to continue.";
  }

  if (
    matchesAny(normalized, [
      "invalid access token",
      "authorization was revoked",
      "token was revoked",
      "access token is invalid",
    ])
  ) {
    return "Dropbox authorization is invalid or was revoked. Reconnect Dropbox workspace to continue.";
  }

  if (
    matchesAny(normalized, [
      "token exchange failed",
      "token exchange returned an invalid response",
      "invalid grant",
      "invalid client",
    ])
  ) {
    return "Dropbox token exchange failed. Check the app key and reconnect Dropbox workspace.";
  }

  if (isDropboxPathUnavailable(normalized)) {
    return "Dropbox app folder or workspace path is no longer available. Check the Dropbox app folder setting, then reconnect Dropbox workspace.";
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

function isGoogleDriveError(normalized: string) {
  return matchesAny(normalized, [
    "google drive",
    "gdrive",
    "googleapis.com",
    "accounts.google.com",
    "oauth2.googleapis.com",
    "drive.google.com",
    "google api",
  ]);
}

function isGoogleDrivePathUnavailable(normalized: string) {
  return (
    matchesAny(normalized, [
      "google drive",
      "gdrive",
      "googleapis.com",
      "drive.google.com",
      "google api",
      "opendal",
    ]) &&
    matchesAny(normalized, [
      "404",
      "file not found",
      "filenotfound",
      "not found",
      "not_found",
      "path not found",
      "path_not_found",
    ])
  );
}

function isDropboxPathUnavailable(normalized: string) {
  return (
    matchesAny(normalized, [
      "dropbox",
      "api.dropboxapi.com",
      "content.dropboxapi.com",
      "opendal",
    ]) &&
    matchesAny(normalized, [
      "409",
      "conflict",
      "path not found",
      "path_not_found",
      "path/not_found",
      "lookup not found",
      "lookup_not_found",
      "lookup/not_found",
      "not found",
      "not_found",
    ])
  );
}

function isOneDriveError(normalized: string) {
  return (
    matchesAny(normalized, [
      "onedrive",
      "graph.microsoft.com",
      "graph microsoft com",
      "login microsoftonline com",
      "microsoft graph",
    ]) || matchesAny(normalized, ["invalidauthenticationtoken", "itemnotfound"])
  );
}

function isOneDrivePathUnavailable(normalized: string) {
  return (
    matchesAny(normalized, [
      "onedrive",
      "graph.microsoft.com",
      "graph microsoft com",
      "microsoft graph",
      "opendal",
      "itemnotfound",
    ]) &&
    matchesAny(normalized, [
      "404",
      "itemnotfound",
      "item not found",
      "path not found",
      "path_not_found",
      "not found",
      "not_found",
    ])
  );
}

function isMissingScope(message: string) {
  let normalized = normalizeErrorText(message);
  return (
    matchesAny(normalized, ["missing scope", "not enough permissions"]) ||
    DROPBOX_REQUIRED_SCOPES.some((scope) => normalized.includes(scope))
  );
}

function isOneDriveMissingScope(message: string) {
  let normalized = normalizeErrorText(message);
  return (
    matchesAny(normalized, ["missing scope", "insufficient privileges", "insufficient scope"]) ||
    ONEDRIVE_REQUIRED_SCOPES.some((scope) => normalized.includes(scope.toLowerCase()))
  );
}

function isGoogleDriveMissingScope(message: string) {
  let normalized = normalizeErrorText(message);
  return (
    matchesAny(normalized, ["missing scope", "insufficient permissions", "insufficient scope"]) ||
    GOOGLE_DRIVE_REQUIRED_SCOPES.some((scope) => normalized.includes(scope.toLowerCase()))
  );
}

function matchesAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function normalizeErrorText(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[\\/]+/g, " ");
}
