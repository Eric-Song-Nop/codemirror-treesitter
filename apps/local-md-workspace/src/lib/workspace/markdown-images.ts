export function resolveMarkdownImagePath(source: string, documentPath: string) {
  if (!documentPath || isExternalImageSource(source)) return null;

  let path = stripImageSourceSuffix(source);
  if (!path || path.startsWith("//")) return null;

  try {
    path = decodeURI(path);
  } catch {
    return null;
  }

  return normalizeWorkspacePath(
    path.startsWith("/") ? path.slice(1) : joinWorkspacePath(directoryPath(documentPath), path),
  );
}

function isExternalImageSource(source: string) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source);
}

function stripImageSourceSuffix(source: string) {
  let suffixIndex = source.search(/[?#]/);
  return suffixIndex == -1 ? source : source.slice(0, suffixIndex);
}

function normalizeWorkspacePath(path: string) {
  let parts: string[] = [];
  for (let part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part == ".") continue;
    if (part == "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function directoryPath(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function joinWorkspacePath(parent: string, child: string) {
  return parent ? `${parent}/${child}` : child;
}
