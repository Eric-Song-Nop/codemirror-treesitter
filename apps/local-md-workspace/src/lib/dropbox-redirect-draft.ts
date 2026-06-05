const DROPBOX_REDIRECT_DRAFT_KEY = "local-md-workspace:dropbox-redirect-draft";

export type DropboxRedirectDraft = {
  appKey: string;
  dirtyValue?: string;
  root?: string;
  selectedPath?: string;
};

type StoredDropboxRedirectDraft = DropboxRedirectDraft & {
  createdAt: number;
};

export function saveDropboxRedirectDraft(draft: DropboxRedirectDraft) {
  if (!canUseSessionStorage()) return;

  let normalized = normalizeDropboxRedirectDraft(draft);
  if (!normalized) return;

  try {
    window.sessionStorage.setItem(
      DROPBOX_REDIRECT_DRAFT_KEY,
      JSON.stringify({
        ...normalized,
        createdAt: Date.now(),
      }),
    );
  } catch {}
}

export function takeDropboxRedirectDraft() {
  if (!canUseSessionStorage()) return null;

  try {
    let raw = window.sessionStorage.getItem(DROPBOX_REDIRECT_DRAFT_KEY);
    window.sessionStorage.removeItem(DROPBOX_REDIRECT_DRAFT_KEY);
    if (!raw) return null;
    return normalizeDropboxRedirectDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeDropboxRedirectDraft(value: unknown): DropboxRedirectDraft | null {
  if (!value || typeof value != "object") return null;
  let record = value as Partial<StoredDropboxRedirectDraft>;
  if (typeof record.appKey != "string") return null;

  let appKey = record.appKey.trim();
  if (!appKey) return null;

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
    appKey,
    ...(dirtyValue != null && selectedPath ? { dirtyValue, selectedPath } : {}),
    ...(root ? { root } : {}),
  };
}

function canUseSessionStorage() {
  return typeof window != "undefined" && Boolean(window.sessionStorage);
}
