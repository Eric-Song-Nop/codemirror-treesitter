export function isSharedFilePath(pathname: string) {
  return /^\/share(?:\/|$)/.test(pathname);
}
