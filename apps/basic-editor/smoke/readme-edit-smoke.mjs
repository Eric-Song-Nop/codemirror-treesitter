import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(scriptDir, "..");
const workspaceRoot = join(scriptDir, "../../..");
const README_PATH = process.env.BASIC_EDITOR_SMOKE_MARKDOWN || join(workspaceRoot, "README.md");
const STRICT =
  !process.argv.includes("--collect") &&
  process.env.BASIC_EDITOR_SMOKE_STRICT != "0" &&
  process.env.BASIC_EDITOR_SMOKE_STRICT != "false";
const HOST = "127.0.0.1";
const readme = readFileSync(README_PATH, "utf8");

let server = null;
let chrome = null;
let cdpClient = null;
let exitCode = 0;
let userDataDir = null;

try {
  let smokeUrl = process.env.BASIC_EDITOR_SMOKE_URL;
  if (!smokeUrl) {
    server = await startBasicEditorServer();
    smokeUrl = server.url;
  }

  let chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      "Chromium was not found. Set CHROME_PATH or install Playwright's Chromium cache first.",
    );
  }

  userDataDir = await mkdtemp(join(tmpdir(), "basic-editor-readme-smoke-"));
  chrome = execFile(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-default-browser-check",
    "--no-first-run",
    "--window-size=1280,900",
    "about:blank",
  ]);

  let browserWs = await waitForDevToolsEndpoint(chrome);
  let client = await createCdpClient(browserWs);
  cdpClient = client;
  let { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  let { sessionId } = await client.send("Target.attachToTarget", {
    flatten: true,
    targetId,
  });

  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await installConsoleCapture(client, sessionId);
  await navigate(client, sessionId, smokeUrl);
  await client.waitForPredicate(
    `customElements.get("live-md-editor") && document.querySelector("live-md-editor")?.view`,
    sessionId,
    20_000,
  );

  await loadReadmeIntoEditor(client, sessionId);
  let baseline = await editorSummary(client, sessionId);
  let results = [];
  for (let edit of readmeSmokeEdits()) {
    results.push(await runReadmeEdit(client, sessionId, edit));
  }

  let browserIssues = await browserIssueSummary(client, sessionId);
  let unstable = results.flatMap((result) =>
    result.issues.map((issue) => `${result.name}: ${issue}`),
  );
  let output = {
    baseline,
    browserIssues,
    readmePath: README_PATH,
    results,
    strict: STRICT,
    url: smokeUrl,
  };
  console.log(JSON.stringify(output, null, 2));

  let hardIssues = [
    ...browserIssues.exceptions.map((issue) => `browser exception: ${issue}`),
    ...browserIssues.consoleErrors.map((issue) => `console error: ${issue}`),
    ...browserIssues.consoleWarnings.map((issue) => `console warning: ${issue}`),
    ...unstable,
  ];
  if (hardIssues.length && STRICT) {
    await client.send("Browser.close").catch(() => {});
    throw new Error(`README edit smoke detected LiveMD instability:\n${hardIssues.join("\n")}`);
  }

  await client.send("Browser.close");
  console.log(`basic-editor README smoke passed at ${smokeUrl}`);
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack : error);
} finally {
  cdpClient?.close();
  if (chrome) await stopProcess(chrome);
  if (server) await stopProcess(server.process);
  if (userDataDir) {
    await rm(userDataDir, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 100,
    });
  }
}

process.exit(exitCode);

