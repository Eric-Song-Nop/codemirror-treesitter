import type { WorkspaceBackend } from "./workspace-backend.ts";

export type DropboxWorkspaceSession = {
  expiresAt: number;
  root?: string;
};

export type WorkspaceProviderStatus = {
  icon: "cloud" | "folder";
  label: string;
  state: "connected" | "expired" | "unknown";
};

export function createWorkspaceProviderStatus(
  backend: WorkspaceBackend | null,
  dropboxSession: DropboxWorkspaceSession | null,
  now = Date.now(),
): WorkspaceProviderStatus | null {
  if (!backend) return null;

  if (backend.kind == "local") {
    return {
      icon: "folder",
      label: "Local folder",
      state: "connected",
    };
  }

  if (backend.kind == "opendal-dropbox") {
    let expiry = dropboxTokenExpiryStatus(dropboxSession?.expiresAt, now);
    return {
      icon: "cloud",
      label: `Dropbox · ${dropboxRootLabel(dropboxSession?.root)} · ${expiry.label}`,
      state: expiry.state,
    };
  }

  return {
    icon: "cloud",
    label: "Cloud workspace",
    state: "connected",
  };
}

export function dropboxRootLabel(root: string | undefined) {
  return root?.trim() ? root.trim() : "app root";
}

export function dropboxTokenExpiryStatus(expiresAt: number | undefined, now = Date.now()) {
  if (typeof expiresAt != "number" || !Number.isFinite(expiresAt)) {
    return {
      label: "token unknown",
      state: "unknown" as const,
    };
  }

  let remainingMs = expiresAt - now;
  if (remainingMs <= 0) {
    return {
      label: "token expired",
      state: "expired" as const,
    };
  }

  let minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes < 60) {
    return {
      label: `token ${minutes}m`,
      state: "connected" as const,
    };
  }

  let hours = Math.floor(minutes / 60);
  let remainder = minutes % 60;
  return {
    label: remainder ? `token ${hours}h ${remainder}m` : `token ${hours}h`,
    state: "connected" as const,
  };
}
