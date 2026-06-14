import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const LiveMdPreloadErrorContext = createContext("");

type LiveMdPreloadErrorProviderProps = {
  children: ReactNode;
  preloadStatus: Promise<string>;
};

export function LiveMdPreloadErrorProvider({
  children,
  preloadStatus,
}: LiveMdPreloadErrorProviderProps) {
  let [preloadError, setPreloadError] = useState("");

  useEffect(() => {
    let canceled = false;
    void preloadStatus.then((message) => {
      if (!canceled) setPreloadError(message);
    });
    return () => {
      canceled = true;
    };
  }, [preloadStatus]);

  return (
    <LiveMdPreloadErrorContext.Provider value={preloadError}>
      {children}
    </LiveMdPreloadErrorContext.Provider>
  );
}

export function useLiveMdPreloadError() {
  return useContext(LiveMdPreloadErrorContext);
}

export function liveMdPreloadErrorMessage(error: unknown) {
  let detail = error instanceof Error ? error.message : typeof error == "string" ? error : "";
  return detail
    ? `LiveMD language support failed to load: ${detail}`
    : "LiveMD language support failed to load.";
}
