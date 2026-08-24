import type {
  WorkspaceDocumentPort,
  WorkspaceEntryPort,
  WorkspaceIdentity,
  WorkspaceTreePort,
  WorkspaceTextSnapshot,
} from "../../workspace/runtime/types.ts";
import type { SourceObservation } from "../../workspace/storage/types.ts";
import { awaitWorkspaceAgentOperation, throwIfWorkspaceAgentAborted } from "./abort.ts";
import {
  workspaceAgentActiveDocumentVersion,
  type WorkspaceAgentActiveDocument,
} from "../domain/active-document.ts";
import type {
  WorkspaceAgentDocumentSource,
  WorkspaceAgentIssue,
  WorkspaceAgentReadMarkdownInput,
  WorkspaceAgentReadMarkdownResult,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentSearchMatch,
  WorkspaceAgentSearchResult,
  WorkspaceAgentSearchTruncationReason,
} from "../domain/contracts.ts";
import type { WorkspaceAgentLimits } from "../domain/limits.ts";
import {
  collectWorkspaceMarkdownCatalog,
  compareWorkspaceAgentPaths,
  isWorkspaceAgentMarkdownPath,
  normalizeWorkspaceAgentDirectory,
  normalizeWorkspaceAgentFilePath,
  resolveWorkspaceMarkdownFile,
  workspaceAgentPathIsWithinDirectory,
} from "./workspace-catalog.ts";

export type WorkspaceAgentReadRuntime = {
  documents: WorkspaceDocumentPort;
  entries?: Pick<WorkspaceEntryPort, "probe">;
  identity: WorkspaceIdentity;
  tree: WorkspaceTreePort;
};

export async function readWorkspaceMarkdown(input: {
  activeDocument: WorkspaceAgentActiveDocument | null;
  limits: WorkspaceAgentLimits;
  request: WorkspaceAgentReadMarkdownInput;
  runtime: WorkspaceAgentReadRuntime;
  signal?: AbortSignal;
}): Promise<WorkspaceAgentReadMarkdownResult> {
  let path = normalizeWorkspaceAgentFilePath(input.request.path);
  if (!path) {
    return {
      path: input.request.path,
      reason: isWorkspaceAgentMarkdownPath(input.request.path)
        ? "outside-workspace"
        : "not-markdown",
      status: "not-found",
    };
  }

  let activeDocument = normalizedActiveDocument(input.activeDocument);
  if (activeDocument?.path == path) {
    return markdownReadResult({
      request: input.request,
      limits: input.limits,
      path,
      source: {
        dirty: activeDocument.dirty,
        kind: "active-document",
        version: workspaceAgentActiveDocumentVersion(activeDocument),
      },
      totalBytes: utf8ByteLength(activeDocument.value),
      value: activeDocument.value,
    });
  }

  let resolved = await resolveWorkspaceMarkdownFile({
    limits: input.limits.catalog,
    path,
    signal: input.signal,
    tree: input.runtime.tree,
  });
  if (resolved.issue) return { issue: resolved.issue, path, status: "unavailable" };
  if (!resolved.file) {
    return {
      path,
      reason: resolved.reason ?? "outside-workspace",
      status: "not-found",
    };
  }

  let observation: SourceObservation<WorkspaceTextSnapshot>;
  try {
    observation = await awaitWorkspaceAgentOperation(
      input.runtime.documents.observe(path),
      input.signal,
    );
  } catch (error) {
    throwIfWorkspaceAgentAborted(input.signal);
    return { issue: issueFromError(path, error), path, status: "unavailable" };
  }
  if (observation.state == "missing") return { path, status: "missing" };
  if (observation.state == "unavailable") {
    return { issue: issueFromError(path, observation.error), path, status: "unavailable" };
  }

  return markdownReadResult({
    request: input.request,
    limits: input.limits,
    path,
    source: {
      capture: observation.value.capture,
      contentHash: observation.value.contentHash,
      kind: "workspace-source",
      revision: observation.value.revision,
    },
    totalBytes: observation.value.bytes.byteLength,
    value: observation.value.value,
  });
}

