import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createRelayShareSession } from "@/lib/collaboration/share-relay-client";
import { workspaceQueryKeys } from "@/lib/workspace-query-keys";

type UseSharedFileSessionOptions = {
  enabled: boolean;
  guestSecret: string;
  relayOrigin: string;
  shareId: string;
};

export function useSharedFileSession({
  enabled,
  guestSecret,
  relayOrigin,
  shareId,
}: UseSharedFileSessionOptions) {
  let guestSecretToken = useMemo(() => sharedSecretCacheToken(guestSecret), [guestSecret]);
  let [errorMessage, setErrorMessage] = useState("");
  let sharedSessionQuery = useQuery({
    enabled,
    gcTime: 0,
    queryFn: ({ signal }) => {
      if (!enabled) {
        throw new Error("Shared file relay is not configured.");
      }
      let fetchWithAbort: typeof fetch = (input, init) => fetch(input, { ...init, signal });
      return createRelayShareSession(relayOrigin, shareId, "guest", guestSecret, fetchWithAbort);
    },
    queryKey: enabled
      ? workspaceQueryKeys.sharedSession(relayOrigin, shareId, guestSecretToken)
      : workspaceQueryKeys.sharedSession("", "invalid", ""),
    refetchOnReconnect: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    setErrorMessage("");
  }, [guestSecretToken, relayOrigin, shareId]);

  useEffect(() => {
    if (sharedSessionQuery.error) {
      setErrorMessage(errorToMessage(sharedSessionQuery.error));
    }
  }, [sharedSessionQuery.error]);

  useEffect(() => {
    if (sharedSessionQuery.data) {
      setErrorMessage("");
    }
  }, [sharedSessionQuery.data]);

  let refreshSession = useCallback(
    (signal: AbortSignal) => {
      let fetchWithAbort: typeof fetch = (input, init) => fetch(input, { ...init, signal });
      return createRelayShareSession(relayOrigin, shareId, "guest", guestSecret, fetchWithAbort);
    },
    [guestSecret, relayOrigin, shareId],
  );

  return {
    errorMessage,
    guestSecretToken,
    isJoining: enabled && sharedSessionQuery.isFetching,
    retry: () => {
      void sharedSessionQuery.refetch();
    },
    refreshSession,
    session: sharedSessionQuery.data ?? null,
  };
}

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sharedSecretCacheToken(secret: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < secret.length; index += 1) {
    hash ^= secret.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${secret.length}:${(hash >>> 0).toString(16)}`;
}
