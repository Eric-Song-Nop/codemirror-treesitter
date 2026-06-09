export type BrowserEnvironment = {
  maxTouchPoints?: number;
  platform?: string;
  userAgent?: string;
};

export function currentBrowserEnvironment(): BrowserEnvironment {
  if (typeof navigator == "undefined") return {};
  return {
    maxTouchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}

export function isMobileBrowser(environment: BrowserEnvironment = currentBrowserEnvironment()) {
  let userAgent = environment.userAgent ?? "";
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
    return true;
  }
  return /Mac/i.test(environment.platform ?? "") && (environment.maxTouchPoints ?? 0) > 1;
}

export function localFolderAccessUnavailableMessage(
  environment: BrowserEnvironment = currentBrowserEnvironment(),
) {
  if (isMobileBrowser(environment)) {
    return "Local folder access is unavailable in this browser. On mobile, reopen Grove in Google Chrome to choose a local folder from the system file picker.";
  }
  return "File System Access API is unavailable. Use a Chromium browser on localhost to open a folder.";
}