export async function searchWorkspaceMarkdown(input: {
  activeDocument: WorkspaceAgentActiveDocument | null;
  limits: WorkspaceAgentLimits;
  request: WorkspaceAgentSearchMarkdownInput;
  runtime: WorkspaceAgentReadRuntime;
  signal?: AbortSignal;
}): Promise<WorkspaceAgentSearchResult> {
  let directory = normalizeWorkspaceAgentDirectory(input.request.directory);
  if (directory == null) return emptySearch(input.request.query, "", "not-found");

  let query = input.request.query;
  if (query.length < input.limits.search.minQueryCharacters) {
    return emptySearch(query, directory, "not-found", {
      message: `Search queries must contain at least ${input.limits.search.minQueryCharacters} characters.`,
      path: directory,
    });
  }

  let catalog = await collectWorkspaceMarkdownCatalog({
    directory,
    limits: { ...input.limits.catalog, maxFiles: input.limits.search.maxFiles },
    signal: input.signal,
    tree: input.runtime.tree,
  });
  if (catalog.status == "not-found") {
    return emptySearch(query, directory, "not-found");
  }

  let files = [...catalog.files];
  let activeDocument = normalizedActiveDocument(input.activeDocument);
  if (
    activeDocument &&
    workspaceAgentPathIsWithinDirectory(activeDocument.path, directory) &&
    !files.some((file) => file.path == activeDocument.path)
  ) {
    if (files.length >= input.limits.search.maxFiles) files.pop();
    files.push({
      name: activeDocument.path.split("/").at(-1)!,
      path: activeDocument.path,
    });
    files.sort((a, b) => compareWorkspaceAgentPaths(a.path, b.path));
  }

  let issues = [...catalog.issues];
  let matches: WorkspaceAgentSearchMatch[] = [];
  let readBytes = 0;
  let scannedFiles = 0;
  let skippedLargeFiles = 0;
  let truncationReason: WorkspaceAgentSearchTruncationReason | undefined = catalog.truncationReason;
  let concurrency =
    input.runtime.identity.kind == "local"
      ? input.limits.search.localConcurrency
      : input.limits.search.remoteConcurrency;

  search: for (let offset = 0; offset < files.length; offset += concurrency) {
    throwIfWorkspaceAgentAborted(input.signal);
    let batch = files.slice(offset, offset + concurrency);
    let observations = await Promise.all(
      batch.map((file) =>
        readSearchDocument(
          file.path,
          activeDocument,
          input.runtime,
          input.limits.search.maxFileBytes,
          input.signal,
        ),
      ),
    );

    for (let index = 0; index < batch.length; index++) {
      throwIfWorkspaceAgentAborted(input.signal);
      let file = batch[index]!;
      let observation = observations[index]!;
      scannedFiles++;
      if (observation.kind == "issue") {
        issues.push(observation.issue);
        continue;
      }
      if (observation.kind == "missing") {
        issues.push({ message: "The file disappeared while searching.", path: file.path });
        continue;
      }
      if (observation.kind == "too-large") {
        skippedLargeFiles++;
        truncationReason ??= "max-file-bytes";
        continue;
      }
      if (observation.bytes > input.limits.search.maxFileBytes) {
        skippedLargeFiles++;
        truncationReason ??= "max-file-bytes";
        continue;
      }
      if (readBytes + observation.bytes > input.limits.search.maxBytes) {
        truncationReason = "max-bytes";
        break search;
      }
      readBytes += observation.bytes;

      collectSearchMatches({
        caseSensitive: input.request.caseSensitive ?? false,
        limit: input.limits.search.maxMatches - matches.length,
        matches,
        path: file.path,
        query,
        snippetCharacters: input.limits.search.maxSnippetCharacters,
        value: observation.value,
      });
      if (matches.length >= input.limits.search.maxMatches) {
        truncationReason = "max-matches";
        break search;
      }
    }
  }

  return {
    directory,
    issues,
    matches,
    query,
    readBytes,
    scannedFiles,
    skippedLargeFiles,
    status: truncationReason ? "truncated" : issues.length ? "partial" : "complete",
    truncationReason,
  };
}

type SearchDocumentResult =
  | { bytes: number; kind: "found"; value: string }
  | { kind: "missing" }
  | { kind: "too-large" }
  | { issue: WorkspaceAgentIssue; kind: "issue" };

