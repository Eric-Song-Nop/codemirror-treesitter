import { useCallback, useEffect, useRef, useState } from "react";
import { revokeImageAssetUrls } from "@/lib/workspace/images";
import type { WorkspaceImageAsset } from "@/lib/workspace/types";

export function useWorkspaceImageAssetStore() {
  let assetsRef = useRef(new Map<string, WorkspaceImageAsset>());
  let [version, setVersion] = useState(0);

  let clear = useCallback(() => {
    revokeImageAssetUrls(assetsRef.current);
    assetsRef.current = new Map();
    setVersion((current) => current + 1);
  }, []);

  let replace = useCallback((nextAssets: WorkspaceImageAsset[]) => {
    revokeImageAssetUrls(assetsRef.current);
    assetsRef.current = new Map(nextAssets.map((asset) => [asset.path, asset]));
    setVersion((current) => current + 1);
  }, []);

  let upsert = useCallback((nextAssets: WorkspaceImageAsset[]) => {
    let assets = new Map(assetsRef.current);
    for (let asset of nextAssets) {
      let previous = assets.get(asset.path);
      if (previous) URL.revokeObjectURL(previous.url);
      assets.set(asset.path, asset);
    }
    assetsRef.current = assets;
    setVersion((current) => current + 1);
  }, []);

  let get = useCallback((path: string) => assetsRef.current.get(path) ?? null, []);

  useEffect(
    () => () => {
      revokeImageAssetUrls(assetsRef.current);
      assetsRef.current = new Map();
    },
    [],
  );

  return {
    clear,
    get,
    replace,
    upsert,
    version,
  };
}
