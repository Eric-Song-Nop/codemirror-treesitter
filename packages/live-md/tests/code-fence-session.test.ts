import { ChangeSet } from "@codemirror/state";
import { describe, expect, it, vi } from "vite-plus/test";
import { emptyLiveMdLeafAnalysisTrace } from "../src/core/analysis/types.js";
import {
  liveMdDefaultCodeFenceHighlighter,
  loadCodeFenceLanguages,
} from "../src/core/languages.js";
import { LiveMdCodeFenceSession } from "../src/core/runtime/code-fence-session.js";
import {
  cachedLiveMdCodeFenceHighlightResult,
  connectLiveMdCodeFenceSessions,
  createLiveMdRenderCache,
  disposeLiveMdCodeFenceSessions,
  mapLiveMdCodeFenceSessions,
  liveMdCodeFenceSessionsPending,
  pruneLiveMdCodeFenceSessions,
} from "../src/core/runtime/render-cache.js";

async function trackedLanguage(name = "ts") {
  let languages = await loadCodeFenceLanguages([name]);
  let original = languages.get(name)!;
  let parser = Object.create(original) as typeof original;
  let deleted = 0;
  parser.createParser = () => {
    let native = original.createParser();
    let destroy = native.delete.bind(native);
    native.delete = () => {
      deleted++;
      destroy();
    };
    return native;
  };
  let parse = vi.spyOn(parser, "parseWith");
  return { parser, parse, deleted: () => deleted };
}
const highlighters = [liveMdDefaultCodeFenceHighlighter];

function finish(session: LiveMdCodeFenceSession) {
  for (let index = 0; index < 100 && !session.work(() => false); index++) {}
  expect(session.pending).toBe(false);
  return session.result!;
}

