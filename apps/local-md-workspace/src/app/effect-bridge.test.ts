import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { runWorkspaceEffect } from "@/app/effect-bridge";
import { isAbortError } from "@/lib/workspace/errors";
import { OAuthAuthorizationError } from "@/lib/workspace/providers/oauth-errors";

describe("runWorkspaceEffect", () => {
  let runtime = ManagedRuntime.make(Layer.empty);

  it("resolves with the success value", async () => {
    await expect(runWorkspaceEffect(runtime, Effect.succeed(42))).resolves.toBe(42);
  });

  it("rejects with the typed failure itself", async () => {
    let failure = new OAuthAuthorizationError({
      message: "Dropbox authorization popup was blocked.",
      provider: "Dropbox",
      reason: "popup-blocked",
    });
    let error = await runWorkspaceEffect(runtime, Effect.fail(failure)).catch((cause) => cause);
    expect(error).toBe(failure);
    expect(error).toBeInstanceOf(Error);
  });

  it("rejects with an AbortError when the signal interrupts the effect", async () => {
    let controller = new AbortController();
    let released = vi.fn();
    let running = runWorkspaceEffect(
      runtime,
      Effect.scoped(
        Effect.acquireRelease(Effect.void, () => Effect.sync(released)).pipe(
          Effect.andThen(Effect.never),
        ),
      ),
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();

    let error = await running.catch((cause: unknown) => cause);
    expect(isAbortError(error)).toBe(true);
    expect(released).toHaveBeenCalledOnce();
  });
});
