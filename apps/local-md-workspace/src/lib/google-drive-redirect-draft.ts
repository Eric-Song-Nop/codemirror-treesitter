const GOOGLE_DRIVE_REDIRECT_DRAFT_KEY = "local-md-workspace:google-drive-redirect-draft";

export type GoogleDriveRedirectDraft = {
  clientId: string;
  dirtyValue?: string;
  selectedPath?: string;
};

type StoredGoogleDriveRedirectDraft = GoogleDriveRedirectDraft & {
  createdAt: number;
};

export function saveGoogleDriveRedirectDraft(draft: GoogleDriveRedirectDraft) {
  if (!canUseSessionStorage()) return;

  let normalized = normalizeGoogleDriveRedirectDraft(draft);
  if (!normalized) return;

  try {
    window.sessionStorage.setItem(
      GOOGLE_DRIVE_REDIRECT_DRAFT_KEY,
      JSON.stringify({
        ...normalized,
        createdAt: Date.now(),
      }),
    );
  } catch {}
}

export function takeGoogleDriveRedirectDraft() {
  if (!canUseSessionStorage()) return null;

  try {
    let raw = window.sessionStorage.getItem(GOOGLE_DRIVE_REDIRECT_DRAFT_KEY);
    window.sessionStorage.removeItem(GOOGLE_DRIVE_REDIRECT_DRAFT_KEY);
    if (!raw) return null;
    return normalizeGoogleDriveRedirectDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeGoogleDriveRedirectDraft(value: unknown): GoogleDriveRedirectDraft | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<StoredGoogleDriveRedirectDraft>;
  if (typeof record.clientId != "string") return null;

  let clientId = record.clientId.trim();
  if (!clientId) return null;

  let selectedPath =
    typeof record.selectedPath == "string" && record.selectedPath.trim()
      ? record.selectedPath.trim().replace(/\\/g, "/").replace(/^\/+/, "")
      : "";
  let dirtyValue = typeof record.dirtyValue == "string" ? record.dirtyValue : undefined;

  return {
    clientId,
    ...(dirtyValue != null && selectedPath ? { dirtyValue, selectedPath } : {}),
  };
}

function canUseSessionStorage() {
  return typeof window != "undefined" && Boolean(window.sessionStorage);
}