describe("bounded incremental code-fence sessions", () => {
  it("passes an edited native tree on source changes and reuses the tree for themes", async () => {
    let { parser, parse, deleted } = await trackedLanguage();
    let trace = emptyLiveMdLeafAnalysisTrace();
    let session = new LiveMdCodeFenceSession(parser, { from: 10, to: 29 }, trace);
    try {
      session.request("const value = 1;", "initial", highlighters, trace);
      let initial = finish(session);
      expect(initial.spans.length).toBeGreaterThan(0);
      expect(parse.mock.calls[0]![2]).toBeNull();
      session.request("const value = 23;", "edited", highlighters, trace);
      let edited = finish(session);
      expect(parse.mock.calls[1]![2]).not.toBeNull();
      expect(parse.mock.calls.every((call) => typeof call[3] == "function")).toBe(true);
      let fresh = new LiveMdCodeFenceSession(parser, { from: 10, to: 30 }, trace);
      try {
        fresh.request(edited.source, "fresh", highlighters, trace);
        expect(edited.spans).toEqual(finish(fresh).spans);
      } finally {
        fresh.dispose();
      }
      let count = parse.mock.calls.length;
      session.request(edited.source, "theme", highlighters, trace);
      expect(finish(session).spans).toEqual(edited.spans);
      expect(parse).toHaveBeenCalledTimes(count);
    } finally {
      session.dispose();
    }
    expect(deleted()).toBe(2);
    expect(trace.codeFenceTreesCreated).toBe(trace.codeFenceTreesDeleted);
  });

  it("resumes large native parses and discards stale work while keeping the completed base", async () => {
    let { parser, parse } = await trackedLanguage();
    let trace = emptyLiveMdLeafAnalysisTrace();
    let session = new LiveMdCodeFenceSession(parser, { from: 0, to: 100000 }, trace);
    try {
      session.request("let a = 1;", "base", highlighters, trace);
      finish(session);
      let source = "let a = 1;\n".repeat(10000);
      session.request(source, "large", highlighters, trace);
      expect(session.work(() => true)).toBe(false);
      expect(session.result).toBeNull();
      let partialCall = parse.mock.calls.at(-1)!;
      expect(partialCall[2]).not.toBeNull();
      session.work(() => true);
      expect(parse.mock.calls.at(-1)![0]).toBe(partialCall[0]);
      expect(parse.mock.calls.at(-1)![2]).toBe(partialCall[2]);
      session.request("let latest = 42;", "latest", highlighters, trace);
      let result = finish(session);
      expect(result.source).toBe("let latest = 42;");
      expect(parse.mock.calls.at(-1)![2]).not.toBeNull();
    } finally {
      session.dispose();
    }
  });

  it("eventually highlights the end of a large fence after bounded slices", async () => {
    let { parser } = await trackedLanguage();
    let trace = emptyLiveMdLeafAnalysisTrace();
    let source = "const value = 123;\n".repeat(3000);
    let session = new LiveMdCodeFenceSession(parser, { from: 0, to: source.length }, trace);
    try {
      session.request(source, "large", highlighters, trace);
      let yields = 0;
      for (let iteration = 0; iteration < 1000; iteration++) {
        let deadline = performance.now() + 1;
        if (session.work(() => performance.now() >= deadline)) break;
        yields++;
      }
      expect(yields).toBeGreaterThan(0);
      expect(session.pending).toBe(false);
      expect(session.result!.spans.at(-1)!.to).toBeGreaterThan(source.length - 10);
      let oracle = cachedLiveMdCodeFenceHighlightResult(
        createLiveMdRenderCache(),
        emptyLiveMdLeafAnalysisTrace(),
        source,
        new Map([["ts", parser]]),
        highlighters,
        "oracle",
        "ts",
      );
      expect(session.result!.spans).toEqual(oracle.spans);
    } finally {
      session.dispose();
    }
  });

  it("queues every visible fence beyond the native session limit without dropping work", async () => {
    let { parser, deleted } = await trackedLanguage();
    let parse = parser.parseWith.bind(parser);
    let create = parser.createParser.bind(parser);
    let blocked = true,
      blockFirst = true,
      created = 0,
      peak = 0;
    let firstNative: ReturnType<typeof parser.createParser> | null = null;
    parser.createParser = () => {
      created++;
      peak = Math.max(peak, created - deleted());
      let native = create();
      firstNative ??= native;
      return native;
    };
    parser.parseWith = (...args) => {
      if (blocked) return null;
      if (blockFirst && args[0] == firstNative) {
        while (!args[3]!()) {
          /* Simulate a native parse using this turn's budget. */
        }
        return null;
      }
      return parse(...args);
    };
    let cache = createLiveMdRenderCache();
    let trace = emptyLiveMdLeafAnalysisTrace();
    let completed = new Set<number>();
    connectLiveMdCodeFenceSessions(cache, (ranges) => {
      for (let range of ranges) completed.add(range.from);
    });
    let request = (index: number) =>
      cachedLiveMdCodeFenceHighlightResult(
        cache,
        trace,
        "let a = 3;",
        new Map([["ts", parser]]),
        highlighters,
        `queued-${index}`,
        "ts",
        { from: index * 20, to: index * 20 + 10 },
      );
    try {
      for (let index = 0; index < 40; index++) expect(request(index).spans).toEqual([]);
      expect(created).toBe(16);
      expect(deleted()).toBe(0);
      expect(liveMdCodeFenceSessionsPending(cache)).toBe(true);
      blocked = false;
      for (let turn = 0; turn < 500 && completed.size < 39; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(completed.size).toBe(39);
      expect(liveMdCodeFenceSessionsPending(cache)).toBe(true);
      blockFirst = false;
      for (let turn = 0; turn < 500 && liveMdCodeFenceSessionsPending(cache); turn++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(liveMdCodeFenceSessionsPending(cache)).toBe(false);
      expect(completed.size).toBe(40);
      for (let index = 0; index < 40; index++)
        expect(request(index).spans.length).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(16);
    } finally {
      disposeLiveMdCodeFenceSessions(cache);
    }
    expect(deleted()).toBe(created);
  });

  it("bounds each native highlight query to the current source window", async () => {
    let { parser } = await trackedLanguage("javascript");
    let source = "const value = 123;\n".repeat(3000);
    let trace = emptyLiveMdLeafAnalysisTrace();
    let session = new LiveMdCodeFenceSession(parser, { from: 0, to: source.length }, trace);
    let query = parser.highlightQuery!;
    let captures = query.captures.bind(query);
    let counts: number[] = [];
    let spy = vi.spyOn(query, "captures").mockImplementation((node, options) => {
      expect(options?.startIndex).toBeTypeOf("number");
      expect(options?.endIndex).toBeTypeOf("number");
      expect(options!.endIndex! - options!.startIndex!).toBeLessThanOrEqual(8192 * 2);
      let result = captures(node, options);
      counts.push(result.length);
      return result;
    });
    try {
      session.request(source, "windowed", highlighters, trace);
      finish(session);
      expect(counts.length).toBeGreaterThan(1);
      expect(Math.max(...counts)).toBeLessThan(counts.reduce((sum, value) => sum + value, 0) / 3);
    } finally {
      spy.mockRestore();
      session.dispose();
    }
  });
  it("resumes nested grammar wrapping and releases native resources on disposal", async () => {
    let { parser } = await trackedLanguage("html");
    let trace = emptyLiveMdLeafAnalysisTrace();
    let session = new LiveMdCodeFenceSession(parser, { from: 0, to: 100 }, trace);
    try {
      session.request("<script>let a = 1;</script>", "html", highlighters, trace);
      expect(session.work(() => true)).toBe(false);
      expect(finish(session).spans.length).toBeGreaterThan(0);
      expect(trace.codeFenceParserSessionsCreated).toBeGreaterThan(1);
    } finally {
      session.dispose();
    }
    expect(trace.codeFenceParserSessionsCreated).toBe(trace.codeFenceParserSessionsDeleted);
    expect(trace.codeFenceTreesCreated).toBe(trace.codeFenceTreesDeleted);
  });

  it("maps stable positions through edits and disposes removed, evicted and destroyed sessions", async () => {
    let { parser, parse, deleted } = await trackedLanguage();
    let cache = createLiveMdRenderCache();
    let trace = emptyLiveMdLeafAnalysisTrace();
    connectLiveMdCodeFenceSessions(cache, () => {});
    let request = (from: number, source: string, key: string) =>
      cachedLiveMdCodeFenceHighlightResult(
        cache,
        trace,
        source,
        new Map([["ts", parser]]),
        highlighters,
        key,
        "ts",
        { from, to: from + source.length },
      );
    try {
      request(10, "let a = 1;", "initial");
      mapLiveMdCodeFenceSessions(cache, ChangeSet.of({ from: 0, insert: "before" }, 1000));
      request(16, "let a = 2;", "edited");
      expect(parse.mock.calls.at(-1)![2]).not.toBeNull();
      pruneLiveMdCodeFenceSessions(cache, [{ from: 500, to: 1000 }]);
      expect(deleted()).toBe(1);
      for (let index = 0; index < 17; index++) request(index * 20, "let a = 3;", `fence-${index}`);
      expect(deleted()).toBe(2);
    } finally {
      disposeLiveMdCodeFenceSessions(cache);
    }
    expect(deleted()).toBe(18);
  });
});
