const ONEDRIVE_REDIRECT_DRAFT_KEY = "local-md-workspace:onedrive-redirect-draft";

export type OneDriveRedirectDraft = {
  clientId: string;
  dirtyValue?: string;
  root?: string;
  selectedPath?: string;
};

type StoredOneDriveRedirectDraft = OneDriveRedirectDraft & {
  createdAt: number;
};

export function saveOneDriveRedirectDraft(draft: OneDriveRedirectDraft) {
  if (!canUseSessionStorage()) return;

  let normalized = normalizeOneDriveRedirectDraft(draft);
  if (!normalized) return;

  try {
    window.sessionStorage.setItem(
      ONEDRIVE_REDIRECT_DRAFT_KEY,
      JSON.stringify({
        ...normalized,
        createdAt: Date.now(),
      }),
    );
  } catch {}
}

export function takeOneDriveRedirectDraft() {
  if (!canUseSessionStorage()) return null;

  try {
    let raw = window.sessionStorage.getItem(ONEDRIVE_REDIRECT_DRAFT_KEY);
    window.sessionStorage.removeItem(ONEDRIVE_REDIRECT_DRAFT_KEY);
    if (!raw) return null;
    return normalizeOneDriveRedirectDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeOneDriveRedirectDraft(value: unknown): OneDriveRedirectDraft | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<StoredOneDriveRedirectDraft>;
  if (typeof record.clientId != "string") return null;

  let clientId = record.clientId.trim();
  if (!clientId) return null;

  let root =
    typeof record.root == "string"
      ? record.root
          .trim()
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, "")
      : "";
  let selectedPath =
    typeof record.selectedPath == "string" && record.selectedPath.trim()
      ? record.selectedPath.trim().replace(/\\/g, "/").replace(/^\/+/, "")
      : "";
  let dirtyValue = typeof record.dirtyValue == "string" ? record.dirtyValue : undefined;

  return {
    clientId,
    ...(dirtyValue != null && selectedPath ? { dirtyValue, selectedPath } : {}),
    ...(root ? { root } : {}),
  };
}

function canUseSessionStorage() {
  return typeof window != "undefined" && Boolean(window.sessionStorage);
}
