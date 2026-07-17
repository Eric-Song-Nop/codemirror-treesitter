import { useMemo, useState } from "react";
import type { LiveMdConfig } from "@codemirror-treesitter/live-md";
import { liveMdLoroCollaborationPlugin } from "@codemirror-treesitter/live-md-loro";
import { AlertCircleIcon, CloudIcon, RefreshCwIcon, WifiIcon, WifiOffIcon } from "lucide-react";
import { LoroDoc, UndoManager, type VersionVector } from "loro-crdt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PendingButtonContent } from "@/components/workspace/PendingButtonContent";
import { GroveMark } from "@/components/GroveMark";
import { LiveMdEditor } from "@/components/LiveMdEditor";
import { ThemeSelector } from "@/components/ThemeSelector";
import type { ShareRelayConnectionState } from "@/lib/collaboration/share-relay-connection";
import { configuredShareRelayOrigin } from "@/lib/collaboration/share-relay-client";
import { parseShareLink, type ShareLinkParts } from "@/lib/collaboration/share-identity";
import { useSharedFileConnection } from "@/hooks/shared/useSharedFileConnection";
import { useSharedFileSession } from "@/hooks/shared/useSharedFileSession";
import { translateKnownMessage, useI18n, type TFunction, type Locale } from "@/lib/i18n";
import { useLiveMdPreload } from "@/lib/live-md-preload";

type SharedFileRoute =
  | {
      kind: "invalid";
      message: string;
    }
  | {
      kind: "share";
      parts: ShareLinkParts;
    };

type SharedFileEditorProps = {
  href?: string;
};

