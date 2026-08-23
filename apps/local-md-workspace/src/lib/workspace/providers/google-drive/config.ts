import { hasGoogleDriveRedirectCallbackForStoredTransaction } from "@/lib/workspace/providers/google-drive/oauth";

export const GOOGLE_DRIVE_WORKSPACE_ROOT = "Grove";

export function defaultGoogleDriveClientId() {
  let configured = import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return "";
}

export function defaultGoogleDriveRoot() {
  return GOOGLE_DRIVE_WORKSPACE_ROOT;
}

export function isGoogleDriveRedirectCallbackWindow() {
  return (
    typeof window != "undefined" &&
    !window.opener &&
    hasGoogleDriveRedirectCallbackForStoredTransaction()
  );
}
