const allowedLinkProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);
const allowedBaseProtocols = new Set(["http:", "https:"]);

export function sanitizeLiveMdLinkDestination(source: null | string | undefined) {
  let destination = normalizeMarkdownDestination(source);
  if (!destination || hasControlCharacter(destination)) return null;

  let absolute = parseAbsoluteLinkDestination(destination);
  return absolute === undefined ? destination : absolute;
}

export function resolveLiveMdLinkDestination(
  source: null | string | undefined,
  baseUrl: null | string,
) {
  let destination = sanitizeLiveMdLinkDestination(source);
  if (!destination) return null;

  let absolute = parseAbsoluteLinkDestination(destination);
  if (absolute !== undefined) return absolute;
  if (!baseUrl) return null;

  try {
    let parsed = new URL(destination, baseUrl);
    return allowedLinkProtocols.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function normalizeLiveMdLinkBaseUrl(baseUrl: string | URL | null | undefined) {
  let source = baseUrl instanceof URL ? baseUrl.href : baseUrl?.trim();
  if (!source || hasControlCharacter(source)) return null;

  try {
    let parsed = new URL(source);
    return allowedBaseProtocols.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function parseAbsoluteLinkDestination(destination: string) {
  try {
    let parsed = new URL(destination);
    return allowedLinkProtocols.has(parsed.protocol) ? destination : null;
  } catch {
    return undefined;
  }
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code < 32 || code == 127) return true;
  }
  return false;
}

function normalizeMarkdownDestination(source: null | string | undefined) {
  let destination = source?.trim() ?? "";
  if (destination.length >= 2 && destination[0] == "<" && destination.at(-1) == ">") {
    destination = destination.slice(1, -1).trim();
  }
  return unescapeMarkdownPunctuation(destination);
}

function unescapeMarkdownPunctuation(value: string) {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    let char = value[index];
    if (char == "\\" && index + 1 < value.length) {
      result += value[++index];
    } else {
      result += char;
    }
  }
  return result;
}
