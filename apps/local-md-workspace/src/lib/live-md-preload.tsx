import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type LiveMdPreloadState = {
  error: string;
  generation: number;
  retry: () => Promise<void>;
  retrying: boolean;
};

const LiveMdPreloadContext = createContext<LiveMdPreloadState>({
  error: "",
  generation: 0,
  retry: async () => {},
  retrying: false,
});

type LiveMdPreloadErrorProviderProps = {
  children: ReactNode;
  preload: () => Promise<void>;
};

export function LiveMdPreloadErrorProvider({ children, preload }: LiveMdPreloadErrorProviderProps) {
  let [error, setError] = useState("");
  let [generation, setGeneration] = useState(0);
  let [retrying, setRetrying] = useState(false);
  let mountedRef = useRef(false);
  let inFlightRef = useRef<Promise<void> | null>(null);

  let retry = useCallback(() => {
    if (inFlightRef.current) return inFlightRef.current;
    if (mountedRef.current) setRetrying(true);

    let current = Promise.resolve()
      .then(preload)
      .then(() => {
        if (!mountedRef.current) return;
        setError("");
        setGeneration((value) => value + 1);
      })
      .catch((nextError: unknown) => {
        if (mountedRef.current) setError(liveMdPreloadErrorMessage(nextError));
      })
      .finally(() => {
        if (inFlightRef.current === current) inFlightRef.current = null;
        if (mountedRef.current) setRetrying(false);
      });
    inFlightRef.current = current;
    return current;
  }, [preload]);

  useEffect(() => {
    mountedRef.current = true;
    void retry();
    return () => {
      mountedRef.current = false;
    };
  }, [retry]);

  let state = useMemo<LiveMdPreloadState>(
    () => ({ error, generation, retry, retrying }),
    [error, generation, retry, retrying],
  );

  return <LiveMdPreloadContext.Provider value={state}>{children}</LiveMdPreloadContext.Provider>;
}

export function useLiveMdPreloadError() {
  return useLiveMdPreload().error;
}

export function useLiveMdPreload() {
  return useContext(LiveMdPreloadContext);
}

export function liveMdPreloadErrorMessage(error: unknown) {
  let detail = error instanceof Error ? error.message : typeof error == "string" ? error : "";
  return detail
    ? `LiveMD language support failed to load: ${detail}`
    : "LiveMD language support failed to load.";
}
