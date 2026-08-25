import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createEncryptedWorkspaceAgentCredentialVault } from "@/lib/agent/adapters/browser/encrypted-credential-vault";
import {
  WorkspaceAgentCredentialManager,
  type WorkspaceAgentCredentialSnapshot,
} from "./workspace-agent-credential-manager";

const defaultWorkspaceAgentCredentialManager = new WorkspaceAgentCredentialManager(
  createEncryptedWorkspaceAgentCredentialVault(),
);

type WorkspaceAgentCredentialAccess = Pick<
  WorkspaceAgentCredentialManager,
  "forget" | "getApiKey" | "getSnapshot" | "lock" | "save" | "subscribe" | "unlock"
>;

let WorkspaceAgentCredentialsContext = createContext<WorkspaceAgentCredentialAccess | null>(null);

export function WorkspaceAgentCredentialsProvider({
  children,
  manager = defaultWorkspaceAgentCredentialManager,
}: {
  children: ReactNode;
  manager?: WorkspaceAgentCredentialManager;
}) {
  let access = useMemo<WorkspaceAgentCredentialAccess>(
    () => ({
      forget: manager.forget,
      getApiKey: manager.getApiKey,
      getSnapshot: manager.getSnapshot,
      lock: manager.lock,
      save: manager.save,
      subscribe: manager.subscribe,
      unlock: manager.unlock,
    }),
    [manager],
  );
  useEffect(() => {
    let stop = manager.start();
    let lock = () => manager.lock();
    globalThis.addEventListener?.("pagehide", lock);
    return () => {
      globalThis.removeEventListener?.("pagehide", lock);
      stop();
    };
  }, [manager]);
  return (
    <WorkspaceAgentCredentialsContext.Provider value={access}>
      {children}
    </WorkspaceAgentCredentialsContext.Provider>
  );
}

export function useWorkspaceAgentCredentials(): WorkspaceAgentCredentialSnapshot & {
  forget: () => Promise<boolean>;
  getApiKey: () => string | null;
  lock: () => void;
  save: (apiKey: string, passphrase: string) => Promise<boolean>;
  subscribe: (listener: () => void) => () => void;
  unlock: (passphrase: string) => Promise<boolean>;
} {
  let access = useContext(WorkspaceAgentCredentialsContext);
  if (!access) {
    throw new Error("useWorkspaceAgentCredentials must be used within its provider.");
  }
  let snapshot = useSyncExternalStore(access.subscribe, access.getSnapshot, access.getSnapshot);
  return {
    ...snapshot,
    forget: access.forget,
    getApiKey: access.getApiKey,
    lock: access.lock,
    save: access.save,
    subscribe: access.subscribe,
    unlock: access.unlock,
  };
}

export type {
  WorkspaceAgentCredentialSnapshot,
  WorkspaceAgentCredentialStatus,
} from "./workspace-agent-credential-manager";
