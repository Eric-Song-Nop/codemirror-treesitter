import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMemoryWorkspaceRuntime } from "@/test/memory-workspace-runtime";
import { CloudWorkspaceStorage, type CloudWorkspaceInput } from "../../runtime/cloud-runtime.ts";

const oauth = vi.hoisted(() => ({
  authorize: vi.fn(),
  identity: vi.fn(),
}));

vi.mock("./oauth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth.ts")>()),
  authorizeDropboxWithPkce: oauth.authorize,
  fetchDropboxAccountIdentity: oauth.identity,
}));

import { DropboxWorkspaces } from "./dropbox-workspaces.ts";

describe("DropboxWorkspaces", () => {
  it("runs one authorization for concurrent opens and reuses its token", async () => {
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    oauth.authorize
      .mockReset()
      .mockImplementation(() =>
        Effect.promise(() => gate).pipe(Effect.as(token("token-1", "dbid:a"))),
      );
    let { opened, runtime } = createRuntime();

    let first = runtime.runPromise(Effect.scoped(openDropbox()));
    let second = runtime.runPromise(Effect.scoped(openDropbox()));
    await vi.waitFor(() => expect(oauth.authorize).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);

    expect(oauth.authorize).toHaveBeenCalledOnce();
    expect(opened.map((input) => input.source)).toEqual([
      { accessToken: "token-1", kind: "dropbox", root: "Apps/Grove" },
      { accessToken: "token-1", kind: "dropbox", root: "Apps/Grove" },
    ]);
    expect(opened[0]?.identity.id).toBe("dropbox:account:dbid%3Aa:Apps/Grove");
    await runtime.dispose();
  });

  it("re-authorizes on renewal and rejects a changed account with a typed error", async () => {
    oauth.authorize
      .mockReset()
      .mockReturnValueOnce(Effect.succeed(token("token-1", "dbid:a")))
      .mockReturnValueOnce(Effect.succeed(token("token-2", "dbid:a")))
      .mockReturnValueOnce(Effect.succeed(token("token-3", "dbid:other")));
    let { opened, runtime } = createRuntime();
    await runtime.runPromise(Effect.scoped(openDropbox()));
    let renewSource = opened[0]!.renewSource;

    await expect(runtime.runPromise(renewSource)).resolves.toEqual({
      accessToken: "token-2",
      kind: "dropbox",
      root: "Apps/Grove",
    });
    await expect(runtime.runPromise(renewSource)).rejects.toMatchObject({
      _tag: "WorkspaceAuthRenewalFailed",
      message: "Dropbox account changed. Reconnect Dropbox workspace to continue.",
      reason: { _tag: "WorkspaceAccountChanged" },
    });
    await runtime.dispose();
  });

  it("uses a redirect token without opening a popup and forgets it when cleared", async () => {
    oauth.authorize.mockReset().mockReturnValue(Effect.succeed(token("popup-token", "dbid:a")));
    let { opened, runtime } = createRuntime();
    await runtime.runPromise(
      DropboxWorkspaces.use((dropbox) =>
        dropbox.setRedirectAccessToken({
          accessToken: "redirect-token",
          appKey: "app-key",
          expiresAt: Date.now() + 60 * 60 * 1000,
          identity: { id: "dbid:a", kind: "account" },
        }),
      ),
    );

    await runtime.runPromise(Effect.scoped(openDropbox()));
    expect(oauth.authorize).not.toHaveBeenCalled();
    expect(opened[0]?.source).toMatchObject({ accessToken: "redirect-token" });

    await runtime.runPromise(DropboxWorkspaces.use((dropbox) => dropbox.clearAccessToken));
    await runtime.runPromise(Effect.scoped(openDropbox()));
    expect(oauth.authorize).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("fails fast with a typed error when the app key is missing", async () => {
    let { runtime } = createRuntime();
    await expect(
      runtime.runPromise(
        Effect.scoped(
          DropboxWorkspaces.use((dropbox) => dropbox.open({ appKey: " " }, { name: "Dropbox" })),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "OAuthAuthorizationError",
      message: "Dropbox app key is required.",
      reason: "client-id-required",
    });
    await runtime.dispose();
  });
});

function openDropbox() {
  return DropboxWorkspaces.use((dropbox) =>
    dropbox.open({ appKey: "app-key", root: "/Apps/Grove/" }, { name: "Dropbox" }),
  );
}

function token(accessToken: string, accountId: string) {
  return {
    accessToken,
    expiresAt: Date.now() + 60 * 60 * 1000,
    identity: { id: accountId, kind: "account" as const },
  };
}

function createRuntime() {
  let opened: CloudWorkspaceInput[] = [];
  let cloud = Layer.succeed(
    CloudWorkspaceStorage,
    CloudWorkspaceStorage.of({
      open: (input) =>
        Effect.sync(() => {
          opened.push(input);
          return createMemoryWorkspaceRuntime([], { kind: "opendal-dropbox" });
        }),
    }),
  );
  oauth.identity.mockReset();
  return {
    opened,
    runtime: ManagedRuntime.make(DropboxWorkspaces.layerNoDeps.pipe(Layer.provide(cloud))),
  };
}
