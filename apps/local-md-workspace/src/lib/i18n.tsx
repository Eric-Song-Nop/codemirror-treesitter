import { useCallback, useEffect, type ReactNode } from "react";
import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import en from "@/i18n/en.json";
import zhCN from "@/i18n/zh-CN.json";

const localeStorageKey = "local-md-workspace:locale";

const messagesByLocale = {
  en,
  "zh-CN": zhCN,
} as const;

export type Locale = keyof typeof messagesByLocale;
export type TranslationKey = keyof typeof en;
export type TranslationParams = Record<string, number | string>;
export type TFunction = (key: TranslationKey, params?: TranslationParams) => string;

void i18next.use(initReactI18next).init({
  fallbackLng: "en",
  initAsync: false,
  interpolation: {
    escapeValue: false,
    prefix: "{",
    suffix: "}",
  },
  keySeparator: false,
  lng: readStoredLocale() ?? "en",
  nsSeparator: false,
  react: {
    useSuspense: false,
  },
  resources: {
    en: {
      translation: en,
    },
    "zh-CN": {
      translation: zhCN,
    },
  },
});

export function I18nProvider({ children }: { children: ReactNode }) {
  let { i18n, t } = useTranslation();
  let locale = normalizeLocale(i18n.resolvedLanguage ?? i18n.language);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.title");
  }, [locale, t]);

  return children;
}

export function useI18n() {
  let { i18n, t: translate } = useTranslation();
  let locale = normalizeLocale(i18n.resolvedLanguage ?? i18n.language);
  let t = useCallback<TFunction>((key, params) => translate(key, params) as string, [translate]);
  let setLocale = useCallback(
    (nextLocale: Locale) => {
      storeLocale(nextLocale);
      void i18n.changeLanguage(nextLocale);
    },
    [i18n],
  );
  let toggleLocale = useCallback(() => {
    let nextLocale: Locale = locale == "en" ? "zh-CN" : "en";
    storeLocale(nextLocale);
    void i18n.changeLanguage(nextLocale);
  }, [i18n, locale]);

  return {
    locale,
    setLocale,
    t,
    toggleLocale,
  };
}

export function translateKnownMessage(message: string, t: TFunction) {
  let exactKey = exactMessageKeys[message];
  if (exactKey) return t(exactKey);

  let missingScopes = message.match(
    /^Dropbox app is missing required file permissions: (?<scopes>.+)\. Enable those scopes and reconnect Dropbox workspace\.$/,
  );
  if (missingScopes?.groups) {
    return t("errors.dropboxMissingScopes", { scopes: missingScopes.groups.scopes });
  }

  let missingGoogleDriveScopes = message.match(
    /^Google Drive app is missing required file permissions: (?<scopes>.+)\. Enable those scopes and reconnect Google Drive workspace\.$/,
  );
  if (missingGoogleDriveScopes?.groups) {
    return t("errors.googleDriveMissingScopes", {
      scopes: missingGoogleDriveScopes.groups.scopes,
    });
  }

  let missingOneDriveScopes = message.match(
    /^OneDrive app is missing required file permissions: (?<scopes>.+)\. Enable those scopes and reconnect OneDrive workspace\.$/,
  );
  if (missingOneDriveScopes?.groups) {
    return t("errors.onedriveMissingScopes", { scopes: missingOneDriveScopes.groups.scopes });
  }

  let pathExists = message.match(/^(?<path>.+) already exists\.$/);
  if (pathExists?.groups) {
    return t("errors.pathAlreadyExists", { path: pathExists.groups.path });
  }

  let unsupportedImage = message.match(/^(?<name>.+) is not a supported image\.$/);
  if (unsupportedImage?.groups) {
    return t("errors.unsupportedImage", { name: unsupportedImage.groups.name });
  }

  let createSharedFile = message.match(/^Could not create shared file \((?<status>[^)]+)\)\.$/);
  if (createSharedFile?.groups) {
    return t("errors.couldNotCreateSharedFile", { status: createSharedFile.groups.status });
  }

  let joinSharedFile = message.match(/^Could not join shared file \((?<status>[^)]+)\)\.$/);
  if (joinSharedFile?.groups) {
    return t("errors.couldNotJoinSharedFile", { status: joinSharedFile.groups.status });
  }

  let rotateSharedFile = message.match(
    /^Could not rotate shared file link \((?<status>[^)]+)\)\.$/,
  );
  if (rotateSharedFile?.groups) {
    return t("errors.couldNotRotateSharedFile", { status: rotateSharedFile.groups.status });
  }

  let stopSharing = message.match(/^Could not stop sharing this file \((?<status>[^)]+)\)\.$/);
  if (stopSharing?.groups) {
    return t("errors.couldNotStopSharing", { status: stopSharing.groups.status });
  }

  let hostSync = message.match(/^(?<action>.+), but host sync did not start: (?<detail>.+)$/);
  if (hostSync?.groups) {
    return t("errors.hostSyncDidNotStart", {
      action: translateShareActionLabel(hostSync.groups.action, t),
      message: hostSync.groups.detail,
    });
  }

  let hostSourceMismatch = message.match(
    /^(?<action>.+), but this file is no longer the shared source\.$/,
  );
  if (hostSourceMismatch?.groups) {
    return t("errors.shareHostSourceMismatch", {
      action: translateShareActionLabel(hostSourceMismatch.groups.action, t),
    });
  }

  let hostKey = message.match(
    /^(?<action>.+), but this browser cannot host it without the host key\.$/,
  );
  if (hostKey?.groups) {
    return t("errors.shareHostMissingKey", {
      action: translateShareActionLabel(hostKey.groups.action, t),
    });
  }

  return message;
}

