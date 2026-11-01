import { UndoManager, type LoroDoc } from "loro-crdt";

/**
 * Loro commit origins written by non-user actors. `live-md:external-edit` is
 * the origin `commitLiveMdLoroExternalEdit` uses for programmatic edits such
 * as Agent writes and reverts; `local-md:external-source` marks whole-text
 * replacements adopted from the filesystem during recovery.
 */
export const LIVE_MD_EXTERNAL_EDIT_ORIGIN = "live-md:external-edit";
export const LOCAL_MD_EXTERNAL_SOURCE_ORIGIN = "local-md:external-source";

export const NON_USER_UNDO_ORIGIN_PREFIXES: readonly string[] = Object.freeze([
  LIVE_MD_EXTERNAL_EDIT_ORIGIN,
  LOCAL_MD_EXTERNAL_SOURCE_ORIGIN,
]);

/** Creates an UndoManager that records only user-originated local edits. */
export function createUserUndoManager(doc: LoroDoc) {
  return new UndoManager(doc, { excludeOriginPrefixes: [...NON_USER_UNDO_ORIGIN_PREFIXES] });
}
