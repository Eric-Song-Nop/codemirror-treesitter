import { hasOneDriveRedirectCallbackForStoredTransaction } from "@/lib/onedrive-oauth";

export function defaultOneDriveClientId() {
  let configured = import.meta.env.VITE_ONEDRIVE_CLIENT_ID;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return "";
}

export function defaultOneDriveRoot() {
  let configured = import.meta.env.VITE_ONEDRIVE_ROOT;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return undefined;
}

export function defaultOneDriveRedirectUri() {
  let configured = import.meta.env.VITE_ONEDRIVE_REDIRECT_URI;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return undefined;
}

export function normalizeOneDriveRootInput(value: string | undefined) {
  let root = value
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return root || undefined;
}

export function isOneDriveRedirectCallbackWindow() {
  return (
    typeof window != "undefined" &&
    !window.opener &&
    hasOneDriveRedirectCallbackForStoredTransaction()
  );
}