function translateShareActionLabel(label: string, t: TFunction) {
  if (label == "Link rotated") return t("share.action.linkRotated");
  if (label == "Link rotation failed") return t("share.action.linkRotationFailed");
  return t("share.action.linkCreated");
}

function readStoredLocale() {
  try {
    let value = localStorage.getItem(localeStorageKey);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

function storeLocale(locale: Locale) {
  try {
    localStorage.setItem(localeStorageKey, locale);
  } catch {
    // Storage can be blocked in private or embedded browser contexts.
  }
}

function normalizeLocale(value: string | undefined): Locale {
  return value == "zh-CN" ? "zh-CN" : "en";
}

function isLocale(value: string | null): value is Locale {
  return value == "en" || value == "zh-CN";
}

const exactMessageKeys: Readonly<Record<string, TranslationKey>> = {
  "Browser storage is required to host a shared file.": "errors.browserStorageRequired",
  "Could not allocate an image file name.": "errors.couldNotAllocateImageFileName",
  "Could not copy the link.": "errors.cannotCopyLink",
  "Dropbox access token expired. Reconnect Dropbox workspace to continue.":
    "errors.dropboxAccessTokenExpired",
  "Dropbox app folder or workspace path is no longer available. Check the Dropbox app folder setting, then reconnect Dropbox workspace.":
    "errors.dropboxPathUnavailable",
  "Dropbox app key is required.": "errors.dropboxAppKeyRequired",
  "Dropbox authorization did not return a code.": "errors.dropboxAuthorizationCodeMissing",
  "Dropbox authorization is invalid or was revoked. Reconnect Dropbox workspace to continue.":
    "errors.dropboxAuthorizationInvalid",
  "Dropbox authorization popup was blocked. Allow popups for this site and try again.":
    "errors.dropboxPopupBlocked",
  "Dropbox authorization state did not match.": "errors.dropboxAuthorizationStateMismatch",
  "Dropbox authorization state was not found.": "errors.dropboxAuthorizationStateMissing",
  "Dropbox authorization was closed before it completed. Reconnect Dropbox workspace to continue.":
    "errors.dropboxAuthorizationClosed",
  "Dropbox authorization was denied.": "errors.dropboxAuthorizationDenied",
  "Dropbox token exchange failed. Check the app key and reconnect Dropbox workspace.":
    "errors.dropboxTokenExchangeFailed",
  "Dropbox workspace is not configured. Set VITE_DROPBOX_APP_KEY for this app.":
    "errors.dropboxNotConfigured",
  "Google Drive access token expired. Reconnect Google Drive workspace to continue.":
    "errors.googleDriveAccessTokenExpired",
  "Google Drive authorization did not return a code.": "errors.googleDriveAuthorizationCodeMissing",
  "Google Drive authorization is invalid or was revoked. Reconnect Google Drive workspace to continue.":
    "errors.googleDriveAuthorizationInvalid",
  "Google Drive authorization popup was blocked. Allow popups for this site and try again.":
    "errors.googleDrivePopupBlocked",
  "Google Drive authorization state did not match.": "errors.googleDriveAuthorizationStateMismatch",
  "Google Drive authorization state was not found.": "errors.googleDriveAuthorizationStateMissing",
  "Google Drive authorization was closed before it completed. Reconnect Google Drive workspace to continue.":
    "errors.googleDriveAuthorizationClosed",
  "Google Drive authorization was denied or blocked by Google OAuth app settings. If this is a development app, add your Google account as a test user and check the Drive scope before reconnecting.":
    "errors.googleDriveAuthorizationDenied",
  "Google Drive client ID is required.": "errors.googleDriveClientIdRequired",
  "Google Drive token exchange failed. Check the client ID and reconnect Google Drive workspace.":
    "errors.googleDriveTokenExchangeFailed",
  "Google Drive workspace is not configured. Set VITE_GOOGLE_DRIVE_CLIENT_ID for this app.":
    "errors.googleDriveNotConfigured",
  "Google Drive workspace path is no longer available. Check the Google Drive root setting, then reconnect Google Drive workspace.":
    "errors.googleDrivePathUnavailable",
  "OneDrive access token expired. Reconnect OneDrive workspace to continue.":
    "errors.onedriveAccessTokenExpired",
  "OneDrive authorization did not return a code.": "errors.onedriveAuthorizationCodeMissing",
  "OneDrive authorization is invalid or was revoked. Reconnect OneDrive workspace to continue.":
    "errors.onedriveAuthorizationInvalid",
  "OneDrive authorization popup was blocked. Allow popups for this site and try again.":
    "errors.onedrivePopupBlocked",
  "OneDrive authorization state did not match.": "errors.onedriveAuthorizationStateMismatch",
  "OneDrive authorization state was not found.": "errors.onedriveAuthorizationStateMissing",
  "OneDrive authorization was closed before it completed. Reconnect OneDrive workspace to continue.":
    "errors.onedriveAuthorizationClosed",
  "OneDrive authorization was denied.": "errors.onedriveAuthorizationDenied",
  "OneDrive client ID is required.": "errors.onedriveClientIdRequired",
  "OneDrive token exchange failed. Check the client ID and reconnect OneDrive workspace.":
    "errors.onedriveTokenExchangeFailed",
  "OneDrive workspace is not configured. Set VITE_ONEDRIVE_CLIENT_ID for this app.":
    "errors.onedriveNotConfigured",
  "OneDrive workspace path is no longer available. Check the OneDrive root setting, then reconnect OneDrive workspace.":
    "errors.onedrivePathUnavailable",
  "Enter a file name, not a path.": "errors.enterFileNameNotPath",
  "Enter a file name.": "errors.enterFileName",
  "Enter a folder name, not a path.": "errors.enterFolderNameNotPath",
  "Enter a folder name.": "errors.enterFolderName",
  "File System Access API is not available in this browser.":
    "errors.fileSystemAccessUnavailableRuntime",
  "File System Access API is unavailable. Use a Chromium browser on localhost to open a folder.":
    "errors.fileSystemAccessUnavailableDesktop",
  "File paths cannot include . or ..": "errors.filePathsCannotIncludeDots",
  "Invalid share metadata.": "errors.invalidShareMetadata",
  "Invalid share secret.": "errors.invalidShareSecret",
  "Invalid share status.": "errors.invalidShareStatus",
  "Invalid shared file revocation.": "errors.invalidSharedFileRevocation",
  "Invalid shared file rotation.": "errors.invalidSharedFileRotation",
  "Invalid shared file session.": "errors.invalidSharedFileSession",
  "Local folder access is unavailable in this browser. On mobile, reopen Grove in Google Chrome to choose a local folder from the system file picker.":
    "errors.fileSystemAccessUnavailableMobile",
  "OpenDAL backend does not support folder creation.": "errors.unsupportedOpenDalFolderCreation",
  "OpenDAL browser WASM assets are missing from the build.": "errors.openDalMissingAssets",
  "Read-write folder permission was not granted.": "errors.localPermissionDenied",
  "Relay returned the wrong share.": "errors.relayWrongShare",
  "Shared file metadata is not available in this browser.": "errors.sharedMetadataUnavailable",
  "Shared file relay is not configured.": "errors.relayNotConfigured",
  "This browser cannot rotate the link without the host key.": "errors.cannotRotateWithoutHostKey",
  "This browser cannot stop sharing without the host key.": "errors.cannotStopWithoutHostKey",
  "This file is no longer shared.": "errors.fileNoLongerShared",
  "This shared file link is invalid or missing its edit key.": "errors.invalidShareLink",
  "This storage backend does not support that operation.": "errors.storageUnsupportedOperation",
  "This workspace cannot delete folders.": "errors.cannotDeleteFolders",
  "This workspace cannot host shared files.": "errors.cannotHostSharedFiles",
  "This workspace cannot rename folders.": "errors.cannotRenameFolders",
};