export function SharedFileEditor({ href = window.location.href }: SharedFileEditorProps) {
  let { locale, t } = useI18n();
  let {
    error: liveMdPreloadError,
    retry: retryLiveMdPreload,
    retrying: liveMdPreloadRetrying,
  } = useLiveMdPreload();
  let route = useMemo(() => sharedFileRouteFromHref(href), [href]);
  let relayOrigin = useMemo(() => configuredShareRelayOrigin(), []);
  let shareId = route.kind == "share" ? route.parts.shareId : "";
  let guestSecret = route.kind == "share" ? route.parts.guestSecret : "";
  let invalidRouteMessage = route.kind == "invalid" ? route.message : "";
  let canJoinSharedFile = route.kind == "share" && Boolean(relayOrigin);
  let [doc] = useState(() => new LoroDoc());
  let [undoManager] = useState(() => new UndoManager(doc, {}));
  let liveMdConfig = useMemo<LiveMdConfig>(
    () => ({ plugins: [liveMdLoroCollaborationPlugin({ doc, undoManager })] }),
    [doc, undoManager],
  );
  let sharedSession = useSharedFileSession({
    enabled: canJoinSharedFile,
    guestSecret,
    relayOrigin,
    shareId,
  });
  let disabledConnectionMessage =
    invalidRouteMessage ||
    (route.kind == "share" && !relayOrigin ? "Shared file relay is not configured." : "");
  let sharedConnection = useSharedFileConnection({
    canConnect: canJoinSharedFile,
    disabledErrorMessage: disabledConnectionMessage,
    doc,
    joining: sharedSession.isJoining,
    relayOrigin,
    session: sharedSession.session,
    sessionErrorMessage: sharedSession.errorMessage,
    sessionKey: sharedSession.guestSecretToken,
    shareId,
  });
  let joiningSharedFile =
    canJoinSharedFile && sharedSession.isJoining && !sharedConnection.sessionReady;
  let retrySharedFileConnection = () => {
    if (sharedConnection.sessionReady) {
      sharedConnection.reconnect();
      return;
    }
    sharedSession.retry();
  };

  let statusLabel = connectionStatusLabel(sharedConnection.connectionState, t);
  let expiresAt = sharedConnection.shareStatus?.expiresAt ?? null;
  let saveStatus = guestSaveStatus({
    hostSavedVersion: sharedConnection.hostSavedVersion,
    latestLocalVersion: sharedConnection.latestLocalVersion,
    t,
  });
  let saveStatusTitle =
    saveStatus == t("shared.savedToHost") && sharedConnection.lastHostSavedAt
      ? t("shared.hostSavedAt", {
          time: formatTimestamp(sharedConnection.lastHostSavedAt, locale),
        })
      : undefined;
  let displayNameLabel =
    sharedConnection.displayName == "Shared file"
      ? t("shared.title")
      : sharedConnection.displayName;
  let visibleErrorMessage = sharedConnection.errorMessage || liveMdPreloadError;
  let retryingVisibleError = sharedConnection.errorMessage
    ? joiningSharedFile
    : liveMdPreloadRetrying;

  return (
    <TooltipProvider>
      <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <GroveMark className="size-7" decorative />
            <div className="min-w-0 truncate text-sm font-medium">{displayNameLabel}</div>
          </div>
          <Badge variant="secondary">
            {sharedConnection.connectionState == "connected" ? (
              <WifiIcon data-icon="inline-start" />
            ) : sharedConnection.connectionState == "connecting" ? (
              <RefreshCwIcon className="animate-spin" data-icon="inline-start" />
            ) : (
              <WifiOffIcon data-icon="inline-start" />
            )}
            {statusLabel}
          </Badge>
          {sharedConnection.shareStatus?.hostOnline ? (
            <Badge variant="secondary">
              <CloudIcon data-icon="inline-start" />
              {t("shared.hostOnline")}
            </Badge>
          ) : (
            <Badge variant="outline">{t("shared.hostOffline")}</Badge>
          )}
          {sharedConnection.shareStatus && sharedConnection.shareStatus.peerCount > 0 && (
            <Badge variant="outline">
              {formatPeerCount(sharedConnection.shareStatus.peerCount, t)}
            </Badge>
          )}
          {saveStatus && (
            <Badge title={saveStatusTitle} variant="secondary">
              {saveStatus}
            </Badge>
          )}
          <ThemeSelector className="shrink-0" />
        </header>

        {visibleErrorMessage && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" />
            <div className="min-w-0 flex-1">{translateKnownMessage(visibleErrorMessage, t)}</div>
            {((sharedConnection.errorMessage && route.kind == "share") ||
              (!sharedConnection.errorMessage && liveMdPreloadError)) && (
              <Button
                disabled={retryingVisibleError}
                size="sm"
                variant="outline"
                onClick={
                  sharedConnection.errorMessage
                    ? retrySharedFileConnection
                    : () => void retryLiveMdPreload()
                }
              >
                <PendingButtonContent
                  pending={retryingVisibleError}
                  pendingLabel={t("actions.connecting")}
                >
                  <>
                    <RefreshCwIcon data-icon="inline-start" />
                    {t("actions.retry")}
                  </>
                </PendingButtonContent>
              </Button>
            )}
          </div>
        )}

        {sharedConnection.sessionReady ? (
          <section className="min-h-0 flex-1 overflow-hidden">
            <LiveMdEditor
              config={liveMdConfig}
              documentKey={shareId || "shared-file"}
              initialValue=""
              placeholder={t("workspace.placeholder")}
              onInput={() => {}}
            />
          </section>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center p-6">
            <Empty className="max-w-md">
              <EmptyHeader>
                <EmptyMedia>
                  {joiningSharedFile ? (
                    <Spinner className="size-10" />
                  ) : (
                    <GroveMark className="size-14" />
                  )}
                </EmptyMedia>
                <EmptyTitle>
                  {route.kind == "invalid" ? t("shared.invalid") : t("shared.joining")}
                </EmptyTitle>
              </EmptyHeader>
              {expiresAt && (
                <EmptyContent>
                  {t("shared.expiresAt", { time: formatTimestamp(expiresAt, locale) })}
                </EmptyContent>
              )}
            </Empty>
          </div>
        )}
      </main>
    </TooltipProvider>
  );
}

function sharedFileRouteFromHref(href: string): SharedFileRoute {
  let parts = parseShareLink(href);
  if (parts) return { kind: "share", parts };
  return {
    kind: "invalid",
    message: "This shared file link is invalid or missing its edit key.",
  };
}

function connectionStatusLabel(state: ShareRelayConnectionState, t: TFunction) {
  if (state == "connected") return t("shared.connection.connected");
  if (state == "connecting") return t("shared.connection.connecting");
  if (state == "resync-required") return t("shared.connection.resyncRequired");
  return t("shared.connection.offline");
}

function guestSaveStatus({
  hostSavedVersion,
  latestLocalVersion,
  t,
}: {
  hostSavedVersion: VersionVector | null;
  latestLocalVersion: VersionVector | null;
  t: TFunction;
}) {
  if (!latestLocalVersion) return "";
  if (hostSavedVersion && versionCovers(hostSavedVersion, latestLocalVersion)) {
    return t("shared.savedToHost");
  }
  return t("shared.waitingForHost");
}

function formatTimestamp(value: number, locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatPeerCount(count: number, t: TFunction) {
  return count == 1
    ? t("shared.peerCount_one")
    : t("shared.peerCount_other", {
        count,
      });
}

function versionCovers(saved: VersionVector, local: VersionVector) {
  let comparison = saved.compare(local);
  return comparison == 0 || comparison == 1;
}
