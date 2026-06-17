import { describe, expect, it } from "vite-plus/test";
import { isWorkspaceWriteConflictError } from "./workspace-file-conflict.ts";

describe("workspace write conflict errors", () => {
  it("classifies Dropbox-style write conflicts as save conflicts", () => {
    expect(
      isWorkspaceWriteConflictError(
        new Error("POST https://content.dropboxapi.com/2/files/upload 409 Conflict"),
      ),
    ).toBe(true);
  });

  it("does not classify missing Dropbox paths as save conflicts", () => {
    expect(
      isWorkspaceWriteConflictError(
        new Error("OpenDAL Dropbox API error 409 Conflict: path/not_found"),
      ),
    ).toBe(false);
  });

  it("classifies OneDrive precondition failures as save conflicts", () => {
    expect(isWorkspaceWriteConflictError(new Error("412 Precondition Failed"))).toBe(true);
    expect(isWorkspaceWriteConflictError(new Error("ConditionNotMatch at write"))).toBe(true);
  });
});