function stopProcess(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  killChild(child, "SIGTERM");
  return new Promise((resolve) => {
    let timer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) killChild(child, "SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killChild(child, signal) {
  try {
    if (child.killGroup && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child.
  }
  try {
    child.kill(signal);
  } catch {
    // Process is already gone.
  }
}

function readmeSmokeEdits() {
  return [
    { name: "top heading", needle: "# GroveMd", text: " smoke" },
    {
      name: "opening paragraph typing",
      needle: "Open a local folder in the browser",
      text: " ordinary paragraph smoke",
      typeByCharacter: true,
    },
    { name: "package table", needle: "packages/live-md", text: " smoke" },
    {
      name: "middle paragraph typing",
      needle: "The goal is source-compatible behavior",
      text: " ordinary paragraph smoke",
      typeByCharacter: true,
    },
    { name: "ready command", needle: "vp run ready", text: " smoke" },
    { name: "EOF append", eof: true, text: "\nsmoke eof line" },
  ];
}

async function loadReadmeIntoEditor(client, sessionId) {
  await client.evaluate(
    `
      (async () => {
        let editor = document.querySelector("live-md-editor");
        if (!editor) throw new Error("live-md-editor was not found.");
        await editor.ready;
        document.body.style.caretColor = "transparent";
        let style = document.createElement("style");
        style.textContent = ".cm-cursor,.cm-dropCursor{display:none!important}";
        editor.shadowRoot.append(style);
        editor.value = ${JSON.stringify(readme)};
        editor.setSelectionRange(0, 0);
        editor.focus();
        await new Promise((resolve) => setTimeout(resolve, 900));
      })()
    `,
    sessionId,
  );
}

async function runReadmeEdit(client, sessionId, edit) {
  let position = edit.eof
    ? await client.evaluate(`document.querySelector("live-md-editor").value.length`, sessionId)
    : await client.evaluate(
        `document.querySelector("live-md-editor").value.indexOf(${JSON.stringify(edit.needle)})`,
        sessionId,
      );
  if (position < 0) throw new Error(`README smoke target was not found: ${edit.needle}`);

  await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        editor.setSelectionRange(${position}, ${position});
        editor.focus();
      })()
    `,
    sessionId,
  );
  await wait(300);

  let before = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await client.evaluate(liveMdProbeSource(), sessionId);
  let screenshotSamples = sampleScreenshots(client, sessionId, 10, 70);
  if (edit.typeByCharacter) {
    for (let char of edit.text) {
      await client.send("Input.insertText", { text: char }, sessionId);
      await wait(35);
    }
  } else {
    await client.send("Input.insertText", { text: edit.text }, sessionId);
  }
  let screenshotFrames = [before.data, ...(await screenshotSamples)];
  let screenshotSizes = screenshotFrames.map((frame) => frame.length);
  let screenshotPixelDiffRatios = screenshotDiffRatios(screenshotFrames);
  await wait(300);

  let report = await client.evaluate(`window.__basicEditorReadmeProbe.stop()`, sessionId);
  let valueContainsEdit = await client.evaluate(
    `document.querySelector("live-md-editor").value.includes(${JSON.stringify(edit.text)})`,
    sessionId,
  );
  let issues = instabilityIssues(report, screenshotSizes, screenshotPixelDiffRatios, edit);
  if (!valueContainsEdit) issues.push("inserted text was not reflected in the editor value");

  return {
    issues,
    name: edit.name,
    position,
    report,
    screenshotMaxPixelDiffRatio: Math.max(...screenshotPixelDiffRatios, 0),
    screenshotPixelDiffRatios,
    screenshotSizes,
    screenshotSizeDeltaRatio: screenshotDeltaRatio(screenshotSizes),
  };
}

async function sampleScreenshots(client, sessionId, count, interval) {
  let frames = [];
  for (let index = 0; index < count; index++) {
    await wait(interval);
    let screenshot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
    frames.push(screenshot.data);
  }
  return frames;
}

function instabilityIssues(report, screenshotSizes, screenshotPixelDiffRatios, edit) {
  let issues = [];
  let scrollJump = report.maxScrollTop - report.minScrollTop;
  let contentHeightJump = report.maxContentHeight - report.minContentHeight;
  let screenshotDelta = screenshotDeltaRatio(screenshotSizes);
  let maxPixelDiff = Math.max(...screenshotPixelDiffRatios, 0);
  let styledNodeDelta = report.maxStyledNodes - report.minStyledNodes;
  let expectedDispatches = edit.typeByCharacter ? edit.text.length : 1;
  let extraDispatches = Math.max(0, (report.dispatchSummary?.count ?? 0) - expectedDispatches);
  let effectDispatches = report.dispatchSummary?.withEffects ?? 0;
  let tablePreviewHeightDelta = maxWidgetHeightDelta(report.widgetStats?.tablePreviews);
  let imagePreviewHeightDelta = maxWidgetHeightDelta(report.widgetStats?.imagePreviews);
  let cmGapHeightDelta = maxWidgetHeightDelta(report.widgetStats?.cmGaps);
  let suspiciousCmGapDrift =
    cmGapHeightDelta > 120 &&
    (report.viewportCollapseFrames > 0 ||
      report.viewportChangeCount > 8 ||
      scrollJump > 120 ||
      contentHeightJump > 120);
  if (report.emptyFrames > 0) issues.push(`${report.emptyFrames} empty visible frames`);
  if (report.replacedFrames > 0)
    issues.push(`${report.replacedFrames} frames replaced .cm-content`);
  if (report.suspiciousFrameCount > 0) {
    issues.push(`${report.suspiciousFrameCount} frames lost more than half of visible content`);
  }
  if (report.viewportCollapseFrames > 0) {
    issues.push(`${report.viewportCollapseFrames} frames collapsed to a narrow viewport`);
  }
  if (report.viewportChangeCount > 8) {
    issues.push(`${report.viewportChangeCount} viewport range changes during one edit`);
  }
  if (extraDispatches > 8) {
    issues.push(`${extraDispatches} extra view dispatches during one edit`);
  }
  if (effectDispatches > 8) {
    issues.push(`${effectDispatches} effect dispatches during one edit`);
  }
  if (report.maxClassMutations > 80) {
    issues.push(`${report.maxClassMutations} class mutations during one edit`);
  }
  if (report.maxStyleMutations > 20) {
    issues.push(`${report.maxStyleMutations} style mutations during one edit`);
  }
  if ((report.mutationSummary?.byBucket?.cursor?.style ?? 0) > 20) {
    issues.push(`${report.mutationSummary.byBucket.cursor.style} cursor style mutations`);
  }
  if ((report.mutationSummary?.byBucket?.liveMd?.childList ?? 0) > 40) {
    issues.push(`${report.mutationSummary.byBucket.liveMd.childList} LiveMD child-list mutations`);
  }
  if ((report.mutationSummary?.byBucket?.codeMirrorMeasure?.style ?? 0) > 20) {
    issues.push(
      `${report.mutationSummary.byBucket.codeMirrorMeasure.style} CodeMirror measure style mutations`,
    );
  }
  if (styledNodeDelta > 20) {
    issues.push(`${styledNodeDelta} styled-node delta during one edit`);
  }
  if (report.maxChildListMutations > 450) {
    issues.push(`${report.maxChildListMutations} child-list mutations during one edit`);
  }
  if (scrollJump > 120) issues.push(`${scrollJump}px scroll drift during one edit`);
  if (contentHeightJump > 120) {
    issues.push(`${contentHeightJump}px content-height drift during one edit`);
  }
  if (tablePreviewHeightDelta > 40) {
    issues.push(`${tablePreviewHeightDelta}px table-preview height drift during one edit`);
  }
  if (imagePreviewHeightDelta > 40) {
    issues.push(`${imagePreviewHeightDelta}px image-preview height drift during one edit`);
  }
  if (suspiciousCmGapDrift) {
    issues.push(`${cmGapHeightDelta}px CodeMirror gap height drift during one edit`);
  }
  if (maxPixelDiff > 0.015) {
    issues.push(`${Math.round(maxPixelDiff * 10_000) / 100}% adjacent-frame pixel diff`);
  }
  if (screenshotDelta > 0.08) {
    issues.push(`${Math.round(screenshotDelta * 100)}% screenshot-size delta during one edit`);
  }
  return issues;
}

function maxWidgetHeightDelta(stats) {
  if (!stats) return 0;
  return Math.max(0, (stats.maxTotalHeight ?? 0) - (stats.minTotalHeight ?? 0));
}

function screenshotDeltaRatio(sizes) {
  let min = Math.min(...sizes);
  let max = Math.max(...sizes);
  return max > 0 ? (max - min) / max : 0;
}

function screenshotDiffRatios(frames) {
  let ratios = [];
  for (let index = 1; index < frames.length; index++) {
    let previous = readScreenshot(frames[index - 1]);
    let current = readScreenshot(frames[index]);
    if (previous.width != current.width || previous.height != current.height) {
      ratios.push(1);
      continue;
    }
    let diffPixels = pixelmatch(
      previous.data,
      current.data,
      null,
      previous.width,
      previous.height,
      { threshold: 0.12 },
    );
    ratios.push(diffPixels / (previous.width * previous.height));
  }
  return ratios;
}

function readScreenshot(base64) {
  return PNG.sync.read(Buffer.from(base64, "base64"));
}

function liveMdProbeSource() {
  return `
    (() => {
      let editor = document.querySelector("live-md-editor");
      let root = editor.shadowRoot;
      let view = editor.view;
      let content = root.querySelector(".cm-content");
      let scroller = root.querySelector(".cm-scroller");
      let attributeMutations = 0;
      let classMutations = 0;
      let mutationCount = 0;
      let childListMutations = 0;
      let styleMutations = 0;
      let mutationSummary = {
        byAttribute: Object.create(null),
        byBucket: Object.create(null),
        byType: Object.create(null),
        topTargets: Object.create(null)
      };
      let mutationEvents = [];
      let maxMutationEvents = 240;
      let dispatchEvents = [];
      let maxDispatchEvents = 160;
      let scrollEvents = [];
      let resourceEvents = [];
      let consoleStart = {
        errors: window.__basicEditorReadmeSmokeConsoleErrors?.length ?? 0,
        warnings: window.__basicEditorReadmeSmokeConsoleWarnings?.length ?? 0
      };
      let originalDispatch = view?.dispatch;
      let dispatchPatched = false;

      if (view && typeof originalDispatch == "function") {
        view.dispatch = function(...args) {
          let event = {
            args: args.map(summarizeDispatchArg),
            before: viewSummary(),
            time: performance.now()
          };
          try {
            return originalDispatch.apply(view, args);
          } finally {
            event.after = viewSummary();
            pushLimited(dispatchEvents, event, maxDispatchEvents);
          }
        };
        dispatchPatched = true;
      }

      function recordScroll() {
        pushLimited(scrollEvents, {
          scrollTop: Math.round(scroller?.scrollTop ?? -1),
          time: performance.now(),
          view: viewSummary()
        }, 120);
      }

      function recordResourceEvent(event) {
        let target = event.target;
        let element = target && target.nodeType == Node.ELEMENT_NODE ? target : null;
        pushLimited(resourceEvents, {
          bucket: bucketForTarget(target),
          className: classText(element),
          event: event.type,
          height: Math.round(element?.getBoundingClientRect?.().height ?? -1),
          src: element?.getAttribute?.("src") ?? "",
          time: performance.now()
        }, 80);
      }

      scroller?.addEventListener("scroll", recordScroll, { passive: true });
      root.addEventListener("load", recordResourceEvent, true);
      root.addEventListener("error", recordResourceEvent, true);

      let observer = new MutationObserver((records) => {
        mutationCount += records.length;
        for (let record of records) {
          let bucket = bucketForTarget(record.target);
          let target = targetKey(record.target);
          let eventType = mutationEventType(record);
          bump(mutationSummary.byType, record.type);
          bumpNested(mutationSummary.byBucket, bucket, eventType);
          bump(mutationSummary.topTargets, target);

          if (record.type == "childList") {
            childListMutations++;
          } else if (record.type == "attributes") {
            attributeMutations++;
            bump(mutationSummary.byAttribute, record.attributeName ?? "attribute");
            if (record.attributeName == "class") classMutations++;
            if (record.attributeName == "style") styleMutations++;
          }

          if (mutationEvents.length < maxMutationEvents) {
            mutationEvents.push({
              added: record.type == "childList" ? record.addedNodes.length : 0,
              attribute: record.attributeName ?? null,
              bucket,
              removed: record.type == "childList" ? record.removedNodes.length : 0,
              target,
              time: performance.now(),
              type: record.type
            });
          }
        }
      });
      observer.observe(root, { attributes: true, characterData: true, childList: true, subtree: true });

      let frames = [];
      let stopped = false;
      function sample() {
        let current = root.querySelector(".cm-content");
        let text = current?.innerText ?? "";
        let rect = current?.getBoundingClientRect();
        let lines = Array.from(root.querySelectorAll(".cm-line"));
        let widgets = widgetSummary();
        let metrics = viewSummary();
        let selectionLine = selectionLineSummary();
        frames.push({
          activeSyntax: root.querySelectorAll(".cm-md-syntax-active").length,
          attributeMutations,
          childListMutations,
          classMutations,
          cmLines: lines.length,
          contentHeight: Math.round(rect?.height ?? -1),
          docLength: metrics.docLength,
          docLines: metrics.docLines,
          firstText: lines.slice(0, 3).map((line) => line.textContent).join(" | ").slice(0, 120),
          height: Math.round(rect?.height ?? -1),
          hiddenSyntax: root.querySelectorAll(".cm-md-syntax-hidden").length,
          mutationCount,
          sameContent: current === content,
          scrollTop: Math.round(scroller?.scrollTop ?? -1),
          selectionLine,
          styledNodes: root.querySelectorAll('[class*="cm-md-"]').length,
          styleMutations,
          tablePreviews: root.querySelectorAll(".cm-md-table-preview").length,
          taskToggles: root.querySelectorAll(".cm-md-task-toggle").length,
          textLength: text.length,
          time: performance.now(),
          view: metrics,
          widgets
        });
        if (!stopped) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);

      window.__basicEditorReadmeProbe = {
        stop() {
          stopped = true;
          observer.disconnect();
          if (dispatchPatched) view.dispatch = originalDispatch;
          scroller?.removeEventListener("scroll", recordScroll);
          root.removeEventListener("load", recordResourceEvent, true);
          root.removeEventListener("error", recordResourceEvent, true);
          let first = frames[0] ?? { cmLines: 0, height: 0, scrollTop: 0, textLength: 0 };
          let lineCounts = frames.map((frame) => frame.cmLines);
          let contentHeights = frames.map((frame) => frame.contentHeight);
          let styledNodeCounts = frames.map((frame) => frame.styledNodes);
          let textLengths = frames.map((frame) => frame.textLength);
          let heights = frames.map((frame) => frame.height);
          let scrollTops = frames.map((frame) => frame.scrollTop);
          let suspiciousFrames = frames.filter((frame, index) => index > 0 && (
            frame.cmLines == 0 ||
            frame.textLength < first.textLength * 0.5 ||
            frame.cmLines < first.cmLines * 0.5 ||
            !frame.sameContent
          ));
          let viewportCollapseFrames = frames.filter((frame, index) => {
            if (index == 0) return false;
            let firstSpan = first.view?.visibleSpan ?? first.textLength;
            let span = frame.view?.visibleSpan ?? frame.textLength;
            return span < Math.max(64, firstSpan * 0.25) || frame.cmLines < first.cmLines * 0.5;
          });
          let viewportChangeCount = countFrameChanges(frames, (frame) => frame.view?.visibleRangesKey ?? "");
          let widgetStats = {
            blockSeparators: widgetGroupStats(frames, "blockSeparators"),
            cmGaps: widgetGroupStats(frames, "cmGaps"),
            imagePreviews: widgetGroupStats(frames, "imagePreviews"),
            latexDisplays: widgetGroupStats(frames, "latexDisplays"),
            mermaids: widgetGroupStats(frames, "mermaids"),
            tablePreviews: widgetGroupStats(frames, "tablePreviews")
          };
          let interestingFrames = uniqueFrames([
            first,
            frames.at(-1),
            ...suspiciousFrames,
            ...viewportCollapseFrames,
            frameWithMin(frames, (frame) => frame.cmLines),
            frameWithMax(frames, (frame) => frame.scrollTop),
            frameWithMin(frames, (frame) => frame.scrollTop),
            frameWithMax(frames, (frame) => frame.contentHeight),
            frameWithMin(frames, (frame) => frame.contentHeight),
            frameWithMax(frames, (frame) => frame.styledNodes),
            frameWithMin(frames, (frame) => frame.styledNodes)
          ]).slice(0, 24);
          let dispatchSummary = summarizeDispatches(dispatchEvents);
          let problemTags = problemTagsFor({
            cmGapHeightDelta: widgetHeightDelta(widgetStats.cmGaps),
            contentHeightDelta: Math.max(...contentHeights) - Math.min(...contentHeights),
            effectDispatchCount: dispatchSummary.withEffects,
            imagePreviewHeightDelta: widgetHeightDelta(widgetStats.imagePreviews),
            replacedFrames: frames.filter((frame) => !frame.sameContent).length,
            scrollDelta: Math.max(...scrollTops) - Math.min(...scrollTops),
            suspiciousFrameCount: suspiciousFrames.length,
            tablePreviewHeightDelta: widgetHeightDelta(widgetStats.tablePreviews),
            viewportChangeCount,
            viewportCollapseFrameCount: viewportCollapseFrames.length
          });
          return {
            consoleDelta: {
              errors:
                (window.__basicEditorReadmeSmokeConsoleErrors?.length ?? 0) - consoleStart.errors,
              warnings:
                (window.__basicEditorReadmeSmokeConsoleWarnings?.length ?? 0) -
                consoleStart.warnings
            },
            dispatchEvents,
            dispatchSummary,
            emptyFrames: frames.filter((frame) => frame.cmLines == 0 || frame.textLength == 0).length,
            frameSamples: interestingFrames.map(compactFrame),
            firstFrame: first,
            frameCount: frames.length,
            lastFrame: frames.at(-1) ?? null,
            maxAttributeMutations: Math.max(...frames.map((frame) => frame.attributeMutations), 0),
            maxChildListMutations: Math.max(...frames.map((frame) => frame.childListMutations), 0),
            maxClassMutations: Math.max(...frames.map((frame) => frame.classMutations), 0),
            maxContentHeight: Math.max(...contentHeights),
            maxHeight: Math.max(...heights),
            maxLines: Math.max(...lineCounts),
            maxMutations: Math.max(...frames.map((frame) => frame.mutationCount), 0),
            maxScrollTop: Math.max(...scrollTops),
            maxStyleMutations: Math.max(...frames.map((frame) => frame.styleMutations), 0),
            maxStyledNodes: Math.max(...styledNodeCounts),
            maxTextLength: Math.max(...textLengths),
            minContentHeight: Math.min(...contentHeights),
            minHeight: Math.min(...heights),
            minLines: Math.min(...lineCounts),
            minScrollTop: Math.min(...scrollTops),
            minStyledNodes: Math.min(...styledNodeCounts),
            minTextLength: Math.min(...textLengths),
            mutationEvents,
            mutationSummary: {
              byAttribute: plainObject(mutationSummary.byAttribute),
              byBucket: plainNestedObject(mutationSummary.byBucket),
              byType: plainObject(mutationSummary.byType),
              topTargets: topEntries(mutationSummary.topTargets, 16)
            },
            problemTags,
            replacedFrames: frames.filter((frame) => !frame.sameContent).length,
            resourceEvents,
            scrollEvents,
            suspiciousFrameCount: suspiciousFrames.length,
            suspiciousFrames: suspiciousFrames.slice(0, 8).map(compactFrame),
            viewportChangeCount,
            viewportCollapseFrames: viewportCollapseFrames.length,
            viewportCollapseSamples: viewportCollapseFrames.slice(0, 8).map(compactFrame),
            widgetStats
          };
        }
      };

      function viewSummary() {
        if (!view) return null;
        let state = view.state;
        let selection = state.selection.main;
        let visibleRanges = (view.visibleRanges ?? []).map((range) => rangeWithLines(range));
        let viewport = rangeWithLines(view.viewport);
        let visibleSpan = visibleRanges.reduce((total, range) => total + Math.max(0, range.to - range.from), 0);
        return {
          clientHeight: Math.round(view.scrollDOM?.clientHeight ?? -1),
          contentHeight: Math.round(root.querySelector(".cm-content")?.getBoundingClientRect?.().height ?? -1),
          docLength: state.doc.length,
          docLines: state.doc.lines,
          scrollHeight: Math.round(view.scrollDOM?.scrollHeight ?? -1),
          scrollTop: Math.round(view.scrollDOM?.scrollTop ?? -1),
          selection: {
            anchor: selection.anchor,
            empty: selection.empty,
            from: selection.from,
            head: selection.head,
            line: lineNumberAt(selection.head),
            to: selection.to
          },
          selectionCoveredByVisibleRanges: visibleRanges.some((range) => range.from <= selection.head && selection.head <= range.to),
          viewport,
          visibleRanges,
          visibleRangesKey: visibleRanges.map((range) => range.from + "-" + range.to).join(","),
          visibleSpan
        };
      }

      function rangeWithLines(range) {
        let from = clampPosition(range?.from ?? 0);
        let to = clampPosition(range?.to ?? from);
        return {
          from,
          fromLine: lineNumberAt(from),
          to,
          toLine: lineNumberAt(to)
        };
      }

      function lineNumberAt(position) {
        if (!view) return -1;
        let doc = view.state.doc;
        return doc.lineAt(clampPosition(position)).number;
      }

      function clampPosition(position) {
        if (!view) return 0;
        return Math.max(0, Math.min(view.state.doc.length, position));
      }

      function selectionLineSummary() {
        if (!view) return null;
        let selection = view.state.selection.main;
        let docLine = view.state.doc.lineAt(selection.head);
        let domLine = null;
        try {
          let dom = view.domAtPos(selection.head);
          let node = dom.node.nodeType == Node.TEXT_NODE ? dom.node.parentElement : dom.node;
          domLine = node?.closest?.(".cm-line") ?? null;
        } catch {
          domLine = null;
        }
        let rect = domLine?.getBoundingClientRect?.();
        return {
          className: classText(domLine),
          docLine: docLine.number,
          domText: domLine?.textContent?.slice(0, 120) ?? "",
          height: Math.round(rect?.height ?? -1),
          text: docLine.text.slice(0, 120),
          top: Math.round(rect?.top ?? -1)
        };
      }

      function widgetSummary() {
        return {
          blockSeparators: summarizeElements(".cm-md-block-separator,.cm-md-block-separator-fill"),
          cmGaps: summarizeElements(".cm-gap"),
          imagePreviews: summarizeElements(".cm-md-image-preview"),
          latexDisplays: summarizeElements(".cm-md-latex-display"),
          mermaids: summarizeElements(".cm-md-mermaid"),
          tablePreviews: summarizeElements(".cm-md-table-preview")
        };
      }

      function summarizeElements(selector) {
        let elements = Array.from(root.querySelectorAll(selector));
        let samples = elements.slice(0, 4).map((element) => {
          let rect = element.getBoundingClientRect();
          return {
            bottom: Math.round(rect.bottom),
            className: classText(element),
            height: Math.round(rect.height),
            text: normalizeText(element.textContent).slice(0, 100),
            top: Math.round(rect.top),
            width: Math.round(rect.width)
          };
        });
        let totalHeight = elements.reduce((total, element) => total + element.getBoundingClientRect().height, 0);
        return {
          count: elements.length,
          maxHeight: Math.round(Math.max(0, ...elements.map((element) => element.getBoundingClientRect().height))),
          samples,
          totalHeight: Math.round(totalHeight)
        };
      }

      function summarizeDispatchArg(arg) {
        if (!arg || typeof arg != "object") return { type: typeof arg };
        let effects = [];
        let rawEffects = Array.isArray(arg.effects) ? arg.effects : arg.effects ? [arg.effects] : [];
        for (let effect of rawEffects) {
          effects.push({
            hasValue: "value" in effect,
            valueType: typeof effect.value
          });
        }
        return {
          docChanged: Boolean(arg.docChanged),
          effectCount: rawEffects.length,
          effects,
          hasChanges: Boolean(arg.changes),
          hasSelection: Boolean(arg.selection),
          scrollIntoView: Boolean(arg.scrollIntoView),
          userEvent: arg.userEvent ?? null
        };
      }

      function summarizeDispatches(events) {
        let byUserEvent = Object.create(null);
        let withChanges = 0;
        let withEffects = 0;
        let withScrollIntoView = 0;
        let selectionOnly = 0;
        for (let event of events) {
          for (let arg of event.args) {
            bump(byUserEvent, arg.userEvent ?? "(none)");
            if (arg.docChanged || arg.hasChanges) withChanges++;
            if (arg.effectCount) withEffects++;
            if (arg.scrollIntoView) withScrollIntoView++;
            if (arg.hasSelection && !arg.docChanged && !arg.hasChanges) selectionOnly++;
          }
        }
        return {
          byUserEvent: plainObject(byUserEvent),
          count: events.length,
          selectionOnly,
          withChanges,
          withEffects,
          withScrollIntoView
        };
      }

      function mutationEventType(record) {
        if (record.type == "attributes") return record.attributeName ?? "attribute";
        return record.type;
      }

      function bucketForTarget(target) {
        let element = elementForNode(target);
        if (!element) return "unknown";
        if (element.closest(".cm-cursorLayer,.cm-cursor,.cm-dropCursor")) return "cursor";
        if (element.closest(".cm-measure,.cm-lineMeasure,.cm-tooltip-measure")) return "codeMirrorMeasure";
        if (element.closest(".cm-gap")) return "codeMirrorGap";
        if (element.closest(".cm-md-table-preview")) return "liveMdTablePreview";
        if (element.closest(".cm-md-image-preview")) return "liveMdImagePreview";
        if (element.closest(".cm-md-mermaid")) return "liveMdMermaid";
        if (element.closest(".cm-md-latex")) return "liveMdLatex";
        if (element.closest("[class*='cm-md-']")) return "liveMd";
        if (element.closest(".cm-line")) return "codeMirrorLine";
        if (element.closest(".cm-content")) return "codeMirrorContent";
        if (element.closest(".cm-scroller")) return "codeMirrorScroller";
        if (element.closest(".cm-editor")) return "codeMirrorOther";
        return "outsideEditor";
      }

      function targetKey(target) {
        let element = elementForNode(target);
        if (!element) return "unknown";
        let classes = classText(element).split(/\\s+/).filter(Boolean).slice(0, 5).join(".");
        return element.localName + (classes ? "." + classes : "");
      }

      function elementForNode(node) {
        if (!node) return null;
        if (node.nodeType == Node.ELEMENT_NODE) return node;
        if (node.nodeType == Node.TEXT_NODE || node.nodeType == Node.COMMENT_NODE) return node.parentElement;
        return null;
      }

      function classText(element) {
        if (!element) return "";
        let className = element.className;
        if (typeof className == "string") return className;
        return className?.baseVal ?? "";
      }

      function normalizeText(text) {
        return (text ?? "").replace(/\\s+/g, " ").trim();
      }

      function countFrameChanges(items, keyOf) {
        let changes = 0;
        let previous = null;
        for (let item of items) {
          let key = keyOf(item);
          if (previous != null && key != previous) changes++;
          previous = key;
        }
        return changes;
      }

      function widgetGroupStats(items, name) {
        let values = items.map((frame) => frame.widgets?.[name] ?? { count: 0, maxHeight: 0, totalHeight: 0 });
        return {
          maxCount: Math.max(...values.map((value) => value.count), 0),
          maxHeight: Math.max(...values.map((value) => value.maxHeight), 0),
          maxTotalHeight: Math.max(...values.map((value) => value.totalHeight), 0),
          minCount: Math.min(...values.map((value) => value.count), 0),
          minHeight: Math.min(...values.map((value) => value.maxHeight), 0),
          minTotalHeight: Math.min(...values.map((value) => value.totalHeight), 0),
          samples: values.find((value) => value.samples?.length)?.samples ?? []
        };
      }

      function widgetHeightDelta(stats) {
        return Math.max(0, (stats?.maxTotalHeight ?? 0) - (stats?.minTotalHeight ?? 0));
      }

      function frameWithMin(items, valueOf) {
        return items.reduce((best, item) => valueOf(item) < valueOf(best) ? item : best, items[0]);
      }

      function frameWithMax(items, valueOf) {
        return items.reduce((best, item) => valueOf(item) > valueOf(best) ? item : best, items[0]);
      }

      function uniqueFrames(items) {
        let seen = new Set();
        let output = [];
        for (let item of items) {
          if (!item) continue;
          let key = item.time + ":" + item.cmLines + ":" + item.scrollTop + ":" + item.textLength;
          if (seen.has(key)) continue;
          seen.add(key);
          output.push(item);
        }
        return output;
      }

      function compactFrame(frame) {
        return {
          activeSyntax: frame.activeSyntax,
          childListMutations: frame.childListMutations,
          classMutations: frame.classMutations,
          cmLines: frame.cmLines,
          contentHeight: frame.contentHeight,
          firstText: frame.firstText,
          hiddenSyntax: frame.hiddenSyntax,
          mutationCount: frame.mutationCount,
          sameContent: frame.sameContent,
          scrollTop: frame.scrollTop,
          selectionLine: frame.selectionLine,
          styledNodes: frame.styledNodes,
          styleMutations: frame.styleMutations,
          textLength: frame.textLength,
          time: Math.round(frame.time),
          view: frame.view,
          widgets: frame.widgets
        };
      }

      function problemTagsFor(values) {
        let tags = [];
        if (values.suspiciousFrameCount) tags.push("visible-content-loss");
        if (values.viewportCollapseFrameCount) tags.push("viewport-collapse");
        if (values.viewportChangeCount > 8) tags.push("viewport-feedback");
        if (values.effectDispatchCount > 8) tags.push("effect-dispatch-churn");
        if (values.replacedFrames) tags.push("content-dom-replaced");
        if (values.scrollDelta > 120) tags.push("scroll-drift");
        if (values.contentHeightDelta > 120) tags.push("content-height-drift");
        if (values.tablePreviewHeightDelta > 40) tags.push("table-height-drift");
        if (values.imagePreviewHeightDelta > 40) tags.push("image-height-drift");
        if (
          values.cmGapHeightDelta > 120 &&
          (values.viewportCollapseFrameCount ||
            values.viewportChangeCount > 8 ||
            values.scrollDelta > 120 ||
            values.contentHeightDelta > 120)
        ) {
          tags.push("codemirror-gap-drift");
        }
        return tags;
      }

      function bump(object, key, amount = 1) {
        object[key] = (object[key] ?? 0) + amount;
      }

      function bumpNested(object, outer, inner, amount = 1) {
        object[outer] ??= Object.create(null);
        bump(object[outer], inner, amount);
      }

      function plainObject(object) {
        return Object.fromEntries(Object.entries(object));
      }

      function plainNestedObject(object) {
        return Object.fromEntries(
          Object.entries(object).map(([key, value]) => [key, plainObject(value)])
        );
      }

      function topEntries(object, limit) {
        return Object.entries(object)
          .sort((left, right) => right[1] - left[1])
          .slice(0, limit)
          .map(([key, count]) => ({ key, count }));
      }

      function pushLimited(items, item, limit) {
        if (items.length < limit) items.push(item);
      }
    })()
  `;
}

async function editorSummary(client, sessionId) {
  return client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        let root = editor.shadowRoot;
        let content = root.querySelector(".cm-content");
        return {
          cmLines: root.querySelectorAll(".cm-line").length,
          contentHeight: Math.round(content?.getBoundingClientRect().height ?? -1),
          docLines: editor.view.state.doc.lines,
          tablePreviews: root.querySelectorAll(".cm-md-table-preview").length,
          taskToggles: root.querySelectorAll(".cm-md-task-toggle").length,
          textLength: content?.innerText.length ?? -1,
          valueLength: editor.value.length
        };
      })()
    `,
    sessionId,
  );
}

