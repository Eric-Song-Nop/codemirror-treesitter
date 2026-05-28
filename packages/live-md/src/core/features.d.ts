export type LiveMdScope = "block" | "container" | "document" | "line" | "node";
export type LiveMdFeature<Context, Node extends {
    name: string;
}> = {
    enter?: (context: Context, node: Node) => false | void;
    invalidatedBy?: readonly string[];
    nodes: readonly string[];
    scope?: LiveMdScope;
};
export type LiveMdFeatureRegistry<Context, Node extends {
    name: string;
}> = {
    enter: (context: Context, node: Node) => false | void;
    hasNode: (nodeName: string) => boolean;
    invalidatedNodes: (invalidation: string) => readonly string[];
    scopeFor: (nodeName: string) => LiveMdScope;
};
export declare function createLiveMdFeatureRegistry<Context, Node extends {
    name: string;
}>(features: readonly LiveMdFeature<Context, Node>[]): LiveMdFeatureRegistry<Context, Node>;
export declare const __testCreateLiveMdFeatureRegistry: typeof createLiveMdFeatureRegistry;
