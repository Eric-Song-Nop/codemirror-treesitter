import { commitLiveMdLoroExternalEdit } from "@codemirror-treesitter/live-md-loro";
import { LoroDoc, UndoManager } from "loro-crdt";
import { describe, expect, it } from "vite-plus/test";
import { createUserUndoManager, LOCAL_MD_EXTERNAL_SOURCE_ORIGIN } from "./undo-origins.ts";

describe("createUserUndoManager", () => {
  it("does not record Agent/external-origin commits as user undo steps", () => {
    let doc = new LoroDoc();
    let undo = createUserUndoManager(doc);
    let text = doc.getText("markdown");
    try {
      text.insert(0, "agent");
      commitLiveMdLoroExternalEdit(doc);
      expect(undo.canUndo()).toBe(false);
      expect(undo.undo()).toBe(false);
      expect(text.toString()).toBe("agent");

      text.insert(0, "source ");
      doc.commit({ origin: LOCAL_MD_EXTERNAL_SOURCE_ORIGIN });
      expect(undo.canUndo()).toBe(false);

      text.insert(text.length, " user");
      doc.commit();
      expect(undo.canUndo()).toBe(true);
      expect(undo.undo()).toBe(true);
      expect(text.toString()).toBe("source agent");
    } finally {
      text.free();
      undo.free();
      doc.free();
    }
  });

  it("differs from an UndoManager without origin exclusions", () => {
    let doc = new LoroDoc();
    let undo = new UndoManager(doc, {});
    let text = doc.getText("markdown");
    try {
      text.insert(0, "agent");
      commitLiveMdLoroExternalEdit(doc);
      expect(undo.canUndo()).toBe(true);
    } finally {
      text.free();
      undo.free();
      doc.free();
    }
  });
});