async function installConsoleCapture(client, sessionId) {
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        (() => {
          window.__basicEditorReadmeSmokeConsoleErrors = [];
          window.__basicEditorReadmeSmokeConsoleWarnings = [];
          let originalError = console.error;
          let originalWarn = console.warn;
          console.error = (...args) => {
            window.__basicEditorReadmeSmokeConsoleErrors.push(args.map(String).join(" "));
            originalError.apply(console, args);
          };
          console.warn = (...args) => {
            window.__basicEditorReadmeSmokeConsoleWarnings.push(args.map(String).join(" "));
            originalWarn.apply(console, args);
          };
        })();
      `,
    },
    sessionId,
  );
}

async function browserIssueSummary(client, sessionId) {
  let consoleErrors = await client.evaluate(
    `window.__basicEditorReadmeSmokeConsoleErrors ?? []`,
    sessionId,
  );
  let consoleWarnings = await client.evaluate(
    `window.__basicEditorReadmeSmokeConsoleWarnings ?? []`,
    sessionId,
  );
  let exceptions = client
    .takeEvents("Runtime.exceptionThrown", sessionId)
    .map((event) => event.params?.exceptionDetails?.exception?.description ?? event.params?.text)
    .filter(Boolean);
  return { consoleErrors, consoleWarnings, exceptions };
}

async function startBasicEditorServer() {
  let port = process.env.BASIC_EDITOR_SMOKE_PORT
    ? Number(process.env.BASIC_EDITOR_SMOKE_PORT)
    : Number(await findOpenPort());
  let child = execFile("vp", ["dev", "--", "--host", HOST, "--port", String(port)], {
    cwd: appRoot,
    detached: true,
  });
  child.killGroup = true;
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  child.on("exit", (code) => {
    if (code) output += `\nbasic-editor dev server exited with code ${code}`;
  });

  let url = `http://${HOST}:${port}/`;
  try {
    await waitForHttp(url, 30_000);
  } catch (error) {
    killChild(child, "SIGTERM");
    throw new Error(`${error.message}\n\nbasic-editor server output:\n${output}`);
  }
  return { process: child, url };
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    let server = createServer();
    server.listen(0, HOST, () => {
      let address = server.address();
      let port = typeof address == "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("Could not allocate port."))));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url, timeout) {
  let started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      let response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function navigate(client, sessionId, url) {
  await client.send("Page.navigate", { url }, sessionId);
  await client.waitForEvent("Page.loadEventFired", sessionId);
  await wait(500);
}

async function createCdpClient(browserWs) {
  let ws = new WebSocket(browserWs);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let events = [];
  let nextId = 1;
  let pending = new Map();

  ws.addEventListener("message", (event) => {
    let message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      let { reject, resolve } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });

  return {
    close() {
      ws.close();
    },
    evaluate(expression, sessionId) {
      return this.send(
        "Runtime.evaluate",
        {
          awaitPromise: true,
          expression,
          returnByValue: true,
        },
        sessionId,
      ).then((result) => {
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ||
              result.exceptionDetails.exception?.value ||
              result.exceptionDetails.text ||
              "Runtime evaluation failed.",
          );
        }
        return result.result.value;
      });
    },
    send(method, params = {}, sessionId) {
      let id = nextId++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { reject, resolve }));
    },
    takeEvents(method, sessionId) {
      let taken = [];
      events = events.filter((event) => {
        if (event.method != method || (sessionId && event.sessionId != sessionId)) return true;
        taken.push(event);
        return false;
      });
      return taken;
    },
    waitForEvent(method, sessionId, timeout = 10_000) {
      return new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for ${method}.`));
        }, timeout);
        let interval = setInterval(() => {
          let index = events.findIndex(
            (event) => event.method == method && (!sessionId || event.sessionId == sessionId),
          );
          if (index == -1) return;
          clearInterval(interval);
          clearTimeout(timer);
          resolve(events.splice(index, 1)[0]);
        }, 25);
      });
    },
    async waitForPredicate(expression, sessionId, timeout = 10_000) {
      let started = Date.now();
      while (Date.now() - started < timeout) {
        if (await this.evaluate(`Boolean(${expression})`, sessionId)) return;
        await wait(50);
      }
      throw new Error(`Timed out waiting for predicate: ${expression}`);
    },
  };
}

function waitForDevToolsEndpoint(child) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error("Timed out waiting for Chromium.")), 10_000);
    child.stderr.on("data", (chunk) => {
      let match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.on("exit", (code) => {
      reject(new Error(`Chromium exited before DevTools was ready: ${code}`));
    });
  });
}

function findChromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  for (let candidate of chromePathCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function chromePathCandidates() {
  let home = homedir();
  let candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  let cacheRoot = join(home, "Library/Caches/ms-playwright");
  for (let entry of newestPlaywrightCacheEntries(cacheRoot, "chromium-")) {
    candidates.push(
      join(
        cacheRoot,
        entry,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
    );
  }
  for (let entry of newestPlaywrightCacheEntries(cacheRoot, "chromium_headless_shell-")) {
    candidates.push(
      join(cacheRoot, entry, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    );
  }

  return candidates;
}

function newestPlaywrightCacheEntries(cacheRoot, prefix) {
  try {
    return readdirSync(cacheRoot)
      .filter((entry) => entry.startsWith(prefix))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
