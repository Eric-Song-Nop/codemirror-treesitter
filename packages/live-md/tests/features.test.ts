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

  it("exposes node scopes for dirty range expansion", () => {
    let registry = __testCreateLiveMdFeatureRegistry<TestContext, TestNode>([
      { nodes: ["image"], scope: "line" },
      { nodes: ["fenced_code_block"], scope: "node" },
      { nodes: ["pipe_table"], scope: "node" },
    ]);

    expect(registry.scopeFor("image")).toBe("line");
    expect(registry.scopeFor("fenced_code_block")).toBe("node");
    expect(registry.scopeFor("unknown")).toBe("node");
    expect(registry.hasNode("image")).toBe(true);
    expect(registry.hasNode("unknown")).toBe(false);
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
