import type { WorkspaceIdentity, WorkspaceTreePort } from "../../workspace/runtime/types.ts";
import type { WorkspaceDocuments } from "../../workspace/documents/contracts.ts";
import { awaitWorkspaceAgentOperation, throwIfWorkspaceAgentAborted } from "./abort.ts";
import type {
  WorkspaceAgentIssue,
  WorkspaceAgentReadFileInput,
  WorkspaceAgentReadFileResult,
  WorkspaceAgentSearchMarkdownInput,
  WorkspaceAgentSearchMatch,
  WorkspaceAgentSearchResult,
  WorkspaceAgentSearchTruncationReason,
} from "../domain/contracts.ts";
import type { WorkspaceAgentLimits } from "../domain/limits.ts";
import {
  collectWorkspaceMarkdownCatalog,
  normalizeWorkspaceAgentDirectory,
  resolveWorkspaceMarkdownFile,
} from "./workspace-catalog.ts";

export type WorkspaceAgentRuntime = {
  documents: WorkspaceDocuments;
  identity: WorkspaceIdentity;
  tree: WorkspaceTreePort;
};

export async function readWorkspaceFile(input: {
  limits: WorkspaceAgentLimits;
  request: WorkspaceAgentReadFileInput;
  runtime: WorkspaceAgentRuntime;
  signal?: AbortSignal;
}): Promise<WorkspaceAgentReadFileResult> {
  let resolved = await resolveWorkspaceMarkdownFile({
    limits: input.limits.catalog,
    path: input.request.path,
    signal: input.signal,
    tree: input.runtime.tree,
  });
  let path = resolved.file?.path ?? input.request.path;
  if (resolved.issue) return { issue: resolved.issue, path, status: "unavailable" };
  if (!resolved.file) {
    return {
      path,
      reason: resolved.reason ?? "outside-workspace",
      status: "not-found",
    };
  }

  try {
    let document = await awaitWorkspaceAgentOperation(
      input.runtime.documents.document(path),
      input.signal,
    );
    let value = document.read();
    return fileReadResult({
      limits: input.limits,
      path,
      request: input.request,
      value,
    });
  } catch (error) {
    throwIfWorkspaceAgentAborted(input.signal);
    return { issue: issueFromError(path, error), path, status: "unavailable" };
  }
}

export async function searchWorkspaceMarkdown(input: {
  limits: WorkspaceAgentLimits;
  request: WorkspaceAgentSearchMarkdownInput;
  runtime: WorkspaceAgentRuntime;
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

  let files = catalog.files;

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
  runtime: WorkspaceAgentRuntime,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<SearchDocumentResult> {
  try {
    let document = await awaitWorkspaceAgentOperation(runtime.documents.document(path), signal);
    let value = document.read();
    let bytes = utf8ByteLength(value);
    if (bytes > maxFileBytes) return { kind: "too-large" };
    return {
      bytes,
      kind: "found",
      value,
    };
  } catch (error) {
    throwIfWorkspaceAgentAborted(signal);
    return { issue: issueFromError(path, error), kind: "issue" };
  }
}

function fileReadResult(input: {
  limits: WorkspaceAgentLimits;
  path: string;
  request: WorkspaceAgentReadFileInput;
  value: string;
}): WorkspaceAgentReadFileResult {
  let requestedStartLine = positiveInteger(input.request.startLine, 1);
  let requestedLineCount = positiveInteger(input.request.lineCount, input.limits.read.maxLines);
  let lineCount = Math.min(requestedLineCount, input.limits.read.maxLines);
  let lines = input.value.split("\n");
  let totalLines = lines.length;
  let startLine = Math.min(requestedStartLine, totalLines + 1);
  let startOffset = lineStartOffset(input.value, startLine);
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
    endOffset: startOffset + text.length,
    nextStartLine: hasMoreLines && !byteTruncated ? endLine + 1 : undefined,
    path: input.path,
    startLine,
    startOffset,
    status: "found",
    text,
    totalBytes: utf8ByteLength(input.value),
    totalLines,
    truncated:
      byteTruncated || requestedLineCount > input.limits.read.maxLines || endExclusive < totalLines,
  };
}

function lineStartOffset(value: string, line: number) {
  if (line <= 1) return 0;
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine++) {
    let nextLine = value.indexOf("\n", offset);
    if (nextLine < 0) return value.length;
    offset = nextLine + 1;
  }
  return offset;
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
