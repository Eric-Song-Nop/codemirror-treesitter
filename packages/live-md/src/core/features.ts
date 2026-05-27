export type LiveMdScope = "block" | "container" | "document" | "line" | "node";

export type LiveMdFeature<Context, Node extends { name: string }> = {
  enter?: (context: Context, node: Node) => false | void;
  nodes: readonly string[];
  scope?: LiveMdScope;
};

export type LiveMdFeatureRegistry<Context, Node extends { name: string }> = {
  enter: (context: Context, node: Node) => false | void;
  scopeFor: (nodeName: string) => LiveMdScope;
};

export function createLiveMdFeatureRegistry<Context, Node extends { name: string }>(
  features: readonly LiveMdFeature<Context, Node>[],
): LiveMdFeatureRegistry<Context, Node> {
  let byNode = new Map<string, LiveMdFeature<Context, Node>[]>();
  let scopes = new Map<string, LiveMdScope>();
  for (let feature of features) {
    for (let node of feature.nodes) {
      let nodeFeatures = byNode.get(node);
      if (nodeFeatures) nodeFeatures.push(feature);
      else byNode.set(node, [feature]);
      let scope = feature.scope ?? "node";
      let previousScope = scopes.get(node);
      scopes.set(node, previousScope ? widerScope(previousScope, scope) : scope);
    }
  }

  return {
    enter(context, node) {
      let stopped = false;
      for (let feature of byNode.get(node.name) ?? []) {
        if (feature.enter?.(context, node) === false) stopped = true;
      }
      return stopped ? false : undefined;
    },
    scopeFor(nodeName) {
      return scopes.get(nodeName) ?? "node";
    },
  };
}

export const __testCreateLiveMdFeatureRegistry = createLiveMdFeatureRegistry;

const scopeOrder: readonly LiveMdScope[] = ["line", "node", "block", "container", "document"];

function widerScope(left: LiveMdScope, right: LiveMdScope) {
  return scopeOrder.indexOf(left) >= scopeOrder.indexOf(right) ? left : right;
}
