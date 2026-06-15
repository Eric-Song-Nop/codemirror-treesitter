import { hasDropboxOAuthCallback, hasDropboxRedirectTransaction } from "@/lib/dropbox-oauth";

export function defaultDropboxAppKey() {
  let configured = import.meta.env.VITE_DROPBOX_APP_KEY;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return "";
}

export function defaultDropboxRoot() {
  let configured = import.meta.env.VITE_DROPBOX_ROOT;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return undefined;
}

export function defaultDropboxRedirectUri() {
  let configured = import.meta.env.VITE_DROPBOX_REDIRECT_URI;
  if (typeof configured == "string" && configured.trim()) return configured.trim();
  return undefined;
}

export function normalizeDropboxRootInput(value: string | undefined) {
  let root = value
    ?.trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return root || undefined;
}

export function isDropboxRedirectCallbackWindow() {
  return (
    typeof window != "undefined" &&
    !window.opener &&
    hasDropboxOAuthCallback() &&
    hasDropboxRedirectTransaction()
  );
}
