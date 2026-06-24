export {
  createLeafAnalysisCache,
  createLeafAnalysisCacheFromRangeSets,
  emptyLeafAnalysisCacheTrace,
  leafAnalysisCacheNextId,
  leafAnalysisCacheRecordCount,
  type LeafAnalysisCache,
  type LeafAnalysisCacheLocalTransitionInput,
  type LeafAnalysisCacheTrace,
  type LeafAnalysisCacheTransition,
  type LeafAnalysisCacheTraceCounters,
  type LiveMdSemanticState,
} from "./cache/cache.js";
export { materializeLeafAnalysisCacheRecords } from "./cache/oracle.js";
export {
  findLeafAnalysisRecordsTouchingRanges,
  forEachLeafAnalysisCacheRecord,
  forEachLeafAnalysisCacheRecordTouchingRanges,
  leafAnalysisCacheRangesInDoc,
} from "./cache/query.js";
export {
  buildFreshLeafAnalysisCache,
  transitionLeafAnalysisCache,
} from "./cache/transition-full.js";
export { transitionLeafAnalysisCacheLocal } from "./cache/transition-local.js";
