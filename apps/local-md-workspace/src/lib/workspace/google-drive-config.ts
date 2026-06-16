import { hasGoogleDriveRedirectCallbackForStoredTransaction } from "@/lib/google-drive-oauth";

export function defaultGoogleDriveClientId() {
  let configured = import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return "";
}

export function defaultGoogleDriveRoot() {
  let configured = import.meta.env.VITE_GOOGLE_DRIVE_ROOT;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return undefined;
}

export function defaultGoogleDriveRedirectUri() {
  let configured = import.meta.env.VITE_GOOGLE_DRIVE_REDIRECT_URI;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return undefined;
}

export function normalizeGoogleDriveRootInput(value: string | undefined) {
  let root = value
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return root || undefined;
}

export function isGoogleDriveRedirectCallbackWindow() {
  return (
    typeof window != "undefined" &&
    !window.opener &&
    hasGoogleDriveRedirectCallbackForStoredTransaction()
  );
}
