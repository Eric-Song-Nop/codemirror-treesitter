export type LiveMdFeature<Context, Node extends { name: string }> = {
  enter?: (context: Context, node: Node) => false | void;
  nodes: readonly string[];
};

export type LiveMdFeatureRegistry<Context, Node extends { name: string }> = {
  enter: (context: Context, node: Node) => false | void;
};

export function createLiveMdFeatureRegistry<Context, Node extends { name: string }>(
  features: readonly LiveMdFeature<Context, Node>[],
): LiveMdFeatureRegistry<Context, Node> {
  let byNode = new Map<string, LiveMdFeature<Context, Node>[]>();
  for (let feature of features) {
    for (let node of feature.nodes) {
      let nodeFeatures = byNode.get(node);
      if (nodeFeatures) nodeFeatures.push(feature);
      else byNode.set(node, [feature]);
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
  };
}

export const __testCreateLiveMdFeatureRegistry = createLiveMdFeatureRegistry;
