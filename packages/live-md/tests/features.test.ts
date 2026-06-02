import { describe, expect, it } from "vite-plus/test";
import { __testCreateLiveMdFeatureRegistry, type LiveMdFeature } from "../src/core/features.js";

type TestContext = {
  calls: string[];
};

type TestNode = {
  name: string;
};

describe("LiveMD feature registry", () => {
  it("dispatches matching node visitors in declaration order", () => {
    let features: LiveMdFeature<TestContext, TestNode>[] = [
      feature("heading", "first"),
      feature("paragraph", "ignored"),
      feature("heading", "second"),
    ];
    let registry = __testCreateLiveMdFeatureRegistry(features);
    let context = { calls: [] };

    registry.enter(context, { name: "heading" });

    expect(context.calls).toEqual(["first", "second"]);
  });

  it("runs all matching visitors before stopping child traversal", () => {
    let features: LiveMdFeature<TestContext, TestNode>[] = [
      feature("table", "decorate"),
      feature("table", "replace", false),
      feature("table", "after"),
    ];
    let registry = __testCreateLiveMdFeatureRegistry(features);
    let context = { calls: [] };

    expect(registry.enter(context, { name: "table" })).toBe(false);
    expect(context.calls).toEqual(["decorate", "replace", "after"]);
  });

  it("ignores nodes without registered visitors", () => {
    let registry = __testCreateLiveMdFeatureRegistry<TestContext, TestNode>([
      feature("image", "preview"),
    ]);
    let context = { calls: [] };

    registry.enter(context, { name: "paragraph" });

    expect(context.calls).toEqual([]);
  });
});

function feature(
  nodeName: string,
  label: string,
  result?: false | void,
): LiveMdFeature<TestContext, TestNode> {
  return {
    nodes: [nodeName],
    enter(context) {
      context.calls.push(label);
      return result;
    },
  };
}
