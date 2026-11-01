import { Context, Effect, Layer, Semaphore, type Scope } from "effect";
import { CloudWorkspaceStorage } from "../../runtime/cloud-runtime.ts";
import type { WorkspaceRuntime } from "../../runtime/types.ts";
import { WorkspaceAuthRenewalFailed, type WorkspaceStorageError } from "../../storage/errors.ts";
import {
  opendalWorkspaceId,
  sameOpendalWorkspaceIdentity,
  type OpendalWorkspaceIdentity,
} from "../identity.ts";
import {
  OAuthAuthorizationError,
  WorkspaceAccountChanged,
  type OAuthError,
} from "../oauth-errors.ts";
import { defaultDropboxRedirectUri, normalizeDropboxRootInput } from "./config.ts";
import {
  authorizeDropboxWithPkce,
  fetchDropboxAccountIdentity,
  type DropboxAccessToken,
} from "./oauth.ts";

export type DropboxWorkspaceConfig = { appKey: string; root?: string };

export type DropboxWorkspaceOpenOptions = {
  /** Display name of the workspace (localized by the caller). */
  name: string;
  /** Saves editor state before authorization falls back to a full-page redirect. */
  onBeforeFullPageRedirect?: (context: { appKey: string; root?: string }) => void;
};

export type DropboxWorkspaceOpenError =
  | OAuthError
  | WorkspaceAccountChanged
  | WorkspaceStorageError;

type CachedToken = { appKey: string; token: DropboxAccessToken };

/** Tokens this close to expiry are refreshed before use. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Dropbox workspace sessions. Holds the short-lived ("online") access token in
 * page memory only, and runs at most one authorization at a time: concurrent
 * callers wait for the in-flight authorization and reuse its token instead of
 * opening another popup. Dropbox issues no refresh token for this app, so a
 * "refresh" is a new PKCE authorization.
 */
export class DropboxWorkspaces extends Context.Service<
  DropboxWorkspaces,
  {
    readonly clearAccessToken: Effect.Effect<void>;
    setRedirectAccessToken(token: {
      accessToken: string;
      appKey: string;
      expiresAt: number;
      identity?: OpendalWorkspaceIdentity;
    }): Effect.Effect<void>;
    open(
      config: DropboxWorkspaceConfig,
      options: DropboxWorkspaceOpenOptions,
    ): Effect.Effect<WorkspaceRuntime, DropboxWorkspaceOpenError, Scope.Scope>;
  }
>()("local-md-workspace/DropboxWorkspaces") {
  static readonly layerNoDeps = Layer.effect(
    DropboxWorkspaces,
    Effect.gen(function* () {
      let cloud = yield* CloudWorkspaceStorage;
      let authorization = yield* Semaphore.make(1);
      let cached: CachedToken | null = null;

      let authorize = Effect.fn("DropboxWorkspaces.authorize")(function* (
        appKey: string,
        root: string | undefined,
        options: DropboxWorkspaceOpenOptions,
        stale: DropboxAccessToken | null,
      ) {
        return yield* authorization.withPermit(
          Effect.gen(function* () {
            // Another caller may have authorized while this one waited.
            let current = cached;
            if (
              current &&
              current.appKey == appKey &&
              current.token !== stale &&
              isFresh(current.token)
            ) {
              return current.token;
            }
            let redirectUri = defaultDropboxRedirectUri();
            let token = yield* authorizeDropboxWithPkce({
              allowFullPageRedirect: true,
              appKey,
              ...(redirectUri ? { redirectUri } : {}),
              onBeforeFullPageRedirect: () => options.onBeforeFullPageRedirect?.({ appKey, root }),
            });
            cached = { appKey, token };
            return token;
          }),
        );
      });

      let accessToken = (
        appKey: string,
        root: string | undefined,
        options: DropboxWorkspaceOpenOptions,
      ) =>
        Effect.suspend(() => {
          let current = cached;
          return current && current.appKey == appKey && isFresh(current.token)
            ? Effect.succeed(current.token)
            : authorize(appKey, root, options, null);
        });

      let open = Effect.fn("DropboxWorkspaces.open")(function* (
        config: DropboxWorkspaceConfig,
        options: DropboxWorkspaceOpenOptions,
      ) {
        let appKey = config.appKey.trim();
        if (!appKey) {
          return yield* new OAuthAuthorizationError({
            message: "Dropbox app key is required.",
            provider: "Dropbox",
            reason: "client-id-required",
          });
        }
        let root = normalizeDropboxRootInput(config.root);
        let initialToken = yield* accessToken(appKey, root, options);
        let workspaceIdentity = yield* tokenIdentity(initialToken);
        let lastToken = initialToken;

        let renewSource = Effect.gen(function* () {
          let token = yield* authorize(appKey, root, options, lastToken);
          let identity = yield* tokenIdentity(token);
          if (!sameOpendalWorkspaceIdentity(workspaceIdentity, identity)) {
            return yield* new WorkspaceAccountChanged({
              message: "Dropbox account changed. Reconnect Dropbox workspace to continue.",
              provider: "Dropbox",
            });
          }
          lastToken = token;
          return { accessToken: token.accessToken, kind: "dropbox" as const, root };
        }).pipe(Effect.mapError(WorkspaceAuthRenewalFailed.fromCause));

        return yield* cloud.open({
          identity: {
            id: opendalWorkspaceId("dropbox", root, workspaceIdentity),
            kind: "opendal-dropbox",
            name: options.name,
          },
          renewSource,
          source: { accessToken: initialToken.accessToken, kind: "dropbox", root },
        });
      });

      return DropboxWorkspaces.of({
        clearAccessToken: Effect.sync(() => {
          cached = null;
        }),
        open,
        setRedirectAccessToken: (token) =>
          Effect.sync(() => {
            cached = {
              appKey: token.appKey,
              token: {
                accessToken: token.accessToken,
                expiresAt: token.expiresAt,
                ...(token.identity ? { identity: token.identity } : {}),
              },
            };
          }),
      });
    }),
  );

  static readonly layer = DropboxWorkspaces.layerNoDeps.pipe(
    Layer.provide(CloudWorkspaceStorage.layer),
  );
}

function isFresh(token: DropboxAccessToken) {
  return token.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS;
}

function tokenIdentity(token: DropboxAccessToken) {
  return token.identity
    ? Effect.succeed(token.identity)
    : fetchDropboxAccountIdentity(token.accessToken);
}