async function readSearchDocument(
  path: string,
  activeDocument: WorkspaceAgentActiveDocument | null,
  runtime: WorkspaceAgentReadRuntime,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<SearchDocumentResult> {
  if (activeDocument?.path == path) {
    return {
      bytes: utf8ByteLength(activeDocument.value),
      kind: "found",
      value: activeDocument.value,
    };
  }
  try {
    if (runtime.entries) {
      let probe = await awaitWorkspaceAgentOperation(runtime.entries.probe(path), signal);
      if (probe.state == "missing") return { kind: "missing" };
      if (probe.state == "unavailable") {
        return { issue: issueFromError(path, probe.error), kind: "issue" };
      }
      if ((probe.value.metadata.size ?? 0) > maxFileBytes) return { kind: "too-large" };
    }

    let observation = await awaitWorkspaceAgentOperation(runtime.documents.observe(path), signal);
    if (observation.state == "missing") return { kind: "missing" };
    if (observation.state == "unavailable") {
      return { issue: issueFromError(path, observation.error), kind: "issue" };
    }
    return {
      bytes: observation.value.bytes.byteLength,
      kind: "found",
      value: observation.value.value,
    };
  } catch (error) {
    throwIfWorkspaceAgentAborted(signal);
    return { issue: issueFromError(path, error), kind: "issue" };
  }
}

function markdownReadResult(input: {
  limits: WorkspaceAgentLimits;
  path: string;
  request: WorkspaceAgentReadMarkdownInput;
  source: WorkspaceAgentDocumentSource;
  totalBytes: number;
  value: string;
}): WorkspaceAgentReadMarkdownResult {
  let requestedStartLine = positiveInteger(input.request.startLine, 1);
  let requestedLineCount = positiveInteger(input.request.lineCount, input.limits.read.maxLines);
  let lineCount = Math.min(requestedLineCount, input.limits.read.maxLines);
  let lines = input.value.split("\n");
  let totalLines = lines.length;
  let startLine = Math.min(requestedStartLine, totalLines + 1);
  let endExclusive = Math.min(startLine - 1 + lineCount, totalLines);
  let selected = lines.slice(startLine - 1, endExclusive).join("\n");
  if (endExclusive < totalLines && selected) selected += "\n";
  let { text, truncated: byteTruncated } = truncateUtf8(selected, input.limits.read.maxBytes);
  let returnedLineBreaks = text.match(/\n/g)?.length ?? 0;
  let selectedLineCount = Math.max(0, endExclusive - (startLine - 1));
  let returnedLineCount = byteTruncated
    ? text
      ? returnedLineBreaks + (text.endsWith("\n") ? 0 : 1)
      : 0
    : selectedLineCount;
  let endLine = returnedLineCount ? startLine + returnedLineCount - 1 : startLine - 1;
  let hasMoreLines = endLine < totalLines;

  return {
    endLine,
    nextStartLine: hasMoreLines && !byteTruncated ? endLine + 1 : undefined,
    path: input.path,
    source: input.source,
    startLine,
    status: "found",
    text,
    totalBytes: input.totalBytes,
    totalLines,
    truncated:
      byteTruncated || requestedLineCount > input.limits.read.maxLines || endExclusive < totalLines,
  };
}

function collectSearchMatches(input: {
  caseSensitive: boolean;
  limit: number;
  matches: WorkspaceAgentSearchMatch[];
  path: string;
  query: string;
  snippetCharacters: number;
  value: string;
}) {
  if (input.limit <= 0) return;
  let matcher = new RegExp(escapeRegExp(input.query), input.caseSensitive ? "gu" : "giu");
  let lines = input.value.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let line = lines[lineIndex]!;
    matcher.lastIndex = 0;
    for (let match = matcher.exec(line); match; match = matcher.exec(line)) {
      input.matches.push({
        column: match.index + 1,
        line: lineIndex + 1,
        path: input.path,
        preview: searchPreview(line, match.index, match[0].length, input.snippetCharacters),
      });
      if (--input.limit <= 0) return;
    }
  }
}

function searchPreview(line: string, index: number, matchLength: number, maxCharacters: number) {
  if (line.length <= maxCharacters) return line;
  let windowStart = Math.max(0, index - Math.floor((maxCharacters - matchLength) / 2));
  let windowEnd = Math.min(line.length, windowStart + maxCharacters);
  windowStart = Math.max(0, windowEnd - maxCharacters);
  return `${windowStart ? "…" : ""}${line.slice(windowStart, windowEnd)}${
    windowEnd < line.length ? "…" : ""
  }`;
}

function truncateUtf8(value: string, maxBytes: number) {
  let bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  let decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end--;
    }
  }
  return { text: "", truncated: true };
}

function normalizedActiveDocument(activeDocument: WorkspaceAgentActiveDocument | null) {
  if (!activeDocument) return null;
  let path = normalizeWorkspaceAgentFilePath(activeDocument.path);
  return path ? { ...activeDocument, path } : null;
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return value == null || !Number.isSafeInteger(value) || value < 1 ? fallback : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function issueFromError(path: string, error: unknown): WorkspaceAgentIssue {
  if (
    error &&
    typeof error == "object" &&
    "message" in error &&
    typeof error.message == "string" &&
    "code" in error &&
    typeof error.code == "string"
  ) {
    return {
      code: error.code as WorkspaceAgentIssue["code"],
      message: error.message,
      path,
      retryable:
        "retryable" in error && typeof error.retryable == "boolean" ? error.retryable : undefined,
    };
  }
  return {
    message: error instanceof Error ? error.message : "Workspace operation failed.",
    path,
  };
}

function emptySearch(
  query: string,
  directory: string,
  status: WorkspaceAgentSearchResult["status"],
  issue?: WorkspaceAgentIssue,
): WorkspaceAgentSearchResult {
  return {
    directory,
    issues: issue ? [issue] : [],
    matches: [],
    query,
    readBytes: 0,
    scannedFiles: 0,
    skippedLargeFiles: 0,
    status,
  };
}
