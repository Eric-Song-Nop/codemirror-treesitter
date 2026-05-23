export { Change, diff, presentableDiff } from "./diff.js";
export type { DiffConfig } from "./diff.js";

export { getChunks, goToNextChunk, goToPreviousChunk } from "./merge.js";

export { MergeView } from "./mergeview.js";
export type { DirectMergeConfig, MergeConfig } from "./mergeview.js";

export {
  unifiedMergeView,
  acceptChunk,
  rejectChunk,
  getOriginalDoc,
  originalDocChangeEffect,
  updateOriginalDoc,
} from "./unified.js";

export { uncollapseUnchanged, mergeViewSiblings } from "./deco.js";

export { Chunk } from "./chunk.js";
