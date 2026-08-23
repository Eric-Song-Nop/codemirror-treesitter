export const sharedMarkdownDraftSearchParam = "shared-draft";
export const sharedMarkdownDraftErrorSearchParam = "shared-draft-error";

export const sharedMarkdownDraftUnavailableMessage =
  "The shared Markdown draft is no longer available.";
export const sharedMarkdownImportFailedMessage = "Grove could not import the shared Markdown file.";
export const sharedMarkdownUnsupportedMessage = "Share a Markdown file to import it into Grove.";

export type SharedMarkdownDraftLaunch =
  | {
      draftId: string;
    }
  | {
      error: SharedMarkdownDraftLaunchError;
    };

export type SharedMarkdownDraftLaunchError = "failed" | "unsupported";

export function readSharedMarkdownDraftLaunch(): SharedMarkdownDraftLaunch | null {
  if (typeof window == "undefined") return null;

  let url = new URL(window.location.href);
  let draftId = url.searchParams.get(sharedMarkdownDraftSearchParam)?.trim();
  if (draftId) return { draftId };

  let error = url.searchParams.get(sharedMarkdownDraftErrorSearchParam);
  return error == "failed" || error == "unsupported" ? { error } : null;
}

export function clearSharedMarkdownDraftLaunchParams() {
  if (typeof window == "undefined") return;

  let url = new URL(window.location.href);
  let hadDraft = url.searchParams.has(sharedMarkdownDraftSearchParam);
  let hadError = url.searchParams.has(sharedMarkdownDraftErrorSearchParam);
  url.searchParams.delete(sharedMarkdownDraftSearchParam);
  url.searchParams.delete(sharedMarkdownDraftErrorSearchParam);
  if (!hadDraft && !hadError) return;

  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function sharedMarkdownDraftLaunchErrorMessage(error: SharedMarkdownDraftLaunchError) {
  return error == "unsupported"
    ? sharedMarkdownUnsupportedMessage
    : sharedMarkdownImportFailedMessage;
}
